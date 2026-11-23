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
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { mayOpenAddress, type SectionsViewer } from '@/app/app/sections';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Fold } from '@/components/ui/fold';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { plural } from '@/lib/format';
import type { MyWorkCounts } from '@/modules/fulfilment/contracts';
import { SUPPLIER_MONEY_HOME_LABEL, type SupplierMoneyHomeCounts } from '@/modules/supplier-money/contracts';
import { HOME_QUOTATION_ROW_FILTER, type HomeQuotationRowKey } from '@/modules/quotations/work-contract';
import type { MembershipLine } from './staff-views';
import type { FlightHomeCounts } from './flight/types';
import { VISA_HOME_ROW_LABEL } from '@/modules/visa/contracts';
import type { VisaHomeCounts } from './visa/types';
import { type FlightMoneyHomeKey, type HomeRow, homeRowButtonText, homeRowsFor } from './home-rows';

export { type FlightMoneyHomeKey, type HomeRow, homeRowButtonText, homeRowsFor } from './home-rows';

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
  const allContributors = ROLE_ORDER.filter((r) => roles[r] && !(draftsSeparate && r === 'bookings'));
  // Flight build (20261201000150): waitingForMe no longer counts flight tasks; Flight work has its own
  // rows (flight_home_counts), so flight never adds to the combined row.
  const contributors = allContributors.filter((r) => r !== 'flight');
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
/**
 * Purchase build (2 Nov 2026): supplier-money and go-ahead rows from
 * supplier_money_home_counts, per role, each opening the list that shows the
 * same items. A null count (not applicable, or an older database) is hidden,
 * never shown as 0. The Manager's rows fold into one "Waiting for your
 * approval" row that opens Approvals.
 */
export function supplierMoneyRows(counts: SupplierMoneyHomeCounts, roles: HomeRoles): HomeRow[] {
  const L = SUPPLIER_MONEY_HOME_LABEL;
  const rows: HomeRow[] = [];
  const add = (key: keyof SupplierMoneyHomeCounts, href: string, action: string, icon: LucideIcon) => {
    const count = counts[key];
    if (typeof count === 'number') rows.push({ key, label: L[key], count, href, action, icon });
  };
  if (roles.purchase) {
    add('purchaseTasksNotTaken', '/app/purchase', 'Open Purchase tasks', ClipboardList);
    add('purchaseWaitingForGoAhead', '/app/purchase?show=mine', 'Open my Purchase tasks', Hourglass);
    add('purchaseCostsWaitingForManager', '/app/purchase?show=mine', 'Open my Purchase tasks', Hourglass);
    add('paymentRequestsReturned', '/app/purchase/payments?show=returned', 'Open Payment requests', Undo2);
    add('supplierInvoicesMissing', '/app/purchase?show=mine', 'Open my Purchase tasks', Receipt);
  }
  if (roles.accounts) {
    add('goAheadToApprove', '/app/accounts/go-ahead', 'Open Hotel go-ahead', ClipboardCheck);
    add('supplierPaymentsToApprove', '/app/accounts/supplier-payments', 'Open Supplier payments', HandCoins);
    add('supplierPaymentsToRecord', '/app/accounts/supplier-payments?tab=to_record', 'Open Supplier payments', HandCoins);
    add('supplierPaymentsToVerify', '/app/accounts/supplier-payments?tab=to_verify', 'Open Supplier payments', HandCoins);
    add('supplierDocumentsToReview', '/app/accounts/supplier-invoices', 'Open Supplier invoices', Receipt);
    add('fundingToApprove', '/app/accounts/funding', 'Open Company funding', HandCoins);
    add('fundingToRecover', '/app/accounts/funding?tab=to_recover', 'Open Company funding', HandCoins);
  }
  if (roles.branchManager) {
    const n = counts.managerApprovals ?? counts.requestsToApprove;
    if (typeof n === 'number') rows.push({ key: 'managerApprovals', label: L.managerApprovals, count: n, href: '/app/approvals', action: 'Open Approvals', icon: ListChecks });
  }
  return rows;
}

/**
 * Flight build (4 Nov 2026): the personal Flight and Sales rows from
 * flight_home_counts, plus the flight payment rows from
 * supplier_money_home_counts. A null count (not for this viewer, or an older
 * database) is hidden, never 0. Each row opens the list that shows the same
 * items. The Manager's flight fares fold into "Waiting for your approval".
 */
export function flightRows(counts: FlightHomeCounts | null | undefined, money: SupplierMoneyHomeCounts | null | undefined, roles: HomeRoles): HomeRow[] {
  const rows: HomeRow[] = [];
  const add = (key: HomeRow['key'], count: unknown, label: string, href: string, action: string, icon: LucideIcon) => {
    if (typeof count === 'number') rows.push({ key, label, count, href, action, icon });
  };
  const m = (money ?? {}) as Partial<Record<FlightMoneyHomeKey, number | null>>;
  if (roles.flight && counts) {
    add('flightDealsNotTaken', counts.flightDealsNotTaken, 'Flights not taken yet', '/app/flight', 'Open Flight tasks', Plane);
    add('flightDealsMine', counts.flightDealsMine, 'Your flights in progress', '/app/flight?show=mine', 'Open my flights', Plane);
    add('flightBookingChanged', counts.flightBookingChanged, 'Booking changed — review', '/app/flight?show=mine&only=booking_changed', 'Open flights with a booking change', RefreshCw);
    add('flightChangesDecided', counts.flightChangesDecided, 'Change decisions to see', '/app/flight?show=mine&only=change_decision', 'Open flights with a decision', ListChecks);
    if ((counts.flightTravellersNamed ?? 0) > 0) add('flightTravellersNamed', counts.flightTravellersNamed, 'Travellers Sales has named', '/app/flight?show=mine', 'Open my flights', UserPlus);
    add('flightReadyToFinish', counts.flightReadyToFinish, 'Flights ready to mark done', '/app/flight?show=mine&only=ready', 'Open flights ready to mark done', ClipboardCheck);
  }
  if (roles.flight) {
    add('flightPaymentsReturned', m.flightPaymentsReturned, 'Flight payments returned', '/app/flight?show=mine&only=payment', 'Open flights needing payment', Undo2);
    add('flightPaymentsMissing', m.flightPaymentsMissing, 'Flight batches to pay', '/app/flight?show=mine&only=payment', 'Open flights needing payment', HandCoins);
  }
  if (roles.bookings && counts) {
    // One Deal behind the row: open it on its Services tab (the approval card / the travellers notice); else the Deals list.
    const deal = (id: string | null | undefined) => (id ? `/app/deals/${id}?tab=services` : '/app/deals');
    add('salesFlightChangesToDecide', counts.salesFlightChangesToDecide, 'Flight changes waiting for your approval', deal(counts.salesFlightChangesToDecideDealId), counts.salesFlightChangesToDecideDealId ? 'Open the deal' : 'Open deals', Plane);
    add('salesTravellersToName', counts.salesTravellersToName, 'Travellers to name for flights', deal(counts.salesTravellersToNameDealId), counts.salesTravellersToNameDealId ? 'Open the deal' : 'Open deals', ListChecks);
  }
  return rows;
}

/**
 * Visa build (contract 8, visa_home_counts): the Visa desk's personal rows
 * and the Sales owner's "Visa results to see". A null count (not for this
 * viewer, or an older database) is hidden, never 0. Each row opens the first
 * task (Work tab) or Deal (Services tab) behind it, else the list.
 */
export function visaRows(counts: VisaHomeCounts | null | undefined, roles: HomeRoles): HomeRow[] {
  if (!counts) return [];
  const rows: HomeRow[] = [];
  const task = (id: string | null | undefined) => (id ? `/app/visa/${id}?tab=work` : '/app/visa?show=mine');
  const add = (key: keyof typeof VISA_HOME_ROW_LABEL, href: string, action: string, icon: LucideIcon) => {
    const count = counts[key];
    if (typeof count === 'number') rows.push({ key, label: VISA_HOME_ROW_LABEL[key], count, href, action, icon });
  };
  if (roles.visa) {
    add('visaApplicantsWaitingResult', task(counts.visaApplicantsWaitingResultTaskId), counts.visaApplicantsWaitingResultTaskId ? 'Open the task' : 'Open my tasks', Hourglass);
    add('visaHandoverPending', task(counts.visaHandoverPendingTaskId), counts.visaHandoverPendingTaskId ? 'Open the task' : 'Open my tasks', ClipboardCheck);
    add('visaFeesReturned', task(counts.visaFeesReturnedTaskId), counts.visaFeesReturnedTaskId ? 'Open the task' : 'Open my tasks', Undo2);
    add('visaFeesWithoutReceipt', task(counts.visaFeesWithoutReceiptTaskId), counts.visaFeesWithoutReceiptTaskId ? 'Open the task' : 'Open my tasks', Receipt);
    add('visaTravellerChanged', task(counts.visaTravellerChangedTaskId), counts.visaTravellerChangedTaskId ? 'Open the task' : 'Open my tasks', RefreshCw);
  }
  if (roles.bookings) {
    const deal = counts.salesVisaResultsDealId;
    add('salesVisaResultsToSee', deal ? `/app/deals/${deal}?tab=services#visa-results` : '/app/deals', deal ? 'Open the deal' : 'Open deals', Stamp);
  }
  return rows;
}

/** Accounts phase (contract 8.5 purchase_home_counts, 11.8): the only new Home row (AL16). */
export interface PurchaseChangeHomeCounts {
  purchaseBookingChanged: number | null;
  purchaseBookingChangedTaskId: string | null;
}

export function purchaseChangeRows(counts: PurchaseChangeHomeCounts | null | undefined, roles: HomeRoles): HomeRow[] {
  if (!counts || !roles.purchase || typeof counts.purchaseBookingChanged !== 'number' || counts.purchaseBookingChanged === 0) return [];
  const id = counts.purchaseBookingChangedTaskId;
  return [
    {
      key: 'purchaseBookingChanged',
      label: 'Bookings changed on your tasks',
      count: counts.purchaseBookingChanged,
      href: id ? `/app/purchase/${id}` : '/app/purchase?show=mine',
      action: id ? 'Open the oldest' : 'Open my Purchase tasks',
      icon: RefreshCw,
    },
  ];
}

export function homeQuotationHref(key: HomeQuotationRowKey): string {
  return `/app/quotations?filter=${HOME_QUOTATION_ROW_FILTER[key]}&scope=all`;
}

/**
 * The person's main queue, used as the page's one primary action when no row
 * is waiting (FP-008: the Visa desk is one click from Home). With `open` (the
 * menu's answer, sections.ts) only a queue this person may open is offered.
 */
function primaryAction(roles: HomeRoles, adminPrimary: { href: string; label: string } | undefined, open: (href: string) => boolean): { href: string; label: string } {
  const candidates: Array<{ href: string; label: string } | false | undefined> = [
    roles.bookings && { href: '/app/deals', label: 'Go to deals' },
    roles.visa && { href: '/app/visa', label: 'Open Visa and passport tasks' },
    roles.purchase && { href: '/app/purchase', label: 'Open Purchase tasks' },
    roles.flight && { href: '/app/flight', label: 'Open Flight tasks' },
    roles.accounts && { href: '/app/accounts', label: 'Open To check' },
    // Echo L10: no work role (Super Admin): their work is in Settings, not an empty Deals list.
    adminPrimary,
  ];
  const first = candidates.find((c): c is { href: string; label: string } => !!c && open(c.href));
  // Deals is in every person's menu (sections.ts), so it is always a safe last choice.
  return first ?? { href: '/app/deals', label: 'Go to deals' };
}

/** DA-134: "Work is waiting for you below." / "Nothing needs you right now." — never a total of overlapping rows. */
export function homeSummary(rows: HomeRow[]): string {
  return rows.some((r) => r.count > 0) ? 'Work is waiting for you below.' : `${NOTHING_NEEDS_YOU_TEXT}.`;
}

/**
 * Home "What needs you" (Direction A HO-01; UX redesign R2, SL-1, SL-19,
 * DM-18). The greeting, then straight to the work: rows with something
 * waiting, each with one button named for the count; rows with nothing
 * waiting have no button and sit folded under the table. The page's one
 * primary action is the top waiting row's button, else the person's main
 * queue. The "Your deals" counts are gone (they repeated the Deals list
 * chips and were noise for desk roles), so Home makes one read fewer.
 * Reads nothing new. "Counts unavailable" is never shown as zero.
 */
export function HomeView({
  displayName,
  canUseAccounts = false,
  canSeePurchaseTasks = false,
  canSeeFlightTasks = false,
  roles: rolesProp,
  myWork,
  supplierMoney,
  flight,
  visa,
  purchaseChanges,
  adminPrimary,
  sections,
}: {
  /** Accounts phase: purchase_home_counts (null or absent = hidden, never zero). */
  purchaseChanges?: PurchaseChangeHomeCounts | null;
  /** Visa build: visa_home_counts (null or absent = hidden, never zero). */
  visa?: VisaHomeCounts | null;
  /** Flight build: flight_home_counts (null or absent = hidden, never zero). */
  flight?: FlightHomeCounts | null;
  /** Purchase build: supplier_money_home_counts (null or absent = hidden, never zero). */
  supplierMoney?: SupplierMoneyHomeCounts | null;
  /** Primary action when no work role applies (Super Admin): a Settings page they can open. */
  adminPrimary?: { href: string; label: string };
  displayName: string;
  /** Kept for older callers; memberships are listed in the account panel now (FP-004). */
  memberships?: MembershipLine[];
  /** Kept for older callers; the "Your deals" counts are no longer shown (UX redesign R2, SL-19, DM-18). */
  counts?: { visible: number; owned: number; assigned: number };
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
  /** The frame's menu flags (sections.ts): rows and the primary action only open addresses the menu offers. */
  sections?: SectionsViewer;
}) {
  const roles: HomeRoles = rolesProp ?? {
    bookings: !canUseAccounts && !canSeePurchaseTasks && !canSeeFlightTasks,
    branchManager: false,
    purchase: canSeePurchaseTasks,
    flight: canSeeFlightTasks,
    visa: false,
    accounts: canUseAccounts,
  };
  const open = (href: string) => !sections || mayOpenAddress(sections, href);
  const rows = homeRowsFor(
    [
      ...(myWork ? homeRows(myWork, roles) : []),
      ...(supplierMoney ? supplierMoneyRows(supplierMoney, roles) : []),
      ...flightRows(flight, supplierMoney, roles),
      ...visaRows(visa, roles),
      ...purchaseChangeRows(purchaseChanges, roles),
    ],
    sections,
  );
  // The first waiting row is the page's one primary action (shown only when the counts were read).
  const top = myWork ? rows.find((r) => r.count > 0) : undefined;
  const fallback = primaryAction(roles, adminPrimary, open);
  // DA-134 (Echo M3, Mercury F4): no total. The rows overlap (drafts missing details are drafts;
  // a returned booking is also a draft), so a sum would overstate the work.
  const summary = myWork === undefined || myWork === null ? undefined : homeSummary(rows);

  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        title={`Welcome, ${displayName}`}
        description={summary}
        actions={
          top ? (
            <Link href={top.href} className={buttonVariants({ variant: 'primary' })} data-slot="home-primary">
              {homeRowButtonText(top)}
              <span className="sr-only">: {top.label}</span>
            </Link>
          ) : (
            <Link href={fallback.href} className={buttonVariants({ variant: 'primary' })} data-slot="home-primary">
              {fallback.label}
            </Link>
          )
        }
      />

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
 * design-system table rows). Waiting rows in the table, one button each named
 * for the count; rows with nothing waiting folded below without a button
 * (SL-19). The section keeps its name for screen readers; the table's first
 * column header is the only visible heading (no repeated heading).
 */
function WhatNeedsYou({ counts, rows }: { counts: MyWorkCounts | null; rows: HomeRow[] }) {
  const waiting = rows.filter((r) => r.count > 0);
  const quiet = rows.filter((r) => !(r.count > 0));
  return (
    <section aria-labelledby="needs-heading">
      <h2 id="needs-heading" className="sr-only">
        What needs you
      </h2>
      {counts === null ? (
        <Notice tone="warning" role="status" icon={RefreshCw}>
          <p>{MY_WORK_UNAVAILABLE_TEXT}</p>
        </Notice>
      ) : waiting.length === 0 ? (
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
              {waiting.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>
                    <span className="flex items-center gap-2.5 font-medium text-ink">
                      <row.icon aria-hidden="true" className="size-4 shrink-0 text-brand" />
                      {row.label}
                    </span>
                  </TableCell>
                  <TableCell numeric label="Waiting">
                    <span className="inline-flex min-w-7 justify-center rounded-full bg-brand-accent px-2 text-sm leading-6 font-semibold text-brand-accent-ink">
                      {numberFormat.format(row.count)}
                    </span>
                  </TableCell>
                  <TableCell label="Next step" className="text-right">
                    <Link href={row.href} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                      {homeRowButtonText(row)}
                      <span className="sr-only">: {row.label}</span>
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {counts !== null && quiet.length > 0 ? (
        <Fold
          id="home-nothing-waiting"
          className="mt-4"
          summary={waiting.length > 0 ? `Nothing waiting in ${plural(quiet.length, 'other list')}` : `Nothing waiting in ${plural(quiet.length, 'list')}`}
        >
          <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Lists with nothing waiting">
            {quiet.map((row) => (
              <li key={row.key} className="m-0 flex items-center gap-2.5 text-copy" data-slot="home-quiet-row">
                <row.icon aria-hidden="true" className="size-4 shrink-0 text-quiet" />
                <span>{row.label}</span>
                <span className="sr-only">: nothing waiting</span>
              </li>
            ))}
          </ul>
        </Fold>
      ) : null}
    </section>
  );
}
