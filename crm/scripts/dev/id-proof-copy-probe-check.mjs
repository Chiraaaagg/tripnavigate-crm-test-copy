#!/usr/bin/env node
// READ-ONLY check for the DEC-43 activation probe (approval draft 3, probe a-e):
// reads the "Aadhar and Passports" field (UF_CRM_1784359513) of ONE Bitrix
// Deal - the owner's dummy test Deal - before and after the one probe copy,
// and compares the two readings.
//
// Usage (the credential comes ONLY from the process environment; never paste it
// in chat; this is the READ webhook, never BITRIX_WRITE_WEBHOOK_BASE_URL):
//   BITRIX_WEBHOOK_BASE_URL=<read webhook, from the Keychain> APP_ENV=production \
//     node scripts/dev/id-proof-copy-probe-check.mjs --portal-domain <portal host> \
//       --deal <test Deal id> --before <state file>      # 1. before the copy
//   ... switch the copy on for the probe, let ONE job run, switch it off ...
//   BITRIX_WEBHOOK_BASE_URL=... APP_ENV=production \
//     node scripts/dev/id-proof-copy-probe-check.mjs --portal-domain <portal host> \
//       --deal <test Deal id> --after <state file>       # 2. after the copy
//
// Calls exactly one Bitrix method, crm.item.get (entityTypeId 2, the same read
// path the copy worker uses since the 13 Oct 2026 live probe), and immediately
// keeps only the one file field (item-API key ufCrm_1784359513); everything
// else in the answer is dropped unread. For each file it also reads the file
// through the entry's urlMachine link (the worker's only link), only on the
// portal host (same-host redirects only, at most 3) and at most 25 MB, in
// memory, to learn its SIZE (the bytes are discarded; this tells whether the
// worker can recognise its file, probe c). Nothing is written to Bitrix.
//
// Printed and saved: the Deal id, file ids, sizes, a count, and whether each
// download link was usable. Never a URL, a file name, file content, the
// credential (urlMachine carries a token) or any other Deal field. The state
// file holds the same and must stay outside the repository.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MetadataError, redact, resolveBaseUrl } from '../lib/bitrix-metadata.mjs';

export const PROBE_METHOD = 'crm.item.get';
export const PROBE_FIELD = 'UF_CRM_1784359513';
/** The same field under the item API (crm.item.get with useOriginalUfNames N). */
export const PROBE_ITEM_FIELD = 'ufCrm_1784359513';
export const DEAL_ENTITY_TYPE_ID = 2;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Same links as the worker (FILE_LINK_KEYS in src/modules/integration/bitrix/id-proof-copy.ts). */
export const LINK_KEYS = Object.freeze(['urlMachine']);
/** Same as the worker (FILE_MAX_REDIRECTS): same-host redirects only. */
export const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Same as the worker (NOT_A_FILE_CONTENT_TYPE): text/*, JSON and XML are never the file. */
export const NOT_A_FILE_CONTENT_TYPE = /^\s*(?:text\/|application\/(?:json|xml)\b|[\w.!#$&^-]+\/[\w.!#$&^-]+\+(?:json|xml)\b)/i;
const TIMEOUT_MS = 15_000;

/** One crm.item.get call; returns only the file field's raw entries. */
export async function readFieldEntries(baseUrl, dealId, fetchImpl = fetch) {
  if (!/^[1-9]\d{0,17}$/.test(String(dealId))) throw new MetadataError('--deal <positive Bitrix Deal id> is required');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(`${baseUrl}${PROBE_METHOD}.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ entityTypeId: DEAL_ENTITY_TYPE_ID, id: Number(dealId), useOriginalUfNames: 'N' }),
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    throw new MetadataError(controller.signal.aborted ? `${PROBE_METHOD}: timeout` : `${PROBE_METHOD}: provider unreachable`);
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const item = body && body.result && typeof body.result === 'object' ? body.result.item : null;
  if (res.status !== 200 || !body || body.error !== undefined || !item || typeof item !== 'object' || Array.isArray(item)) {
    const code = body && typeof body.error === 'string' ? body.error : 'no error code';
    throw new MetadataError(`${PROBE_METHOD}: HTTP ${res.status} (${code})`);
  }
  if (String(item.id) !== String(dealId)) throw new MetadataError(`${PROBE_METHOD}: the answer is for another record`);
  // Like the worker: a missing key is not an empty field.
  if (!Object.prototype.hasOwnProperty.call(item, PROBE_ITEM_FIELD)) throw new MetadataError(`${PROBE_METHOD}: the answer does not show ${PROBE_ITEM_FIELD}`);
  const raw = item[PROBE_ITEM_FIELD];
  const list = Array.isArray(raw) ? raw : raw === null || raw === undefined || raw === '' || raw === false ? [] : [raw];
  return list
    .map((v) => (v && typeof v === 'object' ? v : { id: v }))
    .map((v) => ({ id: Number(v.id), links: Object.fromEntries(LINK_KEYS.map((k) => [k, typeof v[k] === 'string' ? v[k] : null])) }))
    .filter((e) => Number.isSafeInteger(e.id) && e.id > 0)
    .sort((a, b) => a.id - b.id);
}

/**
 * Size of one file through its own link (portal host only, same-host redirects
 * only, bounded); 'html' = a text, JSON or XML answer (login page, error), not the file.
 */
export async function fileSize(baseUrl, link, fetchImpl = fetch) {
  if (!link) return { link: 'missing', sizeBytes: null };
  const origin = new URL(baseUrl).origin;
  let url;
  try {
    url = new URL(link, origin);
  } catch {
    return { link: 'invalid', sizeBytes: null };
  }
  if (url.origin !== origin) return { link: 'other_host', sizeBytes: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res;
    for (let hop = 0; ; hop += 1) {
      res = await fetchImpl(url.toString(), { method: 'GET', redirect: 'manual', signal: controller.signal, cache: 'no-store' });
      if (!REDIRECT_STATUSES.has(res.status)) break;
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get('location');
      if (!location) return { link: `http_${res.status}`, sizeBytes: null };
      if (hop >= MAX_REDIRECTS) return { link: 'too_many_redirects', sizeBytes: null };
      try {
        url = new URL(location, url);
      } catch {
        return { link: 'redirect_invalid', sizeBytes: null };
      }
      if (url.origin !== origin) return { link: 'redirect_other_host', sizeBytes: null };
    }
    const type = res.headers.get('content-type') ?? '';
    if (res.status !== 200 || !res.body) return { link: `http_${res.status}`, sizeBytes: null };
    if (NOT_A_FILE_CONTENT_TYPE.test(type)) {
      await res.body.cancel();
      return { link: 'html', sizeBytes: null };
    }
    const reader = res.body.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FILE_BYTES) {
        await reader.cancel();
        return { link: 'too_large', sizeBytes: null };
      }
    }
    return { link: 'usable', sizeBytes: total };
  } catch {
    return { link: controller.signal.aborted ? 'timeout' : 'failed', sizeBytes: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function readState(baseUrl, dealId, fetchImpl = fetch) {
  const entries = await readFieldEntries(baseUrl, dealId, fetchImpl);
  const files = [];
  for (const e of entries) {
    // Each link separately (status per link); the size comes from the first
    // usable one in the worker's order, as the worker would find it.
    const links = {};
    let sizeBytes = null;
    for (const k of LINK_KEYS) {
      const r = await fileSize(baseUrl, e.links[k], fetchImpl);
      links[k] = r.link;
      if (sizeBytes === null && r.link === 'usable') sizeBytes = r.sizeBytes;
    }
    files.push({ id: e.id, link: sizeBytes !== null ? 'usable' : 'not_usable', links, sizeBytes });
  }
  return { dealId: String(dealId), count: files.length, files };
}

/** Probe a-c from two readings (d: method, e: history/automation are checked by hand). */
export function compareStates(before, after) {
  const now = new Set(after.files.map((f) => f.id));
  const was = new Set(before.files.map((f) => f.id));
  const lost = before.files.filter((f) => !now.has(f.id)).map((f) => f.id);
  const added = after.files.filter((f) => !was.has(f.id));
  const sizeChanged = before.files.filter((f) => {
    const a = after.files.find((x) => x.id === f.id);
    return a && f.sizeBytes !== null && a.sizeBytes !== null && a.sizeBytes !== f.sizeBytes;
  }).map((f) => f.id);
  return {
    a_prior_files_kept: lost.length === 0 && sizeChanged.length === 0,
    lostIds: lost,
    sizeChangedIds: sizeChanged,
    b_exactly_one_added: added.length === 1,
    addedCount: added.length,
    added: added.map((f) => ({ id: f.id, link: f.link, links: f.links, sizeBytes: f.sizeBytes })),
    c_new_file_recognisable: added.length === 1 && added[0].link === 'usable' && added[0].sizeBytes !== null,
  };
}

export function formatState(state) {
  const lines = [`Deal ${state.dealId}: ${state.count} file(s) in ${PROBE_FIELD}`];
  for (const f of state.files) lines.push(`  file ${f.id}: size ${f.sizeBytes ?? '-'} bytes, ${LINK_KEYS.map((k) => `${k} ${f.links?.[k] ?? '-'}`).join(', ')}`);
  return lines.join('\n');
}

export function formatComparison(c) {
  const yes = (b) => (b ? 'YES' : 'NO');
  return [
    `(a) both earlier files still there, unchanged: ${yes(c.a_prior_files_kept)}${c.lostIds.length ? ` (missing: ${c.lostIds.join(', ')})` : ''}${c.sizeChangedIds.length ? ` (size changed: ${c.sizeChangedIds.join(', ')})` : ''}`,
    `(b) exactly one new file: ${yes(c.b_exactly_one_added)} (${c.addedCount} new)`,
    ...c.added.map((f) => `    new file ${f.id}: size ${f.sizeBytes ?? '-'} bytes, ${LINK_KEYS.map((k) => `${k} ${f.links?.[k] ?? '-'}`).join(', ')}`),
    `(c) the new file can be recognised by its size through the read path: ${yes(c.c_new_file_recognisable)} (also check the copy job shows "sent" in the CRM)`,
    '(d) method: crm.item.update (entityTypeId 2, ufCrm_1784359513) - from the code, nothing to read here',
    "(e) check by hand in Bitrix: the test Deal's history/timeline entry, and whether any automation (robots, business processes, triggers) ran",
  ].join('\n');
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const raw = process.env.BITRIX_WEBHOOK_BASE_URL;
  const secrets = [raw?.trim()];
  try {
    const baseUrl = resolveBaseUrl(raw, arg('--portal-domain'), process.env.APP_ENV);
    secrets.push(baseUrl);
    const before = arg('--before');
    const after = arg('--after');
    if ((before ? 1 : 0) + (after ? 1 : 0) !== 1) throw new MetadataError('give exactly one of --before <state file> or --after <state file>');
    const state = await readState(baseUrl, arg('--deal'));
    console.log(redact(formatState(state), secrets));
    if (before) {
      writeFileSync(before, JSON.stringify(state, null, 2));
      console.log('Saved the before reading (ids, sizes, link status only).');
    } else {
      const saved = JSON.parse(readFileSync(after, 'utf8'));
      if (saved.dealId !== state.dealId) throw new MetadataError('the state file is for another Deal');
      console.log('');
      console.log(redact(formatComparison(compareStates(saved, state)), secrets));
    }
  } catch (error) {
    const message = error instanceof MetadataError ? error.message : 'id-proof-copy-probe-check: unexpected failure';
    console.error(redact(message, secrets));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
