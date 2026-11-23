import { NOTICE_ERROR_TEXT, NOTICE_TEXT, type NoticeActionResult, type NoticeHistoryDTO, type NoticeInboxDTO } from './contracts';
import { parseNoticeHistory, parseNoticeInbox } from './validate';

/**
 * Browser side of the bell reads (GET /api/notices, src/modules/notices/server/feed.ts).
 * Plain fetch with the page's own cookies, no-store; the answer is validated
 * by validate.ts (unknown keys stripped). No zod here: this module is in the
 * browser bundle and zod 4 probes `new Function`, which the CSP blocks.
 * Never throws: a failure answers { ok: false } so the bell keeps its last
 * list ("Notices may be out of date").
 */

export const NOTICE_FEED_PATH = '/api/notices';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function get<T>(path: string, parse: (v: unknown) => T | null, fetcher: Fetch): Promise<NoticeActionResult<T>> {
  let res: Response;
  try {
    res = await fetcher(path, { method: 'GET', cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
  } catch {
    return { ok: false, code: 'failed', message: NOTICE_TEXT.outOfDate };
  }
  if (res.status === 401) return { ok: false, code: 'session', message: NOTICE_ERROR_TEXT.session };
  if (!res.ok) return { ok: false, code: 'failed', message: NOTICE_TEXT.outOfDate };
  try {
    const data = parse(await res.json());
    return data ? { ok: true, data } : { ok: false, code: 'failed', message: NOTICE_TEXT.outOfDate };
  } catch {
    return { ok: false, code: 'failed', message: NOTICE_TEXT.outOfDate };
  }
}

const defaultFetch: Fetch = (input, init) => globalThis.fetch(input, init);

export function fetchNoticeInbox(afterSeq: number | null, fetcher: Fetch = defaultFetch): Promise<NoticeActionResult<NoticeInboxDTO>> {
  const q = afterSeq === null ? 'view=inbox' : `view=inbox&after=${encodeURIComponent(String(afterSeq))}`;
  return get(`${NOTICE_FEED_PATH}?${q}`, parseNoticeInbox, fetcher);
}

export function fetchNoticeHistory(beforeSeq: number | null, fetcher: Fetch = defaultFetch): Promise<NoticeActionResult<NoticeHistoryDTO>> {
  const q = beforeSeq === null ? 'view=history' : `view=history&before=${encodeURIComponent(String(beforeSeq))}`;
  return get(`${NOTICE_FEED_PATH}?${q}`, parseNoticeHistory, fetcher);
}

export const REALTIME_TOKEN_PATH = '/api/realtime-token';

/** The Realtime access token for this tab (GET, no-store); null when signed out or on any failure. Never logged. */
export async function fetchRealtimeToken(fetcher: Fetch = defaultFetch): Promise<string | null> {
  try {
    const res = await fetcher(REALTIME_TOKEN_PATH, { method: 'GET', cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    const token = body !== null && typeof body === 'object' ? (body as { accessToken?: unknown }).accessToken : null;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}
