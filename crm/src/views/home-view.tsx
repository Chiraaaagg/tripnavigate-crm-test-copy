import {
  Briefcase,
  ClipboardCheck,
  ClipboardList,
  FileCheck2,
  FilePen,
  Hourglass,
  Info,
  ListChecks,
  Plane,
  Receipt,
  RefreshCw,
  Stamp,
  Sparkles,
  Undo2,
  FileSpreadsheet,
  HandCoins,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { MyWorkCounts } from '@/modules/fulfilment/contracts';
import { HOME_QUOTATION_ROW_FILTER, type HomeQuotationRowKey } from '@/modules/quotations/work-contract';
import type { MembershipLine } from './staff-views';

const numberFormat = new Intl.NumberFormat('en-IN');

/** Which roles' counts apply to the viewer (from shell-permissions.ts homeWorkRoles). */
export interface HomeRoles {
  bookings: boolean;
  /** Holds the Manager role: the Sales counts then also cover the branch's deals (the database decides). */
  branchManager: boolean;
  purchase: boolean;
  flight: boolean;
  visa: boolean;
  accounts: boolean;
  /**
   * Batch 3 (FP-081): the person may see the Quotations menu item (canSeeQuotations). Shows the
   * rows "Quotation drafts to finish" and "Accepted quotations to link". Optional; absent = hidden.
   */
  quotations?: boolean;
}

/** No role applies (start from this when building HomeRoles by hand, e.g. in the preview gallery). */
export const NO_HOME_ROLES: HomeRoles = { bookings: false, branchManager: false, purchase: false, flight: false, visa: false, accounts: false };

/** One "What needs you" row: what, how many, and one button to an existing address. */
export interface HomeRow {
  key: keyof MyWorkCounts;
  label: string;
  count: number;
  href: string;
  action: string;
  icon: LucideIcon;
}

export const MY_WORK_UNAVAILABLE_TEXT = 'Counts unavailable. Reload; nothing is affected.';
export const NOTHING_NEEDS_YOU_TEXT = 'Nothing needs you right now';

/** Where the combined "waiting" count leads when only one role adds to it. */
const WAITING_BY_ROLE: Record<Exclude<keyof HomeRoles, 'branchManager' | 'quotations'>, { label: string; href: string; action: string; icon: LucideIcon }> = {
  bookings: { label: 'Booking drafts you can continue', href: '/app/deals', action: 'Open deals', icon: Hourglass },
  purchase: { label: 'Purchase tasks not taken yet, or yours in progress', href: '/app/purchase', action: 'Open Purchase tasks', icon: ClipboardList },
  flight: { label: 'Flight tasks not taken yet, or yours in progress', href: '/app/flight', action: 'Open Flight tasks', icon: Plane },
  visa: { label: 'Visa and passport tasks not taken yet, or yours in progress', href: '/app/visa', action: 'Open Visa and passport tasks', icon: Stamp },
  accounts: { label: 'Bookings to review in your companies', href: '/app/accounts?filter=needs_review', action: 'Open To check', icon: ClipboardCheck },
};
const ROLE_ORDER: Array<Exclude<keyof HomeRoles, 'branchManager' | 'quotations'>> = ['bookings', 'purchase', 'flight', 'visa', 'accounts'];

/**
 * The "What needs you" rows (Direction A HO-01, plan T4) from the existing
 * my_work_counts read only. A count shows only when it applies to one of the
 * viewer's roles and the database returned a number for it (null = not
 * applicable). The Manager "Requests to approve" placeholder is never shown
 * until that work exists. Every button opens an address that works today; no
 * new filter or read is needed.
 */
export function homeRows(counts: MyWorkCounts, roles: HomeRoles): HomeRow[] {
  const rows: HomeRow[] = [];
  const num = (value: number | null | undefined): value is number => typeof value === 'number';

  // waitingForMe sums drafts (Sales/Manager), department tasks and Accounts reviews. Batch 1:
  // draftsToContinue counts the drafts on their own, so the drafts row reads it (never
  // waitingForMe) and the combined row then covers only the other roles' queues. Without the
  // new count (older database) the combined row stays as before.
  const draftsSeparate = roles.bookings && num(counts.draftsToContinue);
  if (draftsSeparate) {
    const bookings = WAITING_BY_ROLE.bookings;
    rows.push({ key: 'draftsToContinue', label: bookings.label, count: counts.draftsToContinue as number, href: bookings.href, action: bookings.action, icon: bookings.icon });
  }
  const contributors = ROLE_ORDER.filter((r) => roles[r] && !(draftsSeparate && r === 'bookings'));
  const queues = num(counts.waitingForMe) ? counts.waitingForMe - (draftsSeparate ? (counts.draftsToContinue as number) : 0) : null;
  const visaOnly = contributors.length === 1 && contributors[0] === 'visa' && num(counts.visaTasksWaiting);
  if (contributors.length > 0 && queues !== null && queues >= 0 && !visaOnly) {
    const first = WAITING_BY_ROLE[contributors[0]!];
    rows.push({
      key: 'waitingForMe',
      label: contributors.length === 1 ? first.label : 'Waiting for you across your roles',
      count: queues,
      href: first.href,
      action: first.action,
      icon: first.icon,
    });
  }
  if (roles.bookings) {
    // Scope named in the words (owner handoff 19 October): Sales counts cover their own deals;
    // a Manager's also cover their branches' deals (my_work_counts decides).
    const scope = roles.branchManager ? 'your deals and branches' : 'your deals';
    rows.push(
      { key: 'returnedToMe', label: `Returned by Accounts (${scope})`, count: counts.returnedToMe, href: '/app/deals', action: 'Open deals', icon: Undo2 },
      { key: 'missingDetails', label: `Booking drafts missing details (${scope})`, count: counts.missingDetails, href: '/app/deals', action: 'Open deals', icon: ListChecks },
      { key: 'intakeNeeded', label: `Confirmed deals needing a booking (${scope})`, count: counts.intakeNeeded, href: '/app/deals', action: 'Open deals', icon: Briefcase },
    );
  }
  if (roles.quotations) {
    // FP-081: my_work_counts counts every quotation the person can open (scope "all"), so the
    // button opens the list in that scope with the same filter: the count equals the rows.
    const scope = roles.branchManager ? 'yours and your branches’' : 'yours';
    const quoteRow = (key: HomeQuotationRowKey, label: string, icon: LucideIcon): HomeRow => ({
      key,
      label,
      count: counts[key] as number,
      href: homeQuotationHref(key),
      action: 'Open quotations',
      icon,
    });
    if (num(counts.quotationDraftsToFinish)) rows.push(quoteRow('quotationDraftsToFinish', `Quotation drafts to finish (${scope})`, FilePen));
    if (num(counts.acceptedQuotesToLink)) rows.push(quoteRow('acceptedQuotesToLink', `Accepted quotations to link to a deal (${scope})`, FileCheck2));
  }
  if (roles.accounts && num(counts.receiptsToVerify)) {
    rows.push({ key: 'receiptsToVerify', label: 'Receipts to verify (recorded by someone else)', count: counts.receiptsToVerify, href: '/app/accounts?filter=awaiting_verification', action: 'Open To check', icon: Receipt });
  }
  if (roles.accounts && num(counts.claimsToProcess)) {
    rows.push({ key: 'claimsToProcess', label: 'Reported payments to check in your companies', count: counts.claimsToProcess, href: '/app/accounts/claims', action: 'Open Reported payments', icon: HandCoins });
  }
  if (roles.accounts && num(counts.expensesToReview)) {
    rows.push({ key: 'expensesToReview', label: 'Department costs to review (submitted by someone else)', count: counts.expensesToReview, href: '/app/accounts/expenses', action: 'Open Department costs', icon: FileSpreadsheet });
  }
  if (roles.visa && num(counts.visaTasksWaiting)) {
    rows.push({ key: 'visaTasksWaiting', label: 'Visa and passport tasks not taken yet, or yours in progress', count: counts.visaTasksWaiting, href: '/app/visa', action: 'Open Visa and passport tasks', icon: Stamp });
  }
  return rows.filter((r) => num(r.count));
}

/** The Quotations list address a Home quotation row opens (a menu address with a query; scope "all" as the count). */
export function homeQuotationHref(key: HomeQuotationRowKey): string {
  return `/app/quotations?filter=${HOME_QUOTATION_ROW_FILTER[key]}&scope=all`;
}

/** The page's one primary action: the person's main queue (FP-008: the Visa desk is one click from Home). */
function primaryAction(roles: HomeRoles, adminPrimary?: { href: string; label: string }): { href: string; label: string } {
  if (roles.bookings) return { href: '/app/deals', label: 'Go to deals' };
  if (roles.visa) return { href: '/app/visa', label: 'Open Visa and passport tasks' };
  if (roles.purchase) return { href: '/app/purchase', label: 'Open Purchase tasks' };
  if (roles.flight) return { href: '/app/flight', label: 'Open Flight tasks' };
  if (roles.accounts) return { href: '/app/accounts', label: 'Open To check' };
  // Echo L10: no work role (Super Admin): their work is in Settings, not an empty Deals list.
  return adminPrimary ?? { href: '/app/deals', label: 'Go to deals' };
}

/** DA-134: "Work is waiting for you below." / "Nothing needs you right now." — never a total of overlapping rows. */
export function homeSummary(rows: HomeRow[]): string {
  return rows.some((r) => r.count > 0) ? 'Work is waiting for you below.' : `${NOTHING_NEEDS_YOU_TEXT}.`;
}

const chipClass = cn(
  'inline-flex min-h-9 max-w-full items-center gap-2 rounded-control border border-line bg-card px-3 py-1.5 text-base text-copy no-underline',
  'hover:border-line-strong hover:bg-wash hover:text-ink',
  focusRing,
);

/**
 * Home "What needs you" (Direction A HO-01, R0). Greeting with the page's one
 * primary action; the deal counts it has always shown, each a link to the
 * Deals list (FP-006); the role-scoped counts as rows with one button each
 * (FP-007, T4); and the "Not available yet" note on demand (FP-009). Reads
 * nothing new. "Counts unavailable" is never shown as zero.
 */
export function HomeView({
  displayName,
  counts,
  canUseAccounts = false,
  canSeePurchaseTasks = false,
  canSeeFlightTasks = false,
  roles: rolesProp,
  myWork,
  adminPrimary,
}: {
  /** Primary action when no work role applies (Super Admin): a Settings page they can open. */
  adminPrimary?: { href: string; label: string };
  displayName: string;
  /** Kept for older callers; memberships are listed in the account panel now (FP-004). */
  memberships?: MembershipLine[];
  counts: { visible: number; owned: number; assigned: number };
  /** Same rule as the Accounts menu group; the finance commands still decide every read. */
  canUseAccounts?: boolean;
  /** Same rule as the Leads menu item (kept for older callers). */
  canSeeLeads?: boolean;
  /** Same rule as the Purchase tasks menu item. */
  canSeePurchaseTasks?: boolean;
  /** Same rule as the Flight tasks menu item. */
  canSeeFlightTasks?: boolean;
  /** Which roles' counts apply (shell-permissions.ts homeWorkRoles). Older callers fall back to the flags above. */
  roles?: HomeRoles;
  /**
   * B1 "My work" counts (my_work_counts, role-scoped by the database).
   * null = the read failed ("counts unavailable"); absent = not loaded.
   */
  myWork?: MyWorkCounts | null;
}) {
  const roles: HomeRoles = rolesProp ?? {
    bookings: !canUseAccounts && !canSeePurchaseTasks && !canSeeFlightTasks,
    branchManager: false,
    purchase: canSeePurchaseTasks,
    flight: canSeeFlightTasks,
    visa: false,
    accounts: canUseAccounts,
  };
  const rows = myWork ? homeRows(myWork, roles) : [];
  const primary = primaryAction(roles, adminPrimary);
  // DA-134 (Echo M3, Mercury F4): no total. The rows overlap (drafts missing details are drafts;
  // a returned booking is also a draft), so a sum would overstate the work.
  const summary = myWork === undefined || myWork === null ? undefined : homeSummary(rows);

  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        title={`Welcome, ${displayName}`}
        description={summary}
        actions={
          <Link href={primary.href} className={buttonVariants({ variant: 'primary' })}>
            {primary.label}
          </Link>
        }
      />

      <section aria-labelledby="deals-heading" className="mb-6">
        <h2 id="deals-heading" className="sr-only">
          Your deals
        </h2>
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {/* DA-135 (Echo M4): each chip opens the Deals list with the same filter and the same scope words. */}
          {[
            { label: 'Deals you can open', value: counts.visible, href: '/app/deals' },
            { label: 'Owned by you', value: counts.owned, href: '/app/deals?filter=owned' },
            { label: 'Assigned to you', sr: ', owned by someone else', value: counts.assigned, href: '/app/deals?filter=assigned' },
          ].map((c) => (
            <li key={c.label} className="m-0 max-w-full">
              <Link href={c.href} className={chipClass}>
                <span>
                  {c.label}
                  {c.sr ? <span className="sr-only">{c.sr}</span> : null}
                </span>
                <strong className="font-semibold text-ink tabular-nums">{numberFormat.format(c.value)}</strong>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {myWork !== undefined ? <WhatNeedsYou counts={myWork} rows={rows} /> : null}

      <details className="group mt-6 rounded-card border border-dashed border-line-strong bg-card">
        <summary
          className={cn(
            'flex min-h-11 cursor-pointer list-none items-center gap-2.5 rounded-card px-4.5 py-2.5 text-base font-medium text-copy hover:bg-wash [&::-webkit-details-marker]:hidden',
            focusRing,
          )}
        >
          <Info aria-hidden="true" className="size-4 shrink-0 text-status-info" />
          What this CRM does not do yet
        </summary>
        <section aria-label="Not available yet" className="border-t border-line px-4.5 py-3">
          <p className="m-0 text-base text-copy">
            Invoices, supplier payments and reports are not in the CRM yet.{' '}
            {canUseAccounts
              ? 'Customer billing details and receipts are in Accounts.'
              : 'Customer billing details and receipts are handled by Accounts staff.'}{' '}
            Sales leads, follow-ups and stages stay in Bitrix.
          </p>
        </section>
      </details>
    </div>
  );
}

/**
 * "What needs you" (catalog gap G9: the arrangement is a composition of the
 * design-system table rows). One row per applicable count, with one button.
 */
function WhatNeedsYou({ counts, rows }: { counts: MyWorkCounts | null; rows: HomeRow[] }) {
  return (
    <section aria-labelledby="needs-heading">
      <h2 id="needs-heading" className="m-0 mb-3 text-lg leading-6 font-semibold text-ink">
        What needs you
      </h2>
      {counts === null ? (
        <Notice tone="warning" role="status" icon={RefreshCw}>
          <p>{MY_WORK_UNAVAILABLE_TEXT}</p>
        </Notice>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={Sparkles} title={NOTHING_NEEDS_YOU_TEXT} description="New work appears here when it is assigned to you." />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <Table label="What needs you: counts" stackOnMobile wrapperClassName="rounded-card">
            <TableHeader>
              <TableRow>
                <TableHead>What needs you</TableHead>
                <TableHead numeric>Waiting</TableHead>
                <TableHead className="text-right">Next step</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>
                    <span className="flex items-center gap-2.5 font-medium text-ink">
                      <row.icon aria-hidden="true" className="size-4 shrink-0 text-brand" />
                      {row.label}
                    </span>
                  </TableCell>
                  <TableCell numeric label="Waiting">
                    {row.count > 0 ? (
                      <span className="inline-flex min-w-7 justify-center rounded-full bg-brand-accent px-2 text-sm leading-6 font-semibold text-brand-accent-ink">
                        {numberFormat.format(row.count)}
                      </span>
                    ) : (
                      <span className="font-normal text-quiet">Nothing waiting</span>
                    )}
                  </TableCell>
                  <TableCell label="Next step" className="text-right">
                    <Link href={row.href} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                      {row.action}
                      <span className="sr-only">: {row.label}</span>
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </section>
  );
}
