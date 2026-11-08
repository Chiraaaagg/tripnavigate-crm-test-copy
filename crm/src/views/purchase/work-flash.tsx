'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Notice } from '@/components/ui/notice';

/*
 * Page-level result line for the Work tab. A drawer whose trigger changes
 * after a save (for example "Send booking request" becoming "Send booking
 * request again") unmounts with its own success message; it reports the
 * message here first, so the result stays on the page and is announced.
 * Focus moves to the message, because the drawer that had focus is gone.
 */

const FlashContext = createContext<((message: string) => void) | null>(null);

export function WorkFlashProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<{ text: string; n: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) ref.current?.focus();
  }, [message]);
  return (
    <FlashContext.Provider value={(text) => setMessage((m) => ({ text, n: (m?.n ?? 0) + 1 }))}>
      <div role="status" aria-live="polite" ref={ref} tabIndex={-1} className="outline-none empty:hidden" data-slot="work-flash">
        {message ? (
          <Notice tone="success" role="none" key={message.n}>
            <p>
              <strong>Done: </strong>
              {message.text}
            </p>
          </Notice>
        ) : null}
      </div>
      {children}
    </FlashContext.Provider>
  );
}

/** Report a confirmed success to the page (no-op outside the Work tab, e.g. in a single-component test). */
export function useWorkFlash(): (message: string) => void {
  return useContext(FlashContext) ?? (() => undefined);
}
