import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaimedInboxItem } from '@/modules/integration/contracts';
import { type Actor, FIXTURE_USERS as U, type TestDb, amrAt, asOwner, createTestDb, expectDbError, resetActor, setActor } from '../helpers/db';

/**
 * Phase 6 lead screens (docs/implementation/history/phase-6/lead-screens-contract.md
 * sections 3 and 4), migration 20261007000200_lead_scope_reads.sql:
 * crm_leads visibility per viewer and public.intake_scope_status().
 *
 * Synthetic values only. Every scenario runs in a rolled-back transaction as
 * the database owner and switches to the impersonated role only for the call
 * under test.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const SVC: Actor = { userId: null, role: 'service_role' };
const ANON: Actor = { userId: null };
const ADMIN: Actor = { userId: U.adminJodhpur };
const MEMBER = 'SYNTHETIC_MEMBER_0001';
const CONFIG = 'c0000000-0000-4000-8000-000000000001';
const FROM = '2026-10-04T00:00:00+05:30';
const TO = '2026-10-05T00:00:00+05:30';
const MANIFEST_IDS = [41001, 41002, 41003, 41004, 41005];

type Item = ClaimedInboxItem & { sourceObject: 'deal' | 'lead'; sourceId: string };
interface ScopeCounts {
  imported: number;
  heldForReview: number;
  failed: number;
  excluded: number;
}
interface ScopeView {
  manifest: null | {
    status: 'active' | 'closed';
    sourceObject: 'lead' | 'deal';
    sourceCode: string;
    sourceCodeLabel: string | null;
    businessDate: string;
    intervalFrom: string;
    intervalTo: string;
    expectedCount: number;
    createdByOperator: string;
    createdAt: string;
    closedAt: string | null;
    counts: ScopeCounts;
  };
  lastSuccessfulSyncAt: string | null;
}

async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  // On error the caller's savepoint rollback (expectDbError) also undoes SET LOCAL ROLE.
  await setActor(db, actor);
  const rows = await db.query<T>(sql, params);
  await resetActor(db);
  return rows;
}
async function one<T>(actor: Actor, sql: string, params: unknown[] = []): Promise<T> {
  return (await run<{ r: T }>(actor, sql, params))[0]!.r;
}
const scope = (actor: Actor) => one<ScopeView>(actor, 'select public.intake_scope_status() as r');
const refs = async (actor: Actor) =>
  (await run<{ reference: string }>(actor, 'select reference from public.crm_leads order by reference')).map((r) => r.reference);

let ts = 1_850_000_000;
const record = (id: number, event = 'ONCRMLEADADD') =>
  one<{ inboxId: string }>(SVC, 'select public.integration_record_bitrix_event($1, $2, $3, $4) as r', [MEMBER, event, id, (ts += 1)]);
async function claimOne(inboxId: string): Promise<Item> {
  const items = (await run<{ r: Item }>(SVC, 'select r from public.integration_claim_inbox(100, 60) as r')).map((x) => x.r);
  const item = items.find((c) => c.inboxId === inboxId);
  if (!item) throw new Error('row was not claimed');
  return item;
}
const snapshot = (id: number, assignedById = '101') => ({
  id: String(id), title: `Synthetic screen lead ${id}`, statusId: 'NEW', sourceId: 'WEBFORM', assignedById,
  dateCreate: '2026-10-04T11:00:00+05:30', dateModify: '2026-10-04T11:00:00+05:30',
});
async function importLead(id: number, assignedById = '101') {
  const { inboxId } = await record(id);
  const item = await claimOne(inboxId);
  const r = await one<{ outcome: string; leadId: string | null }>(SVC, 'select public.integration_apply_bitrix_lead($1, $2, $3::jsonb) as r', [
    item.inboxId, item.lockToken, JSON.stringify(snapshot(id, assignedById)),
  ]);
  return { ...r, inboxId };
}
const createManifest = (ids = MANIFEST_IDS) =>
  one<{ manifestId: string }>(SVC, 'select public.integration_manifest_create($1, $2, $3, $4::date, $5::timestamptz, $6::timestamptz, $7::bigint[], $8) as r', [
    CONFIG, 'lead', 'WEBFORM', '2026-10-04', FROM, TO, ids, 'synthetic-operator',
  ]);
const closeManifest = (id: string) => one(SVC, 'select public.integration_manifest_close($1, $2) as r', [id, 'synthetic-operator']);

/**
 * Three synthetic Leads: BXL-41001 (Delhi, Sales A, imported through the real
 * apply command), BXL-41002 (Delhi, Sales B) and BXL-41003 (Ahmedabad, Sales
 * Ahmedabad), the last two inserted by the owner with the same provenance.
 */
async function seedLeads(): Promise<string> {
  const { manifestId } = await createManifest();
  const first = await importLead(41001);
  expect(first.outcome).toBe('created');
  await db.query(
    `insert into public.crm_leads (legal_entity_id, branch_id, reference, title, owner_user_id, source_portal, source_lead_id,
       source_status_id, source_id_code, source_created_at, source_modified_at, last_synced_at, last_verified_at, intake_inbox_id, manifest_id)
     select b.legal_entity_id, b.id, 'BXL-' || v.id, 'Synthetic screen lead ' || v.id, v.owner::uuid, $1, v.id,
            'NEW', 'WEBFORM', now(), now(), now(), now(), $2, $3
     from (values (41002, 'DEL', $4), (41003, 'AMD', $5)) as v (id, code, owner)
     join public.branches b on b.code = v.code
     join public.legal_entities e on e.id = b.legal_entity_id and e.code = 'HOLIDAY_CHACHA'`,
    [MEMBER, first.inboxId, manifestId, U.salesDelhiB, U.salesAhmedabad],
  );
  return manifestId;
}
const deactivateMemberships = (user: string, role?: string) =>
  db.query(
    `update public.memberships set status = 'inactive', deactivated_at = now() where user_id = $1 and ($2::text is null or role_code = $2)`,
    [user, role ?? null],
  );
const addMembership = (user: string, branchCode: string, role: string) =>
  db.query(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, $3, 'active' from public.branches b where b.code = $2`,
    [user, branchCode, role],
  );

// ---------------------------------------------------------------------------

describe('Lead visibility per viewer (RLS)', () => {
  it('owner sees own lead only; other Sales owner and other branch do not', async () => {
    await asOwner(db, async () => {
      await seedLeads();
      expect(await refs({ userId: U.salesDelhiA })).toEqual(['BXL-41001']);
      expect(await refs({ userId: U.salesDelhiB })).toEqual(['BXL-41002']);
      expect(await refs({ userId: U.salesAhmedabad })).toEqual(['BXL-41003']);
      for (const userId of [U.accountsJodhpur, U.visaJodhpur, U.salesEntityB]) {
        expect(await refs({ userId }), userId).toEqual([]);
      }
    });
  });

  it('branch manager of the lead branch sees it; another branch manager does not; integration admin sees all', async () => {
    await asOwner(db, async () => {
      await seedLeads();
      expect(await refs({ userId: U.managerDelhi })).toEqual(['BXL-41001', 'BXL-41002']);
      expect(await refs({ userId: U.managerAhmedabad })).toEqual(['BXL-41003']);
      expect(await refs(ADMIN)).toEqual(['BXL-41001', 'BXL-41002', 'BXL-41003']);
    });
  });

  it('inactive staff, deactivated memberships, aal1 and expired sessions see nothing', async () => {
    await asOwner(db, async () => {
      await seedLeads();
      for (const actor of [
        { userId: U.salesDelhiA, aal: 'aal1' }, { userId: U.managerDelhi, aal: 'aal1' }, { userId: U.adminJodhpur, aal: 'aal1' },
        { userId: U.salesDelhiA, amr: amrAt(13 * 3600) }, { userId: U.formerStaff }, { userId: U.movedStaff }, { userId: U.invitedStaff },
      ] as Actor[]) {
        expect(await refs(actor), JSON.stringify(actor)).toEqual([]);
      }
      await db.query(
        `update public.staff_profiles set status = 'inactive', deactivated_at = now(), deactivation_reason = 'synthetic' where user_id = $1`,
        [U.salesDelhiA],
      );
      expect(await refs({ userId: U.salesDelhiA })).toEqual([]);
      await deactivateMemberships(U.salesDelhiB);
      expect(await refs({ userId: U.salesDelhiB })).toEqual([]);
      await deactivateMemberships(U.managerDelhi);
      expect(await refs({ userId: U.managerDelhi })).toEqual([]);
      await deactivateMemberships(U.adminJodhpur);
      expect(await refs(ADMIN)).toEqual([]);
    });
  });

  it('Purchase sees nothing: Purchase-only, Purchase+Sales owner, Purchase+manager, and Purchase in another entity', async () => {
    await asOwner(db, async () => {
      await seedLeads();
      expect(await refs({ userId: U.purchaseJodhpur })).toEqual([]);
      // Purchase + Sales in the Delhi branch, and the mapped owner of a lead.
      await addMembership(U.purchaseJodhpur, 'DEL', 'sales');
      await db.query(`update public.crm_leads set owner_user_id = $1 where reference = 'BXL-41002'`, [U.purchaseJodhpur]);
      expect(await refs({ userId: U.purchaseJodhpur })).toEqual([]);
      await addMembership(U.purchaseJodhpur, 'DEL', 'manager');
      expect(await refs({ userId: U.purchaseJodhpur })).toEqual([]);
      // Deactivating the Purchase membership restores the Sales/manager reads.
      await deactivateMemberships(U.purchaseJodhpur, 'purchase');
      expect(await refs({ userId: U.purchaseJodhpur })).toEqual(['BXL-41001', 'BXL-41002']);

      // Purchase held in a different entity hides every lead (page/nav rule).
      expect(await refs({ userId: U.salesDelhiA })).toEqual(['BXL-41001']);
      await addMembership(U.salesDelhiA, 'SB1', 'purchase');
      expect(await refs({ userId: U.salesDelhiA })).toEqual([]);
      await addMembership(U.managerDelhi, 'SB1', 'purchase');
      expect(await refs({ userId: U.managerDelhi })).toEqual([]);
      await addMembership(U.adminJodhpur, 'SB1', 'purchase');
      expect(await refs(ADMIN)).toEqual([]);
    });
  });

  it('anon reads nothing: no table privilege and no scope function', async () => {
    await asOwner(db, async () => {
      await seedLeads();
      await expectDbError(db, () => run(ANON, 'select reference from public.crm_leads'), { code: '42501' });
      await expectDbError(db, () => scope(ANON), { code: '42501' });
    });
  });
});

describe('intake_scope_status()', () => {
  it('is SECURITY DEFINER with an empty search_path and executable by authenticated only', async () => {
    const [fn] = await db.query<{ secdef: boolean; config: string[] | null }>(
      `select p.prosecdef as secdef, p.proconfig as config from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'intake_scope_status'`,
    );
    expect(fn).toEqual({ secdef: true, config: ['search_path=""'] });
    const grants = await db.query<{ role: string; ok: boolean }>(
      `select r as role, has_function_privilege(r, 'public.intake_scope_status()', 'execute') as ok
       from unnest(array['anon', 'authenticated', 'service_role']) as r order by r`,
    );
    expect(grants).toEqual([
      { role: 'anon', ok: false }, { role: 'authenticated', ok: true }, { role: 'service_role', ok: false },
    ]);
  });

  it('refuses everyone except an integration.manage admin of the config entity with a valid session', async () => {
    await asOwner(db, async () => {
      await seedLeads();
      for (const actor of [
        { userId: U.purchaseJodhpur }, { userId: U.salesDelhiA }, { userId: U.managerDelhi }, { userId: U.managerAhmedabad },
        { userId: U.accountsJodhpur }, { userId: U.salesEntityB }, { userId: U.formerStaff }, { userId: U.movedStaff },
        { userId: U.adminJodhpur, aal: 'aal1' }, { userId: U.adminJodhpur, amr: amrAt(13 * 3600) },
      ] as Actor[]) {
        await expectDbError(db, () => scope(actor), { code: '42501', message: /^not_authorized$/ });
      }
      // Purchase + Sales holder in the entity.
      await addMembership(U.purchaseJodhpur, 'DEL', 'sales');
      await expectDbError(db, () => scope({ userId: U.purchaseJodhpur }), { code: '42501', message: /^not_authorized$/ });
      expect((await scope(ADMIN)).manifest?.sourceObject).toBe('lead');

      // An integration.manage admin holding Purchase in any entity is refused.
      await addMembership(U.adminJodhpur, 'SB1', 'purchase');
      await expectDbError(db, () => scope(ADMIN), { code: '42501', message: /^not_authorized$/ });
      await deactivateMemberships(U.adminJodhpur, 'purchase');
      expect((await scope(ADMIN)).manifest?.sourceObject).toBe('lead');
      await addMembership(U.adminJodhpur, 'JDH', 'purchase');
      await expectDbError(db, () => scope(ADMIN), { code: '42501', message: /^not_authorized$/ });
      await deactivateMemberships(U.adminJodhpur, 'purchase');

      // An admin of another entity is refused once the config moves there.
      await db.query(
        `update public.integration_intake_config c set pilot_legal_entity_id = b.legal_entity_id, pilot_branch_id = b.id
         from public.branches b where c.id = $1 and b.code = 'SB1'`, [CONFIG],
      );
      await expectDbError(db, () => scope(ADMIN), { code: '42501', message: /^not_authorized$/ });
    });
  });

  it('returns the exact IntakeScopeView shape and counts with no ids, titles or names', async () => {
    await asOwner(db, async () => {
      const { manifestId } = await createManifest();
      // 41001 imported; 41002 held (unmapped owner); 41003 failed; 41004 dead letter; 41005 not arrived.
      expect((await importLead(41001)).outcome).toBe('created');
      expect((await importLead(41002, '555')).outcome).toBe('needs_review');
      const failed = await record(41003);
      const dead = await record(41004);
      await db.query(`update public.integration_inbox set status = 'failed', next_attempt_at = now() where id = $1`, [failed.inboxId]);
      await db.query(`update public.integration_inbox set status = 'dead_letter' where id = $1`, [dead.inboxId]);
      // Outside the list: two distinct Leads (one delivered twice), and a Deal outside the Deal list.
      await record(49001);
      await record(49001, 'ONCRMLEADUPDATE');
      await record(49002);
      await record(4001, 'ONCRMDEALADD');
      await db.query(
        `insert into public.integration_worker_runs (kind, started_at, finished_at, outcome)
         values ('worker', '2030-01-01T00:00:00Z', '2030-01-01T00:00:05Z', 'ok'),
                ('reconcile', '2030-02-01T00:00:00Z', '2030-02-01T00:00:05Z', 'partial')`,
      );
      const [m] = await db.query<{ created: string }>(
        `select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created from public.intake_manifests where id = $1`,
        [manifestId],
      );

      const view = await scope(ADMIN);
      expect(view).toStrictEqual({
        manifest: {
          status: 'active',
          sourceObject: 'lead',
          sourceCode: 'WEBFORM',
          sourceCodeLabel: null,
          businessDate: '2026-10-04',
          intervalFrom: '2026-10-03T18:30:00.000Z',
          intervalTo: '2026-10-04T18:30:00.000Z',
          expectedCount: 5,
          createdByOperator: 'synthetic-operator',
          createdAt: m!.created,
          closedAt: null,
          counts: { imported: 1, heldForReview: 1, failed: 2, excluded: 2 },
        },
        lastSuccessfulSyncAt: '2030-01-01T00:00:05.000Z',
      });
      const text = JSON.stringify(view);
      for (const secret of [manifestId, CONFIG, MEMBER, '41001', '49001', 'Synthetic', U.salesDelhiA, '@']) {
        expect(text, secret).not.toContain(secret);
      }
    });
  });

  it('PR 6 L4: a scope change holds the existing Lead with scope_changed; held/failed count only items never imported', async () => {
    await asOwner(db, async () => {
      await createManifest([41001, 41002, 41003]);
      const first = await importLead(41001);
      expect(first.outcome).toBe('created');
      // One transaction shares now(): date the first delivery earlier so "latest" is well defined.
      await db.query(`update public.integration_inbox set received_at = now() - interval '1 minute' where id = $1`, [first.inboxId]);
      await db.query(
        `update public.integration_intake_config c set pilot_branch_id = b.id
         from public.branches b where c.id = $1 and b.code = 'AMD' and b.legal_entity_id = c.pilot_legal_entity_id`, [CONFIG],
      );
      // The Ahmedabad owner is valid for the new branch: only the scope change holds it.
      const { inboxId } = await record(41001, 'ONCRMLEADUPDATE');
      const item = await claimOne(inboxId);
      expect(await one(SVC, 'select public.integration_apply_bitrix_lead($1, $2, $3::jsonb) as r', [
        item.inboxId, item.lockToken, JSON.stringify({ ...snapshot(41001, '104'), dateModify: '2026-10-04T12:00:00+05:30' }),
      ])).toEqual({ outcome: 'needs_review', leadId: null, reasonCode: 'scope_changed' });
      expect(await db.query(`select status, reason_code from public.integration_inbox where id = $1`, [inboxId])).toEqual([
        { status: 'needs_review', reason_code: 'scope_changed' },
      ]);
      // Imported, then its later update held: still imported, not "held, not copied".
      expect((await scope(ADMIN)).manifest?.counts).toEqual({ imported: 1, heldForReview: 0, failed: 0, excluded: 0 });
      // An imported record whose later delivery failed is not counted as failed either.
      await db.query(`update public.integration_inbox set status = 'dead_letter', reason_code = null where id = $1`, [inboxId]);
      expect((await scope(ADMIN)).manifest?.counts).toEqual({ imported: 1, heldForReview: 0, failed: 0, excluded: 0 });
      // Never imported: held (unmapped owner) and failed both count.
      const held = await record(41002);
      const heldItem = await claimOne(held.inboxId);
      expect(await one(SVC, 'select public.integration_apply_bitrix_lead($1, $2, $3::jsonb) as r', [
        heldItem.inboxId, heldItem.lockToken, JSON.stringify(snapshot(41002, '555')),
      ])).toMatchObject({ outcome: 'needs_review', reasonCode: 'unmapped_owner' });
      const failed = await record(41003);
      await db.query(`update public.integration_inbox set status = 'failed', next_attempt_at = now() where id = $1`, [failed.inboxId]);
      expect((await scope(ADMIN)).manifest?.counts).toEqual({ imported: 1, heldForReview: 1, failed: 1, excluded: 0 });
    });
  });

  it('active list first, else the most recently closed list, else null', async () => {
    await asOwner(db, async () => {
      const { manifestId } = await createManifest([41001]);
      expect((await scope(ADMIN)).manifest).toMatchObject({ status: 'active', sourceObject: 'lead', expectedCount: 1 });
      await closeManifest(manifestId);
      // The fixture Deal list is still active.
      expect((await scope(ADMIN)).manifest).toMatchObject({ status: 'active', sourceObject: 'deal', expectedCount: 5000 });
      const [deal] = await db.query<{ id: string }>(`select id from public.intake_manifests where source_object = 'deal' and status = 'active'`);
      await closeManifest(deal!.id);
      const closed = (await scope(ADMIN)).manifest!;
      expect(closed).toMatchObject({ status: 'closed', closedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) });

      // A newly enabled configuration with no list: manifest null, nothing implied.
      await db.query(`update public.integration_intake_config set enabled = false where id = $1`, [CONFIG]);
      await db.query(
        `insert into public.integration_intake_config
           (portal_domain, portal_member_id, category_id, eligible_stage_ids, cutoff_at, pilot_legal_entity_id, pilot_branch_id, enabled)
         select 'second-portal.example.test', 'SYNTHETIC_MEMBER_0003', 7, array['C7:NEW'], now(), b.legal_entity_id, b.id, true
         from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
         where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'`,
      );
      expect(await scope(ADMIN)).toStrictEqual({ manifest: null, lastSuccessfulSyncAt: null });
    });
  });
});
