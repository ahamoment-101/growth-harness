# Verification scope and methods

Verification should identify the exact source candidate, configuration and evidence class. A build proves packaging; an HTTP 200 proves a response; neither alone proves a complete Agent task or publication.

## Local checks

```sh
npm test
node --test scripts/d1-target.test.mjs scripts/sanitize-build.test.mjs scripts/check-public-boundary.test.mjs
npm run build
node scripts/verify-installation-local.mjs
npm run verify:self-hosting:local
npm run verify:model-configuration:local
```

Run these from the repository root on macOS, Linux or Windows. They need no paid credentials: installation and Workflow fixtures use isolated resources and synthetic model replies while exercising the real Worker, D1 and Workflow engine.

The model-configuration verifier also exercises the actual missing-key path without a model substitute: new messages return actionable configuration errors, previously accepted tasks pause, and later reconciliation makes no model request or replacement execution. Set `LEADER_UI=1` to keep its isolated browser fixture running on port 5298; its printed login URL never accesses production data.

CI also checks source/build boundaries, Git history credentials and dependency advisories. Builds remove Cloudflare preview environment files and reject configured local credential values in distributable output. The current-source boundary check keeps private adapters, environment/data files, internal material, `design/` and `.zcode/` out of the public tree. Downstream synchronization and public source exports have separate [maintainer checks](repository-maintenance.md).

## Live model and publication acceptance

Use explicitly authorized service credentials in ignored local files or deployment Secrets, a dedicated test site and separate test storage. Do not run a billable acceptance merely because a key is present.

For a minimal transport probe using the selected registry profile, opt in explicitly. It sends synthetic input without business writes:

```sh
# macOS / Linux
MODEL_TRANSPORT_LIVE_VERIFY=1 npx vitest run worker/lib/model-channel.live.test.ts
```

```powershell
# Windows PowerShell
$env:MODEL_TRANSPORT_LIVE_VERIFY = '1'
try { npx vitest run worker/lib/model-channel.live.test.ts }
finally { Remove-Item Env:MODEL_TRANSPORT_LIVE_VERIFY }
```

This verifies only the chosen endpoint/model. To verify a complete publication:

1. Verify the actual selected endpoint, model, serialized request and decoded tool result. A compatible gateway verifies that route, not the native official service or another preset.
2. Start the normal content path with attributable business facts and an approved test topic. Observe the editor, author, fresh self-check, independent review and any revision through their actual registered tools.
3. Submit the existing owner publication approval. Read back accepted candidate identity, job versions, review/approval receipts and the Publish Workflow result.
4. Open the real served article and list. Inspect populated browser DOM, heading, language and failed resources. Read sitemap, metadata and conditional responses; a listening port or health endpoint is insufficient.
5. Verify external export and search destinations only when actually configured. A skipped Webhook, GSC or IndexNow step is not successful external delivery.
6. Reconcile pending/unknown effects and retain accounting, cancel only owned test work, revoke owned test sessions and preserve evidence privately.

Record assisted recovery, operator configuration changes, unsuccessful requests and unverified scopes. Missing usage is unknown billing rather than zero cost. Do not infer topic discovery, real demand, rankings, cross-task learning or automatic failover from one successful article.

Keep operational receipts and raw conversations private. Public reports can state methods, aggregate results and limits without credentials, account identifiers or customer material.

## First-run configuration

Verify a missing selected model key produces an actionable setup error before a new Leader conversation is accepted; the browser must preserve the draft. Previously accepted work should pause without repeated model calls and retain its original Task/Run for resumption after configuration is restored. Local configuration validation checks presence and structure, not vendor connectivity, permissions or billing.

Initial conversation and first input are accepted atomically. Replaying identical identity/input must not create an empty duplicate conversation; a conflicting payload must leave neither partial insert. Test UI configuration, active work, pending input and unavailable-status states separately. Unavailable status is not zero work, and infrastructure recovery is not a human business question.

## Business learning

Start with [Business learning](business-learning.md#console-and-verification) for the offline, semantic-search and manual browser commands and their configuration. Use separate test state and indexes; never seed synthetic experiences into production.

| Evidence class | What to check | What it cannot establish |
| --- | --- | --- |
| Unit and transactional integration | Isolation, observed versions, exact object attribution, atomic delivery/adoption, replay, correction recomputation, preparation recovery and pinned historical contracts | Real-model judgment or provider availability |
| Offline local Worker/D1 | Installation/upgrade, authorized list/detail, unknown Utility, missing-binding behavior and receipt replay with external services disabled | Semantic relevance or external results |
| Real Workers AI / Vectorize | Cross-language intent matches, older records beyond a directory page, failed lessons, unknown-Utility candidates, distractors, foreign-scope exclusion, stale-generation removal and Utility hydration without re-embedding | Universal recall accuracy; a REST bridge alone does not certify deployed native bindings |
| Real Leader / Learning Agent | Full read, relevance decision, explicit adoption/rejection, frozen evaluation, attributable delivery, evidence-based assessment and recall in later work | Causal value or repeatable growth from a small case set |
| Browser | Intent / Experience / Utility in order on desktop and narrow screens, evidence expansion, real task links, refresh readback and unknown states | Backend/model effects not supported by saved receipts |
| External outcomes | Actual source, page, observation dates, collection time, coverage and comparison | Growth from self-evaluation or publication alone |

Exercise deep descendants and successive assignments, multiple objects with different results, out-of-order evidence, lost commit acknowledgments, cancellation, and delayed outcomes after a parent finishes. Multiple Agents using the same lesson in one practice must produce at most one effective feedback contribution. A correction replaces that contribution without increasing the count. Unused or incompatible history receives no Utility update.

Use a genuinely execution-scoped parent and the real child start service for authority tests. State explicitly when Workflow transport or model replies are synthetic. Inspect actual serialized model tools and messages when diagnosing model choices; stored SDK arguments alone do not verify the provider request.

### Known limits

Earlier bounded checks found expected top-ranked matches for eight predefined queries over synthetic experiences, including multilingual queries. This is evidence for those fixtures, not a retrieval accuracy benchmark over arbitrary businesses or a guarantee for every model/provider.

Autonomous finding classification remains a limitation. In three isolated real-model replays of one case, implemented changes remained only in conclusions despite the revised instructions and schema reaching the model. A fourth replay with explicit semantic feedback saved separate adjustment findings. Persistence and projection worked, but unprompted classification reliability was not established. The empty-state copy is deliberately “No adjustments recorded separately yet.”

One downstream real-model planning task completed read/adopt, preparation, topic delivery, outcome assessment and compatible feedback. It used mixed review: some criteria were externally assessed and others checked by a coordinator independent of the author. The prior lesson received one feedback sample; the new practice's own Utility stayed unknown. That case required recovery from incomplete/inaccessible review material and did not publish an article or measure traffic. It proves neither first-attempt reliability nor acceptance of every public default model.

Historical per-run counts and release receipts remain in Git history. They are not current acceptance certificates. For each release, record its own source/configuration, actual tests, recovery, omissions and evidence boundaries. Keep raw operational data and customer material outside the public tree.
