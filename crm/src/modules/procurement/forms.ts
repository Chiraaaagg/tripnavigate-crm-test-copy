import * as z from 'zod/mini';
import { readUuid, rupeesToPaise } from '@/modules/fulfilment/forms';
import type { BeneficiaryInput, QuoteInput } from './commands';
import type { PurchaseEvidenceKind, SupplierFields, SupplierServiceType } from './contracts';

/**
 * Pure parsing of Phase 4 form posts. Identity, entity membership and
 * assignee are never read from the form; the database derives them from the
 * session. Amounts are rupees in the form and integer paise in the database
 * (string arithmetic only, shared with Phase 3).
 */

export const PFIELD = {
  taskId: 'taskId',
  supplierId: 'supplierId',
  entityId: 'entityId',
  rowVersion: 'rowVersion',
  requestId: 'requestId',
  quoteId: 'quoteId',
  evidenceId: 'evidenceId',
  expectedVersionNo: 'expectedVersionNo',
  kind: 'kind',
  file: 'file',
  name: 'name',
  serviceTypes: 'serviceTypes',
  city: 'city',
  contactName: 'contactName',
  contactPhone: 'contactPhone',
  contactEmail: 'contactEmail',
  paymentTerms: 'paymentTerms',
  status: 'status',
  hotelName: 'hotelName',
  roomType: 'roomType',
  mealPlan: 'mealPlan',
  quotedCostRupees: 'quotedCostRupees',
  holdUntil: 'holdUntil',
  cancellationTerms: 'cancellationTerms',
  amountRupees: 'amountRupees',
  dueDate: 'dueDate',
  note: 'note',
  reference: 'reference',
  accountHolder: 'accountHolder',
  bankName: 'bankName',
  ifsc: 'ifsc',
  accountNumber: 'accountNumber',
  revisionNo: 'revisionNo',
  versionNo: 'versionNo',
  expectedAssigneeId: 'expectedAssigneeId',
  toUserId: 'toUserId',
} as const;

export const PURCHASE_EVIDENCE_KINDS = ['quote', 'supplier_confirmation', 'other'] as const satisfies readonly PurchaseEvidenceKind[];
const SERVICE_TYPES = ['hotel', 'transfer', 'activity'] as const satisfies readonly SupplierServiceType[];

type Parsed<T> = { ok: true; value: T } | { ok: false };
const bad = { ok: false } as const;

function raw(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/** Trimmed single-line text; '' → null; too long or control characters → undefined. */
function line(formData: FormData, name: string, max: number): string | null | undefined {
  const value = raw(formData, name).trim();
  if (value === '') return null;
  if (value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

/** Multi-line text (tabs/newlines allowed). */
function block(formData: FormData, name: string, max: number): string | null | undefined {
  const value = raw(formData, name).trim();
  if (value === '') return null;
  if (value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

function isoDate(formData: FormData, name: string): string | null | undefined {
  const value = raw(formData, name).trim();
  if (value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : undefined;
}

function positiveInt(formData: FormData, name: string, min = 0): number | undefined {
  const value = raw(formData, name).trim();
  if (!/^\d{1,9}$/.test(value)) return undefined;
  const n = Number(value);
  return n >= min ? n : undefined;
}

export function readRequestId(formData: FormData): string | null {
  return readUuid(formData, PFIELD.requestId);
}

export function readPurchaseEvidenceKind(formData: FormData): PurchaseEvidenceKind | null {
  const value = raw(formData, PFIELD.kind);
  return (PURCHASE_EVIDENCE_KINDS as readonly string[]).includes(value) ? (value as PurchaseEvidenceKind) : null;
}

export function parseSupplierForm(formData: FormData, opts: { allowStatus: boolean }): Parsed<SupplierFields> {
  const name = line(formData, PFIELD.name, 200);
  const types = formData.getAll(PFIELD.serviceTypes).filter((v): v is string => typeof v === 'string');
  const unique = [...new Set(types)];
  if (!name || unique.length === 0 || unique.some((t) => !(SERVICE_TYPES as readonly string[]).includes(t))) return bad;
  const city = line(formData, PFIELD.city, 120);
  const contactName = line(formData, PFIELD.contactName, 120);
  const contactPhone = line(formData, PFIELD.contactPhone, 40);
  const contactEmail = line(formData, PFIELD.contactEmail, 254);
  const paymentTerms = block(formData, PFIELD.paymentTerms, 1000);
  if ([city, contactName, contactPhone, contactEmail, paymentTerms].includes(undefined)) return bad;
  if (contactPhone && !/^[0-9+() -]{6,40}$/.test(contactPhone)) return bad;
  if (contactEmail && !z.email().safeParse(contactEmail).success) return bad;
  const fields: SupplierFields = {
    name,
    serviceTypes: unique.sort() as SupplierServiceType[],
    city: city ?? null,
    contactName: contactName ?? null,
    contactPhone: contactPhone ?? null,
    contactEmail: contactEmail ?? null,
    paymentTerms: paymentTerms ?? null,
  };
  if (opts.allowStatus) {
    const status = raw(formData, PFIELD.status);
    if (status !== 'active' && status !== 'archived') return bad;
    fields.status = status;
  }
  return { ok: true, value: fields };
}

export function parseBeneficiaryForm(formData: FormData): Parsed<BeneficiaryInput> {
  const accountHolder = line(formData, PFIELD.accountHolder, 120);
  const bankName = line(formData, PFIELD.bankName, 120);
  const ifsc = raw(formData, PFIELD.ifsc).trim().toUpperCase();
  const accountNumber = raw(formData, PFIELD.accountNumber).replace(/\s/g, '');
  if (!accountHolder || !bankName || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc) || !/^[0-9]{6,18}$/.test(accountNumber)) return bad;
  return { ok: true, value: { accountHolder, bankName, ifsc, accountNumber } };
}

export function parseQuoteForm(formData: FormData): Parsed<QuoteInput> {
  const supplierId = readUuid(formData, PFIELD.supplierId);
  const hotelName = line(formData, PFIELD.hotelName, 200);
  const roomType = line(formData, PFIELD.roomType, 120);
  const mealPlan = line(formData, PFIELD.mealPlan, 60);
  const quotedCostPaise = rupeesToPaise(raw(formData, PFIELD.quotedCostRupees));
  const holdUntil = isoDate(formData, PFIELD.holdUntil);
  const cancellationTerms = block(formData, PFIELD.cancellationTerms, 2000);
  if (!supplierId || !hotelName || !quotedCostPaise || quotedCostPaise === '0') return bad;
  if ([roomType, mealPlan, holdUntil, cancellationTerms].includes(undefined)) return bad;
  return {
    ok: true,
    value: {
      supplierId,
      hotelName,
      roomType: roomType ?? null,
      mealPlan: mealPlan ?? null,
      quotedCostPaise,
      holdUntil: holdUntil ?? null,
      cancellationTerms: cancellationTerms ?? null,
    },
  };
}

export interface CostForm {
  taskId: string;
  quoteId: string;
  expectedVersionNo: number;
  amountPaise: string;
  dueDate: string | null;
  note: string | null;
  requestId: string;
}

export function parseCostForm(formData: FormData): Parsed<CostForm> {
  const taskId = readUuid(formData, PFIELD.taskId);
  const quoteId = readUuid(formData, PFIELD.quoteId);
  const requestId = readRequestId(formData);
  const expectedVersionNo = positiveInt(formData, PFIELD.expectedVersionNo, 0);
  const amountPaise = rupeesToPaise(raw(formData, PFIELD.amountRupees));
  const dueDate = isoDate(formData, PFIELD.dueDate);
  const note = block(formData, PFIELD.note, 500);
  if (!taskId || !quoteId || !requestId || expectedVersionNo === undefined || !amountPaise || amountPaise === '0') return bad;
  if (dueDate === undefined || note === undefined) return bad;
  return { ok: true, value: { taskId, quoteId, expectedVersionNo, amountPaise, dueDate, note, requestId } };
}

export function parseSupplierConfirmForm(formData: FormData): Parsed<{ taskId: string; expectedVersionNo: number; reference: string }> {
  const taskId = readUuid(formData, PFIELD.taskId);
  const expectedVersionNo = positiveInt(formData, PFIELD.expectedVersionNo, 1);
  const reference = line(formData, PFIELD.reference, 120);
  if (!taskId || expectedVersionNo === undefined || !reference) return bad;
  return { ok: true, value: { taskId, expectedVersionNo, reference } };
}

export function readRowVersion(formData: FormData): number | null {
  return positiveInt(formData, PFIELD.rowVersion, 1) ?? null;
}

/** A positive integer field (revision or cost version number); null when missing or malformed. */
export function readPositiveInt(formData: FormData, name: string): number | null {
  return positiveInt(formData, name, 1) ?? null;
}
