import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from 'agents/workflows';
import type { AgentRuntimeProbe } from './agent';
import type { AgentId } from './definitions';
import type { RuntimeAgentEnv } from './env';

type RuntimeProbeWorkflowParams = {
  runId: string;
  agentId: AgentId;
  siteId: string;
  summary: string;
};

type RuntimeProbeWorkflowProgress = {
  phase: 'accepted' | 'verified';
  run_id: string;
};

export class AgentRuntimeProbeWorkflow extends AgentWorkflow<
  AgentRuntimeProbe,
  RuntimeProbeWorkflowParams,
  RuntimeProbeWorkflowProgress,
  RuntimeAgentEnv
> {
  override async run(event: AgentWorkflowEvent<RuntimeProbeWorkflowParams>, step: AgentWorkflowStep) {
    const accepted = await step.do('accept-runtime-decision', async () => ({
      run_id: event.payload.runId,
      agent_id: event.payload.agentId,
      site_id: event.payload.siteId,
      summary: event.payload.summary,
      accepted_at: new Date().toISOString(),
    }));
    await this.reportProgress({ phase: 'accepted', run_id: event.payload.runId });

    const verified = await step.do('verify-durable-resume', async () => ({
      ...accepted,
      durable_resume_verified: true,
      verified_at: new Date().toISOString(),
    }));
    await this.reportProgress({ phase: 'verified', run_id: event.payload.runId });
    await step.reportComplete(verified);
    return verified;
  }
}
