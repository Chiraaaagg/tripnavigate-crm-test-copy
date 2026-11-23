import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * Stage 6 (sync completion contract 2026-10-08, sections 3 and 7), migration
 * 20261111000100_sync_completion: deals.source_lead_id, written only by
 * integration_apply_bitrix_deal from the snapshot key leadId (digits = the Lead;
 * empty, absent or 0 = none). The Deal page shows the link only when a crm_leads row
 * with the same portal and Lead id exists and row-level security lets the viewer read
 * it: the Lead's Sales owner sees it; another branch and Purchase do not.
 *
 * Synthetic fixtures only (Deal manifest 5000-9999, business day 2026-09-15 IST,
 * source SYNTHETIC_SRC; Bitrix 101 -> Sales Delhi A). Rolled back per case.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const SVC: Actor = { userId: null, role: 'service_role' };
const MEMBER = 'SYNTHETIC_MEMBER_0001';
const CONFIG = 'c0000000-0000-4000-8000-000000000001';

interface Result {
  outcome: string;
  dealId?: string | null;
  leadId?: string | null;
  reasonCode: string | null;
}
interface Item {
  inboxId: string;
  lockToken: string;
}

async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  await setActor(db, actor);
  const rows = await db.query<T>(sql, params);
  await resetActor(db);
  return rows;
}
async function one<T>(actor: Actor, sql: string, params: unknown[] = []): Promise<T> {
  return (await run<{ r: T }>(actor, sql, params))[0]!.r;
}

let ts = 1_802_000_000;
async function claimFor(event: string, id: number): Promise<Item> {
  const rec = await one<{ inboxId: string }>(SVC, 'select public.integration_record_bitrix_event($1, $2, $3, $4) as r', [
    MEMBER, event, id, (ts += 1),
  ]);
  const rows = await run<{ r: Item }>(SVC, 'select r from public.integration_claim_inbox(100, 60) as r');
  const item = rows.map((x) => x.r).find((x) => x.inboxId === rec.inboxId);
  if (!item) throw new Error('row was not claimed');
  return item;
}
async function applyDeal(deal: Record<string, unknown>): Promise<Result> {
  const item = await claimFor('ONCRMDEALUPDATE', Number(deal.id));
  return one<Result>(SVC, 'select public.integration_apply_bitrix_deal($1, $2, $3::jsonb) as r', [
    item.inboxId, item.lockToken, JSON.stringify(deal),
  ]);
}
async function applyLead(lead: Record<string, unknown>): Promise<Result> {
  const item = await claimFor('ONCRMLEADUPDATE', Number(lead.id));
  return one<Result>(SVC, 'select public.integration_apply_bitrix_lead($1, $2, $3::jsonb) as r', [
    item.inboxId, item.lockToken, JSON.stringify(lead),
  ]);
}

function deal(id: number, o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: String(id),
    sourceId: 'SYNTHETIC_SRC',
    title: `Synthetic lead-link deal ${id}`,
    stageId: 'C7:NEW',
    categoryId: '7',
    assignedById: '101',
    dateCreate: '2026-09-15T10:00:00+05:30',
    dateModify: '2026-09-15T10:00:00+05:30',
    ...o,
  };
}
const lead = (id: number, assignedById = '101') => ({
  id: String(id), title: `Synthetic linked lead ${id}`, statusId: 'CONVERTED', sourceId: 'WEBFORM', assignedById,
  dateCreate: '2026-10-02T11:00:00+05:30', dateModify: '2026-10-02T11:00:00+05:30',
});
const linkOf = async (id: number) =>
  (await db.query<{ l: string | null }>(`select source_lead_id::text as l from public.deals where source_portal = $1 and source_deal_id = $2`, [MEMBER, id]))[0]?.l;
let minute = 0;
const later = () => `2026-09-15T${String(11 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute++ % 60).padStart(2, '0')}:00+05:30`;

describe('deals.source_lead_id is written and cleared by the Deal apply', () => {
  it('a new Deal stores leadId; every later apply sets the current value (empty, 0 and absent clear it)', async () => {
    await asOwner(db, async () => {
      expect(await applyDeal(deal(7101, { leadId: '41001' }))).toMatchObject({ outcome: 'created' });
      expect(await linkOf(7101)).toBe('41001');
      expect(await applyDeal(deal(7101, { leadId: '', dateModify: later() }))).toMatchObject({ outcome: 'updated' });
      expect(await linkOf(7101)).toBeNull();
      expect(await applyDeal(deal(7101, { leadId: '41002', dateModify: later() }))).toMatchObject({ outcome: 'updated' });
      expect(await linkOf(7101)).toBe('41002');
      expect(await applyDeal(deal(7101, { leadId: '0', dateModify: later() }))).toMatchObject({ outcome: 'updated' });
      expect(await linkOf(7101)).toBeNull();
      expect(await applyDeal(deal(7101, { leadId: '41003', dateModify: later() }))).toMatchObject({ outcome: 'updated' });
      expect(await applyDeal(deal(7101, { dateModify: later() }))).toMatchObject({ outcome: 'updated' });
      expect(await linkOf(7101)).toBeNull();
      expect(await applyDeal(deal(7101, { leadId: '41003', dateModify: later() }))).toMatchObject({ outcome: 'updated' });
      expect(await applyDeal(deal(7101, { leadId: null, dateModify: later() }))).toMatchObject({ outcome: 'updated' });
      expect(await linkOf(7101)).toBeNull();
    });
  });

  it('a changed leadId alone (same DATE_MODIFY) is applied; identical data stays stale_ignored', async () => {
    await asOwner(db, async () => {
      expect(await applyDeal(deal(7111))).toMatchObject({ outcome: 'created' });
      expect(await linkOf(7111)).toBeNull();
      expect(await applyDeal(deal(7111))).toMatchObject({ outcome: 'stale_ignored' });
      // A resync after this release fills the link without a Bitrix change.
      expect(await applyDeal(deal(7111, { leadId: '41011' }))).toMatchObject({ outcome: 'updated' });
      expect(await linkOf(7111)).toBe('41011');
      expect(await applyDeal(deal(7111, { leadId: '41011' }))).toMatchObject({ outcome: 'stale_ignored' });
    });
  });

  it('an older snapshot never changes the link', async () => {
    await asOwner(db, async () => {
      expect(await applyDeal(deal(7121, { leadId: '41021', dateModify: '2026-09-15T12:00:00+05:30' }))).toMatchObject({ outcome: 'created' });
      expect(await applyDeal(deal(7121, { leadId: '41999', dateModify: '2026-09-15T11:00:00+05:30' }))).toMatchObject({ outcome: 'stale_ignored' });
      expect(await linkOf(7121)).toBe('41021');
    });
  });

  it('a leadId that is not digits (or not a string) is invalid source data; nothing is stored', async () => {
    await asOwner(db, async () => {
      for (const [i, leadId] of (['L-1', '12a', ' 5', '-3', 5, true, '1234567890123456789'] as unknown[]).entries()) {
        expect(await applyDeal(deal(7131 + i, { leadId })), String(leadId)).toEqual({
          outcome: 'needs_review', dealId: null, reasonCode: 'invalid_source_data',
        });
        expect(await linkOf(7131 + i)).toBeUndefined();
      }
    });
  });

  it('only positive ids can be stored', async () => {
    await asOwner(db, async () => {
      expect(await applyDeal(deal(7141, { leadId: '41041' }))).toMatchObject({ outcome: 'created' });
      await expectDbError(db, () => db.query(`update public.deals set source_lead_id = 0 where source_deal_id = 7141`), { code: '23514' });
    });
  });
});

describe('the Lead behind a Deal is visible only under the Lead read rules', () => {
  /** What the Deal page asks: the Lead with the Deal's portal and Lead id, under RLS. */
  const visibleLink = (actor: Actor, dealId: number) =>
    run<{ reference: string }>(
      actor,
      `select l.reference from public.crm_leads l
       where (l.source_portal, l.source_lead_id) = (
         select d.source_portal, d.source_lead_id from public.deals d where d.source_portal = $1 and d.source_deal_id = $2)`,
      [MEMBER, dealId],
    );

  it('the Sales owner of the Lead sees it; another branch, another Sales member and Purchase do not', async () => {
    await asOwner(db, async () => {
      await db.query(`update public.integration_intake_config set lead_intake_mode = 'scope' where id = $1`, [CONFIG]);
      expect(await applyLead(lead(41201))).toMatchObject({ outcome: 'created' });
      expect(await applyDeal(deal(7201, { leadId: '41201' }))).toMatchObject({ outcome: 'created' });

      expect(await visibleLink({ userId: U.salesDelhiA }, 7201)).toEqual([{ reference: 'BXL-41201' }]);
      expect(await visibleLink({ userId: U.salesAhmedabad }, 7201)).toEqual([]);
      expect(await visibleLink({ userId: U.salesDelhiB }, 7201)).toEqual([]);
      expect(await visibleLink({ userId: U.purchaseJodhpur }, 7201)).toEqual([]);
      // The branch manager reads it under the existing Lead rules.
      expect(await visibleLink({ userId: U.managerDelhi }, 7201)).toEqual([{ reference: 'BXL-41201' }]);
    });
  });

  it('no matching Lead row: nothing to show (never matched by anything else)', async () => {
    await asOwner(db, async () => {
      expect(await applyDeal(deal(7211, { leadId: '49999', title: 'Synthetic linked lead 49999' }))).toMatchObject({ outcome: 'created' });
      expect(await visibleLink({ userId: U.salesDelhiA }, 7211)).toEqual([]);
    });
  });
});
