import { Circle, CircleCheck } from 'lucide-react';
import { cn, focusRing } from './cn';

/*
 * Progress bar plus a checklist that jumps to each item (Book now v2, change
 * 9: "Before you submit"). Adapted from 21st.dev sean0205 "Multi-Step
 * Progress" (c-progress-7, demo 29469): "x of N done", a bar and a list with
 * circle / circle-check icons. The bar is a plain progressbar (no new Radix
 * part); every item says done or not done in words, never colour alone, and
 * is a button that moves to the place to fix it.
 */

/** Bar widths in 5% steps, written out so the class names exist (no style attribute: the CSP blocks them). */
const WIDTH = [
  'w-0', 'w-[5%]', 'w-[10%]', 'w-[15%]', 'w-[20%]', 'w-[25%]', 'w-[30%]', 'w-[35%]', 'w-[40%]', 'w-[45%]', 'w-[50%]',
  'w-[55%]', 'w-[60%]', 'w-[65%]', 'w-[70%]', 'w-[75%]', 'w-[80%]', 'w-[85%]', 'w-[90%]', 'w-[95%]', 'w-full',
] as const;

export interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
  /** Why it is not done yet (shown after the label). */
  why?: string | null;
  onSelect: () => void;
}

export function ProgressChecklist({ id, title, items, className }: { id?: string; title: string; items: readonly ChecklistItem[]; className?: string }) {
  const done = items.filter((i) => i.done).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  const headingId = `${id ?? 'progress-checklist'}-heading`;
  return (
    <section id={id} aria-labelledby={headingId} className={cn('flex flex-col', className)} data-slot="progress-checklist">
      <div className="flex items-baseline justify-between gap-2.5">
        <h3 id={headingId} tabIndex={-1} className="m-0 text-md font-semibold text-ink outline-none">
          {title}
        </h3>
        <span className="text-sm text-quiet">
          {done} of {items.length} done
        </span>
      </div>
      <div role="progressbar" aria-labelledby={headingId} aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={done} aria-valuetext={`${done} of ${items.length} done`} className="mt-2.5 mb-3.5 h-2 overflow-hidden rounded-full bg-wash">
        <div className={cn('h-full rounded-full bg-brand transition-[width] duration-(--ui-duration-base) motion-reduce:transition-none', WIDTH[Math.round(pct / 5)])} />
      </div>
      <ul className="m-0 grid list-none grid-cols-1 gap-x-4.5 gap-y-1.5 p-0 sm:grid-cols-2">
        {items.map((it) => (
          <li key={it.key} className="m-0">
            <button type="button" onClick={it.onSelect} className={cn('group flex w-full cursor-pointer items-start gap-2 border-0 bg-transparent py-1.25 text-left text-sm text-copy', focusRing)}>
              {it.done ? <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-success" /> : <Circle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-quiet" />}
              <span className="min-w-0">
                <span className="font-semibold group-hover:underline">{it.label}</span>
                <span className="sr-only">{it.done ? ': done' : ': not done'}</span>
                {!it.done && it.why ? <span className="text-quiet"> · {it.why}</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
