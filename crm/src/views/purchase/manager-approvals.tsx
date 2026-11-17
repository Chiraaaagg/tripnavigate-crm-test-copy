import { BadgeCheck, Ban, Building2, CircleCheck, Hourglass, Landmark, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CountBadge } from '@/components/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { CANCELLATION_STATUS_LABEL, PURCHASE_BUILD_TEXT, SERVICE_TYPE_LABEL, type SupplierServiceType, type CancellationStatus, type ManagerCancellationRow as CancellationDetailRow } from '@/modules/procurement/contracts';
import type { ManagerApprovalList, ManagerApprovalsView } from '@/modules/supplier-money/contracts';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ManagerCancellationKeys } from '../cancellations/types';
import { CostContractNotice } from '../accounts/contract-compare';
import { DecisionForm, type DecisionAction } from '../accounts/supplier-forms';
import { FundingItem } from '../accounts/supplier-funding';
import { AmountAside, byText, DecisionPanel, Facts, inr, ItemCard, ItemList, Status, whenText } from '../accounts/supplier-kit';
import { SupplierPaymentItem } from '../accounts/supplier-payments';
import { ManagerApproveBankForm, ManagerApproveCostForm, ManagerVerifySupplierForm } from './manager-approval-forms';

/*
 * Manager · Approvals (Purchase build). Everything waiting for the branch
 * Manager in one place: costs above budget, supplier payments and company
 * funding above ₹50,000 per Deal, new supplier bank details, suppliers to
 * verify and trip-cancellation charges. Nobody approves their own entry; the
 * database decides every row and every decision.
 */

export interface ManagerApprovalActions {
  decidePayment: DecisionAction;
  decideFunding: DecisionAction;
  decideCancellation: DecisionAction;
}

/** Supplier service words, with Flight (flight-only suppliers are made by the Flight team, Flight build). */
function serviceWord(t: string): string {
  return t === 'flight' ? 'Flight' : (SERVICE_TYPE_LABEL[t as SupplierServiceType] ?? t);
}

/** Flight-only suppliers are not on the Purchase supplier pages (Track B 0280): the Manager decides here, without a link. */
function isFlightOnly(serviceTypes: readonly string[] | undefined): boolean {
  return !!serviceTypes && serviceTypes.length > 0 && serviceTypes.every((t) => t === 'flight');
}

const linkClass = cn('rounded-chip font-semibold text-brand-strong underline-offset-4 hover:text-brand-deep hover:underline', focusRing);

const countText = (n: number) => n.toLocaleString('en-IN');

/** Where the rest of a long list can be worked (only lists with such a page). */
export interface MoreLink {
  href: string;
  label: string;
}

/**
 * manager_approvals sends at most 50 rows per list (in the usual order) plus
 * the full count (20261204000900). When the count is larger, say so and
 * point to the page that lists them all, if there is one.
 */
export function ShowingLine({ shown, total, more }: { shown: number; total: number; more?: MoreLink }) {
  if (total <= shown) return null;
  return (
    <p className="m-0 text-sm text-quiet" data-testid="approvals-showing">
      Showing {countText(shown)} of {countText(total)}.{' '}
      {more ? (
        <Link href={more.href} className={linkClass}>
          {more.label}
        </Link>
      ) : (
        'The next ones appear here as these are decided.'
      )}
    </p>
  );
}

function Section({
  id,
  title,
  description,
  count,
  shown,
  more,
  children,
}: {
  id: string;
  title: string;
  description: string;
  /** Full count of the list (may be above the rows shown). */
  count: number;
  /** Rows on this page. */
  shown: number;
  more?: MoreLink;
  children: ReactNode;
}) {
  return (
    <Card>
      <section aria-labelledby={id}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={id}>
              {title} <CountBadge aria-label={`${count} waiting`}>{countText(count)}</CountBadge>
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          {count === 0 ? (
            <p className="m-0 text-quiet">Nothing waiting.</p>
          ) : (
            <div className="flex flex-col gap-3">
              <ShowingLine shown={shown} total={count} more={more} />
              {children}
            </div>
          )}
        </CardBody>
      </section>
    </Card>
  );
}

/** Full count of one list: the read's total when sent, never below the rows shown. */
export function approvalsTotalOf(view: ManagerApprovalsView, key: ManagerApprovalList): number {
  const shown = (view[key] ?? []).length;
  return Math.max(view.totals?.[key] ?? shown, shown);
}

/** The supplier register filters that list every supplier of these two sections (Manager may read the register). */
const SUPPLIERS_TO_VERIFY_LINK: MoreLink = {
  href: '/app/purchase/suppliers?verification=unverified&status=active',
  label: 'See all suppliers to verify',
};
const BANK_DETAILS_LINK: MoreLink = { href: '/app/purchase/suppliers?bankState=on_hold', label: 'See all suppliers with bank details on hold' };

const CANCEL_TONE: Record<CancellationStatus, 'warning' | 'info' | 'success'> = {
  open: 'warning',
  charges_entered: 'warning',
  sent_to_manager: 'info',
  approved: 'success',
};

export function ManagerApprovalsPage({
  view,
  actions,
  today,
  cancellationDetails = [],
  flightSection,
  refundSection,
  refundCount = 0,
  phase3Sections,
  phase3Count = 0,
}: {
  /** Accounts phase 3 (screen 15.6, 15.9, 15.10): write-offs, rate contracts and change requests waiting for this Manager (rendered after refunds; counted in the empty state). */
  phase3Sections?: ReactNode;
  phase3Count?: number;
  /** Accounts phase 2 (screen 11.4): "Refunds to approve" (rendered first; counted in the empty state). */
  refundSection?: ReactNode;
  refundCount?: number;
  /** Flight build: "Flight fares above budget" (rendered with the other sections; counted in the empty state). */
  flightSection?: ReactNode;
  view: ManagerApprovalsView;
  actions: ManagerApprovalActions;
  today: string;
  /** Optional per-service charge lines (procurement's manager cancellation list; Accounts phase 2 adds Flight charges). */
  cancellationDetails?: Array<CancellationDetailRow & ManagerCancellationKeys>;
}) {
  // Bank-detail rows carry no service types: use them when a newer read sends them, else the verify list's.
  const flightOnlyIds = new Set([
    ...view.suppliersToVerify.filter((x) => isFlightOnly(x.serviceTypes)).map((x) => x.supplierId),
    ...view.bankDetails.filter((x) => isFlightOnly((x as { serviceTypes?: string[] }).serviceTypes)).map((x) => x.supplierId),
  ]);
  const t = (key: ManagerApprovalList) => approvalsTotalOf(view, key);
  const total =
    t('costsAboveBudget') + t('payments') + t('funding') + t('bankDetails') + t('suppliersToVerify') + t('cancellations') + t('flightFares') + refundCount + phase3Count;
  const fareRows = view.flightFares?.length ?? 0;
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        eyebrow="Branch Manager"
        title="Approvals"
        description="Purchase, Flight and Accounts requests that need the branch Manager. Approving is never paying: Accounts pays and records every payment."
      />
      {total === 0 ? (
        <Card role="status">
          <EmptyState icon={CircleCheck} headingLevel={2} title="Nothing waiting for you" description="Costs above budget, flight fares above budget, large supplier payments, company funding, bank details, suppliers and trip-cancellation charges, customer refunds and write-offs appear here when they need you." />
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          {refundSection}
          {phase3Sections}
          {flightSection}
          {flightSection ? <ShowingLine shown={fareRows} total={t('flightFares')} /> : null}
          <Section id="ap-costs" title="Costs above budget" description="Approve a final rate above the Sales budget for that rate version only." count={t('costsAboveBudget')} shown={view.costsAboveBudget.length}>
            <ItemList label="Costs above budget">
              {view.costsAboveBudget.map((c) => (
                <ItemCard
                  key={`${c.taskId}-${c.versionNo}`}
                  id={`ap-cost-${c.taskId}-${c.versionNo}`}
                  headingLevel={3}
                  eyebrow={<span className="whitespace-nowrap">{c.dealReference}</span>}
                  title={
                    <Link href={`/app/purchase/${c.taskId}?tab=work`} className={linkClass}>
                      {c.serviceTitle}
                    </Link>
                  }
                  status={
                    <Status tone="warning" icon={TrendingUp} label="Cost">
                      {inr((BigInt(c.amountPaise) - BigInt(c.budgetPaise)).toString())} over budget
                    </Status>
                  }
                  aside={<AmountAside label="Final rate" paise={c.amountPaise} note={`Budget ${inr(c.budgetPaise)}`} />}
                >
                  <Facts
                    rows={[
                      ['Supplier', c.supplierName ?? 'Not recorded'],
                      ['Rate version', String(c.versionNo)],
                      ['Proposed', `${whenText(c.proposedAt)} ${byText(c.proposedByName)}`],
                      c.contractState === 'matches' && ['Rate contract', 'Matches the rate contract'],
                    ]}
                  />
                  <CostContractNotice row={c} />
                  {c.canApprove ? <ManagerApproveCostForm taskId={c.taskId} versionNo={c.versionNo} /> : <p className="m-0 text-sm text-quiet">You can’t approve your own price. Another Manager decides.</p>}
                </ItemCard>
              ))}
            </ItemList>
          </Section>

          <Section id="ap-payments" title="Supplier payments" description="Above ₹50,000 for one supplier on one Deal, the branch Manager approves. Accounts then pays and records it." count={t('payments')} shown={view.payments.length}>
            <ItemList label="Supplier payments to approve">
              {view.payments.map((p) => (
                <SupplierPaymentItem key={p.id} row={p} actions={{ decide: actions.decidePayment }} today={today} managerView headingLevel={3} />
              ))}
            </ItemList>
          </Section>

          <Section id="ap-funding" title="Company funding" description="Above ₹50,000 of company funding on a Deal, the branch Manager approves." count={t('funding')} shown={view.funding.length}>
            <ItemList label="Company funding to approve">
              {view.funding.map((f) => (
                <FundingItem key={f.id} row={f} actions={{ decide: actions.decideFunding }} headingLevel={3} />
              ))}
            </ItemList>
          </Section>

          <Section id="ap-bank" title="Supplier bank details" description="Payments to a supplier are held until its latest bank details are approved. Check them against the supplier’s letter or cheque." count={t('bankDetails')} shown={view.bankDetails.length} more={BANK_DETAILS_LINK}>
            <ItemList label="Bank details to approve">
              {view.bankDetails.map((b) => (
                <ItemCard
                  key={`${b.supplierId}-${b.revisionNo}`}
                  id={`ap-bank-${b.supplierId}-${b.revisionNo}`}
                  headingLevel={3}
                  eyebrow={`Revision ${b.revisionNo}`}
                  title={
                    flightOnlyIds.has(b.supplierId) ? (
                      b.supplierName
                    ) : (
                      <Link href={`/app/purchase/suppliers/${b.supplierId}`} className={linkClass}>
                        {b.supplierName}
                      </Link>
                    )
                  }
                  status={
                    <Status tone="warning" icon={Hourglass} label="Bank details">
                      Not approved yet
                    </Status>
                  }
                >
                  <Facts
                    rows={[
                      [
                        'Bank details',
                        <span key="b" className="flex max-w-full min-w-0 items-start gap-2">
                          <Landmark aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-faint" />
                          <span className="min-w-0 wrap-anywhere">
                            {b.accountHolder} · {b.bankName} · {b.ifsc} ·{' '}
                            <span className="sr-only">account ending </span>
                              <span className="tabular-nums">
                              <span aria-hidden="true">•••• </span>
                              {b.accountLast4}
                            </span>
                          </span>
                        </span>,
                      ],
                      ['Recorded', `${whenText(b.createdAt)} ${byText(b.createdByName)}`],
                    ]}
                  />
                  {b.canApprove ? <ManagerApproveBankForm supplierId={b.supplierId} revisionNo={b.revisionNo} /> : <p className="m-0 text-sm text-quiet">You recorded these details, so another Manager approves them.</p>}
                </ItemCard>
              ))}
            </ItemList>
          </Section>

          <Section id="ap-suppliers" title="Suppliers to verify" description="Check the supplier’s name, services and contact details. Any later change by Purchase marks them not verified again." count={t('suppliersToVerify')} shown={view.suppliersToVerify.length} more={SUPPLIERS_TO_VERIFY_LINK}>
            <ItemList label="Suppliers to verify">
              {view.suppliersToVerify.map((s) => (
                <ItemCard
                  key={s.supplierId}
                  id={`ap-sup-${s.supplierId}`}
                  headingLevel={3}
                  eyebrow={s.city ?? 'City not recorded'}
                  title={
                    isFlightOnly(s.serviceTypes) ? (
                      s.name
                    ) : (
                      <Link href={`/app/purchase/suppliers/${s.supplierId}`} className={linkClass}>
                        {s.name}
                      </Link>
                    )
                  }
                  status={
                    <Status tone="warning" icon={Building2} label="Supplier">
                      Details not verified
                    </Status>
                  }
                >
                  <Facts rows={[['Services', s.serviceTypes.map(serviceWord).join(', ') || 'None listed'], ['Last changed', whenText(s.updatedAt)]]} />
                  {s.canVerify ? <ManagerVerifySupplierForm supplierId={s.supplierId} rowVersion={s.rowVersion} /> : <p className="m-0 text-sm text-quiet">You entered these details, so another Manager verifies them.</p>}
                </ItemCard>
              ))}
            </ItemList>
          </Section>

          <Section id="ap-cancel" title="Trip cancellation charges" description="What each supplier and airline keeps and refunds after a trip is cancelled. The customer refund is not handled here." count={t('cancellations')} shown={view.cancellations.length}>
            <ItemList label="Cancellation charges to approve">
              {view.cancellations.map((c) => {
                const detail = cancellationDetails.find((d) => d.cancellationId === c.cancellationId);
                const status = (c.status in CANCELLATION_STATUS_LABEL ? c.status : 'sent_to_manager') as CancellationStatus;
                return (
                  <ItemCard
                    key={c.cancellationId}
                    id={`ap-cancel-${c.cancellationId}`}
                    headingLevel={3}
                    eyebrow={<span className="whitespace-nowrap">{c.dealReference}</span>}
                    title={`Trip cancelled · ${c.chargeCount} ${c.chargeCount === 1 ? 'service' : 'services'}`}
                    status={
                      <Status tone={CANCEL_TONE[status]} icon={Ban} label="Cancellation">
                        {CANCELLATION_STATUS_LABEL[status]}
                      </Status>
                    }
                    aside={<AmountAside label="Suppliers keep" paise={c.supplierKeepsPaise} note={`Suppliers refund ${inr(c.supplierRefundPaise)}`} />}
                  >
                    <Facts
                      rows={[
                        ['Reason', <span key="r" className="whitespace-pre-wrap">{c.reason}</span>],
                        !!c.sentAt && ['Sent', `${whenText(c.sentAt)} ${byText(c.sentByName)}`],
                        typeof detail?.chargesKeptPaise === 'string' && ['Charges kept (suppliers and airlines)', inr(detail.chargesKeptPaise)],
                      ]}
                    />
                    {detail && detail.charges.length > 0 ? (
                      <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm" aria-label="Charges per service">
                        {detail.charges.map((ch) => (
                          <li key={ch.taskId} className="m-0 wrap-break-word">
                            <BadgeCheck aria-hidden="true" className="mr-1 inline size-3.5 text-faint" />
                            <span className="font-semibold text-ink">{ch.itemTitle}</span> · {ch.supplierName} · cost {inr(ch.committedCostPaise)} · keeps {inr(ch.supplierKeepsPaise)} · refunds {inr(ch.supplierRefundPaise)}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {detail?.flightCharges && detail.flightCharges.length > 0 ? <FlightChargesTable dealReference={c.dealReference} rows={detail.flightCharges} /> : null}
                    {c.canDecide && c.chargeCount === 0 && !(detail?.flightCharges?.length) ? (
                      <p className="m-0 text-sm text-copy">Nothing to charge: no Purchase cost and no ticket batch on this trip. You can approve the cancellation directly.</p>
                    ) : null}
                    {c.canDecide ? (
                      <DecisionPanel title="Approve or return">
                        <DecisionForm
                          action={actions.decideCancellation}
                          label={`Decide cancellation charges for ${c.dealReference}`}
                          fields={{ cancellationId: c.cancellationId, rowVersion: c.rowVersion }}
                          approveLabel={PURCHASE_BUILD_TEXT.chargesApproveLabel}
                          returnLabel={PURCHASE_BUILD_TEXT.chargesReturnLabel}
                          approveHelp="Approves what each supplier keeps and refunds. Nothing is paid or refunded by the CRM."
                        />
                      </DecisionPanel>
                    ) : (
                      <p className="m-0 text-sm text-quiet">You entered a charge on this trip, so another Manager decides.</p>
                    )}
                  </ItemCard>
                );
              })}
            </ItemList>
          </Section>
        </div>
      )}
    </div>
  );
}

/**
 * Accounts phase 2 (contract 7.4): the airline charges per ticket batch the
 * Flight team entered, approved together with the cancellation.
 */
function FlightChargesTable({ dealReference, rows }: { dealReference: string; rows: NonNullable<ManagerCancellationKeys['flightCharges']> }) {
  return (
    <Table label={`Airline charges per ticket batch, ${dealReference}`} stackOnMobile wrapperClassName="rounded-control border border-line">
      <TableHeader>
        <TableRow>
          <TableHead>Ticket batch</TableHead>
          <TableHead numeric>Supplier cost</TableHead>
          <TableHead numeric>Airline keeps</TableHead>
          <TableHead numeric>Refund expected</TableHead>
          <TableHead numeric>Refund reported</TableHead>
          <TableHead>Entered</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.batchId}>
            <TableCell label="Ticket batch">
              <span className="font-semibold wrap-anywhere text-ink">
                Batch {r.batchNo} · {r.supplierName}
              </span>
            </TableCell>
            <TableCell label="Supplier cost" numeric>
              {inr(r.supplierCostPaise)}
            </TableCell>
            <TableCell label="Airline keeps" numeric>
              {r.airlineChargePaise === null ? 'Not entered yet' : inr(r.airlineChargePaise)}
            </TableCell>
            <TableCell label="Refund expected" numeric>
              {r.refundExpectedPaise === null ? 'Not entered yet' : inr(r.refundExpectedPaise)}
            </TableCell>
            <TableCell label="Refund reported" numeric>
              {r.refundReportedPaise ? inr(r.refundReportedPaise) : 'Not reported'}
            </TableCell>
            <TableCell label="Entered">
              {r.airlineChargePaise === null ? 'Waiting for Flight' : `Revision ${r.revisionNo} ${byText(r.enteredByName)}`}
              {r.note ? <span className="block text-sm text-quiet whitespace-pre-wrap">Note: {r.note}</span> : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Anyone without the Manager role who opens /app/approvals. */
export function ApprovalsNotForYouView() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader eyebrow="Branch Manager" title="Approvals" />
      <Notice tone="locked" role="status">
        Only a branch Manager approves here. Your own requests are on your task and Accounts pages.
      </Notice>
    </div>
  );
}

