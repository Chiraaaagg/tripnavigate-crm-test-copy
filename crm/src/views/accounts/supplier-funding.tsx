import { CircleCheck, CircleX, Hourglass, PiggyBank, Undo2 } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import {
  FUNDING_STATUS_LABEL,
  ROUTE_LABEL,
  SM_FIELD,
  type AccountsFundingTab,
  type CompanyFundingRow,
  type FundingStatus,
} from '@/modules/supplier-money/contracts';
import { DecisionForm, SingleActionForm, type DecisionAction } from './supplier-forms';
import { PaymentStatusBadge } from './supplier-payments';
import { AmountAside, byText, DecisionPanel, Facts, ItemCard, ItemList, ListEmpty, ListTabs, Status, whenText } from './supplier-kit';

/*
 * Accounts · Company funding (owner decision 3). When customer money for a
 * Deal has not arrived, Purchase may ask the company to pay a supplier first.
 * The amount is computed by the database. Up to ₹50,000 of company funding
 * per Deal is approved by Accounts, above that by the branch Manager. Once
 * customer money is verified, Accounts marks the funding recovered.
 */

export const FUNDING_TABS: readonly AccountsFundingTab[] = ['to_approve', 'to_recover', 'all'];
const TAB_LABEL: Record<AccountsFundingTab, string> = { to_approve: 'To approve', to_recover: 'To recover', all: 'All' };

export function parseFundingTab(raw: string | string[] | undefined): AccountsFundingTab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (FUNDING_TABS as readonly string[]).includes(v ?? '') ? (v as AccountsFundingTab) : 'to_approve';
}

const LOOK: Record<FundingStatus, { tone: 'warning' | 'info' | 'danger' | 'success'; icon: typeof Hourglass }> = {
  pending: { tone: 'warning', icon: Hourglass },
  approved: { tone: 'info', icon: Undo2 },
  returned: { tone: 'danger', icon: CircleX },
  recovered: { tone: 'success', icon: CircleCheck },
};

export interface FundingActions {
  decide: DecisionAction;
  recover?: DecisionAction;
}

/** One funding request with the decision the viewer may take. Shared with the Manager's Approvals page. */
export function FundingItem({ row, actions, headingLevel = 2 }: { row: CompanyFundingRow; actions: FundingActions; headingLevel?: 2 | 3 }) {
  const look = LOOK[row.status];
  return (
    <ItemCard
      id={`fund-${row.id}`}
      headingLevel={headingLevel}
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
          <Status tone={look.tone} icon={look.icon} label="Funding">
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
          !!row.decidedAt && [row.status === 'returned' ? 'Returned' : 'Approved', `${whenText(row.decidedAt)} ${byText(row.decidedByName)}`],
          !!row.returnReason && ['Reason given', <span key="rr" className="whitespace-pre-wrap">{row.returnReason}</span>],
          !!row.recoveredAt && ['Recovered', `${whenText(row.recoveredAt)} ${byText(row.recoveredByName)}`],
          !!row.recoveryNote && ['Recovery note', <span key="rn" className="whitespace-pre-wrap">{row.recoveryNote}</span>],
        ]}
      />
      {row.canDecide ? (
        <DecisionPanel title="Approve or return">
          <DecisionForm
            action={actions.decide}
            label={`Decide company funding for payment ${row.paymentRefNo}`}
            fields={{ [SM_FIELD.fundingId]: row.id, [SM_FIELD.expectedRowVersion]: row.rowVersion }}
            decisionField={SM_FIELD.decision}
            reasonField={SM_FIELD.reason}
            requestIdField={SM_FIELD.requestId}
            approveLabel="Approve company funding"
            returnLabel="Return to Purchase"
            approveHelp="The company pays this part before customer money arrives. The payment itself still needs its own approval and recording."
          />
        </DecisionPanel>
      ) : row.status === 'pending' ? (
        <p className="m-0 text-sm text-quiet">{row.route === 'manager' ? 'The branch Manager decides this request.' : 'Another colleague decides this. Nobody approves their own request.'}</p>
      ) : null}
      {row.canMarkRecovered && actions.recover ? (
        <DecisionPanel title="Customer money arrived">
          <SingleActionForm
            action={actions.recover}
            label={`Mark company funding for ${row.paymentRefNo} recovered`}
            fields={{ [SM_FIELD.fundingId]: row.id, [SM_FIELD.expectedRowVersion]: row.rowVersion }}
            submitLabel="Mark recovered"
            pendingLabel="Saving…"
            variant="secondary"
            help="Only after the customer’s payment for this Deal is verified."
            note={{ name: SM_FIELD.note, label: 'How it was recovered', hint: '10 to 500 characters, for example the verified receipt it came from.', min: 10, max: 500 }}
          />
        </DecisionPanel>
      ) : null}
    </ItemCard>
  );
}

export function AccountsCompanyFundingPage({ rows, tab, actions }: { rows: CompanyFundingRow[]; tab: AccountsFundingTab; actions: FundingActions }) {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        eyebrow="Accounts"
        title="Company funding"
        description="Supplier payments the company pays before the customer’s money arrives. Up to ₹50,000 of company funding on a Deal is approved by Accounts; above that by the branch Manager."
      />
      <ListTabs label="Company funding filters" basePath="/app/accounts/funding" current={tab} defaultTab="to_approve" tabs={FUNDING_TABS.map((key) => ({ key, label: TAB_LABEL[key], count: key === tab ? rows.length : undefined }))} />
      {rows.length === 0 ? (
        <ListEmpty
          icon={PiggyBank}
          title={tab === 'to_approve' ? 'Nothing to approve' : tab === 'to_recover' ? 'Nothing to recover' : 'No company funding yet'}
          description={
            tab === 'to_approve'
              ? 'No funding request is waiting for Accounts.'
              : tab === 'to_recover'
                ? 'Approved funding appears here until customer money is verified and you mark it recovered.'
                : 'Purchase asks for company funding from a payment request when customer money has not arrived.'
          }
        />
      ) : (
        <ItemList label={`${TAB_LABEL[tab]}: company funding`}>
          {rows.map((r) => (
            <FundingItem key={r.id} row={r} actions={actions} />
          ))}
        </ItemList>
      )}
    </div>
  );
}
