# Content coverage and evidence contract

The content domain binds editor plans, author evidence and independent review to exact saved artifacts. Shared Runtime execution is reused rather than duplicated.

## Ownership and legitimate decisions

The editor saves a page coverage plan and explicitly selects its immutable reference when dispatching each job. Reader tasks, importance, scope, distinct value and research sufficiency remain Agent judgments. Requirements may be answered, partially answered, moved to a related page, judged inapplicable or deferred for evidence. An empty justified plan or evidence ledger is permitted. There are no coverage scores, confidence thresholds, keyword quotas or automatic quality gates.

The author reads public source snapshots and saves an immutable claim ledger, including exact source quotes, limits, support assessments and candidate locations. The reviewer independently evaluates the actual candidate, including unregistered claims, and returns coverage and evidence findings. Pass/revise/defer and publication approval retain their existing semantics. Every product mention must use its complete official name from business facts.

Deterministic checks protect scoped references, exact stored quotations, actual candidate locations, complete accounting for the assigned requirements/registered claims, and locked candidate identity. They do not decide whether evidence is persuasive or whether the writing is good. A supported disposition or a finding can be negative; accounting does not mean mandatory coverage or endorsement.

## Persistence and tools

- `save_coverage_plan` saves immutable `content_coverage` parameter slots. The host creates entry IDs, revision numbers and references. Revisions select their predecessor; existing IDs must exist in that predecessor, omitted entries are removed only in the new snapshot. `inspect_content_group` exposes saved plan references for recovery. Dispatch binds the selected version in the existing durable operation binding before starting children.
- `read_article_source` acquires an extracted Markdown snapshot through the existing accounted Firecrawl reader, or reads an exact stored source by ID and character offset. It preserves capture identity and explicit pagination. An extracted snapshot is not a guarantee that the entire publisher document was available. Indexed range reads reuse the existing source index and immutable R2 object.
- `save_claim_evidence` stores `content_evidence` parameter slots, checking references and exact source quotes before accepting a ledger. Source bytes are checked against the saved receipt during quote validation. A dependency failure preserves existing slots and writing.
- Candidate submission resolves the author's ledger reference and binds its plan, coverage responses and evidence as `seo_contract.editorial`. The v2 contract replaces the old minimal `factual_claims` representation rather than duplicating it. The complete candidate, not the latest editable plan, supplies review context.
- Review findings are stored with the exact artifact, retain full content through existing Runtime JSON chunks, and are decoded by content inspection/detail APIs. Authors receive full editorial feedback on revision. No new UI is introduced.

A reviewer can read only its own sources or the author source IDs explicitly included in the assigned candidate. The author can read its own sources or reviewer source IDs explicitly returned in its persisted revision assignment. These are deliverable receipts, never access to another Agent's internal conversation. Workspace/site and source-owner Run checks remain mandatory. Database writes use the caller's existing execution fence.

## Compatibility

New definitions: parent 18, author 15, reviewer 8. Parent dispatch uses the new plan schema only for definition 18 onward. Persisted author/review assignments select the v1 or v2 tool contract; historical assignments keep their prior schemas, descriptions and tool versions. New assignments explicitly carry editorial contract version 2. Tools and persistence stay domain-local; shared Runtime orchestration is unchanged.

## Verification requirements

Tests must cover immutable revision/replay, source ownership, cancellation, quote validation, pagination, dependency failure, large results, selected-plan binding before dispatch, exact candidate persistence, reviewer feedback and stale review rejection. Invoke tools through their actual registered mapper as well as standalone service tests. Preserve historical persisted contracts during replay.

Real-model evaluation must inspect the actual received instructions, serialized tool schema, saved candidate and independent review. A passing source-reference check or synthetic model response does not establish content quality, account compatibility or production publication. See [verification](verification.md).
