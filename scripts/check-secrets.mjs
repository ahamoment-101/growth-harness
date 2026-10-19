// Scan the candidate files as well as all reachable Git history. Never print matches.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
const root = process.cwd();
const binary = process.env.GITLEAKS_BINARY || 'gitleaks';
const directory = mkdtempSync(join(tmpdir(), 'blog-agent-secret-scan-'));
function scan(args) {
  const result = spawnSync(binary, [...args, '--config', resolve(root, '.gitleaks.toml'), '--redact', '--no-banner', '--verbose'], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Credential scan failed; inspect redacted diagnostics');
}
try {
  const files = new Set(execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean));
  for (const file of files) {
    if (!existsSync(file)) continue;
    const target = join(directory, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
  }
  scan(['dir', directory]);
  scan(['git', root, '--log-opts=--all']);
  console.log(`Credential scan passed for candidate and all reachable Git history (${files.size} candidate paths).`);
} finally { rmSync(directory, { recursive: true, force: true }); }
