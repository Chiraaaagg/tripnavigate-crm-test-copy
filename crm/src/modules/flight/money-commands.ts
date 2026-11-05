import { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import {
  FLIGHT_MONEY_ERROR_STATES,
  type FlightBeneficiaryFields,
  type FlightDirectPaymentFields,
  type FlightFareFields,
  type FlightFareSetFields,
  type FlightMoneyErrorCode,
  type FlightPaymentRequestFields,
  type FlightSupplierFields,
  type FlightSupplierUpdateFields,
} from './money-contracts';

/**
 * Typed wrappers for the flight money commands and reads (migrations
 * 20261201000210_flight_money_commands.sql and 20261201000220_flight_money_reads.sql).
 * Every call runs under the staff member's OWN session; the database
 * authorizes, validates and audits. Responses are zod-validated with every
 * key listed (unknown keys are stripped); anything unexpected throws
 * FlightMoneyCommandError with code null (fail closed). Database messages
 * never reach the browser: errors map by SQLSTATE + exact token; for
 * invalid_input the Postgres hint (the refused input key) is kept.
 */

const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const INPUT_STATES = new Set(['22023', '22P02', '22001', '22003', '22007', '22008', '23514', '23502']);

export class FlightMoneyCommandError extends Error {
  override name = 'FlightMoneyCommandError';
  constructor(
    readonly command: string,
    readonly code: FlightMoneyErrorCode | 'session' | null,
    readonly sqlState: string | null,
    /** Refused input keys from the hint ("fares[0].markupPaise"); invalid_input only. */
    readonly hintKeys: string[] = [],
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapFlightMoneyError(error: RpcError): FlightMoneyErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(FLIGHT_MONEY_ERROR_STATES, token) && FLIGHT_MONEY_ERROR_STATES[token as FlightMoneyErrorCode] === state) {
    return token as FlightMoneyErrorCode;
  }
  if (token === 'request_conflict' && state === '40001') return 'duplicate_request';
  if (SESSION_STATES.has(state)) return 'session';
  if (state === '42501') return 'not_authorized';
  if (state === 'P0002') return 'not_found';
  if (INPUT_STATES.has(state)) return 'invalid_input';
  return null;
}

/** Hint keys are input names only (letters, digits, brackets, dots), never database text. */
function hintKeys(hint: string | null | undefined): string[] {
  if (!hint) return [];
  return hint
    .split(',')
    .map((k) => k.trim())
    .filter((k) => /^[A-Za-z][A-Za-z0-9_.[\]]{0,80}$/.test(k));
}

async function invoke(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, args);
  } catch {
    throw new FlightMoneyCommandError(fn, null, null);
  }
  if (result.error) {
    const code = mapFlightMoneyError(result.error);
    // invalid_input names the refused field; not_authorized may name the Purchase-holder rule.
    const keys = code === 'invalid_input' || code === 'not_authorized' ? hintKeys(result.error.hint) : [];
    throw new FlightMoneyCommandError(fn, code, result.error.code ?? null, keys);
  }
  return result.data;
}

function parse<T>(fn: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new FlightMoneyCommandError(fn, null, null);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const paise = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().min(1).refine((v) => !Number.isNaN(Date.parse(v)));
const nullableText = z.string().nullable();
const outcome = z.enum(['created', 'updated', 'existing']);
const rowVersion = z.number().int().positive();

const PAX = z.enum(['adult', 'child', 'infant']);
const STATE = z.enum([
  'unpaid',
  'direct_submitted',
  'direct_accepted',
  'direct_returned',
  'request_pending',
  'request_approved',
  'request_paid',
  'request_verified',
  'request_returned',
  'request_cancelled',
]);
const ROUTE = z.enum(['direct', 'accounts', 'manager']);
const APPROVAL_STATUS = z.enum(['pending', 'approved', 'returned', 'withdrawn', 'used']);

export const FlightSupplierSchema = z.object({
  supplierId: z.uuid(),
  name: z.string(),
  city: nullableText,
  status: z.enum(['active', 'archived']),
  bankDetailsApproved: z.boolean(),
  verification: z.enum(['unverified', 'verified']),
  contactName: nullableText,
  contactPhone: nullableText,
  contactEmail: nullableText,
  rowVersion,
});
export type FlightSupplierRecord = z.output<typeof FlightSupplierSchema>;

export const FarePreviewSchema = z.object({
  fareHash: z.string().regex(/^[0-9a-f]{64}$/),
  batchSupplierCostPaise: paise,
  batchCustomerTotalPaise: paise.nullable(),
  dealSupplierCostAfterPaise: paise,
  dealBudgetPaise: paise.nullable(),
  overBudget: z.boolean(),
  approval: z.object({ approvalId: z.uuid(), status: z.enum(['pending', 'approved', 'returned']) }).nullable(),
  costTaskId: z.uuid(),
});
export type FarePreviewRecord = z.output<typeof FarePreviewSchema>;

// Keys present only on flight-only Deals arrive absent on package Deals.
const optionalPaise = paise.nullable().optional().transform((v) => v ?? null);

const BatchFareSchema = z.object({
  paxType: PAX,
  basicPaise: paise,
  kPaise: paise,
  yqPaise: paise,
  yrPaise: paise,
  otherPaise: paise,
  supplierPerPersonPaise: paise,
  paxCount: z.number().int().min(1).max(100),
  supplierAmountPaise: paise,
  markupPaise: optionalPaise,
  discountPaise: optionalPaise,
  totalPerPersonPaise: optionalPaise,
  customerAmountPaise: optionalPaise,
});

// The database leaves out the keys a role may not see (contract 9.3 table):
// absent keys become null / false / [] here.
const optional = <T extends z.ZodType>(schema: T) => schema.nullable().optional().transform((v) => v ?? null);
const optionalFlag = z.boolean().optional().transform((v) => v ?? false);

const BatchPaymentSchema = z.object({
  state: STATE,
  route: optional(ROUTE),
  refNo: optional(z.string()),
  returnReason: optional(z.string()),
  entryId: optional(z.uuid()),
  entryRowVersion: optional(rowVersion),
  paymentId: optional(z.uuid()),
  paymentRowVersion: optional(rowVersion),
  onHold: optional(z.boolean()),
  holdReason: optional(z.string()),
});

const MoneyBatchSchema = z.object({
  batchId: z.uuid(),
  batchNo: z.number().int().positive(),
  costTaskId: z.uuid(),
  supplierId: z.uuid(),
  supplierName: z.string(),
  sectorIds: z.array(z.uuid()),
  confirmedAt: timestamp,
  confirmedByName: nullableText,
  fares: z.array(BatchFareSchema).optional().transform((v) => v ?? []),
  supplierCostPaise: optionalPaise,
  legacyPaidPaise: optionalPaise,
  duePaise: optionalPaise,
  customerTotalPaise: optionalPaise,
  payment: BatchPaymentSchema,
  canPayDirect: optionalFlag,
  canRequest: optionalFlag,
  routePreview: optional(ROUTE),
});

const FareApprovalSchema = z.object({
  approvalId: z.uuid(),
  approvalNo: z.number().int().positive(),
  status: APPROVAL_STATUS,
  batchSupplierCostPaise: paise,
  projectedSupplierCostPaise: paise,
  budgetPaise: paise.nullable(),
  requestedAt: timestamp,
  requestedByName: nullableText,
  decidedAt: timestamp.nullable(),
  decidedByName: nullableText,
  returnReason: nullableText,
  rowVersion,
  canDecide: z.boolean(),
  canWithdraw: z.boolean(),
});

export const FlightMoneySchema = z.object({
  dealKind: z.enum(['package', 'flight_only']),
  marginsAllowed: z.boolean(),
  budget: z.object({
    dealPaise: paise.nullable(),
    tasks: z.array(z.object({ taskId: z.uuid(), budgetPaise: paise.nullable(), source: z.enum(['typed', 'estimate', 'none']) })),
  }),
  supplierCostPaise: paise,
  overBudget: z.boolean(),
  customerTotalPaise: optionalPaise,
  batches: z.array(MoneyBatchSchema),
  supplierTotals: z
    .array(z.object({ supplierId: z.uuid(), supplierName: z.string(), runningTotalPaise: paise }))
    .optional()
    .transform((v) => v ?? []),
  approvals: z.array(FareApprovalSchema).optional().transform((v) => v ?? []),
  invoices: z.array(
    z.object({
      documentId: z.uuid(),
      supplierId: z.uuid(),
      number: z.string(),
      docDate: isoDate,
      totalPaise: paise,
      status: z.enum(['uploaded', 'accepted', 'returned']),
    }),
  )
    .optional()
    .transform((v) => v ?? []),
  invoiceMissing: optional(z.boolean()),
});
export type FlightMoneyRecord = z.output<typeof FlightMoneySchema>;

export const FareApprovalSetSchema = z.object({
  approvalId: z.uuid(),
  approvalNo: z.number().int().positive(),
  status: z.enum(['pending', 'approved']),
  rowVersion,
  fareHash: z.string().regex(/^[0-9a-f]{64}$/),
  supplierId: z.uuid(),
  supplierName: nullableText,
  sectorIds: z.array(z.uuid()),
  travellers: z.array(z.object({ seq: z.number().int().min(1).max(100), type: PAX })),
  fares: z.array(
    z.object({
      paxType: PAX,
      basicPaise: paise,
      kPaise: paise,
      yqPaise: paise,
      yrPaise: paise,
      otherPaise: paise,
      markupPaise: optionalPaise,
      discountPaise: optionalPaise,
      paxCount: z.number().int().min(0).max(100),
    }),
  ),
});
export type FareApprovalSetRecord = z.output<typeof FareApprovalSetSchema>;

export const PaymentContextSchema = z.object({
  batchId: z.uuid(),
  batchNo: z.number().int().positive(),
  costTaskId: z.uuid(),
  amountPaise: paise,
  supplierCostPaise: paise,
  legacyPaidPaise: paise,
  supplierId: z.uuid(),
  supplierName: z.string(),
  runningTotalPaise: paise,
  routePreview: z.enum(['direct', 'manager']),
  directAllowed: z.boolean(),
  directLimitPaise: paise,
  proofs: z.array(z.object({ evidenceId: z.uuid(), fileName: z.string() })),
});
export type PaymentContextRecord = z.output<typeof PaymentContextSchema>;

const TicketsConfirmedSchema = z.object({
  outcome,
  batchId: z.uuid(),
  batchNo: z.number().int().positive(),
  ticketCount: z.number().int().nonnegative(),
  travellersConfirmed: z.number().int().positive(),
  stillPending: z.number().int().nonnegative(),
});
const ApprovalRequestedSchema = z.object({
  outcome,
  approvalId: z.uuid(),
  approvalNo: z.number().int().positive(),
  status: APPROVAL_STATUS,
  rowVersion,
  fareHash: z.string().regex(/^[0-9a-f]{64}$/),
});
const ApprovalChangedSchema = z.object({ outcome, approvalId: z.uuid(), status: APPROVAL_STATUS, rowVersion });
const DirectPaymentSchema = z.object({
  outcome,
  batchId: z.uuid(),
  entryId: z.uuid(),
  rowVersion,
  expenseStatus: z.literal('submitted'),
});
const PaymentRequestSchema = z.object({
  outcome,
  id: z.uuid(),
  refNo: z.string().regex(/^SP-\d{4}-\d{6}$/),
  route: z.enum(['accounts', 'manager']),
  status: z.literal('pending'),
});
const SupplierCreatedSchema = z.object({ outcome, supplierId: z.uuid(), rowVersion });
const BeneficiarySchema = z.object({ revisionId: z.uuid(), revisionNo: z.number().int().positive(), created: z.boolean() });

// ---------------------------------------------------------------------------
// Suppliers (B1-B3)
// ---------------------------------------------------------------------------

export async function flightSupplierList(client: RpcClient) {
  const fn = 'flight_supplier_list';
  return parse(fn, z.array(FlightSupplierSchema), await invoke(client, fn, {}));
}

export async function flightSupplierCreate(client: RpcClient, fields: FlightSupplierFields, requestId: string) {
  const fn = 'flight_supplier_create';
  return parse(fn, SupplierCreatedSchema, await invoke(client, fn, { p_fields: fields, p_request_id: requestId }));
}

export async function flightSupplierUpdate(
  client: RpcClient,
  supplierId: string,
  expectedRowVersion: number,
  fields: FlightSupplierUpdateFields,
) {
  const fn = 'flight_supplier_update';
  return parse(
    fn,
    z.object({ supplierId: z.uuid(), rowVersion }),
    await invoke(client, fn, { p_supplier_id: supplierId, p_expected_row_version: expectedRowVersion, p_fields: fields }),
  );
}

export async function flightSupplierAddBeneficiary(client: RpcClient, supplierId: string, fields: FlightBeneficiaryFields, requestId: string) {
  const fn = 'flight_supplier_add_beneficiary';
  return parse(fn, BeneficiarySchema, await invoke(client, fn, { p_supplier_id: supplierId, p_request_id: requestId, p_fields: fields }));
}

// ---------------------------------------------------------------------------
// Fares, approvals, tickets (B4-B8)
// ---------------------------------------------------------------------------

export async function flightFarePreview(client: RpcClient, dealId: string, fields: FlightFareSetFields) {
  const fn = 'flight_fare_preview';
  return parse(fn, FarePreviewSchema, await invoke(client, fn, { p_deal_id: dealId, p_fields: fields }));
}

export async function flightFareApprovalRequest(client: RpcClient, dealId: string, fields: FlightFareSetFields, requestId: string) {
  const fn = 'flight_fare_approval_request';
  return parse(fn, ApprovalRequestedSchema, await invoke(client, fn, { p_deal_id: dealId, p_fields: fields, p_request_id: requestId }));
}

export async function flightFareApprovalDecide(
  client: RpcClient,
  approvalId: string,
  decision: 'approve' | 'return',
  reason: string | null,
  expectedRowVersion: number,
  requestId: string,
) {
  const fn = 'flight_fare_approval_decide';
  return parse(
    fn,
    ApprovalChangedSchema,
    await invoke(client, fn, {
      p_approval_id: approvalId,
      p_decision: decision,
      p_reason: reason,
      p_expected_row_version: expectedRowVersion,
      p_request_id: requestId,
    }),
  );
}

export async function flightFareApprovalWithdraw(client: RpcClient, approvalId: string, expectedRowVersion: number, requestId: string) {
  const fn = 'flight_fare_approval_withdraw';
  return parse(
    fn,
    ApprovalChangedSchema,
    await invoke(client, fn, { p_approval_id: approvalId, p_expected_row_version: expectedRowVersion, p_request_id: requestId }),
  );
}

export async function flightTicketsConfirm(client: RpcClient, dealId: string, fields: FlightFareFields, requestId: string) {
  const fn = 'flight_tickets_confirm';
  return parse(fn, TicketsConfirmedSchema, await invoke(client, fn, { p_deal_id: dealId, p_fields: fields, p_request_id: requestId }));
}

// ---------------------------------------------------------------------------
// Payments (B9, B10)
// ---------------------------------------------------------------------------

export async function flightDirectPaymentSave(
  client: RpcClient,
  batchId: string,
  expectedRowVersion: number | null,
  fields: FlightDirectPaymentFields,
  requestId: string,
) {
  const fn = 'flight_direct_payment_save';
  return parse(
    fn,
    DirectPaymentSchema,
    await invoke(client, fn, { p_batch_id: batchId, p_expected_row_version: expectedRowVersion, p_fields: fields, p_request_id: requestId }),
  );
}

export async function flightPaymentRequestCreate(client: RpcClient, batchId: string, fields: FlightPaymentRequestFields, requestId: string) {
  const fn = 'flight_payment_request_create';
  return parse(fn, PaymentRequestSchema, await invoke(client, fn, { p_batch_id: batchId, p_fields: fields, p_request_id: requestId }));
}

/** A returned flight request sent again (supplier_payment_request_resubmit, flight branch: the batch comes from the request). */
export async function flightPaymentRequestResubmit(client: RpcClient, paymentId: string, fields: FlightPaymentRequestFields, requestId: string) {
  const fn = 'supplier_payment_request_resubmit';
  return parse(fn, PaymentRequestSchema, await invoke(client, fn, { p_payment_id: paymentId, p_fields: fields, p_request_id: requestId }));
}

export async function flightPaymentRequestCancel(client: RpcClient, paymentId: string, expectedRowVersion: number, requestId: string) {
  const fn = 'supplier_payment_request_cancel';
  return parse(
    fn,
    z.object({ outcome, id: z.uuid(), status: z.string(), rowVersion }),
    await invoke(client, fn, { p_payment_id: paymentId, p_expected_row_version: expectedRowVersion, p_request_id: requestId }),
  );
}

// ---------------------------------------------------------------------------
// Reads (9.3, 9.4)
// ---------------------------------------------------------------------------

/** null when the caller may not see this Deal's flight money (Purchase, Visa, other Sales). */
export async function flightMoney(client: RpcClient, dealId: string) {
  const fn = 'flight_money';
  return parse(fn, FlightMoneySchema.nullable(), await invoke(client, fn, { p_deal_id: dealId }));
}

/** Fare sets of the Deal's pending and approved fare approvals; null when not available (same fence as the approvals list). */
export async function flightFareApprovalSets(client: RpcClient, dealId: string) {
  const fn = 'flight_fare_approval_sets';
  return parse(fn, z.array(FareApprovalSetSchema).nullable(), await invoke(client, fn, { p_deal_id: dealId }));
}

/** null unless the caller is the Flight person of the batch's cost task. */
export async function flightPaymentContext(client: RpcClient, batchId: string) {
  const fn = 'flight_payment_context';
  return parse(fn, PaymentContextSchema.nullable(), await invoke(client, fn, { p_batch_id: batchId }));
}
