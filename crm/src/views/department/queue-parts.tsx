import { SearchX } from 'lucide-react';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { StateBlock } from '@/components/ui/state-block';

/*
 * Shared parts of the Purchase, Flight and Visa work queues (R3, design plan
 * 1.2). Kept apart from task-frame.tsx, which the frozen Flight and Visa task
 * pages import, so these list parts never join the frozen forms' imports.
 * The pure helpers (search, sort, addresses) are in queue-show.ts.
 */

/** R3: a search or chip left no row on this tab: say so and offer the way back (the tab and sort stay). */
export function QueueNothingMatches({ clearHref, card = false }: { clearHref: string; card?: boolean }) {
  return (
    <StateBlock
      kind="empty"
      card={card}
      icon={SearchX}
      headingLevel={2}
      title="Nothing matches"
      text="No task on this tab matches the search or filter. Clear them to see every task on this tab."
      action={
        <Link href={clearHref} className={buttonVariants({ variant: 'secondary' })}>
          Clear search and filter
        </Link>
      }
    />
  );
}

/** R3: the one row button (design plan 1.2): a link to the record named after it, full width on phones. */
export function QueueRowButton({ href, label, context, primary = false }: { href: string; label: string; context: string; primary?: boolean }) {
  return (
    <Link href={href} className={cn(buttonVariants({ variant: primary ? 'primary' : 'secondary', size: 'sm' }), 'min-h-9 max-sm:w-full')}>
      {label}
      <span className="sr-only"> {context}</span>
    </Link>
  );
}
