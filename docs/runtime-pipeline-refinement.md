# Runtime pipeline boundaries

The approved execution contract is [continuous-agent-runtime.md](continuous-agent-runtime.md). One Task owns one persistent Run; Executions and Workflow hosts advance successive portions of that same loop.

## Five responsibilities

1. Resume persisted work under captured execution authority.
2. Append attributable observations and prior effects.
3. Prepare the complete model view, including capacity and context maintenance.
4. Execute one model decision and its authorized tools through the same pipeline.
5. Persist receipts and route the checkpoint to continued work, recovery, waiting or completion.

Business definitions supply missions, optional preparation, semantic tools and completion vocabulary. Shared services enforce authorization, cancellation, capacity, persistence, operation identity and unknown-effect reconciliation regardless of which definition is registered.

## Conversations and capacity

Initialize stable instructions and tools once, then append messages. Keep durable receipts separate from model/compaction views. Tool `content` must not be duplicated through host-only `details`, and private reasoning must not become business memory. Preserve exact entity references, observed versions and effect receipts independently of model-written summaries.

Full serialized-request capacity determines compaction. Database page counts, `hasMore` and fixed fullness percentages are not model-capacity evidence. Estimates should use the selected endpoint/model's declared capabilities and actual reported usage when available. The adapter selects supported output allowance within shared input/output capacity.

Compaction is versioned durable work. Preserve authorized original material, successful shards and operation identities. Truncation, input overflow and transient failures have different recovery requirements. Incomplete summaries never replace a valid context; recovery must change the failed condition or wait for an external one.

## Decisions, errors and control

Every model decision, including audit and repair, uses the same pipeline. The autonomous 30-round audit retains cumulative accounting and the original Run. It grants no business permission and does not require a new human budget approval.

Structured feedback identifies the error category, invalid references, affected fields, successful units and known effects. Runtime does not guess missing business values or choose a research strategy. Unknown effects are reconciled before replay. Infrastructure recovery is displayed as recovery rather than fabricated business input requests.

A registered error policy may initially be empty, but it never disables execution fences, authorization, cancellation or effect integrity. Existing domain approval and published-data protection remain mandatory.

## Evaluation

Test with distinct domain definitions and semantic tools. Cover pagination beyond one storage page, oversized results, request serialization, tool/result correlation, interruption between summary shards, same-Run recovery, stale execution, cancellation, partial effects and audit replay. Inspect actual provider metrics separately from object identity or SDK arguments. See [verification](verification.md).
