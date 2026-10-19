# Maintaining upstream and downstream distributions

Maintain one public core and a downstream distribution with its own extensions. Shared fixes land in the public checkout first, then move downstream. A downstream bug fix that belongs to the core is extracted and verified upstream before synchronization. Do not copy a downstream checkout back over the public repository.

## Synchronization

From the public checkout:

```sh
npm run core:sync -- --target /path/to/downstream --check
npm run core:sync -- --target /path/to/downstream --apply --initialize
```

`--initialize` is only for the first synchronization, after reviewing the reported change list. Later synchronization uses `--apply`; `.public-core-sync.json` in the downstream records file hashes and the upstream commit. The tool refuses to overwrite core files changed downstream since its last application. Reconcile those edits first. The commit field identifies the source base; file hashes also cover pending working-tree changes, so it is not a claim that those changes were committed or released.

The synchronized core is `worker/`, `shared/`, `packs/`, `src/`, `index.html`, shared SQL migrations and the explicitly listed common configuration/build scripts. The public and downstream copies of `shared/config/model-extensions.ts` and `worker/lib/model-extensions.ts` are intentionally different. Historical distribution-specific model defaults in `migrations/0001_init.sql` and `migrations/0028_fix_agent_model_configuration.sql` remain owned by each checkout and are excluded from synchronization. Downstream-only files are retained. Deployment bindings, environment files, account identity, repository metadata, private documentation and extension tests are not copied. Dependency requirements are merged while the downstream package identity remains its own; install dependencies to update its lockfile.

This tool synchronizes local source files. It does not commit, push, deploy, change repository visibility, rewrite history or edit remote databases. Inspect its scope before adding directories or files. Run `--check` to confirm there is no current core drift after applying an update.

## Required verification

Run `npm test`, `npm run test:sync` and `npm run build` in **both** checkouts after synchronization. Shared tests check configuration, protocol serialization and durable execution. Downstream extension tests separately check its legacy migration and special request dialects. The isolated synchronization test checks preservation of private files, conflict refusal, shared deletion and direction enforcement.

Use an opt-in real model probe, then writing, independent review and publication acceptance in each checkout with separate test sites and local databases. Review the generated candidate and actual article page. Record exact model/protocol identities, failures and successful effects; a mock response or an HTTP health check cannot establish real model or publication acceptance. A gateway test does not establish native official service acceptance.

A current-source cleanup does not remove earlier commits from Git history. Any historical cleanup is a separate, explicit operation; it must not be implemented as an automatic force-push in synchronization.
