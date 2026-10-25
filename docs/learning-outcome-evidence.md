# Executable evaluations and attributable deliveries

## Problem and behavior

A frozen evaluation could describe a review without giving the coordinator an explicit result-submission action. Recording a delivery only queued experience organization, not outcome evaluation. A topic task could also return real object IDs while its learning evidence had no object subjects. These are protocol gaps: they recur for any initiative with a qualitative delivery objective or newly created topic objects.

New Leader tasks can read an evaluation and submit its actual evidence for evaluation. Topic submission saves the formal decision snapshot and exact object references in the same transaction as the decision. A completed delivery still does not imply a successful outcome or useful prior experience.

## Agent-directed flow

1. Learning Agent preparation freezes the objective, evaluation and an `evidence_plan`: `source`, `collector`, and `ready_when`. The plan names available capabilities. The agreement can remain null when a meaningful evaluation cannot be established.
2. Leader calls `read_business_evaluation`. The returned `evaluation_ref` binds the exact frozen agreement. Evidence remains paginated through existing experience reads.
3. Leader decides how to obtain evidence within the authorized scope and includes relevant criteria in ordinary specialist assignments. Specialists do not receive learning tools. If the frozen agreement permits Learning Agent rubric assessment, it can assess the author's formal artifact; if it requires an external review, that review must exist.
4. The topic domain atomically saves its formal decision and a learning delivery receipt. Receipt subjects name the generated group and item IDs; their version is the immutable submission operation, not a mutable approval status. The snapshot includes the actual submitted content.
5. Leader can cite exact receipts in `record_business_practice`. It submits observed results with `submit_business_outcome`, citing original receipts, available values, completeness and limitations. This action queues feedback; it does not accept a reward or utility score. A correction is a new outcome receipt for the same practice.
6. Learning Agent reads the current outcome and its original evidence. It decides whether the frozen source, reviewer and completeness requirements are met. `outcome_supported=false` keeps the reward unknown, even if the Leader declared completeness. Numeric arithmetic follows the frozen calculation; qualitative judgment follows the rubric.
7. Existing compatibility and adoption checks govern utility updates. Corrections replace the practice's existing contribution and recompute utility in stable order. Unknown evidence contributes no effective sample. No adoption means no utility contribution.

The existing automatic GSC observation path retains ownership of its source and window. Manual outcome submission cannot replace a GSC measurement. Planning quality and measured growth remain different objectives; one does not establish the other.

## Ownership and invariants

| Layer | Responsibility | Why |
| --- | --- | --- |
| Leader definition and tools | Arrange evidence collection, decide when to report, describe gaps | Business coordination remains model-directed. |
| Learning Agent definition and tools | Select feasible criteria before action; assess support, compatibility and meaning afterward | Evidence sufficiency and quality are domain judgments, not keyword rules or fixed quality thresholds. |
| Topic domain persistence | Capture generated IDs and immutable submission content atomically | Only the domain write knows the actual created objects; the model must not regenerate identities. |
| Learning persistence | Scope, observed agreement, evidence membership, replay identity and feedback replacement | Prevent cross-practice attribution, rewritten targets, duplicate effects and duplicate samples. |
| Existing shared Runtime | Execution authority, durable operations, retries and cancellation | Existing fences remain in force; this change introduces no shared Runtime routing or business policy. |

Deterministic validation rejects foreign evidence, invented measurement slots/units, stale agreement references and outcome-on-outcome citations. It does not certify that a cited receipt semantically supports a claim. That remains a Learning Agent decision. Coordination may have practice-level attribution; unavailable object attribution remains unknown.

## Versioning and scope

- Leader definition 25: two new tools and version 2 of `record_business_practice` with `evidence_refs`.
- Learning definition 6: executable evidence plans and explicit source-support judgment. Prior 1/3/4/5 schemas remain available to pinned tasks.
- Topic definition 30: atomic delivery receipts. Earlier topic tasks keep their historical behavior.
- Existing agreements are not rewritten. Existing tasks are not silently upgraded or backfilled with invented pre-action plans.
- No schema migration, external service, vector database change, new UI or manual scoring interface is required. Other deliverable types retain their existing evidence paths; this change does not claim every domain now emits the new topic snapshot format.

## Verification and limits

The contract tests use synthetic fixtures, real migrated SQLite schemas and real domain/tool code. The child integration activates an execution-scoped parent and a separate child through the real start service; Workflow transport is stubbed. Model judgments are supplied explicitly by the tests, so these checks do not establish model decision quality.

Covered paths include immutable topic snapshots, exact object/version findings, transactional rollback after an injected receipt failure, replay, scoped child attribution, coordinator ownership, frozen references, invalid measurement slots, automatic GSC ownership, evidence-backed outcome submission, unknown required review, correction without extra samples, and incompatible/unused experience behavior from the existing learning suite. Learning reads expose the current outcome with its original receipts independently of the first evidence page.

Post-implementation review followed the user path from preparation through delivery and feedback, scanned persistence/tool/definition callers, and checked decision ownership. The review changed an initially separate delivery/evidence write into a single domain transaction. No shared execution algorithm was modified.

At initial implementation acceptance, this change had not been deployed or tested with a live model/provider. The planned production acceptance was to use a newly created task under the new contracts, observe the actual criteria and evidence collection choices, and inspect the resulting saved assessment and attribution. A rubric score verifies only its declared artifact objective. Real growth and long-window results remain unproven until their actual observations arrive.

Local verification on 2026-10-25: upstream `npm test` passed 1,291 tests (18 skipped); downstream passed 1,304 (24 skipped). Both builds passed, including configured-secret artifact scans; Vite reported its existing large-chunk warning. All three synchronizer tests passed. The guarded sync reported no downstream conflicts. No deployment, remote migration, business task creation, publication or remote data mutation was performed for this change.


## Production acceptance update

A downstream deployment completed one real planning task through its ordinary authenticated Leader UI with a configured live model. Customer identifiers, private provider configuration, source receipts and screenshots are intentionally excluded from this public repository.

- The Leader read and adopted a historical lesson, saved an evaluation before delegation, obtained a new topic and brief, arranged review, submitted formal outcome evidence and finished. All eight learning requests completed; the final practice retained its evaluated state after the last organization request.
- The saved topic evidence contained the exact group/item identities, immutable submission version and delivered content. The outcome preserved the same source snapshot and the original evaluation agreement.
- The Learning Agent accepted a rubric reward of 1. The review was mixed: six criteria were assessed externally, while two were verified by the Leader, who was not the topic author. That met this agreement's reviewer clause, but is not a single fully independent review of all criteria.
- The adopted historical lesson received exactly one compatible feedback contribution and its first utility estimate of 1. The new practice's own utility remained unknown with zero feedback. Multiple review tasks did not create extra samples.
- The external research capability was a poor fit for internal artifact review: attempts encountered inaccessible or truncated material and a URL-citation requirement. The Leader repaired the approach in the existing loop and retained those limitations. Runtime recovered connection interruptions. This is an end-to-end functionality case, not a first-attempt reliability rate.
- This was a planning-only task. It created no article or publication and no search observation window. It establishes neither traffic/conversion uplift nor a causal benefit from the adopted lesson. It also does not establish acceptance for every model/provider supported by the public distribution.

The open-source update contains the shared implementation, synthetic contract tests and deployment guidance. The public default model was not rerun for paid acceptance during this publication; downstream live acceptance and public automated validation are distinct evidence. Autonomous finding classification remains subject to the limitations in [the judgment acceptance report](learning-judgment-acceptance.md).

Publication validation: the public unit suite passed 1,291 tests (18 skipped), and the private suite passed 1,304 (24 skipped). Both builds and their configured-secret artifact checks passed. All three synchronization tests passed, and the shared-core check reported zero differences. Candidate source, reachable history and generated artifacts passed the public export boundary checks; credential scanning covered candidate files and reachable history. No public deployment or remote migration is part of this publication.
