import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACC, DEAL, SUPER, financeHelpers, rid } from './finance-support';

/**
 * G19 (20261210000300, bundled into booking go-live 2): a finance policy
 * version is effective from the time finance_policy_update held the policy
 * head lock, not from its transaction start.
 *
 * The race, in the order the steps happen on two sessions: the policy update's
 * transaction starts (its now() is fixed), a receipt is recorded and commits
 * with the version in force at the receipt's own now(), and only then does the
 * policy update take the head and store its version. Before the fix the new
 * version was stored as effective from the policy transaction's start, which
 * is before the receipt: the history then says the receipt should have used the
 * new version. PGlite is one connection, so the steps run in one transaction in
 * that order (open, read now(), receipt_record, finance_policy_update): the
 * receipt's time equals the policy transaction's now(), which shows the same
 * contradiction deterministically. The two-session version is in
 * tests/supabase/finance-concurrency.real.test.ts (real Postgres).
 */

let db: TestDb;
// Finance db files share the policy head and counters on one real Postgres in CI.
const FINANCE_SUITE_LOCK = 5000000001;
beforeAll(async () => {
  db = await createTestDb();
  await db.query('select pg_advisory_lock($1)', [FINANCE_SUITE_LOCK]);
});
afterAll(async () => {
  await db?.query('select pg_advisory_unlock($1)', [FINANCE_SUITE_LOCK]).catch(() => undefined);
  await db?.close();
});

const h = financeHelpers(() => db);

describe('G19: policy version effective from the lock, not from the transaction start', () => {
  it('a receipt recorded before the policy update took the lock keeps a consistent history', async () => {
    await asOwner(db, async () => {
      const [{ t0 }] = (await db.query<{ t0: string }>('select now()::text as t0')) as [{ t0: string }];
      const entity = await h.entityId();
      const rec = await h.record(ACC, DEAL, await h.bankFields());
      const policy = await h.one<{ id: string; status: string }>(SUPER, 'select public.finance_policy_update($1, $2::jsonb, null, $3, $4) as r', [
        entity,
        JSON.stringify({}),
        'Synthetic G19 policy race check',
        rid(),
      ]);
      expect(policy.status).toBe('effective');
      const [row] = await h.owner<{ used: string; in_force: string; recorded_at: string; effective_at: string; after_start: boolean }>(
        `select r.policy_version_id as used, (authz.finance_policy_at(r.legal_entity_id, r.recorded_at)).id as in_force,
                r.recorded_at::text, v.effective_at::text, v.effective_at > $3::timestamptz as after_start
         from public.customer_receipts r, public.finance_policy_versions v
         where r.id = $1 and v.id = $2`,
        [rec.id, policy.id, t0],
      );
      // The receipt used the version in force at its own time, and the history agrees.
      expect(row!.used).toBe(row!.in_force);
      expect(row!.used).not.toBe(policy.id);
      // The new version starts after the policy transaction's start (the lock time).
      expect(row!.after_start, `${row!.effective_at} vs transaction start ${t0}`).toBe(true);
    });
  });

  it('an explicit effective time before the lock moves to the lock time; earlier than the transaction start is still refused', async () => {
    await asOwner(db, async () => {
      const entity = await h.entityId();
      const policy = await h.one<{ id: string; status: string }>(SUPER, 'select public.finance_policy_update($1, $2::jsonb, now(), $3, $4) as r', [
        entity,
        JSON.stringify({}),
        'Synthetic G19 explicit time check',
        rid(),
      ]);
      expect(policy.status).toBe('effective');
      const [row] = await h.owner<{ later: boolean }>('select v.effective_at > now() as later from public.finance_policy_versions v where v.id = $1', [policy.id]);
      expect(row!.later).toBe(true);
      await h.refused(SUPER, 'select public.finance_policy_update($1, $2::jsonb, $3::timestamptz, $4, $5) as r', [
        entity,
        JSON.stringify({}),
        '2000-01-01T00:00:00Z',
        'Synthetic G19 past time check',
        rid(),
      ], '22023', 'invalid_input');
    });
  });

  it('keeps the lock, attributes and grants of finance_policy_update', async () => {
    const [fn] = await db.query<{ src: string; definer: boolean; volatility: string; config: string[] | null; auth: boolean; anon: boolean }>(
      `select p.prosrc as src, p.prosecdef as definer, p.provolatile as volatility, p.proconfig as config,
              has_function_privilege('authenticated', p.oid, 'execute') as auth, has_function_privilege('anon', p.oid, 'execute') as anon
       from pg_proc p where p.oid = 'public.finance_policy_update(uuid,jsonb,timestamptz,text,uuid)'::regprocedure`,
    );
    expect(fn).toMatchObject({ definer: true, volatility: 'v', config: ['search_path=""'], auth: true, anon: false });
    // The time is taken after the head lock, and no refusal uses 40001.
    expect(fn!.src.indexOf('finance_lock_policy(p_entity_id, true)')).toBeLessThan(fn!.src.indexOf('clock_timestamp()'));
    expect(fn!.src).not.toMatch(/40001/);
  });
});
