'use server';

import { requireStaff } from '@/modules/identity/server/session';

/**
 * Access token for the browser's Realtime connection (live deal refresh).
 *
 * The browser does not run its own Supabase Auth client: two token refreshers
 * (proxy + browser) would race under refresh-token rotation. Instead the
 * Realtime client asks this action whenever it connects or re-authenticates.
 * The request passes through the proxy, which refreshes the session cookie, so
 * the token is current. requireStaff() applies the full session gate first.
 *
 * Only the short-lived access JWT is returned (it is already readable by the
 * page's own cookie); never the refresh token. Realtime verifies the JWT and
 * evaluates the deals RLS policy for this user on every change.
 */
export async function getRealtimeAccessToken(): Promise<string | null> {
  const staff = await requireStaff();
  const { data } = await staff.supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
