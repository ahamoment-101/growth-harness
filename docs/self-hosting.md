# Self-Hosting, Upgrades, and Recovery

## Local

```bash
npm ci
npm run setup -- --local
npm run dev
```

Enter the setup page from the dev server address, fill in the email, a password of at least 12 characters, and the `AUTH_SETUP_TOKEN` from the local `.dev.vars`. Do not send the setup code to public logs, screenshots, or issues. After the admin is created, setup closes, and the used setup code can be removed. Registration and team invitations are disabled by default.

The installation script preserves existing Keys, model selections, admins, and sites, and does not automatically start paid jobs. For models and other services see [Configuration guide](configuration.md). Invalid login configuration blocks startup; a disabled optional service missing its Key does not block basic installation.

## Cloudflare

The system still depends on Workers, D1, R2, Durable Objects, and Workflows. The account must meet the actual resource requirements for the services, password computation, and ongoing Tasks; no guarantee is made that the free tier supports all business.

1. `npx wrangler login`, `npx wrangler whoami`, and verify your own account; with multiple accounts, explicitly set `account_id`.
2. Adjust the Worker, database, and R2 bucket names in `wrangler.jsonc`, keeping the binding names and class names. Set `CLOUDFLARE_WORKER_NAME` to the same Worker name for route diagnostics.
3. `npm run setup -- --cloudflare`; it first displays the account and requires typing `CREATE` before creating D1/R2; you may also create them manually and fill in your own database IDs. For existing resources, fill in the existing IDs directly; do not create duplicates.
4. Set the production public configuration in Wrangler vars: login methods, Google Client ID / allowed emails, model registry, optional DataForSEO login, GSC Client ID, account ID, and CNAME_TARGET. **Public settings of the same names in the local `.dev.vars` are not automatically deployed.**
5. Fill in the needed secrets locally, and `npm run secrets:upload` uploads them via stdin without printing values or generating plaintext temp files. After database migrations, `npm run config:check:deploy` checks the production configuration against the online Secret names, but does not verify vendor permissions; before deployment it also checks whether the admin's login methods would be locked out by the configuration.
6. For a fresh empty database, run `npm run db:migrate:remote` on first install. The migration helper selects the configured `DB` binding; use `-- --config <path> --env <environment>` when intentionally selecting another configuration/environment. For existing instances, handle the upgrade per the next section first.
7. `npm run deploy`, open your own public URL, create the admin, and log in. When using Google, register the corresponding authorization callback first.
8. Run a minimal real business chain, read back articles, review records, and Task results, and verify billing, cancellation, and recovery. A successful installation is not the same as model research being accepted.

## Upgrading a Release

Releases are tagged `vX.Y.Z` and described in [CHANGELOG](../CHANGELOG.md). To stay on a known version, check out its tag (for example `git checkout v0.1.0`) instead of tracking `main`.

1. Read the **Upgrade notes** of every release between your version and the target. Patch releases need no manual step; minor releases may add migrations or configuration.
2. Back up the deployed database: `npx wrangler d1 export <database-name> --remote --output backup.sql`. Keep the file private.
3. Complete any maintenance step the notes require, such as a precheck before a migration that drops columns.
4. Check out the target tag, run `npm ci`, apply migrations with `npm run db:migrate:remote`, then `npm run deploy`.
5. Open the console, confirm login and the classroom load, and read back a recent task.

## Existing Instances

Migrations 0073–0080 include schema and protocol changes. 0075/0076 drop the old market-partition fields and must be handled per [Language migration precheck and maintenance steps](#language-migration-precheck); you must not hot-switch old-protocol Tasks that are executing. Back up first and complete the maintenance steps, migrate in order, and then deploy the corresponding Worker and pages.

0081 adds password credentials, auth attempts, and the session-revocation trigger after password change, preserving the original users, Google subjects, workspaces, sites, and Agent data.

Migrating the original Google admin:

1. First explicitly configure `AUTH_LOGIN_METHODS=password,google`, keeping the original Google configuration.
2. Log in with the original Google account, enter `/account` via "Account & Login" in the menu / sidebar, and set a password for the original account.
3. After verifying password login, decide whether to turn Google off. You must not turn off the only bound login method first.

Adding Google for a password admin: after Google is fully configured and `password,google` is enabled, bind proactively at the logged-in `/account`; identical emails do not auto-merge. In the end, both methods access the same original account.

The generic configuration template has had the maintainer's resource IDs removed. Upgrading an existing deployment requires explicitly filling in your own resources; you must not publish the sample with the local placeholder database ID directly as if it were the original production configuration. The old local configuration can be kept in a Git-ignored file.

## Password Recovery

The deployer holds local or Cloudflare D1 write permission and can reset an existing administrator:

```bash
npm run auth:reset -- --local
# Explicitly verify the live target:
npx wrangler whoami
npm run auth:reset -- --remote
```

The command prompts for the administrator email and the new password via hidden input, and only updates an existing owner; it does not create users. Password update and old-session revocation are performed atomically by database triggers. Ensure `AUTH_LOGIN_METHODS` includes `password`. No SMTP configuration is needed.

Automation can pipe `{ "email": "...", "password": "..." }` via stdin; do not write passwords into arguments, the repository, or logs, and do not keep input files containing passwords.

## Verification

`npm run verify:self-hosting:local` uses an isolated Miniflare D1, a real Worker, the login API and Workflows, with models as synthetic responses and no production keys. It does not prove that a real Google account authorization, paid services, or a given production account is available. See [verification methods and limits](verification.md) for the isolated and live-provider paths.

## Read-only request reports

```sh
node scripts/report-agent-requests.mjs <run-id> --local
node scripts/report-agent-requests.mjs <run-id> --remote --config wrangler.jsonc
```

Select `--local` or `--remote` explicitly. The database defaults to the selected configuration/environment's `DB` binding. `--env <environment>` chooses a Wrangler environment and `--database <name>` selects a different database intentionally. Confirm the configuration/account before a remote read, and keep operational reports private.

## Optional business learning recall

Business experience is stored in your D1 database after migrations 0082–0084. The internal Learning Agent uses your existing model configuration. Semantic retrieval additionally needs Workers AI (`AI`) and a dedicated Vectorize index (`LEARNING_VECTOR_INDEX`). Follow [business learning installation](business-learning.md#installation-and-upgrades); never reuse production indexes for local acceptance. Without these bindings the Leader can browse saved history, but semantic recall is explicitly unavailable.

## Language migration precheck

For installations predating migrations `0075_language_only_library.sql` and `0076_language_only_topics_strategy.sql`, these migrations **drop market-partition columns** and rebuild constraints around workspace/site/locale. Existing IDs, locales, revisions, relationships and immutable receipts are preserved. There is no automatic mapping of `global` to English or compatibility for legacy market arguments.

1. Confirm the account, database and scoped release source; back up D1.
2. Run `scripts/language-only-preflight.sql` against the intended database. Same-locale name/operation conflicts cause rollback rather than silent merging; resolve genuine duplicates through an explicit business decision.
3. Finish affected old-protocol tasks and pending effects before cutover. Do not edit saved manifests, slots, operations or Task/Run identity to simulate an upgrade.
4. Stop new starts during the maintenance window, apply ordered migrations and deploy matching code. Database migration and Worker deployment are separate operations.
5. Check foreign keys, counts, configured locales and library reads before resuming new work. A local migration test does not establish that your deployed installation completed this cutover.
