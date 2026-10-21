import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Migrations up to this number shipped as the 0.1.0 baseline and are summarized there.
export const BASELINE_MIGRATION = 81;

/** Migrations after the baseline must be named in CHANGELOG.md so upgraders see them. */
export function unlistedMigrations(migrationFiles, changelog) {
  return migrationFiles
    .filter(name => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) > BASELINE_MIGRATION)
    .filter(name => !changelog.includes(name))
    .sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const missing = unlistedMigrations(readdirSync('migrations'), readFileSync('CHANGELOG.md', 'utf8'));
  if (missing.length) {
    console.error('Add these migrations to the Upgrade notes in CHANGELOG.md:\n' + missing.map(name => '  - ' + name).join('\n'));
    process.exit(1);
  }
  console.log('Changelog lists every migration after the 0.1.0 baseline.');
}
