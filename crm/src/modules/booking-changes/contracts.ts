/**
 * Booking changes (Accounts phase 3, track G; track H adds add / remove
 * services): frozen vocabularies, refusal tokens and staff messages, form
 * field names (Phase 2 Addendum L3) and command result shapes.
 *
 * Contract: implementation/accounts-phase3-2026-11-12/contract.md sections
 * 10, 11, 13, 14, 17.3, 21 LD23-LD32, LD36, LD37, Addendum O1. Database:
 * crm/supabase/migrations/20261205000600..0680 (track G) and
 * 20261205000700..0740 (track H). Money is whole paise as decimal strings;
 * no floats.
 */
import { CONFLICT_STATES } from '@/lib/sqlstate';

export type Paise = string;

export const CHANGE_KINDS = ['change', 'add_service', 'remove_service'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/**
 * Addendum O2 (owner, 13 November 2026): draft (the Sales owner fills the change
 * version) -> requested (sent: waiting for the branch Manager, who approves
 * exactly that version) -> approved (waiting for supplier reconfirmations) ->
 * applied; returned goes back to the Sales owner (same version). 'submitted' is
 * not written any more (older rows only).
 */
export const CHANGE_STATUSES = ['draft', 'requested', 'returned', 'approved', 'submitted', 'applied', 'not_possible', 'withdrawn'] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

export const RECONFIRM_STATUSES = ['pending', 'recorded', 'refused', 'applied', 'void'] as const;
export type ReconfirmStatus = (typeof RECONFIRM_STATUSES)[number];

export const CHANGE_DECISIONS = ['approve', 'return'] as const;
export type ChangeDecision = (typeof CHANGE_DECISIONS)[number];

export const CHANGE_LIST_PRESETS = ['all', 'open', 'to_approve'] as const;
export type ChangeListPreset = (typeof CHANGE_LIST_PRESETS)[number];

/** Track H (11.3): how a service is removed - simple (nothing booked or paid) or through the supplier charges. */
export const REMOVAL_ROUTES = ['simple', 'cancellation'] as const;
export type RemovalRoute = (typeof REMOVAL_ROUTES)[number];

/** Track H (LD31): how a removed service's task ended (fulfilment_tasks.closed_state). */
export const CLOSED_STATES = ['withdrawn', 'cancelled'] as const;
export type ClosedState = (typeof CLOSED_STATES)[number];

/** Track H (11.2): service types the Sales owner may add (R-G1 addableTypes; train stays on hold). */
export const ADDABLE_SERVICE_TYPES = ['hotel', 'transfer', 'activity', 'flight', 'visa', 'passport'] as const;
export type AddableServiceType = (typeof ADDABLE_SERVICE_TYPES)[number];

/** Track H (11.3): departments that enter supplier charges for a booked removal. */
export const CHARGE_DEPARTMENTS = ['purchase', 'flight', 'visa'] as const;
export type ChargeDepartment = (typeof CHARGE_DEPARTMENTS)[number];

/** Track H: R-G1 serviceBlockedBy codes (why a service cannot be added or removed now; database order). */
export const SERVICE_BLOCK_CODES = [
  'service_changes_off', 'change_not_supported', 'not_submitted', 'trip_cancelled', 'refund_open', 'change_open', 'revision_open',
] as const;
export type ServiceBlockCode = (typeof SERVICE_BLOCK_CODES)[number];

/** R-G1 blockedBy codes (database order). */
export const CHANGE_BLOCK_CODES = ['changes_off', 'change_not_supported', 'not_committed', 'trip_cancelled', 'refund_open', 'change_open'] as const;
export type ChangeBlockCode = (typeof CHANGE_BLOCK_CODES)[number];

/** Audit actions (contract 17.3). */
export const CHANGE_AUDIT_ACTIONS = [
  'booking.change_requested',
  'booking.change_resubmitted',
  'booking.change_withdrawn',
  'booking.change_approved',
  'booking.change_returned',
  'booking.change_version_opened',
  'booking.change_submitted',
  'booking.change_applied',
  'booking.change_not_possible',
  'purchase.reconfirm_recorded',
  'purchase.reconfirm_refused',
  'purchase.reconfirm_over_budget_approved',
  'settings.booking_changes_changed',
  // Track H (17.3).
  'fulfilment.task_closed',
] as const;

// ---------------------------------------------------------------------------
// Refusal tokens (section 13) and frozen messages
// ---------------------------------------------------------------------------

export type ChangeErrorCode =
  | 'changes_off'
  | 'service_changes_off'
  | 'change_open_exists'
  | 'change_not_supported'
  | 'change_outside_request'
  | 'use_change_flow'
  | 'change_in_progress'
  | 'charges_missing'
  | 'service_removed'
  | 'payment_in_progress'
  | 'evidence_missing'
  | 'not_self_approval'
  | 'over_budget'
  | 'trip_cancelled'
  | 'not_ready'
  | 'wrong_state'
  | 'version_changed'
  | 'version_superseded'
  | 'request_conflict'
  | 'invalid_input'
  | 'not_authorized'
  | 'not_found'
  | 'deal_removed';

/** Each token and the only SQLSTATE it may arrive with. */
export const CHANGE_ERROR_STATES: Readonly<Record<ChangeErrorCode, string | readonly string[]>> = Object.freeze({
  changes_off: '55000',
  service_changes_off: '55000',
  change_open_exists: '23505',
  change_not_supported: '55000',
  change_outside_request: '22023',
  use_change_flow: '55000',
  change_in_progress: '55000',
  charges_missing: '55000',
  service_removed: '55000',
  payment_in_progress: '55000',
  evidence_missing: '55000',
  not_self_approval: '42501',
  over_budget: '55000',
  trip_cancelled: '55000',
  not_ready: '55000',
  wrong_state: '55000',
  version_changed: CONFLICT_STATES,
  version_superseded: '55000',
  request_conflict: CONFLICT_STATES,
  invalid_input: '22023',
  not_authorized: '42501',
  not_found: 'P0002',
  deal_removed: '55000',
});

export const CHANGE_ERROR_TEXT: Readonly<Record<ChangeErrorCode | 'session', string>> = Object.freeze({
  changes_off: 'Changes after confirmation (adding or removing services) are not switched on yet.',
  service_changes_off: 'Changes after confirmation (adding or removing services) are not switched on yet.',
  change_open_exists: 'This Deal already has a change in progress. Finish or withdraw it first.',
  change_not_supported: 'This booking cannot be changed here.',
  change_outside_request: 'Some changed services are not part of the approved request.',
  use_change_flow: 'This version belongs to a change request. Use "Send change".',
  change_in_progress: 'A change to this service is waiting for the supplier. No new payment until it is settled.',
  charges_missing: 'The supplier charges for this service are not entered yet.',
  service_removed: 'This service was removed from the booking.',
  payment_in_progress: 'A payment request is open on this service. Wait until it is settled or returned.',
  evidence_missing: 'Upload the supplier’s new confirmation first.',
  not_self_approval: 'You cannot approve your own request. Another Manager must decide.',
  over_budget: 'The new cost is above the budget. The branch Manager must approve it.',
  trip_cancelled: 'This trip is being cancelled. It cannot be changed.',
  not_ready: 'This change cannot go ahead yet.',
  wrong_state: 'This change has moved on. Refresh the page to see where it is now.',
  version_changed: 'Someone changed this meanwhile. Refresh the page and try again.',
  version_superseded: 'The booking was changed in another way meanwhile. Refresh the page.',
  request_conflict: 'This request was already used for something else. Refresh the page and try again.',
  invalid_input: 'Check the highlighted field.',
  not_authorized: 'You cannot do this.',
  not_found: 'This change request could not be found.',
  deal_removed: 'This deal was removed from the CRM by the Bitrix sync. New work is paused.',
  session: 'Your session ended. Sign in again.',
});

/** The line each not_ready hint / blockedBy code adds. */
export type ChangeHintCode =
  | ChangeBlockCode
  | ServiceBlockCode
  | 'no_changes'
  | 'revision_open'
  | 'reconfirmation_open'
  | 'last_service'
  | 'no_service_added'
  | 'service_not_removed'
  | 'service_booked';

export const CHANGE_BLOCK_TEXT: Readonly<Record<ChangeHintCode, string>> = Object.freeze({
  changes_off: 'Changes after confirmation are not switched on yet.',
  change_not_supported: 'This older hotel-only booking cannot be changed here.',
  not_committed: 'No supplier has confirmed yet. Use the normal return-and-revise path.',
  trip_cancelled: 'The trip is being cancelled.',
  refund_open: 'A refund request is still open on this Deal.',
  change_open: 'A change is already in progress on this Deal.',
  no_changes: 'Nothing has been changed yet.',
  revision_open: 'Another draft of this booking is open.',
  reconfirmation_open: 'A supplier has not reconfirmed yet.',
  // Track H (11.1-11.3).
  service_changes_off: 'Adding or removing services is not switched on yet.',
  not_submitted: 'The booking has not been submitted yet.',
  last_service: 'This is the only service on the booking. Cancel the trip instead.',
  no_service_added: 'Add the new service to the booking first.',
  service_not_removed: 'Take the service out of the booking first.',
  service_booked: 'This service was booked or paid meanwhile. Withdraw this request and ask again so the supplier charges are entered.',
});

export const CHANGE_UNKNOWN_OUTCOME_TEXT = 'We could not confirm whether this was saved. Refresh the page before trying again.';

export const CHANGE_DONE_TEXT = Object.freeze({
  requested: 'Change started. Open the booking, make the change (with the new total and payment plan), then send it to the branch Manager.',
  resubmitted: 'Request details saved.',
  withdrawn: 'Change withdrawn. The earlier booking stands.',
  approved: 'Change approved. Purchase reconfirms with the supplier where needed.',
  returned: 'Change returned with your reason.',
  opened: 'The booking is open for this change.',
  submitted: 'Change sent to the branch Manager to approve this version.',
  applied: 'Change applied. The new booking is in force.',
  recorded: 'Supplier’s answer saved.',
  overBudgetApproved: 'Cost above budget approved.',
  refused: 'Saved: the supplier could not make the change. The earlier booking stands.',
  switched: 'Saved.',
  // Track H.
  requestedAdd: 'Request to add a service started. Open the booking, add the service with the new total and plan, then send it.',
  requestedRemove: 'Request to remove a service started. Open the booking, set the new total and plan, then send it.',
  requestedRemoveBooked: 'Request to remove a booked service started. The department enters the supplier charges; the branch Manager approves once they are in.',
  serviceAdded: 'Service added. A new task was created for the department.',
  serviceRemoved: 'Service removed from the booking.',
  existing: 'Already done. Nothing changed.',
});

// ---------------------------------------------------------------------------
// Form field names (Addendum L3: rupee inputs <key>Rupees, hidden values in paise)
// ---------------------------------------------------------------------------

export const CHANGE_FIELD = Object.freeze({
  dealId: 'dealId',
  changeRequestId: 'changeRequestId',
  reconfirmationId: 'reconfirmationId',
  kind: 'kind',
  /** Repeated field: one uuid per service. */
  itemIds: 'itemIds',
  changeSummary: 'changeSummary',
  reason: 'reason',
  decision: 'decision',
  expectedRowVersion: 'expectedRowVersion',
  /** Hidden: the change version's content hash the screen showed. */
  expectedContentHash: 'expectedContentHash',
  /** Repeated hidden field: the changed services the screen showed. */
  changedItemIds: 'changedItemIds',
  newRateRupees: 'newRateRupees',
  supplierFeeRupees: 'supplierFeeRupees',
  newReference: 'newReference',
  evidenceId: 'evidenceId',
  note: 'note',
  requestId: 'requestId',
  enabled: 'enabled',
  /** Track H: the customer's charge for dropping a booked service (rupees; sent as paise). */
  customerChargeRupees: 'customerChargeRupees',
} as const);

/** Pages revalidated after a change command. */
export const CHANGE_PATHS = ['/app/approvals', '/app/purchase', '/app/accounts'] as const;

// ---------------------------------------------------------------------------
// Command results and the action result
// ---------------------------------------------------------------------------

export interface ChangeRequestResult {
  outcome: 'created' | 'updated' | 'existing';
  changeRequestId: string;
  dealId: string;
  refNo: string;
  kind: ChangeKind;
  status: ChangeStatus;
  changeVersionId: string | null;
  rowVersion: number;
  /** G6 only. */
  reconfirmations?: number;
  applied?: boolean;
}

export interface ChangeVersionResult {
  outcome: 'created' | 'existing';
  changeRequestId: string;
  versionId: string;
  versionNo: number;
  rowVersion: number;
  contentHash: string;
}

export interface ReconfirmationResult {
  outcome: 'created' | 'updated' | 'existing';
  reconfirmationId: string;
  taskId: string;
  changeRequestId: string;
  status: ReconfirmStatus;
  overBudget: boolean;
  rowVersion: number;
  changeRequestStatus: ChangeStatus;
}

/** Track H: what the Sales owner sees per department of a booked removal (no amounts). */
export interface RemovalChargeState {
  department: ChargeDepartment;
  enteredByName: string | null;
  complete: boolean;
}

export interface ChangeSwitchResult {
  changed: boolean;
  changesEnabled: boolean;
  serviceChangesEnabled: boolean;
  updatedAt: string | null;
}

export type ChangeActionResult<T> =
  | { ok: true; data: T; message: string }
  | { ok: false; code: ChangeErrorCode | 'session'; message: string; field?: string; values?: Record<string, string> };
