# Continuous Agent Runtime: T1 / R1 Single-Loop Contract

This is the continuous Runtime target contract. It does not certify that a particular release, account or deployment has completed acceptance. See [verification methods and limits](verification.md).

The [design principles](design-principles.md) explain decision ownership. The pipeline, parameter ownership and implementation map are consolidated here; historical acceptance does not certify the current contract.

This document is the current Runtime target contract, aligned with the root directory [AGENTS.md](../AGENTS.md). Legacy designs and acceptance records cannot supersede this document, nor can historical test passes be used to claim this contract has been realized. For business missions, still refer to [Content workflow](content-workflow.md); for the Firecrawl service contract, see [deep-research.md](deep-research.md).

## 1. Product Positioning and Identity

Design and fixes follow the [Decision Ownership Principle](../AGENTS.md#decision-ownership-principle): Runtime guarantees that Agents reliably observe, judge, and act; business strategy is decided by the Agent. Newly added deterministic constraints must state the objective invariants, evidence, and responsibility layers they protect. Error feedback, tool contracts, and recovery routing are likewise bound by this boundary and cannot indirectly seize business decisions by "feeding hardcoded rejections back into the loop." Case studies and acceptance records serve to prove implementation and do not constitute grounds for new business constraints.

The system is a business-autonomous Agent running unattended in the cloud 24/7. Internally, it relies on continuous dialogue to make decisions; the product provides no chat or mid-run interruption entries during execution.

- Task (T1): The goal, scope, and deliverable attribution of a unit of business work.
- Run (R1): The continuously existing Agent session and sole decision loop for T1. Stage continuations, resumption after waiting, tool error correction, and execution host recoveries never create R2.
- Workflow: Cloudflare's durable execution host, which can be suspended, terminated, or replaced. The execution batch, lease, or generation of the compute host is internal recovery information, not a new business Run, and does not change session identity.

A single task establishes only one T1 / R1 pair. Whether initial IDs are identical is a storage detail, not the definition of object relationships. No mechanisms are designed to detect new goals, fork sessions, or automatically split tasks.

Submitting milestone deliverables does not require closing the session; waiting for processing or subsequent revisions still continues the original T1 / R1. The loop exits upon explicit finish, cancellation, or audit tool selection of finish. Waiting and termination must be distinguished; no additional user input is accepted during execution. Existing cancellation and business publish approvals are retained, but no new manual authorization checkpoints may be added for round extensions, quota increases, or execution resumptions.

## 2. Initialize Once, Followed by Only One Loop

### Execution Authority Boundaries for Parent-Child Tasks

A parent Agent treats child tasks as persistent semantic tools; child tasks independently hold Task / Run / Execution and context. Reading tasks, validating one's own execution authority, and authorizing direct child task lifecycles are distinct responsibilities. Parent credentials authorize creation, dispatch, and resumption of child tasks and cannot be used to impersonate a child executor. Lifecycle writes retain a transactional barrier for parent execution authority while checking direct lineage and tenant/site; dispatches carry the child's independently saved execution identity, verified by the child upon startup. Unbinding the database or reading the latest generation to authorize on behalf of a stale executor is prohibited.

Child task identifiers bind to saved operations; replays use the same task and dispatch records. Dispatch receipts are separated from final deliverables; parent task waiting does not block children; ancestor closure or cancellation blocks descendant business mutations. Real startup services and parent environments with execution credentials must be verified in combination, without substituting tests using mocked startup services. See the [Runtime implementation map](#7-current-code-map) for the owning modules.

After startup entry finishes authorization, scope, and idempotency checks, it establishes T1 / R1, initializing identity, mission, tool definitions, initial task message, and business material snapshot. Strategy research loads six business documents along with required existing strategies and evidence; initial materials have sources and versions, with missing facts explicitly tagged. Other Agents select materials via their own definitions.

Initialization results are persisted first. Resumption only loads the original state, without re-inserting the initial message, regenerating history, or appending the entire set of identity materials again.

```text
Startup and one-time initialization
        ↓
R1 sole loop
  Receive and persist new input / original tool results / fixable errors
        ↓
  Check execution authority, cancellation, and pending operations; run error policy check
        ↓
  Execute current-round business context stages per definition, appending necessary state mutations
        ↓
  Check stage rounds: append an audit directive upon reaching 30 rounds
        ↓
  Check full model request capacity, compressing and saving context version if necessary
        ↓
  Invoke model once, persisting response and tool call identity
        ↓
  Validate and execute selected actions, persisting results
        ├─ Tool results / fixable failures → Next round
        ├─ Audit continue → Unlock 30 rounds → Next round
        ├─ Explicit wait → Durable wait → Resume this loop after condition is met
        └─ Explicit finish / cancel → Save results and exit
```

Any actual model decision passes through the exact same pipeline, including audits and error fixes. Running an outer pipeline first and then letting the SDK loop on its own inside while bypassing checks is not permitted. Pi can host the loop, provided that all model requests, response submissions, tool executions, and resumptions can hook into and await Runtime persistence controls; dual loops must not be kept just to preserve SDK forms.

Business domains register optional preparation steps, context providers, and tools via definitions. Steps receive an inspection opportunity every round and can pass through directly when there are no changes. Permissions, cancellation, persistence, operation idempotency, capacity, and execution authority cannot be skipped by business logic. Shared Runtime does not orchestrate research order by Agent name.

## 3. Session, Capacity, and Cache

A session is a continuously appended native message sequence: initial task, model responses, tool calls and results, audit directives, and human processing results received under permitted states. Normal rounds do not rewrite an alternative history from scattered business rows.

Initializing identity and tools once does not mean subsequent model requests can omit them. Sending requests still requires carrying the context mandated by the provider protocol; serializing the original session and rewriting the session are two different things. Stabilize identity, tool ordering, baseline materials, and history prefix as much as possible, appending business updates at the end. Cache hits or misses cannot be inferred solely from identical Run IDs or rebuilt SDK objects; proof must rely on actual serialized requests, provider capabilities, and cache usage, and hits cannot be promised beyond cache validity windows.

Check capacity before each model request, including identity, tool schemas, business materials, history, audit directives, and output reservations. An empty dialogue history in the first round does not mean request capacity is zero. Context token capacity, byte limits, and cumulative costs are different metrics; do not conflate them and claim exact token inspection.

Compression only alters the current model reading view; the raw session is fully retained per authorized scope. Save the compression coverage scope, summary, source pointers, and subsequent tail messages, with recovery reusing the same compressed version. Retain goals, user constraints, key decisions, failures and causes, evidence, artifact references, and unresolved issues; maintain association between tool calls and results. Operation identity, execution success status, and business artifacts are governed by independent persistent records and must not rely on summary inferences.

Compression is an explicit context version change that may alter the cache prefix; append continuously after compression without regenerating summaries every round. Merely dropping old messages and providing a query endpoint does not equate to fulfilling this compression contract. Persistence contains no credentials or private chains of thought, and does not require providers to supply inaccessible internal reasoning.

## 4. Autonomous Audit Every 30 Rounds

A round refers to one model decision; multiple tool calls within a single response do not count as multiple rounds. Physical request retries, tool retries, audit invocations, and cumulative model calls are accounted for independently; recovery must not double-count submitted rounds.

After completing 30 normal decision rounds, the next decision enters audit mode within the same R1, appending an audit directive. Audits have dedicated call reservations and are not blocked by normal round limits. Audit directives require evaluating whether continuing is meaningful based on actual outcomes, errors, repeated attempts, resource consumption, and remaining work, without substituting fixed success rates, keywords, or stall counts for model judgment.

The built-in tool is recommended to be named `resolve_execution_audit` (submit execution audit decision), with only two actions:

| Action | Provided by Agent | Runtime Effect |
| --- | --- | --- |
| continue | Actual progress, remaining work, next-stage goals and approach | Atomically persists audit results, automatically unlocks the next 30 rounds, and continues the original T1 / R1 |
| finish | Reason for termination, completion status, deliverable references, limitations, and unresolved issues | Persists task termination results, exits the loop, and returns information to the business system |

Tool definitions are registered stably starting at initialization, and execution permissions are granted only during the audit phase; append usage instructions when the time comes to avoid reordering tool lists ad hoc. This is a semantic execution audit decision, not a reset_budget that allows the model to modify the ledger arbitrarily.

continue requires no confirmation, sets no upper bound on cumulative stage iterations, and introduces no default mechanism for awaiting manual authorization once cumulative model allowances are exhausted. Cumulative rounds, model requests, costs, and external calls continue to be accounted for and are not reset due to renewals. Objective provider balance, rate, and platform capacity limits must still be handled, recovered from via explicit system error policies, waited out, or returned as termination reasons; they cannot be disguised as manual allowance expansion flows.

Audit decisions are bound to checkpoints and operation identities; replaying the same continue does not add quota repeatedly. Tool argument errors are fed back to the same Agent for remediation; the audit invocation itself also undergoes capacity, persistence, and error handling, and must not introduce another closing loop that bypasses the pipeline.

finish does not automatically mean business success. Information such as completed, partially completed, unable to continue, etc., must be expressible; whether a strategy has been successfully submitted is still proven by domain submission tools and formal deliverables. Domain waiting states remain expressible; waiting must not be disguised as completion just because a tool has only two actions.

## 5. Tool Error and System Error Policy Table

Both tool successes and remediable failures enter the next round with associated outcomes. Feedback includes category, field path, invalid references, already successful portions, known side effects, and available recovery information. Argument errors are left to the Agent to determine how to modify; the Runtime must not guess business parameters.

The Runtime pipeline reserves a registrable structured error policy table, which may initially be empty. Matches are made using stable error codes, categories, execution phases, and effect statuses; branches are not piled up based on model text keywords or Agent names.

An empty table indicates that no extra handling is performed for specific errors and that execution proceeds according to the default error feedback flow; it does not mean that permissions, cancellations, protocols, and unknown side effect protections are lifted. When a valid model request cannot be formed, the model must not be forcibly called.

Future policies may handle provider protocol failures, temporary unavailability, missing business dependency configurations, etc. Business tools report specific missing configurations, and the Runtime executes registered wait, reconcile, recover, or terminate actions; the table does not judge research depth or content quality. Do not turn all unexpected model decisions into system error policies.

A request timeout does not mean "definitely not executed." When external outcomes are unknown, reconcile first; one must not hand the error back to the Agent and then permit irreversible operations to be repeated. The model feedback loop resolves remediable judgments, while persistence and reconciliation resolve process and execution outcome issues; the two cannot substitute for each other.

Provider request failure and execution-host failure are distinct. Recovery policy classifies the typed cause, persists successful effects and resumes the original Task/Run. Missing model configuration is a configuration pause; transient availability and host replacement follow registered recovery paths. Recovery must address the failed condition or wait for its dependency, not blindly repeat an unchanged invalid request. Do not infer a local platform failure from arbitrary provider or tool prose. Exact retry/backoff policy belongs to the current error-policy implementation and its tests, not a historical incident transcript.

## 6. Subtasks and Firecrawl

One of the values of a sub-Agent is context isolation. The parent Agent provides research goals, necessary materials, and expected deliverables, and only receives outcomes, evidence, limitations, or failure information. The initial version does not add the ability to read a sub-Agent's internal conversations, trajectories, or step-by-step reviews of subtasks.

Current deep research is an external Firecrawl job and is not required to run a local Pi loop. Retain submission identity, external job ID, polling, and result receipts; when the parent execution recovers, it reconnects to the original job, and unknown submission outcomes must not be directly recreated. Polling and operational evidence needed by the service belong to Runtime internal mechanisms and are not equivalent to exposing internal history tools to the parent Agent.

## 7. Current Code Map

- Persistent identity and execution authority: `runtime-executions.ts`, `execution-context.ts`, migrations 0051, 0053.
- Unified pipeline: `conversation-runtime.ts`, Pi single-response-driven; audit: `execution-audit.ts`.
- Request and cache evidence: `conversation-request.ts`, `conversation-channel.ts`, `request-observation.ts`.
- Continuous history and compaction: `conversation-store.ts`, `conversation-compaction.ts`, `runtime-content.ts`.
- Deliverables and parent-child relationships: migration 0052, domain submission tools, `content-parent-conversation.ts`, `task-descendants.ts`.
- Commands and recovery: `task-commands.ts`, `task-recovery.ts`, `runtime-checkpoint.ts`; pages read D1 state.
- Firecrawl: `firecrawl-research.ts`, saves submission authority first, then saves external job ID; recovery reconciles against the same job.
- Local data cleanup: `scripts/reset-runtime-local.py`, explicitly restricted to local, backups first and reconciles protected data.

The legacy action loop, ObservationTrace, model-gateway, and phase Run relays have been removed from the business execution path.

## 8. Subsequent Implementation and Acceptance

Install structures through sequential migrations and inspect the active persisted task/tool contracts before upgrading. Migration is not permission to rewrite conversations, replace Task/Run identity or replay an unknown external effect. Local data cleanup is a separate explicit operation. Real-provider acceptance uses dedicated test materials and records its scope separately from deployment.

Necessary acceptance includes:

1. Initial six documents and tools match the actual serialized request; after restart, initialization is not repeated, normal continuation prefixes remain stable, and cache hits and provider-returned metrics are explained separately.
2. An audit is triggered every 30 rounds; continue renews automatically and replay does not add rounds repeatedly; finish saves complete outcomes without R2 or manual confirmation. Malformed audit output and model request failures can be handled in the same pipeline.
3. Excessively long tool results trigger capacity handling; after compaction, key constraints, failures, deliverables, and pending operations remain available, restarts use the same compacted version, and tool calls and results are not severed.
4. Remediable tool errors enter the next round without losing successful portions; unknown side effects are reconciled first; an empty error policy table does not break existing protections.
5. Workflow interruptions, lease switches, and cancellation races do not duplicate model outcome submissions, business modifications, or Firecrawl jobs; only one executor advances the same R1.
6. Appending inputs while running is rejected; valid processing outcomes from waiting states restore the original R1; domain approvals cannot be bypassed by continuation tools.
7. UI/API/formal strategy and task outcomes read back consistently; submitted deliverables, waiting, and explicit termination are distinguishable respectively. At least two different domain tool definitions verify the shared pipeline to avoid freezing a single model answer.

The acceptance report must record synthetic models, real models, Firecrawl, cache metrics, and browser evidence separately; passing locally does not represent a production release.

## Pipeline and durable views

Keep five orchestration responsibilities: resume persisted work, append attributable observations, prepare the complete model view, execute one decision and its tools, and persist/route the checkpoint. Domain definitions supply missions and optional preparation; mandatory authority, cancellation, persistence, capacity and effect checks apply to every definition.

Tool `content` is the model-facing result; host-only `details` must not duplicate it in compaction input. Preserve exact references, observed versions and receipts independently of model summaries. Full serialized-request capacity alone triggers compaction: storage page counts, `hasMore` and fixed fullness percentages are not capacity evidence. The adapter selects supported output allowance within the endpoint's shared input/output capacity.

Compaction is versioned durable work. Preserve successful shards and authorized original material; incomplete summaries never replace a valid context. Truncation, overflow and transient failure require distinct repairs. Verify pagination beyond one storage page, interruption between summary shards and actual serialized requests/provider usage.

## Stable parameter ownership

The host binds scope, execution identity and operation inputs. The Agent chooses returned references and expresses changes. A scoped native database ID can already be a reference; an opaque wrapper is not required merely to rename it. Version references retain the observed revision, never the revision most recently fetched during execution.

Migration 0050 introduced task-scoped observations and `parameter_contract_version`. Initialized historical tasks retain their protocol on replay. Resolution checks reference type and scope, then persists resolved inputs before effects. Creation generates identity before mutation; patching a missing object cannot create it. An old reference does not make a deleted object writable.

Domain meanings remain local: strategy has separate draft and activation-baseline revisions; document references bind document versions; topic decisions select scoped keyword/locale references; writing and review bind jobs and exact candidates. New research queries, changes, evidence judgments and completion decisions remain Agent-authored. The [content workflow](content-workflow.md) describes these contracts.
