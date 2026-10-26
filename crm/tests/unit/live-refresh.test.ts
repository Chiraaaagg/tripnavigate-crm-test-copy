import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUSY_RETRY_MS,
  CONNECT_TIMEOUT_MS,
  DEBOUNCE_MS,
  POLL_INTERVAL_MS,
  SAFETY_REFRESH_MS,
  startLiveRefresh,
  type ChannelStatus,
  type LiveMode,
} from '@/modules/deals/live-refresh';

/** LiveDealsRefresh logic: Realtime change -> debounced router.refresh(); fallback polling. */

let refresh: ReturnType<typeof vi.fn<() => void>>;
let modes: LiveMode[];
let handlers: { onChange: () => void; onStatus: (s: ChannelStatus) => void };
let unsubscribe: ReturnType<typeof vi.fn<() => void>>;

let busy = false;
const start = (subscribe?: Parameters<typeof startLiveRefresh>[0]['subscribe']) =>
  startLiveRefresh({
    refresh,
    isBusy: () => busy,
    onMode: (m) => modes.push(m),
    subscribe:
      subscribe ??
      ((h) => {
        handlers = h;
        return unsubscribe;
      }),
  });

beforeEach(() => {
  vi.useFakeTimers();
  refresh = vi.fn<() => void>();
  modes = [];
  unsubscribe = vi.fn<() => void>();
  busy = false;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('live deal refresh', () => {
  it('goes live on SUBSCRIBED and debounces a burst of changes into one refresh', () => {
    const stop = start();
    handlers.onStatus('SUBSCRIBED');
    expect(modes).toEqual(['connecting', 'live']);

    for (let i = 0; i < 5; i += 1) {
      handlers.onChange();
      vi.advanceTimersByTime(200);
    }
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    handlers.onChange();
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it('never refreshes from the payload itself: the change handler takes no data', () => {
    start();
    handlers.onStatus('SUBSCRIBED');
    expect(handlers.onChange.length).toBe(0);
  });

  it('live mode still refreshes on a slow safety interval (lost access sends no event)', () => {
    start();
    handlers.onStatus('SUBSCRIBED');
    vi.advanceTimersByTime(SAFETY_REFRESH_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each<ChannelStatus>(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])('%s -> polling every 30 s', (status) => {
    start();
    handlers.onStatus(status);
    expect(modes).toEqual(['connecting', 'polling']);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    // Catch-up refresh: debounced, never synchronous (a click made meanwhile must survive).
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 3 - DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it('no refresh while a navigation is pending (CI T15 regression): it waits, then runs once', () => {
    start();
    busy = true; // the user clicked a deal link; the next page is loading
    handlers.onStatus('CHANNEL_ERROR'); // Realtime unavailable -> catch-up due
    vi.advanceTimersByTime(DEBOUNCE_MS + BUSY_RETRY_MS * 5);
    expect(refresh).not.toHaveBeenCalled();
    handlers.onChange(); // more changes while busy: still nothing
    vi.advanceTimersByTime(DEBOUNCE_MS + BUSY_RETRY_MS * 5);
    expect(refresh).not.toHaveBeenCalled();
    busy = false; // navigation finished (or was abandoned)
    vi.advanceTimersByTime(BUSY_RETRY_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(BUSY_RETRY_MS * 3);
    expect(refresh).toHaveBeenCalledTimes(1); // retries coalesce into one refresh
  });

  it('subscribing alone never refreshes (no refresh on the first subscribe)', () => {
    start();
    handlers.onStatus('SUBSCRIBED');
    vi.advanceTimersByTime(SAFETY_REFRESH_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('falls back to polling when the channel never subscribes', () => {
    start();
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS);
    expect(modes.at(-1)).toBe('polling');
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('falls back to polling when Realtime cannot be set up at all', () => {
    start(() => {
      throw new Error('realtime unavailable');
    });
    expect(modes).toEqual(['connecting', 'polling']);
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('stop() clears timers, pending debounce and the subscription', () => {
    const stop = start();
    handlers.onStatus('SUBSCRIBED');
    handlers.onChange();
    busy = true;
    handlers.onChange();
    vi.advanceTimersByTime(DEBOUNCE_MS); // a busy-retry is now pending
    stop();
    stop();
    busy = false;
    vi.advanceTimersByTime(SAFETY_REFRESH_MS * 2);
    expect(refresh).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
