import type { ChangeKind, ChangeStatus, CrsType, DeciderKind, PaxType, PaymentState, ProgressKey, SectorDisplayState } from './types';

/*
 * Words the Flight screens show (Flight build contract sections 6.3, 7 and
 * 11). Status words and refusal messages are frozen by the contract; the
 * server module repeats them in its contracts.ts, and the database stays the
 * authority for every state.
 */

export const CRS_LABEL: Record<CrsType, string> = {
  amadeus: 'Amadeus',
  galileo: 'Galileo',
  sabre: 'Sabre',
  airline_direct: 'Airline direct',
  other: 'Other',
};
export const CRS_TYPES: CrsType[] = ['amadeus', 'galileo', 'sabre', 'airline_direct', 'other'];

export const PAX_LABEL: Record<PaxType, string> = { adult: 'Adult', child: 'Child', infant: 'Infant' };
export const PAX_ORDER: PaxType[] = ['adult', 'child', 'infant'];

export const CABINS = ['Economy', 'Premium Economy', 'Business', 'First'] as const;

/** Contract 6.3: staff messages per refusal token (frozen). */
export const FLIGHT_ERROR_TEXT: Record<string, string> = {
  not_authorized: 'You cannot do this on this flight.',
  not_found: 'This item is no longer available. Reload the page.',
  version_changed: 'Someone changed this flight meanwhile. Reload and try again.',
  duplicate_request: 'This was already sent with different details. Reload the page.',
  task_conflict: 'Another Flight colleague took these flights first.',
  invalid_input: 'Check the highlighted field.',
  not_ready: 'Finish the steps listed before doing this.',
  booking_changed: 'Sales sent a new booking. Review "Booking changed" first.',
  traveller_not_on_sector: 'A chosen traveller is not on that flight.',
  held_by_change: 'This traveller is waiting for a change decision.',
  already_confirmed: 'This traveller already has a ticket on that flight.',
  no_difference: 'Change at least one detail. It is the same as the current flight.',
  duplicate_flight: 'These travellers are already on this exact flight.',
  not_self_approval: 'You cannot approve your own request.',
  already_decided: 'This was already decided. Reload the page.',
  ticket_number_taken: 'This ticket number already belongs to another traveller.',
  discount_over_fare: 'The discount is more than the fare.',
  over_budget: 'The supplier cost is above the approved budget. Ask the Manager to approve these fares.',
  fare_approval_mismatch: 'The fares changed after the Manager approved them. Ask again.',
  not_over_budget: 'These fares are within the budget. No approval is needed.',
  payment_in_progress: 'A payment for these tickets already exists.',
  direct_payment_over_limit: 'Above ₹50,000 for this supplier on this Deal, raise a payment request.',
  receipt_required: 'Attach the payment proof first.',
  cost_locked: 'This payment record is with Accounts and cannot be changed now.',
  trip_cancelled: 'This trip is cancelled. No new tickets or payments.',
  duplicate_supplier: 'A supplier with this name already exists.',
};

/** Contract 7: checklist labels per done-issue token, in order. */
export const DONE_CHECKLIST: Array<{ token: string; label: string }> = [
  { token: 'booking_changed', label: 'Booking changes reviewed' },
  { token: 'travellers_unnamed', label: 'Every traveller is named' },
  { token: 'traveller_without_flight', label: 'Every traveller has a flight' },
  { token: 'change_pending', label: 'No change waiting for approval' },
  { token: 'tickets_pending', label: 'Every traveller confirmed on every active flight' },
  { token: 'traveller_changed', label: 'Ticket names match the booking' },
  { token: 'fare_approval_pending', label: 'No fares waiting for the Manager' },
  { token: 'payment_missing', label: 'Every ticket batch is paid or has an approved payment request' },
  { token: 'payment_returned', label: 'No payment returned by Accounts' },
  { token: 'eticket_missing', label: 'E-tickets attached' },
];

export const PROGRESS_LABEL: Record<ProgressKey, string> = {
  take: 'Take',
  approvals: 'Approvals',
  tickets: 'Confirm tickets',
  payment: 'Pay supplier',
  etickets: 'Attach e-tickets',
  done: 'Flight done',
};

export const CHANGE_KIND_LABEL: Record<ChangeKind, string> = {
  alternative: 'Alternative flight',
  added_instead: 'Added sector (instead of a flight)',
  added_extra: 'Added sector (extra journey)',
  passenger_itinerary: 'Passenger itinerary',
};

export const CHANGE_STATUS_LABEL: Record<ChangeStatus, string> = {
  pending: 'Waiting for a decision',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  superseded: 'Replaced by a booking change',
};

export const DECIDER_LABEL: Record<DeciderKind, string> = {
  sales_owner: 'Sales owner',
  branch_manager: 'Branch Manager',
  flight_owner: 'Flight (flight-only Deal)',
};

export const SECTOR_STATE_LABEL: Record<SectorDisplayState, string> = {
  active: 'Active',
  pending: 'Waiting for approval',
  replaced: 'Replaced',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  superseded: 'Replaced by a booking change',
  booking_removed: 'Removed by a booking change',
};

export const ENDED_REASON_LABEL: Record<string, string> = {
  change_approved: 'Moved by an approved change',
  change_rejected: 'Change rejected',
  change_withdrawn: 'Change withdrawn',
  change_superseded: 'Change replaced',
  booking_changed: 'Booking changed',
  traveller_removed: 'Removed from the booking',
  screenshot_replaced: 'Sectors re-entered',
};

export const PAYMENT_STATE_LABEL: Record<PaymentState, string> = {
  unpaid: 'Not paid yet',
  direct_submitted: 'Paid directly · with Accounts',
  direct_accepted: 'Paid directly · accepted by Accounts',
  direct_returned: 'Paid directly · returned by Accounts',
  request_pending: 'Payment request waiting for approval',
  request_approved: 'Payment request approved',
  request_paid: 'Paid by Accounts',
  request_verified: 'Paid and verified',
  request_returned: 'Payment request returned',
  request_cancelled: 'Payment request cancelled',
};

/** History kinds of flight events (contract 9.5) as titles for the Deal History and the task History. */
export const FLIGHT_HISTORY_TITLE: Record<string, string> = {
  taken: 'Flights taken',
  reassigned: 'Flights moved to another Flight colleague',
  booking_change_applied: 'New booking applied to the flight',
  sectors_entered: 'Sectors typed from the screenshot',
  sector_details_filled: 'Missing flight details filled in',
  change_submitted: 'Flight change sent for a decision',
  change_approved: 'Flight change approved',
  change_rejected: 'Flight change rejected',
  change_withdrawn: 'Flight change withdrawn',
  tickets_confirmed: 'Tickets confirmed',
  ticket_corrected: 'Ticket corrected',
  fare_approval_requested: 'Manager asked to approve fares above budget',
  fare_approval_approved: 'Fares above budget approved',
  fare_approval_returned: 'Fares above budget returned',
  fare_approval_withdrawn: 'Fare approval request withdrawn',
  direct_payment_recorded: 'Direct payment recorded',
  payment_requested: 'Supplier payment requested',
  payment_resubmitted: 'Supplier payment request sent again',
  payment_cancelled: 'Supplier payment request cancelled',
  payment_approved: 'Supplier payment approved',
  payment_returned: 'Supplier payment returned',
  payment_recorded: 'Supplier payment recorded by Accounts',
  payment_verified: 'Supplier payment verified',
  completed: 'Flight marked done · ticket issued',
  file_added: 'File added',
  file_removed: 'File removed',
};

export const FLIGHT_TEXT = {
  internal: 'Internal task. Tickets are issued outside the CRM. Nothing is sent to the airline or the customer by the CRM.',
  queueNote: 'One row per Deal. Taking a Deal takes all its flights.',
  noMoney: 'Customer prices and proof files are never shown here.',
  reviewFirst: 'Review the booking change first.',
  doneDialog: 'Sales and Accounts see that the tickets are issued. Ticket details stay correctable with a reason.',
  unknownOutcome: 'We could not confirm the result. Reload the page to see what was saved. Your typed details are still here.',
} as const;
