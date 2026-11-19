import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { cn, focusRing } from '@/components/ui/cn';

/*
 * R2: customer dues, refunds, customer documents and customer messages moved
 * off Services and tasks to their own tabs. The CRM's own links now name the
 * new tab, but older saved links (bookmarks, notices already sent as push
 * messages) still say `?tab=services#dues` and the like; the browser cannot
 * send the "#…" part to the server, so this short
 * list keeps those anchors on Services and tasks and says where each card is
 * now. Rendered only for people who may read customer money, and only with
 * links to tabs they may open.
 */

export interface MovedCardLink {
  /** The old anchor on Services and tasks. */
  anchor: 'dues' | 'refunds' | 'customer-documents' | 'customer-messages';
  label: string;
  href: string;
  tabLabel: string;
}

export function MovedCardsNote({ links }: { links: MovedCardLink[] }) {
  if (links.length === 0) return null;
  return (
    <aside aria-labelledby="deal-moved-heading" className="rounded-control border border-line bg-canvas px-3.5 py-2.5 font-sans text-sm text-copy" data-slot="deal-moved-cards">
      <h2 id="deal-moved-heading" className="m-0 text-sm font-semibold text-ink">
        Moved to their own tabs
      </h2>
      <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
        {links.map((l) => (
          <li key={l.anchor} id={l.anchor} className="m-0 scroll-mt-18">
            <Link href={l.href} className={cn('inline-flex items-center gap-1 rounded-chip font-semibold text-brand-strong underline decoration-1 underline-offset-4 hover:text-brand-deep', focusRing)}>
              {l.label}: {l.tabLabel}
              <ArrowRight aria-hidden="true" className="size-3.5" />
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  );
}
