import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRealStackRequired } from '@/lib/config';
import { type TestDb, assertDatabaseUrlNotOperational, createTestDb, resetActor, setActor } from '../helpers/db';
import { createRealStack, resolveRealStackEnv } from '../helpers/real-stack';
import { SQL, SVC, s11Helpers } from '../db/s11-support';

/**
 * S11 "files to Bitrix" on the REAL local stack (contract file 14 section 5.3
 * "Real stack", file 11 section 4.2): the Storage service and the database
 * agree about deletion.
 *   1. A Storage API remove deletes the object and the database sees it gone.
 *   2. An SQL delete on storage.objects is refused (only the Storage API
 *      removes objects; the CRM's one caller is file-storage-remove.ts).
 *   3. End to end through the S11 commands: a stored traveller proof whose
 *      bytes really are in Storage reaches delete_pending, is removed through
 *      the Storage API, file_move_confirm_deleted sees it gone; the copy-back
 *      (database-compared observation) uploads the same bytes to the same path
 *      and file_move_confirm_restored sees them back; the object downloads
 *      with the same SHA-256.
 * Synthetic bytes and ids only; no Bitrix call. Database steps run in one
 * transaction that is rolled back; objects left in Storage are removed in
 * afterAll. Fails (never skips) when REQUIRE_REAL_STACK=1 and the stack or
 * TEST_DATABASE_URL is missing.
 */

const env = resolveRealStackEnv();
const stack = env ? createRealStack(env) : null;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
function databaseUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    if (env && isRealStackRequired(process.env)) throw new Error('REQUIRE_REAL_STACK=1 but TEST_DATABASE_URL is missing');
    return null;
  }
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) throw new Error('S11 storage real-stack test runs only against a local database');
  return url;
}
const dbUrl = env ? databaseUrl() : null;
const enabled = env !== null && dbUrl !== null;

const BUCKET = 'traveller-id-proofs';
const runTag = randomBytes(4).toString('hex');
const leftovers: string[] = [];

/** 2048 synthetic bytes that start like a PDF. */
function syntheticPdf(): Uint8Array {
  const bytes = new Uint8Array(2048);
  bytes.set(new TextEncoder().encode('%PDF-1.4\n% synthetic S11 test file\n'));
  bytes.set(randomBytes(1024), 1024);
  return bytes;
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function ownerQuery<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: dbUrl! });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}
const objectRow = (name: string) =>
  ownerQuery<{ size: string | null }>(`select metadata ->> 'size' as size from storage.objects where bucket_id = $1 and name = $2`, [BUCKET, name]);

async function upload(path: string, bytes: Uint8Array): Promise<void> {
  const { error } = await stack!.admin().storage.from(BUCKET).upload(path, new Blob([bytes], { type: 'application/pdf' }), {
    contentType: 'application/pdf',
    upsert: false,
  });
  if (error) throw error;
  leftovers.push(path);
}
async function removeObject(path: string): Promise<void> {
  const { error } = await stack!.admin().storage.from(BUCKET).remove([path]);
  if (error) throw error;
}
async function download(path: string): Promise<Uint8Array> {
  const { data, error } = await stack!.admin().storage.from(BUCKET).download(path);
  if (error || !data) throw error ?? new Error('no data');
  return new Uint8Array(await data.arrayBuffer());
}

describe.skipIf(!enabled)('S11 Storage removal and restore (real local stack)', () => {
  let db: TestDb;
  beforeAll(async () => {
    await assertDatabaseUrlNotOperational(dbUrl!);
    db = await createTestDb();
  });
  afterAll(async () => {
    if (enabled && leftovers.length > 0) await stack!.admin().storage.from(BUCKET).remove(leftovers);
    await db?.close();
  });

  it('a Storage API remove deletes the object and the database sees it', async () => {
    const path = `s11-ci/${runTag}/${crypto.randomUUID()}`;
    await upload(path, syntheticPdf());
    expect(await objectRow(path)).toEqual([{ size: '2048' }]);
    await removeObject(path);
    expect(await objectRow(path)).toEqual([]);
  });

  it('an SQL delete on storage.objects is refused; the object stays', async () => {
    const path = `s11-ci/${runTag}/${crypto.randomUUID()}`;
    const bytes = syntheticPdf();
    await upload(path, bytes);
    const client = new pg.Client({ connectionString: dbUrl! });
    await client.connect();
    let refused: { code?: string; message?: string } | null = null;
    try {
      await client.query('begin');
      try {
        await client.query('delete from storage.objects where bucket_id = $1 and name = $2', [BUCKET, path]);
      } catch (error) {
        refused = error as { code?: string; message?: string };
      }
    } finally {
      await client.query('rollback');
      await client.end();
    }
    expect(refused, 'the delete must be refused by Storage').not.toBeNull();
    expect(await objectRow(path)).toEqual([{ size: '2048' }]);
    expect(sha256(await download(path))).toBe(sha256(bytes));
    await removeObject(path);
  });

  it('end to end: delete_pending -> Storage remove -> confirm_deleted sees it gone; copy-back -> same path, same hash -> confirm_restored', async () => {
    const s = s11Helpers(() => db);
    const bytes = syntheticPdf();
    const sha = sha256(bytes);
    await db.exec('begin');
    try {
      const deal = await s.bitrixDeal(993801);
      const begun = await s.one<{ fileId: string; objectPath: string }>({ userId: 'a0000000-0000-4000-8000-000000000001' },
        'select public.traveller_id_proof_begin($1, $2, $3, true, $4, $5, $6, $7) as r',
        [deal, 1, crypto.randomUUID(), 'id-proof-1.pdf', 'application/pdf', bytes.length, sha]);
      // The server uploads after the database authorized the file (synthetic bytes).
      await upload(begun.objectPath, bytes);
      const fin = await s.one<{ status: string }>({ userId: 'a0000000-0000-4000-8000-000000000001' },
        'select public.traveller_id_proof_finish($1, true) as r', [begun.fileId]);
      expect(fin.status).toBe('stored');
      const moveId = await s.moveIdOf('traveller_id_proofs', begun.fileId);
      expect(await s.move(moveId)).toMatchObject({ state: 'waiting', sha256: sha, size_bytes: 2048, crm_copy_present: true });

      // Two matching observations done (owner SQL), deletion allowed, leased for delete.
      await s.deletePending(moveId, 1901);
      const token = await s.lease(moveId, 'delete');
      // Still present: the database refuses to call it deleted.
      expect(await s.one(SVC, SQL.confirmDeleted, [moveId, token])).toEqual({ result: 'still_present' });
      const again = await s.lease(moveId, 'delete');
      await removeObject(begun.objectPath);
      expect(await objectRow(begun.objectPath)).toEqual([]);
      expect(await s.one(SVC, SQL.confirmDeleted, [moveId, again])).toEqual({ result: 'deleted' });
      expect(await s.move(moveId)).toMatchObject({ state: 'deleted', crm_copy_present: false });

      // Copy-back: the database compares the bytes read from Bitrix (here: the same bytes), then the upload, then the confirmation.
      await s.setMove(moveId, `state = 'restore_pending', next_attempt_at = now()`);
      const restore = await s.lease(moveId, 'restore');
      await setActor(db, SVC);
      const observed = await db.query<{ r: { result: string } }>(SQL.observe, [moveId, restore, 1901, sha256(bytes), bytes.length, null]);
      await resetActor(db);
      expect(observed[0]!.r).toEqual({ result: 'restore_checked' });
      await upload(begun.objectPath, bytes);
      expect(await s.one(SVC, SQL.confirmRestored, [moveId, restore])).toEqual({ result: 'restored' });
      expect(await s.move(moveId)).toMatchObject({ state: 'copied', crm_copy_present: true, object_path: begun.objectPath });
      expect(await objectRow(begun.objectPath)).toEqual([{ size: '2048' }]);
      expect(sha256(await download(begun.objectPath))).toBe(sha);
    } finally {
      await db.exec('rollback');
    }
  });
});
