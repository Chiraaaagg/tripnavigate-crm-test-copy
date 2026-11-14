import type { CookieOptionsWithName } from '@supabase/ssr';

/**
 * Options for the Supabase auth cookies (AUDIT-026). Sessions are read and
 * refreshed only on the server (proxy and server client); no browser code
 * needs the cookie, so it is HttpOnly. Secure on https sites; a plain-http
 * local site would otherwise have the cookie dropped by the browser.
 */
export function authCookieOptions(siteUrl: string): CookieOptionsWithName {
  return {
    httpOnly: true,
    secure: new URL(siteUrl).protocol === 'https:',
    sameSite: 'lax',
    path: '/',
  };
}
