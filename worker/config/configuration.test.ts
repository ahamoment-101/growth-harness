import { describe, expect, it } from 'vitest';
import { inspectConfiguration } from '../../shared/config';
import { inspectOwnerLoginAccess, loginConfiguration } from '../../shared/config/auth';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseModelRegistry, selectedModelKeyNames } from '../../shared/config/models';
import { testModelProfile, testModelRegistry } from '../agent-runtime/model-registry.test-fixture';
import { localConfiguration, readVars, readWrangler, secretsForDeployment } from '../../scripts/configuration';

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
    const sample = readVars(fileURLToPath(new URL('../../.dev.vars.example', import.meta.url)));
    const config = readWrangler(fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)));
    const merged = { ...config.vars, ...sample };
    const registry = parseModelRegistry(merged);
    const env = { ...merged, ...Object.fromEntries(selectedModelKeyNames(registry).map(key => [key, 'synthetic-value'])) };
    expect(inspectConfiguration(env, true).errors).toEqual([]);
  });

  it('preserves an intentional local model override without changing deployment settings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'growth-config-'));
    try {
      const configPath = join(directory, 'wrangler.jsonc');
      const deployed = testModelRegistry({ production: testModelProfile() });
      const local = testModelRegistry({ local: testModelProfile({ keyName: 'LOCAL_MODEL_KEY' }) });
      writeFileSync(configPath, JSON.stringify({ vars: { MODEL_REGISTRY: deployed } }));
      expect(parseModelRegistry(localConfiguration(configPath).env).defaultProfile).toBe('production');
      writeFileSync(join(directory, '.dev.vars'), `MODEL_REGISTRY=${local}\nLOCAL_MODEL_KEY=synthetic-value\n`);
      const { env, config } = localConfiguration(configPath);
      expect(parseModelRegistry(env).defaultProfile).toBe('local');
      expect(parseModelRegistry(config.vars).defaultProfile).toBe('production');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uploads the production model key even when local model and login selections differ', () => {
    const profiles = {
      router: testModelProfile({ provider: 'openrouter', keyName: 'OPENROUTER_API_KEY' }),
      native: testModelProfile({ provider: 'openai', protocol: 'openai-responses', keyName: 'OPENAI_API_KEY' }),
    };
    const deployment = { AUTH_LOGIN_METHODS: 'password', MODEL_REGISTRY: testModelRegistry(profiles, 'native') };
    const local = { AUTH_LOGIN_METHODS: 'google', MODEL_REGISTRY: testModelRegistry(profiles, 'router'), OPENAI_API_KEY: 'synthetic-openai-key' };
    expect(secretsForDeployment(deployment, local)).toEqual({ OPENAI_API_KEY: 'synthetic-openai-key' });
    expect(secretsForDeployment(deployment, { ...local, OPENROUTER_API_KEY: 'synthetic-router-key' }))
      .toEqual({ OPENAI_API_KEY: 'synthetic-openai-key' });
  });

  it('does not satisfy deployment public settings from the local environment', () => {
    const MODEL_REGISTRY = testModelRegistry({ model: testModelProfile() });
    const local = { MODEL_REGISTRY, MODEL_API_KEY: 'synthetic-model-key', AUTH_GOOGLE_CLIENT_ID: 'local-client',
      AUTH_ALLOWED_GOOGLE_EMAIL: 'owner@example.test', AUTH_GOOGLE_CLIENT_SECRET: 'synthetic-secret', AUTH_SESSION_SECRET: 'synthetic-session' };
    expect(() => secretsForDeployment({ AUTH_LOGIN_METHODS: 'google', MODEL_REGISTRY }, local)).toThrow('AUTH_GOOGLE_CLIENT_ID');
    expect(() => secretsForDeployment({ AUTH_LOGIN_METHODS: 'password' }, local)).toThrow('OPENROUTER_API_KEY');
  });

  it('validates and uploads the shipped defaults without a registry environment variable', () => {
    expect(inspectConfiguration({ OPENROUTER_API_KEY: 'synthetic-key' }, true).errors).toEqual([]);
    expect(secretsForDeployment({ AUTH_LOGIN_METHODS: 'password' }, {
      MODEL_REGISTRY: 'invalid-local-override', OPENROUTER_API_KEY: 'synthetic-router-key', OPENAI_API_KEY: 'unused',
    })).toEqual({ OPENROUTER_API_KEY: 'synthetic-router-key' });
  });

  it('discovers custom production credentials and reports missing ones without echoing local values', () => {
    const deployment = { MODEL_REGISTRY: testModelRegistry({ custom: testModelProfile({ keyName: 'CUSTOM_MODEL_KEY' }) }) };
    expect(secretsForDeployment(deployment, { CUSTOM_MODEL_KEY: 'synthetic-custom-key', MODEL_REGISTRY: 'invalid-local-override' }))
      .toEqual({ CUSTOM_MODEL_KEY: 'synthetic-custom-key' });
    expect(() => secretsForDeployment(deployment, { OPENROUTER_API_KEY: 'do-not-log-this' })).toThrow('CUSTOM_MODEL_KEY');
    expect(() => secretsForDeployment(deployment, { OPENROUTER_API_KEY: 'do-not-log-this' })).not.toThrow('do-not-log-this');
  });

  it('rejects invalid model contracts even before credentials are available', () => {
    expect(inspectConfiguration({ MODEL_REGISTRY: '{secret-value' }).errors[0].message).not.toContain('secret-value');
    expect(inspectConfiguration({}, true).errors[0].keys).toEqual(['OPENROUTER_API_KEY']);
  });

  it('rejects a login switch that would lock out the existing owner, without requiring a reused initialization token', () => {
    expect(inspectOwnerLoginAccess(['password'], { initialized: true, password: false, google: true }, true)).toContain('existing administrator');
    expect(inspectOwnerLoginAccess(['google'], { initialized: true, password: true, google: false }, false)).toContain('existing administrator');
    expect(inspectOwnerLoginAccess(['password'], { initialized: true, password: true, google: false }, false)).toBeNull();
    expect(inspectOwnerLoginAccess(['password'], { initialized: false, password: false, google: false }, false)).toContain('AUTH_SETUP_TOKEN');
    expect(inspectOwnerLoginAccess(['password'], { initialized: false, password: false, google: false }, true)).toBeNull();
  });
});
