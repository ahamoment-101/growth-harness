import { handleApplicationAuth } from './lib/auth/http';
import { handleLeaderRequest } from './growth-leader/routes';
import { isLeaderConversationResponseRoute } from './growth-leader/response-route';
import { recoverLeaderDeliveries } from './growth-leader/service';
import { dispatchDailyTriggers, readDailyTrigger, saveDailyTrigger } from './growth-leader/daily-triggers';
import { dispatchPendingAgentEvents } from './agent-events/pool';
import { readSiteLedger } from './site-ledger';
import { activityCursor, readAgentActivity } from './team-status/activity';
import { respondToWork } from './agent-work';
import { taskForRun } from './agent-runtime/task-store';
import type { WorkResponse } from '../shared/agent-work';
import { contentGroupInstance } from './agent-runtime/content-production';
import { topicScopeSchema } from './agent-runtime/topic-scope';
import { handleKeywordLibrary } from './keyword-library/http';
import { readRuntimeJson } from './agent-runtime/runtime-content';
import { businessResearchProcess } from './lib/business-research-process';
import { reconcileFirecrawlCancellations } from './agent-runtime/firecrawl-research';
import { reconcileTaskExecutions } from './agent-runtime/task-recovery';
import { requestModelText } from './lib/model-request';
import { resolveModelProfile } from './agent-runtime/model-registry';
import { agentDefinition, agentRoster } from './agent-runtime/definitions';
import { markSeen, markAllHistorySeen } from './team-status';
import { readAgentPanel, readAgentPanelTask } from './team-status/panel';
import { executeTaskCommand, recoverTaskCommand } from './agent-runtime/task-commands';
import examplePack from '../packs/example.json';
import { handleDevelopmentRequest } from './lib/development-routes';
import { serveHosted, serveLive } from './blog/live';
import { ownsArticleUrl } from './blog/url-history';
import { mergeSeoIdentity } from './blog/seo';
import { articlePresentationPatch } from '../shared/article-presentation';
import { markdownSubsetIssues } from './lib/qa';
import {
  buildAuthUrl,
  encryptToken,
  exchangeCode,
  fetchGoogleEmail,
  gscAddProperty,
  gscSubmitSitemap as gscApiSubmitSitemap,
  gscSearchAnalytics,
  gscSearchAnalyticsAll,
  getAccessToken,
} from './lib/gsc';
import {
  emptyJob,
  getJobForWorkspace,
  getSiteByDomain,
  getSiteByRootDomain,
  insertJob,
  insertSite,
  insertTopic,
  isoNow,
  latestGscFetchDate,
  listJobs,
  listSites,
  listTopics,
  newId,
  publicJob,
  publicSite,
  countsForSites,
  emptyCounts,
  countGscAnalytics,
  queryGscAnalytics,
  queryGscDaily,
  updateJob,
  updateSite,
  upsertGscAnalytics,
  upsertGscDaily,
  type GscAnalyticsRow,
  type GscDailyRow,
} from './db';
import { checkHost, cnameTargetOf } from './lib/hosting';
import { defaultBlogHost, parseHostname, registrableDomain } from '../shared/domain';
import { isBusinessModuleKey } from '../shared/business';
import { normalizeBlogLayout } from '../shared/blog-layouts';
import { listBusinessModules, saveBusinessModule } from './lib/business';
import {
  LocalePolicyError,
  normalizeProductOrigin,
  parseHubUrls,
  parseLocalePolicy,
  persistableLocalePolicy,
  serializeLocalePolicy,
  sourceLocaleOf,
  type LocalePolicy,
} from './blog/seo';
import { mergeNameByLocalePatch } from './blog/site-name';
import { startPublish } from './lib/dispatch';
import { reconcilePublicationDispatches } from './lib/publication-dispatch-recovery';
import { dispatchTopicResearchRequests } from './lib/research/dispatch';
import { listStrategyLocaleSummaries, strategyPayload } from './lib/research/strategy-store';
import { SLUG_RE } from './lib/qa';
import { normalizeImportArticle, type ImportedArticle } from './lib/import-article';
import { buildWebhookPosts, jobGenerationLocales, webhookExportEnabled } from './lib/webhook';
import { jobVersions, upsertVersion, versionsPatch } from './lib/versions';
import { jobDetailVersions } from './lib/job-detail';
import { continueContentRevision } from './agent-runtime/content-revision-dispatch';
import { EMPTY_SITE_GSC, EMPTY_SITE_RESEARCH, type ArticleVersion, type JobVisibility, type Site, type WebhookField } from './types';
import { PublishWorkflow } from './workflows/publish';
import { LocalizeWorkflow } from './workflows/localize';
import {
  claimLocalization,
  listLocalizations,
  localizationView,
  missingLocales,
  removeLocalizedVersion,
  setLocalizationStatus,
  sourceVersionOf,
} from './lib/localize';
import { getAgentByName, routeAgentRequest } from 'agents';
import { AgentRuntimeProbe, type StartDurableOnlyProbeInput, type StartRuntimeProbeInput } from './agent-runtime/agent';
import { AgentRuntimeProbeWorkflow } from './agent-runtime/workflow';
import { isAgentId, parseRuntimeAgentName, runtimeAgentName } from './agent-runtime/definitions';
import { AgentShell } from './agent-runtime/shell';
import { SiteRoom } from './site-room/room';
import { pokeChangedSites, pokeSite, pruneSiteChanges, roomName } from './site-room/poke';
import { AgentRuntimeWorkflow } from './agent-runtime/durable-workflow';
import { disposeRpcResource } from './agent-runtime/rpc-resource';
import { appendAgentEvent, getAgentRun, listAgentEvents, listAgentRuns } from './agent-runtime/store';
import { startRuntimeRun } from './agent-runtime/run-service';
import { listWorkingDrafts } from './agent-runtime/working-draft';
import { agentCommandFailure, agentCommandWasApplied, executeAgentCommand, isAgentCommandName } from './agent-runtime/commands';
import { listAgentMemories } from './agent-runtime/memory';
import type { AgentRun } from './agent-runtime/protocol';
import {
  approveTopicDecisionResult,
  publicTopicDecisionResult,
  rejectTopicDecisionResult,
  topicDecisionPayload,
} from './agent-runtime/topic-decision-store';
import {
  contentProductionGroupPayload,
  contentProductionPayload,
  publicationQa,
  recordContentReviewInteraction,
} from './agent-runtime/content-production';
import {
  PRIMARY_WORKSPACE_ID,
  getWorkspaceSite,
  listWorkspaceSites,
} from './lib/auth/store';
import { accessRequiresPrincipal, classifyConsoleRequest } from './lib/auth/access';
import { agentTransportOriginError, unsafeOriginError } from './lib/auth/origin';
import { signJson, verifySignedJson } from './lib/auth/crypto';
import {
  authenticateRequest,
} from './lib/auth/session';

export { AgentRuntimeProbe, AgentRuntimeProbeWorkflow, AgentRuntimeWorkflow, AgentShell, LocalizeWorkflow, PublishWorkflow, SiteRoom };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/agents/agent-runtime-probe/')) {
        if (env.AGENT_RUNTIME_PROBE_ENABLED !== 'true') return json({ error: 'not found' }, 404);
        const originError = agentTransportOriginError(request);
        if (originError) return json({ error: originError }, 403);
        const principal = await authenticateRequest(env.DB, request);
        if (!principal) return json({ error: 'authentication required' }, 401);
        const parsed = parseRuntimeAgentName(path.slice('/agents/agent-runtime-probe/'.length).split('/')[0]);
        if (!parsed || parsed.workspaceId !== principal.workspace.id || !await getWorkspaceSite(env.DB, principal.workspace.id, parsed.siteId)) {
          return json({ error: 'not found' }, 404);
        }
        const agentResponse = await routeAgentRequest(request, env);
        if (agentResponse) return agentResponse;
      }
      if (path.startsWith('/agents/agent-shell/')) {
        if (env.AGENT_RUNTIME_ENABLED !== 'true') return json({ error: 'not found' }, 404);
        const originError = agentTransportOriginError(request);
        if (originError) return json({ error: originError }, 403);
        const principal = await authenticateRequest(env.DB, request);
        if (!principal) return json({ error: 'authentication required' }, 401);
        const parsed = parseRuntimeAgentName(path.slice('/agents/agent-shell/'.length).split('/')[0]);
        if (
          !parsed || parsed.workspaceId !== principal.workspace.id ||
          !await getWorkspaceSite(env.DB, principal.workspace.id, parsed.siteId)
        ) return json({ error: 'not found' }, 404);
        const agentResponse = await routeAgentRequest(request, env);
        if (agentResponse) return agentResponse;
      }
      const response = await handle(request, env, ctx);
      // Writes through the console wake the affected site's live room; the minute backstop covers the rest.
      if (request.method !== 'GET' && request.method !== 'HEAD' && response.status < 400) ctx.waitUntil(pokeAfterWrite(env, path));
      return response;
    } catch (err) {
      if (err instanceof LocalePolicyError) {
        return json({ error: err.message, issues: err.issues }, 400);
      }
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes('not found') ? 404 : 500;
      return json({ error: message }, status);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const at = new Date(event.scheduledTime);
    if (event.cron === '* * * * *') {
      // Independent recoveries: one failing must not starve the others or the live-view backstop.
      const jobs: Array<[string, () => Promise<unknown>]> = [
        ['task executions', () => reconcileTaskExecutions(env, at)],
        ['publication dispatches', () => reconcilePublicationDispatches(env, at)],
        ['leader deliveries', () => recoverLeaderDeliveries(env)],
        ['daily triggers', () => dispatchDailyTriggers(env, at)],
        ['firecrawl cancellations', () => reconcileFirecrawlCancellations(env)],
        ['topic research requests', () => dispatchTopicResearchRequests(env)],
        // Last: rooms of every site changed by anything above or since the previous minute.
        ['site room backstop', () => pokeChangedSites(env)],
      ];
      for (const [name, job] of jobs) {
        try { await job(); } catch (error) { console.error(`Minute job failed: ${name}`, String(error)); }
      }
      return;
    }
    try { await pruneSiteChanges(env, at.getTime()); } catch (error) { console.error('Site change pruning failed', String(error)); }
    const utcHour = at.getUTCHours();
    if (utcHour === 0) {
      try { await dispatchPendingAgentEvents(env); } catch (error) { console.error('Daily agent event dispatch pending', String(error)); }
    }
    if (utcHour === 6) {
      const sites = await listSites(env.DB);
      for (const site of sites) {
        if (site.gsc_oauth_status !== 'connected' || !site.gsc_refresh_token_cipher) continue;
        try {
          await syncGscDataForSite(env, site);
        } catch (error) {
          console.error('GSC sync failed', { siteId: site.id, error: String(error) });
        }
      }
    }
  },
};

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  const hosted =
    !isConsoleHost(url.hostname) ? await getSiteByDomain(env.DB, url.hostname) : null;
  if (hosted) {
    return serveHosted(request, env, hosted);
  }

  if (method === 'GET' && path.startsWith('/live/')) {
    return serveLive(request, env);
  }

  if (method === 'GET' && path === '/api/health') {
    return json({ ok: true });
  }

  const authResponse = await handleApplicationAuth(request, env);
  if (authResponse) return authResponse;

  const principal = await authenticateRequest(env.DB, request);
  const accessClass = classifyConsoleRequest(path);
  if (accessRequiresPrincipal(accessClass, env.APP_AUTH_MODE) && !principal) {
    return json({ error: 'authentication required' }, 401);
  }
  if (path.startsWith('/api/') && method !== 'GET' && method !== 'HEAD') {
    const originError = unsafeOriginError(request);
    if (originError) return json({ error: originError }, 403);
  }
  const workspaceId = principal?.workspace.id ?? PRIMARY_WORKSPACE_ID;
  const ownedSite = (siteId: string) => getWorkspaceSite(env.DB, workspaceId, siteId);

  const libraryResponse = await handleKeywordLibrary(request, env.DB, principal?.workspace.id);
  if (libraryResponse) return libraryResponse;

  const dailyTriggerMatch = path.match(/^\/api\/sites\/([^/]+)\/daily-trigger$/);
  if (dailyTriggerMatch) {
    if (!principal) return json({ error: 'authentication required' }, 401);
    const siteId = decodeURIComponent(dailyTriggerMatch[1]);
    if (!await ownedSite(siteId)) return json({ error: 'site not found' }, 404);
    if (method === 'GET') return json({ trigger: await readDailyTrigger(env.DB, workspaceId, siteId) });
    if (method !== 'PUT') return json({ error: 'method not supported' }, 405);
    try {
      const body = await readJson(request);
      return json({ trigger: await saveDailyTrigger(env.DB, workspaceId, siteId, body) });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Invalid trigger configuration' }, 400);
    }
  }

  const topicDecisionMatch = path.match(
    /^\/api\/sites\/([^/]+)\/topic-decision(?:\/groups\/([^/]+)\/(approve|reject))?$/,
  );
  if (topicDecisionMatch) {
    if (!principal) return json({ error: 'authentication required' }, 401);
    const siteId = decodeURIComponent(topicDecisionMatch[1]);
    const resultId = topicDecisionMatch[2] ? decodeURIComponent(topicDecisionMatch[2]) : '';
    const reviewAction = topicDecisionMatch[3];
    const site = await ownedSite(siteId);
    if (!site) return json({ error: 'not found' }, 404);
    if (method === 'GET' && !reviewAction) {
      if (url.searchParams.get('view') === 'scopes') {
        const rows = { results: [...new Set([site.source_locale, ...JSON.parse(site.translate_locales_json || '[]')])].map(locale => ({ locale })) };
        return json({ scopes: rows.results });
      }
      const requestedScope = topicScopeSchema.safeParse({ locale: url.searchParams.get('locale') });
      if (!requestedScope.success) return json({ error: 'Please select a valid language' }, 400);
      return json({
        ...(await topicDecisionPayload(env.DB, workspaceId, siteId, requestedScope.data)),
        runtime_agent_name: runtimeAgentName(workspaceId, siteId, 'topic_decision'),
      });
    }
    if (method !== 'POST') return json({ error: 'method not supported' }, 405);
    if (env.AGENT_RUNTIME_ENABLED !== 'true') return json({ error: 'Agent Runtime is disabled' }, 503);
    const body = await readJson(request);
    if (reviewAction === 'reject') {
      try {
        const result = await rejectTopicDecisionResult({
          db: env.DB, workspaceId, siteId, resultId, actorId: principal.user.id, note: str(body.note),
        });
        let auditError = '';
        try {
          await appendAgentEvent(env.DB, {
            runId: result.run_id, eventKey: `topic.group-rejected:${result.id}`, kind: 'group_rejected',
            phase: 'human_review', actorType: 'user', actorId: principal.user.id,
            payload: { result_id: result.id, note: str(body.note).slice(0, 2000) },
          });
        } catch (error) {
          auditError = error instanceof Error ? error.message : String(error);
        }
        return json({
          result: await publicTopicDecisionResult(env.DB, workspaceId, siteId, result.id),
          audit_error: auditError,
        });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
    }
    if (reviewAction === 'approve') {
      try {
        const productionGroupId = newId();
        const parentRunId = newId();
        const approved = await approveTopicDecisionResult({
          db: env.DB, workspaceId, siteId, resultId, actorId: principal.user.id, note: str(body.note),
          productionGroupId, parentRunId,
        });
        let auditError = '';
        try {
          await appendAgentEvent(env.DB, {
            runId: approved.result.run_id, eventKey: `topic.group-approved:${approved.result.id}`, kind: 'group_approved',
            phase: 'human_review', actorType: 'user', actorId: principal.user.id,
            payload: { result_id: approved.result.id, job_ids: approved.jobIds, note: str(body.note).slice(0, 2000) },
          });
        } catch (error) {
          auditError = error instanceof Error ? error.message : String(error);
        }
        let dispatchError = '';
        try {
          await startRuntimeRun(env, {
            runId: parentRunId, workspaceId, siteId, agentId: 'content_production', instanceId: contentGroupInstance(productionGroupId), trigger: 'manual',
            summary: { group_id: productionGroupId, decision_group_id: approved.result.id },
          });
        } catch (error) {
          dispatchError = error instanceof Error ? error.message : String(error);
          await env.DB.prepare(
            "update content_production_groups set status = 'needs_attention', error = ?, updated_at = ? where id = ?",
          ).bind(dispatchError.slice(0, 1000), isoNow(), productionGroupId).run();
        }
        return json({
          result: await publicTopicDecisionResult(env.DB, workspaceId, siteId, approved.result.id),
          job_ids: approved.jobIds,
          production_group_id: productionGroupId,
          parent_run_id: parentRunId,
          dispatch_error: dispatchError,
          audit_error: auditError,
        });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
    }
    return json({ error: 'not found' }, 404);
  }

  const contentProductionGroupMatch = path.match(/^\/api\/sites\/([^/]+)\/content-production\/([^/]+)$/);
  if (contentProductionGroupMatch && method === 'GET') {
    const siteId = decodeURIComponent(contentProductionGroupMatch[1]);
    const groupId = decodeURIComponent(contentProductionGroupMatch[2]);
    if (!await ownedSite(siteId)) return json({ error: 'site not found' }, 404);
    return json(await contentProductionGroupPayload(env.DB, workspaceId, siteId, groupId));
  }

  const contentProductionMatch = path.match(/^\/api\/sites\/([^/]+)\/content-production$/);
  if (contentProductionMatch && method === 'GET') {
    const siteId = decodeURIComponent(contentProductionMatch[1]);
    if (!await ownedSite(siteId)) return json({ error: 'site not found' }, 404);
    return json(await contentProductionPayload(env.DB, workspaceId, siteId));
  }

  const agentEventsMatch = path.match(/^\/api\/sites\/([^/]+)\/agents\/([^/]+)\/runs\/([^/]+)\/events$/);
  if (agentEventsMatch) {
    if (!principal) return json({ error: 'authentication required' }, 401);
    if (method !== 'GET') return json({ error: 'method not supported' }, 405);
    const siteId = decodeURIComponent(agentEventsMatch[1]);
    const agentId = decodeURIComponent(agentEventsMatch[2]);
    const runId = decodeURIComponent(agentEventsMatch[3]);
    if (!isAgentId(agentId) || !await ownedSite(siteId)) return json({ error: 'not found' }, 404);
    const run = await getAgentRun(env.DB, runId);
    if (!run || run.workspace_id !== workspaceId || run.site_id !== siteId || run.agent_id !== agentId) return json({ error: 'not found' }, 404);
    return json({ events: await listAgentEvents(env.DB, runId, Number(url.searchParams.get('after_seq') || 0)) });
  }

  const agentCommandsMatch = path.match(/^\/api\/sites\/([^/]+)\/agents\/([^/]+)\/runs\/([^/]+)\/commands$/);
  if (agentCommandsMatch) {
    if (!principal) return json({ error: 'authentication required' }, 401);
    if (method !== 'POST') return json({ error: 'method not supported' }, 405);
    const siteId = decodeURIComponent(agentCommandsMatch[1]);
    const agentId = decodeURIComponent(agentCommandsMatch[2]);
    const runId = decodeURIComponent(agentCommandsMatch[3]);
    if (!isAgentId(agentId) || !await ownedSite(siteId)) return json({ error: 'not found' }, 404);
    const run = await getAgentRun(env.DB, runId);
    if (!run || run.workspace_id !== workspaceId || run.site_id !== siteId || run.agent_id !== agentId) return json({ error: 'not found' }, 404);
    const body = await readJson(request);
    const command = str(body.command);
    if (!isAgentCommandName(command)) return json({ error: 'Unknown Agent command' }, 400);
    const reason = str(body.reason);
    const commandId = str(body.command_id) || request.headers.get('Idempotency-Key') || crypto.randomUUID();
    const name = runtimeAgentName(workspaceId, siteId, agentId, run.agent_instance_id);
    const taskBased = agentDefinition(agentId).taskBased;
    if (taskBased) {
      try { return json(await executeTaskCommand(env, { run, command, commandId, actorId: principal.user.id, reason, value: str(body.value) }), 202); }
      catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 409); }
    }
    const shell = taskBased || command === 'retry' || command === 'resume' ? null : await getAgentByName(env.AGENT_SHELL, name);
    try {
      const result = await executeAgentCommand(env.DB, {
        commandId, runId, command, actorId: principal.user.id, source: 'ui', payload: body,
      }, async () => {
        if (taskBased) return executeTaskCommand(env, { run, command, commandId, actorId: principal.user.id, reason, value: str(body.value) });
        if (command === 'cancel') await shell!.cancelRun(runId, principal.user.id, reason, commandId);
        else if (command === 'approve') await shell!.approveRun(runId, principal.user.id, reason, commandId);
        else if (command === 'reject') await shell!.rejectRun(runId, principal.user.id, reason, commandId);
        else if (command === 'provide_input') await shell!.provideInput(runId, principal.user.id, str(body.value), commandId);
        else {
          if (env.AGENT_RUNTIME_ENABLED !== 'true') throw new Error('Agent Runtime is disabled');
          if (!['failed', 'cancelled'].includes(run.status)) throw new Error('Only failed or cancelled runs can be retried');
          return { run: await startRuntimeRun(env, {
            workspaceId, siteId, agentId, instanceId: run.agent_instance_id, trigger: 'retry', retryOfRunId: runId,
            summary: JSON.parse(run.summary_json || '{}'),
          }) };
        }
        return { run: await getAgentRun(env.DB, runId) };
      }, async () => {
        if (taskBased) return recoverTaskCommand(env, { run, command, commandId, actorId: principal.user.id, reason, value: str(body.value) });
        if (command === 'retry' || command === 'resume') {
          const recovered = await env.DB.prepare(
            `select * from agent_runs where retry_of_run_id = ? and workspace_id = ? and site_id = ? and agent_id = ?
             order by created_at desc limit 1`,
          ).bind(runId, workspaceId, siteId, agentId).first<AgentRun>();
          return recovered ? { run: recovered } : null;
        }
        const applied = await agentCommandWasApplied(env.DB, {
          runId, commandId, command, actorId: principal.user.id,
        });
        return applied ? { run: await getAgentRun(env.DB, runId) } : null;
      });
      return json(result, command === 'retry' || command === 'resume' ? 202 : 200);
    } catch (error) {
      const failure = agentCommandFailure(error);
      return json({ error: failure.error }, failure.status);
    } finally {
      disposeRpcResource(shell);
    }
  }

  const agentMemoriesMatch = path.match(/^\/api\/sites\/([^/]+)\/agents\/([^/]+)\/memories$/);
  if (agentMemoriesMatch) {
    if (!principal) return json({ error: 'authentication required' }, 401);
    if (method !== 'GET') return json({ error: 'method not supported' }, 405);
    const siteId = decodeURIComponent(agentMemoriesMatch[1]);
    const agentId = decodeURIComponent(agentMemoriesMatch[2]);
    if (!isAgentId(agentId) || !await ownedSite(siteId)) return json({ error: 'not found' }, 404);
    return json({ memories: await listAgentMemories(env.DB, workspaceId, siteId, agentId) });
  }

  const agentDraftsMatch = path.match(/^\/api\/sites\/([^/]+)\/agents\/([^/]+)\/drafts$/);
  if (agentDraftsMatch) {
    if (!principal) return json({ error: 'authentication required' }, 401);
    if (method !== 'GET') return json({ error: 'method not supported' }, 405);
    const siteId = decodeURIComponent(agentDraftsMatch[1]);
    const agentId = decodeURIComponent(agentDraftsMatch[2]);
    if (!isAgentId(agentId) || !await ownedSite(siteId)) return json({ error: 'not found' }, 404);
    // Returned exactly as stored. A draft is the Agent's own work in progress,
    // and reshaping it here would mean maintaining a second description of every
    // artifact the Runtime can produce.
    return json({ drafts: await listWorkingDrafts(env.DB, { workspaceId, siteId, agentId }) });
  }

  const agentRunsMatch = path.match(/^\/api\/sites\/([^/]+)\/agents\/([^/]+)\/runs$/);
  if (agentRunsMatch) {
    if (!principal) return json({ error: 'authentication required' }, 401);
    if (env.AGENT_RUNTIME_ENABLED !== 'true') return json({ error: 'Agent Runtime is disabled' }, 503);
    const siteId = decodeURIComponent(agentRunsMatch[1]);
    const agentId = decodeURIComponent(agentRunsMatch[2]);
    const site = isAgentId(agentId) ? await ownedSite(siteId) : null;
    if (!site || !isAgentId(agentId)) return json({ error: 'not found' }, 404);
    if (method === 'GET') return json({ runs: await listAgentRuns(env.DB, workspaceId, siteId, agentId) });
    return json({ error: 'method not supported' }, 405);
  }

  if (path === '/api/agent-runtime/probe') {
    if (!principal) return json({ error: 'authentication required' }, 401);
    if (env.AGENT_RUNTIME_PROBE_ENABLED !== 'true') return json({ error: 'agent runtime probe is disabled' }, 503);
    const body = method === 'POST' ? await readJson(request) : Object.fromEntries(url.searchParams);
    const siteId = str(body.site_id);
    const agentId = body.agent_id;
    if (!siteId || !isAgentId(agentId)) return json({ error: 'site_id or agent_id is invalid' }, 400);
    const site = await ownedSite(siteId);
    if (!site) return json({ error: 'site not found' }, 404);
    const agentName = runtimeAgentName(workspaceId, siteId, agentId);
    const agent = await getAgentByName(env.AGENT_RUNTIME_PROBE, agentName);
    try {
      if (method === 'GET') {
        return json({ agent_name: agentName, state: await agent.getSnapshot() });
      }
      if (method !== 'POST') return json({ error: 'method not supported' }, 405);

      if (body.mode === 'scheduled_runtime') {
        if (env.AGENT_RUNTIME_ENABLED !== 'true') return json({ error: 'Agent Runtime is disabled' }, 503);
        const scheduleKey = `runtime_synthetic:${new Date().toISOString().slice(0, 16)}`;
        const run = await startRuntimeRun(env, {
          workspaceId, siteId, agentId: 'runtime_synthetic', trigger: 'cron', scheduleKey,
          summary: { scenario: 'default', verification: 'scheduled_runtime' },
        });
        return json({ run, schedule_key: scheduleKey }, 202);
      }

      if (body.mode === 'durable_only') {
        const input: StartDurableOnlyProbeInput = { runId: newId(), agentId, siteId: site.id };
        return json({ agent_name: agentName, state: await agent.startDurableOnlyProbe(input) }, 202);
      }

      const input: StartRuntimeProbeInput = {
        runId: newId(),
        agentId,
        site: {
          id: site.id,
          name: site.name,
          domain: site.domain,
          productBrief: site.product_brief,
          researchSeedTerms: parseStringList(site.research_seed_terms_json),
          competitorDomains: parseStringList(site.competitor_domains_json),
        },
      };
      const state = await agent.startProbe(input);
      return json({ agent_name: agentName, state }, state.status === 'failed' ? 502 : 202);
    } finally {
      disposeRpcResource(agent);
    }
  }

  // ─── Search Console (GSC) ───────────────────────────────────────────────────

  const gscGetMatch = path.match(/^\/api\/sites\/([^/]+)\/gsc$/);
  if (gscGetMatch) {
    if (method !== 'GET') return json({ error: 'method not supported' }, 405);
    const siteId = decodeURIComponent(gscGetMatch[1]);
    const site = await ownedSite(siteId);
    if (!site) return json({ error: 'site not found' }, 404);
    return json({
      gsc: {
        oauth_status: site.gsc_oauth_status,
        google_account_email: site.gsc_google_account_email,
        property_url_prefix: site.gsc_property_url_prefix,
        property_verification_status: site.gsc_property_verification_status,
        property_verified_at: site.gsc_property_verified_at,
        sitemap_submit_status: site.gsc_sitemap_submit_status,
        sitemap_last_submit_at: site.gsc_sitemap_last_submit_at,
      },
    });
  }

  // Step 1: redirect browser to Google consent screen
  // Called by the frontend button; returns a redirect (not JSON).
  const gscOauthStartMatch = path.match(/^\/api\/sites\/([^/]+)\/gsc\/oauth\/start$/);
  if (gscOauthStartMatch) {
    if (method !== 'GET' && method !== 'POST') return json({ error: 'method not supported' }, 405);
    const clientId = env.GOOGLE_CLIENT_ID;
    if (!clientId || !env.AUTH_SESSION_SECRET || !principal) return json({ error: 'Google OAuth or application session is not configured' }, 503);
    const siteId = decodeURIComponent(gscOauthStartMatch[1]);
    const site = await ownedSite(siteId);
    if (!site) return json({ error: 'site not found' }, 404);
    const origin = new URL(request.url).origin;
    const redirectUri = `${origin}/api/gsc/oauth/callback`;
    const state = await signJson({
      siteId,
      userId: principal.user.id,
      expiresAt: Date.now() + 10 * 60 * 1000,
    }, env.AUTH_SESSION_SECRET);
    const authUrl = buildAuthUrl({ clientId, redirectUri, state });
    return Response.redirect(authUrl, 302);
  }

  // Step 2: Google redirects back here with ?code=...&state=...
  if (method === 'GET' && path === '/api/gsc/oauth/callback') {
    const code = url.searchParams.get('code');
    const stateRaw = url.searchParams.get('state');
    const errorParam = url.searchParams.get('error');
    const origin = url.origin;
    const redirectUri = `${origin}/api/gsc/oauth/callback`;

    if (errorParam) {
      return Response.redirect(`${origin}/?gsc_error=${encodeURIComponent(errorParam)}`, 302);
    }
    if (!code || !stateRaw) {
      return Response.redirect(`${origin}/?gsc_error=missing_code`, 302);
    }

    const state = env.AUTH_SESSION_SECRET
      ? await verifySignedJson<{ siteId: string; userId: string; expiresAt: number }>(stateRaw, env.AUTH_SESSION_SECRET)
      : null;
    if (!state || !principal || state.userId !== principal.user.id || state.expiresAt <= Date.now()) {
      return Response.redirect(`${origin}/?gsc_error=invalid_state`, 302);
    }
    const siteId = state.siteId;

    const site = await ownedSite(siteId);
    if (!site) return Response.redirect(`${origin}/?gsc_error=site_not_found`, 302);

    const clientId = env.GOOGLE_CLIENT_ID;
    const clientSecret = env.GOOGLE_CLIENT_SECRET;
    const cipherKey = env.GSC_TOKEN_CIPHER_KEY;
    if (!clientId || !clientSecret || !cipherKey) {
      return Response.redirect(`${origin}/?gsc_error=secrets_not_configured`, 302);
    }

    try {
      const tokens = await exchangeCode({ code, clientId, clientSecret, redirectUri });
      if (!tokens.refresh_token) {
        return Response.redirect(`${origin}/?gsc_error=no_refresh_token`, 302);
      }
      const cipher = await encryptToken(tokens.refresh_token, cipherKey);
      const email = await fetchGoogleEmail(tokens.access_token);
      // Derive property URL from domain if available
      const propertyUrl = site.domain ? `https://${site.domain}/` : '';
      await updateSite(env.DB, siteId, {
        gsc_oauth_status: 'connected',
        gsc_google_account_email: email,
        gsc_refresh_token_cipher: cipher,
        gsc_property_url_prefix: propertyUrl,
        gsc_property_verification_status: 'unverified',
      }, workspaceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'oauth_failed';
      return Response.redirect(`${origin}/?gsc_error=${encodeURIComponent(msg.slice(0, 200))}`, 302);
    }

    // Redirect back to the site settings page
    return Response.redirect(`${origin}/website/${siteId}/settings?tab=domain&gsc=connected`, 302);
  }

  // Step 3: Add GSC property (URL-prefix) for the customer
  const gscVerifyPropertyMatch = path.match(/^\/api\/sites\/([^/]+)\/gsc\/verify-property$/);
  if (gscVerifyPropertyMatch) {
    if (method !== 'POST') return json({ error: 'method not supported' }, 405);
    const siteId = decodeURIComponent(gscVerifyPropertyMatch[1]);
    const site = await ownedSite(siteId);
    if (!site) return json({ error: 'site not found' }, 404);
    if (site.gsc_oauth_status !== 'connected' || !site.gsc_refresh_token_cipher) {
      return json({ error: 'Please connect a Google account first' }, 400);
    }
    const clientId = env.GOOGLE_CLIENT_ID;
    const clientSecret = env.GOOGLE_CLIENT_SECRET;
    const cipherKey = env.GSC_TOKEN_CIPHER_KEY;
    if (!clientId || !clientSecret || !cipherKey) return json({ error: 'GSC secrets not configured' }, 503);
    try {
      const accessToken = await getAccessToken({
        gscRefreshTokenCipher: site.gsc_refresh_token_cipher,
        clientId,
        clientSecret,
        cipherKey,
      });
      const propertyUrl = site.gsc_property_url_prefix || (site.domain ? `https://${site.domain}/` : '');
      if (!propertyUrl) return json({ error: 'Site domain is not set' }, 400);
      await gscAddProperty(propertyUrl, accessToken);
      await updateSite(env.DB, siteId, {
        gsc_property_verification_status: 'verified',
        gsc_property_verified_at: isoNow(),
        gsc_property_url_prefix: propertyUrl,
      }, workspaceId);
      const updated = await ownedSite(siteId);
      const counts = await countsForSites(env.DB, [siteId]);
      return json({ ok: true, site: publicSite(updated!, counts.get(siteId) ?? emptyCounts(), cnameTargetOf(env)) });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'verify failed' }, 502);
    }
  }

  // Step 4: Manually submit sitemap
  const gscSubmitSitemapMatch = path.match(/^\/api\/sites\/([^/]+)\/gsc\/submit-sitemap$/);
  if (gscSubmitSitemapMatch) {
    if (method !== 'POST') return json({ error: 'method not supported' }, 405);
    const siteId = decodeURIComponent(gscSubmitSitemapMatch[1]);
    const site = await ownedSite(siteId);
    if (!site) return json({ error: 'site not found' }, 404);
    if (site.gsc_oauth_status !== 'connected' || !site.gsc_refresh_token_cipher) {
      return json({ error: 'Please connect a Google account first' }, 400);
    }
    const clientId = env.GOOGLE_CLIENT_ID;
    const clientSecret = env.GOOGLE_CLIENT_SECRET;
    const cipherKey = env.GSC_TOKEN_CIPHER_KEY;
    if (!clientId || !clientSecret || !cipherKey) return json({ error: 'GSC secrets not configured' }, 503);
    try {
      const accessToken = await getAccessToken({
        gscRefreshTokenCipher: site.gsc_refresh_token_cipher,
        clientId,
        clientSecret,
        cipherKey,
      });
      const propertyUrl = site.gsc_property_url_prefix || (site.domain ? `https://${site.domain}/` : '');
      if (!propertyUrl) return json({ error: 'Site domain is not set' }, 400);
      const live = site.domain_status === 'live' && site.domain;
      const sitemapUrl = live ? `https://${site.domain}/sitemap.xml` : '';
      if (!sitemapUrl) return json({ error: 'The site is not yet live; the sitemap URL is unavailable' }, 400);
      await gscApiSubmitSitemap(propertyUrl, sitemapUrl, accessToken);
      await updateSite(env.DB, siteId, {
        gsc_sitemap_submit_status: 'success',
        gsc_sitemap_last_submit_at: isoNow(),
      }, workspaceId);
      const updated = await ownedSite(siteId);
      const counts = await countsForSites(env.DB, [siteId]);
      return json({ ok: true, site: publicSite(updated!, counts.get(siteId) ?? emptyCounts(), cnameTargetOf(env)) });
    } catch (err) {
      await updateSite(env.DB, siteId, { gsc_sitemap_submit_status: 'error' }, workspaceId);
      return json({ error: err instanceof Error ? err.message : 'submit failed' }, 502);
    }
  }

  // Step 5: GSC Search Analytics — GET reads from D1, POST triggers manual sync
  const gscAnalyticsMatch = path.match(/^\/api\/sites\/([^/]+)\/gsc\/analytics$/);
  if (gscAnalyticsMatch) {
    const siteId = decodeURIComponent(gscAnalyticsMatch[1]);
    const site = await ownedSite(siteId);
    if (!site) return json({ error: 'site not found' }, 404);

    // POST = manual sync from GSC API → D1
    if (method === 'POST') {
      if (site.gsc_oauth_status !== 'connected' || !site.gsc_refresh_token_cipher) {
        return json({ error: 'Please connect a Google account first' }, 400);
      }
      try {
        const result = await syncGscDataForSite(env, site);
        return json({ ok: true, synced: result.synced });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : 'sync failed' }, 502);
      }
    }

    // GET = read from D1
    if (method !== 'GET') return json({ error: 'method not supported' }, 405);
    const end = new Date();
    end.setDate(end.getDate() - 3);
    const start = new Date(end);
    start.setDate(start.getDate() - 27);
    const startDate = url.searchParams.get('start') || start.toISOString().slice(0, 10);
    const endDate = url.searchParams.get('end') || end.toISOString().slice(0, 10);
    const dimension = url.searchParams.get('dimension') || 'query';

    if (dimension !== 'query' && dimension !== 'page') return json({ error: 'invalid dimension' }, 400);
    const requestedPage = Number(url.searchParams.get('page'));
    const page = Number.isSafeInteger(requestedPage) ? Math.max(1, Math.min(1000, requestedPage)) : 1;
    const pageSize = 100;
    const [rows, rowCount, daily, lastFetch] = await Promise.all([
      queryGscAnalytics(env.DB, siteId, dimension, startDate, endDate, pageSize, (page - 1) * pageSize),
      countGscAnalytics(env.DB, siteId, dimension, startDate, endDate),
      queryGscDaily(env.DB, siteId, startDate, endDate),
      latestGscFetchDate(env.DB, siteId),
    ]);

    return json({
      ok: true,
      startDate,
      endDate,
      dimension: [dimension],
      lastSyncDate: lastFetch,
      page,
      pageSize,
      rowCount,
      rows: rows.map((r) => ({ keys: [r.key], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
      daily: daily.map((r) => ({ keys: [r.date], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
    });
  }

  const researchMatch = path.match(/^\/api\/sites\/([^/]+)\/research(?:\/(locales))?$/);
  if (researchMatch) {
    const siteId = decodeURIComponent(researchMatch[1]);
    const action = researchMatch[2];
    const site = await ownedSite(siteId);
    if (!site) return json({ error: 'site not found' }, 404);
    const configuredLocales = uniqueLocales(
      [site.source_locale, ...parseStringList(site.translate_locales_json)],
      '',
    );

    if (action === 'locales' && method === 'GET') {
      return json({ locales: await listStrategyLocaleSummaries(env.DB, siteId, configuredLocales) });
    }

    if (!action && method === 'GET') {
      const requestedVersion = Number(url.searchParams.get('version'));
      const sourceLocale = url.searchParams.get('locale') || site.source_locale;
      const runtimeVisible = Boolean(principal);
      return json(await strategyPayload(
        env.DB,
        siteId,
        sourceLocale,
        Number.isInteger(requestedVersion) && requestedVersion > 0 ? requestedVersion : undefined,
        {
          includeRuntime: runtimeVisible,
          controlsEnabled: runtimeVisible,
          retryEnabled: env.AGENT_RUNTIME_ENABLED === 'true',
          chatEnabled: runtimeVisible && env.AGENT_RUNTIME_ENABLED === 'true',
        },
      ));
    }

    return json({ error: 'method not supported' }, 405);
  }

  const strategyProcessMatch = path.match(/^\/api\/sites\/([^/]+)\/strategy\/research-process$/);
  if (strategyProcessMatch && method === 'GET') {
    const siteId = decodeURIComponent(strategyProcessMatch[1]);
    if (!await ownedSite(siteId)) return json({ error: 'site not found' }, 404);
    if (!principal) return json({ error: 'authentication required' }, 401);
    const locale = url.searchParams.get('locale');
    if (!locale) return json({ error: 'locale required' }, 400);
    return json({ process: await businessResearchProcess(env.DB, siteId, workspaceId, { agentId: 'strategy_research', instanceId: `strategy:${locale}` }) });
  }
  const rosterMatch = path.match(/^\/api\/sites\/([^/]+)\/agent-roster$/);
  if (rosterMatch && method === 'GET') {
    if (!await ownedSite(decodeURIComponent(rosterMatch[1]))) return json({ error: 'site not found' }, 404);
    return json({ members: agentRoster() });
  }
  const agentPanelMatch = path.match(/^\/api\/sites\/([^/]+)\/agent-panel\/([^/]+)(?:\/tasks\/([^/]+)(\/responses)?)?$/);
  if (agentPanelMatch) {
    const [, rawSite, rawAgent, rawTask, responseAction] = agentPanelMatch;
    const siteId = decodeURIComponent(rawSite), agentId = decodeURIComponent(rawAgent);
    if (!await ownedSite(siteId) || !(agentRoster().some((m) => m.agentId === agentId)
      || await isLeaderConversationResponseRoute(env.DB, { workspaceId, siteId, agentId, taskId: rawTask || '', method, responseAction }))) return json({ error: 'not found' }, 404);
    const scope = { db: env.DB, workspaceId, siteId };
    if (responseAction && method === 'POST') {
      if (!principal) return json({ error: 'authentication required' }, 401);
      if (env.AGENT_RUNTIME_ENABLED !== 'true') return json({ error: 'Agent Runtime is disabled' }, 503);
      const owned = await env.DB.prepare('select active_run_id from agent_tasks where id=? and workspace_id=? and site_id=? and agent_id=?')
        .bind(decodeURIComponent(rawTask), workspaceId, siteId, agentId).first<{ active_run_id: string }>();
      const task = owned && await taskForRun(env.DB, owned.active_run_id);
      if (!task) return json({ error: 'task not found' }, 404);
      try { return json(await respondToWork(env, { ...scope, task }, await readJson(request) as WorkResponse, principal.user.id)); }
      catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 409); }
    }
    if (method !== 'GET' || responseAction) return json({ error: 'method not supported' }, 405);
    if (rawTask) {
      const before = url.searchParams.get('before');
      if (before) {
        try { const value = JSON.parse(before); if (!Array.isArray(value) || value.length !== 2 || !value.every(item => typeof item === 'string')) throw new Error(); }
        catch { return json({ error: 'invalid cursor' }, 400); }
      }
      const detail = await readAgentPanelTask(scope, agentId, decodeURIComponent(rawTask), url.searchParams.get('before') || '');
      return detail ? json(detail) : json({ error: 'task not found' }, 404);
    }
    const cursor = url.searchParams.get('cursor') || '';
    if (cursor) {
      try { const c = JSON.parse(cursor); if (!Array.isArray(c) || c.length !== 2 || !c.every((v: unknown) => typeof v === 'string')) throw new Error(); }
      catch { return json({ error: 'invalid cursor' }, 400); }
    }
    // The first page is pushed by the site room; HTTP serves older pages on demand.
    return json(await readAgentPanel(scope, agentId, cursor));
  }
  const leaderMatch = path.match(/^\/api\/sites\/([^/]+)\/leader(?:\/(.*))?$/);
  if (leaderMatch) {
    const siteId = decodeURIComponent(leaderMatch[1]);
    if (!principal || !await ownedSite(siteId)) return json({ error: 'site not found' }, 404);
    return handleLeaderRequest(request, env, { workspaceId, siteId }, principal.user.id, leaderMatch[2] || '', ctx);
  }
  const ledgerMatch = path.match(/^\/api\/sites\/([^/]+)\/ledger$/);
  if (ledgerMatch) {
    const siteId = decodeURIComponent(ledgerMatch[1]);
    if (!await ownedSite(siteId)) return json({ error: 'site not found' }, 404);
    if (method !== 'GET') return json({ error: 'method not supported' }, 405);
    const payload = await readSiteLedger({ db: env.DB, workspaceId, siteId }, { waitUntil: work => ctx.waitUntil(work) });
    const response = json(payload);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }
  const roomMatch = path.match(/^\/api\/sites\/([^/]+)\/room$/);
  if (roomMatch) {
    const siteId = decodeURIComponent(roomMatch[1]);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket upgrade required' }, 426);
    const originError = agentTransportOriginError(request);
    if (originError) return json({ error: originError }, 403);
    if (!principal) return json({ error: 'authentication required' }, 401);
    if (!await ownedSite(siteId)) return json({ error: 'site not found' }, 404);
    const headers = new Headers(request.headers);
    headers.set('X-Room-Site', siteId);
    headers.set('X-Room-User', principal.user.id);
    return env.SITE_ROOM.get(env.SITE_ROOM.idFromName(roomName(siteId))).fetch(new Request(request, { headers }));
  }
  const activityMatch = path.match(/^\/api\/sites\/([^/]+)\/activity$/);
  if (activityMatch) {
    const siteId = decodeURIComponent(activityMatch[1]);
    if (!await ownedSite(siteId)) return json({ error: 'site not found' }, 404);
    if (method !== 'GET') return json({ error: 'method not supported' }, 405);
    const cursor = url.searchParams.get('cursor') || '';
    try { activityCursor(cursor); } catch { return json({ error: 'invalid cursor' }, 400); }
    // The live first page comes from the site room; HTTP serves colleague filters and older pages on demand.
    return json(await readAgentActivity({ db: env.DB, workspaceId, siteId }, cursor, url.searchParams.get('agent_id') || ''));
  }
  const teamStatusMatch = path.match(/^\/api\/sites\/([^/]+)\/team-status(?:\/([^/]+)\/(seen|seen-all))?$/);
  if (teamStatusMatch) {
    const siteId = decodeURIComponent(teamStatusMatch[1]);
    if (!await ownedSite(siteId)) return json({ error: 'site not found' }, 404);
    const scope = { db: env.DB, workspaceId, siteId };
    // Bubbles are read only through the site room (worker/site-room); this route records read receipts.
    const team = agentRoster().map((member) => member.agentId);
    const agentId = teamStatusMatch[2] ? decodeURIComponent(teamStatusMatch[2]) : '';
    if (agentId && method === 'POST') {
      if (!team.includes(agentId)) return json({ error: 'agent not found' }, 404);
      if (teamStatusMatch[3] === 'seen-all') {
        await markAllHistorySeen(scope, agentId);
        return json({ ok: true });
      }
      const body = await readJson(request);
      if (!str(body.task_id) || !str(body.at)) return json({ error: 'task_id and at required' }, 400);
      await markSeen(scope, agentId, str(body.task_id), str(body.at));
      return json({ ok: true });
    }
    return json({ error: 'method not supported' }, 405);
  }
  const businessMatch = path.match(/^\/api\/sites\/([^/]+)\/business(?:\/([^/]+))?$/);
  if (businessMatch) {
    const siteId = decodeURIComponent(businessMatch[1]);
    const rawKey = businessMatch[2] ? decodeURIComponent(businessMatch[2]) : '';
    const site = await ownedSite(siteId);
    if (!site) return json({ error: 'site not found' }, 404);

    if (rawKey === 'research-process' && method === 'GET') {
      if (!principal) return json({ error: 'authentication required' }, 401);
      return json({ process: await businessResearchProcess(env.DB, siteId, workspaceId) });
    }
    if (!rawKey && method === 'GET') {
      return json({ modules: await listBusinessModules(env.DB, siteId) });
    }
    if (rawKey && method === 'POST') {
      if (!isBusinessModuleKey(rawKey)) return json({ error: 'business module not found' }, 404);
      const body = await readJson(request);
      return json({ module: await saveBusinessModule(env.DB, siteId, rawKey, String(body.markdown || ''), 'manual') });
    }
    return json({ error: 'method not supported' }, 405);
  }

  if (method === 'GET' && path === '/api/sites') {
    const sites = await listWorkspaceSites(env.DB, workspaceId);
    const counts = await countsForSites(env.DB, sites.map((s) => s.id));
    return json({ sites: sites.map((s) => publicSite(s, counts.get(s.id), cnameTargetOf(env))) });
  }

  if (method === 'POST' && path === '/api/sites') {
    const body = await readJson(request);
    let site: Site;
    try {
      site = siteFromBody(body, workspaceId);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : 'invalid site' }, 400);
    }
    const taken = await getSiteByRootDomain(env.DB, site.root_domain);
    if (taken) return json({ error: 'A project has already been created for this domain' }, 409);
    await insertSite(env.DB, site);
    return json({ site: publicSite(site, undefined, cnameTargetOf(env)) }, 201);
  }

  const siteMatch = path.match(/^\/api\/sites\/([^/]+)(?:\/(test|topics|jobs|seed-pack|run-next|check-host|translate-name))?$/);
  if (siteMatch) {
    const siteId = decodeURIComponent(siteMatch[1]);
    const action = siteMatch[2];
    const site = await ownedSite(siteId);
    if (!site) return json({ error: 'site not found' }, 404);

    if (method === 'GET' && !action) {
      const counts = await countsForSites(env.DB, [site.id]);
      return json({ site: publicSite(site, counts.get(site.id) ?? emptyCounts(), cnameTargetOf(env)) });
    }

    if (method === 'POST' && !action) {
      const body = await readJson(request);
      const publishedJobs = await listJobs(env.DB, siteId, 'published');
      const publishedLocales = publishedJobs.flatMap((job) => jobVersions(job).map((version) => version.locale));
      await updateSite(env.DB, siteId, sitePatch(site, body, publishedLocales), workspaceId);
      const updated = await ownedSite(siteId);
      const counts = await countsForSites(env.DB, [siteId]);
      return json({ site: publicSite(updated!, counts.get(siteId) ?? emptyCounts(), cnameTargetOf(env)) });
    }

    if (method === 'POST' && action === 'test') {
      if (!webhookExportEnabled(site)) {
        return json({ error: 'webhook export is not configured' }, 400);
      }
      return testIngest(request, site);
    }

    if (method === 'GET' && action === 'topics') {
      return json({ topics: await listTopics(env.DB, siteId) });
    }

    if (method === 'POST' && action === 'topics') {
      const body = await readJson(request);
      const topic = {
        id: newId(),
        site_id: siteId,
        topic_key: str(body.topic_key),
        title_hint: str(body.title_hint),
        category: str(body.category) || 'METHOD',
        primary_keyword: str(body.primary_keyword),
        status: 'queued' as const,
        created_at: isoNow(),
      };
      if (!topic.topic_key || !topic.title_hint || !topic.primary_keyword) {
        return json({ error: 'topic_key, title_hint, primary_keyword required' }, 400);
      }
      await insertTopic(env.DB, topic);
      return json({ topic }, 201);
    }

    if (method === 'GET' && action === 'jobs') {
      const status = url.searchParams.get('status') || undefined;
      const jobs = await listJobs(env.DB, siteId, status);
      const localizations = await listLocalizations(env.DB, siteId);
      return json({
        jobs: jobs.map((j) => ({
          ...publicJob(j, jobGenerationLocales(j, site)),
          ...(j.status === 'published' ? { localization: localizationView(j, site, localizations) } : {}),
        })),
      });
    }

    if (method === 'POST' && action === 'seed-pack') {
      let added = 0;
      for (const t of examplePack.topics) {
        try {
          await insertTopic(env.DB, {
            id: newId(),
            site_id: siteId,
            topic_key: t.topic_key,
            title_hint: t.title_hint,
            category: t.category,
            primary_keyword: t.primary_keyword,
            status: 'queued',
            created_at: isoNow(),
          });
          added += 1;
        } catch {
          // unique (site_id, topic_key) — skip existing
        }
      }
      return json({ added });
    }

    if (method === 'POST' && action === 'translate-name') {
      const body = await readJson(request);
      const locale = str(body.locale).trim();
      const sourceName = (str(body.name) || site.name).trim();
      if (!locale) return json({ error: 'locale is required' }, 400);
      if (!sourceName) return json({ error: 'name is required' }, 400);
      let profile;
      try { profile = resolveModelProfile(env); }
      catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 500); }
      let content = '';
      try {
        const result = await requestModelText(profile, {
          messages: [
            { role: 'system', content: 'You localize the public name of a website/blog project. Translate the given name into the requested language so it reads natural in that locale, while keeping brand names, proper nouns and wordmarks recognizable. Keep it short. Reply with the translated name only: no quotes or explanation.' },
            { role: 'user', content: `Target language (BCP-47): ${locale}\nName: ${sourceName}` },
          ],
          maxTokens: 1024, reasoningEffort: 'low', timeoutMs: 60_000,
        });
        content = result.content;
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'The model request failed' }, 502);
      }
      // Tolerate the model wrapping the name in quotes or a fenced block.
      const translated = content.trim().replace(/^```(?:text)?\s*/i, '').replace(/\s*```$/, '').replace(/^["'“”«]+|["'“”»]+$/g, '').trim().slice(0, 200);
      if (!translated) return json({ error: 'The model did not return a valid name' }, 502);
      return json({ locale, name: translated });
    }

    if (method === 'POST' && action === 'check-host') {
      const check = await checkHost(env, site);
      await updateSite(env.DB, siteId, {
        domain_status: check.status,
        domain_error: check.status === 'live' ? '' : [check.dns.message, check.live.message].filter(Boolean).join(' · '),
        domain_checked_at: isoNow(),
      }, workspaceId);
      const updated = await ownedSite(siteId);
      const counts = await countsForSites(env.DB, [siteId]);
      return json({
        site: publicSite(updated!, counts.get(siteId) ?? emptyCounts(), cnameTargetOf(env)),
        check,
      });
    }

    if (method === 'POST' && action === 'run-next') {
      return json({ error: 'The legacy single-article writing Workflow has been deactivated; please confirm a set of topics with the Topic Decision agent before starting content production.' }, 410);
    }
  }

  const jobImportMatch = path.match(/^\/api\/sites\/([^/]+)\/jobs\/import$/);
  if (jobImportMatch) {
    if (method !== 'POST') return json({ error: 'method not supported' }, 405);
    const siteId = decodeURIComponent(jobImportMatch[1]);
    const site = await ownedSite(siteId);
    if (!site) return json({ error: 'site not found' }, 404);
    let imported: ImportedArticle;
    try {
      imported = normalizeImportArticle(await readJson(request));
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : 'invalid article' }, 400);
    }
    const published = await listJobs(env.DB, siteId);
    const slugTaken = published.some((other) =>
      ownsArticleUrl(other, imported.locale, imported.slug),
    );
    if (slugTaken) {
      return json({ error: `another published ${imported.locale} article already uses this slug` }, 409);
    }
    const version: ArticleVersion = {
      ...articlePresentationPatch(imported as unknown as Record<string, unknown>),
      locale: imported.locale,
      slug: imported.slug,
      title: imported.title,
      excerpt: imported.excerpt,
      content: imported.content,
    };
    // Same as the publish workflow: make sure the site's public locale policy
    // covers the article locale so the live blog lists and links it correctly.
    // Validated before any write so a rejected locale cannot leave a half-imported article.
    const policy = persistableLocalePolicy(site, null, [imported.locale]);
    const job = emptyJob({
      id: newId(),
      site_id: siteId,
      status: 'published',
      visibility: 'visible',
      category: imported.category || null,
      published_at: isoNow(),
      ...versionsPatch([version]),
    });
    await insertJob(env.DB, job);
    await updateSite(env.DB, siteId, { locale_policy_json: serializeLocalePolicy(policy) }, workspaceId);
    return json({ job: publicJob(job, [imported.locale]) }, 201);
  }

  if (method === 'POST' && path === '/api/jobs') {
    return json({ error: 'The legacy single-article writing entry point has been deactivated; please confirm a set of topics with the Topic Decision agent before starting content production.' }, 410);
  }

  const jobLocalizationMatch = path.match(/^\/api\/jobs\/([^/]+)\/localizations\/([^/]+)$/);
  if (jobLocalizationMatch) {
    if (method !== 'DELETE') return json({ error: 'method not supported' }, 405);
    const job = await getJobForWorkspace(env.DB, workspaceId, decodeURIComponent(jobLocalizationMatch[1]));
    const jobSite = job ? await ownedSite(job.site_id) : null;
    if (!job || !jobSite) return json({ error: 'job not found' }, 404);
    if (job.status !== 'published') return json({ error: `job status is ${job.status}, not published` }, 409);
    const outcome = await removeLocalizedVersion(env.DB, job, jobSite, decodeURIComponent(jobLocalizationMatch[2]));
    if (outcome === 'source') return json({ error: 'The original language version cannot be taken down' }, 400);
    if (outcome === 'absent') return json({ error: 'The article does not have this language version' }, 404);
    const updated = await getJobForWorkspace(env.DB, workspaceId, job.id);
    return json({
      ok: true,
      job: updated ? { ...publicJob(updated, jobGenerationLocales(updated, jobSite)), localization: localizationView(updated, jobSite, await listLocalizations(env.DB, jobSite.id)) } : null,
    });
  }

  const jobMatch = path.match(/^\/api\/jobs\/([^/]+)(?:\/(approve|reject|visibility|localize))?$/);
  if (jobMatch) {
    const jobId = decodeURIComponent(jobMatch[1]);
    const action = jobMatch[2];
    const job = await getJobForWorkspace(env.DB, workspaceId, jobId);
    if (!job) return json({ error: 'job not found' }, 404);
    const jobSite = await ownedSite(job.site_id);
    if (!jobSite) return json({ error: 'job not found' }, 404);

    if (method === 'GET' && !action) {
      const artifact = job.production_group_id ? await env.DB.prepare(
        `select id, group_id, child_run_id, attempt, status, versions_json, qa_report_json,
                seo_contract_json, parent_review_json, supersedes_artifact_id, created_at
         from content_artifacts where job_id = ?
         order by case when id = ? then 0 else 1 end, attempt desc limit 1`,
      ).bind(job.id, job.current_artifact_id || '').first<Record<string, unknown>>() : null;
      const artifactVersions = artifact ? JSON.parse(String(artifact.versions_json || '[]')) as ArticleVersion[] : [];
      const publicValue = publicJob(job, jobGenerationLocales(job, jobSite));
      const qa = artifact
        ? JSON.parse(String(artifact.qa_report_json || '{}'))
        : job.qa_report ? JSON.parse(job.qa_report) : null;
      const groupDetail = job.production_group_id
        ? await contentProductionGroupPayload(env.DB, workspaceId, job.site_id, job.production_group_id)
        : null;
      const interactions = groupDetail
        ? (groupDetail.group.items as Array<Record<string, unknown>>).find((item) => item.job_id === job.id)?.interactions || []
        : [];
      return json({
        job: { ...publicValue, versions: jobDetailVersions(job, artifactVersions, jobGenerationLocales(job, jobSite)) },
        qa,
        artifact: artifact ? {
          ...artifact,
          seo_contract: await readRuntimeJson(env.DB, String(artifact.seo_contract_json || '{}')),
          parent_review: await readRuntimeJson(env.DB, String(artifact.parent_review_json || '{}')),
          seo_contract_json: undefined,
          parent_review_json: undefined,
          versions_json: undefined,
          qa_report_json: undefined,
        } : null,
        interactions,
        site: publicSite(jobSite, undefined, cnameTargetOf(env)),
      });
    }

    if (method === 'PATCH' && !action) {
      const body = await readJson(request);
      const locale = str(body.locale);
      const versions = jobVersions(job);
      if (!versions.some((v) => v.locale === locale)) {
        return json({ error: `job has no ${locale || '(empty)'} version to edit` }, 400);
      }
      const title = str(body.title);
      const slug = str(body.slug).trim().toLowerCase();
      const excerpt = str(body.excerpt);
      const content = str(body.content);
      if (!title || !slug || !content) return json({ error: 'title, slug and content are required' }, 400);
      if (!SLUG_RE.test(slug)) return json({ error: 'slug must be lowercase kebab-case' }, 400);
      const siblings = await listJobs(env.DB, job.site_id);
      const slugTaken = siblings.some(
        (other) => other.id !== job.id && ownsArticleUrl(other, locale, slug),
      );
      if (slugTaken) return json({ error: `another published ${locale} article already uses this slug` }, 409);
      let presentation;
      try {
        presentation = articlePresentationPatch(body);
        const issues = markdownSubsetIssues(locale, content);
        if (issues.length) return json({ error: issues.map((issue) => issue.message).join('; ') }, 400);
      } catch (error) { return json({ error: error instanceof Error ? error.message : 'Invalid metadata' }, 400); }
      const nextVersions = upsertVersion(job, { ...versions.find((v) => v.locale === locale)!, ...presentation, locale, title, slug, excerpt, content });
      const category = body.category !== undefined ? str(body.category) : undefined;
      await updateJob(
        env.DB,
        jobId,
        { ...versionsPatch(nextVersions), content_updated_at: isoNow(), ...(category !== undefined ? { category } : {}) },
        workspaceId,
      );
      const updated = await getJobForWorkspace(env.DB, workspaceId, jobId);
      return json({ ok: true, job: updated ? publicJob(updated, jobGenerationLocales(updated, jobSite)) : null });
    }

    if (method === 'POST' && action === 'visibility') {
      if (job.status !== 'published') {
        return json({ error: `job status is ${job.status}, not published` }, 409);
      }
      const body = await readJson(request);
      const rawVisibility = str(body.visibility);
      if (rawVisibility !== 'visible' && rawVisibility !== 'hidden') {
        return json({ error: 'visibility must be "visible" or "hidden"' }, 400);
      }
      await updateJob(env.DB, jobId, { visibility: rawVisibility as JobVisibility }, workspaceId);
      const updated = await getJobForWorkspace(env.DB, workspaceId, jobId);
      return json({ ok: true, job: updated ? publicJob(updated, jobGenerationLocales(updated, jobSite)) : null });
    }

    if (method === 'POST' && action === 'localize') {
      if (job.status !== 'published') return json({ error: `job status is ${job.status}, not published` }, 409);
      if (!sourceVersionOf(job, jobSite)) return json({ error: 'The article has no available original version' }, 409);
      const missing = missingLocales(job, jobSite);
      if (!missing.length) return json({ error: 'All languages enabled on the site already have versions; nothing to fill in' }, 409);
      try { resolveModelProfile(env, 'article_production'); }
      catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 500); }
      for (const locale of missing) {
        const localizationId = await claimLocalization(env.DB, { id: newId(), site_id: jobSite.id, job_id: job.id, locale });
        if (!localizationId) continue;
        try {
          const instance = await env.LOCALIZE_WORKFLOW.create({ params: { localizationId, jobId: job.id, locale } });
          await env.DB.prepare('update article_localizations set workflow_id = ? where id = ?').bind(instance.id, localizationId).run();
        } catch (error) {
          await setLocalizationStatus(env.DB, localizationId, 'failed', error instanceof Error ? error.message : String(error));
        }
      }
      return json({
        ok: true,
        job: { ...publicJob(job, jobGenerationLocales(job, jobSite)), localization: localizationView(job, jobSite, await listLocalizations(env.DB, jobSite.id)) },
      });
    }

    if (method === 'POST' && action === 'approve') {
      if (job.status !== 'awaiting_review') {
        return json({ error: `job status is ${job.status}, not awaiting_review` }, 409);
      }
      const site = jobSite;
      const locales = jobGenerationLocales(job, site);
      const report = await publicationQa(env.DB, site as unknown as Record<string, unknown>, job, publicJob(job, locales).versions, locales);
      if (!report.ok) {
        // The article stays in review: the reviewer sees why and can request a revision.
        await updateJob(env.DB, jobId, { qa_report: JSON.stringify(report) }, workspaceId);
        return json({ error: `Pre-publish check failed: ${report.issues.map((issue) => issue.message).join('; ')}`, qa: report }, 400);
      }
      await startPublish(env, jobId);
      if (job.production_group_id && job.current_artifact_id) {
        await recordContentReviewInteraction(env.DB, {
          idempotencyKey: `human-approved:${job.current_artifact_id}`,
          groupId: job.production_group_id,
          jobId: job.id,
          artifactId: job.current_artifact_id,
          parentRunId: '',
          childRunId: job.child_run_id,
          kind: 'human_approved',
          actorType: 'user',
          actorId: principal?.user.id || '',
          summary: 'Manual review approved; the article has entered the publishing process.',
        });
      }
      const published = await getJobForWorkspace(env.DB, workspaceId, jobId);
      return json({ ok: true, job: published ? publicJob(published, locales) : null });
    }

    if (method === 'POST' && action === 'reject') {
      if (job.status !== 'awaiting_review') {
        return json({ error: `job status is ${job.status}, not awaiting_review` }, 409);
      }
      const body = await readJson(request);
      const note = str(body.review_note);
      if (!note) return json({ error: 'review_note is required' }, 400);
      if (!job.production_group_id || !job.current_artifact_id) return json({ error: 'job is not managed by content production' }, 409);
      const at = isoNow();
      const results = await env.DB.batch([
        env.DB.prepare(
          `update content_production_groups set status = 'needs_attention', ready_items = max(0, ready_items - 1),
             error = 'Human reviewer requested an article revision', updated_at = ?
           where id = ? and exists (select 1 from jobs where id = ? and status = 'awaiting_review')`,
        ).bind(at, job.production_group_id, job.id),
        env.DB.prepare(
          `update content_artifacts set status = 'rejected', updated_at = ?
           where id = ? and job_id = ?
             and exists (select 1 from jobs where id = ? and status = 'awaiting_review')`,
        ).bind(at, job.current_artifact_id, job.id, job.id),
        env.DB.prepare(
          `update jobs set status = 'drafting', review_note = ?, error = '', updated_at = ?
           where id = ? and status = 'awaiting_review'`,
        ).bind(note, at, job.id),
      ]);
      if (!results[2]?.meta.changes) return json({ error: 'The article status has changed; please refresh and try again' }, 409);
      await recordContentReviewInteraction(env.DB, {
        idempotencyKey: `human-revision:${job.current_artifact_id}:${at}`,
        groupId: job.production_group_id,
        jobId: job.id,
        artifactId: job.current_artifact_id,
        parentRunId: '',
        childRunId: job.child_run_id,
        kind: 'human_revision_requested',
        actorType: 'user',
        actorId: principal?.user.id || '',
        summary: `Manual review returned for revision: ${note}`,
        payload: { required_changes: [note] },
        at,
      });
      const run = await continueContentRevision(env, {
        workspaceId, siteId: job.site_id, groupId: job.production_group_id,
        decisionGroupId: job.decision_group_id, jobId: job.id,
      });
      return json({ ok: true, parent_run_id: run.id, job: await getJobForWorkspace(env.DB, workspaceId, jobId) });
    }
  }

  const developmentResponse = await handleDevelopmentRequest(request, env, workspaceId);
  if (developmentResponse) return developmentResponse;

  if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return json({ error: 'not found' }, 404);
}

async function testIngest(request: Request, site: Site): Promise<Response> {
  const origin = new URL(request.url).origin;
  const target = resolveIngestUrl(site.ingest_url, origin);
  const dummy = emptyJob({
    id: 'test',
    site_id: site.id,
    translation_group: 'connectivity-test',
    category: 'METHOD',
    translate_locales_json: '[]',
  });
  dummy.versions_json = JSON.stringify(
    jobGenerationLocales(dummy, site).map((locale, i) => ({
      locale,
      slug: i === 0 ? 'connectivity-test' : `connectivity-test-${locale.toLowerCase()}`,
      title: 'Connectivity test',
      excerpt: 'Dry run',
      content: `Dry run. Practice [write from memory](${site.hub_path}).`,
    })),
  );
  const posts = buildWebhookPosts(site, dummy, { dryRun: true });
  const replies: Array<{ status: number; body: string }> = [];
  try {
    for (const payload of posts) {
      const res = await fetch(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [site.secret_header || 'x-ingest-secret']: site.ingest_secret,
        },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      replies.push({ status: res.status, body: text.slice(0, 2000) });
      if (!res.ok) {
        return json({ ok: false, status: res.status, url: target, body: text.slice(0, 2000), posts: posts.length });
      }
    }
    return json({ ok: true, status: replies[0]?.status ?? 200, url: target, body: replies[0]?.body, posts: posts.length });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err), url: target }, 502);
  }
}

function resolveIngestUrl(ingestUrl: string, origin: string): string {
  if (ingestUrl.startsWith('http://') || ingestUrl.startsWith('https://')) return ingestUrl;
  if (ingestUrl.startsWith('/')) return `${origin}${ingestUrl}`;
  throw new Error('ingest_url must be absolute or start with /');
}

function siteFromBody(body: Record<string, unknown>, workspaceId = PRIMARY_WORKSPACE_ID): Site {
  const root_domain = registrableDomain(str(body.root_domain) || str(body.domain));
  if (!root_domain) throw new Error('Please enter a valid domain, e.g. asd.com');
  const name = str(body.name) || root_domain;
  const domain = parseHostname(str(body.blog_domain)) || defaultBlogHost(root_domain);
  const fields = asWebhookFields(body.webhook_fields);
  const source_locale = str(body.source_locale) || 'en';
  const extra = uniqueLocales(asStringArray(body.translate_locales), source_locale);
  const draft: Site = {
    id: newId(),
    workspace_id: workspaceId,
    name,
    domain,
    root_domain,
    ingest_url: str(body.ingest_url),
    ingest_secret: str(body.ingest_secret),
    secret_header: str(body.secret_header) || 'x-ingest-secret',
    locales_json: JSON.stringify([source_locale]),
    translate_locales_json: JSON.stringify(extra),
    webhook_fields_json: JSON.stringify(fields),
    webhook_mode: 'group',
    hub_path: str(body.hub_path),
    product_origin: normalizeProductOrigin(str(body.product_origin)) || `https://${root_domain}`,
    locale_policy_json: '',
    source_locale,
    hub_urls_json: asHubUrlsJson(body.hub_urls),
    seo_identity_json: asSeoIdentityJson(body.seo_identity),
    name_by_locale_json: '{}',
    blog_layout: normalizeBlogLayout(body.blog_layout),
    publication_language_mode: 'all_enabled',
    model: 'runtime-configured',
    min_words: Number(body.min_words) || 400,
    created_at: isoNow(),
    domain_status: 'unverified',
    domain_error: '',
    domain_checked_at: '',
    ...EMPTY_SITE_GSC,
    ...EMPTY_SITE_RESEARCH,
  };
  return persistSitePolicy(draft, body);
}

function sitePatch(site: Site, body: Record<string, unknown>, requiredLocales: string[] = []) {
  const fields = body.webhook_fields != null ? asWebhookFields(body.webhook_fields) : null;
  const source_locale = str(body.source_locale) || sourceLocaleOf(site);
  const extra =
    body.translate_locales != null
      ? uniqueLocales(asStringArray(body.translate_locales), source_locale)
      : uniqueLocales(parseStringList(site.translate_locales_json), source_locale);
  const root_domain =
    body.root_domain != null ? registrableDomain(str(body.root_domain)) || site.root_domain : site.root_domain;
  const next: Site = {
    ...site,
    name: str(body.name) || site.name,
    domain: body.domain != null ? parseHostname(str(body.domain)) || site.domain : site.domain,
    root_domain,
    ingest_url: body.ingest_url != null ? str(body.ingest_url) : site.ingest_url,
    ingest_secret: body.ingest_secret != null && str(body.ingest_secret) ? str(body.ingest_secret) : site.ingest_secret,
    secret_header: str(body.secret_header) || site.secret_header,
    locales_json: JSON.stringify([source_locale]),
    translate_locales_json: JSON.stringify(extra),
    webhook_fields_json: fields ? JSON.stringify(fields) : site.webhook_fields_json,
    webhook_mode: site.webhook_mode,
    hub_path: body.hub_path != null ? str(body.hub_path) : site.hub_path,
    product_origin: body.product_origin != null ? normalizeProductOrigin(str(body.product_origin)) : site.product_origin,
    locale_policy_json: site.locale_policy_json,
    source_locale,
    hub_urls_json: asHubUrlsJson(body.hub_urls, site.hub_urls_json),
    seo_identity_json: asSeoIdentityJson(body.seo_identity, site.seo_identity_json),
    name_by_locale_json:
      body.name_by_locale != null
        ? mergeNameByLocalePatch(site.name_by_locale_json, asSiteNamePatch(body.name_by_locale))
        : site.name_by_locale_json,
    blog_layout: normalizeBlogLayout(body.blog_layout != null ? body.blog_layout : site.blog_layout),
    publication_language_mode: publicationLanguageMode(body.publication_language_mode, site.publication_language_mode),
    model: site.model,
    min_words: body.min_words != null ? Number(body.min_words) : site.min_words,
  };
  return persistSitePolicy(next, body, requiredLocales);
}

function uniqueLocales(items: string[], source: string): string[] {
  return [...new Set(items.map((x) => x.trim()).filter((x) => x && x !== source))];
}

function publicationLanguageMode(value: unknown, fallback: Site['publication_language_mode']): NonNullable<Site['publication_language_mode']> {
  if (value == null) return fallback || 'all_enabled';
  if (value === 'all_enabled' || value === 'source_only') return value;
  throw new Error('publication_language_mode must be all_enabled or source_only');
}

function persistSitePolicy(site: Site, body: Record<string, unknown>, requiredLocales: string[] = []): Site {
  return {
    ...site,
    locale_policy_json: serializeLocalePolicy(
      persistableLocalePolicy(site, explicitPolicyFromBody(body), requiredLocales),
    ),
  };
}

function explicitPolicyFromBody(body: Record<string, unknown>): LocalePolicy | undefined {
  if (body.locale_policy == null) return undefined;
  const raw = typeof body.locale_policy === 'string' ? body.locale_policy : JSON.stringify(body.locale_policy);
  if (!raw.trim()) return undefined;
  const parsed = parseLocalePolicy(raw);
  if (!parsed) throw new LocalePolicyError([{ code: 'locale_policy', message: 'invalid locale_policy' }]);
  return parsed;
}

function asHubUrlsJson(value: unknown, fallback = '{}'): string {
  if (value == null) return fallback;
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return JSON.stringify(parseHubUrls(raw));
}

function asSeoIdentityJson(value: unknown, fallback = '{}'): string {
  if (value == null) return fallback;
  return mergeSeoIdentity(value, fallback);
}

function asSiteNamePatch(value: unknown): Record<string, string | { deleted: boolean }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string | { deleted: boolean }> = {};
  for (const [code, entry] of Object.entries(value as Record<string, unknown>)) {
    const locale = code.trim();
    if (!locale) continue;
    if (typeof entry === 'string') {
      out[locale] = entry.slice(0, 200);
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      out[locale] = { deleted: Boolean((entry as { deleted?: unknown }).deleted) };
    }
  }
  return out;
}

function parseStringList(raw: string | null | undefined): string[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map((s) => String(s).trim()).filter(Boolean);
  }
  return [];
}

function asWebhookFields(value: unknown): WebhookField[] {
  if (!Array.isArray(value)) return [];
  const out: WebhookField[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const key = str(rec.key);
    const from = str(rec.from);
    if (!key || !from) continue;
    const field: WebhookField = { key, from };
    if (typeof rec.value === 'string') field.value = rec.value;
    out.push(field);
  }
  return out;
}

async function pokeAfterWrite(env: Env, path: string): Promise<void> {
  const site = path.match(/^\/api\/sites\/([^/]+)\//)?.[1];
  if (site) return pokeSite(env, decodeURIComponent(site));
  const job = path.match(/^\/api\/jobs\/([^/]+)/)?.[1];
  if (!job) return;
  const row = await env.DB.prepare('select site_id from jobs where id=?').bind(decodeURIComponent(job)).first<{ site_id: string }>();
  if (row) await pokeSite(env, row.site_id);
}


async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function isConsoleHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.workers.dev');
}

// ─── GSC data sync ────────────────────────────────────────────────────────────

async function syncGscDataForSite(env: Env, site: Site): Promise<{ synced: number }> {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const cipherKey = env.GSC_TOKEN_CIPHER_KEY;
  if (!clientId || !clientSecret || !cipherKey) throw new Error('GSC secrets not configured');
  if (!site.gsc_refresh_token_cipher) throw new Error('No refresh token');

  const propertyUrl = site.gsc_property_url_prefix || (site.domain ? `https://${site.domain}/` : '');
  if (!propertyUrl) throw new Error('No property URL');

  const accessToken = await getAccessToken({
    gscRefreshTokenCipher: site.gsc_refresh_token_cipher,
    clientId, clientSecret, cipherKey,
  });

  // Sync last 28 days (GSC data has ~3 day delay)
  const end = new Date();
  end.setDate(end.getDate() - 3);
  const start = new Date(end);
  start.setDate(start.getDate() - 27);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  const now = isoNow();

  const [byQuery, byPage, byDate] = await Promise.all([
    gscSearchAnalyticsAll({ siteUrl: propertyUrl, accessToken, startDate, endDate, dimensions: ['query'] }),
    gscSearchAnalyticsAll({ siteUrl: propertyUrl, accessToken, startDate, endDate, dimensions: ['page'] }),
    gscSearchAnalytics({ siteUrl: propertyUrl, accessToken, startDate, endDate, dimensions: ['date'], rowLimit: 90 }),
  ]);

  // Each row is an aggregate for this 28-day window, identified by its end date.
  const analyticsRows: GscAnalyticsRow[] = [];
  for (const r of byQuery.rows) {
    analyticsRows.push({
      id: `${site.id}:query:${startDate}:${endDate}:${r.keys[0]}`,
      site_id: site.id, date: endDate, dimension: 'query', key: r.keys[0],
      clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position,
      fetched_at: now,
    });
  }
  for (const r of byPage.rows) {
    analyticsRows.push({
      id: `${site.id}:page:${startDate}:${endDate}:${r.keys[0]}`,
      site_id: site.id, date: endDate, dimension: 'page', key: r.keys[0],
      clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position,
      fetched_at: now,
    });
  }

  const dailyRows: GscDailyRow[] = byDate.rows.map((r) => ({
    id: `${site.id}:${r.keys[0]}`,
    site_id: site.id, date: r.keys[0],
    clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position,
    fetched_at: now,
  }));

  await upsertGscAnalytics(env.DB, analyticsRows);
  await upsertGscDaily(env.DB, dailyRows);

  return { synced: analyticsRows.length + dailyRows.length };
}
