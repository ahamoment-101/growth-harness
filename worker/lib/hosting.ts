import type { Site } from '../types';

export const SETUP_LOCALE = 'en';
export const SETUP_SLUG = '_setup';
export const DEFAULT_CNAME_TARGET = ''; // Each installation supplies its own hostname.

export type DnsLookup = {
  ok: boolean;
  nx: boolean;
  cname: string[];
  a: string[];
  aaaa: string[];
  target: string;
  message: string;
};

export type ProbeResult = {
  ok: boolean;
  status?: number;
  message: string;
};

export type HostCheck = {
  dns: DnsLookup;
  live: ProbeResult;
  status: 'live' | 'dns_ok' | 'error';
  probe_url: string;
};

type DohResponse = {
  Status: number;
  Answer?: Array<{ type: number; data: string }>;
};

const DNS_A = 1;
const DNS_CNAME = 5;
const DNS_AAAA = 28;

export function hostedOrigin(domain: string): string {
  return `https://${domain}`;
}

export function probePath(): string {
  return '/';
}

export function probeUrl(domain: string): string {
  return `${hostedOrigin(domain)}${probePath()}`;
}

export function cnameTargetOf(env?: { CNAME_TARGET?: string }): string {
  return normalizeHost(env?.CNAME_TARGET || DEFAULT_CNAME_TARGET);
}

export function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

export function cnameChainPointsTo(chain: string[], target: string): boolean {
  const t = normalizeHost(target);
  return chain.some((hop) => normalizeHost(hop) === t);
}

/** Some resolvers omit CNAME on type=CNAME queries but include it in A/AAAA answers. */
export function mergeCnameHops(...lists: string[][]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const hop of list) {
      const key = normalizeHost(hop);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

export function isSetupArticle(locale: string, slug: string): boolean {
  return locale === SETUP_LOCALE && slug === SETUP_SLUG;
}

export function isCloudflareIp(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  if (v.includes(':')) {
    return (
      v.startsWith('2400:cb00:') ||
      v.startsWith('2405:8100:') ||
      v.startsWith('2405:b500:') ||
      v.startsWith('2606:4700:') ||
      v.startsWith('2803:f800:') ||
      v.startsWith('2a06:98c0:') ||
      v.startsWith('2c0f:f248:')
    );
  }
  const p = v.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  if (p[0] === 104 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 172 && p[1] >= 64 && p[1] <= 71) return true;
  if (p[0] === 162 && p[1] === 158) return true;
  if (p[0] === 198 && p[1] === 41) return true;
  if (p[0] === 188 && p[1] === 114 && (p[2] === 96 || p[2] === 97)) return true;
  if (p[0] === 141 && p[1] === 101) return true;
  if (p[0] === 108 && p[1] === 162) return true;
  if (p[0] === 173 && p[1] === 245) return true;
  return false;
}

export function looksCloudflareProxied(a: string[], aaaa: string[]): boolean {
  const ips = [...a, ...aaaa];
  return ips.length > 0 && ips.every(isCloudflareIp);
}

export function interpretDns(input: {
  chain: string[];
  a: string[];
  aaaa: string[];
  nx: boolean;
  target: string;
}): DnsLookup {
  const target = normalizeHost(input.target);
  const ok = cnameChainPointsTo(input.chain, target);
  let message = `DNS does not have a CNAME to ${target}`;
  if (input.nx) {
    message = `DNS does not yet have this hostname. Please add a CNAME → ${target}. The orange cloud on Cloudflare must be enabled; do not turn it off.`;
  } else if (ok) {
    const via = input.chain[0] && normalizeHost(input.chain[0]) !== target;
    message = `DNS already points to ${target}` + (via ? `(via ${input.chain.join(' → ')})` : '');
  } else if (input.chain.length) {
    message = `CNAME points to ${input.chain.join(' → ')}, not ${target}`;
  } else if (looksCloudflareProxied(input.a, input.aaaa)) {
    message =
      `The Cloudflare orange cloud is enabled, so it is normal that the CNAME is not visible via public DNS. Do not disable the proxy.`;
  } else if (input.a.length || input.aaaa.length) {
    message = `There are A/AAAA records, but no CNAME to ${target}`;
  }
  return { ok, nx: input.nx, target, cname: input.chain, a: input.a, aaaa: input.aaaa, message };
}

export async function lookupDns(hostname: string, target: string): Promise<DnsLookup> {
  const hops = await cnameChain(hostname);
  const [a, aaaa] = await Promise.all([doh(hostname, 'A'), doh(hostname, 'AAAA')]);
  const aRecords = answers(a, DNS_A);
  const aaaaRecords = answers(aaaa, DNS_AAAA);
  const chain = mergeCnameHops(hops, answers(a, DNS_CNAME), answers(aaaa, DNS_CNAME));
  return interpretDns({
    chain,
    a: aRecords,
    aaaa: aaaaRecords,
    nx: chain.length === 0 && aRecords.length === 0 && aaaaRecords.length === 0 && a.Status === 3 && aaaa.Status === 3,
    target,
  });
}

export async function checkHost(env: Env, site: Site): Promise<HostCheck> {
  const hostname = site.domain;
  if (!hostname) throw new Error('Site domain has not been filled in yet');

  const target = cnameTargetOf(env);
  const dns = await lookupDns(hostname, target);
  const url = probeUrl(hostname);

  let routed = false;
  let routedMessage = '';
  if (!dns.nx) {
    const route = await inspectWorkerRoute(env, hostname);
    routed = route.ok;
    routedMessage = route.message;
  }

  const decided = decideHostStatus(dns, routed);
  if (!decided.live.ok && routedMessage && !decided.live.message.includes(routedMessage)) {
    decided.live = { ...decided.live, message: `${decided.live.message} · ${routedMessage}` };
  }

  return { dns, live: decided.live, status: decided.status, probe_url: url };
}

/**
 * Browser requests to a proxied hostname hit our Worker Route.
 * Fetching that same hostname from this Worker does not — Cloudflare same-zone
 * Worker fetch returns 522 even when the customer's browser already works.
 */
export function decideHostStatus(dns: DnsLookup, routed: boolean): { live: ProbeResult; status: HostCheck['status'] } {
  const orange = looksCloudflareProxied(dns.a, dns.aaaa) && dns.cname.length === 0 && !dns.ok;

  if (dns.nx) {
    return { status: 'error', live: { ok: false, message: dns.message } };
  }

  if (routed && orange) {
    return { status: 'live', live: { ok: true, message: 'The page is connected to your domain; you can open the trial page' } };
  }

  if (dns.ok) {
    return {
      status: 'dns_ok',
      live: {
        ok: false,
        message: routed
          ? 'CNAME is pointing. Cloudflare must have the orange cloud enabled (do not turn it off) for the page to open on your domain.'
          : dns.message,
      },
    };
  }

  if (orange && !routed) {
    return { status: 'error', live: { ok: false, message: 'The orange cloud is enabled, but it is not yet connected to this Worker.' } };
  }

  return { status: 'error', live: { ok: false, message: dns.message } };
}

async function cnameChain(hostname: string): Promise<string[]> {
  const chain: string[] = [];
  let current = hostname;
  const seen = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const key = normalizeHost(current);
    if (seen.has(key)) break;
    seen.add(key);
    const res = await doh(current, 'CNAME');
    const next = answers(res, DNS_CNAME)[0];
    if (!next) break;
    chain.push(next);
    current = next;
  }
  return chain;
}

async function doh(name: string, type: string): Promise<DohResponse> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await fetch(url, { headers: { Accept: 'application/dns-json' } });
  if (!res.ok) throw new Error(`DNS query failed with HTTP ${res.status}`);
  return (await res.json()) as DohResponse;
}

function answers(d: DohResponse, type: number): string[] {
  return (d.Answer ?? [])
    .filter((a) => a.data && a.type === type)
    .map((a) => a.data.replace(/\.$/, ''));
}

type CfEnvelope<T> = {
  success: boolean;
  errors?: Array<{ message?: string }>;
  result?: T;
};

async function inspectWorkerRoute(env: Env, hostname: string): Promise<{ ok: boolean; message: string }> {
  const workerName = env.CLOUDFLARE_WORKER_NAME?.trim();
  if (!workerName) throw new Error('Domain check could not be completed: CLOUDFLARE_WORKER_NAME must match the deployed Worker name. The original connection status has been preserved.');
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('Domain check could not be completed: Cloudflare query credentials are not configured. The original connection status has been preserved.');

  const zone = await findZone(token, hostname);
  if (!zone) throw new Error('Domain check could not be completed: the current Cloudflare credentials cannot view this domain, so this cannot be taken as evidence that the domain is not connected. The original connection status has been preserved.');

  const pattern = `${normalizeHost(hostname)}/*`;
  const listed = await cfApi<Array<{ pattern: string; script?: string }>>(
    token,
    `https://api.cloudflare.com/client/v4/zones/${zone.id}/workers/routes`,
  );
  const routes = listed.result || [];
  const mine = routes.find((r) => r.pattern === pattern && r.script === workerName);
  if (mine) return { ok: true, message: 'Connected to this Worker' };
  const other = routes.find((r) => r.pattern === pattern && r.script && r.script !== workerName);
  if (other) return { ok: false, message: `This hostname is already connected to ${other.script}; no change made` };

  // Other valid routing mechanisms (custom domains or wildcard routes) may exist.
  // A check must never create a route or infer an outage from this limited view.
  throw new Error('Domain check could not be confirmed: no exact matching Worker route was found; the domain may be connected via another route. The original connection status has been preserved.');
}

async function findZone(token: string, hostname: string): Promise<{ id: string; name: string } | null> {
  const labels = normalizeHost(hostname).split('.').filter(Boolean);
  for (let i = 1; i <= labels.length - 2; i++) {
    const name = labels.slice(i).join('.');
    const data = await cfApi<Array<{ id: string; name: string }>>(
      token,
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(name)}`,
    );
    const zone = data.result?.[0];
    if (zone?.id) return zone;
  }
  return null;
}

async function cfApi<T>(token: string, url: string, init?: RequestInit): Promise<CfEnvelope<T>> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const data = (await res.json()) as CfEnvelope<T>;
  if (!res.ok || !data.success || !Array.isArray(data.result)) {
    throw new Error(`Domain check could not be completed: Cloudflare configuration query failed (HTTP ${res.status}). Please check the query credentials and access permissions for the domain. The original connection status has been preserved.`);
  }
  return data;
}
