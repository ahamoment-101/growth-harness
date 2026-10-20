import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { boundaryIssues, checkPublicBoundary, checkArtifacts } from './check-public-boundary.mjs';

test('rejects private/local paths and environment files while allowing empty documented templates', () => {
  for (const path of ['worker/private-models/adapter.ts', '.public-core-sync.json', '.zcode/plan.md', 'design/mock.svg', '.dev.vars', 'nested/.env.production', 'prototypes/experiment.js', 'hitl-lab/fixture.ts', '.claude/launch.json', 'docs/internal-archive/report.md', 'backup.sqlite', 'credentials.pem']) {
    assert.ok(boundaryIssues(path, Buffer.from('')).length, path);
  }
  assert.deepEqual(boundaryIssues('.dev.vars.example', Buffer.from('OPENROUTER_API_KEY=')), []);
  assert.deepEqual(boundaryIssues('worker/lib/model-request.ts', Buffer.from('generic protocol transport')), []);
  const policy = JSON.parse(readFileSync(new URL('./public-distribution-policy.json', import.meta.url)));
  for (const identifier of policy.forbiddenContent) assert.ok(boundaryIssues('worker/adapter.ts', Buffer.from(identifier)).length);
});

test('reserves vendor and export-document rules for explicit maintainer checks', () => {
  const root = mkdtempSync(join(tmpdir(), 'public-export-policy-'));
  const script = fileURLToPath(new URL('./check-public-boundary.mjs', import.meta.url));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(join(root, 'docs/acceptance'), { recursive: true });
    const policy = JSON.parse(readFileSync(new URL('./public-distribution-policy.json', import.meta.url)));
    writeFileSync(join(root, 'docs/acceptance/method.md'), 'Synthetic reproducible verification method');
    writeFileSync(join(root, 'docs/providers.md'), policy.exportOnlyContent[0]);
    assert.equal(checkPublicBoundary(root).failures.length, 0);
    assert.equal(checkPublicBoundary(root, false, [], true).failures.length, 2);
    assert.equal(spawnSync(process.execPath, [script], { cwd: root }).status, 0);
    assert.equal(spawnSync(process.execPath, [script, '--export'], { cwd: root }).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('checks externally supplied private identifiers without exposing their values', () => {
  const marker = 'synthetic-deployment-identifier';
  const issues = boundaryIssues('docs/deployment.md', Buffer.from(marker), undefined, [marker]);
  assert.equal(issues.length, 1);
  assert.ok(!JSON.stringify(issues).includes(marker));
  assert.deepEqual(boundaryIssues('SECURITY.md', Buffer.from('security@example.invalid')), []);
  assert.deepEqual(boundaryIssues('THIRD_PARTY_NOTICES.md', Buffer.from('Upstream copyright holder')), []);
});

test('checks final production output for credentials and demonstration data', () => {
  const root = mkdtempSync(join(tmpdir(), 'public-artifacts-'));
  try {
    writeFileSync(join(root, 'index.js'), 'generic production application');
    assert.deepEqual(checkArtifacts(root).failures, []);
    writeFileSync(join(root, 'worker.js'), 'synthetic-deployment-identifier');
    assert.ok(checkArtifacts(root, ['synthetic-deployment-identifier']).failures.some(issue => issue.path === 'worker.js'));
    writeFileSync(join(root, '.dev.vars'), '');
    assert.ok(checkArtifacts(root).failures.some(issue => issue.path === '.dev.vars'));
    const policy = JSON.parse(readFileSync(new URL('./public-distribution-policy.json', import.meta.url)));
    writeFileSync(join(root, 'index.js'), policy.forbiddenArtifactContent[0]);
    assert.ok(checkArtifacts(root).failures.some(issue => issue.issue.includes('demonstration')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('keeps maintainer export rules for project source maps without rejecting upstream SDK vendor domains', () => {
  const root = mkdtempSync(join(tmpdir(), 'public-sdk-artifacts-'));
  try {
    const policy = JSON.parse(readFileSync(new URL('./public-distribution-policy.json', import.meta.url)));
    const vendor = policy.thirdPartyArtifactContent[0];
    writeFileSync(join(root, 'index.js'), vendor);
    writeFileSync(join(root, 'index.js.map'), JSON.stringify({ sources: ['../../node_modules/upstream-sdk/transport.js'], sourcesContent: [vendor] }));
    assert.deepEqual(checkArtifacts(root, [], true).failures, []);
    writeFileSync(join(root, 'index.js.map'), JSON.stringify({ sources: ['../../worker/adapter.ts'], sourcesContent: [vendor] }));
    assert.deepEqual(checkArtifacts(root).failures, []);
    assert.ok(checkArtifacts(root, [], true).failures.some(issue => issue.source === '../../worker/adapter.ts'));
    writeFileSync(join(root, 'index.js.map'), JSON.stringify({ sources: ['../../worker/private-models/adapter.ts'], sourcesContent: ['neutral code'] }));
    assert.ok(checkArtifacts(root).failures.some(issue => issue.issue.includes('private or local-only')));
    assert.deepEqual(boundaryIssues('worker/adapter.ts', Buffer.from(vendor)), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('checks previous blobs even when a private adapter has been deleted from the current tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'public-boundary-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    git('init', '-q');
    git('config', 'user.name', 'Boundary fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    mkdirSync(join(root, 'worker/private-models'), { recursive: true });
    writeFileSync(join(root, 'worker/private-models/adapter.ts'), 'private fixture');
    git('add', 'worker/private-models/adapter.ts');
    git('commit', '-qm', 'Add private fixture');
    git('rm', '-q', 'worker/private-models/adapter.ts');
    writeFileSync(join(root, 'public.ts'), 'generic transport');
    git('add', 'public.ts');
    git('commit', '-qm', 'Remove private fixture');
    assert.equal(checkPublicBoundary(root).failures.length, 0);
    const historical = checkPublicBoundary(root, true);
    assert.ok(historical.failures.some(issue => issue.path === 'worker/private-models/adapter.ts'));
    assert.ok(historical.failures.every(issue => !Object.hasOwn(issue, 'contents')));
    assert.ok(boundaryIssues('worker/adapter.ts', Buffer.from('synthetic-private-marker'), { forbiddenPaths: [], forbiddenContent: ['synthetic-private-marker'] }).length);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
