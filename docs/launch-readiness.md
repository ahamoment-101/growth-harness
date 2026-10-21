# First-run and launch presentation verification

Verified locally on 2026-10-21. This records local checks, not a production deployment or paid-model acceptance.

## Model configuration

Model connection resolution owns the typed `ModelConfigurationError`. The shared Runtime classifies that error as a configuration pause, preserving Task, Run, conversation and saved work. A missing credential cannot be repaired by changing execution hosts; this is an objective connection requirement rather than an Agent business judgment. Transient provider and platform failures keep their existing recovery policies.

The Leader HTTP boundary checks its selected connection before accepting a message. The browser retains the error code and displays the actionable message while keeping the draft. Existing conversations show their paused reason and Resume action. Recovering executions show their reason and next attempt instead of a thinking indicator.

These mechanisms are shared across Agents. Tests exercise missing credentials for both the Growth Leader and Keyword Researcher, custom credential names, durable error transport, cancellation safeguards, state preservation and resumption using the same Task and Run. No domain prompt, strategy rule, approval boundary, audit allowance or legitimate business outcome was changed. Future model choices continue to come from model definitions and connection configuration.

## Presentation and security

The console, browser title and contributor attribution use GrowthHarness. Fresh public deployments use `growth-harness` resource defaults. Existing downstream Worker, database, bucket and domain identities remain deployment configuration; renaming them is a separate migration. The historical `blog-agent-site` HTML metadata key remains a compatibility identifier rather than visible product copy.

The README leads with the content-team workflow and an actual local classroom screenshot. The screenshot uses sample data and is labeled accordingly. Architecture and roadmap details follow setup and usage. New and modified copy is in English.

GitHub private vulnerability reporting for the public repository was enabled and read back as `enabled: true`. SECURITY.md retains a direct email fallback. No vulnerability report or email was submitted.

## Checks and evidence boundaries

- Public unit suite: 1,160 passed, 18 opt-in tests skipped.
- Downstream unit suite: 1,173 passed, 24 opt-in tests skipped.
- Both TypeScript/Vite builds passed, including configured-secret checks on distributable output.
- Synchronization tests and shared-core drift checks passed.
- The real local Worker/D1/Workflow missing-key verifier rejected a new message with HTTP 503 and `model_configuration_required`, then paused a previously accepted task. Reconciliation at 1 and 30 days created no additional execution: one execution, zero model attempts, zero outbound calls.
- The configured synthetic-model verifier completed delegation and child report delivery in the original conversation in both checkouts. This verifies orchestration, not provider quality or paid endpoint compatibility.
- Browser checks confirmed visible missing-key instructions, preserved draft text, no thinking indicator for paused configuration, English copy and the GrowthHarness browser title. The classroom screenshot comes from the rendered console.

The full test run initially exposed existing Node 22 fixture incompatibilities. An unchanged source archive reproduced the failures. Test-only D1 adapters now bind numbered SQLite parameters using Node's named-parameter interface and avoid the unavailable `StatementSync.columns()` method. Production SQL and business behavior were not changed for that repair.

No real provider request, publication, production database migration or Worker deployment was performed.

## First-message and home-state follow-up (2026-10-21)

- The authenticated, site-scoped Leader configuration endpoint resolves the selected model through the existing registry. It returns configuration state and a missing variable name, never credentials, headers, or provider responses. Invalid configuration receives a generic setup instruction. This is a local configuration check, not a provider connectivity or billing check.
- The classroom checks configuration on entry, site changes, window focus, and explicit retry. Missing configuration is visible before a message is sent. Team headings reflect configuration, available live status, active work, pending input, or idle state; unavailable status is not treated as zero work.
- New user conversations and their first message are accepted together in a D1 batch. The transaction either commits both records or neither. Scope, actor, and original payload checks protect identity on replay; a conflicting message ID rolls back the conversation insert. Scheduled/delegated conversation creation and existing task recovery retain their existing contracts.
- Ownership: model selection remains in the shared model registry; atomic initial message acceptance is local to the Leader interaction contract; state presentation belongs to the console. Deterministic checks enforce configuration availability, tenant scope, immutable request identity, and transactional persistence. Agent strategy, tools, prompts, continuation, and legitimate business outcomes are unchanged and remain model-directed.
- Both AGENTS.md files now use GrowthHarness in the commit example. Existing deployment and authentication compatibility identifiers are retained. Classroom labels, sample data, and the README screenshot were intentionally left unchanged for a later video task.

Validation: public unit suite 1169 passed / 18 skipped; private suite 1182 passed / 24 skipped. Both TypeScript/Vite builds and synchronization suites passed. The actual local Worker/D1/Workflow verifier checks early configuration feedback, zero conversations on rejected first input, atomic replay and rollback, and the existing pause/recovery contract with zero model attempts or outbound calls. The configured synthetic-model fixture uses the new first-message route twice and still completes child delivery in the original conversation. This does not verify a paid model or a production deployment.

Browser acceptance against both built bundles verified the home warning before input, preserved draft text after rejection, no new empty conversation, and no thinking indicator. The configured public fixture showed the idle heading after its work completed; a new browser submission cleared the draft, created one conversation, and received the synthetic team result in that conversation. Screenshot capture was unavailable while the browser window was minimized; no replacement README image was produced.
