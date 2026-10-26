#!/usr/bin/env node
// OFFLINE, READ-ONLY pilot readiness report (Phase 6 selection contract,
// docs/implementation/history/phase-6/selection-contract.md section 5).
//
// Usage:
//   node scripts/pilot-readiness.mjs \
//     [--selection-report <private report.json>]... \
//     [--manifest <private manifest.json>]... \
//     [--mapping <private staff-mapping.json>] \
//     [--business-date YYYY-MM-DD]...
//
// Requested days default to the owner-approved days (contract section 0):
// 2026-10-04 and 2026-10-05 (Asia/Kolkata).
//
// What it does:
//   - Reads the given private files only. No network call is made, nothing is
//     written, Bitrix and Supabase are never contacted.
//   - Reads only the PRESENCE of PRODUCTION_SUPABASE_PROJECT_REF from the
//     process environment; its value is never stored, compared or printed.
//   - Prints a fixed-format table of gates and statuses. Lead IDs, staff IDs,
//     names, portal hosts, member IDs, hashes and file contents are never
//     printed.
//   - Exit 0 for every well-formed run (it is a report, not a gate); exit 1
//     with `pilot-readiness: <fixed message>` on unreadable or malformed input.
//
// Validation success never counts as an import. Only the database and the
// comparator can report imported, already present, held or failed records.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { istInterval, MANIFEST_TIMEZONE, parseManifest } from './bitrix-lead-manifest.mjs';

export const SELECTION_REPORT_KIND = 'tripnavigate.bitrix-lead-selection-report';
export const SELECTION_REPORT_VERSION = 1;

export const GATES = Object.freeze([
  'portal_identity',
  'form_evidence',
  'manifest',
  'staff_mapping',
  'destination',
  'recovery',
  'invitations',
  'release',
]);
export const STATUSES = Object.freeze(['missing', 'provided_unverified', 'verified', 'skipped_by_owner', 'blocked']);
/** Owner-approved business days (contract section 0); the default requested days. */
export const APPROVED_BUSINESS_DATES = Object.freeze(['2026-10-04', '2026-10-05']);
export const EXCLUSION_REASONS = Object.freeze(['source_not_webform', 'no_crm_form_activity', 'form_not_approved']);

export const FOOTER =
  'Validation success never counts as an import. Nothing was imported, written or sent; ' +
  'only the database and the comparator can report imported, already present, held or failed records.';

const ID = /^[1-9][0-9]{0,15}$/;
const FORM_ID = /^[1-9][0-9]{0,15}$/;
const PORTAL_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FILE_NAME = /^[^/\\\0]{1,255}$/;
const REPORT_KEYS = Object.freeze([
  'kind',
  'version',
  'portalDomain',
  'memberIdStatus',
  'businessDate',
  'timezone',
  'interval',
  'dayStatus',
  'providerTime',
  'selectionStartedAt',
  'selectionFinishedAt',
  'formsInScope',
  'evidenceRule',
  'counts',
  'selected',
  'excluded',
  'manifest',
]);

export class ReadinessError extends Error {
  constructor(code) {
    super(`pilot-readiness: ${code}`);
    this.name = 'ReadinessError';
    this.code = code;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasExactKeys = (obj, keys) =>
  isObject(obj) && Object.keys(obj).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isInstant = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));

/** Bitrix IDs may be serialised as strings or safe integers; normalise to a string. */
function idString(value) {
  const s = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof s !== 'string' || !ID.test(s) || Number(s) > Number.MAX_SAFE_INTEGER) return null;
  return s;
}

function formId(value) {
  const s = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof s === 'string' && FORM_ID.test(s) ? s : null;
}

/**
 * Strict validation of a selection report (contract section 3). Throws a
 * ReadinessError with a fixed message; never echoes any value.
 */
export function parseSelectionReport(value) {
  const fail = (why) => {
    throw new ReadinessError(`invalid selection report: ${why}`);
  };
  if (!isObject(value)) fail('not an object');
  if (value.kind !== SELECTION_REPORT_KIND) fail('unknown kind');
  if (value.version !== SELECTION_REPORT_VERSION) fail('unknown version');
  if (!hasExactKeys(value, REPORT_KEYS)) fail('unexpected or missing fields');
  if (typeof value.portalDomain !== 'string' || !PORTAL_DOMAIN.test(value.portalDomain)) fail('portalDomain');
  if (!['verified', 'unverified', 'provided_unverified'].includes(value.memberIdStatus)) fail('memberIdStatus');
  let interval;
  try {
    interval = istInterval(value.businessDate);
  } catch {
    fail('businessDate');
  }
  if (value.timezone !== MANIFEST_TIMEZONE) fail('timezone');
  const iv = value.interval;
  const ivKeysOk = hasExactKeys(iv, ['from', 'to']) || hasExactKeys(iv, ['from', 'to', 'bounds']);
  if (!ivKeysOk || iv.from !== interval.from || iv.to !== interval.to || ('bounds' in iv && iv.bounds !== '[)')) fail('interval');
  if (value.dayStatus !== 'open' && value.dayStatus !== 'closed') fail('dayStatus');
  for (const key of ['providerTime', 'selectionStartedAt', 'selectionFinishedAt']) {
    if (!isInstant(value[key])) fail(key);
  }
  if (Date.parse(value.selectionFinishedAt) < Date.parse(value.selectionStartedAt)) fail('selection finished before it started');
  // A closed day is proven by provider time at or after the interval end (section 2 step 2).
  const closedByTime = Date.parse(value.providerTime) >= Date.parse(interval.to);
  if ((value.dayStatus === 'closed') !== closedByTime) fail('dayStatus does not match providerTime');
  if (!Array.isArray(value.formsInScope) || value.formsInScope.length === 0) fail('formsInScope');
  const forms = value.formsInScope.map(formId);
  if (forms.some((f) => f === null) || new Set(forms).size !== forms.length) fail('formsInScope');
  if (forms.length !== 3 || [...forms].sort().join(',') !== '133,135,137') fail('forms are outside the owner-approved scope');
  if (!APPROVED_BUSINESS_DATES.includes(value.businessDate)) fail('business date is outside the owner-approved scope');
  if (typeof value.evidenceRule !== 'string' || value.evidenceRule.trim() === '') fail('evidenceRule');

  if (!Array.isArray(value.selected)) fail('selected');
  const seen = new Set();
  const selected = value.selected.map((row) => {
    if (!hasExactKeys(row, ['id', 'created', 'statusId', 'assignedById', 'form', 'activityIds'])) fail('selected entry fields');
    const id = idString(row.id);
    if (id === null) fail('selected id');
    if (seen.has(id)) fail('duplicate id');
    seen.add(id);
    const created = Date.parse(row.created);
    if (!isInstant(row.created) || created < Date.parse(interval.from) || created >= Date.parse(interval.to)) fail('selected created');
    // The selector records null when Bitrix returns no usable status or assignee.
    if (row.statusId !== null && (typeof row.statusId !== 'string' || row.statusId === '')) fail('selected statusId');
    const assignedById = row.assignedById === null ? null : idString(row.assignedById);
    if (row.assignedById !== null && assignedById === null) fail('selected assignedById');
    const form = formId(row.form);
    if (form === null || !forms.includes(form)) fail('selected form');
    if (!Array.isArray(row.activityIds) || row.activityIds.length === 0 || row.activityIds.some((a) => idString(a) === null)) {
      fail('selected activityIds');
    }
    return { id, assignedById };
  });

  if (!Array.isArray(value.excluded)) fail('excluded');
  const reasonCounts = Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, 0]));
  for (const row of value.excluded) {
    if (!hasExactKeys(row, ['id', 'reason', 'forms'])) fail('excluded entry fields');
    const id = idString(row.id);
    if (id === null) fail('excluded id');
    if (seen.has(id)) fail('duplicate id');
    seen.add(id);
    if (!EXCLUSION_REASONS.includes(row.reason)) fail('excluded reason');
    if (!Array.isArray(row.forms) || row.forms.some((f) => formId(f) === null)) fail('excluded forms');
    if (row.reason !== 'form_not_approved' && row.forms.length !== 0) fail('excluded forms');
    if (row.reason === 'form_not_approved' && (row.forms.length !== 1 || forms.includes(formId(row.forms[0])))) fail('excluded forms');
    reasonCounts[row.reason] += 1;
  }

  const c = value.counts;
  if (!isObject(c) || !isCount(c.leadsInDay) || !isCount(c.selected) || !isCount(c.excluded)) fail('counts');
  if (c.selected !== selected.length || c.excluded !== value.excluded.length || c.leadsInDay !== c.selected + c.excluded) {
    fail('counts do not match the lists');
  }
  // Per-reason counts may be flat keys or one nested object; either must agree with the list.
  const extra = Object.keys(c).filter((k) => !['leadsInDay', 'selected', 'excluded'].includes(k));
  for (const key of extra) {
    const v = c[key];
    if (isCount(v)) {
      if (!EXCLUSION_REASONS.includes(key) || v !== reasonCounts[key]) fail('counts per reason');
    } else if (isObject(v)) {
      for (const [reason, n] of Object.entries(v)) {
        if (!EXCLUSION_REASONS.includes(reason) || !isCount(n) || n !== reasonCounts[reason]) fail('counts per reason');
      }
    } else {
      fail('counts per reason');
    }
  }

  let manifest = null;
  if (value.manifest !== null) {
    const m = value.manifest;
    if (!hasExactKeys(m, ['fileName', 'sha256', 'expectedCount'])) fail('manifest fields');
    if (typeof m.fileName !== 'string' || !FILE_NAME.test(m.fileName)) fail('manifest fileName');
    if (typeof m.sha256 !== 'string' || !SHA256.test(m.sha256)) fail('manifest sha256');
    if (!isCount(m.expectedCount) || m.expectedCount !== selected.length) fail('manifest expectedCount');
    // Section 3: a manifest exists only for a closed day, a verified member ID and at least one selected Lead.
    if (value.dayStatus !== 'closed' || value.memberIdStatus === 'unverified' || selected.length === 0) {
      fail('manifest present where the contract forbids one');
    }
    manifest = { sha256: m.sha256, expectedCount: m.expectedCount };
  }

  return {
    portalDomain: value.portalDomain,
    memberIdStatus: value.memberIdStatus,
    businessDate: value.businessDate,
    dayStatus: value.dayStatus,
    selected,
    manifest,
  };
}

/** Private staff mapping `{ "<bitrixUserId>": "<crm staff email or id>" }`; only keys are used. */
export function parseStaffMapping(value) {
  if (!isObject(value)) throw new ReadinessError('invalid staff mapping: not an object');
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!ID.test(key)) throw new ReadinessError('invalid staff mapping: key');
    if (typeof value[key] !== 'string' || value[key].trim() === '') throw new ReadinessError('invalid staff mapping: value');
  }
  return new Set(keys);
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const gate = (name, status, reason) => ({ gate: name, status, reason });
const sameIds = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

function portalIdentityGate(reports, manifests) {
  if (reports.length === 0 && manifests.length === 0) return gate('portal_identity', 'missing', 'no selection report or manifest given');
  const parsed = manifests.filter((m) => m.parsed);
  const domains = new Set([...reports.map((r) => r.portalDomain), ...parsed.map((m) => m.parsed.portalDomain)]);
  const members = new Set(parsed.map((m) => m.parsed.memberId));
  if (domains.size > 1) return gate('portal_identity', 'blocked', 'inputs name more than one portal');
  if (members.size > 1) return gate('portal_identity', 'blocked', 'manifests carry more than one member ID');
  if (reports.length === 0) return gate('portal_identity', 'provided_unverified', 'no selection report records member ID status');
  if (reports.some((r) => r.memberIdStatus !== 'verified')) {
    return gate('portal_identity', 'provided_unverified', 'a selection report says the member ID is unverified');
  }
  if (members.size === 0) return gate('portal_identity', 'provided_unverified', 'no parsed manifest carries a member ID');
  return gate('portal_identity', 'provided_unverified', 'files contain an asserted member ID; authenticated portal evidence must be verified separately');
}

function formEvidenceGate(reports, manifests, requestedDays) {
  if (reports.length === 0) return gate('form_evidence', 'missing', 'no selection report given');
  const days = new Map();
  for (const r of reports) {
    const key = `${r.portalDomain} ${r.businessDate}`;
    if (days.has(key)) return gate('form_evidence', 'blocked', 'more than one selection report for one day');
    days.set(key, r);
  }
  for (const m of manifests) {
    if (m.parsed && !days.has(`${m.parsed.portalDomain} ${m.parsed.businessDate}`)) {
      return gate('form_evidence', 'blocked', 'a manifest day has no selection report');
    }
  }
  const forDay = (day) => reports.filter((r) => r.businessDate === day);
  const without = requestedDays.filter((day) => forDay(day).length === 0).length;
  if (without > 0) return gate('form_evidence', 'missing', `${without} requested day(s) have no selection report`);
  if (requestedDays.some((day) => forDay(day).some((r) => r.dayStatus !== 'closed'))) {
    return gate('form_evidence', 'provided_unverified', 'a requested day has only an open-day snapshot');
  }
  return gate('form_evidence', 'verified', 'every requested day has a closed-day selection report');
}

function manifestGate(reports, manifests) {
  const expected = reports.filter((r) => r.manifest);
  if (manifests.length === 0) {
    if (expected.length > 0) return gate('manifest', 'missing', 'a selection report names a manifest that was not given');
    return gate('manifest', 'missing', 'no manifest given');
  }
  if (manifests.some((m) => !m.parsed)) return gate('manifest', 'blocked', 'a manifest does not parse');
  if (manifests.some((m) => m.parsed.sourceCode !== 'WEBFORM')) return gate('manifest', 'blocked', 'a manifest source is not WEBFORM');
  if (manifests.some((m) => m.parsed.sourceObject !== 'lead')) return gate('manifest', 'blocked', 'a manifest is not a Lead manifest');
  if (new Set(manifests.map((m) => m.sha256)).size !== manifests.length) return gate('manifest', 'blocked', 'the same manifest was given twice');
  if (reports.length === 0) return gate('manifest', 'provided_unverified', 'no selection report to compare the manifests with');
  for (const m of manifests) {
    const report = expected.find((r) => r.manifest.sha256 === m.sha256);
    if (!report) return gate('manifest', 'blocked', 'a manifest sha256 matches no selection report');
    const p = m.parsed;
    if (p.businessDate !== report.businessDate) return gate('manifest', 'blocked', 'a manifest day differs from its report');
    if (p.portalDomain !== report.portalDomain) return gate('manifest', 'blocked', 'a manifest portal differs from its report');
    if (p.expectedCount !== report.manifest.expectedCount || p.ids.length !== report.selected.length) {
      return gate('manifest', 'blocked', 'a manifest count differs from its report');
    }
    if (!sameIds(p.ids, report.selected.map((s) => s.id))) return gate('manifest', 'blocked', 'manifest IDs differ from the selected list');
  }
  if (expected.some((r) => !manifests.some((m) => m.sha256 === r.manifest.sha256))) {
    return gate('manifest', 'provided_unverified', 'a selection report names a manifest that was not given');
  }
  if (reports.some((r) => !r.manifest && r.selected.length > 0)) {
    return gate('manifest', 'provided_unverified', 'a day with selected Leads has no manifest yet');
  }
  return gate('manifest', 'verified', 'every manifest equals its report and sha256');
}

function staffMappingGate(reports, mapping) {
  if (!mapping) return gate('staff_mapping', 'missing', 'no staff mapping given');
  if (reports.length === 0) return gate('staff_mapping', 'provided_unverified', 'no selection report to check the mapping against');
  const unmapped = new Set();
  let unassigned = 0;
  for (const r of reports) {
    for (const s of r.selected) {
      if (s.assignedById === null) unassigned += 1;
      else if (!mapping.has(s.assignedById)) unmapped.add(s.assignedById);
    }
  }
  if (unassigned > 0) return gate('staff_mapping', 'blocked', `${unassigned} selected Lead(s) have no assignee`);
  if (unmapped.size > 0) return gate('staff_mapping', 'blocked', `${unmapped.size} assigned Bitrix user(s) have no mapping entry`);
  return gate('staff_mapping', 'provided_unverified', 'mapping entries cover assignees; active CRM Sales membership in the pilot branch must be verified separately');
}

/**
 * Pure readiness evaluation (contract section 5). `reports` are raw parsed
 * JSON values (validated strictly here; a malformed report throws).
 * `manifests` are `{ sha256, data }` with the sha256 of the file bytes and
 * the raw parsed JSON. `mapping` is the raw parsed JSON or null/undefined.
 * `env` is consulted for the presence of PRODUCTION_SUPABASE_PROJECT_REF only.
 * `days` are the requested IST business days (default: the approved days).
 */
export function evaluateReadiness({ reports = [], manifests = [], mapping = null, env = {}, days = APPROVED_BUSINESS_DATES } = {}) {
  const requestedDays = parseBusinessDates(days);
  const parsedReports = reports.map(parseSelectionReport);
  const parsedManifests = manifests.map((m) => {
    if (!isObject(m) || typeof m.sha256 !== 'string' || !SHA256.test(m.sha256)) throw new ReadinessError('invalid manifest input');
    let parsed = null;
    try {
      parsed = parseManifest(m.data);
    } catch {
      parsed = null;
    }
    return { sha256: m.sha256, parsed };
  });
  const mappingKeys = mapping === null || mapping === undefined ? null : parseStaffMapping(mapping);
  const ref = env?.PRODUCTION_SUPABASE_PROJECT_REF;
  const destinationPresent = typeof ref === 'string' ? ref.trim() !== '' : ref === true;

  const gates = [
    portalIdentityGate(parsedReports, parsedManifests),
    formEvidenceGate(parsedReports, parsedManifests, requestedDays),
    manifestGate(parsedReports, parsedManifests),
    staffMappingGate(parsedReports, mappingKeys),
    destinationPresent
      ? gate('destination', 'provided_unverified', 'project ref is present; presence never verifies the destination')
      : gate('destination', 'missing', 'PRODUCTION_SUPABASE_PROJECT_REF is not set'),
    gate('recovery', 'skipped_by_owner', 'owner decision of 5 October 2026'),
    gate('invitations', 'missing', 'operator records SMTP, redirect URLs and recipients outside this script'),
    gate('release', 'provided_unverified', 'operator reads release state from GitHub and Vercel'),
  ];
  const overall = gates.every((g) => g.status === 'verified' || g.status === 'skipped_by_owner') ? 'ready' : 'not_ready';
  return { gates, overall };
}

/** Validated, de-duplicated requested days; an empty list means the approved days. */
export function parseBusinessDates(days) {
  if (!Array.isArray(days)) throw new ReadinessError('requested days must be a list');
  const list = days.length === 0 ? [...APPROVED_BUSINESS_DATES] : days;
  for (const day of list) {
    try {
      istInterval(day);
    } catch {
      throw new ReadinessError('--business-date must be a valid YYYY-MM-DD date');
    }
  }
  return [...new Set(list)];
}

/** Fixed-format table. Gate names, statuses and fixed reasons only. */
export function formatReadiness(
  { gates, overall },
  { reportCount = 0, manifestCount = 0, mappingGiven = false, dayCount = APPROVED_BUSINESS_DATES.length } = {},
) {
  const lines = ['pilot-readiness (offline, read-only)', ''];
  lines.push(`${'gate'.padEnd(16)} ${'status'.padEnd(20)} reason`);
  for (const g of gates) lines.push(`${g.gate.padEnd(16)} ${g.status.padEnd(20)} ${g.reason}`);
  lines.push('');
  lines.push(`overall: ${overall}`);
  lines.push(
    `inputs: ${dayCount} requested day(s), ${reportCount} selection report(s), ${manifestCount} manifest(s), ` +
      `mapping ${mappingGiven ? 'given' : 'not given'}`,
  );
  lines.push(FOOTER);
  return lines.join('\n');
}

/** Parses argv into repeatable file lists. Unknown or valueless options throw. */
export function parseArgs(argv) {
  const out = { reports: [], manifests: [], mapping: null, days: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!['--selection-report', '--manifest', '--mapping', '--business-date'].includes(name)) throw new ReadinessError('unknown option');
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
      throw new ReadinessError(name === '--business-date' ? '--business-date needs a YYYY-MM-DD date' : `${name} needs a file path`);
    }
    i += 1;
    if (name === '--business-date') out.days.push(value);
    else if (name === '--selection-report') out.reports.push(value);
    else if (name === '--manifest') out.manifests.push(value);
    else if (out.mapping !== null) throw new ReadinessError('--mapping may be given once');
    else out.mapping = value;
  }
  return out;
}

function readBytes(path, what) {
  try {
    return readFileSync(path);
  } catch {
    throw new ReadinessError(`cannot read ${what}`);
  }
}

function parseJson(bytes, what) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ReadinessError(`${what} is not valid JSON`);
  }
}

export function runCli(argv, processEnv) {
  const args = parseArgs(argv);
  const days = parseBusinessDates(args.days);
  const reports = args.reports.map((p) => parseJson(readBytes(p, 'selection report'), 'selection report'));
  const manifests = args.manifests.map((p) => {
    const bytes = readBytes(p, 'manifest');
    return { sha256: sha256Hex(bytes), data: parseJson(bytes, 'manifest') };
  });
  const mapping = args.mapping === null ? null : parseJson(readBytes(args.mapping, 'staff mapping'), 'staff mapping');
  // Presence only: the value never leaves this expression.
  const env = { PRODUCTION_SUPABASE_PROJECT_REF: Boolean(processEnv.PRODUCTION_SUPABASE_PROJECT_REF?.trim()) };
  const result = evaluateReadiness({ reports, manifests, mapping, env, days });
  return formatReadiness(result, {
    reportCount: reports.length,
    manifestCount: manifests.length,
    mappingGiven: mapping !== null,
    dayCount: days.length,
  });
}

function main() {
  try {
    console.log(runCli(process.argv.slice(2), process.env));
  } catch (error) {
    console.error(error instanceof ReadinessError ? error.message : 'pilot-readiness: unexpected failure');
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
