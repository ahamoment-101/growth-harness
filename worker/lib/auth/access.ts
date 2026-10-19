export type ConsoleAccessClass =
  | 'public'
  | 'session_optional'
  | 'workspace'
  | 'workspace_agent'
  | 'public_content'
  | 'static_asset';

export type ApiRouteInventoryItem = {
  route: string;
  methods: readonly string[];
  access: ConsoleAccessClass;
  originProtected: boolean;
};

const item = (
  route: string,
  methods: readonly string[],
  access: ConsoleAccessClass,
  originProtected = methods.some((method) => !['GET', 'HEAD'].includes(method)),
): ApiRouteInventoryItem => ({ route, methods, access, originProtected });

// This is the reviewable API contract. Dynamic segments use :name, and multiple
// behaviors on the same pathname share one row when their access boundary is identical.
export const API_ROUTE_INVENTORY = [
  item('/api/sites/:siteId/leader/conversations', ['GET','POST'], 'workspace_agent'),
  item('/api/sites/:siteId/leader/conversations/:conversationId', ['GET'], 'workspace_agent'),
  item('/api/sites/:siteId/leader/conversations/:conversationId/messages', ['POST'], 'workspace_agent'),
  item('/api/sites/:siteId/ledger', ['GET'], 'workspace'),
  // WebSocket upgrade to the site's live room; Origin is checked explicitly because the handshake is a GET.
  item('/api/sites/:siteId/room', ['GET'], 'workspace'),
  item('/api/sites/:siteId/activity', ['GET'], 'workspace'),
  item('/api/sites/:siteId/keyword-library/languages', ['GET'], 'workspace'),
  item('/api/sites/:siteId/keyword-library/entries', ['GET'], 'workspace'),
  item('/api/sites/:siteId/keyword-library/entries/:entryId', ['GET'], 'workspace'),
  item('/api/sites/:siteId/keyword-library/logs', ['GET'], 'workspace'),
  item('/api/sites/:siteId/keyword-library/topics/:topicId', ['GET'], 'workspace'),
  item('/api/health', ['GET'], 'public'),
  item('/api/auth/login', ['GET'], 'public'),
  item('/api/auth/google/callback', ['GET'], 'public'),
  item('/api/auth/me', ['GET'], 'session_optional'),
  item('/api/auth/setup', ['POST'], 'public'),
  item('/api/auth/password/login', ['POST'], 'public'),
  item('/api/auth/password', ['POST'], 'workspace'),
  item('/api/auth/google/link', ['GET'], 'workspace'),
  item('/api/auth/logout', ['POST'], 'session_optional'),
  item('/api/sites/:siteId/agents/:agentId/runs/:runId/events', ['GET'], 'workspace_agent'),
  item('/api/sites/:siteId/agents/:agentId/runs/:runId/commands', ['POST'], 'workspace_agent'),
  item('/api/sites/:siteId/agents/:agentId/memories', ['GET'], 'workspace_agent'),
  item('/api/sites/:siteId/agents/:agentId/drafts', ['GET'], 'workspace_agent'),
  item('/api/sites/:siteId/agents/:agentId/runs', ['GET'], 'workspace_agent'),
  item('/api/agent-runtime/probe', ['GET', 'POST'], 'workspace_agent'),
  item('/api/sites/:siteId/topic-decision', ['GET'], 'workspace_agent'),
  item('/api/sites/:siteId/topic-decision/groups/:groupId/approve', ['POST'], 'workspace_agent'),
  item('/api/sites/:siteId/topic-decision/groups/:groupId/reject', ['POST'], 'workspace_agent'),
  item('/api/sites/:siteId/content-production', ['GET'], 'workspace'),
  item('/api/sites/:siteId/gsc', ['GET'], 'workspace'),
  item('/api/sites/:siteId/gsc/oauth/start', ['GET', 'POST'], 'workspace'),
  item('/api/gsc/oauth/callback', ['GET'], 'workspace'),
  item('/api/sites/:siteId/gsc/verify-property', ['POST'], 'workspace'),
  item('/api/sites/:siteId/gsc/submit-sitemap', ['POST'], 'workspace'),
  item('/api/sites/:siteId/gsc/analytics', ['GET', 'POST'], 'workspace'),
  item('/api/sites/:siteId/research', ['GET'], 'workspace'),
  item('/api/sites/:siteId/agent-roster', ['GET'], 'workspace'),
  item('/api/sites/:siteId/agent-panel/:agentId', ['GET'], 'workspace_agent'),
  item('/api/sites/:siteId/agent-panel/:agentId/tasks/:taskId', ['GET'], 'workspace_agent'),
  item('/api/sites/:siteId/agent-panel/:agentId/tasks/:taskId/responses', ['POST'], 'workspace_agent'),
  item('/api/sites/:siteId/team-status/:agentId/seen', ['POST'], 'workspace'),
  item('/api/sites/:siteId/team-status/:agentId/seen-all', ['POST'], 'workspace'),
  item('/api/sites/:siteId/business', ['GET'], 'workspace'),
  item('/api/sites/:siteId/business/:moduleKey', ['POST'], 'workspace'),
  item('/api/sites', ['GET', 'POST'], 'workspace'),
  item('/api/sites/:siteId', ['GET', 'POST'], 'workspace'),
  item('/api/sites/:siteId/test', ['POST'], 'workspace'),
  item('/api/sites/:siteId/topics', ['GET', 'POST'], 'workspace'),
  item('/api/sites/:siteId/jobs', ['GET'], 'workspace'),
  item('/api/sites/:siteId/jobs/import', ['POST'], 'workspace'),
  item('/api/sites/:siteId/seed-pack', ['POST'], 'workspace'),
  item('/api/sites/:siteId/run-next', ['POST'], 'workspace'),
  item('/api/sites/:siteId/check-host', ['POST'], 'workspace'),
  item('/api/jobs', ['POST'], 'workspace'),
  item('/api/jobs/:jobId', ['GET', 'PATCH'], 'workspace'),
  item('/api/jobs/:jobId/approve', ['POST'], 'workspace_agent'),
  item('/api/jobs/:jobId/reject', ['POST'], 'workspace_agent'),
  item('/api/jobs/:jobId/visibility', ['POST'], 'workspace'),
  item('/api/jobs/:jobId/localize', ['POST'], 'workspace_agent'),
  item('/api/jobs/:jobId/localizations/:locale', ['DELETE'], 'workspace'),
  item('/api/dev/mock-ingest', ['POST'], 'workspace'),
  item('/api/dev/seed-job', ['POST'], 'workspace'),
] as const satisfies readonly ApiRouteInventoryItem[];

export function classifyConsoleRequest(path: string): ConsoleAccessClass {
  if (path.startsWith('/agents/')) return 'workspace_agent';
  if (path.startsWith('/live/')) return 'public_content';
  if (path === '/api/health' || path === '/api/auth/login' || path === '/api/auth/google/callback' || path === '/api/auth/setup' || path === '/api/auth/password/login') return 'public';
  if (path === '/api/auth/me' || path === '/api/auth/logout') return 'session_optional';
  if (
    path === '/api/agent-runtime/probe' ||
    /^\/api\/sites\/[^/]+\/leader(?:\/|$)/.test(path) ||
    /^\/api\/sites\/[^/]+\/agents\//.test(path) ||
    /^\/api\/sites\/[^/]+\/agent-panel\//.test(path) ||
    /^\/api\/sites\/[^/]+\/topic-decision(?:\/|$)/.test(path) ||
    /^\/api\/jobs\/[^/]+\/(?:approve|reject|localize)$/.test(path)
  ) return 'workspace_agent';
  // Unknown API paths stay behind the Workspace boundary before returning 404.
  if (path.startsWith('/api/')) return 'workspace';
  return 'static_asset';
}

export function accessRequiresWorkspace(access: ConsoleAccessClass): boolean {
  return access === 'workspace' || access === 'workspace_agent';
}

export function accessRequiresPrincipal(access: ConsoleAccessClass, _authMode: string | undefined): boolean {
  return access === 'workspace_agent' || access === 'workspace';
}
