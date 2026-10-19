import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Site } from '../api';
import { useEscapeDismiss } from '../components/escapeDismiss';
import { classroomPage, go } from '../nav';
import './window.css';

/** The room stays mounted while route-addressable tools share this window. */
export function ClassroomWindow({ site, children, title }: { site: Site; children: ReactNode; title?: string }) {
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => go(classroomPage(site.id)), 160);
    return () => window.clearTimeout(timer);
  }, [closing, site.id]);
  const root = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEscapeDismiss(!closing, root, () => setClosing(true));

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    function onKey(event: KeyboardEvent) {
      const panel = root.current;
      if (!panel || event.defaultPrevented) return;
      // Nested dialogs (including body portals) retain their own keyboard handling.
      if (Array.from(document.querySelectorAll('[role="dialog"], dialog[open]')).some((dialog) => dialog !== panel)) return;
      if (event.key === 'Tab') {
        const controls = Array.from(panel.querySelectorAll<HTMLElement>('a[href], button, input, textarea, select, [tabindex]'))
          .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous?.isConnected) requestAnimationFrame(() => previous.focus());
    };
  }, []);

  return (
    <div className={`classroom-window-layer${closing ? ' closing' : ''}`}>
      <div ref={root} className="classroom-window" role="dialog" aria-modal="true" aria-label={title || `${site.name || site.domain} work panel`}>
        <header className="classroom-window-bar">
          <span className="classroom-window-mark" aria-hidden="true">▦</span>
          <strong>{title || site.name || site.domain}</strong>
          <span className="classroom-window-caption">{title ? site.name || site.domain : 'Workspace'}</span>
          <button ref={close} type="button" className="classroom-window-close" onClick={() => setClosing(true)} aria-label="Close window and return to the classroom" title="Close window and return to the classroom">×</button>
        </header>
        <div className="classroom-window-content">{children}</div>
      </div>
    </div>
  );
}
