import type { ReactNode } from 'react';

const svg = (d: ReactNode, size = 16) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
);

export const Icon = {
  social: svg(<><circle cx="7" cy="12" r="2.5" /><circle cx="17" cy="6" r="2.5" /><circle cx="17" cy="18" r="2.5" /><path d="m9.2 10.8 5.6-3.4M9.2 13.2l5.6 3.4" /></>),
  x: svg(<path d="M6 6l12 12M18 6 6 18" />),
  arrow: svg(<path d="M5 12h14M13 6l6 6-6 6" />),
  external: svg(<><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>),
};

export function SiteMark({ name, size = 22 }: { name: string; size?: number }) {
  const hue = [...name].reduce((h, c) => h + c.charCodeAt(0), 0) % 360;
  return <span className="site-mark" style={{ width: size, height: size, background: `hsl(${hue} 55% 46%)` }}>{name.slice(0, 1).toUpperCase()}</span>;
}
