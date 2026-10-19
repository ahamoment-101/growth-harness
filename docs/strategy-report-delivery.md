# Versioned strategy and report delivery

Strategy research owns its draft, evidence, recommendations and reports. Shared Runtime owns execution authority, durable conversation, effect receipts, capacity and recovery. Report availability and research outcome are separate facts.

## New work and historical references

Manual research requests a new strategy version. New-task drafts are distinct from the active and historical versions, which are read-only references. An Agent can reuse facts and ideas after evaluating them, but cannot use historical storage IDs as write selectors for its own draft.

The initial strategy baseline and draft revision are independently observed. Submission atomically checks both. Concurrent activation returns an explicit conflict without losing the draft; the Agent can inspect the newer version and decide how to revise or reconcile. Replays use the saved operation inputs and receipts, not a newly queried latest version.

Research scope, evidence sufficiency, whether recommendations need changes, revisions, waiting and honest partial results remain model decisions. The domain's explicit requested deliverable and trigger policy apply to new work; persisted historical definitions retain their original schema and semantics.

## Reports and restoration

Successful submission writes the same-version reports and exact immutable snapshots together before activation. Host snapshots are durable artifacts, not substitute model context or automatically verified current evidence.

`restore_strategy_reports` targets the exact bound version and copies only available snapshots. It does not overwrite an existing report, synthesize a missing original or activate a new strategy version. Missing snapshots and empty or unavailable reports remain explicit. Domain tools allow an Agent to inspect reusable material, submit a fresh version or explain a remaining delivery gap.

Restoration and submission use execution-scoped atomic writes, cancellation fences, version identity and idempotent receipts. These checks preserve data and effects rather than score strategy quality. A report write alone does not terminate a Task; the registered finish contract records the actual business outcome and delivery state.

## Upgrades and verification

Apply ordered migrations before the matching deployment. Report snapshots may contain historical material and must be included in a deliberate permanent-purge policy; removing a visible row alone is not a full deletion.

Verify verbatim body/time preservation, non-overwrite, partial absence, locale isolation, rollback, cancellation, replay, concurrent version activation and historical contract compatibility. Read back actual reports and saved version relationships. Synthetic conversation tests prove routing and persistence, not real-model strategy quality or SEO outcomes. See [verification](verification.md).
