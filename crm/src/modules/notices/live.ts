import type { NoticeInboxDTO, NoticeItemDTO } from './contracts';

/**
 * Bell catch-up (browser side, framework-free so it can be unit tested;
 * modelled on deals/live-refresh.ts). Contract 9.4.
 *
 * A Realtime event on public.staff_notices (filter recipient_user_id=eq.<uid>)
 * NEVER renders its payload: it only schedules a debounced (1 s) re-read
 * through the server (notice_inbox, which applies the access re-check).
 *
 *   start, every (re)subscribe, tab focus / visible  -> full first-page read
 *   Realtime event (debounced 1 s)                   -> read after latestSeq;
 *       when that brings no new rows the event was a read / done / resolve
 *       elsewhere, so a full first-page read follows
 *   every 30 s while running (fallback, also when live) -> read after latestSeq
 *   Realtime closed / error / not subscribed in 10 s -> polling mode (the 30 s
 *       poll keeps running; a full read catches up)
 *   a failed read keeps the last list, sets `stale` ("Notices may be out of
 *       date — retrying") and retries after 5 s, 15 s, 60 s, then every 60 s;
 *       any success clears it
 * Reads never overlap: a read requested while one runs is queued (the full
 * kind wins).
 *   notices switched off (a read answers enabled: false) -> the 30 s poll stops;
 *       only a Realtime event, a (re)subscribe, focus / visible or refresh()
 *       reads again, and a read that answers enabled: true restarts the poll
 */

export const NOTICE_DEBOUNCE_MS = 1_000;
export const NOTICE_POLL_MS = 30_000;
export const NOTICE_CONNECT_TIMEOUT_MS = 10_000;
export const NOTICE_RETRY_MS = [5_000, 15_000, 60_000] as const;
export const NOTICE_RETRY_STEADY_MS = 60_000;
/** Items kept in memory (first page plus incremental arrivals). */
export const NOTICE_KEEP = 100;

export type NoticeLiveMode = 'connecting' | 'live' | 'polling';
export type NoticeChannelStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR';

export interface NoticeLiveState {
  mode: NoticeLiveMode;
  /** The last read failed; the list shown is the last good one. */
  stale: boolean;
  inbox: NoticeInboxDTO | null;
}

export interface NoticeTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface NoticeLiveOptions {
  /** notice_inbox through the server: afterSeq null = first page. Null result = signed out / not available. */
  read: (afterSeq: number | null) => Promise<NoticeInboxDTO | null>;
  onState: (state: NoticeLiveState) => void;
  /** Opens the Realtime channel; returns an unsubscribe function. May throw (treated as unavailable). */
  subscribe: (handlers: { onChange: () => void; onStatus: (status: NoticeChannelStatus) => void }) => () => void;
  timers?: NoticeTimers;
}

export interface NoticeLiveHandle {
  /** Tab focus or visibilitychange to visible. */
  focus(): void;
  /** After a local mark / done: re-read the first page. */
  refresh(): void;
  stop(): void;
}

const defaultTimers: NoticeTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
};

/** Merges an incremental read into the shown inbox (new rows first, no duplicates, counts from the server). */
export function mergeInbox(current: NoticeInboxDTO | null, next: NoticeInboxDTO): NoticeInboxDTO {
  if (!current || !next.enabled) return next;
  const seen = new Set(next.items.map((i) => i.noticeId));
  const items: NoticeItemDTO[] = [...next.items, ...current.items.filter((i) => !seen.has(i.noticeId))]
    .sort((a, b) => b.seq - a.seq)
    .slice(0, NOTICE_KEEP);
  return { ...next, items, latestSeq: next.latestSeq ?? current.latestSeq };
}

/** Retry delay after the n-th consecutive failure (1-based). */
export function retryDelay(failures: number): number {
  return failures <= NOTICE_RETRY_MS.length ? NOTICE_RETRY_MS[failures - 1]! : NOTICE_RETRY_STEADY_MS;
}

export function startNoticeLive(options: NoticeLiveOptions): NoticeLiveHandle {
  const timers = options.timers ?? defaultTimers;
  let state: NoticeLiveState = { mode: 'connecting', stale: false, inbox: null };
  let stopped = false;
  let running = false;
  let queued: 'full' | 'after' | null = null;
  let failures = 0;
  let retry: unknown = null;
  let debounce: unknown = null;
  let unsubscribe: (() => void) | null = null;
  // True while the debounced read was caused by a Realtime event (not a poll).
  let pendingChange = false;
  let poll: unknown = null;

  // The 30 s poll runs only while notices are on (and until the first read says otherwise).
  function setPolling(on: boolean) {
    if (stopped) return;
    if (on && poll === null) poll = timers.setInterval(() => schedule('after'), NOTICE_POLL_MS);
    if (!on && poll !== null) {
      timers.clearInterval(poll);
      poll = null;
    }
  }

  const emit = (patch: Partial<NoticeLiveState>) => {
    state = { ...state, ...patch };
    if (!stopped) options.onState(state);
  };

  const schedule = (kind: 'full' | 'after') => {
    if (stopped) return;
    if (running) {
      queued = queued === 'full' || kind === 'full' ? 'full' : 'after';
      return;
    }
    void runRead(kind);
  };

  async function runRead(kind: 'full' | 'after'): Promise<void> {
    running = true;
    const afterSeq = kind === 'after' ? (state.inbox?.latestSeq ?? null) : null;
    const effective: 'full' | 'after' = afterSeq === null ? 'full' : kind;
    let followUp: 'full' | null = null;
    try {
      const result = await options.read(effective === 'full' ? null : afterSeq);
      if (stopped) return;
      failures = 0;
      if (retry !== null) {
        timers.clearTimeout(retry);
        retry = null;
      }
      setPolling(result === null || result.enabled);
      if (result === null) {
        emit({ stale: false, inbox: null });
      } else if (effective === 'full') {
        emit({ stale: false, inbox: result });
      } else {
        const fresh = result.items.length;
        emit({ stale: false, inbox: mergeInbox(state.inbox, result) });
        if (fresh === 0 && pendingChange) followUp = 'full';
      }
      pendingChange = false;
    } catch {
      if (stopped) return;
      failures += 1;
      emit({ stale: true });
      if (retry !== null) timers.clearTimeout(retry);
      retry = timers.setTimeout(() => {
        retry = null;
        schedule('full');
      }, retryDelay(failures));
    } finally {
      running = false;
    }
    const next = followUp ?? queued;
    queued = null;
    if (next && !stopped) schedule(next);
  }

  const onChange = () => {
    if (stopped) return;
    if (debounce !== null) timers.clearTimeout(debounce);
    debounce = timers.setTimeout(() => {
      debounce = null;
      pendingChange = true;
      schedule('after');
    }, NOTICE_DEBOUNCE_MS);
  };

  const fallBack = () => {
    if (stopped || state.mode === 'polling') return;
    timers.clearTimeout(connectTimer);
    // Removing the channel reports a status (CLOSED) synchronously, which calls
    // onStatus -> fallBack again. Detach and switch to polling first, so that
    // re-entrant call returns at the guard above instead of recursing (BR-25).
    const unsubscribeChannel = unsubscribe;
    unsubscribe = null;
    emit({ mode: 'polling' });
    unsubscribeChannel?.();
    schedule('full');
  };

  const onStatus = (status: NoticeChannelStatus) => {
    if (stopped) return;
    if (status === 'SUBSCRIBED') {
      timers.clearTimeout(connectTimer);
      if (state.mode !== 'live') emit({ mode: 'live' });
      // Every (re)subscribe catches up with a full read.
      schedule('full');
      return;
    }
    fallBack();
  };

  const connectTimer = timers.setTimeout(() => {
    if (state.mode === 'connecting') fallBack();
  }, NOTICE_CONNECT_TIMEOUT_MS);

  options.onState(state);
  setPolling(true);
  schedule('full');
  try {
    unsubscribe = options.subscribe({ onChange, onStatus });
  } catch {
    fallBack();
  }

  return {
    focus: () => schedule('full'),
    refresh: () => schedule('full'),
    stop: () => {
      if (stopped) return;
      stopped = true;
      timers.clearTimeout(connectTimer);
      if (poll !== null) timers.clearInterval(poll);
      if (debounce !== null) timers.clearTimeout(debounce);
      if (retry !== null) timers.clearTimeout(retry);
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
