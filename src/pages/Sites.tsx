import { useMemo, useState, type FormEvent } from 'react';
import { api, type Site } from '../api';
import { Shell } from '../components/Shell';
import { I, classroomPage, go } from '../nav';
import { registrableDomain } from '../../shared/domain';

export default function Sites({ sites, onChange, err }: { sites: Site[]; onChange: () => void; err: string }) {
  const [domain, setDomain] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState('');
  const parsed = useMemo(() => registrableDomain(domain), [domain]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setLocalErr('');
    if (!parsed) {
      setLocalErr('Please enter a valid domain, e.g. example.com');
      return;
    }
    setBusy(true);
    try {
      const created = await api.createSite({ domain, name: name.trim() || parsed });
      setDomain('');
      setName('');
      onChange();
      go(classroomPage(created.site.id));
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell
      sites={sites}
      site={sites[0] || null}
      active="sites"
      crumb={<span className="cur">Add site</span>}
    >
      <div className="home-page inset">
        <div className="home-head">
          <div>
            <h1 className="home-title">Add site</h1>
            <p className="home-lead">Create a project using your official site domain. Paths and prefixes are stripped automatically, keeping only the root domain, such as example.com.</p>
          </div>
        </div>

        <form className="home-form" onSubmit={add}>
          <div className="field grow">
            <label className="label" htmlFor="new-domain">
              Domain
            </label>
            <input
              className="input mono"
              id="new-domain"
              placeholder="https://www.example.com/start"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              required
            />
            <p className="field-hint">
              {parsed ? `Will be saved as ${parsed}` : domain.trim() ? 'Not recognized as a domain' : 'Pasting the full URL also works'}
            </p>
          </div>
          <div className="field grow">
            <label className="label" htmlFor="new-name">
              Site name
            </label>
            <input
              className="input"
              id="new-name"
              placeholder={parsed || 'Optional; defaults to the domain'}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <button className="btn primary" type="submit" disabled={busy || !parsed}>
            {I.plus}
            Create
          </button>
        </form>

        {err || localErr ? <p className="flash">{err || localErr}</p> : null}
        {sites.length === 0 ? <p className="empty">No sites yet. Fill in a domain to create a project.</p> : null}
      </div>
    </Shell>
  );
}
