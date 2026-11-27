import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoticeInboxDTO } from '@/modules/notices/contracts';
import {
  NOTICE_CONNECT_TIMEOUT_MS,
  NOTICE_ENDED_CONFIRM_MS,
  NOTICE_ENDED_FOCUS_MIN_MS,
  NOTICE_ENDED_PROBE_MS,
  NOTICE_ENDED_PROBE_STEADY_MS,
  NOTICE_POLL_MS,
  NOTICE_READ_OK_CHANNEL,
  NOTICE_READ_OK_KEY,
  NOTICE_READ_OK_MESSAGE,
  NoticeSessionEnded,
  endedProbeDelay,
  startNoticeLive,
  startNoticeReadOkSignal,
  type NoticeChannelStatus,
  type NoticeLiveMode,
  type NoticeSignalChannel,
} from '@/modules/notices/live';

/**
 * S4 contract 2.6 items 9-10 and review finding I8: a signed-out or
 * session-ended tab stops the 30-second notices poll after TWO consecutive
 * session refusals at least 5 s apart, then only probes (5 min, 15 min after
 * that, then hourly, plus focus / refresh at most once per 10 s). A successful
 * probe restores polling and the Realtime channel. A single refusal (a
 * cookie-refresh race) or any other failure keeps today's behaviour, so urgent
 * notices for a signed-in person are never silenced.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

type Answer = 'ok' | 'session' | 'down';
type Handlers = { onChange: () => void; onStatus: (status: NoticeChannelStatus) => void };

const inbox = (latestSeq: number | null): NoticeInboxDTO => ({
  enabled: true,
  unreadCount: 1,
  urgentCount: 1,
  latestSeq,
  soundOn: false,
  items: latestSeq === null ? [] : [{ noticeId: `n-${latestSeq}`, seq: latestSeq } as NoticeInboxDTO['items'][number]],
});

/**
 * A notices live harness. `answer` decides each read; `closesOnRemove` makes the
 * channel report CLOSED synchronously when removed, like supabase-js (BR-25).
 */
function harness(opts: { answer?: Answer | ((n: number) => Answer); closesOnRemove?: boolean } = {}) {
  let answer: Answer | ((n: number) => Answer) = opts.answer ?? 'ok';
  const reads: Array<{ at: number; afterSeq: number | null }> = [];
  const states: Array<{ at: number; mode: NoticeLiveMode; stale: boolean; items: number | null }> = [];
  const channel = { opened: 0, removed: 0, handlers: [] as Handlers[] };
  const live = startNoticeLive({
    read: async (afterSeq) => {
      reads.push({ at: Date.now(), afterSeq });
      const a = typeof answer === 'function' ? answer(reads.length) : answer;
      if (a === 'session') throw new NoticeSessionEnded();
      if (a === 'down') throw new Error('down');
      return inbox(7);
    },
    onState: (s) => states.push({ at: Date.now(), mode: s.mode, stale: s.stale, items: s.inbox ? s.inbox.items.length : null }),
    subscribe: (h) => {
      channel.opened += 1;
      channel.handlers.push(h);
      return () => {
        channel.removed += 1;
        if (channel.removed > 50) throw new Error('unsubscribe re-entered: recursion');
        if (opts.closesOnRemove) h.onStatus('CLOSED');
      };
    },
  });
  const last = () => states[states.length - 1]!;
  const endedStates = () => states.filter((s) => s.mode === 'ended');
  const enteredEndedAt = () => endedStates()[0]?.at ?? null;
  return {
    live,
    reads,
    states,
    channel,
    last,
    endedStates,
    enteredEndedAt,
    set: (a: Answer) => {
      answer = a;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('S4 notices: constants', () => {
  it('confirmation 5 s, probes 5 min then 15 min then hourly, focus probe spacing 10 s', () => {
    expect(NOTICE_ENDED_CONFIRM_MS).toBe(5_000);
    expect(NOTICE_ENDED_PROBE_MS).toEqual([300_000, 900_000]);
    expect(NOTICE_ENDED_PROBE_STEADY_MS).toBe(3_600_000);
    expect(NOTICE_ENDED_FOCUS_MIN_MS).toBe(10_000);
    expect([1, 2, 3, 4, 10].map(endedProbeDelay)).toEqual([300_000, 900_000, 3_600_000, 3_600_000, 3_600_000]);
  });
});

describe('S4 notices: one refusal is not enough (I8)', () => {
  it('one session refusal followed by a successful read never enters ended mode and keeps the poll', async () => {
    const h = harness({ answer: 'session' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reads).toHaveLength(1);
    expect(h.last()).toMatchObject({ mode: 'connecting', stale: true });
    h.set('ok');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.reads).toHaveLength(2);
    expect(h.last().stale).toBe(false);
    // Connect timeout -> polling with a catch-up read; then the 30 s poll keeps reading.
    await vi.advanceTimersByTimeAsync(NOTICE_CONNECT_TIMEOUT_MS);
    const before = h.reads.length;
    await vi.advanceTimersByTimeAsync(NOTICE_POLL_MS * 3);
    expect(h.reads.length).toBe(before + 3);
    // Another single refusal (a refresh) followed by a successful retry: still not ended.
    h.set('session');
    h.live.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last().stale).toBe(true);
    h.set('ok');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.endedStates()).toHaveLength(0);
    expect(h.last()).toMatchObject({ mode: 'polling', stale: false });
    const again = h.reads.length;
    await vi.advanceTimersByTimeAsync(NOTICE_POLL_MS);
    expect(h.reads.length).toBe(again + 1);
    h.live.stop();
  });

  it('a second refusal less than 5 s after the first does not count; the next one at least 5 s later does', async () => {
    const h = harness({ answer: 'session' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    h.live.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reads).toHaveLength(2);
    expect(h.endedStates()).toHaveLength(0);
    // The next read (the catch-up read after the 10 s connect timeout) is refused 10 s after the first: ended.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.reads).toHaveLength(3);
    expect(h.reads[2]!.at).toBe(NOTICE_CONNECT_TIMEOUT_MS);
    expect(h.endedStates()).toHaveLength(1);
    expect(h.enteredEndedAt()).toBe(NOTICE_CONNECT_TIMEOUT_MS);
    h.live.stop();
  });

  it('a non-session failure keeps the retry ladder and the poll, and breaks a pair of session refusals', async () => {
    // session, down, session, down, ...: never two session refusals in a row.
    const h = harness({ answer: (n) => (n % 2 === 1 ? 'session' : 'down') });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(h.endedStates()).toHaveLength(0);
    expect(h.last().stale).toBe(true);
    // Poll every 30 s (20 in 10 minutes) plus retries: the bell keeps trying.
    expect(h.reads.length).toBeGreaterThanOrEqual(20);
    h.live.stop();

    const d = harness({ answer: 'down' });
    await vi.advanceTimersByTimeAsync(0);
    const first = d.reads.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(d.reads.length, '5-second retry').toBe(first + 1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(d.endedStates()).toHaveLength(0);
    expect(d.reads.length).toBeGreaterThan(HOUR / NOTICE_POLL_MS);
    d.live.stop();
  });
});

describe('S4 notices: ended mode', () => {
  it('two consecutive refusals at least 5 s apart stop the poll, the retry and the channel, keeping the last list', async () => {
    const h = harness({ answer: 'ok' });
    h.channel.handlers[0]!.onStatus('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toMatchObject({ mode: 'live', stale: false, items: 1 });
    h.set('session');
    h.live.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toMatchObject({ mode: 'live', stale: true, items: 1 });
    expect(h.channel.removed).toBe(0);
    // The 5-second retry is refused as well: ended.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.endedStates()).toHaveLength(1);
    expect(h.last()).toEqual({ at: 5_000, mode: 'ended', stale: true, items: 1 });
    expect(h.channel.removed).toBe(1);
    // Only the first probe timer is left: poll, retry, debounce and connect timers are gone.
    expect(vi.getTimerCount()).toBe(1);
    const reads = h.reads.length;
    // A Realtime event from the removed channel reads nothing.
    h.channel.handlers[0]!.onChange();
    h.channel.handlers[0]!.onStatus('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(5 * MIN - 1);
    expect(h.reads.length).toBe(reads);
    expect(h.last().mode).toBe('ended');
    h.live.stop();
  });

  it('entering ended mode with a channel that reports CLOSED on removal does not recurse (BR-25 kept)', async () => {
    const h = harness({ answer: 'session', closesOnRemove: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.endedStates()).toHaveLength(1);
    expect(h.channel.removed).toBe(1);
    expect(h.last().mode).toBe('ended');
    expect(() => h.live.stop()).not.toThrow();
    // The channel was already removed: stop() does not remove it again.
    expect(h.channel.removed).toBe(1);
  });

  it('probes fire 5 min after entering, 15 min after that, then every hour', async () => {
    const h = harness({ answer: 'session' });
    await vi.advanceTimersByTimeAsync(5_000);
    const t = h.enteredEndedAt()!;
    expect(t).toBe(5_000);
    const before = h.reads.length;
    await vi.advanceTimersByTimeAsync(5 * MIN + 15 * MIN + 3 * HOUR);
    expect(h.reads.slice(before).map((r) => r.at - t)).toEqual([5 * MIN, 20 * MIN, 20 * MIN + HOUR, 20 * MIN + 2 * HOUR, 20 * MIN + 3 * HOUR]);
    // Probes read the first page.
    for (const r of h.reads.slice(before)) expect(r.afterSeq).toBeNull();
    h.live.stop();
  });

  it('the ended state is announced once and cleared by a successful probe, which restores polling and resubscribes', async () => {
    const h = harness({ answer: 'session' });
    await vi.advanceTimersByTimeAsync(5_000);
    // Three failed probes: nothing new is emitted.
    await vi.advanceTimersByTimeAsync(5 * MIN + 15 * MIN + HOUR);
    expect(h.endedStates()).toHaveLength(1);
    expect(h.states.filter((s) => s.mode === 'ended' || s.at > 5_000)).toHaveLength(1);
    expect(h.channel.opened).toBe(1);
    h.set('ok');
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(h.last()).toMatchObject({ mode: 'connecting', stale: false, items: 1 });
    expect(h.channel.opened).toBe(2);
    // The old channel's late callbacks change nothing; the new channel works.
    h.channel.handlers[0]!.onStatus('CHANNEL_ERROR');
    expect(h.last().mode).toBe('connecting');
    h.channel.handlers[1]!.onStatus('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toMatchObject({ mode: 'live', stale: false });
    // The 30 s poll is back (read after latestSeq) and no probe timer is left.
    const before = h.reads.length;
    await vi.advanceTimersByTimeAsync(NOTICE_POLL_MS);
    expect(h.reads.slice(before)).toEqual([{ at: expect.any(Number), afterSeq: 7 }]);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(h.reads.length).toBe(before + 1 + (2 * HOUR) / NOTICE_POLL_MS);
    h.live.stop();
  });

  it('a successful probe with a channel that fails to connect falls back to polling', async () => {
    const h = harness({ answer: 'session' });
    await vi.advanceTimersByTimeAsync(5_000);
    h.set('ok');
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(h.last().mode).toBe('connecting');
    await vi.advanceTimersByTimeAsync(NOTICE_CONNECT_TIMEOUT_MS);
    expect(h.last()).toMatchObject({ mode: 'polling', stale: false });
    expect(h.channel.removed).toBe(2);
    h.live.stop();
  });

  it('focus() and refresh() probe at most once per 10 s while ended', async () => {
    const h = harness({ answer: 'session' });
    await vi.advanceTimersByTimeAsync(5_000);
    const t = h.enteredEndedAt()!;
    const before = h.reads.length;
    h.live.focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reads.length, 'within 10 s of the refusal that ended the session').toBe(before);
    await vi.advanceTimersByTimeAsync(NOTICE_ENDED_FOCUS_MIN_MS);
    h.live.focus();
    h.live.focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reads.length).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(3_000);
    h.live.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reads.length).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(NOTICE_ENDED_FOCUS_MIN_MS);
    h.live.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reads.length).toBe(before + 2);
    expect(h.reads.slice(before).map((r) => r.at - t)).toEqual([10_000, 23_000]);
    expect(h.endedStates()).toHaveLength(1);
    // A focus probe that succeeds leaves ended mode.
    h.set('ok');
    await vi.advanceTimersByTimeAsync(NOTICE_ENDED_FOCUS_MIN_MS);
    h.live.focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toMatchObject({ mode: 'connecting', stale: false });
    h.live.stop();
  });

  it('a signed-out tab reads at most 30 times in 24 hours', async () => {
    const h = harness({ answer: 'session' });
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(h.reads.length).toBeLessThanOrEqual(30);
    expect(h.endedStates()).toHaveLength(1);
    expect(h.channel.opened).toBe(1);
    h.live.stop();
  });

  it('stop() while ended clears the probe timer', async () => {
    const h = harness({ answer: 'session' });
    await vi.advanceTimersByTimeAsync(5_000);
    h.live.stop();
    expect(vi.getTimerCount()).toBe(0);
    const reads = h.reads.length;
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(h.reads.length).toBe(reads);
  });
});

describe('S4 notices: the provider maps a session refusal and exposes the ended state', () => {
  it('read throws NoticeSessionEnded for code session; the state carries sessionEnded from mode ended', () => {
    const src = readFileSync(join(process.cwd(), 'src/views/notices/provider.tsx'), 'utf8');
    expect(src).toMatch(/if \(r\.code === 'session'\) throw new NoticeSessionEnded\(\);\s*\/\/[^\n]*\n\s*throw new Error\(r\.message\);/);
    expect(src).toContain("sessionEnded: s.mode === 'ended',");
    expect(src).toContain('sessionEnded: false,');
  });

  it('the bell stale line shows the session text without the spinning icon when the session ended, the retrying text otherwise', () => {
    const src = readFileSync(join(process.cwd(), 'src/views/notices/bell.tsx'), 'utf8');
    const start = src.indexOf('{state.stale ? (\n            <p role="status"');
    expect(start, 'the existing stale status line').toBeGreaterThan(-1);
    const line = src.slice(start, src.indexOf('</p>', start));
    // One status element: the session text replaces the retrying text inside it.
    expect(line.match(/<p /g)).toHaveLength(1);
    expect(line).toMatch(/\{state\.sessionEnded \? NOTICE_ERROR_TEXT\.session : `\$\{NOTICE_TEXT\.outOfDate\}\. Your work lists and Home counts are not affected\.`\}/);
    // The spinning refresh icon is only in the not-ended branch.
    expect(line).toMatch(/\{state\.sessionEnded \? \(\s*<TriangleAlert [^>]*\/>\s*\) : \(\s*<RefreshCw [^>]*motion-safe:animate-spin[^>]*\/>\s*\)\}/);
    expect(line.slice(line.indexOf('<TriangleAlert'), line.indexOf('/>', line.indexOf('<TriangleAlert')))).not.toContain('animate-spin');
    expect(src).toMatch(/import \{[^}]*\bNOTICE_ERROR_TEXT\b[^}]*\} from '@\/modules\/notices\/contracts';/);
  });
});

describe('S4 notices: another tab read notices ok (review 10b finding 1)', () => {
  it('sessionOk() while ended probes at once when the last probe is 10 s or more ago, and leaves ended mode', async () => {
    const h = harness({ answer: 'session' });
    await vi.advanceTimersByTimeAsync(5_000);
    const t = h.enteredEndedAt()!;
    // Probes at 5 and 20 minutes fail; the person signs in again in another tab at minute 21.
    await vi.advanceTimersByTimeAsync(21 * MIN);
    const before = h.reads.length;
    h.set('ok');
    h.live.sessionOk();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reads.slice(before).map((r) => r.at - t)).toEqual([21 * MIN]);
    expect(h.last()).toMatchObject({ mode: 'connecting', stale: false, items: 1 });
    expect(h.channel.opened).toBe(2);
    h.live.stop();
  });

  it('sessionOk() within 10 s of the last probe is deferred to the 10 s mark, never dropped, never doubled', async () => {
    const h = harness({ answer: 'session' });
    await vi.advanceTimersByTimeAsync(5_000);
    h.set('ok');
    const before = h.reads.length;
    await vi.advanceTimersByTimeAsync(2_000);
    h.live.sessionOk();
    h.live.sessionOk();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(h.reads.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reads.map((r) => r.at).slice(before)).toEqual([15_000]);
    expect(h.last()).toMatchObject({ mode: 'connecting', stale: false });
    // Nothing else pending from the signal: one read in the next minute besides the channel's own.
    await vi.advanceTimersByTimeAsync(NOTICE_CONNECT_TIMEOUT_MS - 1);
    expect(h.reads.length).toBe(before + 1);
    h.live.stop();
  });

  it('a deferred sessionOk() probe that still fails keeps ended mode; stop() clears it', async () => {
    const h = harness({ answer: 'session' });
    await vi.advanceTimersByTimeAsync(5_000);
    h.live.sessionOk();
    await vi.advanceTimersByTimeAsync(NOTICE_ENDED_FOCUS_MIN_MS);
    expect(h.reads).toHaveLength(3);
    expect(h.endedStates()).toHaveLength(1);
    expect(h.last().mode).toBe('ended');
    h.live.sessionOk();
    h.live.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sessionOk() does nothing for a tab that is not ended', async () => {
    const h = harness({ answer: 'ok' });
    await vi.advanceTimersByTimeAsync(0);
    const before = h.reads.length;
    h.live.sessionOk();
    await vi.advanceTimersByTimeAsync(NOTICE_ENDED_FOCUS_MIN_MS);
    expect(h.reads.length).toBe(before + 1); // only the connect-timeout catch-up read
    expect(h.endedStates()).toHaveLength(0);
    h.live.stop();
  });

  /** An in-memory BroadcastChannel bus: delivery to the other channels of the same name, on a later task. */
  function bus() {
    const open: Array<NoticeSignalChannel & { name: string; closed: boolean }> = [];
    const posted: unknown[] = [];
    const create = (name: string) => {
      const ch = {
        name,
        closed: false,
        onmessage: null as NoticeSignalChannel['onmessage'],
        postMessage: (message: unknown) => {
          posted.push(message);
          for (const other of open) {
            if (other !== ch && other.name === name && !other.closed) setTimeout(() => other.onmessage?.({ data: message }), 0);
          }
        },
        close: () => {
          ch.closed = true;
        },
      };
      open.push(ch);
      return ch;
    };
    return { create, open, posted };
  }

  /** Two tabs sharing one sign-in (cookies) and one signal bus, wired like the provider. */
  function twoTabs() {
    const b = bus();
    let signedIn = false;
    const tab = () => {
      const reads: number[] = [];
      const modes: NoticeLiveMode[] = [];
      let signal: ReturnType<typeof startNoticeReadOkSignal> | null = null;
      const live = startNoticeLive({
        read: async () => {
          reads.push(Date.now());
          if (!signedIn) throw new NoticeSessionEnded();
          signal?.post();
          return inbox(7);
        },
        onState: (s) => {
          if (modes[modes.length - 1] !== s.mode) modes.push(s.mode);
        },
        subscribe: () => () => undefined,
      });
      signal = startNoticeReadOkSignal(() => live.sessionOk(), { createChannel: b.create });
      return { live, reads, modes, signal, mode: () => modes[modes.length - 1] };
    };
    const a = tab();
    const c = tab();
    return { a, b: c, bus: b, signIn: () => { signedIn = true; } };
  }

  it('two ended tabs: signing in again in tab B brings background tab A back at once, not at its next hourly probe', async () => {
    const t = twoTabs();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.a.mode()).toBe('ended');
    expect(t.b.mode()).toBe('ended');
    await vi.advanceTimersByTimeAsync(21 * MIN - 5_000);
    const aBefore = t.a.reads.length;
    // The person signs in again in tab B and looks at it (focus probe); tab A stays in the background.
    t.signIn();
    t.b.live.focus();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.b.mode()).toBe('connecting');
    expect(t.bus.posted).toContain(NOTICE_READ_OK_MESSAGE);
    expect(t.a.reads.length, 'tab A probed on the signal').toBe(aBefore + 1);
    expect(t.a.reads[aBefore]! - 21 * MIN).toBeLessThanOrEqual(1_000);
    expect(t.a.mode()).toBe('connecting');
    // Both poll again.
    const a1 = t.a.reads.length;
    await vi.advanceTimersByTimeAsync(NOTICE_POLL_MS);
    expect(t.a.reads.length).toBeGreaterThan(a1);
    t.a.live.stop();
    t.b.live.stop();
    t.a.signal.stop();
    t.b.signal.stop();
  });

  it('two signed-out tabs never signal each other: each reads at most 30 times in 24 hours', async () => {
    const t = twoTabs();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(t.bus.posted).toEqual([]);
    expect(t.a.reads.length).toBeLessThanOrEqual(30);
    expect(t.b.reads.length).toBeLessThanOrEqual(30);
    t.a.live.stop();
    t.b.live.stop();
  });
});

describe('S4 notices: the read-ok signal adapter', () => {
  it('BroadcastChannel: posts a constant with no data, reacts only to that message, closes on stop', async () => {
    const created: string[] = [];
    const box: { ch: (NoticeSignalChannel & { sent: unknown[]; closed: boolean }) | null } = { ch: null };
    const onOk = vi.fn<() => void>();
    const signal = startNoticeReadOkSignal(onOk, {
      createChannel: (name) => {
        created.push(name);
        const made = { sent: [] as unknown[], closed: false, onmessage: null as NoticeSignalChannel['onmessage'],
          postMessage: (m: unknown) => { made.sent.push(m); }, close: () => { made.closed = true; } };
        box.ch = made;
        return made;
      },
      storage: () => { throw new Error('storage must not be used with a channel'); },
    });
    expect(created).toEqual([NOTICE_READ_OK_CHANNEL]);
    const ch = box.ch!;
    signal.post();
    expect(ch.sent).toEqual(['read-ok']);
    ch.onmessage!({ data: 'something else' });
    ch.onmessage!({ data: { kind: 'read-ok' } });
    expect(onOk).not.toHaveBeenCalled();
    ch.onmessage!({ data: NOTICE_READ_OK_MESSAGE });
    expect(onOk).toHaveBeenCalledTimes(1);
    signal.stop();
    expect(ch.closed).toBe(true);
    ch.onmessage!({ data: NOTICE_READ_OK_MESSAGE });
    signal.post();
    expect(onOk).toHaveBeenCalledTimes(1);
    expect(ch.sent).toHaveLength(1);
  });

  it('without BroadcastChannel (or when creating it throws): a localStorage time and the storage event of other tabs', () => {
    const writes: Array<[string, string]> = [];
    const hooks: { listener: ((key: string | null) => void) | null; unlistened: boolean } = { listener: null, unlistened: false };
    const onOk = vi.fn<() => void>();
    const signal = startNoticeReadOkSignal(onOk, {
      createChannel: () => { throw new Error('not supported'); },
      storage: () => ({ setItem: (k, v) => writes.push([k, v]) }),
      listenStorage: (fn) => {
        hooks.listener = fn;
        return () => { hooks.unlistened = true; };
      },
      now: () => 1_234,
    });
    signal.post();
    expect(writes).toEqual([[NOTICE_READ_OK_KEY, '1234']]);
    const listener = hooks.listener!;
    listener('tn-notice-sound-at');
    listener(null);
    expect(onOk).not.toHaveBeenCalled();
    listener(NOTICE_READ_OK_KEY);
    expect(onOk).toHaveBeenCalledTimes(1);
    signal.stop();
    expect(hooks.unlistened).toBe(true);
  });

  it('no channel and blocked storage: post and stop never throw', () => {
    const signal = startNoticeReadOkSignal(() => undefined, { createChannel: null, storage: () => { throw new Error('blocked'); }, listenStorage: null });
    expect(() => signal.post()).not.toThrow();
    expect(() => signal.stop()).not.toThrow();
  });

  it('the provider posts on every successful read, wires the signal to sessionOk, stops it, and probes on focus and on visible', () => {
    const src = readFileSync(join(process.cwd(), 'src/views/notices/provider.tsx'), 'utf8');
    expect(src).toMatch(/if \(r\.ok\) \{\s*\/\/[^\n]*\n\s*readOk\?\.post\(\);\s*return r\.data;\s*\}/);
    expect(src).toContain('readOk = startNoticeReadOkSignal(() => handle.sessionOk());');
    expect(src).toContain('readOk?.stop();');
    expect(src).toContain('const onFocus = () => handle.focus();');
    expect(src).toMatch(/if \(document\.visibilityState === 'visible'\) handle\.focus\(\);/);
    expect(src).toContain("document.addEventListener('visibilitychange', onVisible);");
  });
});
