import { ChevronRight } from 'lucide-react';
import type React from 'react';
import { cn, focusRing } from '@/components/ui/cn';
import { JumpLinks } from '@/components/ui/jump-links';
import type { FlightWorkActions } from './actions';
import { ConfirmTicketsBar } from './confirm-tickets';
import { FinishCard } from './finish';
import { ItineraryCard } from './itinerary';
import { FLIGHT_TEXT, PROGRESS_LABEL } from './labels';
import { CostAndPaymentCard, MARGINS_BLOCKED_TEXT, marginsBlocked } from './money';
import { SelectionProvider } from './selection';
import { FlightSuppliersCard } from './suppliers';
import { ConfirmedTicketsCard } from './tickets';
import { cancelledBatches } from '../cancellations/flight-model';
import { FlightTripCancelledCard } from './trip-cancelled';
import type { FareApprovalSet, FlightMoney, FlightPaymentContext, FlightSupplierOption, FlightWorkspace, ProgressKey, ProgressStep } from './types';
import { BookingChangedCard, ChangesCard, ScreenshotSectorsCard } from './work-parts';

/*
 * Work tab of the Flight workspace (contract 11.1), in working order: per
 * flight its "Booking changed" review, screenshot sectors and itinerary with
 * its changes; then Confirm tickets (the tab's one primary action), the
 * confirmed tickets by PNR, cost and payment, and Finish this flight.
 * Anything that changes a flight whose booking changed is held back with one
 * reason ("Review the booking change first").
 *
 * O9 (owner, 16 November 2026; design plan 2.4): the tracker steps are jump
 * links at the top of the tab, and a finished step folds to one line
 * ("Show details" opens it): the itinerary once every ticket is confirmed and
 * nothing waits on a flight, and Cost and payment once the supplier is paid
 * and no invoice is missing. Nothing that still needs someone folds.
 */

const STEP_STATE_TEXT = { done: 'done', current: 'current step', todo: 'not started' } as const;

/**
 * The tracker steps as in-page links (shared JumpLinks): a jump opens a folded
 * block and moves focus to it; the current step is marked aria-current="step".
 */
function StepJumpLinks({ links }: { links: Array<{ step: ProgressStep; targetId: string }> }) {
  return (
    <JumpLinks
      label="Flight steps on this page"
      className="mb-0"
      links={links.map(({ step, targetId }) => ({
        targetId,
        current: step.state === 'current',
        label: (
          <>
            {PROGRESS_LABEL[step.key]}
            {step.state === 'done' ? <span className="font-normal text-quiet"> (done)</span> : <span className="sr-only">, {STEP_STATE_TEXT[step.state]}</span>}
          </>
        ),
      }))}
    />
  );
}

/** A finished step as one line; its blocks open below it (native <details>, no script, no height animation). */
function StepFold({ id, title, step, children }: { id: string; title: string; step: ProgressStep; children: React.ReactNode }) {
  return (
    <details id={id} className="group/fold flex flex-col" data-slot="fold">
      <summary
        className={cn(
          'flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-2.5 gap-y-1 rounded-card border border-line bg-card px-4.5 py-2.5 font-medium text-ink shadow-card hover:bg-wash [&::-webkit-details-marker]:hidden',
          focusRing,
          'focus-visible:-outline-offset-2',
        )}
      >
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-quiet group-open/fold:rotate-90" />
        <span className="min-w-0 flex-1">{title}</span>
        <span className="text-sm font-normal text-quiet">
          {PROGRESS_LABEL[step.key]}: done{step.sub ? ` · ${step.sub}` : ''}
          <span className="sr-only">. Show details</span>
        </span>
      </summary>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </details>
  );
}

export function FlightWorkTab({
  ws,
  actions,
  money,
  suppliers,
  paymentContexts,
  eTicketBase,
  focusTaskId,
  approvalSets,
}: {
  approvalSets?: FareApprovalSet[];
  ws: FlightWorkspace;
  actions: FlightWorkActions;
  money: FlightMoney | null | 'error';
  suppliers: FlightSupplierOption[];
  paymentContexts: Record<string, FlightPaymentContext>;
  eTicketBase?: string;
  focusTaskId: string | null;
}) {
  const working = ws.canWork && ws.status.code !== 'done';
  const anyChanged = ws.flights.some((f) => f.bookingChanged);
  const deciderWord = 'Sales';
  const moneyOk = money && money !== 'error' ? money : null;
  const flights = focusTaskId ? [...ws.flights].sort((a, b) => (a.taskId === focusTaskId ? -1 : b.taskId === focusTaskId ? 1 : 0)) : ws.flights;
  const stepOf = (key: ProgressKey) => ws.progress.find((p) => p.key === key);
  const ticketsStep = stepOf('tickets');
  const paymentStep = stepOf('payment');
  // O9: fold only what nobody needs any more.
  const flightsWaiting = ws.flights.some((f) => f.bookingChanged || f.changes.some((c) => c.status === 'pending' || c.needsAck));
  const foldItinerary = ticketsStep?.state === 'done' && !flightsWaiting && !focusTaskId;
  const foldPayment = paymentStep?.state === 'done' && !!moneyOk && !moneyOk.invoiceMissing && !moneyOk.overBudget && cancelledBatches(money).length === 0;
  const firstChanges = flights.find((f) => f.changes.some((c) => c.status === 'pending' || c.status === 'rejected' || c.needsAck || c.status === 'approved'));
  const target: Partial<Record<ProgressKey, string>> = {
    approvals: foldItinerary ? 'step-itinerary' : firstChanges ? `changes-${firstChanges.taskId}` : working ? 'confirm-tickets' : undefined,
    tickets: working && ticketsStep?.state !== 'done' ? 'confirm-tickets' : 'tickets',
    payment: foldPayment ? 'step-payment' : 'cost-payment',
    etickets: 'finish',
    done: 'finish',
  };
  const links = ws.assignee.name || ws.assignee.isYou ? ws.progress.flatMap((step) => (target[step.key] ? [{ step, targetId: target[step.key]! }] : [])) : [];
  const flightBlocks = flights.map((f) => {
    const blocked = f.bookingChanged ? FLIGHT_TEXT.reviewFirst : null;
    return (
      <div key={f.taskId} id={`flight-${f.taskId}`} className="flex flex-col gap-4">
        {f.bookingChanged ? <BookingChangedCard f={f} diff={f.bookingChanged} canWork={working} action={actions.applyBookingChange} /> : null}
        {f.entryMode === 'screenshot' && (working || f.sectors.length > 0) ? (
          <ScreenshotSectorsCard f={f} canWork={working} blockedReason={blocked} action={actions.saveScreenshotSectors} />
        ) : null}
        <ItineraryCard f={f} dealKind={ws.dealKind} canWork={working} blockedReason={blocked} actions={actions} deciderWord={deciderWord} />
        <ChangesCard f={f} dealKind={ws.dealKind} canWork={working} actions={actions} />
      </div>
    );
  });
  const costCard = <CostAndPaymentCard money={money} canWork={working} canUploadInvoice={ws.assignee.isYou} dealId={ws.dealId} paymentContexts={paymentContexts} actions={actions} />;
  return (
    <SelectionProvider>
      <div className="flex flex-col gap-5" id="itinerary" tabIndex={-1}>
        <StepJumpLinks links={links} />
        {/* Accounts phase 2 (contract 7.4 C9): the trip-cancelled charges come first while they are open. */}
        {cancelledBatches(money).length > 0 ? <FlightTripCancelledCard money={money} dealId={ws.dealId} action={actions.setCancellationCharge} /> : null}
        {ws.assignee.name || ws.assignee.isYou ? null : (
          <p className="m-0 text-copy">The itinerary opens for work after a Flight colleague takes these flights.</p>
        )}
        {foldItinerary && ticketsStep ? (
          <StepFold id="step-itinerary" title="Itinerary and flight changes" step={ticketsStep}>
            {flightBlocks}
          </StepFold>
        ) : (
          flightBlocks
        )}
        {working ? (
          <ConfirmTicketsBar ws={ws} actions={actions} suppliers={suppliers} approvals={moneyOk?.approvals ?? []} approvalSets={approvalSets} blockedReason={anyChanged ? FLIGHT_TEXT.reviewFirst : marginsBlocked(moneyOk) ? MARGINS_BLOCKED_TEXT : null} />
        ) : null}
        <ConfirmedTicketsCard ws={ws} actions={actions} />
        {foldPayment && paymentStep ? (
          <StepFold id="step-payment" title="Cost and payment" step={paymentStep}>
            {costCard}
          </StepFold>
        ) : (
          costCard
        )}
        {working && actions.suppliers ? <FlightSuppliersCard suppliers={suppliers} actions={actions.suppliers} /> : null}
        <FinishCard ws={ws} money={moneyOk} actions={actions} eTicketBase={eTicketBase} />
      </div>
    </SelectionProvider>
  );
}
