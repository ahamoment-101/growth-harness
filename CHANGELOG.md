# Changelog

All notable changes to GrowthHarness are recorded here. Versions follow [Semantic Versioning](https://semver.org/). While the major version is 0:

- a **minor** release (0.1 → 0.2) may add database migrations, configuration or deployment changes; read its **Upgrade notes** before upgrading;
- a **patch** release (0.1.0 → 0.1.1) contains fixes only and needs no manual step.

Every release lists, under **Upgrade notes**, each new migration by file name, any migration that drops or rewrites data, new or renamed configuration and secrets, and changes to Durable Object or Workflow declarations in `wrangler.jsonc`. CI fails when a migration after the 0.1.0 baseline is missing from this file. Upgrade steps are in [self-hosting](docs/self-hosting.md#upgrading-a-release).

## [Unreleased]

### Added

- Code of Conduct (Contributor Covenant 2.0) and a pull request template.

### Changed

- CI uses `actions/checkout` 7.0.1 and `actions/setup-node` 7.1.0.
- `@cloudflare/workers-types` is pinned to an exact version instead of `latest`.

### Upgrade notes

- None. No migration, configuration or deployment change.

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
  - `0075_language_only_library.sql` and `0076_language_only_topics_strategy.sql` **drop columns**. Back up D1 and complete the [language migration precheck](docs/language-only-domain.md) first.
  - `0081_password_auth.sql` adds password login. Existing Google administrators should follow [Existing Instances](docs/self-hosting.md#existing-instances) before disabling Google.
- Default Cloudflare resource names are now `growth-harness` (Worker, D1 database) and `growth-harness-research` (R2). Existing deployments keep their own names in `wrangler.jsonc`; renaming deployed resources is a separate migration.

[Unreleased]: https://github.com/ahamoment-101/growth-harness/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ahamoment-101/growth-harness/releases/tag/v0.1.0
