# Public release checklist

A release candidate needs both functional verification and a reviewed public-content boundary. Passing one does not establish the other.

## Source and distribution

- Review the complete candidate path list. Exclude local configuration, credentials, private adapters, internal documentation, customer material, prototypes and development-only experiments.
- Keep public examples synthetic and clearly labeled. Keep generic architecture, configuration, protocols and optional integrations usable without a private checkout.
- Retain MIT and third-party license notices. Use reproducible lockfiles and verify dependency downloads from the intended registry.
- Run the public-boundary and credential scanners on the candidate files and, when publishing history, on every reachable historical object. Exact-value checks against ignored configured credentials add evidence that pattern scanning alone cannot supply.
- Inspect built client and Worker output for configured secret values, private endpoint identifiers, unexpected example data and development entry points.

## Functional verification

Run the checks in [verification](verification.md), including tests/build and isolated real Worker/Workflow execution. For model or publication changes, perform the explicitly authorized live-provider path and inspect writing, review, approval and rendered publication. Record synthetic, compatible-gateway and native-account evidence separately.

Configuration checks validate required fields and declared contracts, not account access, balances, content quality or successful indexing. Optional services can remain unconfigured, with their absent acceptance stated explicitly.

## Publication and history

Freeze the reviewed file manifest and repeat scanning after the final change. Verify a fresh clone/export rather than relying only on a working directory that may exclude ignored local data. A new root commit must contain the reviewed candidate, not an earlier unchecked tree. See [history boundaries](public-history-cleanup.md).

Repository deletion, recreation, remote publication, deployments and remote migrations are separate operations. No checklist or test result performs or authorizes them automatically. Current verification results should identify the exact candidate and material limitations without embedding production receipts.
