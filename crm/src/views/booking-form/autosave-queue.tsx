'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SaveState } from '@/components/ui/save-status';
import { UNKNOWN_OUTCOME_TEXT } from '@/modules/fulfilment/contracts';
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
}

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
  if (result.code === 'unexpected') return UNKNOWN_OUTCOME_TEXT;
  const named = (refusedFields(result) ?? []).map((f) => refs.find((r) => r.field === f)?.label).find(Boolean);
  return named ?? errorText(result);
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
  send: () => Promise<UiResult>;
  refs?: readonly FieldRef[];
}): CardSaveState & { flushNow: () => void } {
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
  const latest = useRef({ check, send, refs, enabled, dirty });
  useEffect(() => {
    latest.current = { check, send, refs, enabled, dirty };
  });
  const serialised = JSON.stringify(values);

  const attempt = useCallback(() => {
    timer.current = null;
    const l = latest.current;
    if (!l.enabled || !l.dirty) return;
    const issues = l.check();
    if (issues.length > 0) {
      const next: CardSaveState = { state: 'fix', reason: issues[0]! };
      settled.current = next;
      setS(next);
      return;
    }
    void queue
      // Saved meanwhile by another path (a drawer's save of the same card): nothing left to send.
      .run(() => (latest.current.dirty ? latest.current.send() : Promise.resolve<UiResult>({ ok: true, data: undefined, message: '' } as UiResult)))
      .then((r) => {
        const next: CardSaveState = r.ok ? { state: 'saved', reason: null } : { state: 'fix', reason: refusalReason(r, latest.current.refs) };
        settled.current = next;
        setS((cur) => (cur.state === 'saving' && r.ok && latest.current.dirty ? cur : next));
      })
      .catch(() => {
        const next: CardSaveState = { state: 'fix', reason: UNKNOWN_OUTCOME_TEXT };
        settled.current = next;
        setS(next);
      });
  }, [queue]);

  useEffect(() => {
    if (!enabled) return;
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
    timer.current = setTimeout(attempt, AUTOSAVE_DELAY_MS);
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
  return { ...s, flushNow };
}
