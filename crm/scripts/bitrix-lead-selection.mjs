#!/usr/bin/env node
// READ-ONLY selection of one IST business day of sales-form Leads, with
// form-origin provenance (docs/implementation/history/phase-6/selection-contract.md
// sections 1-4).
//
// Usage (the credential comes ONLY from the process environment):
//   BITRIX_WEBHOOK_BASE_URL=... node scripts/bitrix-lead-selection.mjs \
//     --portal-domain <portal host> --business-date YYYY-MM-DD --forms 133,135,137 \
//     --report-out /private/path/outside/git/lead-selection-report.json \
//     [--member-id <verified portal member id> \
//      --manifest-out /private/path/outside/git/lead-manifest.json]
//
// What it does:
//   1. Freezes the business date as the half-open Asia/Kolkata interval used by
//      bitrix-lead-manifest.mjs (istInterval).
//   2. Calls crm.activity.fields once and stops unless OWNER_ID, OWNER_TYPE_ID,
//      PROVIDER_ID and PROVIDER_TYPE_ID exist.
//   3. Reads server.time once. The day is `closed` only when provider time is at
//      or after the interval end; otherwise `open`.
//   4. Reads every page of crm.lead.list for the interval (no source filter),
//      selecting ID, SOURCE_ID, DATE_CREATE, STATUS_ID, ASSIGNED_BY_ID.
//   5. For each WEBFORM Lead, reads every page of crm.activity.list with
//      { OWNER_TYPE_ID: 1, OWNER_ID: <id> } and takes the distinct
//      PROVIDER_TYPE_ID values of its CRM_WEBFORM rows as the form origin.
//   6. Classifies each Lead (selected, or excluded with a reason code). More
//      than one distinct form on one Lead stops the run.
//   7. Writes a private selection report (always, when the run succeeds) and,
//      only for a closed day with --member-id and at least one selected Lead, a
//      version 2 manifest that the existing parseManifest accepts. Both files
//      are mode 600, never overwritten and refused inside this repository or
//      any Git working tree. Nothing is written when any step fails.
//
// Output on the console: counts and day status only. Lead IDs, names, titles
// and URLs are never printed. Nothing is written to Bitrix.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertPrivateOutputPath,
  buildManifest,
  istInterval,
  ManifestError,
  MANIFEST_TIMEZONE,
  parseManifest,
  selectionFilter,
} from './bitrix-lead-manifest.mjs';
import { createReadOnlyCaller, PilotInspectError } from './bitrix-pilot-inspect.mjs';
import { MetadataError, redact, resolveBaseUrl } from './lib/bitrix-metadata.mjs';

export const SELECTION_REPORT_KIND = 'tripnavigate.bitrix-lead-selection-report';
export const SELECTION_REPORT_VERSION = 1;
/** Stop when the business day holds more Leads than this (contract section 2 step 6). */
export const MAX_SELECTION_LEADS = 500;
/** crm.lead.list returns at most 50 rows per page; 500 Leads fit in 10 pages. */
export const MAX_LEAD_PAGES = 20;
/** Bound on the activity pages read for one Lead. */
export const MAX_ACTIVITY_PAGES = 20;
export const WEBFORM_SOURCE = 'WEBFORM';
export const WEBFORM_PROVIDER = 'CRM_WEBFORM';
/** crm.activity OWNER_TYPE_ID for a Lead. */
export const LEAD_OWNER_TYPE_ID = 1;
export const DAY_LEAD_SELECT = Object.freeze(['ID', 'SOURCE_ID', 'DATE_CREATE', 'STATUS_ID', 'ASSIGNED_BY_ID']);
export const DAY_ACTIVITY_SELECT = Object.freeze(['ID', 'OWNER_ID', 'OWNER_TYPE_ID', 'PROVIDER_ID', 'PROVIDER_TYPE_ID', 'CREATED']);
export const REQUIRED_ACTIVITY_FIELDS = Object.freeze(['OWNER_ID', 'OWNER_TYPE_ID', 'PROVIDER_ID', 'PROVIDER_TYPE_ID']);
export const EXCLUSION_REASONS = Object.freeze(['source_not_webform', 'no_crm_form_activity', 'form_not_approved']);
export const EVIDENCE_RULE =
  "A Lead's form origin is the set of distinct PROVIDER_TYPE_ID values of its crm.activity rows where " +
  "OWNER_TYPE_ID = 1 (Lead), OWNER_ID = the Lead ID and PROVIDER_ID = 'CRM_WEBFORM'. " +
  "SOURCE_ID = 'WEBFORM' is editable and is an additional filter, not proof.";

const ID = /^[1-9][0-9]{0,15}$/;
/** Same rule as FORM_ID in pilot-readiness.mjs: a positive integer without leading zeros. */
const FORM_ID = /^[1-9][0-9]{0,15}$/;
const PORTAL_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const MEMBER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class SelectionError extends Error {
  constructor(code) {
    super(`bitrix-lead-selection: ${code}`);
    this.name = 'SelectionError';
    this.code = code;
  }
}

const instant = (v) => {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : null;
};

const validId = (value) => {
  const id = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return ID.test(id) && Number(id) <= Number.MAX_SAFE_INTEGER ? id : null;
};

const byNumericId = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

/** Parses --forms: comma-separated digits only, de-duplicated, sorted numerically. */
export function parseForms(value) {
  const parts = String(value ?? '').split(',').map((s) => s.trim());
  if (parts.length === 0 || parts.some((p) => !FORM_ID.test(p))) {
    throw new SelectionError('--forms must be a comma-separated list of form IDs (digits only)');
  }
  return [...new Set(parts)].sort((a, b) => byNumericId(a, b));
}

/**
 * Reads every page of a list method. Fails closed on a missing or changed total,
 * a non-advancing `next`, a partial page, or a row count that differs from total.
 * `onRow` validates and keeps each row (it throws SelectionError to stop).
 */
async function readAllPages(caller, method, params, { maxPages, maxTotal, onRow }) {
  let total = null;
  let start = 0;
  let pages = 0;
  let count = 0;
  for (;;) {
    if (pages >= maxPages) throw new SelectionError(`${method}: too many pages; nothing written`);
    const body = await caller.call(method, { ...params, start });
    pages += 1;
    const rows = body?.result;
    if (!Array.isArray(rows)) throw new SelectionError(`${method} returned no result list`);
    if (typeof body.total !== 'number' || !Number.isInteger(body.total) || body.total < 0) {
      throw new SelectionError(`${method} returned no total; cannot prove completeness`);
    }
    if (total === null) total = body.total;
    else if (total !== body.total) throw new SelectionError(`${method}: total changed between pages; re-run the selection`);
    if (maxTotal !== undefined && total > maxTotal) {
      throw new SelectionError(`more than ${maxTotal} Leads in the business day; nothing written`);
    }
    for (const row of rows) {
      onRow(row);
      count += 1;
    }
    const next = body.next;
    if (next === undefined || next === null) break;
    if (typeof next !== 'number' || !Number.isInteger(next) || next <= start) {
      throw new SelectionError(`${method}: pagination did not advance`);
    }
    if (rows.length !== next - start) throw new SelectionError(`${method}: partial page; nothing written`);
    start = next;
  }
  if (count !== total) throw new SelectionError(`${method}: read ${count} of ${total} rows; incomplete, nothing written`);
  return { total, pages };
}

/** Calls crm.activity.fields once and stops unless the provenance fields exist. */
export async function assertActivityMetadata(caller) {
  const body = await caller.call('crm.activity.fields', {});
  const fields = body?.result;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new SelectionError('crm.activity.fields returned no field map');
  }
  for (const name of REQUIRED_ACTIVITY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(fields, name)) {
      throw new SelectionError(`crm.activity.fields has no ${name}; form origin cannot be proven`);
    }
  }
}

/** Reads server.time once. The day is closed only when provider time >= interval end. */
export async function readDayStatus(caller, interval) {
  const body = await caller.call('server.time', {});
  const providerTime = typeof body?.result === 'string' ? body.result : '';
  const at = instant(providerTime);
  if (at === null) throw new SelectionError('server.time returned no usable time');
  const end = instant(interval.to);
  return { providerTime, dayStatus: at >= end ? 'closed' : 'open' };
}

/** Reads every Lead created in the interval (no source filter), ordered by ID. */
export async function selectDayLeads(caller, { interval, maxPages = MAX_LEAD_PAGES, maxLeads = MAX_SELECTION_LEADS }) {
  const from = instant(interval.from);
  const to = instant(interval.to);
  const leads = [];
  const seen = new Set();
  const filter = { '>=DATE_CREATE': interval.from, '<DATE_CREATE': interval.to };
  const { total, pages } = await readAllPages(
    caller,
    'crm.lead.list',
    { filter, select: [...DAY_LEAD_SELECT], order: { ID: 'ASC' } },
    {
      maxPages,
      maxTotal: maxLeads,
      onRow: (row) => {
        const id = validId(row?.ID);
        if (!id) throw new SelectionError('crm.lead.list returned an invalid ID');
        const created = instant(row.DATE_CREATE);
        if (created === null || created < from || created >= to) {
          throw new SelectionError('crm.lead.list returned a record outside the date interval');
        }
        if (seen.has(id)) throw new SelectionError('crm.lead.list returned a duplicate ID; re-run the selection');
        seen.add(id);
        leads.push({
          id,
          sourceId: typeof row.SOURCE_ID === 'string' ? row.SOURCE_ID : null,
          created: String(row.DATE_CREATE),
          statusId: typeof row.STATUS_ID === 'string' ? row.STATUS_ID : null,
          assignedById: validId(row.ASSIGNED_BY_ID),
        });
      },
    },
  );
  if (leads.length > maxLeads) throw new SelectionError(`more than ${maxLeads} Leads in the business day; nothing written`);
  leads.sort((a, b) => byNumericId(a.id, b.id));
  return { leads, total, pages };
}

/**
 * Reads every crm.activity row owned by one Lead. Any row owned by another
 * record stops the run. Returns the CRM_WEBFORM activity IDs and form IDs.
 */
export async function readLeadActivities(caller, leadId, { maxPages = MAX_ACTIVITY_PAGES } = {}) {
  const seen = new Set();
  const webform = [];
  await readAllPages(
    caller,
    'crm.activity.list',
    { filter: { OWNER_TYPE_ID: LEAD_OWNER_TYPE_ID, OWNER_ID: leadId }, select: [...DAY_ACTIVITY_SELECT], order: { ID: 'ASC' } },
    {
      maxPages,
      onRow: (row) => {
        const id = validId(row?.ID);
        if (!id) throw new SelectionError('crm.activity.list returned an invalid ID');
        if (String(row.OWNER_TYPE_ID) !== String(LEAD_OWNER_TYPE_ID) || String(row.OWNER_ID) !== leadId) {
          throw new SelectionError('crm.activity.list returned an activity owned by another record; nothing written');
        }
        if (seen.has(id)) throw new SelectionError('crm.activity.list returned a duplicate ID; re-run the selection');
        seen.add(id);
        if (row.PROVIDER_ID !== WEBFORM_PROVIDER) return;
        const form = typeof row.PROVIDER_TYPE_ID === 'string' || typeof row.PROVIDER_TYPE_ID === 'number' ? String(row.PROVIDER_TYPE_ID) : '';
        if (!FORM_ID.test(form)) throw new SelectionError('crm.activity.list returned a web-form activity without a form ID');
        webform.push({ id, form });
      },
    },
  );
  webform.sort((a, b) => byNumericId(a.id, b.id));
  return webform;
}

/**
 * Classifies one Lead (contract section 2 step 5). `activities` is the
 * CRM_WEBFORM list from readLeadActivities (ignored when SOURCE_ID is not WEBFORM).
 */
export function classifyLead(lead, activities, formsInScope) {
  if (lead.sourceId !== WEBFORM_SOURCE) return { status: 'excluded', id: lead.id, reason: 'source_not_webform', forms: [] };
  const forms = [...new Set((activities ?? []).map((a) => a.form))].sort(byNumericId);
  if (forms.length === 0) return { status: 'excluded', id: lead.id, reason: 'no_crm_form_activity', forms: [] };
  if (forms.length > 1) throw new SelectionError('ambiguous_form_origin: a Lead has more than one web form; nothing written');
  const form = forms[0];
  if (!formsInScope.includes(form)) return { status: 'excluded', id: lead.id, reason: 'form_not_approved', forms };
  return {
    status: 'selected',
    id: lead.id,
    created: lead.created,
    statusId: lead.statusId,
    assignedById: lead.assignedById,
    form,
    activityIds: activities.map((a) => a.id),
  };
}

/**
 * Runs the whole read-only selection. Throws SelectionError (or the caller's
 * PilotInspectError) on any stop condition; returns everything needed to write
 * the outputs otherwise. Nothing is written here.
 */
export async function runSelection(caller, { portalDomain, memberId, businessDate, formsInScope, now = () => new Date() }) {
  if (!['2026-10-04', '2026-10-05'].includes(businessDate)) {
    throw new SelectionError('business date is outside the owner-approved scope');
  }
  if (formsInScope.length !== 3 || [...formsInScope].sort().join(',') !== '133,135,137') {
    throw new SelectionError('forms must match the owner-approved scope: 133,135,137');
  }
  const interval = istInterval(businessDate);
  const selectionStartedAt = now().toISOString();
  await assertActivityMetadata(caller);
  const { providerTime, dayStatus } = await readDayStatus(caller, interval);
  const { leads } = await selectDayLeads(caller, { interval });
  const selected = [];
  const excluded = [];
  for (const lead of leads) {
    const activities = lead.sourceId === WEBFORM_SOURCE ? await readLeadActivities(caller, lead.id) : [];
    const result = classifyLead(lead, activities, formsInScope);
    if (result.status === 'selected') {
      selected.push({
        id: result.id,
        created: result.created,
        statusId: result.statusId,
        assignedById: result.assignedById,
        form: result.form,
        activityIds: result.activityIds,
      });
    } else {
      excluded.push({ id: result.id, reason: result.reason, forms: result.forms });
    }
  }
  const selectionFinishedAt = now().toISOString();

  let manifest = null;
  let manifestSkipped = null;
  if (dayStatus !== 'closed') manifestSkipped = 'day is open';
  else if (!memberId) manifestSkipped = 'no --member-id';
  else if (selected.length === 0) manifestSkipped = 'no Lead selected';
  else {
    manifest = buildManifest({
      portalDomain,
      memberId,
      businessDate,
      sourceCode: WEBFORM_SOURCE,
      interval,
      filter: selectionFilter(interval, WEBFORM_SOURCE),
      ids: selected.map((s) => s.id),
      selectedAt: selectionStartedAt,
    });
    try {
      parseManifest(manifest, { sourceObject: 'lead' });
    } catch {
      throw new SelectionError('built manifest failed validation; nothing written');
    }
  }

  const report = buildSelectionReport({
    portalDomain,
    memberId,
    businessDate,
    interval,
    dayStatus,
    providerTime,
    selectionStartedAt,
    selectionFinishedAt,
    formsInScope,
    leadsInDay: leads.length,
    selected,
    excluded,
  });
  return { report, manifest, manifestSkipped };
}

/** Builds the selection report (contract section 3). `manifest` is filled in after the manifest is written. */
export function buildSelectionReport({
  portalDomain,
  memberId,
  businessDate,
  interval,
  dayStatus,
  providerTime,
  selectionStartedAt,
  selectionFinishedAt,
  formsInScope,
  leadsInDay,
  selected,
  excluded,
  manifest = null,
}) {
  const excludedByReason = Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, excluded.filter((e) => e.reason === r).length]));
  return {
    kind: SELECTION_REPORT_KIND,
    version: SELECTION_REPORT_VERSION,
    portalDomain,
    memberIdStatus: memberId ? 'provided_unverified' : 'unverified',
    businessDate,
    timezone: MANIFEST_TIMEZONE,
    interval: { from: interval.from, to: interval.to, bounds: '[)' },
    dayStatus,
    providerTime,
    selectionStartedAt,
    selectionFinishedAt,
    formsInScope: [...formsInScope],
    evidenceRule: EVIDENCE_RULE,
    counts: { leadsInDay, selected: selected.length, excluded: excluded.length, excludedByReason },
    selected: selected.map((s) => ({ ...s, activityIds: [...s.activityIds] })),
    excluded: excluded.map((e) => ({ ...e, forms: [...e.forms] })),
    manifest,
  };
}

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Exact manifest bytes; the same serialization as writeManifest in bitrix-lead-manifest.mjs. */
export const serializeManifest = (manifest) => JSON.stringify(manifest, null, 2) + '\n';

/**
 * Writes one private file (mode 600, flag 'wx'). On failure removes a file this
 * call created (never a file that already existed) and returns false.
 */
function writePrivateFile(path, text) {
  try {
    writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') removeQuietly(path);
    return false;
  }
  try {
    chmodSync(path, 0o600);
    return true;
  } catch {
    removeQuietly(path);
    return false;
  }
}

function removeQuietly(path) {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return !existsSync(path);
  }
}

/**
 * Writes the report first and then the manifest (if any), both mode 600 with
 * flag 'wx'. The manifest is serialized in memory and the report records the
 * sha256 of exactly those bytes. Nothing remains on any failure: when the
 * manifest write fails, the report written by this call is removed.
 */
export function writeSelectionOutputs({ reportPath, manifestPath, report, manifest }) {
  let finalReport = report;
  let manifestText = null;
  if (manifest) {
    if (!manifestPath) throw new SelectionError('--manifest-out is required to write a manifest; nothing written');
    if (manifestPath === reportPath) throw new SelectionError('--manifest-out and --report-out must differ');
    manifestText = serializeManifest(manifest);
    finalReport = {
      ...report,
      manifest: { fileName: basename(manifestPath), sha256: sha256Hex(manifestText), expectedCount: manifest.expectedCount },
    };
  }
  if (!writePrivateFile(reportPath, JSON.stringify(finalReport, null, 2) + '\n')) {
    throw new SelectionError('report write failed (file exists or directory not writable); nothing written');
  }
  if (manifestText !== null && !writePrivateFile(manifestPath, manifestText)) {
    if (!removeQuietly(reportPath)) {
      throw new SelectionError('manifest write failed and the report could not be removed; delete the report before re-running');
    }
    throw new SelectionError('manifest write failed (file exists or directory not writable); report removed, nothing written');
  }
  return finalReport;
}

/** assertPrivateOutputPath with the flag name of this script in its fixed messages. */
function privatePath(flag, value) {
  try {
    return assertPrivateOutputPath(value);
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new SelectionError(error.code.replace(/^--out\b/, flag).replace('write the manifest', 'write the output'));
    }
    throw error;
  }
}

/** Console summary: counts and day status only. */
export function formatSummary(report, manifestSkipped) {
  const c = report.counts;
  const reasons = EXCLUSION_REASONS.map((r) => `${r} ${c.excludedByReason[r]}`).join(', ');
  const manifest = report.manifest ? `manifest written (${report.manifest.expectedCount} IDs, mode 600)` : `no manifest (${manifestSkipped})`;
  return (
    `bitrix-lead-selection: day ${report.dayStatus}; leads in day ${c.leadsInDay}, selected ${c.selected}, ` +
    `excluded ${c.excluded} (${reasons}); member id ${report.memberIdStatus}; ${manifest}; report written (mode 600)`
  );
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const raw = process.env.BITRIX_WEBHOOK_BASE_URL;
  const secrets = [raw?.trim()];
  try {
    const businessDate = String(arg('--business-date') ?? '');
    istInterval(businessDate);
    const formsInScope = parseForms(arg('--forms'));
    const host = String(arg('--portal-domain') ?? '').trim().toLowerCase();
    if (!PORTAL_DOMAIN.test(host)) throw new SelectionError('--portal-domain <portal host> is required');
    const memberRaw = arg('--member-id');
    let memberId = null;
    if (memberRaw !== undefined) {
      if (!MEMBER_ID.test(memberRaw)) throw new SelectionError('--member-id must be a verified portal member id');
      memberId = memberRaw;
    }
    const reportPath = privatePath('--report-out', arg('--report-out'));
    let manifestPath = null;
    if (memberId) {
      manifestPath = privatePath('--manifest-out', arg('--manifest-out'));
      if (manifestPath === reportPath) throw new SelectionError('--manifest-out and --report-out must differ');
    } else if (arg('--manifest-out') !== undefined) {
      throw new SelectionError('--manifest-out needs --member-id; without it no manifest is written');
    }
    if (!raw || !raw.trim()) throw new SelectionError('BITRIX_WEBHOOK_BASE_URL is not set in the process environment');
    const baseUrl = resolveBaseUrl(raw, host, process.env.APP_ENV);
    if (new URL(baseUrl).hostname !== host) throw new SelectionError('webhook host does not match --portal-domain');
    secrets.push(baseUrl);

    const caller = createReadOnlyCaller(baseUrl, { minIntervalMs: Number(process.env.BITRIX_MIN_INTERVAL_MS ?? 600) || 600 });
    const { report, manifest, manifestSkipped } = await runSelection(caller, { portalDomain: host, memberId, businessDate, formsInScope });
    const written = writeSelectionOutputs({ reportPath, manifestPath, report, manifest });
    console.log(formatSummary(written, manifestSkipped));
  } catch (error) {
    const code =
      error instanceof SelectionError || error instanceof ManifestError || error instanceof MetadataError || error instanceof PilotInspectError
        ? error.code
        : 'unexpected failure';
    console.error(redact(`bitrix-lead-selection: ${code}`, secrets));
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
