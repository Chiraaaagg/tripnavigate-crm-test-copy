import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * Stage 6, lead decision (8 October 2026, night) on top of the sync completion
 * contract: Deal scope mode in migration 20261111000100_sync_completion.
 *
 * integration_intake_config.deal_intake_mode = 'scope': Deal events and Deal
 * reconcile need no manifest, and the Deal apply skips only the manifest membership,
 * source code and interval checks. Every other gate stays: pipeline, entry stage for
 * new Deals, sync date, the Sales-owner hold (I01), soft removal and the stale rule.
 * 'manifest' (the default) keeps today's behaviour exactly.
 *
 * Synthetic fixtures only: portal SYNTHETIC_MEMBER_0001, pipeline 7, stages C7:NEW and
 * C7:PREPARATION, sync date 2026-09-01, Deal manifest 5000-9999 (SYNTHETIC_SRC,
 * 2026-09-15 IST); Bitrix 101 -> Sales Delhi A, 104 -> Sales Ahmedabad (other branch).
 * Deal ids 12000+ are outside every manifest. Rolled back per case.
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

interface Result {
  outcome: string;
  dealId: string | null;
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

let ts = 1_803_000_000;
const record = (id: number) =>
  one<{ inboxId: string; duplicate: boolean }>(SVC, 'select public.integration_record_bitrix_event($1, $2, $3, $4) as r', [
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

/** A live Deal created after the pilot start: no manifest, no SOURCE_ID requirement. */
function deal(id: number, o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: String(id),
    title: `Synthetic scope deal ${id}`,
    stageId: 'C7:NEW',
    categoryId: '7',
    assignedById: '101',
    dateCreate: '2026-10-02T10:00:00+05:30',
    dateModify: '2026-10-02T10:00:00+05:30',
    leadId: '',
    ...o,
  };
}
const dealRow = async (id: number) =>
  (
    await db.query<{ id: string; title: string; owner_user_id: string | null; removed_reason: string | null; source_stage_id: string }>(
      `select id, title, owner_user_id, removed_reason, source_stage_id from public.deals where source_portal = $1 and source_deal_id = $2`,
      [MEMBER, id],
    )
  )[0];
const inbox = async (inboxId: string) =>
  (await db.query<{ status: string; reason_code: string | null }>('select status, reason_code from public.integration_inbox where id = $1', [inboxId]))[0];
const dealScope = () => db.query(`update public.integration_intake_config set deal_intake_mode = 'scope' where id = $1`, [CONFIG]);

describe('manifest mode (default) is unchanged', () => {
  it('starts in manifest mode; a Deal outside the manifest is ignored at the receiver, the reconcile and the apply', async () => {
    await asOwner(db, async () => {
      expect(await db.query('select deal_intake_mode from public.integration_intake_config')).toEqual([{ deal_intake_mode: 'manifest' }]);
      const rec = await record(12001);
      expect(await inbox(rec.inboxId)).toEqual({ status: 'ignored', reason_code: 'not_in_manifest' });
      expect(await one(SVC, 'select public.integration_enqueue_reconcile($1, 12001, $2) as r', [MEMBER, ts++])).toMatchObject({
        inboxId: null, ignored: true, reasonCode: 'not_in_manifest',
      });
      expect(await dealRow(12001)).toBeUndefined();
      // Inside the manifest: the source code and creation interval still apply.
      expect(await importDeal(deal(6101, { sourceId: 'SYNTHETIC_SRC' }))).toEqual({
        outcome: 'needs_review', dealId: null, reasonCode: 'outside_manifest_scope',
      });
      expect(await importDeal(deal(6102, { sourceId: 'OTHER', dateCreate: '2026-09-15T10:00:00+05:30', dateModify: '2026-09-15T10:00:00+05:30' }))).toMatchObject({
        reasonCode: 'outside_manifest_scope',
      });
      expect(await importDeal(deal(6103, { sourceId: 'SYNTHETIC_SRC', dateCreate: '2026-09-15T10:00:00+05:30', dateModify: '2026-09-15T10:00:00+05:30' }))).toMatchObject({
        outcome: 'created',
      });
    });
  });
});

describe('Deal scope mode', () => {
  it('records, enqueues and stores a Deal that is in no manifest (no SOURCE_ID needed)', async () => {
    await asOwner(db, async () => {
      await dealScope();
      // Even with the Deal manifest closed.
      const [active] = await db.query<{ id: string }>(`select id from public.intake_manifests where source_object = 'deal' and status = 'active'`);
      await run(SVC, 'select public.integration_manifest_close($1, $2)', [active!.id, 'test-suite']);
      const rec = await record(12101);
      expect(await inbox(rec.inboxId)).toEqual({ status: 'pending', reason_code: null });
      const res = await applyDeal(await claimOne(rec.inboxId), deal(12101));
      expect(res).toMatchObject({ outcome: 'created', reasonCode: null });
      expect(await dealRow(12101)).toMatchObject({ owner_user_id: U.salesDelhiA, removed_reason: null });
      const [audit] = await db.query<{ d: { manifestId: string | null; intakeMode: string } }>(
        `select details as d from public.audit_events where action = 'integration.deal_created' and target_id = $1`,
        [res.dealId],
      );
      expect(audit!.d).toMatchObject({ manifestId: null, intakeMode: 'scope' });
      // Reconcile: queues an unknown Deal, confirms a stored up-to-date one.
      expect(await one(SVC, 'select public.integration_enqueue_reconcile($1, 12102, $2) as r', [MEMBER, ts++])).toMatchObject({
        ignored: false, duplicate: false,
      });
      const modified = Date.parse('2026-10-02T04:30:00Z') / 1000;
      expect(await one(SVC, 'select public.integration_enqueue_reconcile($1, 12101, $2) as r', [MEMBER, modified])).toMatchObject({
        inboxId: null, upToDate: true, ignored: false,
      });
    });
  });

  it('still refuses Deals before the sync date, in another pipeline or an unticked entry stage (nothing stored)', async () => {
    await asOwner(db, async () => {
      await dealScope();
      const cases: Array<[number, Record<string, unknown>, string]> = [
        [12201, { dateCreate: '2026-08-20T10:00:00+05:30' }, 'before_cutoff'],
        [12202, { categoryId: '9', stageId: 'C9:NEW' }, 'not_eligible_category'],
        [12203, { stageId: 'C7:WON' }, 'not_eligible_stage'],
      ];
      for (const [id, o, reason] of cases) {
        expect(await importDeal(deal(id, o)), reason).toEqual({ outcome: 'ignored', dealId: null, reasonCode: reason });
        expect(await dealRow(id)).toBeUndefined();
      }
    });
  });

  it('holds a Deal whose responsible is not an eligible pilot Sales member (I01)', async () => {
    await asOwner(db, async () => {
      await dealScope();
      await db.query(`insert into public.bitrix_user_mappings (portal_member_id, bitrix_user_id, staff_user_id, active) values ($1, 150, $2, true)`, [
        MEMBER, U.managerDelhi,
      ]);
      const cases: Array<[number, string, string]> = [
        [12301, '777', 'unmapped_owner'],
        [12302, '104', 'owner_not_in_pilot_branch'],
        [12303, '150', 'owner_not_in_pilot_branch'],
      ];
      for (const [id, assignedById, reason] of cases) {
        const rec = await record(id);
        expect(await applyDeal(await claimOne(rec.inboxId), deal(id, { assignedById })), reason).toEqual({
          outcome: 'needs_review', dealId: null, reasonCode: reason,
        });
        expect(await inbox(rec.inboxId)).toEqual({ status: 'needs_review', reason_code: reason });
        expect(await dealRow(id)).toBeUndefined();
      }
    });
  });

  it('keeps the stored-Deal rules: later stage moves follow, another pipeline removes, older data is stale', async () => {
    await asOwner(db, async () => {
      await dealScope();
      expect(await importDeal(deal(12401))).toMatchObject({ outcome: 'created' });
      expect(await importDeal(deal(12401, { stageId: 'C7:WON', dateModify: '2026-10-02T11:00:00+05:30' }))).toMatchObject({ outcome: 'updated' });
      expect((await dealRow(12401))!.source_stage_id).toBe('C7:WON');
      expect(await importDeal(deal(12401, { title: 'Older', dateModify: '2026-10-02T10:30:00+05:30' }))).toMatchObject({ outcome: 'stale_ignored' });
      expect((await dealRow(12401))!.title).toBe('Synthetic scope deal 12401');
      expect(await importDeal(deal(12401, { categoryId: '9', stageId: 'C9:NEW', dateModify: '2026-10-02T12:00:00+05:30' }))).toMatchObject({
        outcome: 'updated',
      });
      expect(await dealRow(12401)).toMatchObject({ removed_reason: 'pipeline_not_eligible', owner_user_id: null });
    });
  });

  it('a Lead in scope mode does not open Deals, and Deal scope does not open Leads', async () => {
    await asOwner(db, async () => {
      await dealScope();
      const rec = await one<{ inboxId: string }>(SVC, 'select public.integration_record_bitrix_event($1, $2, $3, $4) as r', [
        MEMBER, 'ONCRMLEADUPDATE', 12501, (ts += 1),
      ]);
      expect(await inbox(rec.inboxId)).toEqual({ status: 'ignored', reason_code: 'not_in_manifest' });
    });
  });
});

describe('settings: p_deal_intake_mode', () => {
  const mode = async () =>
    (await db.query<{ d: string; l: string }>('select deal_intake_mode as d, lead_intake_mode as l from public.integration_intake_config'))[0];
  // Batch 4: saving goes through preview + apply with a reason (one statement).
  const SAVE = `array[7]::bigint[], array['C7:NEW','C7:PREPARATION'], '2026-09-01T00:00:00+05:30', false`;
  const save = (extra: string) =>
    `select public.integration_apply_sync_settings((public.integration_preview_sync_settings(${SAVE}${extra}) ->> 'previewId')::uuid, 'Test: sync settings saved through preview and apply') as r`;

  it('review M1: a mode change alone queues a full resync; saving the same settings does not', async () => {
    await asOwner(db, async () => {
      await run(ADMIN, save(``)); // normalises the fixture sync date
      expect(await one(ADMIN, save(``))).toMatchObject({ resyncQueued: false });
      expect(await one(ADMIN, save(`, 'scope'`))).toMatchObject({ resyncQueued: true });
      expect(await one(ADMIN, save(`, 'scope'`))).toMatchObject({ resyncQueued: false });
      expect(await one(ADMIN, save(`, null, 'scope'`))).toMatchObject({ resyncQueued: true });
      const jobs = await db.query<{ reason: string; status: string }>(
        `select reason, status from public.integration_resync_jobs order by created_at, id`,
      );
      expect(jobs.filter((j) => j.status === 'queued')).toHaveLength(1);
    });
  });

  it('review M1: switching to scope re-queues the newest not_in_manifest row per record from the sync date, per object type', async () => {
    await asOwner(db, async () => {
      const recordAs = (event: string, id: number) =>
        one<{ inboxId: string }>(SVC, 'select public.integration_record_bitrix_event($1, $2, $3, $4) as r', [MEMBER, event, id, (ts += 1)]);
      const older = await recordAs('ONCRMLEADUPDATE', 12601);
      const newest = await recordAs('ONCRMLEADUPDATE', 12601);
      const other = await recordAs('ONCRMLEADADD', 12602);
      const beforeDate = await recordAs('ONCRMLEADADD', 12603);
      const deal = await recordAs('ONCRMDEALUPDATE', 12611);
      // Received before the sync date: stays ignored.
      await db.query(`update public.integration_inbox set received_at = timestamptz '2026-08-01T00:00:00Z' where id = $1`, [beforeDate.inboxId]);
      await db.query(`update public.integration_inbox set received_at = now() - interval '1 minute' where id = $1`, [older.inboxId]);
      for (const r of [older, newest, other, beforeDate, deal]) expect(await inbox(r.inboxId)).toEqual({ status: 'ignored', reason_code: 'not_in_manifest' });

      expect(await one(ADMIN, save(`, 'scope'`))).toMatchObject({ scopeRequeuedLeads: 2, scopeRequeuedDeals: 0 });
      expect(await inbox(newest.inboxId)).toEqual({ status: 'pending', reason_code: null });
      expect(await inbox(other.inboxId)).toEqual({ status: 'pending', reason_code: null });
      expect(await inbox(older.inboxId)).toEqual({ status: 'ignored', reason_code: 'not_in_manifest' });
      expect(await inbox(beforeDate.inboxId)).toEqual({ status: 'ignored', reason_code: 'not_in_manifest' });
      expect(await inbox(deal.inboxId)).toEqual({ status: 'ignored', reason_code: 'not_in_manifest' });
      // Staying in scope re-queues nothing more; switching Deals re-queues the Deal row.
      expect(await one(ADMIN, save(`, 'scope'`))).toMatchObject({ scopeRequeuedLeads: 0, scopeRequeuedDeals: 0 });
      expect(await one(ADMIN, save(`, null, 'scope'`))).toMatchObject({ scopeRequeuedLeads: 0, scopeRequeuedDeals: 1 });
      expect(await inbox(deal.inboxId)).toEqual({ status: 'pending', reason_code: null });
      const audits = await db.query<{ d: { scopeRequeuedLeads: number; scopeRequeuedDeals: number } }>(
        `select details as d from public.audit_events where action = 'integration.settings_updated' order by id`,
      );
      expect(audits.map((a) => [a.d.scopeRequeuedLeads, a.d.scopeRequeuedDeals])).toEqual([[2, 0], [0, 0], [0, 1]]);
    });
  });

  it('sets, keeps on null (and on 4- and 5-argument calls), refuses anything else; audited', async () => {
    await asOwner(db, async () => {
      expect(await one(ADMIN, save(`, null, 'scope'`))).toMatchObject({ dealIntakeMode: 'scope', leadIntakeMode: 'manifest' });
      expect(await mode()).toEqual({ d: 'scope', l: 'manifest' });
      await run(ADMIN, save(``));
      await run(ADMIN, save(`, 'scope'`));
      expect(await mode()).toEqual({ d: 'scope', l: 'scope' });
      await run(ADMIN, save(`, null, null`));
      expect(await mode()).toEqual({ d: 'scope', l: 'scope' });
      expect(await one(ADMIN, save(`, 'manifest', 'manifest'`))).toMatchObject({ dealIntakeMode: 'manifest', leadIntakeMode: 'manifest' });
      expect(await mode()).toEqual({ d: 'manifest', l: 'manifest' });
      await expectDbError(db, () => run(ADMIN, save(`, null, 'all'`)), { code: '22023', message: /invalid Deal intake mode/ });
      const audits = await db.query<{ d: { previousDealIntakeMode: string; dealIntakeMode: string } }>(
        `select details as d from public.audit_events where action = 'integration.settings_updated' order by id`,
      );
      expect(audits.map((a) => [a.d.previousDealIntakeMode, a.d.dealIntakeMode])).toEqual([
        ['manifest', 'scope'], ['scope', 'scope'], ['scope', 'scope'], ['scope', 'scope'], ['scope', 'manifest'],
      ]);
    });
  });
});
