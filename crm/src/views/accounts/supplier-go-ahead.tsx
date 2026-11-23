import { CircleCheck, CircleX, Hourglass, ListChecks, RefreshCw } from 'lucide-react';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { parseTab } from '@/lib/parse-tab';
import { PROCUREMENT_ERROR_TEXT, PURCHASE_BUILD_TEXT, type AccountsGoAheadRow, type GoAheadRequestStatus } from '@/modules/procurement/contracts';
import type { AccountsSectionViewer } from '@/views/accounts-desk/sections';
import { RowDecision } from '../department/row-decision';
import { CostContractNotice } from './contract-compare';
import type { DecisionAction } from './supplier-forms';
import { AmountAside, byText, dateText, Facts, ItemCard, ItemList, ListEmpty, ListTabs, Status, whenText } from './supplier-kit';
import { MoneyOutTabs } from './money-out-tabs';

/*
 * Accounts · Hotel go-ahead requests (Purchase build, owner decision 1).
 * Purchase's one "Send booking request" press asks Accounts for the
 * go-ahead, bound to the booking version, the final rate (cost version) and
 * the amount. Accounts approves only when that booking version's booking
 * review is approved; a request whose booking or rate changed can only be
 * returned. Accounts sees the supplier cost, never the selling price.
 *
 * Redesign R4 (A7): Money out tab strip under the header; one decision row
 * per request ("Give go-ahead", then "Return with reason" opening the shared
 * reason dialog). Same action, fields and words; the database decides.
 */

export type GoAheadTab = 'to_check' | 'all';
export const GO_AHEAD_TABS: readonly GoAheadTab[] = ['to_check', 'all'];

export function parseGoAheadTab(raw: string | string[] | undefined): GoAheadTab {
  return parseTab(raw, GO_AHEAD_TABS, 'to_check');
}

const STATUS: Record<GoAheadRequestStatus, { tone: 'warning' | 'success' | 'danger' | 'neutral'; icon: typeof Hourglass; text: string }> = {
  pending: { tone: 'warning', icon: Hourglass, text: 'Waiting for Accounts' },
  approved: { tone: 'success', icon: CircleCheck, text: 'Go-ahead given' },
  returned: { tone: 'danger', icon: CircleX, text: 'Returned to Purchase' },
  superseded: { tone: 'neutral', icon: RefreshCw, text: 'Replaced by a newer booking request' },
};

const REVIEW: Record<AccountsGoAheadRow['bookingReviewStatus'], { tone: 'success' | 'warning' | 'danger' | 'neutral'; text: string }> = {
  approved: { tone: 'success', text: 'Booking review approved' },
  pending: { tone: 'warning', text: 'Booking review not decided yet' },
  returned: { tone: 'danger', text: 'Booking review returned to Sales' },
  missing: { tone: 'neutral', text: 'Booking review not sent yet' },
};

function stay(row: AccountsGoAheadRow): string {
  if (!row.checkIn) return 'Dates not set';
  return row.checkOut ? `${dateText(row.checkIn)} → ${dateText(row.checkOut)}` : dateText(row.checkIn);
}

export function AccountsGoAheadPage({
  rows,
  tab,
  decideAction,
  sectionViewer,
}: {
  rows: AccountsGoAheadRow[];
  tab: GoAheadTab;
  decideAction: DecisionAction;
  /** The menu flags (Money out tab strip); absent: no strip. */
  sectionViewer?: AccountsSectionViewer;
}) {
  const toCheck = rows.filter((r) => r.status === 'pending');
  const shown = tab === 'to_check' ? toCheck : rows;
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        eyebrow="Accounts"
        title="Hotel go-ahead requests"
        description="Purchase asks for the go-ahead when it sends a hotel booking request. Give it only when the booking review for that version is approved. A go-ahead is not a payment."
      />
      {/* The page loads every request, so the waiting count is known here. */}
      <MoneyOutTabs viewer={sectionViewer} currentHref="/app/accounts/go-ahead" counts={{ '/app/accounts/go-ahead': toCheck.length }} />
      <ListTabs
        label="Go-ahead request filters"
        basePath="/app/accounts/go-ahead"
        current={tab}
        defaultTab="to_check"
        tabs={[
          { key: 'to_check', label: 'To check', count: toCheck.length },
          { key: 'all', label: 'All', count: rows.length },
        ]}
      />
      {shown.length === 0 ? (
        <ListEmpty
          icon={ListChecks}
          title={tab === 'to_check' ? 'Nothing to check' : 'No go-ahead requests yet'}
          description={tab === 'to_check' ? 'No hotel booking request is waiting for your go-ahead.' : 'Requests appear when Purchase sends a hotel booking request.'}
        />
      ) : (
        <ItemList label="Hotel go-ahead requests, newest first">
          {shown.map((r) => (
            <GoAheadItem key={r.requestId} row={r} decideAction={decideAction} />
          ))}
        </ItemList>
      )}
    </div>
  );
}

function GoAheadItem({ row, decideAction }: { row: AccountsGoAheadRow; decideAction: DecisionAction }) {
  const s = STATUS[row.status];
  const review = REVIEW[row.bookingReviewStatus];
  const pending = row.status === 'pending';
  return (
    <ItemCard
      id={`ga-${row.requestId}`}
      eyebrow={
        <>
          <span className="whitespace-nowrap">{row.dealReference}</span> · {row.branchName}
        </>
      }
      title={row.itemTitle}
      status={
        <>
          <Status tone={s.tone} icon={s.icon} label="Go-ahead">
            {s.text}
          </Status>
          <Status tone={review.tone}>
            {review.text}
          </Status>
        </>
      }
      aside={<AmountAside label="Final rate (supplier cost)" paise={row.amountPaise} note={`Rate version ${row.costVersionNo}`} />}
    >
      <Facts
        rows={[
          ['Stay', stay(row)],
          ['Supplier', row.supplierName],
          ['Asked', `${whenText(row.requestedAt)} ${byText(row.requestedByName)}`],
          !!row.decidedAt && ['Decided', `${whenText(row.decidedAt)} ${byText(row.decidedByName)}`],
          !!row.returnReason && ['Reason given', <span key="r" className="whitespace-pre-wrap">{row.returnReason}</span>],
          row.contractState === 'matches' && ['Rate contract', 'Matches the rate contract'],
        ]}
      />
      {/* Accounts phase 3 (9.3, Addendum L2): what Purchase and the Manager see about the rate contract. */}
      <CostContractNotice row={row} />
      {pending && !row.current ? (
        <Notice tone="warning" title="The booking or the final rate changed after this request">
          <p>Nothing to decide here. Purchase sends the booking request again for the new version, which replaces this one.</p>
        </Notice>
      ) : null}
      {pending && (row.canDecide || row.current) ? (
        <RowDecision
          recordName={`${row.dealReference}, ${row.itemTitle}`}
          action={decideAction}
          fields={{ goAheadRequestId: row.requestId, rowVersion: row.rowVersion }}
          approveLabel={PURCHASE_BUILD_TEXT.goAheadApproveLabel}
          help="Approves this hotel at this final rate for this booking version only. Nothing is paid."
          ret={{
            title: `Return the go-ahead request for ${row.dealReference} to Purchase?`,
            effect: `It goes back to ${row.requestedByName ?? 'the Purchase colleague'} with your reason. No go-ahead is given and nothing is paid.`,
            confirmLabel: PURCHASE_BUILD_TEXT.goAheadReturnLabel,
          }}
          approveBlockedReason={
            !row.current
              ? 'Not possible: the booking or the final rate changed.'
              : row.bookingReviewStatus !== 'approved'
                ? PROCUREMENT_ERROR_TEXT.booking_not_approved
                : undefined
          }
          disabledReason={row.canDecide ? undefined : 'Another Accounts colleague decides this. Nobody approves their own request.'}
        />
      ) : null}
    </ItemCard>
  );
}
