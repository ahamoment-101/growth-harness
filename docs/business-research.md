# Business information research

The authenticated business-research entry starts the registered `business_research` Agent. It uses the site's configured URL, source locale, existing saved documents and the document contracts in `shared/business.ts`.

## Ownership and choices

The domain Agent selects pages, evaluates evidence, preserves human-provided facts, labels inferences and unknowns, writes business documents and decides completion, partial completion, no change or waiting. Public pages are untrusted source material rather than instructions. Generated research must not be presented as verified customer assertions without supporting evidence.

The shared Runtime owns durable native messages, execution credentials, operation correlation, capacity, cancellation, recovery and autonomous audits. The task continues its original Task/Run across host changes; no domain-specific alternate loop is introduced.

## Persistence

Domain save tools append document versions independently, retaining other successful documents. References must resolve to the task's actual saved page snapshots. Writes enforce the original execution authority, cancellation state and observed document version atomically, protecting against stale executions and concurrent human edits. Replaying an operation returns its original receipt.

Document storage limits return explicit errors instead of silently truncating saved content. Scope, references, revisions, idempotency and storage capacity are mechanical constraints; research depth, persuasive evidence and useful document content remain model judgments.

## Web services and verification

Page reading uses the configured Firecrawl scraper, retaining navigation links and immutable snapshot identity. Search uses the configured search integration. Hosted research has its own [durable provider contract](deep-research.md).

Run the Worker suite and build. The local business Workflow verifier exercises authenticated API calls, the real child start service, execution-scoped D1, saved documents and read-back with synthetic model/page responses. It does not prove a real provider account or the quality of generated business research. See [verification](verification.md).
