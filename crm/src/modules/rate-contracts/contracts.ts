/**
 * Rate contracts (Accounts phase 3 contract section 9, Release B; LD21, LD22).
 * Track E owns this module. Words shown to staff are frozen here (section 13).
 *
 * Rate contracts are supplier costs: Purchase (enter, upload, read), Managers
 * of the entity (approve, end, read) and Accounts (read) only. Sales, Flight
 * and Visa never receive these types (every read answers null for them).
 * Money is whole paise as decimal strings; dates are YYYY-MM-DD (India).
 * Pure module: no server imports, safe for client components (type imports).
 */

export const RATE_CONTRACT_STATUSES = ['draft', 'pending_approval', 'active', 'returned', 'ended'] as const;
export type RateContractStatus = (typeof RATE_CONTRACT_STATUSES)[number];
export type RateContractSource = 'manual' | 'import';

/** Fixed meal plan codes (LD21) with their frozen labels. */
export const MEAL_PLAN_CODES = ['EP', 'CP', 'MAP', 'AP', 'AI'] as const;
export type MealPlanCode = (typeof MEAL_PLAN_CODES)[number];
export const MEAL_PLAN_LABEL: Record<MealPlanCode, string> = {
  EP: 'Room only',
  CP: 'Breakfast',
  MAP: 'Breakfast and dinner',
  AP: 'All meals',
  AI: 'All inclusive',
};

export const RATE_LOOKUP_STATES = ['ok', 'no_contract', 'partial', 'blackout', 'ended'] as const;
export type RateLookupState = (typeof RATE_LOOKUP_STATES)[number];

/** Offer against the contract (purchase_quotes.contract_state). */
export const CONTRACT_COMPARE_STATES = ['none', 'matches', 'differs', 'ended'] as const;
export type ContractCompareState = (typeof CONTRACT_COMPARE_STATES)[number];
export const CONTRACT_COMPARE_LABEL: Record<ContractCompareState, string> = {
  none: 'No contract rate',
  matches: 'Same as the contract rate',
  differs: 'Differs from the contract rate',
  ended: 'Contract ended before these dates',
};

export const RATE_CONTRACT_FILE_STATUSES = ['pending_upload', 'stored', 'failed', 'removed'] as const;
export type RateContractFileStatus = (typeof RATE_CONTRACT_FILE_STATUSES)[number];
export const RATE_CONTRACT_FILE_BUCKET = 'purchase-evidence';
export const RATE_CONTRACT_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const RATE_CONTRACT_SIGNED_URL_SECONDS = 60;
export const RATE_CONTRACT_MAX_LINES = 500;
export const RATE_CONTRACT_MAX_BLACKOUTS = 100;

// ---------------------------------------------------------------------------
// Refusals (section 13). Codes are SQLSTATEs; a token maps only with its own code.
// ---------------------------------------------------------------------------

export const RATE_ERROR_STATES = {
  not_authorized: '42501',
  not_self_approval: '42501',
  rate_contracts_off: '55000',
  link_not_allowed: '55000',
  wrong_state: '55000',
  not_ready: '55000',
  already_recorded: '55000',
  in_use: '55000',
  invalid_input: '22023',
  lines_overlap: '22023',
  evidence_rejected: '22023',
  version_changed: '40001',
  request_conflict: '40001',
  not_found: 'P0002',
  // Rate-sheet import (existing import tokens).
  import_stale: '40001',
  import_applied: '55000',
  import_not_validated: '55000',
  import_too_large: '22023',
} as const;
export type RateErrorCode = keyof typeof RATE_ERROR_STATES;

export const RATE_ERROR_TEXT: Record<RateErrorCode | 'session' | 'upload_failed' | 'unexpected', string> = {
  rate_contracts_off: 'Rate contracts are not switched on yet.',
  lines_overlap: 'Two rate lines for the same room and meal plan overlap in dates.',
  in_use: 'This is used by an active contract.',
  not_authorized: 'You do not have access to this. Nothing was changed.',
  not_self_approval: 'You can’t approve your own request or your own entry. Another colleague must decide.',
  link_not_allowed: 'This supplier does not sell this hotel. Link the hotel on the supplier page first.',
  wrong_state: 'This contract can’t be changed in its current state. Reload to see the latest state.',
  not_ready: 'Add at least one rate line (with room types still in use) before sending it for approval.',
  already_recorded: 'This hotel already has a room type with that name.',
  invalid_input: 'Check the highlighted field. Nothing was saved.',
  evidence_rejected: 'The file was not accepted: PDF, JPEG, PNG or WebP up to 4 MB, at most 10 files per contract.',
  version_changed: 'Someone changed this contract while you were working. Reload the page to see the latest version.',
  request_conflict: 'This was already sent with different details. Reload the page before you try again.',
  not_found: 'This could not be found. It may have been removed, or you may not have access.',
  import_stale: 'Something changed since the file was checked. Check the file again, then import it. Nothing was imported.',
  import_applied: 'This file was already imported.',
  import_not_validated: 'Check the file first, then import it.',
  import_too_large: 'The file has too many rows (at most 5,000).',
  session: 'You were signed out. Sign in again; what you typed is still on this page.',
  upload_failed: 'The file was not accepted and does not count. Upload it again.',
  unexpected: 'We could not confirm this was saved. Reload the page to check before you try again. Your typed details are still here.',
};

/** Words for fields the database names in an invalid_input hint (lines[n].x is looked up as x). */
export const RATE_FIELD_TEXT: Record<string, string> = {
  supplierId: 'Pick a supplier that sells hotels.',
  hotelId: 'Pick an active hotel linked to this supplier.',
  validFrom: 'Enter the first date of the contract (rate lines and blackouts must fit inside it).',
  validTo: 'Enter the last date: on or after the first date, at most 1,100 days later, with every line inside.',
  cancellationTerms: 'Cancellation terms can be up to 2,000 characters.',
  note: 'The note is too long.',
  name: 'Enter a room type name of 1 to 120 characters.',
  reason: 'Write a reason of 10 to 500 characters.',
  decision: 'Choose approve or return.',
  seasonFrom: 'The season must start inside the contract dates.',
  seasonTo: 'The season must end on or after its start and inside the contract dates.',
  roomTypeId: 'Pick a room type of this hotel.',
  mealPlan: 'Pick a meal plan: EP, CP, MAP, AP or AI.',
  rateRupees: 'Enter the rate per room per night (more than zero).',
  weekendRateRupees: 'The weekend rate must be more than zero, or left empty.',
  extraAdultRupees: 'Enter an amount of zero or more, or leave it empty.',
  childWithBedRupees: 'Enter an amount of zero or more, or leave it empty.',
  childWithoutBedRupees: 'Enter an amount of zero or more, or leave it empty.',
  fromDate: 'The blackout must start inside the contract dates.',
  toDate: 'The blackout must end on or after its start and inside the contract dates.',
  lines: 'Check the rate lines (at most 500).',
  blackouts: 'Check the blackout dates (at most 100).',
};

/** Database line field names -> the form's names (rupee inputs). */
export const LINE_HINT_FORM_FIELD: Record<string, string> = {
  ratePaise: 'rateRupees',
  weekendRatePaise: 'weekendRateRupees',
  extraAdultPaise: 'extraAdultRupees',
  childWithBedPaise: 'childWithBedRupees',
  childWithoutBedPaise: 'childWithoutBedRupees',
};

// ---------------------------------------------------------------------------
// Rate-sheet import (9.4)
// ---------------------------------------------------------------------------

export const RATE_SHEET_KIND = 'rate_sheet' as const;
export const RATE_SHEET_REASONS = [
  'supplier_not_found', 'hotel_not_found', 'supplier_does_not_sell_hotel', 'dates_invalid', 'season_outside_validity',
  'meal_plan_invalid', 'rate_invalid', 'line_overlap', 'duplicate_in_file',
  // Besides the frozen list (track E report): generic and size rules.
  'room_type_invalid', 'terms_too_long', 'too_many_lines', 'not_text', 'unknown_column', 'formula_cell',
] as const;
export type RateSheetReason = (typeof RATE_SHEET_REASONS)[number];
export const RATE_SHEET_WARNINGS = ['new_room_type', 'overlaps_active_contract'] as const;
export type RateSheetWarning = (typeof RATE_SHEET_WARNINGS)[number];

export const RATE_SHEET_REASON_TEXT: Record<RateSheetReason, string> = {
  supplier_not_found: 'Supplier not found (check the supplier ID or the exact name)',
  hotel_not_found: 'Hotel not found (check the hotel ID, or the exact name and city)',
  supplier_does_not_sell_hotel: 'This supplier is not linked to this hotel, or does not sell hotels',
  dates_invalid: 'A date is missing, not a real date, or in the wrong order',
  season_outside_validity: 'Season or blackout dates are outside the contract dates',
  meal_plan_invalid: 'Meal plan is not EP, CP, MAP, AP or AI (or their words)',
  rate_invalid: 'A rate is missing, not a rupee amount, or not above zero',
  line_overlap: 'Overlaps an earlier line for the same room and meal plan',
  duplicate_in_file: 'Same line twice in the file',
  room_type_invalid: 'Room type is missing or longer than 120 characters',
  terms_too_long: 'Cancellation terms are longer than 2,000 characters',
  too_many_lines: 'More than 500 lines for one contract',
  not_text: 'A cell is not plain text',
  unknown_column: 'A column is not part of the rate sheet',
  formula_cell: 'A cell starts like a spreadsheet formula',
};

export const RATE_SHEET_WARNING_TEXT: Record<RateSheetWarning, string> = {
  new_room_type: 'New room type: it will be added to the hotel',
  overlaps_active_contract: 'Overlaps an active contract: approving the draft ends the older one',
};

// ---------------------------------------------------------------------------
// Action results (Phase 2 Addendum L3 form shape)
// ---------------------------------------------------------------------------

export type RateActionResult<T = unknown> =
  | { ok: true; message: string; data?: T }
  | { ok: false; code: RateErrorCode | 'session' | 'upload_failed' | 'unexpected'; message: string; field?: string; values?: Record<string, string> };

/** Form field names the server actions read. Rupee inputs end in Rupees; hidden binding values are ids and row versions. */
export const RATE_FIELD = {
  contractId: 'contractId',
  expectedRowVersion: 'expectedRowVersion',
  requestId: 'requestId',
  supplierId: 'supplierId',
  hotelId: 'hotelId',
  validFrom: 'validFrom',
  validTo: 'validTo',
  cancellationTerms: 'cancellationTerms',
  note: 'note',
  lineCount: 'lineCount',
  blackoutCount: 'blackoutCount',
  decision: 'decision',
  reason: 'reason',
  roomTypeId: 'roomTypeId',
  name: 'name',
  file: 'file',
  enabled: 'enabled',
} as const;

/** Per line: lines[i].<key>; per blackout: blackouts[i].fromDate / toDate. */
export const RATE_LINE_FORM_KEYS = [
  'seasonFrom', 'seasonTo', 'roomTypeId', 'mealPlan', 'rateRupees', 'weekendRateRupees', 'extraAdultRupees', 'childWithBedRupees',
  'childWithoutBedRupees', 'note',
] as const;

export const RATE_DONE_TEXT = {
  created: 'Draft contract saved. Add the rate lines, then send it for approval.',
  saved: 'Contract details saved.',
  linesSet: 'Rate lines saved.',
  submitted: 'Sent to a Manager for approval.',
  approved: 'Contract approved. Offers for this hotel and supplier now show the contract rate.',
  approvedReplaced: 'Contract approved. The older overlapping contract was ended.',
  returned: 'Contract returned to Purchase with your reason.',
  ended: 'Contract ended. It is no longer used for offers.',
  roomTypeSaved: 'Room type saved.',
  roomTypeRemoved: 'Room type removed.',
  fileStored: 'File uploaded.',
  existing: 'This was already recorded. Nothing changed.',
  switchOn: 'Rate contracts are switched on.',
  switchOff: 'Rate contracts are switched off. Offers no longer compare with contract rates.',
} as const;
