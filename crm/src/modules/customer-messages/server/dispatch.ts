import 'server-only';
import { randomUUID } from 'node:crypto';
import { after } from 'next/server';
import { z } from 'zod';
import { sendCustomerEmail, type CustomerEmailMessage, type CustomerEmailResult } from '@/lib/email/customer-email';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { sendWhatsAppTemplate, type WhatsAppSendResult, type WhatsAppTemplateMessage } from '@/lib/whatsapp/interakt';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { CHANNELS, LANGUAGES, MESSAGE_TYPES, type SendErrorCode } from '../contracts';
import { CUSTOMER_MESSAGE_TEMPLATES, renderEmail, templateValues } from '../templates';

/**
 * Customer message sender (contract 5.9). Claims at most 25 due messages
 * (customer_message_claim re-checks every skip rule and resolves the address
 * now), sends each with the Resend or Interakt adapter and completes it
 * (customer_message_complete: sent, or the retry schedule). Runs from the
 * timer route every minute and once with after() from a server action whose
 * command queued a message. Counts only in the result; never an address,
 * name, amount or message text in a log or result.
 */

/**
 * At most 5 messages per pass, leased for 120 s: 5 x (15 s provider timeout +
 * 5 s file and database work) = 100 s fits inside the lease. The loop stops
 * before a row's lease could run out mid-send, or when the caller's time
 * budget ends; rows left over are claimed again when their lease expires.
 */
export const DISPATCH_LIMIT = 5;
export const DISPATCH_LEASE_SECONDS = 120;
/** Never start a send with less than this left on the lease (provider timeout + margin). */
export const DISPATCH_SEND_RESERVE_MS = 25_000;
/** customer_message_complete is tried up to 3 times (short backoff) so a sent message is recorded as sent. */
export const COMPLETE_BACKOFF_MS: readonly number[] = Object.freeze([250, 1000]);
/** LD7: a WhatsApp file link is valid for 30 minutes. */
export const FILE_LINK_SECONDS = 30 * 60;

const ClaimedSchema = z.array(z.object({
  id: z.string().uuid(),
  channel: z.enum(CHANNELS),
  type: z.enum(MESSAGE_TYPES),
  language: z.enum(LANGUAGES),
  templateCode: z.string().regex(/^tn_[a-z_]+_(en|hi)_v[0-9]+$/),
  params: z.record(z.string(), z.unknown()),
  attachment: z.object({
    source: z.enum(['purchase_evidence', 'department_evidence']),
    id: z.string().uuid(),
    bucket: z.enum(['purchase-evidence', 'department-evidence']),
    objectPath: z.string().min(1).max(300),
    fileName: z.string().min(1).max(120),
    mime: z.string().min(1).max(60),
  }).nullable(),
  dealId: z.string().uuid(),
  to: z.string().min(1).max(254).nullable(),
  replyTo: z.string().min(3).max(254).nullable(),
}));
export type ClaimedMessage = z.infer<typeof ClaimedSchema>[number];

export interface DispatchDeps {
  worker: string;
  claim(worker: string, limit: number, leaseSeconds: number): Promise<unknown>;
  complete(id: string, worker: string, ok: boolean, providerId: string | null, errorCode: SendErrorCode | null): Promise<void>;
  /** Gives back rows this worker claimed but never started (customer_message_release). */
  release(ids: string[], worker: string): Promise<void>;
  sleep?(ms: number): Promise<void>;
  sendEmail(message: CustomerEmailMessage): Promise<CustomerEmailResult>;
  sendWhatsApp(message: WhatsAppTemplateMessage): Promise<WhatsAppSendResult>;
  readFile(bucket: string, objectPath: string): Promise<Uint8Array | null>;
  signedUrl(bucket: string, objectPath: string, seconds: number): Promise<string | null>;
  now?(): number;
}

export interface DispatchCounts {
  claimed: number;
  sent: number;
  failed: number;
  /** Claimed but not started (lease or time budget too short): claimed again after the lease. */
  leftOver: number;
}

async function sendOne(m: ClaimedMessage, deps: DispatchDeps): Promise<{ ok: true; providerId: string | null } | { ok: false; reason: SendErrorCode }> {
  if (!m.to) return { ok: false, reason: 'rejected' };
  if (m.channel === 'email') {
    const rendered = renderEmail(m.type, m.language, m.params);
    let attachments: CustomerEmailMessage['attachments'];
    if (m.attachment) {
      const bytes = await deps.readFile(m.attachment.bucket, m.attachment.objectPath);
      if (!bytes) return { ok: false, reason: 'network' };
      attachments = [{ fileName: m.attachment.fileName, contentBase64: Buffer.from(bytes).toString('base64') }];
    }
    return deps.sendEmail({ messageId: m.id, to: m.to, replyTo: m.replyTo, ...rendered, ...(attachments ? { attachments } : {}) });
  }
  const tpl = CUSTOMER_MESSAGE_TEMPLATES[m.type][m.language];
  let headerValues: string[] | undefined;
  if (tpl.header === 'document') {
    if (!m.attachment) return { ok: false, reason: 'rejected' };
    const link = await deps.signedUrl(m.attachment.bucket, m.attachment.objectPath, FILE_LINK_SECONDS);
    if (!link) return { ok: false, reason: 'network' };
    headerValues = [link];
  }
  return deps.sendWhatsApp({
    messageId: m.id,
    phoneNumber: m.to,
    templateName: m.templateCode,
    languageCode: m.language,
    bodyValues: templateValues(m.type, m.language, m.params),
    ...(headerValues ? { headerValues, fileName: m.attachment!.fileName } : {}),
  });
}

export async function dispatchCustomerMessages(
  deps: DispatchDeps = productionDispatchDeps(),
  signal?: AbortSignal,
): Promise<DispatchCounts> {
  const now = deps.now ?? (() => Date.now());
  const claimedAt = now();
  const parsed = ClaimedSchema.safeParse(await deps.claim(deps.worker, DISPATCH_LIMIT, DISPATCH_LEASE_SECONDS));
  if (!parsed.success) throw Object.assign(new Error('customer_message_claim gave an unexpected answer'), { code: 'bad_response' });
  const counts: DispatchCounts = { claimed: parsed.data.length, sent: 0, failed: 0, leftOver: 0 };
  const leaseEnds = claimedAt + DISPATCH_LEASE_SECONDS * 1000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const notStarted: string[] = [];
  for (const m of parsed.data) {
    // Never send a row whose lease may run out before the provider answers.
    if (signal?.aborted || now() > leaseEnds - DISPATCH_SEND_RESERVE_MS) {
      notStarted.push(m.id);
      continue;
    }
    let result: { ok: true; providerId: string | null } | { ok: false; reason: SendErrorCode };
    try {
      result = await sendOne(m, deps);
    } catch {
      // The request may have left: never retried automatically.
      result = { ok: false, reason: 'unknown_outcome' };
    }
    // Record the outcome; retried so a sent message is not left 'sending' (a WhatsApp
    // row whose lease runs out becomes 'unknown', never sent again by itself).
    let recorded = false;
    for (let attempt = 0; attempt <= COMPLETE_BACKOFF_MS.length && !recorded; attempt += 1) {
      if (attempt > 0) await sleep(COMPLETE_BACKOFF_MS[attempt - 1]!);
      try {
        await deps.complete(m.id, deps.worker, result.ok, result.ok ? result.providerId : null, result.ok ? null : result.reason);
        recorded = true;
      } catch {
        recorded = false;
      }
    }
    if (result.ok && recorded) counts.sent += 1;
    else counts.failed += 1;
  }
  counts.leftOver = notStarted.length;
  if (notStarted.length > 0) {
    try {
      await deps.release(notStarted, deps.worker);
    } catch {
      // Their lease runs out and they are claimed again (e-mail) or marked unknown (WhatsApp, never started:
      // staff see it and may Send again).
    }
  }
  return counts;
}

export function productionDispatchDeps(): DispatchDeps {
  const admin = createSupabaseAdminClient();
  const rpc = asRpcClient(admin);
  return {
    worker: `web-${randomUUID().slice(0, 18)}`,
    claim: async (worker, limit, leaseSeconds) => {
      const { data, error } = await rpc.rpc('customer_message_claim', { p_worker: worker, p_limit: limit, p_lease_seconds: leaseSeconds });
      if (error) throw Object.assign(new Error('customer_message_claim failed'), { code: error.code ?? 'rpc_error' });
      return data;
    },
    release: async (ids, worker) => {
      const { error } = await rpc.rpc('customer_message_release', { p_ids: ids, p_worker: worker });
      if (error) throw Object.assign(new Error('customer_message_release failed'), { code: error.code ?? 'rpc_error' });
    },
    complete: async (id, worker, ok, providerId, errorCode) => {
      const { error } = await rpc.rpc('customer_message_complete', {
        p_id: id, p_worker: worker, p_ok: ok, p_provider_message_id: providerId, p_error_code: errorCode,
      });
      if (error) throw Object.assign(new Error('customer_message_complete failed'), { code: error.code ?? 'rpc_error' });
    },
    sendEmail: (message) => sendCustomerEmail(message),
    sendWhatsApp: (message) => sendWhatsAppTemplate(message),
    readFile: async (bucket, objectPath) => {
      const { data, error } = await admin.storage.from(bucket).download(objectPath);
      if (error || !data) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
    signedUrl: async (bucket, objectPath, seconds) => {
      const { data, error } = await admin.storage.from(bucket).createSignedUrl(objectPath, seconds);
      return error || !data ? null : data.signedUrl;
    },
  };
}

/** Called by a server action whose command queued a message: most messages leave within seconds; the timer is the backstop. */
export function scheduleCustomerMessageDispatch(): void {
  after(async () => {
    try {
      await dispatchCustomerMessages();
    } catch {
      // The minute timer runs it again.
    }
  });
}
