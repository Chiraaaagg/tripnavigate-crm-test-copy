'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useDraftSync } from './draft-sync';

/*
 * Batch 2: which parts of a page are open (Book now step 3 sections, the
 * quotation editor's six parts, hotel cards use their own state). A closed
 * part stays mounted (its body is only `hidden`), so typed values, the
 * unsaved flag and the leave-page guard survive. A part with unsaved changes
 * never closes. Links into a closed part (error summary, checklist, #field,
 * ?at=field) open it first, then move focus to the field or the part heading.
 *
 * Parts are marked in the DOM with `data-part="{key}"`; the heading of a part
 * has the id `{key}-heading` (as the existing section anchors).
 */

interface OpenPartsContext {
  collapsible: boolean;
  isOpen: (key: string) => boolean;
  /** Opens the part, then focuses `fieldId` (or the part heading) after the next paint. */
  open: (key: string, focus?: { fieldId?: string | null; scroll?: boolean } | false) => void;
  /** Closes or opens. Refused (returns false) when the part has unsaved changes. */
  toggle: (key: string) => boolean;
  /** The part has a form with unsaved changes. */
  isDirty: (key: string) => boolean;
  /** The part opened last (one `aria-current` in a part list); null when none. */
  current: string | null;
}

const Ctx = createContext<OpenPartsContext | null>(null);

const ALWAYS_OPEN: OpenPartsContext = {
  collapsible: false,
  isOpen: () => true,
  open: (key, focus) => focusAfterPaint(key, focus),
  toggle: () => false,
  isDirty: () => false,
  current: null,
};

export function useOpenParts(): OpenPartsContext {
  return useContext(Ctx) ?? ALWAYS_OPEN;
}

function focusAfterPaint(key: string, focus?: { fieldId?: string | null; scroll?: boolean } | false) {
  if (focus === false) return;
  const run = () => {
    const el = (focus?.fieldId ? document.getElementById(focus.fieldId) : null) ?? document.getElementById(`${key}-heading`);
    if (!el) return;
    if (focus?.scroll !== false) el.scrollIntoView({ block: focus?.fieldId ? 'center' : 'start' });
    el.focus({ preventScroll: true });
  };
  // Two frames: React commits the open state, then the browser lays the body out.
  requestAnimationFrame(() => requestAnimationFrame(run));
}

export function OpenPartsProvider({ initialOpen, initialCurrent = null, collapsible = true, children }: { initialOpen: readonly string[]; initialCurrent?: string | null; collapsible?: boolean; children: ReactNode }) {
  const sync = useDraftSync();
  const [openSet, setOpenSet] = useState<ReadonlySet<string>>(() => new Set(initialOpen));
  const [current, setCurrent] = useState<string | null>(initialCurrent);
  const dirtyRef = useRef(sync.dirtyEntries);
  useEffect(() => {
    dirtyRef.current = sync.dirtyEntries;
  });
  const isDirty = useCallback((key: string) => sync.dirtyEntries().some((e) => e.section === key), [sync]);
  const open = useCallback((key: string, focus?: { fieldId?: string | null; scroll?: boolean } | false) => {
    setOpenSet((s) => (s.has(key) ? s : new Set([...s, key])));
    setCurrent(key);
    focusAfterPaint(key, focus);
  }, []);
  const toggle = useCallback(
    (key: string) => {
      let changed = true;
      setOpenSet((s) => {
        const n = new Set(s);
        if (n.has(key)) {
          if (dirtyRef.current().some((e) => e.section === key)) {
            changed = false;
            return s;
          }
          n.delete(key);
          setCurrent((c) => (c === key ? null : c));
        } else {
          n.add(key);
          setCurrent(key);
        }
        return n;
      });
      return changed;
    },
    [],
  );
  const value = useMemo<OpenPartsContext>(() => ({ collapsible, isOpen: (k) => !collapsible || openSet.has(k), open, toggle, isDirty, current }), [collapsible, openSet, open, toggle, isDirty, current]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Focus an element of the page by id, opening the part that holds it first.
 * Used by the error summary links, checklist links and `#id` / `?at=id`
 * addresses. Returns false when the id is not on this page.
 */
export function useFocusTarget() {
  const parts = useOpenParts();
  return useCallback(
    (id: string): boolean => {
      const el = document.getElementById(id);
      if (!el) return false;
      const holder = el.closest<HTMLElement>('[data-part]');
      const key = holder?.dataset.part;
      // The target is the part itself (its section element) → focus its heading.
      const focusable = el.matches('input, select, textarea, button, a[href], [tabindex]');
      if (key && (holder === el || id === `${key}-heading` || !focusable)) {
        parts.open(key);
        return true;
      }
      if (key) {
        parts.open(key, { fieldId: id });
        return true;
      }
      focusAfterPaint('', { fieldId: id });
      return true;
    },
    [parts],
  );
}
