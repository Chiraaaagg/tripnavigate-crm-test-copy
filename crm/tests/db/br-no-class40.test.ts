import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from '../helpers/db';

/**
 * Booking reliability B1-1: PostgREST treats every class-40 SQLSTATE
 * (transaction rollback: 40001 serialization failure, 40P01 deadlock, ...) as
 * a reason to run the whole request again. A business refusal must never use
 * one. After stage 2 (20261206000200 and 000210) the allow-list is empty, so a
 * later migration that brings a class-40 code back into any function in
 * public or authz fails here, on the database CI builds (PGlite, or the real
 * local Supabase stack).
 */

/** Functions allowed to hold a class-40 code. Empty after stage 2; keep it empty. */
const ALLOW_LIST: readonly string[] = [];

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

describe('no class-40 SQLSTATE in public or authz (B1-1)', () => {
  it('no function body raises or catches a class-40 code by number', async () => {
    const rows = await db.query<{ f: string }>(
      `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as f
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'authz') and p.prosrc ~* '''40[0-9A-Z]{3}'''
       order by 1`);
    expect(rows.map((r) => r.f).filter((f) => !ALLOW_LIST.includes(f.slice(0, f.indexOf('('))))).toEqual([]);
  });

  it('no function body names a class-40 condition or raises a transaction-rollback condition', async () => {
    const rows = await db.query<{ f: string }>(
      `select n.nspname || '.' || p.proname as f
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'authz')
         and p.prosrc ~* '\\m(serialization_failure|transaction_rollback|deadlock_detected|transaction_integrity_constraint_violation|statement_completion_unknown)\\M'
       order by 1`);
    expect(rows.map((r) => r.f)).toEqual([]);
  });

  it('the conflict code PT409 is in use (the stage-2 migrations ran)', async () => {
    const [row] = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'authz') and p.prosrc like '%''PT409''%'`);
    expect(row!.n).toBeGreaterThanOrEqual(108);
  });
});
