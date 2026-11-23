import { CheckCheck, GitCompareArrows } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { inr, whenText } from '@/views/accounts-desk/labels';
import { DEPARTMENT_WORD, KIND_WORD, REFUSAL_TEXT, ROUTE_WORD, STATUS_TONE, STATUS_WORD } from './labels';
import { itemNosText } from './rules';
import { RowDecision } from '@/views/department/row-decision';
import { ChangeReviewPanel } from './review';
import type { ChangeRequestListRow, ChangeRequestsPage, ChangeReviewView, RemovalChargesView } from './types';

/*
 * Approvals › Change requests (contract 10.3 G4, 10.5 R-G2, 11.3 R-H1,
 * screen 15.10). The branch Manager approves or returns each request; this
 * is the only approval of a change (owner Q7). A booked removal shows the
 * supplier charges table (what the supplier keeps and what comes back) with
 * the customer charge, and cannot be approved until every department
 * entered its charges (`charges_missing`). The requester never approves
 * their own request (`not_self_approval`). The Sales owner sees their own
 * Deals read-only; Accounts reads every request of the entity.
 *
 * Redesign R3 (DM-25): Approve and "Return with reason" sit in a footer
 * that stays in view (sticky) while the Manager reads a long review. Approve
 * still confirms in a dialog before it posts (as before); the reason box
 * opens only after "Return with reason".
 */

export interface ChangeDecideActions {
  decide: DecisionAction;
}

export interface DecidePreviewOpen {
  requestId: string;
  dialog: 'approve' | 'return';
  state?: DeskResult | null;
}

export function ChangeRequestsApprovals({
  page,
  charges,
  reviews,
  actions,
  nextHref,
  viewer,
  open,
  headingLevel = 2,
}: {
  /** Addendum O2 (R-H2): the old and new booking side by side per waiting request, keyed by change request id. */
  reviews?: Record<string, ChangeReviewView | 'error'>;
  /** Level of each request's heading: 2 directly under the page title, 3 inside a titled tab section. */
  headingLevel?: 2 | 3;
  page: ChangeRequestsPage | 'error';
  /** R-H1 per booked removal (Manager only), keyed by change request id. */
  charges?: Record<string, RemovalChargesView | 'error'>;
  actions: ChangeDecideActions | null;
  nextHref?: string | null;
  viewer: 'manager' | 'sales' | 'accounts';
  open?: DecidePreviewOpen;
}) {
  if (page === 'error') {
    return (
      <Notice tone="warning" role="status" title="Change requests could not be loaded">
        <p>Nothing was changed. Reload the page.</p>
      </Notice>
    );
  }
  if (page.items.length === 0) {
    return (
      <EmptyState
        icon={CheckCheck}
        headingLevel={headingLevel}
        title={viewer === 'manager' ? 'No change waiting for you' : 'No change requests'}
        description={viewer === 'manager' ? 'When a Sales owner asks to change, add or remove a confirmed service, it appears here for your decision.' : 'Change requests on your Deals appear here with their status.'}
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {viewer !== 'manager' ? (
        <Notice tone="locked">
          <p>{viewer === 'accounts' ? 'Read only for Accounts. The branch Manager decides.' : 'The branch Manager decides. You see your own Deals here.'}</p>
        </Notice>
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {page.items.map((r) => (
          <li key={r.id}>
            <ApprovalRow r={r} charges={charges?.[r.id]} review={reviews?.[r.id]} actions={actions} open={open?.requestId === r.id ? open : undefined} headingLevel={headingLevel} />
          </li>
        ))}
      </ul>
      {page.hasMore && nextHref ? (
        <Link href={nextHref} rel="next" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
          Show more requests
        </Link>
      ) : null}
    </div>
  );
}

function decideBlocked(r: ChangeRequestListRow, review?: ChangeReviewView | 'error'): string | null {
  if (r.status !== 'requested') return 'Not waiting for a decision.';
  if (r.kind === 'remove_service' && r.removalRoute === 'cancellation' && r.chargesComplete === false) return REFUSAL_TEXT.charges_missing!;
  if (!r.can.approve) return 'You asked for this change or are not its approver. Another Manager decides.';
  // Addendum O2: the approval binds the exact version shown; no approval without seeing it.
  if (review === 'error') return 'The old and new booking did not load. Reload the page before deciding.';
  if (review && !review.proposed) return 'The Sales owner has not filled in the change yet.';
  if (review && !review.sentVersionCurrent) return 'The booking was edited after it was sent. Wait until the Sales owner sends it again.';
  if (review && !review.canDecide) return 'You cannot decide this one. Another Manager decides.';
  return null;
}

function ApprovalRow({ r, charges, review, actions, open, headingLevel }: { r: ChangeRequestListRow; charges?: RemovalChargesView | 'error'; review?: ChangeReviewView | 'error'; actions: ChangeDecideActions | null; open?: DecidePreviewOpen; headingLevel: 2 | 3 }) {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  const fields = { changeRequestId: r.id, expectedRowVersion: r.rowVersion };
  const blocked = decideBlocked(r, review);
  const versionNo = review && review !== 'error' ? (review.proposed?.versionNo ?? null) : null;
  const showDecide = r.status === 'requested' && (r.can.approve || r.can.return || r.chargesComplete === false);
  return (
    <article aria-labelledby={`cra-${r.id}`} className="flex flex-col gap-3 rounded-card border border-line bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <H id={`cra-${r.id}`} className="m-0 text-base font-semibold text-ink">
          {KIND_WORD[r.kind]} {r.refNo}
          {' · '}
          <Link href={`/app/deals/${r.dealId}#changes`} className="text-brand-strong underline-offset-4 hover:underline">
            {r.dealReference}
          </Link>
        </H>
        <StatusBadge tone={STATUS_TONE[r.status]} wrap>
          {STATUS_WORD[r.status]}
        </StatusBadge>
      </div>
      <dl className="m-0 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(7rem,10rem)_1fr]">
        {r.dealTitle ? (
          <>
            <dt className="text-quiet">Deal</dt>
            <dd className="m-0 text-ink">
              {r.dealTitle} · {r.branchName}
            </dd>
          </>
        ) : null}
        <dt className="text-quiet">{r.kind === 'add_service' ? 'Adds' : 'Services'}</dt>
        <dd className="m-0 text-ink">{r.kind === 'add_service' ? 'A new service' : itemNosText(r.itemNos)}</dd>
        <dt className="text-quiet">{r.kind === 'add_service' ? 'What to add' : 'What changes'}</dt>
        <dd className="m-0 wrap-anywhere text-ink">{r.changeSummary}</dd>
        <dt className="text-quiet">Why</dt>
        <dd className="m-0 wrap-anywhere text-ink">{r.reason}</dd>
        <dt className="text-quiet">Asked by</dt>
        <dd className="m-0 text-ink">
          {r.requestedByName} · {whenText(r.requestedAt)}
        </dd>
        {r.kind === 'remove_service' && r.removalRoute ? (
          <>
            <dt className="text-quiet">Removal</dt>
            <dd className="m-0 text-ink">{ROUTE_WORD[r.removalRoute]}</dd>
          </>
        ) : null}
        {r.customerChargePaise != null ? (
          <>
            <dt className="text-quiet">Customer charge</dt>
            <dd className="m-0 tabular-nums text-ink">{inr(r.customerChargePaise)}</dd>
          </>
        ) : null}
      </dl>
      {review ? <ChangeReviewPanel review={review} /> : null}
      {r.kind === 'remove_service' && r.removalRoute === 'cancellation' && charges ? <RemovalChargesTable charges={charges} /> : null}
      {showDecide ? (
        <div className="sticky bottom-0 z-1 -mx-4 -mb-4 rounded-b-card border-t border-line bg-card px-4 py-3" data-slot="decision-footer">
          {actions ? (
            <RowDecision
              recordName={r.refNo}
              action={actions.decide}
              fields={fields}
              approveLabel="Approve this version"
              help={versionNo ? `You approve exactly version ${versionNo} as shown.` : 'You approve exactly the version shown.'}
              // A confirm step before posting, as before the redesign (the approval binds this version).
              approveConfirm={{
                title: `Approve ${r.refNo}?`,
                effect: `${versionNo ? `You approve exactly version ${versionNo} as shown, with its selling total and payment plan. ` : 'You approve exactly the version shown. '}${
                  r.kind === 'change'
                    ? 'Purchase then reconfirms with each supplier; the change is applied when every supplier agreed. Your approval stands in for the Accounts review of the new version (no other approval). Cost above budget and the supplier payment rules still apply.'
                    : r.kind === 'add_service'
                      ? 'The new service then gets its task in the right department.'
                      : 'The service\u2019s task then closes; money the customer paid above the new total goes back through an overpayment refund.'
                }`,
                confirmLabel: 'Approve this version',
              }}
              ret={{
                title: `Return ${r.refNo}?`,
                effect: 'The Sales owner sees your reason, fixes the same change version and sends it again, or withdraws it. Nothing changes in the booking.',
                confirmLabel: 'Return to the Sales owner',
                blockedReason: r.can.return ? null : 'You asked for this change or are not its approver.',
              }}
              approveBlockedReason={blocked}
              initialApproveResult={open?.dialog === 'approve' ? (open.state ?? null) : null}
              initialApproveOpen={open?.dialog === 'approve'}
              initialReturnOpen={open?.dialog === 'return'}
            />
          ) : (
            <p className="m-0 text-sm text-quiet">The branch Manager decides this change.</p>
          )}
        </div>
      ) : null}
    </article>
  );
}

/** R-H1: what each supplier keeps and what comes back, with the customer charge (Manager only). */
export function RemovalChargesTable({ charges }: { charges: RemovalChargesView | 'error' }) {
  if (charges === 'error') {
    return (
      <Notice tone="warning" role="status">
        <p>The supplier charges could not be loaded. Reload the page before deciding.</p>
      </Notice>
    );
  }
  const missing = charges.services.filter((s) => !s.complete).length;
  return (
    <section aria-label={`Supplier charges for ${charges.refNo}`} className="flex flex-col gap-2">
      <p className="m-0 text-sm font-semibold text-ink">
        Supplier charges {missing > 0 ? <StatusBadge tone="warning">{missing} not entered yet</StatusBadge> : <StatusBadge tone="success">All entered</StatusBadge>}
      </p>
      <Table label={`Supplier charges for ${charges.refNo}`} stackOnMobile wrapperClassName="rounded-control border border-line">
        <TableHeader>
          <TableRow>
            <TableHead>Service</TableHead>
            <TableHead>Supplier</TableHead>
            <TableHead numeric>Supplier keeps</TableHead>
            <TableHead numeric>Refund expected</TableHead>
            <TableHead>Entered</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {charges.services.map((s) => (
            <TableRow key={s.itemNo}>
              <TableCell label="Service">
                <span className="font-medium text-ink">
                  {s.itemNo}. {s.serviceTitle}
                </span>
                <span className="block text-sm text-quiet">{DEPARTMENT_WORD[s.department]}</span>
              </TableCell>
              <TableCell label="Supplier">{s.supplierName ?? '—'}</TableCell>
              <TableCell label="Supplier keeps" numeric>
                {s.complete ? inr(s.supplierKeepsPaise) : '—'}
              </TableCell>
              <TableCell label="Refund expected" numeric>
                {s.complete ? inr(s.refundExpectedPaise) : '—'}
              </TableCell>
              <TableCell label="Entered">{s.complete ? <StatusBadge tone="success">{s.enteredByName ?? 'Entered'}</StatusBadge> : <StatusBadge tone="warning">Not yet</StatusBadge>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="m-0 text-sm text-copy">
        Charge to the customer: <strong className="tabular-nums text-ink">{inr(charges.customerChargePaise)}</strong>. Money the customer paid above the new total goes back through an overpayment refund.
      </p>
    </section>
  );
}

export function ChangeRequestsApprovalsLoading() {
  return (
    <LoadingRegion label="Loading change requests…">
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
    </LoadingRegion>
  );
}

/** Heading block for the Approvals tab (the route places it inside its tabs). */
export function ChangeRequestsTabIntro({ count }: { count: number | null }) {
  return (
    <div className="flex items-start gap-2">
      <GitCompareArrows aria-hidden="true" className="mt-1.5 size-4 shrink-0 text-faint" />
      <p className="m-0 text-copy">
        {count === null ? 'Changes, additions and removals of confirmed services.' : `${count} ${count === 1 ? 'request waits' : 'requests wait'} for a decision.`} You see the old and new booking side by side and approve exactly that version; your approval is the only one a change needs. Purchase then reconfirms with the supplier.
      </p>
    </div>
  );
}

/** The Approvals page section (titled, among the other Manager sections). */
export function ChangeRequestsApprovalsSection({ page, actions, charges, reviews }: { page: ChangeRequestsPage | 'error'; actions: ChangeDecideActions | null; charges?: Record<string, RemovalChargesView | 'error'>; reviews?: Record<string, ChangeReviewView | 'error'> }) {
  return (
    <section aria-labelledby="ap-changes-h" className="flex flex-col gap-3 font-sans">
      <h2 id="ap-changes-h" className="m-0 scroll-mt-18 text-lg font-semibold text-ink">
        Changes after confirmation to approve
      </h2>
      <ChangeRequestsApprovals page={page} charges={charges} reviews={reviews} actions={actions} viewer="manager" headingLevel={3} />
    </section>
  );
}
