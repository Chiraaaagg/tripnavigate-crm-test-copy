import 'server-only';
import { createHash } from 'node:crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createBitrixClient } from '../bitrix/client';
import { getIntegrationEnv, resolveBitrixRestTarget } from '../bitrix/config';
import {
  createBitrixIdProofWriter,
  createFieldFileInspector,
  ID_PROOF_ITEM_FIELD,
  processIdProofCopyBatch,
  type IdProofCopySummary,
} from '../bitrix/id-proof-copy';
import { asRpcClient, claimIdProofCopyJobs, completeIdProofCopy, markIdProofCopySending, stopIdProofCopy } from '../commands';
import { selectActiveConfig, selectIntakeConfig, type IntakeConfig } from '../intake-config';

/**
 * Production wiring for the DEC-43 ID-proof copy (one batch). Scheduled by
 * the existing Bitrix worker: after the sync work of ?task=sync (pg_cron +
 * pg_net), when the switch bitrix_id_proof_copy is on, one job runs within
 * the invocation's remaining time (worker-endpoint.ts). Live activation is
 * the owner's APPROVE (switch on, credential BITRIX_WRITE_WEBHOOK_BASE_URL in
 * the server environment). With the switch off the worker makes no call at
 * all, and the claim here would return nothing.
 *
 * Two credentials: the existing read webhook reads the field (crm.item.get,
 * reduced to the one field at once) and downloads files through the entries'
 * urlMachine links (same portal host only); the separate write webhook is used
 * for crm.item.update (Deal, one field) only. Neither value, and no urlMachine
 * link, is ever logged or returned; errors are fixed codes.
 *
 * Several sync runs may overlap (pg_cron every 30 s, up to 90 s each), so
 * several invocations may each run one job: safe, because the database hands
 * out at most one job per Deal at a time and the 180 s lease outlives any
 * invocation (review E7-2/E7-6, E11-1).
 */

export const ID_PROOF_BUCKET = 'traveller-id-proofs';

export type IdProofCopyRun = { status: 'ran'; summary: IdProofCopySummary } | { status: 'not_configured'; code: string };

/**
 * Timeouts for a run inside the Bitrix worker (each bounded so one job fits
 * the invocation's remaining time): reads 10 s with no rate-limit retry, the
 * private-storage download 10 s, the write 20 s, the file check 10 s.
 */
export const IN_WORKER_TIMEOUTS = { readMs: 10_000, downloadMs: 10_000, writeMs: 20_000, inspectMs: 10_000 } as const;

export interface IdProofCopyRunOptions {
  /** The config the caller already loaded (no second read). */
  config?: IntakeConfig;
  timeouts?: { readMs: number; downloadMs: number; writeMs: number; inspectMs: number };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function runIdProofCopyBatch(limit = 5, options: IdProofCopyRunOptions = {}): Promise<IdProofCopyRun> {
  const writeUrl = process.env.BITRIX_WRITE_WEBHOOK_BASE_URL ?? null;
  if (!writeUrl) return { status: 'not_configured', code: 'write_credential_missing' };
  const admin = createSupabaseAdminClient();
  const rpc = asRpcClient(admin);
  let config = options.config ?? null;
  if (!config) {
    const { data, error } = await selectIntakeConfig((columns) =>
      admin.from('integration_intake_config').select(columns).eq('source_system', 'bitrix'),
    );
    if (error) return { status: 'not_configured', code: 'config_unavailable' };
    const active = selectActiveConfig(data ?? []);
    if (!active.config) return { status: 'not_configured', code: active.reason };
    config = active.config;
  }
  const env = getIntegrationEnv();
  let readTarget;
  let writeTarget;
  try {
    readTarget = resolveBitrixRestTarget(env.bitrixWebhookBaseUrl, config.portalDomain, process.env.APP_ENV);
    writeTarget = resolveBitrixRestTarget(writeUrl, config.portalDomain, process.env.APP_ENV);
  } catch {
    return { status: 'not_configured', code: 'bitrix_target_invalid' };
  }
  const t = options.timeouts;
  const reader = createBitrixClient({ target: readTarget, ...(t ? { timeoutMs: t.readMs, maxRateLimitRetries: 0 } : {}) });
  const writer = createBitrixIdProofWriter({ target: writeTarget, ...(t ? { timeoutMs: t.writeMs } : {}) });
  const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const inspectFile = createFieldFileInspector({ target: readTarget, sha256, ...(t ? { timeoutMs: t.inspectMs } : {}) });
  const summary = await processIdProofCopyBatch(
    {
      claim: (n) => claimIdProofCopyJobs(rpc, n),
      markSending: (job, prior) => markIdProofCopySending(rpc, job, prior),
      stop: async (job, reason) => {
        await stopIdProofCopy(rpc, job, reason);
      },
      inspectFile,
      complete: async (job, outcome, code, fileId) => {
        await completeIdProofCopy(rpc, job, outcome, code, fileId);
      },
      readDealItem: async (id) => {
        const read = await reader.getDealItemField(id, ID_PROOF_ITEM_FIELD);
        return read.kind === 'ok' ? { [ID_PROOF_ITEM_FIELD]: read.value } : null;
      },
      download: async (objectPath) => {
        const read = admin.storage.from(ID_PROOF_BUCKET).download(objectPath);
        const { data: blob, error: e } = t ? await withTimeout(read, t.downloadMs) : await read;
        if (e || !blob) throw new Error('file unavailable');
        return new Uint8Array(await blob.arrayBuffer());
      },
      sha256,
      writer,
    },
    limit,
  );
  return { status: 'ran', summary };
}
