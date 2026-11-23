import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { financeHelpers } from './finance-support';
import {
  type Actor,
  FIXTURE_USERS as U,
  SYNTHETIC_INTAKE_CONFIG as CONFIG,
  type TestDb,
  asOwner,
  createTestDb,
  expectDbError,
  resetActor,
  setActor,
} from '../helpers/db';

/**
 * B1.1d Won-only Deal intake (contract section 3, DEC-27; freeze note 3.3;
 * migration 20261119000400_b11_won_only_intake).
 *
 * integration_intake_config.deal_entry_stage_ids is the switch (null = today's
 * rule). Set: new Deals enter, and removed Deals come back, only at those
 * stages; stored Deals keep updating; integration_prune_deals_outside_entry_stages
 * soft-removes stored Deals outside the list that have no CRM work.
 *
 * Synthetic fixtures only: portal SYNTHETIC_MEMBER_0001 (Deal scope mode in these
 * cases), pipeline 7, ticked stages C7:NEW and C7:PREPARATION, entry stage C7:WON,
 * sync date 2026-09-01; Bitrix 101 -> Sales Delhi A. Deal ids 31000+ are outside
 * every manifest. Every case is rolled back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const SVC: Actor = { userId: null, role: 'service_role' };
/** Synthetic fixture Deal SYN-DEL-001 (Delhi, owner Sales Delhi A). */
const FIXTURE_DEAL = 'd0000000-0000-4000-8000-000000000001';
const ADMIN: Actor = { userId: U.adminJodhpur };
const ADMIN_AAL1: Actor = { userId: U.adminJodhpur, aal: 'aal1' };
const SALES: Actor = { userId: U.salesDelhiA };
const MANAGER: Actor = { userId: U.managerDelhi };
const MEMBER = 'SYNTHETIC_MEMBER_0001';
const REASON = 'Owner approval APPROVE, synthetic test run';
const WON = 'C7:WON';

interface Result {
  outcome: string;
  dealId: string | null;
  reasonCode: string | null;
}
interface Item {
  inboxId: string;
  lockToken: string;
}
interface DealRow {
  id: string;
  owner_user_id: string | null;
  removed_at: string | null;
  removed_reason: string | null;
  source_stage_id: string;
  title: string;
}
interface PruneDeal {
  id: string;
  reference: string;
  stageId: string;
  work?: string[];
}
interface Prune {
  dryRun: boolean;
  entryStageIds: string[];
  storedActive: number;
  atEntryStage: number;
  pruned: { count: number; deals: PruneDeal[] };
  keptWithWork: { count: number; byKind: Record<string, string[]>; deals: PruneDeal[] };
  keptSyncPending: { count: number; deals: PruneDeal[] };
  truncated: boolean;
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
async function refused(actor: Actor, sql: string, params: unknown[], code: string, message?: RegExp): Promise<void> {
  await expectDbError(db, () => run(actor, sql, params), { code, message });
  await resetActor(db);
}

let ts = 1_811_000_000;
const record = (id: number) =>
  one<{ inboxId: string }>(SVC, 'select public.integration_record_bitrix_event($1, $2, $3, $4) as r', [
    MEMBER, 'ONCRMDEALUPDATE', id, (ts += 1),
  ]);
async function claimOne(inboxId: string): Promise<Item> {
  const rows = await run<{ r: Item }>(SVC, 'select r from public.integration_claim_inbox(100, 60) as r');
  const item = rows.map((x) => x.r).find((x) => x.inboxId === inboxId);
  if (!item) throw new Error('row was not claimed');
  return item;
}
const applyDeal = (item: Item, deal: Record<string, unknown>) =>
  one<Result>(SVC, 'select public.integration_apply_bitrix_deal($1, $2, $3::jsonb) as r', [item.inboxId, item.lockToken, JSON.stringify(deal)]);
async function importDeal(deal: Record<string, unknown>): Promise<Result> {
  return applyDeal(await claimOne((await record(Number(deal.id))).inboxId), deal);
}

let modified = 0;
/** A live Deal created after the sync date; each call is a newer Bitrix version. */
function deal(id: number, o: Record<string, unknown> = {}): Record<string, unknown> {
  modified += 1;
  const minute = String(modified % 60).padStart(2, '0');
  const hour = String(10 + Math.floor(modified / 60)).padStart(2, '0');
  return {
    id: String(id),
    title: `Synthetic won-only deal ${id}`,
    stageId: 'C7:NEW',
    categoryId: '7',
    assignedById: '101',
    dateCreate: '2026-10-02T09:00:00+05:30',
    dateModify: `2026-10-03T${hour}:${minute}:00+05:30`,
    leadId: '',
    ...o,
  };
}
const dealRow = async (id: number): Promise<DealRow | undefined> =>
  (
    await db.query<DealRow>(
      `select id, owner_user_id, removed_at, removed_reason, source_stage_id, title
       from public.deals where source_portal = $1 and source_deal_id = $2`,
      [MEMBER, id],
    )
  )[0];
const inbox = async (inboxId: string) =>
  (await db.query<{ status: string; reason_code: string | null }>('select status, reason_code from public.integration_inbox where id = $1', [inboxId]))[0];
const dealScope = () => db.query(`update public.integration_intake_config set deal_intake_mode = 'scope' where id = $1`, [CONFIG]);
const entryList = async () =>
  (await db.query<{ l: string[] | null }>('select deal_entry_stage_ids l from public.integration_intake_config'))[0]!.l;

const SET_SQL = 'select public.integration_set_deal_entry_stages($1::text[], $2) as r';
const PRUNE_SQL = 'select public.integration_prune_deals_outside_entry_stages($1, $2) as r';
type SetResult = { changed: boolean; before: string[] | null; after: string[] | null; restored: number; requeued: number; resyncQueued: boolean };
const setList = (list: string[] | null, actor: Actor = ADMIN) => one<SetResult>(actor, SET_SQL, [list, REASON]);
const prune = (dryRun: boolean) => one<Prune>(ADMIN, PRUNE_SQL, [REASON, dryRun]);
const audits = (action: string) =>
  db.query<{ actor_user_id: string | null; reason: string | null; target_id: string | null; details: Record<string, unknown> }>(
    'select actor_user_id, reason, target_id, details from public.audit_events where action = $1 order by occurred_at, id',
    [action],
  );

describe('switch off (default) is today', () => {
  it('starts with no entry list; a Deal enters at a ticked stage and not at an unticked one', async () => {
    await asOwner(db, async () => {
      await dealScope();
      expect(await entryList()).toBeNull();
      expect(await importDeal(deal(31001, { stageId: WON }))).toEqual({ outcome: 'ignored', dealId: null, reasonCode: 'not_eligible_stage' });
      expect(await importDeal(deal(31002))).toMatchObject({ outcome: 'created' });
      // A full check queued while the switch is off lists the ticked stages.
      const queued = await one<{ jobId: string }>(SVC, 'select public.integration_queue_resync($1) as r', [MEMBER]);
      const [job] = await db.query<{ stage_ids: string[] }>('select stage_ids from public.integration_resync_jobs where id = $1', [queued.jobId]);
      expect(job).toBeDefined();
      expect(job!.stage_ids).toEqual(['C7:NEW', 'C7:PREPARATION']);
    });
  });

  it('the prune refuses while the list is not set', async () => {
    await asOwner(db, async () => {
      await refused(ADMIN, PRUNE_SQL, [REASON, true], '55000', /^entry_stages_not_set$/);
    });
  });
});

describe('integration_set_deal_entry_stages', () => {
  it('refuses anyone but a Super Admin at aal2, a bad reason and bad lists', async () => {
    await asOwner(db, async () => {
      for (const actor of [SALES, MANAGER, ADMIN_AAL1, { userId: U.accountsJodhpur }]) {
        await refused(actor, SET_SQL, [[WON], REASON], '42501', /^not_authorized$/);
      }
      await refused(ADMIN, SET_SQL, [[WON], 'too short'], '22023');
      await refused(ADMIN, SET_SQL, [[WON], 'x'.repeat(501)], '22023');
      for (const list of [[], [WON, WON], ['bad id!'], Array.from({ length: 21 }, (_, i) => `C7:S${i}`)]) {
        await refused(ADMIN, SET_SQL, [list, REASON], '22023', /^invalid_input$/);
      }
      // C9 is not a ticked pipeline; an id without prefix is pipeline 0 (not ticked here).
      await refused(ADMIN, SET_SQL, [['C9:WON'], REASON], '22023', /^entry_stage_outside_pipelines$/);
      await refused(ADMIN, SET_SQL, [['UC_AD0SLH'], REASON], '22023', /^entry_stage_outside_pipelines$/);
      expect(await entryList()).toBeNull();
    });
  });

  it('sets the list with audit rows, queues a full check with the entry filter and removes nothing', async () => {
    await asOwner(db, async () => {
      await dealScope();
      await importDeal(deal(31011));
      const res = await setList([WON]);
      expect(res).toEqual({ changed: true, before: null, after: [WON], restored: 0, requeued: 0, resyncQueued: true });
      expect(await entryList()).toEqual([WON]);
      expect(await dealRow(31011)).toMatchObject({ removed_at: null });

      // (The first trigger row is the fixture's own switch to Deal scope mode.)
      const trigger = (await audits('settings.intake_config_changed')).find((a) => a.details.command === 'integration_set_deal_entry_stages');
      expect(trigger).toMatchObject({ actor_user_id: U.adminJodhpur, reason: REASON });
      expect(trigger!.details).toMatchObject({
        via: 'command', command: 'integration_set_deal_entry_stages',
        changes: { deal_entry_stage_ids: { from: null, to: [WON] } },
      });
      const [own] = await audits('integration.deal_entry_stages_set');
      expect(own).toMatchObject({ actor_user_id: U.adminJodhpur, reason: REASON, target_id: CONFIG });
      expect(own!.details).toMatchObject({ before: null, after: [WON], restored: 0, requeued: 0 });

      const jobs = await db.query<{ status: string; stage_ids: string[]; reason: string }>(
        `select status, stage_ids, reason from public.integration_resync_jobs where portal_member_id = $1 and status in ('queued', 'running')`,
        [MEMBER],
      );
      expect(jobs).toEqual([{ status: 'queued', stage_ids: [WON], reason: 'settings_changed' }]);

      // The same list again (any order) changes nothing and writes nothing.
      expect(await setList([WON])).toEqual({ changed: false, before: [WON], after: [WON], restored: 0, requeued: 0, resyncQueued: false });
      expect(await audits('integration.deal_entry_stages_set')).toHaveLength(1);
    });
  });
});

describe('entry only at the entry stages', () => {
  it('a new Deal at a ticked but non-entry stage is ignored; at Won it is created with its owner', async () => {
    await asOwner(db, async () => {
      await dealScope();
      await setList([WON]);
      const rec = await record(31021);
      expect(await applyDeal(await claimOne(rec.inboxId), deal(31021))).toEqual({
        outcome: 'ignored', dealId: null, reasonCode: 'not_eligible_stage',
      });
      expect(await inbox(rec.inboxId)).toEqual({ status: 'ignored', reason_code: 'not_eligible_stage' });
      expect(await dealRow(31021)).toBeUndefined();
      expect(await importDeal(deal(31022, { stageId: WON }))).toMatchObject({ outcome: 'created' });
      expect(await dealRow(31022)).toMatchObject({ owner_user_id: U.salesDelhiA, removed_at: null, source_stage_id: WON });
    });
  });

  it('a stored Deal that leaves Won is kept and keeps receiving header updates', async () => {
    await asOwner(db, async () => {
      await dealScope();
      await setList([WON]);
      await importDeal(deal(31031, { stageId: WON }));
      expect(await importDeal(deal(31031, { stageId: 'C7:PREPARATION', title: 'Renamed after Won' }))).toMatchObject({ outcome: 'updated' });
      expect(await dealRow(31031)).toMatchObject({
        removed_at: null, owner_user_id: U.salesDelhiA, source_stage_id: 'C7:PREPARATION', title: 'Renamed after Won',
      });
      expect(await importDeal(deal(31031, { stageId: 'C7:LOSE' }))).toMatchObject({ outcome: 'updated' });
      expect(await dealRow(31031)).toMatchObject({ removed_at: null, source_stage_id: 'C7:LOSE' });
    });
  });

  it('a Deal stored before the switch, outside Won, is updated and not removed by its apply', async () => {
    await asOwner(db, async () => {
      await dealScope();
      await importDeal(deal(31041));
      await setList([WON]);
      expect(await importDeal(deal(31041, { title: 'Still here' }))).toMatchObject({ outcome: 'updated' });
      expect(await dealRow(31041)).toMatchObject({ removed_at: null, title: 'Still here' });
    });
  });
});

describe('integration_prune_deals_outside_entry_stages', () => {
  it('refuses anyone but a Super Admin at aal2, a bad reason and a missing dry-run flag', async () => {
    await asOwner(db, async () => {
      await setList([WON]);
      for (const actor of [SALES, MANAGER, ADMIN_AAL1]) {
        await refused(actor, PRUNE_SQL, [REASON, true], '42501', /^not_authorized$/);
      }
      await refused(ADMIN, PRUNE_SQL, ['short', true], '22023');
      await refused(ADMIN, PRUNE_SQL, [REASON, null], '22023', /^invalid_input$/);
    });
  });

  it('dry run lists what would be removed, what is kept and why, and changes nothing', async () => {
    await asOwner(db, async () => {
      await dealScope();
      await importDeal(deal(31051)); // no work: would be removed
      await importDeal(deal(31052)); // finance record: kept
      await importDeal(deal(31054)); // sync waiting: kept
      const kept = (await dealRow(31052))!;
      await db.query('insert into public.finance_deal_heads (deal_id, legal_entity_id) select id, legal_entity_id from public.deals where id = $1', [kept.id]);
      await setList([WON]);
      await importDeal(deal(31053, { stageId: WON })); // at Won: not a candidate
      await record(31054); // a pending inbox row
      const before = await db.query('select id, removed_at, owner_user_id from public.deals order by id');
      const listBefore = await db.query('select * from public.deal_list_changes order by legal_entity_id');
      const assignmentsBefore = await db.query('select * from public.deal_assignments order by id');
      const inboxBefore = await db.query('select id, status, reason_code, processed_deal_id from public.integration_inbox order by id');

      const res = await prune(true);
      expect(res).toMatchObject({ dryRun: true, entryStageIds: [WON], storedActive: 4, atEntryStage: 1, truncated: false });
      expect(res.pruned.count).toBe(1);
      expect(res.pruned.deals).toEqual([{ id: (await dealRow(31051))!.id, reference: 'BX-31051', stageId: 'C7:NEW' }]);
      expect(res.keptWithWork.count).toBe(1);
      expect(res.keptWithWork.deals).toEqual([{ id: kept.id, reference: 'BX-31052', stageId: 'C7:NEW', work: ['finance_record'] }]);
      expect(res.keptWithWork.byKind.finance_record).toEqual([kept.id]);
      expect(res.keptWithWork.byKind.booking_version).toEqual([]);
      expect(res.keptSyncPending).toEqual({ count: 1, deals: [{ id: (await dealRow(31054))!.id, reference: 'BX-31054', stageId: 'C7:NEW' }] });

      expect(await db.query('select id, removed_at, owner_user_id from public.deals order by id')).toEqual(before);
      expect(await db.query('select * from public.deal_list_changes order by legal_entity_id')).toEqual(listBefore);
      expect(await db.query('select * from public.deal_assignments order by id')).toEqual(assignmentsBefore);
      expect(await db.query('select id, status, reason_code, processed_deal_id from public.integration_inbox order by id')).toEqual(inboxBefore);
      expect(await db.query(`select 1 from public.deal_removal_participants where removed_reason = 'outside_entry_stage'`)).toEqual([]);
      const [preview] = await audits('integration.deals_prune_previewed');
      expect(preview).toMatchObject({ actor_user_id: U.adminJodhpur, reason: REASON, target_id: CONFIG });
      expect(preview!.details).toMatchObject({ dryRun: true, pruned: 1, keptWithWork: 1, keptSyncPending: 1 });
      expect(await audits('integration.deals_pruned')).toEqual([]);
    });
  });

  it('real run soft-removes only Deals without CRM work, records who was on them, and is idempotent', async () => {
    await asOwner(db, async () => {
      await dealScope();
      await importDeal(deal(31061));
      await importDeal(deal(31062));
      const kept = (await dealRow(31062))!;
      await db.query(
        `insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind)
         select id, legal_entity_id, $2, 'purchase' from public.deals where id = $1`,
        [kept.id, U.purchaseJodhpur],
      );
      await setList([WON]);
      await importDeal(deal(31063, { stageId: WON }));
      const res = await prune(false);
      expect(res).toMatchObject({ dryRun: false, pruned: { count: 1 }, keptWithWork: { count: 1 } });
      expect(res.keptWithWork.byKind.assignment).toEqual([kept.id]);
      const removed = (await dealRow(31061))!;
      expect(removed).toMatchObject({ removed_reason: 'outside_entry_stage', owner_user_id: null });
      expect(removed.removed_at).not.toBeNull();
      expect(await dealRow(31062)).toMatchObject({ removed_at: null, owner_user_id: U.salesDelhiA });
      expect(await dealRow(31063)).toMatchObject({ removed_at: null });
      expect(
        await db.query(`select user_id, participation from public.deal_removal_participants where deal_id = $1 order by participation`, [removed.id]),
      ).toEqual([
        { user_id: U.salesDelhiA, participation: 'owner' },
        { user_id: U.salesDelhiA, participation: 'sales' },
      ]);
      expect(await db.query(`select 1 from public.deal_assignments where deal_id = $1 and ended_at is null`, [removed.id])).toEqual([]);
      const perDeal = await audits('integration.deal_removed');
      expect(perDeal).toEqual([
        expect.objectContaining({ target_id: removed.id, reason: REASON, details: expect.objectContaining({ reason: 'outside_entry_stage' }) }),
      ]);
      const [summary] = await audits('integration.deals_pruned');
      expect(summary!.details).toMatchObject({ dryRun: false, pruned: 1, prunedIds: [removed.id] });

      const again = await prune(false);
      expect(again.pruned).toEqual({ count: 0, deals: [] });
      // Synthetic and CRM-native fixture Deals were never candidates.
      expect(await db.query(`select 1 from public.deals where is_synthetic and removed_at is not null`)).toEqual([]);
    });
  });

  it('never prunes a Deal with CRM work, and names each kind', async () => {
    await asOwner(db, async () => {
      await dealScope();
      const ids: Record<string, number> = {
        booking_version: 31071, billing_profile: 31072, service_item: 31073, traveller: 31074, finance_record: 31075,
      };
      for (const id of Object.values(ids)) await importDeal(deal(id));
      const row = async (k: string) => (await dealRow(ids[k]!))!.id;
      // Sales opens a booking draft through the real command.
      await one(SALES, 'select public.booking_open_draft($1) as r', [await row('booking_version')]);
      await db.query(
        `insert into public.customer_billing_profiles (deal_id, legal_entity_id, billing_name, address_line1, city, state_code, postal_code, updated_by)
         select id, legal_entity_id, 'Synthetic Billing', 'Line 1', 'Delhi', '07', '110001', $2 from public.deals where id = $1`,
        [await row('billing_profile'), U.accountsJodhpur],
      );
      await db.query(
        `insert into public.service_items (deal_id, legal_entity_id, branch_id, item_no, service_type, department, created_by)
         select id, legal_entity_id, branch_id, 1, 'transfer', 'purchase', $2 from public.deals where id = $1`,
        [await row('service_item'), U.salesDelhiA],
      );
      await db.query(
        `insert into public.deal_travellers (deal_id, legal_entity_id, seq, full_name, traveller_type)
         select id, legal_entity_id, 1, 'Synthetic Traveller', 'adult' from public.deals where id = $1`,
        [await row('traveller')],
      );
      await db.query('insert into public.finance_deal_heads (deal_id, legal_entity_id) select id, legal_entity_id from public.deals where id = $1', [
        await row('finance_record'),
      ]);
      await setList([WON]);
      const res = await prune(false);
      expect(res.pruned.count).toBe(0);
      expect(res.keptWithWork.count).toBe(5);
      for (const kind of Object.keys(ids)) {
        expect(res.keptWithWork.byKind[kind]).toContain(await row(kind));
      }
      // No claim row on these Deals (absent B1.1 tables are skipped, not errors).
      expect(res.keptWithWork.byKind.claim).toEqual([]);
      for (const id of Object.values(ids)) expect(await dealRow(id)).toMatchObject({ removed_at: null });
    });
  });
});

describe('restore and reconcile after a prune', () => {
  async function prunedDeal(id: number): Promise<string> {
    await dealScope();
    await importDeal(deal(id));
    await setList([WON]);
    await prune(false);
    const row = (await dealRow(id))!;
    expect(row.removed_reason).toBe('outside_entry_stage');
    return row.id;
  }

  it('a pruned Deal that reaches Won comes back with its owner', async () => {
    await asOwner(db, async () => {
      const id = await prunedDeal(31081);
      expect(await importDeal(deal(31081, { stageId: WON }))).toMatchObject({ outcome: 'updated', dealId: id });
      expect(await dealRow(31081)).toMatchObject({ removed_at: null, removed_reason: null, owner_user_id: U.salesDelhiA, source_stage_id: WON });
      expect((await audits('integration.deal_restored')).map((a) => a.target_id)).toEqual([id]);
    });
  });

  it('a pruned Deal still outside Won stays removed (header updated) through events and the reconcile', async () => {
    await asOwner(db, async () => {
      await prunedDeal(31091);
      const rec = await record(31091);
      expect(await applyDeal(await claimOne(rec.inboxId), deal(31091, { stageId: 'C7:PREPARATION' }))).toMatchObject({
        outcome: 'ignored', reasonCode: 'not_eligible_stage',
      });
      expect(await dealRow(31091)).toMatchObject({ removed_reason: 'outside_entry_stage', source_stage_id: 'C7:PREPARATION' });
      const enq = await one<{ inboxId: string | null }>(SVC, 'select public.integration_enqueue_reconcile($1, 31091, $2) as r', [MEMBER, ts + 999_999]);
      expect(enq.inboxId).not.toBeNull();
      await applyDeal(await claimOne(enq.inboxId!), deal(31091, { stageId: 'C7:NEW' }));
      expect(await dealRow(31091)).toMatchObject({ removed_reason: 'outside_entry_stage', source_stage_id: 'C7:NEW' });
    });
  });

  it('the full check lists Won only and reports no false gap for stored Deals outside Won', async () => {
    await asOwner(db, async () => {
      await dealScope();
      await importDeal(deal(31102)); // stored, outside Won, kept
      await setList([WON]);
      await importDeal(deal(31101, { stageId: WON }));
      const job = await one<{ jobId: string; lockToken: string; stageIds: string[] }>(
        SVC, 'select public.integration_resync_next($1, 60) as r', [MEMBER],
      );
      expect(job.stageIds).toEqual([WON]);
      const stored = (await db.query<{ m: string }>(
        `select extract(epoch from source_modified_at)::bigint::text m from public.deals where source_portal = $1 and source_deal_id = 31101`,
        [MEMBER],
      ))[0]!.m;
      await one(SVC, 'select public.integration_resync_page($1, $2, $3::jsonb, 1, true) as r', [
        job.jobId, job.lockToken, JSON.stringify([{ id: 31101, modified: Number(stored) }]),
      ]);
      const fin = await one<{ done: boolean; result: Record<string, unknown> }>(
        SVC, 'select public.integration_resync_finish($1, $2) as r', [job.jobId, job.lockToken],
      );
      expect(fin.done).toBe(true);
      expect(fin.result).toMatchObject({ bitrix: 1, missing: 0, reRead: 0 });
      expect(fin.result.keptAfterStageMove as number).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('the sync settings cannot remove or restore through the entry list', () => {
  const SETTINGS_SQL = `select public.integration_apply_sync_settings((public.integration_preview_sync_settings($1, $2, $3, true) ->> 'previewId')::uuid, 'Test: sync settings saved through preview and apply') as r`;

  it('a settings save keeps pruned Deals outside Won removed, brings back pruned Deals now at Won, and never writes the list', async () => {
    await asOwner(db, async () => {
      await dealScope();
      await importDeal(deal(31111));
      await importDeal(deal(31112));
      await importDeal(deal(31113, { stageId: 'C7:PREPARATION' }));
      await setList([WON]);
      await prune(false);
      // 31112 reached Won in Bitrix; its stored header says so (still removed).
      await db.query(`update public.deals set source_stage_id = $2 where source_portal = $1 and source_deal_id = 31112`, [MEMBER, WON]);
      const res = await one<{ removed: number; restored: number }>(ADMIN, SETTINGS_SQL, [[7], ['C7:NEW', 'C7:PREPARATION'], '2026-08-31T00:00:00+05:30']);
      expect(res).toMatchObject({ removed: 0, restored: 1 });
      expect(await dealRow(31111)).toMatchObject({ removed_reason: 'outside_entry_stage' });
      expect(await dealRow(31112)).toMatchObject({ removed_at: null });
      expect(await dealRow(31113)).toMatchObject({ removed_reason: 'outside_entry_stage' });
      expect(await entryList()).toEqual([WON]);
    });
  });

  it('unticking a stage never removes a stored Deal sitting in an entry stage', async () => {
    await asOwner(db, async () => {
      await dealScope();
      await importDeal(deal(31121, { stageId: 'C7:PREPARATION' }));
      await setList([WON]);
      await importDeal(deal(31122, { stageId: WON }));
      await one(ADMIN, SETTINGS_SQL, [[7], ['C7:NEW', 'C7:PREPARATION', WON], '2026-09-01T00:00:00+05:30']);
      await one(ADMIN, SETTINGS_SQL, [[7], ['C7:NEW'], '2026-09-01T00:00:00+05:30']);
      expect(await dealRow(31122)).toMatchObject({ removed_at: null });
      // Today's rule for the other stages is unchanged.
      expect(await dealRow(31121)).toMatchObject({ removed_reason: 'stage_not_eligible' });
    });
  });
});

describe('clearing the list is the rollback', () => {
  it('Deals removed by the prune that pass today\'s rule come back; other removals stay; the check lists the ticked stages', async () => {
    await asOwner(db, async () => {
      await dealScope();
      await importDeal(deal(31131));
      await importDeal(deal(31132));
      await setList([WON]);
      await prune(false);
      // A removal for another reason is not touched.
      await db.query(
        `update public.deals set removed_reason = 'pipeline_not_eligible' where source_portal = $1 and source_deal_id = 31132`,
        [MEMBER],
      );
      const res = await setList(null);
      expect(res).toMatchObject({ changed: true, before: [WON], after: null, restored: 1, resyncQueued: true });
      expect(res.requeued).toBeGreaterThanOrEqual(0);
      expect(await dealRow(31131)).toMatchObject({ removed_at: null, owner_user_id: U.salesDelhiA });
      expect(await dealRow(31132)).toMatchObject({ removed_reason: 'pipeline_not_eligible' });
      const restoreRows = await db.query<{ status: string; origin: string }>(
        `select status, origin from public.integration_inbox where portal_member_id = $1 and source_deal_id = 31131 and status = 'pending'`,
        [MEMBER],
      );
      expect(restoreRows).toEqual([{ status: 'pending', origin: 'manual_retry' }]);
      expect((await audits('integration.deal_restored'))[0]!.details).toMatchObject({ cause: 'entry_stages_changed' });
      const [job] = await db.query<{ stage_ids: string[] }>(
        `select stage_ids from public.integration_resync_jobs where portal_member_id = $1 and status = 'queued'`,
        [MEMBER],
      );
      expect(job!.stage_ids).toEqual(['C7:NEW', 'C7:PREPARATION']);
    });
  });
});

describe('Leads are untouched', () => {
  it('the prune never reads or changes Leads, and the Lead apply does not use the entry list', async () => {
    await asOwner(db, async () => {
      await dealScope();
      await importDeal(deal(31141));
      await setList([WON]);
      const before = await db.query('select * from public.crm_leads order by id');
      await prune(false);
      expect(await db.query('select * from public.crm_leads order by id')).toEqual(before);
      const [src] = await db.query<{ s: string }>(
        `select prosrc s from pg_proc where proname = 'integration_apply_bitrix_lead' and pronamespace = 'public'::regnamespace`,
      );
      expect(src!.s).not.toContain('deal_entry_stage_ids');
    });
  });
});

describe('CRM work: tasks, receipts and documents (review W2)', () => {
  const h = financeHelpers(() => db);

  it('a department task, a customer receipt or a booking document keeps the Deal, each named', async () => {
    await asOwner(db, async () => {
      await dealScope();
      for (const id of [31161, 31163]) await importDeal(deal(id));
      const taskDeal = (await dealRow(31161))!.id;
      const evidenceDeal = (await dealRow(31163))!.id;
      // A real receipt through Accounts' command on the synthetic fixture Deal, which is
      // then relabelled as an imported Bitrix Deal of the pilot branch (the
      // stage2-removed-deal-receipts.test.ts pattern; rolled back with the case).
      const receiptDeal = FIXTURE_DEAL;
      await h.record({ userId: U.accountsJodhpur }, receiptDeal, await h.cashFields());
      await db.exec('alter table public.deals drop constraint deals_provenance');
      await db.exec('alter table public.deals drop constraint deals_source_assigned_by_provenance');
      await db.exec('alter table public.deal_commercials drop constraint deal_commercials_synthetic_parent');
      await db.query(
        `update public.deals set is_synthetic = false, reference = 'BX-31162', source_system = 'bitrix', source_portal = $2,
           source_deal_id = 31162, source_stage_id = 'C7:NEW', source_category_id = 7,
           source_created_at = '2026-10-02T09:00:00+05:30', source_modified_at = '2026-10-02T09:00:00+05:30',
           last_synced_at = now(), last_verified_at = now(), source_assigned_by_id = 101
         where id = $1`,
        [receiptDeal, MEMBER],
      );
      // Owner inserts, as booking-policy-parity.test.ts does (no confirmation needed for the rule).
      await db.query(
        `insert into public.booking_versions (deal_id, legal_entity_id, branch_id, version_no, created_by)
         select id, legal_entity_id, branch_id, 1, owner_user_id from public.deals where id = any($1::uuid[])`,
        [[taskDeal, evidenceDeal]],
      );
      await db.query(
        `insert into public.fulfilment_tasks (deal_id, legal_entity_id, branch_id, booking_version_id, task_key, created_by)
         select deal_id, legal_entity_id, branch_id, id, 'booking:' || id || ':hotel', created_by from public.booking_versions where deal_id = $1`,
        [taskDeal],
      );
      await db.query(
        `insert into public.booking_evidence (id, version_id, deal_id, legal_entity_id, kind, object_path, file_name, mime, size_bytes, sha256, uploaded_by)
         select x.id, v.id, v.deal_id, v.legal_entity_id, 'acceptance_message', v.legal_entity_id || '/' || v.deal_id || '/' || v.id || '/' || x.id,
                'accept.pdf', 'application/pdf', 1, repeat('c', 64), v.created_by
         from public.booking_versions v cross join (select gen_random_uuid() as id) x where v.deal_id = $1`,
        [evidenceDeal],
      );
      await setList([WON]);
      const res = await prune(false);
      expect(res.pruned.count).toBe(0);
      expect(res.keptWithWork.byKind.task).toEqual([taskDeal]);
      expect(res.keptWithWork.byKind.receipt).toEqual([receiptDeal]);
      expect(res.keptWithWork.byKind.evidence).toEqual([evidenceDeal]);
      for (const id of [31161, 31162, 31163]) expect(await dealRow(id)).toMatchObject({ removed_at: null });
      expect(res.keptWithWork.deals.find((d) => d.id === receiptDeal)?.work).toEqual(expect.arrayContaining(['receipt', 'finance_record']));
    });
  });
});

describe('undoing the prune (review W1)', () => {
  it('a pruned Deal in an unticked stage comes back when the list is cleared, and stays through its next event', async () => {
    await asOwner(db, async () => {
      await dealScope();
      await importDeal(deal(31171));
      // Moved to an unticked stage after import: stored and kept by today's rule.
      expect(await importDeal(deal(31171, { stageId: 'C7:LOSE' }))).toMatchObject({ outcome: 'updated' });
      await setList([WON]);
      await prune(false);
      expect(await dealRow(31171)).toMatchObject({ removed_reason: 'outside_entry_stage', owner_user_id: null });
      const res = await setList(null);
      expect(res).toMatchObject({ changed: true, restored: 1 });
      expect(await dealRow(31171)).toMatchObject({ removed_at: null, owner_user_id: U.salesDelhiA, source_stage_id: 'C7:LOSE' });
      expect(await importDeal(deal(31171, { stageId: 'C7:LOSE', title: 'Back after rollback' }))).toMatchObject({ outcome: 'updated' });
      expect(await dealRow(31171)).toMatchObject({ removed_at: null, title: 'Back after rollback' });
    });
  });

  it('changing the list also brings back every pruned Deal (a prune belongs to the list it ran under)', async () => {
    await asOwner(db, async () => {
      await dealScope();
      await importDeal(deal(31175, { stageId: 'C7:PREPARATION' }));
      await setList([WON]);
      await prune(false);
      expect(await setList([WON, 'C7:FINAL'])).toMatchObject({ changed: true, restored: 1 });
      expect(await dealRow(31175)).toMatchObject({ removed_at: null });
    });
  });

  it('with the switch off, a pruned Deal still removed comes back through its next event or a settings save', async () => {
    await asOwner(db, async () => {
      await dealScope();
      await importDeal(deal(31181));
      await importDeal(deal(31182));
      await importDeal(deal(31181, { stageId: 'C7:LOSE' }));
      await importDeal(deal(31182, { stageId: 'C7:LOSE' }));
      await setList([WON]);
      await prune(false);
      // The list cleared outside the command (owner SQL, audited by trigger): nothing was restored.
      await db.query('update public.integration_intake_config set deal_entry_stage_ids = null where id = $1', [CONFIG]);
      expect(await dealRow(31181)).toMatchObject({ removed_reason: 'outside_entry_stage' });
      expect(await importDeal(deal(31181, { stageId: 'C7:LOSE' }))).toMatchObject({ outcome: 'updated' });
      expect(await dealRow(31181)).toMatchObject({ removed_at: null, owner_user_id: U.salesDelhiA });
      const settings = await one<{ restored: number }>(ADMIN, `select public.integration_apply_sync_settings((public.integration_preview_sync_settings($1, $2, $3, true) ->> 'previewId')::uuid, 'Test: sync settings saved through preview and apply') as r`, [
        [7], ['C7:NEW', 'C7:PREPARATION'], '2026-08-31T00:00:00+05:30',
      ]);
      expect(settings.restored).toBe(1);
      expect(await dealRow(31182)).toMatchObject({ removed_at: null, source_stage_id: 'C7:LOSE' });
    });
  });
});

describe('skipped events are checked again (review W3)', () => {
  it('changing the list requeues ignored Deal events as a settings save does', async () => {
    await asOwner(db, async () => {
      await dealScope();
      await setList([WON]);
      const rec = await record(31191);
      expect(await applyDeal(await claimOne(rec.inboxId), deal(31191))).toMatchObject({ outcome: 'ignored', reasonCode: 'not_eligible_stage' });
      const res = await setList(null);
      expect(res.requeued).toBeGreaterThanOrEqual(1);
      expect(await inbox(rec.inboxId)).toEqual({ status: 'pending', reason_code: null });
      expect((await audits('integration.deal_entry_stages_set')).at(-1)!.details).toMatchObject({ requeued: res.requeued });
    });
  });
});

describe('settings guard (review W4)', () => {
  const SETTINGS_SQL = `select public.integration_apply_sync_settings((public.integration_preview_sync_settings($1, $2, $3, true) ->> 'previewId')::uuid, 'Test: sync settings saved through preview and apply') as r`;

  it('while Won-only intake is on, a settings save cannot untick the entry stage pipeline', async () => {
    await asOwner(db, async () => {
      await setList([WON]);
      await refused(ADMIN, SETTINGS_SQL, [[1], ['C1:NEW'], '2026-09-01T00:00:00+05:30'], '22023', /^entry_stage_pipeline_required$/);
      expect(await entryList()).toEqual([WON]);
      // Keeping pipeline 7 ticked is fine.
      await one(ADMIN, SETTINGS_SQL, [[7, 1], ['C7:NEW', 'C1:NEW'], '2026-09-01T00:00:00+05:30']);
      // With the switch off, today's rule applies.
      await setList(null);
      await one(ADMIN, SETTINGS_SQL, [[1], ['C1:NEW'], '2026-09-01T00:00:00+05:30']);
    });
  });
});

describe('scope boundaries (review W5)', () => {
  it('Deals of another branch are never selected; a Super Admin of another company is refused', async () => {
    await asOwner(db, async () => {
      await dealScope();
      await importDeal(deal(31201));
      const [amd] = await db.query<{ id: string }>(
        `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic,
           source_system, source_portal, source_deal_id, source_stage_id, source_category_id, source_created_at, source_modified_at,
           last_synced_at, last_verified_at, source_assigned_by_id, intake_inbox_id)
         select b.legal_entity_id, b.id, 'BX-31202', 'Synthetic Ahmedabad deal', $1, false,
           'bitrix', $2, 31202, 'C7:NEW', 7, '2026-10-02T09:00:00+05:30', '2026-10-02T09:00:00+05:30', now(), now(), 104,
           (select d.intake_inbox_id from public.deals d where d.source_portal = $2 and d.source_deal_id = 31201)
         from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
         where e.code = 'HOLIDAY_CHACHA' and b.code = 'AMD'
         returning id`,
        [U.salesAhmedabad, MEMBER],
      );
      await setList([WON]);
      const dry = await prune(true);
      const listed = [...dry.pruned.deals, ...dry.keptWithWork.deals, ...dry.keptSyncPending.deals].map((d) => d.id);
      expect(listed).toContain((await dealRow(31201))!.id);
      expect(listed).not.toContain(amd!.id);
      await prune(false);
      expect((await db.query<{ removed_at: string | null }>('select removed_at from public.deals where id = $1', [amd!.id]))[0]!.removed_at).toBeNull();

      await db.query(
        `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
         values ($1, 'e0000000-0000-4000-8000-0000000000b0', 'b0000000-0000-4000-8000-0000000000b1', 'super_admin', 'active')`,
        [U.salesEntityB],
      );
      const OTHER: Actor = { userId: U.salesEntityB };
      await refused(OTHER, SET_SQL, [null, REASON], '42501', /^not_authorized$/);
      await refused(OTHER, PRUNE_SQL, [REASON, true], '42501', /^not_authorized$/);
    });
  });

  it('manifest mode: a manifest Deal also enters only at the entry stages', async () => {
    await asOwner(db, async () => {
      await setList([WON]);
      const onDay = { sourceId: 'SYNTHETIC_SRC', dateCreate: '2026-09-15T10:00:00+05:30' };
      expect(await importDeal(deal(6201, onDay))).toEqual({ outcome: 'ignored', dealId: null, reasonCode: 'not_eligible_stage' });
      expect(await importDeal(deal(6202, { ...onDay, stageId: WON }))).toMatchObject({ outcome: 'created' });
    });
  });

  it('Lead scope intake and its reconcile work as before with the list set', async () => {
    await asOwner(db, async () => {
      await db.query(`update public.integration_intake_config set lead_intake_mode = 'scope' where id = $1`, [CONFIG]);
      await setList([WON]);
      const rec = await one<{ inboxId: string }>(SVC, 'select public.integration_record_bitrix_event($1, $2, $3, $4) as r', [
        MEMBER, 'ONCRMLEADUPDATE', 31211, (ts += 1),
      ]);
      const item = await claimOne(rec.inboxId);
      const lead = {
        id: '31211', title: 'Synthetic won-only lead', statusId: 'NEW', sourceId: 'WEBFORM', assignedById: '101',
        dateCreate: '2026-10-02T11:00:00+05:30', dateModify: '2026-10-02T11:00:00+05:30',
      };
      expect(await one<{ outcome: string }>(SVC, 'select public.integration_apply_bitrix_lead($1, $2, $3::jsonb) as r', [
        item.inboxId, item.lockToken, JSON.stringify(lead),
      ])).toMatchObject({ outcome: 'created' });
      const enq = await one<{ inboxId: string | null; ignored?: boolean }>(
        SVC, 'select public.integration_enqueue_reconcile_lead($1, 31212, $2) as r', [MEMBER, ts + 5],
      );
      expect(enq.inboxId).not.toBeNull();
      await prune(false);
      expect(await db.query('select 1 from public.crm_leads where source_portal = $1 and source_lead_id = 31211', [MEMBER])).toHaveLength(1);
    });
  });
});

describe('CRM work from the B1.1 tables (0100 contacts and identities, 0200 claims)', () => {
  it('a reported payment, a customer contact or traveller identity details keep the Deal, each named', async () => {
    await asOwner(db, async () => {
      await dealScope();
      for (const id of [31221, 31222, 31223]) await importDeal(deal(id));
      const claimDeal = (await dealRow(31221))!.id;
      const contactDeal = (await dealRow(31222))!.id;
      const identityDeal = (await dealRow(31223))!.id;
      // Claims and contacts hang off a booking version (foreign key), so those Deals
      // also carry booking_version; identities hang off a traveller.
      await db.query(
        `insert into public.booking_versions (deal_id, legal_entity_id, branch_id, version_no, created_by)
         select id, legal_entity_id, branch_id, 1, owner_user_id from public.deals where id = any($1::uuid[])`,
        [[claimDeal, contactDeal]],
      );
      await db.query(
        `insert into public.customer_payment_claims
           (legal_entity_id, deal_id, booking_version_id, mode, amount_paise, paid_on, payer_name, reported_by, request_id)
         select v.legal_entity_id, v.deal_id, v.id, 'cash', 1500000, date '2026-10-03', 'Synthetic Payer', $2, gen_random_uuid()
         from public.booking_versions v where v.deal_id = $1`,
        [claimDeal, U.salesDelhiA],
      );
      await db.query(
        `insert into public.booking_version_contacts (booking_version_id, legal_entity_id, deal_id, contact_name, mobile, booking_for, updated_by)
         select v.id, v.legal_entity_id, v.deal_id, 'Synthetic Contact', '9876543210', 'individual', $2
         from public.booking_versions v where v.deal_id = $1`,
        [contactDeal, U.salesDelhiA],
      );
      await db.query(
        `insert into public.deal_travellers (deal_id, legal_entity_id, seq, full_name, traveller_type)
         select id, legal_entity_id, 1, 'Synthetic Traveller', 'adult' from public.deals where id = $1`,
        [identityDeal],
      );
      await db.query(
        `insert into public.traveller_identities (traveller_id, deal_id, legal_entity_id, nationality, updated_by)
         select t.id, t.deal_id, t.legal_entity_id, 'Indian', $2 from public.deal_travellers t where t.deal_id = $1`,
        [identityDeal, U.salesDelhiA],
      );
      await setList([WON]);
      for (const dryRun of [true, false]) {
        const res = await one<Prune>(ADMIN, PRUNE_SQL, [REASON, dryRun]);
        expect(res.pruned.count).toBe(0);
        expect(res.keptWithWork.byKind.claim).toEqual([claimDeal]);
        expect(res.keptWithWork.byKind.contact).toEqual([contactDeal]);
        expect(res.keptWithWork.byKind.traveller_identity).toEqual([identityDeal]);
        expect(res.keptWithWork.deals.find((d) => d.id === claimDeal)?.work).toEqual(['booking_version', 'claim']);
        expect(res.keptWithWork.deals.find((d) => d.id === contactDeal)?.work).toEqual(['booking_version', 'contact']);
        expect(res.keptWithWork.deals.find((d) => d.id === identityDeal)?.work).toEqual(['traveller_identity', 'traveller']);
      }
      for (const id of [31221, 31222, 31223]) expect(await dealRow(id)).toMatchObject({ removed_at: null });
    });
  });
});
