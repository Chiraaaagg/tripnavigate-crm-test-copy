import { BadgeCheck, Banknote, CircleCheck, CircleX, Clock, Hourglass, MinusCircle, PauseCircle, type LucideIcon } from 'lucide-react';
import { Fold } from '@/components/ui/fold';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import type { StatusTone } from '@/components/ui/badge';
import { parseTab } from '@/lib/parse-tab';
import {
  FUNDING_STATUS_LABEL,
  HOLD_REASON_TEXT,
  PAYMENT_MODE_LABEL,
  PAYMENT_PART_LABEL,
  PAYMENT_STATUS_HELP,
  PAYMENT_STATUS_LABEL,
  ROUTE_LABEL,
  SM_FIELD,
  type AccountsPaymentTab,
  type AccountsSupplierPaymentRow,
  type SupplierPaymentStatus,
} from '@/modules/supplier-money/contracts';
import type { AccountsSectionViewer } from '@/views/accounts-desk/sections';
import { RowDecision } from '../department/row-decision';
import { RecordPaymentForm, SingleActionForm, UnavailableAction, type DecisionAction } from './supplier-forms';
import {
  AmountAside,
  BankLine,
  byText,
  dateText,
  DecisionPanel,
  Facts,
  FileLink,
  inr,
  ItemCard,
  ItemList,
  LimitLine,
  ListEmpty,
  ListTabs,
  NeedsManager,
  Status,
  whenText,
} from './supplier-kit';
import { MoneyOutTabs } from './money-out-tabs';

/*
 * Accounts · Supplier payments (Purchase build, Track B data). Approval is
 * not payment: Accounts (or the branch Manager above ₹50,000 per supplier
 * per Deal) approves, Accounts pays outside the CRM and records it with the
 * proof, and a different Accounts person verifies. A payment on hold (bank
 * details not approved, company funding not approved) cannot be recorded.
 *
 * Redesign R4 (A7): Money out tab strip under the header; the ₹50,000 rule
 * said once per page; one decision row per request ("Approve payment", then
 * "Return with reason" opening the shared reason dialog). A request routed to
 * the branch Manager shows "Needs the branch Manager" and no Approve to
 * Accounts. Longer facts sit under "Show details". Same actions, fields and
 * words; the database decides who may approve, record and verify.
 */

export const ACCOUNTS_PAYMENT_TABS: readonly AccountsPaymentTab[] = ['to_approve', 'to_record', 'to_verify', 'all'];
const TAB_LABEL: Record<AccountsPaymentTab, string> = { to_approve: 'To approve', to_record: 'To pay and record', to_verify: 'To verify', all: 'All' };

export function parsePaymentTab(raw: string | string[] | undefined): AccountsPaymentTab {
  return parseTab(raw, ACCOUNTS_PAYMENT_TABS, 'to_approve');
}

/** The ₹50,000 rule for supplier payments, said once on the page. */
export const PAYMENT_LIMIT_TEXT =
  'Accounts approves a supplier payment when everything asked for that supplier on that Deal comes to ₹50,000 or less; above that, the branch Manager approves.';

export const PAYMENT_STATUS_LOOK: Record<SupplierPaymentStatus, { tone: StatusTone; icon: LucideIcon }> = {
  pending: { tone: 'warning', icon: Hourglass },
  approved: { tone: 'info', icon: Clock },
  returned: { tone: 'danger', icon: CircleX },
  cancelled: { tone: 'neutral', icon: MinusCircle },
  paid: { tone: 'info', icon: Banknote },
  verified: { tone: 'success', icon: BadgeCheck },
};

export const supplierMoneyFileHref = (evidenceId: string) => `/app/accounts/supplier-payments/files/${evidenceId}`;

export interface AccountsPaymentActions {
  decide: DecisionAction;
  record: DecisionAction;
  upload: DecisionAction;
  verify: DecisionAction;
}

const EMPTY: Record<AccountsPaymentTab, { title: string; description: string }> = {
  to_approve: { title: 'Nothing to approve', description: 'No supplier payment request is waiting for Accounts.' },
  to_record: { title: 'Nothing to pay and record', description: 'Approved payments appear here until Accounts records them.' },
  to_verify: { title: 'Nothing to verify', description: 'Payments recorded by a colleague appear here for a second check.' },
  all: { title: 'No supplier payment requests yet', description: 'Purchase sends payment requests from a task’s Work tab.' },
};

export function AccountsSupplierPaymentsPage({
  rows,
  tab,
  actions,
  today,
  sectionViewer,
  previewReturnOpen,
}: {
  rows: AccountsSupplierPaymentRow[];
  tab: AccountsPaymentTab;
  actions: AccountsPaymentActions;
  /** YYYY-MM-DD (India) for the "Paid on" limit. */
  today: string;
  /** The menu flags (Money out tab strip); absent: no strip. */
  sectionViewer?: AccountsSectionViewer;
  /** Preview gallery only: the return dialog of this payment id open on first load. */
  previewReturnOpen?: string;
}) {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        eyebrow="Accounts"
        title="Supplier payments"
        description="Approve, pay and verify what Purchase asks to pay suppliers. Approval is not payment; the CRM sends no money. A different Accounts person verifies each recorded payment."
      />
      <MoneyOutTabs viewer={sectionViewer} currentHref="/app/accounts/supplier-payments" />
      <ListTabs
        label="Supplier payment filters"
        basePath="/app/accounts/supplier-payments"
        current={tab}
        defaultTab="to_approve"
        tabs={ACCOUNTS_PAYMENT_TABS.map((key) => ({ key, label: TAB_LABEL[key], count: key === tab ? rows.length : undefined }))}
      />
      <LimitLine>{PAYMENT_LIMIT_TEXT}</LimitLine>
      {rows.length === 0 ? (
        <ListEmpty icon={CircleCheck} title={EMPTY[tab].title} description={EMPTY[tab].description} />
      ) : (
        <ItemList label={`${TAB_LABEL[tab]}: supplier payments`}>
          {rows.map((r) => (
            <SupplierPaymentItem key={r.id} row={r} actions={actions} today={today} previewReturnOpen={previewReturnOpen === r.id} />
          ))}
        </ItemList>
      )}
    </div>
  );
}

export function PaymentStatusBadge({ status }: { status: SupplierPaymentStatus }) {
  const look = PAYMENT_STATUS_LOOK[status];
  return (
    <Status tone={look.tone} icon={look.icon} label="Payment">
      {PAYMENT_STATUS_LABEL[status]}
    </Status>
  );
}

/** Flight build: which department asked (Purchase / Flight); older rows without it are Purchase. */
export function departmentWord(department: string | null | undefined): string {
  return department === 'flight' ? 'Flight' : 'Purchase';
}

/** One supplier payment, with the decision the viewer may take now. Shared with the Manager's Approvals page. */
export function SupplierPaymentItem({
  row,
  actions,
  today,
  managerView = false,
  headingLevel = 2,
  previewReturnOpen = false,
}: {
  row: AccountsSupplierPaymentRow;
  actions: Pick<AccountsPaymentActions, 'decide'> & Partial<AccountsPaymentActions>;
  today: string;
  managerView?: boolean;
  headingLevel?: 2 | 3;
  /** Preview gallery only. */
  previewReturnOpen?: boolean;
}) {
  return (
    <ItemCard
      id={`sp-${row.id}`}
      headingLevel={headingLevel}
      eyebrow={
        <>
          <span className="whitespace-nowrap">{row.refNo}</span> · <span className="whitespace-nowrap">{row.dealReference}</span> · {row.branchName} · {departmentWord(row.department)}
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
      <p className="m-0 text-sm text-quiet">{PAYMENT_STATUS_HELP[row.status]}</p>
      {row.onHold && row.holdReason ? <Notice tone="warning">{HOLD_REASON_TEXT[row.holdReason]}</Notice> : null}
      <Facts
        rows={[
          ['Asked', `${whenText(row.requestedAt)} ${byText(row.requestedByName)}`],
          !!row.note && [row.department === 'flight' ? 'Flight note' : 'Purchase note', <span key="n" className="whitespace-pre-wrap">{row.note}</span>],
          !!row.decidedAt && [row.status === 'returned' ? 'Returned' : 'Approved', `${whenText(row.decidedAt)} ${byText(row.decidedByName)}`],
          !!row.returnReason && ['Reason given', <span key="rr" className="whitespace-pre-wrap">{row.returnReason}</span>],
          !!row.paidOn && [
            'Paid',
            `${dateText(row.paidOn)}${row.paymentMode ? ` · ${PAYMENT_MODE_LABEL[row.paymentMode]}` : ''}${row.bankReference ? ` · reference ${row.bankReference}` : ''}${row.recordedAt ? ` · recorded ${whenText(row.recordedAt)} ${byText(row.recordedByName)}` : ''}`,
          ],
          !managerView && !!row.paymentProofEvidenceId && ['Payment proof', <FileLink key="pp" href={supplierMoneyFileHref(row.paymentProofEvidenceId)}>Open the payment proof</FileLink>],
          !!row.verifiedAt && ['Verified', `${whenText(row.verifiedAt)} ${byText(row.verifiedByName)}`],
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
      <PaymentDecision row={row} decide={actions.decide} previewReturnOpen={previewReturnOpen} />
      {!managerView && row.status === 'approved' && actions.record && actions.upload ? (
        row.canRecord && !row.onHold ? (
          <details className="rounded-control border border-line bg-canvas px-4 py-3">
            <summary className="cursor-pointer font-semibold text-ink">Record the payment</summary>
            <div className="mt-3">
              <RecordPaymentForm paymentId={row.id} taskId={row.taskId} rowVersion={row.rowVersion} recordAction={actions.record} uploadAction={actions.upload} today={today} />
            </div>
          </details>
        ) : (
          <UnavailableAction label="Record the payment" reason={row.onHold && row.holdReason ? HOLD_REASON_TEXT[row.holdReason] : 'You can’t record this payment.'} />
        )
      ) : null}
      {!managerView && row.status === 'paid' && actions.verify ? (
        row.canVerify ? (
          <DecisionPanel title="Second check">
            <SingleActionForm
              action={actions.verify}
              label={`Verify payment ${row.refNo}`}
              fields={{ [SM_FIELD.paymentId]: row.id, [SM_FIELD.expectedRowVersion]: row.rowVersion }}
              submitLabel="Mark payment verified"
              pendingLabel="Verifying…"
              help="Check the proof against the bank statement: amount, date and reference."
            />
          </DecisionPanel>
        ) : (
          <UnavailableAction label="Mark payment verified" reason="You recorded this payment, so another Accounts person verifies it." />
        )
      ) : null}
    </ItemCard>
  );
}

/**
 * The approval row of one payment request. The read's canDecide says who may
 * decide; the route says whether the branch Manager decides. Accounts never
 * sees Approve on a request routed to the Manager.
 */
function PaymentDecision({ row, decide, previewReturnOpen }: { row: AccountsSupplierPaymentRow; decide: DecisionAction; previewReturnOpen: boolean }) {
  if (!row.canDecide && row.status !== 'pending') return null;
  if (!row.canDecide && row.route === 'manager') return <NeedsManager />;
  const dept = departmentWord(row.department);
  return (
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
        effect: `It goes back to ${row.requestedByName ?? `the ${dept} colleague`} with your reason. Nothing is approved or paid.`,
        confirmLabel: `Return to ${dept}`,
      }}
      disabledReason={row.canDecide ? undefined : 'Another Accounts colleague decides this. Nobody approves their own request.'}
      initialReturnOpen={previewReturnOpen}
    />
  );
}
