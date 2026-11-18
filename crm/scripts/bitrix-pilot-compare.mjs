#!/usr/bin/env node
// READ-ONLY Bitrix vs CRM comparison for approved pilot deals (Phase 3.5;
// Phase 5 pilot runbook: docs/implementation/history/phase-5/pilot-runbook.md).
//
// Usage (credentials ONLY from the process environment, never arguments):
//   BITRIX_WEBHOOK_BASE_URL=... SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=... \
//   node scripts/bitrix-pilot-compare.mjs --member-id <portal member id> --approved-ids-file /private/pilot-ids.json [--out file.json]
//
// For each approved Bitrix deal ID it reads, from Bitrix (crm.deal.list with
// '@ID' and select ID, TITLE, STAGE_ID, CATEGORY_ID, ASSIGNED_BY_ID,
// DATE_CREATE, DATE_MODIFY) and from the CRM (deals, bitrix_user_mappings,
// integration_inbox, integration_intake_config via the service role, GET only),
// and reports per field whether they match. Titles are compared by SHA-256
// and never printed. Phase 5 adds: the BX-<id> reference check, an
// ownerMapped flag, `needs_review` (eligible but held for review, with reason
// codes, e.g. unmapped_owner), `duplicate_in_crm` (more than one CRM row for
// one Bitrix deal) and a summary with counts per verdict. Output holds IDs, booleans, stage/category codes and
// inbox status/reason codes only. It never writes to either system.
// The independently approved JSON file contains numeric ID strings only.
// Positive approval requires EVERY approved deal to match. Negative checks
// (needs_review, ineligible deals) never count toward positive pilot success.
//
// Phase 6 (docs/implementation/history/phase-6/contract.md section 2.7):
//   --object lead|deal (default deal). Leads read crm.lead.list (select ID,
//     TITLE, STATUS_ID, SOURCE_ID, ASSIGNED_BY_ID, DATE_CREATE, DATE_MODIFY)
//     and CRM crm_leads (reference BXL-<id>); Leads and Deals never mix.
//   --manifest-file <file>: the private manifest from
//     scripts/bitrix-lead-manifest.mjs, validated in full (every field, every
//     id, count = expectedCount). Required for --object lead.
//   IDs are processed in bounded pages of <= 50; `pass` requires every
//   expected ID to appear exactly once across ALL pages with `match`
//   (a passing first page is not a pass).
//   --check-active-manifest: also require the file to equal the database's
//     active manifest (integration_active_manifest, read-only RPC): same
//     portal/member/config identity, object, source code, business date,
//     creation interval, expected count and IDs.
//   Legacy bare Deal ID lists remain comparison-only. They cannot establish
//   portal-bound manifest approval for activation.
//   --validate-manifest-only: pre-activation validation of a full version 2
//     manifest and its configured portal/member/webhook host binding. Reads
//     integration_intake_config only. Does not inspect an active manifest,
//     source records, mappings, inbox or imported rows. Success is not evidence
//     of import, field parity, form origin or staff mapping. Cannot combine
//     with --ids or --check-active-manifest. --out writes the fixed count-only
//     validation message instead of a comparison JSON report.
//   Errors print `bitrix-pilot-compare: <fixed message>` (credentials redacted)
//   and exit 1 without a result.

import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createReadOnlyCaller, DEAL_SELECT, LEAD_SELECT, PilotInspectError } from './bitrix-pilot-inspect.mjs';
import { ManifestError, MAX_MANIFEST_IDS, parseManifest } from './bitrix-lead-manifest.mjs';

/** integration_inbox column holding the Bitrix record ID (deal or lead, per source_object). */
const INBOX_ID_COLUMN = 'source_deal_id';
import { MetadataError, redact, resolveBaseUrl } from './lib/bitrix-metadata.mjs';

const sha = (s) => createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex');
const ms = (v) => {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : null;
};

/** Pure comparison. bitrix: deal rows; crm: {deals, mappings, inbox, config}. */
export function compareDeals(ids, bitrixRows, crm) {
  const byBitrix = new Map(bitrixRows.map((d) => [String(d.ID), d]));
  const byCrm = new Map();
  const crmCount = new Map();
  for (const d of crm.deals) {
    const key = String(d.source_deal_id);
    if (!byCrm.has(key)) byCrm.set(key, d);
    crmCount.set(key, (crmCount.get(key) ?? 0) + 1);
  }
  const mapping = new Map(crm.mappings.filter((m) => m.active).map((m) => [String(m.bitrix_user_id), String(m.staff_user_id)]));
  const inbox = new Map();
  for (const r of crm.inbox) {
    const list = inbox.get(String(r.source_deal_id)) ?? [];
    list.push({ status: r.status, reasonCode: r.reason_code ?? null, origin: r.origin ?? null });
    inbox.set(String(r.source_deal_id), list);
  }
  return ids.map((id) => {
    const b = byBitrix.get(id);
    const c = byCrm.get(id);
    const row = { id, inBitrix: !!b, inCrm: !!c, crmRows: crmCount.get(id) ?? 0, inbox: inbox.get(id) ?? [] };
    if ((crmCount.get(id) ?? 0) > 1) return { ...row, verdict: 'duplicate_in_crm' };
    if (!b) return { ...row, verdict: 'missing_in_bitrix' };
    row.bitrix = { stageId: String(b.STAGE_ID), categoryId: String(b.CATEGORY_ID), assignedById: String(b.ASSIGNED_BY_ID) };
    row.ownerMapped = mapping.has(String(b.ASSIGNED_BY_ID));
    const eligible =
      String(b.CATEGORY_ID) === String(crm.config.category_id) &&
      (crm.config.eligible_stage_ids ?? []).includes(String(b.STAGE_ID)) &&
      (ms(b.DATE_CREATE) ?? 0) >= (ms(crm.config.cutoff_at) ?? Infinity);
    row.eligibleByConfig = eligible;
    if (!c) {
      const review = row.inbox.filter((i) => i.status === 'needs_review');
      if (eligible && review.length > 0) {
        return { ...row, reviewReasons: [...new Set(review.map((i) => i.reasonCode))], verdict: 'needs_review' };
      }
      return { ...row, verdict: eligible ? 'expected_but_missing_in_crm' : 'not_imported_as_expected' };
    }
    const checks = {
      title: sha(b.TITLE) === sha(c.title),
      stage: String(b.STAGE_ID) === String(c.source_stage_id),
      category: String(b.CATEGORY_ID) === String(c.source_category_id),
      created: ms(b.DATE_CREATE) !== null && ms(b.DATE_CREATE) === ms(c.source_created_at),
      modified: ms(b.DATE_MODIFY) !== null && ms(b.DATE_MODIFY) === ms(c.source_modified_at),
      owner: mapping.get(String(b.ASSIGNED_BY_ID)) === String(c.owner_user_id),
      branch: String(c.branch_id) === String(crm.config.pilot_branch_id),
      entity: String(c.legal_entity_id) === String(crm.config.pilot_legal_entity_id),
      notSynthetic: c.is_synthetic === false,
      reference: c.reference === `BX-${id}`,
    };
    const crmOlder = (ms(c.source_modified_at) ?? 0) < (ms(b.DATE_MODIFY) ?? 0);
    const ok = Object.values(checks).every(Boolean);
    return {
      ...row,
      checks,
      crmBehindBitrix: crmOlder,
      lastSyncedAt: c.last_synced_at ?? null,
      lastVerifiedAt: c.last_verified_at ?? null,
      verdict: ok ? 'match' : crmOlder ? 'crm_behind_bitrix' : 'mismatch',
    };
  });
}

/** Pure Lead comparison (Phase 6). bitrix: lead rows; crm: {leads, mappings, inbox, config, manifest}. */
export function compareLeads(ids, bitrixRows, crm) {
  const byBitrix = new Map(bitrixRows.map((l) => [String(l.ID), l]));
  const byCrm = new Map();
  const crmCount = new Map();
  for (const l of crm.leads) {
    const key = String(l.source_lead_id);
    if (!byCrm.has(key)) byCrm.set(key, l);
    crmCount.set(key, (crmCount.get(key) ?? 0) + 1);
  }
  const mapping = new Map(crm.mappings.filter((m) => m.active).map((m) => [String(m.bitrix_user_id), String(m.staff_user_id)]));
  const inbox = new Map();
  for (const r of crm.inbox) {
    const key = String(r.source_id ?? r.source_deal_id);
    const list = inbox.get(key) ?? [];
    list.push({ status: r.status, reasonCode: r.reason_code ?? null, origin: r.origin ?? null });
    inbox.set(key, list);
  }
  const from = ms(crm.manifest.interval.from);
  const to = ms(crm.manifest.interval.to);
  return ids.map((id) => {
    const b = byBitrix.get(id);
    const c = byCrm.get(id);
    const row = { id, inBitrix: !!b, inCrm: !!c, crmRows: crmCount.get(id) ?? 0, inbox: inbox.get(id) ?? [] };
    if ((crmCount.get(id) ?? 0) > 1) return { ...row, verdict: 'duplicate_in_crm' };
    if (!b) return { ...row, verdict: 'missing_in_bitrix' };
    row.bitrix = { statusId: String(b.STATUS_ID), sourceId: String(b.SOURCE_ID), assignedById: String(b.ASSIGNED_BY_ID) };
    row.ownerMapped = mapping.has(String(b.ASSIGNED_BY_ID));
    const created = ms(b.DATE_CREATE);
    // In scope: the manifest's verified source code and its half-open creation interval.
    const inScope = String(b.SOURCE_ID) === crm.manifest.sourceCode && created !== null && created >= from && created < to;
    row.eligibleByConfig = inScope;
    if (!c) {
      const review = row.inbox.filter((i) => i.status === 'needs_review');
      if (review.length > 0) {
        return { ...row, reviewReasons: [...new Set(review.map((i) => i.reasonCode))], verdict: 'needs_review' };
      }
      return { ...row, verdict: inScope ? 'expected_but_missing_in_crm' : 'not_imported_as_expected' };
    }
    const checks = {
      title: sha(b.TITLE) === sha(c.title),
      status: String(b.STATUS_ID) === String(c.source_status_id),
      sourceCode: String(b.SOURCE_ID) === String(c.source_id_code) && String(c.source_id_code) === crm.manifest.sourceCode,
      created: created !== null && created === ms(c.source_created_at),
      modified: ms(b.DATE_MODIFY) !== null && ms(b.DATE_MODIFY) === ms(c.source_modified_at),
      owner: mapping.get(String(b.ASSIGNED_BY_ID)) === String(c.owner_user_id),
      branch: String(c.branch_id) === String(crm.config.pilot_branch_id),
      entity: String(c.legal_entity_id) === String(crm.config.pilot_legal_entity_id),
      inManifestScope: inScope,
      reference: c.reference === `BXL-${id}`,
    };
    const crmOlder = (ms(c.source_modified_at) ?? 0) < (ms(b.DATE_MODIFY) ?? 0);
    const ok = Object.values(checks).every(Boolean);
    return {
      ...row,
      checks,
      crmBehindBitrix: crmOlder,
      lastSyncedAt: c.last_synced_at ?? null,
      lastVerifiedAt: c.last_verified_at ?? null,
      verdict: ok ? 'match' : crmOlder ? 'crm_behind_bitrix' : 'mismatch',
    };
  });
}

/** Comparator failures: fixed messages with the script's own prefix (never provider text or URLs). */
export class ComparatorError extends Error {
  constructor(code) {
    super(`bitrix-pilot-compare: ${code}`);
    this.name = 'ComparatorError';
    this.code = code;
  }
}

/** Bitrix list methods return at most 50 rows: every read is a page of <= 50 IDs. */
export const COMPARE_PAGE_SIZE = 50;
export const MAX_COMPARE_IDS = MAX_MANIFEST_IDS;

function validIdList(value, max) {
  return Array.isArray(value) && value.length > 0 && value.length <= max &&
    value.every((id) => typeof id === 'string' && /^[1-9][0-9]{0,15}$/.test(id)) &&
    new Set(value).size === value.length;
}

/** Validate the independent, owner-approved positive pilot list (bare JSON array, 1-50 IDs). */
export function parseApprovedIds(value) {
  if (!validIdList(value, COMPARE_PAGE_SIZE)) {
    throw new ComparatorError('approved IDs must be 1-50 unique numeric strings');
  }
  return [...value];
}

/** Splits IDs into pages of at most `size` (default 50). */
export function pageIds(ids, size = COMPARE_PAGE_SIZE) {
  if (!Number.isInteger(size) || size < 1 || size > COMPARE_PAGE_SIZE) throw new ComparatorError('page size must be 1-50');
  const pages = [];
  for (let i = 0; i < ids.length; i += size) pages.push(ids.slice(i, i + size));
  return pages;
}

/**
 * Positive gate over ALL pages: pass only when every expected ID appears exactly
 * once across the aggregated rows and every row is a clean match.
 */
export function summarize(rows, approvedIds) {
  const byVerdict = {};
  for (const r of rows) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  if (!validIdList(approvedIds, MAX_COMPARE_IDS)) return { total: rows.length, byVerdict, pass: false };
  const ids = new Set(rows.map((r) => r.id));
  const complete = rows.length === approvedIds.length && ids.size === rows.length && approvedIds.every((id) => ids.has(id));
  const pass = complete && rows.every((r) => r.verdict === 'match' && r.eligibleByConfig === true &&
    r.ownerMapped === true && r.inBitrix === true && r.inCrm === true && r.crmRows === 1);
  return { total: rows.length, byVerdict, pass };
}

/** Aggregate coverage over pages: each expected ID compared exactly once. */
export function coverage(pages, expectedIds) {
  const counts = new Map();
  for (const page of pages) for (const row of page) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  const expected = new Set(expectedIds);
  const missing = expectedIds.filter((id) => !counts.has(id)).length;
  const repeated = [...counts.values()].filter((n) => n > 1).length;
  const unexpected = [...counts.keys()].filter((id) => !expected.has(id)).length;
  return {
    pages: pages.length,
    expected: expectedIds.length,
    compared: [...counts.values()].reduce((a, b) => a + b, 0),
    missing,
    repeated,
    unexpected,
    complete: missing === 0 && repeated === 0 && unexpected === 0,
  };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function rest(base, key, path) {
  const headers = key.startsWith('sb_secret_') ? { apikey: key } : { apikey: key, authorization: `Bearer ${key}` };
  let res;
  try {
    res = await fetch(`${base}/rest/v1/${path}`, { method: 'GET', headers: { ...headers, accept: 'application/json' }, redirect: 'error' });
  } catch {
    throw new ComparatorError('CRM read failed: unreachable');
  }
  if (res.status !== 200) throw new ComparatorError(`CRM read failed: HTTP ${res.status}`);
  let body;
  try { body = await res.json(); } catch { throw new ComparatorError('CRM read failed: invalid JSON'); }
  if (!Array.isArray(body)) throw new ComparatorError('CRM read failed: unexpected shape');
  return body;
}

/** Expected IDs from exactly one source: the bare approved list or a full manifest. */
export function loadExpected({ object, approvedFile, manifestFile, readFile }) {
  if (approvedFile && manifestFile) throw new ComparatorError('pass either --approved-ids-file or --manifest-file, not both');
  if (manifestFile) {
    let raw;
    try { raw = JSON.parse(readFile(manifestFile)); } catch { throw new ComparatorError('cannot read the manifest file'); }
    try {
      const manifest = parseManifest(raw, { sourceObject: object });
      return { ids: manifest.ids, manifest };
    } catch (error) {
      throw new ComparatorError(error instanceof ManifestError ? error.code : 'invalid manifest');
    }
  }
  if (object === 'lead') throw new ComparatorError('--object lead requires --manifest-file (the owner-approved manifest)');
  if (!approvedFile) throw new ComparatorError('--approved-ids-file is required (owner-approved JSON array), or --manifest-file');
  let parsed;
  try { parsed = JSON.parse(readFile(approvedFile)); } catch { throw new ComparatorError('cannot read a valid owner-approved IDs file'); }
  try { return { ids: parseApprovedIds(parsed), manifest: null }; } catch {
    throw new ComparatorError('cannot read a valid owner-approved IDs file');
  }
}

/**
 * --check-active-manifest: the manifest file must be exactly the database's
 * ACTIVE manifest for this portal and object (integration_active_manifest):
 * same portal/member/config identity, object, source code, business date,
 * creation interval, expected count and ID set. Timestamp offsets may differ,
 * but their instants must be identical.
 * Fixed messages only.
 */
export function checkActiveManifest(fileManifest, active, config) {
  if (active === null || active === undefined) throw new ComparatorError('no active manifest in CRM for this object');
  if (typeof active !== 'object' || !Array.isArray(active.ids)) throw new ComparatorError('active manifest answer is malformed');
  const activeIds = new Set(active.ids.map(String));
  const same =
    active.sourceObject === fileManifest.sourceObject &&
    active.portalDomain === fileManifest.portalDomain &&
    active.memberId === fileManifest.memberId &&
    (!config || (active.configId === config.id && active.memberId === config.portal_member_id && active.portalDomain === config.portal_domain)) &&
    active.sourceCode === fileManifest.sourceCode &&
    active.businessDate === fileManifest.businessDate &&
    ms(active.intervalFrom) !== null && ms(active.intervalFrom) === ms(fileManifest.interval.from) &&
    ms(active.intervalTo) !== null && ms(active.intervalTo) === ms(fileManifest.interval.to) &&
    active.expectedCount === fileManifest.expectedCount &&
    activeIds.size === active.ids.length &&
    activeIds.size === fileManifest.ids.length &&
    fileManifest.ids.every((id) => activeIds.has(id));
  if (!same) throw new ComparatorError('manifest file does not match the active CRM manifest');
  return { manifestId: typeof active.manifestId === 'string' ? active.manifestId : null };
}

async function rpcRead(base, key, fn, args) {
  const headers = key.startsWith('sb_secret_') ? { apikey: key } : { apikey: key, authorization: `Bearer ${key}` };
  let res;
  try {
    res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { ...headers, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(args),
      redirect: 'error',
    });
  } catch {
    throw new ComparatorError('CRM read failed: unreachable');
  }
  if (res.status !== 200) throw new ComparatorError(`CRM read failed: HTTP ${res.status}`);
  try { return await res.json(); } catch { throw new ComparatorError('CRM read failed: invalid JSON'); }
}

const OBJECTS = {
  deal: {
    method: 'crm.deal.list',
    select: [...DEAL_SELECT, 'TITLE'],
    table: 'deals',
    idColumn: 'source_deal_id',
    columns: 'source_deal_id,reference,title,owner_user_id,branch_id,legal_entity_id,is_synthetic,source_stage_id,source_category_id,source_created_at,source_modified_at,last_synced_at,last_verified_at',
  },
  lead: {
    method: 'crm.lead.list',
    select: [...LEAD_SELECT, 'TITLE'],
    table: 'crm_leads',
    idColumn: 'source_lead_id',
    columns: 'source_lead_id,reference,title,owner_user_id,branch_id,legal_entity_id,source_status_id,source_id_code,source_created_at,source_modified_at,last_synced_at,last_verified_at',
  },
};

async function main() {
  const raw = process.env.BITRIX_WEBHOOK_BASE_URL;
  const supabaseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const supabaseKey = process.env.SUPABASE_SECRET_KEY ?? '';
  const secrets = [raw?.trim(), supabaseKey];
  try {
    const object = arg('--object') ?? 'deal';
    if (object !== 'deal' && object !== 'lead') throw new ComparatorError('--object must be lead or deal');
    const spec = OBJECTS[object];
    const validateManifestOnly = process.argv.includes('--validate-manifest-only');
    if (validateManifestOnly && (process.argv.includes('--ids') || process.argv.includes('--check-active-manifest'))) {
      throw new ComparatorError('--validate-manifest-only cannot be combined with --ids or --check-active-manifest');
    }
    if (validateManifestOnly && !arg('--manifest-file')) {
      throw new ComparatorError('--validate-manifest-only requires --manifest-file');
    }
    const memberId = arg('--member-id');
    if (!memberId || !/^[A-Za-z0-9_-]{1,64}$/.test(memberId)) throw new ComparatorError('--member-id is required');
    const { ids: expectedIds, manifest } = loadExpected({
      object,
      approvedFile: arg('--approved-ids-file'),
      manifestFile: arg('--manifest-file'),
      readFile: (f) => readFileSync(f, 'utf8'),
    });
    const ids = arg('--ids') ? String(arg('--ids')).split(',').map((s) => s.trim()) : expectedIds;
    if (ids.length !== expectedIds.length || new Set(ids).size !== ids.length ||
        expectedIds.some((id) => !ids.includes(id))) {
      throw new ComparatorError('--ids must contain every approved ID exactly once; run negative checks separately');
    }
    if (!/^https:\/\/[a-z0-9.-]+$/.test(supabaseUrl) || !supabaseKey) throw new ComparatorError('SUPABASE_URL (https) and SUPABASE_SECRET_KEY are required');
    if (!raw || !raw.trim()) throw new ComparatorError('BITRIX_WEBHOOK_BASE_URL is not set in the process environment');

    const member = encodeURIComponent(memberId);
    const configs = await rest(supabaseUrl, supabaseKey, `integration_intake_config?select=id,portal_domain,portal_member_id,category_id,eligible_stage_ids,cutoff_at,pilot_legal_entity_id,pilot_branch_id,enabled&portal_member_id=eq.${member}`);
    const config = configs[0];
    if (!config) throw new ComparatorError('no intake config for this member id');
    if (validateManifestOnly && configs.length !== 1) throw new ComparatorError('expected exactly one intake config for this member id');
    if (manifest && (manifest.memberId !== memberId || manifest.memberId !== config.portal_member_id || manifest.portalDomain !== config.portal_domain)) {
      throw new ComparatorError('manifest portal identity does not match the selected CRM portal');
    }
    const baseUrl = resolveBaseUrl(raw, config.portal_domain, process.env.APP_ENV);
    if (manifest && new URL(baseUrl).hostname !== manifest.portalDomain) {
      throw new ComparatorError('webhook host does not match the verified manifest portal');
    }
    secrets.push(baseUrl);
    if (validateManifestOnly) {
      const output = `bitrix-pilot-compare: manifest file and portal binding valid (${expectedIds.length} IDs). No import, field parity, form origin or staff mapping verified.`;
      const file = arg('--out');
      if (file) {
        writeFileSync(file, output + '\n', { mode: 0o600 });
        chmodSync(file, 0o600);
      }
      console.log(output);
      return;
    }
    const caller = createReadOnlyCaller(baseUrl, { allowTitle: true, minIntervalMs: Number(process.env.BITRIX_MIN_INTERVAL_MS ?? 600) || 600 });
    let activeManifestId = null;
    if (process.argv.includes('--check-active-manifest')) {
      if (!manifest) throw new ComparatorError('--check-active-manifest requires --manifest-file');
      // Read-only (stable) RPC via the service role; nothing is written.
      const active = await rpcRead(supabaseUrl, supabaseKey, 'integration_active_manifest', { p_member_id: memberId, p_source_object: object });
      activeManifestId = checkActiveManifest(manifest, active, config).manifestId;
    }
    const mappings = await rest(supabaseUrl, supabaseKey, `bitrix_user_mappings?select=bitrix_user_id,staff_user_id,active&portal_member_id=eq.${member}`);

    // Bounded pages of <= 50 IDs; nothing passes on a partial read.
    const pages = [];
    for (const page of pageIds(ids)) {
      const listed = await caller.call(spec.method, { filter: { '@ID': page }, select: spec.select, start: 0 });
      if (!Array.isArray(listed.result)) throw new ComparatorError(`${spec.method} returned no result list`);
      if (listed.next !== undefined && listed.next !== null) throw new ComparatorError(`${spec.method} returned a partial page`);
      if (listed.result.length > page.length) throw new ComparatorError(`${spec.method} returned more rows than requested`);
      const idList = page.join(',');
      const crmRows = await rest(
        supabaseUrl,
        supabaseKey,
        `${spec.table}?select=${spec.columns}&source_system=eq.bitrix&source_portal=eq.${member}&${spec.idColumn}=in.(${idList})`,
      );
      const inbox = await rest(
        supabaseUrl,
        supabaseKey,
        `integration_inbox?select=${INBOX_ID_COLUMN},status,reason_code,origin&portal_member_id=eq.${member}&source_object=eq.${object}&${INBOX_ID_COLUMN}=in.(${idList})`,
      );
      pages.push(
        object === 'lead'
          ? compareLeads(page, listed.result, { leads: crmRows, mappings, inbox, config, manifest })
          : compareDeals(page, listed.result, { deals: crmRows, mappings, inbox, config }),
      );
    }
    const compared = pages.flat();
    const cover = coverage(pages, expectedIds);
    const summary = summarize(compared, expectedIds);
    summary.pass = summary.pass && cover.complete;
    const result = {
      comparedAt: new Date().toISOString(),
      object,
      manifest: manifest
        ? { businessDate: manifest.businessDate, sourceCode: manifest.sourceCode, expectedCount: manifest.expectedCount, activeManifestId }
        : null,
      coverage: cover,
      summary,
      [object === 'lead' ? 'leads' : 'deals']: compared,
    };
    if (!result.summary.pass) process.exitCode = 1;
    const out = redact(JSON.stringify(result, null, 2), secrets);
    const file = arg('--out');
    if (file) {
      writeFileSync(file, out + '\n', { mode: 0o600 });
      chmodSync(file, 0o600); // mode above applies only when the file is created
      console.log(`bitrix-pilot-compare: wrote ${compared.length} ${object} comparisons (${pages.length} pages) to ${file}`);
    } else {
      console.log(out);
    }
  } catch (error) {
    const code =
      error instanceof ComparatorError || error instanceof MetadataError || error instanceof PilotInspectError
        ? error.code
        : 'unexpected failure';
    console.error(redact(`bitrix-pilot-compare: ${code}`, secrets));
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
