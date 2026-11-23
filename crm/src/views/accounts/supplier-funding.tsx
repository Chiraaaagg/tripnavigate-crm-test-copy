import { CircleCheck, CircleX, Hourglass, PiggyBank, Undo2 } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { parseTab } from '@/lib/parse-tab';
import {
  FUNDING_STATUS_LABEL,
  ROUTE_LABEL,
  SM_FIELD,
  type AccountsFundingTab,
  type CompanyFundingRow,
  type FundingStatus,
} from '@/modules/supplier-money/contracts';
import type { AccountsSectionViewer } from '@/views/accounts-desk/sections';
import { RowDecision } from '../department/row-decision';
import { SingleActionForm, type DecisionAction } from './supplier-forms';
import { PaymentStatusBadge } from './supplier-payments';
import { AmountAside, byText, DecisionPanel, Facts, ItemCard, ItemList, LimitLine, ListEmpty, ListTabs, NeedsManager, Status, whenText } from './supplier-kit';
import { MoneyOutTabs } from './money-out-tabs';

/*
 * Accounts · Company funding (owner decision 3). When customer money for a
 * Deal has not arrived, Purchase may ask the company to pay a supplier first.
 * The amount is computed by the database. Up to ₹50,000 of company funding
 * per Deal is approved by Accounts, above that by the branch Manager. Once
 * customer money is verified, Accounts marks the funding recovered.
 *
 * Redesign R4 (A7): Money out tab strip under the header; the ₹50,000 rule
 * said once per page; one decision row per request ("Approve company
 * funding", then "Return with reason" opening the shared reason dialog). A
 * request routed to the branch Manager shows "Needs the branch Manager" and
 * no Approve to Accounts. Same actions, fields and words.
 */

export const FUNDING_TABS: readonly AccountsFundingTab[] = ['to_approve', 'to_recover', 'all'];
const TAB_LABEL: Record<AccountsFundingTab, string> = { to_approve: 'To approve', to_recover: 'To recover', all: 'All' };

export function parseFundingTab(raw: string | string[] | undefined): AccountsFundingTab {
  return parseTab(raw, FUNDING_TABS, 'to_approve');
}

/** The ₹50,000 rule for company funding, said once on the page. */
export const FUNDING_LIMIT_TEXT = 'Accounts approves company funding up to ₹50,000 on one Deal; above that, the branch Manager approves.';

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
      {row.canDecide || row.status === 'pending' ? (
        !row.canDecide && row.route === 'manager' ? (
          <NeedsManager />
        ) : (
          <RowDecision
            recordName={`company funding for payment ${row.paymentRefNo}`}
            action={actions.decide}
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
            disabledReason={row.canDecide ? undefined : 'Another colleague decides this. Nobody approves their own request.'}
          />
        )
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

export function AccountsCompanyFundingPage({
  rows,
  tab,
  actions,
  sectionViewer,
}: {
  rows: CompanyFundingRow[];
  tab: AccountsFundingTab;
  actions: FundingActions;
  /** The menu flags (Money out tab strip); absent: no strip. */
  sectionViewer?: AccountsSectionViewer;
}) {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        eyebrow="Accounts"
        title="Company funding"
        description="Supplier payments the company pays before the customer’s money arrives. Once the customer’s payment is verified, mark the funding recovered."
      />
      <MoneyOutTabs viewer={sectionViewer} currentHref="/app/accounts/funding" />
      <ListTabs label="Company funding filters" basePath="/app/accounts/funding" current={tab} defaultTab="to_approve" tabs={FUNDING_TABS.map((key) => ({ key, label: TAB_LABEL[key], count: key === tab ? rows.length : undefined }))} />
      <LimitLine>{FUNDING_LIMIT_TEXT}</LimitLine>
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
