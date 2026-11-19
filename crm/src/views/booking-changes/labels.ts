import type { StatusTone } from '@/components/ui/badge';
import type { ChangeDepartment, ChangeKind, ChangeStatus, ReconfirmStatus, RemovalRoute } from './types';

/*
 * Words for the change screens (contract 10, 11, screen 15.10). Every status
 * is an icon plus these words, never colour alone. Refusal texts are the
 * frozen staff messages of contract section 13; server actions return them
 * and the screens show them as given (the copies here feed the preview
 * gallery and the blocked-button reasons).
 */

export const KIND_WORD: Record<ChangeKind, string> = {
  change: 'Change',
  add_service: 'Add a service',
  remove_service: 'Remove a service',
};

export const STATUS_WORD: Record<ChangeStatus, string> = {
  // Addendum O2: the Sales owner fills the change version first, then sends it; the Manager approves that version.
  draft: 'Being prepared — not sent yet',
  requested: 'Waiting for the Manager',
  returned: 'Returned — fix and send again',
  approved: 'Approved — waiting for suppliers',
  submitted: 'Waiting for suppliers',
  applied: 'Applied',
  not_possible: 'Not possible — earlier booking stands',
  withdrawn: 'Withdrawn',
};

export const STATUS_TONE: Record<ChangeStatus, StatusTone> = {
  draft: 'neutral',
  requested: 'warning',
  returned: 'danger',
  approved: 'brand',
  submitted: 'brand',
  applied: 'success',
  not_possible: 'neutral',
  withdrawn: 'neutral',
};

export const RECONFIRM_WORD: Record<ReconfirmStatus, string> = {
  pending: 'Waiting for the supplier',
  recorded: 'Supplier agreed',
  refused: 'Supplier refused',
  applied: 'Applied',
  void: 'Called off',
};

export const RECONFIRM_TONE: Record<ReconfirmStatus, StatusTone> = {
  pending: 'warning',
  recorded: 'info',
  refused: 'danger',
  applied: 'success',
  void: 'neutral',
};

export const ROUTE_WORD: Record<RemovalRoute, string> = {
  simple: 'Not booked yet — simple removal',
  cancellation: 'Booked — supplier charges first',
};

export const DEPARTMENT_WORD: Record<ChangeDepartment, string> = {
  purchase: 'Purchase',
  flight: 'Flight',
  visa: 'Visa and passport',
  sales: 'Sales',
  accounts: 'Accounts',
};

/** Frozen staff messages (contract 13) for the refusals these screens meet. */
export const REFUSAL_TEXT: Record<string, string> = {
  changes_off: 'Changes after confirmation (adding or removing services) are not switched on yet.',
  service_changes_off: 'Changes after confirmation (adding or removing services) are not switched on yet.',
  change_open_exists: 'This Deal already has a change in progress. Finish or withdraw it first.',
  change_not_supported: 'This booking cannot be changed here.',
  change_outside_request: 'Some changed services are not part of the approved request.',
  use_change_flow: 'This version belongs to a change request. Use "Send change".',
  change_in_progress: 'A change to this service is waiting for the supplier. No new payment until it is settled.',
  charges_missing: 'The supplier charges for this service are not entered yet.',
  service_removed: 'This service was removed from the booking.',
  not_self_approval: 'You cannot approve your own request. Another Manager approves it.',
  payment_in_progress: 'A supplier payment for this task is in progress. Finish or withdraw it first.',
  evidence_missing: 'Upload the supplier confirmation first.',
  version_changed: 'Someone changed this since you opened it. Reload the page and check again.',
  wrong_state: 'This is no longer waiting for this step. Reload the page.',
  version_superseded: 'The booking was changed in another way meanwhile. Refresh the page.',
};

/** Words for blockedBy codes and not_ready hints (G2 refusals). */
export const BLOCKED_WORD: Record<string, string> = {
  changes_off: REFUSAL_TEXT.changes_off!,
  service_changes_off: REFUSAL_TEXT.service_changes_off!,
  not_committed: 'The booking is not committed yet. Use "Return and revise" on the booking instead.',
  no_confirmed_version: 'There is no confirmed booking yet.',
  trip_cancelled: 'The trip is cancelled. Nothing can be changed.',
  refund_open: 'A refund request is open. Finish or withdraw it first.',
  change_open: REFUSAL_TEXT.change_open_exists!,
  change_not_supported: REFUSAL_TEXT.change_not_supported!,
  nothing_confirmed: 'No service has a supplier confirmation yet. Ask Sales to revise the booking instead.',
  // Track H (11.1–11.3): serviceBlockedBy codes and the new not_ready hints.
  not_submitted: 'The booking has not been submitted yet.',
  revision_open: 'The booking is being revised. Finish or discard that revision first.',
  last_service: 'This is the only service on the booking. Cancel the trip instead.',
  no_service_added: 'Add the new service to the booking first.',
  service_not_removed: 'Take the service out of the booking first.',
  service_booked: 'This service was booked or paid meanwhile. Withdraw this request and ask again so the supplier charges are entered.',
  service_removed: REFUSAL_TEXT.service_removed!,
  nothing_to_add: 'No service can be added to this booking now.',
  nothing_to_remove: 'No service can be removed from this booking now.',
};

export function blockedWord(code: string): string {
  return BLOCKED_WORD[code] ?? 'Not possible right now.';
}

/** Words for the changed-field keys a version stores (G6). Unknown keys are made readable. */
const FIELD_WORD: Record<string, string> = {
  childAges: 'Children\u2019s ages',
  adults: 'Adults',
  children: 'Children',
  infants: 'Infants',
  nights: 'Nights',
  city: 'City',
  notes: 'Notes',
  note: 'Note',
  pax: 'Travellers',
  checkIn: 'Check-in',
  checkOut: 'Check-out',
  rooms: 'Rooms',
  roomType: 'Room type',
  mealPlan: 'Meal plan',
  hotelName: 'Hotel',
  travellers: 'Travellers',
  tripStart: 'Trip start',
  tripEnd: 'Trip end',
  destination: 'Destination',
  pickup: 'Pick-up',
  dropoff: 'Drop-off',
  date: 'Date',
  sellingTotal: 'Selling total',
  paymentPlan: 'Payment plan',
  serviceAdded: 'Service added',
  serviceRemoved: 'Service removed',
};

export function fieldWord(key: string): string {
  const known = FIELD_WORD[key];
  if (known) return known;
  const spaced = key.replace(/[_.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

/** Fields that carry selling data; never shown to a Purchase reader even if a DTO slipped one in. */
export const SELLING_FIELDS = new Set(['sellingTotal', 'paymentPlan']);
