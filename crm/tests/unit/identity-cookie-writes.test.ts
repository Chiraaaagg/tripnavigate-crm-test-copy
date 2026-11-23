import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Milestone A section 5 / audit finding 9: the cookies actually WRITTEN when a
 * session is refreshed carry the hardened flags, on both write paths:
 *   - the proxy (Set-Cookie on the response), and
 *   - the server client (next/headers cookie store).
 * Unlike auth-cookie-options.test.ts, @supabase/ssr is NOT mocked: a real
 * refresh runs against a stubbed Auth endpoint (no network, no stack).
 */

const cookieSets: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
let requestCookies: Array<{ name: string; value: string }> = [];
let siteUrl = 'https://crm.example.test';

vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => requestCookies,
    set: (name: string, value: string, options: Record<string, unknown>) => cookieSets.push({ name, value, options }),
  }),
}));
vi.mock('@/lib/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/config')>();
  return {
    ...original,
    getAppConfig: () =>
      original.parseAppConfig({
        APP_ENV: 'local',
        NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example_not_a_secret',
        NEXT_PUBLIC_SITE_URL: siteUrl,
      }),
  };
});

const { createSupabaseServerClient } = await import('@/lib/supabase/server');
const { proxy } = await import('@/proxy');

// Storage key the client derives from http://127.0.0.1:54321 ("sb-" + first host label).
const COOKIE = 'sb-127-auth-token';
const USER = { id: 'a0000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'synthetic@example.test' };

const b64url = (value: string) => Buffer.from(value).toString('base64url');
function jwt(expiresAt: number, label: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub: USER.id, aud: 'authenticated', role: 'authenticated', aal: 'aal2', exp: expiresAt, session_id: label }));
  return `${header}.${payload}.${b64url(`signature-${label}`)}`;
}
function session(expiresAt: number, label: string) {
  return {
    access_token: jwt(expiresAt, label),
    refresh_token: `refresh-${label}`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: expiresAt,
    user: USER,
  };
}
const encode = (value: unknown) => `base64-${b64url(JSON.stringify(value))}`;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes('/auth/v1/token') && url.includes('grant_type=refresh_token')) {
    return new Response(JSON.stringify(session(nowSeconds() + 3600, 'refreshed')), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('/auth/v1/user')) {
    return new Response(JSON.stringify(USER), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: 'not stubbed' }), { status: 404, headers: { 'content-type': 'application/json' } });
});

beforeEach(() => {
  cookieSets.length = 0;
  fetchStub.mockClear();
  vi.stubGlobal('fetch', fetchStub);
  siteUrl = 'https://crm.example.test';
  // An expired access token with a refresh token: reading the claims refreshes it.
  requestCookies = [{ name: COOKIE, value: encode(session(nowSeconds() - 600, 'expired')) }];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const refreshCalls = () => fetchStub.mock.calls.filter(([u]) => String(u instanceof Request ? u.url : u).includes('grant_type=refresh_token'));

/** The Set-Cookie lines for the auth cookie (or its chunks) on a proxy response. */
function authSetCookies(response: Response): string[] {
  return response.headers.getSetCookie().filter((line) => line.startsWith(`${COOKIE}=`) || line.startsWith(`${COOKIE}.`));
}

/** Joins the (possibly chunked) written cookie values and decodes the session. */
function decodeWritten(lines: string[]): { refresh_token?: string } {
  const parts = lines
    .map((line) => line.split(';')[0]!)
    .map((pair) => ({ name: pair.slice(0, pair.indexOf('=')), value: pair.slice(pair.indexOf('=') + 1) }))
    .filter((c) => c.value !== '')
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  const raw = parts.map((c) => decodeURIComponent(c.value)).join('');
  return JSON.parse(Buffer.from(raw.replace(/^base64-/, ''), 'base64url').toString('utf8')) as { refresh_token?: string };
}

describe('proxy session refresh writes hardened cookies', () => {
  it('https site: HttpOnly, Secure, SameSite=Lax and path / on every written auth cookie', async () => {
    const request = new NextRequest('https://crm.example.test/app', { headers: { cookie: `${COOKIE}=${requestCookies[0]!.value}` } });
    const response = await proxy(request);
    expect(refreshCalls()).toHaveLength(1);
    const written = authSetCookies(response);
    expect(written.length).toBeGreaterThan(0);
    for (const line of written) {
      expect(line).toMatch(/;\s*HttpOnly/i);
      expect(line).toMatch(/;\s*Secure/i);
      expect(line).toMatch(/;\s*SameSite=Lax/i);
      expect(line).toMatch(/;\s*Path=\//i);
    }
    // The refreshed session, not the expired one, is what the browser keeps.
    expect(decodeWritten(written).refresh_token).toBe('refresh-refreshed');
  });

  it('plain-http local site: HttpOnly and SameSite=Lax, not Secure (the browser would drop it)', async () => {
    siteUrl = 'http://127.0.0.1:3000';
    const request = new NextRequest('http://127.0.0.1:3000/app', { headers: { cookie: `${COOKIE}=${requestCookies[0]!.value}` } });
    const written = authSetCookies(await proxy(request));
    expect(written.length).toBeGreaterThan(0);
    for (const line of written) {
      expect(line).toMatch(/;\s*HttpOnly/i);
      expect(line).toMatch(/;\s*SameSite=Lax/i);
      expect(line).not.toMatch(/;\s*Secure/i);
    }
  });
});

describe('server client session refresh writes hardened cookies', () => {
  it('https site: every cookie written through next/headers is HttpOnly, Secure and SameSite lax', async () => {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.getClaims();
    expect(refreshCalls()).toHaveLength(1);
    const written = cookieSets.filter((c) => c.name === COOKIE || c.name.startsWith(`${COOKIE}.`));
    expect(written.length).toBeGreaterThan(0);
    for (const c of written) {
      expect(c.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    }
  });

  it('plain-http local site: HttpOnly and SameSite lax without Secure', async () => {
    siteUrl = 'http://127.0.0.1:3000';
    const supabase = await createSupabaseServerClient();
    await supabase.auth.getClaims();
    const written = cookieSets.filter((c) => c.name === COOKIE || c.name.startsWith(`${COOKIE}.`));
    expect(written.length).toBeGreaterThan(0);
    for (const c of written) {
      expect(c.options).toMatchObject({ httpOnly: true, secure: false, sameSite: 'lax' });
    }
  });
});
