/** node:sqlite names numbered parameters; D1 binds them positionally. Test adapters bridge that difference. */
export function sqliteTestBindings(sql: string, values: unknown[]): never[] {
  const indexes = [...sql.matchAll(/'(?:''|[^'])*'|--[^\n]*|\?(\d+)/g)].flatMap(match => match[1] ? [Number(match[1])] : []);
  return (indexes.length ? [Object.fromEntries(indexes.map(index => [`?${index}`, values[index - 1]]))] : values) as never[];
}
