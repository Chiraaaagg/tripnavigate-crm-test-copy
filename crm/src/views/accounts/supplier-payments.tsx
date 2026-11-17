import { BadgeCheck, Banknote, CircleCheck, CircleX, Clock, Hourglass, MinusCircle, PauseCircle, type LucideIcon } from 'lucide-react';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import type { StatusTone } from '@/components/ui/badge';
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
import { DecisionForm, RecordPaymentForm, SingleActionForm, UnavailableAction, type DecisionAction } from './supplier-forms';
import { AmountAside, BankLine, byText, dateText, DecisionPanel, Facts, FileLink, inr, ItemCard, ItemList, ListEmpty, ListTabs, Status, whenText } from './supplier-kit';

/*
 * Accounts · Supplier payments (Purchase build, Track B data). Approval is
 * not payment: Accounts (or the branch Manager above ₹50,000 per supplier
 * per Deal) approves, Accounts pays outside the CRM and records it with the
 * proof, and a different Accounts person verifies. A payment on hold (bank
 * details not approved, company funding not approved) cannot be recorded.
 */

export const ACCOUNTS_PAYMENT_TABS: readonly AccountsPaymentTab[] = ['to_approve', 'to_record', 'to_verify', 'all'];
const TAB_LABEL: Record<AccountsPaymentTab, string> = { to_approve: 'To approve', to_record: 'To pay and record', to_verify: 'To verify', all: 'All' };

export function parsePaymentTab(raw: string | string[] | undefined): AccountsPaymentTab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (ACCOUNTS_PAYMENT_TABS as readonly string[]).includes(v ?? '') ? (v as AccountsPaymentTab) : 'to_approve';
}

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
}: {
  rows: AccountsSupplierPaymentRow[];
  tab: AccountsPaymentTab;
  actions: AccountsPaymentActions;
  /** YYYY-MM-DD (India) for the "Paid on" limit. */
  today: string;
}) {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        eyebrow="Accounts"
        title="Supplier payments"
        description="Approve, pay and verify what Purchase asks to pay suppliers. Approval is not payment; the CRM sends no money. A different Accounts person verifies each recorded payment."
      />
      <ListTabs
        label="Supplier payment filters"
        basePath="/app/accounts/supplier-payments"
        current={tab}
        defaultTab="to_approve"
        tabs={ACCOUNTS_PAYMENT_TABS.map((key) => ({ key, label: TAB_LABEL[key], count: key === tab ? rows.length : undefined }))}
      />
      {rows.length === 0 ? (
        <ListEmpty icon={CircleCheck} title={EMPTY[tab].title} description={EMPTY[tab].description} />
      ) : (
        <ItemList label={`${TAB_LABEL[tab]}: supplier payments`}>
          {rows.map((r) => (
            <SupplierPaymentItem key={r.id} row={r} actions={actions} today={today} />
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
export function SupplierPaymentItem({ row, actions, today, managerView = false, headingLevel = 2 }: { row: AccountsSupplierPaymentRow; actions: Pick<AccountsPaymentActions, 'decide'> & Partial<AccountsPaymentActions>; today: string; managerView?: boolean; headingLevel?: 2 | 3 }) {
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
          !!row.note && [row.department === 'flight' ? 'Flight note' : 'Purchase note', <span key="n" className="whitespace-pre-wrap">{row.note}</span>],
          ['Asked', `${whenText(row.requestedAt)} ${byText(row.requestedByName)}`],
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
      {row.canDecide ? (
        <DecisionPanel title="Approve or return">
          <DecisionForm
            action={actions.decide}
            label={`Decide payment ${row.refNo}`}
            fields={{ [SM_FIELD.paymentId]: row.id, [SM_FIELD.expectedRowVersion]: row.rowVersion }}
            decisionField={SM_FIELD.decision}
            reasonField={SM_FIELD.reason}
            requestIdField={SM_FIELD.requestId}
            approveLabel="Approve payment"
            returnLabel="Return to Purchase"
            approveHelp="Approves paying this amount to this supplier. Accounts then pays and records it; approval is not payment."
          />
        </DecisionPanel>
      ) : row.status === 'pending' ? (
        <p className="m-0 text-sm text-quiet">{row.route === 'manager' ? 'The branch Manager decides this request.' : 'Another Accounts colleague decides this. Nobody approves their own request.'}</p>
      ) : null}
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
