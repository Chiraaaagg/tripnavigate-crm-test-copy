import { z } from 'zod';
import {
  type ActivityServiceFacts,
  type BeginEvidenceResult,
  type BookingErrorCode,
  type BookingFacts,
  type BookingIssueCode,
  type BookingReadiness,
  type ClaimTaskResult,
  type ConfirmBookingResult,
  type DealProgress,
  type DealServiceSummaryView,
  type EvidenceKind,
  type EvidenceMime,
  type EvidenceStatus,
  type FlightServiceFacts,
  type HotelServiceFacts,
  INTAKE_CHECKLIST_CODES,
  type IntakeChecklist,
  type IntakeChecklistCode,
  MAX_FLIGHT_SEGMENTS,
  MAX_SERVICE_ITEMS,
  MAX_TRAVELLERS,
  type MyWorkCounts,
  type OpenDraftResult,
  type PurchaseTaskStatus,
  type SaveDraftResult,
  SERVICE_FACT_LIMITS,
  SERVICE_TYPES,
  type ServiceFacts,
  type ServiceItemAddResult,
  type ServiceItemRemoveResult,
  type ServiceItemSaveResult,
  type ServiceType,
  TRAVELLER_TYPES,
  type TransferServiceFacts,
  type Traveller,
  type TravellersSaveResult,
  WORKFLOW_SETTING_KEYS,
  type WorkflowSettingKey,
  type WorkflowSettingResult,
  type WorkflowSettingsView,
  B11_FACT_LIMITS,
  type BookingTrip,
  DEPARTMENT_TASK_STATUSES,
  FLIGHT_TRIP_TYPES,
  HOTEL_MODES,
  INTAKE_CHECKLIST_OWNERS,
  PASSPORT_APPLICATION_TYPES,
  type PassportServiceFacts,
  type ServiceNextStep,
  TRIP_SCOPES,
  VISA_FEE_PAID_BY,
  type VisaServiceFacts,
} from './contracts';
import { CAR_KINDS, REQUEST_ITEMS_MAX, REQUEST_TEXT_MAX } from './booking-form-contract';

/**
 * Typed wrappers for agent B's booking / Purchase commands (contract §5) and
 * read functions (migration 20261004000100_booking_purchase_task.sql). Every
 * call runs under the CALLER's client: the staff member's own session for all
 * of them (the privileged client is used only for Storage, never here).
 *
 * Responses are validated with zod. Anything unexpected throws
 * BookingCommandError with `code: null` (fail closed). Database messages are
 * never surfaced: errors map by SQLSTATE + the exact message token (§5).
 */

export interface RpcError {
  code?: string;
  message?: string;
  /** PostgREST passes the Postgres HINT: B1.1 commands put the refused input keys there (invalid_input). */
  hint?: string | null;
}

export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

/** Narrow a Supabase client to the RPC surface used here. */
export function asRpcClient(client: { rpc: (...args: never[]) => unknown }): RpcClient {
  return client as unknown as RpcClient;
}

/** Contract §5: each refusal token and the only SQLSTATE it may arrive with. */
export const BOOKING_ERROR_STATES: Record<BookingErrorCode, string> = {
  not_authorized: '42501',
  version_changed: '40001',
  task_conflict: '40001',
  booking_disabled: '55000',
  not_ready: '55000',
  environment_unset: '55000',
  already_confirmed: '55000',
  invalid_input: '22023',
  evidence_rejected: '22023',
  deal_removed: '55000',
  deal_not_active: '55000',
  not_found: 'P0002',
  // B1 (contract §11, freeze note §3.3).
  service_on_hold: '22023',
  too_many_items: '22023',
  item_locked: '55000',
  traveller_identity_locked: '55000',
  service_items_disabled: '55000',
  // B1.1 (appendix A §4, freeze note §4).
  billing_verified: '55000',
  version_superseded: '55000',
  revision_not_allowed: '55000',
  already_committed: '55000',
  classification_not_allowed: '22023',
  revision_items_fixed: '55000',
  documents_not_checked: '55000',
  outcome_document_required: '55000',
  outcome_required: '55000',
  application_closed: '55000',
  task_closed: '55000',
  cost_locked: '55000',
  receipt_required: '55000',
  direct_payment_over_limit: '22023',
  request_conflict: '40001',
  wrong_state: '55000',
  // B1.2 traveller identity proof (0100)
  id_proof_limit: '55000',
  consent_required: '22023',
  // B1.2 Bitrix prefill (0600)
  prefill_unavailable: '55000',
  // Batch 2 (migration A): admin_set_workflow_setting while the settings row is held
  settings_busy: '55P03',
  switch_off: '55000',
  // Booking form (20261124000110)
  priced_per_person: '55000',
  item_file_limit: '55000',
  // Book now v2: "Refresh from Bitrix now" refusals. Set by the server action, not raised by a
  // database command today; the states are the ones such a refusal would use.
  refresh_too_soon: '55000',
  refresh_switched_off: '55000',
  refresh_not_bitrix_deal: '55000',
  bitrix_unavailable: '55000',
  bitrix_deal_not_found: 'P0002',
};

/** PostgREST / GoTrue codes meaning the JWT is missing, expired or invalid. */
const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);

/** Postgres states that mean "the input was not acceptable" when no token is present. */
const INPUT_STATES = new Set(['22023', '22P02', '22001', '22003', '22007', '22008', '23514', '23502']);

/** A hint is kept only when it is a plain list of input keys (never free text from the database). */
const HINT_KEYS = /^[A-Za-z0-9_.[\]]{1,60}(,[A-Za-z0-9_.[\]]{1,60}){0,30}$/;

export function safeHintKeys(hint: string | null | undefined): string[] {
  const value = (hint ?? '').trim();
  return HINT_KEYS.test(value) ? value.split(',') : [];
}

export class BookingCommandError extends Error {
  override name = 'BookingCommandError';
  constructor(
    readonly command: string,
    /** The mapped refusal, 'session' for an ended JWT, or null for anything unexpected. */
    readonly code: BookingErrorCode | 'session' | null,
    readonly sqlState: string | null,
    /** B1.1: refused input keys from the database hint (invalid_input only); never shown as text. */
    readonly hintKeys: string[] = [],
  ) {
    // Never include the database message: it could echo arguments.
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapBookingError(error: RpcError): BookingErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(BOOKING_ERROR_STATES, token) && BOOKING_ERROR_STATES[token as BookingErrorCode] === state) {
    return token as BookingErrorCode;
  }
  if (SESSION_STATES.has(state)) return 'session';
  // Without an exact token, only the unambiguous states map (fail closed: a
  // 55000/40001 without its token is NOT guessed into a specific refusal).
  if (state === '42501') return 'not_authorized';
  if (state === 'P0002') return 'not_found';
  if (INPUT_STATES.has(state)) return 'invalid_input';
  return null;
}

/**
 * B1.1: PostgREST "function not in the schema cache" (PGRST202) or Postgres
 * "undefined function" (42883). Loaders treat it as "B1.1 not installed".
 */
export const FUNCTION_MISSING_STATES = new Set(['PGRST202', '42883']);

export function isFunctionMissing(error: unknown): boolean {
  return error instanceof BookingCommandError && error.sqlState !== null && FUNCTION_MISSING_STATES.has(error.sqlState);
}

/** Shared by the B1.1 wrapper files (same mapping and fail-closed rules). */
export async function callRpc(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  return invoke(client, fn, args);
}

export function parseReply<T>(fn: string, schema: z.ZodType<T>, data: unknown): T {
  return parse(fn, schema, data);
}

async function invoke(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, args);
  } catch {
    throw new BookingCommandError(fn, null, null);
  }
  if (result.error) {
    const code = mapBookingError(result.error);
    throw new BookingCommandError(fn, code, result.error.code ?? null, code === 'invalid_input' ? safeHintKeys(result.error.hint) : []);
  }
  return result.data;
}

function parse<T>(fn: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new BookingCommandError(fn, null, null);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

export const ISSUE_CODES = [
  'missing_hotel_name',
  'missing_city',
  'missing_dates',
  'check_out_not_after_check_in',
  'missing_rooms',
  'missing_travellers',
  'missing_purchase_budget',
  'missing_selling_total',
  'missing_selling_total_ask_owner',
  'missing_acceptance_proof',
  'evidence_upload_incomplete',
  'source_not_recently_verified',
  'booking_disabled',
  'environment_unset',
  // B1 package versions (contract §7.2).
  'no_services',
  'traveller_missing',
  'traveller_count_mismatch',
  'stage_not_confirmed',
  'service_facts_invalid',
  // B1.1 (appendix A §1.4, §2.2).
  'contact_missing',
  'contact_not_confirmed',
  'billing_missing',
  'gstin_missing',
  'trip_missing',
  'child_age_missing',
  'participation_missing',
  'identity_missing',
  'plan_missing',
  'plan_total_mismatch',
  'plan_ask_owner',
  'revision_class_missing',
  'customer_acceptance_required',
  'no_changes',
  'base_no_longer_returned',
  // B1.2 (0100)
  'id_proof_missing',
  // B1.2 (0200)
  'quote_acceptance_stale',
  // Booking form (20261124000120)
  'pax_missing',
  'pax_types_exceeded',
  'price_missing',
  'price_count_mismatch',
  'price_below_purchase',
  'hotel_nights_missing',
  'hotel_outside_trip',
  'hotel_same_day_trip',
  'service_dates_outside_trip',
  'gst_status_missing',
  'gst_reason_missing',
  'billing_contact_missing',
  'billing_reach_missing',
  // Book now v2 (20261129000120)
  'flight_screenshot_missing',
  'prices_ask_owner',
] as const satisfies readonly BookingIssueCode[];
type MissingIssueCode = Exclude<BookingIssueCode, (typeof ISSUE_CODES)[number]>;
/** Compile-time guard: every frozen BookingIssueCode is accepted from the database. */
export const ISSUE_CODES_COMPLETE: [MissingIssueCode] extends [never] ? true : false = true;

const ENVIRONMENTS = ['unset', 'test', 'staging', 'operational'] as const;
const TASK_STATUSES = ['not_started', 'in_progress', 'supplier_confirmed'] as const satisfies readonly PurchaseTaskStatus[];
const EVIDENCE_STATUSES = ['pending_upload', 'stored', 'failed', 'removed'] as const satisfies readonly EvidenceStatus[];
const KINDS = ['acceptance_message', 'ticket', 'bill', 'payment_proof', 'other'] as const satisfies readonly EvidenceKind[];
const MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const satisfies readonly EvidenceMime[];

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().min(1).refine((v) => !Number.isNaN(Date.parse(v)));
const count = z.number().int().nonnegative();
/** bigint paise from jsonb (number or numeric string) → decimal string; never a float. */
const paise = z
  .union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^(0|[1-9][0-9]{0,18})$/)])
  .transform(String);
const text = (max: number) => z.string().max(max);
const optionalNull = <T extends z.ZodType>(schema: T) =>
  schema.nullable().optional().transform((v) => (v ?? null) as z.output<T> | null);
/**
 * B1.1: a permission or state flag the SQL may answer null for (an `and`
 * over a missing version, e.g. `v.status = 'draft' and …`). null reads as
 * false: never grants a right, never shows a state that is not there.
 */
export const flag = z.boolean().nullable().transform((v) => v ?? false);

const FactsSchema = z.object({
  hotelName: optionalNull(text(200)),
  city: optionalNull(text(120)),
  checkIn: optionalNull(isoDate),
  checkOut: optionalNull(isoDate),
  rooms: optionalNull(z.number().int()),
  roomType: optionalNull(text(120)),
  mealPlan: optionalNull(text(60)),
  adults: optionalNull(z.number().int()),
  children: optionalNull(z.number().int()),
  inclusions: optionalNull(text(2000)),
  specialRequests: optionalNull(text(2000)),
  purchaseBudgetPaise: optionalNull(paise),
}) satisfies z.ZodType<BookingFacts, unknown>;

const KNOWN_ISSUE_CODES = new Set<string>(ISSUE_CODES);
/**
 * Tolerant code list (booking form release: the app ships before its
 * migration and must also load on a newer database): a code this build does
 * not know is dropped, never a reason to fail the page. The database still
 * refuses submit while any blocking issue remains (not_ready).
 */
const issueCodeList = z
  .array(z.string().min(1).max(80))
  .max(100)
  .transform((codes) => codes.filter((c): c is (typeof ISSUE_CODES)[number] => KNOWN_ISSUE_CODES.has(c)));

export const ReadinessSchema = z.object({
  ready: z.boolean(),
  issues: issueCodeList,
  contentHash: hash,
}) satisfies z.ZodType<BookingReadiness, unknown>;

// ---------------------------------------------------------------------------
// Commands (§5)
// ---------------------------------------------------------------------------

const OpenDraftSchema = z.object({
  versionId: z.uuid(),
  versionNo: z.number().int().positive(),
  rowVersion: z.number().int().nonnegative(),
  created: z.boolean(),
});

export async function openDraft(client: RpcClient, dealId: string): Promise<OpenDraftResult> {
  const fn = 'booking_open_draft';
  return parse(fn, OpenDraftSchema, await invoke(client, fn, { p_deal_id: dealId }));
}

const SaveDraftSchema = z.object({
  versionId: z.uuid(),
  rowVersion: z.number().int().nonnegative(),
  contentHash: hash,
});

export async function saveDraft(
  client: RpcClient,
  input: {
    versionId: string;
    expectedRowVersion: number;
    facts: BookingFacts;
    sellingTotalPaise: string | null;
    /** false = leave the commercial row untouched (contract §12 A4 M3). */
    sellingTotalProvided: boolean;
  },
): Promise<SaveDraftResult> {
  const fn = 'booking_save_draft';
  const data = await invoke(client, fn, {
    p_version_id: input.versionId,
    p_expected_row_version: input.expectedRowVersion,
    p_facts: input.facts,
    // bigint parameter: PostgREST accepts a numeric string and keeps precision.
    p_selling_total_paise: input.sellingTotalProvided ? input.sellingTotalPaise : null,
    p_selling_total_provided: input.sellingTotalProvided,
  });
  return parse(fn, SaveDraftSchema, data);
}

const BeginEvidenceSchema = z.object({
  evidenceId: z.uuid(),
  // Server-generated <entity>/<deal>/<version>/<evidence id>; no traversal, no leading slash.
  objectPath: z
    .string()
    .regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/i),
});

export async function beginEvidence(
  client: RpcClient,
  input: { versionId: string; kind: EvidenceKind; fileName: string; mime: EvidenceMime; sizeBytes: number; sha256: string },
): Promise<BeginEvidenceResult> {
  const fn = 'booking_begin_evidence';
  const data = await invoke(client, fn, {
    p_version_id: input.versionId,
    p_kind: input.kind,
    p_file_name: input.fileName,
    p_mime: input.mime,
    p_size_bytes: input.sizeBytes,
    p_sha256: input.sha256,
  });
  return parse(fn, BeginEvidenceSchema, data);
}

const FinishEvidenceSchema = z.object({ evidenceId: z.uuid(), status: z.enum(EVIDENCE_STATUSES) });

export async function finishEvidence(
  client: RpcClient,
  evidenceId: string,
  ok: boolean,
): Promise<{ evidenceId: string; status: EvidenceStatus }> {
  const fn = 'booking_finish_evidence';
  return parse(fn, FinishEvidenceSchema, await invoke(client, fn, { p_evidence_id: evidenceId, p_ok: ok }));
}

const RemoveEvidenceSchema = z.object({ evidenceId: z.uuid(), status: z.literal('removed') });

export async function removeEvidence(client: RpcClient, evidenceId: string): Promise<{ evidenceId: string; status: 'removed' }> {
  const fn = 'booking_remove_evidence';
  return parse(fn, RemoveEvidenceSchema, await invoke(client, fn, { p_evidence_id: evidenceId }));
}

const AuthorizeDownloadSchema = z.object({
  objectPath: BeginEvidenceSchema.shape.objectPath,
  fileName: z.string().min(1).max(120).regex(/^[A-Za-z0-9._ -]+$/),
  mime: z.enum(MIMES),
});

export async function authorizeEvidenceDownload(
  client: RpcClient,
  evidenceId: string,
): Promise<{ objectPath: string; fileName: string; mime: EvidenceMime }> {
  const fn = 'booking_authorize_evidence_download';
  return parse(fn, AuthorizeDownloadSchema, await invoke(client, fn, { p_evidence_id: evidenceId }));
}

export async function readiness(client: RpcClient, versionId: string): Promise<BookingReadiness> {
  const fn = 'booking_readiness';
  return parse(fn, ReadinessSchema, await invoke(client, fn, { p_version_id: versionId }));
}

const ConfirmSchema = z.object({
  outcome: z.enum(['created', 'existing', 'revised']),
  /** B1.1: null when no task was created (visa/passport waiting for the desk launch). */
  taskId: z.uuid().nullable(),
  versionId: z.uuid(),
  /** B1: every task of the version; absent from databases before the B1 migration. B1.1: may be empty. */
  taskIds: z.array(z.uuid()).optional(),
  supersededVersionId: z.uuid().optional(),
})
  // Consistency (fail closed): no task ⇔ an empty list; a task id is one of the listed tasks.
  .refine((r) => (r.taskId === null ? (r.taskIds ?? []).length === 0 : r.taskIds === undefined || r.taskIds.includes(r.taskId)));

export async function confirmBooking(
  client: RpcClient,
  input: { versionId: string; expectedContentHash: string },
): Promise<ConfirmBookingResult> {
  const fn = 'booking_confirm';
  const data = await invoke(client, fn, {
    p_version_id: input.versionId,
    p_expected_content_hash: input.expectedContentHash,
  });
  return parse(fn, ConfirmSchema, data);
}

const ClaimSchema = z.object({
  taskId: z.uuid(),
  status: z.enum(TASK_STATUSES),
  assignedToYou: z.literal(true),
  alreadyYours: z.boolean(),
});

export async function claimPurchaseTask(client: RpcClient, taskId: string): Promise<ClaimTaskResult> {
  const fn = 'purchase_task_claim';
  return parse(fn, ClaimSchema, await invoke(client, fn, { p_task_id: taskId }));
}

// ---------------------------------------------------------------------------
// Read functions (agent B; security definer, session user's authorization)
// ---------------------------------------------------------------------------

const GateSchema = z.object({
  realBookingEnabled: z.boolean(),
  environment: z.enum(ENVIRONMENTS),
});

const EvidenceRowSchema = z.object({
  id: z.uuid(),
  kind: z.enum(KINDS),
  fileName: z.string().max(120),
  mime: z.enum(MIMES).optional(),
  sizeBytes: z.number().int().nonnegative(),
  status: z.enum(EVIDENCE_STATUSES),
  /** null when the uploader row is gone (`uploaded_by = auth.uid()` over null). */
  uploadedByYou: flag,
  createdAt: timestamp,
});

const PanelVersionSchema = z.object({
  versionId: z.uuid(),
  versionNo: z.number().int().positive(),
  status: z.enum(['draft', 'confirmed']),
  rowVersion: z.number().int().nonnegative(),
  contentHash: hash,
  facts: FactsSchema,
  /**
   * ABSENT (undefined) when the database withholds it (no deal.read_commercial);
   * null when readable but not yet set. Kept distinct on purpose (re-review L-b).
   */
  sellingTotalPaise: paise.nullable().optional(),
  confirmedAt: optionalNull(timestamp),
  confirmedByName: optionalNull(z.string()),
});

const PanelTaskSchema = z.object({
  taskId: z.uuid(),
  status: z.enum(TASK_STATUSES),
  assigneeName: optionalNull(z.string()),
});

export const BookingPanelSchema = z.object({
  dealId: z.uuid(),
  canEdit: z.boolean(),
  canConfirm: z.boolean(),
  gate: GateSchema,
  version: PanelVersionSchema.nullable(),
  readiness: ReadinessSchema.nullable(),
  evidence: z.array(EvidenceRowSchema),
  evidenceVisible: z.boolean(),
  task: PanelTaskSchema.nullable(),
  /** Stage 7 (20261115000100): the Deal is lost or rejected in Bitrix. Absent from older databases = false. */
  dealNotActive: z.boolean().optional(),
  /** B1: the Deal's service items (role-filtered by the database) and progress. Absent before the B1 migration. */
  services: z.array(z.lazy(() => ServiceItemRecordSchema)).optional(),
  progress: z.lazy(() => ProgressSchema).optional(),
});
export type BookingPanelRecord = z.output<typeof BookingPanelSchema>;

/** null = the deal is not visible to the caller (or does not exist). */
export async function bookingPanel(client: RpcClient, dealId: string): Promise<BookingPanelRecord | null> {
  const fn = 'booking_panel';
  const data = await invoke(client, fn, { p_deal_id: dealId });
  if (data === null) return null;
  return parse(fn, BookingPanelSchema, data);
}

const PurchaseSummarySchema = z.object({
  taskId: z.uuid(),
  dealReference: z.string().min(1),
  /**
   * B1: the sold service, its title and typed facts. Absent from databases
   * before the B1 migration; the DTO then builds hotel facts from the hotel
   * columns (deploy order: app first, migration second; contract §13).
   */
  serviceType: z.enum(SERVICE_TYPES).optional(),
  itemTitle: z.string().min(1).max(400).optional(),
  facts: z.lazy(() => ServiceFactsSchema).optional(),
  /** Hotel fields: filled for hotel tasks; null / 0 for other service types (B1). */
  hotelName: optionalNull(z.string().min(1)),
  city: optionalNull(z.string().min(1)),
  checkIn: optionalNull(isoDate),
  checkOut: optionalNull(isoDate),
  rooms: count,
  adults: count,
  children: count,
  purchaseBudgetPaise: paise,
  status: z.enum(TASK_STATUSES),
  assigneeName: optionalNull(z.string()),
  assignedToYou: z.boolean(),
  branchName: z.string(),
  createdAt: timestamp,
  /** Phase 4 (P4-D6): when the supplier confirmed; null before that. */
  supplierConfirmedAt: optionalNull(timestamp),
});
export type PurchaseTaskRecord = z.output<typeof PurchaseSummarySchema>;

/** B1.1 restricted identity (only where the database allows it). */
export const IdentitySchema = z.object({
  dateOfBirth: optionalNull(isoDate),
  nationality: optionalNull(text(60)),
  passportNumber: optionalNull(z.string().regex(/^[A-Z0-9]{6,15}$/)),
  passportExpiry: optionalNull(isoDate),
  /** null for a confirmed version's snapshot; 0 when absent. */
  rowVersion: count.nullable().optional().transform((v) => v ?? 0),
});

/**
 * B1.1: a traveller on a department task (own item's participants). Identity
 * keys arrive flat on the row, and only for the Flight assignee on an
 * international trip (database rule); the DTO groups them.
 */
export const TaskParticipantSchema = z.object({
  seq: z.number().int().min(1).max(100),
  fullName: z.string().min(1).max(120),
  type: z.enum(TRAVELLER_TYPES),
  ageYears: optionalNull(z.number().int().min(0).max(17)),
  specialNeeds: optionalNull(text(500)),
  dateOfBirth: isoDate.nullable().optional(),
  nationality: text(60).nullable().optional(),
  passportNumber: z.string().regex(/^[A-Z0-9]{6,15}$/).nullable().optional(),
  passportExpiry: isoDate.nullable().optional(),
});
export type TaskParticipantRecord = z.output<typeof TaskParticipantSchema>;

const TaskB11Extras = {
  /** B1.1 (0100): the item's participants; absent on older databases. */
  participants: z.array(TaskParticipantSchema).max(100).optional(),
  /** B1.1 (0100, flight detail): trip scope of the accepted version. */
  tripScope: z.enum(TRIP_SCOPES).nullable().optional(),
  /** B1.1 (0300): changed non-commercial field names of the current accepted version (no length cap: fail closed only on shape). */
  changedFields: z.array(z.string().max(120)).optional(),
};

/**
 * Booking form (20261124000120, contract rulings 9 and 14): the supplier
 * estimate of the task's own item (cost side only, never a sale) and, for a
 * flight, its screenshots. The database sends them only to the task
 * assignee; absent otherwise and on an older database.
 */
const taskPaise = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).nullable().optional().transform((v) => v ?? null);
const TaskEstimateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hotel'), roomRatePaise: taskPaise, extraBedRatePaise: taskPaise, noBedRatePaise: taskPaise }),
  z.object({ kind: z.literal('transfer'), vehicleRatePaise: taskPaise }),
  // Book now v2: fare per person (absent on an older database = null).
  z.object({ kind: z.literal('flight'), fareTotalPaise: taskPaise, fareAdultPaise: taskPaise, fareChildPaise: taskPaise, fareInfantPaise: taskPaise }),
]);
/** Book now v2: typed total fare per person of all flights of the booking (Flight assignee only; null = none typed). */
const TaskFareTotalsSchema = z.object({ adultPaise: taskPaise, childPaise: taskPaise, infantPaise: taskPaise });
const TaskFileSchema = z.object({
  fileId: z.uuid(),
  kind: z.literal('flight_screenshot'),
  fileName: z.string().min(1).max(120),
  mime: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']),
  sizeBytes: z.number().int().min(1).max(4 * 1024 * 1024),
  status: z.enum(['pending_upload', 'stored', 'failed', 'removed']),
  createdAt: timestamp,
  storedAt: timestamp.nullable().optional(),
  rowVersion: z.number().int().positive().optional(),
  uploadedByYou: z.boolean().nullable().optional(),
});
export type TaskFileRecord = z.output<typeof TaskFileSchema>;

const PurchaseDetailSchema = PurchaseSummarySchema.extend({
  roomType: optionalNull(z.string()),
  mealPlan: optionalNull(z.string()),
  inclusions: optionalNull(z.string()),
  specialRequests: optionalNull(z.string()),
  confirmedAt: timestamp,
  confirmedByName: z.string(),
  versionNo: z.number().int().positive(),
  canClaim: z.boolean(),
  ...TaskB11Extras,
  estimate: TaskEstimateSchema.nullable().optional(),
});
export type PurchaseTaskDetailRecord = z.output<typeof PurchaseDetailSchema>;

export async function purchaseTaskList(client: RpcClient): Promise<PurchaseTaskRecord[]> {
  const fn = 'purchase_task_list';
  const data = await invoke(client, fn, {});
  if (data === null) return [];
  return parse(fn, z.array(PurchaseSummarySchema), data);
}

/** null = not found or not visible (indistinguishable). */
export async function purchaseTaskGet(client: RpcClient, taskId: string): Promise<PurchaseTaskDetailRecord | null> {
  const fn = 'purchase_task_get';
  const data = await invoke(client, fn, { p_task_id: taskId });
  if (data === null) return null;
  return parse(fn, PurchaseDetailSchema, data);
}

const HealthSchema = GateSchema.extend({
  drafts: count,
  draftsNeedingRepair: count,
  confirmed: count,
  tasksNotStarted: count,
  tasksInProgress: count,
  pendingOutboxEvents: count,
});
export type BookingHealthRecord = z.output<typeof HealthSchema>;

export async function bookingHealth(client: RpcClient): Promise<BookingHealthRecord> {
  const fn = 'booking_health';
  return parse(fn, HealthSchema, await invoke(client, fn, {}));
}

// ===========================================================================
// B1: service items, travellers, intake checklist, Deal services, My work
// counts, Flight queue and workflow switches (freeze note §3.3). Same rules
// as above: the caller's own session, zod-validated replies (fail closed),
// refusal tokens mapped by SQLSTATE + exact token.
// ===========================================================================

const L = SERVICE_FACT_LIMITS;
const B11 = B11_FACT_LIMITS;
const time24 = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
/** B1.1: IATA code or a place name (appendix A §1.2). */
const place = z.string().refine((v) => /^[A-Z]{3}$/.test(v) || /^[A-Za-z][A-Za-z .'-]{1,59}$/.test(v));
const nullableText = (max: number) => optionalNull(text(max));
const nullableInt = (min: number, max: number) => optionalNull(z.number().int().min(min).max(max));

/**
 * Facts per service type as stored (contract §8, SERVICE_FACT_KEYS). Strict
 * objects: an unknown key fails the parse. Cross-field rules (check-out after
 * check-in, ordered segment dates) are the database's; the client-side
 * mirror lives in forms.ts.
 */
/** Book now v2: requests "for whom" as stored (shape only; the database checks the travellers). */
const RequestItemsSchema = z
  .array(z.strictObject({ text: text(REQUEST_TEXT_MAX).min(1), forSeq: z.number().int().min(1).max(100).nullable().optional().transform((v) => v ?? null) }))
  .max(REQUEST_ITEMS_MAX);

export const HotelFactsSchema = z.strictObject({
  /** B1.1: absent in 'preferences' mode (validated below). */
  hotelName: optionalNull(text(200).min(1)),
  city: text(120).min(1),
  checkIn: isoDate,
  checkOut: isoDate,
  rooms: z.number().int().min(1).max(50),
  adults: z.number().int().min(1).max(100),
  roomType: nullableText(120),
  mealPlan: nullableText(60),
  children: nullableInt(0, 100),
  inclusions: nullableText(2000),
  specialRequests: nullableText(2000),
  // B1.1 additive keys: optional on the wire, absent stays absent.
  mode: z.enum(HOTEL_MODES).nullable().optional(),
  preferences: text(B11.hotelPreferences).min(1).nullable().optional(),
  area: text(B11.area).min(1).nullable().optional(),
  childAges: z.array(z.number().int().min(0).max(17)).max(100).nullable().optional(),
  exclusions: text(B11.exclusions).min(1).nullable().optional(),
  // B1.2 (0200, DEC-33): counts and remarks only; optional, absent stays absent.
  extraBeds: z.number().int().min(0).max(20).nullable().optional(),
  childrenWithoutBed: z.number().int().min(0).max(20).nullable().optional(),
  bedRemarks: text(300).min(1).nullable().optional(),
  // Book now v2: requests "for whom" (the readable text is in specialRequests).
  requestItems: RequestItemsSchema.nullable().optional(),
})
  .refine((f) => (f.mode === 'preferences' ? !!f.preferences : !!f.hotelName)) satisfies z.ZodType<HotelServiceFacts, unknown>;

export const TransferFactsSchema = z.strictObject({
  route: text(L.route).min(1),
  date: isoDate,
  /** B1.1: optional (plan §3f). */
  vehicleType: optionalNull(text(L.vehicleType).min(1)),
  passengers: nullableInt(L.passengers.min, L.passengers.max),
  pickupTime: optionalNull(time24),
  notes: nullableText(L.notes),
  pickup: text(B11.pickup).min(1).nullable().optional(),
  drop: text(B11.drop).min(1).nullable().optional(),
  // Booking form (20261124000120, booking-form-contract.ts TransferFactKeys): a car for the whole trip.
  endDate: isoDate.nullable().optional(),
  quantity: z.number().int().min(1).max(100).nullable().optional(),
  includedKms: z.number().int().min(0).max(100_000).nullable().optional(),
  vendor: text(150).min(1).nullable().optional(),
  // Book now v2: car type and the flight it meets.
  carKind: z.enum(CAR_KINDS).nullable().optional(),
  flightItemId: z.uuid().nullable().optional(),
}) satisfies z.ZodType<TransferServiceFacts, unknown>;

export const ActivityFactsSchema = z.strictObject({
  name: text(L.activityName).min(1),
  city: text(L.city).min(1),
  date: isoDate,
  participants: z.number().int().min(L.passengers.min).max(L.passengers.max),
  time: optionalNull(time24),
  notes: nullableText(L.notes),
  inclusions: text(B11.activityInclusions).min(1).nullable().optional(),
}) satisfies z.ZodType<ActivityServiceFacts, unknown>;

export const FlightFactsSchema = z.strictObject({
  // Book now v2: a flight added from a screenshot has no typed leg (checked below).
  segments: z
    .array(
      z.strictObject({
        from: place,
        to: place,
        date: isoDate,
        flex: text(B11.flex).min(1).nullable().optional(),
        // Booking form (20261124000120, FlightSegmentKeys). Local clock times are never compared across time zones.
        arrivalDate: isoDate.nullable().optional(),
        airline: text(60).min(1).nullable().optional(),
        flightNo: text(12).min(1).nullable().optional(),
        departTime: time24.nullable().optional(),
        arriveTime: time24.nullable().optional(),
      }),
    )
    .max(MAX_FLIGHT_SEGMENTS),
  passengers: z.number().int().min(L.passengers.min).max(L.passengers.max),
  preferredTime: nullableText(L.preferredTime),
  cabin: nullableText(L.cabin),
  notes: nullableText(L.notes),
  tripType: z.enum(FLIGHT_TRIP_TYPES).nullable().optional(),
  preferences: text(B11.flightPreferences).min(1).nullable().optional(),
  assistance: text(B11.assistance).min(1).nullable().optional(),
  // Book now v2
  entryMode: z.enum(['typed', 'screenshot']).nullable().optional(),
  screenshotNote: text(200).min(1).nullable().optional(),
  requestItems: RequestItemsSchema.nullable().optional(),
  isReturn: z.boolean().nullable().optional(),
})
  // Typed details need at least one leg; a screenshot flight may have none.
  .refine((f) => f.entryMode === 'screenshot' || f.segments.length >= L.segments.min) satisfies z.ZodType<FlightServiceFacts, unknown>;

/** B1.1 visa facts (appendix A §1.2). */
export const VisaFactsSchema = z.strictObject({
  country: text(B11.visaCountry).min(1),
  purpose: text(B11.visaPurpose).min(1),
  travelDate: isoDate,
  applyBy: optionalNull(isoDate),
  feePaidBy: z.enum(VISA_FEE_PAID_BY),
  notes: nullableText(B11.notes),
}) satisfies z.ZodType<VisaServiceFacts, unknown>;

/** B1.1 passport facts (appendix A §1.2). */
export const PassportFactsSchema = z.strictObject({
  applicationType: z.enum(PASSPORT_APPLICATION_TYPES),
  officeCity: text(B11.officeCity).min(1),
  neededBy: optionalNull(isoDate),
  notes: nullableText(B11.notes),
}) satisfies z.ZodType<PassportServiceFacts, unknown>;

/** `{ type, facts }` as the database returns it (authz.purchase_task_json, deal_services). */
export const ServiceFactsSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hotel'), facts: HotelFactsSchema }),
  z.object({ type: z.literal('transfer'), facts: TransferFactsSchema }),
  z.object({ type: z.literal('activity'), facts: ActivityFactsSchema }),
  z.object({ type: z.literal('flight'), facts: FlightFactsSchema }),
  z.object({ type: z.literal('visa'), facts: VisaFactsSchema }),
  z.object({ type: z.literal('passport'), facts: PassportFactsSchema }),
]) satisfies z.ZodType<ServiceFacts, unknown>;

const SERVICE_STATES = ['planned', 'active', 'cancelled'] as const;
const DEPARTMENTS = ['purchase', 'flight', 'visa'] as const;
const NEXT_STEPS = ['confirm_version', 'take_task', 'supplier_confirmation', 'done', 'waiting_for_desk_launch', 'visa_processing'] as const satisfies readonly ServiceNextStep[];
/** Wire tokens accepted for a next step; 'desk_launch' (appendix A §1.5 wording) is read as waiting_for_desk_launch. */
const nextStep = z
  .enum([...NEXT_STEPS, 'desk_launch'])
  .transform((v): ServiceNextStep => (v === 'desk_launch' ? 'waiting_for_desk_launch' : v));

const ItemTaskSchema = z.object({
  taskId: z.uuid(),
  status: z.enum(DEPARTMENT_TASK_STATUSES),
  assigneeName: optionalNull(z.string()),
  assignedToYou: z.boolean(),
  supplierConfirmedAt: optionalNull(timestamp),
  /** B1.1 (0500). */
  completedAt: timestamp.nullable().optional(),
});

/**
 * One service item from deal_services / booking_panel.services. `title`,
 * `nextStep` and the budget are optional on the wire: the DTO derives the
 * first two (pure helpers in dto.ts) and copies the budget only when the
 * database sent it (own department or booking reader; contract §6).
 */
export const ServiceItemRecordSchema = z.object({
  itemId: z.uuid(),
  itemNo: z.number().int().min(1).max(MAX_SERVICE_ITEMS),
  serviceType: z.enum(SERVICE_TYPES),
  department: z.enum(DEPARTMENTS),
  state: z.enum(SERVICE_STATES),
  title: z.string().min(1).max(400).optional(),
  facts: ServiceFactsSchema,
  purchaseBudgetPaise: paise.nullable().optional(),
  factsHash: hash,
  task: ItemTaskSchema.nullable(),
  nextStep: nextStep.optional(),
  /** B1.1: participating traveller seqs (full scope only). */
  participants: z.array(z.number().int().min(1).max(MAX_TRAVELLERS)).max(MAX_TRAVELLERS).optional(),
});
export type ServiceItemRecord = z.output<typeof ServiceItemRecordSchema>;

export const ProgressSchema = z.object({
  total: count,
  byState: z.object({
    planned: count,
    notStarted: count,
    inProgress: count,
    supplierConfirmed: count,
    waitingForLaunch: count.optional(),
    completed: count.optional(),
  }),
  fulfilled: z.boolean(),
  staleCount: count,
  needs: z.array(nextStep),
}) satisfies z.ZodType<DealProgress, unknown>;

const IDENTITY_STATUSES = ['not_needed', 'missing', 'partial', 'complete'] as const;

const TravellerSchema = z.object({
  fullName: z.string().min(1).max(120),
  type: z.enum(TRAVELLER_TYPES),
  seq: z.number().int().min(1).max(MAX_TRAVELLERS),
  // B1.1 (full scope only; never identity values here)
  ageYears: optionalNull(z.number().int().min(0).max(17)).optional(),
  specialNeeds: optionalNull(text(500)).optional(),
  identityStatus: z.enum(IDENTITY_STATUSES).optional(),
});
export type DealTravellerRecord = z.output<typeof TravellerSchema>;

export const TripSchema = z.object({
  destination: optionalNull(text(200)),
  scope: optionalNull(z.enum(TRIP_SCOPES)),
  start: optionalNull(isoDate),
  end: optionalNull(isoDate),
}) satisfies z.ZodType<BookingTrip, unknown>;

const DealServicesVersionSchema = z.object({
  versionId: z.uuid(),
  versionNo: z.number().int().positive(),
  status: z.enum(['draft', 'confirmed']),
  rowVersion: z.number().int().nonnegative(),
  contentHash: hash,
  serviceType: z.enum(['hotel', 'package']),
});

export const DealServicesSchema = z.object({
  dealId: z.uuid(),
  version: DealServicesVersionSchema.nullable(),
  items: z.array(ServiceItemRecordSchema).max(MAX_SERVICE_ITEMS),
  /** Absent for Purchase and Flight viewers (names are personal data). */
  travellers: z.array(TravellerSchema).max(MAX_TRAVELLERS).optional(),
  /** B1.1: trip block of the version (absent on older databases). */
  trip: TripSchema.nullable().optional(),
  /** Optional on the wire: the DTO computes progress from the items it received. */
  progress: ProgressSchema.optional(),
  /** deal_services: `v_full and v.status = 'draft' and …` is null when no version exists. */
  canEdit: flag,
  canConfirm: flag,
});
export type DealServicesRecord = z.output<typeof DealServicesSchema>;

export const DealServiceSummarySchema = ProgressSchema.extend({
  dealId: z.uuid(),
  serviceTypes: z.array(z.enum(SERVICE_TYPES)).max(MAX_SERVICE_ITEMS),
}) satisfies z.ZodType<DealServiceSummaryView, unknown>;
export type DealServiceSummaryRecord = z.output<typeof DealServiceSummarySchema>;

const KNOWN_CHECKLIST_CODES = new Set<string>(INTAKE_CHECKLIST_CODES);

export const IntakeChecklistSchema = z.object({
  // Tolerant (see issueCodeList): rows with a code this build does not know are dropped.
  items: z.array(
    z.object({
      code: z.string().min(1).max(80),
      blocking: z.boolean(),
      owner: z.enum(INTAKE_CHECKLIST_OWNERS),
      itemNos: z.array(z.number().int().min(1).max(MAX_SERVICE_ITEMS)).optional().transform((v) => v ?? []),
      travellerSeqs: z.array(z.number().int().min(1).max(MAX_TRAVELLERS)).optional(),
      /** B1.2 (0600) prefill_unchecked: field codes. */
      fields: z.array(z.string().min(1).max(60)).max(20).optional(),
    }),
  )
    .max(200)
    .transform((rows) => rows.flatMap((r) => (KNOWN_CHECKLIST_CODES.has(r.code) ? [{ ...r, code: r.code as IntakeChecklistCode }] : []))),
  canConfirm: flag,
}) satisfies z.ZodType<IntakeChecklist, unknown>;

export const MyWorkCountsSchema = z.object({
  waitingForMe: count,
  returnedToMe: count,
  missingDetails: count,
  intakeNeeded: count,
  receiptsToVerify: optionalNull(count),
  requestsToApprove: optionalNull(count),
  // B1.1 (0500): absent before the migration (the DTO then reports null).
  claimsToProcess: optionalNull(count),
  expensesToReview: optionalNull(count),
  visaTasksWaiting: optionalNull(count),
  // Batch 1 (20261121000120). Missing here until Batch 3, so zod stripped it and Home always
  // showed the combined row (known live defect, fixed in Batch 3).
  draftsToContinue: optionalNull(count),
  // Batch 3 (20261123000100, FP-081): absent on an older database (the DTO then reports null).
  quotationDraftsToFinish: optionalNull(count),
  acceptedQuotesToLink: optionalNull(count),
}) satisfies z.ZodType<MyWorkCounts, unknown>;

export const FlightSummarySchema = z.object({
  taskId: z.uuid(),
  dealReference: z.string().min(1),
  itemTitle: z.string().min(1).max(400),
  facts: FlightFactsSchema,
  purchaseBudgetPaise: paise,
  status: z.enum(TASK_STATUSES),
  assigneeName: optionalNull(z.string()),
  assignedToYou: z.boolean(),
  branchName: z.string(),
  createdAt: timestamp,
  supplierConfirmedAt: optionalNull(timestamp),
});
export type FlightTaskRecord = z.output<typeof FlightSummarySchema>;

const FlightDetailSchema = FlightSummarySchema.extend({
  confirmedAt: timestamp,
  confirmedByName: z.string(),
  versionNo: z.number().int().positive(),
  canClaim: z.boolean(),
  travellerCount: count,
  ...TaskB11Extras,
  estimate: TaskEstimateSchema.nullable().optional(),
  /** Book now v2 (20261129000120): assignee only; absent otherwise and on an older database. */
  fareTotals: TaskFareTotalsSchema.nullable().optional(),
  files: z.array(TaskFileSchema).max(20).optional(),
});
export type FlightTaskDetailRecord = z.output<typeof FlightDetailSchema>;

const WorkflowSettingsSchema = z.object({
  intakePromptEnabled: z.boolean(),
  serviceItemsEnabled: z.boolean(),
  /** B1.1: absent before 0100 (most readers treat it as off; the Workflow switches page shows Unknown). */
  visaPassportTasksEnabled: z.boolean().optional(),
  /** Batch 2: absent before migration A (shown as Unknown, never Off). */
  prefillAutoFill: z.boolean().optional(),
  /** Batch 3: absent before migration B (Unknown, never Off). */
  referralDrafts: z.boolean().optional(),
  updatedAt: optionalNull(timestamp),
}) satisfies z.ZodType<WorkflowSettingsView, unknown>;

const WorkflowSettingResultSchema = z.object({
  key: z.enum(WORKFLOW_SETTING_KEYS),
  changed: z.boolean(),
  before: z.boolean(),
  after: z.boolean(),
  updatedAt: timestamp,
  tasksCreated: count.optional(),
  skipped: count.optional(),
}) satisfies z.ZodType<WorkflowSettingResult, unknown>;

const ItemAddSchema = z.object({
  itemId: z.uuid(),
  itemNo: z.number().int().min(1).max(MAX_SERVICE_ITEMS),
  rowVersion: z.number().int().nonnegative(),
  contentHash: hash,
});
const ItemSaveSchema = z.object({ rowVersion: z.number().int().nonnegative(), contentHash: hash });
const ItemRemoveSchema = ItemSaveSchema.extend({ removed: z.literal(true) });

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** The facts object only (no `type` wrapper): what p_facts carries. */
export type ServiceFactsBody = ServiceFacts['facts'];

export async function serviceItemAdd(
  client: RpcClient,
  input: {
    versionId: string;
    expectedRowVersion: number;
    serviceType: ServiceType;
    facts: ServiceFactsBody;
    /** Integer paise as a decimal string (bigint-safe). */
    purchaseBudgetPaise: string;
    /** Exact-retry replay key: the same (version, request) returns the existing item. */
    requestId: string;
  },
): Promise<ServiceItemAddResult> {
  const fn = 'service_item_add';
  const data = await invoke(client, fn, {
    p_version_id: input.versionId,
    p_expected_row_version: input.expectedRowVersion,
    p_service_type: input.serviceType,
    p_facts: input.facts,
    p_purchase_budget_paise: input.purchaseBudgetPaise,
    p_request_id: input.requestId,
  });
  return parse(fn, ItemAddSchema, data);
}

export async function serviceItemSave(
  client: RpcClient,
  input: { itemId: string; versionId: string; expectedRowVersion: number; facts: ServiceFactsBody; purchaseBudgetPaise: string },
): Promise<ServiceItemSaveResult> {
  const fn = 'service_item_save';
  const data = await invoke(client, fn, {
    p_item_id: input.itemId,
    p_version_id: input.versionId,
    p_expected_row_version: input.expectedRowVersion,
    p_facts: input.facts,
    p_purchase_budget_paise: input.purchaseBudgetPaise,
  });
  return parse(fn, ItemSaveSchema, data);
}

export async function serviceItemRemove(
  client: RpcClient,
  input: { itemId: string; versionId: string; expectedRowVersion: number },
): Promise<ServiceItemRemoveResult> {
  const fn = 'service_item_remove';
  const data = await invoke(client, fn, {
    p_item_id: input.itemId,
    p_version_id: input.versionId,
    p_expected_row_version: input.expectedRowVersion,
  });
  return parse(fn, ItemRemoveSchema, data);
}

export async function dealTravellersSave(
  client: RpcClient,
  input: { dealId: string; expectedRowVersion: number; travellers: Traveller[] },
): Promise<TravellersSaveResult> {
  const fn = 'deal_travellers_save';
  const data = await invoke(client, fn, {
    p_deal_id: input.dealId,
    p_expected_row_version: input.expectedRowVersion,
    p_travellers: input.travellers.map((t) => ({ fullName: t.fullName, type: t.type, seq: t.seq })),
  });
  return parse(fn, ItemSaveSchema, data);
}

export async function flightTaskClaim(client: RpcClient, taskId: string): Promise<ClaimTaskResult> {
  const fn = 'flight_task_claim';
  return parse(fn, ClaimSchema, await invoke(client, fn, { p_task_id: taskId }));
}

export async function adminSetWorkflowSetting(
  client: RpcClient,
  input: { key: WorkflowSettingKey; value: boolean; reason: string },
): Promise<WorkflowSettingResult> {
  const fn = 'admin_set_workflow_setting';
  const data = await invoke(client, fn, { p_key: input.key, p_value: input.value, p_reason: input.reason });
  return parse(fn, WorkflowSettingResultSchema, data);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function intakeChecklist(client: RpcClient, dealId: string): Promise<IntakeChecklist> {
  const fn = 'intake_checklist';
  return parse(fn, IntakeChecklistSchema, await invoke(client, fn, { p_deal_id: dealId }));
}

/** null = the Deal is not visible to the caller (or does not exist). */
export async function dealServices(client: RpcClient, dealId: string): Promise<DealServicesRecord | null> {
  const fn = 'deal_services';
  const data = await invoke(client, fn, { p_deal_id: dealId });
  if (data === null) return null;
  return parse(fn, DealServicesSchema, data);
}

/** At most 50 ids per call (the database refuses more with invalid_input); invisible Deals are simply absent. */
export const DEAL_SERVICE_SUMMARY_MAX_IDS = 50;

export async function dealServiceSummary(client: RpcClient, dealIds: string[]): Promise<DealServiceSummaryRecord[]> {
  const fn = 'deal_service_summary';
  if (dealIds.length === 0) return [];
  if (dealIds.length > DEAL_SERVICE_SUMMARY_MAX_IDS) throw new BookingCommandError(fn, 'invalid_input', null);
  const data = await invoke(client, fn, { p_deal_ids: dealIds });
  if (data === null) return [];
  return parse(fn, z.array(DealServiceSummarySchema), data);
}

export async function myWorkCounts(client: RpcClient): Promise<MyWorkCounts> {
  const fn = 'my_work_counts';
  return parse(fn, MyWorkCountsSchema, await invoke(client, fn, {}));
}

export async function flightTaskList(client: RpcClient): Promise<FlightTaskRecord[]> {
  const fn = 'flight_task_list';
  const data = await invoke(client, fn, {});
  if (data === null) return [];
  return parse(fn, z.array(FlightSummarySchema), data);
}

/** null = not found or not visible (indistinguishable). */
export async function flightTaskGet(client: RpcClient, taskId: string): Promise<FlightTaskDetailRecord | null> {
  const fn = 'flight_task_get';
  const data = await invoke(client, fn, { p_task_id: taskId });
  if (data === null) return null;
  return parse(fn, FlightDetailSchema, data);
}

export async function workflowSettingsGet(client: RpcClient): Promise<WorkflowSettingsView> {
  const fn = 'workflow_settings_get';
  return parse(fn, WorkflowSettingsSchema, await invoke(client, fn, {}));
}
