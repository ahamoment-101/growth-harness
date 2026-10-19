import { describe, expect, it, vi } from 'vitest';
import { disposeRpcResource } from './rpc-resource';

describe('RPC resource disposal', () => {
  it('releases disposable RPC handles', () => {
    const dispose = vi.fn();
    const disposeSymbol = (Symbol as unknown as { dispose: symbol }).dispose;
    disposeRpcResource({ [disposeSymbol]: dispose });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('does not let cleanup failure replace a completed business operation', () => {
    const disposeSymbol = (Symbol as unknown as { dispose: symbol }).dispose;
    expect(() => disposeRpcResource({
      [disposeSymbol]: () => { throw new Error('connection already closed'); },
    })).not.toThrow();
  });
});
