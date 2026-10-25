# Content workflow and domain contracts

The Growth Leader coordinates business research, strategy, keywords, topics, writing, review and publication. Domain definitions in `worker/agent-runtime/` and domain modules register the available tools and pin their contracts for each initialized task. The sequence below describes responsibilities, not a fixed research script imposed by Runtime.

## Leader coordination

The Leader reads saved business state, investigates decision-critical ambiguity, delegates concrete briefs and returns attributable deliverables and remaining limits. It may request revision, proceed with successful siblings, wait, deliver partial results or take no further action. Child dispatch is not completion; `read_task` exposes saved status, formal reports and pending business questions, never a child's internal conversation.

A brief supplies the goal, relevant facts, decision use, expected deliverables and uncertainty. The host binds parent/child authority and permitted locale references. [Business learning](business-learning.md) is coordinated by the Leader; specialists receive ordinary business guidance and do not manage learning records.

For a supported waiting child, `provide_task_facts` sends sourced supplementary facts using the observed `input_ref`. These facts are neither a human answer nor publication approval. The receiving Agent reads its requests and can withdraw an obsolete question or `keep_waiting`. Input and successor execution commit under the original parent fence, preserving the child's Task/Run. Replays reuse the original input and successor; competing human answers, changed waits and unknown effects must be reconciled. Historical or external-job contracts without this capability remain unchanged.

## Business research

The `business_research` Agent starts from the configured site URL, locale, saved documents and `shared/business.ts` contracts. It chooses sources, preserves human facts, distinguishes inferences from unknowns, and can finish, partially deliver, leave documents unchanged or wait. External pages are untrusted evidence, not instructions.

Document save tools append versions independently. Atomic writes check actual saved source references, observed document versions and captured execution authority, preserving successful documents and concurrent human edits. Storage limits return explicit errors rather than silently truncating content. Firecrawl supplies configured page reading and [hosted deep research](deep-research.md).

## Strategy and reports

Strategy research combines business goals, documents, the permitted locale, content inventory, keyword research and available outcomes. It chooses tools and evidence depth without source quotas or keyword counts. Read tools expose current and historical artifacts through scoped references and pagination; omitted material is not a complete read.

Each new strategy task owns a new-version draft. Historical versions are read-only references. Creation and patch are distinct. Submission checks both the observed draft revision and the observed active baseline atomically. A concurrent activation returns a conflict while preserving the draft so the Agent can inspect and reconcile it.

Submission saves same-version reports and immutable snapshots before activation. `restore_strategy_reports` restores only available snapshots for the exact bound version: it never overwrites an existing report, invents a missing original or activates a new strategy. Submission, restoration, activation and task finish have separate effects. Reports and snapshots must both be considered in any explicit permanent-purge policy.

## Keywords and topic decisions

Keyword data is scoped by workspace/site/locale. Project locales are authoritative; a search country is evidence metadata, not a second library partition. Missing volume remains unknown, and paid-ad competition is not automatically organic difficulty. See [locale migration requirements](self-hosting.md#language-migration-precheck) when upgrading an older installation.

`worker/keyword-library/catalog.ts`, `tools.ts` and `service.ts` define the shared HTTP/Agent domain service:

| Capability | Semantic tools |
| --- | --- |
| Read entries, relationships and receipts | `list_library_entries`, `read_library_entry`, `read_library_logs` |
| Create or revise research | `create_library_keyword`, `revise_library_keyword` |
| Create or revise groups and clusters | `create_library_topic_group`, `revise_library_topic_group`, `create_library_cluster`, `revise_library_cluster` |
| Organize and associate topics | `organize_library_membership`, `relate_library_topic` |

The registered definition selects capabilities. `open_keyword_library` resolves a permitted locale reference; arbitrary labels cannot grant scope. Reads and receipts preserve observed versions. Writes bind resolved inputs before effects. Reusing an operation with different input is a conflict.

Creation generates identity in code; revision of a missing object never creates one. Omitted patch fields stay unchanged, nullable fields can be cleared with null, and arrays replace their field. Relationships validate real objects and types. Archiving preserves identity and history. Entries, logs and linked objects are paginated; a page limit is not a research quota.

One keyword may support multiple distinct topics and belong to multiple groups or clusters. Topic decisions can propose, research further, defer or conclude that no page is justified. A saved draft group is not approval to start production. Strategy keyword reports derive from actual mutations and receipts, not claimed writes.

## Writing and independent review

The editor coordinates a saved coverage plan, author and reviewer. The author saves a candidate and performs a fresh-context self-check; independent review evaluates the exact delivered version. Revisions return to the same author Task/Run. Existing publication approval remains required.

- `save_coverage_plan` creates immutable `content_coverage` references with host-owned entry IDs. A revision names its predecessor; dispatch binds the selected plan before child creation. `inspect_content_group` exposes the saved references for recovery.
- `read_article_source` returns an immutable extracted source snapshot or a paginated read of a saved snapshot. Extraction may be incomplete; its limits must remain visible.
- `save_claim_evidence` saves a `content_evidence` ledger with exact quotes, support assessments, limits and candidate locations. Quotes are checked against saved source bytes. A failed read preserves existing writing and ledgers.
- Candidate submission binds the plan, coverage responses and claim evidence under `seo_contract.editorial`. The saved candidate, rather than a later editable plan, supplies review context. Review findings and revision feedback retain exact artifact references.
- Reviewers can read their own sources and author sources explicitly attached to the assigned candidate. Authors can read reviewer sources explicitly returned in the saved revision assignment. These are evidence handoffs, not access to child conversations.
- Link discovery returns actual published or eligible peer articles and configured product targets. A configured URL does not prove that its claims were verified. Use the complete official product name from saved business facts.

Requirements can be answered, partly answered, moved to a related page, judged inapplicable or deferred. An empty justified plan or ledger is valid. Mechanical checks enforce accounting, source ownership, exact quotations, real candidate locations and locked versions; they do not impose quality scores, keyword quotas or mandatory endorsement. The reviewer may identify unregistered claims and choose pass, revise or defer. Supported article formats are documented in [Publishing](publishing.md).

## Event delivery and publication

The event pool stores immutable site-scoped facts and per-subscriber deliveries. Event subscriptions determine visibility, not tool authority. Publication-review events bind `job_id + artifact_id`; new candidates obsolete unclaimed old deliveries. Child reports target the original parent Run. Legacy contracts retain their original reporting entry point.

Domain wakeup adapters deliver pending events. Reading an event is not resolving it: the Leader reads the actual task or article and explicitly completes the inbox event. `decide_publication` uses the current candidate and existing approval/state checks to enter publication or reject with revision feedback. A tool receipt is not proof that the Publish Workflow or an optional export succeeded.

Event writes share the business transaction; failed wakeups retain deliveries. Due work uses bounded indexed queries rather than scanning history. `site_changes` is a separate UI refresh mechanism, not the business event queue. Inspect actual publication and configured external delivery receipts independently.

## Human work requests

Domains create work through `createWorkRequest(context, handlerId, node)` in `worker/agent-work/requests.ts` and register a `{ id, respond }` provider in `WORK_PROVIDERS`. The host generates request identity, version and attribution; UI cards render declared materials, fields and actions without interpreting domain decisions.

Providers check authorization, observed version and state, and use the incoming command identity for replay. Exact input and handling receipts are durable; request resolution and its receipt commit atomically. Unknown effects preserve the original input for reconciliation. `resolveWorkRequest` closes a request completed or withdrawn elsewhere without replaying its business effects. A revised question needs a new identity, not overwritten historical text. Cancelled tasks cannot initiate new actions.

Legacy domain tables and `pending/read` compatibility adapters remain authoritative where not migrated. The generic host interface does not give models unrestricted CRUD, bypass waiting rules or replace existing approval boundaries.

## Verification

Use [Verification](verification.md) for runnable checks. Domain tests should cover actual tool registration, scope and capability isolation, observed-version conflicts, immutable artifacts, rollback, partial delivery, pagination, replay and cancellation. Parent/child tests must use real execution-scoped authority and the actual child start service. Live research and editorial quality require separate model and rendered-publication evidence; a synthetic success does not establish either.
