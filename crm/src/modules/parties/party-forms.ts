/*
 * Stored customers (bill-to parties): form parsing and view shaping (Terra,
 * voice-note batch, 24 October 2026). Pure functions; no server imports.
 *
 * The same rules as Bill To (India only this release): GSTIN format and its
 * state prefix only (never a registration check), the unregistered-business
 * reason, Indian mobile or +country phones. The database re-checks all of it.
 * A new or edited customer is always "Not checked" until Accounts checks it.
 */

import { GST_REASON_LIMITS, GST_STATE_CODE, gstinMatchesState, normalisePhone, POSTAL_CODE, EMAIL_SHAPE } from '@/modules/fulfilment/booking-form-model';
import type { BillToType, GstStatus } from '@/modules/fulfilment/booking-form-contract';
import type { PartyCheckStatus, PartyOption } from '@/views/booking-form/vn-types';

/** Input names of the Add customer dialog and the Accounts check screen (luna-vn-props.md). */
export const PARTY_FIELD = {
  dealId: 'dealId',
  requestId: 'requestId',
  partyId: 'partyId',
  partyRowVersion: 'partyRowVersion',
  partyType: 'partyType',
  name: 'name',
  contactPerson: 'contactPerson',
  phone: 'phone',
  email: 'email',
  addressLine1: 'addressLine1',
  addressLine2: 'addressLine2',
  city: 'city',
  stateCode: 'stateCode',
  postalCode: 'postalCode',
  gstStatus: 'gstStatus',
  gstin: 'gstin',
  gstReason: 'gstReason',
  idFile: 'idFile',
  idConsent: 'idConsent',
  documents: 'documents',
  reason: 'reason',
} as const;

const P = PARTY_FIELD;

/** customer_party_create / save p_fields (Atlas shapes v1 §g). */
export interface PartyFields {
  partyType: BillToType;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  stateCode: string | null;
  postalCode: string | null;
  gstStatus: GstStatus | null;
  gstin: string | null;
  gstReason: string | null;
}

export type PartyParse = { ok: true; fields: PartyFields } | { ok: false; fields: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

export function readUuidField(formData: FormData, name: string): string | null {
  const v = str(formData, name);
  return UUID.test(v) ? v.toLowerCase() : null;
}

export function readRowVersionField(formData: FormData, name: string): number | null {
  const v = str(formData, name);
  return /^(0|[1-9][0-9]{0,8})$/.test(v) ? Number(v) : null;
}

/**
 * The customer details of the Add customer dialog (and the Accounts edit).
 * Name and type are needed; address, phone and email are checked when given
 * (Bill To asks for the rest before use). A business needs its GST answer:
 * registered with a GSTIN of its state, or not registered with a reason.
 */
export function parsePartyFields(formData: FormData): PartyParse {
  const bad: string[] = [];
  const typeRaw = str(formData, P.partyType);
  const partyType: BillToType | null = typeRaw === 'personal' || typeRaw === 'business' ? typeRaw : null;
  if (!partyType) bad.push(P.partyType);
  const business = partyType === 'business';
  const line = (name: string, max: number, required = false): string | null => {
    const v = str(formData, name).replace(/\s+/g, ' ');
    if (v === '') {
      if (required) bad.push(name);
      return null;
    }
    if (v.length > max) bad.push(name);
    return v;
  };
  const name = line(P.name, 200, true);
  const contactPerson = business ? line(P.contactPerson, 120) : null;
  const phoneRaw = str(formData, P.phone).replace(/[\s()-]/g, '');
  const phone = phoneRaw === '' ? null : normalisePhone(phoneRaw);
  if (phone === undefined) bad.push(P.phone);
  const emailRaw = str(formData, P.email).toLowerCase();
  const email = emailRaw === '' ? null : emailRaw.length <= 254 && EMAIL_SHAPE.test(emailRaw) ? emailRaw : undefined;
  if (email === undefined) bad.push(P.email);
  const addressLine1 = line(P.addressLine1, 200);
  const addressLine2 = line(P.addressLine2, 200);
  const city = line(P.city, 120);
  const stateRaw = str(formData, P.stateCode);
  const stateCode = stateRaw === '' ? null : GST_STATE_CODE.test(stateRaw) ? stateRaw : undefined;
  if (stateCode === undefined) bad.push(P.stateCode);
  const pinRaw = str(formData, P.postalCode).replace(/\s/g, '');
  const postalCode = pinRaw === '' ? null : POSTAL_CODE.test(pinRaw) ? pinRaw : undefined;
  if (postalCode === undefined) bad.push(P.postalCode);

  let gstStatus: GstStatus | null = null;
  let gstin: string | null = null;
  let gstReason: string | null = null;
  if (business) {
    const s = str(formData, P.gstStatus);
    gstStatus = s === 'registered' || s === 'unregistered' ? s : null;
    if (!gstStatus) bad.push(P.gstStatus);
    if (gstStatus === 'registered') {
      const g = str(formData, P.gstin).toUpperCase().replace(/\s/g, '');
      if (g === '' || !stateCode || !gstinMatchesState(g, stateCode)) bad.push(g === '' || stateCode ? P.gstin : P.stateCode);
      gstin = g || null;
    }
    if (gstStatus === 'unregistered') {
      const r = str(formData, P.gstReason).replace(/\s+/g, ' ');
      if (r.length < GST_REASON_LIMITS.min || r.length > GST_REASON_LIMITS.max) bad.push(P.gstReason);
      gstReason = r || null;
    }
  }
  if (bad.length > 0) return { ok: false, fields: [...new Set(bad)] };
  return {
    ok: true,
    fields: {
      partyType: partyType!,
      name: name!,
      contactPerson,
      phone: phone ?? null,
      email: email ?? null,
      addressLine1,
      addressLine2,
      city,
      stateCode: stateCode ?? null,
      postalCode: postalCode ?? null,
      gstStatus,
      gstin,
      gstReason,
    },
  };
}

/** The reason Accounts gives when returning a customer (10 to 500 characters). */
export function readReturnReason(formData: FormData): string | null {
  const r = str(formData, P.reason).replace(/\s+/g, ' ');
  return r.length >= 10 && r.length <= 500 ? r : null;
}

/** A stored customer as the database reads it (customer_party_get / search, Atlas shapes v1 §g). Missing keys read as empty. */
export interface PartyRecordLike {
  id: string;
  partyType: BillToType;
  name: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  stateCode?: string | null;
  postalCode?: string | null;
  gstStatus?: GstStatus | null;
  gstin?: string | null;
  gstReason?: string | null;
  checkStatus: PartyCheckStatus;
  sourceRef?: string | null;
  importBatchId?: string | null;
  branchName?: string | null;
}

/** "Imported" for a customer that came from a list (it carries the list's ID); null for one added in the CRM. */
export function partySourceLabel(p: Pick<PartyRecordLike, 'sourceRef' | 'importBatchId'>): string | null {
  if (p.importBatchId || p.sourceRef) return 'Imported';
  return null;
}

export function toPartyOption(p: PartyRecordLike): PartyOption {
  return {
    partyId: p.id,
    type: p.partyType,
    name: p.name,
    contactPerson: p.partyType === 'business' ? (p.contactPerson ?? null) : null,
    phone: p.phone ?? null,
    email: p.email ?? null,
    addressLine1: p.addressLine1 ?? '',
    addressLine2: p.addressLine2 ?? null,
    city: p.city ?? '',
    stateCode: p.stateCode ?? '',
    postalCode: p.postalCode ?? '',
    gstStatus: p.partyType === 'business' ? (p.gstStatus ?? (p.gstin ? 'registered' : null)) : null,
    gstin: p.partyType === 'business' ? (p.gstin ?? null) : null,
    gstReason: p.partyType === 'business' ? (p.gstReason ?? null) : null,
    checkStatus: p.checkStatus,
    sourceLabel: partySourceLabel(p),
  };
}

/** Search words: trimmed, single spaces, 2..100 characters (shorter = no search; never a full list). */
export function searchQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const q = raw.replace(/\s+/g, ' ').trim();
  return q.length >= 2 && q.length <= 100 ? q : null;
}

// ---------------------------------------------------------------------------
// History lines on the Accounts check screen (actions, field names, reasons; never values)
// ---------------------------------------------------------------------------

const FIELD_WORD: Record<string, string> = {
  partyType: 'type', name: 'name', contactPerson: 'contact person', phone: 'phone', email: 'email', addressLine1: 'address',
  addressLine2: 'address line 2', city: 'city', stateCode: 'state', postalCode: 'PIN code', gstStatus: 'GST registration', gstin: 'GSTIN', gstReason: 'reason for no GSTIN',
};

const ACTION_WORD: Record<string, string> = {
  'party.created': 'Added',
  'party.updated': 'Details changed by Sales',
  'party.accounts_updated': 'Details changed by Accounts',
  'party.checked': 'Checked by Accounts',
  'party.returned': 'Returned to Sales',
  'party.check_reset': 'Back to Not checked',
  'party.document_stored': 'Document attached',
  'party.document_removed': 'Document removed',
  'party.document_failed': 'Document upload failed',
  'party.document_viewed': 'Document opened',
  'party.document_started': 'Document upload started',
};

export interface PartyHistoryRecord {
  action: string;
  at: string;
  byName: string | null;
  reason: string | null;
  changedFields: string[];
}

/** One plain line per history entry: "Returned to Sales: PIN does not match" / "Details changed by Accounts (address, PIN code)". */
export function partyHistoryLine(h: PartyHistoryRecord): { at: string; byName: string | null; text: string } {
  const what = ACTION_WORD[h.action] ?? 'Changed';
  // "Added" lists no fields (every key is new); a change lists the fields it changed.
  const fields = h.action === 'party.created' ? [] : [...new Set(h.changedFields.map((f) => FIELD_WORD[f]).filter((f): f is string => Boolean(f)))];
  const text = `${what}${fields.length > 0 ? ` (${fields.join(', ')})` : ''}${h.reason ? `: ${h.reason}` : ''}`;
  return { at: h.at, byName: h.byName, text };
}
