import { z } from 'zod';
import type { BillingFields, DestinationFields, PolicyFields, ReceiptFields } from './commands';
import type {
  ChequeMarkKind,
  DestinationKind,
  FinanceEvidenceKind,
  PaymentClaimReportFields,
  ReceiptFromClaimFields,
  ReceiptMode,
  RejectionKind,
  ReversalKind,
} from './contracts';

/**
 * Pure parsing of Phase 5A form posts. Identity, entity membership and the
 * collecting staff's rights are never taken from the form; the database
 * derives and re-checks everything. Field rules mirror the SQL so most
 * mistakes are shown next to the field before a round trip, but the database
 * remains the authority.
 *
 * Amounts: rupees with at most two decimals in the form, whole paise as a
 * decimal digit string everywhere else (BigInt arithmetic only, no floats).
 */

/** FormData names; identical to FIN_FIELD in src/views/finance-forms.tsx. */
export const FINANCE_FIELD = {
  // B1.1 advance claims (lead decision 11 October 2026, frozen form names)
  claimId: 'claimId',
  claimMode: 'claimMode',
  claimAmountRupees: 'claimAmountRupees',
  claimPaidOn: 'claimPaidOn',
  claimPayerName: 'claimPayerName',
  claimReference: 'claimReference',
  claimChequeNumber: 'claimChequeNumber',
  claimChequeDate: 'claimChequeDate',
  claimDestinationVersionId: 'claimDestinationVersionId',
  claimNote: 'claimNote',
  /** Claim withdraw and expense review use rowVersion (Book now convention). */
  rowVersion: 'rowVersion',
  mismatchReason: 'mismatchReason',
  // B1.1 expense records
  entryId: 'entryId',
  requestId: 'requestId',
  dealId: 'dealId',
  entityId: 'entityId',
  branchId: 'branchId',
  bookingVersionId: 'bookingVersionId',
  receiptId: 'receiptId',
  depositId: 'depositId',
  reconciliationId: 'reconciliationId',
  expectedRowVersion: 'expectedRowVersion',
  billingName: 'billingName',
  addressLine1: 'addressLine1',
  addressLine2: 'addressLine2',
  city: 'city',
  stateCode: 'stateCode',
  postalCode: 'postalCode',
  gstin: 'gstin',
  // Booking form Bill To (same names as the Book now Bill To form)
  billToType: 'billToType',
  contactPerson: 'contactPerson',
  billingPhone: 'billingPhone',
  billingEmail: 'billingEmail',
  gstStatus: 'gstStatus',
  gstReason: 'gstReason',
  reason: 'reason',
  mode: 'mode',
  amountRupees: 'amountRupees',
  receivedOn: 'receivedOn',
  collectorUserId: 'collectorUserId',
  payerName: 'payerName',
  payerPan: 'payerPan',
  payerMobile: 'payerMobile',
  reference: 'reference',
  micrCode: 'micrCode',
  chequeNumber: 'chequeNumber',
  chequeDate: 'chequeDate',
  accountPayee: 'accountPayee',
  correctsReceiptId: 'correctsReceiptId',
  note: 'note',
  kind: 'kind',
  outcomeDate: 'outcomeDate',
  file: 'file',
  receiptIds: 'receiptIds',
  depositedOn: 'depositedOn',
  bankReference: 'bankReference',
  businessDate: 'businessDate',
  countedRupees: 'countedRupees',
  receiptMaxRupees: 'receiptMaxRupees',
  cashPayerDayCapRupees: 'cashPayerDayCapRupees',
  cashTripCapRupees: 'cashTripCapRupees',
  cashDepositDays: 'cashDepositDays',
  reconciliationRequired: 'reconciliationRequired',
  effectiveAt: 'effectiveAt',
  destinationVersionId: 'destinationVersionId',
  destinationId: 'destinationId',
  versionId: 'versionId',
  destinationKind: 'destinationKind',
  label: 'label',
  holderName: 'holderName',
  bankName: 'bankName',
  accountNumber: 'accountNumber',
  ifsc: 'ifsc',
  payeeName: 'payeeName',
  upiId: 'upiId',
} as const;

const F = FINANCE_FIELD;

/** Result every Phase 5A server action returns (matches the views' FinanceActionState). */
export interface FinanceActionState {
  status: 'idle' | 'ok' | 'error';
  message?: string;
  fieldErrors?: Record<string, string>;
  /** Refusal token when the database refused (for tests and logs; the message is what staff read). */
  code?: string;
}

export const INITIAL_FINANCE_ACTION_STATE: FinanceActionState = { status: 'idle' };

export type FieldErrors = Record<string, string>;
export type Parsed<T> = { ok: true; value: T } | { ok: false; fieldErrors: FieldErrors };

// ---------------------------------------------------------------------------
// Money and dates
// ---------------------------------------------------------------------------

/**
 * "1,23,456.5" -> "12345650" (whole paise). Accepts an optional leading ₹,
 * commas and spaces as grouping. '' -> null; anything else -> undefined.
 * At most 16 rupee digits (well inside bigint), at most two decimals.
 */
export function rupeesToPaise(raw: string | null | undefined): string | null | undefined {
  const value = (raw ?? '').trim().replace(/^₹\s*/, '').replace(/[,\s]/g, '');
  if (value === '') return null;
  const match = /^(\d{1,16})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return undefined;
  const paise = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  return paise.toString();
}

/** Whole paise -> rupee input text ("12345650" -> "123456.50"). */
export function paiseToRupees(paise: string | null | undefined): string {
  if (paise == null || !/^-?\d+$/.test(paise)) return '';
  const negative = paise.startsWith('-');
  const v = BigInt(negative ? paise.slice(1) : paise);
  return `${negative ? '-' : ''}${(v / 100n).toString()}.${(v % 100n).toString().padStart(2, '0')}`;
}

/** en-IN display: "12345650" -> "₹1,23,456.50". */
export function formatPaise(paise: string): string {
  if (!/^-?\d+$/.test(paise)) return '';
  const negative = paise.startsWith('-');
  const v = BigInt(negative ? paise.slice(1) : paise);
  const rupees = (v / 100n).toString();
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${negative ? '-' : ''}₹${grouped}.${(v % 100n).toString().padStart(2, '0')}`;
}

/** Today's date in Asia/Kolkata (UTC+05:30, no daylight saving). */
export function istToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// ---------------------------------------------------------------------------
// Field readers
// ---------------------------------------------------------------------------

function raw(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/** Trimmed single line; '' -> null; too long/short or control characters -> undefined. */
function line(formData: FormData, name: string, min: number, max: number): string | null | undefined {
  const value = raw(formData, name).trim();
  if (value === '') return null;
  if (value.length < min || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

/** Multi-line text (tabs/newlines allowed). */
function block(formData: FormData, name: string, min: number, max: number): string | null | undefined {
  const value = raw(formData, name).trim();
  if (value === '') return null;
  if (value.length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

export function readUuidField(formData: FormData, name: string): string | null {
  const parsed = z.uuid().safeParse(raw(formData, name).trim());
  return parsed.success ? parsed.data.toLowerCase() : null;
}

export function readRequestId(formData: FormData): string | null {
  return readUuidField(formData, F.requestId);
}

function nonNegativeInt(formData: FormData, name: string): number | null {
  const value = raw(formData, name).trim();
  if (!/^\d{1,9}$/.test(value)) return null;
  return Number(value);
}

export function readExpectedRowVersion(formData: FormData): number | null {
  return nonNegativeInt(formData, F.expectedRowVersion);
}

function errorsOf(errors: FieldErrors): { ok: false; fieldErrors: FieldErrors } | null {
  return Object.keys(errors).length > 0 ? { ok: false, fieldErrors: errors } : null;
}

const REASON_TEXT = 'Write a reason of 10 to 500 characters.';

/** Required reason 10..500 (contract). */
export function parseReason(formData: FormData, name: string = F.reason): Parsed<string> {
  const reason = block(formData, name, 10, 500);
  if (!reason) return { ok: false, fieldErrors: { [name]: REASON_TEXT } };
  return { ok: true, value: reason };
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export const STATE_CODE_PATTERN = /^(0[1-9]|[12][0-9]|3[0-8]|97)$/;
export const POSTAL_CODE_PATTERN = /^[1-9][0-9]{5}$/;
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function parseBillingForm(formData: FormData): Parsed<BillingFields> {
  const errors: FieldErrors = {};
  const billingName = line(formData, F.billingName, 1, 200);
  const addressLine1 = line(formData, F.addressLine1, 1, 200);
  const addressLine2 = line(formData, F.addressLine2, 1, 200);
  const city = line(formData, F.city, 1, 120);
  const stateCode = raw(formData, F.stateCode).trim();
  const postalCode = raw(formData, F.postalCode).replace(/\s/g, '');
  const gstinRaw = raw(formData, F.gstin).trim().toUpperCase();
  if (!billingName) errors[F.billingName] = 'Enter the billing name (up to 200 characters).';
  if (!addressLine1) errors[F.addressLine1] = 'Enter the first address line (up to 200 characters).';
  if (addressLine2 === undefined) errors[F.addressLine2] = 'Keep the second address line under 200 characters.';
  if (!city) errors[F.city] = 'Enter the city (up to 120 characters).';
  if (!STATE_CODE_PATTERN.test(stateCode)) errors[F.stateCode] = 'Choose the GST state code (01 to 38, or 97).';
  if (!POSTAL_CODE_PATTERN.test(postalCode)) errors[F.postalCode] = 'Enter the 6-digit PIN code.';
  if (gstinRaw !== '' && !GSTIN_PATTERN.test(gstinRaw)) errors[F.gstin] = 'Enter a 15-character GSTIN, or leave it empty.';
  else if (gstinRaw !== '' && gstinRaw.slice(0, 2) !== stateCode) errors[F.gstin] = 'The GSTIN must start with the state code.';
  const billTo = formData.has(F.billToType) ? parseBillToExtras(formData, errors, gstinRaw) : null;
  const failed = errorsOf(errors);
  if (failed) return failed;
  return {
    ok: true,
    value: {
      billingName: billingName!,
      addressLine1: addressLine1!,
      addressLine2: addressLine2 ?? null,
      city: city!,
      stateCode,
      postalCode,
      // An unregistered business never reaches here with a GSTIN (refused above).
      gstin: gstinRaw === '' ? null : gstinRaw,
      ...(billTo ?? {}),
    },
  };
}

const INDIAN_MOBILE = /^[6-9][0-9]{9}$/;
const INTERNATIONAL_PHONE = /^\+[1-9][0-9]{6,14}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Booking form Bill To keys, read only when the Accounts form posts them.
 * Accounts may switch a business between GST registered and not registered:
 * registered keeps the GSTIN (checked against the state above); not
 * registered needs a reason (10 to 500 characters) and stores no GSTIN, so a
 * GSTIN typed for an unregistered business is a clear choice, not a dead end.
 */
function parseBillToExtras(formData: FormData, errors: FieldErrors, gstin: string): Required<Pick<BillingFields, 'billToType' | 'contactPerson' | 'phone' | 'email' | 'gstStatus' | 'gstReason'>> | null {
  const typeRaw = raw(formData, F.billToType).trim();
  if (typeRaw !== 'personal' && typeRaw !== 'business') {
    errors[F.billToType] = 'Choose Personal or Business.';
    return null;
  }
  const business = typeRaw === 'business';
  const contactPerson = business ? line(formData, F.contactPerson, 1, 120) : null;
  if (contactPerson === undefined) errors[F.contactPerson] = 'Keep the contact name under 120 characters.';
  const phoneRaw = raw(formData, F.billingPhone).replace(/[\s()-]/g, '');
  const local = phoneRaw.replace(/^(\+91|91(?=\d{10}$)|0(?=\d{10}$))/, '');
  const phone = phoneRaw === '' ? null : INDIAN_MOBILE.test(local) ? local : INTERNATIONAL_PHONE.test(phoneRaw) ? phoneRaw : undefined;
  if (phone === undefined) errors[F.billingPhone] = 'Enter a 10-digit Indian mobile number, or a number starting with + and the country code.';
  const emailRaw = raw(formData, F.billingEmail).trim().toLowerCase();
  const email = emailRaw === '' ? null : emailRaw.length <= 254 && EMAIL.test(emailRaw) ? emailRaw : undefined;
  if (email === undefined) errors[F.billingEmail] = 'Check the billing email.';
  const statusRaw = raw(formData, F.gstStatus).trim();
  const gstStatus = !business || statusRaw === '' ? null : statusRaw === 'registered' || statusRaw === 'unregistered' ? statusRaw : undefined;
  if (gstStatus === undefined) errors[F.gstStatus] = 'Choose GST registered or not registered.';
  let gstReason: string | null = null;
  if (gstStatus === 'unregistered') {
    const reason = block(formData, F.gstReason, 10, 500);
    if (!reason) errors[F.gstReason] = 'Record why the business has no GSTIN (10 to 500 characters).';
    else gstReason = reason;
    if (gstin !== '') errors[F.gstin] = 'A business that is not GST registered has no GSTIN. Clear the GSTIN, or choose GST registered.';
  }
  if (gstStatus === 'registered' && gstin === '') errors[F.gstin] = 'This business is GST registered. Enter the GSTIN, or choose not registered.';
  return { billToType: typeRaw, contactPerson: contactPerson ?? null, phone: phone ?? null, email: email ?? null, gstStatus: gstStatus ?? null, gstReason };
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export const RECEIPT_MODE_VALUES = ['bank_transfer', 'upi', 'cash', 'cheque'] as const satisfies readonly ReceiptMode[];
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const REFERENCE_PATTERN = /^[A-Za-z0-9/-]{6,40}$/;
export const MICR_PATTERN = /^[0-9]{9}$/;
export const CHEQUE_NUMBER_PATTERN = /^[0-9]{6}$/;

/** Mobile after removing spaces and a +91 or leading 0; null when empty; undefined when invalid. */
export function normaliseMobile(value: string): string | null | undefined {
  if (value.trim() === '') return null;
  let v = value.replace(/ /g, '');
  if (v.startsWith('+91')) v = v.slice(3);
  else if (v.startsWith('0')) v = v.slice(1);
  return /^[6-9][0-9]{9}$/.test(v) ? v : undefined;
}

export interface ReceiptForm {
  dealId: string;
  requestId: string;
  fields: ReceiptFields;
}

export function parseReceiptForm(formData: FormData, today: string = istToday()): Parsed<ReceiptForm> {
  const errors: FieldErrors = {};
  const dealId = readUuidField(formData, F.dealId);
  const requestId = readRequestId(formData);
  const modeRaw = raw(formData, F.mode);
  const mode = (RECEIPT_MODE_VALUES as readonly string[]).includes(modeRaw) ? (modeRaw as ReceiptMode) : null;
  if (!mode) errors[F.mode] = 'Choose how the money was received.';

  const amountPaise = rupeesToPaise(raw(formData, F.amountRupees));
  if (!amountPaise || amountPaise === '0') errors[F.amountRupees] = 'Enter the amount in rupees, with at most two decimals.';

  const receivedOn = raw(formData, F.receivedOn).trim();
  if (!validDate(receivedOn) || receivedOn > today || receivedOn < addDays(today, -30)) {
    errors[F.receivedOn] = 'Enter the date the money arrived: today or up to 30 days ago.';
  }

  const branchId = readUuidField(formData, F.branchId);
  if (!branchId) errors[F.branchId] = 'Choose the collecting branch.';

  const collectorRaw = raw(formData, F.collectorUserId).trim();
  const collectorUserId = readUuidField(formData, F.collectorUserId);
  if (mode === 'cash' && !collectorUserId) errors[F.collectorUserId] = 'Choose who collected the cash.';

  const payerName = line(formData, F.payerName, 1, 200);
  if (!payerName) errors[F.payerName] = 'Enter the payer name (up to 200 characters).';
  const pan = raw(formData, F.payerPan).trim().toUpperCase();
  if (pan !== '' && !PAN_PATTERN.test(pan)) errors[F.payerPan] = 'Enter a 10-character PAN like ABCDE1234F, or leave it empty.';
  const mobile = normaliseMobile(raw(formData, F.payerMobile));
  if (mobile === undefined) errors[F.payerMobile] = 'Enter a 10-digit Indian mobile number, or leave it empty.';
  if (pan === '' && mobile === null) errors[F.payerPan] ??= 'Enter the payer PAN or mobile number (at least one).';

  const reference = raw(formData, F.reference).trim();
  if ((mode === 'bank_transfer' || mode === 'upi') && !REFERENCE_PATTERN.test(reference)) {
    errors[F.reference] = 'Enter the bank or UPI reference: 6 to 40 letters, digits, / or -.';
  }

  const micr = raw(formData, F.micrCode).trim();
  const chequeNumber = raw(formData, F.chequeNumber).trim();
  const chequeDate = raw(formData, F.chequeDate).trim();
  const accountPayee = raw(formData, F.accountPayee) === 'true' || raw(formData, F.accountPayee) === 'on';
  if (mode === 'cheque') {
    if (!MICR_PATTERN.test(micr)) errors[F.micrCode] = 'Enter the 9-digit MICR code.';
    if (!CHEQUE_NUMBER_PATTERN.test(chequeNumber)) errors[F.chequeNumber] = 'Enter the 6-digit cheque number.';
    if (!validDate(chequeDate) || chequeDate < addDays(today, -90) || chequeDate > addDays(today, 90)) {
      errors[F.chequeDate] = 'Enter the cheque date, within 90 days of today.';
    }
    if (!accountPayee) errors[F.accountPayee] = 'Only account-payee cheques are accepted.';
  }

  const bookingRaw = raw(formData, F.bookingVersionId).trim();
  const bookingVersionId = readUuidField(formData, F.bookingVersionId);
  if (bookingRaw !== '' && !bookingVersionId) errors[F.bookingVersionId] = 'Choose the booking again.';
  const correctsRaw = raw(formData, F.correctsReceiptId).trim();
  const correctsReceiptId = readUuidField(formData, F.correctsReceiptId);
  if (correctsRaw !== '' && !correctsReceiptId) errors[F.correctsReceiptId] = 'Choose the receipt being corrected again.';
  const note = block(formData, F.note, 1, 500);
  if (note === undefined) errors[F.note] = 'Keep the note under 500 characters.';
  if (collectorRaw !== '' && !collectorUserId) errors[F.collectorUserId] = 'Choose who collected the cash.';
  const destinationVersionId = readUuidField(formData, F.destinationVersionId);
  if ((mode === 'bank_transfer' || mode === 'upi') && !destinationVersionId) {
    errors[F.destinationVersionId] = 'Choose the approved company account the money was paid into.';
  }

  if (!dealId || !requestId) errors._form = 'This form is out of date. Reload the page.';
  const failed = errorsOf(errors);
  if (failed) return failed;
  const isCheque = mode === 'cheque';
  const isBank = mode === 'bank_transfer' || mode === 'upi';
  return {
    ok: true,
    value: {
      dealId: dealId!,
      requestId: requestId!,
      fields: {
        mode: mode!,
        amountPaise: amountPaise!,
        receivedOn,
        branchId: branchId!,
        collectorUserId: mode === 'cash' ? collectorUserId : null,
        payerName: payerName!,
        payerPan: pan === '' ? null : pan,
        payerMobile: mobile ?? null,
        reference: isBank ? reference : null,
        micrCode: isCheque ? micr : null,
        chequeNumber: isCheque ? chequeNumber : null,
        chequeDate: isCheque ? chequeDate : null,
        accountPayee: isCheque ? true : null,
        bookingVersionId,
        correctsReceiptId,
        note: note ?? null,
        destinationVersionId: isBank ? destinationVersionId : null,
      },
    },
  };
}

export function parseRejectionKind(formData: FormData): RejectionKind | null {
  const v = raw(formData, F.kind);
  return v === 'not_received' || v === 'data_error' ? v : null;
}

export function parseReversalKind(formData: FormData): ReversalKind | null {
  const v = raw(formData, F.kind);
  return v === 'bank_return' || v === 'not_received' || v === 'data_error' ? v : null;
}

export function parseChequeMarkKind(formData: FormData): ChequeMarkKind | null {
  const v = raw(formData, F.kind);
  return v === 'bounced' || v === 'stopped' || v === 'cancelled' ? v : null;
}

export function parseEvidenceKind(formData: FormData): FinanceEvidenceKind | null {
  const v = raw(formData, F.kind);
  return v === 'bank_proof' || v === 'cheque_image' || v === 'deposit_slip' ? v : null;
}

/** Outcome date: a valid date not after today (the database checks the cheque-date window). */
export function parseOutcomeDate(formData: FormData, today: string = istToday()): Parsed<string> {
  const v = raw(formData, F.outcomeDate).trim();
  if (!validDate(v) || v > today) return { ok: false, fieldErrors: { [F.outcomeDate]: 'Enter the bank outcome date (not in the future).' } };
  return { ok: true, value: v };
}

/** Cheque note: required 10..500 for a cancelled cheque, otherwise optional 10..500. */
export function parseChequeNote(formData: FormData, kind: ChequeMarkKind): Parsed<string | null> {
  const note = block(formData, F.note, 10, 500);
  if (note === undefined || (kind === 'cancelled' && !note)) {
    return { ok: false, fieldErrors: { [F.note]: kind === 'cancelled' ? 'Explain the cancellation in 10 to 500 characters.' : 'Keep the note between 10 and 500 characters.' } };
  }
  return { ok: true, value: note ?? null };
}

// ---------------------------------------------------------------------------
// Cash custody and reconciliation
// ---------------------------------------------------------------------------

export interface DepositForm {
  branchId: string;
  receiptIds: string[];
  depositedOn: string;
  bankReference: string;
  requestId: string;
}

export function parseDepositForm(formData: FormData, today: string = istToday()): Parsed<DepositForm> {
  const errors: FieldErrors = {};
  const branchId = readUuidField(formData, F.branchId);
  const requestId = readRequestId(formData);
  const ids = formData
    .getAll(F.receiptIds)
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().toLowerCase());
  const unique = [...new Set(ids)];
  if (unique.length === 0 || unique.length > 200 || unique.some((id) => !z.uuid().safeParse(id).success)) {
    errors[F.receiptIds] = 'Tick at least one cash receipt.';
  }
  const depositedOn = raw(formData, F.depositedOn).trim();
  if (!validDate(depositedOn) || depositedOn > today) errors[F.depositedOn] = 'Enter the deposit date (not in the future).';
  const bankReference = raw(formData, F.bankReference).trim();
  if (!/^[A-Za-z0-9/ .-]{3,60}$/.test(bankReference)) {
    errors[F.bankReference] = 'Enter the slip reference: 3 to 60 letters, digits, spaces, /, . or -.';
  }
  if (!branchId || !requestId) errors._form = 'This form is out of date. Reload the page.';
  const failed = errorsOf(errors);
  if (failed) return failed;
  return { ok: true, value: { branchId: branchId!, receiptIds: unique.sort(), depositedOn, bankReference, requestId: requestId! } };
}

export interface ReconciliationForm {
  branchId: string;
  businessDate: string;
  countedPaise: string;
  note: string | null;
  requestId: string;
}

export function parseReconciliationForm(formData: FormData, today: string = istToday()): Parsed<ReconciliationForm> {
  const errors: FieldErrors = {};
  const branchId = readUuidField(formData, F.branchId);
  const requestId = readRequestId(formData);
  const businessDate = raw(formData, F.businessDate).trim();
  // The database permits old outstanding obligations and stale replacements.
  // It checks eligibility under the branch lock; the form only checks date shape/future.
  if (!validDate(businessDate) || businessDate > today) {
    errors[F.businessDate] = 'Enter a valid business date (not in the future).';
  }
  const countedPaise = rupeesToPaise(raw(formData, F.countedRupees));
  if (countedPaise == null) errors[F.countedRupees] = 'Enter the cash counted, in rupees (0 if none).';
  const note = block(formData, F.note, 10, 500);
  if (note === undefined) errors[F.note] = 'Write the note in 10 to 500 characters.';
  if (!branchId || !requestId) errors._form = 'This form is out of date. Reload the page.';
  const failed = errorsOf(errors);
  if (failed) return failed;
  return { ok: true, value: { branchId: branchId!, businessDate, countedPaise: countedPaise!, note: note ?? null, requestId: requestId! } };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface PolicyForm {
  entityId: string;
  fields: PolicyFields;
  /** ISO instant, or null for "effective now". */
  effectiveAt: string | null;
  reason: string;
  requestId: string;
}

/** Grace for an "effective now" time typed a few minutes before submit. */
const NOW_GRACE_MS = 15 * 60_000;

/**
 * datetime-local text (IST wall clock, "YYYY-MM-DDTHH:mm") -> ISO instant.
 * A time at or before now (within 15 minutes) means "now" (null) so the
 * database applies its own transaction time. Earlier times are refused.
 */
export function parseIstDateTime(value: string, now: Date = new Date()): string | null | undefined {
  const v = value.trim();
  if (v === '') return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (!m || !validDate(m[1]!) || Number(m[2]) > 23 || Number(m[3]) > 59) return undefined;
  const instant = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}+05:30`);
  if (Number.isNaN(instant.getTime())) return undefined;
  if (instant.getTime() <= now.getTime()) return now.getTime() - instant.getTime() <= NOW_GRACE_MS ? null : undefined;
  return instant.toISOString();
}

export function parsePolicyForm(formData: FormData, now: Date = new Date()): Parsed<PolicyForm> {
  const errors: FieldErrors = {};
  const entityId = readUuidField(formData, F.entityId);
  const requestId = readRequestId(formData);
  const fields: PolicyFields = {};
  const receiptMax = rupeesToPaise(raw(formData, F.receiptMaxRupees));
  if (receiptMax === undefined || receiptMax === '0') errors[F.receiptMaxRupees] = 'Enter the largest single receipt in rupees.';
  else if (receiptMax) fields.receiptMaxPaise = receiptMax;
  const payerCap = rupeesToPaise(raw(formData, F.cashPayerDayCapRupees));
  if (payerCap === undefined) errors[F.cashPayerDayCapRupees] = 'Enter the cash limit per payer per day in rupees (0 turns cash off).';
  else if (payerCap) fields.cashPayerDayCapPaise = payerCap;
  const tripCap = rupeesToPaise(raw(formData, F.cashTripCapRupees));
  if (tripCap === undefined) errors[F.cashTripCapRupees] = 'Enter the cash limit per trip in rupees (0 turns cash off).';
  else if (tripCap) fields.cashTripCapPaise = tripCap;
  const daysRaw = raw(formData, F.cashDepositDays).trim();
  if (daysRaw !== '') {
    if (!/^[1-7]$/.test(daysRaw)) errors[F.cashDepositDays] = 'Enter 1 to 7 working days.';
    else fields.cashDepositDays = Number(daysRaw);
  }
  // A checkbox: present means required, absent means not required.
  const recon = raw(formData, F.reconciliationRequired);
  fields.reconciliationRequired = recon === 'true' || recon === 'on';
  const effectiveAt = parseIstDateTime(raw(formData, F.effectiveAt), now);
  if (effectiveAt === undefined) errors[F.effectiveAt] = 'Choose now or a later time (IST), up to 90 days ahead.';
  else if (effectiveAt && Date.parse(effectiveAt) > now.getTime() + 90 * 86_400_000) {
    errors[F.effectiveAt] = 'Choose a time within 90 days.';
  }
  const reason = block(formData, F.reason, 10, 500);
  if (!reason) errors[F.reason] = REASON_TEXT;
  if (!entityId || !requestId) errors._form = 'This form is out of date. Reload the page.';
  const failed = errorsOf(errors);
  if (failed) return failed;
  return { ok: true, value: { entityId: entityId!, fields, effectiveAt: effectiveAt ?? null, reason: reason!, requestId: requestId! } };
}

// ---------------------------------------------------------------------------
// Stage 2: company destinations (same syntax rules as the database; the
// database stays the authority and never claims bank verification)
// ---------------------------------------------------------------------------

const ACCOUNT_NUMBER_PATTERN = /^[0-9]{9,18}$/;
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI_PATTERN = /^[a-z0-9._-]{2,100}@[a-z]{2,64}$/;

export interface DestinationForm {
  entityId: string;
  destinationId: string | null;
  expectedRowVersion: number | null;
  requestId: string;
  fields: DestinationFields;
}

/** Add (no destinationId: kind and label required) or replace/correct (destinationId and expectedRowVersion). */
export function parseDestinationForm(formData: FormData): Parsed<DestinationForm> {
  const errors: FieldErrors = {};
  const entityId = readUuidField(formData, F.entityId);
  const requestId = readRequestId(formData);
  const destinationId = readUuidField(formData, F.destinationId);
  const expectedRowVersion = destinationId ? readExpectedRowVersion(formData) : null;
  const fields: DestinationFields = {};
  let kind: DestinationKind | null;
  if (destinationId) {
    const k = raw(formData, F.destinationKind);
    kind = k === 'bank' || k === 'upi' ? k : null;
  } else {
    const k = raw(formData, F.destinationKind);
    kind = k === 'bank' || k === 'upi' ? k : null;
    if (!kind) errors[F.destinationKind] = 'Choose bank account or UPI ID.';
    const label = line(formData, F.label, 1, 80);
    if (!label || /[0-9]{6,}/.test(label.replace(/[\s./_-]/g, '')) || label.includes('@')) {
      errors[F.label] = 'Enter a short name of up to 80 characters, without account numbers or UPI IDs.';
    }
    if (kind) fields.kind = kind;
    if (label) fields.label = label;
  }
  if (kind === 'bank') {
    const holderName = line(formData, F.holderName, 1, 120);
    if (!holderName) errors[F.holderName] = 'Enter the account holder name exactly as the bank shows it.';
    const bankName = line(formData, F.bankName, 1, 120);
    if (!bankName) errors[F.bankName] = 'Enter the bank name.';
    const accountNumber = raw(formData, F.accountNumber).replace(/\s/g, '');
    if (!ACCOUNT_NUMBER_PATTERN.test(accountNumber)) errors[F.accountNumber] = 'Enter the account number: 9 to 18 digits, leading zeros kept.';
    const ifsc = raw(formData, F.ifsc).trim().toUpperCase();
    if (!IFSC_PATTERN.test(ifsc)) errors[F.ifsc] = 'Enter the 11-character IFSC, like ABCD0123456.';
    Object.assign(fields, { holderName: holderName ?? undefined, bankName: bankName ?? undefined, accountNumber, ifsc });
  } else if (kind === 'upi') {
    const payeeName = line(formData, F.payeeName, 1, 120);
    if (!payeeName) errors[F.payeeName] = 'Enter the payee name the UPI app shows.';
    const upiId = raw(formData, F.upiId).trim().toLowerCase();
    if (!UPI_PATTERN.test(upiId)) errors[F.upiId] = 'Enter the UPI ID, like name@bank.';
    Object.assign(fields, { payeeName: payeeName ?? undefined, upiId });
  } else if (destinationId) {
    errors._form = 'This form is out of date. Reload the page.';
  }
  if (!entityId || !requestId || (destinationId && expectedRowVersion === null)) errors._form = 'This form is out of date. Reload the page.';
  const failed = errorsOf(errors);
  if (failed) return failed;
  return { ok: true, value: { entityId: entityId!, destinationId, expectedRowVersion, requestId: requestId!, fields } };
}

// ===========================================================================
// B1.1: advance claims and expense records (frozen form names: FINANCE_FIELD
// claim* keys, claimId, rowVersion, mismatchReason, entryId)
// ===========================================================================

export interface ClaimReportForm {
  dealId: string;
  requestId: string;
  fields: PaymentClaimReportFields;
}

/**
 * Sales "Report this payment to Accounts". Mirrors payment_claim_report's
 * field rules (appendix B §2.1); the database checks again, including the
 * receipt maximum, the selling total and duplicates.
 */
export function parseClaimReportForm(formData: FormData, today: string = istToday()): Parsed<ClaimReportForm> {
  const errors: FieldErrors = {};
  const dealId = readUuidField(formData, F.dealId);
  const requestId = readRequestId(formData);
  const modeRaw = raw(formData, F.claimMode);
  const mode = (RECEIPT_MODE_VALUES as readonly string[]).includes(modeRaw) ? (modeRaw as ReceiptMode) : null;
  if (!mode) errors[F.claimMode] = 'Choose how the customer says they paid.';
  const amountPaise = rupeesToPaise(raw(formData, F.claimAmountRupees));
  if (!amountPaise || amountPaise === '0') errors[F.claimAmountRupees] = 'Enter the amount in rupees, with at most two decimals.';
  const paidOn = raw(formData, F.claimPaidOn).trim();
  if (!validDate(paidOn) || paidOn > today || paidOn < addDays(today, -365)) {
    errors[F.claimPaidOn] = 'Enter the date the customer paid: today or within the last year.';
  }
  const payerName = line(formData, F.claimPayerName, 1, 200);
  if (!payerName) errors[F.claimPayerName] = 'Enter who paid (up to 200 characters).';
  const isBank = mode === 'bank_transfer' || mode === 'upi';
  const isCheque = mode === 'cheque';
  const reference = raw(formData, F.claimReference).trim();
  if (isBank && !REFERENCE_PATTERN.test(reference)) errors[F.claimReference] = 'Enter the bank or UPI reference: 6 to 40 letters, digits, / or -.';
  if (!isBank && reference !== '') errors[F.claimReference] = 'A reference is only for bank transfer or UPI.';
  const destinationVersionId = readUuidField(formData, F.claimDestinationVersionId);
  if (isBank && !destinationVersionId) errors[F.claimDestinationVersionId] = 'Choose the company account the customer paid into.';
  const chequeNumber = raw(formData, F.claimChequeNumber).trim();
  const chequeDate = raw(formData, F.claimChequeDate).trim();
  if (isCheque) {
    if (!CHEQUE_NUMBER_PATTERN.test(chequeNumber)) errors[F.claimChequeNumber] = 'Enter the 6-digit cheque number.';
    if (!validDate(chequeDate) || chequeDate < addDays(today, -90) || chequeDate > addDays(today, 90)) {
      errors[F.claimChequeDate] = 'Enter the cheque date, within 90 days of today.';
    }
  }
  const note = block(formData, F.claimNote, 1, 500);
  if (note === undefined) errors[F.claimNote] = 'Keep the note under 500 characters.';
  if (!dealId || !requestId) errors._form = 'This form is out of date. Reload the page.';
  const failed = errorsOf(errors);
  if (failed) return failed;
  return {
    ok: true,
    value: {
      dealId: dealId!,
      requestId: requestId!,
      fields: {
        mode: mode!,
        amountPaise: amountPaise!,
        paidOn,
        payerName: payerName!,
        reference: isBank ? reference : null,
        chequeNumber: isCheque ? chequeNumber : null,
        chequeDate: isCheque ? chequeDate : null,
        destinationVersionId: isBank ? destinationVersionId : null,
        note: note ?? null,
      },
    },
  };
}

export interface ClaimWithdrawForm {
  dealId: string | null;
  claimId: string;
  expectedRowVersion: number;
  reason: string;
  requestId: string;
}

export function parseClaimWithdrawForm(formData: FormData): Parsed<ClaimWithdrawForm> {
  const errors: FieldErrors = {};
  const claimId = readUuidField(formData, F.claimId);
  const requestId = readRequestId(formData);
  const expectedRowVersion = nonNegativeInt(formData, F.rowVersion);
  const reason = parseReason(formData);
  if (!reason.ok) Object.assign(errors, reason.fieldErrors);
  if (!claimId || !requestId || expectedRowVersion === null) errors._form = 'This form is out of date. Reload the page.';
  const failed = errorsOf(errors);
  if (failed) return failed;
  return {
    ok: true,
    value: {
      dealId: readUuidField(formData, F.dealId),
      claimId: claimId!,
      expectedRowVersion: expectedRowVersion!,
      reason: (reason as { ok: true; value: string }).value,
      requestId: requestId!,
    },
  };
}

export interface ReceiptFromClaimForm {
  dealId: string;
  claimId: string;
  requestId: string;
  fields: ReceiptFromClaimFields;
}

/** The receipt form (same rules as parseReceiptForm) plus claimId and an optional 10–500 mismatch reason; never a correction. */
export function parseReceiptFromClaimForm(formData: FormData, today: string = istToday()): Parsed<ReceiptFromClaimForm> {
  const base = parseReceiptForm(formData, today);
  const errors: FieldErrors = base.ok ? {} : { ...base.fieldErrors };
  const claimId = readUuidField(formData, F.claimId);
  if (!claimId) errors._form = 'This form is out of date. Reload the page.';
  if (raw(formData, F.correctsReceiptId).trim() !== '') errors[F.correctsReceiptId] = 'A receipt from a claim cannot correct another receipt.';
  const mismatchReason = block(formData, F.mismatchReason, 10, 500);
  if (mismatchReason === undefined) errors[F.mismatchReason] = 'Write a reason of 10 to 500 characters, or leave it empty when nothing differs.';
  const failed = errorsOf(errors);
  if (failed || !base.ok) return failed ?? (base as { ok: false; fieldErrors: FieldErrors });
  const f = base.value.fields;
  return {
    ok: true,
    value: {
      dealId: base.value.dealId,
      claimId: claimId!,
      requestId: base.value.requestId,
      fields: {
        mode: f.mode,
        amountPaise: f.amountPaise,
        receivedOn: f.receivedOn,
        branchId: f.branchId,
        collectorUserId: f.collectorUserId,
        payerName: f.payerName,
        payerPan: f.payerPan,
        payerMobile: f.payerMobile,
        reference: f.reference,
        micrCode: f.micrCode,
        chequeNumber: f.chequeNumber,
        chequeDate: f.chequeDate,
        accountPayee: f.accountPayee,
        bookingVersionId: f.bookingVersionId,
        note: f.note,
        destinationVersionId: f.destinationVersionId,
        mismatchReason: mismatchReason ?? null,
      },
    },
  };
}

export interface ClaimLinkForm {
  dealId: string | null;
  claimId: string;
  receiptId: string;
  reason: string | null;
  requestId: string;
}

export function parseClaimLinkForm(formData: FormData): Parsed<ClaimLinkForm> {
  const errors: FieldErrors = {};
  const claimId = readUuidField(formData, F.claimId);
  const receiptId = readUuidField(formData, F.receiptId);
  const requestId = readRequestId(formData);
  if (!receiptId) errors[F.receiptId] = 'Choose the receipt to link.';
  const reason = block(formData, F.mismatchReason, 10, 500);
  if (reason === undefined) errors[F.mismatchReason] = 'Write a reason of 10 to 500 characters, or leave it empty when nothing differs.';
  if (!claimId || !requestId) errors._form = 'This form is out of date. Reload the page.';
  const failed = errorsOf(errors);
  if (failed) return failed;
  return { ok: true, value: { dealId: readUuidField(formData, F.dealId), claimId: claimId!, receiptId: receiptId!, reason: reason ?? null, requestId: requestId! } };
}

export interface ClaimNotReceivedForm {
  dealId: string | null;
  claimId: string;
  reason: string;
  requestId: string;
}

export function parseClaimNotReceivedForm(formData: FormData): Parsed<ClaimNotReceivedForm> {
  const errors: FieldErrors = {};
  const claimId = readUuidField(formData, F.claimId);
  const requestId = readRequestId(formData);
  const reason = parseReason(formData);
  if (!reason.ok) Object.assign(errors, reason.fieldErrors);
  if (!claimId || !requestId) errors._form = 'This form is out of date. Reload the page.';
  const failed = errorsOf(errors);
  if (failed) return failed;
  return {
    ok: true,
    value: { dealId: readUuidField(formData, F.dealId), claimId: claimId!, reason: (reason as { ok: true; value: string }).value, requestId: requestId! },
  };
}

export interface ExpenseReviewForm {
  entryId: string;
  expectedRowVersion: number;
  requestId: string;
  /** Required for a return; null for accept. */
  reason: string | null;
}

export function parseExpenseReviewForm(formData: FormData, needsReason: boolean): Parsed<ExpenseReviewForm> {
  const errors: FieldErrors = {};
  const entryId = readUuidField(formData, F.entryId);
  const requestId = readRequestId(formData);
  const expectedRowVersion = nonNegativeInt(formData, F.rowVersion);
  let reason: string | null = null;
  if (needsReason) {
    const parsed = parseReason(formData);
    if (!parsed.ok) Object.assign(errors, parsed.fieldErrors);
    else reason = parsed.value;
  }
  if (!entryId || !requestId || expectedRowVersion === null) errors._form = 'This form is out of date. Reload the page.';
  const failed = errorsOf(errors);
  if (failed) return failed;
  return { ok: true, value: { entryId: entryId!, expectedRowVersion: expectedRowVersion!, requestId: requestId!, reason } };
}
