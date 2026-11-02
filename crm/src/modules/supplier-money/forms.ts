import { readUuid, rupeesToPaise } from '@/modules/fulfilment/forms';
import type { DocumentFields, PaymentRequestFields } from './commands';
import {
  type AccountsDocumentTab,
  type AccountsFundingTab,
  type AccountsPaymentTab,
  type PurchasePaymentScope,
  SM_FIELD,
  SUPPLIER_PAYMENT_MODES,
  SUPPLIER_PAYMENT_PARTS,
  type SupplierMoneyEvidenceKind,
  type SupplierPaymentMode,
  type SupplierPaymentPart,
} from './contracts';

/**
 * Pure parsing of supplier money form posts. The actor, entity, supplier,
 * route and funding amount are never read from the form; the database
 * derives them. Amounts are rupees in the form and integer paise in the
 * database (string arithmetic only).
 */

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

function int(formData: FormData, name: string, min: number): number | null {
  const value = raw(formData, name).trim();
  if (!/^\d{1,9}$/.test(value)) return null;
  const n = Number(value);
  return n >= min ? n : null;
}

function checkbox(formData: FormData, name: string): boolean {
  const value = raw(formData, name);
  return value === 'on' || value === 'true' || value === '1';
}

function paise(formData: FormData, name: string): string | null {
  const value = rupeesToPaise(raw(formData, name));
  return value && value !== '0' ? value : null;
}

export function readRequestId(formData: FormData): string | null {
  return readUuid(formData, SM_FIELD.requestId);
}

export function readRowVersion(formData: FormData): number | null {
  return int(formData, SM_FIELD.expectedRowVersion, 1);
}

/** 10–500 characters (reasons and recovery notes). */
export function readReason(formData: FormData, name: string = SM_FIELD.reason): string | null {
  const value = block(formData, name, 500);
  return value && value.length >= 10 ? value : null;
}

export function readEvidenceKind(formData: FormData): SupplierMoneyEvidenceKind | null {
  const value = raw(formData, SM_FIELD.kind);
  return value === 'proforma' || value === 'payment_proof' || value === 'invoice' || value === 'credit_note' ? value : null;
}

export function readDecision<T extends string>(formData: FormData, allowed: readonly T[]): T | null {
  const value = raw(formData, SM_FIELD.decision);
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export function readScope(value: string | undefined): PurchasePaymentScope {
  return value === 'all' ? 'all' : 'mine';
}
export function readPaymentTab(value: string | undefined): AccountsPaymentTab {
  return value === 'to_record' || value === 'to_verify' || value === 'all' ? value : 'to_approve';
}
export function readDocumentTab(value: string | undefined): AccountsDocumentTab {
  return value === 'missing' || value === 'all' ? value : 'to_review';
}
export function readFundingTab(value: string | undefined): AccountsFundingTab {
  return value === 'to_recover' || value === 'all' ? value : 'to_approve';
}

/** The typed values echoed back after a refusal (only what this person typed). */
export function paymentFormValues(formData: FormData): Record<string, string> {
  const keep = [SM_FIELD.part, SM_FIELD.amountRupees, SM_FIELD.dueDate, SM_FIELD.note, SM_FIELD.fundingReason, SM_FIELD.askFunding];
  const out: Record<string, string> = {};
  for (const k of keep) out[k] = raw(formData, k).slice(0, 600);
  return out;
}

export interface PaymentRequestForm {
  /** Task id (create) — for resubmit the payment id is read separately. */
  taskId: string | null;
  paymentId: string | null;
  fields: PaymentRequestFields;
  requestId: string;
}

export function parsePaymentRequestForm(formData: FormData): Parsed<PaymentRequestForm> {
  const taskId = readUuid(formData, SM_FIELD.taskId);
  const paymentId = readUuid(formData, SM_FIELD.paymentId);
  const requestId = readRequestId(formData);
  const expectedCostVersionNo = int(formData, SM_FIELD.expectedCostVersionNo, 1);
  const part = raw(formData, SM_FIELD.part);
  const amountPaise = paise(formData, SM_FIELD.amountRupees);
  const dueDate = isoDate(formData, SM_FIELD.dueDate);
  const note = block(formData, SM_FIELD.note, 500);
  const proformaEvidenceId = readUuid(formData, SM_FIELD.proformaEvidenceId);
  // Review F1: the funding ask is gone; fundingReason is an optional note for Accounts.
  const askFunding = false;
  const typedNote = raw(formData, SM_FIELD.fundingReason).trim();
  const fundingReason = typedNote === '' ? null : readReason(formData, SM_FIELD.fundingReason);
  if (!requestId || (!taskId && !paymentId) || expectedCostVersionNo === null || !amountPaise || !proformaEvidenceId) return bad;
  if (!(SUPPLIER_PAYMENT_PARTS as readonly string[]).includes(part)) return bad;
  if (dueDate === undefined || note === undefined || (typedNote !== '' && !fundingReason)) return bad;
  return {
    ok: true,
    value: {
      taskId,
      paymentId,
      requestId,
      fields: {
        expectedCostVersionNo,
        part: part as SupplierPaymentPart,
        amountPaise,
        dueDate,
        note,
        proformaEvidenceId,
        askFunding,
        fundingReason,
      },
    },
  };
}

export interface RecordForm {
  paymentId: string;
  paidOn: string;
  mode: SupplierPaymentMode;
  bankReference: string;
  proofEvidenceId: string;
  expectedRowVersion: number;
  requestId: string;
}

export function parseRecordForm(formData: FormData): Parsed<RecordForm> {
  const paymentId = readUuid(formData, SM_FIELD.paymentId);
  const paidOn = isoDate(formData, SM_FIELD.paidOn);
  const mode = raw(formData, SM_FIELD.paymentMode);
  const bankReference = line(formData, SM_FIELD.bankReference, 40);
  const proofEvidenceId = readUuid(formData, SM_FIELD.proofEvidenceId);
  const expectedRowVersion = readRowVersion(formData);
  const requestId = readRequestId(formData);
  if (!paymentId || !paidOn || !proofEvidenceId || !expectedRowVersion || !requestId) return bad;
  if (!(SUPPLIER_PAYMENT_MODES as readonly string[]).includes(mode)) return bad;
  if (!bankReference || bankReference.length < 4 || !/^[A-Za-z0-9/. -]+$/.test(bankReference)) return bad;
  return {
    ok: true,
    value: { paymentId, paidOn, mode: mode as SupplierPaymentMode, bankReference, proofEvidenceId, expectedRowVersion, requestId },
  };
}

export interface DocumentForm {
  taskId: string;
  fields: DocumentFields;
  requestId: string;
}

export function parseDocumentForm(formData: FormData): Parsed<DocumentForm> {
  const taskId = readUuid(formData, SM_FIELD.taskId);
  const requestId = readRequestId(formData);
  const kind = raw(formData, SM_FIELD.kind);
  const number = line(formData, SM_FIELD.number, 60);
  const docDate = isoDate(formData, SM_FIELD.docDate);
  const totalPaise = paise(formData, SM_FIELD.totalRupees);
  const evidenceId = readUuid(formData, SM_FIELD.evidenceId);
  if (!taskId || !requestId || (kind !== 'invoice' && kind !== 'credit_note') || !number || !docDate || !totalPaise || !evidenceId) {
    return bad;
  }
  return {
    ok: true,
    value: {
      taskId,
      requestId,
      fields: { kind, number, docDate, totalPaise, gstIncluded: checkbox(formData, SM_FIELD.gstIncluded), evidenceId },
    },
  };
}
