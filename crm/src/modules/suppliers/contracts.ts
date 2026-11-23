/**
 * Supplier and hotel master (Accounts phase 2, Track A): frozen DTO shapes,
 * words and refusal texts for the supplier register, the supplier page, the
 * quote hotel picker and the contact / hotel-link commands.
 *
 * Contract: implementation/accounts-phase2-2026-11-11/contract.md sections
 * 5.1-5.7, 9, 10, 13.4; Addendum L2 (kind values 'direct' | 'channel', label
 * "Agent or booking channel"); Addendum L3 (server action shape and form
 * field names). Database: crm/supabase/migrations/20261204000100..0130.
 * Type and constant file only (no zod, no server import): client components
 * may import it.
 */
import { CONFLICT_STATES } from '@/lib/sqlstate';

export const SUPPLIER_KINDS = ['direct', 'channel'] as const;
export type SupplierKind = (typeof SUPPLIER_KINDS)[number];
export const SUPPLIER_SERVICE_TYPES = ['hotel', 'transfer', 'activity', 'flight'] as const;
export type SupplierServiceType = (typeof SUPPLIER_SERVICE_TYPES)[number];
export const SUPPLIER_VERIFICATIONS = ['unverified', 'verified'] as const;
export type SupplierVerification = (typeof SUPPLIER_VERIFICATIONS)[number];
export const SUPPLIER_BANK_STATES = ['approved', 'on_hold', 'none'] as const;
export type SupplierBankState = (typeof SUPPLIER_BANK_STATES)[number];
export const SUPPLIER_DUPLICATE_REASONS = ['similar_name_city', 'same_gstin', 'same_pan', 'same_bank'] as const;
export type SupplierDuplicateReason = (typeof SUPPLIER_DUPLICATE_REASONS)[number];
export const SUPPLIER_HOTEL_SOURCES = ['quote', 'manual', 'import'] as const;
export type SupplierHotelSource = (typeof SUPPLIER_HOTEL_SOURCES)[number];
export const SUPPLIER_CHANGE_SOURCES = ['edit', 'import', 'verify', 'contact', 'hotel_link', 'bank'] as const;
export type SupplierChangeSource = (typeof SUPPLIER_CHANGE_SOURCES)[number];
export const SUPPLIER_STATUSES = ['active', 'archived'] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

export const SUPPLIER_KIND_LABEL: Record<SupplierKind, string> = { direct: 'Direct supplier', channel: 'Agent or booking channel' };
export const SUPPLIER_BANK_STATE_LABEL: Record<SupplierBankState, string> = {
  approved: 'Bank details approved',
  on_hold: 'Bank details waiting for a Manager',
  none: 'No bank details',
};
/** Near-duplicate warning words (5.7): shown next to the other supplier's name; never a block. */
export const SUPPLIER_DUPLICATE_TEXT: Record<SupplierDuplicateReason, string> = {
  similar_name_city: 'similar name in the same city',
  same_gstin: 'same GSTIN',
  same_pan: 'same PAN',
  same_bank: 'same bank account (IFSC and last 4 digits)',
};
/** History field names (supplier_changes.field) in plain words; contact:<id>, hotel:<id> and bank_revision by prefix. */
export const SUPPLIER_HISTORY_FIELD_LABEL: Record<string, string> = {
  name: 'Name',
  service_types: 'Services',
  city: 'City',
  contact_name: 'Contact name',
  contact_phone: 'Contact phone',
  contact_email: 'Contact e-mail',
  payment_terms: 'Payment terms',
  status: 'Status',
  verification_status: 'Verification',
  supplier_kind: 'Kind',
  gstin: 'GSTIN',
  pan: 'PAN',
  state_code: 'State',
  address: 'Address',
  tally_ledger_name: 'Tally ledger name',
  source_ref: 'List ID',
  bank_revision: 'Bank details',
};

/** Who reads the register / page (wording only; the database decides every row). */
export type SupplierViewer = 'purchase' | 'flight' | 'manager' | 'accounts';

export interface SupplierPrimaryContact {
  name: string;
  phone: string | null;
  email: string | null;
}

/** R-A1 row (public.supplier_register). */
export interface SupplierRegisterRow {
  supplierId: string;
  name: string;
  kind: SupplierKind;
  serviceTypes: SupplierServiceType[];
  city: string | null;
  stateCode: string | null;
  gstin: string | null;
  /** Always masked (XXXXX1234X) in the register. */
  panMasked: string | null;
  verification: SupplierVerification;
  bankState: SupplierBankState;
  primaryContact: SupplierPrimaryContact | null;
  hotelCount: number;
  rowVersion: number;
  /** Additive: active | archived. */
  status: SupplierStatus;
}

/** R-A1 filter (p_filter); every key optional. */
export interface SupplierRegisterFilter {
  q?: string;
  kind?: SupplierKind;
  serviceType?: SupplierServiceType;
  city?: string;
  verification?: SupplierVerification;
  bankState?: SupplierBankState;
  hotelId?: string;
  status?: SupplierStatus;
}

export interface SupplierRegisterPage {
  items: SupplierRegisterRow[];
  /** Keyset cursor for "Show more"; null = that is all. */
  nextAfter: string | null;
  hasMore: boolean;
}

/** 5.2 contact (active contacts only are listed). */
export interface SupplierContactView {
  contactId: string;
  name: string;
  roleLabel: string | null;
  phone: string | null;
  email: string | null;
  isPrimary: boolean;
  status: 'active' | 'removed';
  rowVersion: number;
  updatedAt: string;
}

export interface SupplierHotelLinkView {
  linkId: string;
  hotelId: string;
  name: string;
  city: string | null;
  source: SupplierHotelSource;
  createdAt: string;
}

/** 5.7 near-duplicate entry (also the `warnings` of create / update). */
export interface SupplierDuplicate {
  supplierId: string;
  name: string;
  reasons: SupplierDuplicateReason[];
}

export interface SupplierHistoryRow {
  changedAt: string;
  changedByName: string | null;
  source: SupplierChangeSource;
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

/** R-A2 public.supplier_master_get. */
export interface SupplierMaster extends SupplierRegisterRow {
  legalEntityId: string;
  /** Full PAN for Accounts and Managers; masked for everyone else. */
  pan: string | null;
  address: string | null;
  /** Accounts and Managers only (null otherwise). */
  tallyLedgerName: string | null;
  sourceRef: string | null;
  paymentTerms: string | null;
  verifiedAt: string | null;
  verifiedByName: string | null;
  updatedAt: string;
  /** Latest bank detail revision: number, status and last 4 digits only. */
  bank: { revisionNo: number; status: 'unverified' | 'approved'; accountLast4: string } | null;
  contacts: SupplierContactView[];
  hotels: SupplierHotelLinkView[];
  duplicates: SupplierDuplicate[];
  history: SupplierHistoryRow[];
  can: { edit: boolean; verify: boolean; linkHotel: boolean; approveBank: boolean };
}

/** R-A3 public.hotel_suppliers entry (also 13.4 `hotelSuppliers`). */
export interface HotelSupplierOption {
  supplierId: string;
  name: string;
  kind: SupplierKind;
  verification: SupplierVerification;
  bankState: SupplierBankState;
}

export interface HotelSuppliers {
  hotelId: string;
  suppliers: HotelSupplierOption[];
}

/** 13.4 additions of purchase_workspace for a hotel task (null / [] for other tasks). */
export interface QuoteCatalogueHotel {
  catalogueHotelId: string | null;
  catalogueHotelName: string | null;
  hotelSuppliers: HotelSupplierOption[];
}

// ---------------------------------------------------------------------------
// Command results
// ---------------------------------------------------------------------------

export interface SupplierWriteResult {
  supplierId: string;
  rowVersion: number;
  warnings: SupplierDuplicate[];
}
export interface SupplierContactSaveResult {
  outcome: 'created' | 'updated' | 'existing';
  contactId: string;
  rowVersion: number;
  supplierRowVersion: number;
}
export interface SupplierContactRemoveResult {
  outcome: 'updated' | 'existing';
  contactId: string;
  supplierRowVersion: number;
}
export interface SupplierHotelLinkResult {
  outcome: 'created' | 'updated' | 'existing';
  linkId: string;
}

// ---------------------------------------------------------------------------
// Refusals (section 9; SQLSTATE per token)
// ---------------------------------------------------------------------------

export type SupplierErrorCode =
  | 'not_authorized'
  | 'not_found'
  | 'version_changed'
  | 'request_conflict'
  | 'invalid_input'
  | 'environment_unset'
  | 'supplier_exists'
  | 'link_not_allowed';

export const SUPPLIER_ERROR_STATES: Record<SupplierErrorCode, string | readonly string[]> = {
  not_authorized: '42501',
  not_found: 'P0002',
  version_changed: CONFLICT_STATES,
  request_conflict: CONFLICT_STATES,
  invalid_input: '22023',
  environment_unset: '55000',
  supplier_exists: '23505',
  link_not_allowed: '55000',
};
/** Flight's create/update refuse a taken name as duplicate_supplier (unchanged); shown like supplier_exists. */
export const SUPPLIER_TOKEN_ALIASES: Record<string, SupplierErrorCode> = { duplicate_supplier: 'supplier_exists' };

export const SUPPLIER_ERROR_TEXT: Record<SupplierErrorCode | 'session', string> = {
  not_authorized: 'You cannot change this supplier.',
  not_found: 'This supplier, contact or hotel link is no longer available. Reload the page.',
  version_changed: 'Someone changed this supplier meanwhile. Reload and try again.',
  request_conflict: 'This form was already sent with other values. Reload and try again.',
  invalid_input: 'Check the highlighted field.',
  environment_unset: 'This system is not set up yet. Nothing was saved.',
  supplier_exists: 'A supplier with this exact name already exists. Use the existing supplier or change the name.',
  link_not_allowed: 'Only a supplier that sells hotels can be linked to a hotel. Add Hotel to its services first.',
  session: 'Your session ended. Sign in again; nothing was saved.',
};

/** Plain words for the field a refusal names (invalid_input hint). */
export const SUPPLIER_FIELD_TEXT: Record<string, string> = {
  name: 'Name is empty or too long (200 characters at most).',
  supplierKind: 'Choose Direct supplier or Agent or booking channel.',
  serviceTypes: 'Choose at least one service.',
  gstin: 'GSTIN shape is wrong (15 characters, for example 08ABCDE1234F1Z5).',
  pan: 'PAN shape is wrong, or it is not the PAN inside the GSTIN (characters 3 to 12).',
  stateCode: 'State does not match the first two digits of the GSTIN.',
  address: 'Address is too long (300 characters at most).',
  phone: 'Give a phone number or an e-mail address (phone: digits, spaces, + ( ) -).',
  email: 'E-mail address is not valid.',
  reason: 'Write a reason of 10 to 300 characters.',
  hotelId: 'Pick a hotel from the list.',
  catalogueHotelId: 'Pick the hotel from the hotel list again.',
  fields: 'Some details could not be read. Check the form.',
};

// ---------------------------------------------------------------------------
// Server actions (Addendum L3)
// ---------------------------------------------------------------------------

export type SupplierActionResult<T = unknown> =
  | { ok: true; message: string; data?: T }
  | { ok: false; code: SupplierErrorCode | 'session'; message: string; field?: string; fields?: string[]; values?: Record<string, string> };

/**
 * Form field names (Addendum L3: contract keys without p_). Supplier details:
 * entityId (create), supplierId + expectedRowVersion (update), name,
 * supplierKind, serviceTypes (repeated), city, stateCode, gstin, pan (empty on
 * an update = keep the stored PAN), address, paymentTerms, contactName,
 * contactPhone, contactEmail, status. Contacts: supplierId, contactId,
 * expectedRowVersion, name, roleLabel, phone, email, isPrimary
 * ('true'|'false'), reason. Hotel links: supplierId, hotelId, linkId, reason.
 * Every write: requestId.
 */
export const SUPPLIER_FIELD = {
  entityId: 'entityId',
  supplierId: 'supplierId',
  contactId: 'contactId',
  linkId: 'linkId',
  hotelId: 'hotelId',
  requestId: 'requestId',
  expectedRowVersion: 'expectedRowVersion',
  reason: 'reason',
  name: 'name',
  supplierKind: 'supplierKind',
  serviceTypes: 'serviceTypes',
  city: 'city',
  stateCode: 'stateCode',
  gstin: 'gstin',
  pan: 'pan',
  address: 'address',
  paymentTerms: 'paymentTerms',
  contactName: 'contactName',
  contactPhone: 'contactPhone',
  contactEmail: 'contactEmail',
  status: 'status',
  roleLabel: 'roleLabel',
  phone: 'phone',
  email: 'email',
  isPrimary: 'isPrimary',
} as const;

export const SUPPLIER_DONE_TEXT = {
  created: 'Supplier added. It stays unverified until a Manager checks it.',
  updated: 'Supplier saved.',
  updatedReset: 'Supplier saved. It is unverified again until a Manager checks it.',
  contactSaved: 'Contact saved.',
  contactRemoved: 'Contact removed.',
  hotelLinked: 'Hotel linked.',
  hotelAlreadyLinked: 'This hotel was already linked.',
  hotelUnlinked: 'Hotel link removed.',
} as const;

export const SUPPLIER_PATHS = ['/app/purchase/suppliers', '/app/flight', '/app/approvals'] as const;
