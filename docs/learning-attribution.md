# Learning attribution integrity

## Invariant and ownership

A retry identity answers whether an effect has already happened. Attribution answers which practice, object and version the effect concerns. Neither can replace the other. One practice can contain several objects, and one persistent Task can receive several assignments for successive versions of an object.

Runtime owns direct parent identity, execution authority, assignment identity, inherited opaque subject references and durable report snapshots. It does not infer an article identity from text. Domain tools validate actual objects and supply `{ type, id, version }` references. The content domain binds the selected job and, for a review, the exact observed artifact. An author's assignment has no output artifact yet, so its version is unknown until formal delivery evidence exists.

The existing learning delegation receipt selects the practice before dispatch. The database copies that practice relationship at Task creation, through any depth of descendants. A Leader may coordinate multiple practices; it is not globally locked to one practice. A child without an explicit object assignment inherits its parent's saved subjects, not its parent's conversation. Explicit assignments can contain several subjects. Empty subjects mean unassigned evidence, not proof that an object does not exist.

## Persistence and replay

- `0085_task_subjects.sql` adds `agent_tasks.subjects_json`, the captured `parent_assignment_id`, and immutable `agent_task_assignments.subjects_json`. The Runtime copies parent subjects within the Task insertion transaction. Assignment changes apply the saved snapshot and must reference that same Task.
- `0086_learning_attribution.sql` adds `learning_evidence.attribution_json`. A formal Task report captures Task, parent, assignment and subjects at emission. Later reassignment cannot rewrite it. Publication references come from actual job/artifact relationships. A creator report can acquire a version from its formal delivery receipt only when the saved artifact belongs to that job; the original assignment remains unchanged.
- Content dispatch binds subject references alongside the existing operation's resolved inputs. Retrying reuses that binding. Changing subjects under the same initial assignment identity is rejected. Captured parent execution fences remain intact.
- Existing operation receipts, evidence identities and practice feedback deduplication remain authoritative. This change does not create an extra feedback sample per child or per report.
- Migration backfill uses saved structured job references and real publication relations only. It does not infer historical review versions from today's artifact. It does not alter any learning conclusion, evaluation agreement or utility value. Other historical evidence remains unassigned.

## Learning contract v3

The Learning Agent receives each evidence item with attribution and a directory grouped by exact subjects for the current page. Pagination remains required for additional evidence.

`findings` is a complete replacement set of current evidence-grounded statements. Each statement has a scope (`object`, `practice`, `unknown`), subjects, kind (`adjustment`, `delivery`, `conclusion`, `limitation`), text and exact evidence references. Object findings must cite evidence belonging to their selected objects and versions. Aggregate practice judgments and uncertainty remain expressible. A missing version cannot substantiate a version-specific claim.

The engine derives the displayed adjustments, delivery and conclusions from these findings after preparation. It does not silently retain an unsupported old interpretation. The Agent is instructed to reconcile and retract earlier interpretations against formal receipts. Original intent, hypothesis and evaluation remain frozen under the existing agreement rules. Existing v1/v2 Tasks retain their input schemas and prompts; new Learning Agent Tasks use v3.

Reference validation cannot establish that natural-language reasoning is true. It prevents structurally mismatched object citations; the Agent must still judge evidence, interpret outcomes and distinguish a genuine conflict from different objects or different revisions. Practice-level prose is not a causal guarantee, and neither a completed article nor this integrity fix proves growth.

## Acceptance and deployment boundary

Focused tests use SQLite with the production migrations and real tool executors. Child authority tests call the real `startRuntimeRun` through captured parent execution capabilities; Workflow dispatch is replaced, not the start service. They cover multiple Agent definitions, deep descendants, replay, changed assignment identities, stale parents, scope isolation, cancellation and interrupted attachment.

Learning tests cover mixed outcomes for two objects, out-of-order reports, assignment revisions, repeat reports, missing attribution, cross-practice/object/version rejection, valid aggregate judgments, replacement of unsupported prior interpretations, original-input receipt replay, frozen evaluation and unknown Utility. Domain tests verify the writer/reviewer dispatch carries the actual selected job/artifact.

Apply migrations before deploying. No new bindings, model keys or vector indexes are needed. This implementation does not deploy, mutate production business records, reopen completed tasks, rewrite a live experience or enable daily scheduling. Automated acceptance is not a new real-model or production growth acceptance.

### Verified on 2026-10-24

The shared/public suite passed 1,219 tests (18 skipped); the private distribution passed 1,232 (24 skipped). Both builds passed. Synchronization tests and public source/history/build boundary checks passed, and guarded synchronization reported zero differences.

A real-model check was run with the synchronized core in the private distribution's isolated Miniflare D1/Worker/Workflow environment. Synthetic evidence described guide A passing at revision A1 and guide B moving from deferral at B1 to pass at B2. A deliberately incorrect old insight attributed contradictory decisions to guide A. In one Task/Run and three model calls, the Learning Agent retracted that interpretation, preserved object/version-specific findings, and kept publication and growth outcomes unknown. One initial submission used unknown attribution for known objects; structural validation returned scoped repair feedback and the same Agent loop corrected it. Only the successful submission produced a revision. Serialized requests confirmed the v3 findings schema.

This is one real-model case, not universal reasoning or growth proof. It does not establish public-provider compatibility beyond the automated shared-core checks. No production deployment, migration or data correction was performed.
