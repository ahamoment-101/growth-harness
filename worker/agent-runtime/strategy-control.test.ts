import { describe, expect, it, vi } from 'vitest';
import { stopStrategyResearchRun } from './strategy-control';

function dbFor(status: 'running' | 'ok' | 'failed' | null) {
  const run = vi.fn(async () => ({ success: true }));
  return {
    db: {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first: async () => status ? { status } : null, run })) })),
    },
    run,
  };
}

describe('strategy research Runtime control', () => {
  it('closes a running business run when its Agent Workflow is cancelled', async () => {
    const fixture = dbFor('running');
    await expect(stopStrategyResearchRun(fixture.db as never, 'run-1', 'cancelled')).resolves.toBe('stopped');
    expect(fixture.run).toHaveBeenCalledOnce();
  });

  it('does not overwrite an already completed business run', async () => {
    const fixture = dbFor('ok');
    await expect(stopStrategyResearchRun(fixture.db as never, 'run-1', 'late cancel')).resolves.toBe('already_terminal');
    expect(fixture.run).not.toHaveBeenCalled();
  });
});
