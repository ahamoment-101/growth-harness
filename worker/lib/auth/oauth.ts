import { randomToken, sha256, signJson, verifySignedJson } from './crypto';
import type { VerifiedGoogleIdentity } from './store';

export type OAuthState = {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  expiresAt: number;
  linkUserId?: string;
};

function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  return value;
}

export async function createGoogleLogin(input: {
  clientId: string;
  redirectUri: string;
  secret: string;
  returnTo?: string;
  now?: number;
  linkUserId?: string;
}): Promise<{ url: string; cookieValue: string }> {
  const verifier = randomToken(48);
  const state: OAuthState = {
    state: randomToken(),
    nonce: randomToken(),
    verifier,
    returnTo: safeReturnTo(input.returnTo),
    expiresAt: (input.now ?? Date.now()) + 10 * 60 * 1000,
    ...(input.linkUserId ? { linkUserId: input.linkUserId } : {}),
  };
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: state.state,
    nonce: state.nonce,
    code_challenge: await sha256(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return {
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    cookieValue: await signJson(state, input.secret),
  };
}

export async function verifyOAuthState(input: {
  cookieValue: string;
  returnedState: string;
  secret: string;
  now?: number;
}): Promise<OAuthState> {
  const state = await verifySignedJson<OAuthState>(input.cookieValue, input.secret);
  if (!state || state.state !== input.returnedState || state.expiresAt <= (input.now ?? Date.now())) {
    throw new Error('OAuth state is invalid or expired');
  }
  return state;
}

export async function exchangeGoogleCode(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  verifier: string;
}): Promise<{ accessToken: string; idToken: string }> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: input.verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json() as { access_token?: string; id_token?: string; error?: string };
  if (!response.ok || !payload.access_token || !payload.id_token) throw new Error(`Google token exchange failed (${response.status})`);
  return { accessToken: payload.access_token, idToken: payload.id_token };
}

type GoogleIdClaims = { nonce: string; aud: string; iss: string; exp: number; sub: string };
type GoogleJwk = JsonWebKey & { kid?: string; alg?: string };

let googleJwksCache: { expiresAt: number; keys: GoogleJwk[] } | null = null;

function base64UrlBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function idTokenParts(idToken: string): { header: { kid: string; alg: string }; claims: GoogleIdClaims; signingInput: string; signature: Uint8Array } | null {
  try {
    const [encodedHeader, encodedClaims, encodedSignature, extra] = idToken.split('.');
    if (!encodedHeader || !encodedClaims || !encodedSignature || extra) return null;
    const header = JSON.parse(new TextDecoder().decode(base64UrlBytes(encodedHeader))) as Record<string, unknown>;
    const claims = JSON.parse(new TextDecoder().decode(base64UrlBytes(encodedClaims))) as Record<string, unknown>;
    return {
      header: { kid: String(header.kid || ''), alg: String(header.alg || '') },
      claims: {
        nonce: String(claims.nonce || ''), aud: String(claims.aud || ''), iss: String(claims.iss || ''),
        exp: Number(claims.exp || 0), sub: String(claims.sub || ''),
      },
      signingInput: `${encodedHeader}.${encodedClaims}`,
      signature: base64UrlBytes(encodedSignature),
    };
  } catch {
    return null;
  }
}

async function googleJwks(): Promise<GoogleJwk[]> {
  if (googleJwksCache && googleJwksCache.expiresAt > Date.now()) return googleJwksCache.keys;
  const response = await fetch('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(10_000) });
  const payload = await response.json() as { keys?: GoogleJwk[] };
  if (!response.ok || !Array.isArray(payload.keys)) throw new Error(`Google signing keys failed (${response.status})`);
  const maxAge = Number(response.headers.get('Cache-Control')?.match(/max-age=(\d+)/)?.[1] || 300);
  googleJwksCache = { keys: payload.keys, expiresAt: Date.now() + Math.max(60, Math.min(maxAge, 3600)) * 1000 };
  return payload.keys;
}

async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdClaims> {
  const parts = idTokenParts(idToken);
  if (!parts || parts.header.alg !== 'RS256' || !parts.header.kid) throw new Error('Google ID token format is invalid');
  const jwk = (await googleJwks()).find((item) => item.kid === parts.header.kid && (!item.alg || item.alg === 'RS256'));
  if (!jwk) throw new Error('Google ID token signing key is unknown');
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, parts.signature as BufferSource, new TextEncoder().encode(parts.signingInput),
  );
  if (!valid) throw new Error('Google ID token signature is invalid');
  return parts.claims;
}

export async function fetchGoogleIdentity(
  accessToken: string,
  idToken: string,
  expectedNonce: string,
  expectedAudience: string,
): Promise<VerifiedGoogleIdentity> {
  const claims = await verifyGoogleIdToken(idToken);
  if (
    claims.nonce !== expectedNonce ||
    claims.aud !== expectedAudience ||
    !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) ||
    claims.exp * 1000 <= Date.now() || !claims.sub
  ) throw new Error('Google ID token claims are invalid');
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`Google user profile failed (${response.status})`);
  if (String(payload.sub || '') !== claims.sub) throw new Error('Google user profile subject does not match ID token');
  return {
    sub: String(payload.sub || ''),
    email: String(payload.email || ''),
    emailVerified: payload.email_verified === true,
    name: String(payload.name || ''),
    picture: String(payload.picture || ''),
  };
}
