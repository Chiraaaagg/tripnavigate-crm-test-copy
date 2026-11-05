import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBitrixEvent, type ReceiverDeps } from '@/modules/integration/bitrix/receiver';
import { asRpcClient } from '@/modules/integration/commands';
import { FakeIntakeDb } from '../helpers/mock-bitrix';

/**
 * Event receiver (contract §1/§6): P2-01 auth, P2-02 bounds, P2-03 duplicate
 * delivery (receiver level), P2-12 caller endpoints ignored, P2-13 no secrets out.
 */

const TOKEN = 'synthetic-application-token-0123456789';
const MEMBER = 'synthetic-member-0001';
const DOMAIN = 'synthetic.bitrix24.example';
const URL_ = 'https://crm.example.test/api/integrations/bitrix/events';

const configRow = (over: Record<string, unknown> = {}) => ({
  portal_domain: DOMAIN,
  portal_member_id: MEMBER,
  category_id: '7',
  eligible_stage_ids: ['C7:WON'],
  cutoff_at: '2026-10-01T00:00:00+05:30',
  pilot_legal_entity_id: null,
  pilot_branch_id: null,
  enabled: true,
  ...over,
});

let db: FakeIntakeDb;
let loadConfigRows: ReturnType<typeof vi.fn<() => Promise<unknown[]>>>;
let deps: ReceiverDeps;
const fetchSpy = vi.fn();

beforeEach(() => {
  db = new FakeIntakeDb();
  db.config.memberId = MEMBER;
  loadConfigRows = vi.fn(async () => [configRow()]);
  deps = {
    env: { bitrixEventApplicationToken: TOKEN, bitrixWebhookBaseUrl: null, intakeWorkerSecret: null, cronSecret: null },
    loadConfigRows,
    rpc: () => asRpcClient({ rpc: db.rpc }),
  };
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
});

function fields(over: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string | undefined> = {
    event: 'ONCRMDEALUPDATE',
    event_handler_id: '185',
    'data[FIELDS][ID]': '662',
    ts: '1759700000',
    'auth[domain]': DOMAIN,
    'auth[member_id]': MEMBER,
    'auth[application_token]': TOKEN,
    ...over,
  };
  return Object.fromEntries(Object.entries(base).filter((e): e is [string, string] => e[1] !== undefined));
}

function post(body: string | Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(URL_, {
    method: 'POST',
    body: typeof body === 'string' ? body : new URLSearchParams(body).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  });
}

const recordCalls = () => db.calls.filter((c) => c.fn === 'integration_record_bitrix_event');

describe('accepted events', () => {
  it('records the event and answers 200 only after the command returned', async () => {
    const res = await handleBitrixEvent(post(fields()), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(recordCalls()).toEqual([
      {
        fn: 'integration_record_bitrix_event',
        args: { p_member_id: MEMBER, p_event_type: 'ONCRMDEALUPDATE', p_deal_id: 662, p_source_ts: 1759700000 },
      },
    ]);
    expect(db.inbox).toHaveLength(1);
    expect(db.deals.size).toBe(0); // never processed inline
  });

  it('P2-03: the same delivery twice -> one inbox row, both acknowledged', async () => {
    expect((await handleBitrixEvent(post(fields()), deps)).status).toBe(200);
    expect((await handleBitrixEvent(post(fields()), deps)).status).toBe(200);
    expect(recordCalls()).toHaveLength(2);
    expect(db.inbox).toHaveLength(1);
  });

  it('accepts ONCRMDEALADD and lower-case event names', async () => {
    expect((await handleBitrixEvent(post(fields({ event: 'onCrmDealAdd' })), deps)).status).toBe(200);
    expect(recordCalls()[0]!.args.p_event_type).toBe('ONCRMDEALADD');
  });

  it('P2-12: caller-supplied client_endpoint/server_endpoint are ignored and never fetched', async () => {
    const res = await handleBitrixEvent(
      post(
        fields({
          'auth[client_endpoint]': 'https://attacker.example/rest/',
          'auth[server_endpoint]': 'https://attacker.example/oauth/',
          'auth[access_token]': 'synthetic-oauth-access',
        }),
      ),
      deps,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(db.calls)).not.toContain('attacker.example');
    expect(JSON.stringify(db.calls)).not.toContain('synthetic-oauth-access');
  });

  it('portal identity sent to the database comes from configuration, not the caller', async () => {
    await handleBitrixEvent(post(fields({ 'auth[domain]': DOMAIN.toUpperCase() })), deps);
    expect(recordCalls()[0]!.args.p_member_id).toBe(MEMBER);
  });
});

describe('P2-01 authentication: 401, nothing stored', () => {
  it.each([
    ['wrong token', { 'auth[application_token]': 'synthetic-application-token-WRONG' }],
    ['token prefix', { 'auth[application_token]': TOKEN.slice(0, -1) }],
    ['token with suffix', { 'auth[application_token]': `${TOKEN}x` }],
    ['missing token', { 'auth[application_token]': undefined }],
    ['missing member_id', { 'auth[member_id]': undefined }],
    ['missing domain', { 'auth[domain]': undefined }],
    ['no auth at all', { 'auth[application_token]': undefined, 'auth[member_id]': undefined, 'auth[domain]': undefined }],
  ])('%s', async (_label, over) => {
    const res = await handleBitrixEvent(post(fields(over)), deps);
    expect(res.status).toBe(401);
    expect(recordCalls()).toHaveLength(0);
    // Unauthenticated callers cause no database read at all.
    expect(loadConfigRows).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong member_id', { 'auth[member_id]': 'other-member' }],
    ['wrong domain', { 'auth[domain]': 'other.bitrix24.example' }],
  ])('%s with a valid token', async (_label, over) => {
    const res = await handleBitrixEvent(post(fields(over)), deps);
    expect(res.status).toBe(401);
    expect(recordCalls()).toHaveLength(0);
    expect(db.inbox).toHaveLength(0);
  });

  it('a database-side wrong_portal refusal is also 401', async () => {
    db.config.memberId = 'db-side-different';
    const res = await handleBitrixEvent(post(fields()), deps);
    expect(res.status).toBe(401);
    expect(db.inbox).toHaveLength(0);
  });
});

describe('P2-02 bounds: 413/400, nothing stored', () => {
  it('declared Content-Length over 16 KiB -> 413', async () => {
    const res = await handleBitrixEvent(post(fields(), { 'content-length': String(16 * 1024 + 1) }), deps);
    expect(res.status).toBe(413);
    expect(recordCalls()).toHaveLength(0);
  });

  it('streamed body over 16 KiB without Content-Length -> 413', async () => {
    const big = `${new URLSearchParams(fields()).toString()}&pad=${'a'.repeat(17 * 1024)}`;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const req = new Request(URL_, {
      method: 'POST',
      body: stream,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      duplex: 'half',
    } as RequestInit);
    expect((await handleBitrixEvent(req, deps)).status).toBe(413);
    expect(recordCalls()).toHaveLength(0);
  });

  it.each([
    ['JSON content type', () => post(JSON.stringify(fields()), { 'content-type': 'application/json' })],
    ['empty body', () => post('')],
    ['more than 64 fields', () => post({ ...fields(), ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`x${i}`, '1'])) })],
    ['duplicate keys', () => post(`${new URLSearchParams(fields()).toString()}&data%5BFIELDS%5D%5BID%5D=663`)],
    ['over-long value', () => post({ ...fields(), extra: 'v'.repeat(3000) })],
    ['invalid UTF-8', () => new Request(URL_, { method: 'POST', body: new Uint8Array([0x65, 0x3d, 0xff, 0xfe]), headers: { 'content-type': 'application/x-www-form-urlencoded' } })],
  ])('%s -> 400', async (_label, make) => {
    expect((await handleBitrixEvent(make(), deps)).status).toBe(400);
    expect(recordCalls()).toHaveLength(0);
  });

  it.each([
    ['unknown event', { event: 'ONCRMDEALDELETE' }],
    ['lead delete event', { event: 'ONCRMLEADDELETE' }],
    ['contact event', { event: 'ONCRMCONTACTADD' }],
    ['non-numeric deal id', { 'data[FIELDS][ID]': '66a' }],
    ['negative deal id', { 'data[FIELDS][ID]': '-1' }],
    ['zero deal id', { 'data[FIELDS][ID]': '0' }],
    ['huge deal id', { 'data[FIELDS][ID]': '99999999999999999' }],
    ['missing deal id', { 'data[FIELDS][ID]': undefined }],
    ['non-numeric ts', { ts: 'yesterday' }],
    ['missing event', { event: undefined }],
  ])('authenticated but %s -> 400', async (_label, over) => {
    expect((await handleBitrixEvent(post(fields(over)), deps)).status).toBe(400);
    expect(recordCalls()).toHaveLength(0);
  });
});

describe('not configured / unavailable: 503', () => {
  it('no application token configured', async () => {
    deps.env = { ...deps.env, bitrixEventApplicationToken: null };
    expect((await handleBitrixEvent(post(fields()), deps)).status).toBe(503);
  });
  it.each([
    ['no config row', []],
    ['config disabled', [configRow({ enabled: false })]],
    ['two enabled portals', [configRow(), configRow({ portal_member_id: 'other' })]],
  ])('%s', async (_label, rows) => {
    loadConfigRows.mockResolvedValue(rows);
    expect((await handleBitrixEvent(post(fields()), deps)).status).toBe(503);
    expect(recordCalls()).toHaveLength(0);
  });
  it('database refusal (environment unset) -> 503, not 200', async () => {
    deps.rpc = () => ({ rpc: async () => ({ data: null, error: { code: '55000', message: 'intake is not configured (environment unset)' } }) });
    expect((await handleBitrixEvent(post(fields()), deps)).status).toBe(503);
  });
  it('database outage -> 503 so Bitrix can redeliver', async () => {
    deps.rpc = () => ({ rpc: async () => ({ data: null, error: { code: '08006', message: 'connection failure' } }) });
    expect((await handleBitrixEvent(post(fields()), deps)).status).toBe(503);
    loadConfigRows.mockRejectedValue(new Error('down'));
    expect((await handleBitrixEvent(post(fields()), deps)).status).toBe(503);
  });
  it('unexpected command answer is not acknowledged', async () => {
    deps.rpc = () => ({ rpc: async () => ({ data: { weird: true }, error: null }) });
    expect((await handleBitrixEvent(post(fields()), deps)).status).toBe(503);
  });
});

describe('P2-13: no secrets in responses or logs', () => {
  it('responses never echo the token or input, and nothing is logged', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
    const bodies: string[] = [];
    for (const over of [{}, { 'auth[application_token]': 'nope' }, { event: 'X' }, { 'auth[member_id]': 'x' }]) {
      const res = await handleBitrixEvent(post(fields(over)), deps);
      bodies.push(await res.text());
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    for (const body of bodies) {
      expect(body).not.toContain(TOKEN);
      expect(body).not.toContain(MEMBER);
      expect(body.length).toBeLessThan(40);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(db.inbox)).not.toContain(TOKEN);
    spies.forEach((s) => s.mockRestore());
  });
});
