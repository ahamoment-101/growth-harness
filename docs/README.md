# Documentation

## Install and configure

- [Configuration](configuration.md): login modes, model connections, service keys and optional features.
- [Self-hosting and upgrades](self-hosting.md): your own Cloudflare resources, migration order, deployment and password recovery.
- [Model connections](model-channel.md): OpenRouter, compatible OpenAI/Anthropic protocols and per-Agent profiles.
- [Verification](verification.md): automated fixtures, real-provider checks, writing through publication and the limits of each evidence class.

## Architecture and contracts

- [Cloudflare architecture](cloudflare-architecture.md) and [read-path design](real-time-updates-and-cache-architecture.md).
- [Continuous Runtime](continuous-agent-runtime.md), [pipeline boundaries](runtime-pipeline-refinement.md), [implementation map](Agentloopinfra.md) and [stable parameter ownership](stable-agent-parameters.md).
- [Content growth workflow](Agentloop.md), [Growth Leader](CMO-Agent.md), [business research](business-research.md) and [strategy tools](research-agent-tools-design.md).
- [Keyword domain](keyword-library-backend.md), [tool contract](keyword-library-tool-contract.md), [locale ownership](language-only-domain.md) and [strategy reports](strategy-report-delivery.md).
- [Editorial evidence](content-editorial-contract.md), [writing and review](content-self-check-and-author-links.md) and [hosted deep research](deep-research.md).
- [Human work requests](agent-work-requests.md) and [event pool](agent-event-pool.md).
- [Blog rendering and SEO](gsc-technical-checkpoints.md), [blog shell](blog-shell.md), [multilingual URL policy](multilingual-seo-strategy.md), [site checklist](multilingual-site-checklist.md) and [optional Webhook](ingest-contract.md).

## Maintain and release

- [Upstream/downstream maintenance](repository-maintenance.md).
- [Public release checklist](open-source-readiness.md) and [history boundary](public-history-cleanup.md).

Architecture and design documents describe contracts or intended behavior. They are not proof that a particular account, provider or deployment has passed acceptance. Internal deployment receipts, customer handover material and raw conversations are excluded from this documentation set.
