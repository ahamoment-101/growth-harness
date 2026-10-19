import { useEffect, useState } from 'react';
import { api, type Site } from '../api';
import type { SiteLedgerResponse } from '../../shared/site-ledger';
import { go, sitePage } from '../nav';
import { Icon } from './ui';

function enterWorkbench(site: Site) {
  const target = sitePage(site.id);
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  if (doc.startViewTransition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) doc.startViewTransition(() => go(target)).ready.catch(() => undefined);
  else go(target);
}

export function LedgerScreen({ site }: { site: Site }) {
  const [state, setState] = useState<{ siteId: string; data: SiteLedgerResponse | null; error: boolean }>({ siteId: site.id, data: null, error: false });
  useEffect(() => {
    let live = true;
    let timer: number;
    async function load() {
      let delay = 60000;
      try {
        if (document.hidden) return;
        const data = await api.siteLedger(site.id);
        if (!live) return;
        setState({ siteId: site.id, data, error: false });
        if (data.refreshing) delay = 3000;
      } catch {
        if (live) setState(previous => ({ siteId: site.id, data: previous.siteId === site.id ? previous.data : null, error: true }));
      } finally {
        if (live) timer = window.setTimeout(load, delay);
      }
    }
    void load();
    return () => { live = false; window.clearTimeout(timer); };
  }, [site.id]);
  const data = state.siteId === site.id ? state.data : null;
  const snapshot = data?.snapshot;
  const unavailable = state.siteId === site.id && (state.error || data?.refresh_failed);
  const number = (n: number | undefined) => n === undefined ? '—' : n.toLocaleString('en-US');
  const assets = [
    { label: 'Strategy Documents', value: number(snapshot?.strategies.total), unit: ' docs', added: snapshot?.strategies.yesterday },
    { label: 'Research Documents', value: number(snapshot?.research.total), unit: ' docs', added: snapshot?.research.yesterday },
    { label: 'Keyword Library', value: number(snapshot?.keywords.total), unit: ' keywords', added: snapshot?.keywords.yesterday },
    { label: 'Confirmed Topics', value: number(snapshot?.topics.total), unit: ' sets', added: snapshot?.topics.yesterday },
    { label: 'Languages Covered', value: number(snapshot?.languages), unit: ' languages' },
    { label: 'Sitemap', value: snapshot ? { submitted: 'Submitted', error: 'Submission Failed', not_submitted: 'Not Submitted' }[snapshot.sitemap] : '—', unit: '' },
  ];
  const updated = snapshot ? new Date(snapshot.computed_at).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  return <button type="button" className="big-screen main" onClick={() => enterWorkbench(site)} aria-label="Produced for you — go to the workspace">
    <span className="screen-glass ledger-screen">
      <span className="ledger-head">Produced for you</span>
      <span className="ledger-freshness">{snapshot ? `${updated} updated ${unavailable ? ' · Update failed' : data?.refreshing ? ' · Updating' : ''}` : unavailable ? 'Stats unavailable' : 'Gathering stats…'}</span>
      <span className="ledger-body">
        <span className="ledger-hero">
          <span className="ledger-hero-label">Published Articles</span>
          <span className="ledger-hero-value"><b>{number(snapshot?.published.total)}</b>articles</span>
          <span className="ledger-added" title="Added yesterday Beijing time; hidden articles are not counted">{snapshot ? `Yesterday +${number(snapshot.published.yesterday)}` : 'Yesterday —'}</span>
        </span>
        <span className="ledger-assets">{assets.map(asset => <span key={asset.label} className="ledger-asset">
          <span className="ledger-asset-label">{asset.label}</span>
          <span className={`ledger-asset-value${asset.label === 'Sitemap' ? ' ledger-sitemap' : ''}`}><b>{asset.value}</b>{asset.unit}{!!asset.added && <em title="Added Yesterday (Beijing Time)">Yesterday +{asset.added}</em>}</span>
        </span>)}</span>
      </span>
      <span className="ledger-search" title={snapshot?.search ? `Data range: ${snapshot.search.from} to ${snapshot.search.through}; synced at ${snapshot.search.synced_at}` : 'No Google Search Console data available yet'}>
        <span>{snapshot?.search ? `7-day search · as of ${snapshot.search.through.slice(5)}` : 'Search performance · No data yet'}</span>
        <span>Impressions <b>{number(snapshot?.search?.impressions)}</b></span>
        <span>Clicks <b>{number(snapshot?.search?.clicks)}</b></span>
        <span className="ledger-source">GSC</span>
      </span>
      <span className="screen-enter">Go to workspace{Icon.arrow}</span>
    </span>
  </button>;
}
