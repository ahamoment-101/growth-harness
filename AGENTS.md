# Repository Guidelines

## Project Structure & Architecture

This is a React/Vite console backed by a Cloudflare Worker and D1. UI entry points live in `src/`: pages are in `src/pages/`, shared shell/status components in `src/components/`, and browser-to-API calls in `src/api.ts`. The Worker entry point is `worker/index.ts`; persistence is centralized in `worker/db.ts`. Keep domain logic close to its feature: publishing and content rendering are under `worker/blog/`, integrations under `worker/lib/`, and durable Cloudflare Workflows under `worker/workflows/` and `worker/agent-runtime/durable-workflow.ts`. D1 schema changes are ordered SQL files in `migrations/`. Product and operational decisions belong in `docs/`; static design references are in `design/`.

## Build, Test, and Development Commands

- `npm install` installs dependencies.
- `npm run dev` starts the local Vite/Worker development environment.
- `npm run build` runs TypeScript project builds and produces the Vite bundle.
- `npm test` runs the Worker unit suite once with Vitest.
- `npm run cf-typegen` refreshes Cloudflare binding types after `wrangler.jsonc` changes.
- `npm run db:migrate:local` applies D1 migrations locally. Use `npm run db:migrate:remote` only when intentionally updating the deployed database.
- `npm run deploy` builds and deploys the Worker; confirm the target account and configuration first.

Copy `.dev.vars.example` to `.dev.vars` for local LLM credentials. Never commit `.dev.vars`, API keys, OAuth tokens, or customer webhook secrets.

## Coding Style & Naming

Use TypeScript with two-space indentation, single quotes, semicolons, and trailing commas, matching existing files. Name React components and exported types in `PascalCase`; use `camelCase` for functions and variables. Keep Worker/database fields in their existing `snake_case` API form. Put reusable pure logic in focused modules rather than adding route-specific helpers to `worker/index.ts`.

## AI-Native Agent Design Harness

### Continuous Runtime Contract (2026-09-08)

Read [the continuous Runtime contract](docs/continuous-agent-runtime.md) before changing Agent execution. It records the approved target and the current-code gap map; it is not a claim that migration or deployment has happened. Earlier Run-relay designs and acceptance reports are historical evidence, not requirements for new work.

- This is a 24/7 unattended business Agent, not an interactive chat product. One Task owns one persistent Run and one Agent loop. Stage continuation, recovery and permitted input after waiting resume the same T1/R1. A Workflow execution or lease can change without creating a new business Run. Do not add new-goal detection or conversation branching.
- Initialize identity, instructions, stable tools and initial business documents once. Persist native messages and append updates; never regenerate a replacement conversation from scattered rows on each execution. Preserve ordinary request prefixes where possible, and verify caching from serialized requests and provider metrics, not object or Run identity.
- Every model decision, including audit and repair, passes through the same Runtime pipeline. Business definitions register optional preparation steps; authorization, cancellation, capacity, persistence and effect integrity remain mandatory. An SDK loop must not bypass these steps.
- Check full request capacity before every model call. Persist versioned compaction while retaining authorized original history, operation receipts and artifacts. A rolling tail plus archive pointers alone does not meet the compaction contract. Do not persist credentials or private chain of thought.
- Every 30 normal model-decision rounds, append an audit instruction to the same conversation. A built-in audit tool chooses continue (automatically grant 30 more rounds) or finish (return completion status, results and reasons). Keep its definition stable and gate execution to audit mode. No human confirmation, cumulative stage cap or default human budget-expansion gate; retain cumulative accounting and handle actual provider/platform limits. Audit decisions are idempotent and get their own call allowance through the same pipeline.
- No user interjection during execution. Explicit waiting can accept a business response and resume the original Run. A saved artifact need not close the conversation; explicit finish/cancel does. Preserve existing domain approval boundaries, without adding approval for autonomous continuation.
- Child context is isolated. The parent supplies a brief and receives results, evidence, limits or failures; do not add parent inspection of child internal conversations. Deep research currently uses an external Firecrawl job, not a local child Pi loop.
- Include an extensible structured error-policy check in the pipeline; its registry may initially be empty. Unmatched repairable failures return to the Agent. An empty registry never bypasses cancellation, authorization or unknown-effect reconciliation. Add proven system error strategies by typed contracts, not incident-shaped text heuristics.

Agent behavior must remain primarily model-directed and evolvable. First classify the issue from actual model I/O and execution evidence: domain judgment, domain tool contract, shared execution protocol, or provider/platform interoperability. Fix it in its owning layer. The following preference order applies to domain-judgment problems; it does not require prompt experiments before enforcing an established invariant or fixing a broken protocol:

1. Give the Agent the missing facts and state in its context.
2. Clarify the mission, judgment criteria, boundaries, and available choices in the prompt.
3. Make every legitimate outcome representable in the Agent's action or output contract, including deciding to defer, request evidence, hand off, or take no action.
4. Use one persistent Agent loop with 30-round autonomous audits so the model can observe results, revise its approach, continue or finish. Keep cumulative accounting separate from renewable stage allowance.
5. Give the Agent small, semantic tools for reading state and performing domain actions; let the Agent choose when and how to use them.
6. Add deterministic code only when the requirement cannot safely or reliably be delegated to model judgment.

Do not convert a surprising model decision or a single production incident directly into an `if` statement, status-specific blocker, fixed retry count, keyword heuristic, score threshold, or special-case route. First ask why the Agent could not observe the relevant state, express its intended decision, call an appropriate tool, or continue its loop. For a domain-judgment problem, a deterministic patch is justified only after those possibilities have been considered and found insufficient. Established security, state-integrity, resource, and protocol invariants should be enforced directly in their owning layer.

### Runtime Pipeline Refinement (2026-09-08)

Run is the persistent session; do not add a synonymous Session identity above it. Executions carry successive portions of the same loop. Keep five orchestration responsibilities: resume work, append observations, prepare the model view, execute one decision and its tools, and persist/route the checkpoint. Domain judgment stays in definitions, prompts and semantic tools.

Separate durable receipts from model and compaction views. Never duplicate tool `details` into summarization input when `content` already represents the result. Do not archive private reasoning as business memory. Preserve exact entity references, observed versions and effect receipts independently of model-written summaries.

Only full request capacity triggers automatic compaction. Database page counts/hasMore and fixed 80% thresholds are not capacity evidence; do not discard unread history when removing those triggers. Use provider/model capability provenance and calibrated usage estimates. Remove the mandatory 50% compaction target. Remove business-specific small generation caps; the provider adapter selects the supported generation allowance for the request, considering shared input/output capacity.

Context maintenance preserves the same Run and durable progress. Truncation, context overflow and transient unavailability have distinct recovery paths; incomplete summaries never replace valid context. Recovery must change the failed condition or wait for an external condition, not blindly repeat an identical request. System recovery must not project as a request for human input. Validate with real serialized transport evidence as well as replay, cancellation, pagination and large-result tests.

### Parent and Child Execution Authority

A child Agent is a persistent semantic tool to its parent, but owns its own Task, Run, Execution and isolated conversation. Separate task reads, self-execution authorization and parent-authorized lifecycle operations. Creating or returning a child receipt must not validate the parent's credential as the child's execution credential.

Child lifecycle operations must validate the captured parent execution and the direct parent/child, workspace and site relationship. Keep all lifecycle writes behind the original parent's atomic execution fence; never unwrap the database, replace its credential, or grant authority by reading the latest epoch. Dispatch carries the child's independently persisted execution identity. The child validates that identity on activation. Replays reuse persisted child and operation identities; dispatch acceptance is not business completion. Cancellation/closure barriers apply through every ancestor, while a waiting parent permits its children to execute.

Test this boundary using a genuinely execution-scoped parent and the real child start service, with distinct child definitions, replay, stale parents, cancellation and interrupted dispatch. Mocking the start service or using only unscoped database fixtures does not verify authority transfer.

### Stable Parameter Ownership

Existing identities, versions and relationships are host-owned slots, not text the model must regenerate. Bind workspace/site/Task/Run/locale/operation identities in execution context. For selectable objects return stable, scoped references; the Agent chooses a reference and expresses changes. For optimistic concurrency bind the version actually observed, never the latest version at execution time. Persist observations and resolved operation inputs before effects so replay cannot reinterpret a decision against newer state. Existing validated database IDs may serve as references; do not wrap them solely to rename them.

Creation and patch are distinct domain actions. Creating generates identities in code; patching a missing reference must never create a new object. New names, research questions, priorities and market choices remain Agent judgments. Reference resolution must not use fuzzy labels, reconstructed URLs or guessed fields. Expose concrete invalid references and preserve valid work. Historical contracts stay pinned; adopt new tool protocols through persisted contract versions.

### Responsibility Boundaries

Shared Runtime and infra own mechanisms that must be consistent across Agents: persistent Task/Run identity, execution leases, durable execution, state transitions, conversation history and compaction, idempotency, tool authorization and validation, stage accounting and audits, concurrency safety, persistence, recovery, cancellation, and existing domain-approval enforcement. Infra must not decide domain strategy on an Agent's behalf.

Each domain Agent owns its mission, prompt, context composition, decision vocabulary, local tools, completion criteria, and quality judgment. Agent-specific behavior should stay near that Agent. Promote something into shared infra only when it is a stable mechanism shared by multiple Agents, not merely similar wording or a one-off business rule.

Prefer registering definitions, context providers, and tools over adding Agent-name branches to shared routers or workflows. Prefer a small number of semantic actions over exposing storage tables or low-level CRUD. Avoid speculative frameworks: extract a shared abstraction only after the common lifecycle and invariants are clear.

### Generalize From Cases, Keep Ownership Explicit

A production case is evidence of a possible contract gap, not the scope of the solution. Before implementing a non-trivial fix, state the violated invariant, the owning layer, and how the fix applies to another Agent or why it is domain-specific. Shared means a stable mechanism whose semantics remain valid without knowing the Agent's business vocabulary; similar field names or anticipated future Agents alone do not justify an abstraction.

- **Model/provider adapters** own provider capability discovery/configuration and translation of the shared request/response contract. Verify the actual serialized request and decoded response; persisted SDK arguments alone do not prove what the provider received. Do not assume a parameter is supported or obeyed because it is accepted by an SDK.
- **Shared Runtime** owns execution cardinality, operation identity, ordering, result correlation, replay, partial-failure preservation and budgets. An explicit one-action contract must be aligned with adapter capabilities and validated on response. Supporting multiple actions requires defined ordering, authorization, partial success and recovery semantics; never silently discard extra calls or execute concurrent writes merely because a model returned them together.
- **Tool contracts** supply one authoritative schema for model-facing definitions and execution validation, with explicit provider transformations at the adapter boundary. Shared validation reports structural failures; each domain owns permitted meanings, reference relationships and business invariants. Runtime must not infer missing business fields, silently map ambiguous enums, or invent references.
- **Shared error transport** preserves error category, affected object/field paths, violated constraints, known execution effects and recovery requirements. Domain tools supply concrete invalid references and relevant evidence handles. Distinguish invalid input, state conflict, transient execution failure and unknown side-effect outcome; retrying unchanged input is not a repair for invalid input. Expose successful work and valid references so correction does not require replacing or discarding them. Redact sensitive values.
- **Domain mutation tools** define create, patch, replace and delete semantics, stable identity, and the distinct meanings of omission, null and empty values. Prefer targeted edits when the intent is to revise existing work; creation still validates required facts. Shared mechanisms may enforce revisions, atomicity and idempotency, but must not impose generic field-merge semantics or expose storage CRUD in place of semantic tools.
- **Domain Agents** own research depth, primary versus supplementary tools, evidence sufficiency, business classification and quality judgment. Shared infrastructure makes these decisions expressible and executable; it must not encode SEO priorities, research quotas or a universal editorial workflow.

Extract the smallest mechanism with clear lifecycle and invariants. Use definitions, registered tools and context providers for domain differences. Do not build a speculative framework or move a domain policy into Runtime simply to make it reusable. Test shared mechanisms with distinct Agent/tool definitions, including failures and replay; test domain tools for their own semantics rather than freezing one model answer.

### Decision Ownership Principle

Runtime guarantees that the Agent can reliably observe, decide and act; it does not choose business strategy for the Agent. Apply this boundary to new situations, including error feedback, tool schemas, prompts generated by infrastructure, recovery routing and tests—not just the main loop.

Before adding a restriction, ask: if it were removed, which objective invariant would be violated? Name the invariant, its evidence and its owning layer. Permissions, identity/version integrity, durable effects and verified platform constraints justify mechanical enforcement. A less efficient approach, lower-quality judgment or an unexpected model choice alone does not. Do not turn an implementation convenience or an unverified assumption into a platform limit.

For a judgment failure, make the relevant facts, uncertainty, successful effects and remaining choices observable; provide semantic tools and let the same Agent loop select a repair. Returning a hardcoded business rejection to that loop does not make the restriction model-directed. Infrastructure-generated feedback must describe supported facts and execution conditions without secretly instructing the Agent to abandon a source, adopt a strategy or declare the business finished.

Autonomy does not mean retrying every failure through the model. The owning engineering layer reconciles unknown effects, restores a broken protocol, or waits for a temporary dependency condition while preserving progress. Recovery must address an evidenced cause; neither blind repetition nor premature business termination is a substitute. Existing explicit business approvals remain enforced.

Keep this Harness about reusable decision boundaries. Record individual incidents, completed fixes and test results in implementation and acceptance documents. Evaluate new behavior against invariants and legitimate Agent choices, not against one preferred model answer.

### Deterministic Code Boundary

Deterministic enforcement is appropriate for security, authorization, tenant isolation, destructive-action approval, schema and identity integrity, idempotency, published-data protection, transactional state changes, declared platform/resource limits and stage-allowance integrity, and renderer or platform capabilities that are objectively unavailable. These checks should validate or safely execute an Agent decision, not replace the decision itself.

Reader value, strategy priority, whether evidence is sufficient, whether work should wait, which task should be retried, and whether content is useful or repetitive are normally Agent judgments. Express these through context, prompts, tools, and review loops. Mechanical validation may verify that required fields exist or references are real, but should not encode subjective SEO/GEO quality as brittle word counts, phrase lists, or formatting formulas.

Every hard constraint must have a documented reason in the owning contract. If removing a constraint would create only a lower-quality judgment, it likely belongs to the Agent. If removing it could violate permissions, corrupt state, lose work, duplicate irreversible effects, exceed an explicit budget, or produce an artifact the platform cannot process, it likely belongs in deterministic code.

### Required Review Dimensions

Before implementing an Agent change, review all of these dimensions:

- **Model I/O evidence:** Before changing prompts, tool descriptions, or repair feedback, confirm what the model actually received and emitted — attempt records, persisted payloads, or a local reproduction against the real endpoint. Classify the failure first: model judgment (fix through facts, prompts, tools, loops) vs platform interop (schema shape, encoding, or decoding the provider cannot express — fix at the capability boundary). Prompt-level repair cannot fix a broken output channel, and identical repeated failures are a signal to stop climbing the prompt ladder and collect evidence.

- **Observation:** Does the Agent receive the current business state, prior decisions, execution results, errors, and uncertainty needed for this judgment? Is the context current, bounded, and attributable?
- **Decision space:** Can the Agent legally express every reasonable outcome, including success, revision, deferral, evidence requests, partial completion, escalation, and no-op? Do not force a meaningful state into an unrelated branch.
- **Loop:** Does every model decision pass through the same pipeline? Can the Agent observe failures, revise, autonomously renew 30-round stages or finish in the same Run? Audit mode must not reset cumulative accounting or require human expansion approval.
- **Tools:** Are missing capabilities better represented as narrow read or action tools? Are tool names semantic, outputs useful to the next decision, side effects idempotent, and permissions explicit?
- **Memory and feedback:** Will durable outcomes, human feedback, rejected decisions, execution failures, and measured results be available to subsequent rounds of the same Run and, where domain-relevant, future tasks without treating unverified observations as learned truth?
- **Failure semantics:** Are partial successes preserved? Can failed units be retried locally? Can the Agent distinguish evidence failure, execution failure, quality failure, waiting, and cancellation?
- **Human control:** Preserve existing consequential domain approvals and cancellation. There is no runtime chat interjection or new approval for audit continuation; permitted business input is accepted only while waiting.
- **Abstraction:** Is the change a generic Runtime mechanism or a local domain judgment? Could a future prompt/model/tool improvement change the behavior without rewriting orchestration code?
- **Evaluation:** Are tests checking contracts, invariants, tool effects, state preservation, and user-visible outcomes rather than freezing one preferred model answer?

### Handling Common Cases

- **The Agent wants to wait or do nothing:** Provide a general defer/no-action outcome with a reason, recommended next action, and resume condition. Do not fabricate an empty success object, misuse an evidence-request branch, or block the Run before the Agent can judge.
- **Evidence is missing:** Let the Agent request targeted evidence or use an allowed research tool. Preserve known facts and unknowns separately. Do not invent content to satisfy capacity.
- **A child task fails:** Preserve successful sibling outputs and failure evidence. Return child results and failure summaries so the parent can choose a local retry, revision or partial completion without inspecting child internal conversations; do not roll back the whole group by default.
- **Model output is malformed:** Keep structural validation, return concise validation feedback to the next decision through the same Runtime pipeline when safe, and improve the output contract or prompt. Do not weaken important invariants or add incident-shaped fallback content. If the same malformed output repeats identically across repair attempts, suspect a platform interop failure (for example, a schema shape the provider's tool-call decoding cannot express) rather than model judgment: verify the raw model output, then fix at the capability boundary such as flattening a schema the platform cannot express.
- **Content quality is weak:** Improve the task context, evidence, editorial prompt, reviewer Agent, or revision tools first. Avoid keyword-density rules, mandatory filler, universal outlines, or other formulas that optimize proxies instead of reader value.
- **A format cannot be published:** Enforce only the actual renderer/platform limitation deterministically and expose that capability to the Agent. Do not present a product preference as a technical impossibility.
- **Parallel work could conflict:** Let Runtime enforce identity, locking, idempotency, and explicit resource budgets. Let the Agent decide prioritization and sequencing unless the business contract explicitly requires serialization.
- **A new edge case appears:** Determine whether it reveals missing observation, an incomplete decision vocabulary, an absent tool, weak feedback, or a true invariant. Fix the lowest appropriate layer and avoid adding a special case until this classification is explicit.

For every non-trivial Agent change, the implementation summary or review must state: the owning layer of each change, what is shared versus domain-local and why, what remains model-directed, what is deterministic, why each deterministic rule is necessary, whether the Agent can express all legitimate outcomes, and how the design can evolve through prompts, tools, or definitions without rewriting the Runtime.

## Testing Guidelines

Vitest discovers `worker/**/*.test.ts` in the Node environment. Add a colocated test such as `worker/lib/foo.test.ts` for every behavior change in Worker logic, especially payload shape, locale policy, persistence, and external-request handling. Use descriptive `it('does ...')` cases and run `npm test` before opening a PR. Also run `npm run build` for UI or type-affecting changes.

## Commits & Pull Requests

History uses short imperative subjects (for example, `Initialize GrowthHarness...`); keep each commit focused and explain the user-visible outcome. PRs should state scope, migration/configuration changes, and verification commands. Include screenshots for console UI changes, and link relevant issues or docs. Do not overwrite unrelated working-tree changes.

## Public Core and Downstream Maintenance

Keep platform-neutral model configuration and protocol adapters in this upstream repository. Distribution-specific registry migrations and request transforms belong behind `shared/config/model-extensions.ts` and `worker/lib/model-extensions.ts`; the public implementations remain empty. Never import a sibling private checkout into public code or configuration. Follow `docs/repository-maintenance.md` when synchronizing common changes downstream, preserve deployment configuration and credentials, and verify both checkouts independently.
