import type { ReactNode } from 'react';
import { RecordTabs } from '@/components/ui/record-tabs';
import type { DealWorkspaceVM } from '@/modules/deals/workspace-contract';
import { DealDocumentsTab } from './documents';
import { DealWorkspaceHeader } from './header';
import { DealHistoryTab } from './history';
import { DealMoneyTab } from './money';
import { DealOverviewTab } from './overview';
import { TabUnavailable } from './tab-error';

/*
 * Deal record (DE-02; UX redesign R2). Server component: the record header
 * with "Next:" and one primary action, server-rendered link tabs (`?tab=`;
 * Overview · Services and tasks · Money · Documents · Messages · History),
 * then ONLY the open tab's body. Other tabs' data is never rendered or sent
 * (money-privacy P6). The bodies other than the view models are today's
 * server cards, placed by the route. A tab whose model or slot is missing
 * shows the per-tab error card (SH-06); the rest of the record stays.
 */

export interface DealWorkspaceViewProps {
  workspace: DealWorkspaceVM;
  /** Today's StartBookNowForm, used as the header primary when header.primary.kind is 'start_booking'. */
  startBookingForm?: ReactNode;
  /** ?tab=services body (booking card, services card, flights, visa, changes, trip cancellation). */
  servicesTab?: ReactNode;
  /** ?tab=money: the "Tell Accounts about a payment" control for the Money card header (price readers who may report). */
  reportPayment?: ReactNode;
  /** ?tab=money cards after the booking money (customer dues, refunds). Price readers and money readers (the route decides). */
  moneyTab?: ReactNode;
  /** ?tab=documents cards after the files (customer documents, quotations, itineraries). */
  documentsTab?: ReactNode;
  /** ?tab=messages body (the customer messages card). */
  messagesTab?: ReactNode;
  /** Live-update indicator (DA-46). */
  live?: ReactNode;
}

type BodyProps = Pick<DealWorkspaceViewProps, 'workspace' | 'servicesTab' | 'reportPayment' | 'moneyTab' | 'documentsTab' | 'messagesTab'>;

function TabBody({ workspace, servicesTab, reportPayment, moneyTab, documentsTab, messagesTab }: BodyProps) {
  switch (workspace.current) {
    case 'services':
      return servicesTab ? <div className="flex min-w-0 flex-col gap-5 [&>.work-panel]:m-0">{servicesTab}</div> : <TabUnavailable thing="Services and tasks" />;
    case 'money':
      // A money reader without the price summary (a branch Manager through a deal.read grant) has no
      // booking-money card, only the dues and refunds cards the route rendered.
      return workspace.money || moneyTab ? (
        <div className="flex min-w-0 flex-col gap-5">
          {workspace.money ? <DealMoneyTab money={workspace.money} reportPayment={reportPayment} /> : null}
          {moneyTab}
        </div>
      ) : (
        <TabUnavailable thing="Money" />
      );
    case 'documents':
      return workspace.documents || documentsTab ? (
        <div className="flex min-w-0 flex-col gap-5">
          {workspace.documents ? <DealDocumentsTab documents={workspace.documents} /> : null}
          {documentsTab}
        </div>
      ) : (
        <TabUnavailable thing="Documents" />
      );
    case 'messages':
      return messagesTab ? <div className="flex min-w-0 flex-col gap-5">{messagesTab}</div> : <TabUnavailable thing="Messages" />;
    case 'history':
      return workspace.history ? <DealHistoryTab history={workspace.history} /> : <TabUnavailable thing="History" />;
    case 'overview':
      return workspace.overview ? <DealOverviewTab overview={workspace.overview} /> : <TabUnavailable thing="Overview" />;
  }
}

export function DealWorkspaceView({ workspace, startBookingForm, servicesTab, reportPayment, moneyTab, documentsTab, messagesTab, live }: DealWorkspaceViewProps) {
  return (
    <div className="font-sans text-base text-copy">
      <DealWorkspaceHeader header={workspace.header} startBookingForm={startBookingForm} live={live} currentTab={workspace.current} />
      {/* C5 pill look; record tabs never carry a count (money-privacy P6), so none is passed. */}
      <RecordTabs tabs={workspace.tabs} label="Deal sections" variant="pill" className="mb-4" />
      <TabBody workspace={workspace} servicesTab={servicesTab} reportPayment={reportPayment} moneyTab={moneyTab} documentsTab={documentsTab} messagesTab={messagesTab} />
    </div>
  );
}
