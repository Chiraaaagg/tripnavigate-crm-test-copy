import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { resolveBitrixRestTarget } from '@/modules/integration/bitrix/config';
import {
  FILE_WRITE_METHODS,
  FileStoreError,
  IDENTITY_BOX,
  allowedBoxes,
  assertAllowedBoxWrite,
  buildBoxAppendPayload,
  createBitrixFileReader,
  createBitrixFileWriter,
  neutralBoxFileName,
  type BoxEntry,
} from '@/modules/integration/bitrix/file-store';
import { BitrixWriteError } from '@/modules/integration/bitrix/id-proof-copy';

/**
 * S11 "files to Bitrix": the one adapter that names Bitrix methods
 * (file-store.ts). MOCK portal only: a stubbed fetch on synthetic loopback
 * webhooks; no real portal, no real credential, no Bitrix call.
 */

const PORTAL = 'synthetic.bitrix24.example';
const READ_BASE = 'http://127.0.0.1:1/rest/1/syntheticRead0001/';
const WRITE_BASE = 'http://127.0.0.1:1/rest/7/syntheticWrite001/';
const ORIGIN = 'http://127.0.0.1:1';
const ACCOUNTS_BOX = 'ufCrm_AccountsPapers';
const target = (base: string) => resolveBitrixRestTarget(base, PORTAL, 'local');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const BYTES = new TextEncoder().encode('synthetic accounts paper bytes');
const SHA = sha(BYTES);
const machineUrl = (id: number) => `${READ_BASE}crm.controller.item.getFile/?token=syntheticFileToken${id}&fileId=${id}`;

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function stub(route: Route) {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null; redirect: string | undefined }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null, redirect: init?.redirect });
    return route(u, init);
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fileRes = (bytes: Uint8Array, type = 'application/octet-stream') => new Response(Buffer.from(bytes), { headers: { 'content-type': type } });
const redirectRes = (location: string | null, status = 302) => new Response(null, { status, headers: location ? { location } : {} });
/** A fetch that only ends when aborted (timeout path). */
const hang: Route = (_url, init) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });

function item(o: { id?: number; boxes?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) {
  return {
    result: {
      item: {
        id: o.id ?? 501,
        title: 'Synthetic deal title',
        opportunity: 123456,
        ...(o.extra ?? {}),
        ...(o.boxes ?? { [IDENTITY_BOX]: [{ id: 11, url: '/bitrix/services/main/ajax.php', urlMachine: machineUrl(11) }], [ACCOUNTS_BOX]: [] }),
      },
    },
    time: { operating: 0.1 },
  };
}

const reader = (fetchImpl: typeof fetch, o: { readTimeoutMs?: number; downloadTimeoutMs?: number } = {}) =>
  createBitrixFileReader({ target: target(READ_BASE), fetchImpl, sleep: async () => undefined, ...o });

const entry = (id: number, raw: Record<string, unknown> | null = { id, urlMachine: machineUrl(id) }): BoxEntry => ({ id, raw });

describe('readBox: crm.item.get through the existing read client', () => {
  it('one crm.item.get on the READ webhook (Deal, item keys); only the asked box is kept', async () => {
    const s = stub(() => jsonRes(item({ boxes: { [IDENTITY_BOX]: [{ id: 12, urlMachine: machineUrl(12) }, { id: 11, urlMachine: machineUrl(11) }], [ACCOUNTS_BOX]: [{ id: 40 }] } })));
    const r = await reader(s.fetchImpl).readBox('501', IDENTITY_BOX);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({ url: `${READ_BASE}crm.item.get.json`, method: 'POST', redirect: 'error', body: { entityTypeId: 2, id: 501, useOriginalUfNames: 'N' } });
    expect(r).toEqual({ kind: 'ok', entries: [entry(11), entry(12)].map((e) => ({ id: e.id, raw: { id: e.id, urlMachine: machineUrl(e.id) } })) });
    expect(JSON.stringify(r)).not.toMatch(/Synthetic deal title|123456|"40"/);
  });

  it('an Accounts box key with letters is read (the client field helper accepts digits only)', async () => {
    const s = stub(() => jsonRes(item({ boxes: { [IDENTITY_BOX]: [], [ACCOUNTS_BOX]: [{ id: 40, urlMachine: machineUrl(40) }] } })));
    const r = await reader(s.fetchImpl).readBox('501', ACCOUNTS_BOX);
    expect(r).toEqual({ kind: 'ok', entries: [{ id: 40, raw: { id: 40, urlMachine: machineUrl(40) } }] });
  });

  it('an empty box (null, false, empty list) reads as no entries', async () => {
    for (const value of [null, false, '', []]) {
      const s = stub(() => jsonRes(item({ boxes: { [IDENTITY_BOX]: value } })));
      expect(await reader(s.fetchImpl).readBox('501', IDENTITY_BOX)).toEqual({ kind: 'ok', entries: [] });
    }
  });

  it('a missing box key is a bad answer, never an empty box; so is an answer for another Deal', async () => {
    const missing = stub(() => jsonRes(item({ boxes: { [ACCOUNTS_BOX]: [] } })));
    await expect(reader(missing.fetchImpl).readBox('501', IDENTITY_BOX)).rejects.toMatchObject({ kind: 'unavailable', code: 'bitrix_bad_response' });
    const other = stub(() => jsonRes(item({ id: 999 })));
    await expect(reader(other.fetchImpl).readBox('501', IDENTITY_BOX)).rejects.toMatchObject({ kind: 'unavailable', code: 'bitrix_bad_response' });
    const noItem = stub(() => jsonRes({ result: {} }));
    await expect(reader(noItem.fetchImpl).readBox('501', IDENTITY_BOX)).rejects.toBeInstanceOf(FileStoreError);
  });

  it('HTTP 400 NOT_FOUND is deal_not_found', async () => {
    const s = stub(() => jsonRes({ error: 'NOT_FOUND', error_description: 'Element not found' }, 400));
    expect(await reader(s.fetchImpl).readBox('501', IDENTITY_BOX)).toEqual({ kind: 'deal_not_found' });
  });

  it('rate limits, auth, outages and timeouts throw fixed codes after ONE attempt', async () => {
    const cases: Array<[Route, string, string]> = [
      [() => jsonRes({ error: 'QUERY_LIMIT_EXCEEDED' }, 503), 'rate_limited', 'bitrix_rate_limited'],
      [() => jsonRes({ error: 'OPERATION_TIME_LIMIT' }, 429), 'rate_limited', 'bitrix_rate_limited'],
      [() => jsonRes({ error: 'NO_AUTH_FOUND' }, 401), 'auth', 'bitrix_auth_failed'],
      [() => new Response('bad gateway', { status: 502 }), 'unavailable', 'bitrix_unavailable'],
      [() => Promise.reject(new TypeError('fetch failed')), 'unavailable', 'bitrix_unavailable'],
      [hang, 'unavailable', 'bitrix_timeout'],
    ];
    for (const [route, kind, code] of cases) {
      const s = stub(route);
      await expect(reader(s.fetchImpl, { readTimeoutMs: 5 }).readBox('501', IDENTITY_BOX)).rejects.toMatchObject({ kind, code });
      expect(s.calls).toHaveLength(1);
    }
  });

  it('a bad deal id or box key is refused before any call', async () => {
    const s = stub(() => jsonRes(item()));
    for (const [deal, box] of [['abc', IDENTITY_BOX], ['0', IDENTITY_BOX], ['501', 'UF_CRM_1784359513'], ['501', 'title'], ['501', 'ufCrm_a-b']]) {
      await expect(reader(s.fetchImpl).readBox(deal!, box!)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(s.calls).toHaveLength(0);
  });

  it('errors never carry the webhook, the portal host or Bitrix text', async () => {
    const s = stub(() => jsonRes({ error: 'ERROR_CORE', error_description: `synthetic ${READ_BASE} detail` }, 400));
    const error = await reader(s.fetchImpl).readBox('501', IDENTITY_BOX).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FileStoreError);
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(/syntheticRead0001|127\.0\.0\.1|ERROR_CORE|detail|501/);
  });
});

describe('downloadEntry: urlMachine only, same host, bytes hashed, never throws', () => {
  it('reads and hashes the bytes; a size Bitrix shows is never trusted', async () => {
    const s = stub(() => fileRes(BYTES));
    const r = await reader(s.fetchImpl).downloadEntry(entry(11, { id: 11, urlMachine: machineUrl(11), size: BYTES.byteLength, name: `acc-bank-${SHA.slice(0, 8)}.pdf` }), BYTES.byteLength);
    expect(r).toMatchObject({ kind: 'ok', sha256: SHA, sizeBytes: BYTES.byteLength });
    expect(s.calls).toEqual([expect.objectContaining({ url: machineUrl(11), method: 'GET', redirect: 'manual' })]);
    // A different file whose entry claims the expected size: the real size and hash come back.
    const other = new TextEncoder().encode('different bytes');
    const lie = stub(() => fileRes(other));
    const r2 = await reader(lie.fetchImpl).downloadEntry(entry(11, { id: 11, urlMachine: machineUrl(11), size: BYTES.byteLength }), BYTES.byteLength);
    expect(r2).toMatchObject({ kind: 'ok', sha256: sha(other), sizeBytes: other.byteLength });
  });

  it('no urlMachine (only the browser link, or nothing): no_link, nothing fetched', async () => {
    const s = stub(() => fileRes(BYTES));
    const rd = reader(s.fetchImpl);
    expect(await rd.downloadEntry(entry(11, { id: 11, url: '/bitrix/services/main/ajax.php?fileId=11' }), 100)).toEqual({ kind: 'unreadable', code: 'no_link' });
    expect(await rd.downloadEntry(entry(11, null), 100)).toEqual({ kind: 'unreadable', code: 'no_link' });
    expect(await rd.downloadEntry(entry(11, { urlMachine: 'x'.repeat(2001) }), 100)).toEqual({ kind: 'unreadable', code: 'no_link' });
    expect(s.calls).toHaveLength(0);
  });

  it('a link on another host is never fetched', async () => {
    const s = stub(() => fileRes(BYTES));
    expect(await reader(s.fetchImpl).downloadEntry(entry(11, { urlMachine: 'https://files.other.example/f?token=t' }), 100)).toEqual({ kind: 'unreadable', code: 'other_host' });
    expect(s.calls).toHaveLength(0);
  });

  it('a relative link resolves against the portal host', async () => {
    const s = stub(() => fileRes(BYTES));
    const r = await reader(s.fetchImpl).downloadEntry(entry(11, { urlMachine: '/rest/1/syntheticRead0001/crm.controller.item.getFile/?fileId=11' }), 1000);
    expect(r.kind).toBe('ok');
    expect(s.calls[0]!.url.startsWith(ORIGIN)).toBe(true);
  });

  it('same-host redirects are followed by hand (at most 3); a fourth, a missing location or another host ends unreadable', async () => {
    let hops = 0;
    const three = stub((u) => {
      if (u.includes('hop=') && hops >= 3) return fileRes(BYTES);
      hops += 1;
      return redirectRes(`${ORIGIN}/next?hop=${hops}`);
    });
    expect((await reader(three.fetchImpl).downloadEntry(entry(11), 1000)).kind).toBe('ok');
    expect(three.calls).toHaveLength(4);
    expect(three.calls.every((c) => c.redirect === 'manual')).toBe(true);

    const four = stub(() => redirectRes(`${ORIGIN}/again`));
    expect(await reader(four.fetchImpl).downloadEntry(entry(11), 1000)).toEqual({ kind: 'unreadable', code: 'redirect' });
    expect(four.calls).toHaveLength(4);

    const noLocation = stub(() => redirectRes(null));
    expect(await reader(noLocation.fetchImpl).downloadEntry(entry(11), 1000)).toEqual({ kind: 'unreadable', code: 'redirect' });

    const cross = stub((u) => (u.startsWith(ORIGIN) ? redirectRes('https://cdn.other.example/file') : fileRes(BYTES)));
    expect(await reader(cross.fetchImpl).downloadEntry(entry(11), 1000)).toEqual({ kind: 'unreadable', code: 'other_host' });
    expect(cross.calls.map((c) => c.url.startsWith(ORIGIN))).toEqual([true]);
  });

  it('text, HTML, JSON and XML answers are not a file', async () => {
    for (const type of ['text/html; charset=UTF-8', 'text/plain', 'application/json', 'application/xml', 'application/problem+json', 'image/svg+xml']) {
      const s = stub(() => fileRes(new TextEncoder().encode('<html>Authorization</html>'), type));
      expect(await reader(s.fetchImpl).downloadEntry(entry(11), 1000)).toEqual({ kind: 'unreadable', code: 'not_a_file' });
    }
  });

  it('more than maxBytes is too_large; exactly maxBytes is read', async () => {
    const s = stub(() => fileRes(BYTES));
    expect(await reader(s.fetchImpl).downloadEntry(entry(11), BYTES.byteLength - 1)).toEqual({ kind: 'unreadable', code: 'too_large' });
    expect((await reader(s.fetchImpl).downloadEntry(entry(11), BYTES.byteLength)).kind).toBe('ok');
  });

  it('HTTP errors, network failures and timeouts end unreadable without throwing', async () => {
    const notFound = stub(() => jsonRes({ error: 'NOT_FOUND' }, 404));
    expect(await reader(notFound.fetchImpl).downloadEntry(entry(11), 1000)).toEqual({ kind: 'unreadable', code: 'http_error' });
    const down = stub(() => Promise.reject(new TypeError('fetch failed')));
    expect(await reader(down.fetchImpl).downloadEntry(entry(11), 1000)).toEqual({ kind: 'unreadable', code: 'http_error' });
    const slow = stub(hang);
    expect(await reader(slow.fetchImpl, { downloadTimeoutMs: 5 }).downloadEntry(entry(11), 1000)).toEqual({ kind: 'unreadable', code: 'timeout' });
  });
});

describe('neutral names', () => {
  it('id-<sha8>.<ext> for identity papers, acc-<kind>-<sha8>.<ext> for Accounts papers; anything else refused', () => {
    expect(neutralBoxFileName('id', SHA, 'image/jpeg')).toBe(`id-${SHA.slice(0, 8)}.jpg`);
    expect(neutralBoxFileName('bank', SHA, 'application/pdf')).toBe(`acc-bank-${SHA.slice(0, 8)}.pdf`);
    expect(neutralBoxFileName('cn', SHA, 'image/webp')).toBe(`acc-cn-${SHA.slice(0, 8)}.webp`);
    expect(neutralBoxFileName('dpp', SHA, 'image/png')).toBe(`acc-dpp-${SHA.slice(0, 8)}.png`);
    expect(() => neutralBoxFileName('passport', SHA, 'image/jpeg')).toThrow(BitrixWriteError);
    expect(() => neutralBoxFileName('id', SHA, 'application/zip')).toThrow(BitrixWriteError);
    expect(() => neutralBoxFileName('id', 'not-a-hash', 'image/jpeg')).toThrow(BitrixWriteError);
  });
});

describe('the write: one method, Deal only, exactly one of two boxes, prior ids re-sent', () => {
  const name = `acc-bank-${SHA.slice(0, 8)}.pdf`;
  const idName = `id-${SHA.slice(0, 8)}.jpg`;
  const b64 = Buffer.from(BYTES).toString('base64');

  it('one write method only', () => {
    expect(FILE_WRITE_METHODS).toEqual(['crm.item.update']);
    // The adapter names exactly two Bitrix methods: the read and the write.
    const source = readFileSync(new URL('../../src/modules/integration/bitrix/file-store.ts', import.meta.url), 'utf8');
    expect([...new Set(source.match(/crm\.[a-z]+\.[a-zA-Z]+/g))].sort()).toEqual(['crm.item.get', 'crm.item.update']);
  });

  it('the allowlist holds the identity box and, when set and different, the Accounts box; never more', () => {
    expect(allowedBoxes(null)).toEqual([IDENTITY_BOX]);
    expect(allowedBoxes(ACCOUNTS_BOX)).toEqual([IDENTITY_BOX, ACCOUNTS_BOX]);
    expect(allowedBoxes(IDENTITY_BOX)).toEqual([IDENTITY_BOX]);
    expect(allowedBoxes('title')).toEqual([IDENTITY_BOX]);
  });

  it('sends crm.item.update on the WRITE webhook with every prior id kept and the new file last', async () => {
    const s = stub((_u, init) => {
      const body = JSON.parse(String(init?.body)) as { fields: Record<string, unknown[]> };
      const kept = (body.fields[ACCOUNTS_BOX] as Array<{ id?: number }>).filter((v) => !Array.isArray(v)).map((v) => ({ id: v.id }));
      return jsonRes({ result: { item: { id: 501, [ACCOUNTS_BOX]: [...kept, { id: 90 }] } } });
    });
    const w = createBitrixFileWriter({ target: target(WRITE_BASE), accountsBox: ACCOUNTS_BOX, fetchImpl: s.fetchImpl });
    const r = await w.appendToBox({ bitrixDealId: '501', box: ACCOUNTS_BOX, priorFileIds: [40, 41], fileName: name, base64: b64 });
    expect(r).toEqual({ replyFileIds: [40, 41, 90] });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({ url: `${WRITE_BASE}crm.item.update.json`, method: 'POST', redirect: 'error' });
    expect(s.calls[0]!.body).toEqual({ entityTypeId: 2, id: 501, fields: { [ACCOUNTS_BOX]: [{ id: 40 }, { id: 41 }, [name, b64]] } });
  });

  it('a third field, or the Accounts box while none is configured, is refused before any call', async () => {
    const s = stub(() => jsonRes({ result: { item: { id: 501 } } }));
    const identityOnly = createBitrixFileWriter({ target: target(WRITE_BASE), accountsBox: null, fetchImpl: s.fetchImpl });
    await expect(identityOnly.appendToBox({ bitrixDealId: '501', box: ACCOUNTS_BOX, priorFileIds: [], fileName: name, base64: b64 })).rejects.toMatchObject({ kind: 'refused', code: 'field_not_allowed' });
    const both = createBitrixFileWriter({ target: target(WRITE_BASE), accountsBox: ACCOUNTS_BOX, fetchImpl: s.fetchImpl });
    await expect(both.appendToBox({ bitrixDealId: '501', box: 'ufCrm_1111111111', priorFileIds: [], fileName: name, base64: b64 })).rejects.toMatchObject({ kind: 'refused', code: 'field_not_allowed' });
    // An identity name in the Accounts box (and the reverse) is refused too.
    await expect(both.appendToBox({ bitrixDealId: '501', box: ACCOUNTS_BOX, priorFileIds: [], fileName: idName, base64: b64 })).rejects.toMatchObject({ code: 'name_not_allowed' });
    await expect(both.appendToBox({ bitrixDealId: '501', box: IDENTITY_BOX, priorFileIds: [], fileName: name, base64: b64 })).rejects.toMatchObject({ code: 'name_not_allowed' });
    expect(s.calls).toHaveLength(0);
  });

  it('the body check refuses every other shape', () => {
    const boxes = [IDENTITY_BOX, ACCOUNTS_BOX];
    const ok = buildBoxAppendPayload('501', IDENTITY_BOX, [11], idName, b64);
    expect(() => assertAllowedBoxWrite('crm.item.update', ok, boxes)).not.toThrow();
    const bad: Array<[string, unknown, string]> = [
      ['crm.deal.update', ok, 'method_not_allowed'],
      ['crm.item.add', ok, 'method_not_allowed'],
      ['crm.item.update', { ...ok, entityTypeId: 1 }, 'entity_not_allowed'],
      ['crm.item.update', { ...ok, extra: 1 }, 'body_invalid'],
      ['crm.item.update', { ...ok, fields: { [IDENTITY_BOX]: [[idName, b64]], [ACCOUNTS_BOX]: [] } }, 'field_not_allowed'],
      ['crm.item.update', { ...ok, fields: { title: [[idName, b64]] } }, 'field_not_allowed'],
      ['crm.item.update', { ...ok, fields: { [IDENTITY_BOX]: [] } }, 'body_invalid'],
      ['crm.item.update', { ...ok, fields: { [IDENTITY_BOX]: [{ id: 11 }] } }, 'body_invalid'],
      ['crm.item.update', { ...ok, fields: { [IDENTITY_BOX]: [[idName, b64], { id: 11 }] } }, 'body_invalid'],
      ['crm.item.update', { ...ok, fields: { [IDENTITY_BOX]: [[idName, b64], [idName, b64]] } }, 'body_invalid'],
      ['crm.item.update', { ...ok, fields: { [IDENTITY_BOX]: [{ id: 11 }, { id: 11 }, [idName, b64]] } }, 'body_invalid'],
      ['crm.item.update', { ...ok, fields: { [IDENTITY_BOX]: [{ id: 11, name: 'x' }, [idName, b64]] } }, 'body_invalid'],
      ['crm.item.update', { ...ok, fields: { [IDENTITY_BOX]: [['passport-of-a-traveller.jpg', b64]] } }, 'name_not_allowed'],
      ['crm.item.update', { ...ok, fields: { [IDENTITY_BOX]: [[idName, 'not base64!']] } }, 'body_invalid'],
    ];
    const refusal = (fn: () => void) => {
      try {
        fn();
        return null;
      } catch (e) {
        return e instanceof BitrixWriteError ? `${e.kind}:${e.code}` : 'other';
      }
    };
    for (const [method, body, code] of bad) expect(refusal(() => assertAllowedBoxWrite(method, body, boxes)), `${method} ${code}`).toBe(`refused:${code}`);
    // An allowlist that is not "identity box first, at most one other" is refused.
    expect(refusal(() => assertAllowedBoxWrite('crm.item.update', ok, [IDENTITY_BOX, ACCOUNTS_BOX, 'ufCrm_3']))).toBe('refused:field_not_allowed');
    expect(refusal(() => assertAllowedBoxWrite('crm.item.update', ok, [ACCOUNTS_BOX]))).toBe('refused:field_not_allowed');
  });

  it('answers: lost (read back later), rate limited, auth, refused; never the URL or Bitrix text', async () => {
    const send = async (route: Route, timeoutMs = 1000) => {
      const s = stub(route);
      const w = createBitrixFileWriter({ target: target(WRITE_BASE), accountsBox: null, fetchImpl: s.fetchImpl, timeoutMs });
      return w.appendToBox({ bitrixDealId: '501', box: IDENTITY_BOX, priorFileIds: [11], fileName: idName, base64: b64 }).catch((e: unknown) => e);
    };
    const cases: Array<[Route, string, string, number?]> = [
      [() => Promise.reject(new TypeError('fetch failed')), 'lost', 'network'],
      [hang, 'lost', 'timeout', 5],
      [() => new Response('bad gateway', { status: 502 }), 'lost', 'http_server_error'],
      [() => new Response('not json', { status: 200 }), 'lost', 'http_unreadable'],
      [() => jsonRes({ result: {} }), 'lost', 'reply_unexpected'],
      [() => jsonRes({ result: { item: { id: 999 } } }), 'lost', 'reply_mismatch'],
      [() => jsonRes({ error: 'QUERY_LIMIT_EXCEEDED' }, 503), 'rate_limited', 'rate_limited'],
      [() => jsonRes({ error: 'OPERATION_TIME_LIMIT' }, 429), 'rate_limited', 'rate_limited'],
      [() => jsonRes({ error: 'ACCESS_DENIED' }, 403), 'auth', 'auth_failed'],
      [() => jsonRes({ error: 'ERROR_CORE', error_description: `synthetic ${WRITE_BASE}` }, 400), 'refused', 'bitrix_refused'],
    ];
    for (const [route, kind, code, t] of cases) {
      const e = await send(route, t);
      expect(e, code).toBeInstanceOf(BitrixWriteError);
      expect(e).toMatchObject({ kind, code });
      expect(String(e)).not.toMatch(/syntheticWrite001|127\.0\.0\.1|ERROR_CORE/);
    }
    // A reply without the box: unknown reply ids (the read-back decides).
    expect(await send(() => jsonRes({ result: { item: { id: 501 } } }))).toEqual({ replyFileIds: null });
  });
});
