import type { CSSProperties, ReactNode } from 'react';
import type { AgentBubble, BubbleKind } from '../../shared/team-status';
import { bubbleText } from './bubble-copy';

const glyph = (d: ReactNode) => (
  <svg className="bubble-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
);

/** One monochrome icon per kind; the bubble itself carries no color. */
const ICONS: Record<BubbleKind, ReactNode> = {
  needs_you: glyph(<><path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V10" /><path d="M12 9.5a1.5 1.5 0 0 1 3 0V11" /><path d="M15 10.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-.6a6 6 0 0 1-4.8-2.4L4.4 15.3a1.5 1.5 0 0 1 2.3-1.9L9 15.5" /></>),
  stuck: glyph(<><path d="M10.3 4.2 2.8 17.3A2 2 0 0 0 4.5 20.3h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" /><path d="M12 9.5v4M12 17h.01" /></>),
  waiting_on_teammate: glyph(<><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" /><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 14.3a5.5 5.5 0 0 1 3 5.2" /></>),
  waiting_external: glyph(<><path d="M6.5 3.5h11M6.5 20.5h11" /><path d="M7.5 3.5v2.8a4.5 4.5 0 0 0 2 3.7L12 12l-2.5 2a4.5 4.5 0 0 0-2 3.7v2.8M16.5 3.5v2.8a4.5 4.5 0 0 1-2 3.7L12 12l2.5 2a4.5 4.5 0 0 1 2 3.7v2.8" /></>),
  working: glyph(<path className="bubble-spin" d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" />),
  just_done: glyph(<><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12.2 2.3 2.3 4.7-4.9" /></>),
};

export function StatusBubble({ bubble, names, style }: { bubble: AgentBubble; names: (agentId: string) => string; style?: CSSProperties }) {
  const text = bubbleText(bubble, names);
  return (
    <span className={`status-bubble ${bubble.kind}`} style={style} role="status" aria-label={text}>
      {ICONS[bubble.kind]}
      <span className="bubble-text">{text}</span>
      {/* Just-done results stay until someone opens the Agent. */}
      {bubble.kind === 'just_done' ? <i className="bubble-unread" aria-hidden /> : null}
    </span>
  );
}
