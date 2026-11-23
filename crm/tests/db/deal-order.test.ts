import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApplyResult, BitrixDealSnapshot, ClaimedInboxItem } from '@/modules/integration/contracts';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, resetActor, setActor, useDealManifest } from '../helpers/db';

/**
 * Deals ordered by Bitrix deal ID (migration 20261009000800, renumbered from
 * 20261008000400, + the list query in src/modules/deals/server/queries.ts,
 * mirrored here in SQL): numeric order, stable across re-syncs, same for every
 * reader, exact pages, and the worker claims tied inbox rows in deal-ID order.
 * Deals enter through an approved manifest (main's intake guards, PR #13 review
 * fix 1); Super Admin reads no deal, so the Delhi manager (branch grant) reads.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const SVC: Actor = { userId: null, role: 'service_role' };
/** Branch-wide reader of the pilot branch (Delhi grant). */
const MANAGER: Actor = { userId: U.managerDelhi };
const SALES: Actor = { userId: U.salesDelhiA };
const MEMBER = 'SYNTHETIC_MEMBER_0001';
const first = <T>(rows: Array<{ r: T }>): T => rows[0]!.r;
let ts = 1_798_000_000;

/** The Deals list order (DealSort). */
const ORDER = {
  id_desc: 'order by source_deal_id desc nulls last, id',
  id_asc: 'order by source_deal_id asc nulls last, id',
} as const;

async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  await setActor(db, actor);
  const rows = await db.query<T>(sql, params);
  await resetActor(db);
  return rows;
}

type Snapshot = BitrixDealSnapshot & { sourceId?: string };

function snapshot(id: number, over: Partial<Snapshot> = {}): Snapshot {
  return {
    id: String(id),
    // The approved manifest's verified Bitrix source code.
    sourceId: 'SYNTHETIC_SRC',
    title: `Synthetic order deal ${id}`,
    stageId: 'C7:NEW',
    categoryId: '7',
    assignedById: '101',
    dateCreate: '2026-09-15T10:00:00+05:30',
    dateModify: '2026-09-15T10:00:00+05:30',
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
  const claimed = await run<{ r: ClaimedInboxItem }>(SVC, 'select r from public.integration_claim_inbox(100, 60) as r');
  const item = claimed.map((c) => c.r).find((c) => c.inboxId === rec.inboxId)!;
  return first(
    await run<{ r: ApplyResult }>(SVC, 'select public.integration_apply_bitrix_deal($1,$2,$3::jsonb) as r', [
      item.inboxId,
      item.lockToken,
      JSON.stringify(deal),
    ]),
  );
}

const IDS = [100, 9, 1000, 10, 999]; // imported out of order on purpose
const listed = async (actor: Actor, sort: keyof typeof ORDER) =>
  (
    await run<{ id: string }>(actor, `select source_deal_id::text as id from public.deals where source_deal_id = any($1) ${ORDER[sort]}`, [
      IDS,
    ])
  ).map((r) => Number(r.id));

describe('deals ordered by Bitrix deal ID', () => {
  it('numeric order (9, 10, 100, 999, 1000), toggle asc/desc, same for the branch reader and Sales', async () => {
    await asOwner(db, async () => {
      await useDealManifest(db, IDS);
      for (const id of IDS) expect(await importDeal(snapshot(id))).toMatchObject({ outcome: 'created' });
      expect(await listed(MANAGER, 'id_desc')).toEqual([1000, 999, 100, 10, 9]);
      expect(await listed(MANAGER, 'id_asc')).toEqual([9, 10, 100, 999, 1000]);
      expect(await listed(SALES, 'id_desc')).toEqual([1000, 999, 100, 10, 9]);
    });
  });

  it('a re-sync (newer last_synced_at, new stage) never moves a deal', async () => {
    await asOwner(db, async () => {
      await useDealManifest(db, IDS);
      for (const id of IDS) await importDeal(snapshot(id));
      expect(await importDeal(snapshot(9, { stageId: 'C7:WON', dateModify: '2026-09-20T10:00:00+05:30' }))).toMatchObject({
        outcome: 'updated',
      });
      // Push its sync time ahead of every other deal (one transaction shares now()).
      await db.exec(`update public.deals set last_synced_at = now() + interval '1 hour' where source_deal_id = 9`);
      const [newest] = await db.query<{ id: string; stage: string }>(
        `select source_deal_id::text as id, source_stage_id as stage from public.deals
         where source_deal_id = any($1) order by last_synced_at desc limit 1`,
        [IDS],
      );
      expect(newest).toEqual({ id: '9', stage: 'C7:WON' }); // updated and synced last ...
      expect(await listed(MANAGER, 'id_desc')).toEqual([1000, 999, 100, 10, 9]); // ... and still in its place
    });
  });

  it('pages of 50 in both orders: no duplicates, no gaps, total unchanged; synthetic deals last', async () => {
    await asOwner(db, async () => {
      for (let i = 0; i < 120; i += 1) {
        expect(await importDeal(snapshot(5000 + i, { assignedById: i % 2 ? '101' : '102' }))).toMatchObject({ outcome: 'created' });
      }
      const total = Number((await run<{ n: string }>(MANAGER, 'select count(*)::text as n from public.deals'))[0]!.n);
      // Not vacuous: the branch reader sees the 120 imported deals plus the Delhi fixtures.
      expect(total).toBeGreaterThan(120);
      for (const sort of ['id_desc', 'id_asc'] as const) {
        const all: Array<{ id: string; bx: string | null }> = [];
        for (let offset = 0; offset < total; offset += 50) {
          all.push(
            ...(await run<{ id: string; bx: string | null }>(
              MANAGER,
              `select id, source_deal_id::text as bx from public.deals ${ORDER[sort]} limit 50 offset $1`,
              [offset],
            )),
          );
        }
        expect(all).toHaveLength(total);
        expect(new Set(all.map((r) => r.id)).size).toBe(total);
        const bx = all.map((r) => r.bx).filter((v): v is string => v !== null).map(Number);
        expect(bx).toEqual([...bx].sort((a, b) => (sort === 'id_desc' ? b - a : a - b)));
        // Deals without a Bitrix ID (synthetic test records) come after every imported deal.
        const firstNull = all.findIndex((r) => r.bx === null);
        expect(firstNull === -1 || all.slice(firstNull).every((r) => r.bx === null)).toBe(true);
      }
    });
  });

  it('the worker claims rows queued together in deal-ID order', async () => {
    await asOwner(db, async () => {
      await db.exec(`update public.integration_inbox set status = 'ignored', next_attempt_at = null, lock_token = null, locked_until = null
                     where status in ('pending', 'failed', 'processing')`);
      // Same transaction: identical received_at / next_attempt_at.
      for (const id of [7003, 7001, 7002]) {
        await run(SVC, 'select public.integration_record_bitrix_event($1,$2,$3,$4)', [MEMBER, 'ONCRMDEALUPDATE', id, (ts += 1)]);
      }
      const order: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const [row] = await run<{ r: ClaimedInboxItem }>(SVC, 'select r from public.integration_claim_inbox(1, 60) as r');
        order.push(row!.r.sourceDealId);
      }
      expect(order).toEqual(['7001', '7002', '7003']);
    });
  });
});
