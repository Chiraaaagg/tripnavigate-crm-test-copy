import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient, type RpcClient } from '@/modules/fulfilment/commands';

/**
 * Delivery reports and STOP / START (contract 5.8). Machine routes outside
 * the staff proxy: read the raw body (at most 64 KiB), verify the signature
 * BEFORE parsing, constant-time compare, then call the worker command
 * customer_message_event_record under the service role. A bad or missing
 * signature answers 401 and stores nothing. Inbound text is classified here
 * and dropped: only the kind is stored, never the text or the address.
 *
 * Resend signs with Svix: headers svix-id, svix-timestamp, svix-signature
 * ("v1,<base64>" entries), HMAC-SHA256 over "<id>.<timestamp>.<body>" keyed by
 * the base64 part of RESEND_WEBHOOK_SECRET ("whsec_..."), 5-minute tolerance.
 * Interakt (read 13 November 2026, interakt.shop webhook guide): header
 * "Interakt-Signature: sha256=<hex HMAC-SHA256 of the raw body>" keyed by the
 * shared secret (INTERAKT_WEBHOOK_SECRET). Event types used: message_api_sent,
 * message_api_delivered, message_api_read, message_api_failed,
 * message_received; paths data.message.id, data.message.meta_data.source_data
 * .callback_data, data.message.channel_error_code, data.message.message,
 * data.customer.channel_phone_number (with ISD code). Interakt sends no event
 * id, so the event id is "<type>:<message id>".
 */

export const MAX_WEBHOOK_BYTES = 64 * 1024;
const TOLERANCE_SECONDS = 300;

export type EventKind = 'sent' | 'delivered' | 'read' | 'failed' | 'bounced' | 'complained' | 'inbound_stop' | 'inbound_start' | 'inbound_other';

export interface ProviderEvent {
  provider: 'resend' | 'interakt';
  providerEventId: string;
  messageRef: string | null;
  kind: EventKind;
  errorCode: string | null;
  mobile: string | null;
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Svix signature check (Resend). `nowSeconds` for tests. */
export function verifyResendSignature(
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  rawBody: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false;
  if (!/^\d{1,12}$/.test(headers.timestamp)) return false;
  const ts = Number(headers.timestamp);
  if (Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return false;
  const keyText = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(keyText, 'base64');
  } catch {
    return false;
  }
  if (key.length === 0) return false;
  const expected = createHmac('sha256', key).update(`${headers.id}.${headers.timestamp}.${rawBody}`).digest();
  let ok = false;
  for (const part of headers.signature.split(' ')) {
    const [version, sig] = part.split(',', 2);
    if (version !== 'v1' || !sig) continue;
    const given = Buffer.from(sig, 'base64');
    if (safeEqual(given, expected)) ok = true;
  }
  return ok;
}

/** Interakt HMAC-SHA256 (hex) of the raw body; accepts "sha256=<hex>" or "<hex>". */
export function verifyInteraktSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!secret || typeof header !== 'string') return false;
  const hex = header.trim().replace(/^sha256=/i, '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return safeEqual(Buffer.from(hex, 'hex'), expected);
}

const STOP = /^\s*(stop|unsubscribe|बंद|बंद करें)\s*$/iu;
const START = /^\s*(start|शुरू)\s*$/iu;

/** STOP / START classifier for an inbound WhatsApp text (the text itself is dropped). */
export function classifyInbound(text: string | null | undefined): 'inbound_stop' | 'inbound_start' | 'inbound_other' {
  const t = text ?? '';
  if (STOP.test(t)) return 'inbound_stop';
  if (START.test(t)) return 'inbound_start';
  return 'inbound_other';
}

/** 10-digit Indian mobile from "916000012345", "+91 60000 12345" or "6000012345". */
export function normaliseMobile(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits = String(value).replace(/\D/g, '');
  const ten = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits.length === 10 ? digits : null;
  return ten && /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

const get = (o: unknown, path: string[]): unknown =>
  path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length >= 1 && v.length <= max ? v : null);

const RESEND_KINDS: Readonly<Record<string, EventKind>> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.opened': 'read',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
};

/** A Resend event (null = a type we do not record). */
export function parseResendEvent(eventId: string, payload: unknown): ProviderEvent | null {
  const kind = RESEND_KINDS[String(get(payload, ['type']) ?? '')];
  if (!kind) return null;
  return {
    provider: 'resend',
    providerEventId: eventId.slice(0, 200),
    messageRef: str(get(payload, ['data', 'email_id'])),
    kind,
    errorCode: kind === 'bounced' ? 'bounced' : kind === 'failed' ? 'provider_error' : null,
    mobile: null,
  };
}

const INTERAKT_KINDS: Readonly<Record<string, EventKind>> = {
  message_api_sent: 'sent',
  message_api_delivered: 'delivered',
  message_api_read: 'read',
  message_api_failed: 'failed',
};
/** Meta error codes that mean the number cannot receive WhatsApp. */
const INVALID_NUMBER_CODES = new Set(['131026', '1013']);

/** An Interakt event (null = a type we do not record). */
export function parseInteraktEvent(payload: unknown): ProviderEvent | null {
  const type = String(get(payload, ['type']) ?? '');
  const providerMessageId = str(get(payload, ['data', 'message', 'id']), 150);
  if (!providerMessageId) return null;
  if (type === 'message_received') {
    const text = get(payload, ['data', 'message', 'message']);
    return {
      provider: 'interakt',
      providerEventId: `${type}:${providerMessageId}`,
      messageRef: null,
      kind: classifyInbound(typeof text === 'string' ? text : ''),
      errorCode: null,
      mobile: normaliseMobile(get(payload, ['data', 'customer', 'channel_phone_number']))
        ?? normaliseMobile(get(payload, ['data', 'customer', 'phone_number'])),
    };
  }
  const kind = INTERAKT_KINDS[type];
  if (!kind) return null;
  const callback = str(get(payload, ['data', 'message', 'meta_data', 'source_data', 'callback_data']), 512);
  const errorRaw = get(payload, ['data', 'message', 'channel_error_code']);
  return {
    provider: 'interakt',
    providerEventId: `${type}:${providerMessageId}`,
    messageRef: callback && /^[0-9a-f-]{36}$/i.test(callback) ? callback : providerMessageId,
    kind,
    errorCode: kind === 'failed' ? (INVALID_NUMBER_CODES.has(String(errorRaw ?? '')) ? 'invalid_number' : 'provider_error') : null,
    mobile: null,
  };
}

export interface WebhookDeps {
  secret: string | undefined;
  record(event: ProviderEvent): Promise<void>;
  nowSeconds?: number;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

async function rawBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return null;
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_WEBHOOK_BYTES) return null;
  return new TextDecoder().decode(buf);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function handleResendWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  if (!deps.secret) return json(503, { status: 'not_configured' });
  const body = await rawBody(request);
  if (body === null) return json(413, { status: 'too_large' });
  const headers = {
    id: request.headers.get('svix-id'),
    timestamp: request.headers.get('svix-timestamp'),
    signature: request.headers.get('svix-signature'),
  };
  if (!verifyResendSignature(headers, body, deps.secret, deps.nowSeconds)) return json(401, { status: 'unauthorized' });
  const payload = parseJson(body);
  if (payload === undefined) return json(400, { status: 'bad_request' });
  const event = parseResendEvent(headers.id!, payload);
  if (!event) return json(200, { status: 'ignored' });
  await deps.record(event);
  return json(200, { status: 'recorded' });
}

export async function handleInteraktWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  if (!deps.secret) return json(503, { status: 'not_configured' });
  const body = await rawBody(request);
  if (body === null) return json(413, { status: 'too_large' });
  if (!verifyInteraktSignature(body, request.headers.get('interakt-signature'), deps.secret)) return json(401, { status: 'unauthorized' });
  const payload = parseJson(body);
  if (payload === undefined) return json(400, { status: 'bad_request' });
  const event = parseInteraktEvent(payload);
  if (!event || ((event.kind === 'inbound_stop' || event.kind === 'inbound_start') && !event.mobile)) {
    return json(200, { status: 'ignored' });
  }
  await deps.record(event);
  return json(200, { status: 'recorded' });
}

/** Records one event under the service role (after the signature check only). */
export async function recordProviderEvent(rpc: RpcClient, event: ProviderEvent): Promise<void> {
  const { error } = await rpc.rpc('customer_message_event_record', {
    p_provider: event.provider,
    p_provider_event_id: event.providerEventId,
    p_message_ref: event.messageRef,
    p_kind: event.kind,
    p_error_code: event.errorCode,
    p_mobile: event.mobile,
  });
  if (error) throw new Error(`customer_message_event_record failed${error.code ? ` (${error.code})` : ''}`);
}

export function productionWebhookDeps(provider: 'resend' | 'interakt'): WebhookDeps {
  return {
    secret: provider === 'resend' ? process.env.RESEND_WEBHOOK_SECRET : process.env.INTERAKT_WEBHOOK_SECRET,
    record: (event) => recordProviderEvent(asRpcClient(createSupabaseAdminClient()), event),
  };
}
