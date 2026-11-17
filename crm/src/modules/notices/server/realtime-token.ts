import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMySessionStatus } from '@/modules/identity/server/session';

/**
 * Realtime access token over GET (route src/app/api/realtime-token/route.ts),
 * so the bell's Realtime connect and re-auth never queue with the page's own
 * Server Actions. Same session gate as /api/notices and requireStaff():
 * public.my_session_status() must be 'ok' (signed in, aal2, barrier, absolute
 * age, no recovery case, active staff, active membership), else 401.
 *
 * Answers only { accessToken, expiresAt } (the short-lived access JWT the page
 * cookie already holds; never the refresh token). Cache-Control: no-store;
 * the token is never logged. Realtime verifies the JWT and applies the
 * staff_notices select policy (own rows + access re-check) on every change.
 */

const HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' } as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

export interface RealtimeTokenDeps {
  sessionState: string;
  /** The session's access token and its expiry (seconds since epoch), read only after the gate. */
  readSession: () => Promise<{ accessToken: string; expiresAt: number | null } | null>;
}

/** Pure handler (unit-tested). */
export async function realtimeTokenResponse(deps: RealtimeTokenDeps): Promise<Response> {
  if (deps.sessionState !== 'ok') return json(401, { error: 'session' });
  let session: Awaited<ReturnType<RealtimeTokenDeps['readSession']>>;
  try {
    session = await deps.readSession();
  } catch {
    return json(503, { error: 'failed' });
  }
  if (!session?.accessToken) return json(401, { error: 'session' });
  return json(200, { accessToken: session.accessToken, expiresAt: session.expiresAt });
}

export async function realtimeToken(): Promise<Response> {
  let sessionState: string;
  try {
    sessionState = (await getMySessionStatus()).state;
  } catch {
    return json(503, { error: 'failed' });
  }
  return realtimeTokenResponse({
    sessionState,
    readSession: async () => {
      const supabase = await createSupabaseServerClient();
      const { data } = await supabase.auth.getSession();
      const s = data.session;
      return s ? { accessToken: s.access_token, expiresAt: s.expires_at ?? null } : null;
    },
  });
}
