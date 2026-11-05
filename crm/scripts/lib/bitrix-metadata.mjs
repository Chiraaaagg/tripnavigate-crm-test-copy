// Read-only Bitrix24 METADATA inspection helpers (Phase 2, contract §1/§6).
// Used by scripts/bitrix-inspect-metadata.mjs and its unit test.
//
// Only metadata methods are called: crm.category.list (entityTypeId=2 = deals),
// crm.status.list (ENTITY_ID DEAL_STAGE / DEAL_STAGE_{categoryId}) and
// crm.deal.fields. No deal records, contacts or amounts are read. With
// --users (inspectUsers) also user.get: id, name, email, active only.
// The base URL (a credential) is never printed; errors carry fixed codes.

export const METADATA_METHODS = Object.freeze(['crm.category.list', 'crm.status.list', 'crm.deal.fields']);
/** Opt-in (--users): portal user directory for the staff mapping. */
export const USER_METHODS = Object.freeze(['user.get']);

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const REST_PATH = /^\/rest\/\d{1,10}\/[A-Za-z0-9_-]{4,128}\/?$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export class MetadataError extends Error {
  constructor(code) {
    super(`bitrix-inspect-metadata: ${code}`);
    this.name = 'MetadataError';
    this.code = code;
  }
}

/** Same rules as src/modules/integration/bitrix/config.ts (https, host = portal; loopback only for APP_ENV=local). */
export function resolveBaseUrl(raw, portalDomain, appEnv) {
  if (!raw || !raw.trim()) throw new MetadataError('BITRIX_WEBHOOK_BASE_URL is not set in the process environment');
  const portal = String(portalDomain ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!DOMAIN.test(portal)) throw new MetadataError('--portal-domain <portal host> is required');
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new MetadataError('base URL is not a valid URL');
  }
  if (url.username || url.password || url.search || url.hash || !REST_PATH.test(url.pathname)) {
    throw new MetadataError('base URL is not an inbound webhook URL (https://<portal>/rest/<user>/<code>/)');
  }
  const host = url.hostname.toLowerCase();
  const loopback = appEnv === 'local' && LOOPBACK.has(host);
  if (!loopback) {
    if (url.protocol !== 'https:') throw new MetadataError('base URL must use https');
    if ((url.port && url.port !== '443') || host !== portal) throw new MetadataError('base URL host does not match --portal-domain');
  }
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return `${url.protocol}//${url.host}${path}`;
}

export function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  return out.replace(/\/rest\/\d+\/[A-Za-z0-9_-]+/g, '/rest/[redacted]');
}

async function call(baseUrl, method, params, fetchImpl) {
  if (!METADATA_METHODS.includes(method) && !USER_METHODS.includes(method)) throw new MetadataError(`method not allowed: ${method}`);
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
    throw new MetadataError(controller.signal.aborted ? `${method}: timeout` : `${method}: provider unreachable`);
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.status !== 200 || !body || body.error !== undefined) {
    const code = body && typeof body.error === 'string' ? body.error : 'no error code';
    throw new MetadataError(`${method}: HTTP ${res.status} (${code})`);
  }
  return body;
}

/** Returns {categories, stagesByCategory, dealFields}; metadata only. */
export async function inspectMetadata(baseUrl, fetchImpl = fetch) {
  const cat = await call(baseUrl, 'crm.category.list', { entityTypeId: 2 }, fetchImpl);
  const categories = (cat.result?.categories ?? []).map((c) => ({
    id: String(c.id),
    name: String(c.name ?? ''),
    isDefault: c.isDefault === 'Y' || c.isDefault === true,
  }));

  const stagesByCategory = {};
  for (const c of categories) {
    const entityId = c.id === '0' ? 'DEAL_STAGE' : `DEAL_STAGE_${c.id}`;
    const stages = [];
    let start = 0;
    for (let page = 0; page < 20; page += 1) {
      const res = await call(baseUrl, 'crm.status.list', { filter: { ENTITY_ID: entityId }, order: { SORT: 'ASC' }, start }, fetchImpl);
      for (const s of Array.isArray(res.result) ? res.result : []) {
        stages.push({ statusId: String(s.STATUS_ID), name: String(s.NAME ?? ''), sort: Number(s.SORT ?? 0), semantics: s.SEMANTICS ?? null });
      }
      if (typeof res.next !== 'number' || res.next <= start) break;
      start = res.next;
    }
    stagesByCategory[c.id] = stages;
  }

  const fields = await call(baseUrl, 'crm.deal.fields', {}, fetchImpl);
  const dealFields = Object.entries(fields.result ?? {}).map(([code, f]) => ({
    code,
    type: String(f?.type ?? ''),
    title: String(f?.listLabel ?? f?.formLabel ?? f?.title ?? ''),
    isRequired: Boolean(f?.isRequired),
    isReadOnly: Boolean(f?.isReadOnly),
    isMultiple: Boolean(f?.isMultiple),
  }));
  return { categories, stagesByCategory, dealFields };
}

export function formatMetadata({ categories, stagesByCategory, dealFields }) {
  const lines = ['Deal pipelines (crm.category.list, entityTypeId=2):'];
  for (const c of categories) {
    lines.push(`  CATEGORY_ID=${c.id}  ${c.name}${c.isDefault ? '  (default)' : ''}`);
    for (const s of stagesByCategory[c.id] ?? []) {
      lines.push(`    STAGE_ID=${s.statusId}  ${s.name}${s.semantics ? `  [semantics ${s.semantics}]` : ''}`);
    }
  }
  lines.push('', 'Deal fields (crm.deal.fields):');
  for (const f of dealFields) {
    const flags = [f.isRequired && 'required', f.isReadOnly && 'read-only', f.isMultiple && 'multiple'].filter(Boolean).join(', ');
    lines.push(`  ${f.code}  ${f.type}${flags ? `  (${flags})` : ''}${f.title && f.title !== f.code ? `  "${f.title}"` : ''}`);
  }
  return lines.join('\n');
}

/** Portal users (active and inactive): id, name, email, active. Needs the webhook "Users (user)" scope. */
export async function inspectUsers(baseUrl, fetchImpl = fetch) {
  const users = new Map();
  for (const active of [true, false]) {
    let start = 0;
    for (let page = 0; page < 40; page += 1) {
      const res = await call(baseUrl, 'user.get', { FILTER: { ACTIVE: active }, start }, fetchImpl);
      for (const u of Array.isArray(res.result) ? res.result : []) {
        const id = String(u.ID ?? '');
        if (!/^[1-9][0-9]{0,17}$/.test(id)) continue;
        const name = [u.NAME, u.LAST_NAME].filter((x) => typeof x === 'string' && x.trim()).join(' ').trim();
        users.set(id, { id, name: name || `Bitrix user ${id}`, email: typeof u.EMAIL === 'string' ? u.EMAIL : '', active: u.ACTIVE === true || u.ACTIVE === 'Y' });
      }
      if (typeof res.next !== 'number' || res.next <= start) break;
      start = res.next;
    }
  }
  return [...users.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

export function formatUsers(users) {
  const lines = [`Portal users (user.get): ${users.length}`];
  for (const u of users) lines.push(`  USER_ID=${u.id}  ${u.name}${u.email ? `  <${u.email}>` : ''}${u.active ? '' : '  (inactive)'}`);
  return lines.join('\n');
}
