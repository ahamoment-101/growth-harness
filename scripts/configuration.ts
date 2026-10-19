import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parseEnv } from 'node:util';
import ts from 'typescript';
import { inspectConfiguration } from '../shared/config/index.ts';

export function readWrangler(path = resolve('wrangler.jsonc')): Record<string, any> {
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'));
  if (parsed.error) throw new Error('Invalid wrangler.jsonc: check JSONC syntax');
  return parsed.config;
}

export function readVars(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try { return Object.fromEntries(Object.entries(parseEnv(readFileSync(path, 'utf8'))).filter((entry): entry is [string, string] => typeof entry[1] === 'string')); }
  catch { throw new Error('Cannot parse local environment file. Check assignment and quote syntax; values are not logged.'); }
}

export function localConfiguration(path = resolve('wrangler.jsonc'), envFile = resolve(dirname(path), '.dev.vars')) {
  const config = readWrangler(path);
  return { config, env: { ...config.vars, ...readVars(envFile) } };
}

export function checkLocalConfiguration(requireModels = false, path?: string) {
  const { env } = localConfiguration(path);
  const report = inspectConfiguration(env, requireModels);
  if (report.errors.length) throw new Error(report.errors.map(issue => issue.message).join('\n'));
  return report;
}
