#!/usr/bin/env node
// READ-ONLY selection of the owner-approved Lead intake manifest (Phase 6,
// docs/implementation/history/phase-6/contract.md section 2.3 and 2.7).
//
// Usage (the credential comes ONLY from the process environment):
//   BITRIX_WEBHOOK_BASE_URL=... node scripts/bitrix-lead-manifest.mjs \
//     --portal-domain <verified portal host> --member-id <verified portal member id> \
//     --business-date YYYY-MM-DD --source-code WEBFORM \
//     --out /private/path/outside/git/lead-manifest.json
//
// What it does:
//   1. Freezes the business date as the half-open Asia/Kolkata interval
//      [D 00:00 +05:30, D+1 00:00 +05:30) on DATE_CREATE.
//   2. Reads ALL pages of crm.lead.list with filter
//      { '>=DATE_CREATE': from, '<DATE_CREATE': to, '=SOURCE_ID': code },
//      select ID, SOURCE_ID, DATE_CREATE only, ordered by ID.
//   3. Stops with an error on any provider error, partial page, inconsistent
//      `total`, non-advancing `next`, duplicate ID, or a row outside the filter.
//      Nothing is written then.
//   4. Writes a private manifest JSON (mode 600, never overwrites, refused
//      inside this repository or any Git working tree) holding verified portal
//      host/member identity, selectedAt, businessDate, interval, filter,
//      expectedCount and ids. Member identity must come from verified portal
//      configuration, not a guess based on Lead IDs.
//
// Output on the console: counts only. Titles, names, phones, e-mails and other
// lead content are never requested, stored or printed. Nothing is written to
// Bitrix. The manifest is the input to integration_manifest_create (operator
// command, service role) and to scripts/bitrix-pilot-compare.mjs --manifest-file.

import { chmodSync, existsSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReadOnlyCaller, PilotInspectError } from './bitrix-pilot-inspect.mjs';
import { MetadataError, redact, resolveBaseUrl } from './lib/bitrix-metadata.mjs';

export const MANIFEST_KIND = 'tripnavigate.bitrix-intake-manifest';
export const MANIFEST_VERSION = 2;
export const MANIFEST_TIMEZONE = 'Asia/Kolkata';
const IST_OFFSET = '+05:30';
/** Upper bound for one manifest (owner-scale daily intake, far below this). */
export const MAX_MANIFEST_IDS = 5_000;
/** crm.lead.list returns at most 50 rows per page; 100 pages bound the read. */
export const MAX_SELECTION_PAGES = 100;
export const SELECTION_SELECT = Object.freeze(['ID', 'SOURCE_ID', 'DATE_CREATE']);

const ID = /^[1-9][0-9]{0,15}$/;
// Same rule as intake_manifests.source_code / crm_leads.source_id_code
// (migration 20261007000100): ^[A-Za-z0-9_:.-]{1,50}$.
export const SOURCE_CODE = /^[A-Za-z0-9_:.-]{1,50}$/;
const BUSINESS_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PORTAL_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const MEMBER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class ManifestError extends Error {
  constructor(code) {
    super(`bitrix-lead-manifest: ${code}`);
    this.name = 'ManifestError';
    this.code = code;
  }
}

/** Half-open IST interval for a calendar business date (validated, no rollover). */
export function istInterval(businessDate) {
  const m = BUSINESS_DATE.exec(String(businessDate ?? ''));
  if (!m) throw new ManifestError('--business-date must be YYYY-MM-DD');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || y < 2000 || y > 2100) {
    throw new ManifestError('--business-date is not a valid calendar date');
  }
  const next = new Date(day.getTime() + 86_400_000).toISOString().slice(0, 10);
  return { from: `${m[0]}T00:00:00${IST_OFFSET}`, to: `${next}T00:00:00${IST_OFFSET}` };
}

export function parseSourceCode(value) {
  const code = String(value ?? '').trim();
  if (!SOURCE_CODE.test(code)) throw new ManifestError('--source-code must be a Bitrix SOURCE_ID code such as WEBFORM');
  return code;
}

export function selectionFilter(interval, sourceCode) {
  return { '>=DATE_CREATE': interval.from, '<DATE_CREATE': interval.to, '=SOURCE_ID': sourceCode };
}

const instant = (v) => {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : null;
};

/**
 * Reads every page of crm.lead.list for the frozen filter. Fails closed on any
 * sign of an incomplete or inconsistent read. Returns ids (ascending) and counts.
 */
export async function selectLeadIds(caller, { interval, sourceCode, maxPages = MAX_SELECTION_PAGES }) {
  const filter = selectionFilter(interval, sourceCode);
  const from = instant(interval.from);
  const to = instant(interval.to);
  const ids = [];
  const seen = new Set();
  let total = null;
  let start = 0;
  let pages = 0;
  for (;;) {
    if (pages >= maxPages) throw new ManifestError('too many pages; nothing written');
    const body = await caller.call('crm.lead.list', { filter, select: [...SELECTION_SELECT], order: { ID: 'ASC' }, start });
    pages += 1;
    const rows = body.result;
    if (!Array.isArray(rows)) throw new ManifestError('crm.lead.list returned no result list');
    if (typeof body.total !== 'number' || !Number.isInteger(body.total) || body.total < 0) {
      throw new ManifestError('crm.lead.list returned no total; cannot prove completeness');
    }
    if (total === null) total = body.total;
    else if (total !== body.total) throw new ManifestError('total changed between pages; re-run the selection');
    if (total > MAX_MANIFEST_IDS) throw new ManifestError(`more than ${MAX_MANIFEST_IDS} records; narrow the selection`);
    for (const row of rows) {
      const id = row && (typeof row.ID === 'string' || typeof row.ID === 'number') ? String(row.ID) : '';
      if (!ID.test(id) || Number(id) > Number.MAX_SAFE_INTEGER) throw new ManifestError('crm.lead.list returned an invalid ID');
      if (row.SOURCE_ID !== sourceCode) throw new ManifestError('crm.lead.list returned a record outside the source filter');
      const created = instant(row.DATE_CREATE);
      if (created === null || created < from || created >= to) {
        throw new ManifestError('crm.lead.list returned a record outside the date interval');
      }
      if (seen.has(id)) throw new ManifestError('crm.lead.list returned a duplicate ID; re-run the selection');
      seen.add(id);
      ids.push(id);
    }
    const next = body.next;
    if (next === undefined || next === null) break;
    if (typeof next !== 'number' || !Number.isInteger(next) || next <= start) {
      throw new ManifestError('crm.lead.list pagination did not advance');
    }
    // A page that is shorter than the step to `next` is a partial page.
    if (rows.length !== next - start) throw new ManifestError('partial page from crm.lead.list; nothing written');
    start = next;
  }
  if (ids.length !== total) throw new ManifestError(`read ${ids.length} of ${total} records; incomplete, nothing written`);
  ids.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  return { ids, total, pages, filter };
}

export function buildManifest({ portalDomain, memberId, businessDate, sourceCode, interval, filter, ids, selectedAt }) {
  return {
    kind: MANIFEST_KIND,
    version: MANIFEST_VERSION,
    sourceSystem: 'bitrix',
    sourceObject: 'lead',
    portalDomain,
    memberId,
    selectedAt,
    businessDate,
    timezone: MANIFEST_TIMEZONE,
    interval: { from: interval.from, to: interval.to, bounds: '[)' },
    sourceCode,
    filter,
    expectedCount: ids.length,
    ids: [...ids],
  };
}

const sameKeys = (obj, keys) =>
  obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));

/**
 * Validates a whole manifest (every field and every id). Throws an Error with a
 * fixed message; callers re-wrap it with their own prefix.
 */
export function parseManifest(value, { sourceObject } = {}) {
  const fail = (why) => {
    throw new ManifestError(`invalid manifest: ${why}`);
  };
  if (value?.version === 1) fail('legacy manifest has no verified portal identity; regenerate before activation');
  const keys = ['kind', 'version', 'sourceSystem', 'sourceObject', 'portalDomain', 'memberId', 'selectedAt', 'businessDate', 'timezone', 'interval', 'sourceCode', 'filter', 'expectedCount', 'ids'];
  if (!sameKeys(value, keys)) fail('unexpected or missing fields');
  if (value.kind !== MANIFEST_KIND || value.version !== MANIFEST_VERSION || value.sourceSystem !== 'bitrix') fail('kind');
  if (value.sourceObject !== 'lead' && value.sourceObject !== 'deal') fail('sourceObject');
  if (sourceObject && value.sourceObject !== sourceObject) fail(`manifest is for ${value.sourceObject}, not ${sourceObject}`);
  if (typeof value.portalDomain !== 'string' || !PORTAL_DOMAIN.test(value.portalDomain)) fail('portalDomain');
  if (typeof value.memberId !== 'string' || !MEMBER_ID.test(value.memberId)) fail('memberId');
  if (typeof value.selectedAt !== 'string' || instant(value.selectedAt) === null) fail('selectedAt');
  if (value.timezone !== MANIFEST_TIMEZONE) fail('timezone');
  let interval;
  try { interval = istInterval(value.businessDate); } catch { fail('businessDate'); }
  if (!sameKeys(value.interval, ['from', 'to', 'bounds']) || value.interval.from !== interval.from ||
      value.interval.to !== interval.to || value.interval.bounds !== '[)') fail('interval');
  if (typeof value.sourceCode !== 'string' || !SOURCE_CODE.test(value.sourceCode)) fail('sourceCode');
  const filter = selectionFilter(interval, value.sourceCode);
  if (!sameKeys(value.filter, Object.keys(filter)) || Object.entries(filter).some(([k, v]) => value.filter[k] !== v)) fail('filter');
  if (!Number.isInteger(value.expectedCount) || value.expectedCount < 1 || value.expectedCount > MAX_MANIFEST_IDS) fail('expectedCount');
  if (!Array.isArray(value.ids) || value.ids.some((id) => typeof id !== 'string' || !ID.test(id) || Number(id) > Number.MAX_SAFE_INTEGER)) fail('ids');
  if (new Set(value.ids).size !== value.ids.length) fail('duplicate ids');
  if (value.ids.length !== value.expectedCount) fail('ids count does not equal expectedCount');
  return {
    sourceObject: value.sourceObject,
    portalDomain: value.portalDomain,
    memberId: value.memberId,
    businessDate: value.businessDate,
    interval: { from: interval.from, to: interval.to },
    sourceCode: value.sourceCode,
    expectedCount: value.expectedCount,
    ids: [...value.ids],
  };
}

/** Repository root of this script (crm/..). */
export const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..');

function insideOrEqual(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * The manifest is private: refuse paths inside this repository or inside any
 * Git working tree (a `.git` entry in any ancestor), and refuse to overwrite.
 * Returns the resolved absolute path.
 */
export function assertPrivateOutputPath(out, { repositoryRoot = REPOSITORY_ROOT } = {}) {
  if (!out || typeof out !== 'string') throw new ManifestError('--out <private file outside the repository> is required');
  if (!isAbsolute(out)) throw new ManifestError('--out must be an absolute path outside the repository');
  const target = resolve(out);
  let parent;
  try {
    parent = realpathSync(dirname(target));
  } catch {
    throw new ManifestError('--out directory does not exist');
  }
  let root = resolve(repositoryRoot);
  try { root = realpathSync(root); } catch { /* keep the resolved path */ }
  const full = join(parent, target.slice(dirname(target).length + 1));
  if (insideOrEqual(full, root) || insideOrEqual(target, resolve(repositoryRoot))) {
    throw new ManifestError('--out is inside the repository; write the manifest to a private location');
  }
  for (let dir = parent; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) throw new ManifestError('--out is inside a Git working tree; write the manifest to a private location');
    if (dirname(dir) === dir) break;
  }
  if (existsSync(full)) throw new ManifestError('--out already exists; refusing to overwrite');
  return full;
}

export function writeManifest(path, manifest) {
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
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
    const interval = istInterval(businessDate);
    const sourceCode = parseSourceCode(arg('--source-code'));
    const out = assertPrivateOutputPath(arg('--out'));
    const host = String(arg('--portal-domain') ?? '').trim().toLowerCase();
    if (!PORTAL_DOMAIN.test(host)) throw new ManifestError('--portal-domain <verified portal host> is required');
    const memberId = String(arg('--member-id') ?? '');
    if (!MEMBER_ID.test(memberId)) throw new ManifestError('--member-id <verified portal member id> is required');
    if (!raw || !raw.trim()) throw new ManifestError('BITRIX_WEBHOOK_BASE_URL is not set in the process environment');
    const baseUrl = resolveBaseUrl(raw, host, process.env.APP_ENV);
    if (new URL(baseUrl).hostname !== host) throw new ManifestError('webhook host does not match the verified manifest portal');
    secrets.push(baseUrl);

    const selectedAt = new Date().toISOString();
    const caller = createReadOnlyCaller(baseUrl, { minIntervalMs: Number(process.env.BITRIX_MIN_INTERVAL_MS ?? 600) || 600 });
    const { ids, total, pages, filter } = await selectLeadIds(caller, { interval, sourceCode });
    if (ids.length === 0) {
      console.log(`bitrix-lead-manifest: selected 0 leads (total 0, pages ${pages}); no manifest written`);
      return;
    }
    writeManifest(out, buildManifest({ portalDomain: host, memberId, businessDate, sourceCode, interval, filter, ids, selectedAt }));
    console.log(`bitrix-lead-manifest: selected ${ids.length} leads (total ${total}, pages ${pages}); manifest written (mode 600)`);
  } catch (error) {
    const code =
      error instanceof ManifestError || error instanceof MetadataError || error instanceof PilotInspectError
        ? error.code
        : 'unexpected failure';
    console.error(redact(`bitrix-lead-manifest: ${code}`, secrets));
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
