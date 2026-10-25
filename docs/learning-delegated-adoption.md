# Declared experience use in Leader delegation

## Problem and decision

Historical guidance could inform a Leader assignment while the separate adoption action was never called. Search, preparation and even prose saying a lesson was used did not produce an adoption receipt. Subsequent compatible results therefore could not update that history's utility. The tools were available; the domain action contract separated a decision from recording that decision.

Leader definition 24 and `delegate_task` version 7 make declared experience use part of the assignment. This targets the adoption gap, not the separate problem of unprompted adjustment/conclusion classification described in [the earlier acceptance report](learning-judgment-acceptance.md).

## Model-facing contract

`delegate_task.experience_uses` is required and may be empty. Each selected entry contains:

- `experience_ref`: the Leader's own full-read reference from `read_business_experience`, preserving the observed version.
- `reason`: concrete guidance applied in this assignment and the decision it changes.
- `compatibility`: applicability, differences and uncertainty. This is not certification of comparable outcomes.

The tool passes the selected guidance and its uncertainty to the specialist as ordinary business context and returns `registered_experience_uses` alongside the task and practice references. Specialists acquire no learning tools or obligations. Retrieval, recommendations and another Agent's read cannot register adoption. `[]` means no experience is declared for this assignment; it does not erase earlier decisions in the practice. The existing standalone adoption tool remains available for decisions outside delegation.

A receipt proves the Leader declared a decision to use guidance. It does not prove a specialist implemented it, that the task completed, that a measurement improved, or that the experience caused the outcome. A useful failure lesson or unknown-utility record remains a legitimate choice. Rejection, more evidence and no adoption remain legitimate choices.

## Persistence and recovery

The domain stores a separate, namespaced decision receipt keyed by the existing task operation. It binds the entire normalized delegate input, independently of the Runtime's child-dispatch binding. For a learning practice, one D1 transaction commits the unchanged learning data as a revision, the selected adoption rows, the delegation/practice link and the receipt. Existing SQL adoption guards enforce scoped identity and the version actually observed at commit. All selected references are checked before writing; a raced version rolls back the whole set.

Even an assignment explicitly outside a learning practice saves an empty decision receipt. A replay cannot add adoption before child dispatch discovers that the original input changed. No experience is created for that empty receipt.

Child dispatch then uses the existing Runtime service, independent child execution identity and original parent fence. If dispatch is interrupted, the learning decision remains durable, and replay reconciles the same child. A lost commit response is checked against the saved receipt before retrying. Replay does not reinterpret the original decision against a newer history version. Adoption committed before a dispatch failure remains a declared decision, with delivery still unproven.

No database migration, new service, retrieval-ranking change or shared Runtime algorithm is introduced. Existing tasks and manifests remain pinned to their previous definition/tool versions. Production records are not retroactively credited.

## Utility

Existing feedback processing remains authoritative. Only explicitly adopted history judged compatible by the Learning Agent can receive a feedback contribution. The frozen evaluation determines the result score. One practice contributes at most one effective result per historical experience, including when several assignments use it. Corrections replace that contribution and recompute utility; a practice's own result does not become its own utility. Missing or incompatible results remain unknown.

## Ownership and review

| Layer | Responsibility |
| --- | --- |
| Leader definition and prompt | Judge relevance, choose whether to apply guidance, explain its use and uncertainty. |
| Learning domain tool | Represent the decision in the assignment, validate references, and atomically preserve adoption and attribution. |
| Existing shared Runtime | Parent/child authority, operation identity, execution fences, durable dispatch and recovery. |
| Existing Learning Agent and calculation | Judge outcome comparability; calculate frozen evaluations and versioned utility from durable feedback. |

Deterministic checks prevent cross-scope writes, stale observations, changed replay inputs and partial adoption sets. They do not impose business quality thresholds or infer adoption from wording. Prompt and tool-definition versions can evolve without rewriting the shared loop.

Pre-implementation review followed full reads → Leader decision → learning receipt → actual child start service → formal reports → compatible feedback. It ruled out treating recall as adoption or making specialists register learning. Post-implementation review covered no history, explicit non-adoption, multiple selected records, concurrent history edits, lost commit responses, interrupted dispatch, repeated assignments, delayed outcomes after parent completion and pinned legacy schemas. It caught and fixed the empty-decision replay gap and avoided copying display metadata into learning data during receipt commits.

## Acceptance on 2026-10-25

- Automated integration uses an execution-scoped parent and the real child start service with topic, research and production descendants. Only the Workflow dispatch transport is stubbed. It verifies atomic rollback, foreign-task/site references, self-use, duplicate choices, stale versions, cancellation/epoch fences, replay and unknown commit reconciliation.
- The full feedback test declares one lesson in two assignments, captures two formal child reports, then finishes the business parent. Synthetic complete results subsequently initialize history utility to `1`; corrected results recompute it to `0.2`, still with one effective feedback. Incompatible results do not score it, unselected history stays unknown, the current practice's utility stays unknown, and the frozen agreement is preserved.
- A real configured model ran the current Leader loop against an isolated local SQLite D1 fixture and the production tools. It inspected two synthetic candidate records, selected the workplace-email example lesson, declined the unrelated retail-promotion lesson, and passed explicit applicability and uncertainty through `delegate_task`. One adoption and one strategy-child assignment were saved, without a separate adoption call. Eight serialized model requests were inspected; the new required tool field reached the provider. Private local artifacts retain only formal actions, receipts and redacted request metadata, not private reasoning or credentials.
- That model check does not execute the specialist: Workflow dispatch is stubbed. It does not validate live Cloudflare scheduling, production data, real Google measurements or growth uplift, and one case is not an adoption reliability rate. Utility arithmetic uses separately labelled synthetic feedback in the integration test.
- Public unit suite: 1,284 passed, 18 skipped. Private unit suite: 1,297 passed, 24 skipped. Both builds and configured-secret output scans passed. Upstream synchronization tests: 3 passed.

At the time of the local acceptance above, the code was synchronized downstream but had not been deployed or pushed. The subsequent [production acceptance update](learning-outcome-evidence.md#production-acceptance-update) records the completed shared flow. The earlier classification/UI work remains separate; no claim of reliable autonomous semantic reclassification follows from this adoption fix.
