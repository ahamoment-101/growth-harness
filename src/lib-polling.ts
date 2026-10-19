/**
 * Wraps a polling callback: never runs in a hidden tab, and at most once a minute while the
 * window is visible but not focused (a console left open on an unattended screen).
 */
export function attendedPoll(run: () => void, unattendedMs = 60_000): () => void {
  let last = Date.now();
  return () => {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (!document.hasFocus() && now - last < unattendedMs) return;
    last = now;
    run();
  };
}
