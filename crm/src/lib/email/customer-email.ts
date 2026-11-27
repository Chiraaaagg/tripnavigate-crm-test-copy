import 'server-only';

import { PRODUCTION_STAFF_DOMAIN } from '@/lib/config';

/**
 * Customer e-mail sender (Accounts phase 3, contract 5.7) through the Resend
 * HTTP API, the pattern of supplier-email.ts. Rules:
 *   - Called only by the customer message dispatcher (server), for a message
 *     the database claimed (customer_message_claim); never from a page.
 *   - Sender fixed: Holiday Chacha <notifications@holidaychacha.com> (DEC-19);
 *     reply-to the Deal's Sales owner, else the first active branch Manager,
 *     else none (LD10). Plain branded HTML + text. Attachments as base64.
 *   - The message id is the Idempotency-Key, so a retried request never sends twice.
 *   - RESEND_API_KEY comes from the Vercel environment. Never log the key, the
 *     address or the message. Results carry short codes only.
 *   - Tests pass `fetchImpl`; nothing here reaches the network in tests.
 */

export const CUSTOMER_EMAIL_FROM = `Holiday Chacha <notifications@${PRODUCTION_STAFF_DOMAIN}>`;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 15_000;

export interface CustomerEmailMessage {
  /** customer_messages.id: the idempotency key. */
  messageId: string;
  to: string;
  replyTo: string | null;
  subject: string;
  html: string;
  text: string;
  attachments?: ReadonlyArray<{ fileName: string; contentBase64: string }>;
}

/** Any 2xx answer is sent (providerId null when the answer had no usable id). */
export type CustomerEmailResult =
  | { ok: true; providerId: string | null }
  | { ok: false; reason: 'not_configured' | 'rejected' | 'provider_error' | 'network' | 'unknown_outcome' };

type FetchLike = (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export async function sendCustomerEmail(
  message: CustomerEmailMessage,
  opts: { apiKey?: string | undefined; fetchImpl?: FetchLike } = {},
): Promise<CustomerEmailResult> {
  const apiKey = opts.apiKey ?? process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, reason: 'not_configured' };
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));

  let response: Pick<Response, 'ok' | 'status' | 'json'>;
  try {
    response = await doFetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': message.messageId,
      },
      body: JSON.stringify({
        from: CUSTOMER_EMAIL_FROM,
        to: [message.to],
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.attachments && message.attachments.length > 0
          ? { attachments: message.attachments.map((a) => ({ filename: a.fileName, content: a.contentBase64 })) }
          : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (error) {
    return { ok: false, reason: fetchFailureReason(error) };
  }
  if (!response.ok) {
    return { ok: false, reason: response.status >= 400 && response.status < 500 && response.status !== 429 ? 'rejected' : 'provider_error' };
  }
  // A 2xx answer means Resend accepted the e-mail: never resend it, even if the body is odd.
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const id = body && typeof body === 'object' && 'id' in body ? (body as { id: unknown }).id : null;
  return { ok: true, providerId: typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null };
}

/**
 * A failed fetch: 'network' only when the request certainly did not leave
 * (name lookup or connection refused); otherwise 'unknown_outcome' (timeout,
 * reset): the message may have been sent, so it is never retried automatically.
 */
export function fetchFailureReason(error: unknown): 'network' | 'unknown_outcome' {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = String(e?.cause?.code ?? e?.code ?? '');
  return PRE_SEND_CODES.has(code) ? 'network' : 'unknown_outcome';
}

const PRE_SEND_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
