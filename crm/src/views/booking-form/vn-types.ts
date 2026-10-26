import type { BillToType, GstStatus } from '@/modules/fulfilment/booking-form-contract';
import type { TripScope } from '@/modules/fulfilment/contracts';
import type { B11Action } from '../b11/shapes';

/*
 * View props of the voice-note booking form batch (24 October 2026; posted to
 * the team as luna-vn-props.md). Types and small constants only: no zod and
 * no server imports, so client components may import this file. The loader
 * maps its own records onto these shapes; the screens never fetch.
 */

// ---------------------------------------------------------------------------
// Search (type-ahead over stored records; plain arguments, not FormData)
// ---------------------------------------------------------------------------

export type SearchResult<T> = { ok: true; items: T[]; more: boolean } | { ok: false; message: string };
export type SearchAction<T> = (query: string, scope?: { city?: string }) => Promise<SearchResult<T>>;
/** Searches start at this many typed characters (no full list is ever shown). */
export const SEARCH_MIN_QUERY = 2;

// ---------------------------------------------------------------------------
// 1/2 Trip facts from the Bitrix Deal
// ---------------------------------------------------------------------------

/** Values read from the Bitrix Deal. null = the Deal has no value, so the booking asks for it once. */
export interface DealTripFactsView {
  destination: string | null;
  /** YYYY-MM-DD */
  start: string | null;
  end: string | null;
  total: number | null;
  adults: number | null;
  children: number | null;
  infants: number | null;
  /** From the Super Admin's classification of the Deal's destination; null = unclassified or no destination. */
  scope: TripScope | null;
  /** When the Deal was last read (ISO). */
  readAt: string | null;
  bitrixDealHref?: string | null;
}

// ---------------------------------------------------------------------------
// 3 Passengers (standard request codes live in contracts.ts: SPECIAL_REQUEST_CODES)
// ---------------------------------------------------------------------------

/** Extra phone numbers per passenger (optional). */
export const EXTRA_PHONES_MAX = 3;

// ---------------------------------------------------------------------------
// 4 Hotels (stored hotel list)
// ---------------------------------------------------------------------------

export interface HotelOption {
  hotelId: string;
  name: string;
  city: string;
  area: string | null;
  /** e.g. "4 star" */
  category: string | null;
}

// ---------------------------------------------------------------------------
// 9 Bill To parties (stored customers)
// ---------------------------------------------------------------------------

export type PartyCheckStatus = 'not_checked' | 'checked' | 'returned';

export interface PartyOption {
  partyId: string;
  type: BillToType;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  stateCode: string;
  postalCode: string;
  gstStatus: GstStatus | null;
  gstin: string | null;
  gstReason: string | null;
  checkStatus: PartyCheckStatus;
  /** "Imported", "Added on DL-1042" */
  sourceLabel: string | null;
}

export interface PartyActions {
  search: SearchAction<PartyOption>;
  /** FormData: see luna-vn-props.md; result data: { party: PartyOption }. */
  create: B11Action;
  canCreate: boolean;
  /**
   * The full stored details of one customer, read when it is picked (search hits carry only
   * name, city, state and GSTIN). Absent = the search hit is used as it is.
   */
  pick?: (partyId: string) => Promise<{ ok: true; party: PartyOption } | { ok: false; message: string }>;
}

/** Optional extras of the booking form screen (absent = today's screen). */
export interface VoiceNoteProps {
  dealFacts?: DealTripFactsView | null;
  searchHotels?: SearchAction<HotelOption> | null;
  parties?: PartyActions | null;
}

export const PARTY_STATUS_LABEL: Record<PartyCheckStatus, string> = {
  not_checked: 'Not checked',
  checked: 'Checked by Accounts',
  returned: 'Returned',
};

// ---------------------------------------------------------------------------
// 10 Accounts customer check
// ---------------------------------------------------------------------------

export type PartyCheckFilter = PartyCheckStatus;

export interface PartyCheckRow {
  partyId: string;
  href: string;
  type: BillToType;
  name: string;
  contactLine: string | null;
  place: string | null;
  gstLine: string | null;
  status: PartyCheckStatus;
  sourceLabel: string | null;
  addedAt: string;
  addedByName: string | null;
}

export interface PartyFileView {
  fileId: string;
  kind: 'id_proof' | 'gst_certificate' | 'other';
  fileName: string;
  sizeLabel: string;
  downloadHref: string;
}

export interface PartyCheckDetail extends PartyOption {
  rowVersion: number;
  returnedReason: string | null;
  checkedByName: string | null;
  checkedAt: string | null;
  files: PartyFileView[];
  history: Array<{ at: string; byName: string | null; text: string }>;
  usedOn: Array<{ reference: string; href: string | null }>;
}

export interface PartyCheckActions {
  save: B11Action;
  check: B11Action;
  returnParty: B11Action;
}

// ---------------------------------------------------------------------------
// 5 Admin: imports and destination classes
// ---------------------------------------------------------------------------

export type ImportKind = 'hotel' | 'customer';
export type ImportStatus = 'validated' | 'applied' | 'expired';

export interface ImportSummaryView {
  batchId: string;
  kind: ImportKind;
  fileName: string;
  status: ImportStatus;
  counts: { rows: number; valid: number; invalid: number; duplicates: number; creates: number; updates: number; unchanged: number; skippedVerified: number };
  /** field null = the column is ignored. */
  mapping: Array<{ column: string; field: string | null }>;
  invalidRows: Array<{ rowNo: number; reasons: string[] }>;
  duplicateRows: Array<{ rowNo: number; text: string }>;
  proposed: Array<{ rowNo: number; action: 'create' | 'update'; name: string; changes: string[] }>;
  applyBlockedReason: string | null;
  /** Rows where a value was assumed (for example a GST status worked out from a GSTIN); listed, never hidden. */
  assumedRows?: number;
  /** Echo-A L6: update rows where a blank cell will clear a stored value (the notes say which fields). */
  clearingRows?: number;
  rowNotes?: Array<{ rowNo: number; text: string }>;
  /** Echo-A L3: the batch version and proposal fingerprint this summary shows; Apply posts both back. */
  rowVersion?: number;
  proposalHash?: string | null;
  /** Echo-A M1 (customer imports): the branch the customers go to; null = the whole company (every branch). */
  branchName?: string | null;
}

/** Echo-A M1: where imported customers go. Default = the importer's branch; "Whole company" only when chosen. */
export interface ImportBranchChoice {
  options: Array<{ branchId: string; name: string }>;
  /** Pre-selected branch (the importer's own); null = nothing pre-selected (the person must choose). */
  defaultBranchId: string | null;
}

export interface ImportBatchRow {
  batchId: string;
  kind: ImportKind;
  fileName: string;
  status: ImportStatus;
  rows: number;
  creates: number;
  updates: number;
  invalid: number;
  byName: string | null;
  at: string;
}

export interface ImportActions {
  /** FormData: kind, file, requestId; result data: { summary: ImportSummaryView }. */
  validate: B11Action;
  /** FormData: batchId, reason, requestId; result data: { applied: { creates: number; updates: number } }. */
  apply: B11Action;
}

export interface DestinationClassRow {
  optionId: string;
  label: string;
  source: 'single' | 'multi';
  scope: TripScope | null;
  reason: string | null;
  byName: string | null;
  at: string | null;
  rowVersion: number;
}
