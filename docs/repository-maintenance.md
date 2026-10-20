# Repository maintenance

These checks are for maintainers of a downstream distribution or a public source export. Ordinary development uses the [verification checklist](verification.md#local-checks).

## Upstream and downstream

Maintain one public core and a downstream distribution with its own extensions. Shared fixes land in the public checkout first, then move downstream. Extract shared downstream fixes upstream before synchronization; do not copy a downstream checkout over the public repository.

## Synchronization

From the public checkout:

```sh
npm run core:sync -- --target /path/to/downstream --check
npm run core:sync -- --target /path/to/downstream --apply --initialize
```

`--initialize` is only for the first synchronization, after reviewing the reported change list. Later synchronization uses `--apply`; `.public-core-sync.json` records file hashes and the upstream commit. Pending upstream edits are included in the hashes, so commit identity alone is not a release receipt. The tool refuses to overwrite or delete managed files changed downstream; reconcile them first.

The synchronized core is `worker/`, `shared/`, `packs/`, `src/`, `index.html`, shared migrations and selected configuration/build scripts. Each checkout owns its `shared/config/model-extensions.ts`, `worker/lib/model-extensions.ts` and historical model-default migrations `0001_init.sql`/`0028_fix_agent_model_configuration.sql`. Downstream-only files, deployment bindings, credentials, repository metadata and private documentation are retained. Dependencies are merged while downstream package identity remains its own; install dependencies to update its lockfile.

The synchronizer and its tests stay upstream. A later sync removes unchanged copies managed by older versions, while modified copies require reconciliation. Previously injected synchronization commands and the retired strategy-verifier alias are removed only when they still match their original commands; custom downstream commands are preserved.

Run `npm run test:sync` upstream when changing the synchronizer. After synchronization, run `npm test` and `npm run build` in both checkouts, plus checks relevant to the change, then run `core:sync --check` upstream to confirm no core drift. Model or publication changes need explicitly authorized [live acceptance](verification.md#live-model-and-publication-acceptance) with separate sites/storage and exact tested endpoint/model identities. Synthetic or gateway evidence does not establish native account acceptance.

Synchronization only edits local source, package requirements and its manifest. It does not commit, publish, deploy, rewrite history or mutate a remote database.

## Public exports and history

When preparing a public export, review the complete candidate path list and retain MIT/third-party notices. Exclude credentials, private adapters, customer material, operational receipts, prototypes, `design/` and `.zcode/`. Keep examples synthetic. Build and run the [verification checklist](verification.md#local-checks), then:

```sh
npm run release:check
# Requires Gitleaks on PATH; checks candidate files and all reachable history.
node scripts/check-secrets.mjs
```

`release:check` enables the boundary scanner's `--export` rules: distribution-specific provider identifiers and historical acceptance directories are checked in addition to the ordinary private-file protections. `--history` enables these export rules for every reachable historical blob. Ordinary CI keeps credential history scanning without imposing this maintainer export policy on all contributions. Optional `--private-markers /outside/repo/markers.json` checks exact identifiers supplied as a JSON array; matched values are never printed. The build also checks exact configured local credential values in output.

For a new public distribution or changed history, freeze the reviewed paths/hashes and verify an isolated export or fresh clone before publication. Deleting a file in a later commit does not remove its earlier blobs; a parentless release still needs its own contents reviewed. Keep private recovery bundles outside public refs. A replaced history requires collaborators to clone afresh rather than merge old branches.

History changes cannot rotate exposed credentials or retract downloaded/cached copies. Review remote refs and fresh-clone contents separately; see GitHub's [sensitive-data removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository). No scanner authorizes repository deletion, force-pushing, visibility changes, deployment or remote migration.
