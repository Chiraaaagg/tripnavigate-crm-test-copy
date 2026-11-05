import { Circle, CircleAlert, CircleCheck, TriangleAlert, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { cn, focusRing } from './cn';

/*
 * Step list for a stepped form (B1.1 Book now). Each step is its own page, so
 * the steps are links (the browser's back button works and nothing needs
 * script). Idea from 21st.dev vertical titled steppers (originui 774,
 * sean0205 29815): numbered titles with a marker; nothing copied. Below the
 * lg breakpoint the list folds into "Step n of m" plus a native disclosure,
 * so six steps never cause sideways scrolling at 390 px.
 */

export type StepStatus = 'complete' | 'needs_input' | 'warnings' | 'not_started';

export interface StepItem {
  key: string;
  label: string;
  href: string;
  status: StepStatus;
  current?: boolean;
}

const MARKER: Record<StepStatus, { icon: LucideIcon; className: string; text: string }> = {
  complete: { icon: CircleCheck, className: 'text-status-success', text: 'complete' },
  needs_input: { icon: CircleAlert, className: 'text-status-danger', text: 'needs input' },
  warnings: { icon: TriangleAlert, className: 'text-status-warning', text: 'warnings only' },
  not_started: { icon: Circle, className: 'text-faint', text: 'not checked yet' },
};

function StepLinks({ steps }: { steps: StepItem[] }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-1 p-0">
      {steps.map((step, index) => {
        const marker = MARKER[step.status];
        const Icon = marker.icon;
        return (
          <li key={step.key} className="m-0">
            <Link
              href={step.href}
              aria-current={step.current ? 'step' : undefined}
              className={cn(
                'flex min-h-11 items-center gap-2.5 rounded-control border border-transparent px-3 py-2 text-base text-copy no-underline',
                'hover:bg-wash hover:text-ink',
                step.current && 'border-brand-line bg-brand-tint font-semibold text-brand-deep hover:bg-brand-tint',
                focusRing,
              )}
            >
              <Icon aria-hidden="true" className={cn('size-4.5 shrink-0', marker.className)} />
              <span className="min-w-0 flex-1">
                <span className="tabular-nums">{index + 1}.</span> {step.label}
                <span className="sr-only"> ({marker.text})</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

/** Step list: a sticky column on wide screens, a "Step n of m" disclosure on narrow ones. */
export function StepNav({ label, steps, className }: { label: string; steps: StepItem[]; className?: string }) {
  const currentIndex = Math.max(
    0,
    steps.findIndex((s) => s.current),
  );
  const current = steps[currentIndex];
  const open = steps.filter((s) => s.status === 'needs_input').length;
  return (
    <div className={cn('font-sans', className)} data-slot="stepper">
      <nav aria-label={label} className="hidden lg:sticky lg:top-20 lg:block">
        <StepLinks steps={steps} />
      </nav>
      <nav aria-label={label} className="lg:hidden">
        <details className="rounded-card border border-line bg-card shadow-card">
          <summary
            className={cn(
              'flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-card px-4 py-2.5 text-base text-ink [&::-webkit-details-marker]:hidden',
              focusRing,
            )}
          >
            <span className="min-w-0">
              <span className="font-semibold">
                Step {currentIndex + 1} of {steps.length}
              </span>
              {current ? <span className="text-copy">: {current.label}</span> : null}
            </span>
            <span className="shrink-0 text-sm text-brand-strong underline underline-offset-4">
              All steps{open > 0 ? ` · ${open} need input` : ''}
            </span>
          </summary>
          <div className="border-t border-line px-2 py-2">
            <StepLinks steps={steps} />
          </div>
        </details>
      </nav>
    </div>
  );
}
