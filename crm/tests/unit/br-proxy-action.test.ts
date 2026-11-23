import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Booking reliability B1-8 (trace T-e): without a verified session the proxy
 * still redirects every /app page request, but passes a server action POST
 * (POST + Next-Action) on to the action, whose own gate decides.
 */

const getClaims = vi.fn();
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getClaims } }) }));
vi.mock('@/lib/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/config')>();
  const config = original.parseAppConfig({
    APP_ENV: 'local',
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example_not_a_secret',
    NEXT_PUBLIC_SITE_URL: 'http://127.0.0.1:3000',
  });
  return { ...original, getAppConfig: () => config };
});

const { proxy } = await import('@/proxy');

const PAGE = 'http://127.0.0.1:3000/app/deals/d1/book/travellers';

function req(method: string, opts: { action?: boolean; cookie?: boolean } = {}) {
  const headers = new Headers();
  if (opts.action) headers.set('next-action', '7f00000000000000000000000000000000000000');
  if (opts.cookie) headers.set('cookie', 'sb-127-auth-token=not-a-session');
  return new NextRequest(PAGE, { method, headers });
}

const passedOn = (res: Response) => res.headers.get('x-middleware-next') === '1';

beforeEach(() => {
  getClaims.mockResolvedValue({ data: null });
});

describe('proxy: optimistic /app check', () => {
  it('a page request without a session is redirected to sign-in', async () => {
    const res = await proxy(req('GET'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/sign-in?next=');
  });

  it('a page request with a dead session cookie is redirected to session-expired', async () => {
    const res = await proxy(req('GET', { cookie: true }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/session-expired');
  });

  it.each([{ cookie: false }, { cookie: true }])('a server action POST without a session goes on to the action (cookie: $cookie)', async ({ cookie }) => {
    const res = await proxy(req('POST', { action: true, cookie }));
    expect(res.headers.get('location')).toBeNull();
    expect(passedOn(res)).toBe(true);
  });

  it('a POST without the Next-Action header is still redirected', async () => {
    const res = await proxy(req('POST'));
    expect(res.status).toBe(307);
  });

  it('a GET carrying a Next-Action header is still redirected', async () => {
    const res = await proxy(req('GET', { action: true }));
    expect(res.status).toBe(307);
  });

  it('with a verified session nothing changes', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: 'a0000000-0000-4000-8000-000000000001' } } });
    expect(passedOn(await proxy(req('GET')))).toBe(true);
    expect(passedOn(await proxy(req('POST', { action: true })))).toBe(true);
  });
});
