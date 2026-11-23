import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// No browser Supabase client exists (session work runs on the server), so
// JavaScript never needs the auth cookie: it must be HttpOnly (AUDIT-026).
const createServerClient = vi.fn();
let siteUrl = 'https://crm.example.test';

vi.mock('@supabase/ssr', () => ({ createServerClient: (...args: unknown[]) => createServerClient(...args) }));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: vi.fn() }) }));
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

const { authCookieOptions } = await import('@/lib/supabase/cookie-options');
const { createSupabaseServerClient } = await import('@/lib/supabase/server');
const { proxy } = await import('@/proxy');

const passedOptions = () => (createServerClient.mock.calls.at(-1)?.[2] as { cookieOptions?: unknown }).cookieOptions;

beforeEach(() => {
  vi.clearAllMocks();
  siteUrl = 'https://crm.example.test';
  createServerClient.mockReturnValue({ auth: { getClaims: async () => ({ data: null }) } });
});

describe('auth cookie options', () => {
  it('are HttpOnly, SameSite=Lax, path / and Secure on an https site', () => {
    expect(authCookieOptions('https://crm.example.test')).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  });

  it('are not Secure on a plain-http local site (the browser would drop them)', () => {
    expect(authCookieOptions('http://127.0.0.1:3000')).toMatchObject({ httpOnly: true, secure: false });
  });

  it('are used by the server client and by the proxy session refresh', async () => {
    await createSupabaseServerClient();
    expect(passedOptions()).toEqual(authCookieOptions(siteUrl));
    await proxy(new NextRequest('https://crm.example.test/sign-in'));
    expect(passedOptions()).toEqual(authCookieOptions(siteUrl));
  });
});
