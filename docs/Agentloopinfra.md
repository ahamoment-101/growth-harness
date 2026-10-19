# Shared Agent Runtime architecture

The current execution requirements are the [continuous Runtime contract](continuous-agent-runtime.md), [pipeline boundaries](runtime-pipeline-refinement.md) and root [AGENTS.md](../AGENTS.md). This document is an implementation map, not a deployment receipt.

| Responsibility | Source area | Boundary |
| --- | --- | --- |
| Task, Run and Execution identity | `worker/agent-runtime/runtime-executions.ts`, `execution-context.ts` | One persistent Run; changing an execution host does not create another business Run |
| Conversation pipeline | `worker/agent-runtime/conversation-runtime.ts` | Observe, prepare, decide, execute and persist through one authorized pipeline |
| Provider transport | `worker/agent-runtime/conversation-channel.ts`, `worker/lib/model-request.ts` | Translate the configured protocol without choosing business strategy |
| Capacity and compaction | `worker/agent-runtime/request-capacity.ts`, `conversation-compaction.ts` | Full request capacity and durable versioned context maintenance |
| Audits | `worker/agent-runtime/execution-audit.ts` | Same-conversation continue or finish decisions, every 30 ordinary rounds |
| Recovery and cancellation | `worker/agent-runtime/task-recovery.ts`, `task-commands.ts` | Preserve work, fence stale executions and reconcile unknown effects |
| Domain definitions and tools | `worker/agent-runtime/definitions.ts`, domain modules | Mission, evidence, legal choices and business quality remain domain-owned |

A definition registers instructions, context and tools. A tool's authoritative schema supports both model-facing definitions and execution validation; provider transformations belong at the protocol boundary. Successful work and failed units are returned separately so an Agent can repair locally without losing valid effects.

Parents receive child deliverables, evidence, limits and failures. They do not inspect a child's internal conversation. Child execution uses its own persisted authority; parent lifecycle actions stay under the original parent's atomic execution fence.

Verification must cover distinct domains, real execution-scoped persistence, replay, cancellation, tool/result correlation, partial failures and serialized provider requests. See [verification](verification.md). A passing synthetic fixture does not prove account access, paid-model behavior or production readiness.
