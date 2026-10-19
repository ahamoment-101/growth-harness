import { useState } from 'react';
import { api, type Site } from '../api';
import { I } from '../nav';

type CheckResult = {
  ok: boolean;
  at: string;
  message: string;
  records: string;
};

export function HostStatus({ site, onChecked }: { site: Site; onChecked?: (site: Site) => void }) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<CheckResult | null>(null);
  const [err, setErr] = useState('');
  const live = site.domain_status === 'live';
  const pointed = live || site.domain_status === 'dns_ok';
  const failed = site.domain_status === 'error';
  const probe = site.probe_url;
  const target = site.cname_target || '';
  const rec = cnameRecord(site.domain);

  async function check() {
    if (!site.domain) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api.checkHost(site.id);
      const ok = r.check.status === 'live';
      setLast({
        ok,
        at: formatClock(),
        message: ok ? r.check.live.message : [r.check.dns.message, r.check.live.message].filter(Boolean).join(' · '),
        records: formatRecords(r.check.dns),
      });
      onChecked?.(r.site);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyRecord() {
    const text = rec
      ? `Type: CNAME
Name: ${rec.name}
Target: ${target}
Proxy: On (orange cloud, do not turn off)`
      : `Type: CNAME
Target: ${target}
Proxy: On (orange cloud, do not turn off)`;
    await navigator.clipboard.writeText(text);
  }

  return (
    <>
      <p className="section-note">
        {rec
          ? `Add a CNAME at ${rec.zone}. Cloudflare's orange cloud must be on; do not turn it off. Once the check passes, the preview address will open test content on your own domain. Other DNS providers have no proxy switch, so just ignore that.`
          : 'After you fill in the site domain and save, this section will show the CNAME name and target to add.'}
      </p>
      <div className="kv stack">
        <div className="kv-k">
          CNAME record<span className="sub">Fields to fill in on the customer's DNS</span>
        </div>
        <div className="kv-v">
          <div className="dns-recipe">
            <div className="dns-line">
              <span className="lab">Type</span>
              <span className="mono">CNAME</span>
            </div>
            <div className="dns-line">
              <span className="lab">Name</span>
              <span className="mono">{rec?.name || '—'}</span>
            </div>
            <div className="dns-line">
              <span className="lab">Goal</span>
              <span className="mono">{target || 'The deployer has not configured CNAME_TARGET'}</span>
            </div>
            <div className="dns-line">
              <span className="lab">Proxy</span>
              <span className="mono">On (orange cloud, do not turn off)</span>
            </div>
          </div>
        </div>
        <button className="btn sm" type="button" onClick={copyRecord} disabled={!rec || !target}>
          {I.copy} Copy
        </button>
      </div>
      <div className="kv">
        <div className="kv-k">
          Domain and DNS<span className="sub">Pointed to us?</span>
        </div>
        <div className="kv-v">
          <span className="mono">{site.domain || 'Not filled in'}</span>
        </div>
        <DnsStatus pointed={pointed} failed={failed} pending={!site.domain} busy={busy} />
      </div>
      <div className="kv">
        <div className="kv-k">
          Preview address<span className="sub">Opens test content on your domain</span>
        </div>
        <div className="kv-v">
          {live ? (
            <a className="mono" href={probe} target="_blank" rel="noreferrer">
              {probe}
            </a>
          ) : (
            <span className="mono">{probe}</span>
          )}
        </div>
        {live ? (
          <span className="kv-v" style={{ justifyContent: 'flex-end' }}>
            <button className="btn sm" type="button" onClick={check} disabled={busy}>
              {busy ? 'Checking…' : 'Check again'}
            </button>
            <a className="btn sm" href={probe} target="_blank" rel="noreferrer">
              {I.external} Open preview page
            </a>
          </span>
        ) : (
          <button className="btn sm" type="button" onClick={check} disabled={busy || !site.domain}>
            {busy ? 'Checking…' : 'Check DNS'}
          </button>
        )}
      </div>
      {busy ? <p className="section-note">Checking public DNS…</p> : null}
      {err ? <p className="flash">{err}</p> : null}
      {last ? (
        <div className={`check-result ${last.ok ? 'good' : 'bad'}`}>
          <p>
            {last.at} Check result:{last.ok ? 'Pointed' : 'Not pointed'}
          </p>
          <p>{last.message}</p>
          {last.records ? <p className="mono">{last.records}</p> : null}
        </div>
      ) : site.domain_checked_at ? (
        <div className={`check-result ${failed ? 'bad' : pointed ? 'good' : ''}`}>
          <p>
            Last check {formatClock(site.domain_checked_at)}: {pointed ? 'Pointed' : failed ? 'Not pointed' : 'Pending check'}
          </p>
          {site.domain_error ? <p>{site.domain_error}</p> : null}
        </div>
      ) : null}
    </>
  );
}

function DnsStatus({
  pointed,
  failed,
  pending,
  busy,
}: {
  pointed: boolean;
  failed: boolean;
  pending: boolean;
  busy: boolean;
}) {
  if (busy) return <div className="state-text">{I.wait}Checking…</div>;
  if (pending) return <div className="state-text">To be filled in</div>;
  if (pointed) {
    return (
      <div className="state-text">
        {I.check}
        Pointed
      </div>
    );
  }
  if (failed) {
    return (
      <div className="state-text">
        {I.fail}
        Not pointed
      </div>
    );
  }
  return (
    <div className="state-text">
      {I.wait}
      Pending check
    </div>
  );
}

function cnameRecord(domain: string): { name: string; zone: string } | null {
  const host = domain.trim().toLowerCase().replace(/\.$/, '');
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  if (parts.length === 2) return { name: '@', zone: host };
  return { name: parts[0], zone: parts.slice(1).join('.') };
}

function formatClock(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function formatRecords(dns: { cname: string[]; a?: string[]; aaaa?: string[] }): string {
  const cname = dns.cname?.length ? `CNAME ${dns.cname.join(' → ')}` : 'CNAME none';
  const a = dns.a?.length ? `A ${dns.a.join(', ')}` : '';
  const aaaa = dns.aaaa?.length ? `AAAA ${dns.aaaa.join(', ')}` : '';
  return ['Public records:' + cname, a, aaaa].filter(Boolean).join(' · ');
}
