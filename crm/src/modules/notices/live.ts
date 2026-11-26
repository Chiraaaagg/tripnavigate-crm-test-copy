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
 *
 * Session ended (S4 contract 2.6 item 9). The reader throws NoticeSessionEnded
 * when the server refuses the read because the session is over (401).
 *   first refusal                  -> like any other failure (stale, 5 s retry,
 *       the 30 s poll keeps running). One refusal can be a cookie-refresh race
 *       between two tabs, so it never silences urgent notices on its own.
 *   the next read, at least 5 s after the first refusal, refused again
 *       -> mode 'ended': the poll, the retry and the debounce stop, the Realtime
 *       channel is removed, `stale` stays true and the last list is kept. A
 *       successful read or any other failure in between resets the count.
 *   while ended the only reads are probes: 5 min after entering, 15 min after
 *       that, then every hour, plus one on focus() / refresh() when at least
 *       10 s have passed since the last probe. A failed probe changes nothing
 *       shown (the ended state is announced once).
 *   a probe that succeeds -> the result is shown, the poll restarts and the
 *       channel is opened again (mode 'connecting', fresh 10 s connect timeout)
 */

export const NOTICE_DEBOUNCE_MS = 1_000;
export const NOTICE_POLL_MS = 30_000;
export const NOTICE_CONNECT_TIMEOUT_MS = 10_000;
export const NOTICE_RETRY_MS = [5_000, 15_000, 60_000] as const;
export const NOTICE_RETRY_STEADY_MS = 60_000;
/** Items kept in memory (first page plus incremental arrivals). */
export const NOTICE_KEEP = 100;
/** A second session refusal enters ended mode only this long after the first. */
export const NOTICE_ENDED_CONFIRM_MS = 5_000;
/**
 * Probe delays while ended, read as gaps (lead decision, 26 Nov 2026): the first
 * probe 5 min after entering ended mode, the second 15 min after the first (so
 * 20 min after entering), then one every hour (NOTICE_ENDED_PROBE_STEADY_MS).
 */
export const NOTICE_ENDED_PROBE_MS = [300_000, 900_000] as const;
/** Probe delay while ended after the early probes. */
export const NOTICE_ENDED_PROBE_STEADY_MS = 3_600_000;
/** focus() / refresh() probe while ended only this long after the last probe. */
export const NOTICE_ENDED_FOCUS_MIN_MS = 10_000;

export type NoticeLiveMode = 'connecting' | 'live' | 'polling' | 'ended';
export type NoticeChannelStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR';

/** Thrown by NoticeLiveOptions.read when the server refused the read because the session ended. */
export class NoticeSessionEnded extends Error {
  constructor() {
    super('session ended');
    this.name = 'NoticeSessionEnded';
  }
}

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
  /**
   * notice_inbox through the server: afterSeq null = first page. Null result = signed out / not available.
   * Throws NoticeSessionEnded when the session ended; any other throw is an ordinary failure.
   */
  read: (afterSeq: number | null) => Promise<NoticeInboxDTO | null>;
  onState: (state: NoticeLiveState) => void;
  /** Opens the Realtime channel; returns an unsubscribe function. May throw (treated as unavailable). */
  subscribe: (handlers: { onChange: () => void; onStatus: (status: NoticeChannelStatus) => void }) => () => void;
  timers?: NoticeTimers;
  /** Milliseconds clock (default Date.now); used for the 5 s confirmation and the 10 s probe spacing. */
  now?: () => number;
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

/** Delay before the n-th probe while ended (1-based): 5 min, then 15 min, then every hour. */
export function endedProbeDelay(probe: number): number {
  return probe <= NOTICE_ENDED_PROBE_MS.length ? NOTICE_ENDED_PROBE_MS[probe - 1]! : NOTICE_ENDED_PROBE_STEADY_MS;
}

function isSessionEnded(error: unknown): boolean {
  return error instanceof NoticeSessionEnded || (error instanceof Error && error.name === 'NoticeSessionEnded');
}

export function startNoticeLive(options: NoticeLiveOptions): NoticeLiveHandle {
  const timers = options.timers ?? defaultTimers;
  const now = options.now ?? (() => Date.now());
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
  let connectTimer: unknown = null;
  // Each opened channel gets its own generation; callbacks of a channel removed on
  // entering ended mode are ignored after it has been opened again.
  let generation = 0;
  // Session ended: time of the first of two consecutive session refusals (null = none pending).
  let sessionRefusalAt: number | null = null;
  let probeTimer: unknown = null;
  let probeCount = 0;
  let lastProbeAt = 0;

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
    // While ended only probes read (they call runRead directly).
    if (stopped || state.mode === 'ended') return;
    if (running) {
      queued = queued === 'full' || kind === 'full' ? 'full' : 'after';
      return;
    }
    void runRead(kind);
  };

  const clearTimer = (handle: unknown) => {
    if (handle !== null) timers.clearTimeout(handle);
  };

  function enterEnded() {
    sessionRefusalAt = null;
    failures = 0;
    queued = null;
    pendingChange = false;
    setPolling(false);
    clearTimer(retry);
    retry = null;
    clearTimer(debounce);
    debounce = null;
    clearTimer(connectTimer);
    connectTimer = null;
    // As in fallBack: detach and switch mode first, because removing the channel
    // reports CLOSED synchronously and that call must find nothing to do (BR-25).
    generation += 1;
    const unsubscribeChannel = unsubscribe;
    unsubscribe = null;
    emit({ mode: 'ended', stale: true });
    lastProbeAt = now();
    probeCount = 0;
    armProbe();
    try {
      unsubscribeChannel?.();
    } catch {
      /* the channel is gone either way */
    }
  }

  function armProbe() {
    if (stopped) return;
    clearTimer(probeTimer);
    probeTimer = timers.setTimeout(() => {
      probeTimer = null;
      probeCount += 1;
      // The ladder continues whatever this probe answers; a success clears it.
      armProbe();
      probe();
    }, endedProbeDelay(probeCount + 1));
  }

  function probe() {
    if (stopped || state.mode !== 'ended' || running) return;
    lastProbeAt = now();
    void runRead('full');
  }

  function openChannel() {
    clearTimer(connectTimer);
    connectTimer = timers.setTimeout(() => {
      connectTimer = null;
      if (state.mode === 'connecting') fallBack();
    }, NOTICE_CONNECT_TIMEOUT_MS);
    const gen = generation;
    try {
      unsubscribe = options.subscribe({
        onChange: () => {
          if (gen === generation) onChange();
        },
        onStatus: (status) => {
          if (gen === generation) onStatus(status);
        },
      });
    } catch {
      fallBack();
    }
  }

  async function runRead(kind: 'full' | 'after'): Promise<void> {
    running = true;
    const probing = state.mode === 'ended';
    const afterSeq = kind === 'after' ? (state.inbox?.latestSeq ?? null) : null;
    const effective: 'full' | 'after' = afterSeq === null ? 'full' : kind;
    let followUp: 'full' | null = null;
    try {
      const result = await options.read(effective === 'full' ? null : afterSeq);
      if (stopped) return;
      failures = 0;
      sessionRefusalAt = null;
      clearTimer(retry);
      retry = null;
      if (probing) {
        clearTimer(probeTimer);
        probeTimer = null;
      }
      setPolling(result === null || result.enabled);
      const mode: Partial<NoticeLiveState> = probing ? { mode: 'connecting' } : {};
      if (result === null) {
        emit({ ...mode, stale: false, inbox: null });
      } else if (effective === 'full') {
        emit({ ...mode, stale: false, inbox: result });
      } else {
        const fresh = result.items.length;
        emit({ ...mode, stale: false, inbox: mergeInbox(state.inbox, result) });
        if (fresh === 0 && pendingChange) followUp = 'full';
      }
      pendingChange = false;
      // A probe that succeeds opens the channel again (its SUBSCRIBED queues a full read).
      if (probing) openChannel();
    } catch (error) {
      if (stopped) return;
      // A failed probe changes nothing shown; the next probe is already armed.
      if (probing) return;
      if (isSessionEnded(error)) {
        const at = now();
        if (sessionRefusalAt !== null && at - sessionRefusalAt >= NOTICE_ENDED_CONFIRM_MS) {
          enterEnded();
          return;
        }
        if (sessionRefusalAt === null) sessionRefusalAt = at;
      } else {
        // Only two consecutive session refusals count.
        sessionRefusalAt = null;
      }
      failures += 1;
      emit({ stale: true });
      clearTimer(retry);
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
    if (stopped || state.mode === 'ended') return;
    clearTimer(debounce);
    debounce = timers.setTimeout(() => {
      debounce = null;
      pendingChange = true;
      schedule('after');
    }, NOTICE_DEBOUNCE_MS);
  };

  const fallBack = () => {
    if (stopped || state.mode === 'polling' || state.mode === 'ended') return;
    clearTimer(connectTimer);
    connectTimer = null;
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
    if (stopped || state.mode === 'ended') return;
    if (status === 'SUBSCRIBED') {
      clearTimer(connectTimer);
      connectTimer = null;
      if (state.mode !== 'live') emit({ mode: 'live' });
      // Every (re)subscribe catches up with a full read.
      schedule('full');
      return;
    }
    fallBack();
  };

  // While ended, focus / refresh probe at most once per 10 s; otherwise a full read.
  const readNow = () => {
    if (state.mode !== 'ended') {
      schedule('full');
      return;
    }
    if (now() - lastProbeAt >= NOTICE_ENDED_FOCUS_MIN_MS) probe();
  };

  options.onState(state);
  setPolling(true);
  schedule('full');
  openChannel();

  return {
    focus: readNow,
    refresh: readNow,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearTimer(connectTimer);
      connectTimer = null;
      if (poll !== null) timers.clearInterval(poll);
      clearTimer(debounce);
      clearTimer(retry);
      clearTimer(probeTimer);
      probeTimer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
