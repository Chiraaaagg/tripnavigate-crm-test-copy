import { describe, expect, it } from 'vitest';
import { FILE_LINK_KEYS, FILE_MAX_REDIRECTS, NOT_A_FILE_CONTENT_TYPE } from '@/modules/integration/bitrix/id-proof-copy';
// @ts-expect-error -- plain .mjs script without type declarations
import * as probe from '../../scripts/dev/id-proof-copy-probe-check.mjs';

/**
 * B1.2 DEC-43: the lead's read-only probe check script with a mock portal
 * (stubbed fetch, synthetic base URL). It calls only crm.item.get (the
 * worker's read path since the 13 Oct 2026 live probe), keeps only the one
 * file field, sizes files through their urlMachine links on the portal host
 * (same-host redirects only), and prints ids, sizes and link status only.
 */

const BASE = 'https://synthetic.bitrix24.example/rest/1/syntheticRead0001/';
const machine = (id: number | string) => `${BASE}crm.controller.item.getFile/?token=syntheticFileToken&fileId=${id}`;

type FileSpec = { bytes?: number; html?: boolean; machine?: string | null; redirectTo?: string };

function portal(files: Record<number, FileSpec>, o: { item?: Record<string, unknown> | null; omitField?: boolean } = {}) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url.replace(BASE, '<base>/')}`);
    if (url === `${BASE}crm.item.get.json`) {
      bodies.push(JSON.parse(String(init?.body)));
      const item = o.item !== undefined
        ? o.item
        : {
            id: 501,
            title: 'Synthetic customer deal',
            opportunity: 123456,
            ...(o.omitField
              ? {}
              : {
                  ufCrm_1784359513: Object.entries(files).map(([id, f]) => ({
                    id: Number(id),
                    url: `https://synthetic.bitrix24.example/bitrix/services/main/ajax.php?action=crm.controller.item.getFile&fileId=${id}`,
                    ...(f.machine === null ? {} : { urlMachine: f.machine ?? machine(id) }),
                  })),
                }),
          };
      return new Response(JSON.stringify({ result: { item } }));
    }
    if (url.includes('ajax.php')) return new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
    if (url.startsWith('https://synthetic.bitrix24.example/')) {
      const id = Number(new URL(url).searchParams.get('fileId') ?? /\/upload\/(\d+)/.exec(url)?.[1]);
      const f = files[id];
      if (!f) return new Response('{}', { status: 404 });
      if (f.redirectTo && url.includes('getFile')) return new Response(null, { status: 302, headers: { location: f.redirectTo } });
      if (f.html) return new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
      return new Response(new Uint8Array(f.bytes ?? 10), { headers: { 'content-type': 'application/octet-stream' } });
    }
    return new Response('{}', { status: 404 });
  };
  return { calls, bodies, fetchImpl };
}

describe('id-proof-copy-probe-check (mock portal)', () => {
  it('reads only crm.item.get (Deal, camelCase), keeps only the file field, and sizes each file through urlMachine', async () => {
    const p = portal({ 11: { bytes: 100 }, 12: { bytes: 200 } });
    const state = await probe.readState(BASE, '501', p.fetchImpl);
    expect(state).toEqual({
      dealId: '501',
      count: 2,
      files: [
        { id: 11, link: 'usable', links: { urlMachine: 'usable' }, sizeBytes: 100 },
        { id: 12, link: 'usable', links: { urlMachine: 'usable' }, sizeBytes: 200 },
      ],
    });
    expect(p.calls[0]).toBe('POST <base>/crm.item.get.json');
    expect(p.bodies[0]).toEqual({ entityTypeId: 2, id: 501, useOriginalUfNames: 'N' });
    expect(p.calls.slice(1).every((c: string) => c.startsWith('GET <base>/crm.controller.item.getFile/'))).toBe(true);
    // The browser link is never fetched.
    expect(p.calls.some((c: string) => c.includes('ajax.php'))).toBe(false);
    const printed = probe.formatState(state);
    expect(printed).not.toMatch(/Synthetic customer|123456|token|https?:\/\//);
  });

  it('reports a login page, a foreign link or a missing urlMachine instead of a size', async () => {
    const p = portal({ 11: { html: true }, 12: { machine: 'https://elsewhere.example/files/12' }, 13: { machine: null } });
    const state = await probe.readState(BASE, '501', p.fetchImpl);
    expect(state.files.map((f: { links: { urlMachine: string } }) => f.links.urlMachine)).toEqual(['html', 'other_host', 'missing']);
    expect(state.files.every((f: { link: string; sizeBytes: number | null }) => f.link === 'not_usable' && f.sizeBytes === null)).toBe(true);
    expect(p.calls.some((c: string) => c.includes('elsewhere'))).toBe(false);
  });

  it('reports text, JSON and XML answers as not the file, like the worker', async () => {
    for (const type of ['text/plain', 'application/xml', 'text/xml; charset=utf-8', 'application/problem+json']) {
      const fetchImpl = async (url: string, init?: RequestInit) =>
        url.includes('getFile') ? new Response('x', { headers: { 'content-type': type } }) : portal({ 11: {} }).fetchImpl(url, init);
      const state = await probe.readState(BASE, '501', fetchImpl);
      expect(state.files[0], type).toEqual({ id: 11, link: 'not_usable', links: { urlMachine: 'html' }, sizeBytes: null });
    }
    expect(String(probe.NOT_A_FILE_CONTENT_TYPE)).toBe(String(NOT_A_FILE_CONTENT_TYPE));
  });

  it('follows same-host redirects only, like the worker', async () => {
    expect(probe.LINK_KEYS).toEqual([...FILE_LINK_KEYS]);
    expect(probe.MAX_REDIRECTS).toBe(FILE_MAX_REDIRECTS);
    const p = portal({ 21: { bytes: 300, redirectTo: '/upload/21' }, 22: { redirectTo: 'https://cdn.elsewhere.example/22' } });
    const state = await probe.readState(BASE, '501', p.fetchImpl);
    expect(state.files).toEqual([
      { id: 21, link: 'usable', links: { urlMachine: 'usable' }, sizeBytes: 300 },
      { id: 22, link: 'not_usable', links: { urlMachine: 'redirect_other_host' }, sizeBytes: null },
    ]);
    expect(p.calls.some((c: string) => c.includes('cdn.elsewhere'))).toBe(false);
  });

  it('refuses an answer that hides the field or is for another record (never read as empty)', async () => {
    await expect(probe.readState(BASE, '501', portal({}, { omitField: true }).fetchImpl)).rejects.toThrow(/does not show ufCrm_1784359513/);
    await expect(probe.readState(BASE, '501', portal({}, { item: { id: 502, ufCrm_1784359513: [] } }).fetchImpl)).rejects.toThrow(/another record/);
    await expect(probe.readState(BASE, '501', portal({}, { item: null }).fetchImpl)).rejects.toThrow(/crm\.item\.get: HTTP 200/);
  });

  it('compares before and after for probe a-c', () => {
    const before = { dealId: '501', count: 2, files: [{ id: 11, link: 'usable', sizeBytes: 100 }, { id: 12, link: 'usable', sizeBytes: 200 }] };
    const good = probe.compareStates(before, { ...before, count: 3, files: [...before.files, { id: 13, link: 'usable', sizeBytes: 300 }] });
    expect(good).toMatchObject({ a_prior_files_kept: true, b_exactly_one_added: true, c_new_file_recognisable: true });
    const lost = probe.compareStates(before, { dealId: '501', count: 1, files: [{ id: 13, link: 'usable', sizeBytes: 300 }] });
    expect(lost).toMatchObject({ a_prior_files_kept: false, lostIds: [11, 12] });
    const blind = probe.compareStates(before, { ...before, files: [...before.files, { id: 13, link: 'html', sizeBytes: null }] });
    expect(blind).toMatchObject({ b_exactly_one_added: true, c_new_file_recognisable: false });
    expect(probe.formatComparison(good)).toContain('(a) both earlier files still there, unchanged: YES');
  });

  it('refuses a bad Deal id before any call', async () => {
    const p = portal({});
    await expect(probe.readState(BASE, 'abc', p.fetchImpl)).rejects.toThrow(/--deal/);
    expect(p.calls).toHaveLength(0);
  });
});
