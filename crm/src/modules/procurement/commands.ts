import { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import type {
  CancellationDecision,
  CancellationStatus,
  CostStage,
  GoAheadDecision,
  GoAheadRequestStatus,
  GoAheadState,
  ProcurementErrorCode,
  ProcurementIssueCode,
  PurchaseEvidenceKind,
  QuoteStatus,
  SupplierEmailKind,
  SupplierEmailStatus,
  SupplierFields,
  SupplierServiceType,
} from './contracts';

/**
 * Typed wrappers for the Phase 4 commands and reads
 * (migration 20261005000100_purchase_hotel_procurement.sql). Every call runs
 * under the staff member's OWN session; the database authorizes and audits.
 * Responses are zod-validated; anything unexpected throws
 * ProcurementCommandError with code null (fail closed). Database messages are
 * never surfaced: errors map by SQLSTATE + exact token (contract §7).
 */

export const PROCUREMENT_ERROR_STATES: Record<ProcurementErrorCode, string> = {
  not_authorized: '42501',
  not_found: 'P0002',
  version_changed: '40001',
  task_conflict: '40001',
  not_ready: '55000',
  over_budget: '55000',
  procurement_disabled: '55000',
  environment_unset: '55000',
  already_confirmed: '55000',
  invalid_input: '22023',
  evidence_rejected: '22023',
  supplier_exists: '23505',
  deal_removed: '55000',
  // Purchase build (20261130000100..0120).
  go_ahead_missing: '55000',
  booking_request_not_sent: '55000',
  booking_not_approved: '55000',
  trip_cancelled: '55000',
  payment_in_progress: '55000',
  not_self_approval: '42501',
  already_decided: '55000',
  duplicate_request: '23505',
  not_configured: '55000',
};

const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const INPUT_STATES = new Set(['22023', '22P02', '22001', '22003', '22007', '22008', '23514', '23502']);

export class ProcurementCommandError extends Error {
  override name = 'ProcurementCommandError';
  constructor(
    readonly command: string,
    readonly code: ProcurementErrorCode | 'session' | null,
    readonly sqlState: string | null,
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapProcurementError(error: RpcError): ProcurementErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(PROCUREMENT_ERROR_STATES, token) && PROCUREMENT_ERROR_STATES[token as ProcurementErrorCode] === state) {
    return token as ProcurementErrorCode;
  }
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
    throw new ProcurementCommandError(fn, null, null);
  }
  if (result.error) throw new ProcurementCommandError(fn, mapProcurementError(result.error), result.error.code ?? null);
  return result.data;
}

function parse<T>(fn: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ProcurementCommandError(fn, null, null);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const PROCUREMENT_ISSUE_CODES = [
  'environment_unset',
  'procurement_disabled',
  'missing_quote',
  'missing_cost',
  'cost_not_for_quote',
  'over_budget',
  'missing_supplier_confirmation_proof',
  'evidence_upload_incomplete',
  'deal_removed',
  'trip_cancelled',
  'booking_request_not_sent',
  'go_ahead_missing',
] as const satisfies readonly ProcurementIssueCode[];

const SERVICE_TYPES = ['hotel', 'transfer', 'activity'] as const satisfies readonly SupplierServiceType[];
const QUOTE_STATUSES = ['open', 'withdrawn', 'selected'] as const satisfies readonly QuoteStatus[];
const COST_STAGES = ['proposed', 'committed'] as const satisfies readonly CostStage[];
const EVIDENCE_KINDS = ['quote', 'supplier_confirmation', 'other'] as const satisfies readonly PurchaseEvidenceKind[];

const paise = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().min(1).refine((v) => !Number.isNaN(Date.parse(v)));
const nullableText = z.string().nullable();

const SupplierSchema = z.object({
  supplierId: z.uuid(),
  legalEntityId: z.uuid(),
  name: z.string().min(1),
  serviceTypes: z.array(z.enum(SERVICE_TYPES)).min(1),
  city: nullableText,
  contactName: nullableText,
  contactPhone: nullableText,
  contactEmail: nullableText,
  paymentTerms: nullableText,
  verificationStatus: z.enum(['unverified', 'verified']),
  verifiedAt: timestamp.nullable(),
  verifiedByName: nullableText,
  status: z.enum(['active', 'archived']),
  rowVersion: z.number().int().positive(),
  updatedAt: timestamp,
});
export type SupplierRecord = z.output<typeof SupplierSchema>;

const BeneficiarySchema = z.object({
  revisionNo: z.number().int().positive(),
  accountHolder: z.string(),
  bankName: z.string(),
  ifsc: z.string(),
  accountLast4: z.string().regex(/^[0-9]{4}$/),
  status: z.enum(['unverified', 'approved']),
  createdAt: timestamp,
  createdByName: nullableText,
  approvedAt: timestamp.nullable(),
  approvedByName: nullableText,
  canApprove: z.boolean(),
});
const SupplierDetailSchema = SupplierSchema.extend({
  canEdit: z.boolean(),
  canVerify: z.boolean(),
  beneficiaries: z.array(BeneficiarySchema),
});
export type SupplierDetailRecord = z.output<typeof SupplierDetailSchema>;

/** Phase 4 hotel task shape inside purchase_workspace (hotel tasks only; the page reads the task through purchase_task_get). */
export const WorkspaceHotelTaskSchema = z.object({
  taskId: z.uuid(),
  dealReference: z.string().min(1),
  hotelName: z.string().min(1),
  city: z.string().min(1),
  checkIn: isoDate,
  checkOut: isoDate,
  rooms: z.number().int().positive(),
  adults: z.number().int().positive(),
  children: z.number().int().nonnegative(),
  purchaseBudgetPaise: paise,
  status: z.enum(['not_started', 'in_progress', 'supplier_confirmed']),
  assigneeName: nullableText,
  assignedToYou: z.boolean(),
  branchName: z.string(),
  createdAt: timestamp,
  supplierConfirmedAt: timestamp.nullable(),
  roomType: nullableText,
  mealPlan: nullableText,
  inclusions: nullableText,
  specialRequests: nullableText,
  confirmedAt: timestamp,
  confirmedByName: z.string(),
  versionNo: z.number().int().positive(),
  canClaim: z.boolean(),
});

const GO_AHEAD_STATES = ['not_needed', 'not_requested', 'pending', 'approved', 'returned', 'stale'] as const satisfies readonly GoAheadState[];
const GO_AHEAD_REQUEST_STATUSES = ['pending', 'approved', 'returned', 'superseded'] as const satisfies readonly GoAheadRequestStatus[];
const EMAIL_KINDS = ['rate_request', 'booking_request'] as const satisfies readonly SupplierEmailKind[];
const EMAIL_STATUSES = ['marked_sent', 'queued', 'sent', 'failed'] as const satisfies readonly SupplierEmailStatus[];
const CANCELLATION_STATUSES = ['open', 'charges_entered', 'sent_to_manager', 'approved'] as const satisfies readonly CancellationStatus[];
/** Absent on a database before the Purchase build: null. */
const later = <T extends z.ZodType>(schema: T) => schema.nullable().optional().transform((v) => v ?? null);

const GoAheadSchema = z.object({
  state: z.enum(GO_AHEAD_STATES),
  requestId: z.uuid().nullable(),
  costVersionNo: z.number().int().positive().nullable(),
  requestedAt: timestamp.nullable(),
  requestedByName: nullableText,
  decidedAt: timestamp.nullable(),
  decidedByName: nullableText,
  returnReason: nullableText,
});
export type GoAheadRecord = z.output<typeof GoAheadSchema>;

const EmailSchema = z.object({
  emailId: z.uuid(),
  kind: z.enum(EMAIL_KINDS),
  supplierId: z.uuid(),
  supplierName: z.string(),
  toEmail: z.string().min(3).max(254),
  ccEmails: z.array(z.string().min(3).max(254)).max(10),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(8000),
  status: z.enum(EMAIL_STATUSES),
  costVersionNo: z.number().int().positive().nullable(),
  sentAt: timestamp,
  sentByName: nullableText,
  failed: z.boolean(),
});

const ChargeSchema = z.object({
  taskId: z.uuid(),
  revisionNo: z.number().int().positive(),
  supplierId: z.uuid(),
  supplierName: z.string(),
  committedCostPaise: paise,
  supplierKeepsPaise: paise,
  supplierRefundPaise: paise,
  note: nullableText,
  creditNoteEvidenceId: z.uuid().nullable(),
  enteredAt: timestamp,
  enteredByName: nullableText,
});
export type ChargeRecord = z.output<typeof ChargeSchema>;

const TaskCancellationSchema = z.object({
  cancellationId: z.uuid(),
  status: z.enum(CANCELLATION_STATUSES),
  reason: z.string().min(1).max(500),
  openedAt: timestamp,
  openedByName: nullableText,
  rowVersion: z.number().int().positive(),
  returnReason: nullableText,
  myCharge: ChargeSchema.nullable(),
  canEnter: z.boolean(),
  canSend: z.boolean(),
  chargesMissing: z.number().int().nonnegative(),
});

const WorkspaceSchema = z.object({
  /** Not used for the view: loadPurchaseWorkspace reads the task through purchase_task_get (all service types). */
  task: z.unknown(),
  canWork: z.boolean(),
  canRelease: z.boolean(),
  canReassign: z.boolean(),
  canApproveOverBudget: z.boolean(),
  assigneeUserId: z.uuid().nullable(),
  reassignCandidates: z.array(z.object({ userId: z.uuid(), name: z.string() })),
  gateIssue: z.enum(['environment_unset', 'procurement_disabled', 'deal_removed']).nullable(),
  issues: z.array(z.enum(PROCUREMENT_ISSUE_CODES)),
  supplierReference: nullableText,
  selectedQuoteId: z.uuid().nullable(),
  supplierConfirmedByName: nullableText,
  quotes: z.array(
    z.object({
      quoteId: z.uuid(),
      supplierId: z.uuid(),
      supplierName: z.string(),
      supplierVerification: z.enum(['unverified', 'verified']),
      hotelName: z.string(),
      roomType: nullableText,
      mealPlan: nullableText,
      quotedCostPaise: paise,
      holdUntil: isoDate.nullable(),
      cancellationTerms: nullableText,
      status: z.enum(QUOTE_STATUSES),
      createdAt: timestamp,
      createdByName: nullableText,
      perRoomNightPaise: later(paise),
      note: later(z.string().max(300)),
    }),
  ),
  costVersions: z.array(
    z.object({
      versionNo: z.number().int().positive(),
      quoteId: z.uuid(),
      stage: z.enum(COST_STAGES),
      amountPaise: paise,
      dueDate: isoDate.nullable(),
      note: nullableText,
      payableStatus: z.literal('not_requested'),
      createdAt: timestamp,
      createdByName: nullableText,
      overBudgetApprovedAt: timestamp.nullable(),
      overBudgetApprovedByName: nullableText,
    }),
  ),
  evidence: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(EVIDENCE_KINDS),
      fileName: z.string(),
      mime: z.string(),
      sizeBytes: z.number().int().positive(),
      status: z.enum(['pending_upload', 'stored', 'failed']),
      createdAt: timestamp,
      uploadedByName: nullableText,
    }),
  ),
  // Purchase build (20261130000120); absent on an older database.
  goAhead: later(GoAheadSchema),
  emails: z.array(EmailSchema).optional().transform((v) => v ?? []),
  cancellation: later(TaskCancellationSchema),
  emailSendingEnabled: z.boolean().optional().transform((v) => v ?? false),
});
export type WorkspaceRecord = z.output<typeof WorkspaceSchema>;

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export async function supplierList(client: RpcClient): Promise<SupplierRecord[]> {
  const fn = 'supplier_list';
  return parse(fn, z.array(SupplierSchema), await invoke(client, fn, {}));
}

export async function supplierGet(client: RpcClient, supplierId: string): Promise<SupplierDetailRecord | null> {
  const fn = 'supplier_get';
  return parse(fn, SupplierDetailSchema.nullable(), await invoke(client, fn, { p_supplier_id: supplierId }));
}

const SupplierWriteSchema = z.object({ supplierId: z.uuid(), rowVersion: z.number().int().positive() });

export async function supplierCreate(client: RpcClient, entityId: string, fields: SupplierFields) {
  const fn = 'supplier_create';
  return parse(fn, SupplierWriteSchema, await invoke(client, fn, { p_entity_id: entityId, p_fields: fields }));
}

export async function supplierUpdate(client: RpcClient, supplierId: string, expectedRowVersion: number, fields: SupplierFields) {
  const fn = 'supplier_update';
  return parse(
    fn,
    SupplierWriteSchema,
    await invoke(client, fn, { p_supplier_id: supplierId, p_expected_row_version: expectedRowVersion, p_fields: fields }),
  );
}

export interface BeneficiaryInput {
  accountHolder: string;
  bankName: string;
  ifsc: string;
  accountNumber: string;
}

export async function supplierAddBeneficiary(client: RpcClient, supplierId: string, requestId: string, fields: BeneficiaryInput) {
  const fn = 'supplier_add_beneficiary';
  return parse(
    fn,
    z.object({ revisionId: z.uuid(), revisionNo: z.number().int().positive(), created: z.boolean() }),
    await invoke(client, fn, { p_supplier_id: supplierId, p_request_id: requestId, p_fields: fields }),
  );
}

// ---------------------------------------------------------------------------
// Task work
// ---------------------------------------------------------------------------

export async function purchaseWorkspace(client: RpcClient, taskId: string): Promise<WorkspaceRecord | null> {
  const fn = 'purchase_workspace';
  return parse(fn, WorkspaceSchema.nullable(), await invoke(client, fn, { p_task_id: taskId }));
}

export interface QuoteInput {
  supplierId: string;
  /** Hotel name, or the service name for transfer and activity tasks. */
  hotelName: string;
  roomType: string | null;
  mealPlan: string | null;
  quotedCostPaise: string;
  holdUntil: string | null;
  cancellationTerms: string | null;
  /** Purchase build: optional rate per room per night (hotel only). Omitted from the call when null. */
  perRoomNightPaise?: string | null;
  /** Purchase build: optional short note (up to 300 characters). Omitted from the call when null. */
  note?: string | null;
}

export async function quoteAdd(client: RpcClient, taskId: string, requestId: string, fields: QuoteInput) {
  const fn = 'purchase_quote_add';
  return parse(
    fn,
    z.object({ quoteId: z.uuid(), created: z.boolean() }),
    await invoke(client, fn, { p_task_id: taskId, p_request_id: requestId, p_fields: quoteFields(fields) }),
  );
}

/** Older databases refuse unknown keys: the Purchase build keys are sent only when set. */
function quoteFields(fields: QuoteInput): Record<string, string | null> {
  const { perRoomNightPaise, note, ...base } = fields;
  return {
    ...base,
    ...(perRoomNightPaise ? { perRoomNightPaise } : {}),
    ...(note ? { note } : {}),
  };
}

export async function quoteWithdraw(client: RpcClient, quoteId: string) {
  const fn = 'purchase_quote_withdraw';
  return parse(fn, z.object({ quoteId: z.uuid(), status: z.literal('withdrawn') }), await invoke(client, fn, { p_quote_id: quoteId }));
}

export interface CostInput {
  taskId: string;
  quoteId: string;
  expectedVersionNo: number;
  amountPaise: string;
  dueDate: string | null;
  note: string | null;
  requestId: string;
}

export async function costPropose(client: RpcClient, input: CostInput) {
  const fn = 'purchase_cost_propose';
  return parse(
    fn,
    z.object({ versionNo: z.number().int().positive(), created: z.boolean() }),
    await invoke(client, fn, {
      p_task_id: input.taskId,
      p_quote_id: input.quoteId,
      p_expected_version_no: input.expectedVersionNo,
      p_amount_paise: input.amountPaise,
      p_due_date: input.dueDate,
      p_note: input.note,
      p_request_id: input.requestId,
    }),
  );
}

export async function evidenceBegin(
  client: RpcClient,
  input: { taskId: string; kind: PurchaseEvidenceKind; fileName: string; mime: string; sizeBytes: number; sha256: string },
) {
  const fn = 'purchase_evidence_begin';
  return parse(
    fn,
    z.object({ evidenceId: z.uuid(), objectPath: z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/) }),
    await invoke(client, fn, {
      p_task_id: input.taskId,
      p_kind: input.kind,
      p_file_name: input.fileName,
      p_mime: input.mime,
      p_size_bytes: input.sizeBytes,
      p_sha256: input.sha256,
    }),
  );
}

export async function evidenceFinish(client: RpcClient, evidenceId: string, ok: boolean) {
  const fn = 'purchase_evidence_finish';
  return parse(
    fn,
    z.object({ evidenceId: z.uuid(), status: z.enum(['stored', 'failed']) }),
    await invoke(client, fn, { p_evidence_id: evidenceId, p_ok: ok }),
  );
}

export async function evidenceRemove(client: RpcClient, evidenceId: string) {
  const fn = 'purchase_evidence_remove';
  return parse(fn, z.object({ evidenceId: z.uuid(), status: z.literal('removed') }), await invoke(client, fn, { p_evidence_id: evidenceId }));
}

export async function evidenceAuthorizeDownload(client: RpcClient, evidenceId: string) {
  const fn = 'purchase_evidence_authorize_download';
  return parse(
    fn,
    z.object({ objectPath: z.string().min(1), fileName: z.string().min(1), mime: z.string().min(1) }),
    await invoke(client, fn, { p_evidence_id: evidenceId }),
  );
}

export async function supplierConfirm(client: RpcClient, taskId: string, expectedVersionNo: number, reference: string) {
  const fn = 'purchase_supplier_confirm';
  return parse(
    fn,
    z.object({ outcome: z.enum(['created', 'existing']), taskId: z.uuid() }),
    await invoke(client, fn, { p_task_id: taskId, p_expected_version_no: expectedVersionNo, p_reference: reference }),
  );
}

// ---------------------------------------------------------------------------
// Amendment A1 (contract §9): manager decisions, release, reassignment
// ---------------------------------------------------------------------------

const Outcome = z.enum(['created', 'existing']);

export async function supplierVerify(client: RpcClient, supplierId: string, expectedRowVersion: number) {
  const fn = 'supplier_verify';
  return parse(
    fn,
    z.object({ supplierId: z.uuid(), rowVersion: z.number().int().positive(), outcome: Outcome }),
    await invoke(client, fn, { p_supplier_id: supplierId, p_expected_row_version: expectedRowVersion }),
  );
}

export async function supplierApproveBeneficiary(client: RpcClient, supplierId: string, revisionNo: number) {
  const fn = 'supplier_approve_beneficiary';
  return parse(
    fn,
    z.object({ revisionNo: z.number().int().positive(), status: z.literal('approved'), outcome: Outcome }),
    await invoke(client, fn, { p_supplier_id: supplierId, p_revision_no: revisionNo }),
  );
}

export async function costApproveOverBudget(client: RpcClient, taskId: string, versionNo: number) {
  const fn = 'purchase_cost_approve_over_budget';
  return parse(
    fn,
    z.object({ taskId: z.uuid(), versionNo: z.number().int().positive(), outcome: Outcome }),
    await invoke(client, fn, { p_task_id: taskId, p_version_no: versionNo }),
  );
}

export async function taskRelease(client: RpcClient, taskId: string) {
  const fn = 'purchase_task_release';
  return parse(
    fn,
    z.object({ taskId: z.uuid(), status: z.literal('not_started'), outcome: Outcome }),
    await invoke(client, fn, { p_task_id: taskId }),
  );
}

export async function taskReassign(client: RpcClient, taskId: string, expectedAssigneeId: string, toUserId: string) {
  const fn = 'purchase_task_reassign';
  return parse(
    fn,
    z.object({ taskId: z.uuid(), outcome: Outcome }),
    await invoke(client, fn, { p_task_id: taskId, p_expected_assignee: expectedAssigneeId, p_to_user_id: toUserId }),
  );
}

// ---------------------------------------------------------------------------
// Purchase build (20261130000100..0120): e-mail, booking request, go-ahead,
// trip cancellation, e-mail switch
// ---------------------------------------------------------------------------

const Created = z.enum(['created', 'existing']);
const EmailResultSchema = z.object({ emailId: z.uuid(), status: z.enum(EMAIL_STATUSES), outcome: Created });

export interface SupplierEmailInput {
  to: string;
  cc: string[];
  subject: string;
  body: string;
}

export async function emailRecord(
  client: RpcClient,
  input: SupplierEmailInput & { taskId: string; kind: SupplierEmailKind; supplierId: string; requestId: string },
) {
  const fn = 'purchase_email_record';
  return parse(
    fn,
    EmailResultSchema,
    await invoke(client, fn, {
      p_task_id: input.taskId,
      p_kind: input.kind,
      p_supplier_id: input.supplierId,
      p_to: input.to,
      p_cc: input.cc,
      p_subject: input.subject,
      p_body: input.body,
      p_request_id: input.requestId,
    }),
  );
}

export async function bookingRequestSend(
  client: RpcClient,
  input: SupplierEmailInput & { taskId: string; expectedCostVersionNo: number; requestId: string },
) {
  const fn = 'purchase_booking_request_send';
  return parse(
    fn,
    EmailResultSchema.extend({ goAheadRequestId: z.uuid().nullable(), goAheadState: z.enum(GO_AHEAD_STATES) }),
    await invoke(client, fn, {
      p_task_id: input.taskId,
      p_expected_cost_version_no: input.expectedCostVersionNo,
      p_to: input.to,
      p_cc: input.cc,
      p_subject: input.subject,
      p_body: input.body,
      p_request_id: input.requestId,
    }),
  );
}

/** Server-only follow-up after the provider call: privileged client only (service_role; never the staff session). */
export async function emailMarkResult(
  client: RpcClient,
  input: { emailId: string; status: 'sent' | 'failed'; providerId: string | null; failure: string | null },
) {
  const fn = 'purchase_email_mark_result';
  return parse(
    fn,
    EmailResultSchema,
    await invoke(client, fn, {
      p_email_id: input.emailId,
      p_status: input.status,
      p_provider_id: input.providerId,
      p_failure: input.failure,
    }),
  );
}

export async function goAheadDecide(
  client: RpcClient,
  input: { goAheadRequestId: string; decision: GoAheadDecision; reason: string | null; expectedRowVersion: number; requestId: string },
) {
  const fn = 'purchase_go_ahead_decide';
  return parse(
    fn,
    z.object({ requestId: z.uuid(), status: z.enum(['approved', 'returned']), outcome: Created }),
    await invoke(client, fn, {
      p_request: input.goAheadRequestId,
      p_decision: input.decision,
      p_reason: input.reason,
      p_expected_row_version: input.expectedRowVersion,
      p_request_id: input.requestId,
    }),
  );
}

const CancellationResultSchema = z.object({
  cancellationId: z.uuid(),
  status: z.enum(CANCELLATION_STATUSES),
  rowVersion: z.number().int().positive(),
  outcome: Created,
});

export async function cancellationOpen(client: RpcClient, input: { dealId: string; reason: string; requestId: string }) {
  const fn = 'deal_cancellation_open';
  return parse(
    fn,
    CancellationResultSchema,
    await invoke(client, fn, { p_deal_id: input.dealId, p_reason: input.reason, p_request_id: input.requestId }),
  );
}

export interface CancellationChargeInput {
  taskId: string;
  keepsPaise: string;
  refundPaise: string;
  note: string | null;
  creditNoteEvidenceId: string | null;
  expectedRevision: number;
  requestId: string;
}

export async function cancellationChargeSet(client: RpcClient, input: CancellationChargeInput) {
  const fn = 'purchase_cancellation_charge_set';
  return parse(
    fn,
    z.object({ cancellationId: z.uuid(), revisionNo: z.number().int().positive(), status: z.enum(CANCELLATION_STATUSES), outcome: Created }),
    await invoke(client, fn, {
      p_task_id: input.taskId,
      p_keeps_paise: input.keepsPaise,
      p_refund_paise: input.refundPaise,
      p_note: input.note,
      p_credit_note_evidence_id: input.creditNoteEvidenceId,
      p_expected_revision: input.expectedRevision,
      p_request_id: input.requestId,
    }),
  );
}

export async function cancellationSend(client: RpcClient, input: { cancellationId: string; expectedRowVersion: number; requestId: string }) {
  const fn = 'deal_cancellation_send';
  return parse(
    fn,
    CancellationResultSchema,
    await invoke(client, fn, {
      p_cancellation_id: input.cancellationId,
      p_expected_row_version: input.expectedRowVersion,
      p_request_id: input.requestId,
    }),
  );
}

export async function cancellationDecide(
  client: RpcClient,
  input: { cancellationId: string; decision: CancellationDecision; reason: string | null; expectedRowVersion: number; requestId: string },
) {
  const fn = 'deal_cancellation_decide';
  return parse(
    fn,
    CancellationResultSchema,
    await invoke(client, fn, {
      p_cancellation_id: input.cancellationId,
      p_decision: input.decision,
      p_reason: input.reason,
      p_expected_row_version: input.expectedRowVersion,
      p_request_id: input.requestId,
    }),
  );
}

/** Super Admin switch; the database refuses everyone else (message 'not authorized', 42501). */
export async function setSupplierEmailSending(client: RpcClient, enabled: boolean, reason: string) {
  const fn = 'admin_set_supplier_email_sending';
  return parse(
    fn,
    z.object({ changed: z.boolean(), before: z.boolean(), after: z.boolean(), updatedAt: timestamp }),
    await invoke(client, fn, { p_enabled: enabled, p_reason: reason }),
  );
}

// ---- Reads ----------------------------------------------------------------

const AccountsGoAheadSchema = z.object({
  requestId: z.uuid(),
  status: z.enum(GO_AHEAD_REQUEST_STATUSES),
  current: z.boolean(),
  dealId: z.uuid(),
  dealReference: z.string().min(1),
  branchName: z.string(),
  taskId: z.uuid(),
  itemTitle: z.string().min(1).max(400),
  checkIn: isoDate.nullable(),
  checkOut: isoDate.nullable(),
  supplierName: z.string(),
  amountPaise: paise,
  costVersionNo: z.number().int().positive(),
  requestedAt: timestamp,
  requestedByName: nullableText,
  decidedAt: timestamp.nullable(),
  decidedByName: nullableText,
  returnReason: nullableText,
  rowVersion: z.number().int().positive(),
  bookingReviewStatus: z.enum(['pending', 'returned', 'approved', 'missing']),
  canDecide: z.boolean(),
});
export type AccountsGoAheadRecord = z.output<typeof AccountsGoAheadSchema>;

export async function accountsGoAheadList(client: RpcClient): Promise<AccountsGoAheadRecord[]> {
  const fn = 'accounts_go_ahead_list';
  return parse(fn, z.array(AccountsGoAheadSchema).max(500), await invoke(client, fn, {}));
}

const ManagerCancellationSchema = z.object({
  cancellationId: z.uuid(),
  dealId: z.uuid(),
  dealReference: z.string().min(1),
  branchName: z.string(),
  status: z.enum(CANCELLATION_STATUSES),
  reason: z.string().min(1).max(500),
  openedAt: timestamp,
  openedByName: nullableText,
  sentAt: timestamp.nullable(),
  sentByName: nullableText,
  decidedAt: timestamp.nullable(),
  decidedByName: nullableText,
  returnReason: nullableText,
  rowVersion: z.number().int().positive(),
  charges: z.array(ChargeSchema.extend({ itemTitle: z.string().min(1).max(400) })),
  totalKeepsPaise: paise,
  totalRefundPaise: paise,
  canDecide: z.boolean(),
});
export type ManagerCancellationRecord = z.output<typeof ManagerCancellationSchema>;

export async function managerCancellationList(client: RpcClient): Promise<ManagerCancellationRecord[]> {
  const fn = 'manager_cancellation_list';
  return parse(fn, z.array(ManagerCancellationSchema), await invoke(client, fn, {}));
}

const DealCancellationSchema = z.object({
  canOpen: z.boolean(),
  cancellation: z
    .object({
      cancellationId: z.uuid(),
      status: z.enum(CANCELLATION_STATUSES),
      reason: z.string().min(1).max(500),
      openedAt: timestamp,
      openedByName: nullableText,
      decidedAt: timestamp.nullable(),
    })
    .nullable(),
});
export type DealCancellationRecord = z.output<typeof DealCancellationSchema>;

/** null = Deal not found or not readable. */
export async function dealCancellationSummary(client: RpcClient, dealId: string): Promise<DealCancellationRecord | null> {
  const fn = 'deal_cancellation_summary';
  return parse(fn, DealCancellationSchema.nullable(), await invoke(client, fn, { p_deal_id: dealId }));
}

/** Purchase queue flags (purchase_task_list additions); other keys of the row are read by the fulfilment module. */
export async function purchaseQueueFlags(client: RpcClient): Promise<Array<{ taskId: string; goAheadState: GoAheadState; tripCancelled: boolean }>> {
  const fn = 'purchase_task_list';
  const data = await invoke(client, fn, {});
  if (data === null) return [];
  return parse(
    fn,
    z.array(
      z.object({
        taskId: z.uuid(),
        goAheadState: z.enum(GO_AHEAD_STATES).optional().transform((v) => v ?? 'not_needed'),
        tripCancelled: z.boolean().optional().transform((v) => v ?? false),
      }),
    ),
    data,
  );
}
