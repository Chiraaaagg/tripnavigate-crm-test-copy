import { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import {
  type AccountsDocumentTab,
  type AccountsFundingTab,
  type AccountsPaymentTab,
  type PurchasePaymentScope,
  SUPPLIER_MONEY_ERROR_STATES,
  type SupplierMoneyErrorCode,
  type SupplierMoneyEvidenceKind,
} from './contracts';

/**
 * Typed wrappers for the supplier money commands and reads (migrations
 * 20261130000200_supplier_money.sql and 20261130000210_supplier_money_reads.sql).
 * Every call runs under the staff member's OWN session; the database
 * authorizes and audits. Responses are zod-validated (unknown keys are
 * stripped); anything unexpected throws SupplierMoneyCommandError with code
 * null (fail closed). Database messages never reach the browser: errors map
 * by SQLSTATE + exact token.
 */

const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const INPUT_STATES = new Set(['22023', '22P02', '22001', '22003', '22007', '22008', '23514', '23502']);

export class SupplierMoneyCommandError extends Error {
  override name = 'SupplierMoneyCommandError';
  constructor(
    readonly command: string,
    readonly code: SupplierMoneyErrorCode | 'session' | null,
    readonly sqlState: string | null,
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapSupplierMoneyError(error: RpcError): SupplierMoneyErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(SUPPLIER_MONEY_ERROR_STATES, token) && SUPPLIER_MONEY_ERROR_STATES[token as SupplierMoneyErrorCode] === state) {
    return token as SupplierMoneyErrorCode;
  }
  // finance_replay's request_conflict when it escapes a wrapper.
  if (token === 'request_conflict' && state === '40001') return 'duplicate_request';
  if (SESSION_STATES.has(state)) return 'session';
  if (state === '42501') return 'not_authorized';
  if (state === 'P0002') return 'not_found';
  if (INPUT_STATES.has(state)) return 'invalid_input';
  return null;
}

async function invoke(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, args);
  } catch {
    throw new SupplierMoneyCommandError(fn, null, null);
  }
  if (result.error) throw new SupplierMoneyCommandError(fn, mapSupplierMoneyError(result.error), result.error.code ?? null);
  return result.data;
}

function parse<T>(fn: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new SupplierMoneyCommandError(fn, null, null);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const paise = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().min(1).refine((v) => !Number.isNaN(Date.parse(v)));
const nullableText = z.string().nullable();
const outcome = z.enum(['created', 'existing']);

const PART = z.enum(['deposit', 'balance', 'full']);
const PAY_STATUS = z.enum(['pending', 'approved', 'returned', 'cancelled', 'paid', 'verified']);
const ROUTE = z.enum(['accounts', 'manager']);
const MODE = z.enum(['bank_transfer', 'upi', 'cheque']);
const HOLD = z.enum(['bank_details_on_hold', 'funding_pending', 'funding_returned']);
const FUNDING_STATUS = z.enum(['pending', 'approved', 'returned', 'recovered']);
const DOC_KIND = z.enum(['invoice', 'credit_note']);
const DOC_STATUS = z.enum(['uploaded', 'accepted', 'returned']);
const GO_AHEAD = z.enum(['not_needed', 'not_requested', 'pending', 'approved', 'returned', 'stale']);
const ERROR_CODES = Object.keys(SUPPLIER_MONEY_ERROR_STATES) as [SupplierMoneyErrorCode, ...SupplierMoneyErrorCode[]];

export const PurchasePaymentSchema = z.object({
  id: z.uuid(),
  refNo: z.string().regex(/^SP-\d{4}-\d{6}$/),
  dealId: z.uuid(),
  dealReference: z.string(),
  taskId: z.uuid(),
  serviceTitle: z.string(),
  serviceType: z.string(),
  supplierId: z.uuid(),
  supplierName: z.string(),
  part: PART,
  amountPaise: paise,
  dueDate: isoDate.nullable(),
  note: nullableText,
  route: ROUTE,
  status: PAY_STATUS,
  costVersionNo: z.number().int().positive(),
  proformaEvidenceId: z.uuid(),
  returnReason: nullableText,
  requestedAt: timestamp,
  requestedByName: nullableText,
  decidedAt: timestamp.nullable(),
  decidedByName: nullableText,
  paidOn: isoDate.nullable(),
  paymentMode: MODE.nullable(),
  bankReference: nullableText,
  verifiedAt: timestamp.nullable(),
  onHold: z.boolean(),
  holdReason: HOLD.nullable(),
  resubmittedAs: nullableText,
  resubmitsRefNo: nullableText,
  canCancel: z.boolean(),
  canResubmit: z.boolean(),
  rowVersion: z.number().int().positive(),
});
export type PurchasePaymentRecord = z.output<typeof PurchasePaymentSchema>;

export const DocumentSchema = z.object({
  id: z.uuid(),
  kind: DOC_KIND,
  taskId: z.uuid(),
  dealReference: z.string(),
  serviceTitle: z.string(),
  supplierId: z.uuid(),
  supplierName: z.string(),
  number: z.string(),
  docDate: isoDate,
  totalPaise: paise,
  gstIncluded: z.boolean(),
  evidenceId: z.uuid(),
  status: DOC_STATUS,
  returnReason: nullableText,
  uploadedAt: timestamp,
  uploadedByName: nullableText,
  reviewedAt: timestamp.nullable(),
  reviewedByName: nullableText,
  rowVersion: z.number().int().positive(),
});
export type DocumentRecord = z.output<typeof DocumentSchema>;

const FileSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['proforma', 'invoice', 'credit_note']),
  fileName: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().positive(),
  status: z.enum(['pending_upload', 'stored', 'failed']),
  createdAt: timestamp,
  uploadedByName: nullableText,
});

export const ContextSchema = z.object({
  taskId: z.uuid(),
  dealId: z.uuid(),
  dealReference: z.string(),
  serviceType: z.string(),
  serviceTitle: z.string(),
  taskStatus: z.string(),
  supplierId: z.uuid().nullable(),
  supplierName: nullableText,
  costVersionNo: z.number().int().positive().nullable(),
  agreedCostPaise: paise.nullable(),
  requestedPaise: paise,
  remainingPaise: paise,
  goAheadState: GO_AHEAD,
  goAheadNeeded: z.boolean(),
  goAheadValid: z.boolean(),
  allowedParts: z.array(PART),
  // Unknown tokens are dropped rather than failing the whole read.
  blockers: z.array(z.string()).transform((v) => v.filter((c): c is SupplierMoneyErrorCode => (ERROR_CODES as string[]).includes(c))),
  canRequest: z.boolean(),
  canUploadDocuments: z.boolean(),
  routeRunningTotalPaise: paise,
  approvalLimitPaise: paise,
  bankDetailsApproved: z.boolean(),
  invoiceMissing: z.boolean(),
  requests: z.array(PurchasePaymentSchema),
  documents: z.array(DocumentSchema),
  files: z.array(FileSchema),
});
export type ContextRecord = z.output<typeof ContextSchema>;

const BankSchema = z.object({
  revisionNo: z.number().int().positive(),
  accountHolder: z.string(),
  bankName: z.string(),
  ifsc: z.string(),
  accountLast4: z.string().regex(/^[0-9]{4}$/),
  status: z.enum(['unverified', 'approved']),
});

export const AccountsPaymentSchema = z.object({
  id: z.uuid(),
  refNo: z.string().regex(/^SP-\d{4}-\d{6}$/),
  dealId: z.uuid(),
  dealReference: z.string(),
  branchName: z.string(),
  taskId: z.uuid(),
  serviceTitle: z.string(),
  serviceType: z.string(),
  supplierId: z.uuid(),
  supplierName: z.string(),
  part: PART,
  amountPaise: paise,
  customerMoneyPaise: paise,
  dueDate: isoDate.nullable(),
  note: nullableText,
  route: ROUTE,
  status: PAY_STATUS,
  costVersionNo: z.number().int().positive(),
  agreedCostPaise: paise.nullable(),
  proformaEvidenceId: z.uuid(),
  returnReason: nullableText,
  requestedAt: timestamp,
  requestedByName: nullableText,
  decidedAt: timestamp.nullable(),
  decidedByName: nullableText,
  paidOn: isoDate.nullable(),
  paymentMode: MODE.nullable(),
  bankReference: nullableText,
  paymentProofEvidenceId: z.uuid().nullable(),
  bankRevisionNo: z.number().int().positive().nullable(),
  recordedAt: timestamp.nullable(),
  recordedByName: nullableText,
  verifiedAt: timestamp.nullable(),
  verifiedByName: nullableText,
  bankDetails: BankSchema.nullable(),
  funding: z
    .object({ id: z.uuid(), amountPaise: paise, reason: z.string(), route: ROUTE, status: FUNDING_STATUS })
    .nullable(),
  onHold: z.boolean(),
  holdReason: HOLD.nullable(),
  rowVersion: z.number().int().positive(),
  canDecide: z.boolean(),
  canRecord: z.boolean(),
  canVerify: z.boolean(),
});
export type AccountsPaymentRecord = z.output<typeof AccountsPaymentSchema>;

export const FundingSchema = z.object({
  id: z.uuid(),
  paymentRequestId: z.uuid(),
  paymentRefNo: z.string(),
  paymentStatus: PAY_STATUS,
  dealId: z.uuid(),
  dealReference: z.string(),
  branchName: z.string(),
  supplierName: z.string(),
  serviceTitle: z.string(),
  amountPaise: paise,
  reason: z.string(),
  route: ROUTE,
  status: FUNDING_STATUS,
  returnReason: nullableText,
  requestedAt: timestamp,
  requestedByName: nullableText,
  decidedAt: timestamp.nullable(),
  decidedByName: nullableText,
  recoveredAt: timestamp.nullable(),
  recoveredByName: nullableText,
  recoveryNote: nullableText,
  rowVersion: z.number().int().positive(),
  canDecide: z.boolean(),
  canMarkRecovered: z.boolean(),
});
export type FundingRecord = z.output<typeof FundingSchema>;

export const AccountsDocumentsSchema = z.object({
  documents: z.array(DocumentSchema.extend({ branchName: z.string(), canReview: z.boolean() })),
  missingInvoices: z.array(
    z.object({
      taskId: z.uuid(),
      dealReference: z.string(),
      serviceTitle: z.string(),
      supplierId: z.uuid().nullable(),
      supplierName: nullableText,
      tripEnd: isoDate,
      assigneeName: nullableText,
    }),
  ),
});
export type AccountsDocumentsRecord = z.output<typeof AccountsDocumentsSchema>;

export const ManagerApprovalsSchema = z.object({
  costsAboveBudget: z.array(
    z.object({
      taskId: z.uuid(),
      dealReference: z.string(),
      serviceTitle: z.string(),
      supplierName: nullableText,
      versionNo: z.number().int().positive(),
      amountPaise: paise,
      budgetPaise: paise,
      proposedAt: timestamp,
      proposedByName: nullableText,
      canApprove: z.boolean(),
    }),
  ),
  payments: z.array(AccountsPaymentSchema),
  funding: z.array(FundingSchema),
  bankDetails: z.array(
    z.object({
      supplierId: z.uuid(),
      supplierName: z.string(),
      revisionNo: z.number().int().positive(),
      accountHolder: z.string(),
      bankName: z.string(),
      ifsc: z.string(),
      accountLast4: z.string().regex(/^[0-9]{4}$/),
      createdAt: timestamp,
      createdByName: nullableText,
      canApprove: z.boolean(),
    }),
  ),
  suppliersToVerify: z.array(
    z.object({
      supplierId: z.uuid(),
      name: z.string(),
      city: nullableText,
      serviceTypes: z.array(z.string()),
      rowVersion: z.number().int().positive(),
      updatedAt: timestamp,
      canVerify: z.boolean(),
    }),
  ),
  cancellations: z.array(
    z.object({
      cancellationId: z.uuid(),
      dealId: z.uuid(),
      dealReference: z.string(),
      reason: z.string(),
      status: z.string(),
      sentAt: timestamp.nullable(),
      sentByName: nullableText,
      chargeCount: z.number().int().nonnegative(),
      supplierKeepsPaise: paise,
      supplierRefundPaise: paise,
      rowVersion: z.number().int().positive(),
      canDecide: z.boolean(),
    }),
  ),
});
export type ManagerApprovalsRecord = z.output<typeof ManagerApprovalsSchema>;

const count = z.number().int().nonnegative();
const optionalCount = count.nullable().optional().transform((v) => v ?? null);
export const HomeCountsSchema = z.object({
  requestsToApprove: optionalCount,
  purchaseTasksNotTaken: optionalCount,
  purchaseWaitingForGoAhead: optionalCount,
  purchaseCostsWaitingForManager: optionalCount,
  paymentRequestsReturned: optionalCount,
  supplierInvoicesMissing: optionalCount,
  goAheadToApprove: optionalCount,
  supplierPaymentsToApprove: optionalCount,
  supplierPaymentsToRecord: optionalCount,
  supplierPaymentsToVerify: optionalCount,
  supplierDocumentsToReview: optionalCount,
  fundingToApprove: optionalCount,
  fundingToRecover: optionalCount,
  managerApprovals: optionalCount,
});
export type HomeCountsRecord = z.output<typeof HomeCountsSchema>;

const CreatedSchema = z.object({
  outcome,
  id: z.uuid(),
  refNo: z.string().regex(/^SP-\d{4}-\d{6}$/),
  route: ROUTE,
  status: PAY_STATUS,
});
const DecisionSchema = z.object({
  outcome,
  id: z.uuid(),
  status: z.string(),
  rowVersion: z.number().int().positive(),
});
export type DecisionRecord = z.output<typeof DecisionSchema>;
const BegunSchema = z.object({ outcome, evidenceId: z.uuid(), objectPath: z.string().min(1) });
const FinishedSchema = z.object({ evidenceId: z.uuid(), status: z.enum(['stored', 'failed']) });
const DownloadSchema = z.object({ objectPath: z.string().min(1), fileName: z.string().min(1), mime: z.string().min(1) });

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export interface EvidenceBeginInput {
  kind: SupplierMoneyEvidenceKind;
  /** Task id for proforma/invoice/credit_note; payment request id for payment_proof. */
  targetId: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  requestId: string;
}

export async function evidenceBegin(client: RpcClient, input: EvidenceBeginInput) {
  const fn = 'supplier_money_evidence_begin';
  return parse(
    fn,
    BegunSchema,
    await invoke(client, fn, {
      p_kind: input.kind,
      p_target_id: input.targetId,
      p_file_name: input.fileName,
      p_mime: input.mime,
      p_size_bytes: input.sizeBytes,
      p_sha256: input.sha256,
      p_request_id: input.requestId,
    }),
  );
}

export async function evidenceFinish(client: RpcClient, evidenceId: string, ok: boolean) {
  const fn = 'supplier_money_evidence_finish';
  return parse(fn, FinishedSchema, await invoke(client, fn, { p_evidence_id: evidenceId, p_ok: ok }));
}

export async function evidenceAuthorizeDownload(client: RpcClient, evidenceId: string) {
  const fn = 'supplier_money_evidence_authorize_download';
  return parse(fn, DownloadSchema, await invoke(client, fn, { p_evidence_id: evidenceId }));
}

// ---------------------------------------------------------------------------
// Payment requests
// ---------------------------------------------------------------------------

/** p_fields of supplier_payment_request_create / _resubmit (camelCase, exactly these keys). */
export interface PaymentRequestFields {
  expectedCostVersionNo: number;
  part: 'deposit' | 'balance' | 'full';
  amountPaise: string;
  dueDate: string | null;
  note: string | null;
  proformaEvidenceId: string;
  /** Ignored by the database (review F1). */
  askFunding: boolean;
  /** Optional note for Accounts (10–500). */
  fundingReason: string | null;
}

export async function paymentRequestCreate(client: RpcClient, taskId: string, fields: PaymentRequestFields, requestId: string) {
  const fn = 'supplier_payment_request_create';
  return parse(fn, CreatedSchema, await invoke(client, fn, { p_task_id: taskId, p_fields: fields, p_request_id: requestId }));
}

export async function paymentRequestResubmit(client: RpcClient, paymentId: string, fields: PaymentRequestFields, requestId: string) {
  const fn = 'supplier_payment_request_resubmit';
  return parse(fn, CreatedSchema, await invoke(client, fn, { p_payment_id: paymentId, p_fields: fields, p_request_id: requestId }));
}

export async function paymentRequestCancel(client: RpcClient, paymentId: string, expectedRowVersion: number, requestId: string) {
  const fn = 'supplier_payment_request_cancel';
  return parse(
    fn,
    DecisionSchema,
    await invoke(client, fn, { p_payment_id: paymentId, p_expected_row_version: expectedRowVersion, p_request_id: requestId }),
  );
}

export async function paymentDecide(
  client: RpcClient,
  paymentId: string,
  decision: 'approve' | 'return',
  reason: string | null,
  expectedRowVersion: number,
  requestId: string,
) {
  const fn = 'supplier_payment_decide';
  return parse(
    fn,
    DecisionSchema,
    await invoke(client, fn, {
      p_payment_id: paymentId,
      p_decision: decision,
      p_reason: reason,
      p_expected_row_version: expectedRowVersion,
      p_request_id: requestId,
    }),
  );
}

export interface PaymentRecordInput {
  paymentId: string;
  paidOn: string;
  mode: 'bank_transfer' | 'upi' | 'cheque';
  bankReference: string;
  proofEvidenceId: string;
  expectedRowVersion: number;
  requestId: string;
}

export async function paymentRecord(client: RpcClient, input: PaymentRecordInput) {
  const fn = 'supplier_payment_record';
  return parse(
    fn,
    DecisionSchema,
    await invoke(client, fn, {
      p_payment_id: input.paymentId,
      p_paid_on: input.paidOn,
      p_mode: input.mode,
      p_bank_reference: input.bankReference,
      p_proof_evidence_id: input.proofEvidenceId,
      p_expected_row_version: input.expectedRowVersion,
      p_request_id: input.requestId,
    }),
  );
}

export async function paymentVerify(client: RpcClient, paymentId: string, expectedRowVersion: number, requestId: string) {
  const fn = 'supplier_payment_verify';
  return parse(
    fn,
    DecisionSchema,
    await invoke(client, fn, { p_payment_id: paymentId, p_expected_row_version: expectedRowVersion, p_request_id: requestId }),
  );
}

// ---------------------------------------------------------------------------
// Company funding
// ---------------------------------------------------------------------------

export async function fundingDecide(
  client: RpcClient,
  fundingId: string,
  decision: 'approve' | 'return',
  reason: string | null,
  expectedRowVersion: number,
  requestId: string,
) {
  const fn = 'company_funding_decide';
  return parse(
    fn,
    DecisionSchema,
    await invoke(client, fn, {
      p_funding_id: fundingId,
      p_decision: decision,
      p_reason: reason,
      p_expected_row_version: expectedRowVersion,
      p_request_id: requestId,
    }),
  );
}

export async function fundingMarkRecovered(client: RpcClient, fundingId: string, note: string, expectedRowVersion: number, requestId: string) {
  const fn = 'company_funding_mark_recovered';
  return parse(
    fn,
    DecisionSchema,
    await invoke(client, fn, {
      p_funding_id: fundingId,
      p_note: note,
      p_expected_row_version: expectedRowVersion,
      p_request_id: requestId,
    }),
  );
}

// ---------------------------------------------------------------------------
// Supplier documents
// ---------------------------------------------------------------------------

/** p_fields of supplier_document_upload. */
export interface DocumentFields {
  kind: 'invoice' | 'credit_note';
  number: string;
  docDate: string;
  totalPaise: string;
  gstIncluded: boolean;
  evidenceId: string;
}

export async function documentUpload(client: RpcClient, taskId: string, fields: DocumentFields, requestId: string) {
  const fn = 'supplier_document_upload';
  return parse(fn, DecisionSchema, await invoke(client, fn, { p_task_id: taskId, p_fields: fields, p_request_id: requestId }));
}

export async function documentReview(
  client: RpcClient,
  documentId: string,
  decision: 'accept' | 'return',
  reason: string | null,
  expectedRowVersion: number,
  requestId: string,
) {
  const fn = 'supplier_document_review';
  return parse(
    fn,
    DecisionSchema,
    await invoke(client, fn, {
      p_document_id: documentId,
      p_decision: decision,
      p_reason: reason,
      p_expected_row_version: expectedRowVersion,
      p_request_id: requestId,
    }),
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function purchasePaymentRequests(client: RpcClient, scope: PurchasePaymentScope) {
  const fn = 'purchase_payment_requests';
  return parse(fn, z.array(PurchasePaymentSchema), await invoke(client, fn, { p_scope: scope }));
}

export async function paymentContext(client: RpcClient, taskId: string) {
  const fn = 'purchase_payment_context';
  return parse(fn, ContextSchema.nullable(), await invoke(client, fn, { p_task_id: taskId }));
}

export async function accountsSupplierPayments(client: RpcClient, tab: AccountsPaymentTab) {
  const fn = 'accounts_supplier_payments';
  return parse(fn, z.array(AccountsPaymentSchema), await invoke(client, fn, { p_tab: tab }));
}

export async function accountsSupplierDocuments(client: RpcClient, tab: AccountsDocumentTab) {
  const fn = 'accounts_supplier_documents';
  return parse(fn, AccountsDocumentsSchema, await invoke(client, fn, { p_tab: tab }));
}

export async function accountsCompanyFunding(client: RpcClient, tab: AccountsFundingTab) {
  const fn = 'accounts_company_funding';
  return parse(fn, z.array(FundingSchema), await invoke(client, fn, { p_tab: tab }));
}

export async function managerApprovals(client: RpcClient) {
  const fn = 'manager_approvals';
  return parse(fn, ManagerApprovalsSchema, await invoke(client, fn, {}));
}

/** supplier_money_home_counts(): the supplier money Home rows (my_work_counts keeps its own keys). */
export async function supplierMoneyHomeCounts(client: RpcClient) {
  const fn = 'supplier_money_home_counts';
  return parse(fn, HomeCountsSchema, await invoke(client, fn, {}));
}
