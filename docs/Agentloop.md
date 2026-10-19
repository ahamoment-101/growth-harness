# Content growth Agent workflow

GrowthHarness combines business research, strategy, keyword research, topic decisions, writing, review and publishing. The missions and semantic tools for each domain live in `worker/agent-runtime/` and `worker/keyword-library/`; their registered definitions and persisted contract versions are the authority for an executing task.

## Business flow

1. Business research reads the site's configured URL and saved business documents, preserving evidence, human edits and uncertainty.
2. Strategy research evaluates the business and available evidence, maintains the keyword library and submits a versioned strategy with its reports.
3. Topic decisions investigate opportunities for one configured locale. The Agent can propose distinct topics for one keyword, request research, defer or conclude that no new page is justified.
4. After topic approval, the content editor delegates writing and independent review. The author owns the draft, source evidence, internal links and fresh-context self-check; review feedback returns to the same author Task/Run for revision.
5. An approved candidate enters the existing owner publication approval. Publishing serves hosted articles and may export to configured external destinations.

An artifact, tool receipt, provider status and business completion are separate facts. A saved draft is not a published article; a publication is not proof of indexing, reader value or growth.

## Shared and domain responsibilities

The shared Runtime owns persistent Task/Run identity, execution authority, durable messages, capacity, compaction, tool validation, idempotency, cancellation, recovery and autonomous 30-round audits. It does not choose SEO strategy or research depth. See the [continuous Runtime contract](continuous-agent-runtime.md).

Domains own their goals, observations, prompts, tools, deliverables and judgment. Plans, evidence sufficiency, prioritization, topic differentiation, revisions, partial delivery, waiting and no action remain model decisions. Tool contracts protect real references, observed versions, permissions, published data and existing publication approval.

Business documents and versioned artifacts are durable records. Exact operation receipts and object references are retained independently of model-written summaries. Source snapshots, provider excerpts, inferences and human assertions must remain distinguishable.

## Locale and feedback

Project settings define the available locales. Each locale has scoped research, keywords and topic decisions; a geographic search parameter is evidence metadata rather than a second partition. Localization produces separate real language versions of an article. See [locale ownership](language-only-domain.md) and [multilingual URLs](multilingual-seo-strategy.md).

Measured outcomes, human feedback and rejected work can inform later judgments when exposed by domain tools. Cross-task learning and automatic Harness improvement are not established merely by retaining history. Evaluate those separately from successful within-task correction.
