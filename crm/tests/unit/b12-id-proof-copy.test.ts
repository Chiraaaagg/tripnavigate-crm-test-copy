import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createBitrixClient } from '@/modules/integration/bitrix/client';
import { resolveBitrixRestTarget } from '@/modules/integration/bitrix/config';
import {
  BitrixWriteError,
  ID_PROOF_FIELD,
  ID_PROOF_ITEM_FIELD,
  assertAllowedWrite,
  buildAppendPayload,
  createBitrixIdProofWriter,
  createFieldFileInspector,
  FILE_LINK_KEYS,
  FILE_MAX_REDIRECTS,
  entryFacts,
  fieldFileIds,
  matchFile,
  neutralFileName,
  processIdProofCopyBatch,
  type IdProofCopyDeps,
  type IdProofCopyJob,
} from '@/modules/integration/bitrix/id-proof-copy';

/**
 * B1.2 DEC-43: the only Bitrix write (copy an ID proof to the Deal field
 * UF_CRM_1784359513). MOCK portal only: a stubbed fetch on a synthetic
 * loopback webhook; no real portal, no real credential.
 */

const READ_BASE = 'http://127.0.0.1:1/rest/1/syntheticRead0001/';
const WRITE_BASE = 'http://127.0.0.1:1/rest/7/syntheticWrite001/';
const PORTAL = 'synthetic.bitrix24.example';
const target = (base: string) => resolveBitrixRestTarget(base, PORTAL, 'local');
const BYTES = new TextEncoder().encode('synthetic id proof bytes');
const SHA = createHash('sha256').update(BYTES).digest('hex');

type UpdateMode = 'ok' | 'drop_prior' | 'ignore' | 'error' | 'network' | 'timeout' | '5xx' | 'rate' | 'auth' | 'staff_too' | 'staff_only';

/** urlMachine as crm.item.get returns it to a webhook caller (recorded shape, synthetic token). */
const machineUrl = (id: number) => `${READ_BASE}crm.controller.item.getFile/?token=syntheticFileToken${id}&fileId=${id}`;
/** The browser link (needs a signed-in session): never fetched by the worker. */
const browserUrl = (id: number) => `http://127.0.0.1:1/bitrix/services/main/ajax.php?action=crm.controller.item.getFile&SITE_ID=s1&entityTypeId=2&id=501&fieldName=UF_CRM_1784359513&fileId=${id}`;

/**
 * An in-memory Deal and a stubbed portal: crm.item.get (the read path),
 * crm.item.update, GET of a field file through its urlMachine link, and a
 * login page for the browser link.
 */
function mockPortal(o: { files?: number[]; updateMode?: UpdateMode; fileBytes?: Record<number, Uint8Array>; noLinks?: boolean; replyWithoutField?: boolean; replyOtherId?: boolean } = {}) {
  const store = new Map<number, Uint8Array>();
  for (const id of o.files ?? [11, 12]) store.set(id, o.fileBytes?.[id] ?? new TextEncoder().encode(`existing file ${id}`));
  const entry = (id: number) => (o.noLinks ? { id, url: browserUrl(id) } : { id, url: browserUrl(id), urlMachine: machineUrl(id) });
  const item: Record<string, unknown> = { id: 501, title: 'Synthetic', opportunity: 123456, [ID_PROOF_ITEM_FIELD]: [...store.keys()].map(entry) };
  let nextId = 100;
  const calls: Array<{ base: string; method: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const file = /crm\.controller\.item\.getFile\/\?token=syntheticFileToken(\d+)&fileId=(\d+)$/.exec(u);
    if (file && u.startsWith(READ_BASE) && (init?.method ?? 'GET') === 'GET') {
      calls.push({ base: 'file', method: `GET ${file[2]}`, body: {} });
      const bytes = store.get(Number(file[2]));
      return bytes ? new Response(Buffer.from(bytes), { headers: { 'content-type': 'application/octet-stream' } }) : new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/bitrix/services/main/ajax.php')) {
      calls.push({ base: 'browser', method: 'GET browser link', body: {} });
      return new Response('<html>Authorization</html>', { headers: { 'content-type': 'text/html; charset=UTF-8' } });
    }
    const base = u.slice(0, u.lastIndexOf('/') + 1);
    const method = u.slice(u.lastIndexOf('/') + 1).replace(/\.json$/, '');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ base, method, body });
    if (method === 'crm.item.get') {
      return body.entityTypeId === 2 && body.id === 501
        ? new Response(JSON.stringify({ result: { item }, time: { start: 1 } }))
        : new Response(JSON.stringify({ error: 'NOT_FOUND', error_description: 'Element not found' }), { status: 400 });
    }
    if (method === 'crm.item.update') {
      const mode = o.updateMode ?? 'ok';
      if (mode === 'network') throw new TypeError('fetch failed');
      if (mode === 'timeout') {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      if (mode === '5xx') return new Response('bad gateway', { status: 502 });
      if (mode === 'rate') return new Response(JSON.stringify({ error: 'QUERY_LIMIT_EXCEEDED' }), { status: 503 });
      if (mode === 'auth') return new Response(JSON.stringify({ error: 'ACCESS_DENIED' }), { status: 403 });
      if (mode === 'error') return new Response(JSON.stringify({ error: 'ERROR_CORE', error_description: 'synthetic' }), { status: 400 });
      const value = (body.fields as Record<string, unknown>)[ID_PROOF_ITEM_FIELD] as Array<Record<string, unknown> | [string, string]>;
      if (mode !== 'ignore') {
        const kept = mode === 'drop_prior' ? [] : value.filter((v): v is Record<string, unknown> => !Array.isArray(v)).map((v) => v.id as number);
        for (const id of [...store.keys()]) if (!kept.includes(id)) store.delete(id);
        // A staff upload lands first (a different file), then ours.
        if (mode === 'staff_too' || mode === 'staff_only') store.set((nextId += 1), new TextEncoder().encode('a staff upload'));
        // staff_only: Bitrix shows a staff upload but not ours (or ours read wrongly).
        if (mode !== 'staff_only') for (const v of value.filter((x): x is [string, string] => Array.isArray(x))) {
          store.set((nextId += 1), Buffer.from(v[1], 'base64'));
        }
        item[ID_PROOF_ITEM_FIELD] = [...store.keys()].map(entry);
      }
      // crm.item.update answers with the whole item (item-API keys).
      const reply: Record<string, unknown> = { id: Number(body.id), title: 'Synthetic' };
      if (!o.replyWithoutField) reply[ID_PROOF_ITEM_FIELD] = [...store.keys()].map(entry);
      return new Response(JSON.stringify({ result: { item: o.replyOtherId ? { ...reply, id: 999 } : reply } }));
    }
    return new Response(JSON.stringify({ error: 'ERROR_METHOD_NOT_FOUND' }), { status: 404 });
  });
  return { item, store, calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function job(o: Partial<IdProofCopyJob> = {}): IdProofCopyJob {
  return {
    jobId: '11111111-1111-4111-8111-111111111111', leaseToken: '22222222-2222-4222-8222-222222222222', mode: 'send', bitrixDealId: '501',
    objectPath: 'e/d/t/f', mime: 'image/jpeg', sizeBytes: BYTES.byteLength, sha256: SHA, travellerSeq: 2, priorFileIds: [], attempts: 0, ...o,
  };
}

function deps(portal: ReturnType<typeof mockPortal>, o: { jobs?: IdProofCopyJob[]; download?: (path: string) => Promise<Uint8Array> } = {}) {
  const reader = createBitrixClient({ target: target(READ_BASE), fetchImpl: portal.fetchImpl, sleep: async () => undefined });
  const record = { complete: vi.fn(), markSending: vi.fn(), stop: vi.fn(), order: [] as string[] };
  const queue = [...(o.jobs ?? [job()])];
  const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const d: IdProofCopyDeps = {
    claim: vi.fn(async (n: number) => queue.splice(0, n)),
    stop: vi.fn(async (_j, reason) => record.stop(reason)),
    inspectFile: createFieldFileInspector({ target: target(READ_BASE), fetchImpl: portal.fetchImpl, sha256 }),
    markSending: vi.fn(async (_j, prior) => record.markSending(prior)),
    complete: vi.fn(async (_j, outcome, code, fileId) => record.complete(outcome, code, fileId)),
    // As the production wiring (id-proof-copy-runtime.ts): the one field through crm.item.get.
    readDealItem: async (id) => {
      record.order.push('read');
      const r = await reader.getDealItemField(id, ID_PROOF_ITEM_FIELD);
      return r.kind === 'ok' ? { [ID_PROOF_ITEM_FIELD]: r.value } : null;
    },
    download: async (path) => {
      record.order.push('download');
      return (o.download ?? (async () => BYTES))(path);
    },
    sha256,
    writer: createBitrixIdProofWriter({ target: target(WRITE_BASE), fetchImpl: portal.fetchImpl }),
  };
  return { d, record };
}

describe('payload and allowlist', () => {
  it('keeps every prior file by id and appends one new file, in the one field, with a neutral name', () => {
    expect(buildAppendPayload('501', [11, 12], 'traveller-2-id-abcd1234.jpg', 'QUJD')).toEqual({
      entityTypeId: 2,
      id: 501,
      fields: { ufCrm_1784359513: [{ id: 11 }, { id: 12 }, ['traveller-2-id-abcd1234.jpg', 'QUJD']] },
    });
    expect(neutralFileName(2, 'abcd1234ffff', 'image/jpeg')).toBe('traveller-2-id-abcd1234.jpg');
    expect(neutralFileName(1, SHA, 'application/pdf')).toMatch(/^traveller-1-id-[0-9a-f]{8}\.pdf$/);
  });

  it('refuses any other method, entity, field, extra key or a body that drops or adds more than one file', () => {
    const ok = buildAppendPayload('501', [11], 'n.jpg', 'QQ==');
    expect(() => assertAllowedWrite('crm.item.update', ok)).not.toThrow();
    const f = (v: unknown) => ({ ...ok, fields: { ufCrm_1784359513: v } });
    const bad: Array<[string, unknown]> = [
      ['crm.deal.update', ok],
      ['crm.item.add', ok],
      ['crm.deal.add', ok],
      ['crm.item.update', { ...ok, entityTypeId: 1 }],
      ['crm.item.update', { ...ok, entityTypeId: '2' }],
      ['crm.item.update', { ...ok, id: '501' }],
      ['crm.item.update', { ...ok, fields: { ...ok.fields, title: 'x' } }],
      ['crm.item.update', { ...ok, fields: { UF_CRM_1784359513: ok.fields.ufCrm_1784359513 } }],
      ['crm.item.update', { ...ok, fields: { ufCrm_1784359537: ok.fields.ufCrm_1784359513 } }],
      ['crm.item.update', { ...ok, extra: 1 }],
      ['crm.item.update', { ...ok, useOriginalUfNames: 'Y' }],
      ['crm.item.update', f([{ id: 11 }])],
      ['crm.item.update', f([['a', 'b'], ['c', 'd']])],
      ['crm.item.update', f([['a', 'b'], { id: 11 }])],
      ['crm.item.update', f([{ id: 11, remove: 'Y' }, ['a', 'b']])],
      ['crm.item.update', f([{ id: 11 }, { fileData: ['a', 'b'] }])],
      ['crm.item.update', f([{ id: 11 }, ['a', 'b', 'c']])],
      ['crm.item.update', f([{ id: 0 }, ['a', 'b']])],
    ];
    for (const [method, body] of bad) expect(() => assertAllowedWrite(method, body), `${method} ${JSON.stringify(body).slice(0, 80)}`).toThrow(BitrixWriteError);
  });

  it('reads file ids from the item-API field in the shapes Bitrix returns', () => {
    expect(fieldFileIds({ [ID_PROOF_ITEM_FIELD]: [{ id: '12' }, { id: 11 }, { id: 11 }, { nope: 1 }] })).toEqual([11, 12]);
    expect(fieldFileIds({ [ID_PROOF_ITEM_FIELD]: { id: 7, url: 'x', urlMachine: 'y' } })).toEqual([7]);
    expect(fieldFileIds({ [ID_PROOF_ITEM_FIELD]: false })).toEqual([]);
    expect(fieldFileIds({ [ID_PROOF_ITEM_FIELD]: null })).toEqual([]);
    expect(fieldFileIds({})).toEqual([]);
    // The original (crm.deal.*) key is not the read path any more.
    expect(fieldFileIds({ [ID_PROOF_FIELD]: [{ id: 5 }] })).toEqual([]);
  });
});

describe('writer (mock portal)', () => {
  it('calls crm.item.update on the WRITE webhook only, reads the field from the reply, and maps every answer to a code', async () => {
    const ok = mockPortal();
    const reply = await createBitrixIdProofWriter({ target: target(WRITE_BASE), fetchImpl: ok.fetchImpl }).appendFile({ bitrixDealId: '501', priorFileIds: [11, 12], fileName: 'n.jpg', base64: 'QQ==' });
    expect(ok.calls.map((c) => [c.base, c.method])).toEqual([[WRITE_BASE, 'crm.item.update']]);
    expect(reply).toEqual({ replyFileIds: [11, 12, 101] });
    const noField = mockPortal({ replyWithoutField: true });
    expect(await createBitrixIdProofWriter({ target: target(WRITE_BASE), fetchImpl: noField.fetchImpl }).appendFile({ bitrixDealId: '501', priorFileIds: [], fileName: 'n.jpg', base64: 'QQ==' }))
      .toEqual({ replyFileIds: null });
    const other = mockPortal({ replyOtherId: true });
    await expect(createBitrixIdProofWriter({ target: target(WRITE_BASE), fetchImpl: other.fetchImpl }).appendFile({ bitrixDealId: '501', priorFileIds: [], fileName: 'n.jpg', base64: 'QQ==' }))
      .rejects.toMatchObject({ kind: 'lost', code: 'reply_mismatch' });

    const kinds: Array<[Parameters<typeof mockPortal>[0], string, string]> = [
      [{ updateMode: 'network' }, 'lost', 'network'],
      [{ updateMode: 'timeout' }, 'lost', 'network'],
      [{ updateMode: '5xx' }, 'lost', 'http_5xx'],
      [{ updateMode: 'rate' }, 'rate_limited', 'rate_limited'],
      [{ updateMode: 'auth' }, 'auth', 'auth_failed'],
      [{ updateMode: 'error' }, 'refused', 'bitrix_refused'],
    ];
    for (const [mode, kind, code] of kinds) {
      const p = mockPortal(mode);
      const err = await createBitrixIdProofWriter({ target: target(WRITE_BASE), fetchImpl: p.fetchImpl })
        .appendFile({ bitrixDealId: '501', priorFileIds: [], fileName: 'n.jpg', base64: 'QQ==' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BitrixWriteError);
      expect(err).toMatchObject({ kind, code });
      expect(String((err as Error).message)).not.toContain('syntheticWrite001');
    }
  });
});

describe('processIdProofCopyBatch (mock portal)', () => {
  it('reads the field, records the prior ids, appends, reads back, and completes sent with the new file id', async () => {
    const portal = mockPortal({ files: [11, 12] });
    const { d, record } = deps(portal);
    expect(await processIdProofCopyBatch(d)).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
    expect(record.markSending).toHaveBeenCalledWith([11, 12]);
    expect(record.complete).toHaveBeenCalledWith('sent', null, 101);
    expect(fieldFileIds(portal.item)).toEqual([11, 12, 101]);
    // E7-2: the CRM file is downloaded before the field is read.
    expect(record.order).toEqual(['download', 'read', 'read']);
    // Reads go to the read webhook, the one write to the write webhook; the new file is checked by its content.
    expect(portal.calls.map((c) => [c.base === WRITE_BASE ? 'write' : c.base === 'file' ? 'file' : 'read', c.method])).toEqual([
      ['read', 'crm.item.get'], ['write', 'crm.item.update'], ['read', 'crm.item.get'], ['file', 'GET 101'],
    ]);
    expect(d.claim).toHaveBeenCalledWith(1);
    // The update carried exactly the prior files and the new one; no customer name.
    const update = portal.calls.find((c) => c.method === 'crm.item.update')!;
    expect(update.body).toMatchObject({ entityTypeId: 2, id: 501 });
    const value = (update.body.fields as Record<string, unknown[]>)[ID_PROOF_ITEM_FIELD]!;
    expect(value.slice(0, 2)).toEqual([{ id: 11 }, { id: 12 }]);
    expect((value[2] as [string, string])[0]).toMatch(/^traveller-2-id-[0-9a-f]{8}\.jpg$/);
    expect(Buffer.from((value[2] as [string, string])[1], 'base64')).toEqual(Buffer.from(BYTES));
  });

  it('E7-1: a prior file gone after the write stops everything: switch off, alert, batch ends', async () => {
    const { d, record } = deps(mockPortal({ updateMode: 'drop_prior' }), { jobs: [job(), job({ jobId: '33333333-3333-4333-8333-333333333333' })] });
    const summary = await processIdProofCopyBatch(d);
    expect(record.stop).toHaveBeenCalledWith('prior_files_lost');
    expect(record.complete).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ claimed: 1, failed: 1, stopped: true, errors: ['prior_files_lost'] });
    expect(d.claim).toHaveBeenCalledTimes(1);
    // Caught in the reply already: no read-back needed.
    expect(record.order).toEqual(['download', 'read']);
  });

  it('E7-1: when the reply does not show the field, the read-back still catches a lost file', async () => {
    const { d, record } = deps(mockPortal({ updateMode: 'drop_prior', replyWithoutField: true }));
    expect(await processIdProofCopyBatch(d)).toMatchObject({ stopped: true });
    expect(record.stop).toHaveBeenCalledWith('prior_files_lost');
    expect(record.order).toEqual(['download', 'read', 'read']);
  });

  it('E9-1: a 200 reply in an unexpected shape is a lost answer (read back), not a refusal', async () => {
    for (const result of [true, null, { other: 1 }]) {
      const portal = mockPortal();
      const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        const r = await portal.fetchImpl(url, init);
        return String(url).endsWith('crm.item.update.json') ? new Response(JSON.stringify({ result })) : r;
      }) as typeof fetch;
      await expect(createBitrixIdProofWriter({ target: target(WRITE_BASE), fetchImpl }).appendFile({ bitrixDealId: '501', priorFileIds: [11, 12], fileName: 'n.jpg', base64: 'QQ==' }))
        .rejects.toMatchObject({ kind: 'lost', code: 'reply_unexpected' });
    }
  });

  it('a reply for another record is treated as a lost answer (read back later, never re-sent blindly)', async () => {
    const { d, record } = deps(mockPortal({ replyOtherId: true }));
    await processIdProofCopyBatch(d);
    expect(record.complete).toHaveBeenCalledWith('unknown', 'answer_reply_mismatch', null);
  });

  it('E7-1: a verify that finds a prior file gone stops too, without any write', async () => {
    const portal = mockPortal({ files: [12, 55] });
    const { d, record } = deps(portal, { jobs: [job({ mode: 'verify', priorFileIds: [11, 12] })] });
    expect(await processIdProofCopyBatch(d)).toMatchObject({ stopped: true });
    expect(record.stop).toHaveBeenCalledWith('prior_files_lost');
    expect(portal.calls.map((c) => c.method)).toEqual(['crm.item.get']);
  });

  it('E7-3: a staff upload landing next to ours is not taken for ours', async () => {
    const portal = mockPortal({ updateMode: 'staff_too' });
    const { d, record } = deps(portal);
    await processIdProofCopyBatch(d);
    expect(fieldFileIds(portal.item)).toEqual([11, 12, 101, 102]);
    expect(record.complete).toHaveBeenCalledWith('sent', null, 102);
  });

  it('a lost answer or an invisible file is unknown; rate limits retry; refusals and auth fail', async () => {
    const cases: Array<[Parameters<typeof mockPortal>[0], string, string]> = [
      [{ updateMode: 'network' }, 'unknown', 'answer_network'],
      [{ updateMode: '5xx' }, 'unknown', 'answer_http_5xx'],
      [{ updateMode: 'ignore' }, 'unknown', 'not_visible_after_send'],
      [{ updateMode: 'rate' }, 'retry', 'rate_limited'],
      [{ updateMode: 'auth' }, 'failed', 'bitrix_auth_failed'],
      [{ updateMode: 'error' }, 'failed', 'bitrix_refused'],
    ];
    for (const [mode, outcome, code] of cases) {
      const { d, record } = deps(mockPortal(mode));
      await processIdProofCopyBatch(d);
      expect(record.complete, code).toHaveBeenCalledWith(outcome, code, null);
    }
  });

  it('before any write: a missing Deal fails, a changed file fails, an unreadable file or field retries', async () => {
    const gone = deps(mockPortal(), { jobs: [job({ bitrixDealId: '999' })] });
    await processIdProofCopyBatch(gone.d);
    expect(gone.record.complete).toHaveBeenCalledWith('failed', 'deal_not_found', null);
    const changed = deps(mockPortal(), { download: async () => new TextEncoder().encode('other bytes') });
    await processIdProofCopyBatch(changed.d);
    expect(changed.record.complete).toHaveBeenCalledWith('failed', 'file_changed', null);
    expect(changed.record.markSending).not.toHaveBeenCalled();
    // A changed or missing CRM file never reaches Bitrix: not even a read.
    expect(changed.record.order).toEqual(['download']);
    const shorter = deps(mockPortal(), { jobs: [job({ sizeBytes: BYTES.byteLength + 1 })] });
    await processIdProofCopyBatch(shorter.d);
    expect(shorter.record.complete).toHaveBeenCalledWith('failed', 'file_changed', null);
    const missing = deps(mockPortal(), { download: async () => Promise.reject(new Error('x')) });
    await processIdProofCopyBatch(missing.d);
    expect(missing.record.complete).toHaveBeenCalledWith('retry', 'file_unavailable', null);
  });

  it('verify (after a lost answer) never sends: only a new file with this content counts as sent', async () => {
    const found = mockPortal({ files: [11, 12, 55], fileBytes: { 55: BYTES } });
    const v1 = deps(found, { jobs: [job({ mode: 'verify', priorFileIds: [11, 12] })] });
    await processIdProofCopyBatch(v1.d);
    expect(v1.record.complete).toHaveBeenCalledWith('sent', null, 55);
    expect(found.calls.map((c) => c.method)).toEqual(['crm.item.get', 'GET 55']);

    // E7-3: a new file that is someone else's is not this job's copy. Review
    // E12-1: nor is it proof that ours is absent: unknown, never a re-send.
    const other = mockPortal({ files: [11, 12, 56] });
    const v2 = deps(other, { jobs: [job({ mode: 'verify', priorFileIds: [11, 12] })] });
    await processIdProofCopyBatch(v2.d);
    expect(v2.record.complete).toHaveBeenCalledWith('unknown', 'new_file_not_matched', null);
    expect(other.calls.map((c) => c.method)).toEqual(['crm.item.get', 'GET 56']);

    const none = mockPortal({ files: [11, 12] });
    const v3 = deps(none, { jobs: [job({ mode: 'verify', priorFileIds: [11, 12] })] });
    await processIdProofCopyBatch(v3.d);
    expect(v3.record.complete).toHaveBeenCalledWith('retry', 'not_found_on_read_back', null);
    expect(none.calls.map((c) => c.method)).toEqual(['crm.item.get']);

    // No urlMachine (only the browser link): stays unknown, never a guess,
    // and the browser link is not even tried.
    const blind = mockPortal({ files: [11, 12, 57], noLinks: true });
    const v4 = deps(blind, { jobs: [job({ mode: 'verify', priorFileIds: [11, 12] })] });
    await processIdProofCopyBatch(v4.d);
    expect(v4.record.complete).toHaveBeenCalledWith('unknown', 'file_facts_unavailable', null);
    expect(blind.calls.map((c) => c.method)).toEqual(['crm.item.get']);
  });
});

describe('E7-3 file matching', () => {
  const j = { sha256: SHA, sizeBytes: 100 };
  it('decides by hash when known, else by size and the name hash part; never guesses', () => {
    expect(matchFile({ sha256: SHA, sizeBytes: 1, name: null }, j)).toBe('match');
    expect(matchFile({ sha256: 'f'.repeat(64), sizeBytes: 100, name: null }, j)).toBe('no_match');
    expect(matchFile({ sha256: null, sizeBytes: 100, name: null }, j)).toBe('match');
    expect(matchFile({ sha256: null, sizeBytes: 100, name: `traveller-2-id-${SHA.slice(0, 8)}.jpg` }, j)).toBe('match');
    expect(matchFile({ sha256: null, sizeBytes: 100, name: 'scan.jpg' }, j)).toBe('no_match');
    expect(matchFile({ sha256: null, sizeBytes: 99, name: null }, j)).toBe('no_match');
    expect(matchFile({ sha256: null, sizeBytes: null, name: null }, j)).toBe('unknown');
    expect(matchFile(null, j)).toBe('unknown');
    expect(entryFacts({ id: 1, size: '100', name: 'x.jpg' })).toEqual({ sizeBytes: 100, name: 'x.jpg', sha256: null });
  });

  it('reads a file only through a link on the portal host, bounded by the expected size', async () => {
    const portal = mockPortal({ files: [11], fileBytes: { 11: new Uint8Array(500) } });
    const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
    const inspect = createFieldFileInspector({ target: target(READ_BASE), fetchImpl: portal.fetchImpl, sha256 });
    expect(await inspect(job(), { id: 11, raw: { id: 11, urlMachine: 'https://elsewhere.example/rest/1/x/crm.controller.item.getFile/?token=t&fileId=11' } })).toBeNull();
    expect(portal.calls).toHaveLength(0);
    const big = await inspect(job({ sizeBytes: 10 }), { id: 11, raw: { id: 11, urlMachine: machineUrl(11) } });
    expect(big).toMatchObject({ sha256: null });
    expect(big!.sizeBytes).toBeGreaterThan(10);
    expect(await inspect(job(), { id: 11, raw: { id: 11, size: 24 } })).toEqual({ sizeBytes: 24, name: null, sha256: null });
  });
});

describe('13 Oct live probe: the read path is crm.item.get and the file is read through urlMachine', () => {
  const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const ok = () => new Response(Buffer.from(BYTES), { headers: { 'content-type': 'application/octet-stream' } });
  const html = () => new Response('<!DOCTYPE html><html>Authorization</html>', { headers: { 'content-type': 'text/html; charset=UTF-8' } });
  const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });
  function recorder(answer: (url: string, n: number) => Response) {
    const seen: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, redirect: init?.redirect });
      return answer(url, seen.length);
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  }
  const M = machineUrl(31);
  const entry = (raw: Record<string, unknown>) => ({ id: 31, raw: { id: 31, ...raw } });

  it('only urlMachine is tried; the browser url is never fetched', async () => {
    expect(FILE_LINK_KEYS).toEqual(['urlMachine']);
    const r = recorder((url) => (url.includes('ajax.php') ? html() : ok()));
    const inspect = createFieldFileInspector({ target: target(READ_BASE), fetchImpl: r.fetchImpl, sha256 });
    expect(await inspect(job(), entry({ url: browserUrl(31), urlMachine: M }))).toMatchObject({ sha256: SHA, sizeBytes: BYTES.byteLength });
    expect(r.seen.map((s) => s.url)).toEqual([M]);
    // Redirects are never followed by fetch itself.
    expect(r.seen.every((s) => s.redirect === 'manual')).toBe(true);
  });

  it('urlMachine missing: unknown (null), no request at all', async () => {
    const r = recorder(() => ok());
    const inspect = createFieldFileInspector({ target: target(READ_BASE), fetchImpl: r.fetchImpl, sha256 });
    expect(await inspect(job(), entry({ url: browserUrl(31) }))).toBeNull();
    expect(await inspect(job(), entry({ urlMachine: '' }))).toBeNull();
    expect(r.seen).toHaveLength(0);
  });

  it('a link on another host is refused before any request', async () => {
    const r = recorder(() => ok());
    const inspect = createFieldFileInspector({ target: target(READ_BASE), fetchImpl: r.fetchImpl, sha256 });
    for (const link of ['https://elsewhere.example/x', 'http://127.0.0.1:2/rest/1/x/', 'https://127.0.0.1:1/rest/1/x/', '//elsewhere.example/x']) {
      expect(await inspect(job(), entry({ urlMachine: link })), link).toBeNull();
    }
    expect(r.seen).toHaveLength(0);
  });

  it('a login page, a text, JSON or XML error is not the file (E12-1b)', async () => {
    const typed = (type: string) => () => new Response(Buffer.from(BYTES), { headers: { 'content-type': type } });
    const answers = [
      html,
      () => new Response(JSON.stringify({ error: 'ACCESS_DENIED' }), { headers: { 'content-type': 'application/json' } }),
      () => new Response('x', { status: 403 }),
      // Same bytes as the job's file, so only the content type refuses them.
      ...['text/plain', 'text/plain; charset=utf-8', 'TEXT/XML', 'application/xml', 'application/atom+xml', 'application/problem+json', ' application/json; charset=utf-8', 'image/svg+xml'].map(typed),
    ];
    for (const answer of answers) {
      const inspect = createFieldFileInspector({ target: target(READ_BASE), fetchImpl: recorder(answer).fetchImpl, sha256 });
      expect(await inspect(job(), entry({ urlMachine: M }))).toBeNull();
    }
    for (const type of ['application/octet-stream', 'image/jpeg', 'application/pdf', 'image/webp', '']) {
      const inspect = createFieldFileInspector({ target: target(READ_BASE), fetchImpl: recorder(typed(type)).fetchImpl, sha256 });
      expect(await inspect(job(), entry({ urlMachine: M })), type).toMatchObject({ sha256: SHA });
    }
  });

  it('E12-1: a new file id that is not positively ours never leads to a re-send', async () => {
    // Verify: a 200 answer that is not our file (an expired one-time link served as bytes).
    const expired = mockPortal({ files: [11, 12, 101], fileBytes: { 101: new TextEncoder().encode('link expired') } });
    const v1 = deps(expired, { jobs: [job({ mode: 'verify', priorFileIds: [11, 12] })] });
    expect(await processIdProofCopyBatch(v1.d)).toMatchObject({ unknown: 1, retried: 0, sent: 0 });
    expect(v1.record.complete).toHaveBeenCalledWith('unknown', 'new_file_not_matched', null);
    expect(expired.calls.some((c) => c.method === 'crm.item.update')).toBe(false);
    // Verify: the new file cannot be read at all.
    const unreadable = mockPortal({ files: [11, 12, 101], noLinks: true });
    const v2 = deps(unreadable, { jobs: [job({ mode: 'verify', priorFileIds: [11, 12] })] });
    await processIdProofCopyBatch(v2.d);
    expect(v2.record.complete).toHaveBeenCalledWith('unknown', 'file_facts_unavailable', null);
    expect(unreadable.calls.map((c) => c.method)).toEqual(['crm.item.get']);
    // Verify: one new file unreadable, one read and different: still unknown.
    const mixed = mockPortal({ files: [11, 12, 101, 102] });
    const fetchMixed = (async (url: string | URL, init?: RequestInit) =>
      String(url).includes('fileId=101') ? new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) : mixed.fetchImpl(url, init)) as typeof fetch;
    const v3 = deps({ ...mixed, fetchImpl: fetchMixed }, { jobs: [job({ mode: 'verify', priorFileIds: [11, 12] })] });
    await processIdProofCopyBatch(v3.d);
    expect(v3.record.complete).toHaveBeenCalledWith('unknown', 'file_facts_unavailable', null);
    // Verify: no new file id at all: the only case that goes back to a send.
    const absent = mockPortal({ files: [11, 12] });
    const v4 = deps(absent, { jobs: [job({ mode: 'verify', priorFileIds: [11, 12] })] });
    await processIdProofCopyBatch(v4.d);
    expect(v4.record.complete).toHaveBeenCalledWith('retry', 'not_found_on_read_back', null);
    // Send read-back: Bitrix shows a new file, not ours: unknown.
    const staff = mockPortal({ updateMode: 'staff_only' });
    const s1 = deps(staff);
    await processIdProofCopyBatch(s1.d);
    expect(s1.record.complete).toHaveBeenCalledWith('unknown', 'new_file_not_matched', null);
    expect(staff.calls.filter((c) => c.method === 'crm.item.update')).toHaveLength(1);
  });

  it(`same-host redirects are followed (at most ${FILE_MAX_REDIRECTS}); another host never`, async () => {
    const same = recorder((_url, n) => (n === 1 ? redirect('/upload/synthetic/31.bin') : n === 2 ? redirect('http://127.0.0.1:1/upload/final/31.bin', 307) : ok()));
    const inspectSame = createFieldFileInspector({ target: target(READ_BASE), fetchImpl: same.fetchImpl, sha256 });
    expect(await inspectSame(job(), entry({ urlMachine: M }))).toMatchObject({ sha256: SHA });
    expect(same.seen.map((s) => new URL(s.url).pathname)).toEqual(['/rest/1/syntheticRead0001/crm.controller.item.getFile/', '/upload/synthetic/31.bin', '/upload/final/31.bin']);

    const other = recorder((_url, n) => (n === 1 ? redirect('https://cdn.elsewhere.example/31.bin') : ok()));
    const inspectOther = createFieldFileInspector({ target: target(READ_BASE), fetchImpl: other.fetchImpl, sha256 });
    expect(await inspectOther(job(), entry({ urlMachine: M }))).toBeNull();
    expect(other.seen).toHaveLength(1);

    const loop = recorder(() => redirect('/again'));
    const inspectLoop = createFieldFileInspector({ target: target(READ_BASE), fetchImpl: loop.fetchImpl, sha256 });
    expect(await inspectLoop(job(), entry({ urlMachine: M }))).toBeNull();
    expect(loop.seen).toHaveLength(FILE_MAX_REDIRECTS + 1);

    const noLocation = recorder(() => new Response(null, { status: 302 }));
    expect(await createFieldFileInspector({ target: target(READ_BASE), fetchImpl: noLocation.fetchImpl, sha256 })(job(), entry({ urlMachine: M }))).toBeNull();
  });

  it('client: crm.item.get for Deal 2 with camelCase keys; only the one field leaves the client', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    // Recorded shape of a crm.item.get answer (synthetic values).
    const recorded = {
      result: {
        item: {
          id: 501, title: 'Synthetic', opportunity: 123456, contactId: 7,
          [ID_PROOF_ITEM_FIELD]: [{ id: 11, url: browserUrl(11), urlMachine: machineUrl(11) }],
          ufCrm_1784359537: 'other field',
        },
      },
      time: { start: 1, finish: 2 },
    };
    let answer: Response | (() => Response) = () => new Response(JSON.stringify(recorded));
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: url.replace(READ_BASE, '<read>/'), body: JSON.parse(String(init?.body)) });
      return typeof answer === 'function' ? answer() : answer;
    }) as unknown as typeof fetch;
    const client = createBitrixClient({ target: target(READ_BASE), fetchImpl, sleep: async () => undefined, maxRateLimitRetries: 0 });
    expect(await client.getDealItemField('501', ID_PROOF_ITEM_FIELD)).toEqual({ kind: 'ok', value: recorded.result.item[ID_PROOF_ITEM_FIELD] });
    expect(calls[0]).toEqual({ url: '<read>/crm.item.get.json', body: { entityTypeId: 2, id: 501, useOriginalUfNames: 'N' } });

    // A missing key is a bad answer, never an empty field.
    answer = () => new Response(JSON.stringify({ result: { item: { id: 501, title: 'x' } } }));
    await expect(client.getDealItemField('501', ID_PROOF_ITEM_FIELD)).rejects.toMatchObject({ code: 'provider_bad_response' });
    answer = () => new Response(JSON.stringify({ result: { item: { id: 502, [ID_PROOF_ITEM_FIELD]: [] } } }));
    await expect(client.getDealItemField('501', ID_PROOF_ITEM_FIELD)).rejects.toMatchObject({ code: 'provider_bad_response' });
    answer = () => new Response(JSON.stringify({ result: { id: 501 } }));
    await expect(client.getDealItemField('501', ID_PROOF_ITEM_FIELD)).rejects.toMatchObject({ code: 'provider_bad_response' });
    // An empty field shown by Bitrix is fine.
    answer = () => new Response(JSON.stringify({ result: { item: { id: 501, [ID_PROOF_ITEM_FIELD]: [] } } }));
    expect(await client.getDealItemField('501', ID_PROOF_ITEM_FIELD)).toEqual({ kind: 'ok', value: [] });
    // Not found, also with a translated description.
    for (const d of ['Element not found', 'Элемент не найден']) {
      answer = () => new Response(JSON.stringify({ error: 'NOT_FOUND', error_description: d }), { status: 400 });
      expect(await client.getDealItemField('501', ID_PROOF_ITEM_FIELD)).toEqual({ kind: 'not_found' });
    }
    answer = () => new Response(JSON.stringify({ error: 'ACCESS_DENIED', error_description: 'You do not have permission to view this item' }), { status: 400 });
    await expect(client.getDealItemField('501', ID_PROOF_ITEM_FIELD)).rejects.toMatchObject({ code: 'provider_auth_failed' });
    // Refused before any request: bad id or a key that is not a Deal user field.
    const before = calls.length;
    for (const [id, field] of [['0', ID_PROOF_ITEM_FIELD], ['5x', ID_PROOF_ITEM_FIELD], ['501', 'UF_CRM_1784359513'], ['501', 'title']]) {
      await expect(client.getDealItemField(id!, field!)).rejects.toMatchObject({ code: 'internal_error' });
    }
    expect(calls).toHaveLength(before);
    // crm.item.get reads Deals only, also through the generic call().
    for (const entityTypeId of [1, 3, 4, 31, 128, '2', undefined]) {
      await expect(client.call('crm.item.get', { entityTypeId, id: 501 })).rejects.toMatchObject({ code: 'internal_error' });
    }
    expect(calls).toHaveLength(before);
    answer = () => new Response(JSON.stringify(recorded));
    expect((await client.call('crm.item.get', { entityTypeId: 2, id: 501 })).result).toBeTruthy();
  });

  it('a read whose answer hides the field stops before any write (never read as empty)', async () => {
    const portal = mockPortal({ files: [11, 12] });
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('crm.item.get.json')) return new Response(JSON.stringify({ result: { item: { id: 501, title: 'x' } } }));
      return portal.fetchImpl(url, init);
    }) as typeof fetch;
    const { d, record } = deps({ ...portal, fetchImpl });
    await processIdProofCopyBatch(d);
    expect(record.complete).toHaveBeenCalledWith('retry', 'read_provider_bad_response', null);
    expect(record.markSending).not.toHaveBeenCalled();
    expect(portal.calls.some((c) => c.method === 'crm.item.update')).toBe(false);
  });

  it('the live case: a send whose read-back found the new file but could not read it is resolved by verify', async () => {
    // Live-like state: two prior files, ours added (id 101) by an earlier send.
    const portal = mockPortal({ files: [11, 12, 101], fileBytes: { 101: BYTES } });
    const { d, record } = deps(portal, { jobs: [job({ mode: 'verify', priorFileIds: [11, 12], attempts: 1 })] });
    expect(await processIdProofCopyBatch(d)).toMatchObject({ sent: 1, unknown: 0 });
    expect(record.complete).toHaveBeenCalledWith('sent', null, 101);
    // Never a second copy: no write at all.
    expect(portal.calls.map((c) => c.method)).toEqual(['crm.item.get', 'GET 101']);
  });

  it('no URL, token or credential reaches a log, a stored code, a completion or the summary', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    try {
      // A download that throws an error carrying the urlMachine link in its message.
      const throwing = mockPortal({ files: [11, 12, 60] });
      const throwingFetch = (async (url: string | URL, init?: RequestInit) => {
        if (String(url).includes('crm.controller.item.getFile')) throw new TypeError(`fetch failed: ${String(url)}`);
        return throwing.fetchImpl(url, init);
      }) as typeof fetch;
      for (const p of [mockPortal(), mockPortal({ noLinks: true, files: [11, 12, 60] }), { ...throwing, fetchImpl: throwingFetch }]) {
        const { d, record } = deps(p, { jobs: [job(), job({ mode: 'verify', priorFileIds: [11, 12] })] });
        const summary = await processIdProofCopyBatch(d);
        const stored = JSON.stringify([summary, record.complete.mock.calls, record.markSending.mock.calls, record.stop.mock.calls]);
        expect(stored).not.toMatch(/token|syntheticRead0001|syntheticWrite001|http|traveller-|getFile/);
      }
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
