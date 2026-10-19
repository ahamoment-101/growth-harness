import { useState, type FormEvent } from 'react';
import { api, type AuthState } from '../api';

export default function Account({ auth }: { auth: AuthState }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [passwordSet, setPasswordSet] = useState(auth.password_set);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      await api.changePassword(current, password);
      setCurrent(''); setPassword(''); setPasswordSet(true);
      setMessage('Password saved; all other login sessions have been signed out.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Save failed'); }
    finally { setBusy(false); }
  }
  async function logout() {
    try { await api.logout(); window.location.assign('/login'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign out failed'); }
  }
  return <main className="login-page"><section className="login-card">
    <a href="/" className="muted">Back to workspace</a>
    <h1>Account &amp; Sign-in</h1>
    <p className="login-description">{auth.user?.email}</p>
    {error ? <p className="login-error" role="alert">{error}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {auth.methods?.includes('password') ? <form className="login-form" onSubmit={save}>
      {passwordSet ? <label>Current password<input className="input" type="password" autoComplete="current-password" required value={current} onChange={e => setCurrent(e.target.value)} /></label> : <p className="login-note">Add a password for the current admin; existing sites and work records are preserved.</p>}
      <label>New password<input className="input" type="password" autoComplete="new-password" minLength={12} required value={password} onChange={e => setPassword(e.target.value)} /></label>
      <button className="login-button" type="submit" disabled={busy}>{busy ? 'Saving…' : passwordSet ? 'Change password' : 'Set password'}</button>
    </form> : null}
    {auth.methods?.includes('google') ? auth.google_linked ? <p className="login-note">Google account is linked</p> : <a className="login-button" href="/api/auth/google/link">Link Google sign-in</a> : null}
    <button className="btn login-logout" type="button" onClick={() => void logout()}>Sign out</button>
  </section></main>;
}
