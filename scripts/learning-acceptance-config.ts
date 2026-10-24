import { resolve } from 'node:path';
import { localConfiguration } from './configuration.ts';
import { parseModelRegistry, selectedModelKeyNames } from '../shared/config/models.ts';

/** Only selected model credentials enter the isolated Worker. Cloud credentials stay in the host. */
export function learningAcceptanceConfig(requireModels: boolean, input = process.env) {
  const { env } = localConfiguration(resolve('wrangler.jsonc'), resolve(input.LEARNING_ENV_FILE || '.dev.vars'));
  const registry = parseModelRegistry({ MODEL_REGISTRY: input.MODEL_REGISTRY || env.MODEL_REGISTRY });
  const vars: Record<string, string> = { MODEL_REGISTRY: JSON.stringify(registry) };
  for (const name of selectedModelKeyNames(registry)) {
    const value = input[name] || env[name];
    if (requireModels && !value) throw new Error(`Set ${name} for the selected acceptance model.`);
    if (value) vars[name] = value;
  }
  return { vars, accountId: input.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: input.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN };
}
