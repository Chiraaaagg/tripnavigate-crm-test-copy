/**
 * Live deal refresh (browser side, framework-free so it can be unit tested).
 *
 * A Realtime change on public.deals NEVER renders data: it only schedules a
 * debounced refresh, and the server reloads the page through the existing RLS
 * queries and DTOs (so Purchase never receives commercial values, and a row
 * the viewer may not see is never shown).
 *
 * Modes:
 *   connecting -> live      the channel subscribed; refresh on change (debounced)
 *   connecting -> polling   Realtime failed, closed or did not subscribe within
 *                           CONNECT_TIMEOUT_MS; refresh every POLL_INTERVAL_MS
 * Live mode also refreshes every SAFETY_REFRESH_MS, because a viewer who LOSES
 * access to a deal (owner changed in Bitrix) receives no event for it.
 *
 * A refresh never interrupts a navigation: router.refresh() while a link click
 * is still loading re-renders the CURRENT page and the click is lost (CI T15,
 * 5 Oct 2026: Realtime unavailable -> immediate catch-up refresh -> the deal
 * link did not open). So every refresh is postponed while `isBusy()` says a
 * navigation is pending, and the catch-up after a fallback is debounced like
 * any change instead of firing at once. The first subscribe never refreshes.
 */

export const DEBOUNCE_MS = 1_000;
export const POLL_INTERVAL_MS = 30_000;
export const CONNECT_TIMEOUT_MS = 10_000;
export const SAFETY_REFRESH_MS = 5 * 60_000;
/** While a navigation is pending, a due refresh is retried after this delay. */
export const BUSY_RETRY_MS = 1_000;

export type LiveMode = 'connecting' | 'live' | 'polling';

/** Supabase channel states we react to (subset of REALTIME_SUBSCRIBE_STATES). */
export type ChannelStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR';

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface LiveRefreshOptions {
  refresh: () => void;
  onMode: (mode: LiveMode) => void;
  /**
   * Opens the subscription. Calls onChange for every change and onStatus for
   * channel status. Returns an unsubscribe function. May throw (treated as
   * Realtime unavailable).
   */
  subscribe: (handlers: { onChange: () => void; onStatus: (status: ChannelStatus) => void }) => () => void;
  /** True while a page navigation is pending; refreshes wait until it is false. */
  isBusy?: () => boolean;
  timers?: Timers;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
};

/** Starts live refresh; returns a stop function (idempotent). */
export function startLiveRefresh(options: LiveRefreshOptions): () => void {
  const timers = options.timers ?? defaultTimers;
  let mode: LiveMode = 'connecting';
  let stopped = false;
  let debounce: unknown = null;
  let interval: unknown = null;
  let unsubscribe: (() => void) | null = null;
  let busyRetry: unknown = null;

  /** The only way a refresh happens: never while stopped or during a navigation. */
  const refreshNow = () => {
    if (stopped) return;
    if (options.isBusy?.()) {
      if (busyRetry === null) {
        busyRetry = timers.setTimeout(() => {
          busyRetry = null;
          refreshNow();
        }, BUSY_RETRY_MS);
      }
      return;
    }
    options.refresh();
  };

  const setMode = (next: LiveMode) => {
    if (mode === next) return;
    mode = next;
    options.onMode(next);
  };
  const setInterval_ = (ms: number) => {
    if (interval !== null) timers.clearInterval(interval);
    interval = timers.setInterval(refreshNow, ms);
  };

  const fallBack = () => {
    if (stopped || mode === 'polling') return;
    timers.clearTimeout(connectTimer);
    unsubscribe?.();
    unsubscribe = null;
    setMode('polling');
    setInterval_(POLL_INTERVAL_MS);
    // The page may have missed changes while connecting: catch up, debounced
    // (never synchronously, so a click made meanwhile is not cancelled).
    onChange();
  };

  function onChange() {
    if (stopped) return;
    if (debounce !== null) timers.clearTimeout(debounce);
    debounce = timers.setTimeout(() => {
      debounce = null;
      refreshNow();
    }, DEBOUNCE_MS);
  }

  const onStatus = (status: ChannelStatus) => {
    if (stopped) return;
    if (status === 'SUBSCRIBED') {
      if (mode !== 'connecting') return;
      timers.clearTimeout(connectTimer);
      setMode('live');
      setInterval_(SAFETY_REFRESH_MS);
      return;
    }
    fallBack();
  };

  const connectTimer = timers.setTimeout(() => {
    if (mode === 'connecting') fallBack();
  }, CONNECT_TIMEOUT_MS);

  options.onMode(mode);
  try {
    unsubscribe = options.subscribe({ onChange, onStatus });
  } catch {
    fallBack();
  }

  return () => {
    if (stopped) return;
    stopped = true;
    timers.clearTimeout(connectTimer);
    if (debounce !== null) timers.clearTimeout(debounce);
    if (busyRetry !== null) timers.clearTimeout(busyRetry);
    if (interval !== null) timers.clearInterval(interval);
    unsubscribe?.();
    unsubscribe = null;
  };
}
