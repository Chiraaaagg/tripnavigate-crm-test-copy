import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, financeHelpers } from './finance-support';

/**
 * Stage 7 (owner decision, 9 October 2026), migration
 * 20261115000100_lost_deal_booking_block: bookings start only on active Deals.
 *
 *   - booking_open_draft refuses to open a NEW draft with 'deal_not_active'
 *     (SQLSTATE 55000) while the Deal's Bitrix stage (deals.source_stage_id) is
 *     listed in authz.lost_deal_stages (LOSE, UC_U11OBT, C1:LOSE, C1:APOLOGY);
 *   - an existing draft is still returned and stays editable; a confirmed
 *     booking still answers already_confirmed;
 *   - moving the Deal back to an active stage allows opening again;
 *   - synthetic Deals (no Bitrix stage) are unaffected;
 *   - callers who may not edit the Deal's booking keep not_authorized;
 *   - booking_panel reports dealNotActive for the Deal page.
 *
 * Each scenario runs on the synthetic fixture deal SYN-DEL-001 (owner Sales
 * Delhi A), marked imported from Bitrix inside the rolled-back transaction (the
 * provenance checks are dropped for the test only, as in stage0-removed-deals).
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = financeHelpers(() => db);
const { one, refused, owner } = h;

const SALES_A: Actor = { userId: U.salesDelhiA }; // owner of SYN-DEL-001
const MANAGER: Actor = { userId: U.managerDelhi };
const PURCHASE: Actor = { userId: U.purchaseJodhpur }; // same entity, may not edit bookings
const OTHER_ENTITY: Actor = { userId: U.salesEntityB };
const ANON: Actor = { userId: null };

const OPEN = 'select public.booking_open_draft($1) as r';
const PANEL = 'select public.booking_panel($1) as r';
const SAVE = 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, true) as r';
const FACTS = {
  hotelName: 'Synthetic Hotel (fixture)', city: 'Synthetic City', checkIn: '2026-12-10', checkOut: '2026-12-13',
  rooms: 2, roomType: 'Synthetic Deluxe', mealPlan: 'Breakfast', adults: 3, children: 1,
  inclusions: 'Synthetic pickup', specialRequests: null, purchaseBudgetPaise: '4500000',
};

const LOST_STAGES = ['LOSE', 'UC_U11OBT', 'C1:LOSE', 'C1:APOLOGY'];
const ACTIVE_STAGE = 'PREPARATION';

type Opened = { versionId: string; versionNo: number; rowVersion: number; created: boolean };

/** SYN-DEL-001 becomes an imported Bitrix Deal in the given stage. */
async function markImported(stage: string): Promise<void> {
  await db.exec('alter table public.deals drop constraint deals_provenance');
  await db.exec('alter table public.deals drop constraint deals_source_assigned_by_provenance');
  await db.exec('alter table public.deal_commercials drop constraint deal_commercials_synthetic_parent');
  await owner(
    `update public.deals set is_synthetic = false, source_system = 'bitrix', source_portal = 'SYNTHETIC_MEMBER_0001',
       source_deal_id = 990001, source_assigned_by_id = 101, source_stage_id = $2 where id = $1`,
    [DEAL, stage],
  );
}
/** What the Bitrix sync does when the Deal changes stage in Bitrix. */
async function moveTo(stage: string): Promise<void> {
  await owner('update public.deals set source_stage_id = $2 where id = $1', [DEAL, stage]);
}
async function versionCount(): Promise<number> {
  const [n] = await owner<{ n: number }>('select count(*)::int as n from public.booking_versions where deal_id = $1', [DEAL]);
  return n!.n;
}

describe('the lost/rejected stage list', () => {
  it('is seeded with the four lost or rejected stages and is not readable by signed-in staff', async () => {
    await asOwner(db, async () => {
      const rows = await owner<{ stage_id: string }>('select stage_id from authz.lost_deal_stages order by stage_id');
      expect(rows.map((r) => r.stage_id).sort()).toEqual([...LOST_STAGES].sort());
      const [privs] = await owner<{ auth: boolean; anon: boolean; svc: boolean; fn: boolean }>(
        `select has_table_privilege('authenticated', 'authz.lost_deal_stages', 'select') as auth,
                has_table_privilege('anon', 'authz.lost_deal_stages', 'select') as anon,
                has_table_privilege('service_role', 'authz.lost_deal_stages', 'select,insert,update,delete') as svc,
                has_function_privilege('authenticated', 'authz.deal_not_active(uuid)', 'execute') as fn`,
      );
      expect(privs).toEqual({ auth: false, anon: false, svc: false, fn: false });
    });
  });
});

describe('booking_open_draft refuses a new draft on a lost or rejected Deal', () => {
  it('refuses on each lost stage with deal_not_active and writes nothing', async () => {
    await asOwner(db, async () => {
      await markImported(LOST_STAGES[0]!);
      for (const stage of LOST_STAGES) {
        await moveTo(stage);
        await refused(SALES_A, OPEN, [DEAL], '55000', 'deal_not_active');
        await refused(MANAGER, OPEN, [DEAL], '55000', 'deal_not_active');
      }
      expect(await versionCount()).toBe(0);
    });
  });

  it('callers who may not edit the booking keep not_authorized (nothing about the stage is revealed)', async () => {
    await asOwner(db, async () => {
      await markImported('LOSE');
      await refused(OTHER_ENTITY, OPEN, [DEAL], '42501', 'not_authorized');
      await refused(PURCHASE, OPEN, [DEAL], '42501', 'not_authorized');
      await refused(ANON, OPEN, [DEAL], '42501');
      expect(await versionCount()).toBe(0);
    });
  });

  it('allows opening on an active stage, and again after the Deal moves back from a lost stage', async () => {
    await asOwner(db, async () => {
      await markImported(ACTIVE_STAGE);
      expect((await one<{ dealNotActive: boolean }>(SALES_A, PANEL, [DEAL])).dealNotActive).toBe(false);
      await moveTo('C1:APOLOGY');
      await refused(SALES_A, OPEN, [DEAL], '55000', 'deal_not_active');
      expect((await one<{ dealNotActive: boolean }>(SALES_A, PANEL, [DEAL])).dealNotActive).toBe(true);
      await moveTo(ACTIVE_STAGE);
      expect((await one<{ dealNotActive: boolean }>(SALES_A, PANEL, [DEAL])).dealNotActive).toBe(false);
      const opened = await one<Opened>(SALES_A, OPEN, [DEAL]);
      expect(opened).toMatchObject({ versionNo: 1, created: true });
      expect(await versionCount()).toBe(1);
    });
  });

  it('an existing draft is still returned and stays editable after the Deal is marked lost', async () => {
    await asOwner(db, async () => {
      await markImported(ACTIVE_STAGE);
      const opened = await one<Opened>(SALES_A, OPEN, [DEAL]);
      await moveTo('LOSE');
      const again = await one<Opened>(SALES_A, OPEN, [DEAL]);
      expect(again).toEqual({ ...opened, created: false });
      const saved = await one<{ rowVersion: number }>(SALES_A, SAVE, [opened.versionId, opened.rowVersion, JSON.stringify(FACTS), '9876543']);
      expect(saved.rowVersion).toBeGreaterThan(opened.rowVersion);
      const panel = await one<{ dealNotActive: boolean; canEdit: boolean; version: { versionId: string; status: string } }>(
        SALES_A,
        PANEL,
        [DEAL],
      );
      expect(panel).toMatchObject({ dealNotActive: true, canEdit: true, version: { versionId: opened.versionId, status: 'draft' } });
      expect(await versionCount()).toBe(1);
    });
  });

  it('precedence: a removed Deal answers deal_removed, an unset environment answers environment_unset', async () => {
    await asOwner(db, async () => {
      await markImported('LOSE');
      await h.setEnvironment('unset');
      await refused(SALES_A, OPEN, [DEAL], '55000', 'environment_unset');
      await h.setEnvironment('test');
      await refused(SALES_A, OPEN, [DEAL], '55000', 'deal_not_active');
      await owner('select authz.remove_bitrix_deals(array[$1]::uuid[], $2)', [DEAL, 'pipeline_not_eligible']);
      await refused(SALES_A, OPEN, [DEAL], '55000', 'deal_removed');
      await refused(MANAGER, OPEN, [DEAL], '55000', 'deal_removed');
      expect(await versionCount()).toBe(0);
    });
  });

  it('a confirmed booking still answers already_confirmed', async () => {
    await asOwner(db, async () => {
      await h.confirmedBooking(DEAL, SALES_A);
      await markImported('UC_U11OBT');
      await refused(SALES_A, OPEN, [DEAL], '55000', 'already_confirmed');
    });
  });

  it('follows the stage list: a stage added to the list refuses, removing it allows again', async () => {
    await asOwner(db, async () => {
      await markImported('C1:EXECUTING');
      await owner(`insert into authz.lost_deal_stages (stage_id, label) values ('C1:EXECUTING', 'Synthetic test stage')`);
      await refused(SALES_A, OPEN, [DEAL], '55000', 'deal_not_active');
      await owner(`delete from authz.lost_deal_stages where stage_id = 'C1:EXECUTING'`);
      expect((await one<Opened>(SALES_A, OPEN, [DEAL])).created).toBe(true);
    });
  });
});

describe('synthetic Deals are unaffected', () => {
  it('opens a draft on a synthetic Deal (no Bitrix stage), even if a lost stage ID were present', async () => {
    await asOwner(db, async () => {
      expect((await one<{ dealNotActive: boolean }>(SALES_A, PANEL, [DEAL])).dealNotActive).toBe(false);
      // Not a Bitrix Deal: a stage value alone never blocks (source_system stays null).
      await db.exec('alter table public.deals drop constraint deals_provenance');
      await owner(`update public.deals set source_stage_id = 'LOSE' where id = $1`, [DEAL]);
      expect((await one<Opened>(SALES_A, OPEN, [DEAL])).created).toBe(true);
    });
  });
});
