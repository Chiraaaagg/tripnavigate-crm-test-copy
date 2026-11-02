import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildManifest, istInterval, selectionFilter } from '../../scripts/bitrix-lead-manifest.mjs';
import {
  evaluateReadiness,
  APPROVED_BUSINESS_DATES,
  FOOTER,
  formatReadiness,
  GATES,
  parseArgs,
  parseSelectionReport,
  ReadinessError,
  sha256Hex,
  type Gate,
  type GateName,
  type ReadinessResult,
} from '../../scripts/pilot-readiness.mjs';

/** scripts/pilot-readiness.mjs: offline, read-only readiness report (selection contract section 5). Synthetic data only. */

const SCRIPT = join(import.meta.dirname, '../../scripts/pilot-readiness.mjs');
const PORTAL = 'synthetic-portal.example.test';
const MEMBER = 'synthetic-member-0001';
const DAY = '2026-10-04';
const DAY2 = '2026-10-05';
const LEAD_IDS = ['900001', '900002'];
const ASSIGNEE = '7701';

type Json = Record<string, unknown>;

function report(overrides: Json = {}, day = DAY, ids = LEAD_IDS): Json {
  const interval = istInterval(day);
  const selected = ids.map((id, i) => ({
    id,
    created: `${day}T0${i + 1}:00:00+05:30`,
    statusId: 'NEW',
    assignedById: ASSIGNEE,
    form: '133',
    activityIds: [String(500000 + i)],
  }));
  const excluded = [
    { id: '900101', reason: 'source_not_webform', forms: [] },
    { id: '900102', reason: 'form_not_approved', forms: ['141'] },
  ];
  const base: Json = {
    kind: 'tripnavigate.bitrix-lead-selection-report',
    version: 1,
    portalDomain: PORTAL,
    memberIdStatus: 'verified',
    businessDate: day,
    timezone: 'Asia/Kolkata',
    interval: { from: interval.from, to: interval.to, bounds: '[)' },
    dayStatus: 'closed',
    providerTime: '2026-10-06T09:00:00+05:30',
    selectionStartedAt: '2026-10-06T03:30:00.000Z',
    selectionFinishedAt: '2026-10-06T03:31:00.000Z',
    formsInScope: ['133', '135', '137'],
    evidenceRule: 'Synthetic evidence rule text.',
    counts: {
      leadsInDay: selected.length + excluded.length,
      selected: selected.length,
      excluded: excluded.length,
      source_not_webform: 1,
      no_crm_form_activity: 0,
      form_not_approved: 1,
    },
    selected,
    excluded,
    manifest: null,
  };
  return { ...base, ...overrides };
}

function manifestFor(day = DAY, ids = LEAD_IDS, portal = PORTAL) {
  const interval = istInterval(day);
  const data = buildManifest({
    portalDomain: portal,
    memberId: MEMBER,
    businessDate: day,
    sourceCode: 'WEBFORM',
    interval,
    filter: selectionFilter(interval, 'WEBFORM'),
    ids,
    selectedAt: '2026-10-06T03:31:00.000Z',
  });
  const text = JSON.stringify(data, null, 2) + '\n';
  return { text, data: data as unknown as Json, sha256: sha256Hex(text) };
}

/** A matched report + manifest pair for one closed day. */
function pair(day = DAY, ids = LEAD_IDS) {
  const m = manifestFor(day, ids);
  const r = report({ manifest: { fileName: `lead-manifest-${day}.json`, sha256: m.sha256, expectedCount: ids.length } }, day, ids);
  return { report: r, manifest: { sha256: m.sha256, data: m.data } };
}

const statusOf = (result: ReadinessResult, name: GateName) => result.gates.find((g: Gate) => g.gate === name)!.status;
const ENV = { PRODUCTION_SUPABASE_PROJECT_REF: 'synthetic-ref-value' };

describe('evaluateReadiness', () => {
  it('returns every contract gate once, in order, and not_ready with no input', () => {
    const result = evaluateReadiness({});
    expect(result.gates.map((g) => g.gate)).toEqual([...GATES]);
    expect(result.overall).toBe('not_ready');
    expect(statusOf(result, 'portal_identity')).toBe('missing');
    expect(statusOf(result, 'form_evidence')).toBe('missing');
    expect(statusOf(result, 'manifest')).toBe('missing');
    expect(statusOf(result, 'staff_mapping')).toBe('missing');
    expect(statusOf(result, 'destination')).toBe('missing');
    expect(statusOf(result, 'recovery')).toBe('skipped_by_owner');
    expect(statusOf(result, 'invitations')).toBe('missing');
    expect(statusOf(result, 'release')).toBe('provided_unverified');
  });

  it('verifies identity, evidence, manifest and mapping for matched closed days; still not_ready (invitations, release, destination)', () => {
    const a = pair(DAY);
    const b = pair(DAY2, ['900201']);
    const result = evaluateReadiness({
      reports: [a.report, b.report],
      manifests: [a.manifest, b.manifest],
      mapping: { [ASSIGNEE]: 'sales@example.test' },
      env: ENV,
    });
    for (const name of ['form_evidence', 'manifest'] as const) {
      expect(statusOf(result, name)).toBe('verified');
    }
    expect(statusOf(result, 'portal_identity')).toBe('provided_unverified');
    expect(statusOf(result, 'staff_mapping')).toBe('provided_unverified');
    expect(statusOf(result, 'destination')).toBe('provided_unverified');
    expect(statusOf(result, 'recovery')).toBe('skipped_by_owner');
    expect(result.overall).toBe('not_ready');
  });

  it('destination is never verified from presence: blank is missing, any value is provided_unverified', () => {
    expect(statusOf(evaluateReadiness({ env: { PRODUCTION_SUPABASE_PROJECT_REF: '  ' } }), 'destination')).toBe('missing');
    expect(statusOf(evaluateReadiness({ env: {} }), 'destination')).toBe('missing');
    expect(statusOf(evaluateReadiness({ env: { PRODUCTION_SUPABASE_PROJECT_REF: true } }), 'destination')).toBe('provided_unverified');
    expect(statusOf(evaluateReadiness({ env: ENV }), 'destination')).toBe('provided_unverified');
  });

  it('recovery is always skipped_by_owner, invitations missing, release provided_unverified', () => {
    const a = pair();
    const result = evaluateReadiness({ reports: [a.report], manifests: [a.manifest], mapping: { [ASSIGNEE]: 'x' }, env: ENV });
    expect(statusOf(result, 'recovery')).toBe('skipped_by_owner');
    expect(statusOf(result, 'invitations')).toBe('missing');
    expect(statusOf(result, 'release')).toBe('provided_unverified');
  });

  it('overall is not_ready when any gate is missing', () => {
    const a = pair();
    const result = evaluateReadiness({ reports: [a.report], manifests: [a.manifest], env: ENV });
    expect(statusOf(result, 'staff_mapping')).toBe('missing');
    expect(result.overall).toBe('not_ready');
  });

  describe('portal_identity', () => {
    it('is provided_unverified for an unverified member ID report', () => {
      const result = evaluateReadiness({ reports: [report({ memberIdStatus: 'unverified' })] });
      expect(statusOf(result, 'portal_identity')).toBe('provided_unverified');
    });

    it('is provided_unverified when reports say verified but no manifest carries the member ID', () => {
      expect(statusOf(evaluateReadiness({ reports: [report()] }), 'portal_identity')).toBe('provided_unverified');
    });

    it('is provided_unverified with manifests only', () => {
      expect(statusOf(evaluateReadiness({ manifests: [pair().manifest] }), 'portal_identity')).toBe('provided_unverified');
    });

    it('is blocked when inputs name two portals', () => {
      const m = manifestFor(DAY, LEAD_IDS, 'other-portal.example.test');
      const result = evaluateReadiness({ reports: [report()], manifests: [{ sha256: m.sha256, data: m.data }] });
      expect(statusOf(result, 'portal_identity')).toBe('blocked');
    });

    it('is blocked when manifests carry two member IDs', () => {
      const a = pair(DAY);
      const b = pair(DAY2);
      const other = { ...b.manifest.data, memberId: 'synthetic-member-0002' };
      const result = evaluateReadiness({
        reports: [a.report, b.report],
        manifests: [a.manifest, { sha256: sha256Hex(JSON.stringify(other)), data: other }],
      });
      expect(statusOf(result, 'portal_identity')).toBe('blocked');
    });
  });

  describe('form_evidence', () => {
    it('defaults the requested days to the approved days', () => {
      expect([...APPROVED_BUSINESS_DATES]).toEqual([DAY, DAY2]);
      const result = evaluateReadiness({ reports: [report()] });
      expect(statusOf(result, 'form_evidence')).toBe('missing');
      expect(result.gates.find((g) => g.gate === 'form_evidence')!.reason).toBe('1 requested day(s) have no selection report');
      expect(statusOf(evaluateReadiness({ reports: [report()], days: [] }), 'form_evidence')).toBe('missing');
    });

    it('is missing when any requested day has no report, even with other closed days', () => {
      expect(statusOf(evaluateReadiness({ reports: [report()], days: [DAY, '2026-10-06'] }), 'form_evidence')).toBe('missing');
    });

    it('is verified for exactly the requested days', () => {
      expect(statusOf(evaluateReadiness({ reports: [report()], days: [DAY] }), 'form_evidence')).toBe('verified');
      expect(statusOf(evaluateReadiness({ reports: [report()], days: [DAY, DAY] }), 'form_evidence')).toBe('verified');
    });

    it('is provided_unverified when a requested day has only an open-day report', () => {
      const open = report({ dayStatus: 'open', providerTime: '2026-10-04T18:00:00+05:30' });
      expect(statusOf(evaluateReadiness({ reports: [open], days: [DAY] }), 'form_evidence')).toBe('provided_unverified');
      const open2 = report({ dayStatus: 'open', providerTime: '2026-10-05T18:00:00+05:30' }, DAY2, ['900201']);
      expect(statusOf(evaluateReadiness({ reports: [report(), open2] }), 'form_evidence')).toBe('provided_unverified');
    });

    it('missing wins over an open day', () => {
      const open = report({ dayStatus: 'open', providerTime: '2026-10-04T18:00:00+05:30' });
      expect(statusOf(evaluateReadiness({ reports: [open] }), 'form_evidence')).toBe('missing');
    });

    it('rejects an invalid requested day', () => {
      expect(() => evaluateReadiness({ days: ['2026-02-30'] })).toThrow('pilot-readiness: --business-date must be a valid YYYY-MM-DD date');
    });

    it('is verified for closed day reports', () => {
      expect(statusOf(evaluateReadiness({ reports: [report(), report({}, DAY2, ['900201'])] }), 'form_evidence')).toBe('verified');
    });

    it('is blocked for two reports of the same day', () => {
      expect(statusOf(evaluateReadiness({ reports: [report(), report()] }), 'form_evidence')).toBe('blocked');
    });

    it('is blocked when a manifest day has no report', () => {
      const b = pair(DAY2);
      expect(statusOf(evaluateReadiness({ reports: [report()], manifests: [b.manifest] }), 'form_evidence')).toBe('blocked');
    });
  });

  describe('manifest', () => {
    it('is missing when a report names a manifest that was not given', () => {
      expect(statusOf(evaluateReadiness({ reports: [pair().report] }), 'manifest')).toBe('missing');
    });

    it('is provided_unverified with no report to compare', () => {
      expect(statusOf(evaluateReadiness({ manifests: [pair().manifest] }), 'manifest')).toBe('provided_unverified');
    });

    it('is provided_unverified when a closed day with selected Leads has no manifest yet', () => {
      const a = pair(DAY);
      const result = evaluateReadiness({ reports: [a.report, report({}, DAY2, ['900201'])], manifests: [a.manifest] });
      expect(statusOf(result, 'manifest')).toBe('provided_unverified');
    });

    it('is provided_unverified when one of two named manifests was not given', () => {
      const a = pair(DAY);
      const b = pair(DAY2, ['900201']);
      expect(statusOf(evaluateReadiness({ reports: [a.report, b.report], manifests: [a.manifest] }), 'manifest')).toBe(
        'provided_unverified',
      );
    });

    it('is blocked on a mismatched sha256', () => {
      const a = pair();
      const result = evaluateReadiness({ reports: [a.report], manifests: [{ sha256: 'f'.repeat(64), data: a.manifest.data }] });
      expect(statusOf(result, 'manifest')).toBe('blocked');
    });

    it('is blocked when the manifest IDs differ from the selected list', () => {
      const m = manifestFor(DAY, ['900001', '900003']);
      const r = report({ manifest: { fileName: 'm.json', sha256: m.sha256, expectedCount: 2 } });
      const result = evaluateReadiness({ reports: [r], manifests: [{ sha256: m.sha256, data: m.data }] });
      expect(statusOf(result, 'manifest')).toBe('blocked');
    });

    it('is blocked when the manifest count differs from the selected list', () => {
      const m = manifestFor(DAY, ['900001']);
      const r = report({ manifest: { fileName: 'm.json', sha256: m.sha256, expectedCount: 2 } });
      const result = evaluateReadiness({ reports: [r], manifests: [{ sha256: m.sha256, data: m.data }] });
      expect(statusOf(result, 'manifest')).toBe('blocked');
    });

    it('is blocked when the manifest day differs from its report', () => {
      const m = manifestFor(DAY2, LEAD_IDS);
      const r = report({ manifest: { fileName: 'm.json', sha256: m.sha256, expectedCount: 2 } });
      const result = evaluateReadiness({ reports: [r, report({}, DAY2, ['900201'])], manifests: [{ sha256: m.sha256, data: m.data }] });
      expect(statusOf(result, 'manifest')).toBe('blocked');
    });

    it('is blocked when the manifest portal differs from its report', () => {
      const m = manifestFor(DAY, LEAD_IDS, 'other-portal.example.test');
      const r = report({ manifest: { fileName: 'm.json', sha256: m.sha256, expectedCount: 2 } });
      expect(statusOf(evaluateReadiness({ reports: [r], manifests: [{ sha256: m.sha256, data: m.data }] }), 'manifest')).toBe('blocked');
    });

    it('is blocked when a manifest does not parse, is given twice, or is not a Lead manifest', () => {
      const a = pair();
      const broken = { ...a.manifest.data, version: 1 };
      expect(statusOf(evaluateReadiness({ reports: [a.report], manifests: [{ sha256: a.manifest.sha256, data: broken }] }), 'manifest')).toBe(
        'blocked',
      );
      expect(statusOf(evaluateReadiness({ reports: [a.report], manifests: [a.manifest, a.manifest] }), 'manifest')).toBe('blocked');
      const deal = { ...a.manifest.data, sourceObject: 'deal' };
      expect(statusOf(evaluateReadiness({ reports: [a.report], manifests: [{ sha256: a.manifest.sha256, data: deal }] }), 'manifest')).toBe(
        'blocked',
      );
    });
  });

  describe('staff_mapping', () => {
    it('is provided_unverified with no report', () => {
      expect(statusOf(evaluateReadiness({ mapping: { [ASSIGNEE]: 'x' } }), 'staff_mapping')).toBe('provided_unverified');
    });

    it('is blocked when a selected assignee has no entry', () => {
      expect(statusOf(evaluateReadiness({ reports: [report()], mapping: { '1': 'x' } }), 'staff_mapping')).toBe('blocked');
    });

    it('is blocked when a selected Lead has no assignee (null statusId is accepted)', () => {
      const r = report();
      (r.selected as Json[])[0]!.assignedById = null;
      (r.selected as Json[])[0]!.statusId = null;
      const result = evaluateReadiness({ reports: [r], mapping: { [ASSIGNEE]: 'x' } });
      expect(statusOf(result, 'staff_mapping')).toBe('blocked');
      expect(result.gates.find((g) => g.gate === 'staff_mapping')!.reason).toBe('1 selected Lead(s) have no assignee');
    });

    it('is verified when every selected assignee has an entry', () => {
      expect(statusOf(evaluateReadiness({ reports: [report()], mapping: { [ASSIGNEE]: 'x' } }), 'staff_mapping')).toBe('provided_unverified');
    });

    it('rejects a malformed mapping', () => {
      expect(() => evaluateReadiness({ mapping: ['7701'] })).toThrow(ReadinessError);
      expect(() => evaluateReadiness({ mapping: { abc: 'x' } })).toThrow('invalid staff mapping: key');
      expect(() => evaluateReadiness({ mapping: { '7701': '' } })).toThrow('invalid staff mapping: value');
    });
  });
});

describe('parseSelectionReport', () => {
  it('accepts a valid report, flat or nested per-reason counts, and numeric IDs', () => {
    expect(parseSelectionReport(report()).selected).toEqual([
      { id: '900001', assignedById: ASSIGNEE },
      { id: '900002', assignedById: ASSIGNEE },
    ]);
    const nested = report({
      counts: { leadsInDay: 4, selected: 2, excluded: 2, excludedByReason: { source_not_webform: 1, form_not_approved: 1 } },
    });
    expect(() => parseSelectionReport(nested)).not.toThrow();
    const numeric = report();
    (numeric.selected as Json[])[0]!.assignedById = 7701;
    expect(parseSelectionReport(numeric).selected[0]!.assignedById).toBe('7701');
  });

  it.each([
    ['unknown kind', { kind: 'tripnavigate.other' }],
    ['unknown version', { version: 2 }],
    ['unexpected or missing fields', { extra: true }],
    ['memberIdStatus', { memberIdStatus: 'guessed' }],
    ['businessDate', { businessDate: '2026-02-30' }],
    ['timezone', { timezone: 'UTC' }],
    ['interval', { interval: { from: 'x', to: 'y' } }],
    ['dayStatus does not match providerTime', { providerTime: '2026-10-04T12:00:00+05:30' }],
    ['formsInScope', { formsInScope: ['133', '133'] }],
    ['counts do not match the lists', { counts: { leadsInDay: 9, selected: 2, excluded: 2 } }],
    ['counts per reason', { counts: { leadsInDay: 4, selected: 2, excluded: 2, source_not_webform: 2 } }],
    ['manifest present where the contract forbids one', { memberIdStatus: 'unverified', manifest: { fileName: 'm.json', sha256: 'a'.repeat(64), expectedCount: 2 } }],
    ['manifest sha256', { manifest: { fileName: 'm.json', sha256: 'XYZ', expectedCount: 2 } }],
    ['manifest expectedCount', { manifest: { fileName: 'm.json', sha256: 'a'.repeat(64), expectedCount: 3 } }],
  ])('rejects %s', (message, overrides) => {
    expect(() => parseSelectionReport(report(overrides as Json))).toThrow(`invalid selection report: ${message}`);
  });

  it('rejects an open day with a manifest, a selected form outside scope and duplicate IDs', () => {
    const open = report({
      dayStatus: 'open',
      providerTime: '2026-10-04T18:00:00+05:30',
      manifest: { fileName: 'm.json', sha256: 'a'.repeat(64), expectedCount: 2 },
    });
    expect(() => parseSelectionReport(open)).toThrow('manifest present where the contract forbids one');
    const badForm = report();
    (badForm.selected as Json[])[0]!.form = '999';
    expect(() => parseSelectionReport(badForm)).toThrow('selected form');
    for (const reason of ['source_not_webform', 'no_crm_form_activity']) {
      const withForms = report();
      (withForms.excluded as Json[])[0] = { id: '900101', reason, forms: ['133'] };
      expect(() => parseSelectionReport(withForms)).toThrow('invalid selection report: excluded forms');
    }
    const dup = report({}, DAY, ['900001', '900001']);
    expect(() => parseSelectionReport(dup)).toThrow('duplicate id');
  });

  it('never echoes input values in its error', () => {
    try {
      parseSelectionReport(report({ portalDomain: 'SECRET VALUE' }));
      throw new Error('expected a failure');
    } catch (error) {
      expect((error as Error).message).toBe('pilot-readiness: invalid selection report: portalDomain');
    }
  });
});

describe('formatReadiness and parseArgs', () => {
  it('prints a fixed table with the footer and no IDs or values', () => {
    const a = pair();
    const result = evaluateReadiness({ reports: [a.report], manifests: [a.manifest], mapping: { [ASSIGNEE]: 'sales@example.test' }, env: ENV });
    const text = formatReadiness(result, { reportCount: 1, manifestCount: 1, mappingGiven: true });
    expect(text).toContain('overall: not_ready');
    expect(text).toContain(FOOTER);
    for (const secret of [PORTAL, MEMBER, ASSIGNEE, a.manifest.sha256, 'sales@example.test', 'synthetic-ref-value', ...LEAD_IDS]) {
      expect(text).not.toContain(secret);
    }
  });

  it('parses repeatable options and rejects unknown or valueless ones', () => {
    expect(parseArgs(['--selection-report', 'a', '--selection-report', 'b', '--manifest', 'm', '--mapping', 'x'])).toEqual({
      reports: ['a', 'b'],
      manifests: ['m'],
      mapping: 'x',
      days: [],
    });
    expect(parseArgs(['--business-date', DAY, '--business-date', DAY2]).days).toEqual([DAY, DAY2]);
    expect(() => parseArgs(['--business-date'])).toThrow('--business-date needs a YYYY-MM-DD date');
    expect(() => parseArgs(['--out', 'x'])).toThrow('unknown option');
    expect(() => parseArgs(['--manifest'])).toThrow('--manifest needs a file path');
    expect(() => parseArgs(['--mapping', 'a', '--mapping', 'b'])).toThrow('--mapping may be given once');
  });
});

describe('CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-readiness-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // Any network attempt fails the run loudly.
  const NO_NETWORK = 'data:text/javascript,globalThis.fetch=()=>{throw new Error("network call attempted")}';

  function write(name: string, text: string) {
    const path = join(dir, name);
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  }

  function run(args: string[], env: Record<string, string> = {}) {
    return spawnSync(process.execPath, ['--import', NO_NETWORK, SCRIPT, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv,
    });
  }

  it('hashes the manifest file bytes, prints only the table and exits 0', () => {
    const m = manifestFor();
    const manifestPath = write('manifest.json', m.text);
    const reportPath = write(
      'report.json',
      JSON.stringify(report({ manifest: { fileName: 'manifest.json', sha256: m.sha256, expectedCount: 2 } })),
    );
    const mappingPath = write('mapping.json', JSON.stringify({ [ASSIGNEE]: 'sales@example.test' }));
    const result = run(['--selection-report', reportPath, '--manifest', manifestPath, '--mapping', mappingPath], ENV);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/^manifest\s+verified\s/m);
    expect(result.stdout).toMatch(/^destination\s+provided_unverified\s/m);
    expect(result.stdout).toMatch(/^recovery\s+skipped_by_owner\s/m);
    expect(result.stdout).toContain('overall: not_ready');
    expect(result.stdout).toContain('Validation success never counts as an import.');
    for (const secret of [PORTAL, MEMBER, ASSIGNEE, m.sha256, 'sales@example.test', 'synthetic-ref-value', dir, ...LEAD_IDS]) {
      expect(result.stdout).not.toContain(secret);
    }
  });

  it('blocks the manifest gate when the file bytes differ from the recorded sha256', () => {
    const m = manifestFor();
    const manifestPath = write('reformatted.json', JSON.stringify(m.data));
    const reportPath = write(
      'report-b.json',
      JSON.stringify(report({ manifest: { fileName: 'reformatted.json', sha256: m.sha256, expectedCount: 2 } })),
    );
    const result = run(['--selection-report', reportPath, '--manifest', manifestPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^manifest\s+blocked\s/m);
    expect(result.stdout).toMatch(/^destination\s+missing\s/m);
  });

  it('form_evidence follows --business-date and defaults to both approved days', () => {
    const reportPath = write('report-day.json', JSON.stringify(report()));
    const defaults = run(['--selection-report', reportPath]);
    expect(defaults.status).toBe(0);
    expect(defaults.stdout).toMatch(/^form_evidence\s+missing\s/m);
    expect(defaults.stdout).toContain('inputs: 2 requested day(s)');
    const one = run(['--selection-report', reportPath, '--business-date', DAY]);
    expect(one.status).toBe(0);
    expect(one.stdout).toMatch(/^form_evidence\s+verified\s/m);
    expect(one.stdout).toContain('inputs: 1 requested day(s)');
    expect(one.stdout).not.toContain(DAY);
  });

  it('runs with no inputs and reports every gate missing or fixed', () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('overall: not_ready');
  });

  it.each([
    ['unreadable file', ['--selection-report', '/nonexistent/pilot-readiness/report.json'], 'pilot-readiness: cannot read selection report'],
    ['invalid JSON', ['--manifest', 'BAD_JSON'], 'pilot-readiness: manifest is not valid JSON'],
    ['malformed report', ['--selection-report', 'BAD_REPORT'], 'pilot-readiness: invalid selection report: unknown kind'],
    ['unknown option', ['--network', 'yes'], 'pilot-readiness: unknown option'],
    ['invalid business date', ['--business-date', '2026-13-01'], 'pilot-readiness: --business-date must be a valid YYYY-MM-DD date'],
  ])('exits 1 on %s with a fixed message', (_label, rawArgs, message) => {
    const badJson = write('bad.json', '{ not json');
    const badReport = write('bad-report.json', JSON.stringify({ kind: 'other', secret: 'SECRET-CONTENT' }));
    const args = rawArgs.map((a) => (a === 'BAD_JSON' ? badJson : a === 'BAD_REPORT' ? badReport : a));
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe(message);
    expect(result.stderr).not.toContain('SECRET-CONTENT');
  });
});


describe('review regressions: offline evidence is not operational verification', () => {
  it('never verifies a guessed member ID or a nonexistent mapped user', () => {
    const a = pair();
    const result = evaluateReadiness({ reports: [a.report], manifests: [a.manifest], mapping: { [ASSIGNEE]: 'not-a-real-staff-user' }, days: [DAY] });
    expect(statusOf(result, 'portal_identity')).toBe('provided_unverified');
    expect(statusOf(result, 'staff_mapping')).toBe('provided_unverified');
  });
  it('refuses a report selecting an unapproved form', () => {
    expect(() => parseSelectionReport(report({ formsInScope: ['999'] }))).toThrow(ReadinessError);
  });
  it('blocks a manifest whose source contradicts the WEBFORM selection', () => {
    const a = pair();
    const data = { ...a.manifest.data, sourceCode: 'CALL', filter: selectionFilter(istInterval(DAY), 'CALL') };
    const sha256 = sha256Hex(JSON.stringify(data) + '\n');
    const r = { ...a.report, manifest: { fileName: 'manifest.json', sha256, expectedCount: LEAD_IDS.length } };
    expect(statusOf(evaluateReadiness({ reports: [r], manifests: [{ data, sha256 }], days: [DAY] }), 'manifest')).toBe('blocked');
  });
});
