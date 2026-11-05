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
 * Admin-granted ownership of imported Bitrix deals (migration 20261009000200,
 * renumbered from 20261007000100) under main's intake guards (20261009001000,
 * PR #13 review fix 1): an unmapped Bitrix owner is held for review (never stored
 * ownerless by intake), link and unlink / deactivate, Bitrix reassignment, unique
 * mapping, RLS isolation between salespeople, settings command. Super Admin reads
 * no deal (access matrix). Deals enter through the fixture's approved manifest
 * (2026-09-15 IST, ids 5000-9999, source SYNTHETIC_SRC). Synthetic fixtures only
 * (portal SYNTHETIC_MEMBER_0001, pilot branch Delhi, category 7).
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
const MEMBER = 'SYNTHETIC_MEMBER_0001';
/** The `r` column of the first row (commands return one jsonb value). */
const first = <T>(rows: Array<{ r: T }>): T => rows[0]!.r;
let ts = 1_795_000_000;

async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  await setActor(db, actor);
  const rows = await db.query<T>(sql, params);
  await resetActor(db);
  return rows;
}

type Snapshot = BitrixDealSnapshot & { sourceId?: string };

function snapshot(id: number, assignedById: string, over: Partial<Snapshot> = {}): Snapshot {
  return {
    id: String(id),
    // The fixture manifest's verified Bitrix source code.
    sourceId: 'SYNTHETIC_SRC',
    title: `Synthetic access deal ${id}`,
    stageId: 'C7:NEW',
    categoryId: '7',
    assignedById,
    dateCreate: '2026-09-15T10:00:00+05:30',
    dateModify: '2026-09-15T10:00:00+05:30',
    ...over,
  };
}

async function importDeal(deal: Snapshot): Promise<ApplyResult> {
  const rec = first(await run<{ r: { inboxId: string } }>(SVC, 'select public.integration_record_bitrix_event($1,$2,$3,$4) as r', [
    MEMBER,
    'ONCRMDEALUPDATE',
    Number(deal.id),
    (ts += 1),
  ]));
  const claimed = await run<{ r: ClaimedInboxItem }>(SVC, 'select r from public.integration_claim_inbox(100, 60) as r');
  const item = claimed.map((c) => c.r).find((c) => c.inboxId === rec.inboxId)!;
  const r = first(await run<{ r: ApplyResult }>(SVC, 'select public.integration_apply_bitrix_deal($1,$2,$3::jsonb) as r', [
    item.inboxId,
    item.lockToken,
    JSON.stringify(deal),
  ]));
  return r;
}

/** Exists in the database (service view): removal or unlinking never deletes a deal. */
const stored = async (ref: string) => (await db.query('select 1 from public.deals where reference = $1', [ref])).length === 1;
const refs = async (actor: Actor) =>
  (await run<{ reference: string }>(actor, `select reference from public.deals where reference like 'BX-%' order by reference`)).map(
    (r) => r.reference,
  );
const owner = async (ref: string) =>
  (await db.query<{ owner_user_id: string | null }>('select owner_user_id from public.deals where reference = $1', [ref]))[0]!
    .owner_user_id;
const activeSales = async (ref: string) =>
  (
    await db.query<{ user_id: string }>(
      `select a.user_id from public.deal_assignments a join public.deals d on d.id = a.deal_id
       where d.reference = $1 and a.assignment_kind = 'sales' and a.ended_at is null`,
      [ref],
    )
  ).map((r) => r.user_id);
const link = (actor: Actor, staff: string, bitrix: number) =>
  run<{ r: { dealsChanged: number } }>(actor, 'select public.integration_link_bitrix_user($1, $2) as r', [staff, bitrix]);
const unlink = (actor: Actor, staff: string) =>
  run<{ r: { bitrixUserId: number | null; dealsChanged: number } }>(actor, 'select public.integration_unlink_bitrix_user($1) as r', [
    staff,
  ]);

describe('unmapped Bitrix owner', () => {
  it('is held for review and nothing is stored; owned deals stay visible to their readers only', async () => {
    await asOwner(db, async () => {
      expect(await importDeal(snapshot(8101, '777'))).toMatchObject({ outcome: 'needs_review', reasonCode: 'unmapped_owner' });
      expect(await stored('BX-8101')).toBe(false);
      await importDeal(snapshot(8102, '101')); // owned by Sales Delhi A
      expect(await refs(ADMIN)).toEqual([]); // Super Admin reads no deal (access matrix)
      expect(await refs({ userId: U.managerDelhi })).toEqual(['BX-8102']); // Delhi grant
      expect(await refs({ userId: U.salesDelhiA })).toEqual(['BX-8102']);
      expect(await refs({ userId: U.salesDelhiB })).toEqual([]);
      expect(await refs({ userId: U.purchaseJodhpur })).toEqual([]);
      expect(await refs({ userId: U.adminJodhpur, aal: 'aal1' })).toEqual([]);
    });
  });
});

describe('grant: link Bitrix user -> backfill', () => {
  it('links the Bitrix user, audited; the deals held for that user then enter with the new owner', async () => {
    await asOwner(db, async () => {
      expect(await importDeal(snapshot(8201, '777'))).toMatchObject({ outcome: 'needs_review', reasonCode: 'unmapped_owner' });
      expect(await importDeal(snapshot(8203, '778'))).toMatchObject({ outcome: 'needs_review', reasonCode: 'unmapped_owner' });
      // Sales Delhi B is linked to 102 in the fixture: unlink first (one Bitrix user per staff member).
      await unlink(ADMIN, U.salesDelhiB);
      // Nothing was stored for 777, so there is nothing to backfill.
      expect(first(await link(ADMIN, U.salesDelhiB, 777))).toEqual({ dealsChanged: 0 });
      const audit = await db.query<{ action: string; actor_user_id: string; details: Record<string, unknown> }>(
        `select action, actor_user_id, details from public.audit_events
         where action in ('integration.bitrix_user_linked', 'integration.deal_owners_recomputed') and target_id = $1
         order by id`,
        [U.salesDelhiB],
      );
      // The link is audited; no owner recompute is recorded because no stored deal changed.
      expect(audit.map((a) => a.action)).toEqual(['integration.bitrix_user_linked']);
      expect(audit[0]!.actor_user_id).toBe(U.adminJodhpur);

      // The held deal and future deals of 777 now enter, owned by Sales Delhi B.
      expect(await importDeal(snapshot(8201, '777', { dateModify: '2026-09-15T11:00:00+05:30' }))).toMatchObject({ outcome: 'created' });
      expect(await importDeal(snapshot(8204, '777'))).toMatchObject({ outcome: 'created' });
      expect(await owner('BX-8201')).toBe(U.salesDelhiB);
      expect(await activeSales('BX-8204')).toEqual([U.salesDelhiB]);
      expect(await stored('BX-8203')).toBe(false); // 778 is still unmapped
      expect(await refs({ userId: U.salesDelhiB })).toEqual(['BX-8201', 'BX-8204']);
    });
  });

  it('one Bitrix user maps to at most one active staff member, and vice versa', async () => {
    await asOwner(db, async () => {
      await expectDbError(db, () => link(ADMIN, U.salesDelhiA, 102), { code: '23505' }); // 102 -> Sales Delhi B
      await expectDbError(db, () => link(ADMIN, U.salesDelhiA, 555), { code: '23505' }); // A already has 101
      await expectDbError(
        db,
        () =>
          db.query(
            `insert into public.bitrix_user_mappings (portal_member_id, bitrix_user_id, staff_user_id, active)
             values ($1, 556, $2, true)`,
            [MEMBER, U.salesDelhiA],
          ),
        { code: '23505' },
      );
    });
  });

  it('only an aal2 admin with integration.manage + staff.manage can link or unlink', async () => {
    await asOwner(db, async () => {
      for (const actor of [{ userId: U.salesDelhiA }, { userId: U.managerDelhi }, { userId: U.adminJodhpur, aal: 'aal1' as const }]) {
        await expectDbError(db, () => link(actor, U.salesDelhiB, 999), { code: '42501' });
        await expectDbError(db, () => unlink(actor, U.salesDelhiB), { code: '42501' });
      }
      await expectDbError(db, () => link(ADMIN, U.formerStaff, 999), { code: '22023' }); // inactive staff
    });
  });
});

describe('revoke', () => {
  it('unlink: deals return to waiting for owner, sales assignments end, access is gone at once', async () => {
    await asOwner(db, async () => {
      await importDeal(snapshot(8301, '101'));
      expect(await refs({ userId: U.salesDelhiA })).toEqual(['BX-8301']);
      const r = first(await unlink(ADMIN, U.salesDelhiA));
      expect(r).toEqual({ bitrixUserId: 101, dealsChanged: 1 });
      expect(await owner('BX-8301')).toBeNull();
      expect(await activeSales('BX-8301')).toEqual([]);
      const ended = await db.query(
        `select 1 from public.deal_assignments a join public.deals d on d.id = a.deal_id
         where d.reference = 'BX-8301' and a.user_id = $1 and a.ended_at is not null`,
        [U.salesDelhiA],
      );
      expect(ended).toHaveLength(1);
      expect(await refs({ userId: U.salesDelhiA })).toEqual([]);
      expect(await stored('BX-8301')).toBe(true); // never deleted
      // Re-grant brings them back.
      await link(ADMIN, U.salesDelhiA, 101);
      expect(await refs({ userId: U.salesDelhiA })).toEqual(['BX-8301']);
    });
  });

  it('deactivation (existing command): deals ownerless, every assignment ended, nothing visible', async () => {
    await asOwner(db, async () => {
      await importDeal(snapshot(8401, '102'));
      await db.query(
        `insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind)
         select id, legal_entity_id, $1, 'visa' from public.deals where reference = 'SYN-DEL-001'`,
        [U.salesDelhiB],
      );
      await run(ADMIN, `select public.deactivate_staff_member($1, 'left the company (test)')`, [U.salesDelhiB]);
      expect(await owner('BX-8401')).toBeNull();
      expect(
        await db.query('select 1 from public.deal_assignments where user_id = $1 and ended_at is null', [U.salesDelhiB]),
      ).toEqual([]);
      expect(await refs({ userId: U.salesDelhiB })).toEqual([]);
      const [audit] = await db.query<{ details: Record<string, unknown> }>(
        `select details from public.audit_events where action = 'integration.deal_owners_recomputed'
         and details ->> 'cause' = 'staff_deactivated' order by id desc limit 1`,
      );
      expect(audit!.details).toMatchObject({ bitrixUserId: 102, ownerUserId: null });
    });
  });
});

describe('Bitrix reassignment', () => {
  it('the next sync moves ownership to the newly mapped staff member; an unmapped new owner is held for review', async () => {
    await asOwner(db, async () => {
      await importDeal(snapshot(8501, '101'));
      expect(await owner('BX-8501')).toBe(U.salesDelhiA);
      await importDeal(snapshot(8501, '102', { dateModify: '2026-09-16T10:00:00+05:30' }));
      expect(await owner('BX-8501')).toBe(U.salesDelhiB);
      expect(await activeSales('BX-8501')).toEqual([U.salesDelhiB]);
      expect(await refs({ userId: U.salesDelhiA })).toEqual([]);
      // No guessed or missing owner: the change waits for an admin, the CRM record is unchanged.
      expect(await importDeal(snapshot(8501, '779', { dateModify: '2026-09-17T10:00:00+05:30' }))).toMatchObject({
        outcome: 'needs_review',
        reasonCode: 'unmapped_owner',
      });
      expect(await owner('BX-8501')).toBe(U.salesDelhiB);
      expect(await activeSales('BX-8501')).toEqual([U.salesDelhiB]);
    });
  });
});

describe('RLS: a salesperson cannot read another salesperson’s deal through the Data API', () => {
  it('direct select by id, assignments and commercial rows return nothing', async () => {
    await asOwner(db, async () => {
      const r = await importDeal(snapshot(8601, '102'));
      const asA = { userId: U.salesDelhiA };
      expect(await run(asA, 'select id from public.deals where id = $1', [r.dealId])).toEqual([]);
      expect(await run(asA, 'select id from public.deal_assignments where deal_id = $1', [r.dealId])).toEqual([]);
      expect(await run(asA, 'select deal_id from public.deal_commercials where deal_id = $1', [r.dealId])).toEqual([]);
      expect(await run({ userId: U.salesDelhiB }, 'select id from public.deals where id = $1', [r.dealId])).toHaveLength(1);
    });
  });
});

describe('sync settings command', () => {
  it('admin changes pipelines/stages/cutoff/switch; ignored deals are re-queued; others are refused', async () => {
    await asOwner(db, async () => {
      expect(await importDeal(snapshot(8701, '101', { categoryId: '9' }))).toMatchObject({ outcome: 'ignored' });
      const update = (actor: Actor, cats: number[], stages: string[], cutoff: string, on: boolean) =>
        run<{ r: { requeued: number } }>(actor, `select public.integration_apply_sync_settings((public.integration_preview_sync_settings($1, $2, $3, $4) ->> 'previewId')::uuid, 'Test: sync settings saved through preview and apply') as r`, [
          cats,
          stages,
          cutoff,
          on,
        ]);
      await expectDbError(db, () => update({ userId: U.managerDelhi }, [7, 9], ['C7:NEW'], '2026-09-01T00:00:00Z', true), {
        code: '42501',
      });
      await expectDbError(db, () => update(ADMIN, [], ['C7:NEW'], '2026-09-01T00:00:00Z', true), { code: '22023' });
      await expectDbError(db, () => update(ADMIN, [7], ['C7:NEW'], '2999-01-01T00:00:00Z', true), { code: '22023' });

      const r = first(await update(ADMIN, [7, 9], ['C7:NEW', 'C9:NEW'], '2026-09-01T00:00:00Z', true));
      expect(r.requeued).toBeGreaterThanOrEqual(1);
      const [cfg] = await db.query<{ cats: string[]; last: string | null }>(
        `select eligible_category_ids::text[] as cats, last_reconciled_at as last from public.integration_intake_config`,
      );
      expect(cfg).toEqual({ cats: ['7', '9'], last: null });
      expect((await db.query<{ enabled: boolean }>('select enabled from public.integration_sync_schedule'))[0]!.enabled).toBe(true);
      // The re-queued deal now enters (category 9 is eligible, C7:NEW is an entry stage).
      const claimed = await run<{ r: ClaimedInboxItem }>(SVC, 'select r from public.integration_claim_inbox(100, 60) as r');
      const item = claimed.map((c) => c.r).find((c) => c.sourceDealId === '8701')!;
      const applied = first(await run<{ r: ApplyResult }>(
        SVC,
        'select public.integration_apply_bitrix_deal($1,$2,$3::jsonb) as r',
        [item.inboxId, item.lockToken, JSON.stringify(snapshot(8701, '101', { categoryId: '9' }))],
      ));
      expect(applied.outcome).toBe('created');
      // Admin reads the schedule switch; staff do not.
      expect(await run(ADMIN, 'select enabled from public.integration_sync_schedule')).toEqual([{ enabled: true }]);
      expect(await run({ userId: U.salesDelhiA }, 'select enabled from public.integration_sync_schedule')).toEqual([]);
    });
  });
});
