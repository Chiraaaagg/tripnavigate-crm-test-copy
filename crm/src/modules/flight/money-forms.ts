import { z } from 'zod';
import {
  FLIGHT_CRS_TYPES,
  FLIGHT_DIRECT_LIMIT_PAISE,
  FLIGHT_DIRECT_PAYMENT_MODES,
  FLIGHT_PAX_TYPES,
  FM_FIELD,
  type FlightBeneficiaryFields,
  type FlightDealKind,
  type FlightDirectPaymentFields,
  type FlightFareFields,
  type FlightFareInput,
  type FlightFareSetFields,
  type FlightPaxType,
  type FlightPaymentRequestFields,
  type FlightSupplierFields,
  type FlightSupplierUpdateFields,
  type Paise,
} from './money-contracts';

/**
 * Pure fare arithmetic and form parsing for the flight money screens and
 * server actions (shared with the UI). The arithmetic mirrors the database
 * (flight_batch_fares generated columns): supplier per person = Basic + K +
 * YQ + YR + Other; total per person = supplier + Markup − Discount (flight-only
 * Deals only); amount = per person × count. BigInt only, whole paise. The
 * database stays the authority: these numbers are for live display.
 * The actor, entity, route, budget and amounts to pay are never read from a
 * form; the database derives them.
 */

type Parsed<T> = { ok: true; value: T } | { ok: false; fields: string[] };

const MAX_FARE_PAISE = 99_999_999_999n;

/**
 * Rupees text → whole paise ("12,345.50", "₹ 6000", "6 000" → "1234550",
 * "600000", "600000"). Empty → null. Negative, more than two decimals, or
 * not a number → undefined (invalid).
 */
export function fareNum(raw: string | null | undefined): Paise | null | undefined {
  const value = (raw ?? '').replace(/[,\s]/g, '').replace(/^₹/, '');
  if (value === '') return null;
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return undefined;
  const paise = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return paise > MAX_FARE_PAISE ? undefined : paise.toString();
}

/** Whole paise → rupees text for display ("1234550" → "12,345.50"). */
export function paiseToRupeesText(paise: Paise | null | undefined): string {
  if (paise == null || !/^\d+$/.test(paise)) return '';
  const value = BigInt(paise);
  // Indian grouping: the last three digits, then pairs ("12,34,567").
  const whole = (value / 100n).toString();
  const head = whole.slice(0, -3);
  const rupees = head === '' ? whole : `${head.replace(/\B(?=(\d{2})+$)/g, ',')},${whole.slice(-3)}`;
  const fraction = (value % 100n).toString().padStart(2, '0');
  return fraction === '00' ? rupees : `${rupees}.${fraction}`;
}

const p = (v: Paise | null | undefined): bigint => (v && /^\d+$/.test(v) ? BigInt(v) : 0n);

/** Supplier cost per person: Basic + K + YQ + YR + Other. */
export function supplierPerPerson(f: Pick<FlightFareInput, 'basicPaise' | 'kPaise' | 'yqPaise' | 'yrPaise' | 'otherPaise'>): Paise {
  return (p(f.basicPaise) + p(f.kPaise) + p(f.yqPaise) + p(f.yrPaise) + p(f.otherPaise)).toString();
}

/** Total per person: supplier + Markup − Discount (both ignored on package Deals). May be negative (the database refuses it). */
export function totalPerPerson(f: FlightFareInput, dealKind: FlightDealKind): string {
  const supplier = BigInt(supplierPerPerson(f));
  if (dealKind === 'package') return supplier.toString();
  return (supplier + p(f.markupPaise) - p(f.discountPaise)).toString();
}

export interface FareLineTotals {
  paxType: FlightPaxType;
  paxCount: number;
  supplierPerPersonPaise: Paise;
  totalPerPersonPaise: string;
  supplierAmountPaise: Paise;
  customerAmountPaise: string;
  discountOverFare: boolean;
}

export interface FareTotals {
  lines: FareLineTotals[];
  supplierCostPaise: Paise;
  /** null on package Deals. */
  customerTotalPaise: string | null;
  discountOverFare: boolean;
}

/** One fare line with its passenger count: per person and amounts (the popup row). */
export function fareLine(
  f: FlightFareInput & { paxCount: number },
  dealKind: FlightDealKind = 'package',
): Omit<FareLineTotals, 'paxType' | 'paxCount' | 'discountOverFare'> & { discountOverFare: boolean } {
  const count = BigInt(Number.isInteger(f.paxCount) && f.paxCount > 0 ? f.paxCount : 0);
  const sp = BigInt(supplierPerPerson(f));
  const tp = BigInt(totalPerPerson(f, dealKind));
  return {
    supplierPerPersonPaise: sp.toString(),
    totalPerPersonPaise: tp.toString(),
    supplierAmountPaise: (sp * count).toString(),
    customerAmountPaise: (tp * count).toString(),
    discountOverFare: tp < 0n,
  };
}

/** Live totals of a fare set for the given traveller types (count per type). */
export function fareTotals(fares: FlightFareInput[], travellerTypes: FlightPaxType[], dealKind: FlightDealKind): FareTotals {
  let supplier = 0n;
  let customer = 0n;
  let over = false;
  const lines = fares.map((f) => {
    const count = travellerTypes.filter((t) => t === f.paxType).length;
    const sp = BigInt(supplierPerPerson(f));
    const tp = BigInt(totalPerPerson(f, dealKind));
    const lineOver = tp < 0n;
    over = over || lineOver;
    supplier += sp * BigInt(count);
    customer += tp * BigInt(count);
    return {
      paxType: f.paxType,
      paxCount: count,
      supplierPerPersonPaise: sp.toString(),
      totalPerPersonPaise: tp.toString(),
      supplierAmountPaise: (sp * BigInt(count)).toString(),
      customerAmountPaise: (tp * BigInt(count)).toString(),
      discountOverFare: lineOver,
    };
  });
  return {
    lines,
    supplierCostPaise: supplier.toString(),
    customerTotalPaise: dealKind === 'flight_only' ? customer.toString() : null,
    discountOverFare: over,
  };
}

/** C1 preview: direct payment allowed while running total + amount <= ₹50,000. */
export function directPaymentAllowed(runningTotalPaise: Paise, amountPaise: Paise): boolean {
  return p(runningTotalPaise) + p(amountPaise) <= BigInt(FLIGHT_DIRECT_LIMIT_PAISE);
}

/** Route of a payment request for that running total (Accounts at or below ₹50,000, the branch Manager above). */
export function requestRoute(runningTotalPaise: Paise, amountPaise: Paise): 'accounts' | 'manager' {
  return directPaymentAllowed(runningTotalPaise, amountPaise) ? 'accounts' : 'manager';
}

// ---------------------------------------------------------------------------
// Form parsing (server actions)
// ---------------------------------------------------------------------------

function raw(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function line(formData: FormData, name: string, max: number): string | null | undefined {
  const value = raw(formData, name).trim();
  if (value === '') return null;
  if (value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

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

const uuid = z.uuid();
export function readFlightUuid(formData: FormData, name: string): string | null {
  const parsed = uuid.safeParse(raw(formData, name).trim());
  return parsed.success ? parsed.data : null;
}

export function readFlightRowVersion(formData: FormData): number | null {
  const value = raw(formData, FM_FIELD.expectedRowVersion).trim();
  if (!/^\d{1,9}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 ? n : null;
}

const paiseText = z.string().regex(/^(0|[1-9][0-9]{0,10})$/);
const FareFieldsSchema = z.object({
  sectorIds: z.array(z.uuid()).min(1).max(16),
  supplierId: z.uuid(),
  fareApprovalId: z.uuid().nullable(),
  fares: z
    .array(
      z.object({
        paxType: z.enum(FLIGHT_PAX_TYPES as [FlightPaxType, ...FlightPaxType[]]),
        basicPaise: paiseText,
        kPaise: paiseText,
        yqPaise: paiseText,
        yrPaise: paiseText,
        otherPaise: paiseText,
        markupPaise: paiseText.optional(),
        discountPaise: paiseText.optional(),
      }),
    )
    .min(1)
    .max(3),
  travellers: z
    .array(
      z.object({
        seq: z.number().int().min(1).max(100),
        crsType: z.enum(FLIGHT_CRS_TYPES as [string, ...string[]]),
        crsPnr: z.string().max(20).nullable(),
        airlinePnr: z.string().max(20),
        ticketNumber: z.string().max(40),
      }),
    )
    .min(1)
    .max(100),
});

// Preview and approval: a passenger line needs only its seq; ticket
// identifiers may be absent, empty or partly typed and are not sent.
const FareSetFieldsSchema = FareFieldsSchema.extend({
  travellers: z
    .array(z.object({ seq: z.number().int().min(1).max(100) }).loose())
    .min(1)
    .max(100),
});

/**
 * Fares to preview or send to the Manager (no ticket details needed). Only
 * fare-relevant fields go to the database, so the approved fare hash equals
 * the hash of the confirm that posts the same fares.
 */
export function parseFareSetFields(value: unknown): Parsed<FlightFareSetFields> {
  const parsed = FareSetFieldsSchema.safeParse(value);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? FM_FIELD.fareFields)))];
    return { ok: false, fields };
  }
  const v = parsed.data;
  return {
    ok: true,
    value: {
      sectorIds: [...v.sectorIds],
      supplierId: v.supplierId,
      fareApprovalId: v.fareApprovalId,
      fares: v.fares.map((f) => ({
        paxType: f.paxType,
        basicPaise: f.basicPaise,
        kPaise: f.kPaise,
        yqPaise: f.yqPaise,
        yrPaise: f.yrPaise,
        otherPaise: f.otherPaise,
        ...(f.markupPaise !== undefined ? { markupPaise: f.markupPaise } : {}),
        ...(f.discountPaise !== undefined ? { discountPaise: f.discountPaise } : {}),
      })),
      travellers: v.travellers.map((t) => ({ seq: t.seq })),
    },
  };
}

/**
 * The Confirm tickets popup posts FlightFareFields as JSON (field fareFields).
 * Confirm needs the full ticket lines. Shape only here; every rule is checked
 * by the database.
 */
export function parseFareFields(value: unknown): Parsed<FlightFareFields> {
  const parsed = FareFieldsSchema.safeParse(value);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? FM_FIELD.fareFields)))];
    return { ok: false, fields };
  }
  const v = parsed.data;
  return {
    ok: true,
    value: {
      sectorIds: [...v.sectorIds],
      supplierId: v.supplierId,
      fareApprovalId: v.fareApprovalId,
      fares: v.fares.map((f) => ({
        paxType: f.paxType,
        basicPaise: f.basicPaise,
        kPaise: f.kPaise,
        yqPaise: f.yqPaise,
        yrPaise: f.yrPaise,
        otherPaise: f.otherPaise,
        ...(f.markupPaise !== undefined ? { markupPaise: f.markupPaise } : {}),
        ...(f.discountPaise !== undefined ? { discountPaise: f.discountPaise } : {}),
      })),
      travellers: v.travellers.map((t) => ({
        seq: t.seq,
        crsType: t.crsType as FlightFareFields['travellers'][number]['crsType'],
        crsPnr: t.crsPnr,
        airlinePnr: t.airlinePnr,
        ticketNumber: t.ticketNumber,
      })),
    },
  };
}

function readFareJson(formData: FormData): unknown {
  try {
    return JSON.parse(raw(formData, FM_FIELD.fareFields) || 'null');
  } catch {
    return null;
  }
}

/** "Ask the Manager to approve": fares without ticket details. */
export function parseFareSetForm(formData: FormData): Parsed<{ dealId: string; requestId: string; fields: FlightFareSetFields }> {
  const dealId = readFlightUuid(formData, FM_FIELD.dealId);
  const requestId = readFlightUuid(formData, FM_FIELD.requestId);
  const fields = parseFareSetFields(readFareJson(formData));
  if (!dealId || !requestId || !fields.ok) {
    return { ok: false, fields: [...(!dealId ? [FM_FIELD.dealId] : []), ...(!requestId ? [FM_FIELD.requestId] : []), ...(fields.ok ? [] : fields.fields)] };
  }
  return { ok: true, value: { dealId, requestId, fields: fields.value } };
}

/** "Confirm tickets": fares and full ticket lines. */
export function parseFareFieldsForm(formData: FormData): Parsed<{ dealId: string; requestId: string; fields: FlightFareFields }> {
  const dealId = readFlightUuid(formData, FM_FIELD.dealId);
  const requestId = readFlightUuid(formData, FM_FIELD.requestId);
  const fields = parseFareFields(readFareJson(formData));
  if (!dealId || !requestId || !fields.ok) {
    return { ok: false, fields: [...(!dealId ? [FM_FIELD.dealId] : []), ...(!requestId ? [FM_FIELD.requestId] : []), ...(fields.ok ? [] : fields.fields)] };
  }
  return { ok: true, value: { dealId, requestId, fields: fields.value } };
}

export function parseDirectPaymentForm(
  formData: FormData,
): Parsed<{ batchId: string; dealId: string | null; expectedRowVersion: number | null; requestId: string; fields: FlightDirectPaymentFields }> {
  const bad: string[] = [];
  const batchId = readFlightUuid(formData, FM_FIELD.batchId);
  const requestId = readFlightUuid(formData, FM_FIELD.requestId);
  const mode = raw(formData, FM_FIELD.paymentMode).trim();
  const paidOn = isoDate(formData, FM_FIELD.paidOn);
  const reference = line(formData, FM_FIELD.reference, 120);
  const proof = readFlightUuid(formData, FM_FIELD.proofEvidenceId);
  const rv = raw(formData, FM_FIELD.expectedRowVersion).trim();
  if (!batchId) bad.push(FM_FIELD.batchId);
  if (!requestId) bad.push(FM_FIELD.requestId);
  if (!(FLIGHT_DIRECT_PAYMENT_MODES as readonly string[]).includes(mode)) bad.push(FM_FIELD.paymentMode);
  if (!paidOn) bad.push(FM_FIELD.paidOn);
  if (reference === undefined) bad.push(FM_FIELD.reference);
  if (!proof) bad.push(FM_FIELD.proofEvidenceId);
  if (rv !== '' && readFlightRowVersion(formData) === null) bad.push(FM_FIELD.expectedRowVersion);
  if (bad.length > 0) return { ok: false, fields: bad };
  return {
    ok: true,
    value: {
      batchId: batchId!,
      dealId: readFlightUuid(formData, FM_FIELD.dealId),
      expectedRowVersion: rv === '' ? null : readFlightRowVersion(formData),
      requestId: requestId!,
      fields: { paymentMode: mode as FlightDirectPaymentFields['paymentMode'], paidOn: paidOn!, reference: reference ?? null, proofEvidenceId: proof! },
    },
  };
}

export function parsePaymentRequestForm(
  formData: FormData,
): Parsed<{ batchId: string | null; paymentId: string | null; dealId: string | null; requestId: string; fields: FlightPaymentRequestFields }> {
  const bad: string[] = [];
  const batchId = readFlightUuid(formData, FM_FIELD.batchId);
  const paymentId = readFlightUuid(formData, FM_FIELD.paymentId);
  const requestId = readFlightUuid(formData, FM_FIELD.requestId);
  const dueDate = isoDate(formData, FM_FIELD.dueDate);
  const note = block(formData, FM_FIELD.note, 500);
  const proformaRaw = raw(formData, FM_FIELD.proformaEvidenceId).trim();
  const proforma = proformaRaw === '' ? null : readFlightUuid(formData, FM_FIELD.proformaEvidenceId);
  if (!batchId && !paymentId) bad.push(FM_FIELD.batchId);
  if (!requestId) bad.push(FM_FIELD.requestId);
  if (dueDate === undefined) bad.push(FM_FIELD.dueDate);
  if (note === undefined) bad.push(FM_FIELD.note);
  if (proformaRaw !== '' && !proforma) bad.push(FM_FIELD.proformaEvidenceId);
  if (bad.length > 0) return { ok: false, fields: bad };
  return {
    ok: true,
    value: {
      batchId,
      paymentId,
      dealId: readFlightUuid(formData, FM_FIELD.dealId),
      requestId: requestId!,
      fields: { dueDate: dueDate ?? null, note: note ?? null, proformaEvidenceId: proforma },
    },
  };
}

export function parseSupplierForm(formData: FormData): Parsed<{ requestId: string; fields: FlightSupplierFields }> {
  const bad: string[] = [];
  const requestId = readFlightUuid(formData, FM_FIELD.requestId);
  const name = line(formData, FM_FIELD.name, 200);
  const city = line(formData, FM_FIELD.city, 120);
  const contactName = line(formData, FM_FIELD.contactName, 120);
  const contactPhone = line(formData, FM_FIELD.contactPhone, 40);
  const contactEmail = line(formData, FM_FIELD.contactEmail, 254);
  if (!requestId) bad.push(FM_FIELD.requestId);
  if (!name) bad.push(FM_FIELD.name);
  if (city === undefined) bad.push(FM_FIELD.city);
  if (contactName === undefined) bad.push(FM_FIELD.contactName);
  if (contactPhone === undefined || (contactPhone && !/^[0-9+() -]{6,40}$/.test(contactPhone))) bad.push(FM_FIELD.contactPhone);
  if (contactEmail === undefined || (contactEmail && !/^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/.test(contactEmail))) bad.push(FM_FIELD.contactEmail);
  if (bad.length > 0) return { ok: false, fields: bad };
  return {
    ok: true,
    value: {
      requestId: requestId!,
      fields: { name: name!, city: city ?? null, contactName: contactName ?? null, contactPhone: contactPhone ?? null, contactEmail: contactEmail ?? null },
    },
  };
}

/** Edit or archive a flight supplier: supplierId, expectedRowVersion, the create fields, status (optional). */
export function parseSupplierUpdateForm(
  formData: FormData,
): Parsed<{ supplierId: string; expectedRowVersion: number; fields: FlightSupplierUpdateFields }> {
  const bad: string[] = [];
  const supplierId = readFlightUuid(formData, FM_FIELD.supplierId);
  const rv = readFlightRowVersion(formData);
  const status = raw(formData, FM_FIELD.status).trim();
  // The create parser needs a request id; the update has none (the row version guards it).
  const base = new FormData();
  for (const [k, v] of formData.entries()) base.append(k, v);
  base.set(FM_FIELD.requestId, '00000000-0000-4000-8000-000000000000');
  const parsed = parseSupplierForm(base);
  if (!supplierId) bad.push(FM_FIELD.supplierId);
  if (rv === null) bad.push(FM_FIELD.expectedRowVersion);
  if (status !== '' && status !== 'active' && status !== 'archived') bad.push(FM_FIELD.status);
  if (!parsed.ok) bad.push(...parsed.fields);
  if (bad.length > 0 || !parsed.ok) return { ok: false, fields: [...new Set(bad)] };
  return {
    ok: true,
    value: {
      supplierId: supplierId!,
      expectedRowVersion: rv!,
      fields: { ...parsed.value.fields, ...(status === '' ? {} : { status: status as 'active' | 'archived' }) },
    },
  };
}

export function parseBeneficiaryForm(formData: FormData): Parsed<{ supplierId: string; requestId: string; fields: FlightBeneficiaryFields }> {
  const bad: string[] = [];
  const supplierId = readFlightUuid(formData, FM_FIELD.supplierId);
  const requestId = readFlightUuid(formData, FM_FIELD.requestId);
  const accountHolder = line(formData, FM_FIELD.accountHolder, 120);
  const bankName = line(formData, FM_FIELD.bankName, 120);
  const ifsc = (line(formData, FM_FIELD.ifsc, 11) ?? '').toUpperCase();
  const accountNumber = (line(formData, FM_FIELD.accountNumber, 18) ?? '').replace(/\s/g, '');
  if (!supplierId) bad.push(FM_FIELD.supplierId);
  if (!requestId) bad.push(FM_FIELD.requestId);
  if (!accountHolder) bad.push(FM_FIELD.accountHolder);
  if (!bankName) bad.push(FM_FIELD.bankName);
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) bad.push(FM_FIELD.ifsc);
  if (!/^[0-9]{6,18}$/.test(accountNumber)) bad.push(FM_FIELD.accountNumber);
  if (bad.length > 0) return { ok: false, fields: bad };
  return { ok: true, value: { supplierId: supplierId!, requestId: requestId!, fields: { accountHolder: accountHolder!, bankName: bankName!, ifsc, accountNumber } } };
}

export function parseApprovalDecisionForm(
  formData: FormData,
): Parsed<{ approvalId: string; dealId: string | null; decision: 'approve' | 'return'; reason: string | null; expectedRowVersion: number; requestId: string }> {
  const bad: string[] = [];
  const approvalId = readFlightUuid(formData, FM_FIELD.approvalId);
  const requestId = readFlightUuid(formData, FM_FIELD.requestId);
  const decision = raw(formData, FM_FIELD.decision).trim();
  const reason = block(formData, FM_FIELD.reason, 500);
  const rv = readFlightRowVersion(formData);
  if (!approvalId) bad.push(FM_FIELD.approvalId);
  if (!requestId) bad.push(FM_FIELD.requestId);
  if (decision !== 'approve' && decision !== 'return') bad.push(FM_FIELD.decision);
  if (decision === 'return' && (!reason || reason.length < 10)) bad.push(FM_FIELD.reason);
  if (reason === undefined) bad.push(FM_FIELD.reason);
  if (rv === null) bad.push(FM_FIELD.expectedRowVersion);
  if (bad.length > 0) return { ok: false, fields: [...new Set(bad)] };
  return {
    ok: true,
    value: {
      approvalId: approvalId!,
      dealId: readFlightUuid(formData, FM_FIELD.dealId),
      decision: decision as 'approve' | 'return',
      reason: decision === 'return' ? reason! : null,
      expectedRowVersion: rv!,
      requestId: requestId!,
    },
  };
}

export function parseInvoiceForm(
  formData: FormData,
): Parsed<{ taskId: string; dealId: string | null; requestId: string; supplierId: string | null; number: string; docDate: string; totalPaise: Paise; gstIncluded: boolean }> {
  const bad: string[] = [];
  const taskId = readFlightUuid(formData, FM_FIELD.taskId);
  const requestId = readFlightUuid(formData, FM_FIELD.requestId);
  const supplierRaw = raw(formData, FM_FIELD.supplierId).trim();
  const supplierId = supplierRaw === '' ? null : readFlightUuid(formData, FM_FIELD.supplierId);
  const number = line(formData, FM_FIELD.number, 60);
  const docDate = isoDate(formData, FM_FIELD.docDate);
  const total = fareNum(raw(formData, FM_FIELD.totalRupees));
  const gst = raw(formData, FM_FIELD.gstIncluded);
  if (!taskId) bad.push(FM_FIELD.taskId);
  if (!requestId) bad.push(FM_FIELD.requestId);
  if (supplierRaw !== '' && !supplierId) bad.push(FM_FIELD.supplierId);
  if (!number) bad.push(FM_FIELD.number);
  if (!docDate) bad.push(FM_FIELD.docDate);
  if (!total || total === '0') bad.push(FM_FIELD.totalRupees);
  if (bad.length > 0) return { ok: false, fields: bad };
  return {
    ok: true,
    value: {
      taskId: taskId!,
      dealId: readFlightUuid(formData, FM_FIELD.dealId),
      requestId: requestId!,
      supplierId,
      number: number!,
      docDate: docDate!,
      totalPaise: total!,
      gstIncluded: gst === 'on' || gst === 'true' || gst === '1',
    },
  };
}
