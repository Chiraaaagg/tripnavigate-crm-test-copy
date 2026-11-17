import type { Metadata } from 'next';
import { SectionTabs } from '@/components/ui/section-tabs';
import { isAccountsQueueCursor } from '@/modules/finance/dto';
import { lookupAccountsDeal, loadAccountsQueue } from '@/modules/finance/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { AccountsQueueView, FinanceNoAccessView, FinanceUnavailableView, type LookupOutcome, parseQueueFilter } from '@/views/finance-views';
import { financeRead } from './finance-page-support';
import { accountsSectionViewer } from './section-viewer';

// DA-276 / DA-274: the queue is "To check" (default filter Booking reviews; every ?filter= value kept).
// R4: one search (?ref=, exact reference), the filters as chips, one row button per deal.
export const metadata: Metadata = { title: 'To check' };

export default async function AccountsQueuePage({ searchParams }: { searchParams: Promise<{ filter?: string | string[]; ref?: string | string[]; after?: string | string[] }> }) {
  const staff = await requireStaff();
  const { filter: rawFilter, ref: rawRef, after: rawAfter } = await searchParams;
  const filter = parseQueueFilter(rawFilter);
  // Bounded page (Milestone A §3). An invalid cursor means the first page, never an error.
  const firstAfter = Array.isArray(rawAfter) ? rawAfter[0] : rawAfter;
  const after = isAccountsQueueCursor(firstAfter) ? firstAfter : null;
  const reference = (Array.isArray(rawRef) ? rawRef[0] : rawRef)?.trim().slice(0, 60) ?? '';

  const queue = await financeRead(() => loadAccountsQueue(staff, filter, after));
  if (!queue.ok) {
    if (queue.code === 'not_authorized') return <FinanceNoAccessView area="accounts" />;
    return <FinanceUnavailableView code={queue.code} title="To check" />;
  }

  let lookup: LookupOutcome = null;
  if (reference) {
    // Exact reference within the viewer's finance-enabled entities; the database audits the lookup.
    const found = await financeRead(() => lookupAccountsDeal(staff, reference));
    lookup = { reference, result: found.ok ? (found.value ?? null) : null };
  }
  // D5: the To check section tabs under the header; the same flags as the menu (the frame's cached read).
  const viewer = await accountsSectionViewer(staff);
  return (
    <AccountsQueueView
      sectionTabs={<SectionTabs section="to-check" currentHref="/app/accounts" viewer={viewer} />}
      items={queue.value.items}
      filter={filter}
      lookup={lookup}
      paging={{ totalCount: queue.value.totalCount, hasMore: queue.value.hasMore, nextAfter: queue.value.nextAfter, laterPage: after !== null }}
    />
  );
}
