import { go } from '../nav';
import './StudioNavLeft.css';

export function StudioNavLeft({
  title,
  backTo,
}: {
  title: string;
  backTo: string;
}) {
  return (
    <div className="ia-nav-left">
      <button className="ia-back-chat-btn" type="button" onClick={() => go(backTo)}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        <span>Back</span>
      </button>
      <span className="ia-nav-title">{title}</span>
    </div>
  );
}
