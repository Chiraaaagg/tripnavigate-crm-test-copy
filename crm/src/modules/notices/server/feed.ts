import 'server-only';
import { asRpcClient, type RpcClient } from '@/modules/fulfilment/commands';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMySessionStatus } from '@/modules/identity/server/session';
import { NoticeCommandError, noticeHistory, noticeInbox, noticeUnreadCount } from '../commands';

/**
 * Bell reads over GET (route handler src/app/api/notices/route.ts), so the
 * 30-second poll, the load / focus catch-up and Realtime re-reads never queue
 * behind (or in front of) the page's own Server Actions, which Next.js runs
 * one at a time per client.
 *
 *   GET /api/notices?view=inbox[&after=<seq>]   notice_inbox (first page / rows after a seq)
 *   GET /api/notices?view=history[&before=<seq>] notice_history
 *   GET /api/notices?view=count                  notice_unread_count
 *
 * Session gate: the same decision as requireStaff() for every /app page and
 * server action, public.my_session_status() (signed in, aal2, auth time after
 * the barrier, absolute age, no open recovery case, active staff, active
 * membership); anything but 'ok' is 401 (never a redirect, so the bell's fetch
 * fails quietly). The read then runs under the same cookie session; the
 * database again requires a valid staff session and returns only the caller's
 * rows that pass the access re-check. No user id, entity or role is ever read
 * from the request. /api/notices is outside /app, so the proxy refreshes the
 * session cookie but never redirects; route handlers are not cached and every
 * answer says Cache-Control: no-store.
 * Responses: 200 JSON (the same shapes as the reads, zod-validated), 401
 * {error:'session'}, 400 {error:'invalid_input'}, 503 {error:'failed'};
 * always Cache-Control: no-store.
 */

const HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' } as const;
const SEQ = /^(0|[1-9][0-9]{0,15})$/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

function seqParam(params: URLSearchParams, key: string): number | null | undefined {
  const raw = params.get(key);
  if (raw === null || raw === '') return null;
  if (!SEQ.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

export interface NoticeFeedDeps {
  /** public.my_session_status() state for the request ('ok' = may read; anything else is refused). */
  sessionState: string;
  /** RPC client bound to that user's session. */
  client: RpcClient;
}

/** Pure handler (unit-tested with a fake client). */
export async function noticeFeedResponse(url: URL, deps: NoticeFeedDeps): Promise<Response> {
  if (deps.sessionState !== 'ok') return json(401, { error: 'session' });
  const params = url.searchParams;
  const view = params.get('view') ?? 'inbox';
  try {
    if (view === 'inbox') {
      const after = seqParam(params, 'after');
      if (after === undefined) return json(400, { error: 'invalid_input' });
      const data = await noticeInbox(deps.client, after);
      return data ? json(200, data) : json(401, { error: 'session' });
    }
    if (view === 'history') {
      const before = seqParam(params, 'before');
      if (before === undefined) return json(400, { error: 'invalid_input' });
      const data = await noticeHistory(deps.client, before);
      return data ? json(200, data) : json(401, { error: 'session' });
    }
    if (view === 'count') {
      const data = await noticeUnreadCount(deps.client);
      return data ? json(200, data) : json(401, { error: 'session' });
    }
    return json(400, { error: 'invalid_input' });
  } catch (error) {
    if (error instanceof NoticeCommandError && (error.code === 'session' || error.code === 'not_authorized')) {
      return json(401, { error: 'session' });
    }
    if (error instanceof NoticeCommandError && error.code === 'invalid_input') return json(400, { error: 'invalid_input' });
    return json(503, { error: 'failed' });
  }
}

/** Route entry: the app's session decision, then the pure handler with the cookie-bound client. */
export async function noticeFeed(request: Request): Promise<Response> {
  let sessionState: string;
  try {
    sessionState = (await getMySessionStatus()).state;
  } catch {
    return json(503, { error: 'failed' });
  }
  const supabase = await createSupabaseServerClient();
  return noticeFeedResponse(new URL(request.url), { sessionState, client: asRpcClient(supabase) });
}
