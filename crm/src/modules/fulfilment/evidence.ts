import { createHash } from 'node:crypto';
import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MIME_TYPES,
  type EvidenceMime,
} from './contracts';

/**
 * Pure checks for booking proof files (contract §7). The server validates
 * size, declared type AND magic bytes before anything is stored, and computes
 * the sha256 the database records. Nothing here logs or returns file content.
 */

export { EVIDENCE_KINDS, isEvidenceKind } from './forms';

export const MAX_EVIDENCE_FILE_NAME = 120;

export type EvidenceRejection = 'empty' | 'too_large' | 'unsupported_type' | 'content_mismatch';

export type EvidenceCheck =
  | { ok: true; mime: EvidenceMime; fileName: string; sizeBytes: number; sha256: string }
  | { ok: false; reason: EvidenceRejection };

export function isEvidenceMime(value: string): value is EvidenceMime {
  return (EVIDENCE_MIME_TYPES as readonly string[]).includes(value);
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = [0x52, 0x49, 0x46, 0x46]; // RIFF
const WEBP = [0x57, 0x45, 0x42, 0x50]; // WEBP at offset 8

/** The type the file's leading bytes prove, or null. */
export function sniffEvidenceMime(bytes: Uint8Array): EvidenceMime | null {
  if (startsWith(bytes, PDF)) return 'application/pdf';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'image/webp';
  return null;
}

const EXTENSION: Record<EvidenceMime, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Keeps only [A-Za-z0-9._ -], collapses runs of spaces, strips leading dots,
 * spaces and dashes (no hidden or option-like names) and caps at 120
 * characters while keeping the extension. Empty results fall back to
 * `proof.<ext>`.
 */
export function sanitizeEvidenceFileName(raw: string, mime: EvidenceMime): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  let name = base
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._ -]/g, '')
    .replace(/ {2,}/g, ' ')
    .replace(/^[.\s-]+/, '')
    .trim();
  if (!/[A-Za-z0-9]/.test(name)) name = '';
  if (!name) return `proof.${EXTENSION[mime]}`;
  if (name.length > MAX_EVIDENCE_FILE_NAME) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : '';
    name = `${name.slice(0, MAX_EVIDENCE_FILE_NAME - ext.length).trimEnd()}${ext}`;
  }
  return name;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Validates an uploaded file. `declaredMime` is the browser-reported type; it
 * must be allowed AND agree with the magic bytes.
 */
export function checkEvidenceFile(input: { bytes: Uint8Array; declaredMime: string; fileName: string }): EvidenceCheck {
  const size = input.bytes.byteLength;
  if (size === 0) return { ok: false, reason: 'empty' };
  if (size > EVIDENCE_MAX_BYTES) return { ok: false, reason: 'too_large' };
  const declared = input.declaredMime.trim().toLowerCase();
  if (!isEvidenceMime(declared)) return { ok: false, reason: 'unsupported_type' };
  if (sniffEvidenceMime(input.bytes) !== declared) return { ok: false, reason: 'content_mismatch' };
  return {
    ok: true,
    mime: declared,
    fileName: sanitizeEvidenceFileName(input.fileName, declared),
    sizeBytes: size,
    sha256: sha256Hex(input.bytes),
  };
}
