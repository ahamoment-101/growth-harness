import { Agent, getAgentByName, type AgentContext, type Connection } from 'agents';
import { agentDefinition, isAgentId, parseRuntimeAgentName, runtimeAgentName, type AgentId } from './definitions';
import type { RuntimeAgentEnv } from './env';
import { appendAgentEvent, getAgentRun, getAgentRunByWorkflowId, listActiveChildRuns, transitionAgentRun } from './store';
import { failRunningRuntimeTools } from './observability';
import { reconcileCancelledAgentRun } from './run-lifecycle';
import { executeTaskCommand } from './task-commands';
import { disposeRpcResource } from './rpc-resource';

export type AgentShellState = {
  run_id: string;
  agent_id: AgentId | '';
  status: string;
  phase: string;
  workflow_id: string;
  last_event_seq: number;
  updated_at: string;
};

const EMPTY_STATE: AgentShellState = {
  run_id: '', agent_id: '', status: 'idle', phase: 'idle', workflow_id: '', last_event_seq: 0, updated_at: '',
};

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);
}

export class AgentShell extends Agent<RuntimeAgentEnv, AgentShellState> {
  initialState = EMPTY_STATE;
  private readonly runtimeEnv: RuntimeAgentEnv;

  constructor(ctx: AgentContext, env: RuntimeAgentEnv) {
    super(ctx, env);
    this.runtimeEnv = env;
  }

  validateStateChange(_nextState: AgentShellState, source: Connection | 'server') {
    if (source !== 'server') throw new Error('Agent state is server-owned');
  }

  async getSnapshot(): Promise<AgentShellState> {
    const identity = parseRuntimeAgentName(this.name);
    if (!identity) return this.state;
    const run = await this.runtimeEnv.DB.prepare(`select * from agent_runs where workspace_id=? and site_id=? and agent_id=? and agent_instance_id=? order by created_at desc limit 1`)
      .bind(identity.workspaceId, identity.siteId, identity.agentId, identity.instanceId).first<import('./protocol').AgentRun>();
    if (run) this.setState({ run_id: run.id, agent_id: identity.agentId, status: run.status, phase: run.phase,
      workflow_id: run.workflow_id, last_event_seq: run.event_seq, updated_at: run.updated_at });
    return this.state;
  }

  async cancelRun(runId: string, actorId: string, reason = '', commandId = ''): Promise<AgentShellState> {
    const run = await getAgentRun(this.runtimeEnv.DB, runId);
    const identity = parseRuntimeAgentName(this.name);
    if (
      !run || !identity || run.workspace_id !== identity.workspaceId || run.site_id !== identity.siteId ||
      run.agent_id !== identity.agentId || run.agent_instance_id !== identity.instanceId
    ) throw new Error('Agent run not found in this instance');
    if (isAgentId(run.agent_id) && agentDefinition(run.agent_id).taskBased) {
      const result = await executeTaskCommand(this.runtimeEnv, { run, command: 'cancel', commandId: commandId || crypto.randomUUID(), actorId, reason });
      this.setState({ ...this.state, status: result.task?.status || 'cancelled', phase: 'cancelled', updated_at: new Date().toISOString() });
      return this.state;
    }
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) throw new Error(`Agent run is already ${run.status}`);
    for (const childRun of await listActiveChildRuns(this.runtimeEnv.DB, runId)) {
      if (!isAgentId(childRun.agent_id)) throw new Error('Child Agent identity is invalid');
      const child = await getAgentByName(
        this.runtimeEnv.AGENT_SHELL as Env['AGENT_SHELL'],
        runtimeAgentName(childRun.workspace_id, childRun.site_id, childRun.agent_id, childRun.agent_instance_id),
      );
      try {
        await child.cancelRun(childRun.id, actorId, reason || `Parent Run ${runId} was cancelled`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already|not found/i.test(message)) throw error;
      } finally {
        disposeRpcResource(child);
      }
    }
    if (run.workflow_id) {
      let instance: Awaited<ReturnType<RuntimeAgentEnv['AGENT_WORKFLOW']['get']>> | null = null;
      try {
        instance = await this.runtimeEnv.AGENT_WORKFLOW.get(run.workflow_id);
        await instance.terminate();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already|completed|terminated|not found/i.test(message)) throw error;
      } finally {
        disposeRpcResource(instance);
      }
    }
    await failRunningRuntimeTools(this.runtimeEnv.DB, runId, reason || 'Cancelled by user');
    const cancelled = await transitionAgentRun(this.runtimeEnv.DB, runId, 'cancelled', { phase: 'cancelled', errorCode: 'user_cancelled', error: reason });
    await reconcileCancelledAgentRun(this.runtimeEnv.DB, run, reason);
    const event = await appendAgentEvent(this.runtimeEnv.DB, {
      runId, eventKey: `run.cancelled:${commandId || actorId}`, kind: 'run_cancelled', phase: 'cancelled', actorType: 'user', actorId,
      payload: { reason },
    });
    this.setState({ ...this.state, status: cancelled.status, phase: cancelled.phase, last_event_seq: event.seq, updated_at: cancelled.updated_at });
    return this.state;
  }

  async approveRun(runId: string, actorId: string, reason = '', commandId = ''): Promise<void> {
    const run = await getAgentRun(this.runtimeEnv.DB, runId);
    if (!run || run.status !== 'waiting_for_approval' || !run.workflow_id) throw new Error('Agent run is not waiting for approval');
    await this.sendRuntimeWorkflowEvent(run.workflow_id, {
      type: 'approval', payload: { approved: true, reason, metadata: { actor_id: actorId } },
    });
    await this.runtimeEnv.DB.prepare(
      "update agent_approvals set status = 'approved', decided_by = ?, decision_note = ?, decided_at = ? where run_id = ? and status = 'pending'",
    ).bind(actorId, reason.slice(0, 500), new Date().toISOString(), runId).run();
    await appendAgentEvent(this.runtimeEnv.DB, {
      runId, eventKey: `approval.approved:${commandId || actorId}`, kind: 'approval_approved', phase: 'resuming', actorType: 'user', actorId,
      payload: { reason },
    });
  }

  async rejectRun(runId: string, actorId: string, reason = '', commandId = ''): Promise<void> {
    const run = await getAgentRun(this.runtimeEnv.DB, runId);
    if (!run || run.status !== 'waiting_for_approval' || !run.workflow_id) throw new Error('Agent run is not waiting for approval');
    await this.sendRuntimeWorkflowEvent(run.workflow_id, {
      type: 'approval', payload: { approved: false, reason },
    });
    await this.runtimeEnv.DB.prepare(
      "update agent_approvals set status = 'rejected', decided_by = ?, decision_note = ?, decided_at = ? where run_id = ? and status = 'pending'",
    ).bind(actorId, reason.slice(0, 500), new Date().toISOString(), runId).run();
    await appendAgentEvent(this.runtimeEnv.DB, {
      runId, eventKey: `approval.rejected:${commandId || actorId}`, kind: 'approval_rejected', phase: 'rejected', actorType: 'user', actorId,
      payload: { reason },
    });
  }

  async provideInput(runId: string, actorId: string, value: string, commandId = crypto.randomUUID()): Promise<void> {
    const run = await getAgentRun(this.runtimeEnv.DB, runId);
    const identity = parseRuntimeAgentName(this.name);
    if (!run || !identity || run.workspace_id !== identity.workspaceId || run.site_id !== identity.siteId || run.agent_id !== identity.agentId || run.agent_instance_id !== identity.instanceId) throw new Error('Agent run not found in this instance');
    if (isAgentId(run.agent_id) && agentDefinition(run.agent_id).taskBased) {
      const result = await executeTaskCommand(this.runtimeEnv, { run, command: 'provide_input', commandId, actorId, reason: '', value });
      this.setState({ ...this.state, run_id: result.run!.id, status: result.task?.status || 'running', phase: 'resuming', updated_at: new Date().toISOString() });
      return;
    }
    if (!run || run.status !== 'waiting_for_input' || !run.workflow_id) throw new Error('Agent run is not waiting for input');
    await this.sendRuntimeWorkflowEvent(run.workflow_id, {
      type: 'user_input', payload: { value: value.slice(0, 4000), actorId },
    });
    await appendAgentEvent(this.runtimeEnv.DB, {
      runId, eventKey: `input.provided:${commandId}`, kind: 'input_provided', phase: 'resuming', actorType: 'user', actorId,
      payload: { value: value.slice(0, 4000) },
    });
    const current = await getAgentRun(this.runtimeEnv.DB, runId);
    if (current?.status === 'waiting_for_input') {
      await transitionAgentRun(this.runtimeEnv.DB, runId, 'running', { phase: 'resuming' });
    }
  }

  private async sendRuntimeWorkflowEvent(workflowId: string, event: { type: string; payload: unknown }): Promise<void> {
    const instance = await this.runtimeEnv.AGENT_WORKFLOW.get(workflowId);
    try {
      await (instance as unknown as { sendEvent(value: { type: string; payload: unknown }): Promise<void> }).sendEvent(event);
    } finally {
      disposeRpcResource(instance);
    }
  }

  override async onWorkflowProgress(_workflowName: string, workflowId: string, progress: unknown) {
    const value = progress && typeof progress === 'object' ? progress as Record<string, unknown> : {};
    const run = await this.runForWorkflowCallback(workflowId);
    if (!run) return;
    this.setState({
      ...this.state,
      run_id: run.id,
      agent_id: isAgentId(run.agent_id) ? run.agent_id : this.state.agent_id,
      workflow_id: workflowId,
      status: run.status,
      phase: String(value.phase || run.phase),
      last_event_seq: Number(value.event_seq || run.event_seq),
      updated_at: new Date().toISOString(),
    });
  }

  private async runForWorkflowCallback(workflowId: string) {
    const byWorkflow = await getAgentRunByWorkflowId(this.runtimeEnv.DB, workflowId);
    if (byWorkflow) return byWorkflow;
    if (!this.state.run_id || this.state.workflow_id) return null;
    const starting = await getAgentRun(this.runtimeEnv.DB, this.state.run_id);
    return starting && !starting.workflow_id ? starting : null;
  }

  override async onWorkflowComplete(_workflowName: string, workflowId: string) {
    const run = await this.runForWorkflowCallback(workflowId);
    if (!run) return;
    this.setState({
      ...this.state,
      workflow_id: workflowId,
      status: run?.status || 'succeeded',
      phase: run?.phase || 'completed',
      last_event_seq: run?.event_seq || this.state.last_event_seq,
      updated_at: new Date().toISOString(),
    });
  }

  override async onWorkflowError(_workflowName: string, workflowId: string, error: string) {
    const run = await this.runForWorkflowCallback(workflowId);
    if (!run) return;
    // Agents SDK emits this callback for a failed Workflow attempt, before the
    // platform has exhausted step retries. D1 finalization in the Workflow is the
    // business authority; this callback may only refresh the realtime projection.
    const current = await getAgentRun(this.runtimeEnv.DB, run.id);
    this.setState({
      ...this.state,
      run_id: run.id,
      agent_id: isAgentId(run.agent_id) ? run.agent_id : this.state.agent_id,
      workflow_id: workflowId,
      status: current?.status || run.status,
      phase: current?.phase || run.phase,
      last_event_seq: current?.event_seq || this.state.last_event_seq,
      updated_at: new Date().toISOString(),
    });
    console.warn(`[agent-runtime] Workflow attempt callback did not change Run ${run.id}: ${safeError(error)}`);
  }

}
