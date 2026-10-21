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
