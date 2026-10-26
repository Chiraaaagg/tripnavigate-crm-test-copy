import { createServerClient } from '@supabase/ssr';
import { type NextRequest, NextResponse } from 'next/server';
import { getAppConfig } from '@/lib/config';
import { authCookieOptions } from '@/lib/supabase/cookie-options';
import {
  buildContentSecurityPolicy,
  CSP_HEADER,
  generateNonce,
  NONCE_HEADER,
  shouldUpgradeInsecureRequests,
  supabaseConnectSources,
} from '@/lib/csp';
import { ROUTES } from '@/modules/identity/session-policy';

/**
 * 1. Sets a per-request nonce-based Content Security Policy (request header,
 *    so Next.js applies the nonce while rendering, and response header).
 * 2. Refreshes the Supabase session cookie.
 * 3. OPTIMISTIC redirect for /app without a verified session.
 *
 * It is not the authorization boundary: every page and server action calls
 * requireStaff(), and the database decides session validity (aal2, barrier,
 * absolute age, recovery case, active staff) on every Data API request.
 */
export async function proxy(request: NextRequest) {
  // Machine-to-machine intake routes (Bitrix events, worker trigger) authenticate
  // themselves (application token / bearer secret) and return JSON: no staff
  // session cookie refresh, no /app redirect, no HTML needing a CSP nonce. The
  // matcher already excludes them; this guard keeps that true if it changes.
  if (isIntegrationApiPath(request.nextUrl.pathname)) return NextResponse.next();

  const config = getAppConfig();
  const nonce = generateNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === 'development',
    upgradeInsecureRequests: shouldUpgradeInsecureRequests(config.siteUrl),
    connectSources: supabaseConnectSources(config.supabaseUrl),
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set(CSP_HEADER, csp);

  const forward = () => {
    // request.cookies.set() rewrites the request's cookie header; carry it over.
    const cookie = request.headers.get('cookie');
    if (cookie === null) requestHeaders.delete('cookie');
    else requestHeaders.set('cookie', cookie);
    return NextResponse.next({ request: { headers: requestHeaders } });
  };

  let response = forward();
  const providerHeaders: Record<string, string> = {};

  const supabase = createServerClient(config.supabaseUrl, config.supabasePublishableKey, {
    cookieOptions: authCookieOptions(config.siteUrl),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = forward();
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        Object.assign(providerHeaders, headers ?? {});
      },
    },
  });

  const hadSessionCookie = request.cookies.getAll().some((c) => /^sb-.+-auth-token/.test(c.name));
  const { data } = await supabase.auth.getClaims();

  const finish = (res: NextResponse) => {
    for (const [key, value] of Object.entries(providerHeaders)) res.headers.set(key, value);
    res.headers.set(CSP_HEADER, csp);
    return res;
  };

  const redirectTo = (path: string) => {
    const target = NextResponse.redirect(new URL(path, request.url));
    for (const cookie of response.cookies.getAll()) target.cookies.set(cookie);
    return finish(target);
  };

  if (request.nextUrl.pathname.startsWith('/app') && !data?.claims) {
    if (hadSessionCookie) return redirectTo(ROUTES.sessionExpired);
    const next = encodeURIComponent(request.nextUrl.pathname);
    return redirectTo(`${ROUTES.signIn}?next=${next}`);
  }
  return finish(response);
}

/** /api/integrations/** only. Staff UI routes keep CSP, cookie refresh and redirects. */
function isIntegrationApiPath(pathname: string): boolean {
  return pathname === '/api/integrations' || pathname.startsWith('/api/integrations/');
}

export const config = {
  matcher: [
    {
      // Everything except static assets and the self-authenticating
      // /api/integrations/* routes. Prefetches are skipped as the Next.js CSP
      // guide recommends (they render no HTML that needs a nonce).
      source: '/((?!_next/static|_next/image|favicon.ico|robots.txt|api/integrations/).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
