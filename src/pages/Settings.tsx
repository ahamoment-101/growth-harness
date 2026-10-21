import { useState } from 'react';
import { api, formatDate, type Site, type WebhookField } from '../api';
import { HostStatus } from '../components/HostStatus';
import { Shell } from '../components/Shell';
import { I, Link, sitePage } from '../nav';

export default function Settings({
  site,
  sites,
  onSaved,
  onSitePatch,
}: {
  site: Site;
  sites: Site[];
  onSaved: () => void;
  onSitePatch: (site: Site) => void;
}) {
  const [domain, setDomain] = useState(site.domain);
  const [hub, setHub] = useState(site.hub_path);
  const [productOrigin, setProductOrigin] = useState(site.product_origin || '');
  const [hubUrls, setHubUrls] = useState<Record<string, string>>(site.hub_urls || {});
  const [orgName, setOrgName] = useState(site.seo_identity?.organizationName || '');
  const [authorName, setAuthorName] = useState(site.seo_identity?.authorName || '');
  const [logoUrl, setLogoUrl] = useState(site.seo_identity?.logoUrl || '');
  const [ogImage, setOgImage] = useState(site.seo_identity?.defaultOgImage || '');
  const [ingestUrl, setIngestUrl] = useState(site.ingest_url);
  const [secret, setSecret] = useState('');
  const [header, setHeader] = useState(site.secret_header);
  const [fields, setFields] = useState<WebhookField[]>(site.webhook_fields);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<'domain' | 'content' | 'advanced'>('domain');

  async function save() {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await api.updateSite(site.id, {
        domain,
        hub_path: hub,
        product_origin: productOrigin,
        hub_urls: compactRecord(hubUrls),
        seo_identity: {
          organizationName: orgName,
          authorName,
          logoUrl,
          defaultOgImage: ogImage,
        },
        ingest_url: ingestUrl,
        ingest_secret: secret,
        secret_header: header,
        webhook_fields: fields,
      });
      setSecret('');
      setMsg('Saved');
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function testWebhook() {
    setErr('');
    setMsg('');
    try {
      const r = await api.testWebhook(site.id);
      setMsg(r.ok ? `Webhook ${r.status} ${r.url}` : r.error || 'webhook failed');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function runGscAction(action: () => Promise<{ site?: unknown } | unknown>) {
    setErr('');
    setMsg('');
    setBusy(true);
    try {
      const result = await action();
      // If the action returns an updated site object, propagate it
      if (result && typeof result === 'object' && 'site' in result && result.site) {
        onSitePatch(result.site as Parameters<typeof onSitePatch>[0]);
      }
      setMsg('Operation successful');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Operation failed');
    } finally {
      setBusy(false);
    }
  }

  function sitemapUrl() {
    return site.domain_status === 'live' ? `https://${site.domain}/sitemap.xml` : `${site.live_path}/sitemap.xml`;
  }

  return (
    <Shell
      sites={sites}
      site={site}
      active="settings"
      crumb={
        <>
          <Link className="muted" to={sitePage(site.id)}>Main screen</Link>
          <span className="sep">›</span>
          <span className="muted">GrowthHarness</span>
          <span className="sep">›</span>
          <span className="cur">Configuration</span>
        </>
      }
      actions={
        <>
          <span className="note">{msg}</span>
          <button className="btn primary" type="button" onClick={save} disabled={busy}>
            Save
          </button>
        </>
      }
    >
      <nav className="subtabs">
        <button type="button" className={`tab${tab === 'domain' ? ' active' : ''}`} onClick={() => setTab('domain')}>
          Domain &amp; Indexing
        </button>
        <button type="button" className={`tab${tab === 'content' ? ' active' : ''}`} onClick={() => setTab('content')}>
          Content
        </button>
        <button type="button" className={`tab${tab === 'advanced' ? ' active' : ''}`} onClick={() => setTab('advanced')}>
          Advanced
        </button>
      </nav>
      {err ? <p className="flash">{err}</p> : null}

      {tab === 'domain' ? (
        <>
          <section className="section">
            <div className="section-head">
              <h2 className="section-title">Domain and DNS</h2>
            </div>
            <div className="kv">
              <div className="kv-k">
                Blog Subdomain<span className="sub">GrowthHarness Hosting</span>
              </div>
              <div className="kv-v">
                <input className="input mono" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder={site.root_domain ? `blog.${site.root_domain}` : 'blog.example.com'} />
              </div>
              <div className="state-text">{domain ? 'Save before checking' : 'To be filled in'}</div>
            </div>
            <HostStatus site={site} onChecked={onSitePatch} />
          </section>
          <section className="section">
            <div className="section-head">
              <h2 className="section-title">Search Console</h2>
            </div>
            <p className="section-note">Connect your Google account and the system will automatically add a property in Search Console and submit your sitemap.</p>
            <div className="kv">
              <div className="kv-k">Google Account</div>
              <div className="kv-v">
                {site.gsc_google_account_email ? <span className="mono">{site.gsc_google_account_email}</span> : <span className="note">Not connected</span>}
              </div>
              <div className="state-text">{site.gsc_oauth_status === 'connected' ? 'Authorized' : 'Pending onboarding'}</div>
              {/* Direct browser redirect to OAuth consent – no JSON API call needed */}
              <a className="btn sm" href={`/api/sites/${site.id}/gsc/oauth/start`}>
                {site.gsc_oauth_status === 'connected' ? 'Re-authorize' : 'Connect Google Account'}
              </a>
            </div>

            <div className="kv">
              <div className="kv-k">
                Property<span className="sub">URL Prefix</span>
              </div>
              <div className="kv-v">
                <span className="mono">{site.domain_status === 'live' && site.domain ? `https://${site.domain}/` : 'Waiting for domain to take effect'}</span>
              </div>
              <div className="state-text">
                {site.gsc_property_verification_status === 'verified'
                  ? `Verified ${site.gsc_property_verified_at ? ` · ${formatDate(site.gsc_property_verified_at)}` : ''}`
                  : site.gsc_property_verification_status === 'verifying'
                    ? 'Verifying'
                    : 'Pending Verification'}
              </div>
              <button className="btn sm" type="button" onClick={() => runGscAction(() => api.gscVerifyProperty(site.id))} disabled={busy || site.gsc_oauth_status !== 'connected'}>
                Push Domain
              </button>
            </div>

            <div className="kv">
              <div className="kv-k">
                sitemap<span className="sub">Auto-submit after publishing</span>
              </div>
              <div className="kv-v">
                <span className="mono">{sitemapUrl()}</span>
                {site.gsc_sitemap_last_submit_at && (
                  <span className="note"> · Last submitted {formatDate(site.gsc_sitemap_last_submit_at)}</span>
                )}
              </div>
              <a className="btn sm" href={sitemapUrl()} target="_blank" rel="noreferrer">
                Open
              </a>
              <button className="btn sm" type="button" onClick={() => runGscAction(() => api.gscSubmitSitemap(site.id))} disabled={busy || site.gsc_property_verification_status !== 'verified'}>
                Submit Now
              </button>
            </div>

            <div className="kv">
              <div className="kv-k">
                Metrics Backfill<span className="sub">For slow-loop scoring</span>
              </div>
              <div className="kv-v">
                <span className="note">Daily pull of impressions, clicks, and ranking snapshots (coming in the next phase)</span>
              </div>
              <div className="state-text">Pending onboarding</div>
            </div>
          </section>
        </>
      ) : null}

      {tab === 'content' ? (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Content Hub</h2>
          </div>
          <p className="section-note">The hub page lives on the client's main site; each language can be given a full URL, otherwise the main site origin + hub path is used. Which languages are enabled is configured in project settings.</p>
          <div className="kv">
            <div className="kv-k">
              Hub Path<span className="sub">Every article must internally link back here</span>
            </div>
            <div className="kv-v">
              <input className="input mono" value={hub} onChange={(e) => setHub(e.target.value)} placeholder="/start" />
            </div>
            <div />
          </div>
          <div className="kv">
            <div className="kv-k">
              Main site origin<span className="sub">Hub links point here, not to the blog subdomain</span>
            </div>
            <div className="kv-v">
              <input
                className="input mono"
                value={productOrigin}
                onChange={(e) => setProductOrigin(e.target.value)}
                placeholder="https://www.example.com"
              />
            </div>
            <div className="state-text">{productOrigin ? 'Filled in' : 'If left empty, the relative path is kept'}</div>
          </div>
          {contentLocales(site.source_locale, site.translate_locales).map((code, i) => (
            <div className="kv" key={code}>
              <div className="kv-k">
                {i === 0 ? 'Hub URL' : ''}
                <span className="sub">{code}</span>
              </div>
              <div className="kv-v">
                <input
                  className="input mono"
                  value={hubUrls[code] || ''}
                  onChange={(e) => setHubUrls({ ...hubUrls, [code]: e.target.value })}
                  placeholder={productOrigin && hub ? `${productOrigin.replace(/\/+$/, '')}${hub.startsWith('/') ? hub : `/${hub}`}` : 'https://www.example.com/start'}
                />
              </div>
              <div />
            </div>
          ))}
          <div className="kv">
            <div className="kv-k">Author / Publisher</div>
            <div className="kv-v">
              <input className="input" value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder={site.name || 'Organization Name'} />
            </div>
            <div />
          </div>
          <div className="kv">
            <div className="kv-k" />
            <div className="kv-v">
              <input className="input" value={authorName} onChange={(e) => setAuthorName(e.target.value)} placeholder="Author name, defaults to the same as the organization" />
            </div>
            <div />
          </div>
          <div className="kv">
            <div className="kv-k">Logo / OG Image</div>
            <div className="kv-v">
              <input className="input mono" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://www.example.com/logo.png" />
            </div>
            <div />
          </div>
          <div className="kv">
            <div className="kv-k" />
            <div className="kv-v">
              <input className="input mono" value={ogImage} onChange={(e) => setOgImage(e.target.value)} placeholder="https://www.example.com/og.png" />
            </div>
            <div />
          </div>
        </section>
      ) : null}

      {tab === 'advanced' ? (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Advanced</h2>
          </div>
          <p className="section-note">No need to touch this by default. The Webhook is only for sites that already have their own CMS and want to push the same content into it as an extra copy; it is not the onboarding method.</p>
          <div className="kv">
            <div className="kv-k">
              Full-package Webhook Export<span className="sub">Optional</span>
            </div>
            <div className="kv-v">
              <input className="input mono" value={ingestUrl} onChange={(e) => setIngestUrl(e.target.value)} placeholder="https://cms.example.com/api/publish" />
            </div>
            <div className="state-text">{ingestUrl ? 'Filled in' : 'Not enabled'}</div>
          </div>
          <div className="kv">
            <div className="kv-k">Export Secret</div>
            <div className="kv-v">
              <input className="input mono" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={site.secret_set ? 'Set; leave blank to keep unchanged' : 'Optional'} />
            </div>
            <div />
          </div>
          <div className="kv">
            <div className="kv-k">Request Headers</div>
            <div className="kv-v">
              <input className="input mono" value={header} onChange={(e) => setHeader(e.target.value)} />
            </div>
            <div />
          </div>
          {fields.map((f, i) => (
            <div className="kv" key={`${f.key}-${i}`}>
              <div className="kv-k">{i === 0 ? 'Custom Fields' : ''}</div>
              <div className="kv-v">
                <input className="input mono" value={f.key} onChange={(e) => setFields(fields.map((x, n) => (n === i ? { ...x, key: e.target.value } : x)))} placeholder="key" />
                <select
                  className="select"
                  value={f.from}
                  onChange={(e) => setFields(fields.map((x, n) => (n === i ? { ...x, from: e.target.value } : x)))}
                >
                  <option value="languages">All languages</option>
                  <option value="title">Title</option>
                  <option value="slug">Slug</option>
                  <option value="content">Body</option>
                  <option value="content_id">Content ID</option>
                  <option value="literal">Fixed value</option>
                </select>
              </div>
              <button className="btn sm" type="button" onClick={() => setFields(fields.filter((_, n) => n !== i))}>
                Delete
              </button>
            </div>
          ))}
          <div className="kv">
            <div className="kv-k" />
            <div className="kv-v">
              <button className="btn sm" type="button" onClick={() => setFields([...fields, { key: 'article', from: 'languages' }])}>
                {I.plus} Add Field
              </button>
              <button className="btn sm" type="button" onClick={testWebhook} disabled={!ingestUrl}>
                Test Export
              </button>
            </div>
            <div />
          </div>
        </section>
      ) : null}
    </Shell>
  );
}

function compactRecord(input: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const v = value?.trim();
    if (v) out[key] = v;
  }
  return out;
}

function contentLocales(source: string, extras: string[]): string[] {
  return [source, ...extras.filter((code) => code && code !== source)];
}
