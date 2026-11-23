import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildManifest, selectionFilter } from '../../scripts/bitrix-lead-manifest.mjs';
import {
  checkActiveManifest,
  ComparatorError,
  compareDeals,
  compareLeads,
  coverage,
  loadExpected,
  pageIds,
  parseApprovedIds,
  summarize,
} from '../../scripts/bitrix-pilot-compare.mjs';
import { createReadOnlyCaller } from '../../scripts/bitrix-pilot-inspect.mjs';
import { syntheticDeal, syntheticLead } from '../helpers/mock-bitrix';

// Most tests here run the real CLI in child Node processes (up to four per
// test). Each start costs about 1-3 s on Windows (measured), so several
// exceed the 5 s default there; on Linux CI they take well under a second.
// A hang still fails at this limit.
vi.setConfig({ testTimeout: 30_000 });

/** scripts/bitrix-pilot-compare.mjs: field-by-field verdicts, titles never output. */

const OWNER = '00000000-0000-4000-8000-000000000501';
const BRANCH = '00000000-0000-4000-8000-0000000000b1';
const ENTITY = '00000000-0000-4000-8000-0000000000e1';
const config = {
  id: '00000000-0000-4000-8000-0000000000cc',
  portal_member_id: 'SYNTHETIC_MEMBER_0001',
  category_id: 7,
  eligible_stage_ids: ['C7:WON'],
  cutoff_at: '2026-10-01T00:00:00+05:30',
  pilot_branch_id: BRANCH,
  pilot_legal_entity_id: ENTITY,
};
const crmDeal = (id: number, over: Record<string, unknown> = {}) => ({
  source_deal_id: id,
  reference: `BX-${id}`,
  title: `Synthetic trip ${id}`,
  owner_user_id: OWNER,
  branch_id: BRANCH,
  legal_entity_id: ENTITY,
  is_synthetic: false,
  source_stage_id: 'C7:WON',
  source_category_id: 7,
  source_created_at: '2026-10-05T04:30:00+00:00',
  source_modified_at: '2026-10-05T04:30:00+00:00',
  last_synced_at: '2026-10-05T04:31:00+00:00',
  last_verified_at: '2026-10-05T04:31:00+00:00',
  ...over,
});
const mappings = [{ bitrix_user_id: 501, staff_user_id: OWNER, active: true }];

describe('compareDeals', () => {
  it('matches an imported deal field by field (timestamps compared as instants)', () => {
    const [r] = compareDeals(['1'], [syntheticDeal(1)], { deals: [crmDeal(1)], mappings, inbox: [{ source_deal_id: 1, status: 'processed' }], config });
    expect(r!.verdict).toBe('match');
    expect(Object.values(r!.checks!).every(Boolean)).toBe(true);
    expect(r!.inbox).toEqual([{ status: 'processed', reasonCode: null, origin: null }]);
  });

  it('flags mismatches, missing rows and lagging CRM; never outputs titles', () => {
    const rows = compareDeals(
      ['1', '2', '3', '4'],
      [
        syntheticDeal(1, { TITLE: 'Changed synthetic title' }),
        syntheticDeal(2),
        syntheticDeal(3, { DATE_MODIFY: '2026-10-06T10:00:00+05:30' }),
      ],
      { deals: [crmDeal(1), crmDeal(3)], mappings, inbox: [], config },
    );
    expect(rows.map((r) => r.verdict)).toEqual(['mismatch', 'expected_but_missing_in_crm', 'crm_behind_bitrix', 'missing_in_bitrix']);
    expect(rows[0]!.checks!.title).toBe(false);
    const text = JSON.stringify(rows);
    expect(text).not.toContain('Synthetic trip');
    expect(text).not.toContain('Changed synthetic title');
    expect(text).not.toContain('99999');
  });

  it('owner check uses the active mapping only', () => {
    const [r] = compareDeals(['1'], [syntheticDeal(1)], {
      deals: [crmDeal(1)],
      mappings: [{ bitrix_user_id: 501, staff_user_id: OWNER, active: false }],
      inbox: [],
      config,
    });
    expect(r!.checks!.owner).toBe(false);
  });
});

describe('Phase 5 pilot checks', () => {
  it('reference must be BX-<bitrix id>', () => {
    const [r] = compareDeals(['1'], [syntheticDeal(1)], { deals: [crmDeal(1, { reference: 'BX-1-2' })], mappings, inbox: [], config });
    expect(r!.checks!.reference).toBe(false);
    expect(r!.verdict).toBe('mismatch');
  });

  it('an eligible deal held for review is needs_review with its reason codes, and ownerMapped is reported', () => {
    const [r] = compareDeals(['1'], [syntheticDeal(1, { ASSIGNED_BY_ID: '777' })], {
      deals: [],
      mappings,
      inbox: [{ source_deal_id: 1, status: 'needs_review', reason_code: 'unmapped_owner', origin: 'event' }],
      config,
    });
    expect(r).toMatchObject({ verdict: 'needs_review', reviewReasons: ['unmapped_owner'], ownerMapped: false });
  });

  it('more than one CRM row for one Bitrix deal is duplicate_in_crm and fails the summary', () => {
    const rows = compareDeals(['1', '2'], [syntheticDeal(1), syntheticDeal(2)], {
      deals: [crmDeal(1), crmDeal(1), crmDeal(2)],
      mappings,
      inbox: [],
      config,
    });
    expect(rows.map((r) => r.verdict)).toEqual(['duplicate_in_crm', 'match']);
    expect(rows[0]!.crmRows).toBe(2);
    expect(summarize(rows, ['1', '2'])).toEqual({ total: 2, byVerdict: { duplicate_in_crm: 1, match: 1 }, pass: false });
  });

  it('negative outcomes do not count toward positive pilot success', () => {
    const rows = compareDeals(['1', '2'], [syntheticDeal(1), syntheticDeal(2, { STAGE_ID: 'C7:LOSE' })], {
      deals: [crmDeal(1)],
      mappings,
      inbox: [{ source_deal_id: 2, status: 'ignored', reason_code: 'not_eligible_stage' }],
      config,
    });
    expect(rows.map((r) => r.verdict)).toEqual(['match', 'not_imported_as_expected']);
    expect(summarize(rows, ['1', '2']).pass).toBe(false);
  });
});

describe('TITLE select', () => {
  it('is refused unless the caller opted in for comparison', async () => {
    const plain = createReadOnlyCaller('http://127.0.0.1:9/rest/1/x0000/', { minIntervalMs: 0 });
    await expect(plain.call('crm.deal.list', { select: ['ID', 'TITLE'] })).rejects.toThrow(/select outside/);
    const titled = createReadOnlyCaller('http://127.0.0.1:9/rest/1/x0000/', { minIntervalMs: 0, allowTitle: true });
    await expect(titled.call('crm.deal.list', { select: ['ID', 'TITLE', 'COMMENTS'] })).rejects.toThrow(/select outside/);
  });
});

describe('approved pilot completeness', () => {
  const approved = ['1', '2', '3', '4', '5'];
  const matched = () => compareDeals(approved, approved.map((id) => syntheticDeal(Number(id))), {
    deals: approved.map((id) => crmDeal(Number(id))), mappings, inbox: [], config,
  });
  it('five approved deals with only three matches fail', () => {
    expect(summarize(matched().slice(0, 3), approved).pass).toBe(false);
  });
  it('every approved eligible deal matching once passes, regardless of order', () => {
    expect(summarize(matched().reverse(), approved).pass).toBe(true);
  });
  it('empty, incomplete, unexpected and duplicate comparisons fail', () => {
    expect(summarize([], approved).pass).toBe(false);
    expect(summarize([], []).pass).toBe(false);
    expect(summarize(matched(), []).pass).toBe(false);
    expect(summarize(matched().concat(matched()[0]!), approved).pass).toBe(false);
    expect(summarize(matched().map((row, i) => i === 4 ? { ...row, id: '99' } : row), approved).pass).toBe(false);
    expect(summarize(matched().map((row, i) => i === 4 ? { ...row, id: '1' } : row), approved).pass).toBe(false);
  });
  it('review, ineligible and unknown verdicts fail even alongside three matches', () => {
    for (const verdict of ['needs_review', 'not_imported_as_expected', 'expected_but_missing_in_crm'] as const) {
      expect(summarize(matched().map((row, i) => i === 4 ? { ...row, verdict } : row), approved).pass).toBe(false);
    }
    expect(summarize(matched().map((row, i) => i === 4 ? { ...row, eligibleByConfig: false } : row), approved).pass).toBe(false);
    expect(summarize(matched().map((row, i) => i === 4 ? { ...row, ownerMapped: false } : row), approved).pass).toBe(false);
  });
  it('owner approval list rejects empty, duplicate, invalid and oversized input', () => {
    for (const value of [undefined, [], ['1', '1'], ['0'], [1], ['abc'], Array.from({ length: 51 }, (_, i) => String(i + 1))]) {
      expect(() => parseApprovedIds(value)).toThrow();
    }
    expect(parseApprovedIds(approved)).toEqual(approved);
  });
});

describe('pilot CLI approved list', () => {
  it('refuses a reduced --ids list before any credentials or network call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripnavigate-pilot-test-'));
    try {
      const file = join(dir, 'approved.json');
      writeFileSync(file, JSON.stringify(['1', '2', '3', '4', '5']), { mode: 0o600 });
      const result = spawnSync(process.execPath, [
        join(import.meta.dirname, '../../scripts/bitrix-pilot-compare.mjs'),
        '--member-id', 'SYNTHETIC_MEMBER_0001', '--approved-ids-file', file, '--ids', '1,2,3',
      ], { encoding: 'utf8', env: { NODE_ENV: 'test' } });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--ids must contain every approved ID exactly once');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('requires the independent approval file instead of trusting --ids', () => {
    const result = spawnSync(process.execPath, [
      join(import.meta.dirname, '../../scripts/bitrix-pilot-compare.mjs'),
      '--member-id', 'SYNTHETIC_MEMBER_0001', '--ids', '1,2,3',
    ], { encoding: 'utf8', env: { NODE_ENV: 'test' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--approved-ids-file is required');
  });
});

describe('pilot CLI result and exit status (mock fetch only)', () => {
  it.each([true, false])('complete=%s: output file and process status agree', (complete) => {
    const dir = mkdtempSync(join(tmpdir(), 'tripnavigate-pilot-result-'));
    try {
      const file = join(dir, 'approved.json');
      const out = join(dir, 'result.json');
      const preload = join(dir, 'mock-fetch.mjs');
      const approved = ['1', '2', '3'];
      writeFileSync(file, JSON.stringify(approved), { mode: 0o600 });
      const responses = {
        config: [{ ...config, portal_domain: 'synthetic-portal.example.test' }],
        bitrix: { result: approved.map((id) => syntheticDeal(Number(id))) },
        deals: approved.slice(0, complete ? 3 : 2).map((id) => crmDeal(Number(id))), mappings,
      };
      writeFileSync(preload, `const data = ${JSON.stringify(responses)};
        globalThis.fetch = async (input) => {
          const url = new URL(input);
          if (url.hostname === 'synthetic-portal.example.test' && url.pathname.endsWith('/crm.deal.list.json')) return Response.json(data.bitrix);
          if (url.hostname !== 'synthetic-project.example.test') throw new Error('Unexpected host: no network allowed');
          if (url.pathname.endsWith('/integration_intake_config')) return Response.json(data.config);
          if (url.pathname.endsWith('/deals')) return Response.json(data.deals);
          if (url.pathname.endsWith('/bitrix_user_mappings')) return Response.json(data.mappings);
          if (url.pathname.endsWith('/integration_inbox')) return Response.json([]);
          throw new Error('Unexpected mock request');
        };`, { mode: 0o600 });
      const result = spawnSync(process.execPath, [
        '--import', pathToFileURL(preload).href, join(import.meta.dirname, '../../scripts/bitrix-pilot-compare.mjs'),
        '--member-id', 'SYNTHETIC_MEMBER_0001', '--approved-ids-file', file, '--out', out,
      ], { encoding: 'utf8', env: {
        NODE_ENV: 'test',
        BITRIX_WEBHOOK_BASE_URL: 'https://synthetic-portal.example.test/rest/1/synthetic_only_code/',
        SUPABASE_URL: 'https://synthetic-project.example.test',
        SUPABASE_SECRET_KEY: 'synthetic-only-not-a-real-key',
      } });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(complete ? 0 : 1);
      expect(JSON.parse(readFileSync(out, 'utf8')).summary.pass).toBe(complete);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// Phase 6: real CLI failure cases (L3), comparator error prefix (L4),
// --object lead, manifest input and bounded pages with aggregate coverage.
// ---------------------------------------------------------------------------

const COMPARE = join(import.meta.dirname, '../../scripts/bitrix-pilot-compare.mjs');
const CLI_ENV = {
  NODE_ENV: 'test',
  BITRIX_WEBHOOK_BASE_URL: 'https://synthetic-portal.example.test/rest/1/synthetic_only_code/',
  SUPABASE_URL: 'https://synthetic-project.example.test',
  SUPABASE_SECRET_KEY: 'synthetic-only-not-a-real-key',
} as const;
const INTERVAL = { from: '2026-10-04T00:00:00+05:30', to: '2026-10-05T00:00:00+05:30' };
const crmLead = (id: number, over: Record<string, unknown> = {}) => ({
  source_lead_id: id,
  reference: `BXL-${id}`,
  title: `Synthetic enquiry ${id}`,
  owner_user_id: OWNER,
  branch_id: BRANCH,
  legal_entity_id: ENTITY,
  source_status_id: 'NEW',
  source_id_code: 'WEBFORM',
  source_created_at: '2026-10-04T04:30:00+00:00',
  source_modified_at: '2026-10-04T04:30:00+00:00',
  last_synced_at: '2026-10-04T04:31:00+00:00',
  last_verified_at: '2026-10-04T04:31:00+00:00',
  ...over,
});
const leadManifestFile = (ids: string[], over: Record<string, unknown> = {}) =>
  buildManifest({
    portalDomain: 'synthetic-portal.example.test',
    memberId: 'SYNTHETIC_MEMBER_0001',
    businessDate: '2026-10-04',
    sourceCode: 'WEBFORM',
    interval: INTERVAL,
    filter: selectionFilter(INTERVAL, 'WEBFORM'),
    ids,
    selectedAt: '2026-10-04T10:36:20.000Z',
    ...over,
  });

/**
 * Runs the real CLI with a preloaded mock fetch. `crm` answers by table name;
 * `bitrixLeads`/`bitrixDeals` answer the '@ID' list per page. Records request
 * paths into `<dir>/requests.json` is not needed: the mock counts pages itself.
 */
function runCompare(
  dir: string,
  args: string[],
  data: {
    bitrixDeals?: unknown[];
    bitrixLeads?: unknown[];
    crm?: Record<string, unknown>;
    crmStatus?: Record<string, number>;
    activeManifest?: unknown;
  },
  envOverrides: Record<string, string> = {},
) {
  const preload = join(dir, 'mock-fetch.mjs');
  writeFileSync(
    preload,
    `import { writeFileSync } from 'node:fs';
    const requests = [];
    const requestsFile = ${JSON.stringify(join(dir, 'requests.json'))};
    writeFileSync(requestsFile, '[]');
    const data = ${JSON.stringify({ config: [{ ...config, portal_domain: 'synthetic-portal.example.test' }], mappings, ...data })};
    globalThis.__pages = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(input);
      requests.push(url.hostname + ':' + url.pathname.split('/').pop());
      writeFileSync(requestsFile, JSON.stringify(requests));
      if (url.hostname === 'synthetic-portal.example.test') {
        const body = JSON.parse(init.body);
        const ids = body.filter['@ID'];
        if (!Array.isArray(ids) || ids.length > 50) return Response.json({ error: 'TOO_MANY' }, { status: 400 });
        const source = url.pathname.endsWith('/crm.lead.list.json') ? data.bitrixLeads : url.pathname.endsWith('/crm.deal.list.json') ? data.bitrixDeals : null;
        if (!source) return Response.json({ error: 'ERROR_METHOD_NOT_FOUND' }, { status: 404 });
        return Response.json({ result: source.filter((r) => ids.includes(String(r.ID))), total: ids.length });
      }
      if (url.hostname !== 'synthetic-project.example.test') throw new Error('Unexpected host: no network allowed');
      const table = url.pathname.split('/').pop();
      if (url.pathname.endsWith('/rpc/integration_active_manifest')) {
        if (init.method !== 'POST') return new Response('{}', { status: 405 });
        return Response.json(data.activeManifest ?? null);
      }
      if ((data.crmStatus ?? {})[table]) return new Response('{"message":"boom"}', { status: data.crmStatus[table] });
      if (table === 'integration_intake_config') return Response.json(data.config);
      if (table === 'bitrix_user_mappings') return Response.json(data.mappings);
      if (table === 'integration_inbox') return Response.json([]);
      const idParam = [...url.searchParams.entries()].find(([k]) => k === 'source_deal_id' || k === 'source_lead_id');
      const wanted = idParam ? idParam[1].replace(/^in\\.\\(|\\)$/g, '').split(',') : [];
      const rows = (data.crm ?? {})[table] ?? [];
      return Response.json(rows.filter((r) => wanted.includes(String(r.source_deal_id ?? r.source_lead_id))));
    };`,
    { mode: 0o600 },
  );
  return spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, COMPARE, '--member-id', 'SYNTHETIC_MEMBER_0001', ...args], {
    encoding: 'utf8',
    env: { ...CLI_ENV, BITRIX_MIN_INTERVAL_MS: '0', ...envOverrides },
  });
}

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'tripnavigate-compare-p6-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('L3: real CLI failures exit 1 with no successful output', () => {
  const approved = ['1', '2', '3'];
  const setup = (dir: string) => {
    const file = join(dir, 'approved.json');
    writeFileSync(file, JSON.stringify(approved), { mode: 0o600 });
    return { file, out: join(dir, 'result.json') };
  };
  const deals = { bitrixDeals: approved.map((id) => syntheticDeal(Number(id))), crm: { deals: approved.map((id) => crmDeal(Number(id))) } };

  it.each([
    ['superset --ids', '1,2,3,4'],
    ['duplicate --ids', '1,2,3,3'],
    ['duplicate --ids of the same length', '1,2,2'],
  ])('%s', (_label, ids) => {
    withDir((dir) => {
      const { file, out } = setup(dir);
      const result = runCompare(dir, ['--approved-ids-file', file, '--ids', ids, '--out', out], deals);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim()).toBe('bitrix-pilot-compare: --ids must contain every approved ID exactly once; run negative checks separately');
      expect(existsSync(out)).toBe(false);
    });
  });

  it('CRM HTTP 500 exits 1, writes no result and prints only the prefixed fixed message', () => {
    for (const table of ['integration_intake_config', 'bitrix_user_mappings', 'deals', 'integration_inbox']) {
      withDir((dir) => {
        const { file, out } = setup(dir);
        const result = runCompare(dir, ['--approved-ids-file', file, '--out', out], { ...deals, crmStatus: { [table]: 500 } });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr.trim()).toBe('bitrix-pilot-compare: CRM read failed: HTTP 500');
        expect(existsSync(out)).toBe(false);
      });
    }
  });
});

describe('L4: comparator errors carry the bitrix-pilot-compare prefix, credentials redacted', () => {
  it('Bitrix provider failures are re-prefixed and never show the webhook path or keys', () => {
    withDir((dir) => {
      const file = join(dir, 'approved.json');
      writeFileSync(file, JSON.stringify(['1']), { mode: 0o600 });
      const result = runCompare(dir, ['--approved-ids-file', file], { bitrixDeals: undefined });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/^bitrix-pilot-compare: crm\.deal\.list: HTTP 404/);
      expect(result.stderr).not.toContain('bitrix-pilot-inspect:');
      expect(result.stderr).not.toContain('synthetic_only_code');
      expect(result.stderr).not.toContain('synthetic-only-not-a-real-key');
    });
  });
  it('argument and file errors use the same prefix', () => {
    withDir((dir) => {
      for (const [args, message] of [
        [['--object', 'contact'], '--object must be lead or deal'],
        [['--object', 'lead', '--approved-ids-file', join(dir, 'x.json')], '--object lead requires --manifest-file'],
        [['--manifest-file', join(dir, 'missing.json')], 'cannot read the manifest file'],
      ] as const) {
        const result = runCompare(dir, [...args], {});
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`bitrix-pilot-compare: ${message}`);
      }
    });
  });
  it('ComparatorError is its own class with a fixed prefix', () => {
    const e = new ComparatorError('x');
    expect(e.message).toBe('bitrix-pilot-compare: x');
    expect(e.name).toBe('ComparatorError');
    expect(() => parseApprovedIds([])).toThrow(/^bitrix-pilot-compare: /);
  });
});

describe('compareLeads', () => {
  const manifest = { interval: INTERVAL, sourceCode: 'WEBFORM' };
  const lead = (id: number, over: Record<string, unknown> = {}) => syntheticLead(id, { DATE_CREATE: '2026-10-04T10:00:00+05:30', DATE_MODIFY: '2026-10-04T10:00:00+05:30', ...over });

  it('matches field by field, BXL reference, never outputs titles or contact fields', () => {
    const [r] = compareLeads(['1'], [lead(1)], { leads: [crmLead(1)], mappings, inbox: [], config, manifest });
    expect(r!.verdict).toBe('match');
    expect(r!.eligibleByConfig).toBe(true);
    expect(Object.values(r!.checks!).every(Boolean)).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/Synthetic enquiry|Synthetic Person|\+10000000000|synthetic@example\.test/);
  });

  it('source code, interval, reference and status differences fail', () => {
    const rows = compareLeads(
      ['1', '2', '3', '4'],
      [lead(1, { SOURCE_ID: 'CALL' }), lead(2, { DATE_CREATE: '2026-10-05T00:00:00+05:30' }), lead(3), lead(4, { STATUS_ID: 'IN_PROCESS' })],
      {
        leads: [crmLead(1, { source_id_code: 'CALL' }), crmLead(2, { source_created_at: '2026-10-04T18:30:00+00:00' }), crmLead(3, { reference: 'BX-3' }), crmLead(4)],
        mappings,
        inbox: [],
        config,
        manifest,
      },
    );
    expect(rows.map((r) => r.verdict)).toEqual(['mismatch', 'mismatch', 'mismatch', 'mismatch']);
    expect(rows[0]!.checks!.sourceCode).toBe(false);
    expect(rows[1]!.checks!.inManifestScope).toBe(false);
    expect(rows[2]!.checks!.reference).toBe(false);
    expect(rows[3]!.checks!.status).toBe(false);
  });

  it('missing, review and duplicate rows', () => {
    const rows = compareLeads(['1', '2', '3', '4'], [lead(1), lead(2, { ASSIGNED_BY_ID: '777' }), lead(4)], {
      leads: [crmLead(4), crmLead(4)],
      mappings,
      inbox: [{ source_deal_id: 2, status: 'needs_review', reason_code: 'unmapped_owner' }],
      config,
      manifest,
    });
    expect(rows.map((r) => r.verdict)).toEqual(['expected_but_missing_in_crm', 'needs_review', 'missing_in_bitrix', 'duplicate_in_crm']);
  });
});

describe('bounded pages and aggregate coverage', () => {
  it('pages hold at most 50 IDs', () => {
    const ids = Array.from({ length: 120 }, (_, i) => String(i + 1));
    expect(pageIds(ids).map((p) => p.length)).toEqual([50, 50, 20]);
    expect(() => pageIds(ids, 51)).toThrow(ComparatorError);
  });
  it('coverage is complete only when every expected ID appears exactly once across pages', () => {
    const r = (id: string) => ({ id }) as never;
    expect(coverage([[r('1'), r('2')], [r('3')]], ['1', '2', '3']).complete).toBe(true);
    expect(coverage([[r('1'), r('2')]], ['1', '2', '3'])).toMatchObject({ complete: false, missing: 1 });
    expect(coverage([[r('1'), r('2')], [r('2'), r('3')]], ['1', '2', '3'])).toMatchObject({ complete: false, repeated: 1 });
    expect(coverage([[r('1'), r('9')]], ['1'])).toMatchObject({ complete: false, unexpected: 1 });
  });
  it('loadExpected validates the whole manifest file', () => {
    const files: Record<string, string> = {
      good: JSON.stringify(leadManifestFile(['1', '2'])),
      short: JSON.stringify({ ...leadManifestFile(['1', '2']), expectedCount: 3 }),
    };
    expect(loadExpected({ object: 'lead', manifestFile: 'good', readFile: (f) => files[f]! }).ids).toEqual(['1', '2']);
    expect(() => loadExpected({ object: 'lead', manifestFile: 'short', readFile: (f) => files[f]! })).toThrow(/expectedCount/);
    expect(() => loadExpected({ object: 'deal', manifestFile: 'good', readFile: (f) => files[f]! })).toThrow(/not deal/);
    expect(() => loadExpected({ object: 'lead', approvedFile: 'a', manifestFile: 'good', readFile: (f) => files[f]! })).toThrow(/not both/);
  });
});

describe('CLI --object lead with a manifest of more than 50 IDs', () => {
  const ids = Array.from({ length: 60 }, (_, i) => String(i + 1));
  const bitrixLeads = ids.map((id) => syntheticLead(Number(id)));

  it('passes only when every manifest ID matches once across all pages', () => {
    withDir((dir) => {
      const file = join(dir, 'manifest.json');
      writeFileSync(file, JSON.stringify(leadManifestFile(ids)), { mode: 0o600 });
      const out = join(dir, 'result.json');
      const result = runCompare(dir, ['--object', 'lead', '--manifest-file', file, '--out', out], {
        bitrixLeads,
        crm: { crm_leads: ids.map((id) => crmLead(Number(id))) },
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const json = JSON.parse(readFileSync(out, 'utf8'));
      expect(json.object).toBe('lead');
      expect(json.coverage).toMatchObject({ pages: 2, expected: 60, compared: 60, complete: true });
      expect(json.summary).toMatchObject({ total: 60, pass: true });
      expect(JSON.stringify(json)).not.toMatch(/Synthetic enquiry|Synthetic Person|\+10000000000/);
    });
  });

  it('a passing first page is not a pass when the second page has a gap', () => {
    withDir((dir) => {
      const file = join(dir, 'manifest.json');
      writeFileSync(file, JSON.stringify(leadManifestFile(ids)), { mode: 0o600 });
      const out = join(dir, 'result.json');
      const result = runCompare(dir, ['--object', 'lead', '--manifest-file', file, '--out', out], {
        bitrixLeads,
        crm: { crm_leads: ids.slice(0, 59).map((id) => crmLead(Number(id))) },
      });
      expect(result.status).toBe(1);
      const json = JSON.parse(readFileSync(out, 'utf8'));
      expect(json.summary.pass).toBe(false);
      expect(json.summary.byVerdict).toEqual({ match: 59, expected_but_missing_in_crm: 1 });
    });
  });

  it('an invalid manifest (count != expectedCount) is refused before any network call', () => {
    withDir((dir) => {
      const file = join(dir, 'manifest.json');
      writeFileSync(file, JSON.stringify({ ...leadManifestFile(ids), expectedCount: 61 }), { mode: 0o600 });
      const result = runCompare(dir, ['--object', 'lead', '--manifest-file', file], {});
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe('bitrix-pilot-compare: invalid manifest: ids count does not equal expectedCount');
    });
  });
});

describe('--validate-manifest-only before first import', () => {
  it('normal comparison cannot pass before import, but manifest validation reads only configuration', () => {
    withDir((dir) => {
      const file = join(dir, 'manifest.json');
      writeFileSync(file, JSON.stringify(leadManifestFile(['1', '2'])), { mode: 0o600 });
      const ordinary = runCompare(dir, ['--object', 'lead', '--manifest-file', file], {
        bitrixLeads: [syntheticLead(1), syntheticLead(2)],
        crm: { crm_leads: [] },
      });
      expect(ordinary.status).toBe(1);
      expect(JSON.parse(ordinary.stdout).summary).toMatchObject({ pass: false, byVerdict: { expected_but_missing_in_crm: 2 } });

      const validation = runCompare(dir, ['--object', 'lead', '--manifest-file', file, '--validate-manifest-only'], {});
      expect(validation.status).toBe(0);
      expect(validation.stderr).toBe('');
      expect(validation.stdout.trim()).toBe('bitrix-pilot-compare: manifest file and portal binding valid (2 IDs). No import, field parity, form origin or staff mapping verified.');
      expect(JSON.parse(readFileSync(join(dir, 'requests.json'), 'utf8'))).toEqual(['synthetic-project.example.test:integration_intake_config']);
    });
  });

  it.each([{ options: ['--check-active-manifest'] }, { options: ['--ids', '1'] }])('refuses incompatible options before network (%j)', ({ options }) => {
    withDir((dir) => {
      const file = join(dir, 'manifest.json');
      writeFileSync(file, JSON.stringify(leadManifestFile(['1'])), { mode: 0o600 });
      const result = runCompare(dir, ['--object', 'lead', '--manifest-file', file, '--validate-manifest-only', ...options], {});
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe('bitrix-pilot-compare: --validate-manifest-only cannot be combined with --ids or --check-active-manifest');
      expect(JSON.parse(readFileSync(join(dir, 'requests.json'), 'utf8'))).toEqual([]);
    });
  });

  it('requires a complete portal-bound manifest rather than an approved ID list', () => {
    withDir((dir) => {
      const bare = join(dir, 'ids.json');
      writeFileSync(bare, JSON.stringify(['1']), { mode: 0o600 });
      const result = runCompare(dir, ['--approved-ids-file', bare, '--validate-manifest-only'], {});
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe('bitrix-pilot-compare: --validate-manifest-only requires --manifest-file');
      expect(JSON.parse(readFileSync(join(dir, 'requests.json'), 'utf8'))).toEqual([]);
    });
  });

  it('rejects legacy unbound or incomplete manifests before network', () => {
    withDir((dir) => {
      const file = join(dir, 'manifest.json');
      for (const change of [{ version: 1 }, { expectedCount: 2 }]) {
        writeFileSync(file, JSON.stringify({ ...leadManifestFile(['1']), ...change }), { mode: 0o600 });
        const result = runCompare(dir, ['--object', 'lead', '--manifest-file', file, '--validate-manifest-only'], {});
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('invalid manifest:');
        expect(JSON.parse(readFileSync(join(dir, 'requests.json'), 'utf8'))).toEqual([]);
      }
    });
  });

  it('rejects cross-portal IDs and a mismatched webhook host before any source-record read', () => {
    withDir((dir) => {
      const file = join(dir, 'manifest.json');
      writeFileSync(file, JSON.stringify(leadManifestFile(['1'], { memberId: 'ANOTHER_MEMBER' })), { mode: 0o600 });
      const wrongMember = runCompare(dir, ['--object', 'lead', '--manifest-file', file, '--validate-manifest-only'], {});
      expect(wrongMember.status).toBe(1);
      expect(wrongMember.stderr).toContain('manifest portal identity does not match');
      writeFileSync(file, JSON.stringify(leadManifestFile(['1'])), { mode: 0o600 });
      const wrongHost = runCompare(dir, ['--object', 'lead', '--manifest-file', file, '--validate-manifest-only'], {}, {
        BITRIX_WEBHOOK_BASE_URL: 'https://another-portal.example.test/rest/1/synthetic_only_code/',
      });
      expect(wrongHost.status).toBe(1);
      expect(wrongHost.stderr).toContain('base URL host does not match');
      expect(JSON.parse(readFileSync(join(dir, 'requests.json'), 'utf8'))).toEqual(['synthetic-project.example.test:integration_intake_config']);
    });
  });
});

describe('--check-active-manifest (review L7)', () => {
  const ids = ['1', '2', '3'];
  const fileManifest = { portalDomain: 'synthetic-portal.example.test', memberId: 'SYNTHETIC_MEMBER_0001', sourceObject: 'lead' as const, businessDate: '2026-10-04', interval: INTERVAL, sourceCode: 'WEBFORM', expectedCount: 3, ids };
  const active = {
    portalDomain: 'synthetic-portal.example.test', memberId: 'SYNTHETIC_MEMBER_0001', configId: config.id,
    manifestId: '00000000-0000-4000-8000-0000000000aa', sourceObject: 'lead', sourceCode: 'WEBFORM',
    businessDate: '2026-10-04', intervalFrom: '2026-10-03T18:30:00+00:00', intervalTo: '2026-10-04T18:30:00+00:00',
    expectedCount: 3, ids: ['3', '2', '1'],
  };

  it('accepts the identical active manifest (order-insensitive) and refuses any difference', () => {
    expect(checkActiveManifest(fileManifest, active)).toEqual({ manifestId: active.manifestId });
    expect(() => checkActiveManifest(fileManifest, null)).toThrow(/no active manifest/);
    for (const over of [
      { sourceCode: 'CALL' }, { sourceObject: 'deal' }, { expectedCount: 4 }, { ids: ['1', '2', '4'] },
      { ids: ['1', '2'] }, { ids: ['1', '2', '2'] }, { businessDate: '2026-10-03' },
      { intervalFrom: '2026-10-03T18:30:01+00:00' }, { intervalTo: '2026-10-04T18:30:01+00:00' },
      { intervalFrom: undefined }, { intervalTo: 'not-a-date' }, { businessDate: undefined },
      { portalDomain: 'another-portal.example.test' }, { memberId: 'ANOTHER_MEMBER' },
    ]) {
      expect(() => checkActiveManifest(fileManifest, { ...active, ...over })).toThrow(/does not match the active CRM manifest/);
    }
  });

  it('binds the active manifest to the selected intake configuration', () => {
    const selectedConfig = { ...config, portal_domain: 'synthetic-portal.example.test' };
    expect(checkActiveManifest(fileManifest, active, selectedConfig).manifestId).toBe(active.manifestId);
    expect(() => checkActiveManifest(fileManifest, { ...active, configId: '00000000-0000-4000-8000-0000000000dd' }, selectedConfig)).toThrow(/does not match/);
  });

  it.each([
    { portalDomain: 'another-portal.example.test' },
    { memberId: 'ANOTHER_MEMBER' },
  ])('CLI: refuses cross-portal manifests despite colliding source IDs (%j)', (identity) => {
    withDir((dir) => {
      const file = join(dir, 'manifest.json');
      writeFileSync(file, JSON.stringify({ ...leadManifestFile(ids), ...identity }), { mode: 0o600 });
      const result = runCompare(dir, ['--object', 'lead', '--manifest-file', file], {
        bitrixLeads: ids.map((id) => syntheticLead(Number(id))),
        crm: { crm_leads: ids.map((id) => crmLead(Number(id))) },
      });
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe('bitrix-pilot-compare: manifest portal identity does not match the selected CRM portal');
      expect(result.stdout).toBe('');
    });
  });

  it('CLI: a manifest for another business day exits 1 before any Bitrix read', () => {
    withDir((dir) => {
      const file = join(dir, 'manifest.json');
      writeFileSync(file, JSON.stringify(leadManifestFile(ids)), { mode: 0o600 });
      const result = runCompare(dir, ['--object', 'lead', '--manifest-file', file, '--check-active-manifest'], {
        activeManifest: { ...active, businessDate: '2026-10-03' },
        bitrixLeads: ids.map((id) => syntheticLead(Number(id))),
      });
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe('bitrix-pilot-compare: manifest file does not match the active CRM manifest');
    });
  });

  it('CLI: a file that differs from the active manifest exits 1 before any Bitrix read', () => {
    withDir((dir) => {
      const file = join(dir, 'manifest.json');
      writeFileSync(file, JSON.stringify(leadManifestFile(ids)), { mode: 0o600 });
      const result = runCompare(dir, ['--object', 'lead', '--manifest-file', file, '--check-active-manifest'], {
        activeManifest: { ...active, ids: ['1', '2', '9'] },
        bitrixLeads: ids.map((id) => syntheticLead(Number(id))),
      });
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe('bitrix-pilot-compare: manifest file does not match the active CRM manifest');
    });
  });

  it('CLI: the matching active manifest is recorded and the comparison passes', () => {
    withDir((dir) => {
      const file = join(dir, 'manifest.json');
      const out = join(dir, 'result.json');
      writeFileSync(file, JSON.stringify(leadManifestFile(ids)), { mode: 0o600 });
      const result = runCompare(dir, ['--object', 'lead', '--manifest-file', file, '--check-active-manifest', '--out', out], {
        activeManifest: active,
        bitrixLeads: ids.map((id) => syntheticLead(Number(id))),
        crm: { crm_leads: ids.map((id) => crmLead(Number(id))) },
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(out, 'utf8')).manifest.activeManifestId).toBe(active.manifestId);
    });
  });

  it('requires --manifest-file', () => {
    withDir((dir) => {
      const file = join(dir, 'approved.json');
      writeFileSync(file, JSON.stringify(['1']), { mode: 0o600 });
      const result = runCompare(dir, ['--approved-ids-file', file, '--check-active-manifest'], {});
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe('bitrix-pilot-compare: --check-active-manifest requires --manifest-file');
    });
  });
});
