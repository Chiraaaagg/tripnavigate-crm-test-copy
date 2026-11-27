import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Booking reliability B1-8 (trace T-e): without a verified session the proxy
 * still redirects every /app page request, but passes a server action POST
 * (POST + Next-Action) on to the action, whose own gate decides, on the Book
 * now addresses only. Every other /app address keeps the redirect for action
 * POSTs too (review go-live 1, P1-1: its actions use requireStaff(), whose
 * redirect would leave the page and lose what was typed).
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

function req(method: string, opts: { action?: boolean; cookie?: boolean; url?: string } = {}) {
  const headers = new Headers();
  if (opts.action) headers.set('next-action', '7f00000000000000000000000000000000000000');
  if (opts.cookie) headers.set('cookie', 'sb-127-auth-token=not-a-session');
  return new NextRequest(opts.url ?? PAGE, { method, headers });
}

const ORIGIN = 'http://127.0.0.1:3000';

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

  it.each(['/app/deals/d1/book', '/app/deals/d1/book/', '/app/deals/d1/book/travellers', '/app/deals/d1/book/stay', '/app/deals/d1/book/finish'])(
    'a server action POST on the Book now address %s goes on to the action',
    async (path) => {
      const res = await proxy(req('POST', { action: true, url: `${ORIGIN}${path}` }));
      expect(passedOn(res)).toBe(true);
    },
  );

  it.each([
    '/app',
    '/app/deals/d1',
    '/app/deals/d1/intake',
    '/app/deals/d1/book/files/f1',
    '/app/deals/d1/bookings',
    '/app/purchase/t1',
    '/app/flight/deals/d1',
    '/app/visa/t1',
    '/app/accounts',
    '/app/quotations/q1',
  ])('a server action POST elsewhere under /app (%s) is still answered by the proxy, as before', async (path) => {
    for (const cookie of [false, true]) {
      const res = await proxy(req('POST', { action: true, cookie, url: `${ORIGIN}${path}` }));
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain(cookie ? '/session-expired' : '/sign-in?next=');
      expect(passedOn(res)).toBe(false);
    }
  });

  it('with a verified session nothing changes', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: 'a0000000-0000-4000-8000-000000000001' } } });
    expect(passedOn(await proxy(req('GET')))).toBe(true);
    expect(passedOn(await proxy(req('POST', { action: true })))).toBe(true);
    expect(passedOn(await proxy(req('POST', { action: true, url: `${ORIGIN}/app/purchase/t1` })))).toBe(true);
  });
});
