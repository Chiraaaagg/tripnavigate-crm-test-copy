import type { BitrixRefreshRefusal, CarKind, FlightEntryMode, FlightFareTotals, RequestItem, ServiceEstimateView, ServiceItemFileView } from './booking-form-contract';
import type { SwitchState } from '@/modules/settings/contracts';

/**
 * Phase 3 frozen booking → Purchase task contracts (lead-owned).
 * See docs/implementation/phase-3/contract.md. Agents import; they do not redefine.
 */

export type BookingStatus = 'draft' | 'confirmed';
/** B1: one task purpose per service type (legacy tasks stay 'hotel'). */
export type ServicePurpose = ServiceType;
/** Phase 4 adds 'supplier_confirmed'. A claimed ('in_progress') task is not a booked hotel. */
export type PurchaseTaskStatus = 'not_started' | 'in_progress' | 'supplier_confirmed';
export type EvidenceKind = 'acceptance_message' | 'ticket' | 'bill' | 'payment_proof' | 'other';
export type EvidenceStatus = 'pending_upload' | 'stored' | 'failed' | 'removed';
export const EVIDENCE_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
export type EvidenceMime = (typeof EVIDENCE_MIME_TYPES)[number];
/** 4 MiB: hosted serverless functions cap request bodies (about 4.5 MB on Vercel; verify). */
export const EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;
export const EVIDENCE_MAX_FILES = 10;
export const EVIDENCE_BUCKET = 'booking-evidence';
export const EVIDENCE_SIGNED_URL_SECONDS = 60;

/** Draft facts as sent to booking_save_draft (camelCase keys; all optional while draft). */
export interface BookingFacts {
  hotelName: string | null;
  city: string | null;
  /** ISO date YYYY-MM-DD. */
  checkIn: string | null;
  checkOut: string | null;
  rooms: number | null;
  roomType: string | null;
  mealPlan: string | null;
  adults: number | null;
  children: number | null;
  inclusions: string | null;
  specialRequests: string | null;
  /** Integer paise as a decimal string (bigint-safe). Purchase may see this. */
  purchaseBudgetPaise: string | null;
}

export const BOOKING_FACT_LIMITS = {
  hotelName: 200,
  city: 120,
  roomType: 120,
  mealPlan: 60,
  inclusions: 2000,
  specialRequests: 2000,
  rooms: { min: 1, max: 50 },
  adults: { min: 1, max: 100 },
  children: { min: 0, max: 100 },
} as const;

export type BookingIssueCode =
  // B1 (package versions only; see contract §7.2)
  | 'no_services'
  | 'traveller_missing'
  | 'traveller_count_mismatch'
  | 'stage_not_confirmed'
  | 'service_facts_invalid'
  | 'missing_hotel_name'
  | 'missing_city'
  | 'missing_dates'
  | 'check_out_not_after_check_in'
  | 'missing_rooms'
  | 'missing_travellers'
  | 'missing_purchase_budget'
  | 'missing_selling_total'
  | 'missing_selling_total_ask_owner'
  | 'missing_acceptance_proof'
  | 'evidence_upload_incomplete'
  | 'source_not_recently_verified'
  | 'booking_disabled'
  | 'environment_unset'
  // B1.1 package versions (appendix A §1.4; viewer mapping plan_ask_owner)
  | 'contact_missing'
  | 'contact_not_confirmed'
  | 'billing_missing'
  | 'gstin_missing'
  | 'trip_missing'
  | 'child_age_missing'
  | 'participation_missing'
  | 'identity_missing'
  | 'plan_missing'
  | 'plan_total_mismatch'
  | 'plan_ask_owner'
  // B1.2 (0100, DEC-38): an adult traveller has no stored identity proof
  | 'id_proof_missing'
  // B1.2 (0200): a draft converted from a quotation changed materially without fresh acceptance
  | 'quote_acceptance_stale'
  // Booking form (20261124000120, form_rules 2 drafts; booking-form-contract.ts BOOKING_FORM_ISSUE_CODES)
  | 'pax_missing'
  | 'pax_types_exceeded'
  | 'price_missing'
  | 'price_count_mismatch'
  | 'price_below_purchase'
  | 'hotel_nights_missing'
  | 'hotel_outside_trip'
  | 'hotel_same_day_trip'
  | 'service_dates_outside_trip'
  | 'gst_status_missing'
  | 'gst_reason_missing'
  | 'billing_contact_missing'
  | 'billing_reach_missing'
  // Book now v2 (20261129000120): a flight added from a screenshot has no stored screenshot
  | 'flight_screenshot_missing'
  // Booking form: the three price codes as one line for viewers without price access
  | 'prices_ask_owner'
  // B1.1 revision drafts (appendix A §2.2, Stage 3 §11)
  | 'revision_class_missing'
  | 'customer_acceptance_required'
  | 'no_changes'
  | 'base_no_longer_returned';

export interface BookingReadiness {
  ready: boolean;
  issues: BookingIssueCode[];
  contentHash: string;
}

export type BookingErrorCode =
  // B1 (contract §11)
  | 'service_on_hold'
  | 'item_locked'
  | 'traveller_identity_locked'
  | 'too_many_items'
  | 'service_items_disabled'
  | 'not_authorized'
  | 'not_found'
  | 'version_changed'
  | 'task_conflict'
  | 'booking_disabled'
  | 'not_ready'
  | 'environment_unset'
  | 'already_confirmed'
  | 'invalid_input'
  | 'evidence_rejected'
  | 'deal_removed'
  | 'deal_not_active'
  // B1.1 (appendix A §4, freeze note §4)
  | 'billing_verified'
  | 'version_superseded'
  | 'revision_not_allowed'
  | 'already_committed'
  | 'classification_not_allowed'
  | 'revision_items_fixed'
  | 'documents_not_checked'
  | 'outcome_document_required'
  | 'outcome_required'
  | 'application_closed'
  | 'task_closed'
  | 'cost_locked'
  | 'receipt_required'
  | 'direct_payment_over_limit'
  | 'request_conflict'
  | 'wrong_state'
  // B1.2 traveller identity proof (0100)
  | 'id_proof_limit'
  | 'consent_required'
  // B1.2 Bitrix prefill (0600)
  | 'prefill_unavailable'
  // Batch 2 (migration A): the workflow settings row is held by another change (55P03, Atlas shapes §0)
  | 'settings_busy'
  | 'switch_off'
  // Booking form (20261124000110): booking_commercials_save while per-person price lines exist
  | 'priced_per_person'
  // Booking form (20261124000110): five live files per item already
  | 'item_file_limit'
  // Book now v2: "Refresh from Bitrix now" refusals (booking-form-contract.ts)
  | BitrixRefreshRefusal;

export interface OpenDraftResult {
  versionId: string;
  versionNo: number;
  rowVersion: number;
  created: boolean;
}

export interface SaveDraftResult {
  versionId: string;
  rowVersion: number;
  contentHash: string;
}

export interface BeginEvidenceResult {
  evidenceId: string;
  objectPath: string;
}

export interface ConfirmBookingResult {
  /** B1.1: 'revised' when a revision draft replaced its returned base (no new task). */
  outcome: 'created' | 'existing' | 'revised';
  /**
   * The hotel task for a legacy hotel version; the first task for a package
   * version. B1.1: null when no task was created (a standalone visa or
   * passport while the Visa & Passport desk is not launched).
   */
  taskId: string | null;
  versionId: string;
  /** B1: every task of the version (one per service item); absent from databases before B1. */
  taskIds?: string[];
  /** B1.1 revision: the base version this revision replaced. */
  supersededVersionId?: string;
}

export interface ClaimTaskResult {
  taskId: string;
  status: PurchaseTaskStatus;
  assignedToYou: true;
  alreadyYours: boolean;
}

/** Action results returned to forms (never raw database messages). */
export type BookingActionResult<T = undefined> =
  | { ok: true; data: T; message: string }
  | {
      ok: false;
      code: BookingErrorCode | 'upload_failed' | 'session';
      message: string;
      issues?: BookingIssueCode[];
      /** B1: form field names that failed validation (typed values are kept; the form highlights these). */
      fields?: string[];
      /**
       * B1.1 (freeze note §3.4): on version_changed, who saved the draft after
       * the form was opened and when, when the database told us. Absent when unknown.
       */
      conflict?: SaveConflict;
      /**
       * Booking form: a run of two commands saved the first and refused the
       * second. The first save moved the version to this row version (the
       * form advances its own-save chain; the typed values stay).
       */
      savedRowVersion?: number;
    };

/** B1.1: the newer save that made a form out of date. */
export interface SaveConflict {
  savedByName: string | null;
  savedAt: string;
}

// ---------------------------------------------------------------------------
// View DTOs (the only shapes that reach the browser)
// ---------------------------------------------------------------------------

export interface EvidenceItemView {
  id: string;
  kind: EvidenceKind;
  fileName: string;
  sizeLabel: string;
  status: EvidenceStatus;
  uploadedByYou: boolean;
  uploadedAt: string;
}

/** UI-level state of the hotel booking panel on a deal. */
export type BookingPanelState =
  | 'none' // no draft yet
  | 'draft_needs_repair'
  | 'draft_ready'
  | 'confirmed';

export interface BookingPanelView {
  dealId: string;
  state: BookingPanelState;
  versionId: string | null;
  versionNo: number | null;
  rowVersion: number | null;
  contentHash: string | null;
  facts: BookingFacts | null;
  /** Present only when the viewer may read commercial values (never for Purchase). */
  sellingTotalPaise?: string | null;
  evidence: EvidenceItemView[];
  /** False when the viewer may see the booking but not its proof files (list withheld, not empty). */
  evidenceVisible: boolean;
  issues: BookingIssueCode[];
  canEdit: boolean;
  canConfirm: boolean;
  /** Why the viewer cannot confirm, in plain words, when canEdit but !canConfirm. */
  confirmBlockedReason: string | null;
  /**
   * Why a booking cannot be started, in plain words: set only when there is no
   * version yet and the Deal is lost or rejected in Bitrix (Stage 7), for
   * editors and readers alike. Then the start control is not offered.
   */
  openBlockedReason: string | null;
  gate: { realBookingEnabled: boolean; environment: 'unset' | 'test' | 'staging' | 'operational' };
  confirmed: null | {
    at: string;
    byName: string;
    taskId: string;
    taskStatus: PurchaseTaskStatus;
    taskAssigneeName: string | null;
  };
}

/** Purchase DTOs deliberately have NO selling price, margin or evidence fields. */
export interface PurchaseTaskSummary {
  taskId: string;
  dealReference: string;
  /** B1: the sold service this task is for ('hotel' for every task created before B1). */
  serviceType: ServiceType;
  /** B1: short title of the service (hotel name and city, route, activity name, flight route). */
  itemTitle: string;
  /** B1: the item's facts, typed by serviceType. For legacy hotel tasks, built from the version columns. */
  facts: ServiceFacts;
  /** Hotel fields: filled for hotel tasks; null/0 for other service types (facts carries their details). */
  hotelName: string | null;
  city: string | null;
  checkIn: string | null;
  checkOut: string | null;
  nights: number;
  rooms: number;
  travellers: { adults: number; children: number };
  purchaseBudgetPaise: string;
  status: PurchaseTaskStatus;
  assigneeName: string | null;
  assignedToYou: boolean;
  branchName: string;
  createdAt: string;
  /** Phase 4: set once the supplier confirmed the hotel (P4-D6: Sales sees this, nothing else). */
  supplierConfirmedAt?: string | null;
}

export interface PurchaseTaskView extends PurchaseTaskSummary {
  roomType: string | null;
  mealPlan: string | null;
  inclusions: string | null;
  specialRequests: string | null;
  confirmedAt: string;
  confirmedByName: string;
  versionNo: number;
  canClaim: boolean;
  /** B1.1: travellers taking part in this service (no identity data for Purchase). Absent on older databases. */
  participants?: TaskParticipantView[];
  /** B1.1 revision (0300): changed non-commercial field keys of the current accepted version. */
  changedFields?: string[];
  /** Booking form: the supplier estimate of this item (cost only, never a sale). Assignee only; absent otherwise. */
  estimate?: ServiceEstimateView;
}

export interface PurchaseQueueView {
  tasks: PurchaseTaskSummary[];
}

export interface BookingHealthView {
  realBookingEnabled: boolean;
  environment: 'unset' | 'test' | 'staging' | 'operational';
  drafts: number;
  draftsNeedingRepair: number;
  confirmed: number;
  tasksNotStarted: number;
  tasksInProgress: number;
  pendingOutboxEvents: number;
}

// ---------------------------------------------------------------------------
// Frozen interface wording (agent C may propose changes to the lead)
// ---------------------------------------------------------------------------

export const BOOKING_STATUS_LABEL: Record<BookingPanelState, string> = {
  none: 'No booking details yet',
  draft_needs_repair: 'Draft · needs details',
  draft_ready: 'Draft · ready to confirm',
  confirmed: 'Confirmed · Purchase task created',
};

export const PURCHASE_TASK_STATUS_LABEL: Record<PurchaseTaskStatus, string> = {
  // DA-271 (amends DA-44)
  not_started: 'Waiting to be taken',
  in_progress: 'In progress · not booked yet', // DA-278: every Purchase task type (hotel, transfer, activity)
  supplier_confirmed: 'Confirmed by supplier',
};

export const ISSUE_TEXT: Record<BookingIssueCode, string> = {
  missing_hotel_name: 'Add the hotel name.',
  missing_city: 'Add the city.',
  missing_dates: 'Add check-in and check-out dates.',
  check_out_not_after_check_in: 'Check-out must be after check-in.',
  missing_rooms: 'Add the number of rooms.',
  missing_travellers: 'Add how many adults are travelling.',
  missing_purchase_budget: 'Add the approved Purchase budget.',
  missing_selling_total: 'Add the booking total agreed with the customer.',
  missing_selling_total_ask_owner: 'The deal owner still needs to add the booking total agreed with the customer.',
  no_services: 'Add at least one service that was sold.',
  traveller_missing: 'Add the travellers’ names. The services need more travellers than you’ve listed.',
  traveller_count_mismatch: 'The services need more travellers than you’ve listed. Add the missing names.',
  stage_not_confirmed: 'Bitrix hasn’t marked this Deal "Won - Payment Received" yet. You can keep preparing; tasks start after that.',
  service_facts_invalid: 'A service is missing details or has invalid ones. Open each service and fix the highlighted fields.',
  missing_acceptance_proof: 'Upload at least one proof that the customer accepted (for example a message, ticket or bill).',
  evidence_upload_incomplete: 'A proof file did not finish uploading. Remove it or upload it again.',
  source_not_recently_verified:
    'This deal has not been checked against Bitrix in the last 24 hours. Ask an admin to check Bitrix for updates.',
  booking_disabled: 'Booking confirmation is turned off for real deals until the pilot is approved.',
  environment_unset: 'This CRM environment is not set up yet. Ask an admin.',
  // B1.1
  contact_missing: 'Add the booking contact’s name and a mobile number or email.',
  contact_not_confirmed: 'Check the mobile or email with the customer, then tick the box.',
  billing_missing: 'Add the Bill To details: name, address, city, state and PIN code.',
  gstin_missing: 'This business is GST registered. Add the GSTIN.',
  trip_missing: 'Add the destination, whether the trip is domestic or international, and the trip dates.',
  child_age_missing: 'Add the age of every child and infant.',
  participation_missing: 'Every service needs at least one traveller taking part.',
  identity_missing: 'Add the date of birth and nationality of each traveller on an international flight, visa or passport service.',
  plan_missing: 'Add the payment plan (at least one instalment).',
  plan_total_mismatch: 'The payment plan must add up exactly to the final selling total.',
  plan_ask_owner: 'The deal owner still needs to add a payment plan that adds up to the selling total.',
  revision_class_missing: 'Choose what kind of change this is.',
  customer_acceptance_required: 'Upload the customer’s acceptance of the changed booking.',
  no_changes: 'Nothing has changed from the returned version.',
  base_no_longer_returned: 'Accounts has already decided on the returned version.',
  // B1.2 (DEC-38)
  id_proof_missing: 'Attach an identity proof (Aadhaar card or another ID) for every adult traveller.',
  // B1.2 (0200)
  // BR-10
  quote_acceptance_stale: 'This booking differs from the quotation the customer accepted. Upload their new written OK.',
  // Booking form (Mercury money-privacy-copy.md A.8; the screens add names, dates and counts where they know them)
  pax_missing: 'Enter the total number of passengers (1 to 100).',
  pax_types_exceeded: 'More passengers are named than the adult, child and infant counts allow. Change the counts or remove a passenger.',
  price_missing: 'Enter purchase, markup and final sale for every passenger type in the price table.',
  price_count_mismatch: 'Price counts must add up to the total passengers. Split all children into with bed or without bed.',
  price_below_purchase: 'Final sale is below purchase for a passenger type. Change the final sale or the purchase. A sale below purchase cannot be submitted.',
  hotel_nights_missing: 'Some trip nights have no hotel. Add a hotel for every night.',
  hotel_outside_trip: 'Keep each hotel stay within the trip dates.',
  hotel_same_day_trip: 'A same-day trip cannot have an overnight hotel stay. Change the return date or remove the hotel.',
  service_dates_outside_trip: 'Keep car, flight and activity dates within the trip dates. Visa and passport dates may be outside them.',
  gst_status_missing: 'Choose whether the business is GST registered.',
  gst_reason_missing: 'Record why the business has no GSTIN (10 to 500 characters).',
  billing_contact_missing: 'Add the contact name at the business.',
  billing_reach_missing: 'Add a billing phone number or email.',
  // Book now v2 (the booking form names the flights: "Flight 2: attach ...")
  flight_screenshot_missing: 'Attach at least one screenshot to each flight added from a screenshot, or type the details.',
  prices_ask_owner: 'The deal owner still needs to finish the package prices.',
};

/** Echo M3: a booking form save that needs the database change, on a database that does not have it yet. Nothing was saved. */
export const BOOKING_FORM_NOT_INSTALLED_TEXT = 'This form needs the database update; try again in a few minutes. Nothing was saved.';

/** Booking form: the one line an editor without price access sees for every price readiness code (no amounts, no categories). */
export const PRICE_ASK_OWNER_TEXT = 'The deal owner still needs to finish the package prices.';
/** Readiness codes that are masked to PRICE_ASK_OWNER_TEXT for viewers without price access. */
export const PRICE_ISSUE_CODES = ['price_missing', 'price_count_mismatch', 'price_below_purchase', 'prices_ask_owner'] as const;

/** Next step on the booking panel while the Deal is lost or rejected in Bitrix (Stage 7). */
export const DEAL_NOT_ACTIVE_NEXT_TEXT = 'Bookings can’t be started on this deal while it is lost or rejected in Bitrix.';

/** Shown when a command's outcome is unknown (e.g. the response was lost). */
// G-05 (HandForm keeps typed values since PR 37)
export const UNKNOWN_OUTCOME_TEXT = 'We could not confirm this was saved. Reload the page to check before you try again. Your typed details are still here.';

/** Shown instead of the proof list to readers who may not see proof files. */
export const PROOF_HIDDEN_TEXT =
  'Proof files are only visible to the Sales owner, assigned Sales and the branch Sales Manager.';

export const CONFIRM_SUCCESS_TEXT =
  'Booking details confirmed and a Purchase task was created. The hotel is not booked yet.';

export const ERROR_TEXT: Record<BookingErrorCode | 'upload_failed' | 'session', string> = {
  service_on_hold: 'Train isn’t handled in the CRM yet. Add the other services only.',
  item_locked: 'This service is already part of an accepted version. Changes come through a new version.',
  traveller_identity_locked: 'Traveller names are frozen in the accepted version. A change needs the customer to accept again.',
  too_many_items: 'More than 20 services on one Deal isn’t supported.',
  service_items_disabled: 'Service items are switched off for this CRM. An admin can switch them on. Your draft is saved.',
  not_authorized: 'You can’t do this on this deal. The deal owner or a Sales Manager for this branch can.',
  not_found: 'We couldn’t find this booking. It may have been removed, or you may not have access.',
  version_changed: 'Someone changed these booking details after you opened them. Nothing was confirmed. Review the latest details and try again.',
  task_conflict: 'Another Purchase colleague has already taken this task.',
  booking_disabled: 'Booking confirmation is turned off for real deals until the pilot is approved. Your draft is saved.',
  not_ready: 'Some details are missing. Nothing was confirmed. Fix the items listed and try again.',
  environment_unset: 'This CRM environment is not set up yet. Your draft is saved. Ask an admin.',
  already_confirmed: 'This booking is already confirmed. Changes after confirmation aren’t supported yet — talk to your manager and Purchase.',
  invalid_input: 'Some details aren’t valid. Check the highlighted fields.',
  evidence_rejected: 'This file can’t be used. Upload a PDF, JPG, PNG or WebP up to 4 MB.',
  deal_removed: 'This deal was removed from the CRM by the Bitrix sync because it no longer matches the import settings (start date, pipeline or stage). New work is paused; recorded money and history stay.',
  deal_not_active: 'This deal is marked lost or rejected in Bitrix. Bookings can only be started on active deals.',
  upload_failed: 'The proof was not accepted and does not count. Remove it if it is listed, then upload it again.',
  // G-06
  session: 'You were signed out. Sign in again; what you typed is still on this page.',
  // B1.1 (appendix A §4; revision wording from the Stage 3 contract draft §11)
  billing_verified: 'Accounts has already verified these billing details, so they can’t be changed here. Ask Accounts to change them. Nothing on this step was saved.',
  version_superseded: 'This booking version has been replaced by a newer one. Reload to see the current version.',
  revision_not_allowed: 'This booking can only be fixed after Accounts returns it. If Accounts has since approved it, discard your changes or ask Accounts to return it.',
  already_committed: 'A supplier has already confirmed a service on this booking, or a visa or passport is already finished. Changes after that are not supported yet. Talk to your manager, Purchase and Accounts.',
  classification_not_allowed: 'This change can’t be marked as a spelling or format fix or as internal only. Changes to dates, rooms, travellers, services or price need the customer to accept again.',
  revision_items_fixed: 'Services can’t be added or removed while fixing a returned booking. Change the existing services, or talk to your manager.',
  documents_not_checked: 'All required documents must be checked first. Nothing was submitted.',
  outcome_document_required: 'Upload the authority’s outcome document first. A fee receipt or a reference never proves the outcome.',
  outcome_required: 'Documents can be marked returned only after the visa or passport is issued.',
  application_closed: 'This application is already closed. Nothing was changed.',
  task_closed: 'This task is already finished, so its files and costs can’t be changed.',
  cost_locked: 'This cost was already sent to Accounts. It can only be changed if Accounts returns it.',
  receipt_required: 'Upload the fee receipt (or, for a flight, the direct-payment proof) before sending this cost to Accounts.',
  direct_payment_over_limit: 'Above ₹50,000 per purchase, a company payment goes through a supplier payment request. Record it as "Not yet".',
  request_conflict: 'This form was already submitted with different details. Reload the page and try again.',
  wrong_state: 'This is no longer possible in the current state. Reload the page.',
  id_proof_limit: 'This traveller already has 4 identity-proof files. Remove one first. Nothing was uploaded.',
  // BI-04
  consent_required: 'Tick the customer’s agreement first. Nothing was uploaded.',
  prefill_unavailable: 'Bitrix values are not available for this Deal right now. Type the details instead. Nothing was changed.',
  settings_busy: 'The workflow switches are busy right now. Nothing was changed. Try again in a minute.',
  // DA-169
  switch_off: 'Filling from Bitrix is switched off now. Nothing was changed. Reload the page.',
  // Booking form (Mercury A.8)
  priced_per_person: 'This booking uses per-person prices. Change the amounts in the price table; the total follows from them. Nothing was saved.',
  item_file_limit: 'A flight can have at most 5 screenshots. Remove one first. Nothing was uploaded.',
  // Book now v2: "Refresh from Bitrix now" (generic fallbacks; the action sends its own message)
  refresh_too_soon: 'This Deal was refreshed a moment ago. Try again shortly.',
  refresh_switched_off: 'Reading trip facts from Bitrix is switched off, so this Deal cannot be refreshed now. Ask an admin.',
  refresh_not_bitrix_deal: 'This Deal did not come from Bitrix, so there is nothing to refresh.',
  bitrix_unavailable: 'Bitrix did not answer just now. Nothing was changed. Try again in a minute.',
  bitrix_deal_not_found: 'Bitrix cannot find this Deal any more. Nothing was changed here.',
};

export const EVIDENCE_KIND_LABEL: Record<EvidenceKind, string> = {
  acceptance_message: 'Customer acceptance message',
  ticket: 'Ticket',
  bill: 'Bill',
  payment_proof: 'Payment proof',
  other: 'Other proof',
};

/** What the confirm dialog must say before the irreversible action. */
export const CONFIRM_DIALOG_TEXT = {
  title: 'Confirm this booking and create a Purchase task?',
  body: [
    'This locks version {versionNo} of the hotel booking. It can’t be edited afterwards.',
    'It creates one internal task for the Purchase team with the hotel details and approved budget.',
    'It does not book the hotel, contact the customer, raise an invoice or change Bitrix. Purchase arranges the hotel afterwards.',
  ],
  confirmLabel: 'Confirm and create Purchase task',
  cancelLabel: 'Go back',
} as const;

// ===========================================================================
// B1: service items, travellers, intake checklist, Flight queue, My work
// counts and Deal progress (contract: docs/implementation/frontend-first-plan-
// 2026-10-10/b1-contract-service-items-intake-tasks-2026-10-10.md, frozen
// 10 October 2026; freeze note: b1-freeze-note.md in the same folder).
// Lead-owned. Agents import; they do not redefine.
// ===========================================================================

/**
 * Sold service kinds handled by the CRM. B1: hotel, transfer, activity,
 * flight. B1.1 (freeze note §3.1, appendix A §1.1) adds visa and passport,
 * both handled by the Visa & Passport desk (department 'visa'). Train stays
 * on hold (DEC-18).
 */
export type ServiceType = 'hotel' | 'transfer' | 'activity' | 'flight' | 'visa' | 'passport';
export const SERVICE_TYPES = ['hotel', 'transfer', 'activity', 'flight', 'visa', 'passport'] as const satisfies readonly ServiceType[];
/** Service kinds that are sold but on hold: no item, no task (service_on_hold). B1.1: train only. */
export const ON_HOLD_SERVICE_TYPES = ['train'] as const;
export type ServiceDepartment = 'purchase' | 'flight' | 'visa';
export const SERVICE_DEPARTMENT: Record<ServiceType, ServiceDepartment> = {
  hotel: 'purchase',
  transfer: 'purchase',
  activity: 'purchase',
  flight: 'flight',
  visa: 'visa',
  passport: 'visa',
};
/** planned = on a draft only; active = part of a confirmed version (task exists); cancelled reserved for Stage 9. */
export type ServiceItemState = 'planned' | 'active' | 'cancelled';
export type TravellerType = 'adult' | 'child' | 'infant';
export const TRAVELLER_TYPES = ['adult', 'child', 'infant'] as const satisfies readonly TravellerType[];
export const MAX_SERVICE_ITEMS = 20;
export const MAX_TRAVELLERS = 100;
export const MAX_FLIGHT_SEGMENTS = 8;

export interface Traveller {
  /** 1–120 characters. */
  fullName: string;
  type: TravellerType;
  /** 1-based order; unique per Deal. */
  seq: number;
}

/** Facts per service type (contract §8). Same keys in the database validator. Never a selling value. */
export interface HotelServiceFacts {
  /**
   * Required when `mode` is absent or 'specific' (B1 behaviour). B1.1: in
   * 'preferences' mode the database may store no hotel name; the wire value
   * is then null.
   */
  hotelName: string | null;
  city: string;
  /** ISO date YYYY-MM-DD. */
  checkIn: string;
  checkOut: string;
  rooms: number;
  adults: number;
  roomType?: string | null;
  mealPlan?: string | null;
  children?: number | null;
  inclusions?: string | null;
  specialRequests?: string | null;
  // B1.1 additive keys (appendix A §1.2).
  /** Absent = 'specific' (hotelName required). 'preferences' = acceptable options in `preferences`. */
  mode?: HotelMode | null;
  preferences?: string | null;
  area?: string | null;
  /** One age (0–17) per child; length equals `children` when present. */
  childAges?: number[] | null;
  exclusions?: string | null;
  // B1.2 additive keys (Atlas 0200, DEC-33 residual): counts and remarks only.
  /** Extra beds, 0–20. */
  extraBeds?: number | null;
  /** Children sharing without a bed, 0–20. */
  childrenWithoutBed?: number | null;
  bedRemarks?: string | null;
  /** Book now v2: requests "for whom"; the database writes `specialRequests` from them. */
  requestItems?: RequestItem[] | null;
}
/** B1.2 hotel extras (Atlas 0200, DEC-33): limits and labels for the quotation and Book now hotel forms. */
export const HOTEL_EXTRA_LIMITS = { extraBeds: { min: 0, max: 20 }, childrenWithoutBed: { min: 0, max: 20 }, bedRemarks: 300 } as const;
export const HOTEL_EXTRA_LABEL = {
  extraBeds: { label: 'Extra beds', hint: 'Count only. Any charge is a separate price line chosen by staff.' },
  childrenWithoutBed: { label: 'Children sharing without a bed', hint: 'Count only; no ages needed.' },
  bedRemarks: { label: 'Bed remarks', hint: 'For example: extra bed for a 9-year-old; hotel charges per night.' },
} as const;

export interface TransferServiceFacts {
  /** Always stored: derived as "<pickup> to <drop>" by the database when only pickup and drop were given. */
  route: string;
  date: string;
  /** B1 required; B1.1 optional (plan §3f, freeze note §3.1). */
  vehicleType: string | null;
  /** B1 required; B1.1 optional (plan §3f, freeze note §3.1). */
  passengers: number | null;
  /** HH:MM, 24-hour. */
  pickupTime?: string | null;
  notes?: string | null;
  // B1.1
  pickup?: string | null;
  drop?: string | null;
  // Booking form (booking-form-contract.ts TransferFactKeys): a car for the whole trip
  endDate?: string | null;
  quantity?: number | null;
  includedKms?: number | null;
  vendor?: string | null;
  // Book now v2 (booking-form-contract.ts TransferFactKeysV2)
  carKind?: CarKind | null;
  /** service_items.id of the flight the car meets (format only). */
  flightItemId?: string | null;
}
export interface ActivityServiceFacts {
  name: string;
  city: string;
  date: string;
  participants: number;
  time?: string | null;
  notes?: string | null;
  // B1.1
  inclusions?: string | null;
}
export interface FlightSegment {
  /** B1: IATA code. B1.1: IATA code (3 upper-case letters) or a place name (2–60 letters). */
  from: string;
  to: string;
  date: string;
  /** B1.1: flexibility for this leg, e.g. "± 1 day" (≤ 60). */
  flex?: string | null;
  // Booking form (booking-form-contract.ts FlightSegmentKeys)
  arrivalDate?: string | null;
  airline?: string | null;
  flightNo?: string | null;
  departTime?: string | null;
  arriveTime?: string | null;
}
export interface FlightServiceFacts {
  /** Book now v2: empty for a flight added from a screenshot (entryMode 'screenshot'). */
  segments: FlightSegment[];
  passengers: number;
  preferredTime?: string | null;
  cabin?: string | null;
  notes?: string | null;
  // B1.1
  tripType?: FlightTripType | null;
  /** Baggage, seat, meal preferences (≤ 500). */
  preferences?: string | null;
  /** Special assistance (≤ 500). */
  assistance?: string | null;
  // Book now v2 (booking-form-contract.ts FlightFactKeysV2)
  /** Absent = 'typed'. */
  entryMode?: FlightEntryMode | null;
  /** Note for the Flight team (≤ 200), screenshot flights only. */
  screenshotNote?: string | null;
  /** Requests "for whom"; the database writes `preferences` from them. */
  requestItems?: RequestItem[] | null;
  /** Created by "Add return flights". */
  isReturn?: boolean | null;
}
/** B1.1: visa service (Visa & Passport desk). Required: country, purpose, travelDate, feePaidBy. */
export interface VisaServiceFacts {
  country: string;
  purpose: string;
  travelDate: string;
  /** On or before travelDate. */
  applyBy?: string | null;
  feePaidBy: VisaFeePaidBy;
  notes?: string | null;
}
/** B1.1: passport service (Visa & Passport desk). Exactly one participant (readiness). */
export interface PassportServiceFacts {
  applicationType: PassportApplicationType;
  officeCity: string;
  neededBy?: string | null;
  notes?: string | null;
}
export type ServiceFacts =
  | { type: 'hotel'; facts: HotelServiceFacts }
  | { type: 'transfer'; facts: TransferServiceFacts }
  | { type: 'activity'; facts: ActivityServiceFacts }
  | { type: 'flight'; facts: FlightServiceFacts }
  | { type: 'visa'; facts: VisaServiceFacts }
  | { type: 'passport'; facts: PassportServiceFacts };

export const SERVICE_FACT_LIMITS = {
  route: 200,
  vehicleType: 60,
  activityName: 200,
  city: 120,
  notes: 2000,
  cabin: 40,
  preferredTime: 60,
  passengers: { min: 1, max: 100 },
  segments: { min: 1, max: MAX_FLIGHT_SEGMENTS },
} as const;

/** Keys allowed in each facts object (the database refuses anything else with invalid_input). */
export const SERVICE_FACT_KEYS: Record<ServiceType, readonly string[]> = {
  hotel: [
    'hotelName', 'city', 'checkIn', 'checkOut', 'rooms', 'adults', 'roomType', 'mealPlan', 'children', 'inclusions', 'specialRequests',
    // B1.1
    'mode', 'preferences', 'area', 'childAges', 'exclusions',
    // B1.2 (0200, DEC-33): counts and remarks only; never multiplied into money
    'extraBeds', 'childrenWithoutBed', 'bedRemarks',
    // Book now v2
    'requestItems',
  ],
  transfer: [
    'route', 'date', 'vehicleType', 'passengers', 'pickupTime', 'notes', 'pickup', 'drop',
    // Booking form and Book now v2
    'endDate', 'quantity', 'includedKms', 'vendor', 'carKind', 'flightItemId',
  ],
  activity: ['name', 'city', 'date', 'participants', 'time', 'notes', 'inclusions'],
  flight: [
    'segments', 'passengers', 'preferredTime', 'cabin', 'notes', 'tripType', 'preferences', 'assistance',
    // Book now v2
    'entryMode', 'screenshotNote', 'requestItems', 'isReturn',
  ],
  visa: ['country', 'purpose', 'travelDate', 'applyBy', 'feePaidBy', 'notes'],
  passport: ['applicationType', 'officeCity', 'neededBy', 'notes'],
};
/** B1.1: keys allowed inside one flight segment. */
export const FLIGHT_SEGMENT_KEYS = ['from', 'to', 'date', 'flex'] as const;

export const SERVICE_TYPE_LABEL: Record<ServiceType, string> = {
  hotel: 'Hotel',
  transfer: 'Transfer or cab',
  activity: 'Activity',
  flight: 'Flight',
  visa: 'Visa',
  passport: 'Passport',
};
export const SERVICE_DEPARTMENT_LABEL: Record<ServiceDepartment, string> = {
  purchase: 'Purchase',
  flight: 'Flight team',
  visa: 'Visa & Passport desk',
};

// ---------------------------------------------------------------------------
// Command results (§7.1)
// ---------------------------------------------------------------------------

export interface ServiceItemAddResult {
  itemId: string;
  itemNo: number;
  rowVersion: number;
  contentHash: string;
}
export interface ServiceItemSaveResult {
  rowVersion: number;
  contentHash: string;
}
export interface ServiceItemRemoveResult {
  removed: true;
  rowVersion: number;
  contentHash: string;
}
export interface TravellersSaveResult {
  rowVersion: number;
  contentHash: string;
}
export interface WorkflowSettingResult {
  key: WorkflowSettingKey;
  changed: boolean;
  before: boolean;
  after: boolean;
  updatedAt: string;
  /** B1.1: switching visa_passport_tasks_enabled on creates missing tasks once. */
  tasksCreated?: number;
  skipped?: number;
}

/** B1.1 adds visa_passport_tasks_enabled (off; settable from migration 0500). Batch 2 adds prefill_auto_fill (off; migration 20261122000100, lead ruling D2). */
/** Batch 3 adds referral_drafts (off; migration 20261123000100, atlas-batch3-shapes §0). */
export type WorkflowSettingKey = 'intake_prompt_enabled' | 'service_items_enabled' | 'visa_passport_tasks_enabled' | 'prefill_auto_fill' | 'referral_drafts';
export const WORKFLOW_SETTING_KEYS = [
  'intake_prompt_enabled',
  'service_items_enabled',
  'visa_passport_tasks_enabled',
  'prefill_auto_fill',
  'referral_drafts',
] as const satisfies readonly WorkflowSettingKey[];
export interface WorkflowSettingsView {
  intakePromptEnabled: boolean;
  serviceItemsEnabled: boolean;
  /** B1.1: absent on a database without B1.1 (most readers treat it as off; the Workflow switches page shows Unknown). */
  visaPassportTasksEnabled?: boolean;
  /** Batch 2: absent on a database without migration A; the Workflow switches page shows Unknown, never Off. */
  prefillAutoFill?: boolean;
  /**
   * Batch 3 (atlas-batch3-shapes §0): the referral drafts switch as read; absent on a database
   * without migration B (Unknown, never Off).
   */
  referralDrafts?: boolean;
  updatedAt: string | null;
}
export const WORKFLOW_SETTING_LABEL: Record<WorkflowSettingKey, { title: string; detail: string }> = {
  // S-03 / DA-257 (copy-catalogue §16.13): plain names, also used in APPROVAL NEEDED messages.
  service_items_enabled: {
    title: 'Book now (service list)',
    detail: 'On: new bookings list each sold service; submitting creates one task per service. Off: new bookings use the older single hotel booking. Bookings and tasks already made stay readable.',
  },
  intake_prompt_enabled: {
    title: 'Count of won deals with no booking (on Home)',
    detail: 'On: Sales and branch Managers see on Home how many deals reached “Won - Payment Received” in Bitrix but have no booking yet. Count only; nothing is created. Off: the count is hidden.',
  },
  // DA-258
  visa_passport_tasks_enabled: {
    title: 'Visa and passport tasks',
    detail: 'On: each sold visa or passport service gets one task for the Visa and passport desk. Off: those services are saved and wait; no task is created or deleted.',
  },
  // money-privacy-settings §6 "Referral drafts" review text (provisional; Mercury confirms).
  referral_drafts: {
    title: 'Referral drafts',
    // DA-239 (copy-catalogue §16.12).
    detail:
      'On: Sales and branch Managers can start quotations and itineraries for customers not in Bitrix yet. Until a draft is linked to a Bitrix lead or deal, only its owner and the branch Manager can open it; a booking starts only from a linked, confirmed deal. A draft with no changes for 90 days (India time) closes on its own, unless a quotation from it is already tied to a deal; it stays readable and can be reopened, and nothing is deleted. Off: no new referral drafts, and nothing closes on its own; existing drafts keep working (change, link, close, reopen). Turning it on again starts the 90 days again for every open draft. The Quotations and Itineraries lists work either way.',
  },
  // DA-171 / DA-172 (copy-catalogue §16.11).
  prefill_auto_fill: {
    title: 'Fill new bookings and quotations from Bitrix',
    detail:
      'On: when staff start a booking or create a quotation, empty fields get the Bitrix dates and contact details once, marked “From Bitrix”. Nothing is filled later, on reload, or over what staff typed or cleared. Billing, GSTIN, ID consent and the contact check are never filled. On also changes checking: one “I checked these Bitrix details” per section replaces the per-field buttons, a section saved without a check shows “saved, not checked”, and ticking the customer contact check also marks the mobile and email from Bitrix as checked. Older drafts get a “Fill empty fields from Bitrix” button. Off: staff use the “Use Bitrix value” buttons as before. Switching fills no existing draft, and values already filled stay. Needs “Read trip facts from Bitrix” on.',
  },
};

// ---------------------------------------------------------------------------
// Intake checklist (§9)
// ---------------------------------------------------------------------------

export type IntakeChecklistCode =
  | 'stage_not_confirmed'
  | 'no_services'
  | 'acceptance_missing'
  | 'traveller_missing'
  | 'traveller_name_incomplete'
  | 'service_facts_invalid'
  | 'dates_outside_trip'
  | 'budget_missing'
  | 'visa_mentioned'
  // B1.1 blocking (appendix A §1.4)
  | 'contact_missing'
  | 'contact_not_confirmed'
  | 'billing_missing'
  | 'gstin_missing'
  | 'trip_missing'
  | 'child_age_missing'
  | 'participation_missing'
  | 'identity_missing'
  | 'plan_missing'
  | 'plan_total_mismatch'
  | 'selling_total_missing'
  // B1.1: viewers without commercial scope see these instead of the price/plan codes
  | 'selling_total_ask_owner'
  | 'plan_ask_owner'
  // B1.1 warnings
  | 'participation_count_mismatch'
  | 'passport_details_later'
  | 'passport_expiry_before_trip_end'
  | 'visa_waiting_for_launch'
  | 'billing_unverified'
  // B1.2 (0100, DEC-38): an adult without a stored identity proof (blocking); a child or infant without one (warning)
  | 'id_proof_missing'
  | 'id_proof_missing_child'
  // B1.2 (0200): converted from a quotation
  | 'quote_acceptance_stale'
  | 'quote_details_changed'
  // B1.2 (Atlas E5-6): named travellers differ from the accepted quotation's party (warning)
  | 'quote_party_differs'
  // B1.2 (0600): fields filled from Bitrix that nobody has checked yet (warning)
  | 'prefill_unchecked'
  // Booking form (20261124000120, form_rules 2 drafts)
  | 'pax_missing'
  | 'pax_types_exceeded'
  | 'price_missing'
  | 'price_count_mismatch'
  | 'price_below_purchase'
  | 'hotel_nights_missing'
  | 'hotel_outside_trip'
  | 'hotel_same_day_trip'
  | 'service_dates_outside_trip'
  | 'gst_status_missing'
  | 'gst_reason_missing'
  | 'billing_contact_missing'
  | 'billing_reach_missing'
  // Book now v2 (20261129000120): a flight added from a screenshot has no stored screenshot
  | 'flight_screenshot_missing'
  | 'prices_ask_owner'
  // B1.1 revision drafts
  | 'revision_class_missing'
  | 'customer_acceptance_required'
  | 'no_changes'
  | 'base_no_longer_returned';
export const INTAKE_CHECKLIST_CODES = [
  'stage_not_confirmed',
  'no_services',
  'acceptance_missing',
  'traveller_missing',
  'traveller_name_incomplete',
  'service_facts_invalid',
  'dates_outside_trip',
  'budget_missing',
  'visa_mentioned',
  'contact_missing',
  'contact_not_confirmed',
  'billing_missing',
  'gstin_missing',
  'trip_missing',
  'child_age_missing',
  'participation_missing',
  'identity_missing',
  'plan_missing',
  'plan_total_mismatch',
  'selling_total_missing',
  'selling_total_ask_owner',
  'plan_ask_owner',
  'participation_count_mismatch',
  'passport_details_later',
  'passport_expiry_before_trip_end',
  'visa_waiting_for_launch',
  'billing_unverified',
  'id_proof_missing',
  'id_proof_missing_child',
  'quote_acceptance_stale',
  'quote_details_changed',
  'quote_party_differs',
  'prefill_unchecked',
  'pax_missing',
  'pax_types_exceeded',
  'price_missing',
  'price_count_mismatch',
  'price_below_purchase',
  'hotel_nights_missing',
  'hotel_outside_trip',
  'hotel_same_day_trip',
  'service_dates_outside_trip',
  'gst_status_missing',
  'gst_reason_missing',
  'billing_contact_missing',
  'billing_reach_missing',
  'flight_screenshot_missing',
  'prices_ask_owner',
  'revision_class_missing',
  'customer_acceptance_required',
  'no_changes',
  'base_no_longer_returned',
] as const satisfies readonly IntakeChecklistCode[];
/** Who fixes the item: Sales on the form, Bitrix (the stage), Accounts (billing) or an admin (desk launch switch). */
export type IntakeChecklistOwner = 'sales' | 'bitrix' | 'accounts' | 'admin';
export const INTAKE_CHECKLIST_OWNERS = ['sales', 'bitrix', 'accounts', 'admin'] as const satisfies readonly IntakeChecklistOwner[];
export interface IntakeChecklistItem {
  code: IntakeChecklistCode;
  blocking: boolean;
  owner: IntakeChecklistOwner;
  /** Item numbers the rule applies to (empty for Deal-level rules). */
  itemNos: number[];
  /** B1.1: traveller seqs for traveller-level rules (absent on older databases). */
  travellerSeqs?: number[];
  /** B1.2 (0600) prefill_unchecked: the field codes still marked "from Bitrix". */
  fields?: string[];
}
export interface IntakeChecklist {
  items: IntakeChecklistItem[];
  canConfirm: boolean;
}
export const CHECKLIST_TEXT: Record<IntakeChecklistCode, string> = {
  stage_not_confirmed: 'Bitrix hasn’t marked this Deal "Won - Payment Received" yet. You can keep preparing; tasks start after that.',
  no_services: 'Add at least one service that was sold.',
  acceptance_missing: 'Upload the customer’s acceptance message.',
  traveller_missing: 'The services need more travellers than you’ve listed. Add the missing names.',
  traveller_name_incomplete: 'Every traveller needs a full name.',
  service_facts_invalid: 'A service is missing details. Open it and fill the highlighted fields.',
  dates_outside_trip: 'A service date is more than a day outside the other services’ dates. Check it.',
  budget_missing: 'A service has no Purchase budget yet. Tasks can still be created; Purchase will ask.',
  visa_mentioned: 'Visa, passport or train is mentioned. Those are on hold: no CRM task is created for them.',
  // B1.1
  contact_missing: ISSUE_TEXT.contact_missing,
  contact_not_confirmed: ISSUE_TEXT.contact_not_confirmed,
  billing_missing: ISSUE_TEXT.billing_missing,
  gstin_missing: ISSUE_TEXT.gstin_missing,
  trip_missing: ISSUE_TEXT.trip_missing,
  child_age_missing: ISSUE_TEXT.child_age_missing,
  participation_missing: ISSUE_TEXT.participation_missing,
  identity_missing: ISSUE_TEXT.identity_missing,
  plan_missing: ISSUE_TEXT.plan_missing,
  plan_total_mismatch: ISSUE_TEXT.plan_total_mismatch,
  selling_total_missing: ISSUE_TEXT.missing_selling_total,
  selling_total_ask_owner: ISSUE_TEXT.missing_selling_total_ask_owner,
  plan_ask_owner: ISSUE_TEXT.plan_ask_owner,
  participation_count_mismatch: 'A service has a different number of travellers taking part than its details say. Check it.',
  passport_details_later: 'Passport number and expiry can be added later, before ticketing or filing.',
  passport_expiry_before_trip_end: 'A passport expires before the trip ends. Check it with the customer.',
  visa_waiting_for_launch: 'Visa and passport services are recorded and wait for the Visa & Passport desk launch. They still count as outstanding.',
  id_proof_missing: ISSUE_TEXT.id_proof_missing,
  id_proof_missing_child: 'No identity proof is attached for this child or infant yet. Attach it when the customer sends it.',
  quote_acceptance_stale: ISSUE_TEXT.quote_acceptance_stale,
  quote_details_changed: 'Extra beds, children without a bed, bed remarks or meals changed from the accepted quotation. Check with the customer if needed.',
  // Booking form (Echo review A L3): also when the passenger counts differ (readiness then adds quote_acceptance_stale).
  quote_party_differs: 'Passenger counts differ from the accepted quotation. Get fresh written acceptance.',
  prefill_unchecked: 'Some details were filled from Bitrix and nobody has checked them yet. Check them, then mark them checked.',
  billing_unverified: 'Accounts still needs to check the Bill To details. You can submit; Accounts checks them in the booking review.',
  pax_missing: ISSUE_TEXT.pax_missing,
  pax_types_exceeded: ISSUE_TEXT.pax_types_exceeded,
  price_missing: ISSUE_TEXT.price_missing,
  price_count_mismatch: ISSUE_TEXT.price_count_mismatch,
  price_below_purchase: ISSUE_TEXT.price_below_purchase,
  hotel_nights_missing: ISSUE_TEXT.hotel_nights_missing,
  hotel_outside_trip: ISSUE_TEXT.hotel_outside_trip,
  hotel_same_day_trip: ISSUE_TEXT.hotel_same_day_trip,
  service_dates_outside_trip: ISSUE_TEXT.service_dates_outside_trip,
  gst_status_missing: ISSUE_TEXT.gst_status_missing,
  gst_reason_missing: ISSUE_TEXT.gst_reason_missing,
  billing_contact_missing: ISSUE_TEXT.billing_contact_missing,
  billing_reach_missing: ISSUE_TEXT.billing_reach_missing,
  flight_screenshot_missing: ISSUE_TEXT.flight_screenshot_missing,
  prices_ask_owner: ISSUE_TEXT.prices_ask_owner,
  revision_class_missing: ISSUE_TEXT.revision_class_missing,
  customer_acceptance_required: ISSUE_TEXT.customer_acceptance_required,
  no_changes: ISSUE_TEXT.no_changes,
  base_no_longer_returned: ISSUE_TEXT.base_no_longer_returned,
};

// ---------------------------------------------------------------------------
// Deal services, progress and My work counts (§7.1, §5.4)
// ---------------------------------------------------------------------------

/** What happens next for one service item (derived, never stored). */
export type ServiceNextStep =
  | 'confirm_version' // planned: part of the draft; tasks come with confirmation
  | 'take_task' // active, task not started
  | 'supplier_confirmation' // active, task in progress
  | 'done' // active, supplier confirmed (visa/passport: task completed)
  | 'waiting_for_desk_launch' // B1.1: visa/passport item active, no task, desk switch off
  | 'visa_processing'; // B1.1 (0500): visa/passport task in progress with the desk
export const SERVICE_NEXT_STEP_TEXT: Record<ServiceNextStep, string> = {
  // D-13 (copy-catalogue; seen by departments on the Deal too)
  confirm_version: 'In draft',
  take_task: 'Waiting for the department to take it',
  supplier_confirmation: 'Being arranged (not booked yet)',
  done: 'Confirmed by supplier',
  waiting_for_desk_launch: 'Waiting for the Visa desk to start',
  visa_processing: 'With the Visa desk',
};
/** D-13 with the department named ("Waiting for Purchase"); {department} = Purchase / Flight / the Visa desk. */
export const SERVICE_NEXT_STEP_DEPARTMENT_TEXT = 'Waiting for {department}';

/** B1.1: every task status, incl. 'completed' (Visa & Passport desk only: issued and returned, or refused and informed). */
export type DepartmentTaskStatus = PurchaseTaskStatus | 'completed';
export const DEPARTMENT_TASK_STATUSES = ['not_started', 'in_progress', 'supplier_confirmed', 'completed'] as const satisfies readonly DepartmentTaskStatus[];

export interface ServiceItemTaskView {
  taskId: string;
  /** B1.1: may be 'completed' for Visa & Passport desk tasks. */
  status: DepartmentTaskStatus;
  assigneeName: string | null;
  assignedToYou: boolean;
  supplierConfirmedAt: string | null;
  /** B1.1 (0500): when a Visa & Passport task was completed. Absent before 0500. */
  completedAt?: string | null;
}

/** One sold service as seen on the Deal page and intake screen (role-filtered by the database and the DTO). */
export interface ServiceItemView {
  itemId: string;
  itemNo: number;
  serviceType: ServiceType;
  department: ServiceDepartment;
  state: ServiceItemState;
  title: string;
  facts: ServiceFacts;
  /** Absent when the viewer may not see this department's budget (contract §6). */
  purchaseBudgetPaise?: string | null;
  /** Hash of the stored facts; used to detect changes between reads. */
  factsHash: string;
  task: ServiceItemTaskView | null;
  nextStep: ServiceNextStep;
  /** B1.1: traveller seqs taking part (full-scope readers only; absent for departments and older databases). */
  participants?: number[];
  /** B1.1: visa/passport item recorded but its task waits for the desk switch. */
  waitingForLaunch?: boolean;
}

export interface DealProgress {
  total: number;
  /**
   * B1.1 adds waitingForLaunch (visa/passport items without a task while the
   * desk switch is off; outstanding, never fulfilled) and completed (visa
   * tasks done). Absent = 0.
   */
  byState: {
    planned: number;
    notStarted: number;
    inProgress: number;
    supplierConfirmed: number;
    waitingForLaunch?: number;
    completed?: number;
  };
  /** Every item (not on hold) has a supplier confirmation; false while total is 0. */
  fulfilled: boolean;
  /** Reserved for Stage 3 revisions; always 0 in B1. */
  staleCount: number;
  /** Next steps still open, deduplicated, in display order. */
  needs: ServiceNextStep[];
}
export interface DealServiceSummaryView extends DealProgress {
  dealId: string;
  /** Service types sold, in item order (for the "Services sold" chips). */
  serviceTypes: ServiceType[];
}

export interface DealServicesView {
  dealId: string;
  version: { versionId: string; versionNo: number; status: BookingStatus; rowVersion: number; contentHash: string; serviceType: 'hotel' | 'package' } | null;
  items: ServiceItemView[];
  /** Absent for Purchase and Flight viewers (names are personal data; they get counts in the facts). */
  travellers?: DealTravellerView[];
  /** B1.1: trip block of the version shown (absent on older databases). */
  trip?: BookingTrip | null;
  progress: DealProgress;
  canEdit: boolean;
  canConfirm: boolean;
}

/** Role-scoped counts for Home. null = not applicable to this viewer's roles. */
export interface MyWorkCounts {
  waitingForMe: number;
  returnedToMe: number;
  missingDetails: number;
  intakeNeeded: number;
  receiptsToVerify: number | null;
  requestsToApprove: number | null;
  /** B1.1 (migration 0500): Accounts, advance claims reported by Sales and not yet handled. Absent/null = not applicable or not installed. */
  claimsToProcess?: number | null;
  /** B1.1 (0500): Accounts, department expense records submitted by someone else. */
  expensesToReview?: number | null;
  /** B1.1 (0500): Visa & Passport desk, tasks waiting to be taken. */
  visaTasksWaiting?: number | null;
  /** Batch 1 (20261121000120): Sales/Manager booking drafts to continue, counted on their own. Absent/null = not applicable or not installed. */
  draftsToContinue?: number | null;
  /** Batch 3 (20261123000100, FP-081): quotations whose current version is a draft or ready, not converted, draft not closed (scope: everything the caller can open). Absent/null = not applicable or not installed. */
  quotationDraftsToFinish?: number | null;
  /** Batch 3 (FP-081): accepted quotations not converted and with no Deal to book into yet. Absent/null = not applicable or not installed. */
  acceptedQuotesToLink?: number | null;
}
export const MY_WORK_LABEL: Record<keyof MyWorkCounts, string> = {
  waitingForMe: 'Waiting for me',
  returnedToMe: 'Returned by Accounts',
  missingDetails: 'Missing details',
  intakeNeeded: 'Confirmed bookings needing intake',
  receiptsToVerify: 'Receipts to verify',
  requestsToApprove: 'Requests to approve',
  // A-20
  claimsToProcess: 'Reported payments to check',
  expensesToReview: 'Department costs to review',
  visaTasksWaiting: 'Visa & Passport tasks waiting',
  draftsToContinue: 'Booking drafts to continue',
  quotationDraftsToFinish: 'Quotation drafts to finish',
  acceptedQuotesToLink: 'Accepted quotations to link',
};

// ---------------------------------------------------------------------------
// Intake screen view (SCR-INTAKE)
// ---------------------------------------------------------------------------

/** Where a prefilled value came from. 'bitrix' only after the owner confirms the field mapping (B1-O2). */
export type FactSource = 'crm' | 'bitrix';

export interface IntakeView {
  dealId: string;
  dealReference: string;
  dealTitle: string;
  /** Bitrix stage as synced; null for synthetic or CRM-native Deals. */
  stage: { stageId: string; label: string | null; isTriggerStage: boolean } | null;
  serviceItemsEnabled: boolean;
  services: DealServicesView;
  travellers: Traveller[];
  /** Source of the traveller and service prefill shown with the badge. */
  prefillSource: FactSource;
  checklist: IntakeChecklist;
  evidence: EvidenceItemView[];
  evidenceVisible: boolean;
  /** Absent for viewers without commercial scope (never Purchase). */
  sellingTotalPaise?: string | null;
  gate: BookingPanelView['gate'];
  canEdit: boolean;
  canConfirm: boolean;
  confirmBlockedReason: string | null;
  openBlockedReason: string | null;
  dealNotActive: boolean;
}

// ---------------------------------------------------------------------------
// Flight queue (minimal, mirrors Purchase)
// ---------------------------------------------------------------------------

/** Flight DTOs carry NO selling price, margin, acceptance proof or other departments' budgets. */
export interface FlightTaskSummary {
  taskId: string;
  dealReference: string;
  itemTitle: string;
  facts: FlightServiceFacts;
  purchaseBudgetPaise: string;
  status: PurchaseTaskStatus;
  assigneeName: string | null;
  assignedToYou: boolean;
  branchName: string;
  createdAt: string;
  supplierConfirmedAt: string | null;
}
export interface FlightTaskView extends FlightTaskSummary {
  confirmedAt: string;
  confirmedByName: string;
  versionNo: number;
  canClaim: boolean;
  /** Traveller count from the accepted version (names are not shown to Flight in B1). */
  travellerCount: number;
  /**
   * B1.1: travellers taking part in this flight. `identity` only for the
   * assignee on an international trip (database rule). Absent on older databases.
   */
  participants?: TaskParticipantView[];
  changedFields?: string[];
  /** B1.1: trip scope of the accepted version (identity is shown only on international trips). */
  tripScope?: TripScope | null;
  /**
   * Booking form: the estimated fare of this flight (cost only). Book now v2:
   * fare per person; the total counts the participants by type. Assignee only; absent otherwise.
   */
  estimate?: ServiceEstimateView;
  /** Book now v2: typed total fare per person of all flights of the booking (cost only; null = none typed). Assignee only. */
  fareTotals?: FlightFareTotals | null;
  /** Booking form: stored flight screenshots (download through /app/flight/files/{fileId}). Assignee only; absent otherwise. */
  files?: ServiceItemFileView[];
}
export interface FlightQueueView {
  tasks: FlightTaskSummary[];
}

// ---------------------------------------------------------------------------
// Frozen wording (B1)
// ---------------------------------------------------------------------------

export const PROGRESS_EMPTY_TEXT = 'No services yet';

/** "1 of 3 confirmed · 1 in progress · 1 not started"; "2 planned" while nothing is confirmed. */
export function progressText(p: DealProgress): string {
  if (p.total === 0) return PROGRESS_EMPTY_TEXT;
  const parts: string[] = [];
  // B1.1: a completed Visa & Passport task counts as done, like a supplier confirmation.
  const done = p.byState.supplierConfirmed + (p.byState.completed ?? 0);
  const active = p.byState.notStarted + p.byState.inProgress + done;
  if (active > 0) parts.push(`${done} of ${active} confirmed`);
  if (p.byState.inProgress > 0) parts.push(`${p.byState.inProgress} in progress`);
  if (p.byState.notStarted > 0) parts.push(`${p.byState.notStarted} not started`);
  if (p.byState.planned > 0) parts.push(`${p.byState.planned} planned`);
  const waiting = p.byState.waitingForLaunch ?? 0;
  if (waiting > 0) parts.push(`${waiting} waiting for desk launch`);
  return parts.join(' · ');
}

export const INTAKE_CONFIRM_DIALOG_TEXT = {
  title: 'Save the accepted version and create tasks?',
  body: [
    'This locks version {versionNo} of this Deal’s accepted services and travellers. It can’t be edited afterwards.',
    'It creates {taskCount} internal {taskNoun}: one per sold service, for the Purchase team and the Flight team.',
    'It does not book anything, pay anyone, contact the customer, raise an invoice or change Bitrix.',
  ],
  confirmLabel: 'Save accepted version and create tasks',
  cancelLabel: 'Go back',
} as const;

export const INTAKE_CONFIRM_SUCCESS_TEXT = 'Accepted version saved and {taskCount} internal {taskNoun} created. Nothing is booked or paid yet.';
export const INTAKE_CONFIRM_EXISTING_TEXT = 'Tasks already exist for this version. Nothing was created twice.';
/** B1.1: accepted version saved, no task yet (visa/passport waiting for the Visa & Passport desk launch). */
export const INTAKE_CONFIRM_NO_TASK_TEXT =
  'Accepted version saved. No task was created yet: the visa and passport services wait for the Visa & Passport desk launch. Nothing is booked or paid.';
export const INTAKE_DISABLED_TEXT = 'Service items are switched off for this CRM. The hotel booking on the Deal page works as before.';
export const BITRIX_SOURCE_BADGE_TEXT = 'From Bitrix';
export const CRM_SOURCE_BADGE_TEXT = 'Typed in the CRM';

export const FLIGHT_TASK_STATUS_LABEL: Record<PurchaseTaskStatus, string> = {
  // DA-271
  not_started: 'Waiting to be taken',
  in_progress: 'In progress · ticket not recorded in the CRM', // DA-280
  supplier_confirmed: 'Confirmed by supplier', // DA-318 (amends DA-271, DA-280): what the CRM records is a supplier confirmation
};

// ===========================================================================
// B1.1: Book now (stepped form), Stage 3 revision for package versions,
// department work forms and the Visa & Passport desk.
// Contract: docs/implementation/frontend-first-plan-2026-10-10/b1.1/
// b1.1-contract-2026-10-11.md (frozen 11 October 2026); freeze note:
// b1.1-freeze-note.md with appendices A–D in b1.1/freeze/. Field names follow
// the database JSON keys (camelCase). Lead-owned (written by Terra on the
// lead's behalf). Agents import; they do not redefine.
// ===========================================================================

// ---------------------------------------------------------------------------
// Additive service facts enums and limits (appendix A §1.2)
// ---------------------------------------------------------------------------

export type HotelMode = 'specific' | 'preferences';
export const HOTEL_MODES = ['specific', 'preferences'] as const satisfies readonly HotelMode[];
export const HOTEL_MODE_LABEL: Record<HotelMode, string> = {
  specific: 'A specific hotel',
  preferences: 'Preferences (acceptable options)',
};

export type FlightTripType = 'one_way' | 'return' | 'multi_city';
export const FLIGHT_TRIP_TYPES = ['one_way', 'return', 'multi_city'] as const satisfies readonly FlightTripType[];
export const FLIGHT_TRIP_TYPE_LABEL: Record<FlightTripType, string> = {
  one_way: 'One way',
  return: 'Return',
  multi_city: 'Multi-city',
};

export type VisaFeePaidBy = 'customer' | 'company' | 'not_decided';
export const VISA_FEE_PAID_BY = ['customer', 'company', 'not_decided'] as const satisfies readonly VisaFeePaidBy[];
export const VISA_FEE_PAID_BY_LABEL: Record<VisaFeePaidBy, string> = {
  customer: 'Customer pays the government fee directly',
  company: 'Company pays (expense record for Accounts; no approval bypass)',
  not_decided: 'Not decided yet',
};

export type PassportApplicationType = 'fresh' | 'renewal' | 'tatkaal' | 'minor';
export const PASSPORT_APPLICATION_TYPES = ['fresh', 'renewal', 'tatkaal', 'minor'] as const satisfies readonly PassportApplicationType[];
export const PASSPORT_APPLICATION_TYPE_LABEL: Record<PassportApplicationType, string> = {
  fresh: 'Fresh',
  renewal: 'Renewal',
  tatkaal: 'Tatkaal',
  minor: 'Minor',
};

/** B1.1 additive fact limits (B1's SERVICE_FACT_LIMITS stay unchanged). */
export const B11_FACT_LIMITS = {
  hotelPreferences: 2000,
  area: 120,
  exclusions: 2000,
  childAge: { min: 0, max: 17 },
  flex: 60,
  flightPreferences: 500,
  assistance: 500,
  pickup: 200,
  drop: 200,
  activityInclusions: 2000,
  visaCountry: 60,
  visaPurpose: 60,
  officeCity: 120,
  notes: 2000,
  /** Flight from/to: IATA code or a place name. */
  iataPattern: /^[A-Z]{3}$/,
  placePattern: /^[A-Za-z][A-Za-z .'-]{1,59}$/,
} as const;

// ---------------------------------------------------------------------------
// Steps of the Book now form (B1.2 freeze note §2.1: three steps; each step is
// one page with several sections; a section is the unit that saves)
// ---------------------------------------------------------------------------

export type BookStep = 'travellers' | 'stay' | 'finish';
export const BOOK_STEPS = ['travellers', 'stay', 'finish'] as const satisfies readonly BookStep[];
export const BOOK_STEP_LABEL: Record<BookStep, string> = {
  // DA-150 (copy-catalogue §16.11): staff words; the address keys stay travellers / stay / finish.
  // Booking form (owner-approved preview, 22 October 2026; booking-form-contract.ts BOOKING_FORM_STEP_LABEL).
  travellers: 'Customer & passengers',
  stay: 'Trip & services',
  finish: 'Price & Bill To',
};

/** Sections in page order. The section key is also the anchor id on its step page. */
export type BookSection = 'customer' | 'passengers' | 'trip' | 'hotels' | 'services' | 'identity' | 'price' | 'payment' | 'review';
export const BOOK_SECTIONS = [
  'customer',
  'passengers',
  'trip',
  'hotels',
  'services',
  'identity',
  'price',
  'payment',
  'review',
] as const satisfies readonly BookSection[];
export const BOOK_SECTION_STEP: Record<BookSection, BookStep> = {
  customer: 'travellers',
  passengers: 'travellers',
  trip: 'stay',
  hotels: 'stay',
  services: 'finish',
  identity: 'finish',
  price: 'finish',
  payment: 'finish',
  review: 'finish',
};
export const BOOK_SECTION_LABEL: Record<BookSection, string> = {
  customer: 'Customer and billing',
  // DA-151
  passengers: 'Travellers',
  trip: 'Destinations and dates',
  hotels: 'Hotels',
  services: 'Cabs, flights and other services',
  identity: 'Passport and ID details',
  price: 'Selling price',
  payment: 'Payment plan',
  review: 'Review and submit',
};

/** The six B1.1 step keys: they only redirect to the new step and section (freeze note §2.1). */
export type LegacyBookStep = 'customer' | 'trip' | 'services' | 'price' | 'payment' | 'review';
export const LEGACY_BOOK_STEPS = ['customer', 'trip', 'services', 'price', 'payment', 'review'] as const satisfies readonly LegacyBookStep[];
export const LEGACY_STEP_TARGET: Record<LegacyBookStep, { step: BookStep; section: BookSection }> = {
  customer: { step: 'travellers', section: 'customer' },
  // Booking form: trip dates live with the customer in step 1; every service in step 2.
  trip: { step: 'travellers', section: 'customer' },
  services: { step: 'stay', section: 'hotels' },
  price: { step: 'finish', section: 'price' },
  payment: { step: 'finish', section: 'payment' },
  review: { step: 'finish', section: 'review' },
};

// ---------------------------------------------------------------------------
// Trip (booking_trip_save; booking_form_get.trip)
// ---------------------------------------------------------------------------

export type TripScope = 'domestic' | 'international';
export const TRIP_SCOPES = ['domestic', 'international'] as const satisfies readonly TripScope[];
export const TRIP_SCOPE_LABEL: Record<TripScope, string> = { domestic: 'Domestic', international: 'International' };
export const TRIP_LIMITS = { destination: 200 } as const;

/** Trip block of a version. Every key is null until saved. Dates are YYYY-MM-DD; end ≥ start. */
export interface BookingTrip {
  destination: string | null;
  scope: TripScope | null;
  start: string | null;
  end: string | null;
}
/** p_fields of booking_trip_save: every key present (null clears). */
export type BookingTripFields = BookingTrip;

// ---------------------------------------------------------------------------
// Contacts and billing proposal (booking_customer_save, freeze note §3.1)
// ---------------------------------------------------------------------------

export type BookingFor = 'individual' | 'business';
export const BOOKING_FOR = ['individual', 'business'] as const satisfies readonly BookingFor[];
export const BOOKING_FOR_LABEL: Record<BookingFor, string> = { individual: 'An individual', business: 'A business' };
export const CONTACT_LIMITS = {
  contactName: 120,
  payerName: 200,
  email: 254,
  /** Indian mobile, 10 digits starting 6–9. */
  mobilePattern: /^[6-9][0-9]{9}$/,
  emailPattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
} as const;

/** booking_form_get.contacts (null until saved). */
export interface BookingContactView {
  contactName: string;
  mobile: string | null;
  email: string | null;
  contactConfirmed: boolean;
  confirmedAt: string | null;
  confirmedByName: string | null;
  bookingFor: BookingFor;
  payerDifferent: boolean;
  payerName: string | null;
}

/** p_contact of booking_customer_save / p_fields of booking_contacts_save: every key present. */
export interface BookingContactFields {
  contactName: string;
  mobile: string | null;
  email: string | null;
  contactConfirmed: boolean;
  bookingFor: BookingFor;
  payerDifferent: boolean;
  payerName: string | null;
}

export type BillingProposalStatus = 'none' | 'draft' | 'verified';
export type BillingPrefillSource = 'none' | 'sales';

/** booking_form_get.billing: the Deal's billing profile as Sales may see it (always present; status 'none' when absent). */
export interface BookingBillingView {
  status: BillingProposalStatus;
  prefillSource: BillingPrefillSource | null;
  /** 0 when no profile exists yet (the expected row version for the first proposal). */
  rowVersion: number;
  billingName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  stateCode: string | null;
  postalCode: string | null;
  gstin: string | null;
  /** Derived: Sales may propose only while the profile is absent or draft. */
  editableBySales: boolean;
}

/** p_billing of booking_customer_save / p_fields of booking_billing_propose (same keys as accounts_billing_save). */
export interface BillingProposalFields {
  billingName: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  stateCode: string;
  postalCode: string;
  gstin: string | null;
}

export interface BillingProposeResult {
  outcome: 'created' | 'updated' | 'existing';
  status: 'draft';
  rowVersion: number;
}

/** booking_customer_save → contacts saved (and billing proposed when p_billing was not null), in one transaction. */
export interface BookingCustomerSaveResult {
  rowVersion: number;
  contentHash: string;
  billing: BillingProposeResult | null;
  /** True when the database answered an exact retry with the stored result (outcome 'existing'). */
  replayed?: boolean;
}

/** booking_contacts_save, booking_trip_save, service_item_travellers_save, booking_commercials_save, booking_instalments_save. */
export interface DraftSaveResult {
  rowVersion: number;
  contentHash: string;
}

// ---------------------------------------------------------------------------
// Travellers: extra details, identity (restricted) and participation
// ---------------------------------------------------------------------------

export const TRAVELLER_LIMITS = {
  fullName: 120,
  specialNeeds: 500,
  age: { min: 0, max: 17 },
  nationality: { min: 2, max: 60 },
  passportPattern: /^[A-Z0-9]{6,15}$/,
} as const;

/** deal_travellers_save rows (B1.1 adds optional ageYears 0–17 and specialNeeds ≤ 500). */
export interface TravellerDetails extends Traveller {
  ageYears: number | null;
  specialNeeds: string | null;
}

/** Whether a traveller's identity details are complete (never the values). */
export type IdentityStatus = 'not_needed' | 'missing' | 'partial' | 'complete';
export const IDENTITY_STATUS_LABEL: Record<IdentityStatus, string> = {
  not_needed: 'Not needed',
  missing: 'Identity details missing',
  partial: 'Identity details incomplete',
  complete: 'Identity details complete',
};

/** deal_services travellers (full scope): B1 fields plus B1.1 details; never identity values. */
export interface DealTravellerView extends Traveller {
  ageYears?: number | null;
  specialNeeds?: string | null;
  identityStatus?: IdentityStatus;
}

/**
 * Restricted identity data (traveller_identities). Readers: booking editors
 * and acceptors, the Visa & Passport desk assignee for own applicants, the
 * Flight assignee on an international trip. Never Purchase, Accounts or
 * Super Admin; never sent to any external service. The full passport number
 * appears only in the editor's own form field and the assigned desk/Flight
 * detail; everywhere else use maskPassportNumber (freeze note §3.4 answer 6).
 */
export interface TravellerIdentity {
  dateOfBirth: string | null;
  nationality: string | null;
  passportNumber: string | null;
  passportExpiry: string | null;
  /** Identity row version (0 = no row yet); the expected value for traveller_identity_save. */
  rowVersion: number;
  /** Booking form passenger extras (restricted like the rest; not hashed). Absent on an older database. */
  dateOfMarriage?: string | null;
  phone?: string | null;
  email?: string | null;
  /** Voice-note batch (24 Oct 2026): optional additional phone numbers, 0..3, same rule as phone. Absent on an older database. */
  extraPhones?: string[];
}
/** p_fields of traveller_identity_save: every key present (null clears). Passport number upper-cased. */
export interface TravellerIdentityFields {
  dateOfBirth: string | null;
  nationality: string | null;
  passportNumber: string | null;
  passportExpiry: string | null;
}
export interface TravellerIdentitySaveResult {
  seq: number;
  rowVersion: number;
}

/** "K1234567" → "••••4567"; null/short → as is (never more than the last 4). */
export function maskPassportNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

/**
 * Standard special requests for a passenger (owner list, 24 October 2026).
 * Stored as codes beside the free-text special needs, which stay.
 */
export const SPECIAL_REQUEST_CODES = [
  'vegetarian_meals',
  'jain_meals',
  'wheelchair_help',
  'honeymoon_decoration',
  'early_check_in',
  'late_check_out',
  'adjoining_rooms',
  'ground_floor_room',
  'baby_cot',
  'senior_citizen_help',
] as const;
export type SpecialRequestCode = (typeof SPECIAL_REQUEST_CODES)[number];
export const SPECIAL_REQUEST_LABEL: Record<SpecialRequestCode, string> = {
  vegetarian_meals: 'Vegetarian meals',
  jain_meals: 'Jain meals',
  wheelchair_help: 'Wheelchair help',
  honeymoon_decoration: 'Honeymoon decoration',
  early_check_in: 'Early check-in',
  late_check_out: 'Late check-out',
  adjoining_rooms: 'Adjoining rooms',
  ground_floor_room: 'Ground-floor room',
  baby_cot: 'Baby cot',
  senior_citizen_help: 'Senior citizen help',
};
export function isSpecialRequestCode(value: unknown): value is SpecialRequestCode {
  return typeof value === 'string' && (SPECIAL_REQUEST_CODES as readonly string[]).includes(value);
}

/** One traveller on the Book now form. */
export interface BookTravellerView {
  /** deal_travellers id (stable across saves in B1.1: upsert by seq). Absent when the database did not send it. */
  travellerId: string | null;
  seq: number;
  fullName: string;
  type: TravellerType;
  ageYears: number | null;
  specialNeeds: string | null;
  /** Voice-note batch: standard special requests (codes). Absent on an older record = none. */
  specialRequests?: SpecialRequestCode[];
  /** Derived: takes part in a visa or passport item, or in a flight item on an international trip. */
  identityRequired: boolean;
  /** null when no identity row exists yet. */
  identity: TravellerIdentity | null;
  /**
   * B1.2 identity proof files of this traveller (Aadhaar card or another ID;
   * booking_form_get travellers[].idProofs). Absent when the viewer may not
   * read them or the database has no 0100 yet; never a typed ID number.
   */
  idProofs?: TravellerIdProofView[];
}

/** A traveller as a department sees it on its task (own item's participants; identity only where the database allows). */
export interface TaskParticipantView {
  seq: number;
  fullName: string;
  type: TravellerType;
  ageYears: number | null;
  specialNeeds: string | null;
  identity?: TravellerIdentity | null;
}

// ---------------------------------------------------------------------------
// Commercials and payment plan (commercial readers only; never Purchase,
// Flight or the desk)
// ---------------------------------------------------------------------------

/** booking_form_get.commercials. list − discount = selling total when list is set. Whole paise as digit strings. */
export interface BookingCommercials {
  listPricePaise: string | null;
  discountPaise: string | null;
  sellingTotalPaise: string | null;
}

export const MAX_INSTALMENTS = 12;
export const INSTALMENT_LABEL_MAX = 60;

/** One instalment of the payment plan (booking_version_instalments). */
export interface PlanInstalment {
  seq: number;
  label: string;
  amountPaise: string;
  dueDate: string;
}

// ---------------------------------------------------------------------------
// Readiness checklist on the form: code → step and field (freeze note §3.4
// answer 3: a frozen TS map, not database columns)
// ---------------------------------------------------------------------------

/** Every code the Book now form may list: checklist codes and readiness issue codes. */
export type BookChecklistCode = IntakeChecklistCode | BookingIssueCode;

export interface ChecklistTarget {
  step: BookStep;
  /** Section of the step that holds the fix (also its anchor id). Always on `step`. */
  section: BookSection;
  /** Form field name (FIELD value) to focus, or null for a section-level item. */
  field: string | null;
}

/**
 * Where each checklist / readiness code is fixed (B1.2 freeze note §2.1,
 * Terra contract §1.4). `field` values are form input names from forms.ts
 * FIELD (frozen with Luna's form names). Item-scoped codes
 * (ITEM_SCOPED_CHECKLIST_CODES) carry the default target here; when the
 * checklist row names items, the DTO routes it by each item's service type
 * (hotel → stay/hotels, every other type → finish/services).
 */
export const CHECKLIST_STEP: Record<BookChecklistCode, ChecklistTarget> = {
  // Step 1 · customer and billing
  contact_missing: { step: 'travellers', section: 'customer', field: 'contactName' },
  contact_not_confirmed: { step: 'travellers', section: 'customer', field: 'contactConfirmed' },
  billing_missing: { step: 'travellers', section: 'customer', field: 'billingName' },
  gstin_missing: { step: 'travellers', section: 'customer', field: 'gstin' },
  billing_unverified: { step: 'travellers', section: 'customer', field: null },
  // Step 1 · customer (contact fields); trip-date fields are routed to stay/trip by the DTO
  prefill_unchecked: { step: 'travellers', section: 'customer', field: null },
  // Step 1 · passengers
  traveller_missing: { step: 'travellers', section: 'passengers', field: 'travellerName' },
  traveller_count_mismatch: { step: 'travellers', section: 'passengers', field: 'travellerName' },
  traveller_name_incomplete: { step: 'travellers', section: 'passengers', field: 'travellerName' },
  missing_travellers: { step: 'travellers', section: 'passengers', field: 'travellerName' },
  child_age_missing: { step: 'travellers', section: 'passengers', field: 'travellerAge' },
  id_proof_missing: { step: 'travellers', section: 'passengers', field: 'file' },
  id_proof_missing_child: { step: 'travellers', section: 'passengers', field: 'file' },
  quote_party_differs: { step: 'travellers', section: 'passengers', field: 'travellerName' },
  // Step 2 · destinations and dates
  trip_missing: { step: 'stay', section: 'trip', field: 'destination' },
  // Step 2 · hotels (hotel-only readiness codes of the B1 hotel path)
  missing_hotel_name: { step: 'stay', section: 'hotels', field: 'hotelName' },
  missing_city: { step: 'stay', section: 'hotels', field: 'city' },
  missing_dates: { step: 'stay', section: 'hotels', field: 'checkIn' },
  check_out_not_after_check_in: { step: 'stay', section: 'hotels', field: 'checkOut' },
  missing_rooms: { step: 'stay', section: 'hotels', field: 'rooms' },
  // Step 2 · converted from a quotation (warning)
  quote_details_changed: { step: 'stay', section: 'hotels', field: null },
  // Step 3 · services (item-scoped codes are split by item; this is the default)
  no_services: { step: 'finish', section: 'services', field: null },
  service_facts_invalid: { step: 'finish', section: 'services', field: null },
  participation_missing: { step: 'finish', section: 'services', field: 'participantSeq' },
  participation_count_mismatch: { step: 'finish', section: 'services', field: 'participantSeq' },
  dates_outside_trip: { step: 'finish', section: 'services', field: null },
  budget_missing: { step: 'finish', section: 'services', field: 'purchaseBudgetRupees' },
  missing_purchase_budget: { step: 'finish', section: 'services', field: 'purchaseBudgetRupees' },
  visa_waiting_for_launch: { step: 'finish', section: 'services', field: null },
  visa_mentioned: { step: 'finish', section: 'services', field: null },
  // Step 3 · passport and ID details
  identity_missing: { step: 'finish', section: 'identity', field: 'dateOfBirth' },
  passport_details_later: { step: 'finish', section: 'identity', field: 'passportNumber' },
  passport_expiry_before_trip_end: { step: 'finish', section: 'identity', field: 'passportExpiry' },
  // Step 3 · selling price
  missing_selling_total: { step: 'finish', section: 'price', field: 'sellingTotalRupees' },
  selling_total_missing: { step: 'finish', section: 'price', field: 'sellingTotalRupees' },
  selling_total_ask_owner: { step: 'finish', section: 'price', field: null },
  missing_selling_total_ask_owner: { step: 'finish', section: 'price', field: null },
  // Step 3 · payment plan
  plan_missing: { step: 'finish', section: 'payment', field: 'instalmentLabel' },
  plan_total_mismatch: { step: 'finish', section: 'payment', field: 'instalmentAmountRupees' },
  plan_ask_owner: { step: 'finish', section: 'payment', field: null },
  // Booking form codes (old section model; booking-form-vm.ts maps them to the new sections and fields)
  pax_missing: { step: 'travellers', section: 'customer', field: null },
  pax_types_exceeded: { step: 'travellers', section: 'customer', field: null },
  price_missing: { step: 'finish', section: 'price', field: null },
  price_count_mismatch: { step: 'finish', section: 'price', field: null },
  price_below_purchase: { step: 'finish', section: 'price', field: null },
  prices_ask_owner: { step: 'finish', section: 'price', field: null },
  hotel_nights_missing: { step: 'stay', section: 'hotels', field: null },
  hotel_outside_trip: { step: 'stay', section: 'hotels', field: null },
  hotel_same_day_trip: { step: 'travellers', section: 'customer', field: 'tripEnd' },
  service_dates_outside_trip: { step: 'finish', section: 'services', field: null },
  gst_status_missing: { step: 'travellers', section: 'customer', field: null },
  gst_reason_missing: { step: 'travellers', section: 'customer', field: null },
  billing_contact_missing: { step: 'travellers', section: 'customer', field: null },
  billing_reach_missing: { step: 'travellers', section: 'customer', field: null },
  // Book now v2
  flight_screenshot_missing: { step: 'finish', section: 'services', field: null },
  // Step 3 · review and submit
  stage_not_confirmed: { step: 'finish', section: 'review', field: null },
  acceptance_missing: { step: 'finish', section: 'review', field: 'file' },
  missing_acceptance_proof: { step: 'finish', section: 'review', field: 'file' },
  evidence_upload_incomplete: { step: 'finish', section: 'review', field: 'file' },
  customer_acceptance_required: { step: 'finish', section: 'review', field: 'file' },
  revision_class_missing: { step: 'finish', section: 'review', field: 'changeClass' },
  no_changes: { step: 'finish', section: 'review', field: null },
  base_no_longer_returned: { step: 'finish', section: 'review', field: null },
  source_not_recently_verified: { step: 'finish', section: 'review', field: null },
  booking_disabled: { step: 'finish', section: 'review', field: null },
  environment_unset: { step: 'finish', section: 'review', field: null },
  quote_acceptance_stale: { step: 'finish', section: 'review', field: 'file' },
};

/**
 * Codes that name service items: routed by each item's service type when
 * the checklist row carries itemNos (a row naming a hotel and a flight is
 * listed on both steps).
 */
export const ITEM_SCOPED_CHECKLIST_CODES = [
  'service_facts_invalid',
  'participation_missing',
  'participation_count_mismatch',
  'dates_outside_trip',
  'budget_missing',
  'missing_purchase_budget',
  // Booking form
  'service_dates_outside_trip',
  // Book now v2
  'flight_screenshot_missing',
] as const satisfies readonly BookChecklistCode[];

/** One item on the form's checklist (merged from intake_checklist and the version's readiness). */
export interface BookChecklistItem {
  code: BookChecklistCode;
  step: BookStep;
  section: BookSection;
  field: string | null;
  blocking: boolean;
  owner: IntakeChecklistOwner;
  itemNos: number[];
  travellerSeqs: number[];
  /** Plain words (CHECKLIST_TEXT / ISSUE_TEXT, with service numbers appended). */
  text: string;
  /** B1.2 (0600) prefill_unchecked only: the unchecked fields in this section. */
  prefillFields?: PrefillFieldCode[];
}

/** Per-step and per-section marker on the step list and section headings. */
export type BookStepStatus = 'complete' | 'needs_input' | 'warnings_only';
export const BOOK_STEP_STATUS_SR_TEXT: Record<BookStepStatus, string> = {
  complete: '(complete)',
  needs_input: '(needs input)',
  warnings_only: '(warnings only)',
};

// ---------------------------------------------------------------------------
// Revision path (Stage 3 for package versions, appendix A §2)
// ---------------------------------------------------------------------------

/** Version statuses including the revision path (B1 BookingStatus stays draft | confirmed). */
export type BookVersionStatus = BookingStatus | 'superseded' | 'discarded';
export const BOOK_VERSION_STATUSES = ['draft', 'confirmed', 'superseded', 'discarded'] as const satisfies readonly BookVersionStatus[];
export const BOOK_VERSION_STATUS_LABEL: Record<BookVersionStatus, string> = {
  draft: 'Draft',
  confirmed: 'Submitted · accepted version',
  superseded: 'Replaced by a newer version',
  discarded: 'Discarded',
};

export type ChangeClass = 'format_only' | 'internal_only' | 'customer_material';
export const CHANGE_CLASSES = ['format_only', 'internal_only', 'customer_material'] as const satisfies readonly ChangeClass[];
export const CHANGE_CLASS_LABEL: Record<ChangeClass, { title: string; rule: string }> = {
  format_only: {
    title: 'Spelling or layout only',
    rule: 'Only spelling or formatting of free text changed. The customer’s earlier acceptance still applies.',
  },
  customer_material: {
    title: 'Change the customer will notice (needs a new OK from the customer)',
    rule: 'Dates, services, travellers, rooms, price, plan or anything the customer agreed to changed. Upload the customer’s acceptance of the changed booking.',
  },
  internal_only: {
    title: 'Internal budget only (the customer never sees it)',
    rule: 'Only the internal Purchase or Flight budget changed. The customer never sees it, so no fresh acceptance is needed.',
  },
};

export type AccountsReviewStatus = 'pending' | 'returned' | 'approved';
export const ACCOUNTS_REVIEW_STATUS_LABEL: Record<AccountsReviewStatus, string> = {
  pending: 'Waiting for Accounts',
  returned: 'Returned by Accounts',
  approved: 'Approved by Accounts',
};

/** booking_panel.accountsReview (editors and acceptors). The reason is shown only when shared with Sales (S3-D2). */
export interface BookingAccountsReview {
  status: AccountsReviewStatus;
  reviewedAt: string | null;
  reason: string | null;
  reasonHidden: boolean;
}

export interface OpenRevisionResult {
  versionId: string;
  versionNo: number;
  rowVersion: number;
  revisesVersionId: string;
  created: boolean;
}
export interface ClassifyRevisionResult {
  rowVersion: number;
  contentHash: string;
  changedFields: string[];
}
/**
 * B1.1 submit (booking_confirm through submitBookingAction). Unlike the B1
 * ConfirmBookingResult, taskId may be null: a standalone visa or passport
 * while the desk is not launched, or a revision whose items have no task.
 */
export interface SubmitBookingResult {
  outcome: 'created' | 'existing' | 'revised';
  versionId: string;
  taskId: string | null;
  taskIds: string[];
  supersededVersionId: string | null;
}

export interface DiscardDraftResult {
  outcome: 'discarded' | 'existing';
}

/**
 * booking_version_history row. Commercial members only for commercial
 * readers; reviewReason only when shared with Sales and the caller edits or
 * accepts the booking.
 */
export interface BookingVersionHistoryEntry {
  versionId: string;
  versionNo: number;
  status: BookVersionStatus;
  confirmedAt: string | null;
  revisesVersionId: string | null;
  changeClass: ChangeClass | null;
  changedFields: string[];
  reviewStatus: AccountsReviewStatus | null;
  reviewReason: string | null;
  reviewReasonHidden: boolean;
  supersededAt: string | null;
  sellingTotalPaise?: string | null;
  sellingTotalDeltaPaise?: string | null;
}

/** Labels for the top-level groups of changed field keys (items.<no>.<key>, travellers.<seq>.identity, …). */
export const CHANGED_FIELD_GROUP_LABEL: Record<string, string> = {
  items: 'Service',
  sellingTotal: 'Final selling total',
  listPrice: 'List price',
  discount: 'Discount',
  plan: 'Payment plan',
  travellers: 'Travellers',
  participation: 'Who takes part',
  contacts: 'Booking contact',
  trip: 'Trip',
};

export const REVISION_CONFIRM_DIALOG_TEXT = {
  // BS-05
  title: 'Save fixed booking?',
  body: ['Replaces version {baseVersionNo} (kept in history).', 'Accounts checks it again.', 'No new tasks are created.'],
  confirmLabel: 'Save the fixed booking',
  cancelLabel: 'Go back',
} as const;
export const REVISION_CONFIRM_SUCCESS_TEXT = 'The fixed booking replaced version {baseVersionNo}. Accounts will check it. No new task was created.';
export const REVISION_DISCARD_SUCCESS_TEXT = 'The fix was discarded. The returned version stays as it was.';

// ---------------------------------------------------------------------------
// The Book now view (appendix D §5.2, adjusted to booking_form_get keys)
// ---------------------------------------------------------------------------

/** A service item on the form: B1 ServiceItemView plus participants and the desk-launch flag. */
export interface BookServiceItemView extends ServiceItemView {
  participants: number[];
  waitingForLaunch: boolean;
}

export interface BookNowVersion {
  versionId: string;
  versionNo: number;
  status: BookVersionStatus;
  /** 'hotel' = a legacy single-hotel version (Book now shows it read-only and points to the hotel panel). */
  serviceType: 'hotel' | 'package';
  confirmedAt: string | null;
  rowVersion: number;
  contentHash: string;
  /** When and by whom the draft was last saved, when the database sent it. */
  savedAt: string | null;
  savedByName: string | null;
  revisesVersionId: string | null;
  revisesVersionNo: number | null;
  changeClass: ChangeClass | null;
  changedFields: string[];
  /** Revision drafts (0300): the change classes the current changes allow; null when unknown. */
  allowedClasses: ChangeClass[] | null;
}

/**
 * The single read behind /app/deals/[id]/book and /book/[step] (landing, all
 * steps, the submitted read-only view and the revision). null = not visible:
 * missing Deal, not the viewer's, or a role that does not edit or accept the
 * booking (Purchase, Flight, the desk, Accounts) — the same answer.
 */
export interface BookNowView {
  dealId: string;
  dealReference: string;
  dealTitle: string;
  /** Bitrix stage as synced; null for synthetic or CRM-native Deals. */
  stage: { stageId: string; label: string | null; isTriggerStage: boolean } | null;
  /** Lost or rejected in Bitrix: new work stops; records stay readable. */
  dealNotActive: boolean;
  serviceItemsEnabled: boolean;
  visaPassportTasksEnabled: boolean;
  gate: BookingPanelView['gate'];
  /** The working version: the open draft (first or revision), else the accepted one; null = not started. */
  version: BookNowVersion | null;
  /** Database rights (booking_form_get) combined with the version state. */
  canEdit: boolean;
  /** May edit the selling price and plan (commercial editor; booking_form_get.canEditCommercials). */
  canEditCommercials: boolean;
  canSubmit: boolean;
  submitBlockedReason: string | null;
  openBlockedReason: string | null;
  canOpenRevision: boolean;
  accountsReview: BookingAccountsReview | null;
  trip: BookingTrip;
  contacts: BookingContactView | null;
  billing: BookingBillingView;
  travellers: BookTravellerView[];
  items: BookServiceItemView[];
  /** Commercial readers only (absent otherwise). */
  commercials?: BookingCommercials;
  /** Commercial readers only (absent otherwise). Ordered by seq. */
  plan?: PlanInstalment[];
  /** Sales claims projection (finance deal_payment_claims); absent when not available to the viewer or not installed. */
  claims?: import('@/modules/finance/contracts').SalesPaymentClaims;
  evidence: EvidenceItemView[];
  evidenceVisible: boolean;
  checklist: BookChecklistItem[];
  /**
   * B1.2 (0100, D2-3): show Attach and Remove for identity proofs. Booking
   * editor, switch on, Deal active; stays true after submission (when canEdit
   * is false). false on a database without it.
   */
  idProofCanEdit: boolean;
  /**
   * B1.2 (0100, D3): show Remove for identity proofs. Booking editor and the
   * Deal not removed by the sync; stays true with the switch off, on a lost
   * Deal and after submission. false on a database without it, and on a
   * sync-removed Deal (whose travellers carry no idProofs at all).
   */
  idProofCanRemove: boolean;
  /** B1.2 (0100): identity-proof limits from booking_form_get; null on a database without 0100. */
  idProofLimits: IdProofLimits | null;
  stepStatus: Record<BookStep, BookStepStatus>;
  /** B1.2: the marker of each section (a step is the worst of its sections). */
  sectionStatus: Record<BookSection, BookStepStatus>;
  progress: DealProgress;
  /** booking_version_history (absent on a database without the revision migration). */
  history?: BookingVersionHistoryEntry[];
  /**
   * B1.2: this booking version was started from an accepted quotation; the
   * customer's written acceptance of that quotation version stands as the
   * booking's acceptance (no booking evidence copy). Absent when not from a
   * quotation, not visible, or on a database without quotations.
   */
  quotationSource?: BookingQuotationSource;
  /**
   * B1.2 (0600): Bitrix values for "Use Bitrix values" (DEC-36). Absent on a
   * database without 0600; `available` false while the Bitrix read switch is
   * off or nothing was read yet.
   */
  prefill?: PrefillView;
}

/** Where a converted booking version came from (Book now review and submitted views). */
export interface BookingQuotationSource {
  quotationId: string;
  /** 'TQ-12' */
  reference: string;
  versionId: string;
  versionNo: number;
  acceptedAt: string | null;
  acceptedTierKey: 'quoted' | 'upgrade' | null;
  /** Audited download of the stored written acceptance (/app/quotations/evidence/{id}); null when none is stored or visible. */
  acceptanceHref: string | null;
}

export const BOOK_NOW_TEXT = {
  notAvailable: 'This booking is not available to you. It may not exist, or you may not have access.',
  savedNothingBooked: 'Saved. Nothing has been booked or paid.',
  // B0-04 (BF A.1)
  submitWaitsForWon: 'Waiting for Won - Payment Received in Bitrix. You can keep preparing.',
  // DA-289
  lockedNote: 'Submitted details are locked. To change them, Accounts must return the booking; then use Fix and send again.',
  sellingTotalCallout: 'One selling total for the whole booking (one bill). Purchase, Flight and the Visa & Passport desk never see it.',
  identityCallout: 'Private identity details: visible only to Sales on this deal, the branch Manager, and the assigned Flight or Visa & Passport colleague.',
  domesticNoIdentity: 'No date of birth, passport or ID document is asked for this booking.',
  visaWaitingCallout: 'Recorded now. While the Visa & Passport desk is not launched, this service waits and still counts as outstanding.',
  submitCallout: 'Submitting freezes this accepted version and creates one task per service, once. It does not book anything or approve spending.',
  billingVerifiedNote: 'Accounts verified these billing details. Ask Accounts to change them.',
  // B0-16
  notInstalled: 'Booking is not switched on here yet.',
  // G-09
  conflict: 'Not saved: {name} changed this at {time}. What you typed is still here. Copy what you need, then load the latest version.',
  conflictUnknown: 'Not saved. Someone saved this draft after you opened it. Your typed values are still on screen; copy what you need, then load the latest draft.',
  // B1.2 three steps (freeze note §2.1)
  unsavedInSections: 'You have unsaved changes in: {sections}. Save or undo them first.',
  sectionSaveReport: 'Saved: {saved}. Not saved: {refused}. Not tried: {skipped}.',
  noHotelYet: 'No hotel yet. Add a hotel, or continue if this booking has no hotel.',
  /** {reference} {versionNo} {date}: the booking came from an accepted quotation. */
  // BR-09
  acceptanceFromQuotation: 'Customer said yes to quotation {reference}, version {versionNo}, on {date}.',
  acceptanceFromQuotationFile: 'Open the written OK',
  identityAskedLater: 'Passport details are asked in step 3.',
} as const;

export const BOOK_SUBMIT_DIALOG_TEXT = {
  title: 'Submit this booking and create tasks?',
  body: [
    'This freezes version {versionNo} as the accepted version. It can only change if Accounts returns it.',
    'It creates {taskCount} internal {taskNoun}: one per sold service, once.',
    'It does not book anything, pay anyone, contact the customer, raise an invoice or change Bitrix.',
  ],
  confirmLabel: 'Submit booking and create tasks',
  cancelLabel: 'Go back',
} as const;

// ---------------------------------------------------------------------------
// Traveller identity proof (B1.2 freeze note §2.2, owner correction of 12
// October 2026, DEC-38 … DEC-42; migration 20261120000100). Files only
// (Aadhaar card or another ID, e.g. front and back) per traveller: no typed
// ID number anywhere, no extraction, never sent to an external service.
// Required for every adult (blocking id_proof_missing), a warning for
// children and infants (id_proof_missing_child). Each upload needs the
// customer-consent tick. Never hashed; never bumps the booking version's row
// version; allowed after submission; kept indefinitely. Viewers: staff linked
// to the Deal's booking (Sales owner/assignee, branch Manager, Accounts, the
// assignees of its service tasks); every view audited. Writers: booking editors.
// ---------------------------------------------------------------------------

export const ID_PROOF_BUCKET = 'traveller-id-proofs';
export const ID_PROOF_MAX_FILES_PER_TRAVELLER = 4;
/** 4 MiB per file (the server-action body limit is 5 MB). */
export const ID_PROOF_MAX_BYTES = 4 * 1024 * 1024;

export type IdProofStatus = 'pending_upload' | 'stored' | 'failed';
export const ID_PROOF_STATUSES = ['pending_upload', 'stored', 'failed'] as const satisfies readonly IdProofStatus[];
export const ID_PROOF_STATUS_LABEL: Record<IdProofStatus, string> = {
  pending_upload: 'Uploading',
  stored: 'Attached',
  failed: 'Upload failed: remove it and upload again',
};

/** One live identity-proof file of one traveller (removed files are never listed). */
export interface TravellerIdProofView {
  fileId: string;
  /** Stored, sanitised name ([A-Za-z0-9._ -], at most 120 characters). */
  fileName: string;
  mime: EvidenceMime;
  sizeBytes: number;
  /** e.g. "1.2 MB" */
  sizeLabel: string;
  status: IdProofStatus;
  /** Expected row version for traveller_id_proof_remove (the file's own, not the booking version's). */
  rowVersion: number;
  uploadedByName: string | null;
  uploadedByYou: boolean;
  uploadedAt: string;
  storedAt: string | null;
  /** DEC-39: who ticked the customer-consent box, and when. */
  consentByName: string | null;
  consentAt: string;
  /** Audited download route; null until the file is stored. */
  downloadHref: string | null;
  /**
   * DEC-43: copy of this proof to the linked Bitrix Deal. Absent when no copy
   * was queued (copy switched off, proof stored before it was on, a Deal not
   * imported from Bitrix) or on a database without the copy.
   */
  bitrixCopy?: IdProofCopyView;
}

// ---------------------------------------------------------------------------
// DEC-43 copy of ID proofs to the Bitrix Deal (migration 0700): status per
// file, "Try again", and the Super Admin's automatic-stop alerts. Codes only:
// never file content, file names or Bitrix answers.
// ---------------------------------------------------------------------------

export const ID_PROOF_COPY_STATUSES = ['pending', 'unknown', 'sent', 'failed', 'cancelled', 'needs_manual_check'] as const;
export type IdProofCopyStatus = (typeof ID_PROOF_COPY_STATUSES)[number];

export const ID_PROOF_COPY_STATUS_TEXT: Record<IdProofCopyStatus, string> = {
  pending: 'Waiting to be copied to the Bitrix deal.',
  unknown: 'Bitrix did not answer clearly. The CRM checks the Bitrix deal before it tries again, so nothing is copied twice.',
  sent: 'Copied to the Bitrix deal.',
  failed: 'Not copied to the Bitrix deal.',
  cancelled: 'Not copied: the proof was removed, or the deal left the Bitrix sync before it was sent.',
  needs_manual_check: 'The CRM could not tell five times in a row whether the file reached the Bitrix deal, so it stopped trying. The Super Admin checks the deal in Bitrix and tries again.',
};

/** BI-08: short status chips for staff on the booking; the full ID_PROOF_COPY_STATUS_TEXT stays for the Super Admin (Bitrix connection → ID-proof copies). */
export const ID_PROOF_COPY_CHIP_TEXT: Record<IdProofCopyStatus, string> = {
  pending: 'Copying to Bitrix',
  unknown: 'Copying to Bitrix',
  sent: 'Copied to Bitrix',
  failed: 'Not copied to Bitrix',
  cancelled: 'Not copied to Bitrix',
  needs_manual_check: 'Needs an admin check',
};

/** Why a copy is not done yet (job codes, worker codes). Unknown codes fall back by prefix, then to a general line. */
export const ID_PROOF_COPY_REASON_TEXT: Record<string, string> = {
  prior_files_lost: 'Files that were on the Bitrix deal before are gone. Copying stopped for safety; the Super Admin must check Bitrix first.',
  bitrix_auth_failed: 'Bitrix refused the CRM’s sign-in for copying. The Super Admin must check the Bitrix connection.',
  rate_limited: 'Bitrix asked the CRM to slow down. It tries again on its own.',
  deal_not_found: 'The Bitrix deal could not be found.',
  file_unavailable: 'The stored proof could not be read. It tries again on its own.',
  file_changed: 'The stored proof no longer matches the uploaded file. Upload it again.',
  file_facts_unavailable: 'A new file is on the Bitrix deal, but the CRM could not open it to confirm it is this proof. The CRM checks again and never sends it twice.',
  new_file_not_matched: 'A new file is on the Bitrix deal, but its content did not match this proof (it may be another upload, or Bitrix sent something else). The CRM will not send it again. The Super Admin should open the Bitrix deal and check; if this proof is not there, add it in Bitrix by hand, because Try again only checks again.',
  not_found_on_read_back: 'The file was not on the Bitrix deal after the last try. It tries again.',
  not_visible_after_send: 'The file was sent, but Bitrix did not show it yet. The CRM checks again.',
  read_back_not_found: 'The Bitrix deal could not be read after sending. The CRM checks again.',
  read_back_failed: 'The Bitrix deal could not be read after sending. The CRM checks again.',
  answer_unexpected: 'Bitrix gave an unexpected answer. The CRM checks the deal before trying again.',
  bitrix_refused: 'Bitrix refused the file.',
  body_invalid: 'The copy was stopped before sending because the deal field did not look as expected.',
  bitrix_target_invalid: 'The Bitrix deal field for ID proofs is not set up as expected. The Super Admin must check it.',
  write_credential_missing: 'The Bitrix connection for copying is not set up.',
  config_unavailable: 'The copy settings could not be read. It tries again on its own.',
};
const ID_PROOF_COPY_REASON_PREFIX_TEXT: Record<string, string> = {
  read_: 'The Bitrix deal could not be read. It tries again on its own.',
  answer_: 'Bitrix did not answer clearly. The CRM checks the Bitrix deal before it tries again.',
};
const ID_PROOF_COPY_REASON_FALLBACK = 'The copy did not finish. Try again, or ask the Super Admin.';

/** Plain words for a job's last code; null when there is none. Never echoes the code itself. */
export function idProofCopyReasonText(code: string | null): string | null {
  if (!code) return null;
  if (Object.hasOwn(ID_PROOF_COPY_REASON_TEXT, code)) return ID_PROOF_COPY_REASON_TEXT[code]!;
  const prefix = Object.keys(ID_PROOF_COPY_REASON_PREFIX_TEXT).find((p) => code.startsWith(p));
  return prefix ? ID_PROOF_COPY_REASON_PREFIX_TEXT[prefix]! : ID_PROOF_COPY_REASON_FALLBACK;
}

/** Codes only the Super Admin may retry (the database refuses others; review E7-1/E7-8). */
export const ID_PROOF_COPY_SUPER_ADMIN_CODES = ['prior_files_lost', 'bitrix_auth_failed'] as const;
/** Statuses "Try again" applies to; needs_manual_check is the Super Admin's only (review E8-2). */
export const ID_PROOF_COPY_RETRYABLE: readonly IdProofCopyStatus[] = ['failed', 'unknown', 'needs_manual_check'];

export interface IdProofCopyView {
  jobId: string;
  status: IdProofCopyStatus;
  statusText: string;
  /** Plain words for the last code; null when none. */
  reasonText: string | null;
  attempts: number;
  maxAttempts: number;
  updatedAt: string;
  sentAt: string | null;
  /** "Try again" offered to this booking editor (failed or unknown, and not a Super Admin case). */
  canRetry: boolean;
  /** Failed or unknown, but only the Super Admin may retry (show ID_PROOF_COPY_TEXT.askSuperAdmin). */
  retryNeedsSuperAdmin: boolean;
}

/** An automatic stop of the copy (files on a Bitrix Deal went missing). */
export interface IdProofCopyAlertView {
  stopId: string;
  jobId: string;
  /** Bitrix Deal number (for finding it in Bitrix). */
  bitrixDealId: string;
  reasonText: string;
  openedAt: string;
  acknowledgedAt: string | null;
  open: boolean;
}

/** A copy that ended needs_manual_check (review E8-2): the Super Admin checks Bitrix, then "Try again". */
export interface IdProofCopyManualCheckView {
  jobId: string;
  bitrixDealId: string;
  /** Plain words for the last code; null when none. */
  reasonText: string | null;
  readBackAttempts: number;
  updatedAt: string;
  statusText: string;
}

export interface IdProofCopyAlertsView {
  stops: IdProofCopyAlertView[];
  manualChecks: IdProofCopyManualCheckView[];
}

export const ID_PROOF_COPY_TEXT = {
  title: 'Bitrix copy', // DA-284
  retry: 'Try again',
  retried: 'The copy will be tried again shortly. Nothing else changed.',
  retriedChecking: 'The CRM will check the Bitrix deal first, then copy only if the file is not there.',
  askSuperAdmin: 'Only the Super Admin can try this copy again.',
  switchOff: 'Copying to Bitrix is switched off. The Super Admin switches it on again after checking Bitrix.',
  alertsTitle: 'Bitrix copy stopped',
  /** Super Admin: what to do with an open alert. */
  alertsHelp: 'Copying stopped on its own because files on a Bitrix deal went missing. Check that Deal in Bitrix, then switch copying on again with a reason.',
  noAlerts: 'No automatic stops.',
  manualChecksTitle: 'Copies to check by hand',
  manualChecksHelp: 'Open the Bitrix deal and look at the "Aadhar and Passports" field. Then press Try again: the CRM reads the deal first and sends the file only if it is not there.',
  noManualChecks: 'Nothing to check by hand.',
} as const;

export interface TravellerIdProofUploadResult {
  fileId: string;
  travellerSeq: number;
  status: IdProofStatus;
}
export interface TravellerIdProofRemoveResult {
  fileId: string;
  status: 'removed';
  rowVersion: number;
}

export const ID_PROOF_TEXT = {
  // BI-01
  callout: 'Attach a photo or PDF of an ID for each adult (Aadhaar or another ID). Do not type ID numbers.',
  uploaded: 'Identity proof attached. Only the people who need it can open it.',
  alreadyUploaded: 'This file was already attached.',
  removed: 'Identity proof removed for this traveller.',
  rejected: 'File not accepted: PDF, JPG, PNG or WebP up to 4 MB.',
  limit: 'This traveller already has 4 identity-proof files. Remove one first.',
  travellerChanged: 'This traveller was changed or removed after the page loaded. Nothing was uploaded. Reload the page and attach the file again.',
  stillUploading: 'This file is still uploading from your earlier click. Reload the page in a moment to see it.',
  dealRemoved: 'This Deal was removed in Bitrix; files can’t be changed.',
  /** D3-3: after a passengers save, for a traveller whose name changed (the database detaches its proofs). {name} = the new name. */
  detachedOnRename: 'ID proof removed because the name changed — attach it again for {name}.',
  consentLabel: 'Customer agreed to share this ID for this booking',
  // BI-04
  consentRequired: 'Tick the customer’s agreement first. Nothing was uploaded.',
} as const;

/** One traveller of a department task with its stored identity proofs (traveller_id_proofs_for_task). */
export interface TaskTravellerIdProofs {
  seq: number;
  fullName: string;
  type: TravellerType;
  /** Stored files only, oldest first. */
  idProofs: TaskIdProofFileView[];
}
export interface TaskIdProofFileView {
  fileId: string;
  fileName: string;
  mime: EvidenceMime;
  sizeLabel: string;
  storedAt: string;
  /** Audited download (idProofDownloadHref). */
  downloadHref: string;
}
/** "Traveller ID proofs" on a Purchase, Flight or Visa & Passport task (assignees and Managers; never money). */
export interface TaskIdProofsView {
  taskId: string;
  travellers: TaskTravellerIdProofs[];
}
/** "Traveller ID proofs" of a whole Deal (Accounts deal screen and any other DEC-41 viewer; stored files only). */
export interface DealIdProofsView {
  dealId: string;
  travellers: TaskTravellerIdProofs[];
}

/** booking_form_get.idProofLimits: maxBytes comes from the database setting (at most 4 MiB). */
export interface IdProofLimits {
  maxFilesPerTraveller: number;
  maxBytes: number;
}

/**
 * /app/id-proofs/{fileId}: one audited download route for every allowed
 * viewer (booking editors, Accounts and the Deal's task assignees), outside
 * /book so department screens can link it. Route file owned by the UI agent;
 * handler idProofDownloadResponse.
 */
export function idProofDownloadHref(fileId: string): string {
  return `/app/id-proofs/${fileId}`;
}

// ---------------------------------------------------------------------------
// Visa & Passport desk (appendix A §3)
// ---------------------------------------------------------------------------

export type VisaApplicationState = 'docs_pending' | 'submitted' | 'decision_pending' | 'issued' | 'refused' | 'withdrawn';
export const VISA_APPLICATION_STATES = [
  'docs_pending',
  'submitted',
  'decision_pending',
  'issued',
  'refused',
  'withdrawn',
] as const satisfies readonly VisaApplicationState[];
export const VISA_APPLICATION_STATE_LABEL: Record<VisaApplicationState, string> = {
  docs_pending: 'Documents pending',
  submitted: 'Submitted (reference recorded)',
  decision_pending: 'Waiting for decision',
  issued: 'Issued',
  refused: 'Refused',
  withdrawn: 'Withdrawn',
};

/** p_state of visa_application_set_state. documents_returned / customer_informed set dates; the state stays. */
export type VisaStateCommand = 'submitted' | 'decision_pending' | 'issued' | 'refused' | 'withdrawn' | 'documents_returned' | 'customer_informed';
export const VISA_STATE_COMMANDS = [
  'submitted',
  'decision_pending',
  'issued',
  'refused',
  'withdrawn',
  'documents_returned',
  'customer_informed',
] as const satisfies readonly VisaStateCommand[];

export type VisaDocumentStatus = 'missing' | 'received' | 'checked';
export const VISA_DOCUMENT_STATUSES = ['missing', 'received', 'checked'] as const satisfies readonly VisaDocumentStatus[];
export const VISA_DOCUMENT_STATUS_LABEL: Record<VisaDocumentStatus, string> = {
  missing: 'Missing',
  received: 'Received',
  checked: 'Checked',
};
/** Document codes are free text (≤ 40 characters, ≤ 30 per applicant). */
export const VISA_DOCUMENT_LIMITS = { codeMax: 40, maxEntries: 30, codePattern: /^[a-z0-9_]{1,40}$/ } as const;
export const VISA_APPLICATION_LIMITS = { reference: 120, appointmentPlace: 200 } as const;

export interface VisaDocumentView {
  code: string;
  label: string;
  status: VisaDocumentStatus;
}

export type DepartmentEvidenceKind = 'applicant_document' | 'fee_receipt' | 'authority_outcome' | 'direct_payment_proof' | 'other';
export const DEPARTMENT_EVIDENCE_KINDS = [
  'applicant_document',
  'fee_receipt',
  'authority_outcome',
  'direct_payment_proof',
  'other',
] as const satisfies readonly DepartmentEvidenceKind[];
export const DEPARTMENT_EVIDENCE_KIND_LABEL: Record<DepartmentEvidenceKind, string> = {
  applicant_document: 'Applicant document',
  fee_receipt: 'Fee receipt',
  authority_outcome: 'Authority outcome document',
  direct_payment_proof: 'Direct payment proof',
  other: 'Other file',
};
export const DEPARTMENT_EVIDENCE_BUCKET = 'department-evidence';

export interface DepartmentEvidenceView {
  id: string;
  kind: DepartmentEvidenceKind;
  applicationId: string | null;
  fileName: string;
  sizeLabel: string;
  status: EvidenceStatus;
  uploadedByYou: boolean;
  uploadedAt: string;
}

export interface VisaApplicantView {
  /** null until the task is taken (the claim opens one application per applicant). */
  applicationId: string | null;
  travellerSeq: number;
  /** Falls back to "Traveller <seq>" when the snapshot has no name. */
  fullName: string;
  type: TravellerType | null;
  ageYears: number | null;
  /** Assignee only (database rule). */
  identity?: TravellerIdentity | null;
  documents: VisaDocumentView[];
  /** null until the task is taken. */
  state: VisaApplicationState | null;
  reference: string | null;
  appointmentAt: string | null;
  appointmentPlace: string | null;
  submittedAt: string | null;
  outcomeAt: string | null;
  customerInformedAt: string | null;
  documentsReturnedAt: string | null;
  documentsReturnedByName: string | null;
  /** Issued and returned, or refused/withdrawn and the customer informed. */
  closed: boolean;
  /** null until the task is taken. */
  rowVersion: number | null;
}

export interface VisaTaskSummary {
  taskId: string;
  dealReference: string;
  serviceType: 'visa' | 'passport';
  itemTitle: string;
  facts: VisaServiceFacts | PassportServiceFacts;
  status: DepartmentTaskStatus;
  assigneeName: string | null;
  assignedToYou: boolean;
  branchName: string;
  createdAt: string;
  completedAt: string | null;
  /** Number of applicants (participants of the item). */
  applicantCount: number | null;
}

/** visa_task_get. Never price, plan, claims, contacts or billing. */
export interface VisaTaskView extends VisaTaskSummary {
  versionNo: number;
  confirmedAt: string;
  canClaim: boolean;
  /** Derived: the viewer holds the task and it is in progress. */
  canWork: boolean;
  applicants: VisaApplicantView[];
  evidence: DepartmentEvidenceView[];
  costs: DepartmentCostView[];
}

export interface VisaQueueView {
  /**
   * visa_passport_tasks_enabled as read (Batch 4, lead ruling: three states). 'unknown' = the
   * switch could not be read; never shown as "Not launched yet" (that is 'off' only).
   */
  launch: SwitchState;
  /** Sold visa/passport services waiting for the launch, when known (null otherwise). */
  waitingCount: number | null;
  tasks: VisaTaskSummary[];
}

export const VISA_TASK_STATUS_LABEL: Record<DepartmentTaskStatus, string> = {
  // DA-271 (supplier_confirmed is not used by the desk; its word is unchanged)
  not_started: 'Waiting to be taken',
  in_progress: 'In progress',
  supplier_confirmed: 'Confirmed',
  completed: 'Completed',
};

export const VISA_TEXT = {
  // V-01
  notLaunched: 'The Visa desk is not started yet. Tasks appear once it is switched on.',
  /** Batch 4 (DA-255 pattern): the desk switch could not be read; never shown as "not started". */
  launchUnknown: 'The CRM could not read whether the Visa desk is switched on, so it shows as Unknown. Unknown is not Off. Tasks already made are listed below. Reload the page; if it stays Unknown, tell your admin.', // DA-285
  privateDocuments: 'Private applicant documents: Visa & Passport desk and branch Manager only.',
  outcomeNeedsDocument: 'A fee receipt or reference never proves issue. Upload the authority’s outcome document.',
  notVisible: 'This task is not available to you. It may not exist, or you may not have access.',
} as const;

/** visa_application_update / visa_application_set_state result. */
export interface VisaApplicationResult {
  applicationId: string;
  rowVersion: number;
  state: VisaApplicationState;
  /** True when this change completed the task (every applicant closed). */
  taskCompleted: boolean;
}

export interface VisaApplicationFields {
  documents?: Record<string, VisaDocumentStatus>;
  reference?: string | null;
  appointmentAt?: string | null;
  appointmentPlace?: string | null;
}

// ---------------------------------------------------------------------------
// Department work forms and cost entries (expense records), appendix A §3
// ---------------------------------------------------------------------------

export type WorkFormDepartment = 'purchase' | 'flight' | 'visa';
export type CostKind = 'government_fee' | 'service_fee' | 'fare' | 'other';
export const COST_KINDS = ['government_fee', 'service_fee', 'fare', 'other'] as const satisfies readonly CostKind[];
export const COST_KIND_LABEL: Record<CostKind, string> = {
  government_fee: 'Government fee',
  service_fee: 'Service fee',
  fare: 'Fare',
  other: 'Other cost',
};

export type CostPaidBy = 'company' | 'customer_direct' | 'not_yet';
export const COST_PAID_BY = ['company', 'customer_direct', 'not_yet'] as const satisfies readonly CostPaidBy[];
export const COST_PAID_BY_LABEL: Record<CostPaidBy, string> = {
  company: 'Company',
  customer_direct: 'Customer directly',
  not_yet: 'Not yet',
};

export type CostPaymentMode = 'bank_transfer' | 'upi' | 'card' | 'cash' | 'other';
export const COST_PAYMENT_MODES = ['bank_transfer', 'upi', 'card', 'cash', 'other'] as const satisfies readonly CostPaymentMode[];
export const COST_PAYMENT_MODE_LABEL: Record<CostPaymentMode, string> = {
  bank_transfer: 'Bank transfer',
  upi: 'UPI',
  card: 'Card',
  cash: 'Cash',
  other: 'Other',
};

/** Expense record status: only for company-paid costs; null otherwise. Reviewer ≠ submitter. */
export type ExpenseStatus = 'draft' | 'submitted' | 'accepted' | 'returned';
export const EXPENSE_STATUSES = ['draft', 'submitted', 'accepted', 'returned'] as const satisfies readonly ExpenseStatus[];
export const EXPENSE_STATUS_LABEL: Record<ExpenseStatus, string> = {
  draft: 'Draft',
  submitted: 'Sent to Accounts',
  // A-21
  accepted: 'Accepted (recorded only; not approved for payment)',
  returned: 'Returned by Accounts',
};

/** DEC-21: Flight direct company payment up to ₹50,000 per purchase. */
export const FLIGHT_DIRECT_PAYMENT_LIMIT_PAISE = '5000000';

/** One cost entry of a department task (department_cost_entries). Never a selling value. */
export interface DepartmentCostView {
  entryId: string;
  taskId: string;
  department: WorkFormDepartment;
  costKind: CostKind;
  amountPaise: string;
  paidBy: CostPaidBy;
  paymentMode: CostPaymentMode | null;
  paidOn: string | null;
  reference: string | null;
  expenseStatus: ExpenseStatus | null;
  returnReason: string | null;
  /** The stored fee receipt / direct-payment proof this cost points to (needed before sending to Accounts). */
  receiptEvidenceId: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  rowVersion: number;
  /** Derived: draft or returned (or no expense status) and the viewer works the task. */
  canEdit: boolean;
  /** Derived: company-paid, draft or returned, viewer works the task. */
  canSubmit: boolean;
}

/** department_work_form(p_task_id): one shape for Purchase, Flight and the desk. */
export interface DepartmentWorkFormView {
  taskId: string;
  department: WorkFormDepartment;
  /** Step codes: taken, submitted, issued/refused/withdrawn, customer_informed, documents_returned, completed. seq = applicant. */
  steps: Array<{ code: string; at: string | null; byName: string | null; seq: number | null }>;
  references: Array<{ kind: string; value: string; seq: number | null }>;
  documents: DepartmentEvidenceView[];
  costs: DepartmentCostView[];
  /** Purchase: read-only placeholder in B1.1 (costs come with B2/B3). */
  readOnlyReason: string | null;
  canRecordCost: boolean;
  /** Flight only: the direct-payment limit (DEC-21). */
  directLimitPaise: string | null;
}

export interface DepartmentCostFields {
  costKind: CostKind;
  amountPaise: string;
  paidBy: CostPaidBy;
  paymentMode: CostPaymentMode | null;
  paidOn: string | null;
  reference: string | null;
  /** A stored fee_receipt / direct_payment_proof of this task (required before submit for company-paid fees and fares). */
  receiptEvidenceId: string | null;
}

export interface DepartmentCostSaveResult {
  entryId: string;
  rowVersion: number;
  expenseStatus: ExpenseStatus | null;
}

export const DEPARTMENT_COST_TEXT = {
  // P-05, F-01 (§14 #7: no batch codes)
  purchasePlaceholder: 'Costs are recorded in the supplier work.',
  flightOverLimit: 'Company can pay directly up to ₹50,000 per purchase. Above that, choose “Not yet”: it goes through a supplier payment request.',
  companyFeeNote: 'This is an expense record for Accounts review. It does not approve or make a payment.',
  sentToAccounts: 'Sent to Accounts. A different Accounts person reviews it. This is not a payment approval.',
} as const;

// ---------------------------------------------------------------------------
// B1.2 Bitrix prefill (0600, DEC-36): "Use Bitrix values" per field on Book
// now and on a quotation. Values come from the database snapshot only, never
// from the browser. Booking Notes are shown for reference (copied into a
// quotation's requirements note only on request). Customer Type is shown as
// its code; DEC-45: any known type fills "booking for: business" on request
// (field contacts.bookingFor). A contact filled from Bitrix
// stays unconfirmed. prefill_unchecked is a warning, never a blocker.
// ---------------------------------------------------------------------------

export const BOOKING_PREFILL_FIELDS = ['trip.start', 'trip.end', 'contacts.contactName', 'contacts.mobile', 'contacts.email', 'contacts.bookingFor'] as const;
export const QUOTATION_PREFILL_FIELDS = [
  'trip.start',
  'trip.end',
  'requirementsNote',
  'contacts.contactName',
  'contacts.mobile',
  'contacts.email',
  'contacts.companyName',
  'contacts.bookingFor',
] as const;
export type BookingPrefillField = (typeof BOOKING_PREFILL_FIELDS)[number];
/** Every field code (the quotation list is the superset). */
export type PrefillFieldCode = (typeof QUOTATION_PREFILL_FIELDS)[number];
export const PREFILL_TARGET_KINDS = ['booking_version', 'quotation_version'] as const;
export type PrefillTargetKind = (typeof PREFILL_TARGET_KINDS)[number];
/**
 * from_bitrix: applied, not yet checked · checked: staff confirmed · changed: edited afterwards (no longer from Bitrix).
 * Batch 2 (migration 20261122000100, switch prefill_auto_fill on): kept = a section save left the Bitrix value
 * unchanged (saved by staff, not checked; still counts for the prefill_unchecked warning) · replaced_by_quotation =
 * an untouched automatic value replaced by accepted quotation facts on conversion. Readers drop any other state.
 */
export const PREFILL_MARK_STATES = ['from_bitrix', 'kept', 'checked', 'changed', 'replaced_by_quotation'] as const;
export type PrefillMarkState = (typeof PREFILL_MARK_STATES)[number];
/** Batch 2 adds cleared_by_staff, not_provable, accepted_quotation and fill_failed (Atlas shapes §4). Readers drop any other reason. */
export const PREFILL_SKIP_REASONS = [
  'no_value',
  'date_order',
  'mobile_format',
  'contact_name_missing',
  'contact_needs_mobile_or_email',
  'not_allowed',
  'cleared_by_staff',
  'not_provable',
  'accepted_quotation',
  'fill_failed',
] as const;
export type PrefillSkipReason = (typeof PREFILL_SKIP_REASONS)[number];
export const PREFILL_CUSTOMER_TYPES = ['b2d', 'corporate', 'travel_agent'] as const;
export type PrefillCustomerType = (typeof PREFILL_CUSTOMER_TYPES)[number];

/** The snapshot values as the database returns them (booking_form_get / quotation_get `prefill.fields`). */
export interface PrefillValues {
  bookingNotes: string | null;
  travellerTotal: number | null;
  tourStart: string | null;
  tourEnd: string | null;
  /** null code = an option the CRM does not know. */
  customerType: { code: PrefillCustomerType | null } | null;
  contact: { name: string | null; mobile: string | null; email: string | null } | null;
  company: { name: string | null; phone: string | null; email: string | null } | null;
}

export interface PrefillMark {
  fieldCode: PrefillFieldCode;
  state: PrefillMarkState;
  appliedAt: string;
  checkedAt: string | null;
}

/** One field row of the "From Bitrix" panel. */
export interface PrefillFieldView {
  field: PrefillFieldCode;
  label: string;
  /** What Bitrix has, as display text (dates as ISO yyyy-mm-dd); null = Bitrix has nothing. */
  bitrixValue: string | null;
  /** The mark on the working version; null = never filled from Bitrix. */
  state: PrefillMarkState | null;
  stateText: string | null;
  /** "Use Bitrix value" offered: available, editable and Bitrix has a value. */
  canUse: boolean;
  /** "Mark checked" offered: the field is still marked from Bitrix. */
  canMarkChecked: boolean;
}

export interface PrefillView {
  available: boolean;
  /** Bitrix's own last-modified time of the Deal or Lead. */
  sourceModifiedAt: string | null;
  /** When the CRM last read it. */
  lastVerifiedAt: string | null;
  /** Read issue codes from the Bitrix read, as given (shown as a general notice). */
  issues: string[];
  /** Booking Notes (reference only on Book now); null when hidden or empty. */
  bookingNotes: string | null;
  /** Atlas E5-3: Booking Notes are withheld from viewers without commercial scope (show "hidden", not "empty"). */
  notesHidden: boolean;
  travellerTotal: number | null;
  customerType: PrefillCustomerType | null;
  customerTypeLabel: string | null;
  fields: PrefillFieldView[];
  /** Field codes still marked from Bitrix or kept (the prefill_unchecked warning). */
  unchecked: PrefillFieldCode[];
  /** Batch 2 (migration A): the switch, the creation fill run, "Fill empty fields" offer. Absent on an older database (panel mode). */
  autoFill?: import('./prefill-contract').PrefillAutoFillRead;
  /** Batch 2 (migration A): per-field state, touched/cleared flags and the "Bitrix now says" notice. */
  fieldStates?: import('./prefill-contract').PrefillFieldStateRead[];
}

export interface PrefillApplyResult {
  rowVersion: number;
  /** Booking only. */
  contentHash?: string | null;
  applied: PrefillFieldCode[];
  skipped: Array<{ field: PrefillFieldCode; reason: PrefillSkipReason }>;
}

export interface PrefillCheckedResult {
  checked: PrefillFieldCode[];
  /** Batch 2 (migration A): requested fields that were not upgraded (changed, replaced_by_quotation, already checked; null = no mark). Absent on an older database. */
  notChecked?: Array<{ field: PrefillFieldCode; state: PrefillMarkState | null }> | undefined;
}

/** Result of usePrefillAction / markPrefillCheckedAction (booking or quotation target). */
export type PrefillActionResult<T> =
  | { ok: true; data: T; message: string }
  | {
      ok: false;
      code: BookingErrorCode | import('@/modules/quotations/contracts').QuotationErrorCode | 'session' | 'upload_failed';
      message: string;
      fields?: string[];
    };

export const PREFILL_FIELD_LABEL: Record<PrefillFieldCode, string> = {
  'trip.start': 'Trip start date',
  'trip.end': 'Trip end date',
  // BP-13
  requirementsNote: 'Customer requests (from Bitrix booking notes)',
  'contacts.contactName': 'Contact name',
  'contacts.mobile': 'Contact mobile',
  'contacts.email': 'Contact email',
  'contacts.companyName': 'Company name',
  'contacts.bookingFor': 'Booking for',
};

export const PREFILL_MARK_STATE_TEXT: Record<PrefillMarkState, string> = {
  from_bitrix: 'From Bitrix, not checked yet',
  // DA-161: one wording per state, in the panel and the inline details.
  kept: 'From Bitrix, saved, not checked',
  checked: 'From Bitrix, checked',
  changed: 'Changed by staff after filling from Bitrix',
  replaced_by_quotation: 'Replaced by the accepted quotation',
};

export const PREFILL_SKIP_TEXT: Record<PrefillSkipReason, string> = {
  no_value: 'Bitrix has no usable value.',
  date_order: 'The end date would be before the start date.',
  mobile_format: 'The Bitrix mobile is not a 10-digit Indian mobile number.',
  contact_name_missing: 'A contact name is needed first.',
  contact_needs_mobile_or_email: 'A contact needs a mobile number or an email.',
  not_allowed: 'Only staff who can see the price can copy Booking Notes.',
  // DA-166 (shown after "{field} not filled:" or "{field}:").
  cleared_by_staff: 'Someone cleared it on purpose.',
  not_provable: 'The CRM cannot tell if someone cleared it on purpose. Type it in if needed.',
  accepted_quotation: 'The accepted quotation sets this value.',
  fill_failed: 'Bitrix details could not be filled. Type them in.',
};

export const PREFILL_CUSTOMER_TYPE_LABEL: Record<PrefillCustomerType, string> = {
  b2d: 'B2D',
  corporate: 'Corporate',
  travel_agent: 'Travel agent',
};

export const PREFILL_TEXT = {
  title: 'From Bitrix',
  use: 'Use Bitrix value',
  useAll: 'Use Bitrix values',
  markChecked: 'Mark checked',
  unavailable: 'Bitrix values are not available for this Deal yet. Type the details instead.',
  notesReference: 'Booking Notes from Bitrix, for reference. They are not copied into the booking.',
  notesHidden: 'Booking Notes from Bitrix are shown only to staff who can see the price.',
  /** DEC-45: any known Bitrix Customer Type means a business booking. */
  customerTypeNote: 'Bitrix has a Customer Type for this customer, so "Booking for" can be filled as a business. Check it before you continue.',
  contactUnconfirmed: 'A contact filled from Bitrix stays unconfirmed until you confirm it with the customer.',
  appliedNone: 'Nothing was filled from Bitrix.',
  /** {fields}: the applied field labels. */
  // DA-162 / DA-165: the same short result for Use it, Use Bitrix value(s) and Fill empty fields.
  applied: 'Filled from Bitrix: {fields}. Check them with the customer.',
  /** {fields}: the checked field labels. */
  checked: 'Marked as checked: {fields}.',
  checkedNone: 'Nothing to mark: those fields were already checked or changed.',
  /** {field}: label, {reason}: PREFILL_SKIP_TEXT. */
  skipped: '{field} not filled: {reason}',
} as const;

// ---------------------------------------------------------------------------
// B1.2 switches on the Workflow page (Super Admin; every one off by default).
// Each change goes through its audited database command with a reason
// (10-500 characters). Live use needs the owner's APPROVE.
// ---------------------------------------------------------------------------

export const B12_SWITCH_KEYS = ['bitrix_trip_facts_read', 'lead_intake_unowned', 'bitrix_id_proof_copy'] as const;
export type B12SwitchKey = (typeof B12_SWITCH_KEYS)[number];

export const B12_SWITCH_TEXT: Record<B12SwitchKey, { title: string; detail: string; onNote: string; offNote: string }> = {
  bitrix_trip_facts_read: {
    title: 'Read trip facts from Bitrix',
    // DA-174
    detail: 'Reads Booking Notes, traveller count, tour dates, Customer Type and the linked contact from Bitrix for bookings and quotations. Read only: nothing is written to Bitrix. “Fill new bookings and quotations from Bitrix” needs this switch on.',
    // S-12 / DA-257: "Staff still choose" is false while the fill switch is on.
    onNote: 'Reads Bitrix trip facts from now on. Nothing is written to Bitrix.',
    offNote: 'Bitrix trip facts are no longer read. Values already used stay as they are.',
  },
  lead_intake_unowned: {
    // S-13 / DA-257
    title: 'Bring in leads whose Bitrix owner is not a CRM salesperson',
    detail: 'Leads whose Bitrix owner is not a CRM salesperson come into the CRM and wait for an owner. Off: they are skipped.',
    onNote: 'Leads whose Bitrix owner is not a CRM salesperson now come in and wait for an owner.',
    offNote: 'New leads without a CRM salesperson are skipped again. Leads already in the CRM stay.',
  },
  bitrix_id_proof_copy: {
    // S-14 / DA-257
    title: 'Copy ID proofs to the Bitrix deal',
    detail: 'Adds each ID proof stored from now on to the “Aadhar and Passports” field of the linked Bitrix deal. It only adds files; it never deletes or replaces files in Bitrix. Proofs stored earlier are not copied. Switching on closes any open automatic stops, with your reason.',
    onNote: 'ID proofs stored from now on are copied to the Bitrix deal. Any open automatic stops are now closed with your reason.',
    offNote: 'Copying is off. Nothing more is sent to Bitrix; files already there stay.',
  },
};

export interface B12SwitchView {
  key: B12SwitchKey;
  title: string;
  detail: string;
  /** null = could not be read (show "unknown", never "off"). */
  on: boolean | null;
  /** bitrix_id_proof_copy only: open automatic stops that switching on will close. */
  openStops?: number;
}

/** A server setting shown for information only (changed in the hosting settings, not here). */
export interface B12ReadOnlySwitchView {
  key: 'pdf_render_online';
  title: string;
  detail: string;
  on: boolean;
  /** How it is changed (plain words). */
  howToChange: string;
}

export const B12_READ_ONLY_SWITCH_TEXT = {
  pdf_render_online: {
    // S-18 / DA-262
    title: 'Online PDF maker',
    detail: 'Makes itinerary and quotation PDFs on the server.',
    howToChange: 'Changed in the hosting settings with the owner’s approval, not here.',
  },
} as const;

export interface B12SwitchesView {
  switches: B12SwitchView[];
  /** DEC-49: PDF_RENDER_ONLINE (server setting; read only here). */
  readOnly: B12ReadOnlySwitchView[];
  /** The viewer is the Super Admin of the pilot company (the database decides again on every change). */
  canSwitch: boolean;
}

export interface B12SwitchResult {
  key: B12SwitchKey;
  changed: boolean;
  on: boolean;
  /** lead_intake_unowned switched on: Leads handed back to the sync, and Leads left for the next full Lead check. */
  requeued?: number;
  notRequeued?: number;
}

export const B12_SWITCH_LIMITS = { reason: { min: 10, max: 500 } } as const;

export const B12_SWITCH_ACTION_TEXT = {
  unchanged: 'It was already {state}. Nothing changed.',
  reasonHint: 'Say why, in 10 to 500 characters. It is kept in the audit log.',
  approvalNote: 'Switching this on in the live CRM needs the owner\'s approval first.',
  requeued: '{requeued} Leads were handed back to the sync; {notRequeued} more will be picked up by the next full Lead check.',
} as const;
