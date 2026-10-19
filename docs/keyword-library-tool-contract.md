# Keyword library tool contract

The catalog lives in `worker/keyword-library/catalog.ts`, the tool factory in `tools.ts` and domain persistence in `service.ts`. HTTP routes and Agent tools reuse the domain service rather than invoking each other over HTTP.

| Capability | Tools | Purpose |
| --- | --- | --- |
| Read | `list_library_entries`, `read_library_entry`, `read_library_logs` | Read research, relationships, versions and attributable mutation receipts with pagination |
| Research | `create_library_keyword`, `revise_library_keyword` | Create or revise keyword research |
| Research | `create_library_topic_group`, `revise_library_topic_group` | Create or revise topic groups |
| Research | `create_library_cluster`, `revise_library_cluster` | Create or revise clusters |
| Research | `organize_library_membership` | Add or remove grouping relationships |
| Topic links | `relate_library_topic` | Associate real topics with a keyword or remove an association |

The Agent's registered definition selects capabilities. Unselected tools cannot be invoked by spoofing a tool name. The active persisted contract is authoritative; do not inject a newer schema into an initialized historical task.

## Observations and effects

The host binds authenticated workspace/site/locale, execution authority, actor, operation identity and observed versions. Models select returned scoped references rather than reconstructing these fields. Locale discovery and `open_keyword_library` resolve permitted locale references; arbitrary labels or a geographic search parameter do not grant access to another library.

Read results and mutation receipts provide durable observations. Before effects, operation binding freezes the selected object, actual observed version and resolved input so replay cannot reinterpret the choice against newer state. Creation generates identity in code; revision of a missing reference never creates a new entry.

Tools share one authoritative input schema with execution validation. Omission, null and empty-array behavior follows the [domain mutation contract](keyword-library-backend.md). Errors preserve valid work and identify invalid references, affected fields or version conflicts without guessing replacements.

## Topic handoff

Topic decisions may propose multiple distinct topics from one keyword. Topic drafts retain actual host-generated IDs and library relationships. Draft creation is not permission to start content production; existing approval must materialize the selected topic. Rejection and archiving retain history and relationships under their declared semantics.

The strategy's keyword report derives changes from real domain logs and receipts rather than interpreting a model's claimed write as proof. Legacy strategy tables and immutable receipts remain historical compatibility data.

## Evaluation and boundaries

The domain owns research meanings and relationships. Shared Runtime owns execution authority, persistent observations, idempotency and cancellation. Intent, sufficiency, grouping, priority, deferral and no action remain model choices.

Verify capability isolation, authoritative schema serialization, non-injectable host fields, cross-locale rejection, observed-version conflict, replay, expired execution, relationships and logs through the real registered tool path. Synthetic replies prove contracts; real-provider Agent runs separately evaluate research and topic handoff. See [verification](verification.md).
