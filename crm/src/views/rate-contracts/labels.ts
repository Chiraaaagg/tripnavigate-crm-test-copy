import type { StatusTone } from '@/components/ui/badge';
import type { MealPlanCode, RateContractStatus, RateLookupState, RateSheetReason, RateSheetWarning } from './types';

/*
 * Words for the rate contract screens (Accounts phase 3 contract §9, §13).
 * Meal plan labels are frozen by LD21. Refusal texts are the frozen §13
 * messages; track E's `contracts.ts` owns them, these copies are only used by
 * the preview gallery and as a fallback when an action returns no message.
 */

export const MEAL_PLAN_LABEL: Record<MealPlanCode, string> = {
  EP: 'Room only',
  CP: 'Breakfast',
  MAP: 'Breakfast and dinner',
  AP: 'All meals',
  AI: 'All inclusive',
};

export function mealPlanText(code: MealPlanCode): string {
  return `${MEAL_PLAN_LABEL[code]} (${code})`;
}

export const STATUS_LOOK: Record<RateContractStatus, { word: string; tone: StatusTone }> = {
  draft: { word: 'Draft', tone: 'neutral' },
  pending_approval: { word: 'Waiting for Manager approval', tone: 'warning' },
  active: { word: 'Active', tone: 'success' },
  returned: { word: 'Returned for changes', tone: 'danger' },
  ended: { word: 'Ended', tone: 'neutral' },
};

/** Status, owner and next step for the top of the contract page (§0 UI rule). */
export function nextStepText(status: RateContractStatus, viewer: 'purchase' | 'manager' | 'accounts'): string {
  switch (status) {
    case 'draft':
      return viewer === 'purchase' ? 'Next: add the rate lines, then send it to a Manager for approval.' : 'Purchase is still entering this contract.';
    case 'returned':
      return viewer === 'purchase' ? 'Next: fix what the Manager asked for, then send it again.' : 'Waiting for Purchase to fix it and send it again.';
    case 'pending_approval':
      return viewer === 'manager' ? 'Next: check the rates and dates, then approve or return it. You cannot approve a contract you entered.' : 'Waiting for a Manager who did not enter it to approve it.';
    case 'active':
      return 'Offers for this hotel and supplier show the contract rate for the stay dates.';
    case 'ended':
      return 'No longer used for offers. A new sheet makes a new version.';
  }
}

export const LOOKUP_WORD: Record<RateLookupState, string> = {
  ok: 'Contract rate for these dates',
  no_contract: 'No contract covers these dates',
  partial: 'The contract covers only some nights',
  blackout: 'Some nights fall on blackout dates',
  ended: 'The contract ended before these dates',
};

export const SHEET_REASON_WORD: Record<RateSheetReason, string> = {
  supplier_not_found: 'Supplier not found (check the ID or the exact name)',
  hotel_not_found: 'Hotel not found (check the ID, or the exact name and city)',
  supplier_does_not_sell_hotel: 'This supplier is not linked to this hotel',
  dates_invalid: 'A date is missing or not a real date',
  season_outside_validity: 'Season dates are outside the contract dates',
  meal_plan_invalid: 'Meal plan is not EP, CP, MAP, AP or AI',
  rate_invalid: 'Rate is missing or not a rupee amount above zero',
  line_overlap: 'Overlaps another line for the same room and meal plan',
  duplicate_in_file: 'Same line twice in the file',
};

export const SHEET_WARNING_WORD: Record<RateSheetWarning, string> = {
  new_room_type: 'New room type: it will be added to the hotel',
  overlaps_active_contract: 'Overlaps an active contract: approving the draft ends the older one for those dates',
};

/** Rate-sheet columns, in file order (9.4), with what each needs. */
export const RATE_SHEET_COLUMNS: ReadonlyArray<{ name: string; need: string }> = [
  { name: 'supplierRef', need: 'Supplier ID, or the exact supplier name' },
  { name: 'hotelRef', need: 'Hotel ID, or the exact hotel name' },
  { name: 'city', need: 'Hotel city (needed when the hotel is given by name)' },
  { name: 'validFrom', need: 'Contract start date (YYYY-MM-DD)' },
  { name: 'validTo', need: 'Contract end date' },
  { name: 'seasonFrom', need: 'Season start date, inside the contract dates' },
  { name: 'seasonTo', need: 'Season end date' },
  { name: 'roomType', need: 'Room type name (a new name is added to the hotel)' },
  { name: 'mealPlan', need: 'EP, CP, MAP, AP or AI, or its words' },
  { name: 'rate', need: 'Rupees per room per night' },
  { name: 'weekendRate', need: 'Friday and Saturday nights (optional)' },
  { name: 'extraAdult', need: 'Optional' },
  { name: 'childWithBed', need: 'Optional' },
  { name: 'childWithoutBed', need: 'Optional' },
  { name: 'blackoutDates', need: 'Optional, like 2026-12-24..2026-12-31; 2027-01-01..2027-01-01' },
  { name: 'cancellationTerms', need: 'Optional text' },
];

/** Frozen §13 refusal messages (fallback copies; track E's contracts.ts owns them). */
export const RATE_REFUSAL_TEXT: Record<string, string> = {
  rate_contracts_off: 'Rate contracts are not switched on yet.',
  lines_overlap: 'Two rate lines for the same room and meal plan overlap in dates.',
  in_use: 'This is used by an active contract.',
  not_self_approval: 'You cannot approve a contract you entered. Ask another Manager.',
  link_not_allowed: 'This supplier is not linked to this hotel, or does not sell hotels.',
  version_changed: 'Someone changed this contract while you were working. Reload the page to see the latest version.',
};
