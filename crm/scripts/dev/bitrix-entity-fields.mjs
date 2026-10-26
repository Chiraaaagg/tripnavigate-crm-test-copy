#!/usr/bin/env node
// READ-ONLY, disposable: list Bitrix24 Lead, Deal, Contact or Company field metadata (B1.2 Phase A, owner question Q4).
//
// Usage (the credential comes ONLY from the process environment; never paste it in chat):
//   BITRIX_WEBHOOK_BASE_URL=<from the Keychain/.env.local, never pasted in chat> \
//   APP_ENV=production node scripts/dev/bitrix-entity-fields.mjs --entity lead|deal|contact|company \
//     --portal-domain <portal host> [--json]
//
// Calls exactly one method per run, chosen from a fixed allowlist by --entity:
//   lead    -> crm.lead.fields
//   deal    -> crm.deal.fields
//   contact -> crm.contact.fields
//   company -> crm.company.fields (added 12 Oct 2026 for DEC-36: Company name, phone, e-mail codes)
// Nothing else is callable: no *.get, *.list, records, values or files, and nothing
// is written to Bitrix. It prints a table of field code, type, title/label,
// isMultiple, isReadOnly, isRequired and, for enumeration fields, the item ids and
// labels. This is field METADATA only.
// The base URL is never printed (every output line passes through redact()).
//
// Modelled on scripts/dev/bitrix-deal-fields.mjs (B1 step 0). Why a local fetch:
// scripts/lib/bitrix-metadata.mjs does not export its raw call() and its allowlist
// does not include the Lead, Contact and Company methods. The fetch below mirrors call()
// (10 s timeout, no redirects, fixed error codes) but is pinned to the allowlist
// below. resolveBaseUrl, redact and MetadataError are reused as is.
import { MetadataError, redact, resolveBaseUrl } from '../lib/bitrix-metadata.mjs';

const ENTITY_METHODS = Object.freeze({
  lead: 'crm.lead.fields',
  deal: 'crm.deal.fields',
  contact: 'crm.contact.fields',
  company: 'crm.company.fields',
  // B1.2 DEC-43 method question: the universal item API's field names for Deals
  // (crm.item.fields with entityTypeId 2; metadata only).
  'deal-item': 'crm.item.fields',
});
const ENTITY_LABELS = Object.freeze({ lead: 'Lead', deal: 'Deal', contact: 'Contact', company: 'Company', 'deal-item': 'Deal (item API)' });
/** Fixed request parameters per method (never from input). */
const METHOD_PARAMS = Object.freeze({ 'crm.item.fields': { entityTypeId: 2 } });

const raw = process.env.BITRIX_WEBHOOK_BASE_URL;
const secrets = [raw?.trim()];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function methodFor(entity) {
  const key = String(entity ?? '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ENTITY_METHODS, key)) {
    throw new MetadataError('--entity lead|deal|contact|company|deal-item is required');
  }
  return { key, method: ENTITY_METHODS[key] };
}

async function fetchFields(baseUrl, method, fetchImpl = fetch) {
  if (!Object.values(ENTITY_METHODS).includes(method)) throw new MetadataError(`method not allowed: ${method}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let res;
  try {
    res = await fetchImpl(`${baseUrl}${method}.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(METHOD_PARAMS[method] ?? {}),
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
  // crm.item.fields answers {result: {fields: {...}}}; the per-entity methods answer {result: {...}}.
  const result = body.result ?? {};
  return method === 'crm.item.fields' && result && typeof result === 'object' && result.fields ? result.fields : result;
}

function label(f) {
  // Bitrix returns title (system name) plus formLabel/listLabel/filterLabel for custom fields.
  const candidates = [f?.formLabel, f?.listLabel, f?.title].filter((x) => typeof x === 'string' && x.trim());
  return candidates[0] ?? '';
}

function normalise(result) {
  return Object.entries(result).map(([code, f]) => ({
    code,
    type: String(f?.type ?? ''),
    label: label(f),
    // crm.item.fields: the classic name of the same field (e.g. UF_CRM_...).
    upperName: typeof f?.upperName === 'string' ? f.upperName : null,
    isMultiple: Boolean(f?.isMultiple),
    isReadOnly: Boolean(f?.isReadOnly),
    isRequired: Boolean(f?.isRequired),
    statusType: typeof f?.statusType === 'string' ? f.statusType : null,
    items: Array.isArray(f?.items)
      ? f.items.map((it) => ({ id: String(it?.ID ?? ''), value: String(it?.VALUE ?? '') }))
      : null,
  }));
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function formatTable(entityKey, method, fields) {
  const byType = {};
  for (const f of fields) byType[f.type] = (byType[f.type] ?? 0) + 1;
  const custom = fields.filter((f) => f.code.startsWith('UF_CRM_'));
  const lines = [
    `${ENTITY_LABELS[entityKey]} fields (${method}): ${fields.length} fields, ${custom.length} custom (UF_CRM_*)`,
    `Counts by type: ${Object.entries(byType).sort().map(([t, n]) => `${t}=${n}`).join(', ')}`,
    '',
    `${pad('CODE', 34)} ${pad('TYPE', 14)} ${pad('MULTI', 5)} ${pad('RO', 3)} ${pad('REQ', 3)} LABEL`,
  ];
  for (const f of fields) {
    lines.push(
      `${pad(f.code, 34)} ${pad(f.type, 14)} ${pad(f.isMultiple ? 'yes' : '-', 5)} ${pad(f.isReadOnly ? 'yes' : '-', 3)} ${pad(f.isRequired ? 'yes' : '-', 3)} ${f.label}${f.statusType ? `  [status ${f.statusType}]` : ''}${f.upperName ? `  [upper ${f.upperName}]` : ''}`,
    );
    if (f.items && f.items.length) {
      for (const it of f.items) lines.push(`${pad('', 34)}   item ${it.id} = ${it.value}`);
    }
  }
  return lines.join('\n');
}

try {
  const { key, method } = methodFor(arg('--entity'));
  const baseUrl = resolveBaseUrl(raw, arg('--portal-domain'), process.env.APP_ENV);
  secrets.push(baseUrl);
  const fields = normalise(await fetchFields(baseUrl, method));
  const out = process.argv.includes('--json') ? JSON.stringify(fields, null, 2) : formatTable(key, method, fields);
  console.log(redact(out, secrets));
} catch (error) {
  const message = error instanceof MetadataError ? error.message : 'bitrix-entity-fields: unexpected failure';
  console.error(redact(message, secrets));
  process.exit(1);
}
