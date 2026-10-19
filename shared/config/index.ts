import { configuredValue, inspectLoginConfiguration, type ConfigurationIssue, type ConfigurationValues } from './auth.ts';
import { parseModelRegistry, selectedModelKeyNames, type ModelRegistryEnv } from './models.ts';

const OPTIONAL_SERVICES = [
  { id: 'firecrawl', keys: ['FIRECRAWL_API_KEY'] },
  { id: 'dataforseo', keys: ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'] },
  { id: 'gsc', keys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GSC_TOKEN_CIPHER_KEY', 'AUTH_SESSION_SECRET'] },
  { id: 'cloudflare_hosting', keys: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_WORKER_NAME', 'CNAME_TARGET'] },
] as const;

/** One report for CLI and diagnostics. Each feature owns its actual execution validation. */
export function inspectConfiguration(env: ConfigurationValues, requireModels = false) {
  const login = inspectLoginConfiguration(env);
  const errors: ConfigurationIssue[] = [...login.issues];
  const warnings: ConfigurationIssue[] = [];
  const services: Array<{ id: string; configured: boolean; missing: string[] }> = [];
  for (const service of OPTIONAL_SERVICES) {
    const missing = service.keys.filter(key => !configuredValue(env, key));
    services.push({ id: service.id, configured: !missing.length, missing });
    if (missing.length) warnings.push({ feature: service.id, keys: missing, message: `${service.id} is not configured; its associated operations are unavailable. Missing: ${missing.join(', ')}` });
  }
  let modelKeys: string[] = [];
  if (configuredValue(env, 'MODEL_REGISTRY')) {
    try {
      const registry = parseModelRegistry(env as ModelRegistryEnv);
      modelKeys = selectedModelKeyNames(registry);
      const missing = modelKeys.filter(key => !configuredValue(env, key));
      if (missing.length) (requireModels ? errors : warnings).push({ feature: 'models', keys: missing, message: `Selected models require: ${missing.join(', ')}. Configure their keys or select another supported profile.` });
    } catch {
      errors.push({ feature: 'models', keys: ['MODEL_REGISTRY'], message: 'MODEL_REGISTRY is invalid. Check profiles, Agent IDs, provider dialects and documented capacities.' });
    }
  } else {
    (requireModels ? errors : warnings).push({ feature: 'models', keys: ['MODEL_REGISTRY'], message: 'MODEL_REGISTRY is not configured; Agent model calls are unavailable.' });
  }
  return { errors, warnings, loginMethods: login.methods, modelKeys, services };
}
