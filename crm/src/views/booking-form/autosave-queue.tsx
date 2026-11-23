'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import type { SaveState } from '@/components/ui/save-status';
import { BOOK_RELIABILITY_TEXT, ERROR_TEXT, UNKNOWN_OUTCOME_TEXT } from '@/modules/fulfilment/contracts';
import { ROUTES } from '@/modules/identity/session-policy';
import type { LatestOutcome } from '../b11/draft-sync';
import { errorText, refusedFields, type FieldRef, type UiResult } from '../b11/form-kit';

/*
 * One page-level save queue for the booking form (Book now v2, change 2 and
 * owner answer 2: cards save themselves). Every save of the page (the cards'
 * auto-saves, the service drawers, removals, uploads, fares and returns)
 * runs through `run`, one at a time, so two cards never post the same row
 * version and refuse each other with "version_changed". Each save still posts
 * its own form's base row version through the existing own-save chain
 * (draft-sync.tsx: recordSave / advanceBase); because the queue waits for the
 * previous answer, that chain already holds the previous save when the next
 * one is sent.
 *
 * The queue also keeps each auto-saving card's state (Not started, Saving…,
 * Saved, Not saved · needs a fix) for the card pill, the step tabs and the
 * footer ("Not saved: Package price · Go to fix").
 */

export type AutosaveKey = 'customer' | 'passengers' | 'fares' | 'price' | 'billTo' | 'plan';

export interface CardSaveState {
  state: SaveState;
  reason: string | null;
  /**
   * Booking reliability (build contract B1-4, B1-5, B1-8). `paused`: autosave
   * sends nothing until the employee presses "Try again" or edits the card.
   * `retry`: show "Try again". `signIn`: show "Sign in (opens in a new tab)".
   * `conflict`: show "Load the latest and keep my entries". `note`: a status
   * line under the card (for example W5 or W9c).
   */
  paused?: boolean;
  retry?: boolean;
  signIn?: boolean;
  conflict?: boolean;
  note?: string | null;
}

/** A card's send may say exactly how the card should read (the passengers card after a lost answer). */
export type SendOutcome = UiResult & { card?: CardSaveState };

export const AUTOSAVE_LABEL: Record<AutosaveKey, string> = {
  customer: 'Customer & trip',
  passengers: 'Passengers',
  fares: 'Total fare per person',
  price: 'Package price',
  billTo: 'Bill To',
  plan: 'Payment plan',
};

/** The card each key scrolls to ("Go to fix"). */
export const AUTOSAVE_TARGET: Record<AutosaveKey, string> = {
  customer: 'customer',
  passengers: 'passengers',
  fares: 'bf-fare-box',
  price: 'price',
  billTo: 'billTo',
  plan: 'plan',
};

/** Wait after the last keystroke before a card checks itself and saves (prototype: 700 ms). */
export const AUTOSAVE_DELAY_MS = 700;

interface QueueContext {
  /** The draft these saves belong to (the settled states below are kept per draft). */
  scope: string;
  run: <T>(job: () => Promise<T>) => Promise<T>;
  /** Saves waiting or in flight on this page. */
  pending: number;
  cards: Partial<Record<AutosaveKey, CardSaveState>>;
  report: (key: AutosaveKey, s: CardSaveState | null) => void;
}

const Ctx = createContext<QueueContext | null>(null);

/** A serial job runner (pure, so it is unit-tested): each job starts after the previous one settled. */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(job: () => Promise<T>): Promise<T> {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };
}

/**
 * Each card's last settled state per draft, kept for this page's life: a card
 * that mounts again (the step addresses render the screen again) shows what
 * its last save did, not "Not started".
 */
const lastSettled = new Map<string, CardSaveState>();

export function SaveQueueProvider({ scope = '', children }: { scope?: string; children: ReactNode }) {
  const serial = useRef(createSerialQueue());
  const [pending, setPending] = useState(0);
  const [cards, setCards] = useState<Partial<Record<AutosaveKey, CardSaveState>>>({});
  const run = useCallback(<T,>(job: () => Promise<T>) => {
    setPending((n) => n + 1);
    return serial.current(job).finally(() => setPending((n) => n - 1));
  }, []);
  const report = useCallback((key: AutosaveKey, s: CardSaveState | null) => {
    setCards((c) => {
      const cur = c[key];
      if (s === null) {
        if (!cur) return c;
        const n = { ...c };
        delete n[key];
        return n;
      }
      if (cur && cur.state === s.state && cur.reason === s.reason) return c;
      return { ...c, [key]: s };
    });
  }, []);
  const value = useMemo(() => ({ scope, run, pending, cards, report }), [scope, run, pending, cards, report]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Outside the booking form (gallery cards on their own) saves run directly. */
const DIRECT: QueueContext = { scope: '', run: (job) => job(), pending: 0, cards: {}, report: () => {} };

export function useSaveQueue(): QueueContext {
  return useContext(Ctx) ?? DIRECT;
}

/** The words for a refused save: the first named field's text, else the refusal itself (said once). */
export function refusalReason(result: UiResult, refs: readonly FieldRef[] = []): string {
  if (result.ok) return '';
  if (result.code === 'unexpected') return 'offline' in result && result.offline ? BOOK_RELIABILITY_TEXT.offlineNotSaved : UNKNOWN_OUTCOME_TEXT;
  // B1-5: a stale card says why, not a bare "Not saved".
  if (result.code === 'version_changed') return ERROR_TEXT.version_changed;
  const named = (refusedFields(result) ?? []).map((f) => refs.find((r) => r.field === f)?.label).find(Boolean);
  return named ?? errorText(result);
}

/**
 * How a card reads after one save (pure, unit-tested). An unknown outcome, a
 * save that could not be sent and an ended session pause autosave: nothing is
 * sent again until the employee presses "Try again" or edits the card
 * (build contract section 1 rule 1; B1-4 d; B1-8).
 */
export function cardStateOf(r: SendOutcome, refs: readonly FieldRef[] = []): CardSaveState {
  if (r.card) return r.card;
  if (r.ok) return { state: 'saved', reason: null };
  if (r.code === 'session') return { state: 'fix', reason: ERROR_TEXT.session, signIn: true, retry: true, paused: true };
  if (r.code === 'unexpected') {
    if ('offline' in r && r.offline) return { state: 'fix', reason: BOOK_RELIABILITY_TEXT.offlineNotSaved, retry: true, paused: true };
    return { state: 'fix', reason: UNKNOWN_OUTCOME_TEXT, paused: true };
  }
  if (r.code === 'version_changed') return { state: 'fix', reason: ERROR_TEXT.version_changed, conflict: true };
  return { state: 'fix', reason: refusalReason(r, refs) };
}

/**
 * Whether a change of the typed values may start the autosave timer (pure,
 * unit-tested): never while the card cannot save or has nothing unsaved, and
 * never while it is paused on the same values (only an edit re-arms it).
 */
export function autosaveMayArm(s: { enabled: boolean; dirty: boolean; pausedOn: string | null; values: string }): 'arm' | 'idle' | 'paused' {
  if (!s.enabled) return 'idle';
  if (s.pausedOn !== null && s.pausedOn === s.values) return 'paused';
  return s.dirty ? 'arm' : 'idle';
}

/**
 * A card that saves itself: about 700 ms after its values stop changing it
 * runs its own checks; when they fail it shows "Not saved · needs a fix" with
 * the first reason and sends nothing; when they pass it posts through the
 * page queue. Values typed while a save is in flight are saved next.
 */
export function useAutosave<T>({
  key,
  values,
  dirty,
  enabled,
  hasStored,
  check,
  send,
  refs,
  confirm,
  retry,
}: {
  key: AutosaveKey;
  values: T;
  /** The card's values differ from the last loaded or saved ones. */
  dirty: boolean;
  /** False when the card cannot save (view only, verified Bill To, no draft). */
  enabled: boolean;
  /** The card already holds saved data (the pill starts at "Saved", not "Not started"). */
  hasStored: boolean;
  /** Local checks in the live CRM wording; [] = fine to save. */
  check: () => string[];
  /** Posts the card's form (the section form's `post`). */
  send: () => Promise<SendOutcome>;
  refs?: readonly FieldRef[];
  /** Asked before a save is queued (B1-9 rename confirm); false = send nothing now. */
  confirm?: () => Promise<boolean>;
  /** What "Try again" does (default: send the same values now). The passengers card reads first. */
  retry?: () => Promise<SendOutcome>;
}): CardSaveState & { flushNow: () => void; retryNow: () => void; settle: (s: CardSaveState) => void } {
  const queue = useSaveQueue();
  const memoKey = `${queue.scope}:${key}`;
  const [s, setS] = useState<CardSaveState>(() => {
    const last = lastSettled.get(memoKey);
    if (last && (last.state === 'saved' || last.state === 'fix')) return last;
    return { state: hasStored ? 'saved' : 'idle', reason: null };
  });
  // The stored view says the card has data and nothing is typed: it reads "Saved".
  if (hasStored && !dirty && s.state === 'idle') setS({ state: 'saved', reason: null });
  useEffect(() => {
    if (s.state === 'saved' || s.state === 'fix') lastSettled.set(memoKey, s);
  }, [memoKey, s]);
  const settled = useRef<CardSaveState>(s);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ check, send, refs, enabled, dirty, confirm, retry });
  const serialised = JSON.stringify(values);
  const serialisedRef = useRef(serialised);
  useEffect(() => {
    latest.current = { check, send, refs, enabled, dirty, confirm, retry };
    serialisedRef.current = serialised;
  });
  /** The typed values autosave is paused on (null = not paused); an edit away from them re-arms it. */
  const pausedOn = useRef<string | null>(null);

  /** Sets the card's state from outside the timer (drawer saves, "Try again", the re-base). */
  const settle = useCallback((next: CardSaveState) => {
    settled.current = next;
    pausedOn.current = next.paused ? serialisedRef.current : null;
    setS(next);
  }, []);

  const attempt = useCallback(
    (force = false) => {
      timer.current = null;
      const l = latest.current;
      if (!l.enabled) return;
      if (!force && (!l.dirty || pausedOn.current !== null)) return;
      const issues = l.check();
      if (issues.length > 0) {
        settle({ state: 'fix', reason: issues[0]! });
        return;
      }
      if (force) setS({ state: 'saving', reason: null });
      void (l.confirm ? l.confirm() : Promise.resolve<boolean>(true))
        .then((go) => {
          // "Keep the old name" (B1-9): nothing is sent; the restored values decide what the card shows.
          if (!go) return;
          return queue
            .run((): Promise<SendOutcome> => {
              const now = latest.current;
              if (force && now.retry) return now.retry();
              // Saved meanwhile by another path (a drawer's save of the same card): nothing left to send.
              return force || now.dirty ? now.send() : Promise.resolve<SendOutcome>({ ok: true, data: undefined, message: '' } as SendOutcome);
            })
            .then((r) => {
              const next = cardStateOf(r, latest.current.refs);
              if (next.paused || next.note || force) {
                settle(next);
                return;
              }
              settled.current = next;
              pausedOn.current = null;
              setS((cur) => (cur.state === 'saving' && r.ok && latest.current.dirty ? cur : next));
            });
        })
        .catch(() => settle({ state: 'fix', reason: UNKNOWN_OUTCOME_TEXT, paused: true }));
    },
    [queue, settle],
  );

  useEffect(() => {
    if (!enabled) return;
    const arm = autosaveMayArm({ enabled, dirty, pausedOn: pausedOn.current, values: serialised });
    // Paused on these values (an unknown outcome, offline, signed out): only an edit or "Try again" sends.
    if (arm === 'paused') return;
    pausedOn.current = null;
    if (!dirty) {
      // Typed back to the saved values, or the save just landed: nothing to send.
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      setS((cur) => (cur.state === 'saving' && settled.current.state !== 'fix' ? { state: hasStored || settled.current.state === 'saved' ? 'saved' : settled.current.state, reason: null } : cur));
      return;
    }
    setS({ state: 'saving', reason: null });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => attempt(), AUTOSAVE_DELAY_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on each change of the typed values
  }, [serialised, dirty, enabled]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const { report } = queue;
  useEffect(() => {
    report(key, enabled ? s : null);
  }, [report, key, enabled, s]);
  useEffect(() => () => report(key, null), [report, key]);

  const flushNow = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      attempt();
    }
  }, [attempt]);
  /** "Try again": an employee action; sends now (the passengers card reads first). */
  const retryNow = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pausedOn.current = null;
    attempt(true);
  }, [attempt]);
  return { ...s, flushNow, retryNow, settle };
}

/**
 * Booking reliability B1-5 for a card: "Load the latest and keep my entries"
 * under a conflict. When the latest view arrives the section form re-bases
 * (same content) or reports that the same card changed; the card then reads
 * W9b with "Try again", or the conflict with W9c. Nothing is sent here.
 */
export function useCardLatest(f: { latest: LatestOutcome; loadLatest: () => void }, save: { settle: (s: CardSaveState) => void }) {
  const { settle } = save;
  const seen = useRef<LatestOutcome>(f.latest);
  useEffect(() => {
    if (f.latest === seen.current) return;
    seen.current = f.latest;
    if (f.latest === 'rebased') settle({ state: 'fix', reason: BOOK_RELIABILITY_TEXT.latestLoadedKeepEntries, retry: true, paused: true });
    else if (f.latest === 'changed') settle({ state: 'fix', reason: ERROR_TEXT.version_changed, note: BOOK_RELIABILITY_TEXT.sameItemChanged, paused: true });
  }, [f.latest, settle]);
  return { latest: f.latest, onLoadLatest: f.loadLatest };
}

/**
 * The controls under a card's save reason (V4, V5, V6): "Sign in (opens in a
 * new tab)", "Load the latest and keep my entries", "Try again", and one
 * status line. Existing components only; nothing renders for a plain refusal.
 */
export function SaveRecovery({
  save,
  describedBy,
  latest = null,
  onLoadLatest,
  className,
}: {
  save: CardSaveState & { retryNow: () => void };
  /** Id of the reason text the buttons refer to. */
  describedBy?: string;
  latest?: LatestOutcome;
  onLoadLatest?: () => void;
  className?: string;
}) {
  const fix = save.state === 'fix';
  const signIn = fix && save.signIn;
  const loadLatest = fix && save.conflict && onLoadLatest;
  const retry = fix && save.retry;
  if (!signIn && !loadLatest && !retry && !save.note) return null;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {signIn || loadLatest || retry ? (
        <div className="flex flex-wrap items-center gap-2.5">
          {signIn ? (
            <a href={ROUTES.signIn} target="_blank" rel="noopener noreferrer" className={cn('inline-flex min-h-9 items-center rounded-chip text-sm font-semibold text-brand-strong underline underline-offset-4', focusRing)}>
              {BOOK_RELIABILITY_TEXT.signInNewTab}
            </a>
          ) : null}
          {loadLatest ? (
            <Button size="sm" loading={latest === 'waiting'} aria-describedby={describedBy} onClick={onLoadLatest}>
              {BOOK_RELIABILITY_TEXT.loadLatestKeepEntries}
            </Button>
          ) : null}
          {retry ? (
            <Button size="sm" aria-describedby={describedBy} onClick={save.retryNow}>
              {BOOK_RELIABILITY_TEXT.tryAgain}
            </Button>
          ) : null}
        </div>
      ) : null}
      {save.note ? (
        <p role="status" className="m-0 text-sm text-copy">
          {save.note}
        </p>
      ) : null}
    </div>
  );
}

/** The reason line of a card is an alert when the card needs the employee (refusal, offline, signed out). */
export function reasonRole(save: CardSaveState): 'alert' | undefined {
  return save.state === 'fix' && (save.paused || save.conflict || save.retry || save.signIn) ? 'alert' : undefined;
}
