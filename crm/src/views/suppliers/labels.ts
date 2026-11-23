import type { StatusTone } from '@/components/ui/badge';
import type { SupplierBankState, SupplierChangeSource, SupplierDuplicate, SupplierDuplicateReason, SupplierHotelSource, SupplierKind, SupplierServiceType, SupplierVerification } from './types';

/*
 * Words for the supplier screens (Accounts phase 2 contract 5, 11.9, 11.10,
 * 13.3). Every status shows as an icon plus these words, never colour alone.
 * Plain constants only (no runtime module imports): safe in client code.
 */

export const KIND_LABEL: Record<SupplierKind, string> = {
  direct: 'Direct supplier',
  channel: 'Agent or booking channel',
};

export const SERVICE_LABEL: Record<SupplierServiceType, string> = {
  hotel: 'Hotel',
  transfer: 'Transfer',
  activity: 'Activity',
  flight: 'Flight',
};

export const VERIFICATION_WORD: Record<SupplierVerification, { word: string; tone: StatusTone }> = {
  verified: { word: 'Verified', tone: 'success' },
  unverified: { word: 'Not verified', tone: 'warning' },
};

export const BANK_WORD: Record<SupplierBankState, { word: string; tone: StatusTone }> = {
  approved: { word: 'Bank details approved', tone: 'success' },
  on_hold: { word: 'Payments on hold: bank details not approved', tone: 'warning' },
  none: { word: 'No bank details', tone: 'neutral' },
};

export const DUPLICATE_REASON_WORD: Record<SupplierDuplicateReason, string> = {
  similar_name_city: 'similar name, same city',
  same_gstin: 'same GSTIN',
  same_pan: 'same PAN',
  same_bank: 'same bank account',
};

export const HOTEL_SOURCE_WORD: Record<SupplierHotelSource, string> = {
  quote: 'From a rate',
  manual: 'Added by hand',
  import: 'From an import',
};

export const CHANGE_SOURCE_WORD: Record<SupplierChangeSource, string> = {
  edit: 'Edited',
  import: 'Import',
  verify: 'Verification',
  contact: 'Contact',
  hotel_link: 'Hotel link',
  bank: 'Bank details',
};

/** Field names in the history, as staff read them. */
const FIELD_WORD: Record<string, string> = {
  name: 'Name',
  service_types: 'Services',
  city: 'City',
  contact_name: 'Contact person',
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
  tally_ledger_name: 'Tally ledger',
  source_ref: 'Import reference',
  bank_revision: 'Bank details',
};

export function fieldWord(field: string): string {
  if (field.startsWith('contact:')) return 'Contact';
  if (field.startsWith('hotel:')) return 'Hotel sold';
  return FIELD_WORD[field] ?? field.replace(/_/g, ' ');
}

const STATUS_VALUE_WORD: Record<string, string> = { active: 'Active', archived: 'Archived' };

/** A history value in words (verification, kind, status, services); other values as stored. */
export function historyValueWord(field: string, value: string | null): string | null {
  if (value === null) return null;
  if (field === 'verification_status') return (VERIFICATION_WORD as Record<string, { word: string }>)[value]?.word ?? value;
  if (field === 'supplier_kind') return (KIND_LABEL as Record<string, string>)[value] ?? value;
  if (field === 'status') return STATUS_VALUE_WORD[value] ?? value;
  if (field === 'service_types') {
    return value
      .replace(/[{}"]/g, '')
      .split(/[,;]\s*/)
      .filter(Boolean)
      .map((t) => (SERVICE_LABEL as Record<string, string>)[t] ?? t)
      .join(', ');
  }
  return value;
}

/** "Looks like Sample Lake Hotels (same GSTIN) — check before saving" (contract 11.9). */
export function duplicateText(d: SupplierDuplicate, tail = 'check before saving'): string {
  const why = d.reasons.map((r) => DUPLICATE_REASON_WORD[r]).join(', ');
  return `Looks like ${d.name} (${why}) — ${tail}`;
}

/** Import row warnings (contract 5.6, 13.3). */
export const IMPORT_WARNING_WORD: Record<string, string> = {
  similar_name_city: 'Similar name in the same city',
  same_gstin: 'Same GSTIN as',
  same_pan: 'Same PAN as',
  same_bank: 'Bank details may differ — check against',
  hotel_not_found: 'Hotel not in the hotel list',
};

export const IMPORT_OUTCOME_WORD: Record<string, { word: string; tone: StatusTone }> = {
  create: { word: 'New', tone: 'info' },
  update: { word: 'Update', tone: 'info' },
  unchanged: { word: 'Unchanged', tone: 'neutral' },
  skipped_checked: { word: 'Skipped: verified', tone: 'neutral' },
  invalid: { word: 'Invalid: left out', tone: 'danger' },
  duplicate_in_file: { word: 'Twice in the file', tone: 'warning' },
};

/** GST state code → name (codes of contract 5.1). */
export function stateText(code: string | null | undefined, states: ReadonlyArray<{ code: string; name: string }>): string | null {
  if (!code) return null;
  const s = states.find((x) => x.code === code);
  return s ? `${s.name} (${code})` : code;
}
