# Model connections and protocols

The public distribution defaults to OpenRouter and supports OpenAI Chat Completions (`openai-chat`), OpenAI Responses (`openai-responses`) and Anthropic Messages (`anthropic-messages`). Platform names are user-defined connection IDs, not a fixed provider enum.

## Registry version 2

Connections describe the endpoint, protocol, optional public attribution headers and the **name** of a credential environment variable. Model profiles reference a connection and declare verified capabilities for that exact endpoint/model. Agents reference profiles. Changing these settings does not require changing an Agent prompt or execution loop.

```json
{
  "version": 2,
  "defaultProfile": "openrouter/default",
  "agentProfiles": {},
  "connections": {
    "openrouter": {
      "protocol": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "headers": {
        "HTTP-Referer": "https://github.com/ahamoment-101/growth-harness",
        "X-OpenRouter-Title": "GrowthHarness"
      }
    },
    "openai": {
      "protocol": "openai-responses",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY"
    },
    "anthropic": {
      "protocol": "anthropic-messages",
      "baseUrl": "https://api.anthropic.com/v1",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    }
  },
  "profiles": {
    "openrouter/default": {
      "supportedParameters": [
        "tools",
        "tool_choice",
        "max_tokens",
        "response_format",
        "reasoning",
        "reasoning_effort"
      ],
      "reasoningSupported": true,
      "reasoningRequired": false,
      "connection": "openrouter",
      "model": "openai/gpt-5.6-terra",
      "contextWindow": 1050000,
      "maxOutputTokens": 128000,
      "sourceUrl": "https://openrouter.ai/api/v1/models",
      "compatibility": {
        "thinkingFormat": "openrouter",
        "supportsReasoningEffort": true
      }
    },
    "openai/default": {
      "supportedParameters": [
        "tools",
        "tool_choice",
        "max_output_tokens",
        "text.format",
        "reasoning"
      ],
      "reasoningSupported": true,
      "reasoningRequired": false,
      "connection": "openai",
      "model": "gpt-5.6-terra",
      "contextWindow": 1050000,
      "maxOutputTokens": 128000,
      "sourceUrl": "https://developers.openai.com/api/docs/models/gpt-5.6-terra"
    },
    "anthropic/default": {
      "supportedParameters": [
        "tools",
        "tool_choice",
        "max_tokens",
        "response_format"
      ],
      "reasoningSupported": true,
      "reasoningRequired": false,
      "connection": "anthropic",
      "model": "claude-sonnet-5-5",
      "contextWindow": 1000000,
      "maxOutputTokens": 128000,
      "sourceUrl": "https://platform.claude.com/docs/en/models/overview",
      "compatibility": {
        "forceAdaptiveThinking": true
      }
    }
  }
}
```

Only the selected connections require keys. The default needs `OPENROUTER_API_KEY`; native example profiles need their own credentials only when selected. A custom connection can use a custom `apiKeyEnv` name: configuration checks and `npm run secrets:upload` discover it from the registry. Keys are read only on the server and are not part of the registry or model conversation.

Registry values and secrets are Worker bindings. Restart the local development server after editing `.dev.vars`; changing the file alone does not prove a running Workflow received the new selection. Production changes require updating the deployment bindings. Verify the actual request's model and endpoint after a switch, preserve the existing Task/Run and reconcile any in-flight request before restarting a local host.

Use a versioned API root such as `https://api.openai.com/v1` or `https://api.anthropic.com/v1`; the protocol adapter adds the resource path. OpenRouter is a preset over Chat Completions, not a new Agent execution loop. Native OpenAI models may require Responses for tool calling. A chat-compatible gateway is not assumed to support Anthropic Messages or Responses.

The sample capabilities were checked against [OpenRouter's model catalog](https://openrouter.ai/api/v1/models), [OpenAI's model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-terra) and [Anthropic's model documentation](https://platform.claude.com/docs/en/models/overview). Metadata is not live account acceptance; access and parameter support can change. Keep a separate profile when the same model is served by another endpoint.

## Compatibility and responsibilities

`resolveModelProfile` resolves the entire connection/model/credential identity. The native conversation channel selects the protocol SDK; `requestModelText` covers JSON generation, article localization and site-name translation. All business decisions, tool execution, replay, cancellation and durable accounting continue through the existing Runtime pipeline. Transport adapters never choose editorial strategy or publication approval.

Optional `compatibility` fields declare verified protocol differences: `maxTokensField`, `supportsDeveloperRole`, `supportsReasoningEffort`, `supportsUsageInStreaming`, `supportsStore`, `supportsStrictMode`, `thinkingFormat`, `forceAdaptiveThinking` and `thinkingBudgetTokens`. These are endpoint capabilities, not guessed model-name rules. Required native thinking must have a verified adaptive format or a budget that leaves room for output. Unsupported tool schemas and observed platform errors remain visible; no silent fallback to another model or credential is implemented.

Registry validation deterministically protects references, supported protocols, credential separation and context/output capacity. It rejects inline key fields, credential-bearing URLs and authentication headers. Output metadata and HTTP failures retain protocol meaning; truncation is not publication success. Model quality and every legitimate domain outcome remain Agent decisions.

## Downstream extensions

`shared/config/model-extensions.ts` and `worker/lib/model-extensions.ts` form the distribution seam. The public versions have no vendor-specific behavior. A downstream distribution can register explicit legacy-registry migration and request dialects in its own files. Public installation and builds never require the downstream repository. See [two-repository maintenance](repository-maintenance.md).

## Verification

```sh
npm test
npm run build
MODEL_TRANSPORT_LIVE_VERIFY=1 npx vitest run worker/lib/model-channel.live.test.ts
```

The paid probe uses the currently selected connection and model, synthetic input and no business writes. Unit tests verify actual serialized headers, bodies, streaming tool calls, tool-result correlation, native usage and failures for all three protocols. A live check of another compatible gateway is not proof that OpenRouter or either native official service was tested. Full writing, independent review and publication acceptance must name the exact tested connection and its limits.
