import { describe, expect, it } from 'vitest';
import { inspectConfiguration } from '../../shared/config';
import { inspectOwnerLoginAccess, loginConfiguration } from '../../shared/config/auth';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { parseModelRegistry, selectedModelKeyNames } from '../../shared/config/models';
import { testModelProfile, testModelRegistry } from '../agent-runtime/model-registry.test-fixture';

describe('installation configuration', () => {
  it('defaults to password without requiring optional providers', () => {
    const result = inspectConfiguration({});
    expect(result.loginMethods).toEqual(['password']);
    expect(result.errors).toEqual([]);
    expect(result.services.every(service => !service.configured)).toBe(true);
  });

  it('requires the installation Worker name for optional hosting diagnostics', () => {
    const env = { CLOUDFLARE_API_TOKEN: 'test', CLOUDFLARE_ACCOUNT_ID: 'test', CNAME_TARGET: 'docs-worker.example.workers.dev' };
    expect(inspectConfiguration(env).services.find(service => service.id === 'cloudflare_hosting')).toMatchObject({ configured: false, missing: ['CLOUDFLARE_WORKER_NAME'] });
    expect(inspectConfiguration({ ...env, CLOUDFLARE_WORKER_NAME: 'docs-worker' }).services.find(service => service.id === 'cloudflare_hosting')?.configured).toBe(true);
  });

  it.each(['', 'github', 'password,', 'none'])('rejects empty or unsupported login modes: %s', value => {
    expect(() => loginConfiguration({ AUTH_LOGIN_METHODS: value })).toThrow(/at least one/);
  });

  it('requires Google credentials only when explicitly enabled, and never includes values in diagnostics', () => {
    const env = { AUTH_LOGIN_METHODS: 'password,google', AUTH_GOOGLE_CLIENT_SECRET: 'private-test-value' };
    const result = inspectConfiguration(env);
    expect(result.errors[0].keys).toContain('AUTH_GOOGLE_CLIENT_ID');
    expect(result.errors[0].message).toContain('remove google');
    expect(JSON.stringify(result)).not.toContain(env.AUTH_GOOGLE_CLIENT_SECRET);
    expect(inspectConfiguration({ ...env, AUTH_LOGIN_METHODS: 'password' }).errors).toEqual([]);
  });

  it('requires only keys referenced by the actual selected model profiles', () => {
    const registry = JSON.parse(testModelRegistry({
      'openrouter/default': testModelProfile({ provider: 'openrouter', keyName: 'OPENROUTER_API_KEY' }),
      'anthropic/default': testModelProfile({ provider: 'anthropic', protocol: 'anthropic-messages', keyName: 'ANTHROPIC_API_KEY' }),
    }));
    const env = { MODEL_REGISTRY: JSON.stringify(registry), OPENROUTER_API_KEY: 'test' };
    expect(inspectConfiguration(env, true).errors).toEqual([]);
    expect(inspectConfiguration(env, true).modelKeys).toEqual(['OPENROUTER_API_KEY']);
    registry.agentProfiles.article_production = 'anthropic/default';
    expect(inspectConfiguration({ ...env, MODEL_REGISTRY: JSON.stringify(registry) }, true).errors[0].keys).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('accepts this distribution sample with only its selected connection keys', () => {
    const value = readFileSync(new URL('../../.dev.vars.example', import.meta.url), 'utf8').match(/^MODEL_REGISTRY=(.*)$/m)![1];
    const registry = parseModelRegistry({ MODEL_REGISTRY: value });
    const env = { MODEL_REGISTRY: value, ...Object.fromEntries(selectedModelKeyNames(registry).map(key => [key, 'synthetic-value'])) };
    expect(inspectConfiguration(env, true).errors).toEqual([]);
  });

  it('rejects invalid model contracts even before credentials are available', () => {
    expect(inspectConfiguration({ MODEL_REGISTRY: '{secret-value' }).errors[0].message).not.toContain('secret-value');
    expect(inspectConfiguration({}, true).errors[0].keys).toEqual(['MODEL_REGISTRY']);
  });

  it('rejects a login switch that would lock out the existing owner, without requiring a reused initialization token', () => {
    expect(inspectOwnerLoginAccess(['password'], { initialized: true, password: false, google: true }, true)).toContain('existing administrator');
    expect(inspectOwnerLoginAccess(['google'], { initialized: true, password: true, google: false }, false)).toContain('existing administrator');
    expect(inspectOwnerLoginAccess(['password'], { initialized: true, password: true, google: false }, false)).toBeNull();
    expect(inspectOwnerLoginAccess(['password'], { initialized: false, password: false, google: false }, false)).toContain('AUTH_SETUP_TOKEN');
    expect(inspectOwnerLoginAccess(['password'], { initialized: false, password: false, google: false }, true)).toBeNull();
  });
});
