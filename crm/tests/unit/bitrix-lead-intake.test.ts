import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_READ_METHODS,
  BitrixClientError,
  createBitrixClient,
  LEAD_HEADER_FIELDS,
} from '@/modules/integration/bitrix/client';
import { resolveBitrixRestTarget } from '@/modules/integration/bitrix/config';
import { readBitrixEvent, readDealEvent } from '@/modules/integration/bitrix/events';
import { toLeadSnapshot } from '@/modules/integration/bitrix/lead';
import { MANIFEST_PAGE_SIZE, reconcileEligibleDeals } from '@/modules/integration/bitrix/reconcile';
import { handleBitrixEvent, type ReceiverDeps } from '@/modules/integration/bitrix/receiver';
import { processInboxBatch } from '@/modules/integration/bitrix/worker';
import {
  asRpcClient,
  claimInbox,
  enqueueReconcile,
  IntakeCommandError,
  loadActiveManifest,
  recordBitrixEvent,
  type RpcClient,
} from '@/modules/integration/commands';
import type { IntakeConfig } from '@/modules/integration/intake-config';
import { handleBitrixEventEdge, createPostgrestDeps } from '../../supabase/functions/bitrix-events/index';
import { FakeIntakeDb, startMockBitrix, syntheticDeal, syntheticLead, type MockBitrix } from '../helpers/mock-bitrix';

/**
 * Phase 6 Lead intake at app level (contract sections 1 L1, 2.1-2.4, 3) against
 * the in-process mock Bitrix and the FAKE command layer. The real SQL gate and
 * RLS are proven by the DB agent's suites. Synthetic data only.
 */

const PORTAL = 'synthetic.bitrix24.example';
const MEMBER = 'synthetic-member-0001';
const TOKEN = 'synthetic-application-token-0123456789';
const INTERVAL = { from: '2026-10-04T00:00:00+05:30', to: '2026-10-05T00:00:00+05:30' };

let mock: MockBitrix;
let db: FakeIntakeDb;
const sleep = vi.fn(async () => undefined);

const config = (): IntakeConfig => ({
  portalDomain: PORTAL,
  portalMemberId: db.config.memberId,
  categoryId: '7',
  categoryIds: ['7'],
  eligibleStageIds: ['C7:WON'],
  cutoffAt: '2026-10-01T00:00:00+05:30',
  pilotLegalEntityId: null,
  pilotBranchId: null,
  enabled: true,
  lastReconciledAt: db.config.lastReconciledAt,
});
const bitrix = () => createBitrixClient({ target: resolveBitrixRestTarget(mock.baseUrl, PORTAL, 'local'), sleep, timeoutMs: 10_000 });
const rpc = () => asRpcClient({ rpc: db.rpc });
const run = () => processInboxBatch({ rpc: rpc(), bitrix: bitrix(), config: config(), limit: 25, now: () => db.now });
const methods = () => mock.requests.map((r) => r.method);
const leadManifest = (ids: Array<string | number>, sourceCode = 'WEBFORM') => {
  db.manifests.lead = { ids: new Set(ids.map(String)), sourceCode, ...INTERVAL };
};

beforeAll(async () => {
  mock = await startMockBitrix();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.deals.clear();
  mock.leads.clear();
  mock.requests.length = 0;
  mock.pageSize = 50;
  db = new FakeIntakeDb();
  db.config.memberId = MEMBER;
  db.manifestGate = true;
  sleep.mockClear();
});

describe('Bitrix client: Lead reads are header only', () => {
  it('allows crm.lead.get / crm.lead.list and no write-like method', () => {
    expect(ALLOWED_READ_METHODS).toContain('crm.lead.get');
    expect(ALLOWED_READ_METHODS).toContain('crm.lead.list');
    for (const m of ALLOWED_READ_METHODS) expect(m).not.toMatch(/\.(add|update|delete|set)$/);
    expect([...LEAD_HEADER_FIELDS]).toEqual(['ID', 'TITLE', 'STATUS_ID', 'SOURCE_ID', 'ASSIGNED_BY_ID', 'DATE_CREATE', 'DATE_MODIFY']);
  });

  it('getLead drops contact, phone, e-mail, comment and amount fields', async () => {
    mock.leads.set('41', syntheticLead(41));
    const read = await bitrix().getLead('41');
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(Object.keys(read.lead).sort()).toEqual([...LEAD_HEADER_FIELDS].sort());
    const text = JSON.stringify(read);
    for (const secret of ['Synthetic Person', '+10000000000', 'synthetic@example.test', 'synthetic comment', '12345']) {
      expect(text).not.toContain(secret);
    }
    expect(mock.requests.map((r) => r.method)).toEqual(['crm.lead.get']);
  });

  it('getLead reports not found and refuses malformed IDs before any request', async () => {
    expect(await bitrix().getLead('404')).toEqual({ kind: 'not_found' });
    await expect(bitrix().getLead('0')).rejects.toBeInstanceOf(BitrixClientError);
    await expect(bitrix().getLead('1;DROP')).rejects.toBeInstanceOf(BitrixClientError);
    expect(methods()).toEqual(['crm.lead.get']);
  });

  it('listLeads refuses a select outside the header fields and reduces rows to them', async () => {
    mock.leads.set('7', syntheticLead(7));
    const client = bitrix();
    await expect(client.listLeads({ filter: {}, select: ['ID', 'NAME' as never], start: 0 })).rejects.toBeInstanceOf(BitrixClientError);
    await expect(client.listLeads({ filter: {}, select: [], start: 0 })).rejects.toBeInstanceOf(BitrixClientError);
    expect(mock.requests).toHaveLength(0);
    const page = await client.listLeads({ filter: { '@ID': ['7'] }, select: ['ID', 'DATE_MODIFY'], start: 0 });
    expect(page.items).toEqual([{ ID: '7', DATE_MODIFY: '2026-10-04T10:00:00+05:30' }]);
  });

  it('toLeadSnapshot keeps only header fields; missing SOURCE_ID is null', () => {
    const snap = toLeadSnapshot({ ID: '9', TITLE: 'T', STATUS_ID: 'NEW', ASSIGNED_BY_ID: 501, DATE_CREATE: 'a', DATE_MODIFY: 'b' });
    expect(snap).toEqual({ id: '9', title: 'T', statusId: 'NEW', sourceId: null, assignedById: '501', dateCreate: 'a', dateModify: 'b' });
  });
});

describe('event parsing: Lead and Deal events never mix', () => {
  const f = (event: string, id = '41') => new Map([['event', event], ['data[FIELDS][ID]', id], ['ts', '1759700000']]);
  it('names the source object from the event type only', () => {
    expect(readBitrixEvent(f('ONCRMLEADADD'))).toEqual({ event: 'ONCRMLEADADD', sourceObject: 'lead', sourceId: 41, ts: 1759700000 });
    expect(readBitrixEvent(f('oncrmleadupdate'))?.sourceObject).toBe('lead');
    expect(readBitrixEvent(f('ONCRMDEALADD'))?.sourceObject).toBe('deal');
    expect(readBitrixEvent(f('ONCRMLEADDELETE'))).toBeNull();
    expect(readBitrixEvent(f('ONCRMCONTACTADD'))).toBeNull();
    expect(readDealEvent(f('ONCRMLEADADD'))).toBeNull();
  });
});

describe('receiver (local route): Lead events', () => {
  const post = (event: string, id: string, ts = '1759700000') =>
    new Request('https://crm.example.test/api/integrations/bitrix/events', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        event,
        'data[FIELDS][ID]': id,
        ts,
        'auth[domain]': PORTAL,
        'auth[member_id]': MEMBER,
        'auth[application_token]': TOKEN,
      }).toString(),
    });
  const deps = (): ReceiverDeps => ({
    env: { bitrixEventApplicationToken: TOKEN, bitrixWebhookBaseUrl: null, intakeWorkerSecret: null, cronSecret: null },
    loadConfigRows: async () => [
      { portal_domain: PORTAL, portal_member_id: MEMBER, category_id: '7', eligible_stage_ids: ['C7:WON'], cutoff_at: INTERVAL.from, enabled: true },
    ],
    rpc: () => asRpcClient({ rpc: db.rpc }),
  });

  it('records a manifest Lead with the same signature (p_deal_id carries the Lead ID)', async () => {
    leadManifest([41]);
    const res = await handleBitrixEvent(post('ONCRMLEADADD', '41'), deps());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.calls.find((c) => c.fn === 'integration_record_bitrix_event')!.args).toEqual({
      p_member_id: MEMBER,
      p_event_type: 'ONCRMLEADADD',
      p_deal_id: 41,
      p_source_ts: 1759700000,
    });
    expect(db.inbox).toMatchObject([{ sourceObject: 'lead', dealId: '41', status: 'pending' }]);
  });

  it('a Lead outside the manifest is acknowledged with the same 200 body and stored ignored / not_in_manifest', async () => {
    leadManifest([41]);
    const res = await handleBitrixEvent(post('ONCRMLEADADD', '42'), deps());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.inbox).toMatchObject([{ sourceObject: 'lead', status: 'ignored', reasonCode: 'not_in_manifest', attempts: 0 }]);
    // Repeat delivery: dedupe still applies.
    expect((await handleBitrixEvent(post('ONCRMLEADADD', '42'), deps())).status).toBe(200);
    expect(db.inbox).toHaveLength(1);
  });

  it('no active manifest: Lead events are acknowledged and nothing is queued for work', async () => {
    expect((await handleBitrixEvent(post('ONCRMLEADUPDATE', '41'), deps())).status).toBe(200);
    expect(db.inbox.every((r) => r.status === 'ignored')).toBe(true);
    expect(await run()).toMatchObject({ claimed: 0, created: 0 });
    expect(db.leads.size).toBe(0);
  });
});

describe('Edge receiver: Lead events', () => {
  it('passes ONCRMLEADADD through the unchanged receiver RPC signature', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ inboxId: '00000000-0000-4000-8000-000000000001', duplicate: false }), { status: 200 });
    }) as typeof fetch;
    const db = createPostgrestDeps({
      supabaseUrl: 'https://synthetic-ref.supabase.example',
      publishableKey: 'sb_publishable_synthetic_receiver_key_0001',
      receiverCredential: 'synthetic-receiver-credential-0123456789abcdef',
      fetchImpl,
    });
    const req = new Request('https://synthetic-ref.supabase.example/functions/v1/bitrix-events', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        event: 'ONCRMLEADADD',
        'data[FIELDS][ID]': '41',
        ts: '1759700000',
        'auth[domain]': PORTAL,
        'auth[member_id]': MEMBER,
        'auth[application_token]': TOKEN,
      }).toString(),
    });
    const res = await handleBitrixEventEdge(req, { applicationToken: TOKEN, now: () => 1759700000 * 1000, ...db });
    expect(res.status).toBe(200);
    expect(bodies).toEqual([
      {
        p_credential: 'synthetic-receiver-credential-0123456789abcdef',
        p_member_id: MEMBER,
        p_domain: PORTAL,
        p_event_type: 'ONCRMLEADADD',
        p_deal_id: 41,
        p_source_ts: 1759700000,
      },
    ]);
  });
});

describe('worker: dispatch by source object', () => {
  it('imports every manifest Lead exactly once via crm.lead.get and integration_apply_bitrix_lead only', async () => {
    leadManifest([41, 42]);
    mock.leads.set('41', syntheticLead(41));
    mock.leads.set('42', syntheticLead(42));
    db.enqueueLeadEvent(41, 1_000);
    db.enqueueLeadEvent(42, 1_000);
    db.enqueueLeadEvent(41, 1_001, 'ONCRMLEADUPDATE'); // coalesces into the pending row
    const summary = await run();
    expect(summary).toMatchObject({ claimed: 2, created: 2 });
    expect(methods()).toEqual(['crm.lead.get', 'crm.lead.get']);
    expect(db.calls.some((c) => c.fn === 'integration_apply_bitrix_deal')).toBe(false);
    const apply = db.calls.filter((c) => c.fn === 'integration_apply_bitrix_lead');
    expect(apply).toHaveLength(2);
    expect(Object.keys(apply[0]!.args.p_lead as object).sort()).toEqual(
      ['assignedById', 'dateCreate', 'dateModify', 'id', 'sourceId', 'statusId', 'title'].sort(),
    );
    expect(JSON.stringify(apply)).not.toMatch(/Synthetic Person|\+10000000000|synthetic@example\.test|synthetic comment|12345/);
    expect(db.leads.size).toBe(2);
    expect(db.deals.size).toBe(0);
    // Repeat delivery after import: no duplicate row.
    db.enqueueLeadEvent(41, 2_000, 'ONCRMLEADUPDATE');
    expect(await run()).toMatchObject({ claimed: 1, created: 0, ignored: 1 });
    expect(db.leads.size).toBe(2);
  });

  it('a Deal row never reaches the Lead path, and a Lead row never reaches the Deal path', async () => {
    db.manifestGate = false;
    mock.deals.set('41', syntheticDeal(41));
    mock.leads.set('41', syntheticLead(41));
    db.enqueueEvent(41, 1_000, 'ONCRMDEALADD');
    db.enqueueLeadEvent(41, 1_000);
    await run();
    expect(methods().sort()).toEqual(['crm.deal.get', 'crm.lead.get']);
    const dealApply = db.calls.find((c) => c.fn === 'integration_apply_bitrix_deal')!;
    const leadApply = db.calls.find((c) => c.fn === 'integration_apply_bitrix_lead')!;
    expect(db.inbox.find((r) => r.id === dealApply.args.p_inbox_id)!.sourceObject).toBe('deal');
    expect(db.inbox.find((r) => r.id === leadApply.args.p_inbox_id)!.sourceObject).toBe('lead');
    expect(db.deals.size).toBe(1);
    expect(db.leads.size).toBe(1);
  });

  it('an inconsistent claimed row (object vs event type) is dead-lettered with no provider call', async () => {
    db.manifestGate = false;
    db.enqueueLeadEvent(41, 1_000);
    db.inbox[0]!.sourceObject = 'deal'; // corrupt: Deal object on a Lead event
    const summary = await run();
    expect(summary).toMatchObject({ claimed: 1, deadLettered: 1, created: 0 });
    expect(mock.requests).toHaveLength(0);
    expect(db.calls.some((c) => c.fn.startsWith('integration_apply_'))).toBe(false);
  });

  it('a Lead from another source code or outside the interval goes to review / outside_manifest_scope', async () => {
    leadManifest([41, 42]);
    mock.leads.set('41', syntheticLead(41, { SOURCE_ID: 'CALL' }));
    mock.leads.set('42', syntheticLead(42, { DATE_CREATE: '2026-10-05T00:00:00+05:30', DATE_MODIFY: '2026-10-05T00:00:00+05:30' }));
    db.enqueueLeadEvent(41, 1_000);
    db.enqueueLeadEvent(42, 1_000);
    expect(await run()).toMatchObject({ needsReview: 2, created: 0 });
    expect(db.inbox.map((r) => r.reasonCode)).toEqual(['outside_manifest_scope', 'outside_manifest_scope']);
    expect(db.leads.size).toBe(0);
  });

  it('unmapped owner goes to review; closing the manifest stops further writes', async () => {
    leadManifest([41, 42]);
    mock.leads.set('41', syntheticLead(41, { ASSIGNED_BY_ID: '777' }));
    mock.leads.set('42', syntheticLead(42));
    db.enqueueLeadEvent(41, 1_000);
    expect(await run()).toMatchObject({ needsReview: 1 });
    expect(db.inbox[0]!.reasonCode).toBe('unmapped_owner');
    db.enqueueLeadEvent(42, 1_000);
    db.manifests.lead = null; // integration_manifest_close
    expect(await run()).toMatchObject({ claimed: 1, created: 0, ignored: 1 });
    expect(db.leads.size).toBe(0);
  });
});

describe('reconcile: manifest items only', () => {
  const reconcile = () =>
    reconcileEligibleDeals({
      rpc: rpc(),
      bitrix: bitrix(),
      config: config(),
      now: () => db.now,
      activeManifestIds: async (object) => (await loadActiveManifest(rpc(), MEMBER, object))?.ids ?? null,
    });

  it('enumerates only active Lead manifest items in pages of <= 50, through the Lead enqueue command', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => i + 1);
    leadManifest(ids);
    for (const id of ids) mock.leads.set(String(id), syntheticLead(id));
    mock.leads.set('999', syntheticLead(999)); // in Bitrix, not in the manifest
    db.manifestGate = false; // count every enqueue, even ones the DB would refuse
    db.manifests.deal = { ids: new Set(['5']), sourceCode: 'WEBFORM', ...INTERVAL };
    mock.deals.set('5', syntheticDeal(5));
    mock.deals.set('6', syntheticDeal(6)); // eligible by category/stage, but not in the deal manifest
    const summary = await reconcile();
    const leadLists = mock.requests.filter((r) => r.method === 'crm.lead.list');
    expect(leadLists).toHaveLength(3);
    for (const r of leadLists) {
      const filter = r.body.filter as Record<string, unknown>;
      expect(Object.keys(filter)).toEqual(['@ID']);
      expect((filter['@ID'] as unknown[]).length).toBeLessThanOrEqual(MANIFEST_PAGE_SIZE);
      expect(r.body.select).toEqual(['ID', 'DATE_MODIFY']);
    }
    // Deal manifest active: no portal-wide deal list (category/stage passes) at all.
    const dealLists = mock.requests.filter((r) => r.method === 'crm.deal.list');
    expect(dealLists).toHaveLength(1);
    expect(Object.keys(dealLists[0]!.body.filter as object)).toEqual(['@ID']);
    expect(summary.manifest.lead).toEqual({ scoped: true, items: 120, found: 120, missing: 0, enqueued: 120, requested: 120, truncated: false });
    expect(summary.manifest.deal).toMatchObject({ scoped: true, items: 1, found: 1, enqueued: 1 });
    const leadEnqueues = db.calls.filter((c) => c.fn === 'integration_enqueue_reconcile_lead');
    expect(leadEnqueues).toHaveLength(120);
    expect(leadEnqueues.every((c) => c.args.p_deal_id === undefined && Number(c.args.p_lead_id) <= 120)).toBe(true);
    expect(db.calls.filter((c) => c.fn === 'integration_enqueue_reconcile').map((c) => c.args.p_deal_id)).toEqual([5]);
    expect(db.inbox.filter((r) => r.sourceObject === 'lead')).toHaveLength(120);
  });

  it('no active Lead manifest: no Lead is listed or enqueued', async () => {
    mock.leads.set('41', syntheticLead(41));
    const summary = await reconcile();
    expect(mock.requests.some((r) => r.method === 'crm.lead.list')).toBe(false);
    expect(db.calls.some((c) => c.fn === 'integration_enqueue_reconcile_lead')).toBe(false);
    expect(summary.manifest.lead.scoped).toBe(false);
  });

  it('missing manifest items are counted, never replaced by other records', async () => {
    leadManifest([41, 42]);
    mock.leads.set('41', syntheticLead(41));
    const summary = await reconcile();
    expect(summary.manifest.lead).toMatchObject({ items: 2, found: 1, missing: 1, enqueued: 1 });
  });
});

describe('commands: L1 refusal mapping and fail-closed checks', () => {
  const failing = (code: string, message: string): RpcClient => ({ rpc: async () => ({ data: null, error: { code, message } }) });
  const refusalOf = async (code: string, message: string) => {
    try {
      await claimInbox(failing(code, message), 1, 60);
    } catch (error) {
      return (error as IntakeCommandError).refusal;
    }
    throw new Error('expected a refusal');
  };

  it('maps 55000 environment_unset distinctly; staging and other refusals stay not_configured', async () => {
    expect(await refusalOf('55000', 'environment_unset')).toBe('environment_unset');
    expect(await refusalOf('55000', 'intake is not configured (environment unset)')).toBe('environment_unset');
    expect(await refusalOf('55000', 'not_configured')).toBe('not_configured');
    expect(await refusalOf('55000', 'intake is not configured')).toBe('not_configured');
    // No substring matching: a staging refusal mentioning "environment unset" is not labelled unset.
    expect(await refusalOf('55000', 'staging: environment unset is not the reason')).toBe('not_configured');
    expect(await refusalOf('55000', 'ENVIRONMENT_UNSET')).toBe('not_configured');
    expect(await refusalOf('22023', 'environment_unset')).toBeNull();
    expect(await refusalOf('42501', 'portal not recognised')).toBe('wrong_portal');
  });

  it('the receiver answers 503 for both refusals (HTTP unchanged)', async () => {
    for (const message of ['environment_unset', 'not_configured']) {
      const res = await handleBitrixEvent(
        new Request('https://crm.example.test/x', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            event: 'ONCRMLEADADD',
            'data[FIELDS][ID]': '41',
            ts: '1759700000',
            'auth[domain]': PORTAL,
            'auth[member_id]': MEMBER,
            'auth[application_token]': TOKEN,
          }).toString(),
        }),
        {
          env: { bitrixEventApplicationToken: TOKEN, bitrixWebhookBaseUrl: null, intakeWorkerSecret: null, cronSecret: null },
          loadConfigRows: async () => [{ portal_domain: PORTAL, portal_member_id: MEMBER, category_id: '7', eligible_stage_ids: ['C7:WON'], cutoff_at: INTERVAL.from, enabled: true }],
          rpc: () => failing('55000', message),
        },
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'not_configured' });
    }
  });

  it('recordBitrixEvent refuses an object that disagrees with the event type, without a call', async () => {
    const spy = vi.fn(db.rpc);
    const client = asRpcClient({ rpc: spy });
    await expect(recordBitrixEvent(client, { memberId: MEMBER, eventType: 'ONCRMLEADADD', sourceObject: 'deal', sourceId: 1, sourceTs: 1 })).rejects.toBeInstanceOf(IntakeCommandError);
    await expect(recordBitrixEvent(client, { memberId: MEMBER, eventType: 'ONCRMDEALADD', sourceObject: 'lead', sourceId: 1, sourceTs: 1 })).rejects.toBeInstanceOf(IntakeCommandError);
    await expect(recordBitrixEvent(client, { memberId: MEMBER, eventType: 'RECONCILE', sourceObject: 'deal', sourceId: 1, sourceTs: 1 })).rejects.toBeInstanceOf(IntakeCommandError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('enqueue uses separate commands per object and reports the manifest refusal', async () => {
    db.manifestGate = true;
    expect(await enqueueReconcile(rpc(), { memberId: MEMBER, sourceObject: 'lead', sourceId: 41, sourceModified: 1 })).toBe('not_in_manifest');
    leadManifest([41]);
    expect(await enqueueReconcile(rpc(), { memberId: MEMBER, sourceObject: 'lead', sourceId: 41, sourceModified: 1 })).toBe('enqueued');
    expect(db.calls.map((c) => [c.fn, Object.keys(c.args).sort().join(',')])).toEqual([
      ['integration_enqueue_reconcile_lead', 'p_lead_id,p_member_id,p_source_modified'],
      ['integration_enqueue_reconcile_lead', 'p_lead_id,p_member_id,p_source_modified'],
    ]);
  });

  it('claim parsing: sourceObject must agree with the event type', async () => {
    const row = (over: Record<string, unknown>) => ({
      inboxId: '00000000-0000-4000-8000-000000000001',
      lockToken: '00000000-0000-4000-8000-000000000002',
      portalMemberId: MEMBER,
      sourceId: '41',
      sourceDealId: '41',
      origin: 'event',
      attempts: 1,
      ...over,
    });
    const claim = (rows: unknown[]) => claimInbox({ rpc: async () => ({ data: rows, error: null }) }, 5, 60);
    const items = await claim([
      row({ sourceObject: 'lead', eventType: 'ONCRMLEADADD' }),
      row({ sourceObject: 'lead', eventType: 'RECONCILE' }),
      row({ sourceObject: 'deal', eventType: 'ONCRMDEALUPDATE' }),
      row({ sourceObject: 'deal', eventType: 'ONCRMLEADADD' }),
      row({ sourceObject: 'lead', eventType: 'ONCRMDEALADD' }),
      row({ sourceObject: undefined, eventType: 'ONCRMLEADADD' }),
      row({ sourceObject: undefined, eventType: 'RECONCILE' }),
    ]);
    expect(items.map((i) => i.sourceObject)).toEqual(['lead', 'lead', 'deal', null, null, null, 'deal']);
    await expect(claim([row({ sourceObject: 'lead', eventType: 'ONCRMLEADADD', sourceId: '41', sourceDealId: '42' })])).rejects.toBeInstanceOf(
      IntakeCommandError,
    );
  });

  it('loadActiveManifest fails closed on a malformed or inconsistent answer', async () => {
    const answer = (data: unknown) => loadActiveManifest({ rpc: async () => ({ data, error: null }) }, MEMBER, 'lead');
    const good = { manifestId: '00000000-0000-4000-8000-000000000003', sourceObject: 'lead', sourceCode: 'WEBFORM', expectedCount: 2, ids: ['1', '2'] };
    expect(await answer(null)).toBeNull();
    expect(await answer(good)).toMatchObject({ ids: ['1', '2'] });
    await expect(answer({ ...good, expectedCount: 3 })).rejects.toBeInstanceOf(IntakeCommandError);
    await expect(answer({ ...good, sourceObject: 'deal' })).rejects.toBeInstanceOf(IntakeCommandError);
    await expect(answer({ ...good, ids: ['1', '1'] })).rejects.toBeInstanceOf(IntakeCommandError);
    await expect(answer({ ...good, ids: ['1', 'x'] })).rejects.toBeInstanceOf(IntakeCommandError);
  });
});

describe('admin inbox view: sourceObject', () => {
  it('maps source_object and treats anything else as deal', async () => {
    const { toInboxItemView } = await import('@/modules/integration/server/queries');
    const base = {
      id: '00000000-0000-4000-8000-000000000009',
      status: 'ignored' as const,
      origin: 'event' as const,
      event_type: 'ONCRMLEADADD',
      source_deal_id: 41,
      received_at: '2026-10-04T05:00:00Z',
      attempts: 0,
      max_attempts: 8,
      next_attempt_at: null,
      reason_code: 'not_in_manifest',
      last_error_code: null,
      last_error_at: null,
      processed_deal_id: null,
    };
    expect(toInboxItemView({ ...base, source_object: 'lead' })).toMatchObject({ sourceObject: 'lead', reasonCode: 'not_in_manifest', sourceDealId: '41' });
    expect(toInboxItemView({ ...base, source_object: 'deal' }).sourceObject).toBe('deal');
    expect(toInboxItemView({ ...base, source_object: undefined }).sourceObject).toBe('deal');
  });
});

describe('reconcile: bounded manifest pass with a deterministic cursor (review M1)', () => {
  const ROTATION = 5 * 60_000;
  const ids = Array.from({ length: 300 }, (_, i) => i + 1);
  const requestedLeadIds = () =>
    mock.requests
      .filter((r) => r.method === 'crm.lead.list')
      .flatMap((r) => ((r.body.filter as Record<string, unknown>)['@ID'] as string[]).map(String));
  const boundedRun = (nowMs: number, over: Partial<Parameters<typeof reconcileEligibleDeals>[0]> = {}) =>
    reconcileEligibleDeals({
      rpc: rpc(),
      bitrix: bitrix(),
      config: config(),
      maxPages: 2,
      now: () => nowMs,
      activeManifestIds: async (object) => (await loadActiveManifest(rpc(), MEMBER, object))?.ids ?? null,
      ...over,
    });

  beforeEach(() => {
    db.manifestGate = false;
    leadManifest(ids);
    for (const id of ids) mock.leads.set(String(id), syntheticLead(id));
  });

  it('caps pages per run, reports truncation, and later runs cover the tail (never-verified IDs rotate)', async () => {
    const seen = new Set<string>();
    for (let run = 0; run < 3; run += 1) {
      mock.requests.length = 0;
      const summary = await boundedRun(run * ROTATION);
      const leadLists = mock.requests.filter((r) => r.method === 'crm.lead.list');
      expect(leadLists).toHaveLength(2);
      expect(summary.truncated).toBe(true);
      expect(summary.manifest.lead).toMatchObject({ scoped: true, items: 300, requested: 100, truncated: true });
      for (const id of requestedLeadIds()) seen.add(id);
      // The legacy deal passes still run after the bounded lead pass.
      expect(mock.requests.some((r) => r.method === 'crm.deal.list')).toBe(true);
    }
    expect(seen.size).toBe(300);
  });

  it('IDs CRM holds are re-verified stalest first, so successive runs reach every ID', async () => {
    const verified = new Map(ids.map((id) => [String(id), 1_000 + id] as [string, number]));
    const seen = new Set<string>();
    for (let run = 0; run < 3; run += 1) {
      mock.requests.length = 0;
      const nowMs = 10_000_000 + run;
      await boundedRun(nowMs, { verifiedAt: async (object, list) => {
        expect(object).toBe('lead');
        expect(list).toHaveLength(300);
        return new Map(verified);
      } });
      const requested = requestedLeadIds();
      expect(requested).toHaveLength(100);
      for (const id of requested) {
        seen.add(id);
        verified.set(id, nowMs); // the run verified it: it moves to the back
      }
    }
    expect(seen.size).toBe(300);
  });

  it('the run deadline stops the pass before any page and reports truncation', async () => {
    let t = 0;
    const summary = await boundedRun(0, { now: () => (t += 1_000), deadlineMs: 500 });
    expect(mock.requests).toHaveLength(0);
    expect(summary.truncated).toBe(true);
    expect(summary.manifest.lead).toMatchObject({ requested: 0, truncated: true });
  });

  it('a manifest that fits the bound is read in full, in ID order, without truncation', async () => {
    leadManifest(ids.slice(0, 80));
    const summary = await boundedRun(0);
    expect(summary.manifest.lead).toMatchObject({ items: 80, requested: 80, found: 80, truncated: false });
    expect(requestedLeadIds()).toEqual(ids.slice(0, 80).map(String));
  });
});

describe('orderManifestIds', () => {
  it('puts never-verified IDs first (rotated per time bucket) and then the stalest verified', async () => {
    const { orderManifestIds } = await import('@/modules/integration/bitrix/reconcile');
    const all = ['1', '2', '3', '4', '5', '6'];
    const verified = new Map([['5', 20], ['6', 10]]);
    expect(orderManifestIds(all, verified, { nowMs: 0, windowSize: 2, rotationMs: 100 })).toEqual(['1', '2', '3', '4', '6', '5']);
    expect(orderManifestIds(all, verified, { nowMs: 100, windowSize: 2, rotationMs: 100 })).toEqual(['3', '4', '1', '2', '6', '5']);
    expect(orderManifestIds(all, new Map(), { nowMs: 0, windowSize: 10 })).toEqual(all);
  });
});
