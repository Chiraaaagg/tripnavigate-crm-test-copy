import { z } from 'zod';
import type { BitrixDealApplySnapshot } from './bitrix/deal';
import type { BitrixLeadSnapshot } from './bitrix/lead';
import type { DealTripFacts, LeadSourceFacts, PartySnapshot } from './bitrix/trip-facts';
import type {
  ApplyResult,
  ClaimedInboxItem,
  InboxStatus,
  IntakeErrorCode,
  IntakeReasonCode,
  RecordEventResult,
  SourceObject,
} from './contracts';

/**
 * Typed wrappers for agent B's intake commands (contract §5). The caller passes
 * the client: the service-role admin client for record/claim/apply/fail/enqueue
 * (server only), the staff member's own session client for retry. Responses are
 * validated; anything unexpected throws IntakeCommandError (fail closed).
 */

export interface RpcError {
  code?: string;
  message?: string;
}

export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

/** Narrow a Supabase client (untyped schema) to the RPC surface used here. */
export function asRpcClient(client: { rpc: (...args: never[]) => unknown }): RpcClient {
  return client as unknown as RpcClient;
}

/**
 * Fail-closed refusals raised by the intake commands. Phase 6 (contract L1,
 * authz.intake_portal_allowed) raises fixed messages; the Phase 2-5 message for
 * the unset environment is still recognised, by exact equality only:
 *   55000 'environment_unset'                            -> environment_unset
 *   55000 'intake is not configured (environment unset)' -> environment_unset (legacy)
 *   55000 anything else ('not_configured', staging, ...) -> not_configured
 *   42501 'portal not recognised'                        -> wrong_portal
 * No substring match: a staging or other refusal can never be labelled unset.
 */
export type RefusalToken = 'not_configured' | 'environment_unset' | 'wrong_portal';

const ENVIRONMENT_UNSET_MESSAGES: ReadonlySet<string> = new Set([
  'environment_unset',
  'intake is not configured (environment unset)',
]);

export class IntakeCommandError extends Error {
  override name = 'IntakeCommandError';
  constructor(
    readonly command: string,
    readonly sqlState: string | null,
    readonly refusal: RefusalToken | null,
  ) {
    // Never include the database message verbatim: it could echo arguments.
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${refusal ? `: ${refusal}` : ''}`);
  }
}

function refusalOf(error: RpcError): RefusalToken | null {
  const msg = error.message ?? '';
  if (error.code === '55000') return ENVIRONMENT_UNSET_MESSAGES.has(msg) ? 'environment_unset' : 'not_configured';
  if (error.code === '42501' && /portal not recognised/i.test(msg)) return 'wrong_portal';
  return null;
}

async function invoke(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new IntakeCommandError(fn, error.code ?? null, refusalOf(error));
  return data;
}

function parse<T>(fn: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new IntakeCommandError(fn, null, null);
  return parsed.data;
}

const REASON_CODES = [
  'not_configured',
  'environment_unset',
  'not_eligible_category',
  'not_eligible_stage',
  'before_cutoff',
  'unmapped_owner',
  'owner_not_in_pilot_branch',
  'invalid_source_data',
  'source_deal_not_found',
  'stale_ignored',
  'reference_conflict',
  'not_in_manifest',
  'outside_manifest_scope',
  'scope_changed',
  'owner_not_eligible',
] as const satisfies readonly IntakeReasonCode[];

/** Every reason code the database may store (integration_inbox_reason_code_check); tests compare it with the migrations. */
export const INTAKE_REASON_CODES: readonly IntakeReasonCode[] = REASON_CODES;

/**
 * An apply command has already committed when it answers, so an unknown reason
 * code (a newer database) must not turn a finished item into a failure: the
 * outcome is still validated strictly, the reason falls back to null.
 */
const appliedReason = z
  .enum(REASON_CODES)
  .nullable()
  .optional()
  .catch(null)
  .transform((v) => v ?? null);

const idText = z.union([z.string(), z.number()]).transform(String);

const INBOX_STATUSES = [
  'pending',
  'processing',
  'processed',
  'ignored',
  'needs_review',
  'failed',
  'dead_letter',
] as const satisfies readonly InboxStatus[];

/**
 * Sync completion (§1): the record command may also return the inbox row's
 * `status` so the receiver can schedule a live batch only for a pending row
 * without another query. Absent (older database) = unknown.
 */
const RecordSchema = z.object({ inboxId: z.uuid(), duplicate: z.boolean(), status: z.enum(INBOX_STATUSES).optional() });

/** Record result plus the optional inbox status (sync completion §1). */
export type RecordedEvent = RecordEventResult & { status?: InboxStatus };

const sourceIdText = idText.pipe(z.string().regex(/^[1-9][0-9]{0,15}$/));

const LEAD_EVENT_TYPES: ReadonlySet<string> = new Set(['ONCRMLEADADD', 'ONCRMLEADUPDATE']);
const DEAL_EVENT_TYPES: ReadonlySet<string> = new Set(['ONCRMDEALADD', 'ONCRMDEALUPDATE']);

/**
 * Phase 6 claim row. `sourceObject` decides which Bitrix method and apply
 * command handle the row. When the database sends it, it must agree with the
 * event type (a Lead event is never a Deal row and vice versa); a row without
 * it (Phase 2-5 shape) is a Deal only for a Deal event or RECONCILE. Anything
 * inconsistent is `sourceObject: null` and the worker refuses it.
 */
const ClaimSchema = z
  .object({
    inboxId: z.uuid(),
    lockToken: z.uuid(),
    portalMemberId: z.string().min(1),
    sourceObject: z.enum(['deal', 'lead']).optional(),
    sourceDealId: sourceIdText.optional(),
    sourceId: sourceIdText.optional(),
    eventType: z.string(),
    origin: z.enum(['event', 'reconcile', 'manual_retry']),
    attempts: z.number().int().nonnegative(),
  })
  .transform((row, ctx) => {
    const id = row.sourceId ?? row.sourceDealId;
    if (!id || (row.sourceId && row.sourceDealId && row.sourceId !== row.sourceDealId)) {
      ctx.addIssue({ code: 'custom', message: 'source id' });
      return z.NEVER;
    }
    const isLeadEvent = LEAD_EVENT_TYPES.has(row.eventType);
    const isDealEvent = DEAL_EVENT_TYPES.has(row.eventType);
    let sourceObject: SourceObject | null;
    if (row.sourceObject === 'lead') sourceObject = isDealEvent ? null : 'lead';
    else if (row.sourceObject === 'deal') sourceObject = isLeadEvent ? null : 'deal';
    else sourceObject = isDealEvent || row.eventType === 'RECONCILE' ? 'deal' : null;
    return {
      inboxId: row.inboxId,
      lockToken: row.lockToken,
      portalMemberId: row.portalMemberId,
      sourceDealId: id,
      eventType: row.eventType,
      origin: row.origin,
      attempts: row.attempts,
      sourceObject,
    };
  });

/** A claimed row with its source object (null = inconsistent row; never sent to Bitrix). */
export type ClaimedSourceItem = ClaimedInboxItem & { sourceObject: SourceObject | null };

const ApplySchema = z.object({
  outcome: z.enum(['created', 'updated', 'ignored', 'needs_review', 'stale_ignored']),
  dealId: z.uuid().nullable().optional().transform((v) => v ?? null),
  reasonCode: appliedReason,
});

const LeadApplySchema = z.object({
  outcome: z.enum(['created', 'updated', 'ignored', 'needs_review', 'stale_ignored']),
  leadId: z.uuid().nullable().optional().transform((v) => v ?? null),
  reasonCode: appliedReason,
});

export interface LeadApplyResult {
  outcome: ApplyResult['outcome'];
  leadId: string | null;
  reasonCode: IntakeReasonCode | null;
}

const FailSchema = z.object({ status: z.enum(['failed', 'dead_letter']) }).passthrough();

/**
 * Phase 6 (migration 20261007000100): the signature is unchanged. The database
 * derives the source object from the event type (ONCRMDEAL* = deal,
 * ONCRMLEAD* = lead) and `p_deal_id` carries the Deal or Lead ID. The caller
 * states the object it parsed; a mismatch with the event type is refused here
 * before any call.
 */
export function recordBitrixEvent(
  client: RpcClient,
  input: { memberId: string; eventType: string; sourceObject: SourceObject; sourceId: number; sourceTs: number },
): Promise<RecordedEvent> {
  const fn = 'integration_record_bitrix_event';
  const expected = LEAD_EVENT_TYPES.has(input.eventType) ? 'lead' : DEAL_EVENT_TYPES.has(input.eventType) ? 'deal' : null;
  if (expected === null || expected !== input.sourceObject) {
    return Promise.reject(new IntakeCommandError(fn, '22023', null));
  }
  return invoke(client, fn, {
    p_member_id: input.memberId,
    p_event_type: input.eventType,
    p_deal_id: input.sourceId,
    p_source_ts: input.sourceTs,
  }).then((data) => parse(fn, RecordSchema, data));
}

export async function claimInbox(client: RpcClient, limit: number, leaseSeconds: number): Promise<ClaimedSourceItem[]> {
  const fn = 'integration_claim_inbox';
  const data = await invoke(client, fn, { p_limit: limit, p_lease_seconds: leaseSeconds });
  if (data === null) return [];
  return parse(fn, z.array(ClaimSchema), data);
}

/** `deal` null = crm.deal.get answered "not found" (B records needs_review / source_deal_not_found). */
export function applyBitrixDeal(
  client: RpcClient,
  item: Pick<ClaimedInboxItem, 'inboxId' | 'lockToken'>,
  deal: BitrixDealApplySnapshot | null,
): Promise<ApplyResult> {
  const fn = 'integration_apply_bitrix_deal';
  return invoke(client, fn, { p_inbox_id: item.inboxId, p_lock_token: item.lockToken, p_deal: deal }).then(
    (data) => parse(fn, ApplySchema, data),
  );
}

/** Phase 6: `lead` null = crm.lead.get answered "not found". Never called for a Deal row. */
export function applyBitrixLead(
  client: RpcClient,
  item: Pick<ClaimedInboxItem, 'inboxId' | 'lockToken'>,
  lead: BitrixLeadSnapshot | null,
): Promise<LeadApplyResult> {
  const fn = 'integration_apply_bitrix_lead';
  return invoke(client, fn, { p_inbox_id: item.inboxId, p_lock_token: item.lockToken, p_lead: lead }).then((data) =>
    parse(fn, LeadApplySchema, data),
  );
}

const TripFactsSchema = z.object({
  outcome: z.enum(['switched_off', 'not_applicable', 'stale', 'unchanged', 'stored']),
  parties: z
    .array(z.object({ kind: z.enum(['contact', 'company']), id: z.string().regex(/^[1-9][0-9]{0,17}$/) }))
    .max(2),
});
export type TripFactsResult = z.infer<typeof TripFactsSchema>;

const PartySchema = z.object({ outcome: z.enum(['switched_off', 'not_applicable', 'stale', 'unchanged', 'stored']) });
export type PartyResult = z.infer<typeof PartySchema>;

/**
 * B1.2 (DEC-36, migration 20261120000400): stores the read-only Bitrix values of
 * the Deal or Lead the inbox row has just processed (service role). Answers
 * 'switched_off' and writes nothing while bitrix_trip_facts_read is off;
 * `parties` lists the linked Contact / Company to read next.
 */
export function applyBitrixTripFacts(
  client: RpcClient,
  inboxId: string,
  // Voice-note batch: a Deal payload may carry only some groups (each switch alone).
  facts: Partial<DealTripFacts> | LeadSourceFacts | Record<string, unknown>,
): Promise<TripFactsResult> {
  const fn = 'integration_apply_bitrix_trip_facts';
  return invoke(client, fn, { p_inbox_id: inboxId, p_facts: facts }).then((data) => parse(fn, TripFactsSchema, data));
}

/** B1.2: stores one linked Contact / Company snapshot (name, phones, e-mails) for the inbox row's subject. */
export function applyBitrixParty(client: RpcClient, inboxId: string, party: PartySnapshot): Promise<PartyResult> {
  const fn = 'integration_apply_bitrix_party';
  return invoke(client, fn, { p_inbox_id: inboxId, p_party: party }).then((data) => parse(fn, PartySchema, data));
}

const SwitchesSchema = z.object({
  changed: z.boolean(),
  before: z.object({ tripFactsRead: z.boolean(), leadIntakeUnowned: z.boolean() }),
  after: z.object({ tripFactsRead: z.boolean(), leadIntakeUnowned: z.boolean() }),
  requeued: z.number().int().nonnegative(),
});
export type BitrixReadSwitchesResult = z.infer<typeof SwitchesSchema>;

/**
 * B1.2: the audited Super Admin command for the two read switches (the staff
 * member's own session client; null keeps a switch). Live use needs the owner's
 * APPROVE; no screen calls this yet.
 */
export function setBitrixReadSwitches(
  client: RpcClient,
  input: { tripFactsRead: boolean | null; leadIntakeUnowned: boolean | null; reason: string },
): Promise<BitrixReadSwitchesResult> {
  const fn = 'integration_set_bitrix_read_switches';
  return invoke(client, fn, {
    p_trip_facts_read: input.tripFactsRead,
    p_lead_intake_unowned: input.leadIntakeUnowned,
    p_reason: input.reason,
  }).then((data) => parse(fn, SwitchesSchema, data));
}

/** Retryable failures back off (B: 60 s * 2^(attempts-1), cap 1 h); others and the last attempt dead-letter. */
export function failInbox(
  client: RpcClient,
  item: Pick<ClaimedInboxItem, 'inboxId' | 'lockToken'>,
  errorCode: IntakeErrorCode,
  retryable: boolean,
): Promise<{ status: 'failed' | 'dead_letter' }> {
  const fn = 'integration_fail_inbox';
  return invoke(client, fn, {
    p_inbox_id: item.inboxId,
    p_lock_token: item.lockToken,
    p_error_code: errorCode,
    p_retryable: retryable,
  }).then((data) => parse(fn, FailSchema, data));
}

const RowStatusSchema = z.object({ status: z.enum(INBOX_STATUSES) }).passthrough();

/**
 * Sync reliability (20261113000100): the current status of one inbox row
 * (service role). Used only after a fail call was refused, to count an item the
 * database already finished by what really happened. Null = unknown (missing
 * row, older database without the command, or any error).
 */
export async function inboxRowStatus(client: RpcClient, inboxId: string): Promise<InboxStatus | null> {
  const fn = 'integration_inbox_row_status';
  try {
    const data = await invoke(client, fn, { p_inbox_id: inboxId });
    if (data === null) return null;
    return parse(fn, RowStatusSchema, data).status;
  } catch {
    return null;
  }
}

export function retryInbox(client: RpcClient, inboxId: string): Promise<unknown> {
  return invoke(client, 'integration_retry_inbox', { p_inbox_id: inboxId });
}

const EnqueueSchema = z.object({
  inboxId: z.uuid().nullable(),
  duplicate: z.boolean(),
  upToDate: z.boolean(),
  /** Phase 6: the manifest gate refused the record (no row written). */
  ignored: z.boolean().optional().transform((v) => v ?? false),
  // The enqueue has committed too: an unknown reason must not fail the reconcile pass.
  reasonCode: appliedReason,
});

export type EnqueueOutcome = 'enqueued' | 'already_queued' | 'up_to_date' | 'not_in_manifest';

export async function enqueueReconcile(
  client: RpcClient,
  input: { memberId: string; sourceObject?: SourceObject; sourceId: number; sourceModified: number },
): Promise<EnqueueOutcome> {
  // Separate commands per object (migration 20261007000100): a Lead ID never reaches the Deal command.
  const lead = input.sourceObject === 'lead';
  const fn = lead ? 'integration_enqueue_reconcile_lead' : 'integration_enqueue_reconcile';
  const data = await invoke(client, fn, {
    p_member_id: input.memberId,
    ...(lead ? { p_lead_id: input.sourceId } : { p_deal_id: input.sourceId }),
    p_source_modified: input.sourceModified,
  });
  const r = parse(fn, EnqueueSchema, data);
  if (r.ignored || r.reasonCode === 'not_in_manifest' || r.reasonCode === 'outside_manifest_scope') return 'not_in_manifest';
  if (r.upToDate) return 'up_to_date';
  return r.duplicate ? 'already_queued' : 'enqueued';
}

/** L1: return a leased row to pending without consuming an attempt (deadline / rate-limit deferral). */
export async function releaseInbox(client: RpcClient, item: Pick<ClaimedInboxItem, 'inboxId' | 'lockToken'>): Promise<void> {
  await invoke(client, 'integration_release_inbox', { p_inbox_id: item.inboxId, p_lock_token: item.lockToken });
}

export type RunOutcome = 'ok' | 'partial' | 'provider_error' | 'internal_error';

/**
 * Sync completion §7: what started a run, recorded on the heartbeat
 * (integration_worker_runs.run_trigger): 'event' = live batch after a push
 * event; 'cron' = the scheduler (pg_cron ?task=sync, Vercel Cron); 'manual' =
 * an operator or the admin "Sync now".
 */
export type RunTrigger = 'manual' | 'cron' | 'event';

/**
 * M2 heartbeat row (integration_worker_runs). Exactly the keys B's
 * integration_record_worker_run accepts (unknown keys are refused): counts
 * only, no deal content, no provider text, no portal identity.
 */
export interface WorkerRunRecord {
  kind: 'worker' | 'reconcile';
  startedAt: string;
  finishedAt: string;
  outcome: RunOutcome;
  /** Sync completion §7: what started the run. */
  trigger?: RunTrigger;
  claimed?: number;
  created?: number;
  updated?: number;
  ignored?: number;
  needsReview?: number;
  failed?: number;
  deadLettered?: number;
  enqueued?: number;
}

export async function recordWorkerRun(client: RpcClient, run: WorkerRunRecord): Promise<void> {
  await invoke(client, 'integration_record_worker_run', { p_run: run });
}

/** M1: store the reconcile watermark (advanced only when p_ok). */
export async function recordReconcileRun(client: RpcClient, memberId: string, startedAt: string, ok: boolean): Promise<void> {
  await invoke(client, 'integration_record_reconcile_run', {
    p_member_id: memberId,
    p_started_at: startedAt,
    p_ok: ok,
  });
}

const RequestReconcileSchema = z.object({
  portalMemberId: z.string().nullable(),
  allowed: z.boolean(),
  retryAfterSeconds: z.number().int().nonnegative().nullable().transform((v) => v ?? 0),
});

const ActiveManifestSchema = z.object({
  manifestId: z.uuid(),
  sourceObject: z.enum(['deal', 'lead']),
  sourceCode: z.string().min(1),
  expectedCount: z.number().int().positive(),
  ids: z.array(sourceIdText),
});

export interface ActiveManifest {
  manifestId: string;
  sourceObject: SourceObject;
  sourceCode: string;
  ids: string[];
}

/**
 * Phase 6: the ACTIVE manifest for the enabled config of this portal and object
 * (integration_active_manifest, service role), or null when none is active.
 * Fails closed when the answer is malformed, names another object, or its ID
 * list does not match expectedCount.
 */
export async function loadActiveManifest(client: RpcClient, memberId: string, sourceObject: SourceObject): Promise<ActiveManifest | null> {
  const fn = 'integration_active_manifest';
  const data = await invoke(client, fn, { p_member_id: memberId, p_source_object: sourceObject });
  if (data === null) return null;
  const m = parse(fn, ActiveManifestSchema.passthrough(), data);
  if (m.sourceObject !== sourceObject || m.ids.length !== m.expectedCount || new Set(m.ids).size !== m.ids.length) {
    throw new IntakeCommandError(fn, null, null);
  }
  return { manifestId: m.manifestId, sourceObject: m.sourceObject, sourceCode: m.sourceCode, ids: m.ids };
}

/** L5: admin (own session) authorization + audit + cooldown before listing Bitrix. */
export async function requestReconcile(
  client: RpcClient,
): Promise<{ portalMemberId: string | null; allowed: boolean; retryAfterSeconds: number }> {
  const fn = 'integration_request_reconcile';
  return parse(fn, RequestReconcileSchema, await invoke(client, fn, {}));
}

// ---------------------------------------------------------------------------
// Full resync (20261008000200): ID-cursor listing across scheduled runs.
// ---------------------------------------------------------------------------

const ResyncJobSchema = z.object({
  jobId: z.uuid(),
  lockToken: z.uuid(),
  cutoffAt: z.string().min(1),
  categoryIds: z.array(idText),
  stageIds: z.array(z.string()),
  cursorId: z.union([z.string(), z.number()]).transform(Number),
  listingDone: z.boolean(),
  bitrixTotal: z.number().int().nullable(),
  scanned: z.number().int(),
});
export type ResyncJob = z.infer<typeof ResyncJobSchema>;

const ResyncResultSchema = z.object({
  bitrix: z.number().int(),
  bitrixTotal: z.number().int().nullable().optional().transform((v) => v ?? null),
  crm: z.number().int(),
  missing: z.number().int(),
  extra: z.number().int(),
  keptAfterStageMove: z.number().int(),
  reRead: z.number().int(),
  inSync: z.boolean(),
});
export type ResyncResult = z.infer<typeof ResyncResultSchema>;

const FinishSchema = z.union([
  z.object({ done: z.literal(false), waiting: z.number().int() }),
  z.object({ done: z.literal(true), result: ResyncResultSchema }),
]);

/** The open resync job, leased (the daily job is queued by the database), or null. */
export async function nextResyncJob(client: RpcClient, memberId: string, leaseSeconds: number): Promise<ResyncJob | null> {
  const fn = 'integration_resync_next';
  const data = await invoke(client, fn, { p_member_id: memberId, p_lease_seconds: leaseSeconds });
  return data === null ? null : parse(fn, ResyncJobSchema, data);
}

export async function recordResyncPage(
  client: RpcClient,
  job: Pick<ResyncJob, 'jobId' | 'lockToken'>,
  deals: Array<{ id: number; modified: number; leadId?: string }>,
  total: number | null,
  last: boolean,
): Promise<{ enqueued: number; scanned: number; cursorId: number; leadLinkRequeued: number }> {
  const fn = 'integration_resync_page';
  const data = await invoke(client, fn, {
    p_job: job.jobId,
    p_token: job.lockToken,
    p_deals: deals,
    p_total: total,
    p_last: last,
  });
  return parse(
    fn,
    z.object({
      enqueued: z.number().int(),
      scanned: z.number().int(),
      cursorId: z.union([z.string(), z.number()]).transform(Number),
      // Migration 20261113000100; absent on an older database.
      leadLinkRequeued: z.number().int().nonnegative().optional().transform((v) => v ?? 0),
    }),
    data,
  );
}

export async function finishResync(
  client: RpcClient,
  job: Pick<ResyncJob, 'jobId' | 'lockToken'>,
): Promise<z.infer<typeof FinishSchema>> {
  const fn = 'integration_resync_finish';
  return parse(fn, FinishSchema, await invoke(client, fn, { p_job: job.jobId, p_token: job.lockToken }));
}

export async function releaseResync(client: RpcClient, job: Pick<ResyncJob, 'jobId' | 'lockToken'>): Promise<void> {
  await invoke(client, 'integration_resync_release', { p_job: job.jobId, p_token: job.lockToken });
}

/** Admin "Sync now": queue a full resync unless one is open (service role). */
export async function queueResync(client: RpcClient, memberId: string): Promise<string> {
  const fn = 'integration_queue_resync';
  return parse(fn, z.object({ jobId: z.uuid() }), await invoke(client, fn, { p_member_id: memberId })).jobId;
}

// ---------------------------------------------------------------------------
// Sync-stopped alert (sync completion §4, §7). Service role only.
// ---------------------------------------------------------------------------

const AlertSendSchema = z.object({
  incidentId: z.uuid(),
  kind: z.enum(['stopped', 'recovered']),
  openedAt: z.string().min(1),
  recoveredAt: z.string().min(1).nullable().optional().transform((v) => v ?? null),
  reasonCode: z.string().max(200).nullable().optional().transform((v) => v ?? null),
  recipients: z.array(z.string().min(3).max(320)).max(200),
});
export type SyncAlertItem = z.infer<typeof AlertSendSchema>;

const AlertCheckSchema = z.object({
  send: z.array(AlertSendSchema).max(50),
  emailRecipientsCount: z.number().int().nonnegative(),
});
export type SyncAlertCheck = z.infer<typeof AlertCheckSchema>;

/** Opens or closes incidents from the same facts as the admin page and returns the emails still to send. */
export async function syncAlertCheck(client: RpcClient): Promise<SyncAlertCheck> {
  const fn = 'integration_sync_alert_check';
  return parse(fn, AlertCheckSchema, await invoke(client, fn, {}));
}

/** Idempotent: records that the "stopped" or "recovered" email for an incident went out. */
export async function markSyncAlertSent(client: RpcClient, incidentId: string, kind: SyncAlertItem['kind']): Promise<void> {
  await invoke(client, 'integration_sync_alert_mark_sent', { p_incident: incidentId, p_kind: kind });
}

// ---------------------------------------------------------------------------
// B1.2 DEC-43: ID-proof copy to Bitrix (migration 20261120000700)
// ---------------------------------------------------------------------------

const CopyJobSchema = z.object({
  jobId: z.uuid(),
  leaseToken: z.uuid(),
  mode: z.enum(['send', 'verify']),
  bitrixDealId: z.string().regex(/^[1-9]\d{0,17}$/),
  objectPath: z.string().min(1).max(300),
  mime: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']),
  sizeBytes: z.number().int().min(1).max(4_194_304),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  travellerSeq: z.number().int().min(1).max(100),
  priorFileIds: z.array(z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d{0,17}$/).transform(Number)])),
  attempts: z.number().int().nonnegative(),
});
export type IdProofCopyJobRow = z.infer<typeof CopyJobSchema>;

/**
 * Service role: due copy jobs with a lease (none while the switch is off; at
 * most one per Deal). The worker claims one job at a time, so the lease covers
 * one download, two reads and one write (review E7-6).
 */
export async function claimIdProofCopyJobs(client: RpcClient, limit: number, leaseSeconds = 180): Promise<IdProofCopyJobRow[]> {
  const fn = 'bitrix_id_proof_copy_claim';
  const data = await invoke(client, fn, { p_limit: limit, p_lease_seconds: leaseSeconds });
  return parse(fn, z.array(CopyJobSchema), data ?? []);
}

/** Service role: records the field's file ids and moves the job to unknown before the Bitrix call. */
export async function markIdProofCopySending(client: RpcClient, job: { jobId: string; leaseToken: string }, priorFileIds: number[]): Promise<void> {
  const fn = 'bitrix_id_proof_copy_mark_sending';
  await invoke(client, fn, { p_job_id: job.jobId, p_lease_token: job.leaseToken, p_prior_file_ids: priorFileIds });
}

const CopyCompleteSchema = z.object({
  jobId: z.uuid(),
  status: z.enum(['pending', 'unknown', 'sent', 'failed', 'cancelled', 'needs_manual_check']),
  attempts: z.number().int(),
  errorCode: z.string().nullable(),
});

/** Service role: sent / retry / failed / unknown (codes only). */
export async function completeIdProofCopy(
  client: RpcClient,
  job: { jobId: string; leaseToken: string },
  outcome: 'sent' | 'retry' | 'failed' | 'unknown',
  errorCode: string | null,
  bitrixFileId: number | null,
): Promise<z.infer<typeof CopyCompleteSchema>> {
  const fn = 'bitrix_id_proof_copy_complete';
  const data = await invoke(client, fn, {
    p_job_id: job.jobId,
    p_lease_token: job.leaseToken,
    p_outcome: outcome,
    p_error_code: errorCode,
    p_bitrix_file_id: bitrixFileId,
  });
  return parse(fn, CopyCompleteSchema, data);
}

const CopyStatusSchema = z.array(
  z.object({
    jobId: z.uuid(),
    travellerId: z.uuid(),
    idProofId: z.uuid(),
    status: z.enum(['pending', 'unknown', 'sent', 'failed', 'cancelled', 'needs_manual_check']),
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    lastErrorCode: z.string().nullable(),
    updatedAt: z.string(),
    sentAt: z.string().nullable(),
  }),
);
export type IdProofCopyStatus = z.infer<typeof CopyStatusSchema>[number];

/** Staff session (booking editors): copy status per job; null when not visible. */
export async function idProofCopyStatus(client: RpcClient, dealId: string): Promise<IdProofCopyStatus[] | null> {
  const fn = 'bitrix_id_proof_copy_status';
  const data = await invoke(client, fn, { p_deal_id: dealId });
  return data === null ? null : parse(fn, CopyStatusSchema, data);
}

/** Staff session (booking editors, Super Admin): a failed or unknown copy is tried again. */
export async function retryIdProofCopy(client: RpcClient, jobId: string): Promise<{ jobId: string; status: string }> {
  const fn = 'bitrix_id_proof_copy_retry';
  const data = await invoke(client, fn, { p_job_id: jobId });
  return parse(fn, z.object({ jobId: z.uuid(), status: z.string() }), data);
}

/** Service role (review E7-1): the job fails, the copy switch goes off and an alert opens. */
export async function stopIdProofCopy(client: RpcClient, job: { jobId: string; leaseToken: string }, reasonCode: 'prior_files_lost'): Promise<{ stopId: string }> {
  const fn = 'bitrix_id_proof_copy_stop';
  const data = await invoke(client, fn, { p_job_id: job.jobId, p_lease_token: job.leaseToken, p_reason_code: reasonCode });
  return parse(fn, z.object({ stopId: z.uuid(), jobId: z.uuid(), switchOn: z.literal(false) }), data);
}

const CopyAlertsSchema = z.object({
  stops: z.array(
    z.object({
      stopId: z.uuid(),
      jobId: z.uuid(),
      bitrixDealId: z.string().regex(/^[1-9]\d{0,17}$/),
      reasonCode: z.enum(['prior_files_lost']),
      openedAt: z.string(),
      acknowledgedAt: z.string().nullable(),
    }),
  ),
  /** Review E8-2: jobs whose read-back could not decide five times in a row. */
  manualChecks: z.array(
    z.object({
      jobId: z.uuid(),
      bitrixDealId: z.string().regex(/^[1-9]\d{0,17}$/),
      lastErrorCode: z.string().nullable(),
      readBackAttempts: z.number().int(),
      updatedAt: z.string(),
    }),
  ),
});
export type IdProofCopyAlerts = z.infer<typeof CopyAlertsSchema>;

/** Staff session (Super Admin): automatic stops (open first) and jobs needing a manual check; null when not allowed. */
export async function idProofCopyAlerts(client: RpcClient): Promise<IdProofCopyAlerts | null> {
  const fn = 'bitrix_id_proof_copy_alerts';
  const data = await invoke(client, fn, {});
  return data === null ? null : parse(fn, CopyAlertsSchema, data);
}
