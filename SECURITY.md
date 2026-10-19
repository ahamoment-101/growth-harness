# Security

Only the current default branch is maintained. This is a single-owner self-hosted
application; it is not an open-registration multi-tenant SaaS.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/ahamoment-101/growth-harness/security/advisories/new).
If it is unavailable, email **Mansetdev@163.com** with a sanitized reproduction.
Do not post active keys, exploit details or customer data in public issues.
Include affected revision, setup, impact and steps to reproduce. There is no
promised response SLA or bounty. Rotate exposed credentials immediately.

## Deployment responsibilities

Keep `.dev.vars`, cookies and local production maps out of Git. Use Cloudflare
Secrets in production, enable only configured login methods, keep the owner
password private, and back up D1 before upgrades. The local placeholder database
ID is rejected by the deployment checker. Run dependency and credential checks
before deployment; see [release evidence](docs/open-source-readiness.md).

For reproducible dependency checks use `npm audit --registry=https://registry.npmjs.org`.
A passing audit is not a complete security assessment. Never apply forced major
upgrades without reviewing compatibility and verifying Workflows and authentication.
