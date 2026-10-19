import { useEffect, useRef, useState } from 'react';

/** Cursor pagination for one list; the caller remounts (via key) when the list identity changes. */
export function usePages<T>(fetchPage: (after?: string) => Promise<{ items: T[]; next: string | null }>) {
  const [items, setItems] = useState<T[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const active = useRef(false);
  const busy = useRef(false);
  async function load(after?: string) {
    if (busy.current) return;
    busy.current = true; setLoading(true); setError('');
    try {
      const page = await fetchPage(after);
      if (active.current) { setItems(prior => after ? [...prior, ...page.items] : page.items); setNext(page.next); }
    } catch (cause) {
      if (active.current) setError((cause as Error).message);
    } finally {
      busy.current = false;
      if (active.current) setLoading(false);
    }
  }
  useEffect(() => { active.current = true; void load(); return () => { active.current = false; }; }, []);
  return { items, next, loading, error, more: () => load(next || undefined), retry: () => load(items.length ? next || undefined : undefined) };
}

/** Reads every page of a small list (groups, clusters). Stops at `limit` pages and reports whether more remained. */
export async function readAll<T>(fetchPage: (after?: string) => Promise<{ items: T[]; next: string | null }>, limit = 20) {
  const items: T[] = [];
  let after: string | undefined;
  for (let i = 0; i < limit; i++) {
    const page = await fetchPage(after);
    items.push(...page.items);
    if (!page.next) return { items, truncated: false };
    after = page.next;
  }
  return { items, truncated: true };
}
