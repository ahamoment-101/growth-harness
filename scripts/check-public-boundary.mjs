import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { basename, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const policyPath = 'scripts/public-distribution-policy.json';
const policy = JSON.parse(readFileSync(new URL('./public-distribution-policy.json', import.meta.url), 'utf8'));
const exportPolicy = {
  ...policy,
  forbiddenPaths: [...policy.forbiddenPaths, ...policy.exportOnlyPaths],
  forbiddenContent: [...policy.forbiddenContent, ...policy.exportOnlyContent],
};

/** This is a distribution boundary check; credential detection runs separately with Gitleaks. */
export function boundaryIssues(path, contents, rules = policy, privateMarkers = []) {
  const issues = [];
  const name = basename(path);
  if (rules.forbiddenPaths.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'))) {
    issues.push('private or local-only path');
  }
  if ((name === '.env' || name.startsWith('.env.') || name === '.dev.vars' || name.startsWith('.dev.vars.')) && !name.endsWith('.example')) {
    issues.push('environment file');
  }
  if ((rules.forbiddenExtensions || []).includes(extname(name).toLowerCase())) issues.push('private data or credential container');
  // This exact public policy contains forbidden identifiers as rule definitions, never credentials.
  if (path !== policyPath && rules.forbiddenContent.some(value => contents.toString('utf8').toLowerCase().includes(value.toLowerCase()))) {
    issues.push('private implementation or internal material');
  }
  // Private identifiers are supplied by the maintainer from outside the release.
  // Never copy production identifiers or matched values into this public policy.
  if (privateMarkers.some(value => contents.includes(Buffer.from(value)))) issues.push('private configuration value or operational identifier');
  return issues;
}

export function checkPublicBoundary(root, history = false, privateMarkers = [], maintainerExport = history) {
  const rules = maintainerExport ? exportPolicy : policy;
  const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 128 * 1024 * 1024 });
  const failures = [];
  let scanned = 0;
  const inspect = (path, contents, revision) => {
    scanned++;
    for (const issue of boundaryIssues(path, contents, rules, privateMarkers)) failures.push({ path, issue, ...(revision ? { revision } : {}) });
  };
  if (history) {
    const seen = new Set();
    for (const commit of git(['rev-list', '--all']).toString().trim().split('\n').filter(Boolean)) {
      for (const entry of git(['ls-tree', '-rz', commit]).toString().split('\0').filter(Boolean)) {
        const tab = entry.indexOf('\t');
        const [, type, object] = entry.slice(0, tab).split(' ');
        const path = entry.slice(tab + 1), identity = path + '\0' + object;
        if (type !== 'blob' || seen.has(identity)) continue;
        seen.add(identity);
        inspect(path, git(['cat-file', 'blob', object]), commit);
      }
    }
  } else {
    const files = new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean));
    for (const path of files) if (existsSync(resolve(root, path))) {
      if (!lstatSync(resolve(root, path)).isFile()) { failures.push({ path, issue: 'release entries must be regular files' }); continue; }
      inspect(path, readFileSync(resolve(root, path)));
    }
  }
  return { scanned, failures };
}

export function checkArtifacts(directory, privateMarkers = [], maintainerExport = false) {
  const rules = maintainerExport ? exportPolicy : policy;
  if (!existsSync(directory)) throw new Error('Build artifacts do not exist; build before checking artifacts');
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Build artifacts must be a regular directory');
  const failures = [];
  let scanned = 0;
  function walk(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = resolve(folder, entry.name), name = relative(directory, path);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile()) { failures.push({ path: name, issue: 'artifact entries must be regular files' }); continue; }
      scanned++;
      const bytes = readFileSync(path);
      // Public vendor domains in upstream SDK compatibility code are not private
      // project adapters. Project source is still checked without this exception,
      // including source-map content below. Credential markers have no exception.
      const artifactPolicy = { ...rules, forbiddenContent: rules.forbiddenContent.filter(value => !(rules.thirdPartyArtifactContent || []).includes(value)) };
      for (const issue of boundaryIssues(name, bytes, artifactPolicy, privateMarkers)) failures.push({ path: name, issue });
      if (name.endsWith('.map')) {
        const map = JSON.parse(bytes.toString('utf8'));
        for (let index = 0; index < (map.sources || []).length; index++) {
          const source = map.sources[index].replaceAll('\\', '/');
          if (source.split('/').includes('node_modules') || typeof map.sourcesContent?.[index] !== 'string') continue;
          const projectPath = source.replace(/^(?:\.\.?\/)+/, '');
          for (const issue of boundaryIssues(projectPath, Buffer.from(map.sourcesContent[index]), rules, privateMarkers)) failures.push({ path: name, source, issue });
        }
      }
      if ((policy.forbiddenArtifactContent || []).some(value => bytes.includes(Buffer.from(value)))) failures.push({ path: name, issue: 'development demonstration in production artifact' });
    }
  }
  walk(directory);
  if (!scanned) throw new Error('No build artifacts found');
  return { scanned, failures };
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const valueAfter = flag => { const index = args.indexOf(flag); if (index < 0) return null; if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Missing value for ' + flag); return args[index + 1]; };
  const markerPath = valueAfter('--private-markers');
  const privateMarkers = markerPath ? JSON.parse(readFileSync(resolve(markerPath), 'utf8')) : [];
  if (!Array.isArray(privateMarkers) || privateMarkers.some(value => typeof value !== 'string' || value.length < 8)) throw new Error('Private markers must be a JSON array of nonempty identifiers with at least eight characters');
  const artifacts = valueAfter('--artifacts');
  // Export policy is an explicit maintainer check, including when reviewing history.
  const maintainerExport = args.includes('--export') || args.includes('--history');
  const result = artifacts ? checkArtifacts(resolve(artifacts), privateMarkers, maintainerExport) : checkPublicBoundary(process.cwd(), args.includes('--history'), privateMarkers, maintainerExport);
  if (result.failures.length) {
    // Print paths and categories only; never print matched source or possible credentials.
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } else console.log(`Public distribution boundary passed (${result.scanned} file versions checked).`);
}
