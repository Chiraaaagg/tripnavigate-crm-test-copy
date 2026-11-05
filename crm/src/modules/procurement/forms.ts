import * as z from 'zod/mini';
import { readUuid, rupeesToPaise } from '@/modules/fulfilment/forms';
import type { BeneficiaryInput, CancellationChargeInput, QuoteInput, SupplierEmailInput } from './commands';
import {
  type CancellationDecision,
  type GoAheadDecision,
  type PurchaseEvidenceKind,
  SUPPLIER_EMAIL_BODY_MAX,
  SUPPLIER_EMAIL_MAX_CC,
  SUPPLIER_EMAIL_SUBJECT_MAX,
  type SupplierFields,
  type SupplierServiceType,
} from './contracts';

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
  // Purchase build
  perRoomNightRupees: 'perRoomNightRupees',
  quoteNote: 'quoteNote',
  to: 'to',
  cc: 'cc',
  subject: 'subject',
  body: 'body',
  goAheadRequestId: 'goAheadRequestId',
  decision: 'decision',
  reason: 'reason',
  dealId: 'dealId',
  cancellationId: 'cancellationId',
  keepsRupees: 'keepsRupees',
  refundRupees: 'refundRupees',
  creditNoteEvidenceId: 'creditNoteEvidenceId',
  expectedRevisionNo: 'expectedRevisionNo',
  enabled: 'enabled',
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
  // Purchase build: optional rate per room per night and a short note.
  const perRoomNightPaise = rupeesToPaise(raw(formData, PFIELD.perRoomNightRupees));
  const note = block(formData, PFIELD.quoteNote, 300);
  if (!supplierId || !hotelName || !quotedCostPaise || quotedCostPaise === '0') return bad;
  if ([roomType, mealPlan, holdUntil, cancellationTerms, note].includes(undefined)) return bad;
  if (perRoomNightPaise === undefined || perRoomNightPaise === '0') return bad;
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
      perRoomNightPaise: perRoomNightPaise ?? null,
      note: note ?? null,
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

// ---------------------------------------------------------------------------
// Purchase build (20261130000100..0120)
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/;

function emailAddress(value: string): string | undefined {
  const v = value.trim();
  return v.length <= 254 && EMAIL_RE.test(v) ? v : undefined;
}

/** To, Cc (comma, semicolon or new line separated, at most 10), subject (one line) and message. */
export function parseEmailFields(formData: FormData): Parsed<SupplierEmailInput> {
  const to = emailAddress(raw(formData, PFIELD.to));
  const ccRaw = raw(formData, PFIELD.cc)
    .split(/[,;\n]/)
    .map((v) => v.trim())
    .filter((v) => v !== '');
  const cc: string[] = [];
  for (const c of ccRaw) {
    const ok = emailAddress(c);
    if (!ok) return bad;
    if (!cc.some((x) => x.toLowerCase() === ok.toLowerCase()) && ok.toLowerCase() !== to?.toLowerCase()) cc.push(ok);
  }
  const subject = line(formData, PFIELD.subject, SUPPLIER_EMAIL_SUBJECT_MAX);
  const body = block(formData, PFIELD.body, SUPPLIER_EMAIL_BODY_MAX);
  if (!to || cc.length > SUPPLIER_EMAIL_MAX_CC || !subject || !body) return bad;
  return { ok: true, value: { to, cc, subject, body } };
}

export function parseRateRequestForm(formData: FormData): Parsed<SupplierEmailInput & { taskId: string; supplierId: string; requestId: string }> {
  const taskId = readUuid(formData, PFIELD.taskId);
  const supplierId = readUuid(formData, PFIELD.supplierId);
  const requestId = readRequestId(formData);
  const mail = parseEmailFields(formData);
  if (!taskId || !supplierId || !requestId || !mail.ok) return bad;
  return { ok: true, value: { ...mail.value, taskId, supplierId, requestId } };
}

export function parseBookingRequestForm(
  formData: FormData,
): Parsed<SupplierEmailInput & { taskId: string; expectedCostVersionNo: number; requestId: string }> {
  const taskId = readUuid(formData, PFIELD.taskId);
  const requestId = readRequestId(formData);
  const expectedCostVersionNo = positiveInt(formData, PFIELD.expectedVersionNo, 1);
  const mail = parseEmailFields(formData);
  if (!taskId || !requestId || expectedCostVersionNo === undefined || !mail.ok) return bad;
  return { ok: true, value: { ...mail.value, taskId, expectedCostVersionNo, requestId } };
}

/** A decider's reason: 10 to 500 characters (line breaks allowed); required only to return. */
function decisionReason(formData: FormData, required: boolean): string | null | undefined {
  const reason = block(formData, PFIELD.reason, 500);
  if (reason === undefined) return undefined;
  if (reason === null) return required ? undefined : null;
  return reason.length >= 10 ? reason : undefined;
}

function decision(formData: FormData): 'approve' | 'return' | null {
  const value = raw(formData, PFIELD.decision);
  return value === 'approve' || value === 'return' ? value : null;
}

export function parseGoAheadDecisionForm(formData: FormData): Parsed<{
  goAheadRequestId: string;
  decision: GoAheadDecision;
  reason: string | null;
  expectedRowVersion: number;
  requestId: string;
}> {
  const goAheadRequestId = readUuid(formData, PFIELD.goAheadRequestId);
  const d = decision(formData);
  const expectedRowVersion = positiveInt(formData, PFIELD.rowVersion, 1);
  const requestId = readRequestId(formData);
  if (!goAheadRequestId || !d || expectedRowVersion === undefined || !requestId) return bad;
  const reason = decisionReason(formData, d === 'return');
  if (reason === undefined) return bad;
  return { ok: true, value: { goAheadRequestId, decision: d, reason: d === 'return' ? reason : null, expectedRowVersion, requestId } };
}

export function parseCancellationOpenForm(formData: FormData): Parsed<{ dealId: string; reason: string; requestId: string }> {
  const dealId = readUuid(formData, PFIELD.dealId);
  const requestId = readRequestId(formData);
  const reason = decisionReason(formData, true);
  if (!dealId || !requestId || !reason) return bad;
  return { ok: true, value: { dealId, reason, requestId } };
}

export function parseCancellationChargeForm(formData: FormData): Parsed<CancellationChargeInput> {
  const taskId = readUuid(formData, PFIELD.taskId);
  const requestId = readRequestId(formData);
  const expectedRevision = positiveInt(formData, PFIELD.expectedRevisionNo, 0);
  // Rupees; an empty field is not zero: both amounts are required (0 allowed).
  const keepsPaise = rupeesToPaise(raw(formData, PFIELD.keepsRupees));
  const refundPaise = rupeesToPaise(raw(formData, PFIELD.refundRupees));
  const note = block(formData, PFIELD.note, 500);
  const evidenceRaw = raw(formData, PFIELD.creditNoteEvidenceId).trim();
  const creditNoteEvidenceId = evidenceRaw === '' ? null : readUuid(formData, PFIELD.creditNoteEvidenceId);
  if (!taskId || !requestId || expectedRevision === undefined || !keepsPaise || !refundPaise || note === undefined) return bad;
  if (evidenceRaw !== '' && !creditNoteEvidenceId) return bad;
  return { ok: true, value: { taskId, keepsPaise, refundPaise, note, creditNoteEvidenceId, expectedRevision, requestId } };
}

export function parseCancellationSendForm(formData: FormData): Parsed<{ cancellationId: string; expectedRowVersion: number; requestId: string }> {
  const cancellationId = readUuid(formData, PFIELD.cancellationId);
  const expectedRowVersion = positiveInt(formData, PFIELD.rowVersion, 1);
  const requestId = readRequestId(formData);
  if (!cancellationId || expectedRowVersion === undefined || !requestId) return bad;
  return { ok: true, value: { cancellationId, expectedRowVersion, requestId } };
}

export function parseCancellationDecisionForm(formData: FormData): Parsed<{
  cancellationId: string;
  decision: CancellationDecision;
  reason: string | null;
  expectedRowVersion: number;
  requestId: string;
}> {
  const sent = parseCancellationSendForm(formData);
  const d = decision(formData);
  if (!sent.ok || !d) return bad;
  const reason = decisionReason(formData, d === 'return');
  if (reason === undefined) return bad;
  return { ok: true, value: { ...sent.value, decision: d, reason: d === 'return' ? reason : null } };
}

export function parseEmailSwitchForm(formData: FormData): Parsed<{ enabled: boolean; reason: string }> {
  const enabled = raw(formData, PFIELD.enabled);
  const reason = decisionReason(formData, true);
  if ((enabled !== 'true' && enabled !== 'false') || !reason) return bad;
  return { ok: true, value: { enabled: enabled === 'true', reason } };
}
