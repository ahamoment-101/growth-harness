// Local acceptance entrypoint only. Never imported by the production Worker.
import { AgentRuntimeWorkflow as RuntimeWorkflow } from '../../worker/agent-runtime/durable-workflow';
export { AgentShell } from '../../worker/agent-runtime/shell';
export { SiteRoom } from '../../worker/site-room/room';
import { processLearningSearch, learningSearchCoverage } from '../../worker/learning/search';
import { createPractice, commitRecords, requireRecord, recordView } from '../../worker/learning/store';
import { ToolRegistry } from '../../worker/agent-runtime/tools';
import { agentDefinition } from '../../worker/agent-runtime/definitions';
import { addBusinessLearningTools, businessLearningToolNames } from '../../worker/learning/business';
import { startConversation, wakeConversation } from '../../worker/growth-leader/service';
import { dispatchLearningRequests } from '../../worker/learning/dispatch';
import { reconcileTaskExecutions } from '../../worker/agent-runtime/task-recovery';
import { readRuntimeJson } from '../../worker/agent-runtime/runtime-content';

const scope = { workspaceId: 'primary-workspace', siteId: 'semantic-site' };
function connected(env: any) {
  const rpc = async (method: string, input: unknown) => {
    const response = await env.LIVE_SEARCH.fetch('https://provider.invalid/' + method, { method: 'POST', body: JSON.stringify(input) });
    if (!response.ok) throw new Error('Acceptance provider ' + method + ' failed: ' + response.status);
    return response.json();
  };
  return { ...env, AI: { run: (model: string, input: unknown) => rpc('embed', { model, input }) },
    LEARNING_VECTOR_INDEX: {
      upsert: (vectors: unknown) => rpc('upsert', vectors), getByIds: (ids: string[]) => rpc('get_by_ids', { ids }),
      deleteByIds: (ids: string[]) => rpc('delete_by_ids', { ids }),
      query: (vector: number[], options: unknown) => rpc('query', { vector, ...options as object }),
    },
  };
}
export class AgentRuntimeWorkflow extends RuntimeWorkflow {
  constructor(ctx: any, env: any) { super(ctx, connected(env)); }
}
export default {
  async fetch(request: Request, bindings: any) {
    const env = connected(bindings), path = new URL(request.url).pathname;
    const body = request.method === 'POST' ? await request.json() as any : {};
    if (path === '/seed') {
      for (const item of body.records) {
        const owned = item.scope || scope;
        const previous = await createPractice(env.DB, owned, 'import:' + item.id, 'growth_leader', item.goal, { id: item.id, material: { source: 'Synthetic acceptance history' } });
        const data = recordView(previous);
        data.intent = { goal: item.goal, context: item.context, expectation: 'Pilot discovery target; synthetic historical evidence only.' };
        data.experience = { ...data.experience, hypothesis: item.hypothesis, approach: item.approach,
          adjustments: item.adjustments, delivery: 'Synthetic historical article', insight: item.insight,
          preparation: 'ready', gaps: ['Synthetic acceptance data; not production growth evidence.'],
          evaluation: { version: 1, objective: 'Reach 10 clicks in the first 7 publication days', basis: ['Synthetic historical pilot brief'],
            inputs: [{ name: 'clicks', unit: 'count', source: 'gsc' }], method: 'numeric', constants: { target: 10, one: 1, zero: 0 },
            steps: [{ name: 'ratio', op: 'divide', left: 'clicks', right: 'target' }, { name: 'capped', op: 'min', left: 'ratio', right: 'one' }, { name: 'score', op: 'max', left: 'capped', right: 'zero' }],
            output: 'score', rubric: '', score_meaning: 'Share of the pilot discovery goal, not conversion or causality', unavailable_when: ['Incomplete observation'], comparison_key: 'discovery-10-clicks-7-days' },
          assessment: { reward: item.reward, conclusion: item.conclusion, limitations: item.limitations || ['Synthetic evidence only.'], evidence_refs: [] },
        };
        data.utility = { score: item.utility ?? null, feedback_count: item.utility == null ? 0 : 5, calculation_version: 'ema-0.2-v1' };
        if (previous.version === 0 || body.reset_history) await commitRecords(env.DB, owned, (body.seed_id || 'import') + ':' + item.id, item, [{ previous, data, title: item.title, status: 'evaluated' }]);
        // Imported synthetic histories are complete snapshots, not new model preparation requests.
        await env.DB.prepare("update learning_requests set status='completed' where record_id=?").bind(item.id).run();
        if (item.id === 'email-boundaries') await env.DB.prepare("update learning_records set updated_at='2020-01-01T00:00:00.000Z' where id=?").bind(item.id).run();
      }
      return Response.json(await learningSearchCoverage(env.DB, scope));
    }
    if (path === '/index') return Response.json({ ...await processLearningSearch(env, new Date(), 10), coverage: await learningSearchCoverage(env.DB, scope) });
    if (path === '/search') {
      const task = { agent_id: 'growth_leader', definition_version: 21, workspace_id: scope.workspaceId, site_id: scope.siteId } as any;
      const tools = addBusinessLearningTools(new ToolRegistry(), env, task);
      const definition = { ...agentDefinition('growth_leader'), tools: businessLearningToolNames(task) };
      return Response.json(await tools.execute(definition, 'find_business_experience', { query: body.query, top_k: body.top_k || 5 }, { ...scope, runId: 'acceptance-search', idempotencyKey: crypto.randomUUID() }));
    }
    if (path === '/revise') {
      const previous = await requireRecord(env.DB, scope, body.id), data = recordView(previous);
      if (body.insight) data.experience.insight = body.insight;
      if (body.utility) data.utility = body.utility;
      return Response.json(await commitRecords(env.DB, scope, body.operation_id, body, [{ previous, data }]));
    }
    if (path === '/start') {
      await startConversation(env, scope, { id: body.id, title: body.title, context: 'Isolated synthetic learning acceptance. No customer or publication effects.', message: { id: body.id + ':input', text: body.text } }, 'acceptance-user');
      await wakeConversation(env, scope, body.id);
      return Response.json({ id: body.id });
    }
    if (path === '/recover') {
      await dispatchLearningRequests(env); await reconcileTaskExecutions(env);
      return Response.json({ ok: true });
    }
    if (path === '/evidence') {
      const tasks = (await env.DB.prepare('select id,agent_id,status,outcome,reason,definition_version from agent_tasks').all()).results;
      const uses = (await env.DB.prepare('select * from learning_uses').all()).results;
      const ops = (await env.DB.prepare('select task_id,action_json,output_json,status from agent_task_operations order by created_at').all()).results;
      const tools = [];
      for (const op of ops) {
        const action = await readRuntimeJson(env.DB, op.action_json);
        // Formal tool decisions and results only; private model reasoning is never exported.
        if (action.name?.includes('experience') || action.name?.includes('learning') || action.name === 'prepare_business_practice')
          tools.push({ task_id: op.task_id, action, status: op.status, result: await readRuntimeJson(env.DB, op.output_json || '{}') });
      }
      const counts = (await env.DB.prepare('select r.agent_id,count(*) as count from agent_model_attempts a join agent_runs r on r.id=a.run_id group by r.agent_id').all()).results;
      return Response.json({ tasks, uses, tools, model_attempts: counts, coverage: await learningSearchCoverage(env.DB, scope) });
    }
    return Response.json({ error: 'Local acceptance route not found' }, { status: 404 });
  },
};
