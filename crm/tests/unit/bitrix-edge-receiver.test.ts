import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  constantTimeEqual,
  createEdgeHandler,
  createPostgrestDeps,
  FixedWindowLimiter,
  handleBitrixEventEdge,
  MAX_EVENT_BODY_BYTES,
  MAX_TS_SKEW_SECONDS,
  isPublishableKey,
  RECEIVER_ENV_NAMES,
  resolvePublishableKey,
  type EdgeReceiverDeps,
} from '../../supabase/functions/bitrix-events/index';
import { FakeIntakeDb, syntheticEventFields, syntheticEventRequest, type SyntheticEventOptions } from '../helpers/mock-bitrix';

/**
 * Supabase Edge Function receiver (Phase 3.5 ingress, Phase 5 least-privilege
 * path). Same acceptance cases as the Vercel receiver (P2-01, P2-02, P2-03,
 * P2-10, P2-12, P2-13), exercised through the real PostgREST adapter against a
 * fake PostgREST that emulates public.integration_receive_bitrix_event
 * (receiver credential -> environment/portal -> FakeIntakeDb record). The SQL
 * itself is covered by tests/db/intake-production.test.ts. Synthetic data only.
 */

const TOKEN = 'synthetic-application-token-0123456789';
const MEMBER = 'synthetic-member-0001';
const DOMAIN = 'synthetic.bitrix24.example';
const SUPABASE_URL = 'https://synthetic-ref.supabase.example';
const PUBLISHABLE = 'sb_publishable_synthetic_receiver_key_0001';
const CREDENTIAL = 'synthetic-receiver-credential-0123456789abcdef';
const FN_URL = `${SUPABASE_URL}/functions/v1/bitrix-events`;
/** syntheticEventFields() default ts (seconds); the receiver clock is pinned to it. */
const EVENT_TS = 1759700000;
const NOW = () => EVENT_TS * 1000;
const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.synthetic-signature`;
const LEGACY_ANON = jwt('anon');
const LEGACY_SERVICE = jwt('service_role');

const row = (over: Record<string, unknown> = {}) => ({ portal_domain: DOMAIN, portal_member_id: MEMBER, enabled: true, ...over });

let db: FakeIntakeDb;
let configRows: unknown[];
let fetched: Array<{ url: string; headers: Record<string, string>; body: string | null }>;
let fakeFetch: typeof fetch;
let deps: EdgeReceiverDeps;

let activeCredentials: string[];
const pgError = (code: string, message: string) => new Response(JSON.stringify({ code, message }), { status: 400 });

/**
 * Minimal PostgREST stand-in for the anon role: ONLY the receiver RPC exists
 * (anon has no table grant). Emulates the SQL order: credential (28000), then
 * single enabled config (55000), then member_id AND domain (42501), then record.
 */
function makeFakePostgrest(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === 'string' ? init.body : null;
    fetched.push({ url, headers, body });
    const path = new URL(url).pathname;
    if (path !== '/rest/v1/rpc/integration_receive_bitrix_event') return new Response('{}', { status: 404 });
    const args = JSON.parse(body ?? '{}') as Record<string, unknown>;
    if (!activeCredentials.includes(String(args.p_credential))) return pgError('28000', 'receiver not authorized');
    const enabled = (configRows as Array<Record<string, unknown>>).filter((r) => r.enabled === true);
    if (enabled.length !== 1) return pgError('55000', 'intake is not configured');
    const cfg = enabled[0]!;
    const domain = String(args.p_domain ?? '').trim().toLowerCase().replace(/\.$/, '');
    if (args.p_member_id !== cfg.portal_member_id || domain !== cfg.portal_domain) {
      return pgError('42501', 'portal not recognised');
    }
    const { data, error } = await db.rpc('integration_record_bitrix_event', {
      p_member_id: args.p_member_id,
      p_event_type: args.p_event_type,
      p_deal_id: args.p_deal_id,
      p_source_ts: args.p_source_ts,
    });
    if (error) return pgError(String(error.code), String(error.message));
    return new Response(JSON.stringify(data), { status: 200 });
  }) as typeof fetch;
}

const adapter = (over: Partial<Parameters<typeof createPostgrestDeps>[0]> = {}) =>
  createPostgrestDeps({ supabaseUrl: SUPABASE_URL, publishableKey: PUBLISHABLE, receiverCredential: CREDENTIAL, fetchImpl: fakeFetch, ...over });

beforeEach(() => {
  db = new FakeIntakeDb();
  db.config.memberId = MEMBER;
  configRows = [row()];
  activeCredentials = [CREDENTIAL];
  fetched = [];
  fakeFetch = makeFakePostgrest();
  deps = { applicationToken: TOKEN, now: NOW, ...adapter() };
});

const send = (opts: SyntheticEventOptions = {}, d: EdgeReceiverDeps = deps) =>
  handleBitrixEventEdge(syntheticEventRequest(FN_URL, opts), d);
const recordCalls = () => db.calls.filter((c) => c.fn === 'integration_record_bitrix_event');

describe('accepted events', () => {
  it('records through the receiver RPC and answers 200 only after it returned', async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fetched).toHaveLength(1);
    expect(JSON.parse(fetched[0]!.body!)).toEqual({
      p_credential: CREDENTIAL,
      p_member_id: MEMBER,
      p_domain: DOMAIN,
      p_event_type: 'ONCRMDEALUPDATE',
      p_deal_id: 662,
      p_source_ts: 1759700000,
    });
    expect(recordCalls()).toEqual([
      {
        fn: 'integration_record_bitrix_event',
        args: { p_member_id: MEMBER, p_event_type: 'ONCRMDEALUPDATE', p_deal_id: 662, p_source_ts: 1759700000 },
      },
    ]);
    expect(db.inbox).toHaveLength(1);
    expect(db.deals.size).toBe(0);
  });

  it('P2-03: the same delivery twice -> one inbox row, both 200', async () => {
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(db.inbox).toHaveLength(1);
  });

  it('accepts ONCRMDEALADD in any case; the domain is normalised before the RPC', async () => {
    expect((await send({ event: 'onCrmDealAdd', domain: `${DOMAIN.toUpperCase()}.` })).status).toBe(200);
    expect(recordCalls()[0]!.args).toMatchObject({ p_event_type: 'ONCRMDEALADD', p_member_id: MEMBER });
    expect(JSON.parse(fetched[0]!.body!).p_domain).toBe(DOMAIN);
  });

  it('P2-12: never fetches caller endpoints; only the configured Supabase URL is contacted', async () => {
    await send({ extra: { 'auth[client_endpoint]': 'https://attacker.example/rest/', 'auth[access_token]': 'synthetic-oauth' } });
    expect(fetched.length).toBeGreaterThan(0);
    for (const f of fetched) expect(f.url.startsWith(`${SUPABASE_URL}/rest/v1/`)).toBe(true);
    expect(JSON.stringify(fetched)).not.toContain('attacker.example');
    expect(JSON.stringify(fetched)).not.toContain('synthetic-oauth');
  });

  it('sends a publishable key as apikey only; a legacy anon JWT also as Bearer', async () => {
    await send();
    expect(fetched[0]!.headers.apikey).toBe(PUBLISHABLE);
    expect(fetched[0]!.headers.authorization).toBeUndefined();

    fetched = [];
    await send({}, { applicationToken: TOKEN, now: NOW, ...adapter({ publishableKey: LEGACY_ANON }) });
    expect(fetched[0]!.headers.authorization).toBe(`Bearer ${LEGACY_ANON}`);
  });

  it('M3: refuses to be built with a secret key or a service_role JWT', () => {
    expect(() => adapter({ publishableKey: 'sb_secret_synthetic_key_0001' })).toThrow(/publishable/);
    expect(() => adapter({ publishableKey: LEGACY_SERVICE })).toThrow(/publishable/);
    expect(() => adapter({ publishableKey: 'not-a-key' })).toThrow(/publishable/);
    expect(isPublishableKey(PUBLISHABLE)).toBe(true);
    expect(isPublishableKey(LEGACY_ANON)).toBe(true);
  });
});

describe('P2-01 authentication: 401 before any database access', () => {
  it.each([
    ['wrong token', { applicationToken: 'synthetic-application-token-WRONG' }],
    ['token prefix', { applicationToken: TOKEN.slice(0, -1) }],
    ['token with suffix', { applicationToken: `${TOKEN}x` }],
    ['missing token', { extra: { 'auth[application_token]': undefined } }],
    ['missing member_id', { extra: { 'auth[member_id]': undefined } }],
    ['missing domain', { extra: { 'auth[domain]': undefined } }],
  ] as Array<[string, SyntheticEventOptions]>)('%s', async (_label, opts) => {
    const res = await send(opts);
    expect(res.status).toBe(401);
    expect(fetched).toHaveLength(0);
    expect(db.inbox).toHaveLength(0);
  });

  it.each([
    ['wrong member_id', { memberId: 'other-member' }],
    ['wrong domain', { domain: 'other.bitrix24.example' }],
  ] as Array<[string, SyntheticEventOptions]>)('%s with a valid token: 401, nothing stored', async (_label, opts) => {
    const res = await send(opts);
    expect(res.status).toBe(401);
    expect(recordCalls()).toHaveLength(0);
  });

  it('database refusal "portal not recognised" maps to 401', async () => {
    configRows = [row({ portal_member_id: 'a-different-member' })];
    expect((await send()).status).toBe(401);
    expect(db.inbox).toHaveLength(0);
  });

  it('receiver credential refused by the database (28000) maps to 503, nothing stored', async () => {
    activeCredentials = [];
    const res = await send();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'not_configured' });
    expect(db.inbox).toHaveLength(0);
  });
});

describe('P2-02 bounds and shape', () => {
  it('405 for non-POST', async () => {
    const res = await handleBitrixEventEdge(new Request(FN_URL, { method: 'GET' }), deps);
    expect(res.status).toBe(405);
  });

  it('413 on declared oversize without reading', async () => {
    const req = new Request(FN_URL, {
      method: 'POST',
      body: 'x=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(MAX_EVENT_BODY_BYTES + 1) },
    });
    expect((await handleBitrixEventEdge(req, deps)).status).toBe(413);
    expect(fetched).toHaveLength(0);
  });

  it('413 on streamed oversize', async () => {
    const big = new URLSearchParams({ ...syntheticEventFields(), pad: 'a'.repeat(2000) }).toString().repeat(10);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const req = new Request(FN_URL, {
      method: 'POST',
      body: stream,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      duplex: 'half',
    } as RequestInit);
    expect((await handleBitrixEventEdge(req, deps)).status).toBe(413);
  });

  it('408 when the body does not arrive within the deadline', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event=ONCRMDEALADD&'));
        // never closes: a slow-loris sender
      },
    });
    const req = new Request(FN_URL, {
      method: 'POST',
      body: stream,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      duplex: 'half',
    } as RequestInit);
    const res = await handleBitrixEventEdge(req, { ...deps, bodyTimeoutMs: 20 });
    expect(res.status).toBe(408);
    expect(await res.json()).toEqual({ error: 'request_timeout' });
    expect(fetched).toHaveLength(0);
  });

  it('accepts ts within +/-15 min of now and rejects it outside (400, nothing stored)', async () => {
    const at = (offset: number) => String(EVENT_TS + offset);
    expect((await send({ dealId: '1', ts: at(MAX_TS_SKEW_SECONDS) })).status).toBe(200);
    expect((await send({ dealId: '2', ts: at(-MAX_TS_SKEW_SECONDS) })).status).toBe(200);
    expect((await send({ dealId: '3', ts: at(MAX_TS_SKEW_SECONDS + 1) })).status).toBe(400);
    expect((await send({ dealId: '4', ts: at(-MAX_TS_SKEW_SECONDS - 1) })).status).toBe(400);
    expect(recordCalls().map((c) => c.args.p_deal_id)).toEqual([1, 2]);
  });

  it('400 for JSON content type', async () => {
    const req = new Request(FN_URL, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect((await handleBitrixEventEdge(req, deps)).status).toBe(400);
  });

  it('400 for duplicate keys (parameter pollution)', async () => {
    const body = `${new URLSearchParams(syntheticEventFields()).toString()}&data%5BFIELDS%5D%5BID%5D=663`;
    const req = new Request(FN_URL, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect((await handleBitrixEventEdge(req, deps)).status).toBe(400);
    expect(db.inbox).toHaveLength(0);
  });

  it('400 for more than 64 fields', async () => {
    const extra: Record<string, string> = {};
    for (let i = 0; i < 70; i += 1) extra[`k${i}`] = 'v';
    expect((await send({ extra })).status).toBe(400);
  });

  it.each([
    ['unknown event', { event: 'ONCRMCONTACTADD' }],
    ['zero deal id', { dealId: '0' }],
    ['non-numeric deal id', { dealId: '12a' }],
    ['huge deal id', { dealId: '99999999999999999' }],
    ['bad ts', { ts: '-1' }],
  ] as Array<[string, SyntheticEventOptions]>)('400 for %s (after authentication)', async (_label, opts) => {
    expect((await send(opts)).status).toBe(400);
    expect(recordCalls()).toHaveLength(0);
  });
});

describe('P2-10 not configured: 503, nothing stored', () => {
  it('no application token configured', async () => {
    expect((await send({}, { ...deps, applicationToken: null })).status).toBe(503);
    expect(fetched).toHaveLength(0);
  });

  it.each([
    ['no rows', []],
    ['disabled row', [row({ enabled: false })]],
    ['two enabled rows (ambiguous)', [row(), row({ portal_member_id: 'synthetic-member-0002', portal_domain: 'two.bitrix24.example' })]],
  ])('%s', async (_label, rows) => {
    configRows = rows;
    expect((await send()).status).toBe(503);
    expect(recordCalls()).toHaveLength(0);
  });

  it('environment unset refusal (55000) maps to 503', async () => {
    const d: EdgeReceiverDeps = {
      ...deps,
      recordEvent: async () => ({ ok: false, kind: 'refused' }),
    };
    expect((await send({}, d)).status).toBe(503);
  });

  it('identity capture: reports member_id only for a token-valid, fresh event from the exact domain while intake is refused', async () => {
    const seen: Array<{ domain: string; memberId: string }> = [];
    const refused: EdgeReceiverDeps = {
      ...deps,
      recordEvent: async () => ({ ok: false, kind: 'refused' }),
      identityCaptureDomain: DOMAIN.toUpperCase() + '.',
      onIdentityCapture: (identity) => seen.push(identity),
    };
    expect((await send({}, refused)).status).toBe(503);
    expect(seen).toEqual([{ domain: DOMAIN, memberId: MEMBER }]);

    seen.length = 0;
    expect((await send({ domain: 'other.bitrix24.example' }, refused)).status).toBe(503);
    expect((await send({ applicationToken: 'wrong-token-0123456789abcdef' }, refused)).status).toBe(401);
    expect((await send({ ts: String(EVENT_TS - 3600) }, refused)).status).toBe(400);
    expect((await send({ memberId: 'bad member id!' }, refused)).status).toBe(503);
    expect(seen).toEqual([]);

    // Not captured once intake accepts the event, or when the mode is off.
    expect((await send({}, { ...refused, recordEvent: async () => ({ ok: true }) })).status).toBe(200);
    expect((await send({}, { ...refused, identityCaptureDomain: null })).status).toBe(503);
    expect(seen).toEqual([]);
  });

  it('database unavailable maps to 503', async () => {
    const d: EdgeReceiverDeps = { ...deps, recordEvent: () => Promise.reject(new Error('down')) };
    expect((await send({}, d)).status).toBe(503);
  });
});

describe('budget, secrets and wiring', () => {
  it('budget is checked right after the token: an exhausted budget causes no database read', async () => {
    const recordEvent = vi.fn(deps.recordEvent);
    const d = { ...deps, recordEvent, limiter: new FixedWindowLimiter(0, 60_000, () => 0) };
    expect((await send({}, d)).status).toBe(429);
    expect(recordEvent).not.toHaveBeenCalled();
    expect(fetched).toHaveLength(0);
  });

  it('429 once the per-instance budget is used; unauthenticated calls do not consume it', async () => {
    let t = 0;
    const limiter = new FixedWindowLimiter(2, 60_000, () => t);
    const d = { ...deps, limiter };
    expect((await send({ applicationToken: 'wrong-token-wrong-token' }, d)).status).toBe(401);
    expect((await send({ dealId: '1' }, d)).status).toBe(200);
    expect((await send({ dealId: '2' }, d)).status).toBe(200);
    expect((await send({ dealId: '3' }, d)).status).toBe(429);
    t = 60_000;
    expect((await send({ dealId: '3' }, d)).status).toBe(200);
  });

  it('P2-13: responses and logs never contain the token, key, credential or member id', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const env: Record<string, string> = {
      SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }),
      INTAKE_RECEIVER_CREDENTIAL: CREDENTIAL,
      BITRIX_EVENT_APPLICATION_TOKEN: TOKEN,
    };
    const handler = createEdgeHandler((n) => env[n], fakeFetch);
    const texts: string[] = [];
    const ts = String(Math.floor(Date.now() / 1000));
    for (const opts of [{ ts }, { ts, applicationToken: 'bad-bad-bad-bad-bad' }, { ts, memberId: 'x' }] as SyntheticEventOptions[]) {
      const res = await handler(syntheticEventRequest(FN_URL, opts));
      texts.push(await res.text());
    }
    const out = texts.join('\n') + JSON.stringify(log.mock.calls);
    for (const secret of [TOKEN, PUBLISHABLE, CREDENTIAL, MEMBER]) expect(out).not.toContain(secret);
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])).status)).toEqual([200, 401, 401]);
    log.mockRestore();
  });

  it('createEdgeHandler without Supabase URL/key answers 503', async () => {
    const handler = createEdgeHandler(() => undefined, fakeFetch);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect((await handler(syntheticEventRequest(FN_URL))).status).toBe(503);
    expect(fetched).toHaveLength(0);
  });

  it('resolvePublishableKey prefers a named publishable key, falls back to the legacy anon key, never a secret', () => {
    const env = (vals: Record<string, string>) => (n: string) => vals[n];
    expect(
      resolvePublishableKey(
        env({ SUPABASE_PUBLISHABLE_KEYS: '{"default":"sb_publishable_a","intake":"sb_publishable_b"}', INTAKE_RECEIVER_PUBLISHABLE_KEY_NAME: 'intake' }),
      ),
    ).toBe('sb_publishable_b');
    expect(resolvePublishableKey(env({ SUPABASE_PUBLISHABLE_KEYS: '{"default":"sb_publishable_a"}' }))).toBe('sb_publishable_a');
    expect(resolvePublishableKey(env({ SUPABASE_PUBLISHABLE_KEYS: 'not json', SUPABASE_ANON_KEY: LEGACY_ANON }))).toBe(LEGACY_ANON);
    expect(resolvePublishableKey(env({ SUPABASE_PUBLISHABLE_KEYS: '{"default":"sb_secret_x"}' }))).toBeNull();
    expect(resolvePublishableKey(env({ SUPABASE_ANON_KEY: LEGACY_SERVICE }))).toBeNull();
    expect(resolvePublishableKey(env({}))).toBeNull();
  });

  it('M3: the handler never reads secret keys or the database URL from the environment', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const read: string[] = [];
    const env: Record<string, string> = {
      SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }),
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_must_not_be_read' }),
      SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE,
      SUPABASE_DB_URL: 'postgresql://synthetic',
      INTAKE_RECEIVER_CREDENTIAL: CREDENTIAL,
      BITRIX_EVENT_APPLICATION_TOKEN: TOKEN,
    };
    const handler = createEdgeHandler((n) => {
      read.push(n);
      return env[n];
    }, fakeFetch);
    const ts = String(Math.floor(Date.now() / 1000));
    expect((await handler(syntheticEventRequest(FN_URL, { ts }))).status).toBe(200);
    for (const name of new Set(read)) expect(RECEIVER_ENV_NAMES as readonly string[]).toContain(name);
    expect(read).not.toContain('SUPABASE_SECRET_KEYS');
    expect(read).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(read).not.toContain('SUPABASE_DB_URL');
    expect(JSON.stringify(fetched)).not.toContain('sb_secret_must_not_be_read');
  });

  it('createEdgeHandler without the receiver credential (or with a short one) answers 503 and makes no call', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const base: Record<string, string> = {
      SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }),
      BITRIX_EVENT_APPLICATION_TOKEN: TOKEN,
    };
    for (const extra of [{}, { INTAKE_RECEIVER_CREDENTIAL: 'short' }] as Array<Record<string, string>>) {
      const vals: Record<string, string> = { ...base, ...extra };
      const handler = createEdgeHandler((n) => vals[n], fakeFetch);
      expect((await handler(syntheticEventRequest(FN_URL))).status).toBe(503);
    }
    expect(fetched).toHaveLength(0);
  });

  it('constantTimeEqual compares exactly', async () => {
    expect(await constantTimeEqual('abc', 'abc')).toBe(true);
    expect(await constantTimeEqual('abc', 'abd')).toBe(false);
    expect(await constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(await constantTimeEqual('', '')).toBe(true);
  });
});
