import { Agent, type AgentContext, type Connection } from 'agents';
import { agentDefinition, type AgentId } from './definitions';
import type { RuntimeAgentEnv } from './env';
import { runRuntimeLoop, type RuntimeSiteSnapshot, type RuntimeToolEvent } from './loop';
import { runtimeChannelModel } from './model-policy';
import { resolveModelProfile } from './model-registry';
import { disposeRpcResource } from './rpc-resource';

export type RuntimeProbeStatus = 'idle' | 'agent_running' | 'workflow_running' | 'completed' | 'failed';

export type RuntimeProbeState = {
  status: RuntimeProbeStatus;
  agent_id: AgentId | '';
  site_id: string;
  run_id: string;
  phase: string;
  workflow_id: string;
  tool_events: RuntimeToolEvent[];
  result: string;
  error: string;
  updated_at: string;
};

export type StartRuntimeProbeInput = {
  runId: string;
  agentId: AgentId;
  site: RuntimeSiteSnapshot;
};

export type StartDurableOnlyProbeInput = {
  runId: string;
  agentId: AgentId;
  siteId: string;
};

const EMPTY_STATE: RuntimeProbeState = {
  status: 'idle',
  agent_id: '',
  site_id: '',
  run_id: '',
  phase: 'idle',
  workflow_id: '',
  tool_events: [],
  result: '',
  error: '',
  updated_at: '',
};

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);
}

export class AgentRuntimeProbe extends Agent<RuntimeAgentEnv, RuntimeProbeState> {
  initialState = EMPTY_STATE;
  private readonly runtimeEnv: RuntimeAgentEnv;

  constructor(ctx: AgentContext, env: RuntimeAgentEnv) {
    super(ctx, env);
    this.runtimeEnv = env;
  }

  validateStateChange(_nextState: RuntimeProbeState, source: Connection | 'server') {
    if (source !== 'server') throw new Error('Agent runtime state is server-owned');
  }

  async getSnapshot(): Promise<RuntimeProbeState> {
    return this.state;
  }

  private async startProbeWorkflow(params: Record<string, unknown>): Promise<string> {
    const workflowName = 'AGENT_RUNTIME_PROBE_WORKFLOW';
    const instance = await this.runtimeEnv.AGENT_RUNTIME_PROBE_WORKFLOW.create({
      params: {
        ...params,
        __agentName: this.name,
        __agentBinding: 'AGENT_RUNTIME_PROBE',
        __workflowName: workflowName,
        __agentOrigin: { kind: 'agent', version: 1, binding: 'AGENT_RUNTIME_PROBE', name: this.name },
      },
    });
    try {
      return instance.id;
    } finally {
      disposeRpcResource(instance);
    }
  }

  async startProbe(input: StartRuntimeProbeInput): Promise<RuntimeProbeState> {
    if (this.state.status === 'agent_running' || this.state.status === 'workflow_running') {
      throw new Error('This agent already has a set of Tasks running');
    }

    const definition = agentDefinition(input.agentId);
    this.setState({
      status: 'agent_running',
      agent_id: input.agentId,
      site_id: input.site.id,
      run_id: input.runId,
      phase: 'routing_context',
      workflow_id: '',
      tool_events: [],
      result: '',
      error: '',
      updated_at: new Date().toISOString(),
    });

    try {
      const profile = resolveModelProfile(this.runtimeEnv, definition.id);
      const result = await runRuntimeLoop({
        model: runtimeChannelModel(profile),
        definition,
        site: input.site,
        onToolEvent: async (event) => {
          this.setState({
            ...this.state,
            phase: event.tool,
            tool_events: [...this.state.tool_events, event].slice(-40),
            updated_at: event.at,
          });
        },
        startWorkflow: async (summary) => this.startProbeWorkflow({
          runId: input.runId,
          agentId: input.agentId,
          siteId: input.site.id,
          summary,
        }),
      });
      const workflowAlreadyFinished = this.state.status === 'completed' || this.state.status === 'failed';
      const agentLoopResult = { text: result.text, tool_calls: result.toolCalls };
      this.setState({
        ...this.state,
        status: workflowAlreadyFinished ? this.state.status : 'workflow_running',
        phase: workflowAlreadyFinished ? this.state.phase : 'durable_workflow',
        workflow_id: result.workflowId,
        result: workflowAlreadyFinished
          ? JSON.stringify({ agent_loop: agentLoopResult, workflow_completion: this.state.result })
          : JSON.stringify(agentLoopResult),
        updated_at: new Date().toISOString(),
      });
    } catch (error) {
      this.setState({
        ...this.state,
        status: 'failed',
        phase: 'failed',
        error: publicError(error),
        updated_at: new Date().toISOString(),
      });
    }
    return this.state;
  }

  async startDurableOnlyProbe(input: StartDurableOnlyProbeInput): Promise<RuntimeProbeState> {
    if (this.state.status === 'agent_running' || this.state.status === 'workflow_running') {
      throw new Error('This agent already has a set of Tasks running');
    }
    this.setState({
      status: 'workflow_running',
      agent_id: input.agentId,
      site_id: input.siteId,
      run_id: input.runId,
      phase: 'durable_workflow',
      workflow_id: '',
      tool_events: [],
      result: JSON.stringify({ validation_mode: 'durable_only' }),
      error: '',
      updated_at: new Date().toISOString(),
    });
    const workflowId = await this.startProbeWorkflow({
      runId: input.runId,
      agentId: input.agentId,
      siteId: input.siteId,
      summary: 'Local synthetic verification: confirm the Agent can start and receive Durable Workflow callbacks',
    });
    const workflowAlreadyFinished = this.state.status === 'completed' || this.state.status === 'failed';
    this.setState({
      ...this.state,
      status: workflowAlreadyFinished ? this.state.status : 'workflow_running',
      phase: workflowAlreadyFinished ? this.state.phase : 'durable_workflow',
      workflow_id: workflowId,
      updated_at: new Date().toISOString(),
    });
    return this.state;
  }

  override async onWorkflowProgress(_workflowName: string, workflowId: string, progress: unknown) {
    if (workflowId !== this.state.workflow_id && this.state.workflow_id) return;
    const phase = typeof progress === 'object' && progress && 'phase' in progress
      ? String((progress as { phase: unknown }).phase)
      : 'durable_workflow';
    this.setState({ ...this.state, phase, updated_at: new Date().toISOString() });
  }

  override async onWorkflowComplete(_workflowName: string, workflowId: string, result?: unknown) {
    this.setState({
      ...this.state,
      status: 'completed',
      phase: 'completed',
      workflow_id: workflowId,
      result: JSON.stringify({ agent_loop: this.state.result, workflow: result }),
      updated_at: new Date().toISOString(),
    });
  }

  override async onWorkflowError(_workflowName: string, workflowId: string, error: string) {
    this.setState({
      ...this.state,
      status: 'failed',
      phase: 'workflow_failed',
      workflow_id: workflowId,
      error: publicError(error),
      updated_at: new Date().toISOString(),
    });
  }
}
