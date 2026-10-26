import { CircleCheck, FlaskConical, ListEnd, Lock, SearchX } from 'lucide-react';
import Link from 'next/link';
import { AccountsClaimsSection, type ClaimActions } from './b11/accounts-claims';
import { AccountsPackageReview } from './b11/accounts-review';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Tabs } from '@/components/ui/tabs';
import {
  ACCOUNTS_DEAL_TAB_LABEL,
  ACCOUNTS_DEAL_TABS,
  type AccountsDealTab,
  accountsDealDefaultTab,
  parseAccountsDealTab,
} from '@/modules/settings/contracts';
import {
  type AccountsDealDetail,
  type AccountsDealLookup,
  type AccountsQueueFilter,
  type AccountsQueueItem,
  DESTINATION_KIND_LABEL,
  type DestinationOption,
  FINANCE_ERROR_TEXT,
  type FinanceErrorCode,
  RECEIPT_MODE_LABEL,
  type ReceiptView,
} from '@/modules/finance/contracts';
import {
  BillingPill,
  EvidenceList,
  FinanceDisclaimer,
  FinanceHeader,
  finDate,
  finDateTime,
  formatInr,
  maskedDestination,
  MoneyFigures,
  ReceiptStatusPill,
  REVIEW_STATUS_LABEL,
  ReviewPill,
} from './finance-common';
import {
  ApproveReviewForm,
  BillingForm,
  EvidenceUploadForm,
  type FinanceActions,
  ReceiptActionsPanel,
  RecordReceiptForm,
  ReturnReviewForm,
  VerifyBillingForm,
} from './finance-forms';
import { KeepTabInAddress } from './finance-tab-address';
import { SettingsSectionHeading } from './settings/settings-frame';

/*
 * Phase 5A Accounts screens (contract §14–§15). Pure views over the
 * contracts.ts shapes; pages pass real data and server actions, the preview
 * gallery passes synthetic data and a stub action.
 *
 * Design (see docs/implementation/next/phase-5a-design.md): queue rows from
 * 21st.dev "Invoice History Table" (22187) without its total footer, because
 * the three money figures are never added together; filters as a
 * link-based segmented control after "Segmented Control" (23552); readiness
 * as a checklist after "Sprint Task Checklist" (24947, inspiration only).
 */

/**
 * Filters of the one Accounts queue (DA-06, DA-274). The first three are the
 * "To check" tabs; Returned and Cheques stay reachable as secondary filters
 * so nothing the old filter row offered is lost. `?filter=` values unchanged.
 */
export const QUEUE_FILTERS: Array<{ value: AccountsQueueFilter; label: string; tab: boolean }> = [
  { value: 'needs_review', label: 'Booking reviews', tab: true },
  { value: 'awaiting_verification', label: 'Receipts to verify', tab: true },
  { value: 'all', label: 'All', tab: true },
  { value: 'returned', label: 'Returned to Sales', tab: false },
  { value: 'cheques_pending', label: 'Cheques awaiting clearance', tab: false },
];

/** The queue opens on Booking reviews (screen plan AC-01); `?filter=all` lists everything. */
export const DEFAULT_QUEUE_FILTER: AccountsQueueFilter = 'needs_review';

export function parseQueueFilter(value: string | string[] | undefined): AccountsQueueFilter {
  const v = Array.isArray(value) ? value[0] : value;
  return QUEUE_FILTERS.some((f) => f.value === v) ? (v as AccountsQueueFilter) : DEFAULT_QUEUE_FILTER;
}

// ---------------------------------------------------------------------------
// Access and unavailable states
// ---------------------------------------------------------------------------

export function FinanceNoAccessView({ area }: { area: 'accounts' | 'policy' }) {
  return (
    <>
      {/* Money rules sits inside the Settings frame (its h1 is "Settings"): a section heading here. */}
      {area === 'accounts' ? (
        <FinanceHeader eyebrow="Accounts" title="Accounts" />
      ) : (
        <>
          <SettingsSectionHeading>Finance policy</SettingsSectionHeading>
          <FinanceDisclaimer />
        </>
      )}
      <Card>
        <EmptyState
          icon={Lock}
          headingLevel={area === 'accounts' ? 2 : 3}
          title="You do not have access to this page"
          description={
            area === 'accounts'
              ? 'Only Accounts staff of a company with finance switched on can open Accounts. People who also hold the Purchase role cannot, because Purchase never sees selling prices. Ask a Super Admin if you think this is wrong.'
              : 'Only a Super Admin who does not also handle cash as Accounts can change the finance policy. Ask the owner if you think this is wrong.'
          }
        />
      </Card>
    </>
  );
}

/** Finance switched off or not set up: honest text, nothing pretends to work. */
export function FinanceUnavailableView({ code, title, inSettings = false }: { code: FinanceErrorCode; title: string; /** Money rules (Settings frame): a section heading, not a page title. */ inSettings?: boolean }) {
  return (
    <>
      {inSettings ? (
        <>
          <SettingsSectionHeading>{title}</SettingsSectionHeading>
          <FinanceDisclaimer />
        </>
      ) : (
        <FinanceHeader eyebrow="Accounts" title={title} />
      )}
      <Notice tone="warning" title={FINANCE_ERROR_TEXT[code]}>
        <p>Nothing can be recorded or read here until the owner sets it up.</p>
      </Notice>
    </>
  );
}

export function AccountsDealNotFoundView() {
  return (
    <>
      <FinanceHeader eyebrow="Accounts" title="Deal not found" />
      <Card>
        <EmptyState
          icon={SearchX}
          headingLevel={2}
          title={FINANCE_ERROR_TEXT.not_found}
          description="Look the deal up by its exact reference on To check."
          action={
            <Link href="/app/accounts" className={buttonVariants({ variant: 'secondary' })}>
              Back to To check
            </Link>
          }
        />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// To check (the Accounts queue)
// ---------------------------------------------------------------------------

export type LookupOutcome = { reference: string; result: AccountsDealLookup | null } | null;

const LINK_CLASS = cn('rounded-chip font-semibold text-brand-strong underline decoration-1 underline-offset-4 hover:text-brand-deep hover:decoration-2', focusRing);

function LookupPanel({ lookup }: { lookup: LookupOutcome }) {
  return (
    <section className="mb-4 rounded-card border border-line bg-card px-4.5 py-4 font-sans shadow-card" aria-labelledby="fin-lookup-heading">
      <h2 id="fin-lookup-heading" className="m-0 mb-2 text-lg font-semibold text-ink">
        Find a deal by reference
      </h2>
      <form method="get" action="/app/accounts" role="search" aria-label="Find a deal by exact reference" className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor="fin-lookup-ref" className="text-base font-semibold text-ink">
            Deal reference
          </label>
          <span id="fin-lookup-hint" className="text-sm text-quiet">
            Find a deal by its exact reference.
          </span>
          <Input id="fin-lookup-ref" name="ref" defaultValue={lookup?.reference ?? ''} maxLength={60} autoComplete="off" spellCheck={false} aria-describedby="fin-lookup-hint" required />
        </div>
        <Button type="submit" variant="secondary">
          Find deal
        </Button>
      </form>
      {lookup ? (
        lookup.result ? (
          <div className="mt-3" role="status">
            <p className="m-0">
              <Link href={`/app/accounts/deals/${lookup.result.dealId}`} className={LINK_CLASS}>
                {lookup.result.dealReference} · {lookup.result.dealTitle}
              </Link>
            </p>
            <p className="m-0 text-sm text-quiet">
              {lookup.result.branchName} · {lookup.result.hasConfirmedBooking ? 'Has a confirmed booking' : 'No confirmed booking yet; receipts can still be recorded'}
            </p>
          </div>
        ) : (
          <p className="m-0 mt-3" role="status">
            No deal with the exact reference “{lookup.reference}” in your companies. Check the reference and try again.
          </p>
        )
      ) : null}
    </section>
  );
}

/** `/app/accounts` with the filter and, for a later page, the opaque cursor from accounts_queue. */
export function accountsQueueHref(filter: AccountsQueueFilter, after: string | null = null): string {
  const params = new URLSearchParams();
  if (filter !== DEFAULT_QUEUE_FILTER) params.set('filter', filter);
  if (after) params.set('after', after);
  const query = params.toString();
  return query ? `/app/accounts?${query}` : '/app/accounts';
}

/**
 * DA-274: the tabs are filters of one queue, links with aria-current. The
 * count is shown on the open tab only (lead ruling D7: accounts_queue counts
 * the current filter; no extra read for the others).
 */
function QueueTabs({ current, total }: { current: AccountsQueueFilter; total: number }) {
  const secondary = QUEUE_FILTERS.filter((f) => !f.tab);
  return (
    <div className="mb-4 flex flex-col gap-2">
      <Tabs
        label="To check tabs"
        items={QUEUE_FILTERS.filter((f) => f.tab).map((f) => ({
          href: accountsQueueHref(f.value),
          label: f.label,
          current: f.value === current,
          count: f.value === current ? total : undefined,
        }))}
      />
      <nav aria-label="More filters" className="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-sm text-quiet">
        <span>More filters:</span>
        {secondary.map((f) => (
          <Link key={f.value} href={accountsQueueHref(f.value)} aria-current={f.value === current ? 'page' : undefined} className={cn(LINK_CLASS, 'font-medium aria-[current=page]:font-bold aria-[current=page]:text-ink')}>
            {f.label}
            {f.value === current ? <span className="tabular-nums"> ({total})</span> : null}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export interface AccountsQueuePaging {
  /** Every deal matching the filter, not just this page. */
  totalCount: number;
  hasMore: boolean;
  /** Cursor for the next page; null when hasMore is false. */
  nextAfter: string | null;
  /** True when this page was opened with ?after=. */
  laterPage: boolean;
}

function QueuePager({ filter, paging }: { filter: AccountsQueueFilter; paging: AccountsQueuePaging }) {
  const next = paging.hasMore ? paging.nextAfter : null;
  if (!next && !paging.laterPage) return null;
  return (
    <nav className="mt-3 flex flex-wrap gap-2" aria-label="Accounts queue pages">
      {paging.laterPage ? (
        <Link className={buttonVariants({ variant: 'secondary', size: 'sm' })} href={accountsQueueHref(filter)}>
          First page
        </Link>
      ) : null}
      {next ? (
        <Link className={buttonVariants({ variant: 'secondary', size: 'sm' })} href={accountsQueueHref(filter, next)}>
          Next page
        </Link>
      ) : null}
    </nav>
  );
}

const EMPTY_TEXT: Record<AccountsQueueFilter, { title: string; text: string }> = {
  needs_review: { title: 'No booking reviews waiting', text: 'A booking appears here when Sales submits it. Receipts to verify are on their own tab.' },
  awaiting_verification: { title: 'No receipts to verify', text: 'A receipt appears here after an Accounts person records it. Another Accounts person verifies it.' },
  all: {
    title: 'Nothing to check',
    text: 'A deal appears here when Sales submits a booking or when a receipt is recorded. To record a receipt for another deal, find it by reference above.',
  },
  returned: { title: 'No bookings returned to Sales', text: 'No deal matches this filter right now. Choose “All” to see every deal.' },
  cheques_pending: { title: 'No cheques awaiting clearance', text: 'No deal matches this filter right now. Choose “All” to see every deal.' },
};

export function AccountsQueueView({
  items,
  filter,
  lookup = null,
  paging,
}: {
  items: AccountsQueueItem[];
  filter: AccountsQueueFilter;
  lookup?: LookupOutcome;
  /** Omitted only by callers that already hold the whole queue (totalCount = items.length). */
  paging?: AccountsQueuePaging;
}) {
  const label = QUEUE_FILTERS.find((f) => f.value === filter)?.label ?? 'All';
  const page: AccountsQueuePaging = paging ?? { totalCount: items.length, hasMore: false, nextAfter: null, laterPage: false };
  const total = Math.max(page.totalCount, items.length);
  const partial = page.hasMore || page.laterPage || total > items.length;
  const empty = EMPTY_TEXT[filter];
  return (
    <>
      <FinanceHeader eyebrow="Accounts" title="To check">
        <p>Bookings and payments to check.</p>
      </FinanceHeader>
      <LookupPanel lookup={lookup} />
      <QueueTabs current={filter} total={total} />
      {page.hasMore ? (
        <Notice tone="warning" role="status" className="mb-3">
          <p>
            Showing {items.length} of {total} {total === 1 ? 'deal' : 'deals'} under “{label}”. More deals are waiting: use Next page below the list.
          </p>
        </Notice>
      ) : null}
      {items.length === 0 && page.laterPage ? (
        <Card>
          <EmptyState
            icon={ListEnd}
            headingLevel={2}
            title="No more deals after this point"
            description={`${total > 0 ? `The queue holds ${total} ${total === 1 ? 'deal' : 'deals'} under “${label}”. ` : ''}Go back to the first page to see them.`}
          />
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState icon={CircleCheck} headingLevel={2} title={empty.title} description={empty.text} />
        </Card>
      ) : (
        <div className="table-scroll">
          <table className="stack-table fin-queue">
            <caption>
              {partial ? `Showing ${items.length} of ${total} ${total === 1 ? 'deal' : 'deals'}` : `${items.length} ${items.length === 1 ? 'deal' : 'deals'}`} · {label}
            </caption>
            <thead>
              <tr>
                <th scope="col">Deal</th>
                <th scope="col">Branch</th>
                <th scope="col">Booking</th>
                <th scope="col">Billing</th>
                <th scope="col">Review</th>
                <th scope="col">Available</th>
                <th scope="col">Awaiting verification</th>
                <th scope="col">Cheques awaiting clearance</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.dealId}>
                  <td data-label="Deal">
                    <Link href={`/app/accounts/deals/${i.dealId}`}>
                      <strong>{i.dealReference}</strong>
                      <span className="visually-hidden"> — open in Accounts</span>
                    </Link>
                    <span className="fin-sub">{i.dealTitle}</span>
                  </td>
                  <td data-label="Branch">{i.branchName}</td>
                  <td data-label="Booking">{i.hasConfirmedBooking ? 'Confirmed' : 'No confirmed booking'}</td>
                  <td data-label="Billing">
                    <BillingPill status={i.billingStatus} />
                  </td>
                  <td data-label="Review">
                    <ReviewPill status={i.reviewStatus} />
                  </td>
                  <td data-label="Available" className="fin-num">
                    {formatInr(i.money.availablePaise)}
                  </td>
                  <td data-label="Awaiting verification" className="fin-num">
                    {formatInr(i.money.awaitingVerificationPaise)}
                  </td>
                  <td data-label="Cheques awaiting clearance" className="fin-num">
                    {formatInr(i.money.chequesAwaitingClearancePaise)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <details className="mt-8 font-sans text-sm text-quiet">
            <summary className={cn('cursor-pointer rounded-chip font-medium text-copy', focusRing)}>Why are the amounts separate?</summary>
            <p className="m-0 mt-4">
              Available money, receipts awaiting verification and cheques awaiting clearance are different things, so they are shown side by side and never added together.
            </p>
          </details>
        </div>
      )}
      <QueuePager filter={filter} paging={page} />
      <p className="m-0 mt-5 font-sans text-sm text-quiet">
        Also in Accounts: <Link href="/app/accounts/cash" className={LINK_CLASS}>Open branch cash, deposits and daily counts</Link> ·{' '}
        <Link href="/app/accounts/destinations" className={LINK_CLASS}>
          Open company accounts (bank accounts and UPI IDs customers pay into)
        </Link>
      </p>
    </>
  );
}

/** Accounts route loading state: says what is loading; never shows figures before they arrive. */
export function FinanceLoadingView({ title = 'Accounts' }: { title?: string }) {
  return (
    <>
      <FinanceHeader eyebrow="Accounts" title={title} />
      <div className="loading-block">
        <p role="status" aria-live="polite" className="m-0">
          Loading Accounts work…
        </p>
        <div className="skeleton" aria-hidden="true" />
        <div className="skeleton wide" aria-hidden="true" />
        <div className="skeleton" aria-hidden="true" />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Deal detail
// ---------------------------------------------------------------------------

function Check({ ok, children, detail }: { ok: boolean | null; children: ReactNode; detail?: ReactNode }) {
  const cls = ok === null ? 'check-info' : ok ? 'check-ok' : 'check-missing';
  const glyph = ok === null ? '•' : ok ? '✓' : '✕';
  const word = ok === null ? 'Information' : ok ? 'Done' : 'Not done';
  return (
    <li className={cls}>
      <span className="status-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span>
        <span className="visually-hidden">{word}: </span>
        {children}
        {detail ? <span className="fin-sub">{detail}</span> : null}
      </span>
    </li>
  );
}

function Readiness({ d }: { d: AccountsDealDetail }) {
  const b = d.booking;
  return (
    <section className="fin-card" aria-labelledby="fin-ready">
      <h2 id="fin-ready">Readiness checklist</h2>
      <ul className="checklist fin-checklist">
        <Check ok={!!b} detail={b ? undefined : 'Receipts can still be recorded without a booking.'}>
          {b ? `Booking confirmed (version ${b.versionNo})` : 'No confirmed booking yet'}
        </Check>
        <Check ok={d.billing?.status === 'verified'} detail={!d.billing ? 'Enter the customer billing details below.' : d.billing.status === 'draft' ? 'Saved; another Accounts check is needed.' : undefined}>
          {d.billing?.status === 'verified' ? 'Billing details checked' : d.billing ? 'Billing details saved, not checked yet' : 'Billing details not entered'}
        </Check>
        <Check ok={b ? b.reviewStatus === 'approved' : null}>{b ? `Review: ${REVIEW_STATUS_LABEL[b.reviewStatus]}` : 'Review: nothing to review without a confirmed booking'}</Check>
        <Check ok={null}>Money: see the three separate figures on the Money tab</Check>
      </ul>
    </section>
  );
}

function BookingFacts({ d, actions }: { d: AccountsDealDetail; actions: FinanceActions }) {
  const b = d.booking;
  if (!b) {
    return (
      <section className="fin-card" aria-labelledby="fin-booking">
        <h2 id="fin-booking">Booking and review</h2>
        <p className="m-0">
          This deal has no confirmed booking. There is nothing to review yet. You can still record receipts on the Receipts tab.
        </p>
      </section>
    );
  }
  const travellers = b.adults === null ? '—' : `${b.adults} ${b.adults === 1 ? 'adult' : 'adults'}${b.children ? `, ${b.children} ${b.children === 1 ? 'child' : 'children'}` : ''}`;
  return (
    <section className="fin-card" aria-labelledby="fin-booking">
      <div className="panel-header m-0">
        <h2 id="fin-booking" className="m-0">
          Booking and review
        </h2>
        <ReviewPill status={b.reviewStatus} />
      </div>
      <p className="hint">Read-only. Accounts never changes the booking.</p>
      <dl className="facts">
        {b.serviceType === 'package' ? null : (
          <>
            <dt>Hotel</dt>
            <dd>{b.hotelName ?? '—'}{b.city ? `, ${b.city}` : ''}</dd>
            <dt>Stay</dt>
            <dd>
              {finDate(b.checkIn)} to {finDate(b.checkOut)}
            </dd>
            <dt>Rooms and travellers</dt>
            <dd>
              {b.rooms ?? '—'} {b.rooms === 1 ? 'room' : 'rooms'} · {travellers}
            </dd>
          </>
        )}
        <dt>Selling total</dt>
        <dd>
          <strong>{b.sellingTotalPaise ? formatInr(b.sellingTotalPaise) : 'Not recorded'}</strong>
          <span className="fin-sub">What Sales agreed with the customer. Not an invoice and not money received.</span>
        </dd>
        <dt>Confirmed</dt>
        <dd>
          {finDateTime(b.confirmedAt)}
          {b.confirmedByName ? ` by ${b.confirmedByName}` : ''} · version {b.versionNo}
        </dd>
        {b.reviewedAt ? (
          <>
            <dt>Last review</dt>
            <dd>
              {REVIEW_STATUS_LABEL[b.reviewStatus]} · {finDateTime(b.reviewedAt)}
              {b.reviewedByName ? ` by ${b.reviewedByName}` : ''}
            </dd>
          </>
        ) : null}
      </dl>
      {b.serviceType === 'package' || b.paymentPlan || b.revision ? <AccountsPackageReview booking={b} /> : null}
      {b.reviewStatus === 'returned' && b.returnReason ? (
        <div className="note warn" role="note">
          <p>
            <strong>Return reason:</strong> <span className="prewrap">{b.returnReason}</span>
          </p>
          <p>Sales sees return reasons in Book now. Only reasons recorded before Sales could see them stay inside Accounts; if this return is that old, tell Sales outside the CRM.</p>
        </div>
      ) : null}
      {b.reviewStatus === 'pending' && b.reviewedAt && d.billing?.status !== 'verified' ? (
        <Notice tone="warning" role="status" className="mb-3" title="Review waiting again">
          <p>The billing details were saved after the last review, so this review is waiting again. Check the billing details, then approve or return the booking.</p>
        </Notice>
      ) : null}
      {b.reviewStatus !== 'approved' ? (
        <div className="fin-review-actions">
          <ApproveReviewForm dealId={d.dealId} booking={b} action={actions.approveReviewAction} />
          <ReturnReviewForm dealId={d.dealId} booking={b} action={actions.returnReviewAction} />
        </div>
      ) : (
        <p className="m-0">Approved. Approval posts no money and issues no document. Saving billing details again puts the review back to waiting.</p>
      )}
    </section>
  );
}

function BillingSection({ d, actions }: { d: AccountsDealDetail; actions: FinanceActions }) {
  const b = d.billing;
  return (
    <section className="fin-card" aria-labelledby="fin-billing">
      <div className="panel-header m-0">
        <h2 id="fin-billing" className="m-0">
          Customer billing details
        </h2>
        <BillingPill status={b?.status ?? null} />
      </div>
      <p className="hint">Sales proposes these in Book now from what the customer gave them. Accounts checks them against the customer’s documents, edits them if needed, then verifies them. The CRM never fills them in from Bitrix.</p>
      {b ? (
        <>
          <dl className="facts">
            {b.billToType !== undefined ? (
              <>
                <dt>Bill To type</dt>
                <dd>{b.billToType === 'business' ? 'Business' : b.billToType === 'personal' ? 'Personal' : 'Not recorded (older booking)'}</dd>
              </>
            ) : null}
            <dt>{b.billToType === 'business' ? 'Company name' : 'Billing name'}</dt>
            <dd>{b.billingName}</dd>
            {b.billToType === 'business' ? (
              <>
                <dt>Contact name</dt>
                <dd>{b.contactPerson ?? 'Not given'}</dd>
              </>
            ) : null}
            {b.billToType !== undefined ? (
              <>
                <dt>Phone · Email</dt>
                <dd>{[b.phone, b.email].filter(Boolean).join(' · ') || 'Not given'}</dd>
              </>
            ) : null}
            <dt>Address</dt>
            <dd>
              {b.addressLine1}
              {b.addressLine2 ? `, ${b.addressLine2}` : ''}, {b.city} {b.postalCode} (state code {b.stateCode})
            </dd>
            {b.billToType === 'business' ? (
              <>
                <dt>GST registration</dt>
                <dd>{b.gstStatus === 'registered' ? 'GST registered' : b.gstStatus === 'unregistered' ? `Not GST registered. Reason: ${b.gstReason ?? 'not given'}` : 'Not chosen yet'}</dd>
              </>
            ) : null}
            <dt>GSTIN</dt>
            <dd>{b.gstin ?? 'None given'}</dd>
            <dt>Last saved</dt>
            <dd>
              {finDateTime(b.updatedAt)}
              {b.updatedByName ? ` by ${b.updatedByName}` : ''}
            </dd>
            {b.verifiedAt ? (
              <>
                <dt>Verified</dt>
                <dd>
                  {finDateTime(b.verifiedAt)}
                  {b.verifiedByName ? ` by ${b.verifiedByName}` : ''}
                </dd>
              </>
            ) : null}
          </dl>
          {b.status === 'draft' ? <VerifyBillingForm dealId={d.dealId} rowVersion={b.rowVersion} action={actions.verifyBillingAction} /> : null}
        </>
      ) : (
        <p>No billing details yet.</p>
      )}
      <details className="form-section work-form" open={!b || undefined}>
        <summary>
          <span className="form-section-title">{b ? 'Edit billing details' : 'Enter billing details'}</span>
        </summary>
        <BillingForm dealId={d.dealId} billing={b} action={actions.saveBillingAction} />
      </details>
    </section>
  );
}

/** Where a bank-transfer or UPI receipt was paid into: the masked snapshot kept on the receipt, or "Unmapped" for older receipts. */
function ReceiptDestination({ r }: { r: ReceiptView }) {
  const dest = r.destination;
  if (!dest) return null;
  return (
    <>
      <dt>Paid into</dt>
      {dest.unmapped ? (
        <dd>
          Unmapped
          <span className="fin-sub">Recorded before company accounts were tracked. No account is guessed for it.</span>
        </dd>
      ) : (
        <dd>
          {dest.label} · {DESTINATION_KIND_LABEL[dest.kind]} · {maskedDestination({ kind: dest.kind, bankName: dest.bankName, accountMasked: dest.accountMasked, upiMasked: dest.upiMasked })} ·
          version {dest.versionNo}
          <span className="fin-sub">As approved when this receipt was recorded. Later changes or retirement do not alter it.</span>
        </dd>
      )}
    </>
  );
}

function ReceiptCard({
  r,
  d,
  actions,
  destinationOptions,
  destinationOptionsUnavailable,
}: {
  r: ReceiptView;
  d: AccountsDealDetail;
  actions: FinanceActions;
  destinationOptions: DestinationOption[];
  destinationOptionsUnavailable: boolean;
}) {
  const headingId = `rcpt-${r.receiptId}`;
  return (
    <li className={`fin-receipt is-${r.status}`} aria-labelledby={headingId}>
      <div className="fin-receipt-head">
        <div>
          <h3 id={headingId} className="m-0">
            {r.receiptNo} · {RECEIPT_MODE_LABEL[r.mode]}
          </h3>
          <p className="offer-meta">Internal receipt number</p>
        </div>
        <p className="fin-receipt-amount m-0">{formatInr(r.amountPaise)}</p>
      </div>
      <ReceiptStatusPill status={r.status} isCheque={r.mode === 'cheque'} rejection={r.rejectionKind} reversal={r.reversalKind} />
      <dl className="facts fin-receipt-facts">
        <dt>Received</dt>
        <dd>
          {finDate(r.receivedOn)} at {r.branchName}
          {r.collectorName ? ` · collected by ${r.collectorName}` : ''}
        </dd>
        <dt>Payer</dt>
        <dd>
          {r.payerName}
          {r.payerPanMasked ? ` · PAN ${r.payerPanMasked}` : ''}
          {r.payerMobileMasked ? ` · mobile ${r.payerMobileMasked}` : ''}
        </dd>
        {r.reference ? (
          <>
            <dt>Reference</dt>
            <dd className="fin-mono">{r.reference}</dd>
          </>
        ) : null}
        <ReceiptDestination r={r} />
        {r.mode === 'cheque' ? (
          <>
            <dt>Cheque</dt>
            <dd>
              No. <span className="fin-mono">{r.chequeNumber ?? '—'}</span> · MICR <span className="fin-mono">{r.micrCode ?? '—'}</span> · dated {finDate(r.chequeDate)}
              {r.outcomeDate ? ` · outcome on ${finDate(r.outcomeDate)}` : ''}
            </dd>
          </>
        ) : null}
        <dt>Recorded</dt>
        <dd>
          {finDateTime(r.recordedAt)}
          {r.recordedByName ? ` by ${r.recordedByName}` : ''} · policy version {r.policyVersionNo}
        </dd>
        {r.verifiedAt ? (
          <>
            <dt>Verified</dt>
            <dd>
              {finDateTime(r.verifiedAt)}
              {r.verifiedByName ? ` by ${r.verifiedByName}` : ''}
            </dd>
          </>
        ) : null}
        {r.reason ? (
          <>
            <dt>Reason</dt>
            <dd className="prewrap">{r.reason}</dd>
          </>
        ) : null}
        {r.correctsReceiptNo ? (
          <>
            <dt>Corrects</dt>
            <dd>{r.correctsReceiptNo}</dd>
          </>
        ) : null}
        {r.correctedByReceiptNo ? (
          <>
            <dt>Corrected by</dt>
            <dd>{r.correctedByReceiptNo}</dd>
          </>
        ) : null}
      </dl>
      <EvidenceList evidence={r.evidence} />
      {['recorded', 'pending_clearance', 'bounced'].includes(r.status) ? <EvidenceUploadForm dealId={d.dealId} receipt={r} action={actions.uploadEvidenceAction} /> : null}
      <ReceiptActionsPanel
        dealId={d.dealId}
        receipt={r}
        detail={d}
        actions={actions}
        destinationOptions={destinationOptions}
        destinationOptionsUnavailable={destinationOptionsUnavailable}
      />
    </li>
  );
}

function liveSummary(d: AccountsDealDetail): string {
  const live = (Object.keys(d.liveModes) as Array<keyof typeof d.liveModes>).filter((m) => d.liveModes[m]).map((m) => RECEIPT_MODE_LABEL[m]);
  return live.length === 0 ? 'No payment mode is available yet.' : `Available: ${live.join(', ')}.`;
}

const NOTHING_WAITING = 'Nothing waiting.';

/** Where the person is sent next (DA-275), in the same order as the default tab. */
function nextOf(d: AccountsDealDetail): { text: string; tab: AccountsDealTab | null; label: string | null } {
  const waiting = d.receipts.filter((r) => r.status === 'recorded').length;
  if (waiting > 0) return { text: 'another Accounts person verifies the receipt', tab: 'receipts', label: waiting === 1 ? 'Open the receipt to verify' : 'Open the receipts to verify' };
  if (d.billing?.status !== 'verified') return { text: 'check the billing details', tab: 'review', label: 'Check billing details' };
  if (d.booking?.reviewStatus === 'pending') return { text: 'approve or return the booking', tab: 'review', label: 'Review the booking' };
  if (d.booking?.reviewStatus === 'returned') return { text: 'Sales fixes the returned booking and sends it again', tab: null, label: null };
  return { text: NOTHING_WAITING, tab: null, label: null };
}

/**
 * The open tab: `?tab=` when it is one of the four (server allowlist),
 * otherwise the tab of the next action (accountsDealDefaultTab; lead ruling
 * D6: billing sits on Review). `fromAddress` false = the address had no
 * valid tab.
 */
export function accountsDealTabOf(d: AccountsDealDetail, tabParam: string | string[] | undefined): { tab: AccountsDealTab; fromAddress: boolean } {
  const fallback = accountsDealDefaultTab({
    receiptsAwaitingVerification: d.receipts.filter((r) => r.status === 'recorded').length,
    billingVerified: d.billing?.status === 'verified',
    reviewWaiting: d.booking?.reviewStatus === 'pending',
  });
  const tab = parseAccountsDealTab(tabParam, fallback);
  const raw = Array.isArray(tabParam) ? tabParam[0] : tabParam;
  return { tab, fromAddress: raw === tab };
}

function MoneyTab({
  d,
  claimActions,
  destinationOptions,
  destinationOptionsUnavailable,
  openClaimId,
}: {
  d: AccountsDealDetail;
  claimActions?: ClaimActions;
  destinationOptions: DestinationOption[];
  destinationOptionsUnavailable: boolean;
  openClaimId?: string;
}) {
  return (
    <>
      <section className="fin-card" aria-labelledby="fin-money-heading">
        <h2 id="fin-money-heading">Money for this deal</h2>
        <MoneyFigures money={d.money} headingId="fin-money-heading" />
      </section>
      {claimActions && d.claims ? (
        <AccountsClaimsSection detail={d} actions={claimActions} destinationOptions={destinationOptions} destinationOptionsUnavailable={destinationOptionsUnavailable} openClaimId={openClaimId} />
      ) : null}
    </>
  );
}

function ReceiptsTab({
  d,
  actions,
  destinationOptions,
  destinationOptionsUnavailable,
}: {
  d: AccountsDealDetail;
  actions: FinanceActions;
  destinationOptions: DestinationOption[];
  destinationOptionsUnavailable: boolean;
}) {
  const anyAllowed = Object.values(d.modesAllowed).some(Boolean);
  return (
    <>
      <section className="fin-card" aria-labelledby="fin-receipts">
        <h2 id="fin-receipts">Customer receipts</h2>
        <p className="hint">
          Each receipt needs a second Accounts person to verify it. Nothing here refunds the customer or creates an invoice. {liveSummary(d)}
        </p>
        {d.receipts.length === 0 ? (
          <p>No receipts recorded for this deal yet.</p>
        ) : (
          <ol className="fin-receipt-list" aria-label="Receipts, newest first">
            {d.receipts.map((r) => (
              <ReceiptCard key={r.receiptId} r={r} d={d} actions={actions} destinationOptions={destinationOptions} destinationOptionsUnavailable={destinationOptionsUnavailable} />
            ))}
          </ol>
        )}
      </section>

      <section className="fin-card" aria-labelledby="fin-record">
        <h2 id="fin-record">Record a receipt</h2>
        {!anyAllowed ? (
          <Notice tone="warning" className="mb-3" title="No payment mode is available yet.">
            <p>Payment modes are switched on by the CRM team with the owner’s approval, after the CA confirms the rules. You can still verify receipts that were already recorded.</p>
          </Notice>
        ) : null}
        <RecordReceiptForm detail={d} action={actions.recordReceiptAction} destinationOptions={destinationOptions} destinationOptionsUnavailable={destinationOptionsUnavailable} />
      </section>
    </>
  );
}

/** Documents tab: ID proofs (route slot) and the private proof files of this deal's receipts. Accounts only (the page refuses everyone else). */
function DocumentsTab({ d, documents }: { d: AccountsDealDetail; documents?: ReactNode }) {
  const withFiles = d.receipts.filter((r) => r.evidence.some((e) => e.status !== 'removed'));
  return (
    <>
      {documents}
      <section className="fin-card" aria-labelledby="fin-documents">
        <h2 id="fin-documents">Receipt proof files</h2>
        <p id="fin-documents-hint" className="hint">
          Bank proofs and cheque images for this deal’s receipts. Private: only Accounts can open them, and each opening is recorded.
        </p>
        {withFiles.length === 0 ? (
          <p className="m-0">No receipt proof files on this deal yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Proof files by receipt">
            {withFiles.map((r) => (
              <li key={r.receiptId} className="m-0">
                <p className="m-0 font-semibold text-ink">
                  {r.receiptNo} · {RECEIPT_MODE_LABEL[r.mode]}
                </p>
                <EvidenceList evidence={r.evidence} label={`Proof files of ${r.receiptNo}`} describedBy="fin-documents-hint" />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function AccountsDealView({
  detail,
  actions,
  destinationOptions = [],
  destinationOptionsUnavailable = false,
  claimActions,
  openClaimId,
  tabParam,
  documents,
  tabHref,
}: {
  detail: AccountsDealDetail;
  actions: FinanceActions;
  /** B1.1: Sales advance claims (present when the claims commands exist). */
  claimActions?: ClaimActions;
  /** Preview gallery only. */
  openClaimId?: string;
  /** Approved current company accounts a new bank-transfer or UPI receipt may select (masked). */
  destinationOptions?: DestinationOption[];
  /** The company-accounts read was refused; the receipt form says so instead of "none approved". */
  destinationOptionsUnavailable?: boolean;
  /** Raw `?tab=` from the address (Batch 4 DA-15); allowlisted here, else the tab of the next action. */
  tabParam?: string | string[];
  /** Documents tab content from the route (traveller ID proofs). */
  documents?: ReactNode;
  /** Preview gallery only: where each tab link points. Routes omit it. */
  tabHref?: (tab: AccountsDealTab) => string;
}) {
  const d = detail;
  const { tab, fromAddress } = accountsDealTabOf(d, tabParam);
  const base = `/app/accounts/deals/${d.dealId}`;
  const hrefOf = (t: AccountsDealTab) => tabHref?.(t) ?? `${base}?tab=${t}`;
  const next = nextOf(d);
  // One primary per screen: Review and Receipts carry their own actions, so the
  // header link to the next action shows only on Money and Documents.
  const primary =
    next.tab && next.label && next.tab !== tab && (tab === 'money' || tab === 'documents') ? (
      <Link href={hrefOf(next.tab)} className={buttonVariants({ variant: 'primary' })}>
        {next.label}
      </Link>
    ) : undefined;
  return (
    <>
      {fromAddress || tabHref ? null : <KeepTabInAddress tab={tab} />}
      <FinanceHeader
        eyebrow={`Accounts · ${d.branchName}`}
        title={<span className="block wrap-anywhere">{`${d.dealReference} · ${d.dealTitle}`}</span>}
        status={
          <>
            {d.booking ? <ReviewPill status={d.booking.reviewStatus} /> : null}
            <BillingPill status={d.billing?.status ?? null} />
            {d.isSynthetic ? (
              <StatusBadge tone="warning" icon={FlaskConical}>
                Synthetic test deal
              </StatusBadge>
            ) : null}
          </>
        }
        actions={primary ? <div data-slot="accounts-deal-primary">{primary}</div> : undefined}
      >
        <p data-slot="accounts-deal-next">
          {next.tab === null && next.label === null && next.text === NOTHING_WAITING ? (
            NOTHING_WAITING
          ) : (
            <>
              <span className="font-semibold text-ink">Next:</span> {next.text}
            </>
          )}
        </p>
        <p className="text-sm">
          <Link href="/app/accounts" className={LINK_CLASS}>
            Back to To check
          </Link>
        </p>
      </FinanceHeader>

      <Tabs label="Accounts deal sections" className="mb-4" items={ACCOUNTS_DEAL_TABS.map((t) => ({ href: hrefOf(t), label: ACCOUNTS_DEAL_TAB_LABEL[t], current: t === tab }))} />

      <div data-slot="accounts-deal-tab" data-tab={tab}>
        {tab === 'money' ? (
          <MoneyTab d={d} claimActions={claimActions} destinationOptions={destinationOptions} destinationOptionsUnavailable={destinationOptionsUnavailable} openClaimId={openClaimId} />
        ) : tab === 'review' ? (
          <>
            <div className="fin-grid">
              <Readiness d={d} />
              <BookingFacts d={d} actions={actions} />
            </div>
            <BillingSection d={d} actions={actions} />
          </>
        ) : tab === 'receipts' ? (
          <ReceiptsTab d={d} actions={actions} destinationOptions={destinationOptions} destinationOptionsUnavailable={destinationOptionsUnavailable} />
        ) : (
          <DocumentsTab d={d} documents={documents} />
        )}
      </div>
    </>
  );
}
