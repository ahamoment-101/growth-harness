# Contributing

Start with [README](README.md), [configuration](docs/configuration.md) and
[self-hosting](docs/self-hosting.md). Use Node 22.18+ and `npm ci` from the lockfile.
All package downloads use the official npm registry. Never commit credentials,
production resource maps, customer content or real model conversations.

Follow the [local verification checklist](docs/verification.md#local-checks) before a PR.
It uses local resources and synthetic model responses. Paid provider tests are opt-in.
CI runs without production credentials and never deploys a pull request.

Worker features live near their domain, HTTP routes in `worker/index.ts`, persistence
in `worker/db.ts`, UI in `src/`, and ordered migrations in `migrations/`. Add meaningful
colocated Worker tests for behavior changes. Read [AGENTS.md](AGENTS.md) and the
[continuous Runtime contract](docs/continuous-agent-runtime.md) before Agent changes.
Keep editorial decisions in the domain Agent and execution integrity in Runtime.

Open a [bug or feature issue](https://github.com/ahamoment-101/growth-harness/issues)
with a minimal reproduction, sanitized config names and expected behavior. For PRs,
describe user-visible changes, migrations/config changes and actual validation.
Include screenshots for UI changes. Do not include keys, cookies or customer logs.

Contributions are provided under the repository MIT license. Retain third-party
notices and identify copied code and its source. Report security issues privately
using [SECURITY.md](SECURITY.md), not a public issue.

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
