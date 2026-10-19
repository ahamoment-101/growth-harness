export function publicResearchUrl(value: string): string {
  const url = new URL(value);
  // Browser service must never receive credentials or private/IP destinations.
  const host = url.hostname.toLowerCase();
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))
    || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('A public HTTP(S) hostname without credentials is required');
  url.hash = '';
  return url.toString();
}
