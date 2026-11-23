/*
 * Rate contracts (Accounts phase 3 contract §9, Release B): typed adapter for
 * the screens of §15 item 9. Track E's module (`@/modules/rate-contracts`) is
 * not built yet, so these types mirror the frozen reads R-E1, R-E2, R-E3 and
 * the 9.2 price lookup key for key. Track E's DTOs (`@/modules/rate-contracts/dto`)
 * are structural supersets of these (checked 13 Nov 2026), so the routes pass
 * them straight in; no runtime import here keeps client components light.
 * Money is whole paise as decimal strings; dates are YYYY-MM-DD.
 */

export type RateContractStatus = 'draft' | 'pending_approval' | 'active' | 'returned' | 'ended';
export type RateContractSource = 'manual' | 'import';
/** Fixed meal plan codes (LD21). */
export type MealPlanCode = 'EP' | 'CP' | 'MAP' | 'AP' | 'AI';
export const MEAL_PLAN_CODES: readonly MealPlanCode[] = ['EP', 'CP', 'MAP', 'AP', 'AI'];

/** Who is looking: Purchase enters and uploads, Managers approve and end, Accounts read (§14). */
export type RateContractViewer = 'purchase' | 'manager' | 'accounts';

/** R-E1 `rate_contracts_list` filter. */
export interface RateContractFilter {
  supplierId?: string;
  hotelId?: string;
  status?: RateContractStatus[];
  endingWithinDays?: number;
  q?: string;
  /** Presets: `to_approve` (Managers), `ending_soon`. */
  preset?: 'to_approve' | 'ending_soon';
}

/** R-E1 row. */
export interface RateContractRow {
  contractId: string;
  contractNo: string;
  versionNo: number;
  supplierName: string;
  hotelName: string;
  city: string | null;
  validFrom: string;
  validTo: string;
  /** Days until validTo (India date); negative once past. */
  daysLeft: number;
  status: RateContractStatus;
  lineCount: number;
  enteredByName: string | null;
  rowVersion: number;
  /** E (migration 0570): the viewer entered it (cannot approve it). Absent = false. */
  isMine?: boolean;
  /** E: list rows only — waiting, the viewer is an Approver and did not enter it, switch On. Absent = not known. */
  canApprove?: boolean;
}

/** R-E1 keyset page (same shape as the other keyset lists). */
export interface RateContractPage {
  items: RateContractRow[];
  nextAfter: string | null;
  hasMore: boolean;
}

/** One rate line (9.1 `rate_contract_lines`). */
export interface RateLineView {
  lineId: string;
  seasonFrom: string;
  seasonTo: string;
  roomTypeId: string;
  /** UI assumption: the room type name is joined by the read. */
  roomTypeName: string;
  mealPlan: MealPlanCode;
  ratePaise: string;
  weekendRatePaise: string | null;
  extraAdultPaise: string | null;
  childWithBedPaise: string | null;
  childWithoutBedPaise: string | null;
  note: string | null;
}

export interface RateBlackoutView {
  fromDate: string;
  toDate: string;
}

/** A stored contract file (track E's RATE_CONTRACT_FILE_STATUSES). */
export interface RateContractFileView {
  fileId: string;
  fileName: string;
  status: 'pending_upload' | 'stored' | 'failed' | 'removed';
  uploadedAt: string;
  uploadedByName: string | null;
}

/** An earlier version of the same supplier + hotel (R-E2 `history`). */
export interface RateContractHistoryItem {
  contractId: string;
  contractNo: string;
  versionNo: number;
  validFrom: string;
  validTo: string;
  status: RateContractStatus;
  decidedByName: string | null;
  decidedAt: string | null;
  endReason: string | null;
}

/** R-E2 `rate_contract_get`. */
export interface RateContractDetail extends RateContractRow {
  /** UI assumption: ids for the edit form and the hotel's room types. */
  supplierId: string;
  hotelId: string;
  source: RateContractSource;
  cancellationTerms: string | null;
  note: string | null;
  /** UI assumption: shown at the top while returned / ended. */
  returnReason: string | null;
  endReason: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  lines: RateLineView[];
  blackouts: RateBlackoutView[];
  files: RateContractFileView[];
  history: RateContractHistoryItem[];
  can: { edit: boolean; submit: boolean; approve: boolean; return: boolean; end: boolean };
}

/** Room types of a hotel (`hotel_room_types`). */
export interface RoomTypeView {
  roomTypeId: string;
  name: string;
  rowVersion: number;
  /** UI assumption: true when an active contract uses it (remove is refused `in_use`). */
  inUse?: boolean;
}

/** 9.2 `authz.rate_contract_price` result. */
export type RateLookupState = 'ok' | 'no_contract' | 'partial' | 'blackout' | 'ended';
export interface RateLookupNight {
  date: string;
  ratePaise: string;
  lineId: string;
  weekend: boolean;
}
export interface RateLookupPrice {
  state: RateLookupState;
  contractIds: string[];
  nights: RateLookupNight[];
  perRoomTotalPaise: string | null;
  totalPaise: string | null;
  endedOn: string | null;
}

/** R-E3 `rate_contract_lookup`: the 9.2 result plus the hotel's room types. */
export interface RateContractLookup extends RateLookupPrice {
  roomTypes: Array<{ roomTypeId: string; name: string }>;
}

/** Supplier → hotels it may have contracts for (the create form's choices). UI assumption: an existing supplier-hotel read. */
export interface ContractSupplierChoice {
  supplierId: string;
  supplierName: string;
  hotels: Array<{ hotelId: string; name: string; city: string | null }>;
}

/* Rate-sheet import (9.4): the rate_sheet part of the import check result. */

export type RateSheetOutcome = 'create' | 'invalid';
export type RateSheetReason =
  | 'supplier_not_found'
  | 'hotel_not_found'
  | 'supplier_does_not_sell_hotel'
  | 'dates_invalid'
  | 'season_outside_validity'
  | 'meal_plan_invalid'
  | 'rate_invalid'
  | 'line_overlap'
  | 'duplicate_in_file';
export type RateSheetWarning = 'new_room_type' | 'overlaps_active_contract';

export interface RateSheetRowView {
  rowNo: number;
  outcome: RateSheetOutcome;
  reasons: RateSheetReason[];
  warnings: RateSheetWarning[];
  values: {
    supplierRef: string | null;
    hotelRef: string | null;
    validFrom: string | null;
    validTo: string | null;
    seasonFrom: string | null;
    seasonTo: string | null;
    roomType: string | null;
    mealPlan: string | null;
    rate: string | null;
    weekendRate: string | null;
    blackoutDates: string | null;
  };
}

export interface RateSheetImportSummary {
  /** Draft contracts the apply step would create. */
  contracts: number;
  lines: number;
  newRoomTypes: number;
  invalidRows: number;
  warnings: { newRoomType: number; overlapsActiveContract: number };
  rows: RateSheetRowView[];
  moreRows?: number;
}
