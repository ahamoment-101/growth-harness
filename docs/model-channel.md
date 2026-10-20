# Model connections and protocols

The public distribution defaults to OpenRouter and supports OpenAI Chat Completions (`openai-chat`), OpenAI Responses (`openai-responses`) and Anthropic Messages (`anthropic-messages`). Platform names are user-defined connection IDs, not a fixed provider enum.

## Registry version 2

Connections describe the endpoint, protocol, optional public attribution headers and the **name** of a credential environment variable. Model profiles reference a connection and declare verified capabilities for that exact endpoint/model. Agents reference profiles. Changing these settings does not require changing an Agent prompt or execution loop.

Edit [`shared/config/agent-models.json`](../shared/config/agent-models.json). This JSON is imported into the Worker and configuration CLI; no generation command or copied Wrangler JSON is needed. It contains no credentials.

| Setting | Meaning |
| --- | --- |
| `defaultProfile` | Model profile for calls without an explicit Agent binding, including utility text generation |
| `agentProfiles` | Agent ID → model profile; the shipped file lists every Agent |
| `defaultReasoning` | Requested reasoning for Agents without an override, and utility calls |
| `agentReasoning` | Agent ID → requested reasoning (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) |
| `connections` / `profiles` | Endpoint/protocol/key variable names and verified model capabilities |

The shipped preset uses one OpenRouter connection:

| Agent | Model | Requested reasoning |
| --- | --- | --- |
| `growth_leader` | `z-ai/glm-5.3-flash` | `low` |
| `business_research` | `z-ai/glm-5.3-flash` | `low` |
| `strategy_research` | `z-ai/glm-5.3-flash` | `low` |
| `deep_research` | `z-ai/glm-5.3-flash` | `low` |
| `keyword_research` | `z-ai/glm-5.3-flash` | `low` |
| `topic_decision` | `z-ai/glm-5.3-flash` | `low` |
| `content_production` | `z-ai/glm-5.3-flash` | `low` |
| `article_production` | `google/gemini-3.8-flash` | `low` |
| `content_review` | `z-ai/glm-5.3-flash` | `low` |
| `runtime_synthetic`, `runtime_synthetic_child` | Default GLM profile, test definitions only | `none` |

Model IDs and capacities were checked against the [OpenRouter catalog](https://openrouter.ai/api/v1/models) on 2026-10-20. These are starting defaults, not a claim of optimal quality or live acceptance on every account. Both models expose tools and reasoning through OpenRouter. External web research still needs its own service credential; one model key does not activate unrelated integrations.

To switch all Agents, change `defaultProfile` and clear `agentProfiles`; existing explicit bindings otherwise take precedence. To change one Agent, edit its binding and `agentReasoning` entry. Native `openai/default` and `anthropic/default` examples remain available but do not require keys until selected. Add a connection/profile for another compatible endpoint, using that endpoint's documented capacities. Changing a model never silently selects another model or borrows its credential.

Only selected connections require keys. The preset needs `OPENROUTER_API_KEY` in ignored `.dev.vars` locally or Cloudflare Secrets in production. `npm run setup` generates local login secrets; developers do not need to create model-routing JSON to start. Configuration checks and `npm run secrets:upload` discover required model keys from the effective registry.

An optional `vars.MODEL_REGISTRY` in `wrangler.jsonc` replaces the entire bundled file for that deployment. A local `MODEL_REGISTRY` in `.dev.vars` replaces the Wrangler override or bundled file locally. Overrides are complete registries, not patches; omitted `agentReasoning` is empty and omitted `defaultReasoning` defaults to `low` for older version 2 registries. Remove stale local overrides before expecting edited defaults to take effect. Restart the dev server after changes; production requires rebuilding/deploying the bundle. Production secret uploads never select models from a local override.

The resolved requested reasoning travels with the model profile into normal decisions, audits, isolated self-checks, context maintenance and text calls. An explicit call-level reasoning override wins. Capability constraints still apply: unsupported controls are omitted, and verified required reasoning/minimum levels remain enforced. Requested reasoning is an instruction to the selected endpoint, not a guarantee about hidden provider computation. Agent definitions contain business behavior, not a second routing or reasoning table.

Use a versioned API root such as `https://api.openai.com/v1` or `https://api.anthropic.com/v1`; the protocol adapter adds the resource path. OpenRouter is a preset over Chat Completions, not a new Agent execution loop. Native OpenAI models may require Responses for tool calling. A chat-compatible gateway is not assumed to support Anthropic Messages or Responses.

Profile metadata records its source URL. Metadata is not live account acceptance; access and parameter support can change. Keep a separate profile when the same model is served by another endpoint.

## Compatibility and responsibilities

`resolveModelProfile` resolves the entire connection/model/credential identity. The native conversation channel selects the protocol SDK; `requestModelText` covers JSON generation, article localization and site-name translation. All business decisions, tool execution, replay, cancellation and durable accounting continue through the existing Runtime pipeline. Transport adapters never choose editorial strategy or publication approval.

Optional `compatibility` fields declare verified protocol differences: `maxTokensField`, `supportsDeveloperRole`, `supportsReasoningEffort`, `supportsUsageInStreaming`, `supportsStore`, `supportsStrictMode`, `thinkingFormat`, `forceAdaptiveThinking` and `thinkingBudgetTokens`. These are endpoint capabilities, not guessed model-name rules. Required native thinking must have a verified adaptive format or a budget that leaves room for output. Unsupported tool schemas and observed platform errors remain visible; no silent fallback to another model or credential is implemented.

For Chat Completions, `thinkingFormat` selects the wire format (`openai` by default, or explicit `openrouter`), and `supportsReasoningEffort` declares effort support. `supportedParameters` records catalog metadata; it does not select a wire format.

Registry validation deterministically protects references, supported protocols, credential separation and context/output capacity. It rejects inline key fields, credential-bearing URLs and authentication headers. Output metadata and HTTP failures retain protocol meaning; truncation is not publication success. Model quality and every legitimate domain outcome remain Agent decisions.

## Downstream extensions

`shared/config/model-extensions.ts` and `worker/lib/model-extensions.ts` form the distribution seam. The public versions have no vendor-specific behavior. A downstream distribution can register explicit legacy-registry migration and request dialects in its own files. Public installation and builds never require the downstream repository. See [two-repository maintenance](repository-maintenance.md).

## Verification

Follow [verification](verification.md) for local checks and the opt-in paid probe. Unit tests verify serialized headers, bodies, streaming tool calls, tool-result correlation, usage and failures for all three protocols. A compatible-gateway result does not establish native official-service acceptance; full writing, review and publication evidence must name the tested connection and its limits.
