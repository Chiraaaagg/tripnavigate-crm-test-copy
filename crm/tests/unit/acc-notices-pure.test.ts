import { describe, expect, it } from 'vitest';
import { NOTICE_KINDS, NOTICE_PARAM_KEYS, NOTICE_TONE, type NoticeItemDTO, noticeText } from '@/modules/notices/contracts';
import { GROUP_WINDOW_MS, groupNotices } from '@/modules/notices/group';
import { NOTICE_POLL_MS, NOTICE_RETRY_MS, retryDelay, startNoticeLive } from '@/modules/notices/live';
import { SOUND_THROTTLE_MS, decideSound } from '@/modules/notices/sound-policy';

/**
 * Accounts phase contract 9.1 (kinds, templates), 9.4 (grouping, urgent,
 * sound, live catch-up and back-off) and 12.5, Track E. The function names
 * are Track C's (groupNotices is frozen; the rest are named by the module
 * layout in section 10).
 */

let n = 0;
const item = (over: Partial<NoticeItemDTO> = {}): NoticeItemDTO => {
  n += 1;
  return { noticeId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, seq: n, kind: 'task_new', priority: 'normal', escalated: false,
    createdAt: new Date(Date.UTC(2026, 10, 10, 6, 0, 0) + n * 1000).toISOString(), readAt: null, doneAt: null, resolvedAt: null, resolvedReason: null,
    dealId: 'd0000000-0000-4000-8000-000000000001', dealReference: 'BX-1001', taskId: null, department: 'purchase', params: { dealReference: 'BX-1001' },
    link: null, ...over } as NoticeItemDTO;
};
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 10, 6, 0, 0) + minutes * 60_000).toISOString();

describe('9.1 frozen kinds and templates', () => {
  it('25 Phase 1 kinds + 12 Phase 2 kinds (26-38 without 34, Addendum L1) + refund_shortfall (Addendum L6); params allowlist; references only', () => {
    expect(NOTICE_KINDS).toHaveLength(54); // + Accounts phase 3: 40-46 (track D), 50-60 without 53 and 55 (track N)
    expect(NOTICE_KINDS).toContain('refund_shortfall');
    expect(NOTICE_KINDS).not.toContain('supplier_refund_to_verify');
    expect([...NOTICE_PARAM_KEYS].sort()).toEqual(['dealReference', 'department', 'refNo', 'serviceType', 'status', 'versionNo']);
    for (const kind of NOTICE_KINDS) {
      const text = noticeText({ kind, params: { dealReference: 'BX-1001', refNo: 'SP-2026-000001', department: 'purchase', status: 'approved' },
        dealReference: 'BX-1001', department: 'purchase' } as never);
      expect(text.length, kind).toBeGreaterThan(5);
      expect(text.replace(/SP-2026-000001|BX-1001/g, ''), kind).not.toMatch(/₹|INR|\d{4,}/);
    }
    expect(noticeText({ kind: 'booking_changed', params: { dealReference: 'BX-1001' }, dealReference: 'BX-1001', department: 'purchase' } as never))
      .toBe('BX-1001 booking changed — check the details');
    expect(noticeText({ kind: 'payment_to_record', params: { refNo: 'SP-2026-000001' }, dealReference: 'BX-1001', department: null } as never))
      .toBe('Payment request SP-2026-000001 approved — record the payment');
  });
  it('urgent tone for 3, 4, 8, 16 (urgent), 19, 20; normal tone only for 1 and 2; others silent', () => {
    const urgent = Object.entries(NOTICE_TONE).filter(([, t]) => t === 'urgent').map(([k]) => k).sort();
    expect(urgent).toEqual(expect.arrayContaining(['booking_changed', 'cost_over_budget', 'fare_to_approve', 'review_returned', 'trip_cancelled']));
    expect(Object.entries(NOTICE_TONE).filter(([, t]) => t === 'normal').map(([k]) => k).sort()).toEqual(['task_assigned', 'task_new']);
    for (const k of ['payment_reported', 'receipt_to_verify', 'visa_result', 'tally_exception', 'review_approved']) expect(NOTICE_TONE[k as never]).toBe('none');
  });
});

describe('9.4 grouping', () => {
  it('normal unread notices of one Deal within 10 minutes of the first collapse; later ones start a new group', () => {
    expect(GROUP_WINDOW_MS).toBe(600_000);
    const items = [item({ createdAt: at(0) }), item({ createdAt: at(5) }), item({ createdAt: at(10) }), item({ createdAt: at(11) })];
    const g = groupNotices(items);
    const entries = (g as unknown as { entries: Array<{ type: string; items?: unknown[] }> }).entries;
    const groups = entries.filter((e) => e.type === 'group');
    expect(groups.map((e) => e.items!.length)).toEqual([3]);
    expect(entries.filter((e) => e.type === 'single')).toHaveLength(1);
  });
  it('urgent notices are never grouped and are listed first; they stay until opened or done', () => {
    const items = [item({ createdAt: at(0) }), item({ createdAt: at(1), kind: 'review_returned', priority: 'urgent' }),
      item({ createdAt: at(2), kind: 'trip_cancelled', priority: 'urgent' }), item({ createdAt: at(3) }),
      item({ createdAt: at(4), kind: 'review_returned', priority: 'urgent', readAt: at(5) })];
    const g = groupNotices(items) as unknown as { urgent: NoticeItemDTO[]; entries: Array<{ type: string; items?: NoticeItemDTO[] }> };
    expect(g.urgent).toHaveLength(3);
    expect(g.entries.flatMap((e) => e.items ?? []).some((x) => x.priority === 'urgent')).toBe(false);
  });
});

describe('9.4 sound policy', () => {
  const base = { soundOn: true, isLeader: true, audioUnlocked: true, lastPlayedAt: null, now: 100_000, lastSeenSeq: 0 };
  it('off by default, first load silent, one leader, 10 s throttle, locked audio', () => {
    const urgent = [item({ kind: 'review_returned', priority: 'urgent', seq: 5 })];
    expect(decideSound({ ...base, soundOn: false, items: urgent })).toMatchObject({ play: false, reason: 'off' });
    expect(decideSound({ ...base, lastSeenSeq: null, items: urgent })).toMatchObject({ play: false });
    expect(decideSound({ ...base, isLeader: false, items: urgent })).toMatchObject({ play: false, reason: 'not_leader' });
    expect(SOUND_THROTTLE_MS).toBe(10_000);
    expect(decideSound({ ...base, lastPlayedAt: 100_000 - 9_999, items: urgent })).toMatchObject({ play: false, reason: 'throttled' });
    expect(decideSound({ ...base, lastPlayedAt: 100_000 - 10_000, items: urgent })).toMatchObject({ play: true, tone: 'urgent' });
    expect(decideSound({ ...base, audioUnlocked: false, items: urgent })).toMatchObject({ play: false, reason: 'locked' });
    expect(decideSound({ ...base, items: [item({ kind: 'task_new', seq: 6 })] })).toMatchObject({ play: true, tone: 'normal' });
    expect(decideSound({ ...base, items: [item({ kind: 'payment_reported', seq: 7 })] })).toMatchObject({ play: false, reason: 'silent' });
    expect(decideSound({ ...base, items: [item({ kind: 'receipt_to_verify', escalated: true, seq: 8 })] }), 'escalation plays no sound')
      .toMatchObject({ play: false });
  });
});

describe('9.4 live catch-up', () => {
  type Timer = { fn: () => void; ms: number; every: boolean; at: number };
  function fakeTimers() {
    let now = 0;
    const list = new Map<number, Timer>();
    let id = 0;
    return {
      timers: {
        setTimeout: (fn: () => void, ms: number) => { id += 1; list.set(id, { fn, ms, every: false, at: now + ms }); return id; },
        clearTimeout: (h: unknown) => { list.delete(h as number); },
        setInterval: (fn: () => void, ms: number) => { id += 1; list.set(id, { fn, ms, every: true, at: now + ms }); return id; },
        clearInterval: (h: unknown) => { list.delete(h as number); },
      },
      async advance(ms: number) {
        const end = now + ms;
        for (;;) {
          const next = [...list.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
          if (!next) break;
          const [key, t] = next;
          now = t.at;
          if (t.every) t.at += t.ms; else list.delete(key);
          t.fn();
          await new Promise((r) => setTimeout(r, 0));
        }
        now = end;
      },
    };
  }
  const inbox = (latestSeq: number | null) => ({ enabled: true, unreadCount: 0, urgentCount: 0, latestSeq, soundOn: false, items: [] });

  it('first page on start and on every (re)subscribe; after-seq every 30 s; focus re-reads the first page', async () => {
    const t = fakeTimers();
    const reads: Array<number | null> = [];
    let status: ((s: 'SUBSCRIBED' | 'CLOSED') => void) | null = null;
    const live = startNoticeLive({ timers: t.timers, onState: () => undefined,
      read: async (after) => { reads.push(after); return inbox(7); },
      subscribe: ({ onStatus }) => { status = onStatus as never; return () => undefined; } });
    await t.advance(0);
    expect(reads[0]).toBeNull();
    status!('SUBSCRIBED');
    await t.advance(0);
    expect(reads.filter((r) => r === null).length).toBeGreaterThanOrEqual(2);
    expect(NOTICE_POLL_MS).toBe(30_000);
    const before = reads.length;
    await t.advance(30_000);
    expect(reads.slice(before)).toContain(7);
    live.focus();
    await t.advance(0);
    expect(reads[reads.length - 1]).toBeNull();
    live.stop();
  });

  it('a failed read keeps the last list, marks it stale and retries after 5 s, 15 s, 60 s, then every 60 s', async () => {
    expect(NOTICE_RETRY_MS).toEqual([5_000, 15_000, 60_000]);
    expect([1, 2, 3, 4, 9].map(retryDelay)).toEqual([5_000, 15_000, 60_000, 60_000, 60_000]);
    const t = fakeTimers();
    const states: Array<{ stale: boolean; inbox: unknown }> = [];
    let fail = false;
    const live = startNoticeLive({ timers: t.timers, onState: (s) => states.push(s),
      read: async () => { if (fail) throw new Error('down'); return inbox(1); }, subscribe: () => () => undefined });
    await t.advance(0);
    fail = true;
    live.refresh();
    await t.advance(0);
    const last = states[states.length - 1]!;
    expect(last.stale).toBe(true);
    expect(last.inbox).not.toBeNull();
    live.stop();
  });
});
