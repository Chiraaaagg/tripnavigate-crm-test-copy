import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApplyResult, BitrixDealSnapshot, ClaimedInboxItem } from '@/modules/integration/contracts';
import {
  type Actor,
  FIXTURE_USERS as U,
  type TestDb,
  asOwner,
  createTestDb,
  expectDbError,
  resetActor,
  setActor,
} from '../helpers/db';

/**
 * Stage 0, audit finding I01 (migration 20261107000100_integration_sync_transition):
 * one Sales-owner rule for every Deal owner entry point. An eligible owner is active
 * staff with an ACTIVE SALES membership in the Deal's legal entity and branch (the
 * rule Lead intake already applies). Intake holds a Deal whose Bitrix responsible
 * maps to anyone else (needs_review, visible to the admin); link/unlink, membership
 * changes and authz.set_deal_owner never make a non-Sales person the owner, and a
 * stored Deal without an eligible owner waits visibly for the admin
 * (public.integration_waiting_for_owner, counts only). No owner is ever guessed.
 *
 * Synthetic fixtures: portal SYNTHETIC_MEMBER_0001, pilot branch Delhi; Bitrix 101 ->
 * Sales Delhi A, 102 -> Sales Delhi B. The Delhi manager holds a manager (not Sales)
 * membership in the pilot branch.
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
const SALES_A: Actor = { userId: U.salesDelhiA };
const MEMBER = 'SYNTHETIC_MEMBER_0001';
const first = <T>(rows: Array<{ r: T }>): T => rows[0]!.r;
let ts = 1_798_000_000;

async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  await setActor(db, actor);
  const rows = await db.query<T>(sql, params);
  await resetActor(db);
  return rows;
}

function snapshot(id: number, assignedById: string): BitrixDealSnapshot & { sourceId: string } {
  return {
    id: String(id),
    sourceId: 'SYNTHETIC_SRC',
    title: `Synthetic owner-gate deal ${id}`,
    stageId: 'C7:NEW',
    categoryId: '7',
    assignedById,
    dateCreate: '2026-09-15T10:00:00+05:30',
    dateModify: '2026-09-15T10:00:00+05:30',
  };
}

async function importDeal(deal: BitrixDealSnapshot): Promise<ApplyResult> {
  const rec = first(
    await run<{ r: { inboxId: string } }>(SVC, 'select public.integration_record_bitrix_event($1,$2,$3,$4) as r', [
      MEMBER, 'ONCRMDEALUPDATE', Number(deal.id), (ts += 1),
    ]),
  );
  const claimed = await run<{ r: ClaimedInboxItem }>(SVC, 'select r from public.integration_claim_inbox(100, 60) as r');
  const item = claimed.map((c) => c.r).find((c) => c.inboxId === rec.inboxId)!;
  return first(
    await run<{ r: ApplyResult }>(SVC, 'select public.integration_apply_bitrix_deal($1,$2,$3::jsonb) as r', [
      item.inboxId, item.lockToken, JSON.stringify(deal),
    ]),
  );
}

const mapBitrix = (bitrixUserId: number, staff: string) =>
  db.query(`insert into public.bitrix_user_mappings (portal_member_id, bitrix_user_id, staff_user_id, active) values ($1, $2, $3, true)`, [
    MEMBER, bitrixUserId, staff,
  ]);
const dealRow = async (ref: string) =>
  (await db.query<{ id: string; owner_user_id: string | null }>('select id, owner_user_id from public.deals where reference = $1', [ref]))[0];
const activeSales = async (ref: string) =>
  (
    await db.query<{ user_id: string }>(
      `select a.user_id from public.deal_assignments a join public.deals d on d.id = a.deal_id
       where d.reference = $1 and a.assignment_kind = 'sales' and a.ended_at is null`,
      [ref],
    )
  ).map((r) => r.user_id);
const waiting = (actor: Actor = ADMIN) =>
  run<{ r: { total: number; byBitrixUser: Array<{ bitrixUserId: number; deals: number }> } }>(
    actor,
    'select public.integration_waiting_for_owner() as r',
  ).then(first);

describe('intake: only a Sales member of the pilot branch owns a Deal', () => {
  it('a responsible mapped to a non-Sales member of the pilot branch is held for review; nothing is stored', async () => {
    await asOwner(db, async () => {
      await mapBitrix(150, U.managerDelhi); // active manager membership in Delhi, no Sales role
      expect(await importDeal(snapshot(8601, '150'))).toMatchObject({ outcome: 'needs_review', reasonCode: 'owner_not_in_pilot_branch' });
      expect(await dealRow('BX-8601')).toBeUndefined();
      // The admin sees the hold in the intake attention list.
      const held = await run<{ reason_code: string }>(
        ADMIN,
        `select reason_code from public.integration_inbox where source_deal_id = 8601 and status = 'needs_review'`,
      );
      expect(held).toEqual([{ reason_code: 'owner_not_in_pilot_branch' }]);
      // A Sales member of the pilot branch is accepted (control).
      expect(await importDeal(snapshot(8602, '101'))).toMatchObject({ outcome: 'created' });
      expect((await dealRow('BX-8602'))!.owner_user_id).toBe(U.salesDelhiA);
    });
  });

  it('a stored Deal whose responsible moves to a non-Sales member is held; the owner is not replaced by a guess', async () => {
    await asOwner(db, async () => {
      await mapBitrix(150, U.managerDelhi);
      expect(await importDeal(snapshot(8611, '101'))).toMatchObject({ outcome: 'created' });
      const moved = { ...snapshot(8611, '150'), dateModify: '2026-09-15T12:00:00+05:30' };
      expect(await importDeal(moved)).toMatchObject({ outcome: 'needs_review', reasonCode: 'owner_not_in_pilot_branch' });
      expect((await dealRow('BX-8611'))!.owner_user_id).toBe(U.salesDelhiA);
    });
  });
});

describe('ownership recompute: link, unlink and membership changes follow the same rule', () => {
  it('linking a non-Sales member leaves the Deal waiting for an owner, visible to the admin as counts', async () => {
    await asOwner(db, async () => {
      expect(await importDeal(snapshot(8621, '102'))).toMatchObject({ outcome: 'created' });
      expect((await dealRow('BX-8621'))!.owner_user_id).toBe(U.salesDelhiB);
      await run(ADMIN, 'select public.integration_unlink_bitrix_user($1) as r', [U.salesDelhiB]);
      expect((await dealRow('BX-8621'))!.owner_user_id).toBeNull();
      expect(await activeSales('BX-8621')).toEqual([]);
      // The Delhi manager is linked to Bitrix 102: not a Sales member, so not the owner.
      await run(ADMIN, 'select public.integration_link_bitrix_user($1, $2) as r', [U.managerDelhi, 102]);
      expect((await dealRow('BX-8621'))!.owner_user_id).toBeNull();
      expect(await activeSales('BX-8621')).toEqual([]);
      expect(await waiting()).toEqual({ total: 1, byBitrixUser: [{ bitrixUserId: 102, deals: 1 }] });
      // Only the integration admin may read the summary.
      await expectDbError(db, () => run(SALES_A, 'select public.integration_waiting_for_owner() as r'), { code: '42501' });
      await expectDbError(db, () => run({ userId: null }, 'select public.integration_waiting_for_owner() as r'), { code: '42501' });
    });
  });

  it('losing the only Sales membership releases the Deal even while another membership in the branch stays active', async () => {
    await asOwner(db, async () => {
      expect(await importDeal(snapshot(8631, '101'))).toMatchObject({ outcome: 'created' });
      await db.query(
        `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
         select $1, b.legal_entity_id, b.id, 'manager', 'active' from public.branches b where b.code = 'DEL'`,
        [U.salesDelhiA],
      );
      await db.query(`update public.memberships set status = 'inactive' where user_id = $1 and role_code = 'sales'`, [U.salesDelhiA]);
      expect((await dealRow('BX-8631'))!.owner_user_id).toBeNull();
      expect(await activeSales('BX-8631')).toEqual([]);
      // Reactivating the Sales membership gives the Deal back to its mapped owner.
      await db.query(`update public.memberships set status = 'active' where user_id = $1 and role_code = 'sales'`, [U.salesDelhiA]);
      expect((await dealRow('BX-8631'))!.owner_user_id).toBe(U.salesDelhiA);
      expect(await activeSales('BX-8631')).toEqual([U.salesDelhiA]);
    });
  });

  it('authz.set_deal_owner never makes a non-Sales person the owner', async () => {
    await asOwner(db, async () => {
      expect(await importDeal(snapshot(8641, '101'))).toMatchObject({ outcome: 'created' });
      const deal = (await dealRow('BX-8641'))!;
      await db.query('select authz.set_deal_owner($1, $2)', [deal.id, U.managerDelhi]);
      expect((await dealRow('BX-8641'))!.owner_user_id).toBeNull();
      expect(await activeSales('BX-8641')).toEqual([]);
      // A Sales member of the Deal's branch is accepted (control); Sales in another branch is not.
      await db.query('select authz.set_deal_owner($1, $2)', [deal.id, U.salesAhmedabad]);
      expect((await dealRow('BX-8641'))!.owner_user_id).toBeNull();
      await db.query('select authz.set_deal_owner($1, $2)', [deal.id, U.salesDelhiB]);
      expect((await dealRow('BX-8641'))!.owner_user_id).toBe(U.salesDelhiB);
      expect(await activeSales('BX-8641')).toEqual([U.salesDelhiB]);
    });
  });

  it('removed Deals are not counted as waiting for an owner', async () => {
    await asOwner(db, async () => {
      expect(await importDeal(snapshot(8651, '102'))).toMatchObject({ outcome: 'created' });
      await run(ADMIN, 'select public.integration_unlink_bitrix_user($1) as r', [U.salesDelhiB]);
      expect((await waiting()).total).toBe(1);
      const deal = (await dealRow('BX-8651'))!;
      await db.query(`select authz.remove_bitrix_deals(array[$1]::uuid[], 'stage_not_eligible')`, [deal.id]);
      expect(await waiting()).toEqual({ total: 0, byBitrixUser: [] });
    });
  });
});
