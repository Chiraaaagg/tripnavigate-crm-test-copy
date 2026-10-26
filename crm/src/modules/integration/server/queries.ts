import 'server-only';
import { z } from 'zod';
import type { StaffContext } from '@/modules/identity/server/session';
import { getIntegrationEnv, MIN_WORKER_SECRET_LENGTH } from '../bitrix/config';
import { countVisibleDeals } from '@/modules/deals/server/queries';
import type {
  AutoSyncView,
  FullCheckView,
  InboxItemView,
  InboxStatus,
  IntakeErrorCode,
  IntakeReasonCode,
  IntegrationStatusView,
  RunCounts24h,
} from '../contracts';
import type { IntakeScopeView } from '@/views/integration-views';
import type { BitrixPipeline } from '../bitrix/directory';
import { entryRuleView, type IntakeEntryRuleView } from '../won-only';
import { readManagedConfig } from './bitrix-admin';
import { countEnabled, dealListingStageIds, isIntakeEnvironmentAllowed, parseIntakeConfigRow, selectIntakeConfig } from '../intake-config';

/**
 * Status for /app/admin/integration. Every read runs under the staff member's
 * own session, so RLS (integration.manage, aal2, session validity) decides what
 * is visible. No privileged client is used. `credentialPresent` reports only
 * whether the server env values are non-empty, never the values.
 */

export const INBOX_STATUSES: InboxStatus[] = [
  'pending',
  'processing',
  'processed',
  'ignored',
  'needs_review',
  'failed',
  'dead_letter',
];
const ATTENTION: InboxStatus[] = ['needs_review', 'failed', 'dead_letter'];
const ATTENTION_LIMIT = 50;
const ENVIRONMENTS = ['unset', 'test', 'staging', 'operational'] as const;
const RUN_OUTCOMES = ['ok', 'partial', 'provider_error', 'internal_error'] as const;

/**
 * Deals waiting for an owner, grouped by Bitrix responsible
 * (integration_waiting_for_owner: integration managers only; removed Deals
 * excluded). A database count, so it is neither capped by the Data API row
 * limit nor hidden by Deal RLS (Super Admin no longer reads every Deal).
 */
async function ownerlessAssignees(
  db: Pick<StaffContext, 'supabase'>['supabase'],
): Promise<{ data: Array<{ source_assigned_by_id: number | string | null; deals: number }>; error: unknown }> {
  const { data, error } = await db.rpc('integration_waiting_for_owner');
  if (error) return { data: [], error };
  const rows = ((data as { byBitrixUser?: Array<{ bitrixUserId: number | string | null; deals: number }> } | null)?.byBitrixUser ?? [])
    .map((r) => ({ source_assigned_by_id: r.bitrixUserId, deals: Number(r.deals) || 0 }));
  return { data: rows, error: null };
}

/** Midnight today in India Standard Time (UTC+05:30, no daylight saving), as ISO. */
export function startOfTodayIst(nowMs: number = Date.now()): string {
  const offsetMs = 330 * 60_000;
  const istMidnight = Math.floor((nowMs + offsetMs) / 86_400_000) * 86_400_000;
  return new Date(istMidnight - offsetMs).toISOString();
}

const INBOX_COLUMNS =
  'id, source_object, status, origin, event_type, source_deal_id, received_at, attempts, max_attempts, next_attempt_at, reason_code, last_error_code, last_error_at, processed_deal_id';

interface InboxRow {
  id: string;
  /** Phase 6 (migration 20261007000100); absent on older rows read elsewhere means 'deal'. */
  source_object?: string | null;
  status: InboxStatus;
  origin: InboxItemView['origin'];
  event_type: string;
  source_deal_id: string | number;
  received_at: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  reason_code: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  processed_deal_id: string | null;
}

export function toInboxItemView(row: InboxRow): InboxItemView {
  return {
    inboxId: row.id,
    sourceObject: row.source_object === 'lead' ? 'lead' : 'deal',
    status: row.status,
    origin: row.origin,
    eventType: row.event_type,
    sourceDealId: String(row.source_deal_id),
    receivedAt: row.received_at,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    reasonCode: (row.reason_code as IntakeReasonCode | null) ?? null,
    lastErrorCode: (row.last_error_code as IntakeErrorCode | null) ?? null,
    lastErrorAt: row.last_error_at,
    processedDealId: row.processed_deal_id,
  };
}

interface JobRow {
  cutoff_at?: string;
  category_ids?: Array<number | string>;
  stage_ids?: string[];
  reason: 'settings_changed' | 'manual' | 'daily';
  status: 'queued' | 'running' | 'done';
  scanned: number;
  bitrix_total: number | null;
  listing_done: boolean;
  created_at: string;
  finished_at: string | null;
  result: Record<string, unknown> | null;
}

const num = (v: unknown) => (typeof v === 'number' ? v : 0);

/** Same filter as the current settings (order-insensitive). */
function sameFilter(job: JobRow, settings?: { cutoffAt: string; categoryIds: string[]; stageIds: string[] } | null): boolean {
  if (!settings || !job.cutoff_at) return false;
  const set = (a: Array<string | number>) => [...a].map(String).sort().join(',');
  return (
    Date.parse(job.cutoff_at) === Date.parse(settings.cutoffAt) &&
    set(job.category_ids ?? []) === set(settings.categoryIds) &&
    set(job.stage_ids ?? []) === set(settings.stageIds)
  );
}

export function toFullCheck(
  rows: JobRow[],
  settings?: { cutoffAt: string; categoryIds: string[]; stageIds: string[] } | null,
): FullCheckView {
  const open = rows.find((r) => r.status !== 'done') ?? null;
  const done = rows.find((r) => r.status === 'done' && r.result && r.finished_at) ?? null;
  return {
    running: open
      ? { reason: open.reason, scanned: open.scanned, bitrixTotal: open.bitrix_total, listingDone: open.listing_done, queuedAt: open.created_at }
      : null,
    last: done
      ? {
          finishedAt: done.finished_at!,
          bitrix: num(done.result!.bitrix),
          crm: num(done.result!.crm),
          missing: num(done.result!.missing),
          extra: num(done.result!.extra),
          keptAfterStageMove: num(done.result!.keptAfterStageMove),
          inSync: done.result!.inSync === true,
          matchesSettings: sameFilter(done, settings),
        }
      : null,
  };
}

type Res = { data?: unknown; error?: unknown } | null | undefined;

const runCount = z.number().int().nonnegative();
const outcomeCounts = z.object({ ok: runCount, partial: runCount, providerError: runCount, internalError: runCount });
const runs24hSchema = z.object({
  worker: outcomeCounts,
  reconcile: outcomeCounts,
  itemsFailed: runCount,
  itemsDeadLettered: runCount,
  lastFailedAt: z.string().nullable(),
});

/** integration_auto_sync_status().runs24h (20261113000100); null when absent or malformed (never a guessed zero). */
export function toRuns24h(value: unknown): RunCounts24h | null {
  const parsed = runs24hSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function toAutoSync(auto: Res, okRun: Res): AutoSyncView | null {
  if (!auto || auto.error || !auto.data || typeof auto.data !== 'object') return null;
  const d = auto.data as {
    cronInstalled?: boolean;
    job?: { active?: boolean } | null;
    enabled?: boolean | null;
    lastCalls?: Array<{ at: string; statusCode: number | null; ok: boolean | null; reason: string | null }>;
    failingSince?: string | null;
    runs24h?: unknown;
  };
  const ok = okRun && !okRun.error ? (okRun.data as { finished_at?: string } | null) : null;
  return {
    cronInstalled: d.cronInstalled === true && !!d.job,
    jobActive: d.job?.active === true,
    enabled: d.enabled ?? null,
    lastCalls: (d.lastCalls ?? []).map((c) => ({ at: c.at, statusCode: c.statusCode ?? null, ok: c.ok ?? null, reason: c.reason ?? null })),
    failingSince: d.failingSince ?? null,
    lastSuccessAt: ok?.finished_at ?? null,
    runs24h: toRuns24h(d.runs24h),
  };
}

function toLastRun(res: Res): IntegrationStatusView['lastRun'] {
  if (!res || res.error || !res.data) return null;
  const r = res.data as { finished_at?: string; claimed?: number; created?: number; updated?: number };
  if (!r.finished_at) return null;
  return { at: r.finished_at, fetched: r.claimed ?? 0, created: r.created ?? 0, updated: r.updated ?? 0 };
}

export async function loadIntegrationStatus(staff: Pick<StaffContext, 'supabase'>): Promise<IntegrationStatusView> {
  const db = staff.supabase;
  const env = getIntegrationEnv();

  const [configRes, envRes, attentionRes, lastRes, runRes, oldestRes, syncRes, todayRes, scheduleRes, waitingRes, jobsRes, crmDeals, autoRes, okRunRes, workerRes, ...countRes] =
    await Promise.all([
    selectIntakeConfig((columns) => db.from('integration_intake_config').select(columns).eq('source_system', 'bitrix')),
    db.from('deployment_settings').select('environment').limit(1).maybeSingle(),
    db
      .from('integration_inbox')
      .select(INBOX_COLUMNS)
      .in('status', ATTENTION)
      .order('received_at', { ascending: false })
      .limit(ATTENTION_LIMIT),
    db
      .from('integration_inbox')
      .select('processed_at')
      .not('processed_at', 'is', null)
      .order('processed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from('integration_worker_runs')
      .select('finished_at, outcome')
      .eq('kind', 'worker')
      .not('finished_at', 'is', null)
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from('integration_inbox')
      .select('received_at')
      .in('status', ['pending', 'failed'])
      .order('received_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    db
      .from('integration_worker_runs')
      .select('finished_at, outcome')
      .eq('kind', 'reconcile')
      .not('finished_at', 'is', null)
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from('integration_inbox')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'processed')
      .gte('processed_at', startOfTodayIst()),
    db.from('integration_sync_schedule').select('enabled').limit(1).maybeSingle(),
    ownerlessAssignees(db),
    db
      .from('integration_resync_jobs')
      .select('reason, status, scanned, bitrix_total, listing_done, created_at, finished_at, result, cutoff_at, category_ids, stage_ids')
      .in('status', ['queued', 'running', 'done'])
      .order('created_at', { ascending: false })
      .limit(10),
    // THE deal count (same query as the Deals page); admin reads every live deal.
    countVisibleDeals(staff).catch(() => null),
    db.rpc('integration_auto_sync_status'),
    db
      .from('integration_worker_runs')
      .select('finished_at')
      .eq('kind', 'reconcile')
      .in('outcome', ['ok', 'partial'])
      .not('finished_at', 'is', null)
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from('integration_worker_runs')
      .select('finished_at, claimed, created, updated')
      .eq('kind', 'worker')
      .not('finished_at', 'is', null)
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    ...INBOX_STATUSES.map((status) =>
      db.from('integration_inbox').select('id', { count: 'exact', head: true }).eq('status', status),
    ),
  ]);

  for (const res of [configRes, attentionRes, ...countRes]) {
    if (res.error) throw new Error('Could not load the integration status. Please retry.');
  }

  const configs = (configRes.data ?? []).map(parseIntakeConfigRow).filter((c) => c !== null);
  const enabledConfigCount = countEnabled(configRes.data ?? []);
  const config = configs.find((c) => c.enabled) ?? configs[0] ?? null;
  const run = runRes.error ? null : (runRes.data as { finished_at?: string; outcome?: string } | null);
  const lastWorkerOutcome = (RUN_OUTCOMES as readonly string[]).includes(run?.outcome ?? '')
    ? (run!.outcome as IntegrationStatusView['lastWorkerOutcome'])
    : null;

  // Unreadable or missing deployment setting is reported as 'unset' (intake refuses then too).
  const rawEnv = envRes.error ? null : (envRes.data as { environment?: string } | null)?.environment;
  const environment = (ENVIRONMENTS as readonly string[]).includes(rawEnv ?? '')
    ? (rawEnv as IntegrationStatusView['environment'])
    : 'unset';

  let pilotBranchName: string | null = null;
  if (config?.pilotBranchId) {
    const branch = await db.from('branches').select('name').eq('id', config.pilotBranchId).maybeSingle();
    pilotBranchName = (branch.data as { name?: string } | null)?.name ?? null;
  }

  const sync = syncRes.error ? null : (syncRes.data as { finished_at?: string; outcome?: string } | null);
  const lastSyncOutcome = (RUN_OUTCOMES as readonly string[]).includes(sync?.outcome ?? '')
    ? (sync!.outcome as NonNullable<IntegrationStatusView['lastSyncOutcome']>)
    : null;

  const waitingRows = waitingRes.error ? [] : waitingRes.data;
  const byUser = new Map<string, number>();
  for (const r of waitingRows) {
    if (r.source_assigned_by_id == null) continue;
    const id = String(r.source_assigned_by_id);
    byUser.set(id, (byUser.get(id) ?? 0) + r.deals);
  }

  const counts = Object.fromEntries(INBOX_STATUSES.map((s, i) => [s, countRes[i]?.count ?? 0])) as Record<
    InboxStatus,
    number
  >;

  return {
    crmDeals: crmDeals ?? undefined,
    fullCheck: jobsRes.error
      ? null
      : toFullCheck(
          (jobsRes.data ?? []) as JobRow[],
          // B1.1d: the full check lists the entry stages while Won-only intake is on.
          config ? { cutoffAt: config.cutoffAt, categoryIds: config.categoryIds, stageIds: dealListingStageIds(config) } : null,
        ),
    autoSync: toAutoSync(autoRes, okRunRes),
    lastRun: toLastRun(workerRes),
    // Exactly one enabled portal: more than one is ambiguous and intake refuses.
    configured: enabledConfigCount === 1 && isIntakeEnvironmentAllowed(environment, config?.portalDomain ?? null),
    environment,
    portalDomain: config?.portalDomain ?? null,
    pilotBranchName,
    cutoffAt: config?.cutoffAt ?? null,
    // Phase 5: the application token lives with the Edge receiver, not on Vercel;
    // the app needs only the REST credential for the worker.
    credentialPresent: Boolean(env.bitrixWebhookBaseUrl),
    // Either trigger counts: Vercel Cron (CRON_SECRET) or manual/pg_net (INTAKE_WORKER_SECRET).
    workerSecretPresent: [env.cronSecret, env.intakeWorkerSecret].some((v) => (v?.length ?? 0) >= MIN_WORKER_SECRET_LENGTH),
    enabledConfigCount,
    counts,
    lastProcessedAt: lastRes.error ? null : ((lastRes.data as { processed_at?: string } | null)?.processed_at ?? null),
    lastWorkerRunAt: run?.finished_at ?? null,
    lastWorkerOutcome: run?.finished_at ? lastWorkerOutcome : null,
    lastSyncAt: sync?.finished_at ?? null,
    lastSyncOutcome: sync?.finished_at ? lastSyncOutcome : null,
    dealsSyncedToday: todayRes.error ? 0 : (todayRes.count ?? 0),
    syncEnabled: scheduleRes.error ? null : ((scheduleRes.data as { enabled?: boolean } | null)?.enabled ?? null),
    categoryIds: config?.categoryIds ?? [],
    stageIds: config?.eligibleStageIds ?? [],
    // B1.1d Won-only Deal intake (null = off).
    dealEntryStageIds: config?.dealEntryStageIds ?? null,
    dealIntakeWonOnly: (config?.dealEntryStageIds ?? null) !== null,
    waitingForOwner: waitingRows.reduce((sum, r) => sum + r.deals, 0),
    waitingByBitrixUser: [...byUser.entries()]
      .map(([bitrixUserId, deals]) => ({ bitrixUserId, deals }))
      .sort((a, b) => b.deals - a.deals),
    oldestPendingAt: oldestRes.error ? null : ((oldestRes.data as { received_at?: string } | null)?.received_at ?? null),
    attention: ((attentionRes.data ?? []) as unknown as InboxRow[]).map(toInboxItemView),
  };
}

// ---------------------------------------------------------------------------
// Phase 6 import-scope panel (lead-screens contract §3).
// ---------------------------------------------------------------------------

const timestamp = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'timestamp');
const count = z.number().int().nonnegative();

const intakeScopeSchema = z
  .object({
    manifest: z
      .object({
        status: z.enum(['active', 'closed']),
        sourceObject: z.enum(['lead', 'deal']),
        sourceCode: z.string().min(1),
        sourceCodeLabel: z.string().nullable(),
        businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        intervalFrom: timestamp,
        intervalTo: timestamp,
        expectedCount: count,
        createdByOperator: z.string(),
        createdAt: timestamp,
        closedAt: timestamp.nullable(),
        counts: z.strictObject({ imported: count, heldForReview: count, failed: count, excluded: count }),
      })
      .strict()
      .nullable(),
    lastSuccessfulSyncAt: timestamp.nullable(),
  })
  .strict();

/** Strictly parses the intake_scope_status() answer; unknown keys or shapes are rejected (fail closed). */
export function parseIntakeScope(data: unknown): IntakeScopeView | null {
  const parsed = intakeScopeSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

type ScopeRpc = (fn: 'intake_scope_status') => PromiseLike<{ data: unknown; error: { code?: string } | null }>;

/**
 * Import-scope panel data via public.intake_scope_status() under the staff
 * member's own session. Returns null when the database refuses (42501, not an
 * integration admin or session not ok). Throws on any other error or on an
 * answer that does not match IntakeScopeView, so the page never shows a guess.
 */
export async function loadIntakeScope(staff: Pick<StaffContext, 'supabase'>): Promise<IntakeScopeView | null> {
  // intake_scope_status is not in the generated Database types yet (lead owns them).
  const rpc = staff.supabase.rpc.bind(staff.supabase) as unknown as ScopeRpc;
  const { data, error } = await rpc('intake_scope_status');
  if (error) {
    if (error.code === '42501') return null;
    throw new Error('Could not load the import list status. Please retry.');
  }
  const scope = parseIntakeScope(data);
  if (!scope) throw new Error('Could not load the import list status. Please retry.');
  return scope;
}

// ---------------------------------------------------------------------------
// B1.1d Won-only Deal intake (freeze note 3.3).
// ---------------------------------------------------------------------------

/**
 * The entry rule for the Bitrix sync and workflow screens, read under the staff
 * member's own session (RLS: integration.manage). Pass the Bitrix pipelines the
 * page already loaded to show stage names (ids otherwise). Null when the intake
 * config is not readable for this person.
 */
export async function loadIntakeEntryRule(
  staff: Pick<StaffContext, 'supabase'>,
  pipelines?: BitrixPipeline[] | null,
): Promise<IntakeEntryRuleView | null> {
  const config = await readManagedConfig(staff);
  return config ? entryRuleView(config, pipelines) : null;
}
