/** Blog page layout templates. Keys are persisted on sites.blog_layout and read by the public renderer. */

export type BlogLayoutKey = 'magazine';

export type BlogLayoutDef = {
  key: BlogLayoutKey;
  name: string;
  description: string;
};

export const DEFAULT_BLOG_LAYOUT: BlogLayoutKey = 'magazine';

export const BLOG_LAYOUTS: BlogLayoutDef[] = [
  {
    key: 'magazine',
    name: 'Magazine card',
    description: 'Cards display title, excerpt, and date in a grid, with the latest post enlarged as the headline card.',
  },
];

const BLOG_LAYOUT_KEYS = new Set<string>(BLOG_LAYOUTS.map((l) => l.key));

export function isBlogLayoutKey(value: string): value is BlogLayoutKey {
  return BLOG_LAYOUT_KEYS.has(value);
}

export function blogLayoutDef(key: string): BlogLayoutDef {
  return BLOG_LAYOUTS.find((l) => l.key === key) ?? BLOG_LAYOUTS[0];
}

/** Validates an incoming layout value; anything unknown falls back instead of erroring. */
export function normalizeBlogLayout(value: unknown, fallback: BlogLayoutKey = DEFAULT_BLOG_LAYOUT): BlogLayoutKey {
  if (typeof value !== 'string') return fallback;
  const key = value.trim();
  return isBlogLayoutKey(key) ? key : fallback;
}
