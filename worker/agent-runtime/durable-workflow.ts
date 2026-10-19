import { executeContinuousWorkflow } from './continuous-workflow';
import type { RuntimeExecutionContext } from './execution-context';
import { faultAwareStep } from './platform-step';
import { accountExecutionBoundary, accountedEnvironment, accountedStep } from './request-accounting';
import { recordExecutionFailure } from './task-recovery';
import { executionFailure } from './execution-failure';
import { getAgentByName } from 'agents';
import type { WorkflowCallback } from 'agents/workflows';
import { WorkflowEntrypoint, type WorkflowEvent } from 'cloudflare:workers';
import type { RuntimeAgentEnv, RuntimeWorkflowStep } from './env';
import { isAgentId, runtimeAgentName, type AgentId } from './definitions';
import { assembleContext, missingContextSourceIds, persistContextSnapshot } from './context';
import { appendAgentEvent, getAgentRun, transitionAgentRun } from './store';
import { startRuntimeRun } from './run-service';
import { failRunningRuntimeTools } from './observability';
import { runtimeAgentModule, safeModuleError } from './agent-modules';
import { disposeRpcResource } from './rpc-resource';
import { BOOKKEEPING_STEP } from './runtime-limits';

/** How long a Run waits for a human before handing the decision back. */
const HUMAN_RESPONSE_EVENT_TIMEOUT = '10 minutes';
import { notifyParentRunFinished } from './child-run-wait';

export type AgentWorkflowParams = { runId: string; workspaceId: string; siteId: string; agentId: AgentId; instanceId?: string; execution?: RuntimeExecutionContext };
type Progress = { status: string; phase: string; event_seq: number };

export class AgentRuntimeWorkflow extends WorkflowEntrypoint<RuntimeAgentEnv, AgentWorkflowParams> {
  private callbackAgentName = '';
  private callbackWorkflowId = '';
  private callbackWorkflowName = 'AGENT_WORKFLOW';

  private async notifyAgent(callback: WorkflowCallback<Progress>): Promise<void> {
    if (!this.callbackAgentName) return;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const agent = await getAgentByName(this.env.AGENT_SHELL as Env['AGENT_SHELL'], this.callbackAgentName);
        try {
          await agent._workflow_handleCallback(callback as unknown as WorkflowCallback);
          return;
        } finally {
          disposeRpcResource(agent);
        }
      } catch (error) {
        lastError = error;
        if (!/Durable Object instance is no longer active|Connection closed/i.test(String(error))) break;
      }
    }
    console.warn(
      `[agent-runtime] Agent callback ${callback.type} degraded; D1 remains authoritative: ${String(lastError).slice(0, 300)}`,
    );
  }

  private reportProgress(progress: Progress): Promise<void> {
    return this.notifyAgent({
      workflowName: this.callbackWorkflowName,
      workflowId: this.callbackWorkflowId,
      type: 'progress',
      progress,
      timestamp: Date.now(),
    });
  }

  private async waitForSyntheticApproval(step: RuntimeWorkflowStep, runId: string): Promise<void> {
    const waiting = await step.do('request-synthetic-approval', async () => {
      const approvalId = crypto.randomUUID();
      const at = new Date().toISOString();
      await this.env.DB.prepare(
        `insert into agent_approvals (id, run_id, tool_call_key, status, requested_json, requested_at)
         values (?, ?, 'synthetic_approval', 'pending', ?, ?)`,
      ).bind(approvalId, runId, JSON.stringify({ action: 'continue synthetic verification' }), at).run();
      await transitionAgentRun(this.env.DB, runId, 'waiting_for_approval', { phase: 'waiting_for_approval' });
      return appendAgentEvent(this.env.DB, {
        runId, eventKey: 'approval.requested', kind: 'approval_requested', phase: 'waiting_for_approval',
        actorType: 'workflow', payload: { approval_id: approvalId, action: 'continue synthetic verification' },
      });
    });
    await this.reportProgress({ status: 'waiting_for_approval', phase: 'waiting_for_approval', event_seq: waiting.seq });
    const approval = await step.waitForEvent<{ approved: boolean; reason?: string }>('wait-for-synthetic-approval', {
      type: 'approval', timeout: HUMAN_RESPONSE_EVENT_TIMEOUT,
    });
    if (!approval.payload.approved) throw new Error(approval.payload.reason || 'Workflow rejected');
    await step.do('resume-after-synthetic-approval', async () => {
      await transitionAgentRun(this.env.DB, runId, 'running', { phase: 'approval_received' });
      await appendAgentEvent(this.env.DB, {
        runId, eventKey: 'approval.resumed', kind: 'run_resumed', phase: 'approval_received', actorType: 'workflow',
      });
    });
  }

  override async run(event: WorkflowEvent<AgentWorkflowParams>, step: RuntimeWorkflowStep) {
    const input = event.payload;
    if (!isAgentId(input.agentId)) throw new Error('Agent workflow id is not registered');
    const module = runtimeAgentModule(input.agentId);
    const definition = module.definition;
    if (definition.taskBased) {
      if (!input.execution) throw new Error('Continuous Workflow requires dispatch-time execution authority');
      return executeContinuousWorkflow(this.env, { ...input, execution: input.execution }, event.instanceId, step);
    }
    try {
      this.callbackAgentName = runtimeAgentName(input.workspaceId, input.siteId, input.agentId, input.instanceId || '');
      this.callbackWorkflowId = event.instanceId;
      this.callbackWorkflowName = definition.workflowBinding;
      definition.inputSchema.parse(input);
      const started = await step.do('initialize-agent-run', async () => {
        const run = await getAgentRun(this.env.DB, input.runId);
        if (!run) throw new Error('Agent run not found');
        if (run.workspace_id !== input.workspaceId || run.site_id !== input.siteId || run.agent_id !== input.agentId || run.agent_instance_id !== (input.instanceId || '')) {
          throw new Error('Agent workflow identity mismatch');
        }
        if (run.definition_version !== definition.definitionVersion || run.prompt_version !== definition.promptVersion) {
          throw new Error('Agent definition version drift detected');
        }
        const next = run.status === 'queued'
          ? await transitionAgentRun(this.env.DB, run.id, 'running', { phase: 'assembling_context' })
          : run;
        const eventRow = await appendAgentEvent(this.env.DB, {
          runId: run.id, eventKey: 'run.started', kind: 'run_started', phase: 'assembling_context', actorType: 'workflow',
          payload: { definition_version: definition.definitionVersion, prompt_version: definition.promptVersion },
        });
        const summary = JSON.parse(run.summary_json || '{}') as { scenario?: string };
        return { run: next, eventSeq: eventRow.seq, scenario: summary.scenario || 'default' };
      });
      await this.reportProgress({ status: started.run.status, phase: 'assembling_context', event_seq: started.eventSeq });

      const context = await step.do('assemble-context', async () => {
        const site = await this.env.DB.prepare(
          `select id, workspace_id, name, domain, root_domain, source_locale, hub_path,
                  translate_locales_json, min_words, research_seed_terms_json, competitor_domains_json, product_brief, created_at
           from sites where workspace_id = ? and id = ?`,
        ).bind(input.workspaceId, input.siteId).first<Record<string, unknown>>();
        if (!site) throw new Error('Agent site context not found');
        const currentRun = await getAgentRun(this.env.DB, input.runId);
        if (!currentRun) throw new Error('Agent run disappeared before context assembly');
        const sources = await module.loadContext(this.env, site, currentRun);
        const expectedSources = new Set(definition.contextSources);
        for (const source of sources) if (!expectedSources.has(source.sourceId)) {
          throw new Error(`Context source is not allowed: ${source.sourceId}`);
        }
        const assembled = await assembleContext(sources, definition.contextBudgetBytes);
        const missing = missingContextSourceIds(definition.contextSources, assembled.manifest);
        if (missing.length) throw new Error(`Required context sources exceed the context budget: ${missing.join(', ')}`);
        const snapshotId = crypto.randomUUID();
        await persistContextSnapshot(this.env.DB, {
          id: snapshotId, runId: input.runId, definitionVersion: definition.definitionVersion,
          promptVersion: definition.promptVersion, context: assembled,
        });
        await transitionAgentRun(this.env.DB, input.runId, 'running', { phase: 'context_ready' });
        const row = await appendAgentEvent(this.env.DB, {
          runId: input.runId, eventKey: 'context.assembled', kind: 'context_assembled', phase: 'context_ready',
          actorType: 'workflow', payload: {
            manifest_hash: assembled.manifestHash, sources: assembled.manifest.map((item) => item.source_id),
            truncated: assembled.truncated,
          },
        });
        return {
          snapshotId, eventSeq: row.seq,
          valuesJson: JSON.stringify(assembled.values),
        };
      });
      await this.reportProgress({ status: 'running', phase: 'context_ready', event_seq: context.eventSeq });

      const execution = await accountExecutionBoundary(this.env, step, input.runId, () => module.execute({
        env: accountedEnvironment(this.env), step: faultAwareStep(accountedStep(step, this.env, input.runId)), definition, run: started.run,
        values: JSON.parse(context.valuesJson) as Record<string, unknown>,
        snapshotId: context.snapshotId, scenario: started.scenario,
        startChildRun: (request) => startRuntimeRun(this.env, request),
        waitForApproval: () => this.waitForSyntheticApproval(step, input.runId),
        waitForInput: async () => {
          const waiting = await step.do('request-synthetic-input', async () => {
            await transitionAgentRun(this.env.DB, input.runId, 'waiting_for_input', { phase: 'waiting_for_input' });
            return appendAgentEvent(this.env.DB, {
              runId: input.runId, eventKey: 'input.requested', kind: 'input_requested', phase: 'waiting_for_input',
              actorType: 'workflow', payload: { prompt: 'Provide a synthetic value' },
            });
          });
          await this.reportProgress({ status: 'waiting_for_input', phase: 'waiting_for_input', event_seq: waiting.seq });
          await step.waitForEvent<{ value: string }>('wait-for-synthetic-input', { type: 'user_input', timeout: HUMAN_RESPONSE_EVENT_TIMEOUT });
          await step.do('resume-after-synthetic-input', async () => transitionAgentRun(
            this.env.DB, input.runId, 'running', { phase: 'input_received' },
          ));
        },
      }));
      const output = definition.outputSchema.parse(execution.output);
      const completed = await step.do('complete-agent-run', async () => {
        const current = await getAgentRun(this.env.DB, input.runId);
        if (!current) throw new Error('Agent run disappeared before completion');
        const run = ['succeeded','failed','cancelled'].includes(current.status)
          ? current
          : await transitionAgentRun(this.env.DB, input.runId, 'succeeded', { phase: execution.phase, output });
        await this.env.DB.prepare('update agent_runs set execution_outcome = ? where id = ? and execution_outcome = \'\'').bind('completed', input.runId).run();
        const row = await appendAgentEvent(this.env.DB, {
          runId: input.runId, eventKey: `run.${run.status}`, kind: run.status === 'succeeded' ? 'run_succeeded' : run.status === 'cancelled' ? 'run_cancelled' : 'run_failed', phase: execution.phase,
          actorType: 'workflow', payload: output,
        });
        return { run, eventSeq: row.seq };
      });
      await this.reportProgress({ status: completed.run.status, phase: execution.phase, event_seq: completed.eventSeq });
      await step.do('notify-parent-run-succeeded', BOOKKEEPING_STEP, async () => {
        await notifyParentRunFinished(this.env, input.runId);
      });
      await step.do('__agent_projection_complete', async () => this.notifyAgent({
        workflowName: this.callbackWorkflowName,
        workflowId: this.callbackWorkflowId,
        type: 'complete',
        result: output,
        timestamp: Date.now(),
      }));
      return output;
    } catch (error) {
      const message = safeModuleError(module, error);
      await step.do('fail-agent-run', { retries: { limit: 0, delay: '1 second' }, timeout: '1 minute' }, async () => {
        await failRunningRuntimeTools(this.env.DB, input.runId, message);
        const run = await getAgentRun(this.env.DB, input.runId);
        if (run && !['succeeded', 'failed', 'cancelled'].includes(run.status)) {
          await transitionAgentRun(this.env.DB, run.id, 'failed', { phase: 'failed', errorCode: 'workflow_failed', error: message });
          await appendAgentEvent(this.env.DB, {
            runId: run.id, eventKey: 'run.failed', kind: 'run_failed', phase: 'failed',
            actorType: 'workflow', payload: { error: message },
          });
        }
        await this.env.DB.prepare("update agent_runs set execution_outcome = 'execution_failed' where id = ? and status = 'failed'").bind(input.runId).run();
        const failure = executionFailure(error, 'workflow');
        if (failure) {
          if (run && module.failBusinessStart) await module.failBusinessStart(this.env, run.id, message);
          await recordExecutionFailure(this.env, input.runId, failure);
        } else if (run && module.onFailure) await module.onFailure(this.env, run, message);
        await this.env.DB.prepare(
          `update agent_approvals set status = 'expired', decision_note = ?, decided_at = ?
           where run_id = ? and status = 'pending'`,
        ).bind('Run ended before approval', new Date().toISOString(), input.runId).run();
      });
      await step.do('notify-parent-run-failed', BOOKKEEPING_STEP, async () => {
        await notifyParentRunFinished(this.env, input.runId);
      });
      await this.notifyAgent({
        workflowName: this.callbackWorkflowName,
        workflowId: this.callbackWorkflowId,
        type: 'error',
        error: message,
        timestamp: Date.now(),
      });
      throw error;
    }
  }
}
