# Project Locale Is the Only Partition

## Invariants and Attribution

`source_locale` and `translate_locales_json` in project settings are the sole sources of available locales. Identities for keyword libraries, keyword research, and topics are workspace/site/locale; there is no longer a separate `market` partition, nor is `global` interpreted or mapped to English. Existing `locale` values on records are preserved.

- **Domain Protocol**: The Leader selects a locale from the `scope_ref` returned by `discover_agents`, and the host resolves the reference to bind the child task; child tasks access the keyword library for the same locale via `library_ref`. Business objectives and judgments beyond locale selection remain decided by the Agent.
- **Domain Persistence**: Foreign keys for keyword library relations, name uniqueness, operation idempotency keys, and topic filtering uniformly use workspace/site/locale. The database directly enforces isolation, referential integrity, and deduplication protection; these rules are not SEO judgments.
- **Domain Prompts**: Leader v11 first investigates any ambiguity, omission, or conflict that would affect action, using the existing `request_human_input` when user judgment is required; it does not write guesses into delegations. Whether clarification is needed, question contents, and which work can proceed independently are determined by the model. There is no locale-specific follow-up question branch.
- **Shared Runtime**: Retains existing Runs, operation receipts, version observations, and HITL mechanisms without introducing new business routing or guess-repair rules.
- **Search Evidence**: Country, search sampling region, and similar criteria remain evidence source parameters; they do not participate in locale identity or create a second keyword library. The same locale does not guarantee equivalent research conclusions across different regions.

All valid business outcomes (completed, partially completed, research, revision, waiting, request information, no action needed) remain expressible. Clarification methods and research workflows can evolve via domain prompts and tools without rewriting the Runtime.

## Data Migration and Protocol Cutover

`0075` drops the market column from four keyword library tables and rebuilds related constraints; `0076` removes market/scope_market from topics and legacy strategy structures, stripping matching fields from mutable article plans. IDs, locales, revisions, references, and immutable receipts are preserved intact; legacy receipt JSON remains historical evidence and no longer serves as a scope selector for new tasks.

This is a schema-breaking cutover that drops fields, providing no legacy market parameter compatibility or automatic mapping. **Live cutovers must not be performed on tasks still executing the old tool protocol.** Prior to release, ensure:

1. Build from a clean, scoped release tree, verifying the Cloudflare account, database, and Worker target.
2. Run `scripts/language-only-preflight.sql`. Check for conflicting records; conflicts on the same name or operation ID within the same locale will cause the migration to roll back rather than merge silently. Genuine duplicates require an explicit business decision on resolution.
3. Complete related tasks and pending operations under the old version, confirming affected persistent sessions have cleanly shut down. Do not tamper with saved tool manifests, slots, operation inputs, or Task/Run identities to simulate an upgrade; if unfinished goals exist, retain and finish their actual work first.
4. Halt new task starts during the maintenance window, apply migrations in sequence after backing up, and deploy matching code. Validate foreign keys, record counts, configured locales, and keyword library reads before resuming new tasks. Migrations and Worker deployments cannot be assumed to be a single atomic operation.

A migration file and a passing local test do not prove that an existing deployment has completed this cutover. Verify your own migration state and active tool contracts before upgrading.

## Verification

- Full Worker tests and TypeScript/Vite build.
- Real SQLite full migration: preserved IDs, locales, relations, cascading child records, and immutable receipts; transaction rolled back completely on name conflicts.
- Agent tools: structured locale references, cross-locale rejections, observed versions, receipt replays; legacy market inputs are not mapped.
- HTTP: Locales configured in project settings are returned even without keyword library records; unconfigured locales are rejected.
- Leader: Captured local model requests, confirming abstract clarification prompts and `request_human_input` capabilities actually reach the request. This verification does not imply that the live model has already made judgments according to the new prompt.
