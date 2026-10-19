import { describe, expect, it } from 'vitest';
import { agentTransportOriginError, unsafeOriginError } from './origin';

describe('application origin policy', () => {
  it('rejects cross-origin state changes and accepts same-origin requests', () => {
    expect(unsafeOriginError(new Request('https://console.example/api/sites', {
      method: 'POST', headers: { Origin: 'https://evil.example' },
    }))).toContain('cross-origin');
    expect(unsafeOriginError(new Request('https://console.example/api/sites', {
      method: 'POST', headers: { Origin: 'https://console.example' },
    }))).toBe('');
  });

  it('requires an explicit same-origin Origin for WebSocket upgrades', () => {
    expect(agentTransportOriginError(new Request('https://console.example/agents/agent-shell/name', {
      headers: { Upgrade: 'websocket' },
    }))).toBe('WebSocket Origin is required');
    expect(agentTransportOriginError(new Request('https://console.example/agents/agent-shell/name', {
      headers: { Upgrade: 'websocket', Origin: 'https://console.example' },
    }))).toBe('');
    expect(agentTransportOriginError(new Request('https://console.example/agents/agent-shell/name', {
      headers: { Upgrade: 'websocket', Origin: 'https://evil.example' },
    }))).toContain('cross-origin');
  });
});
