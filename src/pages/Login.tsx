import { useState, type FormEvent } from 'react';
import { api, type AuthState } from '../api';

export default function Login({ auth, error: configurationError }: { auth?: AuthState | null; error?: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const setup = Boolean(auth?.setup_required);
  const methods = auth?.methods || [];
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setFailure('');
    try {
      if (setup) await api.setupOwner(email, password, setupToken);
      else await api.passwordLogin(email, password);
      window.location.assign(returnTo);
    } catch (cause) { setFailure(cause instanceof Error ? cause.message : 'Login Failed'); }
    finally { setBusy(false); }
  }
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');
  const requestedReturnTo = params.get('return_to') || '/';
  const returnTo = window.location.pathname === '/login'
    ? (requestedReturnTo.startsWith('/') && !requestedReturnTo.startsWith('//') && !requestedReturnTo.includes('\\') ? requestedReturnTo : '/')
    : `${window.location.pathname}${window.location.search}`;
  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand">
          <span className="login-mark" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="2" />
              <rect x="14" y="3" width="7" height="7" rx="2" />
              <rect x="3" y="14" width="7" height="7" rx="2" />
              <rect x="14" y="14" width="7" height="7" rx="2" />
            </svg>
          </span>
          <span>PROGRAMMATIC SEO TEAM</span>
        </div>
        <h1 id="login-title">{setup ? 'Create Your Admin Account' : 'Back to Your Marketing Team'}</h1>
        <p className="login-description">After logging in, continue viewing team progress, agent work logs, and content results.</p>
        {configurationError || failure || error ? <p className="login-error" role="alert">{configurationError || failure || error}</p> : null}
        {setup && !auth?.setup_available && methods.includes('password') ? <p className="login-note">The deployer must first run npm run setup to generate the initialization code.</p> : null}
        {methods.includes('password') ? <form className="login-form" onSubmit={submit}>
          <label>Email<input className="input" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></label>
          <label>Password<input className="input" type="password" autoComplete={setup ? 'new-password' : 'current-password'} minLength={setup ? 12 : undefined} required value={password} onChange={e => setPassword(e.target.value)} /></label>
          {setup ? <><label>Initialization Code<input className="input" type="password" autoComplete="off" required value={setupToken} onChange={e => setSetupToken(e.target.value)} /></label><p className="login-note">Password must be at least 12 characters. The initialization code is provided by the deployer; registration closes automatically after the admin is created.</p></> : null}
          <button className="login-button" type="submit" disabled={busy || (setup && !auth?.setup_available)}>{busy ? 'Processing…' : setup ? 'Create Admin and Log In' : 'Log In with Email and Password'}</button>
        </form> : null}
        {methods.includes('google') ? <>
        <a className="login-button" href={`/api/auth/login?return_to=${encodeURIComponent(returnTo)}`}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36ZM12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22ZM6.41 13.92A6 6 0 0 1 6.1 12c0-.67.11-1.32.31-1.92V7.49H3.07A10 10 0 0 0 2 12c0 1.61.39 3.14 1.07 4.51l3.34-2.59ZM12 5.96c1.47 0 2.79.51 3.82 1.51l2.86-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.59A5.99 5.99 0 0 1 12 5.96Z" />
          </svg>
          Log In with Google
        </a>
        <p className="login-note">Please use an authorized and linked Google account</p></> : null}
      </section>
    </main>
  );
}
