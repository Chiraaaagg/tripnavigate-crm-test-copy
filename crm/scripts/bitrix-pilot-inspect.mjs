#!/usr/bin/env node
// READ-ONLY Bitrix24 pilot inspection (Phase 3.5, staging readiness).
//
// Usage (the credential comes ONLY from the process environment):
//   BITRIX_WEBHOOK_BASE_URL=<inbound webhook base URL> \
//   node scripts/bitrix-pilot-inspect.mjs --portal-domain <portal host> [--since-days 30] [--max-pages 4] [--out <file.json>]
//
// Diagnosis (Phase 5): offline URL-shape check, then ONE server.time call (no
// retry), printing pass/fail booleans, HTTP status, Bitrix error code and a
// fixed explanation only (exit 0 = ok, 2 = rejected or shape failed):
//   node --env-file=<secrets file> scripts/bitrix-pilot-inspect.mjs --portal-domain <host> --diagnose [--offline] [--form post|get]
//
// Collects what the owner needs to approve an intake configuration, without
// customer data:
//   - portal host (from the base URL; the credential path is never printed)
//   - webhook scopes (app.info), webhook owner ID/admin flag (profile), portal time (server.time)
//   - deal pipelines, stages, deal field map vs the Phase 2 contract
//   - per pipeline: deal total, and for deals created in the last N days the
//     counts per stage and per ASSIGNED_BY_ID plus the newest deal IDs
//   - for those assignees: user ID, ACTIVE, department IDs (user.get), and
//     department ID/name/parent (department.get)
//
// Strict allow-list of READ methods (PILOT_READ_METHODS). crm.deal.list may
// only select ID, CATEGORY_ID, STAGE_ID, ASSIGNED_BY_ID, DATE_CREATE,
// DATE_MODIFY; user.get only ID, ACTIVE, UF_DEPARTMENT. Every response is
// reduced to allow-listed keys before it is kept, so titles, names, phones,
// e-mails, comments and amounts are never stored or printed. Calls are spaced
// (default 600 ms, below the documented 2 req/s) and a rate-limit answer is
// retried once after a pause. Nothing is written to Bitrix.

import { chmodSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MetadataError, redact, resolveBaseUrl } from './lib/bitrix-metadata.mjs';

export const PILOT_READ_METHODS = Object.freeze([
  'app.info',
  'profile',
  'server.time',
  'crm.category.list',
  'crm.status.list',
  'crm.deal.fields',
  'crm.deal.list',
  'crm.lead.list',
  'crm.activity.fields',
  'crm.activity.list',
  'user.get',
  'department.get',
]);

export const DEAL_SELECT = Object.freeze(['ID', 'CATEGORY_ID', 'STAGE_ID', 'ASSIGNED_BY_ID', 'DATE_CREATE', 'DATE_MODIFY']);
export const USER_SELECT = Object.freeze(['ID', 'ACTIVE', 'UF_DEPARTMENT']);
/** Phase 6: Lead header fields only (no contacts, phones, e-mails, comments or amounts). TITLE needs allowTitle. */
export const LEAD_SELECT = Object.freeze(['ID', 'STATUS_ID', 'SOURCE_ID', 'ASSIGNED_BY_ID', 'DATE_CREATE', 'DATE_MODIFY']);
/** Form-origin evidence only: no subject, description, communications or files (selection-contract.md section 4). */
export const ACTIVITY_SELECT = Object.freeze(['ID', 'OWNER_ID', 'OWNER_TYPE_ID', 'PROVIDER_ID', 'PROVIDER_TYPE_ID', 'CREATED']);
export const ACTIVITY_FILTER_KEYS = Object.freeze(['OWNER_TYPE_ID', 'OWNER_ID']);

/** Fields the Phase 2 worker reads from crm.deal.get (contract §4, deal.ts). */
export const CONTRACT_DEAL_FIELDS = Object.freeze({
  ID: ['integer'],
  TITLE: ['string'],
  STAGE_ID: ['crm_status'],
  CATEGORY_ID: ['crm_category'],
  ASSIGNED_BY_ID: ['user'],
  DATE_CREATE: ['datetime'],
  DATE_MODIFY: ['datetime'],
});

const WRITE_LIKE = /(add|update|delete|set|bind|unbind|import|send|start|stop|register|clear|attach|move|event)/i;

export class PilotInspectError extends Error {
  constructor(code) {
    super(`bitrix-pilot-inspect: ${code}`);
    this.name = 'PilotInspectError';
    this.code = code;
  }
}

function assertParams(method, params, dealSelect = DEAL_SELECT, leadSelect = LEAD_SELECT) {
  if (!PILOT_READ_METHODS.includes(method)) throw new PilotInspectError(`method not allowed: ${method}`);
  // Defence in depth: the allow-list contains no write-like name.
  const leaf = method.split('.').pop() ?? '';
  if (method !== 'server.time' && WRITE_LIKE.test(leaf) && leaf !== 'list' && leaf !== 'get') {
    throw new PilotInspectError(`method not allowed: ${method}`);
  }
  if (method === 'crm.deal.list') {
    const select = params.select;
    if (!Array.isArray(select) || select.length === 0 || select.some((f) => !dealSelect.includes(f))) {
      throw new PilotInspectError('crm.deal.list select outside the allow-list');
    }
  }
  if (method === 'crm.lead.list') {
    const select = params.select;
    if (!Array.isArray(select) || select.length === 0 || select.some((f) => !leadSelect.includes(f))) {
      throw new PilotInspectError('crm.lead.list select outside the allow-list');
    }
  }
  if (method === 'crm.activity.list') {
    const select = params.select;
    if (!Array.isArray(select) || select.length === 0 || select.some((f) => !ACTIVITY_SELECT.includes(f))) {
      throw new PilotInspectError('crm.activity.list select outside the allow-list');
    }
    const filter = params.filter;
    // Exactly one Lead's activities: both keys, OWNER_TYPE_ID = 1 (Lead), OWNER_ID a positive integer.
    const ownerId = filter?.OWNER_ID;
    const ownerIdOk =
      (typeof ownerId === 'string' && /^[1-9][0-9]{0,15}$/.test(ownerId) && Number(ownerId) <= Number.MAX_SAFE_INTEGER) ||
      (typeof ownerId === 'number' && Number.isSafeInteger(ownerId) && ownerId > 0);
    if (!filter || typeof filter !== 'object' || Array.isArray(filter) ||
        Object.keys(filter).length !== ACTIVITY_FILTER_KEYS.length ||
        !ACTIVITY_FILTER_KEYS.every((k) => Object.prototype.hasOwnProperty.call(filter, k)) ||
        filter.OWNER_TYPE_ID !== 1 || !ownerIdOk) {
      throw new PilotInspectError('crm.activity.list filter outside the allow-list');
    }
  }
  if (method === 'user.get') {
    const select = params.select ?? params.SELECT;
    if (!Array.isArray(select) || select.some((f) => !USER_SELECT.includes(f))) {
      throw new PilotInspectError('user.get select outside the allow-list');
    }
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read-only, rate-spaced caller. Returns the parsed body or throws
 * PilotInspectError with a fixed code (never the URL).
 */
export function createReadOnlyCaller(
  baseUrl,
  { fetchImpl = fetch, minIntervalMs = 600, sleep = defaultSleep, now = Date.now, allowTitle = false } = {},
) {
  // TITLE may contain customer names: only the comparison script asks for it,
  // and it keeps a SHA-256 of the title, never the text.
  const dealSelect = allowTitle ? [...DEAL_SELECT, 'TITLE'] : DEAL_SELECT;
  const leadSelect = allowTitle ? [...LEAD_SELECT, 'TITLE'] : LEAD_SELECT;
  let last = 0;
  const calls = [];
  async function once(method, params) {
    const wait = last + minIntervalMs - now();
    if (wait > 0) await sleep(wait);
    last = now();
    calls.push(method);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${method}.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(params),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      throw new PilotInspectError(controller.signal.aborted ? `${method}: timeout` : `${method}: provider unreachable`);
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }
  async function call(method, params = {}) {
    assertParams(method, params, dealSelect, leadSelect);
    for (let attempt = 0; ; attempt += 1) {
      const { status, body } = await once(method, params);
      const code = body && typeof body.error === 'string' ? body.error : null;
      const limited = status === 429 || code === 'QUERY_LIMIT_EXCEEDED' || code === 'OPERATION_TIME_LIMIT';
      if (limited && attempt === 0) {
        await sleep(Math.max(2_000, minIntervalMs * 4));
        continue;
      }
      if (status !== 200 || !body || body.error !== undefined) {
        throw new PilotInspectError(`${method}: HTTP ${status} (${code ?? 'no error code'})`);
      }
      return body;
    }
  }
  return { call, calls };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}

async function optional(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof PilotInspectError ? error.message.replace(/^bitrix-pilot-inspect: /, '') : 'unexpected failure' };
  }
}

const ID = /^[0-9]{1,16}$/;

/** Collects the redacted pilot inventory. No customer content is kept. */
export async function inspectPilot(caller, { portalHost, sinceDays = 30, maxPages = 4, now = Date.now } = {}) {
  const sinceIso = new Date(now() - sinceDays * 86_400_000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const report = { portalHost, sinceDays, since: sinceIso, memberId: { obtainable: false, note: '' } };

  const app = await optional(async () => {
    const r = (await caller.call('app.info')).result ?? {};
    return { scope: Array.isArray(r.SCOPE) ? r.SCOPE.map(String).sort() : null, license: typeof r.LICENSE === 'string' ? r.LICENSE : null };
  });
  report.webhook = app.ok ? app.value : { error: app.error };

  const profile = await optional(async () => {
    const r = (await caller.call('profile')).result ?? {};
    return { id: r.ID != null ? String(r.ID) : null, admin: r.ADMIN === true || r.ADMIN === 'Y' };
  });
  report.webhookOwner = profile.ok ? profile.value : { error: profile.error };

  const time = await optional(async () => {
    const r = (await caller.call('server.time')).result;
    return typeof r === 'string' ? r : null;
  });
  report.portalTime = time.ok ? time.value : { error: time.error };
  report.memberId.note =
    'Inbound-webhook REST does not expose member_id (app.info via webhook returns only SCOPE and LICENSE). ' +
    'It arrives as auth[member_id] on the first outbound event delivery.';

  // A failing required call (e.g. a missing scope) keeps what was already
  // collected and records the fixed error code instead of losing the run.
  try {
    const cat = await caller.call('crm.category.list', { entityTypeId: 2 });
    const categories = (cat.result?.categories ?? []).map((c) => ({
      id: String(c.id),
      name: String(c.name ?? ''),
      isDefault: c.isDefault === 'Y' || c.isDefault === true,
    }));
    report.categories = [];

    for (const c of categories) {
      const entityId = c.id === '0' ? 'DEAL_STAGE' : `DEAL_STAGE_${c.id}`;
      const st = await caller.call('crm.status.list', { filter: { ENTITY_ID: entityId }, order: { SORT: 'ASC' } });
      const stages = (Array.isArray(st.result) ? st.result : []).map((s) => ({
        statusId: String(s.STATUS_ID),
        name: String(s.NAME ?? ''),
        sort: Number(s.SORT ?? 0),
        semantics: s.SEMANTICS ?? null,
      }));

      const totalPage = await caller.call('crm.deal.list', { filter: { '=CATEGORY_ID': c.id }, select: ['ID'], start: 0 });
      const total = typeof totalPage.total === 'number' ? totalPage.total : null;

      const recent = [];
      let start = 0;
      let truncated = false;
      for (let page = 0; ; page += 1) {
        if (page >= maxPages) {
          truncated = true;
          break;
        }
        const r = await caller.call('crm.deal.list', {
          filter: { '=CATEGORY_ID': c.id, '>=DATE_CREATE': sinceIso },
          select: [...DEAL_SELECT],
          order: { ID: 'DESC' },
          start,
        });
        for (const d of Array.isArray(r.result) ? r.result : []) recent.push(pick(d, DEAL_SELECT));
        if (typeof r.next !== 'number' || r.next <= start) break;
        start = r.next;
      }
      const byStage = {};
      const byAssignee = {};
      let newest = null;
      let oldest = null;
      for (const d of recent) {
        byStage[String(d.STAGE_ID)] = (byStage[String(d.STAGE_ID)] ?? 0) + 1;
        byAssignee[String(d.ASSIGNED_BY_ID)] = (byAssignee[String(d.ASSIGNED_BY_ID)] ?? 0) + 1;
        const created = String(d.DATE_CREATE ?? '');
        if (!newest || created > newest) newest = created;
        if (!oldest || created < oldest) oldest = created;
      }
      report.categories.push({
        ...c,
        stages,
        dealTotal: total,
        recent: {
          count: recent.length,
          truncated,
          createdRange: recent.length ? { oldest, newest } : null,
          byStage,
          byAssignee,
          newestDealIds: recent
            .map((d) => String(d.ID))
            .filter((id) => ID.test(id))
            .sort((a, b) => Number(b) - Number(a))
            .slice(0, 15),
          newestDeals: recent
            .slice()
            .sort((a, b) => Number(b.ID) - Number(a.ID))
            .slice(0, 15)
            .map((d) => pick(d, DEAL_SELECT)),
        },
      });
    }

    const fields = await caller.call('crm.deal.fields');
    const fieldMap = fields.result ?? {};
    report.fieldCheck = Object.entries(CONTRACT_DEAL_FIELDS).map(([code, types]) => {
      const f = fieldMap[code];
      return {
        code,
        present: !!f,
        type: f ? String(f.type ?? '') : null,
        expected: types,
        ok: !!f && types.includes(String(f.type ?? '')),
      };
    });
    // Metadata only: code, type, flags and the field label (a business label, not
    // a value). Enumeration items, settings and defaults are never kept.
    report.dealFields = Object.entries(fieldMap).map(([code, f]) => ({
      code,
      type: String(f?.type ?? ''),
      isRequired: Boolean(f?.isRequired),
      isMultiple: Boolean(f?.isMultiple),
      isReadOnly: Boolean(f?.isReadOnly),
      label: code.startsWith('UF_') ? String(f?.listLabel ?? f?.formLabel ?? f?.title ?? '').slice(0, 80) : null,
    }));
    report.dealFieldCount = Object.keys(fieldMap).length;
    report.customFieldCount = Object.keys(fieldMap).filter((k) => k.startsWith('UF_')).length;

    const assignees = [
      ...new Set(report.categories.flatMap((c) => Object.keys(c.recent.byAssignee)).filter((id) => ID.test(id))),
    ].slice(0, 50);
    const users = await optional(async () => {
      if (assignees.length === 0) return [];
      const r = await caller.call('user.get', { filter: { '@ID': assignees }, select: [...USER_SELECT] });
      return (Array.isArray(r.result) ? r.result : []).map((u) => ({
        id: String(u.ID),
        active: u.ACTIVE === true || u.ACTIVE === 'Y',
        departmentIds: Array.isArray(u.UF_DEPARTMENT) ? u.UF_DEPARTMENT.map(String) : [],
      }));
    });
    report.assignees = users.ok ? users.value : { error: users.error, ids: assignees };

    const departments = await optional(async () => {
      const r = await caller.call('department.get', {});
      return (Array.isArray(r.result) ? r.result : []).map((d) => ({
        id: String(d.ID),
        name: String(d.NAME ?? ''),
        parent: d.PARENT != null ? String(d.PARENT) : null,
      }));
    });
    report.departments = departments.ok ? departments.value : { error: departments.error };
  } catch (error) {
    if (!(error instanceof PilotInspectError)) throw error;
    report.aborted = error.message.replace(/^bitrix-pilot-inspect: /, '');
  }
  report.calls = caller.calls.slice();
  return report;
}

// ---------------------------------------------------------------------------
// --diagnose (Phase 5, 401 investigation): offline URL-shape checks plus at
// most ONE read call (server.time). Prints booleans, the HTTP status, a
// fixed-shape Bitrix error code and a fixed interpretation; never the URL,
// the code, its prefix/suffix/length, or any response content other than the
// portal time. A redirect is not followed; only the target host is reported.
// ---------------------------------------------------------------------------

/**
 * Offline checks of the raw BITRIX_WEBHOOK_BASE_URL value. Returns pass/fail
 * booleans only (no part of the value).
 */
export function checkWebhookShape(raw, portalDomain, appEnv) {
  const value = String(raw ?? '');
  const trimmed = value.trim();
  const checks = {
    set: trimmed.length > 0,
    noSurroundingWhitespace: value === trimmed,
    noQuotes: !/["']/.test(trimmed),
    noInnerWhitespace: !/\s/.test(trimmed),
    asciiOnly: /^[\x21-\x7e]*$/.test(trimmed),
    parsesAsUrl: false,
    https: false,
    hostMatchesPortal: false,
    defaultPort: false,
    noUserinfoQueryHash: false,
    pathIsRestUserCode: false,
    userIdNumeric: false,
    codeAlphanumeric: false,
    codeLength16: false,
    trailingSlash: false,
  };
  let url = null;
  try {
    url = new URL(trimmed);
  } catch {
    url = null;
  }
  if (url) {
    checks.parsesAsUrl = true;
    // Loopback http only for APP_ENV=local (mock tests), same rule as resolveBaseUrl.
    const loopback = appEnv === 'local' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    checks.https = url.protocol === 'https:' || (loopback && url.protocol === 'http:');
    const portal = String(portalDomain ?? '').trim().toLowerCase().replace(/\.$/, '');
    checks.hostMatchesPortal = !!portal && url.hostname.toLowerCase() === portal;
    checks.defaultPort = !url.port || url.port === '443' || loopback;
    checks.noUserinfoQueryHash = !url.username && !url.password && !url.search && !url.hash;
    const segs = url.pathname.split('/');
    // ['', 'rest', '<user>', '<code>', ''] — nothing (e.g. a pasted method name) after the code.
    checks.pathIsRestUserCode = segs[1] === 'rest' && segs.length >= 4 && segs.length <= 5 && (segs[4] ?? '') === '';
    checks.userIdNumeric = /^[1-9][0-9]{0,9}$/.test(segs[2] ?? '');
    checks.codeAlphanumeric = /^[A-Za-z0-9]+$/.test(segs[3] ?? '');
    checks.codeLength16 = (segs[3] ?? '').length === 16;
    checks.trailingSlash = url.pathname.endsWith('/');
  }
  // Advisory only: the scripts add a missing trailing slash, and Bitrix24 codes
  // are normally (not contractually) 16 characters. Every other check must pass.
  const advisory = new Set(['trailingSlash', 'codeLength16']);
  const ok = Object.entries(checks).every(([k, v]) => v || advisory.has(k));
  return { ok, checks };
}

/** Documented Bitrix24 answers (apidocs.bitrix24.com error-codes) mapped to a fixed explanation. */
export const DIAGNOSIS = Object.freeze({
  ok: 'Webhook accepted. Credential, owner and portal are valid.',
  INVALID_CREDENTIALS:
    'No ACTIVE inbound webhook exists for this user-id/code pair on this portal: the webhook was deleted, regenerated or switched off, ' +
    'or its owner user is no longer active. A Bitrix24 administrator must create a new inbound webhook.',
  NO_AUTH_FOUND: 'The request carried no webhook code: the URL path is wrong (it must be /rest/<user>/<code>/<method>.json).',
  ACCESS_DENIED: 'REST is not available for this portal (plan or REST access switched off). Portal administrator must check the plan.',
  insufficient_scope: 'Webhook is active but lacks the scope for this method. Add scopes crm, user_brief, department.',
  INVALID_REQUEST: 'Bitrix24 requires https.',
  ERROR_METHOD_NOT_FOUND: 'Method name or suffix wrong, or scope missing for it.',
  QUERY_LIMIT_EXCEEDED: 'Rate limited. Wait and retry later (do not loop).',
  redirect: 'The host redirected: the portal domain changed (renamed portal or custom domain). Use the redirect host as the portal domain.',
  unreachable: 'Portal host did not answer (DNS, TLS or network).',
  other: 'Unexpected answer. Record status and code; do not retry.',
});

const ERROR_CODE = /^[A-Za-z_]{1,64}$/;

/**
 * Exactly ONE read call (server.time), no retry. form 'post' = the production
 * client form (POST JSON to <base>server.time.json); 'get' = the documented
 * simplest form. Redirects are not followed.
 */
export async function diagnoseWebhook(baseUrl, { fetchImpl = fetch, form = 'post', timeoutMs = 10_000 } = {}) {
  if (form !== 'post' && form !== 'get') throw new PilotInspectError('--form must be post or get');
  const method = 'server.time';
  assertParams(method, {});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(
      `${baseUrl}${method}.json`,
      form === 'post'
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: '{}',
            redirect: 'manual',
            signal: controller.signal,
          }
        : { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal: controller.signal },
    );
  } catch {
    return { calls: 1, method, form, status: null, errorCode: null, verdict: 'unreachable', explanation: DIAGNOSIS.unreachable };
  } finally {
    clearTimeout(timer);
  }
  const base = { calls: 1, method, form, status: res.status };
  if (res.status >= 300 && res.status < 400) {
    let redirectHost = null;
    try {
      redirectHost = new URL(res.headers.get('location') ?? '', baseUrl).hostname.toLowerCase();
    } catch {
      redirectHost = null;
    }
    return { ...base, errorCode: null, redirectHost, verdict: 'redirect', explanation: DIAGNOSIS.redirect };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.status === 200 && body && body.error === undefined && 'result' in body) {
    const portalTime = typeof body.result === 'string' && /^[0-9T:+\-.Z ]{10,40}$/.test(body.result) ? body.result : null;
    return { ...base, errorCode: null, portalTime, verdict: 'ok', explanation: DIAGNOSIS.ok };
  }
  const code = body && typeof body.error === 'string' && ERROR_CODE.test(body.error) ? body.error : null;
  const verdict = code && Object.prototype.hasOwnProperty.call(DIAGNOSIS, code) ? code : 'other';
  return { ...base, errorCode: code, verdict, explanation: DIAGNOSIS[verdict] };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const raw = process.env.BITRIX_WEBHOOK_BASE_URL;
  const secrets = [raw?.trim()];
  try {
    if (!raw || !raw.trim()) throw new MetadataError('BITRIX_WEBHOOK_BASE_URL is not set in the process environment');
    // Required and independent of the URL: the base URL host must equal the
    // operator-stated portal (resolveBaseUrl), so a wrong credential is refused.
    const host = String(arg('--portal-domain') ?? '').trim().toLowerCase();
    if (!host) throw new MetadataError('--portal-domain <portal host> is required');
    if (process.argv.includes('--diagnose')) {
      const shape = checkWebhookShape(raw, host, process.env.APP_ENV);
      const result = { shape };
      if (!shape.ok) {
        result.call = null;
        result.note = 'URL shape failed: no request was made. Fix the stored value first.';
      } else if (process.argv.includes('--offline')) {
        result.call = null;
        result.note = '--offline: no request was made.';
      } else {
        const baseUrl = resolveBaseUrl(raw, host, process.env.APP_ENV);
        secrets.push(baseUrl);
        result.call = await diagnoseWebhook(baseUrl, { form: String(arg('--form') ?? 'post') });
      }
      console.log(redact(JSON.stringify(result, null, 2), secrets));
      if (!shape.ok || (result.call && result.call.verdict !== 'ok')) process.exitCode = 2;
      return;
    }
    const baseUrl = resolveBaseUrl(raw, host, process.env.APP_ENV);
    secrets.push(baseUrl);
    const sinceDays = Math.min(Math.max(Number(arg('--since-days') ?? 30) || 30, 1), 365);
    const maxPages = Math.min(Math.max(Number(arg('--max-pages') ?? 4) || 4, 1), 20);
    const caller = createReadOnlyCaller(baseUrl, { minIntervalMs: Number(process.env.BITRIX_MIN_INTERVAL_MS ?? 600) || 600 });
    const report = await inspectPilot(caller, { portalHost: host, sinceDays, maxPages });
    const out = redact(JSON.stringify(report, null, 2), secrets);
    const file = arg('--out');
    if (file) {
      writeFileSync(file, out + '\n', { mode: 0o600 });
      chmodSync(file, 0o600); // mode above applies only when the file is created
      console.log(`bitrix-pilot-inspect: wrote ${report.calls.length} read calls of results to ${file}`);
    } else {
      console.log(out);
    }
    if (report.aborted) {
      console.error(redact(`bitrix-pilot-inspect: incomplete, stopped at ${report.aborted}`, secrets));
      // exitCode, not process.exit(): exiting while the HTTP keep-alive socket
      // closes crashes Node on Windows (0xC0000409) instead of exiting 2.
      process.exitCode = 2;
    }
  } catch (error) {
    const message =
      error instanceof MetadataError || error instanceof PilotInspectError ? error.message : 'bitrix-pilot-inspect: unexpected failure';
    console.error(redact(message, secrets));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
