'use client';

import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FORM_STEPS, type FormStep } from './types';

/*
 * Client-side step switching for the booking form (contract §2.1). All three
 * steps stay mounted; the inactive ones are only `hidden`, so typed values,
 * unsaved flags and the leave-page guard survive a step change. The address
 * follows with history.pushState (Next 16 integrates it with the router, see
 * node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md),
 * so reload and Back show the right step. Nothing is stored in the browser.
 *
 * Links on the page that point at a field of another step, into a closed
 * <details>, or at another step's address (error summaries, checklist links,
 * "Edit" in the final review) switch the step here, open the closed groups and
 * move focus, instead of loading a new page.
 */

interface StepContext {
  step: FormStep;
  go: (step: FormStep, focus?: { fieldId?: string | null } | false) => void;
  /** Shows the step holding `id`, opens closed groups around it, then focuses it. False when `id` is not on the page. */
  focusField: (id: string) => boolean;
  hrefs: Record<FormStep, string>;
}

const Ctx = createContext<StepContext | null>(null);

export function useFormStep(): StepContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useFormStep must be used inside <FormStepProvider>.');
  return ctx;
}

/** Same as useFormStep, but null outside the booking form (shared b11 parts). */
export function useOptionalFormStep(): StepContext | null {
  return useContext(Ctx);
}

const HEADING_ID: Record<FormStep, string> = {
  travellers: 'bf-step-travellers-heading',
  stay: 'bf-step-stay-heading',
  finish: 'bf-step-finish-heading',
};
export const stepHeadingId = (step: FormStep) => HEADING_ID[step];

function afterPaint(run: () => void) {
  // Two frames: React commits the step change, then the browser lays it out.
  requestAnimationFrame(() => requestAnimationFrame(run));
}

function openAround(el: HTMLElement) {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    if (node instanceof HTMLDetailsElement && !node.open) node.open = true;
    node = node.parentElement;
  }
}

function stepOf(el: Element): FormStep | null {
  const holder = el.closest<HTMLElement>('[data-form-step]');
  const s = holder?.dataset.formStep;
  return s && (FORM_STEPS as readonly string[]).includes(s) ? (s as FormStep) : null;
}

function pathOf(href: string): string | null {
  try {
    return new URL(href, window.location.href).pathname;
  } catch {
    return null;
  }
}

export function FormStepProvider({ initialStep, hrefs, children }: { initialStep: FormStep; hrefs: Record<FormStep, string>; children: ReactNode }) {
  const [step, setStep] = useState<FormStep>(initialStep);
  const stepRef = useRef(step);
  useEffect(() => {
    stepRef.current = step;
  });

  const stepForPath = useCallback(
    (path: string | null): FormStep | null => {
      if (!path) return null;
      for (const s of FORM_STEPS) if (pathOf(hrefs[s]) === path) return s;
      return null;
    },
    [hrefs],
  );

  const focusEl = useCallback((el: HTMLElement) => {
    openAround(el);
    afterPaint(() => {
      openAround(el);
      el.scrollIntoView({ block: 'center' });
      if (!el.matches('input, select, textarea, button, a[href], summary, [tabindex]')) el.tabIndex = -1;
      el.focus({ preventScroll: true });
    });
  }, []);

  const go = useCallback(
    (next: FormStep, focus?: { fieldId?: string | null } | false) => {
      if (next !== stepRef.current) {
        setStep(next);
        try {
          window.history.pushState(null, '', hrefs[next]);
        } catch {
          // The address is a convenience; the step still changes.
        }
      }
      if (focus === false) return;
      afterPaint(() => {
        const el = (focus?.fieldId ? document.getElementById(focus.fieldId) : null) ?? document.getElementById(HEADING_ID[next]);
        if (!el) return;
        if (focus?.fieldId) {
          focusEl(el);
          return;
        }
        window.scrollTo({ top: 0 });
        el.focus({ preventScroll: true });
      });
    },
    [hrefs, focusEl],
  );

  const focusField = useCallback(
    (id: string) => {
      // A section address (#customer, #payment) focuses that section's heading when it has one;
      // an anchor may name its focus target (data-focus-target), e.g. bf-passengers → the passengers heading.
      const raw = document.getElementById(`${id}-heading`) ?? document.getElementById(id);
      if (!raw) return false;
      const alias = raw.dataset.focusTarget ? document.getElementById(raw.dataset.focusTarget) : null;
      const el = alias ?? raw;
      const s = stepOf(el);
      if (s && s !== stepRef.current) {
        go(s, { fieldId: id });
        return true;
      }
      focusEl(el);
      return true;
    },
    [go, focusEl],
  );

  // Arriving with #field or ?at=field (old links, readiness links from other pages): open and focus it once.
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current) return;
    arrived.current = true;
    const id = window.location.hash ? decodeURIComponent(window.location.hash.slice(1)) : new URLSearchParams(window.location.search).get('at');
    if (id && document.getElementById(id)) focusField(id);
  }, [focusField]);

  // The screen lives in the booking layout (Echo B-H2), so a refresh never remounts it; when the
  // address changes to another step (pushState, Back, a link rendered by the router) the step follows.
  const pathname = usePathname();
  const [seenPath, setSeenPath] = useState(pathname);
  if (pathname !== seenPath) {
    setSeenPath(pathname);
    const s = stepForPath(pathname);
    if (s && s !== step) setStep(s);
  }

  // Back and Forward between step addresses.
  useEffect(() => {
    const onPop = () => {
      const s = stepForPath(window.location.pathname);
      if (s) setStep(s);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [stepForPath]);

  // In-page links: #field, another step's address (with ?at= and #field).
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.('a[href]');
      if (!(link instanceof HTMLAnchorElement) || link.target === '_blank' || link.hasAttribute('download')) return;
      const raw = link.getAttribute('href') ?? '';
      let url: URL;
      try {
        url = new URL(raw, window.location.href);
      } catch {
        return;
      }
      const hashId = url.hash ? decodeURIComponent(url.hash.slice(1)) : null;
      const sameDoc = url.pathname === window.location.pathname && raw.startsWith('#');
      const targetStep = sameDoc ? null : stepForPath(url.pathname);
      if (!sameDoc && !targetStep) return;
      const at = url.searchParams.get('at');
      const id = hashId || at;
      if (id && document.getElementById(id)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        focusField(id);
        return;
      }
      if (targetStep) {
        e.preventDefault();
        e.stopImmediatePropagation();
        go(targetStep);
      }
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [stepForPath, focusField, go]);

  const value = useMemo<StepContext>(() => ({ step, go, focusField, hrefs }), [step, go, focusField, hrefs]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
