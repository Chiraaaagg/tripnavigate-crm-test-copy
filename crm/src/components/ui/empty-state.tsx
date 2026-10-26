import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './cn';

/**
 * Empty state: icon, title, one plain sentence and at most one action.
 * Say why it is empty and what to do next, honestly.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  headingLevel = 3,
  className,
}: {
  icon: LucideIcon;
  title: ReactNode;
  description: ReactNode;
  action?: ReactNode;
  headingLevel?: 2 | 3 | 4;
  className?: string;
}) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div className={cn('flex flex-col items-center px-6 py-10 text-center font-sans', className)} data-slot="empty-state">
      <span className="mb-3 grid size-11 place-items-center rounded-card bg-brand-tint text-brand">
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <Heading className="m-0 text-lg leading-6 font-semibold text-ink">{title}</Heading>
      <p className="m-0 mt-1.5 max-w-[42ch] text-base text-quiet">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
