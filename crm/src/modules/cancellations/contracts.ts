/**
 * Trip cancellation handling for Flight and Visa (Accounts phase 2, Track C):
 * frozen DTO shapes and texts for the Flight charge per ticket batch (C9), the
 * Visa per-application choice (C10) and expected fee refund (C11), and the
 * Manager's cancellation read additions (7.4).
 *
 * Contract: implementation/accounts-phase2-2026-11-11/contract.md sections
 * 7.3, 7.4, LD11-LD14 and Addendum L3. Database:
 * crm/supabase/migrations/20261204000330. Money is whole paise as decimal
 * strings.
 *
 * Accounts phase 3, track H (contract 11.3, LD30): a booked service being
 * removed from a booking records its supplier charges with the same forms and
 * tables, keyed by the remove_service request instead of a trip cancellation
 * (no trip cancellation is ever opened for it). Every shape below gains
 * changeRequestId (null for a trip cancellation) and its cancellationId is
 * null for a removal (migrations 20261205000700..0740).
 */
import { CONFLICT_STATES } from '@/lib/sqlstate';

export type Paise = string;

/** One ticket batch in the Manager's cancellation review (latest Flight revision; null amounts = not entered). */
export interface FlightCancellationChargeView {
  batchId: string;
  batchNo: number;
  supplierName: string;
  supplierCostPaise: Paise;
  airlineChargePaise: Paise | null;
  refundExpectedPaise: Paise | null;
  refundReportedPaise: Paise | null;
  revisionNo: number;
  enteredByName: string | null;
  /** The Flight note of the latest revision (20261204000370). */
  note?: string | null;
}

/** Additive keys of deal_cancellation_summary().cancellation and manager_cancellation_list() rows, Manager only. */
export interface CancellationManagerAdditions {
  flightCharges: FlightCancellationChargeView[];
  /** LD11: Purchase supplier keeps + airline charges (latest revisions). */
  chargesKeptPaise: Paise;
}

/** Additive per-batch keys of flight_money() (7.4). */
export interface FlightBatchCancellationView {
  /** Track H: the remove_service request this charge belongs to (null for a trip cancellation). */
  changeRequestId?: string | null;
  state: 'open' | 'approved';
  revisionNo: number;
  airlineChargePaise: Paise | null;
  refundExpectedPaise: Paise | null;
  refundReportedPaise: Paise | null;
  /** Verified supplier refunds received for this batch. */
  supplierRefundReceivedPaise: Paise;
  canEnter: boolean;
  /** The Flight note of the latest revision (20261204000370). */
  note?: string | null;
}

/** Additive keys of visa_workspace() (LD12). */
export interface VisaCancellationView {
  /** Null when the panel belongs to a service removal (track H). */
  cancellationId: string | null;
  /** Track H: the remove_service request (null for a trip cancellation). */
  changeRequestId?: string | null;
  status: 'open' | 'charges_entered' | 'sent_to_manager' | 'approved';
  approved: boolean;
  fees: Array<{ entryId: string; applicationId: string | null; costKind: string; amountPaise: Paise; refundExpectedPaise: Paise | null;
    revisionNo: number; canSet: boolean }>;
}
export interface VisaApplicantCancellationKeys {
  cancellationChoice: 'withdraw' | 'finish' | null;
  canChooseCancellation: boolean;
  cancellationChoiceReason?: string | null;
}

export interface FlightChargeResult {
  outcome: 'created' | 'existing';
  /** Null when the charge belongs to a service removal (track H). */
  cancellationId: string | null;
  /** Track H: the remove_service request (null for a trip cancellation). */
  changeRequestId?: string | null;
  batchId: string;
  revisionNo: number;
  status: string;
}

export interface VisaChoiceResult {
  outcome: 'updated' | 'existing';
  applicationId: string;
  rowVersion: number;
  state: string;
  closed: boolean;
  taskCompleted: boolean;
  cancellationChoice: 'withdraw' | 'finish';
}

export interface VisaFeeRefundResult {
  outcome: 'created' | 'existing';
  entryId: string;
  revisionNo: number;
  /** Track H: the remove_service request (null for a trip cancellation). */
  changeRequestId?: string | null;
}

export type CancellationErrorCode =
  | 'trip_cancelled'
  | 'not_ready'
  | 'already_decided'
  | 'already_recorded'
  | 'version_changed'
  | 'invalid_input'
  | 'not_authorized'
  | 'not_found'
  | 'duplicate_request'
  | 'application_closed'
  | 'task_closed'
  | 'environment_unset';

export const CANCELLATION_ERROR_STATES: Record<CancellationErrorCode, string | readonly string[]> = {
  trip_cancelled: '55000',
  not_ready: '55000',
  already_decided: '55000',
  already_recorded: '55000',
  version_changed: CONFLICT_STATES,
  invalid_input: '22023',
  not_authorized: '42501',
  not_found: 'P0002',
  duplicate_request: '23505',
  application_closed: '55000',
  task_closed: '55000',
  environment_unset: '55000',
};

export const CANCELLATION_ERROR_TEXT: Record<CancellationErrorCode | 'session', string> = {
  trip_cancelled: 'The trip is cancelled. New fees, applications and payments are stopped.',
  not_ready: 'This step is not available yet. The trip cancellation must be open (or approved, for visa choices).',
  already_decided: 'The cancellation is approved. Only the refund the airline reported can still change.',
  already_recorded: 'This is already recorded.',
  version_changed: 'Someone changed this meanwhile. Reload and try again.',
  invalid_input: 'Check the highlighted field.',
  not_authorized: 'You cannot do this here.',
  not_found: 'This item is no longer available. Reload the page.',
  duplicate_request: 'This was already sent with different details. Reload the page and try again.',
  application_closed: 'This application is already closed.',
  task_closed: 'This task is already completed.',
  environment_unset: 'This CRM environment is not set up yet. Ask an admin.',
  session: 'You were signed out. Sign in again; what you typed is still on this page.',
};

export const CANCELLATION_UNKNOWN_OUTCOME_TEXT =
  'We could not confirm this was saved. Reload the page to check before you try again. Your typed details are still here.';

export const CANCELLATION_DONE_TEXT = {
  flightCharge: 'Airline charges saved.',
  visaWithdraw: 'Application withdrawn for the cancelled trip.',
  visaFinish: 'Application left to finish.',
  visaFee: 'Expected fee refund saved.',
  existing: 'This was already done. Nothing changed.',
} as const;

export type CancellationActionResult<T> =
  | { ok: true; message: string; data?: T }
  | { ok: false; code: CancellationErrorCode | 'session'; message: string; field?: string; values?: Record<string, string> };

/** FormData field names (Addendum L3). */
export const CANCELLATION_FIELD = {
  batchId: 'batchId',
  dealId: 'dealId',
  taskId: 'taskId',
  applicationId: 'applicationId',
  entryId: 'entryId',
  expectedRevision: 'expectedRevision',
  expectedRowVersion: 'expectedRowVersion',
  airlineChargeRupees: 'airlineChargeRupees',
  refundExpectedRupees: 'refundExpectedRupees',
  refundReportedRupees: 'refundReportedRupees',
  note: 'note',
  choice: 'choice',
  reason: 'reason',
  requestId: 'requestId',
} as const;
