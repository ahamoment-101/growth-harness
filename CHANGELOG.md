# Changelog

All notable changes to GrowthHarness are recorded here. Versions follow [Semantic Versioning](https://semver.org/). While the major version is 0:

- a **minor** release (0.1 → 0.2) may add database migrations, configuration or deployment changes; read its **Upgrade notes** before upgrading;
- a **patch** release (0.1.0 → 0.1.1) contains fixes only and needs no manual step.

Every release lists, under **Upgrade notes**, each new migration by file name, any migration that drops or rewrites data, new or renamed configuration and secrets, and changes to Durable Object or Workflow declarations in `wrangler.jsonc`. CI fails when a migration after the 0.1.0 baseline is missing from this file. Upgrade steps are in [self-hosting](docs/self-hosting.md#upgrading-a-release).

## [Unreleased]

### Added

- Frozen, executable evaluation plans and Leader tools to read agreements and submit formal outcome evidence for Learning Agent assessment.
- Leader can supply sourced facts to a waiting direct child in its original Task/Run; the child can withdraw its own obsolete question or keep waiting on the same request.
- Site-owned business learning with Intent / Experience / Utility, Leader adoption tools, a Runtime-backed Learning Agent, outcome observation and File Cabinet views.
- Optional Workers AI BGE-M3 / Vectorize semantic recall with durable indexing, scoped hydration and explicit applicability decisions.
- Reproducible isolated learning checks and configuration guidance.
- Code of Conduct (Contributor Covenant 2.0) and a pull request template.

### Changed

- Runtime snapshots object attribution across child tasks and assignments; Learning Agent v3 validates object/version citations and replaces unsupported prior interpretations.

- CI uses `actions/checkout` 7.0.1 and `actions/setup-node` 7.1.0.
- `@cloudflare/workers-types` is pinned to an exact version instead of `latest`.

### Fixed

- Save explicitly selected historical guidance with delegation, so adoption registration and the specialist brief share a durable decision receipt.
- Capture exact topic group/item identities, immutable submission versions and delivered content atomically for learning attribution.
- Clarify learning finding categories and distinguish unrecorded adjustments from evidence that no changes occurred.
- Render nested bold and italic star delimiters correctly in article text and link labels while preserving code spans and safe links.

### Security

- Refresh transitive `body-parser` and `fast-uri` dependencies and override Miniflare's `undici` to 7.30.1 to address the pre-merge dependency audit. Cloudflare tool versions remain unchanged.
- Vitest 4.1.12 addresses GHSA-qxg6-89mg-rqv8 and GHSA-xp26-3454-mjgp. Vitest is test tooling only and is not part of the deployed Worker.

### Upgrade notes

- The formal-outcome/delegated-adoption update requires no additional migration, secret or binding. New tasks use Leader 25, Learning Agent 6 and Topic 30; existing tasks keep pinned contracts. See [Business learning](docs/business-learning.md) and [acceptance boundaries](docs/verification.md#business-learning).
- Supplementary task facts require no migration, new secret or binding. New tasks use the updated Agent tool contracts; existing tasks retain their pinned versions.
- Apply `0085_task_subjects.sql` and `0086_learning_attribution.sql` before deploying the attribution update. These add subject snapshots and conservatively backfill evidence relationships; no learning conclusions or rewards are rewritten. Existing Learning Agent v1/v2 runs keep their contracts.
- Apply `0082_business_learning.sql`, `0083_leader_learning.sql` and `0084_learning_search.sql` before deploying. These add learning storage, Leader attribution and a search outbox; existing conversations keep their pinned contracts.
- Optional bindings: `AI` and `LEARNING_VECTOR_INDEX` with a dedicated 1024-dimensional cosine index. See [Business learning](docs/business-learning.md). Without these bindings, records and directory access work, while semantic recall reports unavailable.
- The new `learning_agent` uses the existing model registry. No new model credential is required by the default preset; custom registries may assign a profile.
- No Durable Object or Workflow declaration changes.

## [0.1.0] - 2026-10-21

First public release.

### Added

- Self-hosted content team: Growth Leader, business research, strategy, deep research, keyword research, topic decisions, editor, writer and independent reviewer Agents on one continuous Runtime.
- Classroom console with live team status, Leader conversations, task panels and owner publication approval.
- Hosted multilingual blog with sitemap, feeds and optional Webhook, sitemap submission and IndexNow.
- Email and password login by default, optional Google login, single owner workspace.
- OpenRouter model preset with optional OpenAI, Anthropic and compatible endpoints; optional Firecrawl, DataForSEO and Search Console integrations.
- Missing model credentials are shown on the home screen and before a message is accepted; already accepted tasks pause and can resume after configuration is restored.

### Upgrade notes

- **Fresh installations** apply the baseline migrations `0001`–`0081` with `npm run setup -- --local` or `npm run db:migrate:remote`. No manual step is needed.
- **Instances created before this release** (from an earlier private build):
  - `0073`–`0080` change schema and Runtime protocol. Do not upgrade while old-protocol tasks are executing.
  - `0075_language_only_library.sql` and `0076_language_only_topics_strategy.sql` **drop columns**. Back up D1 and complete the [language migration precheck](docs/self-hosting.md#language-migration-precheck) first.
  - `0081_password_auth.sql` adds password login. Existing Google administrators should follow [Existing Instances](docs/self-hosting.md#existing-instances) before disabling Google.
- Default Cloudflare resource names are now `growth-harness` (Worker, D1 database) and `growth-harness-research` (R2). Existing deployments keep their own names in `wrangler.jsonc`; renaming deployed resources is a separate migration.

[Unreleased]: https://github.com/ahamoment-101/growth-harness/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ahamoment-101/growth-harness/releases/tag/v0.1.0
