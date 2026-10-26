import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';

/*
 * Small layout parts of the booking form, matching the approved preview
 * (section card with icon, title, count and one action; quiet inline empty
 * line; row card). Tokens only; no global CSS and no style attributes.
 */

export function SectionCard({
  id,
  title,
  icon: Icon,
  count,
  action,
  status,
  children,
  className,
}: {
  /** Prefix for the heading id (`{id}-heading`) and the section anchor. */
  id: string;
  title: ReactNode;
  icon: LucideIcon;
  count?: number;
  action?: ReactNode;
  /** Short state in words beside the title (never colour alone). */
  status?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('min-w-0 scroll-mt-6', className)}>
      <section id={id} aria-labelledby={`${id}-heading`} data-section={id}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 max-sm:px-4 max-sm:py-3.5">
          <h3 id={`${id}-heading`} tabIndex={-1} className="m-0 flex min-w-0 flex-wrap items-center gap-2.25 text-lg font-semibold text-ink outline-none">
            <Icon aria-hidden="true" className="size-4.5 shrink-0 text-quiet" />
            <span className="min-w-0 wrap-anywhere">{title}</span>
            {count !== undefined ? <CountPill n={count} /> : null}
            {status}
          </h3>
          {action}
        </div>
        {children}
      </section>
    </Card>
  );
}

export function CountPill({ n }: { n: number }) {
  return (
    <span className="rounded-full bg-wash px-1.75 py-0.5 text-sm font-medium text-quiet tabular-nums">
      {n}
      <span className="sr-only"> {n === 1 ? 'item' : 'items'}</span>
    </span>
  );
}

export function SectionBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('p-5 max-sm:p-4', className)}>{children}</div>;
}

/** "No hotels added." with one action, inside a section card. */
export function EmptyInline({ text, action }: { text: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-21 flex-wrap items-center justify-between gap-4.5 p-5 text-quiet max-sm:p-4">
      <span>{text}</span>
      {action}
    </div>
  );
}

export function InlineNote({ icon: Icon, children, className, role }: { icon?: LucideIcon; children: ReactNode; className?: string; role?: 'status' }) {
  return (
    <p role={role} className={cn('m-0 flex items-center gap-1.5 text-sm text-quiet', className)}>
      {Icon ? <Icon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** A saved service or passenger line: content on the left, small actions on the right. */
export function RowCard({ id, children, actions, className }: { id?: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div id={id} tabIndex={id ? -1 : undefined} className={cn('outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-strong', 'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3.5 border-b border-line px-5 py-4 last:border-b-0 max-sm:px-4 max-sm:py-3.5', className)}>
      <div className="min-w-0">{children}</div>
      {actions ? <div className="flex gap-1">{actions}</div> : null}
    </div>
  );
}

export function RowTitle({ children }: { children: ReactNode }) {
  return <div className="mb-0.75 font-semibold wrap-anywhere text-ink">{children}</div>;
}

export function RowMeta({ children }: { children: ReactNode }) {
  return <div className="mt-1.25 flex flex-wrap gap-x-3 gap-y-1 text-sm text-quiet">{children}</div>;
}

/** "Our cost ₹1,50,000" under a service row. */
export function RowAmount({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-3 text-sm text-quiet">
      {label}
      <strong className="mt-0.5 block text-base font-semibold text-copy tabular-nums">{children}</strong>
    </div>
  );
}

/** A closed group inside a form ("Customer type & market", "More details", "Billing address"). */
export function Disclosure({ summary, children, className, defaultOpen = false, id }: { summary: ReactNode; children: ReactNode; className?: string; defaultOpen?: boolean; id?: string }) {
  return (
    <details id={id} open={defaultOpen || undefined} className={cn('group/disc mt-4.5 border-t border-line pt-3.5', className)}>
      <summary className={cn('w-fit cursor-pointer rounded-chip text-sm font-medium text-brand-strong group-open/disc:mb-3.5', focusRing)}>{summary}</summary>
      {children}
    </details>
  );
}
