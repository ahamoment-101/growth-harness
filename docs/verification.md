# Verification scope and methods

Verification should identify the exact source candidate, configuration and evidence class. A build proves packaging; an HTTP 200 proves a response; neither alone proves a complete Agent task or publication.

## Automated and isolated checks

```sh
npm test
npm run test:sync
npm run build
node --test scripts/sanitize-build.test.mjs
node scripts/verify-installation-local.mjs
npm run verify:self-hosting:local
```

The default unit suite does not require paid service credentials. Optional live tests remain opt-in. Installation and Workflow fixtures use isolated local resources and explicitly synthetic model replies. The real Worker, D1 and Workflow engine may execute while their external model responses are synthetic; record that distinction.

For upstream/downstream maintenance, run tests, synchronization checks and build independently in both distributions. Confirm private extension preservation and no shared-core drift. See [repository maintenance](repository-maintenance.md).

## Live model and publication acceptance

Use explicitly authorized service credentials in ignored local files or deployment Secrets, a dedicated test site and separate test storage. Do not run a billable acceptance merely because a key is present.

1. Verify the actual selected endpoint, model, serialized request and decoded tool result. A compatible gateway verifies that route, not the native official service or another preset.
2. Start the normal content path with attributable business facts and an approved test topic. Observe the editor, author, fresh self-check, independent review and any revision through their actual registered tools.
3. Submit the existing owner publication approval. Read back accepted candidate identity, job versions, review/approval receipts and the Publish Workflow result.
4. Open the real served article and list. Inspect populated browser DOM, heading, language and failed resources. Read sitemap, metadata and conditional responses; a listening port or health endpoint is insufficient.
5. Verify external export and search destinations only when actually configured. A skipped Webhook, GSC or IndexNow step is not successful external delivery.
6. Reconcile pending/unknown effects and retain accounting, cancel only owned test work, revoke owned test sessions and preserve evidence privately.

Record assisted recovery, operator configuration changes, unsuccessful requests and unverified scopes. Missing usage is unknown billing rather than zero cost. Do not infer topic discovery, real demand, rankings, cross-task learning or automatic failover from one successful article.

## Publication boundary

Before releasing source, review the whole candidate manifest and run source/history credential checks, public-distribution checks and build-output scanning. Include internal documents, business material, resource identifiers and demo/development entry points in that review, not just key patterns. A fresh isolated export/clone must reproduce the candidate and checks.

Public reports can state methods, aggregate results and limits without account IDs, internal site/task references, customer content or raw conversations. Keep operational receipts, recovery bundles and private adapter evidence in a private distribution or ignored local storage.
