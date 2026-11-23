import { BadgeCheck, Ban, Building2, CircleCheck, Hourglass, Landmark, PauseCircle, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CountBadge } from '@/components/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Fold } from '@/components/ui/fold';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { CANCELLATION_STATUS_LABEL, PURCHASE_BUILD_TEXT, SERVICE_TYPE_LABEL, type SupplierServiceType, type CancellationStatus, type ManagerCancellationRow as CancellationDetailRow } from '@/modules/procurement/contracts';
import { PFIELD } from '@/modules/procurement/forms';
import {
  FUNDING_STATUS_LABEL,
  HOLD_REASON_TEXT,
  PAYMENT_PART_LABEL,
  ROUTE_LABEL,
  SM_FIELD,
  type AccountsSupplierPaymentRow,
  type CompanyFundingRow,
  type ManagerApprovalList,
  type ManagerApprovalsView,
} from '@/modules/supplier-money/contracts';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ManagerCancellationKeys } from '../cancellations/types';
import { CostContractNotice } from '../accounts/contract-compare';
import type { DecisionAction } from '../accounts/supplier-forms';
import { AmountAside, BankLine, byText, dateText, Facts, FileLink, inr, ItemCard, ItemList, Status, whenText } from '../accounts/supplier-kit';
import { departmentWord, PaymentStatusBadge, supplierMoneyFileHref } from '../accounts/supplier-payments';
import { RowDecision } from '../department/row-decision';
import { ApprovalsSummaryChips, ManagerApproveBankForm, ManagerApproveCostForm, ManagerVerifySupplierForm, type ApprovalsChip } from './manager-approval-forms';

/*
 * Manager · Approvals (Purchase build; redesign R3, design plan DM-5 to
 * DM-8). Everything waiting for the branch Manager in one place: costs above
 * budget, flight fares above budget, supplier payments and company funding
 * above ₹50,000 per Deal and supplier, trip-cancellation charges, customer
 * refunds, write-offs, changes after confirmation, rate contracts, new
 * supplier bank details and suppliers to verify.
 *
 * Layout: a sticky row of summary chips (one per section with something
 * waiting, with its count) that jump to the section; only sections with
 * something waiting are shown; the empty ones are named in one closing line.
 * Every row uses one card template: identifier line, title, status, amount
 * on the right, facts, then "Approve …" and "Return with reason" at the
 * bottom (the reason box opens only after "Return with reason").
 *
 * Nothing about who may decide is worked out here: the database sends
 * canApprove / canDecide per row, refuses a person's own entry and routes
 * supplier money by the ₹50,000 rule; every decision command checks again.
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
  /** id of the heading: the summary chip jumps here. */
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
            <CardTitle id={id} className="scroll-mt-18">
              {title} <CountBadge aria-label={`${count} waiting`}>{countText(count)}</CountBadge>
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          <div className="flex flex-col gap-3">
            <ShowingLine shown={shown} total={count} more={more} />
            {children}
          </div>
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

/* ---------------------------------------------------------------------------
 * Sections, in the order the page shows them (money decisions first).
 * ------------------------------------------------------------------------- */

export type ApprovalsSectionKey =
  | 'costs'
  | 'flightFares'
  | 'payments'
  | 'funding'
  | 'cancellations'
  | 'refunds'
  | 'writeOffs'
  | 'changes'
  | 'rateContracts'
  | 'bankDetails'
  | 'suppliers';

/** Chip words and the heading each chip jumps to (ids owned by each section's view). */
export const APPROVALS_SECTIONS: Record<ApprovalsSectionKey, { label: string; targetId: string }> = {
  costs: { label: 'Costs above budget', targetId: 'ap-costs' },
  flightFares: { label: 'Flight fares above budget', targetId: 'flight-fares-heading' },
  payments: { label: 'Supplier payments', targetId: 'ap-payments' },
  funding: { label: 'Company funding', targetId: 'ap-funding' },
  cancellations: { label: 'Trip cancellation charges', targetId: 'ap-cancel' },
  refunds: { label: 'Refunds', targetId: 'ap-refunds' },
  writeOffs: { label: 'Write-offs', targetId: 'wo-approvals-h' },
  changes: { label: 'Changes after confirmation', targetId: 'ap-changes-h' },
  rateContracts: { label: 'Rate contracts', targetId: 'approvals-rc-heading' },
  bankDetails: { label: 'Supplier bank details', targetId: 'ap-bank' },
  suppliers: { label: 'Suppliers to verify', targetId: 'ap-suppliers' },
};

const SECTION_ORDER: readonly ApprovalsSectionKey[] = ['costs', 'flightFares', 'payments', 'funding', 'cancellations', 'refunds', 'writeOffs', 'changes', 'rateContracts', 'bankDetails', 'suppliers'];

/** A section read by the route outside manager_approvals (refunds, write-offs, changes, rate contracts). */
export interface ApprovalsExtraSection {
  key: Extract<ApprovalsSectionKey, 'refunds' | 'writeOffs' | 'changes' | 'rateContracts'>;
  /** Waiting count; 'unknown' when the read failed (the section then shows its own error). */
  count: number | 'unknown';
  /** The section itself (rendered only when something waits or the count is unknown). */
  node: ReactNode;
}

interface SectionEntry {
  key: ApprovalsSectionKey;
  count: number | 'unknown';
  node: ReactNode;
}

/** Which sections to show and chip, and which to name as empty (pure; unit-tested). */
export function planApprovalsSections(entries: readonly SectionEntry[]): { waiting: SectionEntry[]; empty: ApprovalsSectionKey[]; total: number; chips: ApprovalsChip[] } {
  const ordered = [...entries].sort((a, b) => SECTION_ORDER.indexOf(a.key) - SECTION_ORDER.indexOf(b.key));
  const waiting = ordered.filter((e) => e.count === 'unknown' || e.count > 0);
  const empty = ordered.filter((e) => e.count === 0).map((e) => e.key);
  const total = waiting.reduce((n, e) => n + (e.count === 'unknown' ? 0 : e.count), 0);
  const chips = waiting.map((e) => ({ targetId: APPROVALS_SECTIONS[e.key].targetId, label: APPROVALS_SECTIONS[e.key].label, count: e.count }));
  return { waiting, empty, total, chips };
}

/** "Nothing waiting: company funding, supplier bank details." */
export function nothingWaitingText(keys: readonly ApprovalsSectionKey[]): string | null {
  if (keys.length === 0) return null;
  const words = keys.map((k) => {
    const label = APPROVALS_SECTIONS[k].label;
    return label.charAt(0).toLowerCase() + label.slice(1);
  });
  return `Nothing waiting: ${words.join(', ')}.`;
}

export function ManagerApprovalsPage({
  view,
  actions,
  cancellationDetails = [],
  flightSection,
  extraSections = [],
}: {
  /** Refunds, write-offs, changes after confirmation and rate contracts (read by the route; absent = not shown, not named). */
  extraSections?: ApprovalsExtraSection[];
  /** Flight build: "Flight fares above budget" (passed when manager_approvals sent fare rows). */
  flightSection?: ReactNode;
  view: ManagerApprovalsView;
  actions: ManagerApprovalActions;
  /** YYYY-MM-DD (India), kept for the shared payment parts. */
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
  const fareRows = view.flightFares?.length ?? 0;

  const entries: SectionEntry[] = [
    {
      key: 'costs',
      count: t('costsAboveBudget'),
      node: (
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
                <ManagerApproveCostForm
                  taskId={c.taskId}
                  versionNo={c.versionNo}
                  recordName={`${c.serviceTitle}, rate version ${c.versionNo}`}
                  disabledReason={c.canApprove ? undefined : 'You can’t approve your own price. Another Manager decides.'}
                />
              </ItemCard>
            ))}
          </ItemList>
        </Section>
      ),
    },
    // Flight build (contract 11.1): known only when the route passes the section (it reads the fares with manager_approvals).
    ...(flightSection || fareRows === 0
      ? [
          {
            key: 'flightFares' as const,
            count: fareRows === 0 ? 0 : t('flightFares'),
            node: (
              <div className="flex flex-col gap-2">
                {flightSection}
                <ShowingLine shown={fareRows} total={t('flightFares')} />
              </div>
            ),
          },
        ]
      : []),
    {
      key: 'payments',
      count: t('payments'),
      node: (
        <Section id="ap-payments" title="Supplier payments" description="Above ₹50,000 for one supplier on one Deal, the branch Manager approves. Accounts then pays and records it." count={t('payments')} shown={view.payments.length}>
          <ItemList label="Supplier payments to approve">
            {view.payments.map((p) => (
              <ManagerPaymentItem key={p.id} row={p} decide={actions.decidePayment} />
            ))}
          </ItemList>
        </Section>
      ),
    },
    {
      key: 'funding',
      count: t('funding'),
      node: (
        <Section id="ap-funding" title="Company funding" description="Above ₹50,000 of company funding on a Deal, the branch Manager approves." count={t('funding')} shown={view.funding.length}>
          <ItemList label="Company funding to approve">
            {view.funding.map((f) => (
              <ManagerFundingItem key={f.id} row={f} decide={actions.decideFunding} />
            ))}
          </ItemList>
        </Section>
      ),
    },
    {
      key: 'cancellations',
      count: t('cancellations'),
      node: (
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
                  <RowDecision
                    recordName={`cancellation charges for ${c.dealReference}`}
                    action={actions.decideCancellation}
                    fields={{ [PFIELD.cancellationId]: c.cancellationId, [PFIELD.rowVersion]: c.rowVersion }}
                    approveLabel={PURCHASE_BUILD_TEXT.chargesApproveLabel}
                    help="Approves what each supplier keeps and refunds. Nothing is paid or refunded by the CRM."
                    ret={{
                      title: `Return the cancellation charges for ${c.dealReference}?`,
                      effect: `They go back to ${c.sentByName ?? 'Purchase'} with your reason. Nothing is approved, paid or refunded.`,
                      confirmLabel: PURCHASE_BUILD_TEXT.chargesReturnLabel,
                    }}
                    disabledReason={c.canDecide ? undefined : 'You entered a charge on this trip, so another Manager decides.'}
                  />
                </ItemCard>
              );
            })}
          </ItemList>
        </Section>
      ),
    },
    ...extraSections.map((x) => ({ key: x.key, count: x.count, node: x.node })),
    {
      key: 'bankDetails',
      count: t('bankDetails'),
      node: (
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
                <ManagerApproveBankForm
                  supplierId={b.supplierId}
                  revisionNo={b.revisionNo}
                  recordName={`${b.supplierName}, revision ${b.revisionNo}`}
                  disabledReason={b.canApprove ? undefined : 'You recorded these details, so another Manager approves them.'}
                />
              </ItemCard>
            ))}
          </ItemList>
        </Section>
      ),
    },
    {
      key: 'suppliers',
      count: t('suppliersToVerify'),
      node: (
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
                <ManagerVerifySupplierForm
                  supplierId={s.supplierId}
                  rowVersion={s.rowVersion}
                  recordName={s.name}
                  disabledReason={s.canVerify ? undefined : 'You entered these details, so another Manager verifies them.'}
                />
              </ItemCard>
            ))}
          </ItemList>
        </Section>
      ),
    },
  ];
  const plan = planApprovalsSections(entries);
  const closing = nothingWaitingText(plan.empty);

  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        eyebrow="Branch Manager"
        title="Approvals"
        description="Purchase, Flight and Accounts requests that need the branch Manager. Approving is never paying: Accounts pays and records every payment."
      />
      {plan.waiting.length === 0 ? (
        <Card role="status">
          <EmptyState icon={CircleCheck} headingLevel={2} title="Nothing waiting for you" description="Costs above budget, flight fares above budget, large supplier payments, company funding, bank details, suppliers and trip-cancellation charges, customer refunds and write-offs appear here when they need you." />
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          <ApprovalsSummaryChips chips={plan.chips} />
          {plan.waiting.map((e) => (
            <div key={e.key} className="contents">
              {e.node}
            </div>
          ))}
          {closing ? (
            <p className="m-0 text-sm text-quiet" data-testid="approvals-nothing-waiting">
              {closing}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Supplier payment and company funding rows (Manager view): the facts the
 * Manager decides on, with the longer ones under "Show details", and one
 * decision row. Accounts keeps its own cards on its pages.
 * ------------------------------------------------------------------------- */

function ManagerPaymentItem({ row, decide }: { row: AccountsSupplierPaymentRow; decide: DecisionAction }) {
  const dept = departmentWord(row.department);
  const asker = row.requestedByName ?? `the ${dept} colleague`;
  return (
    <ItemCard
      id={`sp-${row.id}`}
      headingLevel={3}
      eyebrow={
        <>
          <span className="whitespace-nowrap">{row.refNo}</span> · <span className="whitespace-nowrap">{row.dealReference}</span> · {row.branchName} · {dept}
          {row.flightBatchNo ? ` · ticket batch ${row.flightBatchNo}` : ''}
        </>
      }
      title={
        <>
          {row.supplierName}
          <span className="block text-base font-normal text-copy">{row.serviceTitle}</span>
        </>
      }
      status={
        <>
          <PaymentStatusBadge status={row.status} />
          {row.onHold ? (
            <Status tone="warning" icon={PauseCircle} label="Hold">
              On hold
            </Status>
          ) : null}
          <span className="text-sm text-quiet">{ROUTE_LABEL[row.route]}</span>
        </>
      }
      aside={<AmountAside label={PAYMENT_PART_LABEL[row.part]} paise={row.amountPaise} note={row.dueDate ? `Due ${dateText(row.dueDate)}` : 'No due date'} />}
    >
      {row.onHold && row.holdReason ? <Notice tone="warning">{HOLD_REASON_TEXT[row.holdReason]}</Notice> : null}
      <Facts
        rows={[
          ['Asked', `${whenText(row.requestedAt)} ${byText(row.requestedByName)}`],
          !!row.note && [row.department === 'flight' ? 'Flight note' : 'Purchase note', <span key="n" className="whitespace-pre-wrap">{row.note}</span>],
        ]}
      />
      <Fold flat summary={<>Show details<span className="sr-only"> of {row.refNo}</span></>} meta="cost, bank, proforma" className="-mx-4.5">
        <Facts
          rows={[
            ['Agreed supplier cost', row.costVersionNo === null ? inr(row.agreedCostPaise ?? '0') : row.agreedCostPaise ? `${inr(row.agreedCostPaise)} · rate version ${row.costVersionNo}` : `Rate version ${row.costVersionNo}`],
            ['From customer money', inr(row.customerMoneyPaise)],
            !!row.funding && [
              'Company funding',
              <span key="f">
                {inr(row.funding.amountPaise)} · {FUNDING_STATUS_LABEL[row.funding.status]} · {ROUTE_LABEL[row.funding.route]}
              </span>,
            ],
            ['Supplier bank details', <BankLine key="b" bank={row.bankDetails} />],
            row.proformaEvidenceId
              ? ['Proforma', <FileLink key="p" href={supplierMoneyFileHref(row.proformaEvidenceId)}>Open the supplier’s proforma</FileLink>]
              : ['Basis', row.department === 'flight' ? 'The confirmed ticket fares (no proforma needed)' : 'No proforma attached'],
          ]}
        />
      </Fold>
      {row.status === 'pending' || row.canDecide ? (
        <RowDecision
          recordName={row.refNo}
          action={decide}
          fields={{ [SM_FIELD.paymentId]: row.id, [SM_FIELD.expectedRowVersion]: row.rowVersion }}
          decisionField={SM_FIELD.decision}
          reasonField={SM_FIELD.reason}
          requestIdField={SM_FIELD.requestId}
          approveLabel="Approve payment"
          help="Approves paying this amount to this supplier. Accounts then pays and records it; approval is not payment."
          ret={{
            title: `Return ${row.refNo} to ${dept}?`,
            effect: `It goes back to ${asker} with your reason. Nothing is approved or paid.`,
            confirmLabel: `Return to ${dept}`,
          }}
          disabledReason={row.canDecide ? undefined : 'Another Manager decides this one. Nobody approves their own request.'}
        />
      ) : null}
    </ItemCard>
  );
}

function ManagerFundingItem({ row, decide }: { row: CompanyFundingRow; decide: DecisionAction }) {
  return (
    <ItemCard
      id={`fund-${row.id}`}
      headingLevel={3}
      eyebrow={
        <>
          <span className="whitespace-nowrap">{row.dealReference}</span> · {row.branchName} · payment {row.paymentRefNo}
        </>
      }
      title={
        <>
          {row.supplierName}
          <span className="block text-base font-normal text-copy">{row.serviceTitle}</span>
        </>
      }
      status={
        <>
          <Status tone="warning" icon={Hourglass} label="Funding">
            {FUNDING_STATUS_LABEL[row.status]}
          </Status>
          <PaymentStatusBadge status={row.paymentStatus} />
          <span className="text-sm text-quiet">{ROUTE_LABEL[row.route]}</span>
        </>
      }
      aside={<AmountAside label="Company pays first" paise={row.amountPaise} />}
    >
      <Facts
        rows={[
          ['Why the supplier can’t wait', <span key="r" className="whitespace-pre-wrap">{row.reason}</span>],
          ['Asked', `${whenText(row.requestedAt)} ${byText(row.requestedByName)}`],
        ]}
      />
      {row.status === 'pending' || row.canDecide ? (
        <RowDecision
          recordName={`company funding for payment ${row.paymentRefNo}`}
          action={decide}
          fields={{ [SM_FIELD.fundingId]: row.id, [SM_FIELD.expectedRowVersion]: row.rowVersion }}
          decisionField={SM_FIELD.decision}
          reasonField={SM_FIELD.reason}
          requestIdField={SM_FIELD.requestId}
          approveLabel="Approve company funding"
          help="The company pays this part before customer money arrives. The payment itself still needs its own approval and recording."
          ret={{
            title: `Return the company funding for ${row.paymentRefNo} to Purchase?`,
            effect: `It goes back to ${row.requestedByName ?? 'the Purchase colleague'} with your reason. Nothing is approved or paid.`,
            confirmLabel: 'Return to Purchase',
          }}
          disabledReason={row.canDecide ? undefined : 'Another Manager decides this one. Nobody approves their own request.'}
        />
      ) : null}
    </ItemCard>
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

