import { resolve } from 'node:path';

/** Explicit environment selection prevents diagnostics from silently querying production. */
export function parseD1Options(args) {
  const options = { configPath: resolve('wrangler.jsonc'), target: null, database: null, environment: null };
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === '--local' || argument === '--remote') {
      if (options.target) throw new Error('Choose exactly one: --local or --remote');
      options.target = argument;
    } else if (['--config', '--database', '--env'].includes(argument)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${argument} needs a value`);
      if (argument === '--config') options.configPath = resolve(value);
      else if (argument === '--database') options.database = value;
      else options.environment = value;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.target) throw new Error('Choose exactly one: --local or --remote');
  return options;
}

export function configuredD1Target(config, options) {
  const selected = options.environment ? config.env?.[options.environment] : config;
  if (!selected) throw new Error(`Wrangler environment is not configured: ${options.environment}`);
  const database = options.database || selected.d1_databases?.find(item => item.binding === 'DB')?.database_name;
  if (typeof database !== 'string' || !database.trim()) throw new Error('Configure the DB D1 binding database_name in the selected Wrangler configuration, or supply --database.');
  return [database, '--config', options.configPath, options.target, ...(options.environment ? ['--env', options.environment] : [])];
}
