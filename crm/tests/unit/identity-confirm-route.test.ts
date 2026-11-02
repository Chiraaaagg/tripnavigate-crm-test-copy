import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /auth/confirm: GET never spends the token (link scanners, login CSRF); it
 * 303s to /auth/accept. Only a same-origin POST verifies the token.
 */

const verifyOtp = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: async () => ({ auth: { verifyOtp } }) }));
vi.mock('@/lib/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/config')>();
  const config = original.parseAppConfig({
    APP_ENV: 'local',
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example_not_a_secret',
    NEXT_PUBLIC_SITE_URL: 'https://crm.example.test',
  });
  return { ...original, getAppConfig: () => config };
});

const { GET, POST } = await import('@/app/auth/confirm/route');
const HASH = 'a'.repeat(56);
const BASE = 'https://crm.example.test/auth/confirm';

function location(res: Response): string {
  const url = new URL(res.headers.get('location')!);
  return url.pathname + url.search;
}

function post(fields: Record<string, string>, headers: Record<string, string> = { origin: 'https://crm.example.test' }) {
  const body = new URLSearchParams(fields).toString();
  return new NextRequest(BASE, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyOtp.mockResolvedValue({ error: null });
});

describe('GET /auth/confirm', () => {
  it('keeps redirects on the configured public origin when Next sees an internal hostname', async () => {
    const res = await GET(new NextRequest(`http://localhost:3100/auth/confirm?token_hash=${HASH}&type=invite`));
    expect(new URL(res.headers.get('location')!).origin).toBe('https://crm.example.test');
    expect(verifyOtp).not.toHaveBeenCalled();
  });
  it.each(['invite', 'recovery'])('type=%s 303-redirects to /auth/accept without spending the token', async (type) => {
    const res = await GET(new NextRequest(`${BASE}?token_hash=${HASH}&type=${type}`));
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`/auth/accept?type=${type}&token_hash=${HASH}`);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it.each([
    ['other type', `token_hash=${HASH}&type=signup`],
    ['magiclink', `token_hash=${HASH}&type=magiclink`],
    ['missing hash', 'type=invite'],
    ['too long', `token_hash=${'a'.repeat(513)}&type=invite`],
    ['too short', 'token_hash=abc&type=invite'],
    ['bad characters', `token_hash=${'a'.repeat(20)}%3Cscript%3E&type=recovery`],
  ])('rejects %s', async (_name, query) => {
    const res = await GET(new NextRequest(`${BASE}?${query}`));
    expect(res.status).toBe(303);
    expect(location(res)).toBe('/sign-in?notice=link_invalid');
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});

describe('POST /auth/confirm', () => {
  it('uses the public origin for the password redirect even behind an internal hostname', async () => {
    const res = await POST(new NextRequest('http://localhost:3100/auth/confirm', {
      method: 'POST',
      headers: { origin: 'https://crm.example.test', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ type: 'invite', token_hash: HASH }).toString(),
    }));
    expect(res.headers.get('location')).toBe('https://crm.example.test/onboarding/password');
    expect(verifyOtp).toHaveBeenCalledOnce();
  });

  it('does not trust an internal request origin as an allowed browser origin', async () => {
    const res = await POST(new NextRequest('http://localhost:3100/auth/confirm', {
      method: 'POST',
      headers: { origin: 'http://localhost:3100', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ type: 'invite', token_hash: HASH }).toString(),
    }));
    expect(location(res)).toBe('/sign-in?notice=link_invalid');
    expect(verifyOtp).not.toHaveBeenCalled();
  });
  it.each(['invite', 'recovery'])('same-origin type=%s verifies and lands on the password step', async (type) => {
    const res = await POST(post({ type, token_hash: HASH }));
    expect(res.status).toBe(303);
    expect(location(res)).toBe('/onboarding/password');
    expect(verifyOtp).toHaveBeenCalledWith({ type, token_hash: HASH });
  });

  it('accepts Sec-Fetch-Site: same-origin when Origin is absent', async () => {
    const res = await POST(post({ type: 'invite', token_hash: HASH }, { 'sec-fetch-site': 'same-origin' }));
    expect(location(res)).toBe('/onboarding/password');
  });

  it.each([
    ['cross-site origin', { origin: 'https://evil.example' }],
    ['null origin', { origin: 'null' }],
    ['no origin and cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
    ['no origin headers at all', {}],
  ])('rejects %s without calling the provider', async (_name, headers) => {
    const res = await POST(post({ type: 'invite', token_hash: HASH }, headers as Record<string, string>));
    expect(location(res)).toBe('/sign-in?notice=link_invalid');
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('rejects malformed fields and provider refusals', async () => {
    expect(location(await POST(post({ type: 'signup', token_hash: HASH })))).toBe('/sign-in?notice=link_invalid');
    expect(location(await POST(post({ type: 'invite', token_hash: 'x' })))).toBe('/sign-in?notice=link_invalid');
    expect(verifyOtp).not.toHaveBeenCalled();
    verifyOtp.mockResolvedValue({ error: { code: 'otp_expired' } });
    expect(location(await POST(post({ type: 'recovery', token_hash: HASH })))).toBe('/sign-in?notice=link_invalid');
  });
});
