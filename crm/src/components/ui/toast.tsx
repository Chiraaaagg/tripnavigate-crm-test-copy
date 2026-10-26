'use client';

import { X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { STATUS_ICONS } from './badge';
import { cn, focusRing } from './cn';

/**
 * Toasts with our own live regions (no sonner, no Radix Toast viewport: both
 * add style tags or server-rendered style attributes the production Content
 * Security Policy blocks).
 *
 * - Two regions exist from the first render, empty, so screen readers pick up
 *   later insertions: role=status (polite) for success/info/neutral and
 *   role=alert (assertive) for warning/danger.
 * - success/info/neutral close by themselves after 6 seconds (paused while
 *   hovered or focused). warning/danger stay until dismissed: staff must be
 *   able to read a refusal and its repair text.
 * - Never the only place an outcome is shown; the page itself shows it too.
 */

export type ToastTone = 'success' | 'info' | 'neutral' | 'warning' | 'danger';

export interface ToastInput {
  tone?: ToastTone;
  title: string;
  description?: string;
}

interface ToastItem extends Required<Pick<ToastInput, 'tone' | 'title'>> {
  id: number;
  description?: string;
}

interface ToastApi {
  toast: (input: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const AUTO_CLOSE_MS = 6000;
const URGENT: ReadonlySet<ToastTone> = new Set(['warning', 'danger']);

const toneClass: Record<ToastTone, string> = {
  success: 'border-status-success-line [&_[data-icon]]:text-status-success',
  info: 'border-status-info-line [&_[data-icon]]:text-status-info',
  neutral: 'border-line-strong [&_[data-icon]]:text-status-neutral',
  warning: 'border-status-warning-line [&_[data-icon]]:text-status-warning',
  danger: 'border-status-danger-line [&_[data-icon]]:text-status-danger',
};

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>.');
  return api;
}

export function ToastProvider({ children, regionLabel = 'Notifications' }: { children: ReactNode; regionLabel?: string }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((current) => current.filter((t) => t.id !== id)), []);
  const toast = useCallback((input: ToastInput) => {
    const id = nextId.current++;
    const item: ToastItem = { id, tone: input.tone ?? 'success', title: input.title, description: input.description };
    // Newest last (reading order); keep at most five on screen.
    setItems((current) => [...current, item].slice(-5));
    return id;
  }, []);
  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  const polite = items.filter((t) => !URGENT.has(t.tone));
  const urgent = items.filter((t) => URGENT.has(t.tone));

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section
        aria-label={regionLabel}
        className="pointer-events-none fixed right-0 bottom-0 z-[60] flex w-full flex-col items-end gap-2 p-4 sm:w-[26rem]"
      >
        <div role="alert" aria-live="assertive" aria-atomic="false" className="flex w-full flex-col gap-2">
          {urgent.map((t) => (
            <ToastCard key={t.id} item={t} onDismiss={dismiss} />
          ))}
        </div>
        <div role="status" aria-live="polite" aria-atomic="false" className="flex w-full flex-col gap-2">
          {polite.map((t) => (
            <ToastCard key={t.id} item={t} onDismiss={dismiss} />
          ))}
        </div>
      </section>
    </ToastContext.Provider>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const autoClose = !URGENT.has(item.tone);

  useEffect(() => {
    if (!autoClose || paused) return;
    const timer = window.setTimeout(() => onDismiss(item.id), AUTO_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [autoClose, paused, item.id, onDismiss]);

  const Icon = STATUS_ICONS[item.tone];
  return (
    <div
      className={cn(
        'pointer-events-auto flex w-full items-start gap-3 rounded-card border bg-card px-4 py-3 font-sans text-base text-copy shadow-raised',
        'animate-ui-pop-in motion-reduce:animate-none',
        toneClass[item.tone],
      )}
      data-tone={item.tone}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon aria-hidden="true" data-icon="" className="mt-0.5 size-4.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="m-0 font-semibold text-ink">{item.title}</p>
        {item.description ? <p className="m-0 mt-0.5 text-sm text-quiet">{item.description}</p> : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        aria-label={`Dismiss: ${item.title}`}
        className={cn(
          '-mt-1 -mr-2 grid size-8 shrink-0 cursor-pointer place-items-center rounded-control border-0 bg-transparent p-0 text-quiet hover:bg-wash hover:text-ink',
          focusRing,
        )}
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
