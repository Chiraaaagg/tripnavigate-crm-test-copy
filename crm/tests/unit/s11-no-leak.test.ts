import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBitrixRestTarget } from '@/modules/integration/bitrix/config';
import { IDENTITY_BOX, createBitrixFileReader, createBitrixFileWriter } from '@/modules/integration/bitrix/file-store';
import type { RpcClient } from '@/modules/integration/commands';
import {
  claimFileMoves,
  completeFileMove,
  confirmFileMoveDeleted,
  confirmFileMoveRestored,
  fileMoveLeaseOk,
  markFileMoveSending,
  recordFileMoveObservation,
  recordFilePresence,
  recordFileRelocated,
  stopFileMove,
} from '@/modules/integration/server/file-move-commands';
import { processFileMoveBatch, type FileMoveDeps, type FileMoveSummary } from '@/modules/integration/server/file-move-runtime';
import { removeMovedSourceObject } from '@/modules/integration/server/file-storage-remove';

/**
 * S11 no-leak scan: across every worker mode and failure path (mock portal,
 * scripted database answers through the real command wrappers), nothing
 * that leaves the worker carries a urlMachine link or its token, a webhook
 * URL, the portal host, a file path or name, or a Bitrix id outside the
 * database arguments that are defined to hold one:
 *   - console output (there must be none),
 *   - batch results (codes and counts only),
 *   - every database command argument (error codes are [a-z_] only),
 *   - thrown errors.
 * Synthetic values only; no real portal, no Bitrix call.
 */

const PORTAL = 'synthetic.bitrix24.example';
const READ_BASE = 'http://127.0.0.1:1/rest/1/syntheticRead0001/';
const WRITE_BASE = 'http://127.0.0.1:1/rest/7/syntheticWrite001/';
const DEAL = '73519';
const PATH = 'e/secret-traveller-name.pdf';
const MOVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LEASE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STOP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const target = (base: string) => resolveBitrixRestTarget(base, PORTAL, 'local');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const BYTES = new TextEncoder().encode('synthetic pretend paper for the leak scan');
const SHA = sha(BYTES);
const OTHER = new TextEncoder().encode('a staff upload of other bytes, longer than ours by far');

/** Anything that must never leave the worker. */
const SECRETS = [/syntheticRead0001/, /syntheticWrite001/, /127\.0\.0\.1/, /synthetic\.bitrix24/, /token/i, /urlMachine/, /getFile/, /secret-traveller-name/, /e\/secret/, /\/rest\//];
/** Bitrix ids used in the scenarios (deal and files). */
const BITRIX_IDS = [DEAL, '88001', '88101', '88102', '88103'];
/** Database arguments defined to carry Bitrix ids. */
const ID_ARGS = new Set(['p_bitrix_file_id', 'p_prior_file_ids', 'p_present_ids', 'p_new_file_id', 'p_source_deal_id']);

type PortalMode = { readError?: boolean; writeError?: boolean; dropPrior?: boolean; html?: boolean; noDeal?: boolean };

function portal(mode: PortalMode = {}) {
  const box = new Map<number, Uint8Array>([[88001, OTHER]]);
  let next = 88100;
  const link = (id: number) => `${READ_BASE}crm.controller.item.getFile/?token=syntheticFileToken${id}&fileId=${id}`;
  const entries = () => [...box.keys()].map((id) => ({ id, url: `/bitrix/services/main/ajax.php?fileId=${id}`, urlMachine: link(id) }));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u === `${READ_BASE}crm.item.get.json`) {
      if (mode.readError) return json({ error: 'OVERLOAD_LIMIT', error_description: `busy at ${READ_BASE} token=syntheticFileToken1` }, 503);
      if (mode.noDeal) return json({ error: 'NOT_FOUND', error_description: `Element ${DEAL} not found on ${PORTAL}` }, 400);
      return json({ result: { item: { id: Number(DEAL), title: 'Synthetic', [IDENTITY_BOX]: entries() } } });
    }
    const m = /fileId=(\d+)$/.exec(u);
    if (m && u.includes('getFile')) {
      if (mode.html) return new Response(`<html><a href="${link(1)}">sign in at ${PORTAL}</a></html>`, { headers: { 'content-type': 'text/html' } });
      const bytes = box.get(Number(m[1]));
      return bytes ? new Response(Buffer.from(bytes), { headers: { 'content-type': 'application/pdf' } }) : json({ error: 'NOT_FOUND' }, 404);
    }
    if (u === `${WRITE_BASE}crm.item.update.json`) {
      if (mode.writeError) return json({ error: 'ERROR_CORE', error_description: `field ${IDENTITY_BOX} on ${WRITE_BASE} for deal ${DEAL}` }, 400);
      const body = JSON.parse(String(init?.body)) as { fields: Record<string, Array<{ id: number } | [string, string]>> };
      const value = body.fields[IDENTITY_BOX]!;
      for (const v of value) if (Array.isArray(v)) box.set((next += 1), new Uint8Array(Buffer.from(v[1], 'base64')));
      if (mode.dropPrior) box.delete(88001);
      return json({ result: { item: { id: Number(DEAL), [IDENTITY_BOX]: entries() } } });
    }
    return json({ error: 'ERROR_METHOD_NOT_FOUND', error_description: u }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, box };
}

const row = (mode: string, o: Record<string, unknown> = {}) => ({
  moveId: MOVE,
  leaseToken: LEASE,
  mode,
  fileClass: 'id_proof',
  sourceTable: 'department_evidence',
  kindCode: 'id',
  bitrixDealId: DEAL,
  bitrixField: IDENTITY_BOX,
  bucket: 'department-evidence',
  objectPath: PATH,
  mime: 'application/pdf',
  sizeBytes: BYTES.byteLength,
  sha256: SHA,
  bitrixFileId: null,
  priorFileIds: [],
  knownFileIds: [],
  attempts: 0,
  // As Postgres writes a timestamptz into jsonb (microseconds, offset).
  leasedAt: '2026-12-01T09:59:59.123456+00:00',
  ...o,
});

interface Recorded {
  fn: string;
  args: Record<string, unknown>;
}

/** Scripted database through the real wrappers: claims hand out `jobs` in order; other commands answer plainly. */
function run(jobs: Array<Record<string, unknown>>, p: ReturnType<typeof portal>, observation: string = 'verified', over: Record<string, unknown> = {}) {
  const calls: Recorded[] = [];
  const queue = [...jobs];
  const answers: Record<string, unknown> = {
    file_move_mark_sending: { moveId: MOVE, state: 'copy_sending' },
    file_move_complete: { moveId: MOVE, state: 'copied', attempts: 1 },
    file_move_record_observation: { result: observation },
    file_move_confirm_deleted: { result: 'deleted' },
    file_move_confirm_restored: { result: 'restored' },
    file_move_lease_ok: { ok: true },
    file_move_stop: { stopId: STOP },
    file_move_presence_result: { checked: 1, missing: 0 },
    file_move_relocated: { result: 'relocated' },
    ...over,
  };
  const rpc: RpcClient = {
    rpc: async (fn, args) => {
      calls.push({ fn, args: args ?? {} });
      if (fn === 'file_move_claim') {
        const job = queue.shift();
        return { data: job ? [job] : [], error: null };
      }
      return { data: answers[fn] ?? null, error: null };
    },
  };
  const storage = new Map<string, Uint8Array>([[`department-evidence/${PATH}`, BYTES]]);
  const storageClient = {
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          for (const path of paths) storage.delete(`${bucket}/${path}`);
          return { data: [], error: null };
        },
      }),
    },
  };
  const now = Date.parse('2026-12-01T10:00:00Z');
  const deps: FileMoveDeps = {
    now: () => now,
    deadline: now + 600_000,
    maxJobs: 10,
    claim: async () => (await claimFileMoves(rpc, 1, 180))[0] ?? null,
    markSending: async (job, prior) => {
      await markFileMoveSending(rpc, job, prior);
    },
    recordObservation: (job, o) => recordFileMoveObservation(rpc, job, o),
    complete: async (job, outcome, code, fileId) => {
      await completeFileMove(rpc, job, outcome, code, fileId);
    },
    confirmDeleted: (job) => confirmFileMoveDeleted(rpc, job),
    confirmRestored: (job, stored) => confirmFileMoveRestored(rpc, job, stored),
    leaseOk: (job, minSeconds) => fileMoveLeaseOk(rpc, job, minSeconds),
    stop: async (job, reason) => {
      await stopFileMove(rpc, job, reason);
    },
    presence: async (job, ids) => {
      await recordFilePresence(rpc, job, ids);
    },
    relocated: (job, o) => recordFileRelocated(rpc, job, o),
    reader: createBitrixFileReader({ target: target(READ_BASE), fetchImpl: p.fetchImpl }),
    writerFor: (accountsBox) => createBitrixFileWriter({ target: target(WRITE_BASE), accountsBox, fetchImpl: p.fetchImpl }),
    downloadCrm: async (bucket, path) => {
      const b = storage.get(`${bucket}/${path}`);
      if (!b) throw new Error(`missing ${bucket}/${path}`);
      return b;
    },
    uploadCrm: async (bucket, path, bytes) => {
      storage.set(`${bucket}/${path}`, bytes);
      return 'uploaded';
    },
    removeCrm: (bucket, path) => removeMovedSourceObject(storageClient, bucket, path),
  };
  return { calls, done: processFileMoveBatch(deps) };
}

let consoleCalls: unknown[][] = [];
beforeEach(() => {
  consoleCalls = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

function assertClean(label: string, summary: FileMoveSummary, calls: Recorded[]) {
  const text = JSON.stringify(summary);
  for (const s of SECRETS) expect(text, `${label}: result`).not.toMatch(s);
  for (const id of BITRIX_IDS) expect(text, `${label}: result`).not.toContain(id);
  for (const c of calls) {
    // Values only: argument names such as p_lease_token are not data.
    const all = JSON.stringify(Object.values(c.args));
    for (const s of SECRETS) expect(all, `${label}: ${c.fn}`).not.toMatch(s);
    for (const [key, value] of Object.entries(c.args)) {
      if (key === 'p_error_code' && value !== null) expect(String(value), `${label}: ${c.fn} error code`).toMatch(/^[a-z_]{1,60}$/);
      if (ID_ARGS.has(key)) continue;
      for (const id of BITRIX_IDS) expect(JSON.stringify(value), `${label}: ${c.fn} ${key}`).not.toContain(id);
    }
  }
}

describe('nothing secret leaves the worker, in any mode or failure', () => {
  const scenarios: Array<[string, Array<Record<string, unknown>>, PortalMode, string?, Record<string, unknown>?]> = [
    ['copy then checks and delete', [row('copy'), row('verify', { bitrixFileId: '88101' }), row('reverify', { bitrixFileId: '88101' }), row('delete', { bitrixFileId: '88101' }), row('confirm_delete', { bitrixFileId: '88101' })], {}],
    ['copy refused by Bitrix with a description naming the webhook', [row('copy')], { writeError: true }],
    ['copy while Bitrix is overloaded (description naming the host and a token)', [row('copy')], { readError: true }],
    ['copy where Bitrix drops an earlier file', [row('copy')], { dropPrior: true }],
    ['verify_copy after a lost answer', [row('verify_copy', { priorFileIds: ['88001'] })], {}],
    ['restore', [row('restore', { bitrixFileId: '88001', sizeBytes: OTHER.byteLength, sha256: sha(OTHER) })], {}, 'restore_checked'],
    ['restore whose read-back differs', [row('restore', { bitrixFileId: '88001', sizeBytes: OTHER.byteLength, sha256: sha(OTHER) })], {}, 'restore_checked',
      { file_move_confirm_restored: { result: 'missing' } }],
    ['delete with the lease no longer held', [row('delete', { bitrixFileId: '88101' })], {}, undefined, { file_move_lease_ok: { ok: false } }],
    ['relocate', [row('relocate', { bitrixFileId: '88999', knownFileIds: [], sizeBytes: OTHER.byteLength, sha256: sha(OTHER) })], {}],
    ['presence', [{ moveId: null, leaseToken: LEASE, mode: 'presence', bitrixDealId: DEAL, bitrixField: IDENTITY_BOX, expectedFileIds: ['88001'] }], {}],
    ['deal not found', [row('verify', { bitrixFileId: '88001' })], { noDeal: true }],
    ['a login page instead of the file', [row('verify', { bitrixFileId: '88001' })], { html: true }],
    // Same size, other bytes: the database compares and answers quarantined.
    ['quarantine on mismatch', [row('verify', { bitrixFileId: '88001', sizeBytes: OTHER.byteLength })], {}, 'quarantined'],
  ];
  for (const [label, jobs, mode, observation, over] of scenarios) {
    it(label, async () => {
      const r = run(jobs, portal(mode), observation, over);
      const summary = await r.done;
      expect(summary.claimed).toBeGreaterThan(0);
      assertClean(label, summary, r.calls);
      expect(consoleCalls).toEqual([]);
    });
  }

  it('the restore read-back and the lease check send only a hash, a size, the lease and a number', async () => {
    const r = run([row('restore', { bitrixFileId: '88001', sizeBytes: OTHER.byteLength, sha256: sha(OTHER) }), row('delete', { bitrixFileId: '88101' })],
      portal(), 'restore_checked');
    const summary = await r.done;
    expect(summary.done).toMatchObject({ restore_restored: 1, delete_deleted: 1 });
    const restored = r.calls.find((c) => c.fn === 'file_move_confirm_restored')!;
    expect(restored.args).toEqual({ p_id: MOVE, p_lease_token: LEASE, p_stored_sha256: sha(OTHER), p_stored_size: OTHER.byteLength });
    const lease = r.calls.find((c) => c.fn === 'file_move_lease_ok')!;
    expect(lease.args).toEqual({ p_id: MOVE, p_lease_token: LEASE, p_min_seconds: 60 });
    // The lease check comes before the remove's confirmation, and the read start is derived from the lease start.
    expect(r.calls.findIndex((c) => c.fn === 'file_move_lease_ok')).toBeLessThan(r.calls.findIndex((c) => c.fn === 'file_move_confirm_deleted'));
    const observed = r.calls.find((c) => c.fn === 'file_move_record_observation')!;
    expect(observed.args.p_read_started_at).toBe('2026-12-01T09:59:59.124Z');
    assertClean('restore and delete', summary, r.calls);
    expect(consoleCalls).toEqual([]);
  });

  it('a database failure whose message names a link ends with a fixed code', async () => {
    const deps = {
      now: () => 0,
      deadline: 600_000,
      claim: async () => {
        throw new Error(`refused ${READ_BASE} token=syntheticFileToken9 deal ${DEAL}`);
      },
    } as unknown as FileMoveDeps;
    const summary = await processFileMoveBatch(deps);
    expect(summary.errors).toEqual(['claim_failed']);
    assertClean('db failure', summary, []);
  });
});

describe('thrown errors carry fixed codes only', () => {
  it('reader, writer and command errors', async () => {
    const errors: unknown[] = [];
    const overloaded = portal({ readError: true });
    errors.push(await createBitrixFileReader({ target: target(READ_BASE), fetchImpl: overloaded.fetchImpl }).readBox(DEAL, IDENTITY_BOX).catch((e: unknown) => e));
    const refusing = portal({ writeError: true });
    errors.push(
      await createBitrixFileWriter({ target: target(WRITE_BASE), accountsBox: null, fetchImpl: refusing.fetchImpl })
        .appendToBox({ bitrixDealId: DEAL, box: IDENTITY_BOX, priorFileIds: [88001], fileName: `id-${SHA.slice(0, 8)}.pdf`, base64: Buffer.from(BYTES).toString('base64') })
        .catch((e: unknown) => e),
    );
    const failingDb: RpcClient = { rpc: async () => ({ data: null, error: { code: '55000', message: `wrong_state for deal ${DEAL} at ${READ_BASE}` } }) };
    errors.push(await completeFileMove(failingDb, { moveId: MOVE, leaseToken: LEASE }, 'retry', 'bitrix_unavailable').catch((e: unknown) => e));
    errors.push(await claimFileMoves({ rpc: async () => ({ data: [{ ...row('copy'), objectPath: '' }], error: null }) }).catch((e: unknown) => e));
    expect(errors.every((e) => e instanceof Error)).toBe(true);
    for (const e of errors) {
      const text = `${String(e)} ${JSON.stringify(e)} ${(e as Error).stack?.split('\n')[0] ?? ''}`;
      for (const s of SECRETS) expect(text).not.toMatch(s);
      for (const id of BITRIX_IDS) expect(text).not.toContain(id);
    }
    expect(consoleCalls).toEqual([]);
  });
});
