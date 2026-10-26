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
 * Stage 6 (sync completion contract 2026-10-08, sections 2 and 7), migration
 * 20261111000100_sync_completion: live Lead intake in scope mode.
 *
 * integration_intake_config.lead_intake_mode = 'scope': the receiver records every
 * Lead event without a manifest; the Lead apply stores a Lead when DATE_CREATE is
 * on/after the sync date and the Bitrix responsible maps to an eligible Sales member
 * of the pilot branch, else holds it (needs_review / owner_not_eligible). Lead status
 * does not limit intake. 'manifest' (the default) keeps today's behaviour exactly.
 *
 * Synthetic fixtures only: portal SYNTHETIC_MEMBER_0001 (.test), pilot branch Delhi;
 * Bitrix 101 -> Sales Delhi A, 102 -> Sales Delhi B, 104 -> Sales Ahmedabad (other
 * branch), 108 -> former staff, 109 -> moved staff. Every case runs in a rolled-back
 * transaction.
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
const CUTOFF = '2026-10-01T00:00:00+05:30';

interface Lead {
  id: string;
  title: string;
  statusId: string;
  sourceId: string | null;
  assignedById: string;
  dateCreate: string;
  dateModify: string;
}
interface LeadResult {
  outcome: string;
  leadId: string | null;
  reasonCode: string | null;
}
interface Item {
  inboxId: string;
  lockToken: string;
  sourceObject: string;
}
interface LeadRow {
  id: string;
  title: string;
  owner_user_id: string;
  source_status_id: string;
  source_id_code: string;
  manifest_id: string | null;
  intake_mode: string;
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

let ts = 1_801_000_000;
const record = (id: number, event = 'ONCRMLEADUPDATE', at = (ts += 1)) =>
  one<{ inboxId: string; duplicate: boolean }>(SVC, 'select public.integration_record_bitrix_event($1, $2, $3, $4) as r', [
    MEMBER, event, id, at,
  ]);
async function claimOne(inboxId: string): Promise<Item> {
  const rows = await run<{ r: Item }>(SVC, 'select r from public.integration_claim_inbox(100, 60) as r');
  const item = rows.map((x) => x.r).find((x) => x.inboxId === inboxId);
  if (!item) throw new Error('row was not claimed');
  return item;
}
const applyLead = (item: Item, lead: Lead | Record<string, unknown> | null) =>
  one<LeadResult>(SVC, 'select public.integration_apply_bitrix_lead($1, $2, $3::jsonb) as r', [
    item.inboxId, item.lockToken, lead === null ? null : JSON.stringify(lead),
  ]);
async function importLead(lead: Lead | Record<string, unknown>): Promise<LeadResult> {
  const rec = await record(Number(lead.id));
  return applyLead(await claimOne(rec.inboxId), lead);
}

function lead(id: number, o: Partial<Lead> = {}): Lead {
  return {
    id: String(id),
    title: `Synthetic scope lead ${id}`,
    statusId: 'NEW',
    sourceId: 'WEBFORM',
    assignedById: '101',
    dateCreate: '2026-10-02T11:00:00+05:30',
    dateModify: '2026-10-02T11:00:00+05:30',
    ...o,
  };
}

const leadRow = async (id: number) =>
  (
    await db.query<LeadRow>(
      `select id, title, owner_user_id, source_status_id, source_id_code, manifest_id, intake_mode
       from public.crm_leads where source_portal = $1 and source_lead_id = $2`,
      [MEMBER, id],
    )
  )[0];
const inbox = async (inboxId: string) =>
  (await db.query<{ status: string; reason_code: string | null }>('select status, reason_code from public.integration_inbox where id = $1', [inboxId]))[0];
const countLeads = async () => Number((await db.query<{ n: number }>('select count(*)::int as n from public.crm_leads'))[0]!.n);

/** Scope mode with a 1 October 2026 IST sync date (owner set; settings command tested separately). */
async function scopeMode(): Promise<void> {
  await db.query(`update public.integration_intake_config set lead_intake_mode = 'scope', cutoff_at = $2 where id = $1`, [CONFIG, CUTOFF]);
}
const mapBitrix = (bitrixUserId: number, staff: string) =>
  db.query(`insert into public.bitrix_user_mappings (portal_member_id, bitrix_user_id, staff_user_id, active) values ($1, $2, $3, true)`, [
    MEMBER, bitrixUserId, staff,
  ]);

describe('schema and defaults', () => {
  it('the fixture portal starts in manifest mode; only manifest | scope are accepted', async () => {
    await asOwner(db, async () => {
      expect(await db.query('select lead_intake_mode from public.integration_intake_config')).toEqual([{ lead_intake_mode: 'manifest' }]);
      await expectDbError(db, () => db.query(`update public.integration_intake_config set lead_intake_mode = 'all'`), { code: '23514' });
    });
  });

  it('a Lead without a manifest must be a scope-mode Lead (crm_leads_manifest_required)', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      expect(await importLead(lead(61001))).toMatchObject({ outcome: 'created' });
      await expectDbError(db, () => db.query(`update public.crm_leads set intake_mode = 'manifest' where source_lead_id = 61001`), {
        code: '23514',
        message: /crm_leads_manifest_required/,
      });
    });
  });

  it('owner_not_eligible is an accepted inbox reason', async () => {
    const [row] = await db.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'integration_inbox_reason_code_check'`,
    );
    const def = row!.def;
    expect(def).toContain('owner_not_eligible');
    expect(def).toContain('not_in_manifest');
  });
});

describe('manifest mode is unchanged', () => {
  it('a Lead event outside a manifest is recorded as ignored / not_in_manifest and never stored', async () => {
    await asOwner(db, async () => {
      const rec = await record(61101);
      expect(rec.duplicate).toBe(false);
      expect(await inbox(rec.inboxId)).toEqual({ status: 'ignored', reason_code: 'not_in_manifest' });
      expect(await countLeads()).toBe(0);
      // Lead reconcile is refused the same way.
      expect(await one(SVC, 'select public.integration_enqueue_reconcile_lead($1, 61101, 1801000000) as r', [MEMBER])).toMatchObject({
        inboxId: null, ignored: true, reasonCode: 'not_in_manifest',
      });
    });
  });

  it('a manifest Lead is still imported with its manifest and intake_mode manifest', async () => {
    await asOwner(db, async () => {
      const m = await one<{ manifestId: string }>(
        SVC,
        'select public.integration_manifest_create($1, $2, $3, $4::date, $5::timestamptz, $6::timestamptz, $7::bigint[], $8) as r',
        [CONFIG, 'lead', 'WEBFORM', '2026-10-02', '2026-10-02T00:00:00+05:30', '2026-10-03T00:00:00+05:30', [61111], 'test-suite'],
      );
      expect(await importLead(lead(61111))).toMatchObject({ outcome: 'created' });
      expect(await leadRow(61111)).toMatchObject({ manifest_id: m.manifestId, intake_mode: 'manifest', owner_user_id: U.salesDelhiA });
      // Outside the manifest scope (source code) is still held, and the owner rule keeps its manifest reasons.
      expect(await importLead(lead(61111, { sourceId: 'CALL', dateModify: '2026-10-02T12:00:00+05:30' }))).toMatchObject({
        outcome: 'needs_review', reasonCode: 'outside_manifest_scope',
      });
      expect(await importLead(lead(61111, { assignedById: '104', dateModify: '2026-10-02T12:00:00+05:30' }))).toMatchObject({
        outcome: 'needs_review', reasonCode: 'owner_not_in_pilot_branch',
      });
    });
  });
});

describe('scope mode: receiver and reconcile', () => {
  it('records Lead events without a manifest; Deal events keep the Deal manifest gate', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      const rec = await record(61201, 'ONCRMLEADADD');
      expect(await inbox(rec.inboxId)).toEqual({ status: 'pending', reason_code: null });
      // A repeat delivery coalesces into the pending row.
      expect(await record(61201, 'ONCRMLEADUPDATE')).toEqual({ inboxId: rec.inboxId, duplicate: true });
      // A Deal outside the fixture Deal manifest (5000-9999) is still ignored.
      const deal = await record(12001, 'ONCRMDEALUPDATE');
      expect(await inbox(deal.inboxId)).toEqual({ status: 'ignored', reason_code: 'not_in_manifest' });
    });
  });

  it('Lead reconcile enqueues without a manifest and confirms a stored, up-to-date Lead', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      const queued = await one<{ inboxId: string | null; ignored: boolean; duplicate: boolean }>(
        SVC, 'select public.integration_enqueue_reconcile_lead($1, 61211, $2) as r', [MEMBER, ts++],
      );
      expect(queued).toMatchObject({ ignored: false, duplicate: false });
      expect(await inbox(queued.inboxId!)).toEqual({ status: 'pending', reason_code: null });
      const item = await claimOne(queued.inboxId!);
      expect(await applyLead(item, lead(61211))).toMatchObject({ outcome: 'created' });
      const modified = Date.parse('2026-10-02T05:30:00Z') / 1000;
      expect(await one(SVC, 'select public.integration_enqueue_reconcile_lead($1, 61211, $2) as r', [MEMBER, modified])).toMatchObject({
        inboxId: null, upToDate: true, ignored: false,
      });
    });
  });
});

describe('scope mode: accept rules', () => {
  it('stores a Lead of an eligible pilot Sales owner created on/after the sync date, without a manifest', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      const rec = await record(61301, 'ONCRMLEADADD');
      const res = await applyLead(await claimOne(rec.inboxId), lead(61301));
      expect(res).toMatchObject({ outcome: 'created', reasonCode: null });
      expect(await leadRow(61301)).toMatchObject({
        id: res.leadId, owner_user_id: U.salesDelhiA, source_id_code: 'WEBFORM', manifest_id: null, intake_mode: 'scope',
      });
      expect(await inbox(rec.inboxId)).toEqual({ status: 'processed', reason_code: null });
      const audit = await db.query<{ details: { intakeMode: string; manifestId: string | null } }>(
        `select details from public.audit_events where action = 'integration.lead_created' and target_id = $1`,
        [res.leadId],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.details).toMatchObject({ intakeMode: 'scope', manifestId: null });
    });
  });

  it('the sync date is the entry rule: before it is ignored (nothing stored), exactly at it is accepted', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      const early = await record(61311);
      expect(await applyLead(await claimOne(early.inboxId), lead(61311, {
        dateCreate: '2026-09-30T23:59:59+05:30', dateModify: '2026-10-02T10:00:00+05:30',
      }))).toEqual({ outcome: 'ignored', leadId: null, reasonCode: 'before_cutoff' });
      expect(await inbox(early.inboxId)).toEqual({ status: 'ignored', reason_code: 'before_cutoff' });
      expect(await leadRow(61311)).toBeUndefined();
      expect(await importLead(lead(61312, { dateCreate: CUTOFF, dateModify: CUTOFF }))).toMatchObject({ outcome: 'created' });
    });
  });

  it('Lead status does not limit intake', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      for (const [i, statusId] of ['CONVERTED', 'JUNK', 'IN_PROCESS', 'UC_SYNTH1'].entries()) {
        expect(await importLead(lead(61321 + i, { statusId }))).toMatchObject({ outcome: 'created' });
      }
      expect(await countLeads()).toBe(4);
    });
  });

  it('an empty or absent SOURCE_ID is stored as NONE; other codes are normalised to the stored format (Stage 6b)', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      expect(await importLead(lead(61331, { sourceId: null }))).toMatchObject({ outcome: 'created' });
      expect(await importLead(lead(61332, { sourceId: '' }))).toMatchObject({ outcome: 'created' });
      const absent: Record<string, unknown> = { ...lead(61333) };
      delete absent.sourceId;
      expect(await importLead(absent)).toMatchObject({ outcome: 'created' });
      for (const id of [61331, 61332, 61333]) expect((await leadRow(id))!.source_id_code).toBe('NONE');
      // Stage 6b (20261112000100): Bitrix open-channel codes ("1|WHATSAPP") and other
      // characters are normalised instead of holding the Lead; 50 characters at most.
      expect(await importLead(lead(61334, { sourceId: 'WEB FORM' }))).toMatchObject({ outcome: 'created' });
      expect((await leadRow(61334))!.source_id_code).toBe('WEB_FORM');
      expect(await importLead(lead(61335, { sourceId: '1|WHATSAPP' }))).toMatchObject({ outcome: 'created' });
      expect((await leadRow(61335))!.source_id_code).toBe('1:WHATSAPP');
      expect(await importLead(lead(61336, { sourceId: 'X'.repeat(80) }))).toMatchObject({ outcome: 'created' });
      expect((await leadRow(61336))!.source_id_code).toBe('X'.repeat(50));
    });
  });

  it('a title longer than 200 characters is stored cut to 200 in scope mode (Stage 6b)', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      const long = `Synthetic long title ${'x'.repeat(300)}`;
      expect(await importLead(lead(61337, { title: long }))).toMatchObject({ outcome: 'created' });
      const row = (await leadRow(61337))!;
      expect(row.title).toHaveLength(200);
      expect(row.title.endsWith('...')).toBe(true);
      // A repeat with the same DATE_MODIFY changes nothing (stale rule), and the stored copy stays cut.
      expect(await importLead(lead(61337, { title: long }))).toMatchObject({ outcome: 'stale_ignored' });
      expect((await leadRow(61337))!.title).toHaveLength(200);
      // Empty titles are still invalid.
      expect(await importLead(lead(61338, { title: '   ' }))).toMatchObject({ outcome: 'needs_review', reasonCode: 'invalid_source_data' });
    });
  });

  it('manifest mode keeps the strict title and source code rules (Stage 6b)', async () => {
    await asOwner(db, async () => {
      await one(SVC, 'select public.integration_manifest_create($1, $2, $3, $4::date, $5::timestamptz, $6::timestamptz, $7::bigint[], $8) as r', [
        CONFIG, 'lead', 'WEBFORM', '2026-10-02', '2026-10-02T00:00:00+05:30', '2026-10-03T00:00:00+05:30', [61339], 'test-suite',
      ]);
      expect(await importLead(lead(61339, { title: 'y'.repeat(201) }))).toMatchObject({ outcome: 'needs_review', reasonCode: 'invalid_source_data' });
    });
  });

  it('an active Lead manifest does not limit scope mode and is not attached', async () => {
    await asOwner(db, async () => {
      await one(SVC, 'select public.integration_manifest_create($1, $2, $3, $4::date, $5::timestamptz, $6::timestamptz, $7::bigint[], $8) as r', [
        CONFIG, 'lead', 'CALL', '2026-10-02', '2026-10-02T00:00:00+05:30', '2026-10-03T00:00:00+05:30', [61341], 'test-suite',
      ]);
      await scopeMode();
      expect(await importLead(lead(61342))).toMatchObject({ outcome: 'created' });
      expect(await importLead(lead(61341))).toMatchObject({ outcome: 'created' });
      expect((await leadRow(61341))!.manifest_id).toBeNull();
      expect((await leadRow(61342))!.manifest_id).toBeNull();
    });
  });
});

describe('scope mode: owner outside the pilot (owner_not_eligible, ignored)', () => {
  it('ignores Leads whose responsible is unmapped, outside the pilot branch, not Sales, former or moved staff; nothing held', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      await mapBitrix(150, U.managerDelhi); // active manager membership in Delhi, no Sales role
      const cases: Array<[number, string]> = [[61401, '777'], [61402, '104'], [61403, '150'], [61404, '108'], [61405, '109'], [61406, '199']];
      for (const [id, assignedById] of cases) {
        const rec = await record(id);
        expect(await applyLead(await claimOne(rec.inboxId), lead(id, { assignedById })), assignedById).toEqual({
          outcome: 'ignored', leadId: null, reasonCode: 'owner_not_eligible',
        });
        expect(await inbox(rec.inboxId)).toEqual({ status: 'ignored', reason_code: 'owner_not_eligible' });
      }
      expect(await countLeads()).toBe(0);
      // Lead decision: other branches' Leads never reach "needs attention" and write no hold audit.
      const held = await run<{ n: number }>(ADMIN, `select count(*)::int as n from public.integration_inbox where status = 'needs_review'`);
      expect(held).toEqual([{ n: 0 }]);
      const audits = await db.query<{ n: number }>(
        `select count(*)::int as n from public.audit_events where action like 'integration.lead_%'`,
      );
      expect(audits).toEqual([{ n: 0 }]);
    });
  });

  it('once the mapping exists, the next change brings the ignored Lead in', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      expect(await importLead(lead(61411, { assignedById: '777' }))).toMatchObject({ reasonCode: 'owner_not_eligible' });
      // Sales Delhi B moves from Bitrix 102 to Bitrix 777 (admin unlink + link).
      await run(ADMIN, 'select public.integration_unlink_bitrix_user($1) as r', [U.salesDelhiB]);
      await run(ADMIN, 'select public.integration_link_bitrix_user($1, $2) as r', [U.salesDelhiB, 777]);
      const next = await importLead(lead(61411, { assignedById: '777', dateModify: '2026-10-02T12:00:00+05:30' }));
      expect(next).toMatchObject({ outcome: 'created' });
      expect((await leadRow(61411))!.owner_user_id).toBe(U.salesDelhiB);
    });
  });

  it('a stored Lead whose responsible becomes ineligible stays exactly as stored; the row is ignored', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      const created = await importLead(lead(61421));
      expect(created).toMatchObject({ outcome: 'created' });
      const before = await db.query('select * from public.crm_leads where id = $1', [created.leadId]);
      const rec = await record(61421);
      expect(await applyLead(await claimOne(rec.inboxId), lead(61421, {
        assignedById: '104', title: 'Moved to Ahmedabad', statusId: 'JUNK', dateModify: '2026-10-02T12:00:00+05:30',
      }))).toEqual({ outcome: 'ignored', leadId: created.leadId, reasonCode: 'owner_not_eligible' });
      expect(await inbox(rec.inboxId)).toEqual({ status: 'ignored', reason_code: 'owner_not_eligible' });
      expect(await db.query('select * from public.crm_leads where id = $1', [created.leadId])).toEqual(before);
      expect(await leadRow(61421)).toMatchObject({ owner_user_id: U.salesDelhiA, title: 'Synthetic scope lead 61421' });
      // An owner change between eligible pilot Sales members is applied.
      expect(await importLead(lead(61421, { assignedById: '102', dateModify: '2026-10-02T13:00:00+05:30' }))).toMatchObject({ outcome: 'updated' });
      expect((await leadRow(61421))!.owner_user_id).toBe(U.salesDelhiB);
    });
  });
});

describe('scope mode: duplicates, stale and out-of-order updates', () => {
  it('newer data updates; older or identical data is stale_ignored; one row per Lead', async () => {
    await asOwner(db, async () => {
      await scopeMode();
      expect(await importLead(lead(61501))).toMatchObject({ outcome: 'created' });
      const newer = lead(61501, { title: 'Newest synthetic title', statusId: 'IN_PROCESS', dateModify: '2026-10-03T09:00:00+05:30' });
      expect(await importLead(newer)).toMatchObject({ outcome: 'updated' });
      // Out of order: an older snapshot arrives after the newer one.
      const older = lead(61501, { title: 'Older synthetic title', dateModify: '2026-10-02T15:00:00+05:30' });
      expect(await importLead(older)).toMatchObject({ outcome: 'stale_ignored', reasonCode: 'stale_ignored' });
      // Identical content at the same version.
      expect(await importLead(newer)).toMatchObject({ outcome: 'stale_ignored' });
      expect(await leadRow(61501)).toMatchObject({ title: 'Newest synthetic title', source_status_id: 'IN_PROCESS', intake_mode: 'scope' });
      expect(await countLeads()).toBe(1);
      // An exact redelivery of one event is a duplicate of its inbox row.
      const at = (ts += 1);
      const first = await record(61501, 'ONCRMLEADUPDATE', at);
      expect(await record(61501, 'ONCRMLEADUPDATE', at)).toEqual({ inboxId: first.inboxId, duplicate: true });
    });
  });

  it('a manifest Lead updated in scope mode keeps its manifest and records the scope write', async () => {
    await asOwner(db, async () => {
      const m = await one<{ manifestId: string }>(
        SVC,
        'select public.integration_manifest_create($1, $2, $3, $4::date, $5::timestamptz, $6::timestamptz, $7::bigint[], $8) as r',
        [CONFIG, 'lead', 'WEBFORM', '2026-10-02', '2026-10-02T00:00:00+05:30', '2026-10-03T00:00:00+05:30', [61511], 'test-suite'],
      );
      expect(await importLead(lead(61511))).toMatchObject({ outcome: 'created' });
      await scopeMode();
      expect(await importLead(lead(61511, { sourceId: null, title: 'Scope update', dateModify: '2026-10-03T10:00:00+05:30' }))).toMatchObject({
        outcome: 'updated',
      });
      expect(await leadRow(61511)).toMatchObject({ manifest_id: m.manifestId, intake_mode: 'scope', source_id_code: 'NONE', title: 'Scope update' });
    });
  });
});

describe('review I2: intake_scope_status() counts scope-mode Leads', () => {
  const status = () => one<Record<string, unknown>>(ADMIN, 'select public.intake_scope_status() as r');

  it('manifest mode: no scopeIntake key (the result is exactly as before)', async () => {
    await asOwner(db, async () => {
      expect(Object.keys(await status()).sort()).toEqual(['lastSuccessfulSyncAt', 'manifest']);
    });
  });

  it('scope mode: Leads stored without a manifest; held, failed and owner-not-eligible Leads never stored; no ids or names', async () => {
    await asOwner(db, async () => {
      // One manifest Lead first: it keeps its manifest and is not a scope-mode import.
      await one(SVC, 'select public.integration_manifest_create($1, $2, $3, $4::date, $5::timestamptz, $6::timestamptz, $7::bigint[], $8) as r', [
        CONFIG, 'lead', 'WEBFORM', '2026-10-02', '2026-10-02T00:00:00+05:30', '2026-10-03T00:00:00+05:30', [61700], 'test-suite',
      ]);
      expect(await importLead(lead(61700))).toMatchObject({ outcome: 'created' });
      await scopeMode();
      expect(await importLead(lead(61701))).toMatchObject({ outcome: 'created' });
      expect(await importLead(lead(61702))).toMatchObject({ outcome: 'created' });
      expect(await importLead(lead(61703, { assignedById: '777' }))).toMatchObject({ outcome: 'ignored', reasonCode: 'owner_not_eligible' });
      // A stored Lead whose later update is ignored still counts as imported only.
      expect(await importLead(lead(61701, { assignedById: '777', dateModify: '2026-10-02T12:00:00+05:30' }))).toMatchObject({ reasonCode: 'owner_not_eligible' });
      // A Lead held for review (invalid source data) and never stored.
      expect(await importLead(lead(61705, { title: '   ' }))).toMatchObject({ outcome: 'needs_review' });
      const failed = await record(61704);
      await db.query(`update public.integration_inbox set status = 'dead_letter' where id = $1`, [failed.inboxId]);
      const view = await status();
      expect(view.scopeIntake).toEqual({
        leadMode: 'scope',
        dealMode: 'manifest',
        since: '2026-09-30T18:30:00.000Z',
        leads: { imported: 2, heldForReview: 1, failed: 1, ownerNotEligible: 1 },
      });
      expect((view.manifest as { sourceObject: string }).sourceObject).toBe('lead');
      const text = JSON.stringify(view);
      for (const secret of ['61701', '61703', '61705', MEMBER, CONFIG, U.salesDelhiA, 'Synthetic']) expect(text, secret).not.toContain(secret);
      // Deal scope only: modes shown, no Lead counts.
      await db.query(`update public.integration_intake_config set lead_intake_mode = 'manifest', deal_intake_mode = 'scope'`);
      expect((await status()).scopeIntake).toEqual({ leadMode: 'manifest', dealMode: 'scope', since: '2026-09-30T18:30:00.000Z', leads: null });
    });
  });
});

describe('Lead reconcile watermark (lead_reconciled_at)', () => {
  const recordRun = (startedAt: string, ok: boolean) =>
    one<{ portalMemberId: string; leadReconciledAt: string | null; advanced: boolean }>(
      SVC, 'select public.integration_record_lead_reconcile_run($1, $2::timestamptz, $3) as r', [MEMBER, startedAt, ok],
    );
  const mark = async () =>
    (await db.query<{ l: string | null; d: string | null }>(
      `select (lead_reconciled_at at time zone 'UTC')::text as l, (last_reconciled_at at time zone 'UTC')::text as d from public.integration_intake_config`,
    ))[0]!;
  const save = (mode: string | null, cutoff = '2026-09-01T00:00:00+05:30') =>
    run(ADMIN, `select public.integration_apply_sync_settings((public.integration_preview_sync_settings(array[7]::bigint[], array['C7:NEW','C7:PREPARATION'], $1, false, $2) ->> 'previewId')::uuid, 'Test: sync settings saved through preview and apply') as r`, [cutoff, mode]);

  it('starts null; advances only on success, never backwards; the Deal watermark is untouched', async () => {
    await asOwner(db, async () => {
      expect(await mark()).toEqual({ l: null, d: null });
      expect(await recordRun('2026-10-05T10:00:00Z', false)).toMatchObject({ leadReconciledAt: null, advanced: false });
      expect(await recordRun('2026-10-05T10:00:00Z', true)).toMatchObject({ advanced: true });
      expect(await recordRun('2026-10-05T09:00:00Z', true)).toMatchObject({ advanced: false });
      expect(await recordRun('2026-10-05T11:00:00Z', false)).toMatchObject({ advanced: false });
      expect(await mark()).toEqual({ l: '2026-10-05 10:00:00', d: null });
      await expectDbError(db, () => recordRun('2999-01-01T00:00:00Z', true), { code: '22023' });
      await expectDbError(db, () => run(SVC, 'select public.integration_record_lead_reconcile_run($1, now(), null)', [MEMBER]), { code: '22023' });
      await expectDbError(db, () => run(SVC, `select public.integration_record_lead_reconcile_run('NOT_A_PORTAL', now(), true)`), { code: '42501' });
    });
  });

  it('service role only', async () => {
    const rows = await db.query<{ role: string; ok: boolean }>(
      `select r as role, has_function_privilege(r, 'public.integration_record_lead_reconcile_run(text, timestamptz, boolean)', 'execute') as ok
       from unnest(array['anon', 'authenticated', 'service_role']) r`,
    );
    expect(rows).toEqual([{ role: 'anon', ok: false }, { role: 'authenticated', ok: false }, { role: 'service_role', ok: true }]);
  });

  it('settings reset it when Lead intake switches to scope or the sync date changes, and keep it otherwise', async () => {
    await asOwner(db, async () => {
      await save(null); // normalises the fixture sync date
      await recordRun('2026-10-05T10:00:00Z', true);
      await save(null);
      expect((await mark()).l).toBe('2026-10-05 10:00:00');
      await save('scope');
      expect((await mark()).l).toBeNull();
      await recordRun('2026-10-05T10:00:00Z', true);
      await save('scope');
      await save(null);
      expect((await mark()).l).toBe('2026-10-05 10:00:00');
      await save(null, '2026-09-02T00:00:00+05:30');
      expect((await mark()).l).toBeNull();
      await recordRun('2026-10-05T10:00:00Z', true);
      // Back to manifest keeps the value (the scope pass is not running).
      await save('manifest', '2026-09-02T00:00:00+05:30');
      expect((await mark()).l).toBe('2026-10-05 10:00:00');
    });
  });
});

describe('settings: integration_update_sync_settings(..., p_lead_intake_mode)', () => {
  const save = (mode: string | null, actor: Actor = ADMIN) =>
    one<{ leadIntakeMode: string }>(
      actor,
      `select public.integration_apply_sync_settings((public.integration_preview_sync_settings(array[7]::bigint[], array['C7:NEW','C7:PREPARATION'], '2026-09-01T00:00:00+05:30', false, $1) ->> 'previewId')::uuid, 'Test: sync settings saved through preview and apply') as r`,
      [mode],
    );
  const mode = async () => (await db.query<{ m: string }>('select lead_intake_mode as m from public.integration_intake_config'))[0]!.m;

  it('sets scope, keeps it on null, returns to manifest, refuses anything else; each save is audited', async () => {
    await asOwner(db, async () => {
      expect(await save('scope')).toMatchObject({ leadIntakeMode: 'scope' });
      expect(await mode()).toBe('scope');
      expect(await save(null)).toMatchObject({ leadIntakeMode: 'scope' });
      expect(await mode()).toBe('scope');
      // The 4-argument call (current app) keeps the mode too.
      await run(ADMIN, `select public.integration_apply_sync_settings((public.integration_preview_sync_settings(array[7]::bigint[], array['C7:NEW'], '2026-09-01T00:00:00+05:30', false) ->> 'previewId')::uuid, 'Test: sync settings saved through preview and apply')`);
      expect(await mode()).toBe('scope');
      expect(await save('manifest')).toMatchObject({ leadIntakeMode: 'manifest' });
      expect(await mode()).toBe('manifest');
      await expectDbError(db, () => save('everything'), { code: '22023', message: /invalid Lead intake mode/ });
      const audits = await db.query<{ d: { leadIntakeMode: string; previousLeadIntakeMode: string } }>(
        `select details as d from public.audit_events where action = 'integration.settings_updated' order by id`,
      );
      expect(audits.map((a) => [a.d.previousLeadIntakeMode, a.d.leadIntakeMode])).toEqual([
        ['manifest', 'scope'], ['scope', 'scope'], ['scope', 'scope'], ['scope', 'manifest'],
      ]);
    });
  });

  it('only the integration admin may change it', async () => {
    await asOwner(db, async () => {
      await expectDbError(db, () => save('scope', { userId: U.salesDelhiA }), { code: '42501' });
      await expectDbError(db, () => save('scope', { userId: null }), { code: '42501' });
      expect(await mode()).toBe('manifest');
    });
  });

  it('one signature (the 4-argument version is gone) with the same grants as before', async () => {
    const rows = await db.query<{ args: string; anon: boolean; auth: boolean; svc: boolean; secdef: boolean; config: string[] }>(
      `select pg_get_function_identity_arguments(p.oid) as args,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc,
              p.prosecdef as secdef, p.proconfig as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'integration_update_sync_settings'`,
    );
    expect(rows).toEqual([
      {
        args: 'p_category_ids bigint[], p_stage_ids text[], p_cutoff_at timestamp with time zone, p_sync_enabled boolean, p_lead_intake_mode text, p_deal_intake_mode text',
        anon: false, auth: true, svc: false, secdef: true, config: ['search_path=""'],
      },
    ]);
  });
});
