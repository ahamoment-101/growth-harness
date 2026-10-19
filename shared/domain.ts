const MULTI_PART_TLDS = new Set([
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'edu.cn',
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.jp',
  'or.jp',
  'ne.jp',
  'com.hk',
  'com.tw',
  'com.sg',
  'co.kr',
  'co.nz',
  'co.za',
  'com.br',
  'com.mx',
  'co.in',
  'com.in',
]);

/** Hostname only: drop scheme, path, port, credentials, trailing dot, and leading www. */
export function parseHostname(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/^['"]+|['"]+$/g, '');
  if (!trimmed) return '';

  let host = '';
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (url.hostname) host = url.hostname;
  } catch {
    host = trimmed.replace(/^https?:\/\//, '').split('/')[0].split('?')[0].split('#')[0];
    host = host.replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  }

  host = host.replace(/\.$/, '').replace(/^www\./, '');
  if (!host || host === 'localhost') return '';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return '';
  if (!host.includes('.') || /[^a-z0-9.-]/.test(host)) return '';
  return host;
}

/** Registrable site domain, e.g. https://www.example.com/foo → example.com. */
export function registrableDomain(raw: string): string {
  const host = parseHostname(raw);
  if (!host) return '';
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return '';
  const last2 = parts.slice(-2).join('.');
  if (parts.length >= 3 && MULTI_PART_TLDS.has(last2)) return parts.slice(-3).join('.');
  return last2;
}

export function defaultBlogHost(root: string): string {
  return root ? `blog.${root}` : '';
}
