import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_DEALS as D, FIXTURE_USERS as U, type TestDb, asOwner, claimsFor, createTestDb, resetActor } from '../helpers/db';
import { ACCOUNTS, ANON, DEAL, MANAGER, MANAGER_AMD, OTHER_ENTITY, OWNER, PURCHASE, SALES_AMD, SALES_B, SUPER, b1Helpers, rid } from './b1-support';
import { DESK } from './b11-support';

/**
 * Direction A Batch 1 B1-4 (migration 20261121000130_record_staff_names),
 * owner answer DEC-52 as scoped on 19 October: the OWNER's display name on
 * Deals and Leads the caller can already read. Never assignee names, never
 * contact details. authz.deal_row_visible is held equal to the deals read
 * policy for every role fixture (drift guard). Synthetic fixtures; rolled back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b1Helpers(() => db);
const { one, refused, owner } = h;
const SQL = 'select public.record_staff_names($1::uuid[]) as r';
type Name = { userId: string; displayName: string };
const names = (actor: Actor, ids: string[]) => one<Name[]>(actor, SQL, [ids]);
const ALL_IDS = Object.values(U);

/** Deal ids the deals policy returns to the actor (Data API path). */
async function policyDeals(actor: Actor): Promise<string[]> {
  return (await h.run<{ id: string }>(actor, 'select id from public.deals order by id')).map((r) => r.id);
}
/** Deal ids authz.deal_row_visible accepts for the actor (evaluated as the owner with the actor's claims). */
async function helperDeals(actor: Actor): Promise<string[]> {
  await resetActor(db);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claimsFor(actor))]);
  const rows = await owner<{ id: string }>('select id from public.deals where authz.deal_row_visible(id) order by id');
  await resetActor(db);
  return rows.map((r) => r.id);
}

async function insertLead(sourceLeadId: number, branch: string, ownerUser: string): Promise<string> {
  const [inbox] = await owner<{ id: string }>(
    `insert into public.integration_inbox (portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, status, processed_at)
     values ('SYNTHETIC_MEMBER_0001', 'ONCRMDEALADD', $1::bigint, 1, repeat('d', 58) || lpad($2::text, 6, '0'), 'processed', now()) returning id`,
    [sourceLeadId, String(sourceLeadId)]);
  const [lead] = await owner<{ id: string }>(
    `insert into public.crm_leads (legal_entity_id, branch_id, reference, title, owner_user_id, source_portal, source_lead_id,
       source_status_id, source_id_code, source_created_at, source_modified_at, last_synced_at, last_verified_at, intake_inbox_id,
       manifest_id, intake_mode)
     select b.legal_entity_id, b.id, 'BXL-' || $1::text, 'Synthetic names lead', $2, 'SYNTHETIC_MEMBER_0001', $1::bigint,
            'NEW', 'WEBFORM', now(), now(), now(), now(), $3, null, 'scope'
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = $4
     returning id`,
    [sourceLeadId, ownerUser, inbox!.id, branch]);
  return lead!.id;
}

async function scenario() {
  // SALES_B assists on DEAL (owned by Sales Delhi A); Purchase is already assigned to DEAL in the fixtures.
  await h.addSalesAssignee(DEAL, U.salesDelhiB);
  // A live cross-branch grant: the Ahmedabad Manager reads Delhi Deals.
  await owner(`insert into public.access_grants (user_id, legal_entity_id, branch_id, permission_code, granted_by, reason)
               select $1, d.legal_entity_id, d.branch_id, 'deal.read', $2, 'Synthetic cross-branch grant for the test'
               from public.deals d where d.id = $3`, [MANAGER_AMD.userId, SUPER.userId, DEAL]);
  // An Ahmedabad Lead owned by Sales Ahmedabad.
  await insertLead(880001, 'AMD', U.salesAhmedabad);
}

const ROLES: Array<[string, Actor]> = [
  ['sales owner', OWNER], ['assisting sales', SALES_B], ['branch manager', MANAGER], ['manager with grant', MANAGER_AMD],
  ['purchase (assigned)', PURCHASE], ['visa desk', DESK], ['accounts', ACCOUNTS], ['super admin', SUPER],
  ['sales ahmedabad', SALES_AMD], ['other entity', OTHER_ENTITY],
];

describe('authz.deal_row_visible drift guard', () => {
  it('equals the deals read policy for every role fixture, including removed Deals', async () => {
    await asOwner(db, async () => {
      await scenario();
      await owner('alter table public.deals drop constraint deals_removed_imported_only');
      await owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [D.del002]);
      for (const [label, actor] of ROLES) {
        expect({ label, deals: await helperDeals(actor) }).toEqual({ label, deals: await policyDeals(actor) });
      }
      expect(await helperDeals({ userId: U.salesDelhiA, aal: 'aal1' })).toEqual([]);
      expect(await helperDeals(ANON)).toEqual([]);
    });
  });
});

describe('record_staff_names (owner names only)', () => {
  it('names exactly the owners of Deals and Leads the caller can read', async () => {
    await asOwner(db, async () => {
      await scenario();
      for (const [label, actor] of ROLES) {
        const visible = await policyDeals(actor);
        const dealOwners = visible.length
          ? (await owner<{ o: string }>('select distinct owner_user_id::text as o from public.deals where id = any($1::uuid[]) and owner_user_id is not null', [visible])).map((r) => r.o)
          : [];
        const leadOwners = (await h.run<{ o: string }>(actor, 'select distinct owner_user_id::text as o from public.crm_leads where owner_user_id is not null')).map((r) => r.o);
        const expected = [...new Set([...dealOwners, ...leadOwners])].sort();
        const got = (await names(actor, ALL_IDS)).map((n) => n.userId).sort();
        expect({ label, got }).toEqual({ label, got: expected });
      }
    });
  });

  it('never names an assignee or an unrelated colleague; display name only', async () => {
    await asOwner(db, async () => {
      await scenario();
      // Sales Delhi B assists on the owner's Deal but owns nothing the owner can read.
      expect(await names(OWNER, [U.salesDelhiB, U.purchaseJodhpur, U.accountsJodhpur, U.managerDelhi])).toEqual([]);
      const own = await names(OWNER, [U.salesDelhiA]);
      expect(own).toEqual([{ userId: U.salesDelhiA, displayName: 'Synthetic Sales Delhi A' }]);
      // The assisting salesperson and the assigned Purchase person see the Deal owner's name.
      expect(await names(SALES_B, [U.salesDelhiA])).toEqual(own);
      expect(await names(PURCHASE, [U.salesDelhiA, U.salesDelhiB])).toEqual(own);
      const raw = JSON.stringify(await names(MANAGER, ALL_IDS));
      expect(raw).not.toMatch(/@example\.test|work_email|status|role|phone|mobile/i);
      for (const n of await names(MANAGER, ALL_IDS)) expect(Object.keys(n).sort()).toEqual(['displayName', 'userId']);
    });
  });

  it('Purchase sees names only through Deals it can read, never through Leads', async () => {
    await asOwner(db, async () => {
      await scenario();
      expect(await names(MANAGER_AMD, [U.salesAhmedabad])).toEqual([{ userId: U.salesAhmedabad, displayName: 'Synthetic Sales Ahmedabad' }]);
      expect(await names(PURCHASE, [U.salesAhmedabad])).toEqual([]);
    });
  });

  it('Super Admin by role alone: no Deal owner names; Lead owner names through the integration-admin Lead read (lead ruling on Echo L4)', async () => {
    await asOwner(db, async () => {
      await scenario();
      expect(await policyDeals(SUPER)).toEqual([]);
      expect(await names(SUPER, [U.salesDelhiA, U.salesDelhiB])).toEqual([]);
      // Intended (lead ruling on Echo L4): authz.can_read_lead admits the integration administrator,
      // who already reads every staff profile, so the Lead owner's name is no new data.
      expect((await names(SUPER, [U.salesAhmedabad])).map((n) => n.userId)).toEqual([U.salesAhmedabad]);
    });
  });

  it('a removed Deal names nobody; input limits and refusals', async () => {
    await asOwner(db, async () => {
      await owner('alter table public.deals drop constraint deals_removed_imported_only');
      await owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [DEAL]);
      expect(await names(MANAGER, [U.salesDelhiA])).toEqual([]);
      expect(await names(MANAGER, [])).toEqual([]);
      expect(await names(MANAGER, [rid(), rid()])).toEqual([]);
      await refused(MANAGER, SQL, [Array.from({ length: 201 }, () => rid())], '22023', 'invalid_input');
      await refused(MANAGER, SQL, [null], '22023', 'invalid_input');
      await refused(ANON, SQL, [[U.salesDelhiA]], '42501');
      await refused({ userId: U.managerDelhi, aal: 'aal1' }, SQL, [[U.salesDelhiA]], '42501', 'not_authorized');
    });
  });

  it('reads write nothing; definer, empty search path; the helper is not granted', async () => {
    await asOwner(db, async () => {
      await scenario();
      const audit = await h.count('select 1 from public.audit_events');
      await names(MANAGER, ALL_IDS);
      expect(await h.count('select 1 from public.audit_events')).toBe(audit);
      const fns = await owner<{ fn: string; definer: boolean; config: string[]; auth: boolean; svc: boolean; anon: boolean }>(
        `select p.oid::regprocedure::text as fn, p.prosecdef as definer, p.proconfig as config,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc,
                has_function_privilege('anon', p.oid, 'execute') as anon
         from pg_proc p where p.oid in ('public.record_staff_names(uuid[])'::regprocedure, 'authz.deal_row_visible(uuid)'::regprocedure)
         order by 1`);
      expect(fns).toEqual([
        { fn: 'authz.deal_row_visible(uuid)', definer: true, config: ['search_path=""'], auth: false, svc: false, anon: false },
        { fn: 'record_staff_names(uuid[])', definer: true, config: ['search_path=""'], auth: true, svc: false, anon: false },
      ]);
    });
  });
});
