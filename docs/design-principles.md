# Design principles

GrowthHarness gives Agents business judgment and gives the Runtime responsibility for reliable execution. These principles guide changes; they are not claims about growth results or universal model reliability.

## Let the Agent make business decisions

Research depth, evidence sufficiency, topic priority, writing quality, whether to revise, and whether to wait are model judgments. Supply current facts, uncertainty, prior effects and small semantic tools. Make partial delivery, deferral, evidence requests and no action legitimate outcomes. A surprising choice alone does not justify a hardcoded business rule.

Before changing behavior, inspect the actual model request, response and tool receipts. Distinguish missing context or decision vocabulary from a provider/schema problem. Repair the owning layer: prompts cannot fix a tool-call channel that cannot represent the schema.

## Make execution dependable

Runtime enforces permissions, tenant scope, identity, observed versions, atomic persistence, idempotency, cancellation and declared platform limits. A useful question for each restriction is: which objective invariant would fail if this restriction disappeared? If the answer is only a less useful business judgment, improve the Agent's context, tools or loop instead.

One Task owns one persistent Run. Recovery changes the execution host, not the business identity or conversation. Autonomous audits let the same Agent continue or finish while retaining cumulative usage. Unknown external effects must be reconciled before replay. Preserve valid work when another part fails.

## Give references to the model, keep identity in the host

The host binds workspace, site, task, run and operation identities. The Agent selects scoped references returned by reads and proposes business changes. Writes use the version actually observed; silently upgrading it to the latest revision would erase conflict detection. Create and patch are distinct actions, and a missing patch target must not become a new object.

## Coordinate through deliverables

Parents provide briefs and receive saved results, evidence, limitations and failures. Children own isolated conversations and execution authority. Neither a dispatch receipt nor a model's claim of completion replaces a formal deliverable. Existing publication approvals and cancellation boundaries remain in force.

## Learn from business evidence

Learning concerns business choices and results, not tool-call choreography or private reasoning. Intent states the goal; Experience retains the hypothesis, evaluation agreement, actions and evidence; Utility estimates later-use value. Fix evaluation before action, distinguish a returned lesson from an adopted one, and retain failed lessons and unknowns. A high score is neither causal attribution nor a promise of growth.

## Verify the claim being made

Separate packaging, protocol tests, real-model decisions, real external delivery and measured business improvement. A synthetic fixture can verify replay without establishing writing quality. A publication can be real while its outcome remains unmeasured. State evidence limits rather than converting missing data to success or zero.

For execution details read [Continuous Runtime](continuous-agent-runtime.md); for the business paths read [Content workflow](content-workflow.md) and [Business learning](business-learning.md). Contributor requirements live in [AGENTS.md](../AGENTS.md).
