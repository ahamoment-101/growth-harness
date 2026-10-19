import { useMemo, useState } from 'react';
import { useAgent } from 'agents/react';
import type { RuntimeProbeState } from '../../worker/agent-runtime/agent';

export default function AgentRuntimeLab() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [siteId, setSiteId] = useState(params.get('site_id') || '');
  const [activeName, setActiveName] = useState('');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  async function start() {
    if (!siteId.trim()) {
      setError('Please enter the site_id of an existing site');
      return;
    }
    setStarting(true);
    setError('');
    try {
      const response = await fetch('/api/agent-runtime/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: siteId.trim(), agent_id: 'runtime_synthetic' }),
      });
      const data = await response.json() as { error?: string; agent_name?: string };
      if (!response.ok) throw new Error(data.error || 'Launch failed');
      if (!data.agent_name) throw new Error('The server did not return a synthetic Agent instance identity');
      setActiveName(data.agent_name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  }

  return (
    <main style={{ maxWidth: 1040, margin: '40px auto', padding: '0 24px', color: 'var(--text-primary)' }}>
      <p style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>Hidden technical validation page · /agent-runtime-lab</p>
      <h1 style={{ marginTop: 0 }}>General Agent Runtime</h1>
      <p style={{ color: 'var(--text-secondary)' }}>
        One Durable Agent shell that switches identity, context, and tools via agent_id; state is streamed back in real time over WebSocket.
      </p>
      <section style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, margin: '28px 0' }}>
        <input value={siteId} onChange={(event) => setSiteId(event.target.value)} placeholder="Existing site_id" />
        <button type="button" onClick={start} disabled={starting}>{starting ? 'Launching…' : 'Start validation'}</button>
      </section>
      {error ? <p style={{ color: 'var(--danger, #ef4444)' }}>{error}</p> : null}
      {activeName ? <RuntimeProbeConnection activeName={activeName} /> : <p className="empty">After launch, connect to a server-validated synthetic Agent instance.</p>}
    </main>
  );
}

function RuntimeProbeConnection({ activeName }: { activeName: string }) {
  const agent = useAgent<RuntimeProbeState>({ agent: 'AgentRuntimeProbe', name: activeName });
  const state = agent.state;
  return (
    <>
      <section style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 20 }}>
        <div className="card" style={{ padding: 20 }}>
          <p>Connection:{agent.readyState === WebSocket.OPEN ? 'Live online' : 'Connecting'}</p>
          <p>Instance:{activeName}</p>
          <p>Status:{state?.status || 'idle'}</p>
          <p>Phase:{state?.phase || 'idle'}</p>
          <p>Workflow: {state?.workflow_id || '—'}</p>
          {state?.error ? <p style={{ color: 'var(--danger, #ef4444)' }}>{state.error}</p> : null}
        </div>
        <div className="card" style={{ padding: 20 }}>
          <h2 style={{ marginTop: 0 }}>Tool execution trace</h2>
          {!state?.tool_events.length ? <p className="empty">Waiting for tool events…</p> : (
            <ol>
              {state.tool_events.map((event, index) => (
                <li key={`${event.at}-${index}`} style={{ marginBottom: 10 }}>
                  <code>{event.tool}</code> · {event.phase}<br />
                  <small style={{ color: 'var(--text-secondary)' }}>{event.detail}</small>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
      {state?.result ? <pre style={{ whiteSpace: 'pre-wrap', marginTop: 20 }}>{state.result}</pre> : null}
    </>
  );
}
