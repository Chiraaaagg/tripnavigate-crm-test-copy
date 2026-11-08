import type { FlightWorkActions } from './actions';
import { ConfirmTicketsBar } from './confirm-tickets';
import { FinishCard } from './finish';
import { ItineraryCard } from './itinerary';
import { FLIGHT_TEXT } from './labels';
import { CostAndPaymentCard, MARGINS_BLOCKED_TEXT, marginsBlocked } from './money';
import { SelectionProvider } from './selection';
import { FlightSuppliersCard } from './suppliers';
import { ConfirmedTicketsCard } from './tickets';
import type { FareApprovalSet, FlightMoney, FlightPaymentContext, FlightSupplierOption, FlightWorkspace } from './types';
import { BookingChangedCard, ChangesCard, ScreenshotSectorsCard } from './work-parts';

/*
 * Work tab of the Flight workspace (contract 11.1), in working order: per
 * flight its "Booking changed" review, screenshot sectors and itinerary with
 * its changes; then Confirm tickets (the tab's one primary action), the
 * confirmed tickets by PNR, cost and payment, and Finish this flight.
 * Anything that changes a flight whose booking changed is held back with one
 * reason ("Review the booking change first").
 */

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
  return (
    <SelectionProvider>
      <div className="flex flex-col gap-5" id="itinerary" tabIndex={-1}>
        {ws.assignee.name || ws.assignee.isYou ? null : (
          <p className="m-0 text-copy">The itinerary opens for work after a Flight colleague takes these flights.</p>
        )}
        {flights.map((f) => {
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
        })}
        {working ? (
          <ConfirmTicketsBar ws={ws} actions={actions} suppliers={suppliers} approvals={moneyOk?.approvals ?? []} approvalSets={approvalSets} blockedReason={anyChanged ? FLIGHT_TEXT.reviewFirst : marginsBlocked(moneyOk) ? MARGINS_BLOCKED_TEXT : null} />
        ) : null}
        <ConfirmedTicketsCard ws={ws} actions={actions} />
        <CostAndPaymentCard money={money} canWork={working} canUploadInvoice={ws.assignee.isYou} dealId={ws.dealId} paymentContexts={paymentContexts} actions={actions} />
        {working && actions.suppliers ? <FlightSuppliersCard suppliers={suppliers} actions={actions.suppliers} /> : null}
        <FinishCard ws={ws} money={moneyOk} actions={actions} eTicketBase={eTicketBase} />
      </div>
    </SelectionProvider>
  );
}
