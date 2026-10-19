# Stable Agent parameters in the continuous Runtime

> The current execution contract is in [continuous-agent-runtime.md](continuous-agent-runtime.md). This document defines ownership of business identities and observed versions.

## Ownership and compatibility

Runtime owns durable reference storage, operation bindings, task scope, execution fencing, receipts and autonomous audit checkpoints. Domains own object meanings, create/patch semantics, allowed relationships, evidence interpretation and completion. The model chooses permitted locales, research depth, changes, quality judgments and continuation. Deterministic checks prevent identity corruption, unauthorized access, stale writes, duplicate effects and unauthorized execution takeover; they do not grade SEO quality.

Migration 0050 adds immutable task-scoped slots, resolved operation bindings and `parameter_contract_version`. Existing tasks stay on contract 0; new tasks use contract 1. Continuous Tasks use autonomous 30-decision audits; cumulative usage never resets. Definition IDs are unchanged because the independent persisted parameter contract selects the tool protocol. Legacy decisions keep their original schema on replay and recovery. No user draft or evidence is cleared or converted in place.

A slot is an immutable observation addressed by a task-scoped digest. Resolution verifies type and ownership. Version references contain the observed revision, never an automatically refreshed revision. Bindings persist before effects and replay returns the same resolved arguments. Domain operations retain atomic revision/epoch checks and existing idempotent receipts. A deleted object is rejected by the domain even when its old reference remains readable.

## Tool inventory

| Registered family | Parameter ownership |
| --- | --- |
| Strategy workspace/blueprint/keywords/review/submit | Task injects locale and execution scope. Workspace refs carry revision and initial base version. System-generated territory/cluster keys and keyword IDs survive patches. Keyword creation and patch are distinct. Source refs resolve to saved evidence URLs before saving. |
| Strategy read_strategy/read_site_content/read_evidence | Existing version, source, job and research Task IDs are validated selectors with site/locale/parent scope. Version observations additionally return a version_ref for explicitly reconciling the submission baseline. |
| Strategy deep_research | Host supplies parent Task, operation identity and locale. resume_task_id is an existing, parent-scoped selector. Provider research question/context remain Agent-authored. Hosted Firecrawl implementation is unchanged. |
| Business documents | document_ref binds module key and observed version; source IDs already select persisted snapshots. Save checks document version and execution epoch atomically. |
| Web page, sitemap, autocomplete and search | A new URL, domain, query or search country is a research choice. Saved-source citations use returned selectors. Host injects tenant/execution scope. |
| Topic decision | The Agent selects scoped keyword and locale references. The host binds actual persisted identity before caching the operation. Search returns stable web-source references; citations use exact returned handles rather than fuzzy titles or reconstructed URLs. Historical contracts remain pinned. |
| Content production, article production, content review | Run context already binds topic/job/candidate artifact and approval state. Model supplies content, editorial decisions, change requests or defer reasons; it does not supply candidate identities. |
| Published article inventory | Locale is an explicit read filter; returned job IDs and URLs are existing resource selectors. |
| Conversation control and synthetic tools | Run/approval scope is host-bound; reason/input are decisions. Synthetic-only tools retain fixture-specific contracts. |

Native validated IDs are already slots; no redundant opaque wrapper is required. Reads may register new scoped observations without creating a keyword. Newly created object IDs are bound to the operation before any write, so retries cannot generate another identity.

## Runtime integration

All six business Agents use the same original Task and Run. Workflow replacement changes Execution and its captured epoch. Every 30 normal model decisions the original Agent resolves an audit with continue or finish, without human authorization. Tool manifests remain stable; audit mode suspends new business writes.

The authenticated process endpoint exposes cumulative usage, audit decisions, current work and outcomes. Running tasks accept cancellation only. Business input and explicit child assignments append to a waiting task and resume its original Run.

## Acceptance

Run `npm test`, `npm run build`, `node scripts/verify-strategy-workflow-local.mjs`, `npm run verify:runtime:long:local`, and `npm run verify:business:workflow:local`.

The Workflow verifier checks actual local Cloudflare execution, same-Run handoff, autonomous audits, persisted tool repairs and final submission. Its model is synthetic. The live-provider fixture uses six public fictional documents and separately records serialized requests, provider cache metrics and the saved Firecrawl job lifecycle. Neither proves production deployment.
