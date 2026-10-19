import { useEffect, useState } from 'react';
import { api, type Site } from '../api';
import { Shell } from '../components/Shell';
import { Link, sitePage } from '../nav';

type AnalyticsRow = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };
type AnalyticsData = {
  startDate: string;
  endDate: string;
  lastSyncDate: string | null;
  page: number;
  pageSize: number;
  rowCount: number;
  rows: AnalyticsRow[];
  daily: AnalyticsRow[];
};

export default function Seo({ site, sites }: { site: Site; sites: Site[] }) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [err, setErr] = useState('');
  const [syncErr, setSyncErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [dimension, setDimension] = useState<'query' | 'page'>('query');
  const [page, setPage] = useState(1);

  const connected = site.gsc_oauth_status === 'connected';

  function load() {
    setLoading(true);
    setErr('');
    api.gscAnalytics(site.id, { dimension, page })
      .then(setData)
      .catch((e) => setErr(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (!connected) { setLoading(false); return; }
    load();
  }, [site.id, dimension, page, connected]);

  async function handleSync() {
    setSyncing(true);
    setSyncErr('');
    try {
      await api.gscSync(site.id);
      load();
    } catch (e) {
      setSyncErr(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  const totalClicks = data?.daily.reduce((s, r) => s + r.clicks, 0) ?? 0;
  const totalImpressions = data?.daily.reduce((s, r) => s + r.impressions, 0) ?? 0;
  const avgCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
  const avgPosition =
    data && data.daily.length > 0
      ? data.daily.reduce((s, r) => s + r.position * r.impressions, 0) / Math.max(totalImpressions, 1)
      : 0;

  return (
    <Shell
      sites={sites}
      site={site}
      active="seo"
      crumb={
        <>
          <Link className="muted" to={sitePage(site.id)}>Main screen</Link>
          <span className="sep">›</span>
          <Link className="muted" to={sitePage(site.id, 'seo')}>Data Analytics</Link>
          <span className="sep">›</span>
          <span className="cur">SEO Data</span>
        </>
      }
      actions={connected ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {data?.lastSyncDate && (
            <span className="note">Data as of: {data.lastSyncDate}</span>
          )}
          <button className="btn sm" onClick={handleSync} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      ) : undefined}
    >
      <div className="pad seo-page">
        <header className="seo-page-head">
          <p className="business-eyebrow">ANALYTICS</p>
          <h1>SEO Data</h1>
          <p>Search performance from Search Console: view clicks, impressions, and rankings by keyword and page.</p>
        </header>
        {!connected ? (
          <p className="empty">Please connect a Google account in "<Link to={sitePage(site.id, 'settings')}>Configuration</Link>" first to view SEO data.</p>
        ) : loading ? (
          <p className="empty">Loading…</p>
        ) : err ? (
          <p className="err">{err}</p>
        ) : data ? (
        <>
          {syncErr && <p className="err">Sync failed:{syncErr}. The data below still shows the last successful sync.</p>}
          <div className="seo-summary">
            <div className="seo-card">
              <div className="seo-card-value">{totalClicks.toLocaleString()}</div>
              <div className="seo-card-label">Total clicks</div>
            </div>
            <div className="seo-card">
              <div className="seo-card-value">{totalImpressions.toLocaleString()}</div>
              <div className="seo-card-label">Total impressions</div>
            </div>
            <div className="seo-card">
              <div className="seo-card-value">{(avgCtr * 100).toFixed(1)}%</div>
              <div className="seo-card-label">Average CTR</div>
            </div>
            <div className="seo-card">
              <div className="seo-card-value">{avgPosition.toFixed(1)}</div>
              <div className="seo-card-label">Average position</div>
            </div>
          </div>
          <p className="note">Totals are taken from site daily data. Keywords may total less than the overall figures due to Google's anonymization; pages are aggregated by URL, and impression counts may also differ from site totals.</p>

          {data.daily.length > 0 && (
            <section className="section">
              <h2 className="section-title">Daily trend <span className="note">{data.startDate} ~ {data.endDate}</span></h2>
              <div className="seo-chart">
                <DailyChart daily={data.daily} />
              </div>
            </section>
          )}

          <section className="section">
            <div className="section-head">
              <h2 className="section-title">
                {dimension === 'query' ? 'Search Keywords' : 'Pages'}
              </h2>
              <div className="head-actions">
                <button className={`btn sm${dimension === 'query' ? ' active' : ''}`} onClick={() => { setDimension('query'); setPage(1); }}>
                  Keyword
                </button>
                <button className={`btn sm${dimension === 'page' ? ' active' : ''}`} onClick={() => { setDimension('page'); setPage(1); }}>
                  Pages
                </button>
              </div>
            </div>
            <table className="seo-table">
              <thead>
                <tr>
                  <th>{dimension === 'query' ? 'Keyword' : 'URL'}</th>
                  <th className="num">Clicks</th>
                  <th className="num">Impressions</th>
                  <th className="num">CTR</th>
                  <th className="num">Position</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 ? (
                  <tr><td colSpan={5} className="empty">No data yet — click "Sync now" in the top right to pull from GSC; new sites take 2-3 days before data appears</td></tr>
                ) : (
                  data.rows.map((row, i) => (
                    <tr key={i}>
                      <td className="seo-key">
                        {dimension === 'page' ? (
                          <a href={row.keys[0]} target="_blank" rel="noreferrer">{shortenUrl(row.keys[0])}</a>
                        ) : row.keys[0]}
                      </td>
                      <td className="num">{row.clicks}</td>
                      <td className="num">{row.impressions}</td>
                      <td className="num">{(row.ctr * 100).toFixed(1)}%</td>
                      <td className="num">{row.position.toFixed(1)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {data.rowCount > data.pageSize && (
              <div className="head-actions" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
                <span className="note">{data.rowCount} items · page {data.page} / {Math.ceil(data.rowCount / data.pageSize)} </span>
                <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous page</button>
                <button className="btn sm" disabled={page * data.pageSize >= data.rowCount} onClick={() => setPage(page + 1)}>Next page</button>
              </div>
            )}
          </section>
        </>
      ) : null}
      </div>
    </Shell>
  );
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch { return url; }
}

function DailyChart({ daily }: { daily: AnalyticsRow[] }) {
  if (daily.length === 0) return null;
  const maxClicks = Math.max(...daily.map((d) => d.clicks), 1);
  const maxImpr = Math.max(...daily.map((d) => d.impressions), 1);
  const w = 100 / daily.length;
  return (
    <div className="daily-chart">
      <div className="daily-bars">
        {daily.map((d, i) => (
          <div key={i} className="daily-bar-group" style={{ width: `${w}%` }} title={`${d.keys[0]}: ${d.clicks} clicks / ${d.impressions} impressions`}>
            <div className="daily-bar impr" style={{ height: `${(d.impressions / maxImpr) * 100}%` }} />
            <div className="daily-bar click" style={{ height: `${(d.clicks / maxClicks) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="daily-legend">
        <span className="legend-dot click" /> Clicks
        <span className="legend-dot impr" /> Impressions
      </div>
    </div>
  );
}
