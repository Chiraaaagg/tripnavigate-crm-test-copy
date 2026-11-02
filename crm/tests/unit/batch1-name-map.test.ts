import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBitrixNameRefresh } from '@/modules/integration/bitrix/name-refresh';
import { handleWorkerRequest, type WorkerEndpointDeps } from '@/modules/integration/bitrix/worker-endpoint';
import { asRpcClient, type RpcClient } from '@/modules/integration/commands';
import { INTAKE_CONFIG_COLUMNS, parseIntakeConfigRow, selectIntakeConfig } from '@/modules/integration/intake-config';
import { cleanBitrixName, parseStatusList, stageEntityForPipeline, toBitrixNameMapView } from '@/modules/integration/name-map';
import { readBitrixNameMap, setBitrixNameRead } from '@/modules/integration/server/name-map';
import { FakeIntakeDb, startMockBitrix, syntheticDeal, type MockBitrix } from '../helpers/mock-bitrix';

/**
 * Direction A Batch 1 B1-1: Bitrix name map, application side. Parsing keeps
 * only STATUS_ID, NAME, SORT and SEMANTICS; the worker reads names only while
 * the switch is on and only when the database says a read is due; a list cut
 * short is never applied; the staff read never reports a failure as "off".
 * Mock Bitrix and fake command layers only.
 */

describe('parsing Bitrix status lists', () => {
  it('keeps only code, name, sort and kind; drops bad codes, empty names and duplicates', () => {
    const raw = [
      { ID: '1', ENTITY_ID: 'DEAL_STAGE_7', STATUS_ID: 'C7:NEW', NAME: ' New\u0007 ', SORT: '10', SEMANTICS: null, COLOR: '#fff', EXTRA: { phone: '+1' } },
      { STATUS_ID: 'C7:WON', NAME: 'Won <b>deal</b>', SORT: 20, SEMANTICS: 'S' },
      { STATUS_ID: 'C7:LOSE', NAME: 'Lost', SORT: 30, SEMANTICS: 'F' },
      { STATUS_ID: 'bad code!', NAME: 'x' },
      { STATUS_ID: 'C7:EMPTY', NAME: '  \u0001 ' },
      { STATUS_ID: 'C7:NEW', NAME: 'Duplicate' },
      null,
      'text',
    ];
    expect(parseStatusList('DEAL_STAGE_7', raw)).toEqual([
      { code: 'C7:NEW', name: 'New', sort: 10, kind: 'open' },
      { code: 'C7:WON', name: 'Won <b>deal</b>', sort: 20, kind: 'won' },
      { code: 'C7:LOSE', name: 'Lost', sort: 30, kind: 'lost' },
    ]);
    // kind is for stage lists only.
    expect(parseStatusList('SOURCE', [{ STATUS_ID: 'WEB', NAME: 'Website', SORT: 'x', SEMANTICS: 'S' }])).toEqual([
      { code: 'WEB', name: 'Website', sort: 0, kind: null },
    ]);
    expect(parseStatusList('STATUS', { not: 'a list' })).toEqual([]);
  });

  it('bounds names to 120 characters and maps pipelines to list ids', () => {
    expect(cleanBitrixName('x'.repeat(300))).toHaveLength(120);
    expect(cleanBitrixName(42)).toBe('42');
    expect(cleanBitrixName({})).toBeNull();
    expect(stageEntityForPipeline(0)).toBe('DEAL_STAGE');
    expect(stageEntityForPipeline(7)).toBe('DEAL_STAGE_7');
  });
});

describe('staff read view', () => {
  const NAMES = [{ entityId: 'STATUS', code: 'NEW', name: 'Fresh', kind: null, missing: false, extra: 'dropped' }];

  it('enabled:false is switched_off; malformed is list_unreadable; extra keys are dropped', () => {
    expect(toBitrixNameMapView({ enabled: false, readAt: null, names: [] })).toEqual({ state: 'switched_off' });
    expect(toBitrixNameMapView({ enabled: true })).toEqual({ state: 'list_unreadable' });
    expect(toBitrixNameMapView(null)).toEqual({ state: 'list_unreadable' });
    expect(toBitrixNameMapView({ enabled: true, readAt: '2026-10-19T00:00:00Z', names: NAMES })).toEqual({
      state: 'on', readAt: '2026-10-19T00:00:00Z', names: [{ entityId: 'STATUS', code: 'NEW', name: 'Fresh', kind: null, missing: false }],
    });
  });

  it('a failed read is never "off"; a missing function is not_installed', async () => {
    const client = (reply: { data: unknown; error: { code?: string } | null } | Error): RpcClient => ({
      rpc: async () => {
        if (reply instanceof Error) throw reply;
        return reply;
      },
    });
    expect(await readBitrixNameMap(client({ data: null, error: { code: 'PGRST202' } }))).toEqual({ state: 'not_installed' });
    expect(await readBitrixNameMap(client({ data: null, error: { code: '42883' } }))).toEqual({ state: 'not_installed' });
    expect(await readBitrixNameMap(client({ data: null, error: { code: '42501' } }))).toEqual({ state: 'list_unreadable' });
    expect(await readBitrixNameMap(client(new Error('network')))).toEqual({ state: 'list_unreadable' });
    expect(await readBitrixNameMap(client({ data: { enabled: true, readAt: null, names: NAMES }, error: null }))).toMatchObject({ state: 'on' });
  });

  it('the switch command maps refusals to fixed codes', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const client = (error: { code?: string } | null, data: unknown = { changed: true, enabled: true }): RpcClient => ({
      rpc: async (fn, args) => {
        calls.push([fn, args]);
        return { data: error ? null : data, error };
      },
    });
    expect(await setBitrixNameRead(client(null), true, 'Owner APPROVE reason')).toEqual({ ok: true, result: { changed: true, enabled: true } });
    expect(calls[0]).toEqual(['integration_set_bitrix_name_read', { p_enabled: true, p_reason: 'Owner APPROVE reason' }]);
    expect(await setBitrixNameRead(client({ code: '42501' }), true, 'r')).toEqual({ ok: false, code: 'not_authorized' });
    expect(await setBitrixNameRead(client({ code: '22023' }), true, 'r')).toEqual({ ok: false, code: 'reason_required' });
    expect(await setBitrixNameRead(client({ code: '55000' }), true, 'r')).toEqual({ ok: false, code: 'not_configured' });
    expect(await setBitrixNameRead(client({ code: 'PGRST202' }), true, 'r')).toEqual({ ok: false, code: 'not_installed' });
    expect(await setBitrixNameRead(client(null, { odd: 1 }), true, 'r')).toEqual({ ok: false, code: 'failed' });
  });
});

/** A fake of the two service-role commands. */
function namesDb(due: unknown) {
  const calls: Array<{ fn: string; args: Record<string, unknown> | undefined }> = [];
  const rpc: RpcClient = {
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      if (fn === 'integration_bitrix_names_due') return { data: due, error: null };
      if (fn === 'integration_apply_bitrix_names') {
        const lists = (args?.p_lists ?? []) as unknown[];
        return { data: { applied: true, lists: lists.length, added: 2, renamed: 0, missing: 0, restored: 0, dropped: 0 }, error: null };
      }
      throw new Error(`unexpected ${fn}`);
    },
  };
  return { rpc, calls };
}

/** A fake Bitrix caller answering crm.status.list per list id (pages of the given answers). */
function fakeBitrix(pages: Record<string, Array<{ result: unknown; next: number | null }> | Error>) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    requests.push({ method, params });
    const entity = (params.filter as { ENTITY_ID: string }).ENTITY_ID;
    const answer = pages[entity];
    if (answer instanceof Error) throw answer;
    const start = Number(params.start ?? 0);
    const page = answer?.[start === 0 ? 0 : Math.round(start / 50)] ?? { result: [], next: null };
    return { result: page.result, next: page.next, total: null };
  });
  return { bitrix: { call: call as never }, requests };
}

const STAGES7 = [{ STATUS_ID: 'C7:NEW', NAME: 'New', SORT: 10 }, { STATUS_ID: 'C7:WON', NAME: 'Won', SORT: 20, SEMANTICS: 'S' }];

describe('runBitrixNameRefresh', () => {
  it('not due: no Bitrix call at all', async () => {
    for (const reason of ['switched_off', 'fresh', 'recently_attempted'] as const) {
      const db = namesDb({ due: false, reason });
      const { bitrix, requests } = fakeBitrix({});
      expect(await runBitrixNameRefresh({ rpc: db.rpc, bitrix, config: { portalMemberId: 'M1' } })).toEqual({ status: 'not_due', reason });
      expect(requests).toEqual([]);
      expect(db.calls.map((c) => c.fn)).toEqual(['integration_bitrix_names_due']);
    }
  });

  it('due: reads every pipeline, STATUS and SOURCE with crm.status.list only; sends names only', async () => {
    const db = namesDb({ due: true, pipelineIds: [7, 0] });
    const { bitrix, requests } = fakeBitrix({
      DEAL_STAGE: [{ result: [{ STATUS_ID: 'NEW', NAME: 'New' }], next: null }],
      DEAL_STAGE_7: [{ result: STAGES7.slice(0, 1), next: 50 }, { result: STAGES7.slice(1), next: null }],
      STATUS: [{ result: [{ STATUS_ID: 'NEW', NAME: 'Fresh', SORT: 1, PHONE: '+1' }], next: null }],
      SOURCE: [{ result: [{ STATUS_ID: 'WEB', NAME: 'Website' }], next: null }],
    });
    const r = await runBitrixNameRefresh({ rpc: db.rpc, bitrix, config: { portalMemberId: 'M1' } });
    expect(r).toEqual({ status: 'ran', listsRead: 4, listsFailed: 0, added: 2, renamed: 0, missing: 0, restored: 0 });
    expect(new Set(requests.map((q) => q.method))).toEqual(new Set(['crm.status.list']));
    expect(requests.map((q) => (q.params.filter as { ENTITY_ID: string }).ENTITY_ID)).toEqual(
      ['DEAL_STAGE', 'DEAL_STAGE_7', 'DEAL_STAGE_7', 'STATUS', 'SOURCE']);
    const apply = db.calls.find((c) => c.fn === 'integration_apply_bitrix_names')!;
    expect(apply.args).toEqual({
      p_portal: 'M1',
      p_complete: true,
      p_lists: [
        { entityId: 'DEAL_STAGE', items: [{ code: 'NEW', name: 'New', sort: 0, kind: 'open' }] },
        { entityId: 'DEAL_STAGE_7', items: [{ code: 'C7:NEW', name: 'New', sort: 10, kind: 'open' }, { code: 'C7:WON', name: 'Won', sort: 20, kind: 'won' }] },
        { entityId: 'STATUS', items: [{ code: 'NEW', name: 'Fresh', sort: 1, kind: null }] },
        { entityId: 'SOURCE', items: [{ code: 'WEB', name: 'Website', sort: 0, kind: null }] },
      ],
    });
    expect(JSON.stringify(apply.args)).not.toContain('PHONE');
  });

  it('a list that fails or runs past the deadline is not sent; nothing read is an error without an apply', async () => {
    const db = namesDb({ due: true, pipelineIds: [7] });
    const { bitrix } = fakeBitrix({ DEAL_STAGE_7: new Error('provider_unavailable'), STATUS: [{ result: [{ STATUS_ID: 'NEW', NAME: 'Fresh' }], next: null }] });
    const r = await runBitrixNameRefresh({ rpc: db.rpc, bitrix, config: { portalMemberId: 'M1' } });
    expect(r).toMatchObject({ status: 'ran', listsRead: 1, listsFailed: 2 });
    const applyCall = db.calls.find((c) => c.fn === 'integration_apply_bitrix_names')!;
    const sent = (applyCall.args!.p_lists as Array<{ entityId: string }>).map((l) => l.entityId);
    // SOURCE answered an empty list: a failed read (Echo L2), not "every source is gone".
    expect(sent).toEqual(['STATUS']);
    // A run with a failed list records no success, so it is retried within the day.
    expect(applyCall.args!.p_complete).toBe(false);

    const late = namesDb({ due: true, pipelineIds: [7] });
    const { bitrix: b2, requests } = fakeBitrix({});
    expect(await runBitrixNameRefresh({ rpc: late.rpc, bitrix: b2, config: { portalMemberId: 'M1' }, now: () => 1000, deadline: 1000 }))
      .toEqual({ status: 'error', code: 'nothing_read' });
    expect(requests).toEqual([]);
    expect(late.calls.map((c) => c.fn)).toEqual(['integration_bitrix_names_due']);
  });

  it('Echo L2: a result that is not a list, or an empty first page, is a failed read for that list', async () => {
    const db = namesDb({ due: true, pipelineIds: [0] });
    const { bitrix } = fakeBitrix({
      DEAL_STAGE: [{ result: { error: 'renamed field' }, next: null }],
      STATUS: [{ result: [], next: null }],
      SOURCE: [{ result: [{ STATUS_ID: 'WEB', NAME: 'Website' }], next: null }],
    });
    const r = await runBitrixNameRefresh({ rpc: db.rpc, bitrix, config: { portalMemberId: 'M1' } });
    expect(r).toMatchObject({ status: 'ran', listsRead: 1, listsFailed: 2 });
    const applyCall = db.calls.find((c) => c.fn === 'integration_apply_bitrix_names')!;
    expect((applyCall.args!.p_lists as Array<{ entityId: string }>).map((l) => l.entityId)).toEqual(['SOURCE']);
    expect(applyCall.args!.p_complete).toBe(false);
  });

  it('a list with more pages than allowed is never sent (it would mark real codes missing)', async () => {
    const db = namesDb({ due: true, pipelineIds: [] });
    const endless = Array.from({ length: 20 }, (_, i) => ({ result: [{ STATUS_ID: `S${i}`, NAME: `S${i}` }], next: (i + 1) * 50 }));
    const { bitrix } = fakeBitrix({ STATUS: endless, SOURCE: [{ result: [{ STATUS_ID: 'WEB', NAME: 'Website' }], next: null }] });
    const r = await runBitrixNameRefresh({ rpc: db.rpc, bitrix, config: { portalMemberId: 'M1' } });
    expect(r).toMatchObject({ status: 'ran', listsRead: 1, listsFailed: 1 });
  });

  it('command failures become codes', async () => {
    const failing: RpcClient = { rpc: async () => ({ data: null, error: { code: '42501' } }) };
    const { bitrix } = fakeBitrix({});
    expect(await runBitrixNameRefresh({ rpc: failing, bitrix, config: { portalMemberId: 'M1' } })).toEqual({ status: 'error', code: 'due_failed' });
    const malformed: RpcClient = { rpc: async () => ({ data: { due: 'yes' }, error: null }) };
    expect(await runBitrixNameRefresh({ rpc: malformed, bitrix, config: { portalMemberId: 'M1' } })).toEqual({ status: 'error', code: 'due_failed' });
  });
});

describe('intake config reads the name switch with the rest', () => {
  it('bitrix_name_read is part of the one select; absent reads as off; an older database falls back', async () => {
    // The voice-note batch (20261128000100) appends its switch after this one.
    expect(INTAKE_CONFIG_COLUMNS.endsWith(', bitrix_id_proof_copy, bitrix_name_read, bitrix_trip_details_read')).toBe(true);
    const base = { portal_domain: 'p.example', portal_member_id: 'M1', category_id: 7, eligible_stage_ids: [], cutoff_at: 'x', enabled: true };
    expect(parseIntakeConfigRow({ ...base, bitrix_name_read: true })).toMatchObject({ bitrixNameRead: true });
    expect(parseIntakeConfigRow(base)).toMatchObject({ bitrixNameRead: false });
    const seen: string[] = [];
    await selectIntakeConfig(async (columns) => {
      seen.push(columns);
      return columns === INTAKE_CONFIG_COLUMNS ? { data: null, error: { code: '42703' } } : { data: [], error: null };
    });
    expect(seen).toEqual([INTAKE_CONFIG_COLUMNS, INTAKE_CONFIG_COLUMNS.replace(', bitrix_trip_details_read', '')]);
  });
});

describe('?task=sync with the name read', () => {
  const PORTAL = 'synthetic.bitrix24.example';
  const SECRET = 'synthetic-worker-secret-0123456789abcdef';
  let mock: MockBitrix;
  let db: FakeIntakeDb;
  let names: ReturnType<typeof namesDb>;

  beforeAll(async () => {
    mock = await startMockBitrix();
  });
  afterAll(async () => {
    await mock.close();
  });
  beforeEach(() => {
    mock.deals.clear();
    mock.requests.length = 0;
    db = new FakeIntakeDb();
    db.maxAttempts = 8;
    names = namesDb({ due: true, pipelineIds: [7] });
  });

  function deps(nameRead?: boolean): WorkerEndpointDeps {
    const intake = asRpcClient({ rpc: db.rpc });
    return {
      env: { bitrixWebhookBaseUrl: mock.baseUrl, bitrixEventApplicationToken: null, intakeWorkerSecret: SECRET, cronSecret: null },
      appEnv: 'local',
      loadConfigRows: async () => [{
        portal_domain: PORTAL, portal_member_id: db.config.memberId, category_id: '7', eligible_stage_ids: ['C7:WON'],
        cutoff_at: '2026-10-01T00:00:00+05:30', enabled: true, last_reconciled_at: db.config.lastReconciledAt,
        ...(nameRead === undefined ? {} : { bitrix_name_read: nameRead }),
      }],
      rpc: () => ({
        rpc: (fn: string, args?: Record<string, unknown>) =>
          fn === 'integration_bitrix_names_due' || fn === 'integration_apply_bitrix_names' ? names.rpc.rpc(fn, args) : intake.rpc(fn, args),
      }),
      heldDealIds: async (_member, ids) => new Set(ids.filter((id) => db.deals.has(String(id)))),
      now: () => db.now,
    };
  }

  async function run(d: WorkerEndpointDeps) {
    mock.deals.set('7', syntheticDeal(7));
    const res = await handleWorkerRequest(
      new Request('https://crm.example.test/api/integrations/bitrix/worker?task=sync', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }),
      d,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, bitrix: mock.requests.map((r) => r.method) };
  }

  it('switch off (or absent): no names call, no status list read, no bitrixNames in the answer', async () => {
    for (const flag of [undefined, false]) {
      names.calls.length = 0;
      mock.requests.length = 0;
      const r = await run(deps(flag));
      expect(r.status).toBe(200);
      expect(r.body).not.toHaveProperty('bitrixNames');
      expect(names.calls).toEqual([]);
      expect(r.bitrix).not.toContain('crm.status.list');
    }
  });

  it('switch on: one due check, read-only status lists, counts in the answer; the sync result is unchanged', async () => {
    const r = await run(deps(true));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ worker: { created: 1 }, bitrixNames: { status: 'ran', listsRead: 3, listsFailed: 0 } });
    expect(names.calls.map((c) => c.fn)).toEqual(['integration_bitrix_names_due', 'integration_apply_bitrix_names']);
    expect(r.bitrix.filter((m) => m === 'crm.status.list')).toHaveLength(3);
    // Read methods only (the client refuses anything else).
    expect(r.bitrix.every((m) => /^(crm\.(deal|lead|status|category)\.(list|get|fields)|user\.get)$/.test(m))).toBe(true);
  });
});
