import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, realpathSync, copyFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const source = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
if (existsSync(resolve(source, '.public-core-sync.json'))) throw new Error('Run synchronization from the upstream checkout; downstream-to-upstream copying is not supported');
const args = process.argv.slice(2);
const targetArg = args.indexOf('--target');
if (targetArg < 0 || !args[targetArg + 1]) throw new Error('Provide --target /path/to/downstream and --check or --apply');
const targetPath = resolve(args[targetArg + 1]);
if (!existsSync(resolve(targetPath, '.git'))) throw new Error('Target must be a separate Git checkout');
const target = realpathSync(targetPath);
if (target === source) throw new Error('Target must be a separate Git checkout');
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
// Historical distribution-specific model defaults remain owned by each checkout.
const exclusions = new Set(['shared/config/model-extensions.ts', 'worker/lib/model-extensions.ts', 'migrations/0001_init.sql', 'migrations/0028_fix_agent_model_configuration.sql']);
const folders = ['worker', 'shared', 'packs', 'src', 'migrations'];
const sharedFiles = ['index.html', 'worker-configuration.d.ts', 'vite.config.ts', 'scripts/configuration.ts', 'scripts/config-check.ts', 'scripts/deploy-check.ts', 'scripts/secrets-upload.ts', 'scripts/setup.ts', 'scripts/auth-reset.ts', 'scripts/sanitize-build.mjs', 'scripts/sanitize-build.test.mjs', 'scripts/collect-license-notices.mjs', 'scripts/runtime-fixture-capabilities.mjs', 'scripts/sync-public-core.mjs', 'scripts/sync-public-core.test.mjs', 'scripts/d1-target.mjs', 'scripts/d1-target.test.mjs', 'scripts/d1-migrate.ts', 'scripts/report-agent-requests.mjs'];
const files = [...new Set(git(source, 'ls-files', '--cached', '--others', '--exclude-standard', '--', ...folders, ...sharedFiles).split('\n'))]
  .filter(path => path && !exclusions.has(path) && !path.startsWith('worker/private-models/') && existsSync(resolve(source, path)));
const hash = path => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
const statePath = resolve(target, '.public-core-sync.json');
// Metadata and package writes need the same protection as managed source files.
assertNoSymlinks(source, 'package.json');
assertNoSymlinks(target, 'package.json');
assertNoSymlinks(target, '.public-core-sync.json');
const previous = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
const previousFiles = Array.isArray(previous?.files)
  ? Object.fromEntries(previous.files.map(file => [file.path, file.sha256])) : previous?.files || {};
const conflicts = [];
const changes = [];
const removed = [];
function assertNoSymlinks(root, path) {
  let current = root;
  for (const part of path.split('/')) {
    current = resolve(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Core synchronization does not follow symbolic links');
  }
}
for (const path of files) {
  if (path.startsWith('/') || relative(source, resolve(source, path)).startsWith('..')) throw new Error('Invalid core path');
  const from = resolve(source, path), to = resolve(target, path);
  assertNoSymlinks(source, path);
  assertNoSymlinks(target, path);
  if (lstatSync(from).isSymbolicLink() || (existsSync(to) && lstatSync(to).isSymbolicLink())) throw new Error('Core synchronization does not follow symbolic links');
  const sourceHash = hash(from), targetHash = hash(to);
  if (sourceHash === targetHash) continue;
  changes.push(path);
  if (previous && targetHash !== (previousFiles[path] ?? null)) conflicts.push(path);
}
for (const path of Object.keys(previousFiles)) {
  if (files.includes(path) || exclusions.has(path)) continue;
  if (path.startsWith('/') || relative(target, resolve(target, path)).startsWith('..')) throw new Error('Invalid recorded core path');
  assertNoSymlinks(target, path);
  const value = hash(resolve(target, path));
  if (value === null) continue;
  if (value !== previousFiles[path]) conflicts.push(path);
  else removed.push(path);
}
const sourcePackage = JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8'));
const targetPackage = JSON.parse(readFileSync(resolve(target, 'package.json'), 'utf8'));
for (const field of ['dependencies', 'devDependencies', 'overrides', 'engines']) targetPackage[field] = { ...targetPackage[field], ...sourcePackage[field] };
for (const [name, command] of Object.entries(sourcePackage.scripts)) {
  if (name === 'release:check') continue; // The private distribution intentionally contains private material.
  if (name === 'build' || name === 'test' || name === 'core:sync' || name.startsWith('db:migrate:') || !targetPackage.scripts[name]) targetPackage.scripts[name] = command;
}
const packageChanged = JSON.stringify(targetPackage, null, 2) + '\n' !== readFileSync(resolve(target, 'package.json'), 'utf8');
if (conflicts.length) throw new Error('Downstream core edits need reconciliation: ' + conflicts.join(', '));
console.log(JSON.stringify({ source, target, files: files.length, changed: changes.length, removed: removed.length, packageChanged, mode: args.includes('--apply') ? 'apply' : 'check', paths: changes.slice(0, 20) }, null, 2));
if (!args.includes('--apply')) { if (changes.length || removed.length || packageChanged) process.exitCode = 1; }
else {
  if (!previous && !args.includes('--initialize')) throw new Error('First synchronization needs --initialize after reviewing the change list');
  if (!previous) {
    const dirty = git(target, 'diff', '--name-only', 'HEAD', '--', ...files);
    if (dirty) throw new Error('Initial synchronization requires clean tracked core files: ' + dirty);
    const untracked = changes.length ? git(target, 'ls-files', '--others', '--exclude-standard', '--', ...changes) : '';
    if (untracked) throw new Error('Initial synchronization would overwrite untracked core files: ' + untracked);
  }
  for (const path of changes) { const to = resolve(target, path); mkdirSync(dirname(to), { recursive: true }); copyFileSync(resolve(source, path), to); }
  for (const path of removed) unlinkSync(resolve(target, path));
  if (packageChanged) writeFileSync(resolve(target, 'package.json'), JSON.stringify(targetPackage, null, 2) + '\n');
  // Keep filenames separate from digests so credential scanners do not mistake
  // a path containing "password" or "key" followed by a digest for a secret.
  writeFileSync(statePath, JSON.stringify({ version: 2, upstream: git(source, 'remote', 'get-url', 'origin'), commit: git(source, 'rev-parse', 'HEAD'),
    files: files.map(path => ({ path, sha256: hash(resolve(source, path)) })) }, null, 2) + '\n');
  console.log('Shared core synchronized. Distribution extensions and deployment configuration were preserved. Install dependencies and run both checkouts tests/builds.');
}
