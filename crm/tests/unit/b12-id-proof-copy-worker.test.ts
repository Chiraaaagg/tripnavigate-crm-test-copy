import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALERT_CHECK_MARGIN_MS,
  ID_PROOF_COPY_MIN_REMAINING_MS,
  ID_PROOF_COPY_WORST_CASE_MS,
  WORKER_INVOCATION_BUDGET_MS,
  handleWorkerRequest,
  type IdProofCopyResult,
  type WorkerEndpointDeps,
} from '@/modules/integration/bitrix/worker-endpoint';
import { asRpcClient } from '@/modules/integration/commands';
import { INTAKE_CONFIG_COLUMNS, parseIntakeConfigRow, selectIntakeConfig, type IntakeConfig } from '@/modules/integration/intake-config';
import { FakeIntakeDb, startMockBitrix, syntheticDeal, type MockBitrix } from '../helpers/mock-bitrix';

/**
 * B1.2 DEC-43 activation: the existing scheduled Bitrix worker (?task=sync,
 * pg_cron + pg_net) runs at most one ID-proof copy job after its sync work,
 * only while the switch bitrix_id_proof_copy is on. Mock Bitrix and the fake
 * command layer only; the copy itself is a fake (its own tests cover it).
 */

const PORTAL = 'synthetic.bitrix24.example';
const SECRET = 'synthetic-worker-secret-0123456789abcdef';
let mock: MockBitrix;
let db: FakeIntakeDb;

beforeAll(async () => {
  mock = await startMockBitrix();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.deals.clear();
  mock.requests.length = 0;
  mock.pageSize = 50;
  db = new FakeIntakeDb();
  db.maxAttempts = 8;
});

const RAN: IdProofCopyResult = { status: 'ran', claimed: 1, sent: 1, retried: 0, failed: 0, unknown: 0, stopped: false, errors: [] };

function rowFor(copy?: boolean) {
  return {
    portal_domain: PORTAL,
    portal_member_id: db.config.memberId,
    category_id: '7',
    eligible_stage_ids: ['C7:WON'],
    cutoff_at: '2026-10-01T00:00:00+05:30',
    enabled: true,
    last_reconciled_at: db.config.lastReconciledAt,
    ...(copy === undefined ? {} : { bitrix_id_proof_copy: copy }),
  };
}

function deps(over: Partial<WorkerEndpointDeps> & { copy?: boolean } = {}): WorkerEndpointDeps {
  const { copy, ...rest } = over;
  return {
    env: { bitrixWebhookBaseUrl: mock.baseUrl, bitrixEventApplicationToken: null, intakeWorkerSecret: SECRET, cronSecret: null },
    appEnv: 'local',
    loadConfigRows: async () => [rowFor(copy)],
    rpc: () => asRpcClient({ rpc: db.rpc }),
    heldDealIds: async (_member, ids) => new Set(ids.filter((id) => db.deals.has(String(id)))),
    now: () => db.now,
    ...rest,
  };
}

const req = (task = 'sync') =>
  new Request(`https://crm.example.test/api/integrations/bitrix/worker?task=${task}`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } });

async function run(d: WorkerEndpointDeps, task = 'sync') {
  mock.deals.set('7', syntheticDeal(7));
  const res = await handleWorkerRequest(req(task), d);
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, bitrix: mock.requests.map((r) => r.method), db: db.calls.map((c) => c.fn) };
}

/** Random ids (job ids) differ between two runs; everything else must be equal. */
function masked(r: Awaited<ReturnType<typeof run>>) {
  return JSON.parse(JSON.stringify(r).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>'));
}

describe('config reads the copy switch with the rest (no extra call)', () => {
  it('bitrix_id_proof_copy is part of the one config select; absent or null reads as off', async () => {
    // Batch 1 B1-1 (20261121000100) appends the name-read switch after it, and
    // the voice-note batch (20261128000100) the trip details switch.
    expect(INTAKE_CONFIG_COLUMNS.endsWith(', bitrix_id_proof_copy, bitrix_name_read, bitrix_trip_details_read')).toBe(true);
    expect(parseIntakeConfigRow(rowFor(true))).toMatchObject({ idProofCopy: true });
    expect(parseIntakeConfigRow(rowFor(false))).toMatchObject({ idProofCopy: false });
    expect(parseIntakeConfigRow(rowFor())).toMatchObject({ idProofCopy: false });
    // A database before 0700 falls back to the 0400 column list (switch reads as off).
    const seen: string[] = [];
    await selectIntakeConfig(async (columns) => {
      seen.push(columns);
      return columns.includes('bitrix_id_proof_copy') ? { data: null, error: { code: '42703' } } : { data: [], error: null };
    });
    expect(seen).toHaveLength(4);
    expect(seen[3]).toBe(INTAKE_CONFIG_COLUMNS.replace(', bitrix_id_proof_copy, bitrix_name_read, bitrix_trip_details_read', ''));
  });
});

describe('?task=sync with the copy wired', () => {
  it('switch off: the copy is never called and the answer, Bitrix calls and database calls are exactly as without it', async () => {
    const without = await run(deps());
    db = new FakeIntakeDb();
    db.maxAttempts = 8;
    mock.requests.length = 0;
    const copy = vi.fn(async () => RAN);
    const off = await run(deps({ copy: false, idProofCopy: copy }));
    expect(copy).not.toHaveBeenCalled();
    expect(masked(off)).toEqual(masked(without));
    expect(off.body).not.toHaveProperty('idProofCopy');
  });

  it('switch on: one copy run after the sync, its codes added to the answer', async () => {
    const order: string[] = [];
    const copy = vi.fn<(config: IntakeConfig) => Promise<IdProofCopyResult>>(async () => {
      order.push(`copy after ${db.calls.length} db calls`);
      return RAN;
    });
    const r = await run(deps({ copy: true, idProofCopy: copy }));
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy.mock.calls[0]![0]).toMatchObject({ idProofCopy: true, portalDomain: PORTAL });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ worker: { created: 1 }, idProofCopy: RAN });
    // It ran after the sync's own database work.
    expect(order[0]).not.toBe('copy after 0 db calls');
  });

  it('a copy failure never fails the sync run', async () => {
    const r = await run(deps({ copy: true, idProofCopy: async () => Promise.reject(new Error('synthetic')) }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ worker: { created: 1 }, idProofCopy: { status: 'error', code: 'copy_failed' } });
    expect(JSON.stringify(r.body)).not.toContain('synthetic');
  });

  it('E11-2: the start threshold keeps 15 s for the alert check after the copy', () => {
    expect(ALERT_CHECK_MARGIN_MS).toBeGreaterThanOrEqual(15_000);
    expect(ID_PROOF_COPY_MIN_REMAINING_MS).toBe(ID_PROOF_COPY_WORST_CASE_MS + ALERT_CHECK_MARGIN_MS);
    expect(WORKER_INVOCATION_BUDGET_MS - ID_PROOF_COPY_MIN_REMAINING_MS).toBeGreaterThan(0);
  });

  it('not enough time left: the copy is skipped (no call)', async () => {
    const copy = vi.fn(async () => RAN);
    let t = 0;
    const now = () => {
      t += WORKER_INVOCATION_BUDGET_MS - ID_PROOF_COPY_MIN_REMAINING_MS + 1;
      return t;
    };
    const r = await run(deps({ copy: true, idProofCopy: copy, now }));
    expect(copy).not.toHaveBeenCalled();
    expect(r.body).toMatchObject({ idProofCopy: { status: 'skipped', code: 'not_enough_time' } });
  });

  it('a sync that cannot read Bitrix stays 503; the copy outcome does not change the status', async () => {
    mock.failNext('crm.deal.list', { status: 401, body: { error: 'NO_AUTH_FOUND', error_description: 'x' } });
    const r = await run(deps({ copy: true, idProofCopy: async () => RAN }));
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ reconcileError: 'provider_auth_failed' });
  });

  it('only ?task=sync runs the copy (batch and reconcile never do)', async () => {
    const copy = vi.fn(async () => RAN);
    await run(deps({ copy: true, idProofCopy: copy }), 'reconcile');
    await run(deps({ copy: true, idProofCopy: copy }), 'batch');
    expect(copy).not.toHaveBeenCalled();
  });
});
