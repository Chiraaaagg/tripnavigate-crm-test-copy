'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/*
 * The booking form's short confirmations ("Flight saved.", "Filled from the
 * flight and hotel. Check and change if needed."), exactly as the
 * owner-approved prototype shows them: one small box above the footer for
 * about three seconds. The live region exists from the first render so
 * screen readers hear later messages. Never the only place an outcome is
 * shown: refusals stay on the card or in the drawer.
 */

const SHOW_MS = 3200;

const Ctx = createContext<(text: string) => void>(() => {});

export function useFormToast() {
  return useContext(Ctx);
}

export function FormToastProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((t: string) => {
    setText(t);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(''), SHOW_MS);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const value = useMemo(() => show, [show]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-22 left-1/2 z-95 w-max max-w-[calc(100vw-1.5rem)] -translate-x-1/2">
        {text ? <div className="rounded-control border border-line-strong bg-card px-3.5 py-2.5 text-sm text-copy shadow-raised">{text}</div> : null}
      </div>
    </Ctx.Provider>
  );
}
