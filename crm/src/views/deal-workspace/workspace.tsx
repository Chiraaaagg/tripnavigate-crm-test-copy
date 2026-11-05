import type { ReactNode } from 'react';
import { RecordTabs } from '@/components/ui/record-tabs';
import type { DealWorkspaceVM } from '@/modules/deals/workspace-contract';
import { BackLink } from '../list-parts';
import { DealDocumentsTab } from './documents';
import { DealWorkspaceHeader } from './header';
import { DealHistoryTab } from './history';
import { DealMoneyTab } from './money';
import { DealOverviewTab } from './overview';
import { TabUnavailable } from './tab-error';

/*
 * Deal record (DE-02, Direction A Batch 1). Server component: header with one
 * primary action, server-rendered link tabs (`?tab=`), then ONLY the open
 * tab's body. Other tabs' data is never rendered or sent (money-privacy P6).
 * Services and tasks and Quotations bodies are today's server cards, placed
 * by the route. A tab whose model or slot is missing shows the per-tab error
 * card (SH-06); the rest of the record stays.
 * Props: luna-batch1-props.md. Patterns: shadcn Tabs 953 look on the CRM's
 * link tabs; record header = catalog gap G9 (composition).
 */

export interface DealWorkspaceViewProps {
  workspace: DealWorkspaceVM;
  /** Today's StartBookNowForm, used as the header primary when header.primary.kind is 'start_booking'. */
  startBookingForm?: ReactNode;
  /** ?tab=services body (booking card, services card, legacy hotel panel or their unavailable cards). */
  servicesTab?: ReactNode;
  /** ?tab=quotations body (quotations and itineraries cards). */
  quotationsTab?: ReactNode;
  /** Live-update indicator (DA-46). */
  live?: ReactNode;
}

function TabBody({ workspace, servicesTab, quotationsTab }: Pick<DealWorkspaceViewProps, 'workspace' | 'servicesTab' | 'quotationsTab'>) {
  switch (workspace.current) {
    case 'services':
      return servicesTab ? <div className="flex min-w-0 flex-col gap-5 [&>.work-panel]:m-0">{servicesTab}</div> : <TabUnavailable thing="Services and tasks" />;
    case 'quotations':
      return quotationsTab ? <div className="flex min-w-0 flex-col gap-5">{quotationsTab}</div> : <TabUnavailable thing="Quotations" />;
    case 'documents':
      return workspace.documents ? <DealDocumentsTab documents={workspace.documents} /> : <TabUnavailable thing="Documents" />;
    case 'money':
      return workspace.money ? <DealMoneyTab money={workspace.money} /> : <TabUnavailable thing="Money" />;
    case 'history':
      return workspace.history ? <DealHistoryTab history={workspace.history} /> : <TabUnavailable thing="History" />;
    case 'overview':
      return workspace.overview ? <DealOverviewTab overview={workspace.overview} /> : <TabUnavailable thing="Overview" />;
  }
}

export function DealWorkspaceView({ workspace, startBookingForm, servicesTab, quotationsTab, live }: DealWorkspaceViewProps) {
  return (
    <div className="font-sans text-base text-copy">
      <BackLink href="/app/deals">Back to deals</BackLink>
      <DealWorkspaceHeader header={workspace.header} startBookingForm={startBookingForm} live={live} />
      <RecordTabs tabs={workspace.tabs} label="Deal sections" className="mb-4" />
      <TabBody workspace={workspace} servicesTab={servicesTab} quotationsTab={quotationsTab} />
    </div>
  );
}
