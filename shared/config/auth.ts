export const LOGIN_METHODS = ['password', 'google'] as const;
export type LoginMethod = typeof LOGIN_METHODS[number];
export type ConfigurationValues = { [key: string]: unknown };
export type ConfigurationIssue = { feature: string; message: string; keys: string[] };

export function configuredValue(env: ConfigurationValues, key: string): string {
  return typeof env[key] === 'string' ? env[key].trim() : '';
}

export function inspectLoginConfiguration(env: ConfigurationValues): { methods: LoginMethod[]; issues: ConfigurationIssue[] } {
  const raw = env.AUTH_LOGIN_METHODS === undefined ? 'password' : configuredValue(env, 'AUTH_LOGIN_METHODS');
  const names = raw.split(',').map(value => value.trim());
  const issues: ConfigurationIssue[] = [];
  if (!names.length || names.some(name => !LOGIN_METHODS.includes(name as LoginMethod))) {
    issues.push({ feature: 'login', keys: ['AUTH_LOGIN_METHODS'], message: 'AUTH_LOGIN_METHODS must contain password and/or google; at least one login method is required.' });
  }
  const methods = [...new Set(names.filter(name => LOGIN_METHODS.includes(name as LoginMethod)))] as LoginMethod[];
  if (methods.includes('google')) {
    const keys = ['AUTH_GOOGLE_CLIENT_ID', 'AUTH_GOOGLE_CLIENT_SECRET', 'AUTH_SESSION_SECRET', 'AUTH_ALLOWED_GOOGLE_EMAIL']
      .filter(key => !configuredValue(env, key));
    if (keys.length) issues.push({ feature: 'google', keys, message: `Google login is enabled but missing: ${keys.join(', ')}. Configure these values or remove google from AUTH_LOGIN_METHODS.` });
  }
  return { methods, issues };
}

export class ConfigurationError extends Error {
  readonly issues: ConfigurationIssue[];
  constructor(issues: ConfigurationIssue[]) {
    super(issues.map(issue => issue.message).join('\n'));
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

export function loginConfiguration(env: ConfigurationValues): { methods: LoginMethod[] } {
  const result = inspectLoginConfiguration(env);
  if (result.issues.length) throw new ConfigurationError(result.issues);
  return { methods: result.methods };
}

/** Validate a mode switch against existing credentials without reading their secret values. */
export function inspectOwnerLoginAccess(methods: LoginMethod[], owner: { initialized: boolean; password: boolean; google: boolean }, setupTokenPresent: boolean): string | null {
  if (!owner.initialized) {
    return methods.includes('google') || (methods.includes('password') && setupTokenPresent)
      ? null : 'First administrator setup requires AUTH_SETUP_TOKEN. Run npm run setup and upload the generated token.';
  }
  if ((methods.includes('password') && owner.password) || (methods.includes('google') && owner.google)) return null;
  return 'The configured login methods exclude every credential bound to the existing administrator. Keep the old method enabled until a password or Google identity is added, or use npm run auth:reset.';
}
