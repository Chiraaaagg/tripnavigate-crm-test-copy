import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntakeConfig } from '@/modules/integration/intake-config';

/**
 * B1.2 DEC-43, review E12: the production wiring (id-proof-copy-runtime.ts)
 * reads the field through crm.item.get on the READ webhook and the file
 * through urlMachine. Mock portal only (stubbed global fetch on loopback
 * webhooks); the database commands and private storage are mocked.
 */

const READ_BASE = 'http://127.0.0.1:1/rest/1/syntheticRead0001/';
const WRITE_BASE = 'http://127.0.0.1:1/rest/7/syntheticWrite001/';
const BYTES = new TextEncoder().encode('synthetic id proof bytes');
const SHA = createHash('sha256').update(BYTES).digest('hex');

const db = vi.hoisted(() => ({ jobs: [] as unknown[], completed: [] as unknown[][], marked: [] as unknown[][], stopped: [] as unknown[][] }));

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({
    rpc: async () => ({ data: null, error: null }),
    storage: { from: () => ({ download: async () => ({ data: new Blob([Buffer.from('synthetic id proof bytes')]), error: null }) }) },
  }),
}));

vi.mock('@/modules/integration/commands', () => ({
  asRpcClient: (c: unknown) => c,
  claimIdProofCopyJobs: async (_c: unknown, n: number) => db.jobs.splice(0, n),
  markIdProofCopySending: async (_c: unknown, _j: unknown, prior: number[]) => {
    db.marked.push([prior]);
  },
  completeIdProofCopy: async (_c: unknown, _j: unknown, outcome: string, code: string | null, fileId: number | null) => {
    db.completed.push([outcome, code, fileId]);
  },
  stopIdProofCopy: async (_c: unknown, _j: unknown, reason: string) => {
    db.stopped.push([reason]);
    return { stopId: 's' };
  },
}));

const machineUrl = (id: number) => `${READ_BASE}crm.controller.item.getFile/?token=syntheticFileToken${id}&fileId=${id}`;

function stubPortal(files: Record<number, Uint8Array>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u === `${READ_BASE}crm.item.get.json`) {
      calls.push(`read crm.item.get ${init?.body}`);
      const item = { id: 9412, title: 'Synthetic', ufCrm_1784359513: Object.keys(files).map((id) => ({ id: Number(id), url: '/bitrix/services/main/ajax.php', urlMachine: machineUrl(Number(id)) })) };
      return new Response(JSON.stringify({ result: { item } }));
    }
    const m = /fileId=(\d+)$/.exec(u);
    if (m && u.startsWith(`${READ_BASE}crm.controller.item.getFile/`)) {
      calls.push(`file ${m[1]} ${init?.redirect}`);
      return new Response(Buffer.from(files[Number(m[1])]!), { headers: { 'content-type': 'application/octet-stream' } });
    }
    calls.push(`other ${u.startsWith(WRITE_BASE) ? 'write' : 'unknown'}`);
    return new Response('{}', { status: 404 });
  });
  return calls;
}

const config = { portalDomain: 'synthetic.bitrix24.example' } as IntakeConfig;
const job = (o: Record<string, unknown> = {}) => ({
  jobId: '11111111-1111-4111-8111-111111111111', leaseToken: '22222222-2222-4222-8222-222222222222', mode: 'verify', bitrixDealId: '9412',
  objectPath: 'e/d/t/f', mime: 'image/jpeg', sizeBytes: BYTES.byteLength, sha256: SHA, travellerSeq: 1, priorFileIds: [11, 12], attempts: 1, ...o,
});

describe('runIdProofCopyBatch wiring (mock portal)', () => {
  beforeEach(() => {
    vi.stubEnv('BITRIX_WEBHOOK_BASE_URL', READ_BASE);
    vi.stubEnv('BITRIX_WRITE_WEBHOOK_BASE_URL', WRITE_BASE);
    vi.stubEnv('APP_ENV', 'local');
    db.jobs = [];
    db.completed = [];
    db.marked = [];
    db.stopped = [];
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('verify: reads the field with crm.item.get on the READ webhook, recognises the file through urlMachine, never writes', async () => {
    const { runIdProofCopyBatch } = await import('@/modules/integration/server/id-proof-copy-runtime');
    const calls = stubPortal({ 11: new TextEncoder().encode('a'), 12: new TextEncoder().encode('b'), 101: BYTES });
    db.jobs = [job()];
    const run = await runIdProofCopyBatch(1, { config });
    expect(run).toMatchObject({ status: 'ran', summary: { claimed: 1, sent: 1 } });
    expect(db.completed).toEqual([['sent', null, 101]]);
    expect(calls).toEqual(['read crm.item.get {"entityTypeId":2,"id":9412,"useOriginalUfNames":"N"}', 'file 101 manual']);
    expect(JSON.stringify(run)).not.toMatch(/token|syntheticRead0001|syntheticWrite001|http/);
  });

  it('verify: a new file read as something else stays unknown, no write', async () => {
    const { runIdProofCopyBatch } = await import('@/modules/integration/server/id-proof-copy-runtime');
    const calls = stubPortal({ 11: new TextEncoder().encode('a'), 12: new TextEncoder().encode('b'), 101: new TextEncoder().encode('not ours') });
    db.jobs = [job()];
    await runIdProofCopyBatch(1, { config });
    expect(db.completed).toEqual([['unknown', 'new_file_not_matched', null]]);
    expect(calls.some((c) => c.includes('write'))).toBe(false);
  });

  it('no write credential: not configured, no call', async () => {
    vi.stubEnv('BITRIX_WRITE_WEBHOOK_BASE_URL', '');
    const { runIdProofCopyBatch } = await import('@/modules/integration/server/id-proof-copy-runtime');
    const calls = stubPortal({});
    expect(await runIdProofCopyBatch(1, { config })).toEqual({ status: 'not_configured', code: 'write_credential_missing' });
    expect(calls).toHaveLength(0);
  });
});
