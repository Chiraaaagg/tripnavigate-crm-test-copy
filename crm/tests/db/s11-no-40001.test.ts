import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { CONFLICT_STATE } from '../helpers/sqlstates';
import { REVERT_FILE, SQL, SVC, s11Files, s11Helpers, stripComments } from './s11-support';

/**
 * S11 "files to Bitrix" (contract file 14 section 1.5 C4): a business refusal
 * never uses SQLSTATE 40001 (PostgREST would run the request again), nor any
 * other class-40 code. No S11 migration (nor the prepared revert file) raises
 * or names one; every conflict (lease or token mismatch) is PT409
 * task_conflict; the codes used are the frozen ones. Checked in the source and
 * in the database, plus one real refusal.
 */

const CLASS_40 = /'40[0-9A-Z]{3}'|\b40001\b/;
const CLASS_40_NAMES = /serialization_failure|transaction_rollback|deadlock_detected|transaction_integrity_constraint_violation|statement_completion_unknown/i;
/** The frozen refusal codes (lead freeze "Error codes"), plus 23514 for the table guards. */
const ALLOWED_CODES = ['PT409', '55000', '22023', '42501', 'P0002', 'PT429', '23514'];

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const s = s11Helpers(() => db);

describe('no 40001 in S11', () => {
  const sources = [...s11Files(), REVERT_FILE].map((f) => ({ name: basename(f), text: readFileSync(f, 'utf8') }));

  it('no S11 migration or the revert file raises, catches or names a class-40 code', () => {
    expect(sources).toHaveLength(7);
    for (const f of sources) {
      expect(f.text, f.name).not.toMatch(CLASS_40);
      expect(f.text, f.name).not.toMatch(CLASS_40_NAMES);
    }
  });

  it('every task_conflict refusal uses PT409, and only the frozen codes are used', () => {
    for (const f of sources) {
      const code = stripComments(f.text);
      const conflicts = code.match(/'task_conflict'/g) ?? [];
      const pt409 = code.match(/raise exception 'task_conflict' using errcode = 'PT409'/g) ?? [];
      expect(pt409.length, f.name).toBe(conflicts.length);
      for (const m of code.matchAll(/errcode = '([A-Z0-9]{5})'/g)) expect(ALLOWED_CODES, `${f.name}: ${m[1]}`).toContain(m[1]);
      expect(code.match(/errcode = 'PT409'/g)?.length ?? 0, f.name).toBe(pt409.length);
    }
    expect(sources.reduce((n, f) => n + (stripComments(f.text).match(/'task_conflict'/g) ?? []).length, 0)).toBeGreaterThanOrEqual(16);
  });

  it('in the database, no S11 function body (nor the three restated DEC-43 functions) holds a class-40 code', async () => {
    const rows = await db.query<{ f: string; src: string }>(
      `select n.nspname || '.' || p.proname as f, p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'authz')
         and (p.proname like 'file\\_move%' or p.proname like 'file\\_view%' or p.proname in ('kick_file_move', 'provision_file_move_sweep_job')
              or p.proname in ('bitrix_id_proof_copy_claim', 'bitrix_id_proof_copy_mark_sending', 'bitrix_id_proof_copy_complete'))`);
    expect(rows.length).toBeGreaterThanOrEqual(40);
    for (const r of rows) {
      expect(r.src, r.f).not.toMatch(CLASS_40);
      expect(r.src, r.f).not.toMatch(CLASS_40_NAMES);
    }
  });

  it('a lease mismatch arrives as PT409 task_conflict', async () => {
    await asOwner(db, async () => {
      await s.refusedWith(SVC, SQL.mark, [crypto.randomUUID(), crypto.randomUUID(), []], CONFLICT_STATE, 'task_conflict');
      await s.refusedWith(SVC, SQL.complete, [crypto.randomUUID(), crypto.randomUUID(), 'released', null, null], CONFLICT_STATE, 'task_conflict');
      await s.refusedWith(SVC, SQL.confirmDeleted, [crypto.randomUUID(), crypto.randomUUID()], CONFLICT_STATE, 'task_conflict');
      await s.refusedWith(SVC, SQL.presence, [993701, 'ufCrm_1784359513', crypto.randomUUID(), []], CONFLICT_STATE, 'task_conflict');
      expect(CONFLICT_STATE).toBe('PT409');
    });
  });
});
