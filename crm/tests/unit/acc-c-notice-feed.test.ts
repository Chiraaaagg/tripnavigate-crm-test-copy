import { describe, expect, it } from 'vitest';
import type { RpcClient } from '@/modules/fulfilment/commands';
import type { NoticeInboxDTO } from '@/modules/notices/contracts';
import { fetchNoticeInbox } from '@/modules/notices/feed-client';
import { NOTICE_POLL_MS, startNoticeLive, type NoticeTimers } from '@/modules/notices/live';
import { noticeFeedResponse } from '@/modules/notices/server/feed';

/**
 * Track C: bell reads over GET /api/notices (src/modules/notices/server/feed.ts)
 * and the catch-up pause while notices are off (live.ts).
 */

const OTHER = 'a0000000-0000-4000-8000-000000000001';
const NOTICE = {
  noticeId: '11111111-1111-4111-8111-111111111111', seq: 7, kind: 'task_new', priority: 'normal', escalated: false,
  createdAt: '2026-11-10T09:00:00Z', readAt: null, doneAt: null, resolvedAt: null, resolvedReason: null,
  dealId: '22222222-2222-4222-8222-222222222222', dealReference: 'SYN-DEL-001', taskId: '33333333-3333-4333-8333-333333333333',
  department: 'purchase', params: { dealReference: 'SYN-DEL-001', department: 'purchase' },
  link: { kind: 'task', id: '33333333-3333-4333-8333-333333333333' },
};
const INBOX = { enabled: true, unreadCount: 1, urgentCount: 0, latestSeq: 7, soundOn: false, popupsOn: true, items: [NOTICE] } as unknown as NoticeInboxDTO;

/** Fake session client: records every call; answers as the database would for the session's own user. */
function fakeClient(answer: (fn: string, args: Record<string, unknown>) => { data: unknown; error: { code?: string; message?: string } | null }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: RpcClient = {
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      calls.push({ fn, args });
      return answer(fn, args);
    },
  };
  return { client, calls };
}
const url = (q: string) => new URL(`http://127.0.0.1:3000/api/notices?${q}`);

describe('GET /api/notices (noticeFeedResponse)', () => {
  it('answers 401 without a verified session and never calls the database', async () => {
    const f = fakeClient(() => ({ data: INBOX, error: null }));
    const res = await noticeFeedResponse(url('view=inbox'), { sessionState: 'no_session', client: f.client });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'session' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(f.calls).toEqual([]);
  });

  it('refuses every session state the app refuses (aal1 = mfa_required, expired, revoked, recovery, inactive, no membership) with 401 and no read', async () => {
    const f = fakeClient(() => ({ data: INBOX, error: null }));
    for (const state of ['no_session', 'mfa_required', 'session_expired', 'session_revoked', 'recovery_pending', 'onboarding_incomplete',
      'inactive', 'no_membership']) {
      const res = await noticeFeedResponse(url('view=inbox'), { sessionState: state, client: f.client });
      expect(res.status).toBe(401);
    }
    expect(f.calls).toEqual([]);
  });

  it('answers 401 when the database refuses the session (null read or 42501)', async () => {
    const nul = fakeClient(() => ({ data: null, error: null }));
    expect((await noticeFeedResponse(url('view=inbox'), { sessionState: 'ok', client: nul.client })).status).toBe(401);
    const refused = fakeClient(() => ({ data: null, error: { code: '42501', message: 'not_authorized' } }));
    expect((await noticeFeedResponse(url('view=count'), { sessionState: 'ok', client: refused.client })).status).toBe(401);
  });

  it('never takes a user from the request: other users\' rows are never asked for', async () => {
    const f = fakeClient(() => ({ data: INBOX, error: null }));
    const res = await noticeFeedResponse(url(`view=inbox&after=5&userId=${OTHER}&recipient_user_id=${OTHER}&p_user=${OTHER}`),
      { sessionState: 'ok', client: f.client });
    expect(res.status).toBe(200);
    expect(f.calls).toEqual([{ fn: 'notice_inbox', args: { p_after_seq: 5, p_limit: 50 } }]);
    expect(JSON.stringify(f.calls)).not.toContain(OTHER);
    expect(await res.json()).toEqual(INBOX);
  });

  it('strips keys the read does not allow and refuses bad input', async () => {
    const f = fakeClient(() => ({ data: { ...INBOX, items: [{ ...NOTICE, actor_user_id: OTHER, recipientUserId: OTHER }] }, error: null }));
    const body = await (await noticeFeedResponse(url('view=inbox'), { sessionState: 'ok', client: f.client })).json();
    expect(JSON.stringify(body)).not.toContain(OTHER);
    for (const q of ['view=inbox&after=-1', 'view=inbox&after=1.5', 'view=history&before=x', 'view=nope']) {
      expect((await noticeFeedResponse(url(q), { sessionState: 'ok', client: f.client })).status).toBe(400);
    }
    const broken = fakeClient(() => ({ data: { enabled: 'yes' }, error: null }));
    expect((await noticeFeedResponse(url('view=inbox'), { sessionState: 'ok', client: broken.client })).status).toBe(503);
  });

  it('serves history and the unread count', async () => {
    const f = fakeClient((fn) => ({ data: fn === 'notice_history' ? { enabled: true, items: [], nextBefore: null } : { unreadCount: 3, urgentCount: 1 }, error: null }));
    expect(await (await noticeFeedResponse(url('view=history&before=9'), { sessionState: 'ok', client: f.client })).json())
      .toEqual({ enabled: true, items: [], nextBefore: null });
    expect(await (await noticeFeedResponse(url('view=count'), { sessionState: 'ok', client: f.client })).json()).toEqual({ unreadCount: 3, urgentCount: 1 });
    expect(f.calls.map((c) => c.args)).toEqual([{ p_before_seq: 9, p_limit: 50 }, {}]);
  });
});

describe('browser fetch client', () => {
  it('GETs no-store with the page cookies and maps 401 / failures without throwing', async () => {
    const seen: Array<{ input: string; init?: RequestInit }> = [];
    const ok = await fetchNoticeInbox(7, async (input, init) => {
      seen.push({ input, init });
      return new Response(JSON.stringify(INBOX), { status: 200 });
    });
    expect(ok).toEqual({ ok: true, data: INBOX });
    expect(seen[0]).toMatchObject({ input: '/api/notices?view=inbox&after=7', init: { method: 'GET', cache: 'no-store', credentials: 'same-origin' } });
    expect(await fetchNoticeInbox(null, async () => new Response('{}', { status: 401 }))).toMatchObject({ ok: false, code: 'session' });
    expect(await fetchNoticeInbox(null, async () => { throw new Error('offline'); })).toMatchObject({ ok: false, code: 'failed' });
  });
});

describe('catch-up while notices are off', () => {
  function fakeTimers() {
    let now = 0;
    let id = 0;
    const tasks = new Map<number, { at: number; every: number | null; fn: () => void }>();
    const timers: NoticeTimers = {
      setTimeout: (fn, ms) => (tasks.set(++id, { at: now + ms, every: null, fn }), id),
      clearTimeout: (h) => void tasks.delete(h as number),
      setInterval: (fn, ms) => (tasks.set(++id, { at: now + ms, every: ms, fn }), id),
      clearInterval: (h) => void tasks.delete(h as number),
    };
    const advance = async (ms: number) => {
      const end = now + ms;
      for (;;) {
        const next = [...tasks.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [key, t] = next;
        now = t.at;
        if (t.every) t.at += t.every;
        else tasks.delete(key);
        t.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = end;
    };
    return { timers, advance, intervals: () => [...tasks.values()].filter((t) => t.every !== null).length };
  }

  it('reads once on load, stops the 30 s poll while off, and resumes after a focus read says on', async () => {
    const t = fakeTimers();
    let enabled = false;
    const reads: Array<number | null> = [];
    const handle = startNoticeLive({
      read: async (after) => {
        reads.push(after);
        return { ...INBOX, enabled, items: enabled ? INBOX.items : [] };
      },
      onState: () => undefined,
      subscribe: () => { throw new Error('no realtime'); },
      timers: t.timers,
    });
    await t.advance(10);
    expect(t.intervals()).toBe(0);
    const afterLoad = reads.length;
    await t.advance(NOTICE_POLL_MS * 3);
    expect(reads.length).toBe(afterLoad);
    enabled = true;
    handle.focus();
    await t.advance(10);
    expect(t.intervals()).toBe(1);
    const afterFocus = reads.length;
    await t.advance(NOTICE_POLL_MS + 10);
    expect(reads.length).toBeGreaterThan(afterFocus);
    handle.stop();
  });
});

describe('no zod in the browser graph of the bell and the banner', () => {
  it('feed-client, validate, contracts, live, group, sound-policy and booking-change import no zod at runtime', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const src = join(process.cwd(), 'src');
    const resolve = (from: string, spec: string): string | null => {
      const base = spec.startsWith('@/') ? join(src, spec.slice(2)) : spec.startsWith('.') ? join(dirname(from), spec) : null;
      if (!base) return null;
      for (const ext of ['', '.ts', '.tsx', '/index.ts']) if (existsSync(base + ext) && !base.endsWith('/') && (ext !== '' || /\.tsx?$/.test(base))) return base + ext;
      return null;
    };
    const runtimeImports = (file: string): string[] => {
      const code = readFileSync(file, 'utf8');
      const out: string[] = [];
      for (const m of code.matchAll(/^\s*(import|export)\s+(?!type\b)([\s\S]*?)\s+from\s+'([^']+)'/gm)) {
        const clause = m[2]!.trim();
        // import { type A, type B } from '...' is type-only too.
        if (/^\{[^}]*\}$/.test(clause) && clause.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean).every((x) => x.startsWith('type '))) continue;
        out.push(m[3]!);
      }
      return out;
    };
    const roots = ['modules/notices/feed-client.ts', 'modules/notices/group.ts', 'modules/notices/live.ts', 'modules/notices/sound-policy.ts',
      'modules/notices/href.ts', 'modules/procurement/booking-change.ts'].map((f) => join(src, f));
    const seen = new Set<string>();
    const zod: string[] = [];
    const stack = [...roots];
    while (stack.length) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of runtimeImports(file)) {
        if (spec === 'zod' || spec.startsWith('zod/')) zod.push(file);
        const next = resolve(file, spec);
        if (next) stack.push(next);
      }
    }
    expect(zod).toEqual([]);
    expect([...seen].some((f) => f.endsWith('validate.ts'))).toBe(true);
  });
});

describe('GET /api/realtime-token', () => {
  it('401 for every refused session state without reading the session; only token and expiry otherwise; no-store', async () => {
    const { realtimeTokenResponse } = await import('@/modules/notices/server/realtime-token');
    let reads = 0;
    const readSession = async () => {
      reads += 1;
      return { accessToken: 'synthetic.jwt.token', expiresAt: 1_900_000_000 };
    };
    for (const state of ['no_session', 'mfa_required', 'session_expired', 'session_revoked', 'recovery_pending', 'onboarding_incomplete',
      'inactive', 'no_membership']) {
      const res = await realtimeTokenResponse({ sessionState: state, readSession });
      expect(res.status).toBe(401);
    }
    expect(reads).toBe(0);
    const ok = await realtimeTokenResponse({ sessionState: 'ok', readSession });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
    expect(await ok.json()).toEqual({ accessToken: 'synthetic.jwt.token', expiresAt: 1_900_000_000 });
    expect((await realtimeTokenResponse({ sessionState: 'ok', readSession: async () => null })).status).toBe(401);
    expect((await realtimeTokenResponse({ sessionState: 'ok', readSession: async () => { throw new Error('x'); } })).status).toBe(503);
  });

  it('the browser fetch returns the token or null, never throws', async () => {
    const { fetchRealtimeToken } = await import('@/modules/notices/feed-client');
    expect(await fetchRealtimeToken(async () => new Response(JSON.stringify({ accessToken: 'synthetic.jwt', expiresAt: 1 }), { status: 200 })))
      .toBe('synthetic.jwt');
    expect(await fetchRealtimeToken(async () => new Response('{}', { status: 401 }))).toBeNull();
    expect(await fetchRealtimeToken(async () => { throw new Error('offline'); })).toBeNull();
  });
});
