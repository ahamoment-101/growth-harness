import type { WorkProvider } from './contracts';

/** Publication keeps its existing full article editor and approval contract. The request still belongs to the owning work stream. */
export const contentWorkProvider: WorkProvider = {
  id: 'publication', agents: ['content_production'],
  async pending(scope, agentId) {
    const rows = await scope.db.prepare(`select t.id as task_id,j.id,coalesce(j.en_title,j.pt_title,'') as title,j.updated_at
      from jobs j join content_production_groups g on g.id=j.production_group_id and g.site_id=j.site_id
      join agent_tasks t on t.active_run_id=g.parent_run_id and +t.workspace_id=g.workspace_id and +t.site_id=g.site_id
      where g.workspace_id=? and g.site_id=? and +t.agent_id=? and j.status='awaiting_review'`)
      .bind(scope.workspaceId, scope.siteId, agentId).all<{ task_id: string; id: string; title: string; updated_at: string }>();
    return rows.results.map(row => ({ task_id: row.task_id, request_id: `publication:${row.id}`, label: row.title || 'Article awaiting review', at: row.updated_at }));
  },
  async read(context) {
    return (await contentWorkProvider.pending!(context, context.task.agent_id)).filter(item => item.task_id === context.task.id).map(item => ({
      id: item.request_id, at: item.at, title: 'The article needs your review', body: item.label, state: 'attention',
      interaction: { id: item.request_id, version: item.at, state: 'pending', fields: [], actions: [
        { id: 'review', label: 'Open article review', href: `/website/${context.siteId}/review/${item.request_id.slice('publication:'.length)}` },
      ] },
    }));
  },
  async respond() { throw new Error('Please handle this request in article review'); },
};
