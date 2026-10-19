/** Keep the original console route so signing in returns to the interrupted work. */
export function redirectToLogin() {
  if (window.location.pathname === '/login') return;
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.replace(`/login?return_to=${encodeURIComponent(returnTo)}`);
}

let sessionCheck: Promise<boolean> | null = null;

/** A socket failure alone is not evidence that the session expired. */
export function checkSessionAfterDisconnect(): Promise<boolean> {
  if (sessionCheck) return sessionCheck;
  sessionCheck = (async () => {
    try {
      const response = await fetch('/api/auth/me', {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return false;
      const state = await response.json() as { authenticated?: boolean };
      if (state.authenticated !== false) return false;
      redirectToLogin();
      return true;
    } catch {
      return false;
    } finally {
      sessionCheck = null;
    }
  })();
  return sessionCheck;
}
