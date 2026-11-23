'use server';

import { revalidatePath } from 'next/cache';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { readUuid } from '@/modules/fulfilment/forms';
import { requireStaff } from '@/modules/identity/server/session';
import {
  flightSupplierCreate,
  flightSupplierUpdate,
  SupplierCommandError,
  supplierContactRemove,
  supplierContactSave,
  supplierCreate,
  supplierHotelLink,
  supplierHotelUnlink,
  supplierMasterGet,
  supplierUpdate,
  type SupplierMasterFields,
} from '../commands';
import {
  SUPPLIER_DONE_TEXT,
  SUPPLIER_ERROR_TEXT,
  SUPPLIER_FIELD as F,
  SUPPLIER_FIELD_TEXT,
  SUPPLIER_KINDS,
  SUPPLIER_PATHS,
  SUPPLIER_SERVICE_TYPES,
  type SupplierActionResult,
  type SupplierContactRemoveResult,
  type SupplierContactSaveResult,
  type SupplierErrorCode,
  type SupplierHotelLinkResult,
  type SupplierKind,
  type SupplierMaster,
  type SupplierServiceType,
  type SupplierWriteResult,
} from '../contracts';
import { normaliseCode } from '../validate';

/**
 * Supplier master commands (Accounts phase 2, A1-A7; Addendum L3 shape).
 * Every action: requireStaff(); read the form (never the actor, entity of an
 * existing supplier, or a status the database owns); run the database
 * command under the staff member's OWN session; revalidate the supplier
 * pages. Messages are frozen wording (contracts.ts); database messages never
 * reach the browser and nothing here logs names, GSTIN, PAN or contacts.
 */

type Prev<T> = SupplierActionResult<T> | null;
type Failure = Extract<SupplierActionResult<never>, { ok: false }>;

function fail(code: SupplierErrorCode | 'session', field?: string, values?: Record<string, string>): Failure {
  return {
    ok: false,
    code,
    message: code === 'invalid_input' && field && SUPPLIER_FIELD_TEXT[field] ? SUPPLIER_FIELD_TEXT[field]! : SUPPLIER_ERROR_TEXT[code],
    ...(field ? { field } : {}),
    ...(values ? { values } : {}),
  };
}

/** Known refusals become frozen text; anything else is rethrown without detail (the command may have committed). */
function failFrom(error: unknown, values?: Record<string, string>): Failure {
  if (error instanceof SupplierCommandError && error.code) {
    return fail(error.code, error.code === 'invalid_input' ? (error.hint ?? undefined) : undefined, values);
  }
  throw new Error('The supplier change could not be confirmed. Reload the page to see whether it was saved.');
}

function revalidateSuppliers(supplierId?: string | null): void {
  for (const path of SUPPLIER_PATHS) revalidatePath(path);
  if (supplierId) revalidatePath(`/app/purchase/suppliers/${supplierId}`);
}

function str(formData: FormData, name: string): string | null {
  const v = formData.get(name);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** What the person typed (returned on a refusal so the form shows it again). */
function typed(formData: FormData, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = formData.getAll(n).filter((x): x is string => typeof x === 'string');
    if (v.length > 0) out[n] = v.join(';').slice(0, 600);
  }
  return out;
}

function readRowVersion(formData: FormData, allowZero = false): number | null {
  const raw = str(formData, F.expectedRowVersion);
  if (raw === null || !/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n === 0 && !allowZero ? null : n;
}

const DETAIL_KEYS = [F.name, F.supplierKind, F.serviceTypes, F.city, F.stateCode, F.gstin, F.pan, F.address, F.paymentTerms, F.contactName,
  F.contactPhone, F.contactEmail, F.status] as const;

interface DetailForm {
  name: string | null;
  kind: SupplierKind | null;
  serviceTypes: SupplierServiceType[];
  city: string | null;
  stateCode: string | null;
  gstin: string | null;
  /** Empty = keep the stored PAN on an update (a masked PAN is never sent back). */
  pan: string | null;
  address: string | null;
  paymentTerms: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  status: 'active' | 'archived' | null;
  has: (key: string) => boolean;
}

function readDetails(formData: FormData): DetailForm | { field: string } {
  const kindRaw = str(formData, F.supplierKind);
  if (kindRaw !== null && !(SUPPLIER_KINDS as readonly string[]).includes(kindRaw)) return { field: F.supplierKind };
  const types = [...new Set(formData.getAll(F.serviceTypes).filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))];
  if (types.some((t) => !(SUPPLIER_SERVICE_TYPES as readonly string[]).includes(t))) return { field: F.serviceTypes };
  const status = str(formData, F.status);
  if (status !== null && status !== 'active' && status !== 'archived') return { field: F.status };
  const gstin = str(formData, F.gstin);
  const pan = str(formData, F.pan);
  return {
    name: str(formData, F.name),
    kind: kindRaw as SupplierKind | null,
    serviceTypes: types as SupplierServiceType[],
    city: str(formData, F.city),
    stateCode: str(formData, F.stateCode),
    gstin: gstin === null ? null : normaliseCode(gstin),
    pan: pan === null || /^XXXXX[0-9]{4}X$/.test(normaliseCode(pan)) ? null : normaliseCode(pan),
    address: str(formData, F.address),
    paymentTerms: str(formData, F.paymentTerms),
    contactName: str(formData, F.contactName),
    contactPhone: str(formData, F.contactPhone),
    contactEmail: str(formData, F.contactEmail),
    status: status as 'active' | 'archived' | null,
    has: (key: string) => formData.has(key),
  };
}

function writeMessage(r: SupplierWriteResult, mode: 'create' | 'update', resetWasVerified: boolean): string {
  if (mode === 'create') return SUPPLIER_DONE_TEXT.created;
  return resetWasVerified ? SUPPLIER_DONE_TEXT.updatedReset : SUPPLIER_DONE_TEXT.updated;
}

/**
 * A1 / A3 "Add a supplier". A flight-only supplier is created by Flight
 * (flight_supplier_create, entity from the Flight membership); every other
 * one by Purchase in the chosen company (entityId).
 */
export async function createSupplierAction(_prev: Prev<SupplierWriteResult>, formData: FormData): Promise<SupplierActionResult<SupplierWriteResult>> {
  const staff = await requireStaff();
  const values = typed(formData, DETAIL_KEYS);
  const requestId = readUuid(formData, F.requestId);
  if (!requestId) return fail('invalid_input', F.requestId, values);
  const d = readDetails(formData);
  if ('field' in d) return fail('invalid_input', d.field, values);
  if (!d.name) return fail('invalid_input', F.name, values);
  if (d.serviceTypes.length === 0) return fail('invalid_input', F.serviceTypes, values);
  const master = { supplierKind: d.kind ?? 'direct', gstin: d.gstin, pan: d.pan, stateCode: d.stateCode, address: d.address } as const;
  const rpc = asRpcClient(staff.supabase);
  try {
    let r: SupplierWriteResult;
    if (d.serviceTypes.length === 1 && d.serviceTypes[0] === 'flight') {
      r = await flightSupplierCreate(rpc, { name: d.name, city: d.city, contactName: d.contactName, contactPhone: d.contactPhone,
        contactEmail: d.contactEmail, ...master }, requestId);
    } else {
      const entityId = readUuid(formData, F.entityId);
      if (!entityId) return fail('invalid_input', F.entityId, values);
      if (d.serviceTypes.includes('flight')) return fail('invalid_input', F.serviceTypes, values);
      r = await supplierCreate(rpc, entityId, { name: d.name, serviceTypes: d.serviceTypes, city: d.city, contactName: d.contactName,
        contactPhone: d.contactPhone, contactEmail: d.contactEmail, paymentTerms: d.paymentTerms, ...master });
    }
    revalidateSuppliers(r.supplierId);
    return { ok: true, message: writeMessage(r, 'create', false), data: r };
  } catch (error) {
    return failFrom(error, values);
  }
}

/**
 * A2 / A3 "Save details". The current supplier is read first so keys the
 * form does not carry (contacts are edited separately, payment terms on
 * Flight) keep their stored values; a flight supplier goes to Flight's command.
 */
export async function updateSupplierAction(_prev: Prev<SupplierWriteResult>, formData: FormData): Promise<SupplierActionResult<SupplierWriteResult>> {
  const staff = await requireStaff();
  const values = typed(formData, DETAIL_KEYS);
  const supplierId = readUuid(formData, F.supplierId);
  const expected = readRowVersion(formData);
  if (!supplierId) return fail('invalid_input', F.supplierId, values);
  if (expected === null) return fail('invalid_input', F.expectedRowVersion, values);
  const d = readDetails(formData);
  if ('field' in d) return fail('invalid_input', d.field, values);
  if (!d.name) return fail('invalid_input', F.name, values);
  const rpc = asRpcClient(staff.supabase);
  try {
    const current = await supplierMasterGet(rpc, supplierId);
    if (!current) return fail('not_found', undefined, values);
    const fields = mergeDetails(current, d);
    const isFlight = current.serviceTypes.includes('flight');
    const r = isFlight
      ? await flightSupplierUpdate(rpc, supplierId, expected, flightFields(fields))
      : await supplierUpdate(rpc, supplierId, expected, fields);
    revalidateSuppliers(supplierId);
    return { ok: true, message: writeMessage(r, 'update', current.verification === 'verified'), data: r };
  } catch (error) {
    return failFrom(error, values);
  }
}

/** The form's values over the stored ones (supplier_update replaces the legacy keys it receives). */
function mergeDetails(current: SupplierMaster, d: DetailForm): SupplierMasterFields {
  const keep = <T>(key: string, typedValue: T, stored: T): T => (d.has(key) ? typedValue : stored);
  return {
    name: d.name ?? current.name,
    serviceTypes: d.serviceTypes.length > 0 ? d.serviceTypes : current.serviceTypes,
    city: keep(F.city, d.city, current.city),
    contactName: keep(F.contactName, d.contactName, current.primaryContact?.name ?? null),
    contactPhone: keep(F.contactPhone, d.contactPhone, current.primaryContact?.phone ?? null),
    contactEmail: keep(F.contactEmail, d.contactEmail, current.primaryContact?.email ?? null),
    paymentTerms: keep(F.paymentTerms, d.paymentTerms, current.paymentTerms),
    status: d.status ?? current.status,
    ...(d.has(F.supplierKind) && d.kind ? { supplierKind: d.kind } : {}),
    ...(d.has(F.gstin) ? { gstin: d.gstin } : {}),
    // Empty PAN on an update keeps the stored one (the screen never sends a masked PAN back).
    ...(d.pan !== null ? { pan: d.pan } : {}),
    ...(d.has(F.stateCode) ? { stateCode: d.stateCode } : {}),
    ...(d.has(F.address) ? { address: d.address } : {}),
  };
}

function flightFields(f: SupplierMasterFields) {
  const { serviceTypes: _types, paymentTerms: _terms, ...rest } = f;
  void _types;
  void _terms;
  return rest;
}

const CONTACT_KEYS = [F.name, F.roleLabel, F.phone, F.email, F.isPrimary] as const;

/** A4 "Save contact" (new when contactId is empty; expectedRowVersion 0 for a new one). */
export async function saveSupplierContactAction(_prev: Prev<SupplierContactSaveResult>, formData: FormData): Promise<SupplierActionResult<SupplierContactSaveResult>> {
  const staff = await requireStaff();
  const values = typed(formData, CONTACT_KEYS);
  const supplierId = readUuid(formData, F.supplierId);
  const requestId = readUuid(formData, F.requestId);
  const contactId = str(formData, F.contactId) === null ? null : readUuid(formData, F.contactId);
  const expected = readRowVersion(formData, true);
  if (!supplierId) return fail('invalid_input', F.supplierId, values);
  if (!requestId) return fail('invalid_input', F.requestId, values);
  if (str(formData, F.contactId) !== null && !contactId) return fail('invalid_input', F.contactId, values);
  if (expected === null) return fail('invalid_input', F.expectedRowVersion, values);
  const name = str(formData, F.name);
  if (!name) return fail('invalid_input', F.name, values);
  const primaryRaw = str(formData, F.isPrimary);
  if (primaryRaw !== null && primaryRaw !== 'true' && primaryRaw !== 'false') return fail('invalid_input', F.isPrimary, values);
  try {
    const r = await supplierContactSave(asRpcClient(staff.supabase), {
      supplierId, contactId, expectedRowVersion: expected, requestId,
      fields: { name, roleLabel: str(formData, F.roleLabel), phone: str(formData, F.phone), email: str(formData, F.email),
        ...(primaryRaw !== null ? { isPrimary: primaryRaw === 'true' } : {}) },
    });
    revalidateSuppliers(supplierId);
    return { ok: true, message: SUPPLIER_DONE_TEXT.contactSaved, data: r };
  } catch (error) {
    return failFrom(error, values);
  }
}

/** A5 "Remove contact" with a reason (10-300 characters). */
export async function removeSupplierContactAction(_prev: Prev<SupplierContactRemoveResult>, formData: FormData): Promise<SupplierActionResult<SupplierContactRemoveResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const contactId = readUuid(formData, F.contactId);
  const requestId = readUuid(formData, F.requestId);
  const expected = readRowVersion(formData);
  const reason = (str(formData, F.reason) ?? '').replace(/\s+/g, ' ');
  if (!contactId) return fail('invalid_input', F.contactId, values);
  if (!requestId) return fail('invalid_input', F.requestId, values);
  if (expected === null) return fail('invalid_input', F.expectedRowVersion, values);
  if (reason.length < 10 || reason.length > 300) return fail('invalid_input', F.reason, values);
  try {
    const r = await supplierContactRemove(asRpcClient(staff.supabase), { contactId, expectedRowVersion: expected, reason, requestId });
    revalidateSuppliers();
    return { ok: true, message: SUPPLIER_DONE_TEXT.contactRemoved, data: r };
  } catch (error) {
    return failFrom(error, values);
  }
}

/** A6 "Link hotel" (a hotel picked from the catalogue list). */
export async function linkSupplierHotelAction(_prev: Prev<SupplierHotelLinkResult>, formData: FormData): Promise<SupplierActionResult<SupplierHotelLinkResult>> {
  const staff = await requireStaff();
  const supplierId = readUuid(formData, F.supplierId);
  const hotelId = readUuid(formData, F.hotelId);
  const requestId = readUuid(formData, F.requestId);
  if (!supplierId) return fail('invalid_input', F.supplierId);
  if (!hotelId) return fail('invalid_input', F.hotelId);
  if (!requestId) return fail('invalid_input', F.requestId);
  try {
    const r = await supplierHotelLink(asRpcClient(staff.supabase), { supplierId, hotelId, requestId });
    revalidateSuppliers(supplierId);
    return { ok: true, message: r.outcome === 'existing' ? SUPPLIER_DONE_TEXT.hotelAlreadyLinked : SUPPLIER_DONE_TEXT.hotelLinked, data: r };
  } catch (error) {
    return failFrom(error);
  }
}

/** A7 "Remove hotel link" with a reason (10-300 characters). */
export async function unlinkSupplierHotelAction(_prev: Prev<SupplierHotelLinkResult>, formData: FormData): Promise<SupplierActionResult<SupplierHotelLinkResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const linkId = readUuid(formData, F.linkId);
  const requestId = readUuid(formData, F.requestId);
  const reason = (str(formData, F.reason) ?? '').replace(/\s+/g, ' ');
  if (!linkId) return fail('invalid_input', F.linkId, values);
  if (!requestId) return fail('invalid_input', F.requestId, values);
  if (reason.length < 10 || reason.length > 300) return fail('invalid_input', F.reason, values);
  try {
    const r = await supplierHotelUnlink(asRpcClient(staff.supabase), { linkId, reason, requestId });
    revalidateSuppliers();
    return { ok: true, message: SUPPLIER_DONE_TEXT.hotelUnlinked, data: r };
  } catch (error) {
    return failFrom(error, values);
  }
}
