import { describe, expect, it } from 'vitest';
import { API_ROUTE_INVENTORY, accessRequiresPrincipal, accessRequiresWorkspace, classifyConsoleRequest } from './access';

function examplePath(route: string): string {
  return route
    .replace(':siteId', 'site-1')
    .replace(':agentId', 'strategy_research')
    .replace(':runId', 'run-1')
    .replace(':groupId', 'group-1')
    .replace(':moduleKey', 'product')
    .replace(':jobId', 'job-1');
}

describe('console HTTP access inventory', () => {
  it('classifies every inventoried route at its declared boundary', () => {
    for (const route of API_ROUTE_INVENTORY) {
      expect(classifyConsoleRequest(examplePath(route.route)), route.route).toBe(route.access);
      expect(route.originProtected, route.route).toBe(route.methods.some((method) => !['GET', 'HEAD'].includes(method)));
    }
  });

  it('keeps unknown APIs protected while public content and assets stay public', () => {
    expect(classifyConsoleRequest('/api/future-management-route')).toBe('workspace');
    expect(accessRequiresWorkspace(classifyConsoleRequest('/api/future-management-route'))).toBe(true);
    expect(classifyConsoleRequest('/live/site-1/sitemap.xml')).toBe('public_content');
    expect(classifyConsoleRequest('/')).toBe('static_asset');
  });

  it('always authenticates Agent surfaces and always authenticates management APIs regardless of legacy rollout mode', () => {
    expect(accessRequiresPrincipal('workspace_agent', 'report_only')).toBe(true);
    expect(accessRequiresPrincipal('workspace_agent', 'required')).toBe(true);
    expect(accessRequiresPrincipal('workspace', 'report_only')).toBe(true);
    expect(accessRequiresPrincipal('workspace', 'required')).toBe(true);
    expect(accessRequiresPrincipal('public_content', 'required')).toBe(false);
  });

  it('exposes no direct specialist start routes while preserving Leader messages and task responses', () => {
    const routes = new Map(API_ROUTE_INVENTORY.map(item => [item.route, item.methods]));
    expect(routes.get('/api/sites/:siteId/agents/:agentId/runs')).toEqual(['GET']);
    for (const route of [
      '/api/sites/:siteId/research/run',
      '/api/sites/:siteId/research/run-missing',
      '/api/sites/:siteId/topic-decision/run',
      '/api/sites/:siteId/content-production/:groupId/retry',
    ]) expect(routes.has(route), route).toBe(false);
    expect(routes.get('/api/sites/:siteId/leader/conversations/:conversationId/messages')).toContain('POST');
    expect(routes.get('/api/sites/:siteId/agent-panel/:agentId/tasks/:taskId/responses')).toContain('POST');
  });
});
