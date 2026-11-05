'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BookingActionResult, BookSection } from '@/modules/fulfilment/contracts';
import type { QuotationSection } from '@/modules/quotations/contracts';
import { guard } from '../booking-forms';
import { advanceBase } from './book-fields';
import { normaliseResult } from './result';
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
  onSuccess?: (result: UiResult) => void;
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

  // The server sent new values (a refresh after any save): a clean form shows them.
  const incoming = json(o.initial);
  if (incoming !== loaded) {
    setLoaded(incoming);
    if (!dirty) {
      setValues(o.initial);
      setBaseline(incoming);
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

  const send = useCallback(
    async (fd: FormData, options: { refresh: boolean }): Promise<UiResult> => {
      // Own saves made a moment ago (another section, same "Save and continue") count at once.
      const expected = o.versionBound ? advanceBase(baseRef.current, sync.getLinks()) : baseRef.current;
      if (o.versionBound) fd.set('rowVersion', String(expected));
      const submitted = json(valuesRef.current);
      // One request id per submission (Echo B-H1): the database replays an id only for the same
      // payload. A form that posts a request id gets a fresh one here, set at the moment it is sent,
      // except for an exact retry after an unknown outcome (same values, same version), which keeps it.
      if (fd.has('requestId')) {
        const last = lastSendRef.current;
        const key = `${expected}|${submitted}`;
        const id = last && last.unknown && last.key === key ? last.id : newRequestId();
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
        o.onSuccess?.(result);
        if (options.refresh) {
          router.refresh();
          sync.notifySaved({ id: o.id, section: o.section });
        }
      } else {
        // Booking form: a refusal after part of the form was saved (contact saved, trip refused)
        // carries the version that part wrote; it is this browser's own save, so the chain follows it.
        const partial = (result as { savedRowVersion?: unknown }).savedRowVersion;
        if (o.versionBound && typeof partial === 'number' && partial > expected) {
          setBase(partial);
          sync.recordSave(expected, partial);
          if (options.refresh) router.refresh();
        }
      }
      return result;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- options object is re-created per render; the fields used are stable per form
    [o.versionBound, o.action, o.id, sync, router, setBase, getLinks],
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
