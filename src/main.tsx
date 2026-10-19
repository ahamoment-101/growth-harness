import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const Root = import.meta.env.DEV && window.location.pathname === '/agent-runtime-lab'
  ? lazy(() => import('./pages/AgentRuntimeLab'))
  : App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<p className="empty">Loading…</p>}>
      <Root />
    </Suspense>
  </StrictMode>,
);
