import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from '../helpers/db';

/** Track G: the 20261205000600.. migrations load in order (PGlite). */
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

describe('track G migrations', () => {
  it('load and create the change objects', async () => {
    const rows = await db.query<{ ok: boolean }>(
      `select to_regclass('public.booking_change_requests') is not null
          and to_regclass('public.task_reconfirmations') is not null
          and to_regprocedure('public.booking_change_request_create(uuid, jsonb, uuid)') is not null as ok`);
    expect(rows[0]!.ok).toBe(true);
  });
});
