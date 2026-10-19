# Public history and release boundaries

A public release must contain only the reviewed distribution in both its current tree and its published history. Deleting a file in a later commit does not remove earlier blobs. A parentless release can exclude old ancestry, but only if its own file contents have been reviewed first.

Keep recovery bundles, private originals and local configuration outside the public checkout's candidate manifest. Never push, merge or restore them into public refs. Existing collaborators should clone a replaced history afresh and avoid merging old branches.

`scripts/check-public-boundary.mjs` checks candidate paths/content using `scripts/public-distribution-policy.json`; historical mode checks reachable historical blobs. CI also runs credential scanning. Build sanitization checks configured local secret values against distributable output. These controls complement manual review; an incomplete policy can pass while unlisted internal material remains.

After all source cleanup, freeze the candidate paths and hashes. Verify an isolated export or fresh clone, run the functional checks, scan its reachable objects and compare it with the reviewed manifest before publication. Any later edit invalidates the prior candidate hashes and requires the relevant checks again.

Changing branch history cannot retract copies already downloaded or purge hosting-side cached objects. Verify advertised remote refs, fresh-clone content and any previously accessible commit URLs separately. A history rewrite or repository recreation does not rotate exposed credentials or prove that external copies disappeared. GitHub explains these limits in [Removing sensitive data from a repository](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).

No source cleanup, synchronization or scanner automatically deletes a repository, force-pushes, changes visibility, deploys an application or mutates a remote database. Those are separately scoped actions.
