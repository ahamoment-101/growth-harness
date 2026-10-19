export function disposeRpcResource(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const disposeSymbol = (Symbol as unknown as { dispose?: symbol }).dispose;
  if (!disposeSymbol) return;
  const dispose = (value as Record<symbol, unknown>)[disposeSymbol];
  if (typeof dispose !== 'function') return;
  try {
    dispose.call(value);
  } catch (error) {
    console.warn(`[agent-runtime] RPC resource disposal failed: ${String(error).slice(0, 300)}`);
  }
}
