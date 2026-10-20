import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, unlinkSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const original = resolve(dirname(fileURLToPath(import.meta.url)), 'sync-public-core.mjs');
test('synchronizes shared changes and deletions while preserving private files and refusing conflicting edits', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'core-sync-'));
  const source = resolve(root, 'upstream'), target = resolve(root, 'downstream');
  const write = (base, path, value) => { const file = resolve(base, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  try {
    for (const [base, name] of [[source, 'public-package'], [target, 'private-package']]) {
      mkdirSync(base);
      git(base, 'init', '--quiet', '--initial-branch=main');
      git(base, 'remote', 'add', 'origin', 'https://example.invalid/' + name + '.git');
      write(base, 'package.json', JSON.stringify({ name, scripts: {}, dependencies: {}, devDependencies: {}, engines: {}, overrides: {} }, null, 2) + '\n');
      write(base, 'worker/core.ts', 'export const version = 1;\n');
      write(base, 'index.html', '<main>Shared console</main>\n');
      write(base, 'migrations/0100_shared.sql', '-- shared schema fixture\n');
      write(base, 'migrations/0001_init.sql', name + ' historical model default');
      write(base, 'shared/config/model-extensions.ts', name + ' extension');
      write(base, '.gitignore', '.dev.vars\n');
      write(base, '.dev.vars', name + '-credential-sentinel');
      git(base, 'add', '.');
      git(base, '-c', 'user.name=Core Sync Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--no-gpg-sign', '-m', 'Initialize isolated test');
    }
    mkdirSync(resolve(source, 'scripts')); copyFileSync(original, resolve(source, 'scripts/sync-public-core.mjs'));
    const invoke = (...flags) => spawnSync(process.execPath, [resolve(source, 'scripts/sync-public-core.mjs'), '--target', target, ...flags], { encoding: 'utf8' });
    assert.equal(invoke('--apply', '--initialize').status, 0);
    const manifestPath = resolve(target, '.public-core-sync.json');
    const manifest = JSON.parse(readFileSync(manifestPath));
    assert.equal(manifest.version, 2);
    assert.ok(manifest.files.every(file => typeof file.path === 'string' && /^[a-f0-9]{64}$/.test(file.sha256)));
    assert.equal(existsSync(resolve(target, 'scripts/sync-public-core.mjs')), false);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: 1, files: Object.fromEntries(manifest.files.map(file => [file.path, file.sha256])) }));
    assert.equal(invoke('--check').status, 0, 'Legacy digest maps retain conflict protection');
    assert.equal(invoke('--apply').status, 0);
    assert.ok(Array.isArray(JSON.parse(readFileSync(manifestPath)).files));
    assert.equal(readFileSync(resolve(target, 'shared/config/model-extensions.ts'), 'utf8'), 'private-package extension');
    assert.equal(readFileSync(resolve(target, '.dev.vars'), 'utf8'), 'private-package-credential-sentinel');
    assert.equal(JSON.parse(readFileSync(resolve(target, 'package.json'))).name, 'private-package');
    assert.equal(readFileSync(resolve(target, 'migrations/0001_init.sql'), 'utf8'), 'private-package historical model default');
    write(source, 'index.html', '<main>Updated shared console</main>\n');
    write(source, 'migrations/0100_shared.sql', '-- updated shared schema fixture\n');
    assert.equal(invoke('--apply').status, 0);
    assert.equal(readFileSync(resolve(target, 'index.html'), 'utf8'), '<main>Updated shared console</main>\n');
    assert.equal(readFileSync(resolve(target, 'migrations/0100_shared.sql'), 'utf8'), '-- updated shared schema fixture\n');
    assert.equal(readFileSync(resolve(target, 'migrations/0001_init.sql'), 'utf8'), 'private-package historical model default');
    write(source, 'worker/core.ts', 'export const version = 2;\n');
    write(target, 'worker/core.ts', 'downstream edit');
    const conflict = invoke('--apply');
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /reconciliation/);
    assert.equal(readFileSync(resolve(target, 'worker/core.ts'), 'utf8'), 'downstream edit');
    write(target, 'worker/core.ts', 'export const version = 1;\n');
    assert.equal(invoke('--apply').status, 0);
    assert.equal(readFileSync(resolve(target, 'worker/core.ts'), 'utf8'), 'export const version = 2;\n');
    unlinkSync(resolve(source, 'worker/core.ts'));
    assert.equal(invoke('--apply').status, 0);
    assert.throws(() => readFileSync(resolve(target, 'worker/core.ts')));
    assert.equal(invoke('--check').status, 0);
    write(source, '.public-core-sync.json', '{}');
    const reverse = invoke('--apply');
    assert.notEqual(reverse.status, 0);
    assert.match(reverse.stderr, /upstream checkout/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('retires unchanged legacy tooling and commands while protecting modified copies and custom commands', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'core-sync-retirement-'));
  const source = resolve(root, 'upstream'), target = resolve(root, 'downstream');
  const write = (base, path, value) => { const file = resolve(base, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const commands = {
    'core:sync': 'node scripts/sync-public-core.mjs',
    'test:sync': 'node --test scripts/sync-public-core.test.mjs',
    'verify:strategy:workflow:local': 'node scripts/verify-strategy-workflow-local.mjs',
  };
  const legacyFiles = ['scripts/sync-public-core.mjs', 'scripts/sync-public-core.test.mjs'];
  try {
    for (const base of [source, target]) {
      mkdirSync(base);
      git(base, 'init', '--quiet', '--initial-branch=main');
      git(base, 'remote', 'add', 'origin', 'https://example.invalid/fixture.git');
      write(base, 'package.json', JSON.stringify({ scripts: commands, dependencies: {}, devDependencies: {}, engines: {}, overrides: {} }, null, 2) + '\n');
      write(base, 'worker/core.ts', 'export const version = 1;\n');
      git(base, 'add', '.');
      git(base, '-c', 'user.name=Core Sync Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--no-gpg-sign', '-m', 'Initialize isolated test');
    }
    write(source, legacyFiles[0], readFileSync(original));
    const legacyContents = 'legacy synchronized tool\n';
    for (const path of legacyFiles) write(target, path, legacyContents);
    const manifestPath = resolve(target, '.public-core-sync.json');
    const manifest = JSON.stringify({ version: 2, files: legacyFiles.map(path => ({ path, sha256: createHash('sha256').update(legacyContents).digest('hex') })) });
    writeFileSync(manifestPath, manifest);
    const invoke = (...flags) => spawnSync(process.execPath, [resolve(source, legacyFiles[0]), '--target', target, ...flags], { encoding: 'utf8' });

    write(target, legacyFiles[1], 'downstream customizations\n');
    assert.notEqual(invoke('--apply').status, 0);
    assert.equal(readFileSync(resolve(target, legacyFiles[1]), 'utf8'), 'downstream customizations\n');
    assert.equal(readFileSync(resolve(target, legacyFiles[0]), 'utf8'), legacyContents);
    assert.equal(readFileSync(manifestPath, 'utf8'), manifest);
    assert.deepEqual(JSON.parse(readFileSync(resolve(target, 'package.json'))).scripts, commands);

    write(target, legacyFiles[1], legacyContents);
    const customized = JSON.parse(readFileSync(resolve(target, 'package.json')));
    customized.scripts['test:sync'] = 'node custom-downstream-check.mjs';
    write(target, 'package.json', JSON.stringify(customized, null, 2) + '\n');
    assert.equal(invoke('--apply').status, 0);
    for (const path of legacyFiles) assert.equal(existsSync(resolve(target, path)), false);
    assert.deepEqual(JSON.parse(readFileSync(resolve(target, 'package.json'))).scripts, { 'test:sync': 'node custom-downstream-check.mjs' });
    assert.ok(JSON.parse(readFileSync(manifestPath)).files.every(file => !legacyFiles.includes(file.path)));
    assert.equal(invoke('--check').status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('rejects an alias of upstream and symlinked package or synchronization metadata', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'core-sync-path-safety-'));
  const source = resolve(root, 'upstream'), target = resolve(root, 'downstream');
  const write = (base, path, value) => { const file = resolve(base, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const packageJson = JSON.stringify({ scripts: {}, dependencies: {}, devDependencies: {}, engines: {}, overrides: {} });
  try {
    for (const base of [source, target]) {
      mkdirSync(base);
      git(base, 'init', '--quiet', '--initial-branch=main');
      git(base, 'remote', 'add', 'origin', 'https://example.invalid/fixture.git');
      write(base, 'package.json', packageJson);
      write(base, 'worker/core.ts', 'export const core = 1;');
      git(base, 'add', '.');
      git(base, '-c', 'user.name=Core Sync Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--no-gpg-sign', '-m', 'Initialize isolated test');
    }
    write(source, 'scripts/sync-public-core.mjs', readFileSync(original));
    const invoke = destination => spawnSync(process.execPath, [resolve(source, 'scripts/sync-public-core.mjs'), '--target', destination, '--apply', '--initialize'], { encoding: 'utf8' });
    const alias = resolve(root, 'upstream-alias');
    symlinkSync(source, alias, 'dir');
    const sameCheckout = invoke(alias);
    assert.notEqual(sameCheckout.status, 0);
    assert.match(sameCheckout.stderr, /separate Git checkout/);
    assert.equal(existsSync(resolve(source, '.public-core-sync.json')), false);

    const outside = resolve(root, 'outside.json');
    writeFileSync(outside, packageJson);
    unlinkSync(resolve(target, 'package.json'));
    symlinkSync(outside, resolve(target, 'package.json'));
    assert.notEqual(invoke(target).status, 0);
    assert.equal(readFileSync(outside, 'utf8'), packageJson);
    unlinkSync(resolve(target, 'package.json'));
    writeFileSync(resolve(target, 'package.json'), packageJson);

    writeFileSync(outside, '{}');
    const state = resolve(target, '.public-core-sync.json');
    symlinkSync(outside, state);
    assert.notEqual(invoke(target).status, 0);
    assert.equal(readFileSync(outside, 'utf8'), '{}');
    unlinkSync(state);
    const notCreated = resolve(root, 'not-created.json');
    symlinkSync(notCreated, state);
    assert.notEqual(invoke(target).status, 0);
    assert.equal(existsSync(notCreated), false);
    assert.equal(existsSync(resolve(target, 'scripts/sync-public-core.mjs')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
