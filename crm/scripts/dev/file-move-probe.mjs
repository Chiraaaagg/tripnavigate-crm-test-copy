#!/usr/bin/env node
// S11 "files to Bitrix", release step 1: the PROBE on one test Deal.
//
// THIS SCRIPT WRITES TO BITRIX. It adds pretend files to two file boxes of ONE
// test Deal the owner named. It is run by the lead only, after the owner's
// APPROVE for step 1 (hosting-migration file 11 section 6, step 1; file 14
// section 5.5). No builder runs it. Nothing in the CRM is read, changed or
// deleted: the script never talks to Supabase.
//
// Usage (credentials come ONLY from the process environment of the server
// side; never paste them in chat, never print them):
//   BITRIX_WEBHOOK_BASE_URL=<read webhook> BITRIX_WRITE_WEBHOOK_BASE_URL=<write webhook> \
//   APP_ENV=production node scripts/dev/file-move-probe.mjs \
//     --portal-domain <portal host> --deal <test Deal id> --accounts-box <ufCrm_... key> \
//     --confirm-write [--manual-removal-step] [--out <result file outside the repository>]
//
// Without --confirm-write and --deal it refuses and makes no call.
//
// Matrix (file 11 section 6, step 1):
//   - PDF, JPEG, PNG and WebP at about 100 KB and at about 4 MiB in the
//     identity box; one small and one large file in the Accounts box;
//   - every append re-sends every file id the box held (append only, the
//     same request shape as the CRM's writer), and after each append every
//     known file id of BOTH boxes is compared (an append to one box must
//     leave the other box unchanged);
//   - each new file is downloaded twice from one read and once from a fresh
//     read, through urlMachine only (portal host, same-host redirects only),
//     and hashed byte for byte against the original;
//   - the time to send and to fetch each file, whether a request of about
//     5.6 MB (a 4 MiB file as base64) is accepted, and Bitrix's
//     time.operating value of each answer;
//   - optional --manual-removal-step: the script pauses after one append so
//     the lead removes one pretend file by hand in Bitrix, then reads both
//     boxes and appends once more, and reports what it observed;
//   - automation rules and history entries cannot be read with these
//     credentials: the report reminds the lead to check them by hand.
//
// Output: pseudonymous labels (#1, #2, ...) instead of Bitrix file ids, byte
// counts, hashes of the PRETEND files only, timings and yes/no results.
// Never a URL, the webhook credential, urlMachine, a Deal title or any other
// Deal field. The script stops at once (exit 2) if a file that was in a box
// disappears after an append (outside the manual removal step).
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { MetadataError, redact, resolveBaseUrl } from '../lib/bitrix-metadata.mjs';

export const IDENTITY_BOX = 'ufCrm_1784359513';
export const BOX_KEY = /^ufCrm_[0-9A-Za-z_]{1,40}$/;
export const DEAL_ENTITY_TYPE_ID = 2;
export const SMALL_BYTES = 100 * 1024;
/** The CRM's upload limit (4 MiB). */
export const LARGE_BYTES = 4 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const NOT_A_FILE_CONTENT_TYPE = /^\s*(?:text\/|application\/(?:json|xml)\b|[\w.!#$&^-]+\/[\w.!#$&^-]+\+(?:json|xml)\b)/i;
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 60_000;
/** Keeps the probe well under Bitrix's 2 requests a second. */
const PAUSE_MS = 700;

export class ProbeError extends Error {
  constructor(code) {
    super(`file-move-probe: ${code}`);
    this.name = 'ProbeError';
    this.code = code;
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Pretend files (synthetic; random filler, no real content)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A valid PNG of random pixels (random data does not compress, so the size follows the pixel count). */
export function makePng(targetBytes) {
  const side = Math.max(8, Math.floor(Math.sqrt((targetBytes - 1024) / 3)));
  const raw = Buffer.alloc(side * (side * 3 + 1));
  for (let y = 0; y < side; y += 1) {
    const row = y * (side * 3 + 1);
    raw[row] = 0; // filter: none
    randomBytes(side * 3).copy(raw, row + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 0 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A valid one-page PDF whose size comes from an uncompressed filler stream. */
export function makePdf(targetBytes) {
  const filler = randomBytes(Math.max(0, Math.floor((targetBytes - 900) * 0.72))).toString('base64').replace(/(.{76})/g, '$1\n');
  const content = `BT /F1 12 Tf 72 720 Td (Synthetic probe file) Tj ET\n% ${filler.split('\n').join('\n% ')}\n`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Random printable filler (no 0xff, no '-', no '<' or '&'), so it is safe inside a JPEG comment and an XMP packet. */
function printableFiller(n) {
  // A-Z, a-z, 0-9, '+' and '/' (built from ranges, 64 characters).
  const range = (from, to) => Array.from({ length: to.charCodeAt(0) - from.charCodeAt(0) + 1 }, (_, i) => String.fromCharCode(from.charCodeAt(0) + i)).join('');
  const alphabet = `${range('A', 'Z')}${range('a', 'z')}${range('0', '9')}+/`;
  const fill = randomBytes(n);
  for (let i = 0; i < n; i += 1) fill[i] = alphabet.charCodeAt(fill[i] & 63);
  return fill;
}

/** A minimal little-endian TIFF/EXIF block: one IFD with Orientation = 1 (normal). */
function exifTiff() {
  const t = Buffer.alloc(8 + 2 + 12 + 4);
  t.write('II', 0, 'ascii');
  t.writeUInt16LE(42, 2);
  t.writeUInt32LE(8, 4); // offset of IFD0
  t.writeUInt16LE(1, 8); // one entry
  t.writeUInt16LE(0x0112, 10); // Orientation
  t.writeUInt16LE(3, 12); // SHORT
  t.writeUInt32LE(1, 14); // count
  t.writeUInt16LE(1, 18); // value: normal (the other 2 bytes stay 0)
  t.writeUInt32LE(0, 22); // no next IFD
  return t;
}

function jpegSegment(marker, data) {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}

/** Splits `total` bytes into comment segments (4 header bytes + at most 65533 data bytes each). */
function jpegFillerSegments(total) {
  if (total <= 0) return [];
  const count = Math.ceil(total / 65537);
  const base = Math.floor(total / count);
  const extra = total % count;
  const segs = [];
  for (let i = 0; i < count; i += 1) segs.push(jpegSegment(0xfe, printableFiller(Math.max(0, base + (i < extra ? 1 : 0) - 4))));
  return segs;
}

/**
 * JPEG: a real, decodable baseline image (8 x 8 pixels, YCbCr, one solid
 * mid-grey colour). Segments: SOI, APP0 JFIF, APP1 EXIF (Orientation = 1),
 * comment segments of random filler up to the target size, DQT, SOF0, two DHT,
 * SOS, the entropy-coded data and EOI. Each Huffman table holds one symbol
 * (code "0"): DC difference category 0, and AC end-of-block. Each of the three
 * blocks is then the bits 0 0, and the scan is 000000 plus two 1-bit pads
 * (0x03). Re-encoding, EXIF stripping or comment stripping changes the hash.
 */
export function makeJpeg(targetBytes) {
  const app0 = jpegSegment(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]));
  const app1 = jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exifTiff()]));
  const dqt = jpegSegment(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)]));
  const sof0 = jpegSegment(0xc0, Buffer.from([8, 0, 8, 0, 8, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]));
  const oneSymbolTable = (classAndId) => Buffer.concat([Buffer.from([classAndId, 1]), Buffer.alloc(15), Buffer.from([0x00])]);
  const dhtDc = jpegSegment(0xc4, oneSymbolTable(0x00));
  const dhtAc = jpegSegment(0xc4, oneSymbolTable(0x10));
  const sos = jpegSegment(0xda, Buffer.from([3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]));
  const scan = Buffer.from([0x03]);
  const soi = Buffer.from([0xff, 0xd8]);
  const eoi = Buffer.from([0xff, 0xd9]);
  const fixed = soi.length + app0.length + app1.length + dqt.length + sof0.length + dhtDc.length + dhtAc.length + sos.length + scan.length + eoi.length;
  return Buffer.concat([soi, app0, app1, ...jpegFillerSegments(targetBytes - fixed), dqt, sof0, dhtDc, dhtAc, sos, scan, eoi]);
}

function riffChunk(type, data) {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat(data.length % 2 ? [head, data, Buffer.alloc(1)] : [head, data]);
}

/** A VP8L (lossless) bitstream of one solid colour: every prefix code is a one-symbol simple code, so each pixel costs 0 bits. */
function vp8lSolid(width, height, [a, r, g, b]) {
  const bytes = [0x2f];
  let acc = 0;
  let nbits = 0;
  const put = (value, n) => {
    for (let i = 0; i < n; i += 1) {
      acc |= ((value >>> i) & 1) << nbits;
      nbits += 1;
      if (nbits === 8) {
        bytes.push(acc);
        acc = 0;
        nbits = 0;
      }
    }
  };
  put(width - 1, 14);
  put(height - 1, 14);
  put(0, 1); // alpha_is_used: no (the colour is opaque)
  put(0, 3); // version 0
  put(0, 1); // no transform
  put(0, 1); // no colour cache
  put(0, 1); // no meta prefix codes
  for (const symbol of [g, r, b, a]) {
    put(1, 1); // simple code
    put(0, 1); // one symbol
    put(1, 1); // the symbol takes 8 bits
    put(symbol, 8);
  }
  put(1, 1); // distance code: simple
  put(0, 1); // one symbol
  put(0, 1); // the symbol takes 1 bit
  put(0, 1); // symbol 0
  if (nbits > 0) bytes.push(acc);
  return Buffer.from(bytes);
}

/**
 * WebP: a real, decodable extended-format lossless image (8 x 8 pixels, one
 * solid colour). Chunks: VP8X (EXIF and XMP flags set), VP8L, EXIF
 * (Orientation = 1) and an XMP packet whose XML comment carries random filler
 * up to the target size. Re-encoding or metadata stripping changes the hash.
 */
export function makeWebp(targetBytes) {
  const side = 8;
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08 | 0x04; // EXIF + XMP
  vp8x.writeUIntLE(side - 1, 4, 3);
  vp8x.writeUIntLE(side - 1, 7, 3);
  const head = [riffChunk('VP8X', vp8x), riffChunk('VP8L', vp8lSolid(side, side, [0xff, 0x2e, 0x86, 0xc1])), riffChunk('EXIF', exifTiff())];
  const xmpOpen = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><!-- synthetic probe filler ';
  const xmpClose = ' --></x:xmpmeta><?xpacket end="w"?>';
  const fixed = 12 + head.reduce((n, c) => n + c.length, 0) + 8 + xmpOpen.length + xmpClose.length;
  const fill = printableFiller(Math.max(0, targetBytes - fixed));
  const chunks = [...head, riffChunk('XMP ', Buffer.concat([Buffer.from(xmpOpen, 'ascii'), fill, Buffer.from(xmpClose, 'ascii')]))];
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + chunks.reduce((n, c) => n + c.length, 0), 4);
  riff.write('WEBP', 8, 'ascii');
  return Buffer.concat([riff, ...chunks]);
}

const MAKERS = {
  'application/pdf': { ext: 'pdf', make: makePdf, decodable: true },
  'image/jpeg': { ext: 'jpg', make: makeJpeg, decodable: true },
  'image/png': { ext: 'png', make: makePng, decodable: true },
  'image/webp': { ext: 'webp', make: makeWebp, decodable: true },
};

/** The probe matrix: 8 files in the identity box, 2 in the Accounts box. */
export function probeMatrix(accountsBox) {
  const list = [];
  for (const mime of Object.keys(MAKERS)) {
    for (const [sizeName, bytes] of [['small', SMALL_BYTES], ['large', LARGE_BYTES]]) list.push({ box: IDENTITY_BOX, boxName: 'identity', mime, sizeName, target: bytes });
  }
  list.push({ box: accountsBox, boxName: 'accounts', mime: 'application/pdf', sizeName: 'small', target: SMALL_BYTES });
  list.push({ box: accountsBox, boxName: 'accounts', mime: 'image/png', sizeName: 'large', target: LARGE_BYTES });
  return list;
}

/** The same neutral names the CRM uses (kind code `pro` for the Accounts test files). */
export function neutralName(boxName, hash, mime) {
  const ext = MAKERS[mime].ext;
  return boxName === 'identity' ? `id-${hash.slice(0, 8)}.${ext}` : `acc-pro-${hash.slice(0, 8)}.${ext}`;
}

// ---------------------------------------------------------------------------
// Bitrix calls (crm.item.get with the READ webhook, crm.item.update with the WRITE webhook)
// ---------------------------------------------------------------------------

async function post(baseUrl, method, params, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
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
    throw new ProbeError(controller.signal.aborted ? `${method}: timeout` : `${method}: provider unreachable`);
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const ms = Date.now() - started;
  const operating = body && body.time && typeof body.time.operating === 'number' ? body.time.operating : null;
  if (res.status !== 200 || !body || body.error !== undefined) {
    const code = body && typeof body.error === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(body.error) ? body.error : 'no error code';
    throw new ProbeError(`${method}: HTTP ${res.status} (${code})`);
  }
  return { body, ms, operating };
}

function entriesOf(item, box) {
  if (!Object.prototype.hasOwnProperty.call(item, box)) throw new ProbeError(`crm.item.get: the answer does not show the ${box === IDENTITY_BOX ? 'identity' : 'accounts'} box`);
  const raw = item[box];
  const list = Array.isArray(raw) ? raw : raw === null || raw === undefined || raw === '' || raw === false ? [] : [raw];
  return list
    .map((v) => (v && typeof v === 'object' ? v : { id: v }))
    .map((v) => ({ id: Number(v.id), link: typeof v.urlMachine === 'string' ? v.urlMachine : null }))
    .filter((e) => Number.isSafeInteger(e.id) && e.id > 0)
    .sort((a, b) => a.id - b.id);
}

/** Both boxes from one crm.item.get; nothing else of the Deal is kept. */
export async function readBoxes(readBase, dealId, accountsBox, fetchImpl = fetch) {
  const { body, ms, operating } = await post(readBase, 'crm.item.get', { entityTypeId: DEAL_ENTITY_TYPE_ID, id: Number(dealId), useOriginalUfNames: 'N' }, READ_TIMEOUT_MS, fetchImpl);
  const item = body.result && typeof body.result === 'object' ? body.result.item : null;
  if (!item || typeof item !== 'object' || String(item.id) !== String(dealId)) throw new ProbeError('crm.item.get: the answer is for another record');
  return { identity: entriesOf(item, IDENTITY_BOX), accounts: entriesOf(item, accountsBox), ms, operating };
}

/** One append: every prior id kept as {id}, the new file last. Same body shape as the CRM writer. */
export async function appendFile(writeBase, dealId, box, priorIds, name, bytes, fetchImpl = fetch) {
  const body = { entityTypeId: DEAL_ENTITY_TYPE_ID, id: Number(dealId), fields: { [box]: [...priorIds.map((id) => ({ id })), [name, Buffer.from(bytes).toString('base64')]] } };
  const requestBytes = Buffer.byteLength(JSON.stringify(body));
  try {
    const { body: answer, ms, operating } = await post(writeBase, 'crm.item.update', body, WRITE_TIMEOUT_MS, fetchImpl);
    const item = answer.result && typeof answer.result === 'object' ? answer.result.item : null;
    const replyIds = item && Object.prototype.hasOwnProperty.call(item, box) ? entriesOf(item, box).map((e) => e.id) : null;
    return { accepted: true, ms, operating, requestBytes, replyIds, error: null };
  } catch (error) {
    if (!(error instanceof ProbeError)) throw error;
    return { accepted: false, ms: null, operating: null, requestBytes, replyIds: null, error: error.code };
  }
}

/** Download through urlMachine only: portal host, same-host redirects (at most 3), never text/JSON/XML. */
export async function download(readBase, link, maxBytes, fetchImpl = fetch) {
  if (!link) return { ok: false, code: 'no_link' };
  const origin = new URL(readBase).origin;
  let url;
  try {
    url = new URL(link, origin);
  } catch {
    return { ok: false, code: 'no_link' };
  }
  if (url.origin !== origin) return { ok: false, code: 'other_host' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  const started = Date.now();
  try {
    let res;
    for (let hop = 0; ; hop += 1) {
      res = await fetchImpl(url.toString(), { method: 'GET', redirect: 'manual', signal: controller.signal, cache: 'no-store' });
      if (!REDIRECT_STATUSES.has(res.status)) break;
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get('location');
      if (!location || hop >= MAX_REDIRECTS) return { ok: false, code: 'redirect' };
      url = new URL(location, url);
      if (url.origin !== origin) return { ok: false, code: 'other_host' };
    }
    if (res.status !== 200 || !res.body) return { ok: false, code: `http_${res.status}` };
    if (NOT_A_FILE_CONTENT_TYPE.test(res.headers.get('content-type') ?? '')) {
      await res.body.cancel().catch(() => undefined);
      return { ok: false, code: 'not_a_file' };
    }
    const reader = res.body.getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, code: 'too_large' };
      }
      parts.push(value);
    }
    const bytes = Buffer.concat(parts);
    return { ok: true, sha256: sha256(bytes), sizeBytes: total, ms: Date.now() - started };
  } catch {
    return { ok: false, code: controller.signal.aborted ? 'timeout' : 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { confirmWrite: false, manualRemoval: false, deal: null, accountsBox: null, portalDomain: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--confirm-write') args.confirmWrite = true;
    else if (a === '--manual-removal-step') args.manualRemoval = true;
    else if (a === '--deal') args.deal = argv[++i] ?? null;
    else if (a === '--accounts-box') args.accountsBox = argv[++i] ?? null;
    else if (a === '--portal-domain') args.portalDomain = argv[++i] ?? null;
    else if (a === '--out') args.out = argv[++i] ?? null;
    else throw new ProbeError(`unknown argument ${JSON.stringify(a).slice(0, 40)}`);
  }
  if (!args.confirmWrite) throw new ProbeError('refused: this script writes to Bitrix; pass --confirm-write after the owner approved step 1');
  if (!args.deal || !/^[1-9]\d{0,15}$/.test(args.deal)) throw new ProbeError('refused: --deal <test Deal id> is required');
  if (!args.accountsBox || !BOX_KEY.test(args.accountsBox) || args.accountsBox === IDENTITY_BOX) throw new ProbeError('refused: --accounts-box <ufCrm_ key of the Accounts box> is required and must differ from the identity box');
  return args;
}

export async function runProbe(args, env, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pause = options.pause ?? (() => sleep(PAUSE_MS));
  const log = options.log ?? ((line) => console.log(line));
  const waitForManualRemoval = options.waitForManualRemoval ?? null;
  const readBase = resolveBaseUrl(env.BITRIX_WEBHOOK_BASE_URL, args.portalDomain, env.APP_ENV);
  let writeBase;
  try {
    writeBase = resolveBaseUrl(env.BITRIX_WRITE_WEBHOOK_BASE_URL, args.portalDomain, env.APP_ENV);
  } catch (error) {
    throw new ProbeError(`write webhook: ${error instanceof MetadataError ? error.code.replace('BITRIX_WEBHOOK_BASE_URL', 'BITRIX_WRITE_WEBHOOK_BASE_URL') : 'invalid'}`);
  }

  // Pseudonymous labels instead of Bitrix file ids.
  const labels = new Map();
  const label = (id) => {
    if (!labels.has(id)) labels.set(id, `#${labels.size + 1}`);
    return labels.get(id);
  };
  const report = { startedAt: new Date().toISOString(), files: [], checks: [], manualRemoval: null, stoppedEarly: null };
  const known = { identity: new Set(), accounts: new Set() };

  let state = await readBoxes(readBase, args.deal, args.accountsBox, fetchImpl);
  for (const e of state.identity) known.identity.add(e.id);
  for (const e of state.accounts) known.accounts.add(e.id);
  report.before = { identity: state.identity.map((e) => label(e.id)), accounts: state.accounts.map((e) => label(e.id)) };
  log(`Before: identity box ${state.identity.length} file(s), accounts box ${state.accounts.length} file(s).`);

  /** Every known id of both boxes must still be there (except one removed by hand on purpose). */
  const compare = (now, step, allowedMissing = new Set()) => {
    const ids = { identity: new Set(now.identity.map((e) => e.id)), accounts: new Set(now.accounts.map((e) => e.id)) };
    const lost = [];
    for (const boxName of ['identity', 'accounts']) for (const id of known[boxName]) if (!ids[boxName].has(id) && !allowedMissing.has(id)) lost.push(`${boxName} ${label(id)}`);
    report.checks.push({ step, allKnownFilesPresent: lost.length === 0, lost });
    return lost;
  };

  const matrix = probeMatrix(args.accountsBox);
  for (const [index, spec] of matrix.entries()) {
    if (index === 3 && args.manualRemoval && waitForManualRemoval) {
      // Manual removal: the lead removes ONE pretend file by hand in Bitrix now.
      log('Manual step: remove ONE pretend file from the identity box by hand in Bitrix, then press Enter.');
      await waitForManualRemoval();
      const seen = await readBoxes(readBase, args.deal, args.accountsBox, fetchImpl);
      const gone = [...known.identity].filter((id) => !seen.identity.some((e) => e.id === id));
      report.manualRemoval = { removedSeenByRead: gone.map(label), countBefore: known.identity.size, countAfter: seen.identity.length };
      for (const id of gone) known.identity.delete(id);
      state = seen;
      log(`Manual step: the read shows ${gone.length} file(s) gone from the identity box.`);
    }
    const bytes = MAKERS[spec.mime].make(spec.target);
    const hash = sha256(bytes);
    const name = neutralName(spec.boxName, hash, spec.mime);
    const prior = state[spec.boxName].map((e) => e.id);
    await pause();
    const sent = await appendFile(writeBase, args.deal, spec.box, prior, name, bytes, fetchImpl);
    const file = {
      box: spec.boxName,
      mime: spec.mime,
      size: spec.sizeName,
      sizeBytes: bytes.length,
      sha256: hash,
      decodablePicture: MAKERS[spec.mime].decodable,
      requestBytes: sent.requestBytes,
      accepted: sent.accepted,
      sendMs: sent.ms,
      sendOperating: sent.operating,
      error: sent.error,
      replyKeptPrior: sent.replyIds === null ? null : prior.every((id) => sent.replyIds.includes(id)),
    };
    report.files.push(file);
    log(`Sent ${spec.boxName} ${spec.mime} ${spec.sizeName} (${bytes.length} bytes, request ${sent.requestBytes} bytes): ${sent.accepted ? `accepted in ${sent.ms} ms` : `refused (${sent.error})`}.`);
    await pause();
    const fresh = await readBoxes(readBase, args.deal, args.accountsBox, fetchImpl);
    const lost = compare(fresh, `after ${spec.boxName} ${spec.mime} ${spec.sizeName}`);
    if (lost.length > 0) {
      report.stoppedEarly = `files disappeared after an append: ${lost.join(', ')}`;
      log(`STOP: ${report.stoppedEarly}`);
      return { report, exitCode: 2 };
    }
    const added = fresh[spec.boxName].filter((e) => !known[spec.boxName].has(e.id));
    file.newEntries = added.length;
    for (const e of added) known[spec.boxName].add(e.id);
    // Every new entry is checked (normally exactly one).
    for (const entry of added) {
      file.label = label(entry.id);
      const first = await download(readBase, entry.link, LARGE_BYTES + 1, fetchImpl);
      await pause();
      const second = await download(readBase, entry.link, LARGE_BYTES + 1, fetchImpl);
      await pause();
      const again = await readBoxes(readBase, args.deal, args.accountsBox, fetchImpl);
      const freshEntry = again[spec.boxName].find((e) => e.id === entry.id);
      const third = await download(readBase, freshEntry?.link ?? null, LARGE_BYTES + 1, fetchImpl);
      const verdict = (d) => (d.ok ? { sameBytes: d.sha256 === hash && d.sizeBytes === bytes.length, ms: d.ms } : { sameBytes: false, code: d.code });
      file.downloads = { firstFromRead: verdict(first), secondFromSameRead: verdict(second), fromFreshRead: verdict(third) };
      file.readOperating = again.operating;
      log(`  ${file.label}: same bytes ${[first, second, third].map((d) => (d.ok && d.sha256 === hash ? 'yes' : 'no')).join('/')} (first read, same read again, fresh read).`);
    }
    state = fresh;
    if (index === 3 && args.manualRemoval && report.manualRemoval) report.manualRemoval.appendAfterRemovalAccepted = sent.accepted;
  }
  report.finishedAt = new Date().toISOString();
  report.byHand = [
    'Check the test Deal history in Bitrix: one change entry per append is expected.',
    'Check whether any automation rule or robot ran on the test Deal.',
    'JPEG and WebP pretend files are tiny solid-colour pictures padded with metadata (EXIF, a JPEG comment, a WebP XMP packet); a hash difference means Bitrix re-encoded or stripped them.',
  ];
  report.summary = {
    allAccepted: report.files.every((f) => f.accepted),
    largeAccepted: report.files.filter((f) => f.size === 'large').every((f) => f.accepted),
    allSameBytes: report.files.every((f) => !f.downloads || Object.values(f.downloads).every((d) => d.sameBytes)),
    otherBoxUnchanged: report.checks.every((c) => c.allKnownFilesPresent),
  };
  log(`Summary: all accepted ${report.summary.allAccepted ? 'YES' : 'NO'}; 4 MiB accepted ${report.summary.largeAccepted ? 'YES' : 'NO'}; all downloads byte-identical ${report.summary.allSameBytes ? 'YES' : 'NO'}; no file lost in either box ${report.summary.otherBoxUnchanged ? 'YES' : 'NO'}.`);
  for (const line of report.byHand) log(`By hand: ${line}`);
  return { report, exitCode: 0 };
}

async function main() {
  const secrets = [process.env.BITRIX_WEBHOOK_BASE_URL, process.env.BITRIX_WRITE_WEBHOOK_BASE_URL];
  try {
    const args = parseArgs(process.argv.slice(2));
    const rl = args.manualRemoval ? createInterface({ input: process.stdin, output: process.stdout }) : null;
    const { report, exitCode } = await runProbe(args, process.env, {
      waitForManualRemoval: rl ? async () => void (await rl.question('')) : null,
    });
    rl?.close();
    if (args.out) writeFileSync(args.out, `${redact(JSON.stringify(report, null, 2), secrets)}\n`, { mode: 0o600 });
    process.exitCode = exitCode;
  } catch (error) {
    const code = error instanceof ProbeError || error instanceof MetadataError ? error.message : 'file-move-probe: unexpected failure';
    console.error(redact(code, secrets));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
