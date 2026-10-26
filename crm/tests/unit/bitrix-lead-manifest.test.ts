import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expectOwnerOnlyMode } from '../helpers/file-mode';
import { describe, expect, it } from 'vitest';
import {
  assertPrivateOutputPath,
  buildManifest,
  istInterval,
  ManifestError,
  parseManifest,
  parseSourceCode,
  REPOSITORY_ROOT,
  selectLeadIds,
  selectionFilter,
  SOURCE_CODE,
} from '../../scripts/bitrix-lead-manifest.mjs';
import { createReadOnlyCaller, LEAD_SELECT } from '../../scripts/bitrix-pilot-inspect.mjs';
import { syntheticLead } from '../helpers/mock-bitrix';

/** scripts/bitrix-lead-manifest.mjs: read-only, complete, private Lead manifest selection. Mock fetch only. */

const SCRIPT = join(import.meta.dirname, '../../scripts/bitrix-lead-manifest.mjs');
const INTERVAL = { from: '2026-10-04T00:00:00+05:30', to: '2026-10-05T00:00:00+05:30' };

type Page = { result: unknown; total?: unknown; next?: unknown };
/** Fake read-only caller: answers crm.lead.list from a page script and records params. */
function fakeCaller(pages: Page[]) {
  const params: Array<Record<string, unknown>> = [];
  return {
    params,
    call: async (method: string, p: Record<string, unknown> = {}) => {
      expect(method).toBe('crm.lead.list');
      params.push(p);
      const page = pages[params.length - 1];
      if (!page) throw new Error('unexpected page');
      return page as Record<string, unknown>;
    },
  };
}
const row = (id: number, over: Record<string, unknown> = {}) => ({ ID: String(id), SOURCE_ID: 'WEBFORM', DATE_CREATE: '2026-10-04T10:00:00+05:30', ...over });
const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => row(from + i));

describe('istInterval / filter', () => {
  it('freezes the half-open Asia/Kolkata day, including month and year ends', () => {
    expect(istInterval('2026-10-04')).toEqual(INTERVAL);
    expect(istInterval('2026-12-31')).toEqual({ from: '2026-12-31T00:00:00+05:30', to: '2027-01-01T00:00:00+05:30' });
    expect(istInterval('2028-02-28').to).toBe('2028-02-29T00:00:00+05:30');
    for (const bad of ['2026-02-30', '2026-13-01', '04-10-2026', '2026-10-4', '', undefined, '2026-10-04T00:00']) {
      expect(() => istInterval(bad)).toThrow(ManifestError);
    }
  });
  it('builds the documented filter and validates the source code', () => {
    expect(selectionFilter(INTERVAL, 'WEBFORM')).toEqual({
      '>=DATE_CREATE': INTERVAL.from,
      '<DATE_CREATE': INTERVAL.to,
      '=SOURCE_ID': 'WEBFORM',
    });
    expect(parseSourceCode('WEBFORM')).toBe('WEBFORM');
    for (const bad of ['', 'web form', 'WEB;FORM', 'WEB/FORM', 'A'.repeat(51), undefined]) {
      expect(() => parseSourceCode(bad)).toThrow(ManifestError);
    }
    // Same rule as the database (migration 20261007000100): ^[A-Za-z0-9_:.-]{1,50}$.
    for (const ok of ['UC_ABC123', 'Call:1.web-form', 'A'.repeat(50)]) expect(parseSourceCode(ok)).toBe(ok);
    expect(SOURCE_CODE.source).toBe('^[A-Za-z0-9_:.-]{1,50}$');
    const migration = readFileSync(join(import.meta.dirname, '../../supabase/migrations/20261007000100_lead_intake_manifest.sql'), 'utf8');
    expect(migration).toContain("source_code ~ '^[A-Za-z0-9_:.-]{1,50}$'");
  });
});

describe('selectLeadIds', () => {
  it('reads ALL pages with minimal select and returns sorted IDs and counts', async () => {
    const caller = fakeCaller([
      { result: rows(1, 50), total: 120, next: 50 },
      { result: rows(51, 50), total: 120, next: 100 },
      { result: rows(101, 20), total: 120 },
    ]);
    const out = await selectLeadIds(caller, { interval: INTERVAL, sourceCode: 'WEBFORM' });
    expect(out.total).toBe(120);
    expect(out.pages).toBe(3);
    expect(out.ids).toHaveLength(120);
    expect(out.ids[0]).toBe('1');
    expect(out.ids[119]).toBe('120');
    expect(caller.params.map((p) => p.start)).toEqual([0, 50, 100]);
    for (const p of caller.params) {
      expect(p.select).toEqual(['ID', 'SOURCE_ID', 'DATE_CREATE']);
      expect(p.filter).toEqual(selectionFilter(INTERVAL, 'WEBFORM'));
      expect(p.order).toEqual({ ID: 'ASC' });
    }
  });

  it.each([
    ['partial page', [{ result: rows(1, 49), total: 60, next: 50 }]],
    ['total smaller than rows read', [{ result: rows(1, 3), total: 2 }]],
    ['total larger than rows read (no next)', [{ result: rows(1, 3), total: 4 }]],
    ['total changes between pages', [{ result: rows(1, 50), total: 60, next: 50 }, { result: rows(51, 10), total: 61 }]],
    ['missing total', [{ result: rows(1, 2) }]],
    ['next does not advance', [{ result: rows(1, 50), total: 100, next: 0 }]],
    ['non-list result', [{ result: { items: [] }, total: 0 }]],
    ['duplicate ID across pages', [{ result: rows(1, 50), total: 51, next: 50 }, { result: [row(50)], total: 51 }]],
    ['row from another source', [{ result: [row(1, { SOURCE_ID: 'CALL' })], total: 1 }]],
    ['row before the interval', [{ result: [row(1, { DATE_CREATE: '2026-10-03T23:59:59+05:30' })], total: 1 }]],
    ['row at the exclusive end', [{ result: [row(1, { DATE_CREATE: '2026-10-05T00:00:00+05:30' })], total: 1 }]],
    ['invalid ID', [{ result: [row(1, { ID: '0' })], total: 1 }]],
  ])('%s: stops with an error', async (_label, pages) => {
    await expect(selectLeadIds(fakeCaller(pages as Page[]), { interval: INTERVAL, sourceCode: 'WEBFORM' })).rejects.toBeInstanceOf(ManifestError);
  });

  it('a provider error stops the selection', async () => {
    const caller = { call: async () => { throw new Error('crm.lead.list: HTTP 500'); } };
    await expect(selectLeadIds(caller, { interval: INTERVAL, sourceCode: 'WEBFORM' })).rejects.toThrow();
  });

  it('the read-only caller never lets crm.lead.list select content fields', async () => {
    expect([...LEAD_SELECT]).toEqual(['ID', 'STATUS_ID', 'SOURCE_ID', 'ASSIGNED_BY_ID', 'DATE_CREATE', 'DATE_MODIFY']);
    const caller = createReadOnlyCaller('http://127.0.0.1:9/rest/1/x0000/', { minIntervalMs: 0 });
    for (const select of [['ID', 'TITLE'], ['ID', 'NAME'], ['ID', 'PHONE'], ['ID', 'EMAIL'], ['ID', 'COMMENTS'], []]) {
      await expect(caller.call('crm.lead.list', { select })).rejects.toThrow(/select outside/);
    }
    await expect(caller.call('crm.lead.add', {})).rejects.toThrow(/not allowed/);
  });
});

describe('parseManifest (full validation)', () => {
  const ids = ['3', '1', '2'];
  const good = () =>
    buildManifest({ portalDomain: 'synthetic-portal.example.test', memberId: 'SYNTHETIC_MEMBER_0001', businessDate: '2026-10-04', sourceCode: 'WEBFORM', interval: INTERVAL, filter: selectionFilter(INTERVAL, 'WEBFORM'), ids, selectedAt: '2026-10-04T10:36:20.000Z' });

  it('accepts a manifest built by the selection step', () => {
    expect(parseManifest(good(), { sourceObject: 'lead' })).toEqual({
      sourceObject: 'lead',
      portalDomain: 'synthetic-portal.example.test',
      memberId: 'SYNTHETIC_MEMBER_0001',
      businessDate: '2026-10-04',
      interval: INTERVAL,
      sourceCode: 'WEBFORM',
      expectedCount: 3,
      ids,
    });
  });

  it.each([
    ['count != expectedCount', (m: Record<string, unknown>) => ({ ...m, expectedCount: 4 })],
    ['duplicate id', (m: Record<string, unknown>) => ({ ...m, ids: ['1', '1', '2'] })],
    ['invalid id', (m: Record<string, unknown>) => ({ ...m, ids: ['1', '2', '0'] })],
    ['numeric id', (m: Record<string, unknown>) => ({ ...m, ids: [1, 2, 3] })],
    ['empty', (m: Record<string, unknown>) => ({ ...m, ids: [], expectedCount: 0 })],
    ['interval not the business date', (m: Record<string, unknown>) => ({ ...m, interval: { from: INTERVAL.from, to: '2026-10-06T00:00:00+05:30', bounds: '[)' } })],
    ['filter widened', (m: Record<string, unknown>) => ({ ...m, filter: { '>=DATE_CREATE': INTERVAL.from } })],
    ['other source code in filter', (m: Record<string, unknown>) => ({ ...m, sourceCode: 'CALL' })],
    ['extra field', (m: Record<string, unknown>) => ({ ...m, titles: ['x'] })],
    ['missing field', (m: Record<string, unknown>) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'selectedAt'))],
    ['wrong kind', (m: Record<string, unknown>) => ({ ...m, kind: 'other' })],
    ['wrong timezone', (m: Record<string, unknown>) => ({ ...m, timezone: 'UTC' })],
    ['legacy unbound manifest', (m: Record<string, unknown>) => ({ ...m, version: 1 })],
    ['portal URL instead of host', (m: Record<string, unknown>) => ({ ...m, portalDomain: 'https://synthetic-portal.example.test' })],
    ['invalid member ID', (m: Record<string, unknown>) => ({ ...m, memberId: 'member/name' })],
    ['missing portal identity', (m: Record<string, unknown>) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'memberId'))],
  ])('rejects %s', (_label, mutate) => {
    expect(() => parseManifest(mutate(good() as unknown as Record<string, unknown>))).toThrow(ManifestError);
  });

  it('rejects a manifest for the other source object', () => {
    expect(() => parseManifest(good(), { sourceObject: 'deal' })).toThrow(/not deal/);
  });
});

describe('assertPrivateOutputPath', () => {
  it('refuses paths inside the repository or any Git working tree, relative paths and existing files', () => {
    expect(() => assertPrivateOutputPath(join(REPOSITORY_ROOT, 'crm', 'manifest.json'))).toThrow(/inside the repository/);
    expect(() => assertPrivateOutputPath(join(REPOSITORY_ROOT, 'manifest.json'))).toThrow(/inside the repository/);
    expect(() => assertPrivateOutputPath('manifest.json')).toThrow(/absolute/);
    expect(() => assertPrivateOutputPath(undefined)).toThrow(/required/);
    const dir = mkdtempSync(join(tmpdir(), 'tripnavigate-manifest-path-'));
    try {
      expect(() => assertPrivateOutputPath(join(dir, 'missing-dir', 'm.json'))).toThrow(/does not exist/);
      mkdirSync(join(dir, 'other-repo', '.git'), { recursive: true });
      expect(() => assertPrivateOutputPath(join(dir, 'other-repo', 'm.json'))).toThrow(/Git working tree/);
      writeFileSync(join(dir, 'taken.json'), '{}');
      expect(() => assertPrivateOutputPath(join(dir, 'taken.json'))).toThrow(/overwrite/);
      expect(assertPrivateOutputPath(join(dir, 'ok.json'))).toMatch(/ok\.json$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CLI (mock fetch, synthetic credentials)', () => {
  const env = {
    NODE_ENV: 'test',
    BITRIX_WEBHOOK_BASE_URL: 'https://synthetic-portal.example.test/rest/1/synthetic_only_code/',
    BITRIX_MIN_INTERVAL_MS: '1',
  } as const;
  function runCli(dir: string, args: string[], answer: string) {
    const preload = join(dir, 'mock-fetch.mjs');
    writeFileSync(
      preload,
      `${answer}
      globalThis.fetch = async (input, init) => {
        const url = new URL(input);
        if (url.hostname !== 'synthetic-portal.example.test') throw new Error('Unexpected host: no network allowed');
        if (!url.pathname.endsWith('/crm.lead.list.json')) return Response.json({ error: 'ERROR_METHOD_NOT_FOUND' }, { status: 404 });
        return answer(JSON.parse(init.body));
      };`,
      { mode: 0o600 },
    );
    return spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, SCRIPT, ...args], { encoding: 'utf8', env });
  }
  const leads = Array.from({ length: 60 }, (_, i) => syntheticLead(i + 1));
  const pagedAnswer = `const leads = ${JSON.stringify(leads)};
    const answer = (body) => {
      const start = body.start ?? 0;
      const page = leads.slice(start, start + 50).map((l) => Object.fromEntries(body.select.map((k) => [k, l[k]])));
      return Response.json({ result: page, total: leads.length, ...(start + 50 < leads.length ? { next: start + 50 } : {}) });
    };`;

  it('writes a mode-600 manifest outside Git and prints counts only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripnavigate-manifest-cli-'));
    try {
      const out = join(dir, 'lead-manifest.json');
      const result = runCli(dir, ['--portal-domain', 'synthetic-portal.example.test', '--member-id', 'SYNTHETIC_MEMBER_0001', '--business-date', '2026-10-04', '--source-code', 'WEBFORM', '--out', out], pagedAnswer);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('selected 60 leads (total 60, pages 2)');
      for (const text of [result.stdout, readFileSync(out, 'utf8')]) {
        expect(text).not.toMatch(/Synthetic enquiry|Synthetic Person|\+10000000000|synthetic@example\.test|synthetic_only_code/);
      }
      expectOwnerOnlyMode(statSync(out).mode);
      const manifest = parseManifest(JSON.parse(readFileSync(out, 'utf8')), { sourceObject: 'lead' });
      expect(manifest.expectedCount).toBe(60);
      expect(manifest.interval).toEqual(INTERVAL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a partial page or provider error exits 1 and writes nothing', () => {
    for (const answer of [
      `const answer = () => Response.json({ result: [], total: 5 });`,
      `const answer = () => Response.json({ error: 'INTERNAL_SERVER_ERROR', error_description: 'x' }, { status: 500 });`,
    ]) {
      const dir = mkdtempSync(join(tmpdir(), 'tripnavigate-manifest-cli-'));
      try {
        const out = join(dir, 'lead-manifest.json');
        const result = runCli(dir, ['--portal-domain', 'synthetic-portal.example.test', '--member-id', 'SYNTHETIC_MEMBER_0001', '--business-date', '2026-10-04', '--source-code', 'WEBFORM', '--out', out], answer);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(/^bitrix-lead-manifest: /);
        expect(result.stderr).not.toContain('synthetic_only_code');
        expect(existsSync(out)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('refuses an output path inside the repository before any network call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripnavigate-manifest-cli-'));
    try {
      const inside = join(REPOSITORY_ROOT, 'crm', 'lead-manifest-should-not-exist.json');
      const result = runCli(dir, ['--portal-domain', 'synthetic-portal.example.test', '--member-id', 'SYNTHETIC_MEMBER_0001', '--business-date', '2026-10-04', '--source-code', 'WEBFORM', '--out', inside], `const answer = () => { throw new Error('network called'); };`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('inside the repository');
      expect(existsSync(inside)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires independently verified member identity before any provider call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripnavigate-manifest-cli-'));
    try {
      const out = join(dir, 'lead-manifest.json');
      const result = runCli(dir, ['--portal-domain', 'synthetic-portal.example.test', '--business-date', '2026-10-04', '--source-code', 'WEBFORM', '--out', out], `const answer = () => { throw new Error('network called'); };`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--member-id <verified portal member id> is required');
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
