# Hosted deep research

`deep_research` calls use Firecrawl `POST /v2/agent`; there is no self-hosted research Agent loop or fallback to one. Strategy research still runs through Pi and decides the question, evidence sufficiency, follow-up, partial delivery and waiting.

## Execution and ownership

The strategy tool accepts `research_question`, `decision_use`, `scope`, `deliverable` and minimal non-secret `context`; the strategy locale is injected. Firecrawl owns web exploration and synthesis. The domain provider adapter translates the authoritative Zod output schema to the supported provider dialect; it does not weaken result validation. Briefs exceeding the provider's 10,000-character prompt capacity fail explicitly; the model-facing tool reserves room for instructions by limiting the serialized brief to 9,000 characters.

The historical `deep_research` task identity remains registered solely as a durable hosted-job executor: its tool registry is empty and it never calls our model gateway. Existing task/Run lineage, fencing, child completion and cancellation are reused. Former prompts, notebook mutation tools, the deep-research Pi loop and their obsolete verification harnesses have been removed. Historical notebook/result reading remains supported; old execution definitions cannot resume under the new contract.

## Durable provider protocol

Migration `0048_firecrawl_research_jobs.sql` adds the job receipt and credit reservations. Submission is claimed durably before POST. A saved job ID is queried on recovery; it is not submitted again. A request with an ambiguous creation outcome stays `unknown` and retains its reservation for manual reconciliation. An explicit HTTP request rejection is recorded as failed. Starting another research task is an Agent decision, not an automatic retry of an unknown charge.

Workflow polls every 30 seconds. Each network attempt is counted against the existing root external-request allowance; this accounting is separate from provider credits. Poll failures pause with the same saved job, and recovery continues retrieval. Raw results are saved in D1 immediately, including failed or structurally invalid output, because provider API results expire. A provider `completed` status alone is not a successful research contract: malformed data pauses for inspection, and valid no-findings/partial/needs-input outcomes remain explicit. Valid partial data from a failed provider run is retained.

Provider receipts advance monotonically so a late polling response cannot overwrite a terminal result. Domain finalization checks task ownership and root cancellation. Cancellation calls the module's registered cleanup hook; it requests provider cancellation and the minute scheduler reconciles pending cancellations and final credit usage. Provider cancellation acknowledgement is not a claim that an in-flight action or billing has stopped. A submission interrupted before its job ID was saved may need manual provider reconciliation; it is never silently resubmitted.

## Budgets

Defaults: `FIRECRAWL_RESEARCH_MODEL=spark-2`, `FIRECRAWL_RESEARCH_MAX_CREDITS=100` per job, `FIRECRAWL_RESEARCH_ROOT_CREDITS=300` cumulatively per root. Concurrent reservations are admitted atomically in D1. Completed jobs settle to reported credits; missing usage and unknown outcomes retain the full reservation. Changing the model prompt cannot increase these limits. These deterministic rules prevent overspending and duplicate external effects, not prescribe research quality or number of sources.

## Evidence

Provider results contain report, summary, outcome, findings, citations, unknowns and reason. The adapter assigns task-scoped stable IDs and labels citations `provider_excerpt`. Those excerpts are never inserted as independently captured webpage snapshots. `read_evidence` can read both hosted reports and old captured sources, preserving source locale and tenant scope. The parent judges whether a citation supports a claim and whether further research is needed; URLs and quotations do not automatically prove truth or market demand.

## Verification and delivery

Unit/integration tests cover submission and poll failures, replay, cancellation, credit admission, raw/partial preservation, old notebook reads, strategy-tool delegation and provider-excerpt reads. Run `npm test` and `npm run build`. For an explicitly authorized billable check, `FIRECRAWL_RESEARCH_LIVE=1 npx vitest run worker/agent-runtime/firecrawl-research.test.ts -t 'actual provider adapter'` uses `.dev.vars` without logging the key and an isolated in-memory database; its report is `/tmp/firecrawl-integrated-verification.json`.

Apply the migration before using the new executor. Local migration is independent of production. Production deployment and remote migration require their normal explicit release scope and account verification. No existing site business data is rewritten by this integration.

## Autonomous commissioning

The strategy Agent authors topics and briefs from its goal, business materials and prior evidence. It passes relevant facts, audience, decision use and uncertainty explicitly: Firecrawl does not inherit the parent conversation. Missing seed lists, incomplete modules, domain verification or GSC connection do not by themselves require user intervention. Historical waiting decisions must be reassessed. Only an unresolved decision-critical private fact or an unidentifiable business can justify targeted user input after inspecting available materials. These are domain prompt/tool responsibilities; Runtime does not force a research call or invent a business. Existing cancellation, budgets and legitimate terminal outcomes remain unchanged.
