/**
 * Phase 2 frozen integration contracts (lead-owned).
 * See docs/implementation/phase-2/contract.md. Agents import; they do not redefine.
 */

export type InboxStatus =
  | 'pending'
  | 'processing'
  | 'processed'
  | 'ignored'
  | 'needs_review'
  | 'failed'
  | 'dead_letter';

export type InboxOrigin = 'event' | 'reconcile' | 'manual_retry';

export type IntakeReasonCode =
  | 'not_configured'
  | 'environment_unset'
  | 'not_eligible_category'
  | 'not_eligible_stage'
  | 'before_cutoff'
  | 'unmapped_owner'
  | 'owner_not_in_pilot_branch'
  | 'invalid_source_data'
  | 'source_deal_not_found'
  | 'stale_ignored'
  | 'reference_conflict'
  /** Phase 6: the source record is not in the active owner-approved manifest. */
  | 'not_in_manifest'
  /** Phase 6: the source record is in the manifest but its source code or creation time is outside the manifest scope. */
  | 'outside_manifest_scope'
  /** Lead screens batch: an existing CRM record belongs to a different entity/branch than the current intake configuration; held, original preserved. */
  | 'scope_changed'
  /** Sync completion §2: scope-mode Lead whose Bitrix responsible is not an eligible pilot Sales member (ignored, nothing written). */
  | 'owner_not_eligible';

/** Phase 6: Bitrix object type. Leads and Deals never mix. */
export type SourceObject = 'deal' | 'lead';

export type IntakeErrorCode =
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'provider_rate_limited'
  | 'provider_auth_failed'
  | 'provider_bad_response'
  | 'internal_error';

/** Bounded, validated deal read from crm.deal.get, passed to integration_apply_bitrix_deal. */
export interface BitrixDealSnapshot {
  id: string;
  title: string;
  stageId: string;
  categoryId: string;
  assignedById: string;
  /** ISO 8601 with offset, as returned by Bitrix. */
  dateCreate: string;
  dateModify: string;
  /** Phase 6: Bitrix SOURCE_ID (e.g. WEBFORM); must equal the active manifest's source code. */
  sourceId?: string | null;
}

export interface RecordEventResult {
  inboxId: string;
  duplicate: boolean;
}

export interface ClaimedInboxItem {
  inboxId: string;
  lockToken: string;
  portalMemberId: string;
  sourceDealId: string;
  eventType: string;
  origin: InboxOrigin;
  attempts: number;
}

export interface ApplyResult {
  outcome: 'created' | 'updated' | 'ignored' | 'needs_review' | 'stale_ignored';
  dealId: string | null;
  reasonCode: IntakeReasonCode | null;
}

export interface WorkerRunSummary {
  claimed: number;
  created: number;
  updated: number;
  ignored: number;
  needsReview: number;
  failed: number;
  deadLettered: number;
}

/** Row shown on the admin integration page (no customer content beyond deal title). */
export interface InboxItemView {
  inboxId: string;
  /** Phase 6: optional until the inbox read returns it; absent means 'deal'. */
  sourceObject?: SourceObject;
  status: InboxStatus;
  origin: InboxOrigin;
  eventType: string;
  sourceDealId: string;
  receivedAt: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  reasonCode: IntakeReasonCode | null;
  lastErrorCode: IntakeErrorCode | null;
  lastErrorAt: string | null;
  processedDealId: string | null;
}

export interface IntegrationStatusView {
  /** False means intake is disabled: no config row, not enabled, or environment unset. */
  configured: boolean;
  environment: 'unset' | 'test' | 'staging' | 'operational';
  portalDomain: string | null;
  pilotBranchName: string | null;
  cutoffAt: string | null;
  credentialPresent: boolean;
  /** INTAKE_WORKER_SECRET configured (presence only, never the value). */
  workerSecretPresent: boolean;
  /** Number of enabled intake config rows; more than one means intake is refused (ambiguous). */
  enabledConfigCount: number;
  counts: Record<InboxStatus, number>;
  lastProcessedAt: string | null;
  /** Durable worker heartbeat (integration_worker_runs). Null = worker has never run. */
  lastWorkerRunAt: string | null;
  lastWorkerOutcome: 'ok' | 'partial' | 'provider_error' | 'internal_error' | null;
  /** received_at of the oldest pending/failed row, for backlog age. */
  oldestPendingAt: string | null;
  /** Last pull from Bitrix (reconcile heartbeat), automatic or manual. Optional for older fixtures. */
  lastSyncAt?: string | null;
  lastSyncOutcome?: 'ok' | 'partial' | 'provider_error' | 'internal_error' | null;
  /** Inbox rows that created or updated a deal since midnight IST today. */
  dealsSyncedToday?: number;
  /** Supabase pg_cron schedule switch (null = not readable / not installed). */
  syncEnabled?: boolean | null;
  /** Current eligibility settings. */
  categoryIds?: string[];
  /** The ticked stages (the settings form). New-Deal entry uses dealEntryStageIds instead while it is set. */
  stageIds?: string[];
  /** B1.1d: stages at which new Deals enter while Won-only intake is on; null = off. Optional for older fixtures. */
  dealEntryStageIds?: string[] | null;
  /** B1.1d: the contract's `deal_intake_won_only` (dealEntryStageIds is set). */
  dealIntakeWonOnly?: boolean;
  /** Stored deals without a CRM owner, grouped by Bitrix responsible (largest first). */
  waitingForOwner?: number;
  waitingByBitrixUser?: Array<{ bitrixUserId: string; deals: number }>;
  /** Deals in the CRM now: the shared count (same query as the Deals page). */
  crmDeals?: number;
  /** Full resync: the open job (progress) and the last completed check. */
  fullCheck?: FullCheckView | null;
  /** Scheduler health (pg_cron -> CRM), null when not readable. */
  autoSync?: AutoSyncView | null;
  /** Bitrix deals for the current settings right now (null = Bitrix not readable). */
  bitrixNow?: number | null;
  /** Available deals outside the listing stages (ticked stages, or the entry stages with Won-only on): kept, so not in bitrixNow. */
  keptOutsideStages?: number;
  /** Last worker batch: fetched (claimed), new, updated. */
  lastRun?: { fetched: number; created: number; updated: number; at: string } | null;
  attention: InboxItemView[];
}

/** Scheduled sync health (public.integration_auto_sync_status + heartbeats). */
export interface AutoSyncView {
  /** pg_cron available and the bitrix-sync job present and active. */
  cronInstalled: boolean;
  jobActive: boolean;
  /** integration_sync_schedule.enabled (the admin switch). */
  enabled: boolean | null;
  /** Last scheduler calls, newest first: ok null = no answer yet. */
  lastCalls: Array<{ at: string; statusCode: number | null; ok: boolean | null; reason: string | null }>;
  failingSince: string | null;
  /** Last successful sync run (reconcile heartbeat ok/partial), any trigger. */
  lastSuccessAt: string | null;
  /** Heartbeats of the last 24 hours by outcome (null = older database without the counts). */
  runs24h?: RunCounts24h | null;
}

export interface RunOutcomeCounts {
  ok: number;
  partial: number;
  providerError: number;
  internalError: number;
}

/** integration_auto_sync_status().runs24h (migration 20261113000100): counts only. */
export interface RunCounts24h {
  worker: RunOutcomeCounts;
  reconcile: RunOutcomeCounts;
  /** Items the runs could not save (retried automatically) and items stopped for good. */
  itemsFailed: number;
  itemsDeadLettered: number;
  /** Finish time of the newest provider_error or internal_error run. */
  lastFailedAt: string | null;
}

/** integration_resync_jobs as shown on the Bitrix sync page (counts only). */
export interface FullCheckView {
  /** An open job: listing Bitrix (scanned of bitrixTotal) or waiting for the inbox to drain. */
  running: { reason: 'settings_changed' | 'manual' | 'daily'; scanned: number; bitrixTotal: number | null; listingDone: boolean; queuedAt: string } | null;
  last: {
    finishedAt: string;
    bitrix: number;
    crm: number;
    missing: number;
    extra: number;
    keptAfterStageMove: number;
    inSync: boolean;
    /** The check used the CURRENT pipelines, stages and sync date. */
    matchesSettings?: boolean;
  } | null;
}

/** Source provenance fields added to deal DTOs (agent B extends DealListItem/DealDetail). */
export interface DealSourceView {
  system: 'bitrix';
  sourceDealId: string;
  stageId: string;
  lastSyncedAt: string;
  /** Last time the worker or reconcile confirmed the source state (may be newer than lastSyncedAt). */
  lastVerifiedAt: string;
  /** True when last_verified_at is older than the PROPOSED 24 h threshold. */
  stale: boolean;
  /** Phase 5: plain stage name when the intake configuration maps it; null shows the raw id as a Bitrix stage. */
  stageLabel?: string | null;
}

/**
 * Module map:
 *   '@/modules/integration/server/actions'  (A): retryInboxItemAction(prev, formData{inboxId}),
 *                                                runReconcileNowAction(prev, formData) -> FormState
 *   '@/modules/integration/server/queries'  (A): loadIntegrationStatus(staff): Promise<IntegrationStatusView>
 *   '@/modules/deals/dto'                    (B): DealListItem/DealDetail gain optional `source?: DealSourceView`
 *   '@/modules/access/policy'                (B): Permission gains 'integration.manage'
 */
export const STALE_SYNC_HOURS_PROPOSED = 24;
/** Worker heartbeat older than this, or pending backlog older than this, is not "receiving" (PROPOSED). */
export const WORKER_HEALTH_MINUTES_PROPOSED = 15;
