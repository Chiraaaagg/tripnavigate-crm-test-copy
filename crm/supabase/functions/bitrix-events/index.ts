/**
 * Bitrix24 outbound-event receiver: Supabase Edge Function `bitrix-events`.
 * POST /functions/v1/bitrix-events
 *
 * NOT DEPLOYED. Deploy only after lead/owner approval
 * (docs/implementation/phase-5/intake-plan.md, pilot-runbook.md). JWT
 * verification is off (crm/supabase/config.toml): Bitrix cannot send a
 * Supabase JWT, so authentication is the application token plus the
 * configured portal. Required pre-deploy step:
 * `deno check supabase/functions/bitrix-events/index.ts`.
 *
 * Single self-contained module: the same file is the Deno entry (it calls
 * Deno.serve only when a Deno global exists) and the unit-tested module under
 * Node, so there is no cross-file `.ts` import and no Deno declaration.
 *
 * LEAST PRIVILEGE (Phase 5, security review M3). This public function talks to
 * the database ONLY through public.integration_receive_bitrix_event (migration
 * 20261006000100), using:
 *   - the project's PUBLISHABLE key (role anon; its only intake grant is
 *     EXECUTE on that one RPC), and
 *   - INTAKE_RECEIVER_CREDENTIAL, a dedicated random credential whose SHA-256
 *     digest the owner stores in public.integration_receiver_credentials.
 * The RPC checks the credential first, then environment and portal identity
 * (member_id AND domain against the single enabled config), then records the
 * event. The code path never reads SUPABASE_SECRET_KEYS,
 * SUPABASE_SERVICE_ROLE_KEY or SUPABASE_DB_URL (unit-tested). Residual risk:
 * the platform still injects those into every function's environment.
 *
 * Env (Edge Function secrets; SUPABASE_* are provided by the platform):
 *   BITRIX_EVENT_APPLICATION_TOKEN     outbound-webhook auth[application_token]
 *   INTAKE_RECEIVER_CREDENTIAL         receiver credential (32-256 chars)
 *   SUPABASE_URL                       platform
 *   SUPABASE_PUBLISHABLE_KEYS          platform JSON {name: sb_publishable_...}
 *                                      (legacy fallback: SUPABASE_ANON_KEY)
 *   INTAKE_RECEIVER_PUBLISHABLE_KEY_NAME optional; default 'default'
 *   INTAKE_RECEIVER_EVENTS_PER_MINUTE  optional; per-instance accepted-event budget
 *
 * Status contract (same as src/modules/integration/bitrix/receiver.ts plus 408/429):
 *   503  not configured (no token/credential/key, environment unset, no single
 *        enabled config, receiver credential refused, DB unavailable)
 *   405  not POST
 *   408  body not fully received within 5 s
 *   413  body > 16 KiB (declared or streamed)
 *   400  not form-urlencoded, malformed, > 64 fields, duplicate keys,
 *        unknown event, bad IDs, `ts` outside +/-15 min of now
 *        (accepted: ONCRMDEALADD/UPDATE and, Phase 6, ONCRMLEADADD/UPDATE)
 *   401  missing auth, wrong application_token (constant time, checked BEFORE
 *        any database call), member_id/domain not the configured portal
 *   429  per-instance budget for token-authenticated requests exhausted
 *   200  only after the insert/dedupe committed. Phase 6: a record outside the
 *        active manifest gets the same 200 body (the database stores it as
 *        `ignored / not_in_manifest`), so the response shape does not change.
 *
 * Portable: Web APIs only (Request, Response, crypto.subtle, TextDecoder,
 * fetch). Nothing from the request is echoed, logged or stored beyond the
 * bounded fields passed to the RPC. auth[client_endpoint]/server_endpoint and
 * OAuth tokens are ignored and never fetched.
 */

export const MAX_EVENT_BODY_BYTES = 16 * 1024;
export const MAX_EVENT_FIELDS = 64;
const MAX_KEY_LENGTH = 128;
const MAX_VALUE_LENGTH = 2048;
const MAX_AUTH_LENGTH = 256;
export const BODY_READ_TIMEOUT_MS = 5_000;
/** Accepted clock skew between the Bitrix event `ts` and this receiver. */
export const MAX_TS_SKEW_SECONDS = 15 * 60;
export const DEAL_EVENTS = ['ONCRMDEALADD', 'ONCRMDEALUPDATE'] as const;
export type DealEvent = (typeof DEAL_EVENTS)[number];
/** Phase 6: Lead events. The event type alone decides the source object. */
export const LEAD_EVENTS = ['ONCRMLEADADD', 'ONCRMLEADUPDATE'] as const;
export type LeadEvent = (typeof LEAD_EVENTS)[number];
export type SourceEvent = DealEvent | LeadEvent;
export type SourceObject = 'deal' | 'lead';

export type RecordOutcome =
  | { ok: true }
  | { ok: false; kind: 'wrong_portal' | 'refused' | 'receiver_refused' | 'invalid' | 'unavailable' };

export interface RecordArgs {
  memberId: string;
  domain: string;
  eventType: SourceEvent;
  sourceObject: SourceObject;
  /** Deal ID or Lead ID according to sourceObject. */
  sourceId: number;
  sourceTs: number;
}

export interface EdgeReceiverDeps {
  /** BITRIX_EVENT_APPLICATION_TOKEN (Edge Function secret). */
  applicationToken: string | null;
  /** integration_receive_bitrix_event (publishable key + receiver credential). */
  recordEvent: (args: RecordArgs) => Promise<RecordOutcome>;
  /** Budget for token-authenticated requests on this instance; omit to disable. */
  limiter?: FixedWindowLimiter;
  /** Clock (ms) for the `ts` freshness check; defaults to Date.now. */
  now?: () => number;
  /** Body read deadline; defaults to BODY_READ_TIMEOUT_MS. */
  bodyTimeoutMs?: number;
  /**
   * Identity capture (operator opt-in, INTAKE_IDENTITY_CAPTURE_DOMAIN). Only
   * while intake is still refused (no enabled config or environment unset),
   * and only for a request that passed the application-token check, carries a
   * fresh well-formed Lead/Deal event and names exactly this portal domain,
   * the receiver reports the portal member_id through `onIdentityCapture`.
   * The response is unchanged (503 not_configured) and nothing is stored.
   */
  identityCaptureDomain?: string | null;
  onIdentityCapture?: (identity: { domain: string; memberId: string }) => void;
}

const CAPTURE_MEMBER_ID = /^[A-Za-z0-9_-]{1,64}$/;

const HEADERS = { 'cache-control': 'no-store', 'content-type': 'application/json' } as const;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

// ---------------------------------------------------------------------------
// Constant-time comparison over SHA-256 digests (length does not short-circuit)

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([digest(a), digest(b)]);
  let diff = da.length ^ db.length;
  for (let i = 0; i < da.length; i += 1) diff |= da[i]! ^ db[i]!;
  return diff === 0 && a.length === b.length;
}

// ---------------------------------------------------------------------------
// Bounded body read and form parse

type BodyRead = { ok: true; text: string } | { ok: false; status: 400 | 408 | 413 };

const TIMED_OUT = Symbol('timed-out');

/** Reads at most `limit` bytes within `timeoutMs` (slow senders get 408). */
export async function readBoundedText(request: Request, limit: number, timeoutMs = BODY_READ_TIMEOUT_MS): Promise<BodyRead> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d{1,12}$/.test(declared)) return { ok: false, status: 400 };
    if (Number(declared) > limit) return { ok: false, status: 413 };
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400 };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === TIMED_OUT) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 408 };
      }
      const { done, value } = next;
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(all) };
  } catch {
    return { ok: false, status: 400 };
  }
}

/** Duplicate keys are rejected (no parameter pollution). */
export function parseFormBody(body: string): Map<string, string> | null {
  if (body.length === 0) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(body);
  } catch {
    return null;
  }
  const fields = new Map<string, string>();
  let count = 0;
  for (const [key, value] of params) {
    count += 1;
    if (count > MAX_EVENT_FIELDS) return null;
    if (key.length === 0 || key.length > MAX_KEY_LENGTH || value.length > MAX_VALUE_LENGTH) return null;
    if (fields.has(key)) return null;
    fields.set(key, value);
  }
  return fields;
}

function authValue(fields: Map<string, string>, key: string): string | null {
  const v = fields.get(key)?.trim();
  return v && v.length <= MAX_AUTH_LENGTH ? v : null;
}

/**
 * Deal (ONCRMDEAL*) or Lead (ONCRMLEAD*) event; anything else is null.
 * `nowMs` given: `ts` must be within MAX_TS_SKEW_SECONDS of it (limits replay of captured deliveries).
 */
export function readSourceEvent(
  fields: Map<string, string>,
  nowMs?: number,
): { event: SourceEvent; sourceObject: SourceObject; sourceId: number; ts: number } | null {
  const event = fields.get('event')?.trim().toUpperCase();
  const id = fields.get('data[FIELDS][ID]');
  const ts = fields.get('ts');
  if (!event) return null;
  const isDeal = (DEAL_EVENTS as readonly string[]).includes(event);
  const isLead = (LEAD_EVENTS as readonly string[]).includes(event);
  if (!isDeal && !isLead) return null;
  if (!id || !/^[1-9][0-9]{0,15}$/.test(id) || Number(id) > Number.MAX_SAFE_INTEGER) return null;
  if (!ts || !/^[0-9]{1,12}$/.test(ts)) return null;
  if (nowMs !== undefined && Math.abs(Number(ts) - Math.floor(nowMs / 1000)) > MAX_TS_SKEW_SECONDS) return null;
  return { event: event as SourceEvent, sourceObject: isLead ? 'lead' : 'deal', sourceId: Number(id), ts: Number(ts) };
}

/** Deal events only (Phase 2-5 shape). */
export function readDealEvent(fields: Map<string, string>, nowMs?: number): { event: DealEvent; dealId: number; ts: number } | null {
  const e = readSourceEvent(fields, nowMs);
  return e && e.sourceObject === 'deal' ? { event: e.event as DealEvent, dealId: e.sourceId, ts: e.ts } : null;
}

// ---------------------------------------------------------------------------
// Portal identity is checked IN THE DATABASE (integration_receive_bitrix_event,
// migration 20261006000100): member_id AND normalised domain must equal the
// single enabled integration_intake_config row. This function cannot read
// that table (publishable key, no grant).

export function normaliseDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

// ---------------------------------------------------------------------------
// Per-instance budget for TOKEN-AUTHENTICATED requests, taken right after the
// token check. Unauthenticated requests never reach the database, so they are
// not counted; the token is 32+ random characters, so guessing is not a
// practical threat. The budget bounds what a leaked token can make this
// instance read or write per minute; anything over it answers 429 and is
// repaired later by reconciliation. Per instance only (no shared state).

export class FixedWindowLimiter {
  private windowStart = 0;
  private count = 0;
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}
  take(): boolean {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) {
      this.windowStart = t;
      this.count = 0;
    }
    if (this.count >= this.limit) return false;
    this.count += 1;
    return true;
  }
}

export const DEFAULT_EVENTS_PER_MINUTE = 300;

// ---------------------------------------------------------------------------

export async function handleBitrixEventEdge(request: Request, deps: EdgeReceiverDeps): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const expected = deps.applicationToken;
  if (!expected || expected.length < 16) return json(503, { error: 'not_configured' });

  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('application/x-www-form-urlencoded')) return json(400, { error: 'invalid_request' });

  const body = await readBoundedText(request, MAX_EVENT_BODY_BYTES, deps.bodyTimeoutMs ?? BODY_READ_TIMEOUT_MS);
  if (!body.ok) {
    const error = body.status === 413 ? 'payload_too_large' : body.status === 408 ? 'request_timeout' : 'invalid_request';
    return json(body.status, { error });
  }
  const fields = parseFormBody(body.text);
  if (!fields) return json(400, { error: 'invalid_request' });

  // 1. Token first, before any database call.
  const token = authValue(fields, 'auth[application_token]');
  const memberId = authValue(fields, 'auth[member_id]');
  const domain = authValue(fields, 'auth[domain]');
  const tokenOk = await constantTimeEqual(token ?? '', expected);
  if (!token || !memberId || !domain || !tokenOk) return json(401, { error: 'unauthorized' });

  // Budget for token holders, before any database call (a leaked token cannot
  // turn into unbounded RPCs from this instance).
  if (deps.limiter && !deps.limiter.take()) return json(429, { error: 'rate_limited' });

  // 2. Strict event shape (Deal or Lead events only) and freshness.
  const event = readSourceEvent(fields, (deps.now ?? Date.now)());
  if (!event) return json(400, { error: 'invalid_request' });

  // 3. One RPC: receiver credential, environment, portal identity (member_id AND
  //    domain against configuration, never trusted from the caller), durable record.
  let outcome: RecordOutcome;
  try {
    outcome = await deps.recordEvent({
      memberId,
      domain: normaliseDomain(domain),
      eventType: event.event,
      sourceObject: event.sourceObject,
      sourceId: event.sourceId,
      sourceTs: event.ts,
    });
  } catch {
    return json(503, { error: 'unavailable' });
  }
  if (outcome.ok) return json(200, { ok: true });
  if (outcome.kind === 'wrong_portal') return json(401, { error: 'unauthorized' });
  if (outcome.kind === 'invalid') return json(400, { error: 'invalid_request' });
  if (outcome.kind === 'refused' || outcome.kind === 'receiver_refused') {
    const captureDomain = deps.identityCaptureDomain ? normaliseDomain(deps.identityCaptureDomain) : '';
    if (captureDomain && deps.onIdentityCapture && normaliseDomain(domain) === captureDomain && CAPTURE_MEMBER_ID.test(memberId)) {
      deps.onIdentityCapture({ domain: captureDomain, memberId });
    }
    return json(503, { error: 'not_configured' });
  }
  return json(503, { error: 'unavailable' });
}

// ---------------------------------------------------------------------------
// PostgREST adapter (publishable key) using plain fetch: no supabase-js import.

export interface PostgrestOptions {
  /** SUPABASE_URL of the project (https://<ref>.supabase.co). */
  supabaseUrl: string;
  /** Publishable key (sb_publishable_..., apikey header only) or the legacy anon JWT. */
  publishableKey: string;
  /** INTAKE_RECEIVER_CREDENTIAL. */
  receiverCredential: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Refuses anything that is not a low-privilege public key (fail closed on a pasted secret key). */
export function isPublishableKey(key: string): boolean {
  if (key.startsWith('sb_publishable_')) return true;
  if (key.startsWith('sb_secret_')) return false;
  // Legacy JWT: accept only role "anon".
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { role?: unknown };
    return payload.role === 'anon';
  } catch {
    return false;
  }
}

function authHeaders(key: string): Record<string, string> {
  // Publishable keys are not JWTs: apikey header only. Legacy anon JWT: both.
  return key.startsWith('sb_publishable_') ? { apikey: key } : { apikey: key, authorization: `Bearer ${key}` };
}

async function bounded(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
  } finally {
    clearTimeout(timer);
  }
}

export const MIN_RECEIVER_CREDENTIAL_LENGTH = 32;

export function createPostgrestDeps(options: PostgrestOptions): Pick<EdgeReceiverDeps, 'recordEvent'> {
  if (!isPublishableKey(options.publishableKey)) throw new Error('receiver key must be a publishable key');
  const base = options.supabaseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const headers = { ...authHeaders(options.publishableKey), accept: 'application/json' };

  return {
    async recordEvent(args) {
      const res = await bounded(
        fetchImpl,
        `${base}/rest/v1/rpc/integration_receive_bitrix_event`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            p_credential: options.receiverCredential,
            p_member_id: args.memberId,
            p_domain: args.domain,
            p_event_type: args.eventType,
            // Same RPC signature (migration 20261007000100): the database derives the
            // object from the event type and p_deal_id carries the Deal or Lead ID.
            p_deal_id: args.sourceId,
            p_source_ts: args.sourceTs,
          }),
        },
        timeoutMs,
      );
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (res.status === 200) {
        const b = body as { inboxId?: unknown; duplicate?: unknown } | null;
        if (b && typeof b.inboxId === 'string' && typeof b.duplicate === 'boolean') return { ok: true };
        return { ok: false, kind: 'unavailable' };
      }
      // PostgREST error body: {code, message, ...} (SQLSTATEs from migration 20261006000100).
      const e = (body ?? {}) as { code?: unknown; message?: unknown };
      const message = typeof e.message === 'string' ? e.message : '';
      if (e.code === '28000') return { ok: false, kind: 'receiver_refused' };
      if (e.code === '42501' && /portal not recognised/i.test(message)) return { ok: false, kind: 'wrong_portal' };
      if (e.code === '55000') return { ok: false, kind: 'refused' };
      if (e.code === '22023') return { ok: false, kind: 'invalid' };
      return { ok: false, kind: 'unavailable' };
    },
  };
}

/** Publishable key from Edge Function env values (pure; the entry passes Deno.env). Never a secret key. */
export function resolvePublishableKey(env: (name: string) => string | undefined): string | null {
  const name = env('INTAKE_RECEIVER_PUBLISHABLE_KEY_NAME')?.trim() || 'default';
  const keys = env('SUPABASE_PUBLISHABLE_KEYS');
  if (keys) {
    try {
      const parsed: unknown = JSON.parse(keys);
      const value = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[name] : undefined;
      if (typeof value === 'string' && value) return isPublishableKey(value) ? value : null;
    } catch {
      // fall through
    }
  }
  const legacy = env('SUPABASE_ANON_KEY')?.trim();
  return legacy && isPublishableKey(legacy) ? legacy : null;
}

/** Env names this function reads. Secret keys and the DB URL are deliberately absent. */
export const RECEIVER_ENV_NAMES = [
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEYS',
  'SUPABASE_ANON_KEY',
  'INTAKE_RECEIVER_PUBLISHABLE_KEY_NAME',
  'INTAKE_RECEIVER_CREDENTIAL',
  'INTAKE_RECEIVER_EVENTS_PER_MINUTE',
  'BITRIX_EVENT_APPLICATION_TOKEN',
  'INTAKE_IDENTITY_CAPTURE_DOMAIN',
] as const;

/** Builds the production handler from env accessors (pure; the entry passes Deno.env). */
export function createEdgeHandler(
  env: (name: string) => string | undefined,
  fetchImpl: typeof fetch = fetch,
): (request: Request) => Promise<Response> {
  const supabaseUrl = env('SUPABASE_URL')?.trim() ?? '';
  const publishableKey = resolvePublishableKey(env);
  const credential = env('INTAKE_RECEIVER_CREDENTIAL')?.trim() ?? '';
  const perMinute = Number(env('INTAKE_RECEIVER_EVENTS_PER_MINUTE') ?? DEFAULT_EVENTS_PER_MINUTE);
  const limiter = new FixedWindowLimiter(
    Number.isInteger(perMinute) && perMinute > 0 ? perMinute : DEFAULT_EVENTS_PER_MINUTE,
    60_000,
  );
  const db =
    supabaseUrl.startsWith('https://') && publishableKey && credential.length >= MIN_RECEIVER_CREDENTIAL_LENGTH
      ? createPostgrestDeps({ supabaseUrl, publishableKey, receiverCredential: credential, fetchImpl })
      : null;
  return async (request) => {
    const token = env('BITRIX_EVENT_APPLICATION_TOKEN')?.trim() || null;
    const identityCaptureDomain = env('INTAKE_IDENTITY_CAPTURE_DOMAIN')?.trim() || null;
    const response = db
      ? await handleBitrixEventEdge(request, {
          applicationToken: token,
          ...db,
          limiter,
          identityCaptureDomain,
          // Function logs are private to the company-owned project. Remove
          // INTAKE_IDENTITY_CAPTURE_DOMAIN after the operator records the ID.
          onIdentityCapture: (identity) =>
            console.log(JSON.stringify({ fn: 'bitrix-events', identityCapture: identity })),
        })
      : json(503, { error: 'not_configured' });
    // Fixed outcome code only: never request content.
    console.log(JSON.stringify({ fn: 'bitrix-events', status: response.status }));
    return response;
  };
}

// ---------------------------------------------------------------------------
// Deno entry. Under Node (unit tests) there is no Deno global and nothing runs.

interface DenoLike {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): unknown;
}

const deno = (globalThis as { Deno?: DenoLike }).Deno;
if (deno && typeof deno.serve === 'function') {
  deno.serve(createEdgeHandler((name) => deno.env.get(name)));
}
