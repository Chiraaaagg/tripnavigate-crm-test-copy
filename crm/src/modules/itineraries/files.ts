import { sha256Hex, sniffEvidenceMime } from '@/modules/fulfilment/evidence';
import { DOCX_MIME, SOURCE_MAX_BYTES, SOURCE_MIMES, type SourceMime } from './contracts';

/*
 * Source-file checks for the private itinerary sources (PDF, Word .docx,
 * JPEG, PNG, WebP; at most 4 MiB): size, declared type AND the file's own
 * bytes must agree before anything is stored. A .docx is a ZIP package:
 * it must start with the ZIP local-file signature and carry the Word body
 * part (word/document.xml) in its directory. Nothing is extracted or read
 * beyond that check; the file is never sent outside. Pure.
 */

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const DOCX_PART = new TextEncoder().encode('word/document.xml');
const EXTENSION: Record<SourceMime, string> = {
  'application/pdf': 'pdf',
  [DOCX_MIME]: 'docx',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function contains(bytes: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= bytes.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** The type the bytes prove, or null. */
export function sniffSourceMime(bytes: Uint8Array): SourceMime | null {
  const evidence = sniffEvidenceMime(bytes);
  if (evidence) return evidence;
  if (ZIP.every((b, i) => bytes[i] === b) && contains(bytes, DOCX_PART)) return DOCX_MIME;
  return null;
}

/** Server rule mirrored: characters outside [A-Za-z0-9._ -] → "_", trimmed, at most 120 (extension kept). */
export function sanitizeSourceFileName(raw: string, mime: SourceMime): string {
  const ext = `.${EXTENSION[mime]}`;
  let name = raw.normalize('NFKC').replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim();
  if (!name || /^[._ -]+$/.test(name)) name = `itinerary${ext}`;
  if (name.length > 120) name = `${name.slice(0, 120 - ext.length).trimEnd()}${ext}`;
  return name;
}

export type SourceCheck =
  | { ok: true; mime: SourceMime; fileName: string; sizeBytes: number; sha256: string }
  | { ok: false; reason: 'empty' | 'too_large' | 'unsupported_type' | 'content_mismatch' };

export function checkSourceFile(input: { bytes: Uint8Array; declaredMime: string; fileName: string }): SourceCheck {
  const size = input.bytes.byteLength;
  if (size === 0) return { ok: false, reason: 'empty' };
  if (size > SOURCE_MAX_BYTES) return { ok: false, reason: 'too_large' };
  if (!(SOURCE_MIMES as readonly string[]).includes(input.declaredMime)) return { ok: false, reason: 'unsupported_type' };
  const declared = input.declaredMime as SourceMime;
  if (sniffSourceMime(input.bytes) !== declared) return { ok: false, reason: 'content_mismatch' };
  return { ok: true, mime: declared, fileName: sanitizeSourceFileName(input.fileName, declared), sizeBytes: size, sha256: sha256Hex(input.bytes) };
}

/** Canonical JSON (sorted keys) → sha256 hex: the render input hash (same input → same job). */
export function stableHash(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
    return v;
  };
  return sha256Hex(new TextEncoder().encode(JSON.stringify(canon(value))));
}
