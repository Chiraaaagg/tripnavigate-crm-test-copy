import { CircleCheck, FlaskConical, ListEnd, Lock, ReceiptText, SearchX, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { AccountsClaimsSection, type ClaimActions } from './b11/accounts-claims';
import { AccountsPackageReview } from './b11/accounts-review';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Fold } from '@/components/ui/fold';
import { Notice } from '@/components/ui/notice';
import { QueueToolbar } from '@/components/ui/queue-toolbar';
import { RecordHeader, type NextButton } from '@/components/ui/record-header';
import { StateBlock } from '@/components/ui/state-block';
import { Tabs } from '@/components/ui/tabs';
import { accountsDealDefaultTab } from '@/modules/settings/contracts';
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
  REVIEW_RETURN_BLOCK_TEXT,
} from '@/modules/finance/contracts';
import {
  ACCOUNTS_DEAL_PAGE_TAB_LABEL,
  ACCOUNTS_DEAL_PAGE_TABS,
  type AccountsDealPageTab,
  BILLING_STATUS_LABEL,
  BillingPill,
  EvidenceList,
  FinanceDisclaimer,
  FinanceHeader,
  finDate,
  finDateTime,
  formatInr,
  isZero,
  maskedDestination,
  MoneyFigures,
  parseAccountsDealPageTab,
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
  ReturnReviewForm,
  VerifyBillingForm,
} from './finance-forms';
import { ReceiptRowAction, RecordReceiptDrawer, verifyButtonId } from './finance-receipt-forms';
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

/**
 * The result of the one search (R4): the queue's search box asks the server for
 * the exact reference (accounts_deal_lookup), so a deal that is not in the list
 * can still be opened, for example to record a receipt.
 */
function LookupResult({ lookup }: { lookup: LookupOutcome }) {
  if (!lookup) return null;
  return (
    <div className="mb-4 rounded-control border border-line bg-card px-3.5 py-3 font-sans" role="status" data-slot="accounts-lookup">
      {lookup.result ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="m-0 font-semibold text-ink wrap-anywhere">
              {lookup.result.dealReference} · {lookup.result.dealTitle}
            </p>
            <p className="m-0 text-sm text-quiet">
              {lookup.result.branchName} · {lookup.result.hasConfirmedBooking ? 'Has a confirmed booking' : 'No confirmed booking yet; receipts can still be recorded'}
            </p>
          </div>
          <Link href={`/app/accounts/deals/${lookup.result.dealId}`} className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'shrink-0')}>
            Open {lookup.result.dealReference}
          </Link>
        </div>
      ) : (
        <p className="m-0">No deal with the exact reference “{lookup.reference}” in your companies. Check the reference and try again.</p>
      )}
    </div>
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
 * DA-274 and R4 (C2): the queue filters are chips of one toolbar with the one
 * search. Every `?filter=` value is kept; the first four chips show and the
 * rest sit under "More". The count shows on the open filter only (lead ruling
 * D7: accounts_queue counts the current filter; no extra read for the others).
 * The search is the exact-reference lookup (`?ref=`), as before.
 */
function QueueBar({ current, total, reference }: { current: AccountsQueueFilter; total: number; reference: string }) {
  return (
    <QueueToolbar
      action="/app/accounts"
      label="Find a deal to check"
      chipsLabel="To check filters"
      search={{ name: 'ref', value: reference, label: 'Find a deal by its exact reference', placeholder: 'Exact deal reference' }}
      keep={current === DEFAULT_QUEUE_FILTER ? undefined : { filter: current }}
      chips={QUEUE_FILTERS.map((f) => ({ href: accountsQueueHref(f.value), label: f.label, current: f.value === current, count: f.value === current ? total : undefined }))}
    />
  );
}

/** What a queue row asks next, with its one row button (design plan 2.3, To check). */
export function queueRowNext(i: AccountsQueueItem): { text: string; button: { label: string; tab: AccountsDealPageTab } | null } {
  if (!isZero(i.money.awaitingVerificationPaise)) return { text: 'A receipt waits for a second Accounts person', button: { label: 'Verify', tab: 'receipts' } };
  if (i.hasConfirmedBooking && i.billingStatus !== 'verified') return { text: 'Check the billing details', button: { label: 'Review', tab: 'review' } };
  if (i.reviewStatus === 'pending') return { text: 'Approve or return the booking', button: { label: 'Review', tab: 'review' } };
  if (i.reviewStatus === 'returned') return { text: 'Sales fixes the returned booking and sends it again', button: null };
  if (!isZero(i.money.chequesAwaitingClearancePaise)) return { text: 'A cheque waits for bank clearance', button: { label: 'Open', tab: 'receipts' } };
  return { text: 'Nothing waiting', button: null };
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
  sectionTabs,
}: {
  items: AccountsQueueItem[];
  filter: AccountsQueueFilter;
  lookup?: LookupOutcome;
  /** Omitted only by callers that already hold the whole queue (totalCount = items.length). */
  paging?: AccountsQueuePaging;
  /** D5: the To check section tabs, placed under the page header (the page builds them for the viewer). */
  sectionTabs?: ReactNode;
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
      {sectionTabs}
      <QueueBar current={filter} total={total} reference={lookup?.reference ?? ''} />
      <LookupResult lookup={lookup} />
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
        <div className="table-scroll" role="region" aria-label={`Deals to check · ${label}`} tabIndex={0}>
          <table className="stack-table fin-queue">
            <caption>
              {partial ? `Showing ${items.length} of ${total} ${total === 1 ? 'deal' : 'deals'}` : `${items.length} ${items.length === 1 ? 'deal' : 'deals'}`} · {label}
            </caption>
            <thead>
              <tr>
                <th scope="col">Deal</th>
                <th scope="col">Available</th>
                <th scope="col">Awaiting verification</th>
                <th scope="col">Cheques awaiting clearance</th>
                <th scope="col">Status</th>
                <th scope="col">Next step</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const next = queueRowNext(i);
                return (
                  <tr key={i.dealId}>
                    <td data-label="Deal">
                      <Link href={`/app/accounts/deals/${i.dealId}`}>
                        <strong>{i.dealReference}</strong>
                        <span className="visually-hidden"> — open in Accounts</span>
                      </Link>
                      <span className="fin-sub">{i.dealTitle}</span>
                      <span className="fin-sub">
                        {i.branchName} · {i.hasConfirmedBooking ? 'Confirmed booking' : 'No confirmed booking'}
                      </span>
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
                    <td data-label="Status">
                      <ReviewPill status={i.reviewStatus} />
                      <span className="fin-sub">Billing details: {i.billingStatus ? BILLING_STATUS_LABEL[i.billingStatus].toLowerCase() : 'not entered yet'}</span>
                    </td>
                    <td data-label="Next step">
                      <div className="flex flex-col items-start gap-1.5">
                        <span className="text-sm text-copy">{next.text}</span>
                        {next.button ? (
                          <Link href={`/app/accounts/deals/${i.dealId}?tab=${next.button.tab}`} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                            {next.button.label}
                            <span className="visually-hidden"> {i.dealReference}</span>
                          </Link>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
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
        <Check ok={null}>Money: see the three separate figures on the Receipts tab</Check>
      </ul>
    </section>
  );
}

function BookingFacts({ d, actions }: { d: AccountsDealDetail; actions: FinanceActions }) {
  const b = d.booking;
  if (!b) {
    return (
      <section id="fin-booking-section" className="fin-card" aria-labelledby="fin-booking">
        <h2 id="fin-booking">Booking and review</h2>
        <p className="m-0">
          This deal has no confirmed booking. There is nothing to review yet. You can still record receipts on the Receipts tab.
        </p>
      </section>
    );
  }
  const travellers = b.adults === null ? '—' : `${b.adults} ${b.adults === 1 ? 'adult' : 'adults'}${b.children ? `, ${b.children} ${b.children === 1 ? 'child' : 'children'}` : ''}`;
  return (
    <section id="fin-booking-section" className="fin-card" aria-labelledby="fin-booking">
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
      {!b.canReturn && b.returnBlock ? (
        <Notice tone="locked" className="mb-3" title="Return to Sales is not possible">
          <p>{REVIEW_RETURN_BLOCK_TEXT[b.returnBlock]}</p>
        </Notice>
      ) : null}
      {b.reviewStatus === 'pending' && b.reviewedAt && d.billing?.status !== 'verified' ? (
        <Notice tone="warning" role="status" className="mb-3" title="Review waiting again">
          <p>The billing details were saved after the last review, so this review is waiting again. Check the billing details, then approve or return the booking.</p>
        </Notice>
      ) : null}
      {b.reviewStatus !== 'approved' ? (
        <div className="fin-review-actions">
          <ApproveReviewForm dealId={d.dealId} booking={b} action={actions.approveReviewAction} />
          {/* Accounts phase 0 (contract 5.2, 11.4): the Return button is hidden once the Deal is committed; the reason says what to do instead. */}
          {b.canReturn ? <ReturnReviewForm dealId={d.dealId} booking={b} action={actions.returnReviewAction} /> : null}
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
    <section id="fin-billing-section" className="fin-card" aria-labelledby="fin-billing">
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

const AWAITING: ReceiptView['status'][] = ['recorded', 'pending_clearance', 'bounced'];

/** Receipts as rows (design plan 2.3): awaiting receipts first, otherwise the order the database gives (newest first). */
export function orderReceipts(receipts: ReceiptView[]): ReceiptView[] {
  const awaiting = receipts.filter((r) => AWAITING.includes(r.status));
  return [...awaiting, ...receipts.filter((r) => !AWAITING.includes(r.status))];
}

function ReceiptFacts({ r }: { r: ReceiptView }) {
  return (
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
  );
}

function ReceiptRows({
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
  if (d.receipts.length === 0) {
    return <StateBlock kind="empty" icon={ReceiptText} headingLevel={3} title="No receipts yet" text="No receipts recorded for this deal yet. Use “Record a receipt” at the top when the customer pays." />;
  }
  return (
    <div className="table-scroll" role="region" aria-label={`Receipts of ${d.dealReference}`} tabIndex={0}>
      <table className="stack-table fin-receipt-rows">
        <caption className="visually-hidden">Customer receipts, awaiting first, then newest</caption>
        <thead>
          <tr>
            <th scope="col">Receipt</th>
            <th scope="col">Received</th>
            <th scope="col">Amount</th>
            <th scope="col">Status</th>
            <th scope="col">Proof</th>
            <th scope="col">Next step</th>
          </tr>
        </thead>
        {orderReceipts(d.receipts).map((r) => {
          const files = r.evidence.filter((e) => e.status !== 'removed').length;
          return (
            <tbody key={r.receiptId} id={`rcpt-${r.receiptId}`} className={`fin-receipt is-${r.status}`}>
              <tr>
                <td data-label="Receipt">
                  <span className="font-semibold whitespace-nowrap text-ink">{r.receiptNo}</span> <span className="text-copy">· {RECEIPT_MODE_LABEL[r.mode]}</span>
                </td>
                <td data-label="Received">
                  <span className="whitespace-nowrap">{finDate(r.receivedOn)}</span>
                </td>
                <td data-label="Amount" className="fin-num">
                  {formatInr(r.amountPaise)}
                </td>
                <td data-label="Status">
                  <ReceiptStatusPill status={r.status} isCheque={r.mode === 'cheque'} rejection={r.rejectionKind} reversal={r.reversalKind} />
                  <span className="fin-sub">{r.verifiedByName ? `Verified by ${r.verifiedByName}` : r.recordedByName ? `Recorded by ${r.recordedByName}` : 'Recorded'}</span>
                </td>
                <td data-label="Proof">{files > 0 ? `${files} ${files === 1 ? 'file' : 'files'}` : <span className="text-quiet">No proof</span>}</td>
                <td data-label="Next step">
                  <ReceiptRowAction dealId={d.dealId} receipt={r} actions={actions} />
                </td>
              </tr>
              <tr className="fin-receipt-details">
                <td colSpan={6}>
                  <Fold flat summary={<>Details<span className="visually-hidden"> of receipt {r.receiptNo}</span></>} meta="Facts, proof files and other actions">
                    <ReceiptFacts r={r} />
                    <EvidenceList evidence={r.evidence} label={`Proof files of ${r.receiptNo}`} />
                    {AWAITING.includes(r.status) ? <EvidenceUploadForm dealId={d.dealId} receipt={r} action={actions.uploadEvidenceAction} /> : null}
                    <ReceiptActionsPanel
                      dealId={d.dealId}
                      receipt={r}
                      detail={d}
                      actions={actions}
                      destinationOptions={destinationOptions}
                      destinationOptionsUnavailable={destinationOptionsUnavailable}
                      inRow
                    />
                  </Fold>
                </td>
              </tr>
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

function liveSummary(d: AccountsDealDetail): string {
  const live = (Object.keys(d.liveModes) as Array<keyof typeof d.liveModes>).filter((m) => d.liveModes[m]).map((m) => RECEIPT_MODE_LABEL[m]);
  return live.length === 0 ? 'No payment mode is available yet.' : `Available: ${live.join(', ')}.`;
}

/**
 * The open tab: `?tab=` when it is one of the five, an old value through its
 * alias (`money` → Receipts), otherwise the tab of the next action
 * (accountsDealDefaultTab; lead ruling D6: billing sits on Review).
 * `fromAddress` false = the address did not name the open tab exactly.
 */
export function accountsDealTabOf(d: AccountsDealDetail, tabParam: string | string[] | undefined): { tab: AccountsDealPageTab; fromAddress: boolean } {
  // The Batch 4 rule (settings/contracts.ts) answers Receipts or Review; its type also allows the old Money tab.
  const next = accountsDealDefaultTab({
    receiptsAwaitingVerification: d.receipts.filter((r) => r.status === 'recorded').length,
    billingVerified: d.billing?.status === 'verified',
    reviewWaiting: d.booking?.reviewStatus === 'pending',
  });
  return parseAccountsDealPageTab(tabParam, parseAccountsDealPageTab(next, 'receipts').tab);
}

type HeaderNext = { text: ReactNode; button?: NextButton } | null;

/**
 * "Next:" in the record header (DA-275, design plan 2.3), in the same order as
 * the default tab. A receipt this person may verify comes first (the button
 * jumps to its row on Receipts); a receipt only someone else may verify says
 * so. When nothing else waits, "Record a receipt" at the top is the one
 * primary action.
 */
export function accountsDealNext(d: AccountsDealDetail, tab: AccountsDealPageTab, hrefOf: (t: AccountsDealPageTab) => string): HeaderNext {
  const waiting = orderReceipts(d.receipts).filter((r) => r.status === 'recorded');
  const mine = waiting.find((r) => (r.actions.verify ?? null) === null);
  if (mine) {
    return {
      text: `verify receipt ${mine.receiptNo} (${formatInr(mine.amountPaise)}, ${RECEIPT_MODE_LABEL[mine.mode]})`,
      button: tab === 'receipts' ? { label: 'Verify receipt', jumpTo: verifyButtonId(mine.receiptId) } : { label: 'Verify receipt', href: hrefOf('receipts') },
    };
  }
  if (waiting.length > 0) {
    // Nobody approves their own work: the recorder (or the Deal's owner or seller) waits for a colleague.
    const otherPerson = waiting.every((r) => r.actions.verify === 'own_record' || r.actions.verify === 'deal_conflict');
    if (otherPerson) return { text: `another Accounts person verifies ${waiting.length === 1 ? 'the receipt' : 'the receipts'} waiting on this deal.` };
    return {
      text: `${waiting.length === 1 ? 'the receipt waiting here cannot' : 'the receipts waiting here cannot'} be verified yet; each row says why.`,
      button: tab === 'receipts' ? undefined : { label: 'Open the receipts', href: hrefOf('receipts') },
    };
  }
  if (d.billing?.status !== 'verified') {
    return { text: 'check the billing details', button: tab === 'review' ? { label: 'Check billing details', jumpTo: 'fin-billing-section' } : { label: 'Check billing details', href: hrefOf('review') } };
  }
  if (d.booking?.reviewStatus === 'pending') {
    return { text: 'approve or return the booking', button: tab === 'review' ? { label: 'Review the booking', jumpTo: 'fin-booking-section' } : { label: 'Review the booking', href: hrefOf('review') } };
  }
  if (d.booking?.reviewStatus === 'returned') return { text: 'Sales fixes the returned booking and sends it again.' };
  return { text: 'nothing waiting. Record a receipt when the customer pays.' };
}

function ReceiptsTab({
  d,
  actions,
  claimActions,
  destinationOptions,
  destinationOptionsUnavailable,
  openClaimId,
}: {
  d: AccountsDealDetail;
  actions: FinanceActions;
  claimActions?: ClaimActions;
  destinationOptions: DestinationOption[];
  destinationOptionsUnavailable: boolean;
  openClaimId?: string;
}) {
  return (
    <>
      <section className="mb-5" aria-labelledby="fin-money-heading">
        <h2 id="fin-money-heading" className="visually-hidden">
          Money for this deal
        </h2>
        <MoneyFigures money={d.money} headingId="fin-money-heading" />
      </section>
      <section className="fin-card" aria-labelledby="fin-receipts">
        <h2 id="fin-receipts">Customer receipts</h2>
        <p className="hint">
          A second Accounts person verifies each receipt; verifying confirms the money arrived, matching the proof. Nothing here refunds the customer or creates an invoice. {liveSummary(d)}
        </p>
        <ReceiptRows d={d} actions={actions} destinationOptions={destinationOptions} destinationOptionsUnavailable={destinationOptionsUnavailable} />
      </section>
      {claimActions && d.claims ? (
        <AccountsClaimsSection detail={d} actions={claimActions} destinationOptions={destinationOptions} destinationOptionsUnavailable={destinationOptionsUnavailable} openClaimId={openClaimId} />
      ) : null}
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

/** Dues and plan: the Deal's Customer dues card (route slot), with the way to the Dues list. */
function DuesTab({ dues }: { dues?: ReactNode }) {
  return (
    <>
      {dues ?? <StateBlock kind="unknown" title="Dues not shown" text="The dues of this deal are not available here. Open Customer dues to find them." />}
      <p className="m-0 mt-3 font-sans text-sm text-quiet">
        Instalments are a plan, not money received. Only verified receipts reduce a due; the Deal’s salesperson follows up.{' '}
        <Link href="/app/accounts/dues" className={LINK_CLASS}>
          Open Customer dues
        </Link>
      </p>
    </>
  );
}

/** Refunds: the Deal's Refunds card (route slot), with the way to the Refunds list. */
function RefundsTab({ refunds }: { refunds?: ReactNode }) {
  return (
    <>
      {refunds ?? <StateBlock kind="empty" icon={Undo2} headingLevel={2} title="No refunds on this deal" text="A refund appears here after the branch Manager approves a cancellation or a change." />}
      <p className="m-0 mt-3 font-sans text-sm text-quiet">
        Refunds are paid and verified on{' '}
        <Link href="/app/accounts/refunds" className={LINK_CLASS}>
          Refunds
        </Link>
        ; a different Accounts person verifies each one.
      </p>
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
  dues,
  refunds,
  tabHref,
  recordOpen = false,
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
  /** Raw `?tab=` from the address; allowlisted here (old `money` opens Receipts), else the tab of the next action. */
  tabParam?: string | string[];
  /** Documents tab content from the route (traveller ID proofs; Accounts phase 2: customer documents). */
  documents?: ReactNode;
  /** Dues and plan tab content from the route (the Deal's Customer dues card). */
  dues?: ReactNode;
  /** Refunds tab content from the route (the Deal's Refunds card); null or absent = none for this viewer. */
  refunds?: ReactNode;
  /** Preview gallery only: where each tab link points. Routes omit it. */
  tabHref?: (tab: AccountsDealPageTab) => string;
  /** Preview gallery only: the receipt drawer starts open. */
  recordOpen?: boolean;
}) {
  const d = detail;
  const { tab, fromAddress } = accountsDealTabOf(d, tabParam);
  const base = `/app/accounts/deals/${d.dealId}`;
  const hrefOf = (t: AccountsDealPageTab) => tabHref?.(t) ?? `${base}?tab=${t}`;
  const next = accountsDealNext(d, tab, hrefOf);
  const waiting = d.receipts.filter((r) => r.status === 'recorded').length;
  const b = d.booking;
  return (
    <>
      {fromAddress || tabHref ? null : <KeepTabInAddress tab={tab} />}
      <RecordHeader
        back={{ href: '/app/accounts', label: 'To check' }}
        // The reference stays in the one h1 (as before), so the page name says which deal it is.
        title={<span className="block wrap-anywhere">{`${d.dealReference} · ${d.dealTitle}`}</span>}
        status={
          <>
            {b ? <ReviewPill status={b.reviewStatus} /> : null}
            <BillingPill status={d.billing?.status ?? null} />
            {d.isSynthetic ? (
              <StatusBadge tone="warning" icon={FlaskConical}>
                Synthetic test deal
              </StatusBadge>
            ) : null}
          </>
        }
        next={next}
        actions={
          <div data-slot="accounts-deal-primary">
            <RecordReceiptDrawer
              detail={d}
              action={actions.recordReceiptAction}
              destinationOptions={destinationOptions}
              destinationOptionsUnavailable={destinationOptionsUnavailable}
              primary={!next?.button}
              defaultOpen={recordOpen}
            />
          </div>
        }
        details={
          <dl className="facts m-0">
            <dt>Branch</dt>
            <dd>{d.branchName}</dd>
            <dt>Booking</dt>
            <dd>{b ? `Confirmed ${finDateTime(b.confirmedAt)}${b.confirmedByName ? ` by ${b.confirmedByName}` : ''} · version ${b.versionNo}` : 'No confirmed booking yet; receipts can still be recorded'}</dd>
          </dl>
        }
        className="mb-3"
      />
      <div className="mb-4">
        <FinanceDisclaimer />
      </div>

      <Tabs
        variant="pill"
        label="Accounts deal sections"
        className="mb-4"
        items={ACCOUNTS_DEAL_PAGE_TABS.map((t) => ({ href: hrefOf(t), label: ACCOUNTS_DEAL_PAGE_TAB_LABEL[t], current: t === tab, count: t === 'receipts' && waiting > 0 ? waiting : undefined }))}
      />

      <div data-slot="accounts-deal-tab" data-tab={tab}>
        {tab === 'receipts' ? (
          <ReceiptsTab
            d={d}
            actions={actions}
            claimActions={claimActions}
            destinationOptions={destinationOptions}
            destinationOptionsUnavailable={destinationOptionsUnavailable}
            openClaimId={openClaimId}
          />
        ) : tab === 'dues' ? (
          <DuesTab dues={dues} />
        ) : tab === 'refunds' ? (
          <RefundsTab refunds={refunds} />
        ) : tab === 'review' ? (
          <>
            <div className="fin-grid">
              <Readiness d={d} />
              <BookingFacts d={d} actions={actions} />
            </div>
            <BillingSection d={d} actions={actions} />
          </>
        ) : (
          <DocumentsTab d={d} documents={documents} />
        )}
      </div>
    </>
  );
}
