import 'server-only';

/**
 * WhatsApp sender through Interakt (Accounts phase 3, contract 5.7), on the
 * number already connected in the Interakt dashboard (never the unofficial
 * QR-scanned number). Legacy Interakt code was read for structure only.
 *
 * Interakt public API, read 13 November 2026 (interakt.shop resource centre,
 * "how to send WhatsApp templates using APIs/webhooks"):
 *   POST https://api.interakt.ai/v1/public/message/
 *   Authorization: Basic <API key>; Content-Type: application/json
 *   body {countryCode, phoneNumber (no country code, no leading 0),
 *         callbackData (<= 512 chars, returned in webhooks), type: 'Template',
 *         template {name, languageCode (must match the template), headerValues
 *         (one media link for a media header), fileName (document header only),
 *         bodyValues (in order)}}
 *   response {result: true, message, id}: `id` is the message id the
 *   delivery-report webhooks refer to.
 * A file goes as a signed link to the private object valid 30 minutes, made
 * at send time (LD7); one WhatsApp message per file.
 *
 * INTERAKT_API_KEY comes from the Vercel environment. Never log the key, the
 * number or the values. Tests pass `fetchImpl`.
 */

const INTERAKT_ENDPOINT = 'https://api.interakt.ai/v1/public/message/';
const TIMEOUT_MS = 15_000;

export interface WhatsAppTemplateMessage {
  /** customer_messages.id: sent as callbackData. */
  messageId: string;
  /** 10-digit Indian mobile number. */
  phoneNumber: string;
  templateName: string;
  languageCode: 'en' | 'hi';
  bodyValues: readonly string[];
  /** One signed file link for a document-header template. */
  headerValues?: readonly string[];
  fileName?: string;
}

/** Any 2xx answer is sent (providerId null when the answer had no usable id), except an explicit `result: false`. */
export type WhatsAppSendResult =
  | { ok: true; providerId: string | null }
  | { ok: false; reason: 'not_configured' | 'rejected' | 'provider_error' | 'network' | 'unknown_outcome' | 'invalid_number' };

type FetchLike = (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export async function sendWhatsAppTemplate(
  message: WhatsAppTemplateMessage,
  opts: { apiKey?: string | undefined; fetchImpl?: FetchLike } = {},
): Promise<WhatsAppSendResult> {
  const apiKey = opts.apiKey ?? process.env.INTERAKT_API_KEY;
  if (!apiKey) return { ok: false, reason: 'not_configured' };
  const phone = message.phoneNumber.replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(phone)) return { ok: false, reason: 'invalid_number' };
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));

  const template: Record<string, unknown> = {
    name: message.templateName,
    languageCode: message.languageCode,
    bodyValues: [...message.bodyValues],
  };
  if (message.headerValues && message.headerValues.length > 0) {
    template.headerValues = [...message.headerValues];
    if (message.fileName) template.fileName = message.fileName;
  }

  let response: Pick<Response, 'ok' | 'status' | 'json'>;
  try {
    response = await doFetch(INTERAKT_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Basic ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        countryCode: '+91',
        phoneNumber: phone,
        callbackData: message.messageId,
        type: 'Template',
        template,
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
  // A 2xx answer means Interakt accepted the message: never resend it, even if the body is odd.
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const o = body && typeof body === 'object' ? (body as { result?: unknown; id?: unknown }) : null;
  if (o?.result === false) return { ok: false, reason: 'rejected' };
  return { ok: true, providerId: typeof o?.id === 'string' && o.id.length >= 1 && o.id.length <= 200 ? o.id : null };
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
