# Keyword library domain and storage

`worker/keyword-library/` owns keyword research information, grouping and relationships to topic drafts. It uses existing Runtime execution credentials and operation binding; it does not add another Agent loop or a generic storage CRUD interface.

## Scope and data

The identity is workspace/site/locale. Enabled project locales are authoritative. Search country and other geographic sampling choices describe evidence; they do not create a separate keyword-library partition. See [locale ownership and migration](language-only-domain.md).

The schema stores keyword entries, topic groups, clusters, memberships, links to topics and immutable mutation logs. Composite relationships enforce actual ownership and types. One keyword may be linked to multiple distinct topics, and a keyword may participate in multiple groups or clusters. Existing strategy snapshots remain historical records rather than being silently imported as current research.

Research can include intent, reader task, audience, scenario, business relationship, priority, rationale, uncertainty, evidence and nullable metrics. Evidence retains source, time and observation. Metrics retain value, unit, source, period and scope. Missing search volume is not a zero, and paid-ad competition is not automatically organic ranking difficulty.

## Mutations and identity

Creation generates a new host-owned identity. Revision selects an existing object and its observed version; a missing object does not become a create. Omitted patch fields remain unchanged, nullable fields can be cleared with null, and arrays replace their field rather than merging invisibly.

Grouping and topic associations use their declared relationship operations. They validate scope, actual objects and types, preserving content updates and immutable receipts. Content changes retain optimistic revision checks; execution cannot substitute the latest revision for the one actually observed. Archiving retains identity and history. Destructive removal requires its own explicit retention and approval semantics.

Operation identity, normalized inputs and actor are saved with durable results. A replay returns the original receipt; changing inputs under the same identity is a conflict. Atomic writes preserve entities and logs together. The caller's captured execution fence protects cancellation and stale writers.

## Tools and judgment

The [tool catalog](keyword-library-tool-contract.md) exposes semantic create, revise, organize, link and read actions. The host supplies authenticated scope, actor, operation identity and version observations. Never trust those fields merely because an HTTP request or model supplied them.

Grouping rationale, intent, reader value, evidence sufficiency, prioritization, whether to create a topic and whether to leave data unchanged remain Agent judgments. Mechanical checks protect scope, identity, revisions, referential integrity and effect replay.

Lists, members, linked topics and logs have explicit cursors. Consumers must follow pagination; a page limit is a transport boundary, not a research quota or proof that the library has been exhausted.

## Verification

Run the Worker suite, build and local keyword-library verifier. Check real SQLite migrations, cross-locale isolation, create/read/revise/log behavior, concurrent writes, rollback, replay, archive behavior and one keyword linked to multiple topics. Agent-level tests must additionally inspect persisted observation references and operation replay through the registered tools. Real-provider research quality is a separate acceptance scope.
