import 'server-only';
import { randomUUID } from 'node:crypto';
import webPush from 'web-push';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { PUSH_TEST_BODY, PUSH_TITLE, noticeText, type NoticeItemDTO, type PushPayload } from '../contracts';
import { PushClaimSchema, type PushClaimRow } from '../dto';
import { noticeHref } from '../href';
import { isSafeNoticePath } from '../push-policy';

/**
 * Closed-browser alert sender (Accounts phase 3 contract 8.2-8.4, LD19, LD20;
 * web-push 3.6.7, Addendum L1). Claims at most 50 due jobs (push_claim
 * re-checks visibility, read / done / resolved state, the person, the device
 * and the switch), sends each with the Web Push standard and completes it.
 * Runs from the timer route every minute and from the push route when the
 * database kicks it (within seconds of a new job).
 *
 * The payload is the ONLY content that leaves for the browser's push service:
 * {title, body, tag, url}, where body is the bell text (noticeText) and url a
 * same-origin path (noticeHref). The bell text holds references only; names,
 * phone numbers, amounts, PNRs, ticket numbers and message text are never in a
 * notice row. Counts only in results and logs; never an endpoint or key.
 */

export const PUSH_DISPATCH_LIMIT = 50;
export const PUSH_LEASE_SECONDS = 60;
/** How long the push service keeps an undelivered alert (8.4). */
export const PUSH_TTL_SECONDS = 3600;
const SEND_TIMEOUT_MS = 10_000;
const PARALLEL = 10;

/** The payload of a notice alert (8.2). Pure: unit-tested with sentinel values. */
export function buildPushPayload(item: NoticeItemDTO): PushPayload {
  const href = noticeHref(item);
  return {
    title: PUSH_TITLE,
    body: noticeText(item),
    tag: `tn-notice-${item.noticeId}`,
    url: href && isSafeNoticePath(href) ? href : '/app',
  };
}

/** The payload of a test alert (D4). */
export function buildTestPushPayload(jobId: string): PushPayload {
  return { title: PUSH_TITLE, body: PUSH_TEST_BODY, tag: `tn-test-${jobId}`, url: '/app' };
}

export interface PushSubscriptionTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** null status = no answer from the push service (network, timeout). */
export type PushSendResult = { ok: true } | { ok: false; statusCode: number | null };

export interface PushDispatchDeps {
  worker: string;
  claim(worker: string, limit: number, leaseSeconds: number): Promise<unknown>;
  complete(jobId: string, worker: string, ok: boolean, statusCode: number | null): Promise<void>;
  send(target: PushSubscriptionTarget, payload: string, options: { urgency: 'high' | 'normal'; ttlSeconds: number }): Promise<PushSendResult>;
}

export interface PushDispatchCounts {
  claimed: number;
  sent: number;
  failed: number;
  gone: number;
}

async function sendOne(job: PushClaimRow, deps: PushDispatchDeps): Promise<PushSendResult> {
  if (!job.test && !job.notice) return { ok: false, statusCode: null };
  const payload = job.notice && !job.test ? buildPushPayload(job.notice) : buildTestPushPayload(job.jobId);
  try {
    return await deps.send({ endpoint: job.endpoint, keys: { p256dh: job.p256dh, auth: job.authKey } }, JSON.stringify(payload), {
      urgency: job.urgent ? 'high' : 'normal',
      ttlSeconds: PUSH_TTL_SECONDS,
    });
  } catch {
    return { ok: false, statusCode: null };
  }
}

/**
 * One pass: claim, send (10 at a time), complete. Returns null when the push
 * keys are not configured (the step is skipped; jobs wait and the stalled
 * check reports them).
 */
export async function dispatchPush(deps: PushDispatchDeps | null = productionPushDeps()): Promise<PushDispatchCounts | null> {
  if (!deps) return null;
  const parsed = PushClaimSchema.safeParse(await deps.claim(deps.worker, PUSH_DISPATCH_LIMIT, PUSH_LEASE_SECONDS));
  if (!parsed.success) throw Object.assign(new Error('push_claim gave an unexpected answer'), { code: 'bad_response' });
  const counts: PushDispatchCounts = { claimed: parsed.data.length, sent: 0, failed: 0, gone: 0 };
  for (let i = 0; i < parsed.data.length; i += PARALLEL) {
    await Promise.all(parsed.data.slice(i, i + PARALLEL).map(async (job) => {
      const result = await sendOne(job, deps);
      try {
        if (result.ok) {
          await deps.complete(job.jobId, deps.worker, true, 201);
          counts.sent += 1;
        } else {
          await deps.complete(job.jobId, deps.worker, false, result.statusCode);
          if (result.statusCode === 404 || result.statusCode === 410) counts.gone += 1;
          else counts.failed += 1;
        }
      } catch {
        // The lease runs out and the job is claimed again; nothing is lost.
        counts.failed += 1;
      }
    }));
  }
  return counts;
}

/** VAPID settings from the environment (owner saves them in Vercel; never logged). Null when incomplete. */
export function vapidFromEnv(env: Record<string, string | undefined> = process.env): { subject: string; publicKey: string; privateKey: string } | null {
  const subject = env.VAPID_SUBJECT?.trim() ?? '';
  const publicKey = env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() ?? '';
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() ?? '';
  if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(subject)) return null;
  if (!/^[A-Za-z0-9_-]{80,100}={0,2}$/.test(publicKey) || !/^[A-Za-z0-9_-]{40,50}={0,2}$/.test(privateKey)) return null;
  return { subject, publicKey, privateKey };
}

let vapidSet = false;

/** The production sender, or null while the push keys are not configured. */
export function productionPushDeps(): PushDispatchDeps | null {
  const vapid = vapidFromEnv();
  if (!vapid) return null;
  if (!vapidSet) {
    try {
      webPush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
      vapidSet = true;
    } catch {
      return null;
    }
  }
  const rpc = asRpcClient(createSupabaseAdminClient());
  return {
    worker: `web-${randomUUID().slice(0, 18)}`,
    claim: async (worker, limit, leaseSeconds) => {
      const { data, error } = await rpc.rpc('push_claim', { p_worker: worker, p_limit: limit, p_lease_seconds: leaseSeconds });
      if (error) throw Object.assign(new Error('push_claim failed'), { code: error.code ?? 'rpc_error' });
      return data;
    },
    complete: async (jobId, worker, ok, statusCode) => {
      const { error } = await rpc.rpc('push_complete', { p_job_id: jobId, p_worker: worker, p_ok: ok, p_status_code: statusCode });
      if (error) throw Object.assign(new Error('push_complete failed'), { code: error.code ?? 'rpc_error' });
    },
    send: async (target, payload, options) => {
      try {
        await webPush.sendNotification(target, payload, { TTL: options.ttlSeconds, urgency: options.urgency, timeout: SEND_TIMEOUT_MS });
        return { ok: true };
      } catch (error) {
        const status = error instanceof webPush.WebPushError && Number.isInteger(error.statusCode) ? error.statusCode : null;
        return { ok: false, statusCode: status };
      }
    },
  };
}
