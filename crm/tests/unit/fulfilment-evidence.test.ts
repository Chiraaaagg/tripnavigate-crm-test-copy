import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EVIDENCE_MAX_BYTES } from '@/modules/fulfilment/contracts';
import { formatEvidenceSize } from '@/modules/fulfilment/dto';
import { checkEvidenceFile, sanitizeEvidenceFileName, sniffEvidenceMime } from '@/modules/fulfilment/evidence';

const bytes = (...values: number[]) => new Uint8Array(values);
const withTail = (head: number[], size = 64) => {
  const b = new Uint8Array(size);
  b.set(head);
  return b;
};

const PDF = withTail([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const JPEG = withTail([0xff, 0xd8, 0xff, 0xe0]);
const PNG = withTail([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = withTail([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe('sniffEvidenceMime', () => {
  it.each([
    [PDF, 'application/pdf'],
    [JPEG, 'image/jpeg'],
    [PNG, 'image/png'],
    [WEBP, 'image/webp'],
  ])('recognises the magic bytes (%#)', (b, mime) => {
    expect(sniffEvidenceMime(b)).toBe(mime);
  });

  it('rejects RIFF that is not WEBP (e.g. WAV), HTML, and truncated headers', () => {
    expect(sniffEvidenceMime(withTail([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeNull();
    expect(sniffEvidenceMime(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffEvidenceMime(bytes(0x89, 0x50, 0x4e))).toBeNull();
    expect(sniffEvidenceMime(bytes(0x25, 0x50, 0x44, 0x46))).toBeNull(); // "%PDF" without "-"
  });
});

describe('checkEvidenceFile', () => {
  it('accepts a matching file and returns sanitized name, size and sha256', () => {
    const result = checkEvidenceFile({ bytes: PDF, declaredMime: 'application/pdf', fileName: 'Ticket ✈ 01.pdf' });
    expect(result).toEqual({
      ok: true,
      mime: 'application/pdf',
      fileName: 'Ticket 01.pdf',
      sizeBytes: 64,
      sha256: createHash('sha256').update(PDF).digest('hex'),
    });
  });

  it('rejects bad magic bytes for the declared type', () => {
    expect(checkEvidenceFile({ bytes: PNG, declaredMime: 'application/pdf', fileName: 'x.pdf' })).toEqual({
      ok: false,
      reason: 'content_mismatch',
    });
    const html = new TextEncoder().encode('<!doctype html><p>not an image</p>');
    expect(checkEvidenceFile({ bytes: html, declaredMime: 'image/png', fileName: 'x.png' })).toMatchObject({ ok: false });
  });

  it('rejects types outside the allow-list even with valid content', () => {
    expect(checkEvidenceFile({ bytes: PDF, declaredMime: 'text/html', fileName: 'x.html' })).toEqual({
      ok: false,
      reason: 'unsupported_type',
    });
    expect(checkEvidenceFile({ bytes: PNG, declaredMime: 'image/svg+xml', fileName: 'x.svg' })).toMatchObject({
      reason: 'unsupported_type',
    });
  });

  it('rejects empty and oversize files', () => {
    expect(checkEvidenceFile({ bytes: new Uint8Array(0), declaredMime: 'image/png', fileName: 'a.png' })).toMatchObject({
      reason: 'empty',
    });
    const big = new Uint8Array(EVIDENCE_MAX_BYTES + 1);
    big.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(checkEvidenceFile({ bytes: big, declaredMime: 'application/pdf', fileName: 'a.pdf' })).toMatchObject({
      reason: 'too_large',
    });
    const exact = new Uint8Array(EVIDENCE_MAX_BYTES);
    exact.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(checkEvidenceFile({ bytes: exact, declaredMime: 'application/pdf', fileName: 'a.pdf' }).ok).toBe(true);
  });

  it('accepts a declared type with different case/whitespace', () => {
    expect(checkEvidenceFile({ bytes: JPEG, declaredMime: ' IMAGE/JPEG ', fileName: 'p.jpg' }).ok).toBe(true);
  });
});

describe('sanitizeEvidenceFileName', () => {
  it('keeps only [A-Za-z0-9._ -] and strips paths', () => {
    expect(sanitizeEvidenceFileName('../../etc/passwd', 'application/pdf')).toBe('passwd');
    expect(sanitizeEvidenceFileName('C:\\Users\\x\\bill (final)<script>.pdf', 'application/pdf')).toBe('bill finalscript.pdf');
    expect(sanitizeEvidenceFileName('"quoted";\r\nname.png', 'image/png')).toBe('quotedname.png');
  });

  it('removes leading dots/dashes and falls back when nothing remains', () => {
    expect(sanitizeEvidenceFileName('.htaccess', 'image/png')).toBe('htaccess');
    expect(sanitizeEvidenceFileName('--rf.pdf', 'application/pdf')).toBe('rf.pdf');
    expect(sanitizeEvidenceFileName('✈✈✈', 'image/webp')).toBe('proof.webp');
    expect(sanitizeEvidenceFileName('...', 'image/jpeg')).toBe('proof.jpg');
  });

  it('caps at 120 characters and keeps the extension', () => {
    const name = sanitizeEvidenceFileName(`${'a'.repeat(300)}.pdf`, 'application/pdf');
    expect(name).toHaveLength(120);
    expect(name.endsWith('.pdf')).toBe(true);
    expect(/^[A-Za-z0-9._ -]+$/.test(name)).toBe(true);
  });
});

describe('formatEvidenceSize', () => {
  it('formats binary units', () => {
    expect(formatEvidenceSize(512)).toBe('512 B');
    expect(formatEvidenceSize(240 * 1024)).toBe('240 KB');
    expect(formatEvidenceSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatEvidenceSize(EVIDENCE_MAX_BYTES)).toBe(`${(EVIDENCE_MAX_BYTES / (1024 * 1024)).toFixed(1)} MB`);
    expect(formatEvidenceSize(10 * 1024 * 1024)).toBe('10 MB');
  });
});
