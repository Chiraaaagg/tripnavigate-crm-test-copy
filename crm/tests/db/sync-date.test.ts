import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApplyResult, BitrixDealSnapshot, ClaimedInboxItem } from '@/modules/integration/contracts';
import {
  type Actor,
  FIXTURE_DEALS as D,
  FIXTURE_USERS as U,
  type TestDb,
  asOwner,
  createTestDb,
  expectDbError,
  resetActor,
  setActor,
} from '../helpers/db';

/**
 * Soft removal, pipelines/stages and the sync date (migrations 20261009000500 +
 * 20261009000600, renumbered from 20261008000100/0200) under main's intake guards
 * (20261009001000, PR #13 review fix 1): Deals enter only through the active approved
 * manifest (fixture: business day 2026-09-15 IST, ids 5000-9999, source SYNTHETIC_SRC),
 * an unmapped Bitrix owner is held for review, and Super Admin reads no deal
 * (access matrix). Synthetic fixtures only: portal SYNTHETIC_MEMBER_0001, pilot branch
 * Delhi, category 7, entry stages C7:NEW / C7:PREPARATION, Bitrix users 101 -> Sales
 * Delhi A, 102 -> Sales Delhi B. The Delhi manager reads the branch through a grant.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const SVC: Actor = { userId: null, role: 'service_role' };
const ADMIN: Actor = { userId: U.adminJodhpur };
/** Branch-wide reader of the pilot branch (Delhi grant). */
const MANAGER: Actor = { userId: U.managerDelhi };
const MEMBER = 'SYNTHETIC_MEMBER_0001';
const first = <T>(rows: Array<{ r: T }>): T => rows[0]!.r;
let ts = 1_796_000_000;

async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  await setActor(db, actor);
  // No finally: after an error the transaction is aborted; expectDbError rolls back to its savepoint.
  const rows = await db.query<T>(sql, params);
  await resetActor(db);
  return rows;
}

type Snapshot = BitrixDealSnapshot & { sourceId?: string };

function snapshot(id: number, assignedById: string, over: Partial<Snapshot> = {}): Snapshot {
  const created = over.dateCreate ?? '2026-09-15T10:00:00+05:30';
  return {
    id: String(id),
    // The fixture manifest's verified Bitrix source code.
    sourceId: 'SYNTHETIC_SRC',
    title: `Synthetic sync-date deal ${id}`,
    stageId: 'C7:NEW',
    categoryId: '7',
    assignedById,
    dateCreate: created,
    dateModify: over.dateModify ?? created,
    ...over,
  };
}

async function importDeal(deal: Snapshot): Promise<ApplyResult> {
  const rec = first(
    await run<{ r: { inboxId: string } }>(SVC, 'select public.integration_record_bitrix_event($1,$2,$3,$4) as r', [
      MEMBER,
      'ONCRMDEALUPDATE',
      Number(deal.id),
      (ts += 1),
    ]),
  );
  return applyTo(rec.inboxId, deal);
}

async function applyTo(inboxId: string, deal: Snapshot): Promise<ApplyResult> {
  const claimed = await run<{ r: ClaimedInboxItem }>(SVC, 'select r from public.integration_claim_inbox(100, 60) as r');
  const item = claimed.map((c) => c.r).find((c) => c.inboxId === inboxId)!;
  return first(
    await run<{ r: ApplyResult }>(SVC, 'select public.integration_apply_bitrix_deal($1,$2,$3::jsonb) as r', [
      item.inboxId,
      item.lockToken,
      JSON.stringify(deal),
    ]),
  );
}

type Settings = { requeued: number; removed: number; restored: number; resyncQueued: boolean; cutoffAt: string };
const settings = (actor: Actor, cats: number[], stages: string[], cutoff: string) =>
  run<{ r: Settings }>(actor, `select public.integration_apply_sync_settings((public.integration_preview_sync_settings($1, $2, $3, true) ->> 'previewId')::uuid, 'Test: sync settings saved through preview and apply') as r`, [cats, stages, cutoff]).then(
    first,
  );
const STAGES = ['C7:NEW', 'C7:PREPARATION'];

const visibleBx = async (actor: Actor) =>
  (await run<{ reference: string }>(actor, `select reference from public.deals where reference like 'BX-%' order by reference`)).map(
    (r) => r.reference,
  );
const countAs = async (actor: Actor) =>
  Number((await run<{ n: string }>(actor, 'select count(*)::text as n from public.deals'))[0]!.n);
const deal = async (ref: string) =>
  (
    await db.query<{ id: string; owner_user_id: string | null; removed_at: string | null; removed_reason: string | null }>(
      'select id, owner_user_id, removed_at, removed_reason from public.deals where reference = $1',
      [ref],
    )
  )[0]!;
const activeAssignments = async (ref: string) =>
  (
    await db.query<{ user_id: string }>(
      `select a.user_id from public.deal_assignments a join public.deals d on d.id = a.deal_id
       where d.reference = $1 and a.ended_at is null`,
      [ref],
    )
  ).map((r) => r.user_id);

describe('Super Admin reads no deal (access matrix); other roles unchanged', () => {
  it('Super Admin: no imported or synthetic deal, no assignment, no commercial value; an unmapped owner is held for review', async () => {
    await asOwner(db, async () => {
      expect(await importDeal(snapshot(9101, '101'))).toMatchObject({ outcome: 'created' }); // Sales Delhi A, Delhi
      // No guessed or missing owner: an unmapped Bitrix user is held for review, nothing stored.
      expect(await importDeal(snapshot(9102, '777'))).toMatchObject({ outcome: 'needs_review', reasonCode: 'unmapped_owner' });
      expect(await db.query(`select 1 from public.deals where reference = 'BX-9102'`)).toEqual([]);
      expect(await countAs(ADMIN)).toBe(0);
      expect(await visibleBx(ADMIN)).toEqual([]);
      expect(await run(ADMIN, 'select id from public.deals where id = any($1::uuid[])', [[D.del001, D.amd001]])).toEqual([]);
      expect(
        await run(ADMIN, 'select 1 from public.deal_assignments a join public.deals d on d.id = a.deal_id where d.reference = $1', ['BX-9101']),
      ).toEqual([]);
      expect(await run(ADMIN, 'select deal_id from public.deal_commercials')).toEqual([]);
      // The branch reader sees the imported deal; another legal entity stays out.
      expect(await visibleBx(MANAGER)).toEqual(['BX-9101']);
      expect((await run<{ id: string }>(MANAGER, 'select id from public.deals')).map((r) => r.id)).not.toContain(D.b001);
    });
  });

  it('Salesperson: own only; Manager: branch grant (owned deals); Inactive: nothing; aal1: nothing', async () => {
    await asOwner(db, async () => {
      await importDeal(snapshot(9111, '101'));
      await importDeal(snapshot(9112, '102'));
      expect(await importDeal(snapshot(9113, '777'))).toMatchObject({ outcome: 'needs_review', reasonCode: 'unmapped_owner' });
      expect(await visibleBx({ userId: U.salesDelhiA })).toEqual(['BX-9111']);
      expect(await visibleBx({ userId: U.salesDelhiB })).toEqual(['BX-9112']);
      expect(await visibleBx({ userId: U.managerDelhi })).toEqual(['BX-9111', 'BX-9112']);
      expect(await countAs({ userId: U.formerStaff })).toBe(0);
      expect(await countAs({ userId: U.adminJodhpur, aal: 'aal1' })).toBe(0);
      // Purchase never reads commercial values (unchanged rule).
      expect(await run({ userId: U.purchaseJodhpur }, 'select deal_id from public.deal_commercials')).toEqual([]);
    });
  });
});

describe('sync date moves LATER: older deals are removed for everyone', () => {
  // The approved manifest covers one IST day (2026-09-15) and the sync date is an IST
  // midnight, so moving it past that day removes the day's imported deals.
  it('removed from every list, count and detail; assignments end; audited; synthetic deals stay', async () => {
    await asOwner(db, async () => {
      await importDeal(snapshot(9201, '101', { dateCreate: '2026-09-15T09:00:00+05:30' }));
      const before = await countAs(MANAGER);
      const old = await deal('BX-9201');
      expect(await activeAssignments('BX-9201')).toEqual([U.salesDelhiA]);

      const r = await settings(ADMIN, [7], STAGES, '2026-09-16T00:00:00+05:30');
      expect(r).toMatchObject({ removed: 1, restored: 0, resyncQueued: true });

      expect(await deal('BX-9201')).toMatchObject({ owner_user_id: null, removed_reason: 'before_sync_date' });
      expect(await activeAssignments('BX-9201')).toEqual([]);
      for (const actor of [ADMIN, { userId: U.salesDelhiA }, MANAGER]) {
        expect(await visibleBx(actor)).toEqual([]);
        expect(await run(actor, 'select id from public.deals where id = $1', [old.id])).toEqual([]);
        expect(await run(actor, 'select 1 from public.deal_assignments where deal_id = $1', [old.id])).toEqual([]);
      }
      expect(await countAs(MANAGER)).toBe(before - 1);
      // Synthetic (non-Bitrix) deals are never removed.
      expect((await run<{ n: string }>(MANAGER, 'select count(*)::text as n from public.deals where is_synthetic'))[0]!.n).not.toBe('0');
      // Not deleted: the row and its audit trail stay.
      expect(old.id).toBeTruthy();
      const [audit] = await db.query<{ details: Record<string, unknown> }>(
        `select details from public.audit_events where action = 'integration.settings_updated' order by id desc limit 1`,
      );
      expect(audit!.details).toMatchObject({ removed: 1, restored: 0 });
      expect(new Date(audit!.details.cutoffAt as string).toISOString()).toBe('2026-09-15T18:30:00.000Z');
      // Open deal pages are told to refresh (the removed row itself sends no event to them).
      expect(await run(MANAGER, 'select removed from public.deal_list_changes')).toEqual([{ removed: 1 }]);
      // Link/unlink never re-assigns a removed deal.
      await run(ADMIN, 'select public.integration_unlink_bitrix_user($1)', [U.salesDelhiA]);
      await run(ADMIN, 'select public.integration_link_bitrix_user($1, 101)', [U.salesDelhiA]);
      expect(await deal('BX-9201')).toMatchObject({ owner_user_id: null });
      expect(await visibleBx({ userId: U.salesDelhiA })).toEqual([]);
    });
  });
});

describe('sync date moves EARLIER: removed deals come back, missing ones are fetched', () => {
  it('restores with the owner mapping re-applied and queues a fresh read; new resync job', async () => {
    await asOwner(db, async () => {
      await importDeal(snapshot(9301, '101'));
      await settings(ADMIN, [7], STAGES, '2026-09-16T00:00:00+05:30');
      expect(await visibleBx({ userId: U.salesDelhiA })).toEqual([]);

      const r = await settings(ADMIN, [7], STAGES, '2026-09-01T00:00:00+05:30');
      expect(r).toMatchObject({ removed: 0, restored: 1, resyncQueued: true });
      expect(await deal('BX-9301')).toMatchObject({ owner_user_id: U.salesDelhiA, removed_at: null });
      expect(await activeAssignments('BX-9301')).toEqual([U.salesDelhiA]);
      expect(await visibleBx({ userId: U.salesDelhiA })).toEqual(['BX-9301']);
      // Fetched fresh from Bitrix: an open inbox row for the restored deal.
      expect(
        await db.query(`select 1 from public.integration_inbox where source_deal_id = 9301 and status = 'pending'`),
      ).toHaveLength(1);
      // Exactly one open resync job (the earlier one was superseded) with the new date.
      const jobs = await db.query<{ status: string; reason: string; cutoff_at: Date | string }>(
        `select status, reason, cutoff_at from public.integration_resync_jobs order by created_at, status`,
      );
      expect(jobs.filter((j) => j.status === 'queued')).toHaveLength(1);
      expect(jobs.filter((j) => j.status === 'superseded')).toHaveLength(1);
      // Missing deals created after the new date enter through the apply rule.
      expect(await importDeal(snapshot(9302, '101', { dateCreate: '2026-09-15T11:00:00+05:30' }))).toMatchObject({ outcome: 'created' });
    });
  });
});

describe('time zone: the sync date is 00:00 India time (IST)', () => {
  it('23:30 IST the day before is out, 00:10 IST on the day is in (settings, manifest and apply agree)', async () => {
    await asOwner(db, async () => {
      // Any instant of the IST day is normalised to its 00:00 IST.
      const r = await settings(ADMIN, [7], STAGES, '2026-09-15T03:00:00Z');
      expect(new Date(r.cutoffAt).toISOString()).toBe('2026-09-14T18:30:00.000Z');
      // The day before is outside the approved manifest day as well as before the sync date.
      expect(await importDeal(snapshot(9401, '101', { dateCreate: '2026-09-14T23:30:00+05:30' }))).toMatchObject({
        outcome: 'needs_review',
        reasonCode: 'outside_manifest_scope',
      });
      expect(await importDeal(snapshot(9402, '101', { dateCreate: '2026-09-15T00:10:00+05:30' }))).toMatchObject({ outcome: 'created' });
      expect(await visibleBx(MANAGER)).toEqual(['BX-9402']);
      // The same boundary for a stored deal when the date moves past its day, and back.
      await settings(ADMIN, [7], STAGES, '2026-09-16T00:00:00+05:30');
      expect((await deal('BX-9402')).removed_reason).toBe('before_sync_date');
      await settings(ADMIN, [7], STAGES, '2026-09-15T00:00:00+05:30');
      expect((await deal('BX-9402')).removed_at).toBeNull();
    });
  });
});

describe('pipelines and stages', () => {
  it('unticking a pipeline removes its deals; ticking it again restores them', async () => {
    await asOwner(db, async () => {
      await importDeal(snapshot(9501, '101'));
      expect((await settings(ADMIN, [9], ['C9:NEW'], '2026-09-01T00:00:00+05:30')).removed).toBeGreaterThanOrEqual(1);
      expect((await deal('BX-9501')).removed_reason).toBe('pipeline_not_eligible');
      expect((await settings(ADMIN, [7], STAGES, '2026-09-01T00:00:00+05:30')).restored).toBeGreaterThanOrEqual(1);
      expect(await deal('BX-9501')).toMatchObject({ removed_at: null, owner_user_id: U.salesDelhiA });
    });
  });

  it('unticking a stage removes deals in it now; a deal that MOVED to an unticked stage after import stays', async () => {
    await asOwner(db, async () => {
      await importDeal(snapshot(9511, '101', { stageId: 'C7:PREPARATION' }));
      await importDeal(snapshot(9512, '101'));
      await importDeal(snapshot(9512, '101', { stageId: 'C7:WON', dateModify: '2026-09-16T10:00:00+05:30' })); // won after import
      expect((await deal('BX-9512')).removed_at).toBeNull();
      const r = await settings(ADMIN, [7], ['C7:NEW'], '2026-09-01T00:00:00+05:30');
      expect(r.removed).toBe(1);
      expect((await deal('BX-9511')).removed_reason).toBe('stage_not_eligible');
      expect((await deal('BX-9512')).removed_at).toBeNull();
    });
  });

  it('apply: a stored deal moved to another pipeline in Bitrix is removed; moved back it is restored with its owner', async () => {
    await asOwner(db, async () => {
      await importDeal(snapshot(9521, '101'));
      expect(await importDeal(snapshot(9521, '101', { categoryId: '9', stageId: 'C9:NEW', dateModify: '2026-09-16T10:00:00+05:30' }))).toMatchObject({
        outcome: 'updated',
      });
      expect(await deal('BX-9521')).toMatchObject({ removed_reason: 'pipeline_not_eligible', owner_user_id: null });
      expect(await visibleBx(MANAGER)).not.toContain('BX-9521');
      // Still ineligible: kept up to date, stays removed.
      expect(await importDeal(snapshot(9521, '101', { categoryId: '9', stageId: 'C9:NEW', title: 'Renamed', dateModify: '2026-09-17T10:00:00+05:30' }))).toMatchObject({
        outcome: 'ignored',
        reasonCode: 'not_eligible_category',
      });
      expect(await importDeal(snapshot(9521, '101', { dateModify: '2026-09-18T10:00:00+05:30' }))).toMatchObject({ outcome: 'updated' });
      expect(await deal('BX-9521')).toMatchObject({ removed_at: null, owner_user_id: U.salesDelhiA });
      expect(await activeAssignments('BX-9521')).toEqual([U.salesDelhiA]);
      const actions = (
        await db.query<{ action: string }>(
          `select action from public.audit_events where target_id = $1 and action in ('integration.deal_removed', 'integration.deal_restored') order by id`,
          [(await deal('BX-9521')).id],
        )
      ).map((a) => a.action);
      expect(actions).toEqual(['integration.deal_removed', 'integration.deal_restored']);
    });
  });
});

describe('full resync job (cursor, lease, count check)', () => {
  type Job = { jobId: string; lockToken: string; cursorId: number; listingDone: boolean };
  const next = () => run<{ r: Job | null }>(SVC, `select public.integration_resync_next($1, 60) as r`, [MEMBER]).then(first);
  const page = (job: Job, deals: Array<{ id: number; modified: number }>, total: number | null, last: boolean) =>
    run<{ r: { enqueued: number; scanned: number; cursorId: number } }>(
      SVC,
      'select public.integration_resync_page($1, $2, $3::jsonb, $4, $5) as r',
      [job.jobId, job.lockToken, JSON.stringify(deals), total, last],
    ).then(first);
  const finish = (job: Job) =>
    run<{ r: { done: boolean; waiting?: number; result?: Record<string, unknown> } }>(SVC, 'select public.integration_resync_finish($1, $2) as r', [
      job.jobId,
      job.lockToken,
    ]).then(first);
  const drain = async (dealsById: Record<string, Snapshot>) => {
    const claimed = await run<{ r: ClaimedInboxItem }>(SVC, 'select r from public.integration_claim_inbox(100, 60) as r');
    for (const { r: item } of claimed) {
      await run(SVC, 'select public.integration_apply_bitrix_deal($1,$2,$3::jsonb)', [
        item.inboxId,
        item.lockToken,
        JSON.stringify(dealsById[item.sourceDealId] ?? null),
      ]);
    }
  };

  it('daily job is queued; listing continues by cursor; one lease at a time; counts recorded when drained', async () => {
    await asOwner(db, async () => {
      await db.exec(`delete from public.integration_inbox where status in ('pending','processing','failed')`);
      const job = (await next())!;
      expect(job).toMatchObject({ cursorId: 0, listingDone: false });
      expect((await db.query<{ reason: string }>('select reason from public.integration_resync_jobs'))[0]!.reason).toBe('daily');
      // Leased: an overlapping run gets nothing.
      expect(await next()).toBeNull();
      await expectDbError(db, () => page({ ...job, lockToken: '00000000-0000-4000-8000-000000000000' }, [], 2, false), { code: '55P03' });

      const bitrix: Record<string, Snapshot> = { '9601': snapshot(9601, '101'), '9602': snapshot(9602, '102') };
      const m = Math.floor(Date.parse(bitrix['9601']!.dateModify) / 1000);
      expect(await page(job, [{ id: 9601, modified: m }], 2, false)).toMatchObject({ enqueued: 1, scanned: 1, cursorId: 9601 });
      // Cursor: an ID at or below it is refused (never re-listed out of order).
      await expectDbError(db, () => page(job, [{ id: 9601, modified: m }], null, false), { code: '22023' });
      await page(job, [{ id: 9602, modified: m }], null, true);
      // Inbox not drained yet: not finished, lease released.
      expect(await finish(job)).toEqual({ done: false, waiting: 2 });
      await drain(bitrix);
      const again = (await next())!;
      expect(again).toMatchObject({ jobId: job.jobId, cursorId: 9602, listingDone: true });
      const done = await finish(again);
      expect(done.done).toBe(true);
      expect(done.result).toMatchObject({ bitrix: 2, bitrixTotal: 2, missing: 0 });
      const crm = Number((await db.query<{ n: string }>(`select count(*)::text as n from public.deals where source_system = 'bitrix' and removed_at is null`))[0]!.n);
      expect(done.result!.crm).toBe(crm);
      // Stored deals Bitrix did not list are re-read (fixtures' imported deals, if any).
      expect(done.result!.extra).toBe(crm - 2 - (done.result!.keptAfterStageMove as number));
      // No new daily job within 24 hours; the admin reads progress, staff do not.
      expect(await next()).toBeNull();
      expect(await run(ADMIN, 'select status from public.integration_resync_jobs')).toEqual([{ status: 'done' }]);
      expect(await run({ userId: U.salesDelhiA }, 'select status from public.integration_resync_jobs')).toEqual([]);
      // Service-role only commands.
      await expectDbError(db, () => run(ADMIN, `select public.integration_resync_next($1, 60)`, [MEMBER]), { code: '42501' });
    });
  });
});

describe('pagination totals with more than 200 deals', () => {
  it('pages of 50 (Bitrix deal ID desc, id) cover every visible deal exactly once and match count(*)', async () => {
    await asOwner(db, async () => {
      for (let i = 0; i < 230; i += 1) await importDeal(snapshot(9700 + i, i % 2 ? '101' : '102'));
      // The Delhi manager reads the whole pilot branch through a grant.
      const total = await countAs(MANAGER);
      expect(total).toBeGreaterThan(230);
      const seen = new Set<string>();
      for (let offset = 0; offset < total; offset += 50) {
        const rows = await run<{ id: string }>(
          MANAGER,
          'select id from public.deals order by source_deal_id desc nulls last, id limit 50 offset $1',
          [offset],
        );
        for (const r of rows) seen.add(r.id);
      }
      expect(seen.size).toBe(total);
      // The salesperson's count is their own (owned or assigned) deals only.
      const mine = (await run<{ id: string }>({ userId: U.salesDelhiA }, 'select id from public.deals')).map((r) => r.id);
      expect(mine.length).toBe(await countAs({ userId: U.salesDelhiA }));
      const own = await db.query<{ n: string }>(
        `select count(*)::text as n from public.deals d where d.id = any($1::uuid[])
           and (d.owner_user_id = $2 or exists (select 1 from public.deal_assignments a
                where a.deal_id = d.id and a.user_id = $2 and a.ended_at is null))`,
        [mine, U.salesDelhiA],
      );
      expect(Number(own[0]!.n)).toBe(mine.length);
      expect(mine.length).toBeGreaterThanOrEqual(115);
    });
  });
});

describe('no silent stall (20261008000500 prompt): leases and jobs recover by themselves', () => {
  it('an expired inbox lease is released: the next run claims the row again and processes it', async () => {
    await asOwner(db, async () => {
      const rec = first(
        await run<{ r: { inboxId: string } }>(SVC, 'select public.integration_record_bitrix_event($1,$2,$3,$4) as r', [
          MEMBER,
          'ONCRMDEALUPDATE',
          9801,
          (ts += 1),
        ]),
      );
      const firstClaim = (await run<{ r: ClaimedInboxItem }>(SVC, 'select r from public.integration_claim_inbox(100, 60) as r'))
        .map((c) => c.r)
        .find((c) => c.inboxId === rec.inboxId)!;
      // The run that held it died: its lease runs out.
      await db.exec(`update public.integration_inbox set locked_until = now() - interval '1 second' where id = '${rec.inboxId}'`);
      // Its late write is refused (lease not held) ...
      await expectDbError(
        db,
        () => run(SVC, 'select public.integration_apply_bitrix_deal($1,$2,$3::jsonb)', [firstClaim.inboxId, firstClaim.lockToken, JSON.stringify(snapshot(9801, '101'))]),
        { code: '55P03' },
      );
      // ... and the next run takes the row over and stores the deal.
      expect(await applyTo(rec.inboxId, snapshot(9801, '101'))).toMatchObject({ outcome: 'created' });
      expect((await db.query<{ status: string; attempts: number }>('select status, attempts from public.integration_inbox where id = $1', [rec.inboxId]))[0]).toEqual({
        status: 'processed',
        attempts: 2,
      });
    });
  });

  it('a resync job whose run died is taken over after its lease; saving new settings supersedes it and restarts at cursor 0', async () => {
    await asOwner(db, async () => {
      type Job = { jobId: string; lockToken: string; cursorId: number };
      const next = () => run<{ r: Job | null }>(SVC, `select public.integration_resync_next($1, 60) as r`, [MEMBER]).then(first);
      const job = (await next())!;
      await run(SVC, 'select public.integration_resync_page($1, $2, $3::jsonb, $4, false)', [
        job.jobId,
        job.lockToken,
        JSON.stringify([{ id: 9811, modified: 1_790_000_000 }]),
        5,
      ]);
      expect(await next()).toBeNull(); // still leased
      await db.exec(`update public.integration_resync_jobs set locked_until = now() - interval '1 second' where id = '${job.jobId}'`);
      expect(await next()).toMatchObject({ jobId: job.jobId, cursorId: 9811 }); // continues from its cursor
      await settings(ADMIN, [7], STAGES, '2026-09-10T00:00:00+05:30');
      const fresh = (await next()) ?? null;
      // The superseded job is closed; the new one (new filter) starts from the beginning.
      const rows = await db.query<{ id: string; status: string; cursor_id: string }>(
        'select id, status, cursor_id::text from public.integration_resync_jobs order by created_at',
      );
      expect(rows.find((r) => r.id === job.jobId)!.status).toBe('superseded');
      // Both jobs can share one created_at inside the test transaction, so pick the new job by id.
      const others = rows.filter((r) => r.id !== job.jobId);
      expect(others).toHaveLength(1);
      expect(others[0]).toMatchObject({ status: fresh ? 'running' : 'queued', cursor_id: '0' });
    });
  });
});

describe('removal rules never touch synthetic deals (CI T15 regression)', () => {
  it('an assigned synthetic deal (no Bitrix ID) stays readable, with its assignment, after the sync date and pipelines change', async () => {
    await asOwner(db, async () => {
      await db.query(
        `insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind)
         select d.id, d.legal_entity_id, $2, 'visa' from public.deals d where d.id = $1
         on conflict do nothing`,
        [D.del002, U.salesDelhiB],
      );
      await settings(ADMIN, [9], ['C9:NEW'], '2026-10-01T00:00:00+05:30'); // later date AND another pipeline
      const [row] = await db.query<{ removed_at: string | null; source_deal_id: string | null }>(
        'select removed_at, source_deal_id from public.deals where id = $1',
        [D.del002],
      );
      expect(row).toEqual({ removed_at: null, source_deal_id: null });
      const asB = { userId: U.salesDelhiB };
      expect(await run(asB, 'select reference from public.deals where id = $1', [D.del002])).toEqual([{ reference: 'SYN-DEL-002' }]);
      expect(await run(asB, 'select user_id from public.deal_assignments where deal_id = $1 and ended_at is null', [D.del002])).toEqual(
        expect.arrayContaining([{ user_id: U.salesDelhiB }]),
      );
    });
  });
});
