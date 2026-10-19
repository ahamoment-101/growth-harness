import { describe, expect, it, vi } from 'vitest';
import { createGoogleLogin, fetchGoogleIdentity, verifyOAuthState } from './oauth';

describe('application Google OAuth', () => {
  it('creates a PKCE login request and verifies the signed state', async () => {
    const login = await createGoogleLogin({
      clientId: 'client',
      redirectUri: 'https://app.example/api/auth/google/callback',
      secret: 'test-secret',
      returnTo: '/website/s1/strategy',
      now: 1000,
    });
    const url = new URL(login.url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBeTruthy();
    const state = await verifyOAuthState({
      cookieValue: login.cookieValue,
      returnedState: url.searchParams.get('state')!,
      secret: 'test-secret',
      now: 1100,
    });
    expect(state.returnTo).toBe('/website/s1/strategy');
  });

  it('rejects tampered, mismatched, and expired state', async () => {
    const login = await createGoogleLogin({ clientId: 'c', redirectUri: 'https://x/cb', secret: 's', now: 1000 });
    const state = new URL(login.url).searchParams.get('state')!;
    await expect(verifyOAuthState({ cookieValue: `${login.cookieValue}x`, returnedState: state, secret: 's', now: 1100 })).rejects.toThrow();
    await expect(verifyOAuthState({ cookieValue: login.cookieValue, returnedState: 'other', secret: 's', now: 1100 })).rejects.toThrow();
    await expect(verifyOAuthState({ cookieValue: login.cookieValue, returnedState: state, secret: 's', now: 700_001 })).rejects.toThrow();
  });

  it('does not preserve protocol-relative return locations', async () => {
    const login = await createGoogleLogin({ clientId: 'c', redirectUri: 'https://x/cb', secret: 's', returnTo: '//evil.example' });
    const state = await verifyOAuthState({
      cookieValue: login.cookieValue,
      returnedState: new URL(login.url).searchParams.get('state')!,
      secret: 's',
    });
    expect(state.returnTo).toBe('/');
  });

  it('verifies the Google ID token signature and matches the userinfo subject', async () => {
    const keys = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    const keyPair = keys as CryptoKeyPair;
    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const signingInput = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode({
      nonce: 'nonce-1', aud: 'client-1', iss: 'https://accounts.google.com',
      exp: Math.floor(Date.now() / 1000) + 300, sub: 'google-sub-1',
    })}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, new TextEncoder().encode(signingInput));
    const encodedSignature = Buffer.from(signature).toString('base64url');
    const idToken = `${signingInput}.${encodedSignature}`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256' }] }), {
        headers: { 'Cache-Control': 'max-age=300' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sub: 'google-sub-1', email: 'owner@example.com', email_verified: true, name: 'Owner', picture: '',
      })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(fetchGoogleIdentity('access', idToken, 'nonce-1', 'client-1')).resolves.toMatchObject({
        sub: 'google-sub-1', email: 'owner@example.com', emailVerified: true,
      });
      const tampered = `${signingInput}.${encodedSignature[0] === 'A' ? 'B' : 'A'}${encodedSignature.slice(1)}`;
      await expect(fetchGoogleIdentity('access', tampered, 'nonce-1', 'client-1')).rejects.toThrow('signature');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
