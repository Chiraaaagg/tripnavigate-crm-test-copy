import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expectOwnerOnlyMode } from '../helpers/file-mode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseManifest, REPOSITORY_ROOT, selectionFilter } from '../../scripts/bitrix-lead-manifest.mjs';
import {
  classifyLead,
  EVIDENCE_RULE,
  MAX_SELECTION_LEADS,
  parseForms,
  readLeadActivities,
  runSelection,
  SelectionError,
  serializeManifest,
  sha256Hex,
  writeSelectionOutputs,
  type DayLead,
} from '../../scripts/bitrix-lead-selection.mjs';
import { createReadOnlyCaller, PilotInspectError } from '../../scripts/bitrix-pilot-inspect.mjs';

/**
 * scripts/bitrix-lead-selection.mjs: read-only day selection with form-origin
 * provenance (selection-contract.md sections 1-4). Fake callers and mock fetch
 * only; synthetic portal, member ID and record IDs.
 */

const SCRIPT = join(import.meta.dirname, '../../scripts/bitrix-lead-selection.mjs');
const PORTAL = 'synthetic-portal.example.test';
const MEMBER = 'SYNTHETIC_MEMBER_0001';
const DATE = '2026-10-04';
const INTERVAL = { from: '2026-10-04T00:00:00+05:30', to: '2026-10-05T00:00:00+05:30' };
const FORMS = ['133', '135', '137'];
const CLOSED_TIME = '2026-10-05T09:00:00+05:30';
const OPEN_TIME = '2026-10-04T18:00:00+05:30';
const FIELDS = { ID: {}, OWNER_ID: {}, OWNER_TYPE_ID: {}, PROVIDER_ID: {}, PROVIDER_TYPE_ID: {}, CREATED: {}, SUBJECT: {} };

type Row = Record<string, unknown>;
type Page = { result: unknown; total?: unknown; next?: unknown };
type Body = Record<string, unknown>;

const lead = (id: number, over: Row = {}): Row => ({
  ID: String(id),
  SOURCE_ID: 'WEBFORM',
  DATE_CREATE: '2026-10-04T10:00:00+05:30',
  STATUS_ID: 'NEW',
  ASSIGNED_BY_ID: '501',
  ...over,
});
const activity = (id: number, owner: number, over: Row = {}): Row => ({
  ID: String(id),
  OWNER_ID: String(owner),
  OWNER_TYPE_ID: '1',
  PROVIDER_ID: 'CRM_WEBFORM',
  PROVIDER_TYPE_ID: '133',
  CREATED: '2026-10-04T10:00:00+05:30',
  ...over,
});

/** Paginates a full list the way Bitrix does (50 per page, `next` when more remain). */
function paged(rows: Row[], start: number): Page {
  const page = rows.slice(start, start + 50);
  return { result: page, total: rows.length, ...(start + 50 < rows.length ? { next: start + 50 } : {}) };
}

interface Scenario {
  fields?: unknown;
  time?: string;
  leads?: Row[];
  leadPages?: Page[];
  activities?: Record<string, Row[]>;
  activityPages?: Record<string, Page[]>;
  fail?: string;
}

/** Fake read-only caller: answers by method from a scenario and records every call. */
function fakeCaller(s: Scenario) {
  const calls: Array<{ method: string; params: Body }> = [];
  const pageIndex: Record<string, number> = {};
  return {
    calls,
    call: async (method: string, params: Body = {}) => {
      calls.push({ method, params });
      if (s.fail === method) throw new PilotInspectError(`${method}: HTTP 500 (INTERNAL_SERVER_ERROR)`);
      if (method === 'crm.activity.fields') return { result: s.fields ?? FIELDS };
      if (method === 'server.time') return { result: s.time ?? CLOSED_TIME };
      const start = Number(params.start ?? 0);
      if (method === 'crm.lead.list') {
        if (s.leadPages) {
          const i = (pageIndex.lead = (pageIndex.lead ?? -1) + 1);
          const page = s.leadPages[i];
          if (!page) throw new Error('unexpected page');
          return page as Body;
        }
        return paged(s.leads ?? [], start) as Body;
      }
      if (method === 'crm.activity.list') {
        const owner = String((params.filter as Body).OWNER_ID);
        const scripted = s.activityPages?.[owner];
        if (scripted) {
          const i = (pageIndex[owner] = (pageIndex[owner] ?? -1) + 1);
          const page = scripted[i];
          if (!page) throw new Error('unexpected page');
          return page as Body;
        }
        return paged(s.activities?.[owner] ?? [], start) as Body;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

const clock = () => {
  let t = Date.parse('2026-10-05T04:00:00Z');
  return () => new Date((t += 1000));
};

/** A day with one Lead per classification outcome (no ambiguous Lead). */
function mixedDay(): Scenario {
  return {
    leads: [
      lead(900101), // selected, form 133
      lead(900102, { SOURCE_ID: 'CALL' }), // source_not_webform
      lead(900103), // no_crm_form_activity
      lead(900104), // form_not_approved (hiring form)
      lead(900105, { ASSIGNED_BY_ID: '502', STATUS_ID: 'IN_PROCESS' }), // selected, form 137
    ],
    activities: {
      '900101': [activity(700001, 900101), activity(700002, 900101, { PROVIDER_ID: 'CRM_EMAIL', PROVIDER_TYPE_ID: 'EMAIL' })],
      '900103': [activity(700003, 900103, { PROVIDER_ID: 'VOXIMPLANT_CALL', PROVIDER_TYPE_ID: 'CALL' })],
      '900104': [activity(700004, 900104, { PROVIDER_TYPE_ID: '141' })],
      '900105': [activity(700006, 900105, { PROVIDER_TYPE_ID: '137' }), activity(700005, 900105, { PROVIDER_TYPE_ID: '137' })],
    },
  };
}

const dayLead = (over: Partial<DayLead> = {}): DayLead => ({
  id: '900001',
  sourceId: 'WEBFORM',
  created: '2026-10-04T10:00:00+05:30',
  statusId: 'NEW',
  assignedById: '501',
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tripnavigate-selection-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseForms', () => {
  it('accepts digits only, de-duplicates and sorts numerically', () => {
    expect(parseForms('137,133, 135,133')).toEqual(FORMS);
    expect(parseForms('9,10')).toEqual(['9', '10']);
    for (const bad of ['', undefined, '133,', '133;135', 'abc', '133,-1', '1.5', '0', '133,0', '0133', '12345678901234567']) {
      expect(() => parseForms(bad)).toThrow(SelectionError);
    }
  });
});

describe('classifyLead (contract section 2 step 5)', () => {
  it.each([
    ['SOURCE_ID not WEBFORM', dayLead({ sourceId: 'CALL' }), [{ id: '1', form: '133' }], { status: 'excluded', reason: 'source_not_webform', forms: [] }],
    ['SOURCE_ID missing', dayLead({ sourceId: null }), [], { status: 'excluded', reason: 'source_not_webform', forms: [] }],
    ['WEBFORM, no CRM_WEBFORM activity', dayLead(), [], { status: 'excluded', reason: 'no_crm_form_activity', forms: [] }],
    ['one form, not approved', dayLead(), [{ id: '1', form: '141' }], { status: 'excluded', reason: 'form_not_approved', forms: ['141'] }],
    [
      'one form, approved (repeated activity)',
      dayLead(),
      [{ id: '1', form: '135' }, { id: '2', form: '135' }],
      { status: 'selected', form: '135', activityIds: ['1', '2'], assignedById: '501', statusId: 'NEW' },
    ],
  ])('%s', (_label, l, acts, expected) => {
    expect(classifyLead(l, acts, FORMS)).toMatchObject({ id: l.id, ...expected });
  });

  it('more than one distinct form stops the run with ambiguous_form_origin', () => {
    expect(() => classifyLead(dayLead(), [{ id: '1', form: '133' }, { id: '2', form: '135' }], FORMS)).toThrow(/ambiguous_form_origin/);
    // Even when one of the forms is outside the approved set.
    expect(() => classifyLead(dayLead(), [{ id: '1', form: '133' }, { id: '2', form: '141' }], FORMS)).toThrow(/ambiguous_form_origin/);
  });
});

describe('runSelection', () => {
  it('classifies a closed day and builds a manifest of selected IDs only', async () => {
    const caller = fakeCaller(mixedDay());
    const { report, manifest, manifestSkipped } = await runSelection(caller, { portalDomain: PORTAL, memberId: MEMBER, businessDate: DATE, formsInScope: FORMS, now: clock() });
    expect(manifestSkipped).toBeNull();
    expect(report).toMatchObject({
      kind: 'tripnavigate.bitrix-lead-selection-report',
      version: 1,
      portalDomain: PORTAL,
      memberIdStatus: 'provided_unverified',
      businessDate: DATE,
      timezone: 'Asia/Kolkata',
      interval: { ...INTERVAL, bounds: '[)' },
      dayStatus: 'closed',
      providerTime: CLOSED_TIME,
      formsInScope: FORMS,
      evidenceRule: EVIDENCE_RULE,
      counts: { leadsInDay: 5, selected: 2, excluded: 3, excludedByReason: { source_not_webform: 1, no_crm_form_activity: 1, form_not_approved: 1 } },
      manifest: null,
    });
    expect(report).not.toHaveProperty('memberId');
    expect(report.selected).toEqual([
      { id: '900101', created: '2026-10-04T10:00:00+05:30', statusId: 'NEW', assignedById: '501', form: '133', activityIds: ['700001'] },
      { id: '900105', created: '2026-10-04T10:00:00+05:30', statusId: 'IN_PROCESS', assignedById: '502', form: '137', activityIds: ['700005', '700006'] },
    ]);
    expect(report.excluded).toEqual([
      { id: '900102', reason: 'source_not_webform', forms: [] },
      { id: '900103', reason: 'no_crm_form_activity', forms: [] },
      { id: '900104', reason: 'form_not_approved', forms: ['141'] },
    ]);
    expect(Date.parse(report.selectionFinishedAt)).toBeGreaterThan(Date.parse(report.selectionStartedAt));
    expect(manifest).not.toBeNull();
    expect(manifest!.ids).toEqual(['900101', '900105']);
    expect(manifest!.filter).toEqual(selectionFilter(INTERVAL, 'WEBFORM'));
    expect(parseManifest(manifest, { sourceObject: 'lead' }).ids).toEqual(['900101', '900105']);

    // Call order and minimal parameters: fields once, server.time once, no source filter on Leads,
    // activities only for WEBFORM Leads, single-value equality filters only.
    expect(caller.calls.slice(0, 3).map((c) => c.method)).toEqual(['crm.activity.fields', 'server.time', 'crm.lead.list']);
    expect(caller.calls.filter((c) => c.method === 'crm.activity.fields')).toHaveLength(1);
    expect(caller.calls.filter((c) => c.method === 'server.time')).toHaveLength(1);
    const leadCall = caller.calls.find((c) => c.method === 'crm.lead.list')!;
    expect(leadCall.params).toEqual({
      filter: { '>=DATE_CREATE': INTERVAL.from, '<DATE_CREATE': INTERVAL.to },
      select: ['ID', 'SOURCE_ID', 'DATE_CREATE', 'STATUS_ID', 'ASSIGNED_BY_ID'],
      order: { ID: 'ASC' },
      start: 0,
    });
    const activityCalls = caller.calls.filter((c) => c.method === 'crm.activity.list');
    expect(activityCalls.map((c) => (c.params.filter as Body).OWNER_ID)).toEqual(['900101', '900103', '900104', '900105']);
    for (const c of activityCalls) {
      expect(Object.keys(c.params.filter as Body).sort()).toEqual(['OWNER_ID', 'OWNER_TYPE_ID']);
      expect((c.params.filter as Body).OWNER_TYPE_ID).toBe(1);
      expect(c.params.select).toEqual(['ID', 'OWNER_ID', 'OWNER_TYPE_ID', 'PROVIDER_ID', 'PROVIDER_TYPE_ID', 'CREATED']);
    }
  });

  it('an open day never gets a manifest; provider time equal to the interval end is closed', async () => {
    const open = await runSelection(fakeCaller({ ...mixedDay(), time: OPEN_TIME }), { portalDomain: PORTAL, memberId: MEMBER, businessDate: DATE, formsInScope: FORMS });
    expect(open.report.dayStatus).toBe('open');
    expect(open.report.counts.selected).toBe(2);
    expect(open.manifest).toBeNull();
    expect(open.manifestSkipped).toBe('day is open');
    const justBefore = await runSelection(fakeCaller({ ...mixedDay(), time: '2026-10-04T23:59:59+05:30' }), { portalDomain: PORTAL, memberId: MEMBER, businessDate: DATE, formsInScope: FORMS });
    expect(justBefore.report.dayStatus).toBe('open');
    const atEnd = await runSelection(fakeCaller({ ...mixedDay(), time: '2026-10-04T18:30:00Z' }), { portalDomain: PORTAL, memberId: MEMBER, businessDate: DATE, formsInScope: FORMS });
    expect(atEnd.report.dayStatus).toBe('closed');
    expect(atEnd.manifest).not.toBeNull();
  });

  it('without --member-id the report is unverified and no manifest is built', async () => {
    const out = await runSelection(fakeCaller(mixedDay()), { portalDomain: PORTAL, memberId: null, businessDate: DATE, formsInScope: FORMS });
    expect(out.report.memberIdStatus).toBe('unverified');
    expect(out.manifest).toBeNull();
    expect(out.manifestSkipped).toBe('no --member-id');
  });

  it('zero selected Leads gives a report and no manifest', async () => {
    const out = await runSelection(fakeCaller({ leads: [lead(900102, { SOURCE_ID: 'CALL' })] }), { portalDomain: PORTAL, memberId: MEMBER, businessDate: DATE, formsInScope: FORMS });
    expect(out.report.counts).toMatchObject({ leadsInDay: 1, selected: 0, excluded: 1 });
    expect(out.manifest).toBeNull();
    expect(out.manifestSkipped).toBe('no Lead selected');
  });

  it.each(['OWNER_ID', 'OWNER_TYPE_ID', 'PROVIDER_ID', 'PROVIDER_TYPE_ID'])('stops when crm.activity.fields has no %s', async (missing) => {
    const fields = Object.fromEntries(Object.entries(FIELDS).filter(([k]) => k !== missing));
    const caller = fakeCaller({ ...mixedDay(), fields });
    await expect(runSelection(caller, { portalDomain: PORTAL, memberId: MEMBER, businessDate: DATE, formsInScope: FORMS })).rejects.toThrow(new RegExp(`no ${missing}`));
    expect(caller.calls.map((c) => c.method)).toEqual(['crm.activity.fields']);
  });

  it('stops on a missing field map or an unusable server.time', async () => {
    await expect(runSelection(fakeCaller({ fields: [] }), { portalDomain: PORTAL, memberId: MEMBER, businessDate: DATE, formsInScope: FORMS })).rejects.toBeInstanceOf(SelectionError);
    await expect(runSelection(fakeCaller({ time: 'not a time' }), { portalDomain: PORTAL, memberId: MEMBER, businessDate: DATE, formsInScope: FORMS })).rejects.toThrow(/server\.time/);
  });

  const many = (n: number) => Array.from({ length: n }, (_, i) => lead(900001 + i, { SOURCE_ID: 'CALL' }));
  const runOf = (scenario: Scenario) => runSelection(fakeCaller(scenario), { portalDomain: PORTAL, memberId: MEMBER, businessDate: DATE, formsInScope: FORMS });
  it.each<[string, Scenario, string]>([
    ['lead partial page', { leadPages: [{ result: many(49), total: 60, next: 50 }] }, 'crm.lead.list: partial page; nothing written'],
    ['lead total changes between pages', { leadPages: [{ result: many(50), total: 60, next: 50 }, { result: many(60).slice(50), total: 61 }] }, 'crm.lead.list: total changed between pages; re-run the selection'],
    ['lead missing total', { leadPages: [{ result: many(2) }] }, 'crm.lead.list returned no total; cannot prove completeness'],
    ['lead non-list result', { leadPages: [{ result: { items: [] }, total: 0 }] }, 'crm.lead.list returned no result list'],
    ['lead total larger than rows read', { leadPages: [{ result: many(2), total: 3 }] }, 'crm.lead.list: read 2 of 3 rows; incomplete, nothing written'],
    ['lead next does not advance', { leadPages: [{ result: many(50), total: 100, next: 0 }] }, 'crm.lead.list: pagination did not advance'],
    ['lead duplicate ID across pages', { leadPages: [{ result: many(50), total: 51, next: 50 }, { result: [lead(900050, { SOURCE_ID: 'CALL' })], total: 51 }] }, 'crm.lead.list returned a duplicate ID; re-run the selection'],
    ['lead outside the interval', { leads: [lead(900001, { DATE_CREATE: '2026-10-05T00:00:00+05:30' })] }, 'crm.lead.list returned a record outside the date interval'],
    ['lead invalid ID', { leads: [lead(0)] }, 'crm.lead.list returned an invalid ID'],
    ['lead provider error', { ...mixedDay(), fail: 'crm.lead.list' }, 'crm.lead.list: HTTP 500 (INTERNAL_SERVER_ERROR)'],
    ['more than MAX_SELECTION_LEADS', { leads: many(MAX_SELECTION_LEADS + 1) }, 'more than 500 Leads in the business day; nothing written'],
    ['activity partial page', { leads: [lead(900001)], activityPages: { '900001': [{ result: [activity(1, 900001)], total: 60, next: 50 }] } }, 'crm.activity.list: partial page; nothing written'],
    ['activity total changes', { leads: [lead(900001)], activityPages: { '900001': [{ result: Array.from({ length: 50 }, (_, i) => activity(i + 1, 900001)), total: 51, next: 50 }, { result: [activity(51, 900001)], total: 52 }] } }, 'crm.activity.list: total changed between pages; re-run the selection'],
    ['activity duplicate ID', { leads: [lead(900001)], activities: { '900001': [activity(1, 900001), activity(1, 900001)] } }, 'crm.activity.list returned a duplicate ID; re-run the selection'],
    ['activity provider error', { ...mixedDay(), fail: 'crm.activity.list' }, 'crm.activity.list: HTTP 500 (INTERNAL_SERVER_ERROR)'],
    ['activity owned by another Lead', { leads: [lead(900001)], activities: { '900001': [activity(1, 900002)] } }, 'crm.activity.list returned an activity owned by another record; nothing written'],
    ['activity owned by another entity type', { leads: [lead(900001)], activities: { '900001': [activity(1, 900001, { OWNER_TYPE_ID: '2' })] } }, 'crm.activity.list returned an activity owned by another record; nothing written'],
    ['web-form activity without a form ID', { leads: [lead(900001)], activities: { '900001': [activity(1, 900001, { PROVIDER_TYPE_ID: '' })] } }, 'crm.activity.list returned a web-form activity without a form ID'],
    ['web-form activity with form ID 0', { leads: [lead(900001)], activities: { '900001': [activity(1, 900001, { PROVIDER_TYPE_ID: '0' })] } }, 'crm.activity.list returned a web-form activity without a form ID'],
    ['ambiguous form origin', { leads: [lead(900001)], activities: { '900001': [activity(1, 900001), activity(2, 900001, { PROVIDER_TYPE_ID: '135' })] } }, 'ambiguous_form_origin: a Lead has more than one web form; nothing written'],
  ])('%s: stops the run with a fixed code', async (_label, scenario, code) => {
    const error = await runOf(scenario).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error instanceof SelectionError || error instanceof PilotInspectError).toBe(true);
    expect((error as SelectionError).code).toBe(code);
  });

  it('readLeadActivities keeps CRM_WEBFORM rows only, sorted by ID', async () => {
    const caller = fakeCaller({ activities: { '900001': [activity(9, 900001, { PROVIDER_TYPE_ID: 135 }), activity(3, 900001, { PROVIDER_ID: 'CRM_EMAIL', PROVIDER_TYPE_ID: 'EMAIL' }), activity(4, 900001, { OWNER_ID: 900001, OWNER_TYPE_ID: 1 })] } });
    expect(await readLeadActivities(caller, '900001')).toEqual([{ id: '4', form: '133' }, { id: '9', form: '135' }]);
  });
});

describe('writeSelectionOutputs', () => {
  async function closedRun(memberId: string | null = MEMBER) {
    return runSelection(fakeCaller(mixedDay()), { portalDomain: PORTAL, memberId, businessDate: DATE, formsInScope: FORMS, now: clock() });
  }

  it('writes a mode-600 manifest that round-trips through parseManifest and records its sha256', async () => {
    const { report, manifest } = await closedRun();
    const reportPath = join(dir, 'report.json');
    const manifestPath = join(dir, 'manifest.json');
    const written = writeSelectionOutputs({ reportPath, manifestPath, report, manifest });
    const bytes = readFileSync(manifestPath);
    expect(written.manifest).toEqual({ fileName: 'manifest.json', sha256: sha256Hex(bytes), expectedCount: 2 });
    const onDisk = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(onDisk).toEqual(written);
    expect(onDisk.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    const parsed = parseManifest(JSON.parse(bytes.toString('utf8')), { sourceObject: 'lead' });
    expect(parsed).toMatchObject({ portalDomain: PORTAL, memberId: MEMBER, businessDate: DATE, sourceCode: 'WEBFORM', expectedCount: 2, ids: ['900101', '900105'] });
    expectOwnerOnlyMode(statSync(reportPath).mode);
    expectOwnerOnlyMode(statSync(manifestPath).mode);
  });

  it('writes the report only when there is no manifest', async () => {
    const { report, manifest } = await closedRun(null);
    const reportPath = join(dir, 'report.json');
    const written = writeSelectionOutputs({ reportPath, manifestPath: null, report, manifest });
    expect(written.manifest).toBeNull();
    expect(JSON.parse(readFileSync(reportPath, 'utf8')).memberIdStatus).toBe('unverified');
  });

  it('report write fails first: no manifest is written and the existing report is untouched', async () => {
    const { report, manifest } = await closedRun();
    const reportPath = join(dir, 'report.json');
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(reportPath, 'existing');
    expect(() => writeSelectionOutputs({ reportPath, manifestPath, report, manifest })).toThrow(
      'bitrix-lead-selection: report write failed (file exists or directory not writable); nothing written',
    );
    expect(readFileSync(reportPath, 'utf8')).toBe('existing');
    expect(existsSync(manifestPath)).toBe(false);

    const noManifest = await closedRun(null);
    expect(() => writeSelectionOutputs({ reportPath, manifestPath: null, report: noManifest.report, manifest: null })).toThrow(/report write failed/);
    expect(readFileSync(reportPath, 'utf8')).toBe('existing');
  });

  it('manifest write fails after the report: the new report is removed and the existing manifest untouched', async () => {
    const { report, manifest } = await closedRun();
    const reportPath = join(dir, 'report.json');
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, 'existing');
    expect(() => writeSelectionOutputs({ reportPath, manifestPath, report, manifest })).toThrow(
      'bitrix-lead-selection: manifest write failed (file exists or directory not writable); report removed, nothing written',
    );
    expect(readFileSync(manifestPath, 'utf8')).toBe('existing');
    expect(existsSync(reportPath)).toBe(false);

    // Same when the manifest directory is missing: nothing remains.
    const missingDir = join(dir, 'missing', 'manifest.json');
    expect(() => writeSelectionOutputs({ reportPath, manifestPath: missingDir, report, manifest })).toThrow(/manifest write failed/);
    expect(existsSync(reportPath)).toBe(false);
    expect(existsSync(missingDir)).toBe(false);
  });

  it('the recorded sha256 covers the in-memory serialization that is written', async () => {
    const { report, manifest } = await closedRun();
    const written = writeSelectionOutputs({ reportPath: join(dir, 'r.json'), manifestPath: join(dir, 'm.json'), report, manifest });
    expect(written.manifest!.sha256).toBe(sha256Hex(serializeManifest(manifest!)));
    expect(readFileSync(join(dir, 'm.json'), 'utf8')).toBe(serializeManifest(manifest!));
    expect(() => writeSelectionOutputs({ reportPath: join(dir, 'same.json'), manifestPath: join(dir, 'same.json'), report, manifest })).toThrow(/must differ/);
    expect(existsSync(join(dir, 'same.json'))).toBe(false);
  });
});

describe('read-only caller allow-list for crm.activity.list', () => {
  it('rejects a select or filter outside the allow-list before any request', async () => {
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      return Response.json({ result: [], total: 0 });
    }) as typeof fetch;
    const caller = createReadOnlyCaller(`https://${PORTAL}/rest/1/synthetic_only_code/`, { fetchImpl, minIntervalMs: 0 });
    const filter = { OWNER_TYPE_ID: 1, OWNER_ID: '900001' };
    for (const select of [['ID', 'SUBJECT'], ['ID', 'DESCRIPTION'], ['ID', 'COMMUNICATIONS'], ['ID', 'FILES'], ['*'], []]) {
      await expect(caller.call('crm.activity.list', { filter, select })).rejects.toThrow(/select outside/);
    }
    for (const bad of [{}, { OWNER_TYPE_ID: 1, '>OWNER_ID': 1 }, { OWNER_TYPE_ID: 1, OWNER_ID: [1, 2] }, { OWNER_TYPE_ID: 1, PROVIDER_ID: 'CRM_WEBFORM' }]) {
      await expect(caller.call('crm.activity.list', { filter: bad, select: ['ID'] })).rejects.toThrow(/filter outside/);
    }
    expect(requests).toBe(0);
  });
});

describe('CLI (mock fetch, synthetic credentials)', () => {
  const env = {
    NODE_ENV: 'test',
    BITRIX_WEBHOOK_BASE_URL: `https://${PORTAL}/rest/1/synthetic_only_code/`,
    BITRIX_MIN_INTERVAL_MS: '1',
  } as const;

  /** `answer(method, body)` runs inside the child process and returns a Response. */
  function runCli(args: string[], answer: string, envOver: Record<string, string> = {}) {
    const preload = join(dir, 'mock-fetch.mjs');
    writeFileSync(
      preload,
      `${answer}
      globalThis.fetch = async (input, init) => {
        const url = new URL(input);
        if (url.hostname !== '${PORTAL}') throw new Error('Unexpected host: no network allowed');
        const method = url.pathname.split('/').pop().replace(/\\.json$/, '');
        return answer(method, JSON.parse(init.body));
      };`,
      { mode: 0o600 },
    );
    return spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, SCRIPT, ...args], { encoding: 'utf8', env: { ...env, ...envOver } });
  }
  const dayAnswer = (time: string, activities: Record<string, Row[]> = mixedDay().activities!) => `
    const leads = ${JSON.stringify(mixedDay().leads)};
    const activities = ${JSON.stringify(activities)};
    const answer = (method, body) => {
      if (method === 'crm.activity.fields') return Response.json({ result: ${JSON.stringify(FIELDS)} });
      if (method === 'server.time') return Response.json({ result: '${time}' });
      if (method === 'crm.lead.list') return Response.json({ result: leads, total: leads.length });
      if (method === 'crm.activity.list') {
        const rows = activities[String(body.filter.OWNER_ID)] ?? [];
        return Response.json({ result: rows, total: rows.length });
      }
      return Response.json({ error: 'ERROR_METHOD_NOT_FOUND' }, { status: 404 });
    };`;
  const baseArgs = () => ['--portal-domain', PORTAL, '--business-date', DATE, '--forms', '133,135,137', '--report-out', join(dir, 'report.json')];

  it('closed day with --member-id writes report and manifest; console has counts only', () => {
    const manifestPath = join(dir, 'manifest.json');
    const result = runCli([...baseArgs(), '--member-id', MEMBER, '--manifest-out', manifestPath], dayAnswer(CLOSED_TIME));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      'bitrix-lead-selection: day closed; leads in day 5, selected 2, excluded 3 (source_not_webform 1, no_crm_form_activity 1, form_not_approved 1); member id provided_unverified; manifest written (2 IDs, mode 600); report written (mode 600)\n',
    );
    expect(result.stdout).not.toMatch(/9001|7000|synthetic_only_code|https?:|\/rest\//);
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    expect(report.manifest.sha256).toBe(sha256Hex(readFileSync(manifestPath)));
    expect(parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), { sourceObject: 'lead' }).ids).toEqual(['900101', '900105']);
    expectOwnerOnlyMode(statSync(manifestPath).mode);
    expectOwnerOnlyMode(statSync(join(dir, 'report.json')).mode);
  });

  it('open day writes the report only', () => {
    const manifestPath = join(dir, 'manifest.json');
    const result = runCli([...baseArgs(), '--member-id', MEMBER, '--manifest-out', manifestPath], dayAnswer(OPEN_TIME));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('day open;');
    expect(result.stdout).toContain('no manifest (day is open)');
    expect(existsSync(manifestPath)).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))).toMatchObject({ dayStatus: 'open', manifest: null });
  });

  it('missing --member-id writes the report only, unverified', () => {
    const result = runCli(baseArgs(), dayAnswer(CLOSED_TIME));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('member id unverified; no manifest (no --member-id)');
    expect(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))).toMatchObject({ memberIdStatus: 'unverified', manifest: null });
  });

  it.each([
    ['provider error', `const answer = () => Response.json({ error: 'INTERNAL_SERVER_ERROR' }, { status: 500 });`],
    ['ambiguous origin', dayAnswer(CLOSED_TIME, { ...mixedDay().activities!, '900103': [activity(1, 900103), activity(2, 900103, { PROVIDER_TYPE_ID: '135' })] })],
    ['partial page', `const answer = (method) => method === 'crm.activity.fields' ? Response.json({ result: ${JSON.stringify(FIELDS)} }) : method === 'server.time' ? Response.json({ result: '${CLOSED_TIME}' }) : Response.json({ result: [], total: 5 });`],
  ])('%s exits 1, prints a fixed redacted error and writes nothing', (_label, answer) => {
    const manifestPath = join(dir, 'manifest.json');
    const result = runCli([...baseArgs(), '--member-id', MEMBER, '--manifest-out', manifestPath], answer);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^bitrix-lead-selection: [^\n]+\n$/);
    expect(result.stderr).not.toMatch(/synthetic_only_code|9001|https?:/);
    expect(existsSync(manifestPath)).toBe(false);
    expect(existsSync(join(dir, 'report.json'))).toBe(false);
  });

  it('refuses output paths inside the repository before any network call', () => {
    const noNetwork = `const answer = () => { throw new Error('network called'); };`;
    const insideReport = join(REPOSITORY_ROOT, 'crm', 'selection-report-should-not-exist.json');
    const r1 = runCli(['--portal-domain', PORTAL, '--business-date', DATE, '--forms', '133', '--report-out', insideReport], noNetwork);
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain('--report-out is inside the repository');
    expect(existsSync(insideReport)).toBe(false);
    const insideManifest = join(REPOSITORY_ROOT, 'manifest-should-not-exist.json');
    const r2 = runCli([...baseArgs(), '--member-id', MEMBER, '--manifest-out', insideManifest], noNetwork);
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain('--manifest-out is inside the repository');
    expect(existsSync(insideManifest)).toBe(false);
    expect(existsSync(join(dir, 'report.json'))).toBe(false);
  });

  it.each<[string, string[], Record<string, string>, string]>([
    ['webhook host differs from --portal-domain', ['--member-id', MEMBER, '--manifest-out', 'MANIFEST'], { BITRIX_WEBHOOK_BASE_URL: 'https://other-portal.example.test/rest/1/synthetic_only_code/' }, 'base URL host does not match --portal-domain'],
    ['--manifest-out without --member-id', ['--manifest-out', 'MANIFEST'], {}, '--manifest-out needs --member-id; without it no manifest is written'],
    ['--manifest-out equal to --report-out', ['--member-id', MEMBER, '--manifest-out', 'REPORT'], {}, '--manifest-out and --report-out must differ'],
    // arg() reads the first occurrence, so these flags override baseArgs().
    ['--forms with 0', ['--forms', '0,133'], {}, '--forms must be a comma-separated list of form IDs (digits only)'],
  ])('%s: exits 1 before any network call and writes nothing', (_label, extra, envOver, message) => {
    const args = [...extra, ...baseArgs()].map((a) => (a === 'MANIFEST' ? join(dir, 'manifest.json') : a === 'REPORT' ? join(dir, 'report.json') : a));
    const result = runCli(args, `const answer = () => { throw new Error('network called'); };`, envOver);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`bitrix-lead-selection: ${message}\n`);
    expect(existsSync(join(dir, 'report.json'))).toBe(false);
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false);
  });

  it('refuses an existing report path before any network call', () => {
    writeFileSync(join(dir, 'report.json'), 'existing');
    const result = runCli(baseArgs(), `const answer = () => { throw new Error('network called'); };`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--report-out already exists; refusing to overwrite');
    expect(readFileSync(join(dir, 'report.json'), 'utf8')).toBe('existing');
  });
});


describe('approved selection scope', () => {
  it('refuses unapproved forms before contacting Bitrix', async () => {
    const caller = fakeCaller(mixedDay());
    await expect(runSelection(caller, { portalDomain: PORTAL, memberId: null, businessDate: DATE, formsInScope: ['999'] })).rejects.toThrow(/owner-approved scope/);
    expect(caller.calls).toHaveLength(0);
  });
  it('refuses unapproved dates before contacting Bitrix', async () => {
    const caller = fakeCaller(mixedDay());
    await expect(runSelection(caller, { portalDomain: PORTAL, memberId: null, businessDate: '2026-10-06', formsInScope: FORMS })).rejects.toThrow(/owner-approved scope/);
    expect(caller.calls).toHaveLength(0);
  });
});
