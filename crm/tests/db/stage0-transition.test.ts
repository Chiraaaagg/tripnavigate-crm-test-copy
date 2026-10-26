import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { ApplyResult, ClaimedInboxItem } from '@/modules/integration/contracts';
import {
  type Actor,
  FIXTURE_EMAILS,
  FIXTURE_USERS as U,
  type TestDb,
  fixtureFiles,
  migrationFiles,
  resetActor,
  setActor,
} from '../helpers/db';

/**
 * Stage 0 transition (migrations 20261107000100 ... 20261107000400) applied to a
 * database that already holds the product chain and data, as the hosted database
 * will: imported Deals stored by the pre-transition intake (20261007000200), then
 * the transition. Each case builds its own PGlite database up to 20261105000100,
 * creates the "before" state through the real pre-transition commands, and then
 * applies the transition files.
 *
 * PGlite only: a shared real Postgres (TEST_DATABASE_URL) already has every
 * migration applied, so these cases are skipped there.
 */

const TRANSITION = '20261107';
const SVC: Actor = { userId: null, role: 'service_role' };
const MEMBER = 'SYNTHETIC_MEMBER_0001';
const pglite = !process.env.TEST_DATABASE_URL;
let ts = 1_797_000_000;

const before = () => migrationFiles().filter((f) => basename(f) < TRANSITION);
const transition = () => migrationFiles().filter((f) => basename(f) >= TRANSITION);

async function buildBeforeTransition(): Promise<TestDb & { raw: PGlite }> {
  const raw = new PGlite();
  const root = join(import.meta.dirname, '..', '..');
  await raw.exec(readFileSync(join(root, 'tests', 'helpers', 'supabase-shim.sql'), 'utf8'));
  const users = Object.entries(U)
    .map(([key, id]) => `('${id}', '${FIXTURE_EMAILS[key as keyof typeof U]}')`)
    .join(',\n');
  await raw.exec(`insert into auth.users (id, email) values ${users};`);
  for (const file of before()) await raw.exec(readFileSync(file, 'utf8'));
  for (const file of fixtureFiles()) await raw.exec(readFileSync(file, 'utf8'));
  return {
    raw,
    mode: 'pglite',
    async query(sql, params) {
      return (await raw.query(sql, params)).rows as never;
    },
    async exec(sql) {
      await raw.exec(sql);
    },
    async close() {
      await raw.close();
    },
  };
}

async function applyTransition(db: TestDb, files = transition()): Promise<void> {
  for (const file of files) await db.exec(readFileSync(file, 'utf8'));
}

/** Imports one Deal through the PRE-transition intake (the active fixture manifest, 2026-09-15 IST). */
async function legacyImport(db: TestDb, id: number, assignedById: string): Promise<ApplyResult> {
  const svc = async <T>(sql: string, params: unknown[]): Promise<T[]> => {
    await db.exec('begin');
    try {
      await setActor(db, SVC);
      const rows = await db.query<T>(sql, params);
      await resetActor(db);
      await db.exec('commit');
      return rows;
    } catch (error) {
      await db.exec('rollback');
      throw error;
    }
  };
  const [rec] = await svc<{ r: { inboxId: string } }>('select public.integration_record_bitrix_event($1,$2,$3,$4) as r', [
    MEMBER, 'ONCRMDEALUPDATE', id, (ts += 1),
  ]);
  const claimed = await svc<{ r: ClaimedInboxItem }>('select r from public.integration_claim_inbox(100, 60) as r', []);
  const item = claimed.map((c) => c.r).find((c) => c.inboxId === rec!.r.inboxId)!;
  const deal = {
    id: String(id), sourceId: 'SYNTHETIC_SRC', title: `Synthetic legacy deal ${id}`, stageId: 'C7:NEW', categoryId: '7',
    assignedById, dateCreate: '2026-09-15T10:00:00+05:30', dateModify: '2026-09-15T10:00:00+05:30',
  };
  const [applied] = await svc<{ r: ApplyResult }>('select public.integration_apply_bitrix_deal($1,$2,$3::jsonb) as r', [
    item.inboxId, item.lockToken, JSON.stringify(deal),
  ]);
  return applied!.r;
}

describe.skipIf(!pglite)('Stage 0 transition over existing data', () => {
  it('backfills the Bitrix responsible of existing imported Deals from the owner\'s active mapping', async () => {
    const db = await buildBeforeTransition();
    try {
      expect(await legacyImport(db, 5101, '101')).toMatchObject({ outcome: 'created' });
      expect(await legacyImport(db, 5102, '102')).toMatchObject({ outcome: 'created' });
      await applyTransition(db);
      const rows = await db.query<{ reference: string; source_assigned_by_id: string; owner_user_id: string; removed_at: string | null }>(
        `select reference, source_assigned_by_id::text, owner_user_id, removed_at from public.deals
         where not is_synthetic order by reference`,
      );
      expect(rows).toEqual([
        { reference: 'BX-5101', source_assigned_by_id: '101', owner_user_id: U.salesDelhiA, removed_at: null },
        { reference: 'BX-5102', source_assigned_by_id: '102', owner_user_id: U.salesDelhiB, removed_at: null },
      ]);
      // Current settings keep both: nothing removed, no resync queued, one audit event per portal.
      const [jobs] = await db.query<{ n: number }>('select count(*)::int as n from public.integration_resync_jobs');
      expect(jobs!.n).toBe(0);
      const audit = await db.query<{ details: Record<string, unknown> }>(
        `select details from public.audit_events where action = 'integration.settings_applied_to_stored_deals'`,
      );
      expect(audit).toEqual([{ details: expect.objectContaining({ removed: 0, migration: '20261107000100' }) }]);
      // No scheduler was created and no extension installed.
      const [ext] = await db.query<{ n: number }>(`select count(*)::int as n from pg_extension where extname in ('pg_cron', 'pg_net')`);
      expect(ext!.n).toBe(0);
      expect(await db.query('select enabled from public.integration_sync_schedule')).toEqual([{ enabled: false }]);
    } finally {
      await db.close();
    }
  });

  it('stops with a count (nothing applied) when an imported Deal\'s responsible cannot be recovered', async () => {
    const db = await buildBeforeTransition();
    try {
      expect(await legacyImport(db, 5201, '101')).toMatchObject({ outcome: 'created' });
      expect(await legacyImport(db, 5202, '102')).toMatchObject({ outcome: 'created' });
      // The owner of BX-5202 no longer has an active mapping.
      await db.exec(`update public.bitrix_user_mappings set active = false where bitrix_user_id = 102`);
      const [main] = transition();
      await expect(applyTransition(db, [main!])).rejects.toMatchObject({
        code: '55000',
        message: expect.stringMatching(/^integration transition: 1 imported deal\(s\) have no recoverable Bitrix responsible/),
      });
      // The whole transaction rolls back: no transition object exists.
      await db.exec('rollback');
      expect(await db.query(`select to_regclass('public.deal_removal_participants') as t`)).toEqual([{ t: null }]);
      // After the operator links the owner's Bitrix user again, the transition applies.
      await db.exec(`update public.bitrix_user_mappings set active = true where bitrix_user_id = 102`);
      await applyTransition(db);
      const [n] = await db.query<{ n: number }>('select count(*)::int as n from public.deals where not is_synthetic and source_assigned_by_id is null');
      expect(n!.n).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('the one-time settings step soft-removes Deals outside the settings, records their people and queues one resync', async () => {
    const db = await buildBeforeTransition();
    try {
      expect(await legacyImport(db, 5301, '101')).toMatchObject({ outcome: 'created' });
      await db.query(
        `insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind)
         select d.id, d.legal_entity_id, $1, 'sales' from public.deals d where d.reference = 'BX-5301'`,
        [U.salesDelhiB],
      );
      // The pipeline was unticked before the transition: BX-5301 no longer belongs.
      await db.exec(`update public.integration_intake_config set category_id = 8 where portal_member_id = '${MEMBER}'`);
      await applyTransition(db);
      const [deal] = await db.query<{ id: string; owner_user_id: string | null; removed_reason: string }>(
        `select id, owner_user_id, removed_reason from public.deals where reference = 'BX-5301'`,
      );
      expect(deal).toMatchObject({ owner_user_id: null, removed_reason: 'pipeline_not_eligible' });
      expect(
        await db.query(
          `select user_id, participation from public.deal_removal_participants where deal_id = $1 order by participation`,
          [deal!.id],
        ),
      ).toEqual([
        { user_id: U.salesDelhiA, participation: 'owner' },
        { user_id: U.salesDelhiB, participation: 'sales' },
      ]);
      // The ended Sales assignment is kept (history), not deleted.
      expect(
        await db.query(`select user_id, ended_at is not null as ended from public.deal_assignments where deal_id = $1`, [deal!.id]),
      ).toEqual([{ user_id: U.salesDelhiB, ended: true }]);
      expect(await db.query(`select reason, status from public.integration_resync_jobs`)).toEqual([
        { reason: 'settings_changed', status: 'queued' },
      ]);
    } finally {
      await db.close();
    }
  });

  it('a pre-existing RLS predicate index with another definition stops the index check', async () => {
    const db = await buildBeforeTransition();
    try {
      const files = transition();
      await db.exec('drop index public.deals_owner_user_idx');
      await db.exec('create index deals_owner_user_idx on public.deals (owner_user_id, id)');
      // 20261107000200 (IF NOT EXISTS) silently keeps the different index; 20261107000400 refuses.
      await applyTransition(db, files.slice(0, 3));
      await expect(applyTransition(db, files.slice(3))).rejects.toMatchObject({
        code: '55000',
        message: expect.stringMatching(/^index deals_owner_user_idx differs from its single expected definition/),
      });
    } finally {
      await db.close();
    }
  });
});
