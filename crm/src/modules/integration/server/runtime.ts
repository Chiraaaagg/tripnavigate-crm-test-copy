import 'server-only';
import { after } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleBitrixEvent } from '../bitrix/receiver';
import { getIntegrationEnv } from '../bitrix/config';
import { json } from '../bitrix/receiver';
import { liveBatchDecision, runLiveBatch } from '../bitrix/live';
import type { LeadWatermarkStore } from '../bitrix/reconcile';
import { handleWorkerRequest, type WorkerTrigger } from '../bitrix/worker-endpoint';
import { asRpcClient, type RecordedEvent } from '../commands';
import type { InboxStatus, SourceObject } from '../contracts';
import { selectIntakeConfig, type IntakeConfig } from '../intake-config';
import { IN_WORKER_TIMEOUTS, runIdProofCopyBatch } from './id-proof-copy-runtime';

/**
 * Production wiring for the machine-to-machine intake routes. The privileged
 * client is created only after the route's own authentication (application
 * token / worker bearer) succeeded: the handlers call these factories lazily.
 */

let admin: ReturnType<typeof createSupabaseAdminClient> | undefined;
function adminClient() {
  admin ??= createSupabaseAdminClient();
  return admin;
}

async function loadConfigRows(): Promise<unknown[]> {
  // B1.1d: falls back to the legacy columns on a database without deal_entry_stage_ids.
  const { data, error } = await selectIntakeConfig((columns) =>
    adminClient().from('integration_intake_config').select(columns).eq('source_system', 'bitrix'),
  );
  if (error) throw new Error('intake config unavailable');
  return data ?? [];
}

/** Source deal IDs CRM already holds for this portal (reconcile update pass). */
export async function heldDealIds(memberId: string, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const { data, error } = await adminClient()
    .from('deals')
    .select('source_deal_id')
    .eq('source_system', 'bitrix')
    .eq('source_portal', memberId)
    .in('source_deal_id', ids);
  if (error) throw new Error('deal lookup unavailable');
  return new Set((data ?? []).map((d) => Number((d as { source_deal_id: number | string }).source_deal_id)));
}

const VERIFIED_LOOKUP_CHUNK = 200;

/**
 * Phase 6: last_verified_at (ms) of manifest records CRM already holds for this
 * portal, so a bounded reconcile pass re-verifies the stalest first. Lead IDs
 * are looked up only in crm_leads, Deal IDs only in deals.
 */
export async function manifestVerifiedAt(memberId: string, sourceObject: SourceObject, ids: string[]): Promise<Map<string, number>> {
  const table = sourceObject === 'lead' ? 'crm_leads' : 'deals';
  const idColumn = sourceObject === 'lead' ? 'source_lead_id' : 'source_deal_id';
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += VERIFIED_LOOKUP_CHUNK) {
    const chunk = ids.slice(i, i + VERIFIED_LOOKUP_CHUNK);
    const { data, error } = await adminClient()
      .from(table)
      .select(`${idColumn}, last_verified_at`)
      .eq('source_system', 'bitrix')
      .eq('source_portal', memberId)
      .in(idColumn, chunk);
    if (error) throw new Error('verification lookup unavailable');
    for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      const at = Date.parse(String(row.last_verified_at ?? ''));
      if (Number.isFinite(at)) out.set(String(row[idColumn]), at);
    }
  }
  return out;
}

/** Minimal PostgREST surface for the Lead watermark read (column not in the generated types yet; lead owns them). */
interface WatermarkQuery {
  select(columns: string): WatermarkQuery;
  eq(column: string, value: unknown): WatermarkQuery;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * Sync completion §2: the Lead scope pass watermark, kept apart from the Deal
 * watermark. Pending DB interface (lead to confirm):
 *   integration_intake_config.lead_reconciled_at timestamptz null (null = from the sync date)
 *   public.integration_record_lead_reconcile_run(p_member_id text, p_started_at timestamptz, p_ok boolean)
 * Until both exist the read fails and the reconcile skips the Lead scope pass
 * (summary.leadScope.unavailable); nothing else changes.
 */
export function leadWatermarkStore(memberId: string): LeadWatermarkStore {
  return {
    async read() {
      const table = adminClient().from('integration_intake_config') as unknown as WatermarkQuery;
      const { data, error } = await table
        .select('lead_reconciled_at')
        .eq('portal_member_id', memberId)
        .eq('enabled', true)
        .maybeSingle();
      if (error || !data) throw new Error('lead watermark unavailable');
      const value = (data as { lead_reconciled_at?: unknown }).lead_reconciled_at;
      if (value === null) return null;
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error('lead watermark unavailable');
      return value;
    },
    async record(startedAt, ok) {
      const { error } = await asRpcClient(adminClient()).rpc('integration_record_lead_reconcile_run', {
        p_member_id: memberId,
        p_started_at: startedAt,
        p_ok: ok,
      });
      if (error) throw new Error('lead watermark not recorded');
    },
  };
}

const INBOX_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'processing',
  'processed',
  'ignored',
  'needs_review',
  'failed',
  'dead_letter',
]);

/**
 * Status of one inbox row (service role). Used by the live batch only when the
 * record command did not return the status (database before sync completion).
 */
async function inboxStatus(inboxId: string): Promise<InboxStatus | null> {
  const { data, error } = await adminClient().from('integration_inbox').select('status').eq('id', inboxId).maybeSingle();
  if (error || !data) return null;
  const status = (data as { status?: unknown }).status;
  return typeof status === 'string' && INBOX_STATUSES.has(status) ? (status as InboxStatus) : null;
}

/**
 * Sync completion §1: a pending row gets one bounded batch after the response
 * (Next.js after(); runs within the route's maxDuration). Rows the database
 * marked as anything else (ignored, duplicate of a processed row) schedule nothing.
 */
function scheduleLiveBatch(recorded: RecordedEvent, config: IntakeConfig): void {
  if (liveBatchDecision(recorded) === 'skip') return;
  after(async () => {
    await runLiveBatch({
      env: getIntegrationEnv(),
      appEnv: process.env.APP_ENV,
      vercelEnv: process.env.VERCEL_ENV,
      config,
      recorded,
      rpc: () => asRpcClient(adminClient()),
      inboxStatus,
    });
  });
}

/**
 * Vercel events route: LOCAL ONLY (tests and the real-stack CI job). In
 * production the only registered ingress is the Supabase Edge Function
 * `bitrix-events`; this route answers 404 so the public Production deployment
 * exposes no second receiver (docs/implementation/phase-5/intake-plan.md).
 */
export async function receiveBitrixEvent(request: Request): Promise<Response> {
  if (process.env.APP_ENV !== 'local' || process.env.VERCEL_ENV !== undefined) return json(404, { error: 'not_found' });
  return handleBitrixEvent(request, {
    env: getIntegrationEnv(),
    loadConfigRows,
    rpc: () => asRpcClient(adminClient()),
    afterRecord: scheduleLiveBatch,
  });
}

export function runIntakeWorker(request: Request, trigger: WorkerTrigger = 'manual'): Promise<Response> {
  return handleWorkerRequest(request, {
    env: getIntegrationEnv(),
    appEnv: process.env.APP_ENV,
    vercelEnv: process.env.VERCEL_ENV,
    trigger,
    loadConfigRows,
    rpc: () => asRpcClient(adminClient()),
    heldDealIds,
    manifestVerifiedAt,
    leadWatermark: leadWatermarkStore,
    // Sync completion §4: the post-run alert check runs after the response.
    schedule: (task) => after(task),
    // B1.2 DEC-43: one ID-proof copy job after ?task=sync, only while the switch is on.
    idProofCopy: async (config) => {
      const run = await runIdProofCopyBatch(1, { config, timeouts: IN_WORKER_TIMEOUTS });
      return run.status === 'ran' ? { status: 'ran', ...run.summary } : run;
    },
  });
}
