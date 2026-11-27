import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { S11_SOURCE_BUCKETS, removeMovedSourceObject, type StorageRemoveClient } from '@/modules/integration/server/file-storage-remove';

/**
 * S11 decision D5: Storage objects are removed through the Storage API from
 * ONE file only, src/modules/integration/server/file-storage-remove.ts. Until
 * S11 the CRM never removed a Storage object. This test reads every source
 * file of the application (and the Edge Functions) and fails when any other
 * file calls Storage remove, empties or deletes a bucket, or calls the
 * Storage object API directly.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Review 14a P3-9: the scripts folder is scanned too.
const SCANNED = ['src', join('supabase', 'functions'), 'scripts'];
const ONLY_CALLER = join('src', 'modules', 'integration', 'server', 'file-storage-remove.ts');

function walk(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...walk(path));
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** Ways to delete a Storage object or bucket. */
const PATTERNS: Array<[string, RegExp]> = [
  // storage.from(bucket).remove([path]) and any other remove taking a list.
  ['remove with a list', /\.remove\s*\(\s*\[/],
  // A remove call in a file that talks to Storage (catches remove(paths) with a variable).
  ['remove in a Storage file', /\.storage\b[\s\S]*\.remove\s*\(|\.remove\s*\([\s\S]*\.storage\b/],
  ['empty or delete a bucket', /\.(?:emptyBucket|deleteBucket)\s*\(/],
  ['Storage object API called directly', /storage\/v1\/object/],
  // Review 14a P3-9: a remove reached by name instead of by a dot call.
  ['remove by bracket name', /\[\s*['"`]remove['"`]\s*\]/],
  ['remove taken out of an object', /\{[^}]*\bremove\b[^}]*\}\s*=/],
];

const files = SCANNED.flatMap((d) => walk(join(ROOT, d)));
const rel = (p: string) => relative(ROOT, p).split(sep).join('/');

describe('only file-storage-remove.ts removes Storage objects', () => {
  it('the scan covers the application source', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map(rel)).toContain(ONLY_CALLER.split(sep).join('/'));
  });

  it('no other file matches any removal pattern', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (rel(file) === ONLY_CALLER.split(sep).join('/')) continue;
      const text = readFileSync(file, 'utf8');
      for (const [what, pattern] of PATTERNS) if (pattern.test(text)) offenders.push(`${rel(file)}: ${what}`);
    }
    expect(offenders).toEqual([]);
  });

  it('only the file move runtime imports the remove helper', () => {
    const importers = files
      .filter((file) => rel(file) !== ONLY_CALLER.split(sep).join('/'))
      .filter((file) => /file-storage-remove/.test(readFileSync(file, 'utf8')))
      .map(rel);
    expect(importers).toEqual(['src/modules/integration/server/file-move-runtime.ts']);
  });

  it('the one caller removes exactly one path per call', () => {
    const text = readFileSync(join(ROOT, ONLY_CALLER), 'utf8');
    expect(text.match(/\.remove\s*\(/g)).toHaveLength(1);
    expect(text).toMatch(/\.remove\(\[objectPath\]\)/);
  });
});

describe('removeMovedSourceObject', () => {
  function client(answer: { data: unknown; error: unknown } | 'throw' | 'hang' = { data: [], error: null }) {
    const calls: Array<{ bucket: string; paths: string[] }> = [];
    const c: StorageRemoveClient = {
      storage: {
        from: (bucket: string) => ({
          remove: (paths: string[]) => {
            calls.push({ bucket, paths });
            if (answer === 'throw') return Promise.reject(new Error('synthetic storage failure'));
            if (answer === 'hang') return new Promise<{ data: unknown; error: unknown }>(() => undefined);
            return Promise.resolve(answer);
          },
        }),
      },
    };
    return { c, calls };
  }

  it('the six S11 source buckets only', () => {
    expect([...S11_SOURCE_BUCKETS].sort()).toEqual(['booking-evidence', 'customer-party-documents', 'department-evidence', 'finance-evidence', 'supplier-money', 'traveller-id-proofs']);
  });

  it('removes one path in an allowed bucket; an absent object is harmless', async () => {
    const { c, calls } = client();
    expect(await removeMovedSourceObject(c, 'traveller-id-proofs', 'e/d/t/f.jpg')).toEqual({ kind: 'removed' });
    expect(calls).toEqual([{ bucket: 'traveller-id-proofs', paths: ['e/d/t/f.jpg'] }]);
  });

  it('refuses other buckets and unusual paths before any call', async () => {
    const { c, calls } = client();
    for (const bucket of ['rendered-documents', 'purchase-evidence', 'quotation-evidence', 'itinerary-sources', 'service-item-files', '']) {
      expect(await removeMovedSourceObject(c, bucket, 'e/f')).toEqual({ kind: 'refused', code: 'bucket_not_allowed' });
    }
    for (const path of ['', '/e/f', 'e/f/', 'e//f', 'e/../f', './e', 'e/\u0000f', 'e\\f', 'x'.repeat(1025)]) {
      expect(await removeMovedSourceObject(c, 'finance-evidence', path)).toEqual({ kind: 'refused', code: 'invalid_path' });
    }
    expect(calls).toEqual([]);
  });

  it('Storage errors, failures and timeouts are fixed codes', async () => {
    expect(await removeMovedSourceObject(client({ data: null, error: { message: 'synthetic' } }).c, 'finance-evidence', 'e/f')).toEqual({ kind: 'error', code: 'storage_error' });
    expect(await removeMovedSourceObject(client('throw').c, 'finance-evidence', 'e/f')).toEqual({ kind: 'error', code: 'storage_error' });
    expect(await removeMovedSourceObject(client('hang').c, 'finance-evidence', 'e/f', 5)).toEqual({ kind: 'error', code: 'timeout' });
  });
});
