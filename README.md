# GrowthHarness

A persistent Agent Harness for content growth, starting with SEO research, writing, review, and publishing. The shared Runtime manages task identity, persistent conversations, execution recovery, tool permissions, and audits. Domain Agents choose business actions through their own prompts and tools.

**Self-evolution roadmap:** Continuous execution and feedback-driven correction within a task have been verified. Learning across tasks, automatically reusing that experience, and evaluating improvements remain under development. The current version does not claim to optimize its own Harness or demonstrate SEO growth.

The self-hosted workspace brings together business documents, research, a keyword library, topic selection, writing, and human publishing review. The React/Vite console and hosted articles run on Cloudflare Workers, using D1, R2, Durable Objects, and Workflows for storage and execution.

Each installation supports one owner workspace. Email and password login is the default; Google login is optional and public registration is disabled. You provide your own model and research service credentials. The repository includes no API keys or service credits.

The console and operational reports use English. Target-market research and published articles retain their independently configured languages.

## Getting Started Locally

Requires Node **22.18+**, npm, and a local Cloudflare development environment.

```bash
git clone https://github.com/ahamoment-101/growth-harness.git
cd growth-harness
npm ci
npm run setup -- --local
npm run config:check
npm run dev
```

`setup` prepares `.dev.vars`, generates initialization codes and signing keys, and applies local migrations without overwriting existing keys or model choices. Open the address output by the development server, and on the initialization page, enter your email, a password of at least 12 characters, and the `AUTH_SETUP_TOKEN` from `.dev.vars`. Once the administrator is established, initialization is closed.

After logging in, add a site and enter the classroom. Fill in the selected model Key before running Agents; configure corresponding services only when using research, keyword data, or GSC. The public sample defaults to OpenRouter. Native OpenAI Responses and Anthropic Messages connections are also included; select models per Agent in `MODEL_REGISTRY.agentProfiles`. See [model connections](docs/model-channel.md).

See [verification methods and limits](docs/verification.md) when testing model accounts and the complete publication path. See [repository maintenance](docs/repository-maintenance.md) when maintaining a downstream distribution.

```bash
npm run config:check -- --require-models
```

Configuration checks validate format and completeness. Actual permissions, account balances, and provider compatibility require real API calls. Synthetic tests and passing builds do not prove business completion or growth.

## Configuration and Deployment

- [Configuration Guide](docs/configuration.md): Purpose, service portal, required conditions, costs, and impact of absence for each configuration item.
- [Self-Hosting and Upgrades](docs/self-hosting.md): Your own Cloudflare resources, Secrets, deployment, migration of existing Google users, and password resets.
- [Verification Guide](docs/verification.md): Automated checks, real-provider evidence, writing/review/publication acceptance and scope limits.
- [Open Source Readiness Checklist](docs/open-source-readiness.md): Source, distribution, history and functional release gates.
- [Documentation Index](docs/README.md): Shared architecture and feature contracts.

`wrangler.jsonc` stores deployment resources and public settings, using your own database ID and domain; `.dev.vars` is used only locally. Production keys are stored in Cloudflare Secrets. When enabled login methods lack required items, startup checks fail; disabled methods do not display buttons and their login endpoints cannot be invoked.

## Verification and Development

```bash
npm test
npm run build
npm run verify:self-hosting:local
```

Default tests do not access paid models; live service testing must be explicitly enabled. Self-hosted local verification uses isolated D1, real Workers, and Workflows, with models using explicitly labeled synthetic responses.

- Frontend `src/`; HTTP entry `worker/index.ts`.
- Authentication `worker/lib/auth/`; configuration `shared/config/`, `scripts/configuration.ts`.
- Agent missions and tools reside in corresponding domain directories; shared execution mechanisms reside in `worker/agent-runtime/`.
- Database upgrades reside in `migrations/`, executed sequentially.
- [Continuous Runtime Contract](docs/continuous-agent-runtime.md), [Cloudflare Architecture](docs/cloudflare-architecture.md), [Optional Webhook Export](docs/ingest-contract.md).

Publishing retains manual review; Webhook is an optional export method. Do not commit passwords, model Keys, or production business data.

## License and Maintenance

The code is licensed under [MIT](LICENSE); third-party materials retain their [original license notices](THIRD_PARTY_NOTICES.md). Builds simultaneously generate browser and Worker dependency notices, shipping `THIRD_PARTY_LICENSES.txt` with the application. To participate in development, see [CONTRIBUTING](CONTRIBUTING.md); please report security issues privately per [SECURITY](SECURITY.md); standard issues can use repository Issue templates.

CI uses lockfiles to run tests, builds, empty database migrations, and local Workflow verification, while checking dependencies and Git history credentials without requiring production keys. Live paid acceptance is separated from CI.
