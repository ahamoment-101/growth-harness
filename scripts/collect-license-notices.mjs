import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = join(process.cwd(), 'dist');
const directories = readdirSync(root).filter(name => existsSync(join(root, name, '.vite/license.md')));
if (!directories.includes('client') || directories.length < 2) throw new Error('Expected browser and Worker dependency notices; keep build.license enabled');
const text = [readFileSync('THIRD_PARTY_NOTICES.md', 'utf8'), ...directories.sort().map(name =>
  `\n# ${name} bundle\n\n${readFileSync(join(root, name, '.vite/license.md'), 'utf8')}`)].join('\n');
writeFileSync(join(root, 'client/THIRD_PARTY_LICENSES.txt'), text);
console.log('Collected browser and Worker dependency notices for distribution');
