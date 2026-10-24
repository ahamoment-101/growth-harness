import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { learningAcceptanceConfig } from './learning-acceptance-config.ts';
import { fixtureModelRegistry } from './runtime-fixture-capabilities.mjs';

test('passes only selected model credentials to the Worker and keeps management credentials on the host', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learning-config-'));
  try {
    const path = join(dir, '.dev.vars');
    writeFileSync(path, 'MODEL_REGISTRY=' + fixtureModelRegistry + '\nMODEL_API_KEY=fixture-model\nCLOUDFLARE_ACCOUNT_ID=fixture-account\nCLOUDFLARE_API_TOKEN=fixture-management\nUNRELATED_SECRET=fixture-unrelated\n');
    const value = learningAcceptanceConfig(true, { LEARNING_ENV_FILE: path, MODEL_API_KEY: 'fixture-override' });
    assert.equal(value.vars.MODEL_API_KEY, 'fixture-override');
    assert.equal(value.accountId, 'fixture-account');
    assert.equal(value.apiToken, 'fixture-management');
    assert.deepEqual(Object.keys(value.vars).sort(), ['MODEL_API_KEY', 'MODEL_REGISTRY']);
    writeFileSync(path, 'MODEL_REGISTRY=' + fixtureModelRegistry + '\n');
    assert.throws(() => learningAcceptanceConfig(true, { LEARNING_ENV_FILE: path }), /Set MODEL_API_KEY/);
    assert.deepEqual(Object.keys(learningAcceptanceConfig(false, { LEARNING_ENV_FILE: path }).vars), ['MODEL_REGISTRY']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
