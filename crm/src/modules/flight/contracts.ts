/**
 * Flight workspace contract (Track A of the Flight build, frozen 4 Nov 2026).
 * Contract sections 6.1, 6.3, 7, 9.1, 9.2 and 9.4; migrations
 * crm/supabase/migrations/20261201000100..0130.
 *
 * Owner decisions (binding): one Flight workspace per Deal covering all its
 * flight tasks, taken and reassigned together (D1); changes are decided by
 * the Sales owner on package Deals and by the Flight owner on flight-only
 * Deals (D5); a new booking version is reviewed and applied explicitly (D6);
 * passengers are the real Deal travellers (D7); tickets per passenger and
 * sector are append-only (D8); e-tickets are private files (D9); "Mark
 * flight done" is server-checked (D10). No read in this module carries
 * flight money (money-contracts.ts, Track B).
 *
 * Pure module: types, frozen refusal messages, status words, checklist and
 * CRS labels. The DTO types come from the zod schemas in dto.ts.
 */

export type {
  BookedLegDTO,
  BookingChangeApplyResult,
  BookingDiffDTO,
  ChangeAckResult,
  ChangeDecisionResult,
  ChangeSubmitResult,
  DealFlightHistoryDTO,
  DealFlightHistoryEventDTO,
  DealFlightSummaryDTO,
  ETicketDTO,
  FillBlanksResult,
  FlightChangeDTO,
  FlightDoneIssue,
  FlightHistoryKind,
  FlightHomeCountsDTO,
  FlightQueueDTO,
  FlightQueueFlightDTO,
  FlightQueueGroupDTO,
  FlightSectorDTO,
  FlightStatusDTO,
  FlightTravellerDTO,
  FlightWorkspaceDTO,
  GroupClaimResult,
  GroupCompleteResult,
  GroupReassignResult,
  PnrGroupDTO,
  SalesFareDTO,
  ScreenshotSaveResult,
  SectorSummaryDTO,
  SectorTicketDTO,
  TicketCorrectResult,
  TravellerNameFillResult,
  WorkspaceFlightDTO,
} from './dto';

export type FlightStatusCode = 'waiting' | 'in_progress' | 'all_confirmed' | 'done';
export type FlightCrs = 'amadeus' | 'galileo' | 'sabre' | 'airline_direct' | 'other';
export type FlightChangeKind = 'alternative' | 'added_instead' | 'added_extra' | 'passenger_itinerary';
export type FlightCabin = 'Economy' | 'Premium Economy' | 'Business' | 'First';

/** Cabin values Flight may enter (booking rows keep the booking's text). */
export const FLIGHT_CABINS: readonly FlightCabin[] = ['Economy', 'Premium Economy', 'Business', 'First'];

// ---------------------------------------------------------------------------
// Refusal tokens (section 6.3): the database message is exactly the token,
// arriving with exactly this SQLSTATE.
// ---------------------------------------------------------------------------

export type FlightErrorCode =
  | 'not_authorized'
  | 'not_found'
  | 'version_changed'
  | 'duplicate_request'
  | 'task_conflict'
  | 'invalid_input'
  | 'not_ready'
  | 'deal_removed'
  | 'environment_unset'
  | 'booking_changed'
  | 'traveller_not_on_sector'
  | 'held_by_change'
  | 'already_confirmed'
  | 'no_difference'
  | 'duplicate_flight'
  | 'not_self_approval'
  | 'already_decided'
  | 'ticket_number_taken'
  // R3 (Addendum 2): deal_traveller_name_fill.
  | 'name_already_set'
  // Department evidence (e-tickets): existing tokens of department_evidence_begin.
  | 'evidence_rejected'
  | 'task_closed';

export const FLIGHT_ERROR_STATES: Record<FlightErrorCode, string> = {
  not_authorized: '42501',
  not_found: 'P0002',
  version_changed: '40001',
  duplicate_request: '40001',
  task_conflict: '40001',
  invalid_input: '22023',
  not_ready: '55000',
  deal_removed: '55000',
  environment_unset: '55000',
  booking_changed: '55000',
  traveller_not_on_sector: '22023',
  held_by_change: '55000',
  already_confirmed: '55000',
  no_difference: '22023',
  duplicate_flight: '22023',
  not_self_approval: '42501',
  already_decided: '55000',
  ticket_number_taken: '23505',
  name_already_set: '55000',
  evidence_rejected: '22023',
  task_closed: '55000',
};

/** Frozen staff messages (section 6.3; deal_removed / environment_unset keep the existing wording). */
export const FLIGHT_ERROR_TEXT: Record<FlightErrorCode | 'upload_failed' | 'session', string> = {
  not_authorized: 'You cannot do this on this flight.',
  not_found: 'This item is no longer available. Reload the page.',
  version_changed: 'Someone changed this flight meanwhile. Reload and try again.',
  duplicate_request: 'This was already sent with different details. Reload the page.',
  task_conflict: 'Another Flight colleague took these flights first.',
  invalid_input: 'Check the highlighted field.',
  not_ready: 'Finish the steps listed before doing this.',
  deal_removed:
    'This deal was removed from the CRM by the Bitrix sync because it no longer matches the import settings (start date, pipeline or stage). New work is paused; recorded money and history stay.',
  environment_unset: 'This CRM environment is not set up yet. Ask an admin.',
  booking_changed: 'Sales sent a new booking. Review "Booking changed" first.',
  traveller_not_on_sector: 'A chosen traveller is not on that flight.',
  held_by_change: 'This traveller is waiting for a change decision.',
  already_confirmed: 'This traveller already has a ticket on that flight.',
  no_difference: 'Change at least one detail. It is the same as the current flight.',
  duplicate_flight: 'These travellers are already on this exact flight.',
  not_self_approval: 'You cannot approve your own request.',
  already_decided: 'This was already decided. Reload the page.',
  ticket_number_taken: 'This ticket number already belongs to another traveller.',
  name_already_set: 'This traveller already has a name. Reload the page to see it.',
  evidence_rejected: 'This file can’t be used. Upload a PDF, JPG, PNG or WebP up to 4 MB.',
  task_closed: 'This flight is already done, so new files can’t be added.',
  upload_failed: 'The file could not be uploaded. Nothing was saved. Please try again.',
  session: 'You were signed out. Sign in again; what you typed is still on this page.',
};

/** The command may have committed before the failure: never claim "nothing changed". */
export const FLIGHT_UNKNOWN_OUTCOME_TEXT =
  'We could not confirm this was saved. Reload the page to check before you try again. Your typed details are still here.';

// ---------------------------------------------------------------------------
// Status words (section 7, frozen) and chips
// ---------------------------------------------------------------------------

export const FLIGHT_STATUS_WORD = {
  waiting: 'Waiting',
  in_progress: 'In progress · {x} of {y} tickets',
  /** In progress with nothing ticketable yet (a screenshot flight without typed sectors). */
  in_progress_untyped: 'In progress · flight details not typed yet',
  all_confirmed: 'All tickets confirmed',
  done: 'Done · ticket issued',
} as const satisfies Record<FlightStatusCode | 'in_progress_untyped', string>;

export const FLIGHT_CHIP_TEXT = {
  bookingChanged: 'Booking changed',
  unnamed: '{n} travellers not named yet',
  changeWaitingSales: 'Change waiting for Sales',
  changeWaitingManager: 'Change waiting for the Manager',
  faresWaiting: 'Fares waiting for the Manager',
  paymentNeeded: 'Payment needed',
} as const;

export const FLIGHT_PROGRESS_LABEL = {
  take: 'Take',
  approvals: 'Approvals',
  tickets: 'Confirm tickets',
  payment: 'Pay supplier',
  etickets: 'Attach e-tickets',
  done: 'Flight done',
} as const;

// ---------------------------------------------------------------------------
// Mark flight done checklist (section 7)
// ---------------------------------------------------------------------------

export const FLIGHT_DONE_CHECKLIST = {
  booking_changed: { label: 'Booking changes reviewed', why: 'Sales sent a new booking for {flight}. Review it.' },
  travellers_unnamed: { label: 'Every traveller is named', why: '{n} travellers not named yet. Sales has been told.' },
  traveller_without_flight: { label: 'Every traveller has a flight', why: 'Not on a flight yet: {names} ({flight}).' },
  change_pending: { label: 'No change waiting for approval', why: '{decider} still has to decide change {no}.' },
  tickets_pending: { label: 'Every traveller confirmed on every active flight', why: 'Still pending: {name} on {flight}, …' },
  traveller_changed: { label: 'Ticket names match the booking', why: '{name} changed in the booking after ticketing. Correct the ticket.' },
  fare_approval_pending: { label: 'No fares waiting for the Manager', why: 'The Manager still has to approve the fares.' },
  payment_missing: { label: 'Every ticket batch is paid or has an approved payment request', why: 'Record the payment for batch {no}.' },
  payment_returned: { label: 'No payment returned by Accounts', why: 'Accounts returned the payment for batch {no}.' },
  eticket_missing: { label: 'E-tickets attached', why: 'Attach the issued e-tickets.' },
} as const;

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const FLIGHT_CRS_LABEL: Record<FlightCrs, string> = {
  amadeus: 'Amadeus',
  galileo: 'Galileo',
  sabre: 'Sabre',
  airline_direct: 'Airline direct',
  other: 'Other',
};

export const FLIGHT_CHANGE_KIND_LABEL: Record<FlightChangeKind, string> = {
  alternative: 'Alternative flight',
  added_instead: 'Instead of',
  added_extra: 'Extra journey',
  passenger_itinerary: 'Passenger itinerary',
};

/** Form field names of the Flight actions (the screens post these). */
export const FLIGHT_FIELD = {
  dealId: 'dealId',
  taskId: 'taskId',
  sectorId: 'sectorId',
  changeId: 'changeId',
  evidenceId: 'evidenceId',
  requestId: 'requestId',
  expectedRowVersion: 'expectedRowVersion',
  expectedBasisVersionId: 'expectedBasisVersionId',
  targetVersionId: 'targetVersionId',
  expectedAssignee: 'expectedAssignee',
  expectedTaskIds: 'expectedTaskIds',
  expectedRevisionNo: 'expectedRevisionNo',
  travellerSeq: 'travellerSeq',
  toUserId: 'toUserId',
  decision: 'decision',
  reason: 'reason',
  payload: 'payload',
  kind: 'kind',
  file: 'file',
  versionId: 'versionId',
  seq: 'seq',
  fullName: 'fullName',
  travellerType: 'travellerType',
} as const;

/** Result of every Flight action (fits useActionState and the screens' DecisionAction). */
export type FlightActionResult<T> =
  | { ok: true; data: T; message: string }
  | {
      ok: false;
      code: FlightErrorCode | 'upload_failed' | 'session';
      message: string;
      /** Refused input keys from the database hint (invalid_input) or the done issues (not_ready). */
      fields?: string[];
    };

/** Success messages of the Flight actions. */
export const FLIGHT_DONE_TEXT = {
  claimed: 'You have taken these flights. They are now in progress.',
  claimedExisting: 'These flights are already yours.',
  reassigned: 'The flights moved to the new Flight person.',
  bookingApplied: 'The new booking is applied. Check the flagged tickets.',
  sectorsSaved: 'Flights saved from the screenshot.',
  blanksFilled: 'Missing details saved.',
  changeSent: 'Change sent to Sales for approval.',
  changeApplied: 'Change saved and applied.',
  changeApproved: 'Change approved. The travellers move to the new flight.',
  changeRejected: 'Change rejected. The travellers stay on their previous flight.',
  changeWithdrawn: 'Change withdrawn. The travellers stay on their previous flight.',
  changeSeen: 'Noted.',
  ticketCorrected: 'Ticket corrected. The old details stay in its history.',
  eTicketStored: 'E-ticket uploaded.',
  completed: 'Flight marked done. Sales and Accounts see that the tickets are issued.',
  travellerNamed: 'Name saved. The Flight team can now book this traveller.',
} as const;

export const FLIGHT_E_TICKET_BUCKET = 'department-evidence';
export const FLIGHT_E_TICKET_SIGNED_URL_SECONDS = 60;
export const FLIGHT_E_TICKET_MAX_BYTES = 4 * 1024 * 1024;
