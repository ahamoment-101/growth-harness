import { taskSubjectsJson, type TaskSubject } from './task-subjects';
import { createRuntimeExecution, dispatchExecution, currentExecution } from './runtime-executions';
import { persistRuntimeJson } from './runtime-content';
import { attachTask, stopTask, taskForRun, requireParentAuthority } from './task-store';
import { executionContext } from './execution-context';
import { getWorkspaceSite } from '../lib/auth/store';
import { agentDefinition, isAgentId, type AgentId } from './definitions';
import type { RuntimeAgentEnv } from './env';
import { createAgentRun, getActiveAgentRun, getAgentRun, getScheduledAgentRun, transitionAgentRun, type CreateAgentRunInput } from './store';
import { runtimeAgentModule } from './agent-modules';
import { disposeRpcResource } from './rpc-resource';

export const RUNTIME_RUN_TRIGGERS = ['manual', 'cron', 'retry', 'sub_agent'] as const;
export type RuntimeRunTrigger = (typeof RUNTIME_RUN_TRIGGERS)[number];

export type StartRuntimeRunInput = {
  workspaceId: string;
  siteId: string;
  agentId: AgentId;
  instanceId?: string;
  trigger: RuntimeRunTrigger;
  runId?: string;
  retryOfRunId?: string;
  parentRunId?: string;
  scheduleKey?: string;
  summary?: unknown;
  initialAssignment?: { id: string; material: unknown; subjects?: TaskSubject[] };
};

export function assertRuntimeRunRequest(input: StartRuntimeRunInput): void {
  if (!input.workspaceId || !input.siteId || !isAgentId(input.agentId)) throw new Error('Runtime Run identity is invalid');
  if (input.instanceId?.includes('--')) throw new Error('Agent instance id cannot contain --');
  if (!RUNTIME_RUN_TRIGGERS.includes(input.trigger)) throw new Error('Runtime Run trigger is invalid');
  if (input.trigger === 'retry' && !input.retryOfRunId) throw new Error('Retry Run requires retryOfRunId');
  if (input.trigger !== 'retry' && input.retryOfRunId) throw new Error('retryOfRunId is only valid for retry Runs');
  if (input.trigger === 'sub_agent' && !input.parentRunId) throw new Error('Sub-agent Run requires parentRunId');
  if (!['sub_agent', 'retry'].includes(input.trigger) && input.parentRunId) throw new Error('parentRunId is only valid for sub-agent or retry Runs');
  const module = runtimeAgentModule(input.agentId);
  if (module.manualStartAllowed === false && !['sub_agent', 'retry'].includes(input.trigger)) {
    throw new Error(`${module.definition.label} Runs can only be started or retried by an allowed content parent Agent`);
  }
  if (module.parentAgentIds?.length && input.trigger === 'retry' && !input.parentRunId) {
    throw new Error(`${module.definition.label} retry requires its current content parent Run`);
  }
  if (input.trigger === 'cron' && !input.scheduleKey) throw new Error('Scheduled Run requires scheduleKey');
  if (input.trigger !== 'cron' && input.scheduleKey) throw new Error('scheduleKey is only valid for scheduled Runs');
}

async function lineageForRun(env: RuntimeAgentEnv, input: StartRuntimeRunInput): Promise<Pick<CreateAgentRunInput, 'rootRunId' | 'parentRunId' | 'retryOfRunId'>> {
  if (input.trigger === 'sub_agent') {
    const parent = await getAgentRun(env.DB, input.parentRunId!);
    if (
      !parent || ['succeeded', 'failed', 'cancelled'].includes(parent.status) ||
      parent.workspace_id !== input.workspaceId || parent.site_id !== input.siteId || !isAgentId(parent.agent_id)
    ) throw new Error('Parent Run is invalid');
    if (!agentDefinition(parent.agent_id).runPolicy.allowSubAgents) throw new Error('Parent Agent does not allow sub-agents');
    const childModule = runtimeAgentModule(input.agentId);
    if (childModule.parentAgentIds?.length && !childModule.parentAgentIds.includes(parent.agent_id)) {
      throw new Error(`${childModule.definition.label} parent is not allowed`);
    }
    return { parentRunId: parent.id, rootRunId: parent.root_run_id || parent.id };
  }
  return {};
}

function assertRegisteredTools(env: RuntimeAgentEnv, agentId: AgentId): void {
  const module = runtimeAgentModule(agentId);
  const definition = module.definition;
  const registry = module.createToolRegistry?.(env);
  if (!registry) return;
  for (const toolName of definition.tools) registry.resolve(definition, toolName);
}

function runtimeWorkflowId(runId: string): string {
  return `wf_${runId.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

export async function dispatchRuntimeWorkflow(
  env: RuntimeAgentEnv,
  input: Pick<StartRuntimeRunInput, 'workspaceId' | 'siteId' | 'agentId' | 'instanceId'> & { runId: string },
): Promise<string> {
  const definition = agentDefinition(input.agentId);
  const workflow = env[definition.workflowBinding];
  const workflowId = runtimeWorkflowId(input.runId);
  const params = {
    runId: input.runId,
    workspaceId: input.workspaceId,
    siteId: input.siteId,
    agentId: input.agentId,
    instanceId: input.instanceId || '',
  };
  try {
    const instance = await workflow.create({ id: workflowId, params });
    try {
      return instance.id;
    } finally {
      disposeRpcResource(instance);
    }
  } catch (createError) {
    // A Workflow create RPC can lose its response after Cloudflare has accepted the
    // deterministic instance id. Read it back before declaring dispatch failure.
    try {
      const existing = await workflow.get(workflowId);
      try {
        const status = await existing.status();
        if (['queued', 'running', 'waiting', 'waitingForPause', 'paused', 'complete'].includes(status.status)) {
          return existing.id;
        }
      } finally {
        disposeRpcResource(existing);
      }
    } catch {
      // Preserve the original create error; it is the useful dispatch evidence.
    }
    throw createError;
  }
}

export async function startRuntimeRun(env: RuntimeAgentEnv, input: StartRuntimeRunInput) {
  if (executionContext(env.DB)) {
    if (!input.parentRunId || !['sub_agent', 'retry'].includes(input.trigger)) throw new Error('An execution may only start child tasks');
    await requireParentAuthority(env.DB, input.parentRunId, input.workspaceId, input.siteId);
  }
  if (input.trigger === 'retry') {
    const previous = await getAgentRun(env.DB, input.retryOfRunId || '');
    if (!previous || previous.workspace_id !== input.workspaceId || previous.site_id !== input.siteId || previous.agent_id !== input.agentId || previous.agent_instance_id !== (input.instanceId || '')) throw new Error('Resume identity mismatch');
    const task = await taskForRun(env.DB, previous.id);
    if (!task || !['waiting','paused','failed'].includes(task.status)) throw new Error('Task is not waiting for recovery');
    const { taskResumeBlock } = await import('./task-store');
    const block = await taskResumeBlock(env.DB, task);
    if (block) throw new Error(block);
    const current = await currentExecution(env.DB, previous.id);
    const execution = await createRuntimeExecution(env.DB, previous.id, current || undefined, 'resume');
    await dispatchExecution(env, execution);
    return (await getAgentRun(env.DB, previous.id))!;
  }
  assertRuntimeRunRequest(input);
  const site = await getWorkspaceSite(env.DB, input.workspaceId, input.siteId);
  if (!site) throw new Error('Runtime Run site not found');
  const module = runtimeAgentModule(input.agentId);
  if (module.requiresHubPath && !String(site.hub_path || '').trim()) {
    throw new Error('The site Hub path must be configured before starting content creation');
  }
  const definition = agentDefinition(input.agentId);
  if (input.trigger === 'cron' && !definition.runPolicy.allowScheduled) throw new Error('Agent does not allow scheduled Runs');
  assertRegisteredTools(env, input.agentId);
  if (module.validateStart) await module.validateStart(env, input, site as Record<string, unknown>);
  const lineage = await lineageForRun(env, input);
  const scheduledExisting = input.scheduleKey
    ? await getScheduledAgentRun(env.DB, input.workspaceId, input.siteId, input.agentId, input.scheduleKey)
    : null;
  if (scheduledExisting) return scheduledExisting;
  const runId = input.runId || crypto.randomUUID();
  const requestedExisting = input.runId ? await getAgentRun(env.DB, runId) : null;
  if (requestedExisting && (
    requestedExisting.workspace_id !== input.workspaceId || requestedExisting.site_id !== input.siteId ||
    requestedExisting.agent_id !== input.agentId || requestedExisting.trigger !== input.trigger ||
    requestedExisting.agent_instance_id !== (input.instanceId || '') ||
    requestedExisting.definition_version !== definition.definitionVersion || requestedExisting.prompt_version !== definition.promptVersion
  )) throw new Error('Existing Runtime Run does not match the requested identity');
  if (requestedExisting && (
    requestedExisting.parent_run_id !== (lineage.parentRunId || '') ||
    requestedExisting.retry_of_run_id !== (lineage.retryOfRunId || '') ||
    (['sub_agent', 'retry'].includes(input.trigger) && requestedExisting.root_run_id !== lineage.rootRunId)
  )) throw new Error('Existing Runtime Run lineage does not match the request');
  if (requestedExisting && input.initialAssignment) {
    const receipt = await env.DB.prepare('select task_id,subjects_json from agent_task_assignments where id=?')
      .bind(input.initialAssignment.id).first<{ task_id: string; subjects_json: string | null }>();
    const assigned = !receipt && await env.DB.prepare("select 1 from agent_tasks where id=? and assignment_id!=''").bind(requestedExisting.id).first();
    if ((!receipt && (assigned || requestedExisting.status !== 'queued')) || (receipt && (receipt.task_id !== requestedExisting.id || receipt.subjects_json !== taskSubjectsJson(input.initialAssignment.subjects))))
      throw new Error('Assignment subject identity conflict');
  }
  if (requestedExisting && requestedExisting.status !== 'queued') return requestedExisting;
  const existing = await getActiveAgentRun(env.DB, input.workspaceId, input.siteId, input.agentId, input.instanceId || '');
  if (existing && existing.id !== runId) {
    if (input.scheduleKey && existing.schedule_key === input.scheduleKey) return existing;
    throw new Error('This agent already has a set of Tasks running');
  }
  const existingBusinessRun = module.findBlockingBusinessRun ? await module.findBlockingBusinessRun(env, input) : null;
  if (existingBusinessRun && existingBusinessRun.id !== runId) {
    throw new Error('Strategy research is in progress');
  }

  let agentCreated = Boolean(requestedExisting);
  let businessCreated = module.businessRunExists ? await module.businessRunExists(env, runId) : false;
  try {
    const run = requestedExisting || await createAgentRun(env.DB, {
        id: runId, workspaceId: input.workspaceId, siteId: input.siteId, agentId: input.agentId,
        instanceId: input.instanceId,
        definitionVersion: definition.definitionVersion, promptVersion: definition.promptVersion,
        trigger: input.trigger, scheduleKey: input.scheduleKey, summary: input.summary || {}, ...lineage,
      });
    agentCreated = true;
    if (module.initializeBusinessRun && !businessCreated) {
      await module.initializeBusinessRun(env, input, runId);
      businessCreated = true;
    }
    if (definition.taskBased || (input.retryOfRunId && await taskForRun(env.DB, input.retryOfRunId))) await attachTask(env.DB, run, definition, input.retryOfRunId);
    if (definition.taskBased) {
      if (input.initialAssignment) {
        const task = (await taskForRun(env.DB, runId))!;
        await env.DB.batch([
          env.DB.prepare('insert or ignore into agent_task_assignments(id,task_id,operation_id,context_json,created_at,subjects_json) values(?,?,?,?,?,?)')
            .bind(input.initialAssignment.id, task.id, input.initialAssignment.id, await persistRuntimeJson(env.DB, input.initialAssignment.material), new Date().toISOString(), taskSubjectsJson(input.initialAssignment.subjects)),
          env.DB.prepare("update agent_tasks set assignment_id=? where id=? and assignment_id=''").bind(input.initialAssignment.id, task.id),
        ]);
      }
      const execution = await createRuntimeExecution(env.DB, runId);
      await dispatchExecution(env, execution);
      return (await getAgentRun(env.DB, runId)) || run;
    }
    const workflowId = runtimeWorkflowId(runId);
    // Dispatch metadata must never regress a Workflow that already started.
    await env.DB.prepare("update agent_runs set workflow_id = ?,phase = 'dispatching' where id = ? and status = 'queued'").bind(workflowId, runId).run();
    await dispatchRuntimeWorkflow(env, {
      runId, workspaceId: input.workspaceId, siteId: input.siteId,
      agentId: input.agentId, instanceId: input.instanceId,
    });
    return (await getAgentRun(env.DB, runId)) || run;
  } catch (error) {
    if (!agentCreated && input.scheduleKey) {
      const winner = await getScheduledAgentRun(env.DB, input.workspaceId, input.siteId, input.agentId, input.scheduleKey);
      if (winner) return winner;
    }
    if (definition.taskBased && await currentExecution(env.DB, runId)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (agentCreated) {
      const run = await getAgentRun(env.DB, runId);
      if (run && run.status === 'queued' && (!run.workflow_id || !input.retryOfRunId)) {
        await transitionAgentRun(env.DB, runId, 'failed', { phase: 'dispatch_failed', errorCode: 'dispatch_failed', error: message });
      }
    }
    const dispatchState = agentCreated ? await getAgentRun(env.DB, runId) : null;
    if (!dispatchState || dispatchState.status === 'failed') {
      if (definition.taskBased) await stopTask(env.DB, runId, 'failed', message, 'dispatch_failed');
      if (businessCreated && module.failBusinessStart) await module.failBusinessStart(env, runId, message);
    }
    throw error;
  }
}
