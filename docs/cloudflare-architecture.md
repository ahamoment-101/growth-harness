# Cloudflare deployment architecture

GrowthHarness is a Cloudflare application. Account identity, resource IDs, domains and credentials belong to the installation; the public repository supplies the application and binding contract. It does not currently provide a Node/PostgreSQL deployment adapter.

## Components

```text
Browser console ── HTTPS / WebSocket ── Worker
                                         ├── Static assets and authenticated API
                                         ├── Server-rendered public blog
                                         ├── D1: business state, tasks, versions and receipts
                                         ├── R2: persisted large artifacts and source material
                                         ├── Durable Objects: live read models and runtime services
                                         └── Workflows: durable Agent and publication execution
                                                  │
                                                  ├── Configured model connection
                                                  └── Optional research / export services
```

The React/Vite console lives in `src/`; `worker/index.ts` serves API routes and public content. `worker/db.ts`, domain services and ordered `migrations/` own persistence. The concrete binding names and exported classes are declared in `wrangler.jsonc`; keep them when renaming the installation's resources.

## Identity and execution

Each installation has one owner workspace. Password authentication is the default and Google login is optional. Public article routes remain readable independently of console sessions. Authenticated operations retain workspace/site authorization and same-origin mutation checks.

The continuous Agent Runtime owns a persistent Task/Run and independently fenced Executions. Durable Workflows advance the same Run, and scheduled recovery resumes persisted work. Business waiting, infrastructure recovery, cancellation and completion are distinct states. See [the Runtime contract](continuous-agent-runtime.md).

See [read models and caching](real-time-updates-and-cache-architecture.md) for live views, missed notifications and cache invalidation.

D1 is the authoritative business store. Read models and caches must not replace authorization, version observations or durable operation receipts. Large data can be persisted in R2 while retaining stable references and explicit read boundaries. Database migrations and Worker deployments are separate operations and require a controlled upgrade sequence.

## Models and optional services

Model registry connections select OpenRouter or compatible OpenAI/Anthropic protocols. Keys are server-side Secrets; neither a model connection nor a Cloudflare deployment requires a maintainer-owned gateway. See [model configuration](model-channel.md).

Firecrawl currently supplies web search, scraping and hosted deep research. DataForSEO supplies supported keyword and search-result data. These are optional configured vendor integrations, not an interchangeable research-provider framework. GSC OAuth and IndexNow are optional publication/search integrations. External service credentials, quotas and account permissions belong to the deployer.

Publishing first exposes the approved hosted article. A per-site Webhook is optional export; no specific customer site or CMS is required. See [the export contract](ingest-contract.md).

## Deployment boundaries

Use your own Worker, D1 database, R2 bucket, account and DNS settings. Set `CLOUDFLARE_WORKER_NAME` to the deployed Worker name for route diagnostics. Remote administrative API access is needed only for the optional diagnostics that use it; it is distinct from Wrangler's deployment login.

The local environment uses ignored `.dev.vars`; deployed secrets use Cloudflare Secrets. Confirm account and target before resource creation, migrations or deployment. Do not publish local backups, raw model conversations, production resource maps or customer documents.

Follow [self-hosting](self-hosting.md) and validate the actual services, billing and platform limits of your account. No fixed tenant scale, free-tier suitability or search outcome follows from this architecture diagram.
