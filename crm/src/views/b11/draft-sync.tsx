'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import { BOOK_RELIABILITY_TEXT, type BookingActionResult, type BookSection } from '@/modules/fulfilment/contracts';
import type { QuotationSection } from '@/modules/quotations/contracts';
import { guard } from '../booking-forms';
import { advanceBase } from './book-fields';
import { normaliseResult, requestIdFor } from './result';
import { newRequestId, useUnsavedGuard, type UiResult } from './form-kit';
import type { B11Action } from './shapes';

/*
 * B1.2 three-step Book now (freeze note §2.1, Terra contract §2.2–2.3).
 *
 * DraftSync is the per-step client bookkeeping that lets one page carry
 * several forms (sections, service cards) without losing anybody's work:
 *
 * - every form posts its OWN base row version, not "the latest the page knows";
 *   after one of this browser's saves (expected → result), every form whose
 *   base equals `expected` advances (advanceBase), so own saves chain while a
 *   colleague's save leaves a gap and the next save of a dirty form is refused
 *   with version_changed instead of silently overwriting;
 * - a clean form follows the server: new values and the new row version arrive
 *   with the refreshed view; a dirty form keeps what is typed;
 * - "Save and continue" saves the forms with unsaved changes one at a time, in
 *   page order, stops at the first refusal and reports every form in words;
 * - one unsaved-changes guard per step (links to another step, the step list
 *   and Back to the deal; in-page #section links are not guarded).
 */

/** Booking step sections, or the quotation editor's sections (B1.2 Phase E reuses the same sync). */
export type SyncSection = BookSection | QuotationSection;

export interface SyncedEntry {
  id: string;
  section: SyncSection;
  label: string;
  order: number;
  /** Saved by "Save and continue" when it has unsaved changes. */
  saveable: boolean;
  dirty: boolean;
  submit: (options: { refresh: boolean }) => Promise<UiResult>;
  focusResult: () => void;
  /** Element id an error-summary link focuses for this form (its answer box, or the unsaved control). */
  targetId?: string;
}

interface SyncContext {
  rowVersion: number;
  links: ReadonlyArray<{ from: number; to: number }>;
  /** The own-save chain as of now (synchronous; "Save and continue" posts several forms in a row). */
  getLinks: () => ReadonlyArray<{ from: number; to: number }>;
  recordSave: (from: number, to: number) => void;
  register: (entry: SyncedEntry) => void;
  unregister: (id: string) => void;
  setDirty: (id: string, dirty: boolean) => void;
  lastResult: (id: string) => UiResult | null;
  setLastResult: (id: string, result: UiResult | null) => void;
  dirtyEntries: () => SyncedEntry[];
  anyDirty: boolean;
  /** Batch 2: a form of this page saved on its own (not inside "Save and continue"); used to open the next section. */
  subscribeSaved: (listener: SavedListener) => () => void;
  notifySaved: (saved: { id: string; section: SyncSection }) => void;
}

export type SavedListener = (saved: { id: string; section: SyncSection }) => void;

const Ctx = createContext<SyncContext | null>(null);

export function DraftSyncProvider({ view, children }: { view: { version: { rowVersion: number } | null | undefined }; children: ReactNode }) {
  const rowVersion = view.version?.rowVersion ?? 0;
  const entries = useRef(new Map<string, SyncedEntry>());
  const results = useRef(new Map<string, UiResult | null>());
  const [links, setLinks] = useState<ReadonlyArray<{ from: number; to: number }>>([]);
  const linksRef = useRef<Array<{ from: number; to: number }>>([]);
  const getLinks = useCallback(() => linksRef.current, []);
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(() => new Set());
  const anyDirty = dirtyIds.size > 0;
  useUnsavedGuard(anyDirty);
  const listeners = useRef(new Set<SavedListener>());
  const subscribeSaved = useCallback((listener: SavedListener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const notifySaved = useCallback((saved: { id: string; section: SyncSection }) => {
    for (const l of listeners.current) l(saved);
  }, []);

  const recordSave = useCallback((from: number, to: number) => {
    if (to <= from) return;
    if (!linksRef.current.some((l) => l.from === from && l.to === to)) linksRef.current = [...linksRef.current, { from, to }];
    setLinks(linksRef.current);
  }, []);
  const register = useCallback((entry: SyncedEntry) => {
    entries.current.set(entry.id, entry);
  }, []);
  const unregister = useCallback((id: string) => {
    entries.current.delete(id);
    setDirtyIds((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  }, []);
  const setDirty = useCallback((id: string, dirty: boolean) => {
    setDirtyIds((s) => {
      if (s.has(id) === dirty) return s;
      const n = new Set(s);
      if (dirty) n.add(id);
      else n.delete(id);
      return n;
    });
  }, []);
  const value = useMemo<SyncContext>(
    () => ({
      rowVersion,
      links,
      getLinks,
      recordSave,
      register,
      unregister,
      setDirty,
      lastResult: (id) => results.current.get(id) ?? null,
      setLastResult: (id, r) => {
        results.current.set(id, r);
      },
      dirtyEntries: () => [...entries.current.values()].filter((e) => dirtyIds.has(e.id)).sort((a, b) => a.order - b.order),
      anyDirty,
      subscribeSaved,
      notifySaved,
    }),
    [rowVersion, links, getLinks, recordSave, register, unregister, setDirty, dirtyIds, anyDirty, subscribeSaved, notifySaved],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Outside a DraftSyncProvider (preview gallery cards, the submitted view) forms behave like single B1.1 forms. */
const NO_SYNC: SyncContext = {
  rowVersion: 0,
  links: [],
  getLinks: () => [],
  recordSave: () => {},
  register: () => {},
  unregister: () => {},
  setDirty: () => {},
  lastResult: () => null,
  setLastResult: () => {},
  dirtyEntries: () => [],
  anyDirty: false,
  subscribeSaved: () => () => {},
  notifySaved: () => {},
};

export function useDraftSync(): SyncContext {
  return useContext(Ctx) ?? NO_SYNC;
}

/**
 * Booking reliability rules for the forms of one screen (Book now; build
 * contract B1-4 and B1-6). Outside the booking form both are off and the
 * forms behave as before.
 * - serverRefreshes: the server action re-renders the page after a save
 *   (BOOK_SAVE_REFRESH_MODE 'server'), so the form does not also call
 *   router.refresh(). Exactly one party refreshes.
 * - offlineCheck: a save is not sent while the browser says it is offline;
 *   the form answers "You are offline. Not saved yet." and keeps the values.
 */
export interface SaveRules {
  serverRefreshes: boolean;
  offlineCheck: boolean;
}

const RulesCtx = createContext<SaveRules>({ serverRefreshes: false, offlineCheck: false });

export function SaveRulesProvider({ rules, children }: { rules: SaveRules; children: ReactNode }) {
  return <RulesCtx.Provider value={rules}>{children}</RulesCtx.Provider>;
}

/** The save rules of the screen this form is on (see SaveRulesProvider). */
export function useSaveRules(): SaveRules {
  return useContext(RulesCtx);
}

/** True when the browser reports that it is offline (a save would not reach the server). */
export function browserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** "Load the latest and keep my entries" (B1-5): waiting for the view, re-based, or the same part changed. */
export type LatestOutcome = null | 'waiting' | 'rebased' | 'changed';

function rowVersionOf(result: UiResult): number | null {
  if (!result.ok) return null;
  const data = (result as Extract<BookingActionResult<unknown>, { ok: true }>).data as { rowVersion?: unknown } | undefined;
  return data && typeof data.rowVersion === 'number' ? data.rowVersion : null;
}

const json = (v: unknown) => JSON.stringify(v);

export interface SectionFormOptions<T> {
  id: string;
  section: SyncSection;
  /** Words for the save report ("Customer details", "Hotel 2"). */
  label: string;
  order: number;
  action: B11Action;
  /** The values this form shows when nothing is typed (from the view). */
  initial: T;
  /** Posts the working version's row version (booking draft commands). */
  versionBound: boolean;
  /** The view's current row version (version-bound forms start from it). */
  rowVersion: number;
  /** Saved by "Save and continue" when dirty (edit forms; not add/remove/upload forms). */
  saveable?: boolean;
  /** Counts as unsaved work for the guard and the submit check (default: saveable). */
  tracksDirty?: boolean;
  initialState?: UiResult | null;
  /**
   * After a successful save. `submitted` is what was posted; `adopt` changes the
   * values and the saved baseline together (for example, passenger numbers
   * learned from the answer), so the change does not count as unsaved.
   */
  onSuccess?: (result: UiResult, helpers: { submitted: T; adopt: (patch: (v: T) => T) => void }) => void;
  /** New values from the server for a clean form (default: take them as they are). */
  merge?: (current: T, incoming: T) => T;
  /** Whether two values hold the same saved content (default: equal JSON); used by loadLatest. */
  same?: (a: T, b: T) => boolean;
}

/**
 * One form of a step: controlled values that survive refusals, the form's own
 * base row version, dirty tracking against the last loaded or saved values,
 * and a submit that the step's "Save and continue" can call.
 */
export function useSectionForm<T>(o: SectionFormOptions<T>) {
  const sync = useDraftSync();
  const router = useRouter();
  const saveable = o.saveable ?? true;
  const tracksDirty = o.tracksDirty ?? saveable;
  const [values, setValues] = useState<T>(o.initial);
  const [baseline, setBaseline] = useState(() => json(o.initial));
  const [loaded, setLoaded] = useState(() => json(o.initial));
  const rules = useSaveRules();
  const [state, setState] = useState<UiResult | null>(() => o.initialState ?? sync.lastResult(o.id));
  /** Booking form (Echo B-M2): the values a refusal was about, so a corrected field loses its error. */
  const [refusedValues, setRefusedValues] = useState<T | null>(null);
  const dirty = json(values) !== baseline;
  const baseRef = useRef(o.rowVersion);
  const [base, setBaseState] = useState(o.rowVersion);
  const setBase = useCallback((n: number) => {
    baseRef.current = n;
    setBaseState(n);
  }, []);
  const valuesRef = useRef(values);
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    valuesRef.current = values;
    dirtyRef.current = dirty;
  });
  const formEl = useRef<HTMLFormElement | null>(null);
  const resultEl = useRef<HTMLDivElement | null>(null);
  const bindForm = useCallback((el: HTMLFormElement | null) => {
    formEl.current = el;
  }, []);
  const resultId = `${o.id}-result`;
  const bindResult = useCallback(
    (el: HTMLDivElement | null) => {
      resultEl.current = el;
      // Error-summary links ("reason shown there") land on this box.
      if (el && !el.id) {
        el.id = resultId;
        el.tabIndex = -1;
      }
    },
    [resultId],
  );
  const prevRef = useRef<UiResult | null>(state);
  const lastSendRef = useRef<{ id: string; key: string; unknown: boolean } | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);
  /** What the last submission posted (the values at the moment it was sent). */
  const submittedRef = useRef<T | null>(null);
  const onSuccessRef = useRef(o.onSuccess);
  const sameRef = useRef(o.same);
  useEffect(() => {
    onSuccessRef.current = o.onSuccess;
    sameRef.current = o.same;
  });

  // The server sent new values (a refresh after any save): a clean form shows them.
  const incoming = json(o.initial);
  if (incoming !== loaded) {
    setLoaded(incoming);
    if (!dirty) {
      const next = o.merge ? o.merge(values, o.initial) : o.initial;
      setValues(next);
      setBaseline(json(next));
    }
  }

  // Own saves chain the base; a clean form follows the latest row version.
  useEffect(() => {
    if (!o.versionBound) return;
    let next = baseRef.current;
    if (!dirtyRef.current && o.rowVersion > next) next = o.rowVersion;
    next = advanceBase(next, sync.links);
    if (next !== baseRef.current) setBase(next);
  }, [o.versionBound, o.rowVersion, sync.links, setBase]);

  const { setDirty, unregister, register, getLinks } = sync;
  useEffect(() => {
    setDirty(o.id, tracksDirty && dirty);
  }, [setDirty, o.id, tracksDirty, dirty]);

  const [latest, setLatest] = useState<LatestOutcome>(null);
  const send = useCallback(
    async (fd: FormData, options: { refresh: boolean }): Promise<UiResult> => {
      // Own saves made a moment ago (another section, same "Save and continue") count at once.
      const expected = o.versionBound ? advanceBase(baseRef.current, sync.getLinks()) : baseRef.current;
      if (o.versionBound) fd.set('rowVersion', String(expected));
      const submitted = json(valuesRef.current);
      submittedRef.current = JSON.parse(submitted) as T;
      setLatest(null);
      // Booking reliability B1-4 (d): offline, nothing is sent; the values stay and the card says so.
      if (rules.offlineCheck && browserOffline()) {
        const offline = { ok: false, code: 'unexpected', message: BOOK_RELIABILITY_TEXT.offlineNotSaved, offline: true } as UiResult;
        prevRef.current = offline;
        setState(offline);
        setRefusedValues(null);
        sync.setLastResult(o.id, offline);
        return offline;
      }
      // One request id per submission (Echo B-H1): the database replays an id only for the same
      // payload. A form that posts a request id gets a fresh one here, set at the moment it is sent,
      // except for an exact retry after an unknown outcome (same values, same version), which keeps it.
      if (fd.has('requestId')) {
        const last = lastSendRef.current;
        const key = `${expected}|${submitted}`;
        const id = requestIdFor(last, key, newRequestId);
        fd.set('requestId', id);
        lastSendRef.current = { id, key, unknown: true };
      }
      const result = normaliseResult(await guard(o.action as (prev: never, f: FormData) => Promise<BookingActionResult<unknown>>)(prevRef.current, fd)) as UiResult;
      prevRef.current = result;
      if (lastSendRef.current) lastSendRef.current.unknown = !result.ok && result.code === 'unexpected';
      setState(result);
      setRefusedValues(result.ok ? null : (JSON.parse(submitted) as T));
      sync.setLastResult(o.id, result);
      if (result.ok) {
        const next = rowVersionOf(result);
        if (o.versionBound && next !== null) {
          setBase(next);
          sync.recordSave(expected, next);
        }
        setBaseline(submitted);
        onSuccessRef.current?.(result, {
          submitted: JSON.parse(submitted) as T,
          adopt: (patch) => {
            setValues((v) => patch(v));
            setBaseline((b) => json(patch(JSON.parse(b) as T)));
          },
        });
        if (options.refresh) {
          // B1-6: in 'server' mode the action has already re-rendered the page.
          if (!rules.serverRefreshes) router.refresh();
          sync.notifySaved({ id: o.id, section: o.section });
        }
      } else {
        // Booking form: a refusal after part of the form was saved (contact saved, trip refused)
        // carries the version that part wrote; it is this browser's own save, so the chain follows it.
        const partial = (result as { savedRowVersion?: unknown }).savedRowVersion;
        if (o.versionBound && typeof partial === 'number' && partial > expected) {
          setBase(partial);
          sync.recordSave(expected, partial);
          if (options.refresh && !rules.serverRefreshes) router.refresh();
        }
      }
      return result;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- options object is re-created per render; the fields used are stable per form
    [o.versionBound, o.action, o.id, sync, router, setBase, getLinks, rules],
  );

  const run = useCallback(
    async (fd: FormData, options: { refresh: boolean } = { refresh: true }): Promise<UiResult> => {
      // One submission of this form at a time: a second press (the section button, then the step
      // footer) waits for the first answer, so it posts the version that answer returned.
      const before = inflightRef.current;
      let release: () => void = () => {};
      inflightRef.current = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (before) await before;
      try {
        return await send(fd, options);
      } finally {
        release();
      }
    },
    [send],
  );


  const formAction = useCallback(
    async (fd: FormData) => {
      await run(fd);
    },
    [run],
  );

  const submit = useCallback(
    async (options: { refresh: boolean }) => {
      const form = formEl.current;
      if (!form) return { ok: false, code: 'unexpected', message: 'This part of the form is not on screen.' } as UiResult;
      return run(new FormData(form), options);
    },
    [run],
  );

  /**
   * Booking reliability B1-5: the form's base row version becomes the latest
   * one; typed values stay and the refusal is cleared. Nothing is sent.
   */
  const rebase = useCallback(
    (latestRowVersion: number) => {
      if (!o.versionBound || latestRowVersion <= baseRef.current) return;
      setBase(latestRowVersion);
      prevRef.current = null;
      setState(null);
      setRefusedValues(null);
      sync.setLastResult(o.id, null);
    },
    [o.versionBound, o.id, setBase, sync],
  );

  /**
   * B1-4 (c): a save whose answer was lost was found stored by a read. The
   * values and the baseline take `patch` (numbers learned), and the own-save
   * chain gets `link` only for an exact one-step move. Nothing is sent.
   */
  const markSaved = useCallback(
    (submitted: T, link: { from: number; to: number } | null, patch: (v: T) => T, result: UiResult) => {
      setValues((v) => patch(v));
      setBaseline(json(patch(submitted)));
      if (o.versionBound && link) {
        setBase(link.to);
        sync.recordSave(link.from, link.to);
      }
      prevRef.current = result;
      setState(result);
      setRefusedValues(null);
      sync.setLastResult(o.id, result);
    },
    [o.versionBound, o.id, setBase, sync],
  );

  // "Load the latest and keep my entries" (B1-5): refresh, then compare what the form was opened
  // on with the same part in the latest view. Equal: re-base (nothing is sent). Different: say so.
  const [refreshing, startRefresh] = useTransition();
  const latestSame = useRef<(() => boolean) | null>(null);
  const loadLatest = useCallback(
    (sameAsOpened?: () => boolean) => {
      latestSame.current = sameAsOpened ?? null;
      setLatest('waiting');
      startRefresh(() => router.refresh());
    },
    [router],
  );
  useEffect(() => {
    if (latest !== 'waiting') return;
    if (o.versionBound && o.rowVersion > baseRef.current) {
      const custom = latestSame.current;
      const opened = JSON.parse(baseline) as T;
      const equal = custom ? custom() : sameRef.current ? sameRef.current(opened, o.initial) : json(opened) === incoming;
      if (equal) {
        rebase(o.rowVersion);
        setLatest('rebased');
      } else setLatest('changed');
      // The refresh ended without a newer view (it failed, or nothing changed yet): stop waiting.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reacts once to the end of the router refresh
    } else if (!refreshing) setLatest(null);
  }, [latest, o.versionBound, o.rowVersion, o.initial, baseline, incoming, refreshing, rebase]);

  const focusResult = useCallback(() => {
    const box = resultEl.current?.querySelector<HTMLElement>('[role="alert"], [tabindex="-1"]') ?? resultEl.current;
    box?.focus?.();
    box?.scrollIntoView?.({ block: 'center' });
  }, []);

  useEffect(() => {
    register({ id: o.id, section: o.section, label: o.label, order: o.order, saveable, dirty: dirtyRef.current, submit, focusResult, targetId: resultId });
  });
  // Stable callbacks only: a dependency that changes with every dirty flag would unregister and re-add in a loop.
  useEffect(() => () => unregister(o.id), [unregister, o.id]);

  return {
    values,
    setValues,
    set: <K extends keyof T>(k: K, v: T[K]) => setValues((x) => ({ ...x, [k]: v })),
    reset: () => setValues(JSON.parse(baseline) as T),
    dirty,
    state,
    formAction,
    /** Posts a FormData built by the caller (buttons outside a form) and returns the answer. */
    post: run,
    bindForm,
    bindResult,
    base,
    /** The values of the last refused submission (null after a success or before any reply). */
    refusedValues,
    /** What the last submission posted (null before the first one). */
    getSubmitted: () => submittedRef.current,
    rebase,
    markSaved,
    loadLatest,
    /** Outcome of the last "Load the latest and keep my entries" (null when none or after the next save). */
    latest,
  };
}

/** The hidden row version of a version-bound form (the real value is set again on submit). */
export function BaseRowVersion({ base }: { base: number }) {
  return <input type="hidden" name="rowVersion" value={base} readOnly />;
}

/**
 * Unsaved work that "Save and continue" cannot save for you (a chosen file
 * not attached yet, a new service not added): counts for the guard, the step
 * footer and the Submit check, and stops "Save and continue" with its name.
 */
export function useTrackedDirty(id: string, section: SyncSection, label: string, order: number, dirty: boolean, focusId?: string) {
  const { register, setDirty, unregister } = useDraftSync();
  useEffect(() => {
    register({ id, section, label, order, saveable: false, dirty, submit: async () => ({ ok: false, code: 'unexpected', message: '' }) as UiResult, focusResult: () => document.getElementById(focusId ?? id)?.focus(), targetId: focusId ?? id });
  });
  useEffect(() => {
    setDirty(id, dirty);
  }, [setDirty, id, dirty]);
  useEffect(() => () => unregister(id), [unregister, id]);
}
