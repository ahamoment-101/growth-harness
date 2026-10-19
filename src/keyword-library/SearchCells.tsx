import type { KeywordSearchData } from '../../shared/keyword-library';
import { countryName, dataStatus, difficultyBand, formatNumber, primaryMetrics, shortDate } from './format';

export function VolumeCell({ data }: { data?: KeywordSearchData | null }) {
  const row = primaryMetrics(data);
  const status = dataStatus(data);
  if (status.kind === 'not_checked') return <span className="kl-unknown">Not checked</span>;
  if (!row || row.search_volume === null) return <span className="kl-unknown">No data</span>;
  const others = (data?.metrics.length || 1) - 1;
  return <span className="kl-volume">
    <strong>{formatNumber(row.search_volume)}</strong>
    <small>{countryName(row.country)}{others ? ` +${others} countries` : ''}</small>
  </span>;
}

export function DifficultyCell({ data }: { data?: KeywordSearchData | null }) {
  const value = primaryMetrics(data)?.keyword_difficulty ?? null;
  const band = difficultyBand(value);
  if (!band) return <span className="kl-unknown">—</span>;
  return <span className={`kl-kd ${band.tone}`} title={`Difficulty ${value}/100 (${band.label}), vendor estimate`}><i />{value}</span>;
}

export function Sparkline({ values, width = 72, height = 20 }: { values: Array<number | null>; width?: number; height?: number }) {
  const points = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (points.length < 2) return <span className="kl-unknown">—</span>;
  const max = Math.max(...points.map(p => p[1]));
  // Scale over at least half the peak so month-to-month noise does not read as a trend.
  const span = Math.max(max - Math.min(...points.map(p => p[1])), max * 0.5) || 1;
  const x = (i: number) => (i / (values.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 2 - ((v - (max - span)) / span) * (height - 4);
  const first = points[0][1];
  const last = points[points.length - 1][1];
  const change = first ? Math.round(((last - first) / first) * 100) : 0;
  return <svg className="kl-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${change >= 0 ? 'Rising' : 'Falling'} ${Math.abs(change)}% over the last 12 months`}>
    <polyline fill="none" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" points={points.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} />
  </svg>;
}

export function TrendCell({ data }: { data?: KeywordSearchData | null }) {
  const row = primaryMetrics(data);
  return row?.monthly.length ? <Sparkline values={row.monthly.map(m => m.volume)} /> : <span className="kl-unknown">—</span>;
}

export function StatusPill({ data }: { data?: KeywordSearchData | null }) {
  const status = dataStatus(data);
  if (status.kind === 'not_checked') return <span className="kl-pill neutral" title="Search data for this keyword has never been queried">Not checked</span>;
  if (status.kind === 'no_data') return <span className="kl-pill warn" title="Queried, but the data source has no data for this keyword — usually means search volume is very small; doesn't mean nobody searches for it">No data · {shortDate(status.observed_at)}</span>;
  if (status.stale) return <span className="kl-pill stale" title="Data is over 90 days old and may be outdated">{shortDate(status.observed_at)} · May be outdated</span>;
  return <span className="kl-pill ok" title="Query date">{shortDate(status.observed_at)}</span>;
}
