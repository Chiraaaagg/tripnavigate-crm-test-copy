#!/usr/bin/env node
// READ-ONLY, disposable: list Bitrix24 Deal field metadata (B1 step 0, contract B1-O2).
//
// Usage (the credential comes ONLY from the process environment; never paste it in chat):
//   BITRIX_WEBHOOK_BASE_URL=<from the Keychain/.env.local, never pasted in chat> \
//   APP_ENV=production node scripts/dev/bitrix-deal-fields.mjs --portal-domain <portal host> [--json]
//
// Calls exactly one method, crm.deal.fields, and prints a table of field code,
// type, title/label, isMultiple, isReadOnly and, for enumeration fields, the item
// ids and labels. This is field METADATA only: no Deal records, no customer data,
// no amounts, no values are read, and nothing is written to Bitrix.
// The base URL is never printed (every output line passes through redact()).
//
// Why a local fetch: scripts/lib/bitrix-metadata.mjs does not export its raw
// call() and its inspectMetadata() drops enumeration items. The fetch below
// mirrors call() (10 s timeout, no redirects, fixed error codes) but is pinned
// to crm.deal.fields. resolveBaseUrl, redact and MetadataError are reused as is.
import { MetadataError, redact, resolveBaseUrl } from '../lib/bitrix-metadata.mjs';

const METHOD = 'crm.deal.fields';

const raw = process.env.BITRIX_WEBHOOK_BASE_URL;
const secrets = [raw?.trim()];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function fetchDealFields(baseUrl, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let res;
  try {
    res = await fetchImpl(`${baseUrl}${METHOD}.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({}),
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    throw new MetadataError(controller.signal.aborted ? `${METHOD}: timeout` : `${METHOD}: provider unreachable`);
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
    throw new MetadataError(`${METHOD}: HTTP ${res.status} (${code})`);
  }
  return body.result ?? {};
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

function formatTable(fields) {
  const byType = {};
  for (const f of fields) byType[f.type] = (byType[f.type] ?? 0) + 1;
  const custom = fields.filter((f) => f.code.startsWith('UF_CRM_'));
  const lines = [
    `Deal fields (${METHOD}): ${fields.length} fields, ${custom.length} custom (UF_CRM_*)`,
    `Counts by type: ${Object.entries(byType).sort().map(([t, n]) => `${t}=${n}`).join(', ')}`,
    '',
    `${pad('CODE', 34)} ${pad('TYPE', 14)} ${pad('MULTI', 5)} ${pad('RO', 3)} ${pad('REQ', 3)} LABEL`,
  ];
  for (const f of fields) {
    lines.push(
      `${pad(f.code, 34)} ${pad(f.type, 14)} ${pad(f.isMultiple ? 'yes' : '-', 5)} ${pad(f.isReadOnly ? 'yes' : '-', 3)} ${pad(f.isRequired ? 'yes' : '-', 3)} ${f.label}${f.statusType ? `  [status ${f.statusType}]` : ''}`,
    );
    if (f.items && f.items.length) {
      for (const it of f.items) lines.push(`${pad('', 34)}   item ${it.id} = ${it.value}`);
    }
  }
  return lines.join('\n');
}

try {
  const baseUrl = resolveBaseUrl(raw, arg('--portal-domain'), process.env.APP_ENV);
  secrets.push(baseUrl);
  const fields = normalise(await fetchDealFields(baseUrl));
  const out = process.argv.includes('--json') ? JSON.stringify(fields, null, 2) : formatTable(fields);
  console.log(redact(out, secrets));
} catch (error) {
  const message = error instanceof MetadataError ? error.message : 'bitrix-deal-fields: unexpected failure';
  console.error(redact(message, secrets));
  process.exit(1);
}
