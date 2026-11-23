import { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import {
  type AccountsDealDetail,
  type AccountsDealLookup,
  type AccountsQueueFilter,
  type AccountsQueuePage,
  type CashOverview,
  type ChequeMarkKind,
  type CompanyDestinationsPage,
  type DestinationKind,
  type DestinationOption,
  type DestinationVersionDetail,
  FINANCE_ERROR_STATES,
  type FinanceCommandResult,
  type FinanceErrorCode,
  type FinanceEvidenceKind,
  type FinancePolicyPage,
  type RejectionKind,
  type ReversalKind,
  type AccountsClaimsFilter,
  type AccountsClaimsPage,
  type AccountsExpenseFilter,
  type AccountsExpenseRecordsPage,
  type PaymentClaimReportFields,
  type ReceiptFromClaimFields,
  type SalesPaymentClaims,
} from './contracts';
import {
  AccountsDealDetailSchema,
  AccountsDealLookupSchema,
  AccountsQueuePageSchema,
  CashOverviewSchema,
  CompanyDestinationsPageSchema,
  DestinationOptionsSchema,
  DestinationVersionDetailSchema,
  EvidenceBeginResultSchema,
  EvidenceDownloadSchema,
  EvidenceFinishResultSchema,
  FinanceCommandResultSchema,
  FinancePolicyPageSchema,
  AccountsClaimsPageSchema,
  AccountsExpenseRecordsPageSchema,
  SalesPaymentClaimsSchema,
} from './dto';

/**
 * Typed wrappers for the Phase 5A RPCs (migration
 * 20261101000100_accounts_receipts.sql). Every call runs under the staff
 * member's OWN session; the database authorizes, audits and owns every rule.
 * Errors map only by exact token + SQLSTATE (contracts.ts
 * FINANCE_ERROR_STATES); anything else is code null (fail closed). Database
 * messages never reach the browser.
 */

export interface FinanceRpcError extends RpcError {
  details?: string | null;
}

/** PostgREST / GoTrue codes meaning the JWT is missing, expired or invalid. */
const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);

export type CashCapKind = 'payer_day' | 'trip';

export class FinanceCommandError extends Error {
  override name = 'FinanceCommandError';
  constructor(
    readonly command: string,
    /** The refusal token, 'session' for an ended JWT, or null for anything unexpected. */
    readonly code: FinanceErrorCode | 'session' | null,
    readonly sqlState: string | null,
    /** For cash_cap_exceeded: which cap refused. */
    readonly capKind: CashCapKind | null = null,
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapFinanceError(error: FinanceRpcError): FinanceErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(FINANCE_ERROR_STATES, token) && FINANCE_ERROR_STATES[token as FinanceErrorCode] === state) {
    return token as FinanceErrorCode;
  }
  if (SESSION_STATES.has(state)) return 'session';
  return null;
}

function capKindOf(error: FinanceRpcError): CashCapKind | null {
  const detail = (error.details ?? '').trim();
  return detail === 'payer_day' || detail === 'trip' ? detail : null;
}

async function invoke(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: FinanceRpcError | null };
  try {
    result = (await client.rpc(fn, args)) as { data: unknown; error: FinanceRpcError | null };
  } catch {
    throw new FinanceCommandError(fn, null, null);
  }
  if (result.error) {
    const code = mapFinanceError(result.error);
    throw new FinanceCommandError(fn, code, result.error.code ?? null, code === 'cash_cap_exceeded' ? capKindOf(result.error) : null);
  }
  return result.data;
}

function parse<T>(fn: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new FinanceCommandError(fn, null, null);
  return parsed.data;
}

const command = async (client: RpcClient, fn: string, args: Record<string, unknown>): Promise<FinanceCommandResult> =>
  parse(fn, FinanceCommandResultSchema, await invoke(client, fn, args));

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** One page of the Accounts queue; `after` is the previous page's nextAfter (null = first page). */
export async function accountsQueue(
  client: RpcClient,
  filter: AccountsQueueFilter,
  after: string | null = null,
  limit?: number,
): Promise<AccountsQueuePage> {
  const fn = 'accounts_queue';
  const args: Record<string, unknown> = { p_filter: filter, p_after: after };
  if (limit !== undefined) args.p_limit = limit;
  return parse(fn, AccountsQueuePageSchema, await invoke(client, fn, args));
}

export async function accountsDealLookup(client: RpcClient, reference: string): Promise<AccountsDealLookup | null> {
  const fn = 'accounts_deal_lookup';
  return parse(fn, AccountsDealLookupSchema.nullable(), await invoke(client, fn, { p_reference: reference }));
}

export async function accountsDealDetail(client: RpcClient, dealId: string): Promise<AccountsDealDetail | null> {
  const fn = 'accounts_deal_detail';
  return parse(fn, AccountsDealDetailSchema.nullable(), await invoke(client, fn, { p_deal_id: dealId }));
}

export async function accountsCashOverview(client: RpcClient, entityId: string): Promise<CashOverview> {
  const fn = 'accounts_cash_overview';
  return parse(fn, CashOverviewSchema, await invoke(client, fn, { p_entity_id: entityId }));
}

export async function financePolicyGet(client: RpcClient, entityId: string): Promise<FinancePolicyPage> {
  const fn = 'finance_policy_get';
  return parse(fn, FinancePolicyPageSchema, await invoke(client, fn, { p_entity_id: entityId }));
}

export async function financeEnabledEntities(client: RpcClient): Promise<string[]> {
  const fn = 'finance_enabled_entities';
  return parse(fn, z.array(z.uuid()), await invoke(client, fn, {}));
}

// ---------------------------------------------------------------------------
// Billing and review
// ---------------------------------------------------------------------------

export interface BillingFields {
  billingName: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  stateCode: string;
  postalCode: string;
  gstin: string | null;
  /**
   * Booking form Bill To (20261124000110). Sent only when the Accounts form
   * posts them (the screen shows these inputs only when the read carries
   * them), so a database without the change never receives an unknown key.
   */
  billToType?: 'personal' | 'business';
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  gstStatus?: 'registered' | 'unregistered' | null;
  gstReason?: string | null;
}

export const billingSave = (client: RpcClient, i: { dealId: string; expectedRowVersion: number; fields: BillingFields; requestId: string }) =>
  command(client, 'accounts_billing_save', {
    p_deal_id: i.dealId,
    p_expected_row_version: i.expectedRowVersion,
    p_fields: i.fields,
    p_request_id: i.requestId,
  });

export const billingVerify = (client: RpcClient, i: { dealId: string; expectedRowVersion: number; requestId: string }) =>
  command(client, 'accounts_billing_verify', { p_deal_id: i.dealId, p_expected_row_version: i.expectedRowVersion, p_request_id: i.requestId });

export const reviewReturn = (client: RpcClient, i: { bookingVersionId: string; reason: string; requestId: string }) =>
  command(client, 'accounts_review_return', { p_booking_version_id: i.bookingVersionId, p_reason: i.reason, p_request_id: i.requestId });

export const reviewApprove = (client: RpcClient, i: { bookingVersionId: string; expectedRowVersion: number; requestId: string }) =>
  command(client, 'accounts_review_approve', {
    p_booking_version_id: i.bookingVersionId,
    p_expected_row_version: i.expectedRowVersion,
    p_request_id: i.requestId,
  });

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/** receipt_record p_fields (contract 9.1). Absent optional values are null. */
export interface ReceiptFields {
  mode: 'bank_transfer' | 'upi' | 'cash' | 'cheque';
  amountPaise: string;
  receivedOn: string;
  branchId: string;
  collectorUserId: string | null;
  payerName: string;
  payerPan: string | null;
  payerMobile: string | null;
  reference: string | null;
  micrCode: string | null;
  chequeNumber: string | null;
  chequeDate: string | null;
  accountPayee: boolean | null;
  bookingVersionId: string | null;
  correctsReceiptId: string | null;
  note: string | null;
  /** Stage 2: the approved current company destination version (bank transfer and UPI only). */
  destinationVersionId: string | null;
}

export const receiptRecord = (client: RpcClient, i: { dealId: string; fields: ReceiptFields; requestId: string }) =>
  command(client, 'receipt_record', { p_deal_id: i.dealId, p_fields: i.fields, p_request_id: i.requestId });

export const receiptVerify = (client: RpcClient, i: { receiptId: string; requestId: string }) =>
  command(client, 'receipt_verify', { p_receipt_id: i.receiptId, p_request_id: i.requestId });

export const receiptReject = (client: RpcClient, i: { receiptId: string; kind: RejectionKind; reason: string; requestId: string }) =>
  command(client, 'receipt_reject', { p_receipt_id: i.receiptId, p_kind: i.kind, p_reason: i.reason, p_request_id: i.requestId });

export const chequeClear = (client: RpcClient, i: { receiptId: string; outcomeDate: string; requestId: string }) =>
  command(client, 'cheque_clear', { p_receipt_id: i.receiptId, p_outcome_date: i.outcomeDate, p_request_id: i.requestId });

export const chequeMark = (
  client: RpcClient,
  i: { receiptId: string; kind: ChequeMarkKind; outcomeDate: string; note: string | null; requestId: string },
) =>
  command(client, 'cheque_mark', {
    p_receipt_id: i.receiptId,
    p_kind: i.kind,
    p_outcome_date: i.outcomeDate,
    p_note: i.note,
    p_request_id: i.requestId,
  });

export const chequeRepresent = (client: RpcClient, i: { receiptId: string; requestId: string }) =>
  command(client, 'cheque_represent', { p_receipt_id: i.receiptId, p_request_id: i.requestId });

export const receiptReverse = (client: RpcClient, i: { receiptId: string; kind: ReversalKind; reason: string; requestId: string }) =>
  command(client, 'receipt_reverse', { p_receipt_id: i.receiptId, p_kind: i.kind, p_reason: i.reason, p_request_id: i.requestId });

// ---------------------------------------------------------------------------
// Cash custody and reconciliation
// ---------------------------------------------------------------------------

export const depositRecord = (
  client: RpcClient,
  i: { branchId: string; receiptIds: string[]; depositedOn: string; bankReference: string; evidenceId: string; requestId: string },
) =>
  command(client, 'cash_deposit_record', {
    p_branch_id: i.branchId,
    p_receipt_ids: i.receiptIds,
    p_deposited_on: i.depositedOn,
    p_bank_reference: i.bankReference,
    p_evidence_id: i.evidenceId,
    p_request_id: i.requestId,
  });

export const depositVerify = (client: RpcClient, i: { depositId: string; requestId: string }) =>
  command(client, 'cash_deposit_verify', { p_deposit_id: i.depositId, p_request_id: i.requestId });

export const depositReject = (client: RpcClient, i: { depositId: string; reason: string; requestId: string }) =>
  command(client, 'cash_deposit_reject', { p_deposit_id: i.depositId, p_reason: i.reason, p_request_id: i.requestId });

export const reconciliationRecord = (
  client: RpcClient,
  i: { branchId: string; businessDate: string; countedPaise: string; note: string | null; requestId: string },
) =>
  command(client, 'cash_reconciliation_record', {
    p_branch_id: i.branchId,
    p_business_date: i.businessDate,
    p_counted_paise: i.countedPaise,
    p_note: i.note,
    p_request_id: i.requestId,
  });

export const reconciliationVerify = (client: RpcClient, i: { reconciliationId: string; requestId: string }) =>
  command(client, 'cash_reconciliation_verify', { p_reconciliation_id: i.reconciliationId, p_request_id: i.requestId });

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface PolicyFields {
  receiptMaxPaise?: string;
  cashPayerDayCapPaise?: string;
  cashTripCapPaise?: string;
  cashDepositDays?: number;
  reconciliationRequired?: boolean;
}

/** effectiveAt null = effective immediately (the database uses its own now()). */
export const policyUpdate = (
  client: RpcClient,
  i: { entityId: string; fields: PolicyFields; effectiveAt: string | null; reason: string; requestId: string },
) =>
  command(client, 'finance_policy_update', {
    p_entity_id: i.entityId,
    p_fields: i.fields,
    p_effective_at: i.effectiveAt,
    p_reason: i.reason,
    p_request_id: i.requestId,
  });

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export async function evidenceBegin(
  client: RpcClient,
  i: {
    targetType: 'receipt' | 'branch';
    targetId: string;
    kind: FinanceEvidenceKind;
    fileName: string;
    mime: string;
    sizeBytes: number;
    sha256: string;
    requestId: string;
  },
) {
  const fn = 'finance_evidence_begin';
  return parse(
    fn,
    EvidenceBeginResultSchema,
    await invoke(client, fn, {
      p_target_type: i.targetType,
      p_target_id: i.targetId,
      p_kind: i.kind,
      p_file_name: i.fileName,
      p_mime: i.mime,
      p_size_bytes: i.sizeBytes,
      p_sha256: i.sha256,
      p_request_id: i.requestId,
    }),
  );
}

export async function evidenceFinish(client: RpcClient, evidenceId: string, ok: boolean) {
  const fn = 'finance_evidence_finish';
  return parse(fn, EvidenceFinishResultSchema, await invoke(client, fn, { p_evidence_id: evidenceId, p_ok: ok }));
}

export async function evidenceRemove(client: RpcClient, evidenceId: string) {
  const fn = 'finance_evidence_remove';
  return parse(fn, EvidenceFinishResultSchema, await invoke(client, fn, { p_evidence_id: evidenceId }));
}

export async function evidenceAuthorizeDownload(client: RpcClient, evidenceId: string) {
  const fn = 'finance_evidence_authorize_download';
  return parse(fn, EvidenceDownloadSchema, await invoke(client, fn, { p_evidence_id: evidenceId }));
}

// ---------------------------------------------------------------------------
// Stage 2: company destinations
// ---------------------------------------------------------------------------

/** company_destination_submit p_fields: kind and label only for a new destination; values for the kind. */
export interface DestinationFields {
  kind?: DestinationKind;
  label?: string;
  holderName?: string;
  bankName?: string;
  accountNumber?: string;
  ifsc?: string;
  payeeName?: string;
  upiId?: string;
}

export async function companyDestinationsList(client: RpcClient, entityId: string): Promise<CompanyDestinationsPage> {
  const fn = 'company_destinations_list';
  return parse(fn, CompanyDestinationsPageSchema, await invoke(client, fn, { p_entity_id: entityId }));
}

export async function companyDestinationOptions(client: RpcClient, dealId: string): Promise<DestinationOption[]> {
  const fn = 'company_destination_options';
  return parse(fn, DestinationOptionsSchema, await invoke(client, fn, { p_deal_id: dealId }));
}

export async function companyDestinationVersionDetail(client: RpcClient, versionId: string): Promise<DestinationVersionDetail> {
  const fn = 'company_destination_version_detail';
  return parse(fn, DestinationVersionDetailSchema, await invoke(client, fn, { p_version_id: versionId }));
}

export const destinationSubmit = (
  client: RpcClient,
  i: { entityId: string; destinationId: string | null; fields: DestinationFields; expectedRowVersion: number | null; requestId: string },
) =>
  command(client, 'company_destination_submit', {
    p_entity_id: i.entityId,
    p_destination_id: i.destinationId,
    p_fields: i.fields,
    p_expected_row_version: i.expectedRowVersion,
    p_request_id: i.requestId,
  });

export const destinationApprove = (client: RpcClient, i: { versionId: string; expectedRowVersion: number; requestId: string }) =>
  command(client, 'company_destination_approve', {
    p_version_id: i.versionId,
    p_expected_row_version: i.expectedRowVersion,
    p_request_id: i.requestId,
  });

export const destinationReturn = (
  client: RpcClient,
  i: { versionId: string; expectedRowVersion: number; reason: string; requestId: string },
) =>
  command(client, 'company_destination_return', {
    p_version_id: i.versionId,
    p_expected_row_version: i.expectedRowVersion,
    p_reason: i.reason,
    p_request_id: i.requestId,
  });

export const destinationRetire = (
  client: RpcClient,
  i: { destinationId: string; expectedRowVersion: number; reason: string; requestId: string },
) =>
  command(client, 'company_destination_retire', {
    p_destination_id: i.destinationId,
    p_expected_row_version: i.expectedRowVersion,
    p_reason: i.reason,
    p_request_id: i.requestId,
  });

// ===========================================================================
// B1.1: advance claims (appendix B §2–§3) and expense records (freeze note
// §3.2). database.types.ts does not list these functions until the lead
// regenerates it; they use the same untyped RpcClient surface.
// ===========================================================================

/** PGRST202 / 42883: the function is not installed yet (database without B1.1). */
export function isFinanceFunctionMissing(error: unknown): boolean {
  return error instanceof FinanceCommandError && (error.sqlState === 'PGRST202' || error.sqlState === '42883');
}

/** Sales: report what the customer says they paid. Never money. */
export const paymentClaimReport = (client: RpcClient, i: { dealId: string; fields: PaymentClaimReportFields; requestId: string }) =>
  command(client, 'payment_claim_report', { p_deal_id: i.dealId, p_fields: i.fields, p_request_id: i.requestId });

export const paymentClaimWithdraw = (client: RpcClient, i: { claimId: string; expectedRowVersion: number; reason: string; requestId: string }) =>
  command(client, 'payment_claim_withdraw', {
    p_claim_id: i.claimId,
    p_expected_row_version: i.expectedRowVersion,
    p_reason: i.reason,
    p_request_id: i.requestId,
  });

/** Accounts: record the real receipt from a claim (receipt_record runs inside, every receipt rule applies). */
export const receiptRecordFromClaim = (client: RpcClient, i: { claimId: string; fields: ReceiptFromClaimFields; requestId: string }) =>
  command(client, 'receipt_record_from_claim', { p_claim_id: i.claimId, p_fields: i.fields, p_request_id: i.requestId });

export const paymentClaimLinkReceipt = (client: RpcClient, i: { claimId: string; receiptId: string; reason: string | null; requestId: string }) =>
  command(client, 'payment_claim_link_receipt', { p_claim_id: i.claimId, p_receipt_id: i.receiptId, p_reason: i.reason, p_request_id: i.requestId });

export const paymentClaimMarkNotReceived = (client: RpcClient, i: { claimId: string; reason: string; requestId: string }) =>
  command(client, 'payment_claim_mark_not_received', { p_claim_id: i.claimId, p_reason: i.reason, p_request_id: i.requestId });

/** null = the caller may not report on this Deal (Purchase, Flight, desk, other owner, …). */
export async function dealPaymentClaims(client: RpcClient, dealId: string): Promise<SalesPaymentClaims | null> {
  const fn = 'deal_payment_claims';
  return parse(fn, SalesPaymentClaimsSchema.nullable(), await invoke(client, fn, { p_deal_id: dealId }));
}

export async function accountsPaymentClaims(
  client: RpcClient,
  filter: AccountsClaimsFilter,
  after: string | null = null,
  limit?: number,
): Promise<AccountsClaimsPage> {
  const fn = 'accounts_payment_claims';
  const args: Record<string, unknown> = { p_filter: filter, p_after: after };
  if (limit !== undefined) args.p_limit = limit;
  return parse(fn, AccountsClaimsPageSchema, await invoke(client, fn, args));
}

export const expenseRecordAccept = (client: RpcClient, i: { entryId: string; expectedRowVersion: number; requestId: string }) =>
  command(client, 'expense_record_accept', { p_entry_id: i.entryId, p_expected_row_version: i.expectedRowVersion, p_request_id: i.requestId });

export const expenseRecordReturn = (client: RpcClient, i: { entryId: string; expectedRowVersion: number; reason: string; requestId: string }) =>
  command(client, 'expense_record_return', {
    p_entry_id: i.entryId,
    p_expected_row_version: i.expectedRowVersion,
    p_reason: i.reason,
    p_request_id: i.requestId,
  });

export async function accountsExpenseRecords(
  client: RpcClient,
  filter: AccountsExpenseFilter,
  after: string | null = null,
  limit?: number,
): Promise<AccountsExpenseRecordsPage> {
  const fn = 'accounts_expense_records';
  const args: Record<string, unknown> = { p_filter: filter, p_after: after };
  if (limit !== undefined) args.p_limit = limit;
  return parse(fn, AccountsExpenseRecordsPageSchema, await invoke(client, fn, args));
}
