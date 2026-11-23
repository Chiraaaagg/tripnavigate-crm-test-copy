import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECT_TIMEOUT_MS,
  DEBOUNCE_MS,
  POLL_INTERVAL_MS,
  startLiveRefresh,
  type ChannelStatus,
  type LiveMode,
} from '@/modules/deals/live-refresh';
import {
  NOTICE_CONNECT_TIMEOUT_MS,
  NOTICE_POLL_MS,
  startNoticeLive,
  type NoticeChannelStatus,
  type NoticeLiveMode,
} from '@/modules/notices/live';
import type { NoticeInboxDTO } from '@/modules/notices/contracts';

/**
 * BR-25 (B1-2): removing the Realtime channel reports CLOSED synchronously
 * (supabase.removeChannel -> channel.unsubscribe -> status callback). Before the
 * fix, fallBack() called the stored unsubscribe while the mode was not yet
 * 'polling', so onStatus('CLOSED') re-entered fallBack() and recursed until
 * "Maximum call stack size exceeded". These tests use a fake channel that does
 * exactly that and assert one switch to polling, one unsubscribe, no overflow,
 * polling still running, and a safe stop() afterwards, for both modules.
 */

/** Above this many unsubscribe calls the fake reports the loop instead of overflowing the stack. */
const LOOP_CAP = 200;

type Handlers<S> = { onChange: () => void; onStatus: (status: S) => void };

/** A channel whose unsubscribe synchronously reports CLOSED, like supabase-js. */
function fakeChannel<S extends string>() {
  const channel = {
    handlers: null as Handlers<S> | null,
    unsubscribeCalls: 0,
    subscribe: (h: Handlers<S>) => {
      channel.handlers = h;
      return () => {
        channel.unsubscribeCalls += 1;
        if (channel.unsubscribeCalls > LOOP_CAP) throw new Error('unsubscribe re-entered: fallback recursion');
        channel.handlers?.onStatus('CLOSED' as S);
      };
    },
  };
  return channel;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('deal live refresh: fallback does not call itself (BR-25)', () => {
  const run = () => {
    const channel = fakeChannel<ChannelStatus>();
    const modes: LiveMode[] = [];
    const refresh = vi.fn<() => void>();
    const stop = startLiveRefresh({ refresh, onMode: (m) => modes.push(m), subscribe: channel.subscribe });
    return { channel, modes, refresh, stop };
  };

  it.each<ChannelStatus>(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])(
    '%s: one switch to polling, one unsubscribe, no overflow',
    (status) => {
      const { channel, modes, stop } = run();
      expect(() => channel.handlers!.onStatus(status)).not.toThrow();
      expect(modes).toEqual(['connecting', 'polling']);
      expect(modes.filter((m) => m === 'polling')).toHaveLength(1);
      expect(channel.unsubscribeCalls).toBe(1);
      expect(() => stop()).not.toThrow();
      // The channel was already removed: stop() does not remove it again.
      expect(channel.unsubscribeCalls).toBe(1);
    },
  );

  it('connect timeout: one switch to polling, no overflow', () => {
    const { channel, modes, stop } = run();
    expect(() => vi.advanceTimersByTime(CONNECT_TIMEOUT_MS)).not.toThrow();
    expect(modes).toEqual(['connecting', 'polling']);
    expect(channel.unsubscribeCalls).toBe(1);
    stop();
  });

  it('a dead live connection still ends in polling: catch-up refresh, then every 30 s', () => {
    const { channel, refresh, stop } = run();
    channel.handlers!.onStatus('CHANNEL_ERROR');
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('a later status from the removed channel changes nothing', () => {
    const { channel, modes, stop } = run();
    channel.handlers!.onStatus('CHANNEL_ERROR');
    channel.handlers!.onStatus('CLOSED');
    channel.handlers!.onStatus('SUBSCRIBED');
    expect(modes).toEqual(['connecting', 'polling']);
    expect(channel.unsubscribeCalls).toBe(1);
    stop();
  });

  it('stop() while live removes the channel once without re-entering the fallback', () => {
    const { channel, modes, stop } = run();
    channel.handlers!.onStatus('SUBSCRIBED');
    expect(() => stop()).not.toThrow();
    expect(channel.unsubscribeCalls).toBe(1);
    expect(modes).toEqual(['connecting', 'live']);
    expect(() => stop()).not.toThrow();
    expect(channel.unsubscribeCalls).toBe(1);
  });
});

describe('notice bell live: fallback does not call itself (BR-25)', () => {
  const inbox = (latestSeq: number | null): NoticeInboxDTO => ({
    enabled: true,
    unreadCount: 0,
    urgentCount: 0,
    latestSeq,
    soundOn: false,
    items: [],
  });

  const run = () => {
    const channel = fakeChannel<NoticeChannelStatus>();
    const modes: NoticeLiveMode[] = [];
    const reads: Array<number | null> = [];
    const live = startNoticeLive({
      read: async (afterSeq) => {
        reads.push(afterSeq);
        return inbox(7);
      },
      onState: (s) => {
        if (modes[modes.length - 1] !== s.mode) modes.push(s.mode);
      },
      subscribe: channel.subscribe,
    });
    return { channel, modes, reads, live };
  };

  it.each<NoticeChannelStatus>(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])(
    '%s: one switch to polling, one unsubscribe, no overflow',
    async (status) => {
      const { channel, modes, live } = run();
      await vi.advanceTimersByTimeAsync(0);
      expect(() => channel.handlers!.onStatus(status)).not.toThrow();
      expect(modes).toEqual(['connecting', 'polling']);
      expect(channel.unsubscribeCalls).toBe(1);
      expect(() => live.stop()).not.toThrow();
      expect(channel.unsubscribeCalls).toBe(1);
    },
  );

  it('connect timeout: one switch to polling, no overflow', async () => {
    const { channel, modes, live } = run();
    // A recursion inside the timer callback would reject here and fail the test.
    await vi.advanceTimersByTimeAsync(NOTICE_CONNECT_TIMEOUT_MS);
    expect(modes).toEqual(['connecting', 'polling']);
    expect(channel.unsubscribeCalls).toBe(1);
    live.stop();
  });

  it('polling as specified after the fallback: a full catch-up read, then a read after latestSeq every 30 s', async () => {
    const { channel, reads, live } = run();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toEqual([null]);
    channel.handlers!.onStatus('CHANNEL_ERROR');
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toEqual([null, null]);
    await vi.advanceTimersByTimeAsync(NOTICE_POLL_MS);
    expect(reads).toEqual([null, null, 7]);
    await vi.advanceTimersByTimeAsync(NOTICE_POLL_MS);
    expect(reads).toEqual([null, null, 7, 7]);
    live.stop();
    await vi.advanceTimersByTimeAsync(NOTICE_POLL_MS * 3);
    expect(reads).toHaveLength(4);
  });

  it('a later status from the removed channel changes nothing', async () => {
    const { channel, modes, live } = run();
    await vi.advanceTimersByTimeAsync(0);
    channel.handlers!.onStatus('CHANNEL_ERROR');
    channel.handlers!.onStatus('CLOSED');
    expect(modes).toEqual(['connecting', 'polling']);
    expect(channel.unsubscribeCalls).toBe(1);
    live.stop();
  });

  it('stop() while live removes the channel once without re-entering the fallback', async () => {
    const { channel, modes, live } = run();
    channel.handlers!.onStatus('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(0);
    expect(() => live.stop()).not.toThrow();
    expect(channel.unsubscribeCalls).toBe(1);
    expect(modes).toEqual(['connecting', 'live']);
    expect(() => live.stop()).not.toThrow();
    expect(channel.unsubscribeCalls).toBe(1);
  });
});
