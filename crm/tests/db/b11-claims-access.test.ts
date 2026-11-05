import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACCOUNTS_DETAIL, ACCOUNTS_LIST, CLAIMS_SUITE_LOCK, FROM_CLAIM, LINK, NOT_RECEIVED, REPORT, SALES_VIEW, WITHDRAW, claimHelpers } from './b11-claims-support';
import { ACC, ANON, DEAL, MANAGER, PURCHASE, SALES, SALES_B, SUPER, rid } from './finance-support';

/**
 * B1.1b access matrix (appendix B section 5): the claims table is closed to
 * the Data API for every role; claim helpers are not executable; Purchase,
 * Flight, the Visa & Passport desk and Super Admin never see claims; Sales
 * sees only its own Deals' projection; Accounts reads and commands stay
 * Accounts-only (and never for a holder of the Purchase role).
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  if (db.mode === 'postgres') await db.query('select pg_advisory_lock($1::bigint)', [CLAIMS_SUITE_LOCK]);
});
afterAll(async () => {
  await db?.close();
});

const h = claimHelpers(() => db);
const VISA: Actor = { userId: U.visaJodhpur };
const FLIGHT: Actor = { userId: U.purchaseJodhpur }; // given a flight membership per test (and Purchase removed)

async function addFlightOnly(): Promise<void> {
  await h.owner(`update public.memberships set status = 'inactive' where user_id = $1 and role_code = 'purchase'`, [U.purchaseJodhpur]);
  await h.owner(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, 'flight', 'active' from public.branches b where b.code = 'JDH'`,
    [U.purchaseJodhpur],
  );
}

describe('table and function privileges', () => {
  it('the claims table has RLS, one restrictive policy and no privileges', async () => {
    await asOwner(db, async () => {
      const policies = await h.owner<{ policyname: string; permissive: string }>(
        `select policyname, permissive from pg_policies where schemaname = 'public' and tablename = 'customer_payment_claims'`,
      );
      expect(policies).toEqual([{ policyname: 'require_valid_session', permissive: 'RESTRICTIVE' }]);
      const [rls] = await h.owner<{ on: boolean }>(`select relrowsecurity as on from pg_class where oid = 'public.customer_payment_claims'::regclass`);
      expect(rls!.on).toBe(true);
      const grants = await h.owner(
        `select grantee, privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'customer_payment_claims' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')`,
      );
      expect(grants).toEqual([]);
    });
  });

  it('direct reads and writes are refused for every role', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      await h.report(SALES, h.cashClaim());
      await addFlightOnly();
      for (const actor of [ANON, SALES, MANAGER, ACC, PURCHASE, FLIGHT, VISA, SUPER]) {
        await h.refused(actor, 'select * from public.customer_payment_claims limit 1', [], '42501');
        await h.refused(actor, 'update public.customer_payment_claims set note = null', [], '42501');
        await h.refused(actor, 'delete from public.customer_payment_claims', [], '42501');
      }
    });
  });

  it('claim helpers are not executable; only the seven claim RPCs are, by authenticated only', async () => {
    await asOwner(db, async () => {
      const helpers = await h.owner<{ name: string }>(
        `select p.oid::regprocedure::text as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'authz' and (p.proname like 'finance_claim%' or p.proname = 'customer_payment_claims_guard')
           and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`,
      );
      expect(helpers).toEqual([]);
      const rpcs = await h.owner<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
        `select p.proname as name, has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ('payment_claim_report', 'payment_claim_withdraw', 'receipt_record_from_claim',
           'payment_claim_link_receipt', 'payment_claim_mark_not_received', 'deal_payment_claims', 'accounts_payment_claims')
         order by p.proname`,
      );
      expect(rpcs).toHaveLength(7);
      for (const r of rpcs) expect(r).toMatchObject({ anon: false, auth: true, svc: false });
    });
  });
});

describe('Sales projection visibility', () => {
  it('only the owner and active Sales assignees with commercial access see claims', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      await h.report(SALES, h.cashClaim());
      await addFlightOnly();
      expect((await h.salesView(SALES))!.claims).toHaveLength(1);
      for (const actor of [SALES_B, MANAGER, ACC, PURCHASE, FLIGHT, VISA, SUPER]) {
        expect(await h.salesView(actor)).toBeNull();
      }
      await h.refused({ ...SALES, aal: 'aal1' }, SALES_VIEW, [DEAL], '42501', 'not_authorized');
      await h.refused(ANON, SALES_VIEW, [DEAL], '42501');
      await h.addSalesAssignment(DEAL, U.salesDelhiB);
      expect((await h.salesView(SALES_B))!.claims).toHaveLength(1);
      expect(await h.salesView(SALES, rid())).toBeNull();
    });
  });

  it('a removed Deal shows nothing to Sales', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      await h.report(SALES, h.cashClaim());
      await h.markImported();
      await h.owner('alter table public.deals drop constraint deals_removed_imported_only'); // test-only
      await h.owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [DEAL]);
      expect(await h.salesView(SALES)).toBeNull();
    });
  });
});

describe('Accounts reads and commands', () => {
  it('everyone except Accounts is refused; Accounts with Purchase is refused', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const fields = h.cashClaim();
      const claim = await h.report(SALES, fields);
      const receipt = await h.record(ACC, DEAL, await h.cashFields());
      const receiptFields = JSON.stringify(await h.receiptFieldsFor(fields));
      await addFlightOnly();
      const calls: Array<[string, unknown[]]> = [
        [ACCOUNTS_LIST, ['all', null, null]],
        [FROM_CLAIM, [claim.id, receiptFields, rid()]],
        [LINK, [claim.id, receipt.id, null, rid()]],
        [NOT_RECEIVED, [claim.id, 'Synthetic reason long enough', rid()]],
      ];
      for (const actor of [SALES, MANAGER, PURCHASE, FLIGHT, VISA, SUPER]) {
        for (const [sql, params] of calls) await h.refused(actor, sql, params, '42501', 'not_authorized');
        expect(await h.one(actor, ACCOUNTS_DETAIL, [DEAL])).toBeNull();
      }
      for (const [sql, params] of calls) await h.refused({ ...ACC, aal: 'aal1' }, sql, params, '42501', 'not_authorized');
      await h.owner(
        `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
         select $1, b.legal_entity_id, b.id, 'purchase', 'active' from public.branches b where b.code = 'DEL'`,
        [U.accountsJodhpur],
      );
      for (const [sql, params] of calls) await h.refused(ACC, sql, params, '42501', 'not_authorized');
    });
  });

  it('Accounts commands follow the finance gate (environment and synthetic flag)', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const claim = await h.report(SALES, h.cashClaim());
      await h.setEnvironment('unset');
      await h.refused(ACC, NOT_RECEIVED, [claim.id, 'Synthetic reason long enough', rid()], '55000', 'environment_unset');
      await h.setEnvironment('operational');
      // Synthetic Deal in the operational environment.
      await h.refused(ACC, NOT_RECEIVED, [claim.id, 'Synthetic reason long enough', rid()], '55000', 'not_configured');
      // The list, like accounts_queue, filters synthetic Deals out instead of refusing.
      expect((await h.accountsList(ACC, 'all')).totalCount).toBe(0);
    });
  });

  it('Sales commands stay closed to Accounts, Purchase, Flight, the desk and Super Admin', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const claim = await h.report(SALES, h.cashClaim());
      await addFlightOnly();
      for (const actor of [ACC, PURCHASE, FLIGHT, VISA, SUPER]) {
        await h.refused(actor, REPORT, [DEAL, JSON.stringify(h.cashClaim()), rid()], '42501', 'not_authorized');
        await h.refused(actor, WITHDRAW, [claim.id, 1, 'Synthetic withdrawal reason', rid()], '42501', 'not_authorized');
      }
    });
  });
});
