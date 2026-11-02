import 'server-only';

import { PRODUCTION_STAFF_DOMAIN } from '@/lib/config';

/**
 * Supplier e-mail sender (owner decision 5, 2 November 2026) through the
 * Resend HTTP API. Rules:
 *   - Call only from a Purchase server action, AFTER the database recorded
 *     the e-mail as 'queued' (purchase_email_record or
 *     purchase_booking_request_send). The database queues only while
 *     procurement_settings.supplier_email_sending_enabled is on (default off).
 *   - Sender is fixed (SUPPLIER_EMAIL_FROM); replies go to the Purchase
 *     person (replyTo). Plain text only.
 *   - The API key comes from RESEND_API_KEY (Vercel environment). Never log
 *     the key, the recipients or the message.
 *   - Tests stub fetch (pass `fetchImpl`); this module is never called with
 *     the real network in tests.
 */

export const SUPPLIER_EMAIL_FROM = `notifications@${PRODUCTION_STAFF_DOMAIN}`;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 15_000;

export interface SupplierEmailMessage {
  to: string;
  cc: readonly string[];
  subject: string;
  text: string;
  /** The Purchase person's own e-mail address. */
  replyTo: string;
}

export type SupplierEmailSendResult =
  | { ok: true; providerId: string }
  /** reason: a short code safe to store (never provider text with addresses). */
  | { ok: false; reason: 'not_configured' | 'rejected' | 'provider_error' | 'network' | 'bad_response' };

type FetchLike = (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export async function sendSupplierEmail(
  message: SupplierEmailMessage,
  opts: { apiKey?: string | undefined; fetchImpl?: FetchLike } = {},
): Promise<SupplierEmailSendResult> {
  const apiKey = opts.apiKey ?? process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, reason: 'not_configured' };
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));

  let response: Pick<Response, 'ok' | 'status' | 'json'>;
  try {
    response = await doFetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: SUPPLIER_EMAIL_FROM,
        to: [message.to],
        ...(message.cc.length > 0 ? { cc: [...message.cc] } : {}),
        reply_to: message.replyTo,
        subject: message.subject,
        text: message.text,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (!response.ok) {
    return { ok: false, reason: response.status >= 400 && response.status < 500 ? 'rejected' : 'provider_error' };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'bad_response' };
  }
  const id = body && typeof body === 'object' && 'id' in body ? (body as { id: unknown }).id : null;
  // Resend message ids are UUIDs; the database accepts nothing else as a sent id.
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { ok: false, reason: 'bad_response' };
  }
  return { ok: true, providerId: id };
}
