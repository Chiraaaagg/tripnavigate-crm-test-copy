import { FileQuestion } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { FocusHashTarget } from '@/components/ui/jump-links';
import { RecordHeader, type NextButton } from '@/components/ui/record-header';
import { Skeleton } from '@/components/ui/skeleton';
import type { DepartmentTaskTabsVM, TaskHistoryVM } from '@/modules/settings/contracts';
import { defaultTaskTab } from '../department/task-default-tab';
import { InternalTaskLine, TaskFilesPanel, TaskHistoryPanel, TaskTabsNav, type TaskFilesVM } from '../department/task-frame';
import { formatIst } from '../deal-labels';
import type { FlightWorkActions } from './actions';
import { chipsOf, FlightStatusBadge } from './bits';
import { FlightDetailsTab } from './details-tab';
import { FlightETicketsCard } from './files';
import { FlightInvoicesSection } from './invoices';
import { ClaimGroupForm, ReassignGroupDrawer } from './header-forms';
import { SectorHistoryCard } from './history-tab';
import { FLIGHT_TEXT } from './labels';
import type { FareApprovalSet, FlightMoney, FlightPaymentContext, FlightSupplierOption, FlightWorkspace } from './types';
import { FlightWorkTab } from './work-tab';

/*
 * Flight workspace (contract 11.1, prototype flightTask FV:1615): one page
 * per Deal covering all its flight tasks. Header: back link, eyebrow, route
 * title, status words + chips, "Taken by"; ONE primary action chosen by
 * state; the Next line (R3: the steps are the Work tab's jump links, O9); link tabs Details · Work · Files ·
 * History (?tab=, server allowlist). `?flight=<taskId>` scrolls to one flight.
 */

export function workspaceTitle(ws: FlightWorkspace): string {
  const routes = ws.flights.map((f) => f.title);
  return routes.length ? routes.join(' · ') : 'Flights';
}

export function workspaceChips(ws: FlightWorkspace, money?: FlightMoney | null | 'error') {
  const m = money && money !== 'error' ? money : null;
  const pending = ws.flights.flatMap((f) => f.changes).filter((c) => c.status === 'pending').length;
  return chipsOf(
    {
      bookingChanged: ws.flights.some((f) => f.bookingChanged),
      unnamed: ws.flights.reduce((n, f) => n + f.unnamedCount, 0),
      changesWaiting: pending,
      faresWaiting: !!m?.approvals?.some((a) => a.status === 'pending'),
      paymentNeeded: !!m?.batches.some((b) => b.payment.state === 'unpaid' || b.payment.state.endsWith('returned')),
    },
    ws.dealKind,
  );
}

/** "Next:" text (lower case after "Next:"). */
export function flightNextText(ws: FlightWorkspace): string {
  if (ws.status.code === 'done') return 'Nothing waiting.';
  if (!ws.assignee.name && !ws.assignee.isYou) return ws.canTake ? 'take these flights' : 'the Flight team takes these flights. You can follow them here';
  if (!ws.assignee.isYou) return ws.canReassign ? `${ws.assignee.name} works on these flights. You can follow them here or move them to another colleague` : `${ws.assignee.name} works on these flights`;
  if (ws.flights.some((f) => f.bookingChanged)) return 'review the booking change Sales sent, then apply it';
  if (ws.flights.some((f) => f.changes.some((c) => c.status === 'pending'))) return ws.dealKind === 'package' ? 'wait for Sales to decide the flight change, then confirm tickets' : 'confirm each traveller’s ticket on the Work tab';
  if (ws.status.code === 'in_progress') return 'confirm each traveller’s ticket on the Work tab';
  if (ws.canComplete) return 'mark the flight done on the Work tab';
  return 'finish the steps listed under “Finish this flight” on the Work tab';
}

/**
 * The record header's one primary button (UX redesign R3, C4): the same
 * labels and targets as before. Off the Work tab it opens Work at the control;
 * on Work it jumps to the control and focuses it. Taking the flights stays
 * the existing "Take these flights" form (beside the title).
 */
function nextButton(ws: FlightWorkspace, tab: string, base: string): NextButton | undefined {
  if (ws.canTake || !ws.canWork || ws.status.code === 'done') return undefined;
  const changed = ws.flights.find((f) => f.bookingChanged);
  const go = (label: string, anchor: string): NextButton => (tab === 'work' ? { label, jumpTo: anchor } : { label, href: `${base}?tab=work#${anchor}` });
  if (changed) return go('Review booking change', `booking-changed-${changed.taskId}`);
  if (ws.status.code === 'in_progress') return tab === 'work' ? undefined : go('Confirm tickets', 'itinerary');
  return tab === 'work' ? undefined : go('Finish this flight', 'finish');
}

export interface FlightWorkspaceProps {
  ws: FlightWorkspace;
  tabs: DepartmentTaskTabsVM;
  actions: FlightWorkActions;
  /** Work tab only: flight_money for this viewer; 'error' = could not load (never "no money"). */
  money?: FlightMoney | null | 'error';
  suppliers?: FlightSupplierOption[];
  paymentContexts?: Record<string, FlightPaymentContext>;
  /** Files tab content (only when Files is open). */
  files?: TaskFilesVM;
  /** History tab: merged task history of the group (only when History is open). */
  history?: TaskHistoryVM | null;
  /** Details tab: ID proofs card (assignee only). */
  idProofs?: ReactNode;
  /** Accounts phase 3 (contract 5.6, screen 15.3): the boarding-pass panels of the group's tasks (Work tab). */
  boardingPasses?: ReactNode;
  /** Work tab: the fare sets the Manager was asked about or approved. */
  approvalSets?: FareApprovalSet[];
  /** `?flight=` focus (scroll target). */
  focusTaskId?: string | null;
  /** Base for the e-ticket download links (route handler owned by the server track). */
  /** E-ticket download route prefix (the server track's route handler): `${eTicketBase}/${evidenceId}`. */
  eTicketBase?: string;
}

export function FlightWorkspacePage(p: FlightWorkspaceProps) {
  const { ws, tabs } = p;
  const base = `/app/flight/deals/${ws.dealId}`;
  const current = tabs.current;
  const taken = ws.assignee.isYou ? 'You' : (ws.assignee.name ?? 'Not taken yet');
  const button = nextButton(ws, current, base);
  const facts = workspaceChips(ws, p.money).map((c) => c.text).join(' · ');
  const internal =
    ws.status.code === 'done'
      ? `Internal task. Tickets issued and marked done${ws.completedAt ? ` on ${formatIst(ws.completedAt)}` : ''}${ws.completedByName ? ` by ${ws.completedByName}` : ''}. Nothing has been sent to the airline or the customer by the CRM.`
      : !ws.canWork && !ws.canTake && !ws.assignee.isYou
        ? 'You are viewing these flights read-only. The Flight team issues the tickets outside the CRM; nothing is sent to the airline or the customer by the CRM.'
        : `${FLIGHT_TEXT.internal}${ws.assignee.isYou ? ' Taking the flights did not book them.' : ''}`;
  return (
    <div className="font-sans text-base text-copy">
      {/* UX redesign R3 (C4, owner Q6): the shared record header around the approved Work form. */}
      <RecordHeader
        back={{ href: '/app/flight', label: 'Back to Flight tasks' }}
        recordId={`Flight · ${ws.dealReference} · ${ws.dealKind === 'package' ? 'Package Deal' : 'Flight-only Deal'}`}
        title={<span className="block wrap-anywhere">{workspaceTitle(ws)}</span>}
        status={
          <>
            <FlightStatusBadge status={ws.status} />
            {facts ? <span className="text-copy">{facts}</span> : null}
          </>
        }
        owner={taken}
        ownerLabel="Taken by"
        actions={
          ws.canTake || (ws.canReassign && ws.assigneeUserId) ? (
            <>
              {ws.canTake ? <ClaimGroupForm dealId={ws.dealId} flightCount={ws.flights.length} action={p.actions.claim} /> : null}
              {ws.canReassign && ws.assigneeUserId && p.actions.reassign ? (
                <ReassignGroupDrawer dealId={ws.dealId} expectedAssignee={ws.assigneeUserId} candidates={ws.reassignCandidates} action={p.actions.reassign} />
              ) : null}
            </>
          ) : undefined
        }
        next={{ text: flightNextText(ws), button }}
        className="mb-4"
      />
      <div className="mb-4">
        <InternalTaskLine>{internal}</InternalTaskLine>
      </div>
      {/* O9 (R3): the steps show once, as the Work tab's step links; the header keeps the status and "Next:". */}
      {/* D6: the bare address opens Work for the holder, so Details gets "?tab=details". */}
      <TaskTabsNav basePath={base} tabs={tabs} defaultTab={defaultTaskTab(tabs.tabs, ws.assignee.isYou)} variant="pill" />
      {current === 'work' ? (
        <div className="flex flex-col gap-5">
          {/* O6: arriving from another tab at "?tab=work#…" moves focus to that control. */}
          <FocusHashTarget />
          <FlightWorkTab ws={ws} actions={p.actions} money={p.money ?? null} suppliers={p.suppliers ?? []} paymentContexts={p.paymentContexts ?? {}} eTicketBase={p.eTicketBase} focusTaskId={p.focusTaskId ?? null} approvalSets={p.approvalSets} />
          {p.boardingPasses}
        </div>
      ) : current === 'files' ? (
        <div className="flex flex-col gap-5">
          <TaskFilesPanel files={p.files ?? {}} />
          {ws.eTickets.length > 0 && p.eTicketBase ? <FlightETicketsCard files={ws.eTickets} base={p.eTicketBase} /> : null}
          {p.money && p.money !== 'error' ? (
            <Card>
              <CardBody>
                <FlightInvoicesSection money={p.money} canUpload={ws.assignee.isYou} actions={p.actions.invoices} dealId={ws.dealId} />
              </CardBody>
            </Card>
          ) : null}
        </div>
      ) : current === 'history' ? (
        <div className="flex flex-col gap-5">
          {p.history ? <TaskHistoryPanel history={p.history} /> : null}
          <SectorHistoryCard ws={ws} />
        </div>
      ) : (
        <FlightDetailsTab ws={ws} idProofs={p.idProofs} money={p.money && p.money !== 'error' ? p.money : null} />
      )}
    </div>
  );
}

export function FlightWorkspaceNotFound() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Flights not available" />
      <Card role="status">
        <div className="flex items-start gap-3 px-4.5 py-4">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-control bg-brand-tint text-brand">
            <FileQuestion className="size-4.5" />
          </span>
          <p className="m-0 self-center text-copy">This item is no longer available. Reload the page.</p>
        </div>
      </Card>
      <p className="m-0 mt-4">
        <Link href="/app/flight" className={buttonVariants({ variant: 'secondary' })}>
          Back to Flight tasks
        </Link>
      </p>
    </div>
  );
}

export function FlightWorkspaceLoading() {
  return (
    <div className="flex flex-col gap-4 font-sans">
      <h1 className="sr-only">Flights</h1>
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading the flights…
      </p>
      <div aria-busy="true" className="flex flex-col gap-4">
        <Skeleton className="h-7 w-56 max-w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}
