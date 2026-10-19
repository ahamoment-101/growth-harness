/**
 * Google Search Console OAuth + API helpers.
 *
 * Architecture:
 *   - We (the product) register ONE Google Cloud App.  Client ID/Secret go into
 *     Wrangler Secrets once.  Customers never touch them.
 *   - Each customer clicks "Connect Google Account" in Settings → we redirect to
 *     Google OAuth → customer approves → we get their refresh_token and store it
 *     AES-GCM encrypted in sites.gsc_refresh_token_cipher.
 *   - After that we call the GSC API on their behalf: add property, submit sitemap.
 *
 * Scopes requested:
 *   https://www.googleapis.com/auth/webmasters
 *   https://www.googleapis.com/auth/userinfo.email  (to show which account)
 */

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GSC_BASE = 'https://www.googleapis.com/webmasters/v3';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

// ─── OAuth URL ───────────────────────────────────────────────────────────────

export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: OAUTH_SCOPES,
    access_type: 'offline',
    prompt: 'consent',   // force consent so we always get a fresh refresh_token
    state: opts.state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

// ─── Token exchange ───────────────────────────────────────────────────────────

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
};

export async function exchangeCode(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed: ${res.status} ${text.slice(0, 400)}`);
  }
  return res.json() as Promise<TokenResponse>;
}

export async function refreshAccessToken(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token refresh failed: ${res.status} ${text.slice(0, 400)}`);
  }
  const data = await res.json() as TokenResponse;
  return data.access_token;
}

// ─── Userinfo ─────────────────────────────────────────────────────────────────

export async function fetchGoogleEmail(accessToken: string): Promise<string> {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return '';
  const data = await res.json() as { email?: string };
  return data.email ?? '';
}

// ─── AES-GCM encryption for refresh_token ────────────────────────────────────
// Key is a 64-char hex string (32 bytes).  We store ciphertext as base64url.

async function importCipherKey(hexKey: string): Promise<CryptoKey> {
  const raw = hexToBytes(hexKey);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptToken(plaintext: string, hexKey: string): Promise<string> {
  const key = await importCipherKey(hexKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  // store as iv:ciphertext, both base64url
  return `${toBase64url(iv)}:${toBase64url(new Uint8Array(cipherBuf))}`;
}

export async function decryptToken(cipher: string, hexKey: string): Promise<string> {
  const [ivB64, ctB64] = cipher.split(':');
  if (!ivB64 || !ctB64) throw new Error('invalid cipher format');
  const key = await importCipherKey(hexKey);
  const iv = fromBase64url(ivB64);
  const ct = fromBase64url(ctB64);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(plain);
}

// ─── GSC API calls ────────────────────────────────────────────────────────────

/** Add the URL-prefix property to the customer's GSC account. */
export async function gscAddProperty(siteUrl: string, accessToken: string): Promise<void> {
  const url = `${GSC_BASE}/sites/${encodeURIComponent(siteUrl)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  // 200 = added, 204 = already exists – both OK
  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`GSC add property failed: ${res.status} ${text.slice(0, 400)}`);
  }
}

/** Submit a sitemap URL to the customer's GSC property. */
export async function gscSubmitSitemap(siteUrl: string, sitemapUrl: string, accessToken: string): Promise<void> {
  const url = `${GSC_BASE}/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GSC submit sitemap failed: ${res.status} ${text.slice(0, 400)}`);
  }
}

// ─── IndexNow (Bing / Yandex) ────────────────────────────────────────────────

const INDEXNOW_ENDPOINTS = [
  'https://api.indexnow.org/indexnow',
];

/**
 * Push URLs to IndexNow (Bing, Yandex, etc).
 * key is an 8+ char hex string hosted at /{key}.txt on the domain.
 */
export async function submitIndexNow(opts: {
  host: string;
  key: string;
  urls: string[];
}): Promise<void> {
  if (!opts.urls.length) return;
  const body = JSON.stringify({
    host: opts.host,
    key: opts.key,
    keyLocation: `https://${opts.host}/${opts.key}.txt`,
    urlList: opts.urls,
  });
  for (const endpoint of INDEXNOW_ENDPOINTS) {
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body,
      });
    } catch {
      // best-effort; don't fail publish on IndexNow errors
    }
  }
}

// ─── GSC Search Analytics (data backfill) ────────────────────────────────────

export type SearchAnalyticsRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type SearchAnalyticsResponse = {
  rows: SearchAnalyticsRow[];
};

/**
 * Query GSC Search Analytics API for performance data.
 * dimensions: e.g. ['query'], ['page'], ['query','page'], ['date']
 */
export async function gscSearchAnalytics(opts: {
  siteUrl: string;
  accessToken: string;
  startDate: string;   // YYYY-MM-DD
  endDate: string;     // YYYY-MM-DD
  dimensions: string[];
  rowLimit?: number;
  startRow?: number;
}): Promise<SearchAnalyticsResponse> {
  const url = `${GSC_BASE}/sites/${encodeURIComponent(opts.siteUrl)}/searchAnalytics/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      startDate: opts.startDate,
      endDate: opts.endDate,
      dimensions: opts.dimensions,
      rowLimit: opts.rowLimit ?? 1000,
      startRow: opts.startRow ?? 0,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GSC analytics query failed: ${res.status} ${text.slice(0, 400)}`);
  }
  const data = await res.json() as SearchAnalyticsResponse;
  return { rows: data.rows ?? [] };
}

/** Fetch every row the Search Analytics API exposes for this dimension. */
export async function gscSearchAnalyticsAll(opts: Omit<Parameters<typeof gscSearchAnalytics>[0], 'rowLimit' | 'startRow'>): Promise<SearchAnalyticsResponse> {
  const rowLimit = 25_000;
  const rows: SearchAnalyticsRow[] = [];
  for (;;) {
    const page = await gscSearchAnalytics({ ...opts, rowLimit, startRow: rows.length });
    rows.push(...page.rows);
    if (page.rows.length < rowLimit) return { rows };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get a fresh access token for a site, using the stored encrypted refresh token.
 * Throws if secrets or cipher are missing.
 */
export async function getAccessToken(opts: {
  gscRefreshTokenCipher: string;
  clientId: string;
  clientSecret: string;
  cipherKey: string;
}): Promise<string> {
  const refreshToken = await decryptToken(opts.gscRefreshTokenCipher, opts.cipherKey);
  return refreshAccessToken({
    refreshToken,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
  });
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('invalid hex key');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toBase64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64url(b64: string): Uint8Array {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
