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
 * B1.2 (DEC-37), migration 20261120000400_b12_bitrix_trip_facts: all Leads.
 *
 * integration_intake_config.lead_intake_unowned (off by default, audited Super
 * Admin command integration_set_bitrix_read_switches): in Lead scope mode a Lead
 * whose Bitrix responsible is not an eligible pilot Sales member is stored
 * waiting for an owner (owner_user_id null) instead of ignored as
 * owner_not_eligible; the branch Manager sees it, Sales does not; linking the
 * Bitrix user later fills the owner. Off: today's behaviour.
 *
 * Synthetic fixtures only: portal SYNTHETIC_MEMBER_0001, pilot branch Delhi;
 * Bitrix 101 -> Sales Delhi A, 102 -> Sales Delhi B, 104 -> Sales Ahmedabad
 * (other branch). Every case runs in a rolled-back transaction.
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
const ADMIN_AAL1: Actor = { userId: U.adminJodhpur, aal: 'aal1' };
const MEMBER = 'SYNTHETIC_MEMBER_0001';
const REASON = 'Owner approval APPROVE, synthetic test run';
const SWITCH_SQL = 'select public.integration_set_bitrix_read_switches($1, $2, $3) as r';

interface Item {
  inboxId: string;
  lockToken: string;
}
interface LeadResult {
  outcome: string;
  leadId: string | null;
  reasonCode: string | null;
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

let ts = 1_821_000_000;
const record = (id: number) =>
  one<{ inboxId: string }>(SVC, 'select public.integration_record_bitrix_event($1, $2, $3, $4) as r', [
    MEMBER, 'ONCRMLEADUPDATE', id, (ts += 1),
  ]);
async function claimOne(inboxId: string): Promise<Item> {
  const rows = await run<{ r: Item }>(SVC, 'select r from public.integration_claim_inbox(100, 60) as r');
  const item = rows.map((x) => x.r).find((x) => x.inboxId === inboxId);
  if (!item) throw new Error('row was not claimed');
  return item;
}
async function importLead(lead: Record<string, unknown>): Promise<LeadResult & { inboxId: string }> {
  const rec = await record(Number(lead.id));
  const item = await claimOne(rec.inboxId);
  const r = await one<LeadResult>(SVC, 'select public.integration_apply_bitrix_lead($1, $2, $3::jsonb) as r', [
    item.inboxId, item.lockToken, JSON.stringify(lead),
  ]);
  return { ...r, inboxId: rec.inboxId };
}
let minute = 0;
function lead(id: number, o: Record<string, unknown> = {}): Record<string, unknown> {
  minute += 1;
  return {
    id: String(id),
    title: `Synthetic all-leads lead ${id}`,
    statusId: 'NEW',
    sourceId: 'WEBFORM',
    assignedById: '101',
    dateCreate: '2026-10-02T09:00:00+05:30',
    dateModify: `2026-10-02T${String(10 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00+05:30`,
    ...o,
  };
}
const leadRow = async (id: number) =>
  (
    await db.query<{ id: string; owner_user_id: string | null; source_assigned_by_id: string | null; intake_mode: string }>(
      `select id, owner_user_id, source_assigned_by_id::text, intake_mode from public.crm_leads
       where source_portal = $1 and source_lead_id = $2`,
      [MEMBER, id],
    )
  )[0];
const inbox = async (inboxId: string) =>
  (await db.query<{ status: string; reason_code: string | null }>('select status, reason_code from public.integration_inbox where id = $1', [inboxId]))[0];
const scopeMode = () =>
  db.query(`update public.integration_intake_config set lead_intake_mode = 'scope', cutoff_at = '2026-10-01T00:00:00+05:30' where id = $1`, [CONFIG]);
const switches = async () =>
  (await db.query<{ f: boolean; u: boolean }>('select bitrix_trip_facts_read f, lead_intake_unowned u from public.integration_intake_config'))[0]!;
const audits = (action: string) =>
  db.query<{ actor_user_id: string | null; reason: string | null; details: Record<string, unknown> }>(
    'select actor_user_id, reason, details from public.audit_events where action = $1 order by occurred_at, id',
    [action],
  );
const visibleLeadIds = async (actor: Actor) => (await run<{ id: string }>(actor, 'select id from public.crm_leads order by id')).map((r) => r.id);

describe('schema and defaults', () => {
  it('both switches start off; owner_user_id is nullable only for scope-mode Leads', async () => {
    await asOwner(db, async () => {
      expect(await switches()).toEqual({ f: false, u: false });
      const [col] = await db.query<{ is_nullable: string }>(
        `select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'crm_leads' and column_name = 'owner_user_id'`,
      );
      expect(col!.is_nullable).toBe('YES');
      await scopeMode();
      const created = await importLead(lead(71001));
      expect(created.outcome).toBe('created');
      await db.query(`update public.crm_leads set owner_user_id = null where source_lead_id = 71001`);
      await expectDbError(db, () => db.query(`update public.crm_leads set intake_mode = 'manifest' where source_lead_id = 71001`), {
        code: '23514',
        message: /crm_leads_owner_required_unless_scope|crm_leads_manifest_required/,
      });
    });
  });

  it('the Lead apply records the Bitrix responsible on every write', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      await importLead(lead(71011));
      expect(await leadRow(71011)).toMatchObject({ owner_user_id: U.salesDelhiA, source_assigned_by_id: '101' });
    });
  });
});

describe('switch off is today', () => {
  it('a scope-mode Lead of a non-pilot responsible is ignored as owner_not_eligible and not stored', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      const r = await importLead(lead(71101, { assignedById: '104' }));
      expect(r).toMatchObject({ outcome: 'ignored', leadId: null, reasonCode: 'owner_not_eligible' });
      expect(await leadRow(71101)).toBeUndefined();
      expect(await importLead(lead(71102, { assignedById: '555' }))).toMatchObject({ reasonCode: 'owner_not_eligible' });
    });
  });

  it('a stored Lead whose responsible leaves the pilot stays exactly as it was', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      await importLead(lead(71111));
      expect(await importLead(lead(71111, { assignedById: '104', title: 'changed' }))).toMatchObject({ outcome: 'ignored', reasonCode: 'owner_not_eligible' });
      expect(await leadRow(71111)).toMatchObject({ owner_user_id: U.salesDelhiA, source_assigned_by_id: '101' });
    });
  });

  it('an identical replay stays stale_ignored and the audit details keep their keys', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      const l = lead(71121);
      await importLead(l);
      expect(await importLead(l)).toMatchObject({ outcome: 'stale_ignored' });
      const [created] = await audits('integration.lead_created');
      expect(Object.keys(created!.details).sort()).toEqual(['inboxId', 'intakeMode', 'manifestId', 'origin', 'ownerChanged']);
    });
  });
});

describe('integration_set_bitrix_read_switches', () => {
  it('refuses anyone but a Super Admin at aal2, a bad reason and an empty request', async () => {
    await asOwner(db, async () => {
      for (const actor of [{ userId: U.salesDelhiA }, { userId: U.managerDelhi }, { userId: U.accountsJodhpur }, ADMIN_AAL1, SVC]) {
        await refused(actor, SWITCH_SQL, [null, true, REASON], '42501');
      }
      await refused(ADMIN, SWITCH_SQL, [null, true, 'short'], '22023');
      await refused(ADMIN, SWITCH_SQL, [null, null, REASON], '22023', /^invalid_input$/);
      expect(await switches()).toEqual({ f: false, u: false });
    });
  });

  it('sets a switch with both audit rows; the same values again change nothing', async () => {
    await asOwner(db, async () => {
      const res = await one(ADMIN, SWITCH_SQL, [null, true, REASON]);
      expect(res).toEqual({
        changed: true, before: { tripFactsRead: false, leadIntakeUnowned: false },
        after: { tripFactsRead: false, leadIntakeUnowned: true }, requeued: 0, notRequeued: 0,
      });
      expect(await switches()).toEqual({ f: false, u: true });
      const trigger = (await audits('settings.intake_config_changed')).find((a) => a.details.command === 'integration_set_bitrix_read_switches');
      expect(trigger).toMatchObject({ actor_user_id: U.adminJodhpur, reason: REASON });
      expect(trigger!.details).toMatchObject({ changes: { lead_intake_unowned: { from: false, to: true } } });
      const [own] = await audits('integration.bitrix_read_switches_set');
      expect(own).toMatchObject({ actor_user_id: U.adminJodhpur, reason: REASON });
      expect(await one(ADMIN, SWITCH_SQL, [false, true, REASON])).toMatchObject({ changed: false, requeued: 0 });
      expect(await audits('integration.bitrix_read_switches_set')).toHaveLength(1);
    });
  });

  it('turning lead_intake_unowned on hands back only the latest skipped event of each Lead', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      // Three skipped events for one Lead, one for another.
      const older = await importLead(lead(71201, { assignedById: '104' }));
      await importLead(lead(71201, { assignedById: '104' }));
      const latest = await importLead(lead(71201, { assignedById: '104' }));
      const other = await importLead(lead(71202, { assignedById: '555' }));
      expect(await inbox(latest.inboxId)).toEqual({ status: 'ignored', reason_code: 'owner_not_eligible' });
      expect(await one(ADMIN, SWITCH_SQL, [null, true, REASON])).toMatchObject({ changed: true, requeued: 2, notRequeued: 0 });
      expect(await inbox(latest.inboxId)).toEqual({ status: 'pending', reason_code: null });
      expect(await inbox(other.inboxId)).toEqual({ status: 'pending', reason_code: null });
      expect(await inbox(older.inboxId)).toEqual({ status: 'ignored', reason_code: 'owner_not_eligible' });
      // Exactly one row per Lead was handed back, whatever the row ids (received_at ties inside one transaction).
      const pending = await db.query<{ source_deal_id: string; n: number }>(
        `select source_deal_id::text, count(*)::int as n from public.integration_inbox
         where portal_member_id = $1 and source_object = 'lead' and status = 'pending' group by source_deal_id order by 1`,
        [MEMBER],
      );
      expect(pending).toEqual([{ source_deal_id: '71201', n: 1 }, { source_deal_id: '71202', n: 1 }]);
      const [own] = await audits('integration.bitrix_read_switches_set');
      expect(own!.details).toMatchObject({ requeued: 2, notRequeued: 0 });
      // Turning it off deletes and requeues nothing.
      expect(await one(ADMIN, SWITCH_SQL, [null, false, REASON])).toMatchObject({ changed: true, requeued: 0 });
    });
  });
});

describe('switch on: Leads waiting for an owner', () => {
  const on = () => db.query('update public.integration_intake_config set lead_intake_unowned = true where id = $1', [CONFIG]);

  it('stores the Lead without an owner; Manager sees it, Sales and Purchase do not', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      await on();
      const r = await importLead(lead(71301, { assignedById: '104' }));
      expect(r).toMatchObject({ outcome: 'created', reasonCode: null });
      const row = await leadRow(71301);
      expect(row).toMatchObject({ owner_user_id: null, source_assigned_by_id: '104', intake_mode: 'scope' });
      const [created] = await audits('integration.lead_created');
      expect(created!.details).toMatchObject({ waitingForOwner: true });

      expect(await visibleLeadIds({ userId: U.managerDelhi })).toContain(row!.id);
      expect(await visibleLeadIds({ userId: U.salesDelhiA })).not.toContain(row!.id);
      expect(await visibleLeadIds({ userId: U.salesAhmedabad })).not.toContain(row!.id);
      expect(await visibleLeadIds({ userId: U.purchaseJodhpur })).toEqual([]);
      expect(await visibleLeadIds({ userId: U.managerAhmedabad })).not.toContain(row!.id);
    });
  });

  it('a stored Lead with an owner keeps it when its responsible leaves the pilot (E1-3); a mapped responsible still moves it', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      await on();
      await importLead(lead(71311));
      expect(await importLead(lead(71311, { assignedById: '555', title: 'changed' }))).toMatchObject({
        outcome: 'ignored', reasonCode: 'owner_not_eligible',
      });
      expect(await leadRow(71311)).toMatchObject({ owner_user_id: U.salesDelhiA, source_assigned_by_id: '101' });
      expect(await importLead(lead(71311, { assignedById: '102' }))).toMatchObject({ outcome: 'updated' });
      expect(await leadRow(71311)).toMatchObject({ owner_user_id: U.salesDelhiB, source_assigned_by_id: '102' });
    });
  });

  it('a Lead waiting for an owner stays waiting when its responsible changes to another non-pilot person', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      await on();
      await importLead(lead(71315, { assignedById: '555' }));
      expect(await importLead(lead(71315, { assignedById: '104' }))).toMatchObject({ outcome: 'updated' });
      expect(await leadRow(71315)).toMatchObject({ owner_user_id: null, source_assigned_by_id: '104' });
    });
  });

  it('an unowned replay with a different responsible is applied, not stale', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      await on();
      const first = lead(71321, { assignedById: '555' });
      await importLead(first);
      expect(await importLead(first)).toMatchObject({ outcome: 'stale_ignored' });
      expect(await importLead({ ...first, assignedById: '556' })).toMatchObject({ outcome: 'updated' });
      expect(await leadRow(71321)).toMatchObject({ owner_user_id: null, source_assigned_by_id: '556' });
    });
  });

  it('linking the Bitrix user to an eligible Sales member fills the owner (audited, counts only)', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      await on();
      await importLead(lead(71331, { assignedById: '150' }));
      expect(await leadRow(71331)).toMatchObject({ owner_user_id: null });
      // Sales Delhi B moves from Bitrix user 102 to 150.
      await db.query(`update public.bitrix_user_mappings set active = false where portal_member_id = $1 and bitrix_user_id = 102`, [MEMBER]);
      await db.query(`insert into public.bitrix_user_mappings (portal_member_id, bitrix_user_id, staff_user_id, active) values ($1, 150, $2, true)`, [
        MEMBER, U.salesDelhiB,
      ]);
      await db.query(`select authz.reassign_bitrix_user_deals($1, 150, 'linked')`, [MEMBER]);
      expect(await leadRow(71331)).toMatchObject({ owner_user_id: U.salesDelhiB });
      const [filled] = await audits('integration.lead_owners_filled');
      expect(filled!.details).toEqual({ bitrixUserId: 150, ownerUserId: U.salesDelhiB, leadsFilled: 1, cause: 'linked' });
    });
  });

  it('with the switch off, linking fills nothing (Leads keep today\'s rule)', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      await on();
      await importLead(lead(71341, { assignedById: '151' }));
      await db.query('update public.integration_intake_config set lead_intake_unowned = false where id = $1', [CONFIG]);
      await db.query(`update public.bitrix_user_mappings set active = false where portal_member_id = $1 and bitrix_user_id = 102`, [MEMBER]);
      await db.query(`insert into public.bitrix_user_mappings (portal_member_id, bitrix_user_id, staff_user_id, active) values ($1, 151, $2, true)`, [
        MEMBER, U.salesDelhiB,
      ]);
      await db.query(`select authz.reassign_bitrix_user_deals($1, 151, 'linked')`, [MEMBER]);
      expect(await leadRow(71341)).toMatchObject({ owner_user_id: null });
      expect(await audits('integration.lead_owners_filled')).toEqual([]);
    });
  });

  it('manifest mode is unchanged: an unmapped responsible is still held for review', async () => {
    await asOwner(db, async () => {
      await on();
      await one(
        SVC,
        'select public.integration_manifest_create($1, $2, $3, $4::date, $5::timestamptz, $6::timestamptz, $7::bigint[], $8) as r',
        [CONFIG, 'lead', 'WEBFORM', '2026-10-02', '2026-10-02T00:00:00+05:30', '2026-10-03T00:00:00+05:30', [71401], 'test-suite'],
      );
      expect(await importLead(lead(71401, { assignedById: '555' }))).toMatchObject({ outcome: 'needs_review', reasonCode: 'unmapped_owner' });
      expect(await leadRow(71401)).toBeUndefined();
    });
  });
});
