import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, claimsFor, createTestDb, resetActor } from '../helpers/db';
import { HOTEL_ITEM } from './acc-support';
import { ACC, MANAGER, MANAGER_AMD, PURCHASE, SQL2, acc2Helpers, rid, today } from './acc2-support';

/**
 * Lead fix-forward after the Phase 2 speed verification (12 Nov 2026):
 *
 *   20261204000900_manager_approvals_capped — the three Manager predicates
 *     rewritten set-based must return exactly the rows of their 20261130000210
 *     definitions (reproduced below as reference SQL); manager_approvals sends
 *     at most 50 rows per list in the unchanged order plus `<list>Total`; the
 *     Manager gate and the canVerify / canApprove self-checks are unchanged.
 *   20261204000910_accounts_daily_check_speed — supplierRefundsDue and
 *     urgentNoticesUnopenedOverOneWorkingDay equal their 20261204000410
 *     definitions (reference SQL below) before and after a supplier refund.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = acc2Helpers(() => db);
const { one, owner } = h;
const APPROVALS = 'select public.manager_approvals() as r';
const DAILY = 'select public.accounts_daily_check() as r';

/** Owner SQL with `actor`'s request claims (auth.uid()), as inside a definer function. */
async function ownerAs<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  await resetActor(db);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claimsFor(actor))]);
  const rows = await db.query<T>(sql, params);
  await resetActor(db);
  return rows;
}
const sorted = <T>(rows: T[]) => rows.map((r) => JSON.stringify(r)).sort();

// 20261130000210 bodies (the rows the set-based helpers must keep).
const OLD_COST_ROWS = `
  select t.id as task_id, c.version_no, c.created_at as since, c.created_by
  from public.fulfilment_tasks t
  cross join lateral (select * from authz.purchase_latest_cost(t.id)) c
  where t.department = 'purchase' and t.status = 'in_progress'
    and authz.is_branch_sales_manager(t.deal_id)
    and c.id is not null and c.stage = 'proposed'
    and (authz.task_budget(t.id) is null or c.amount_paise > authz.task_budget(t.id))
    and not authz.cost_version_approved(t.id, c.version_no)`;
const OLD_BANK_ROWS = `
  select s.id as supplier_id, r.revision_no, r.created_by, r.created_at
  from public.suppliers s
  cross join lateral (select * from public.supplier_beneficiary_revisions x
                      where x.supplier_id = s.id order by x.revision_no desc limit 1) r
  where r.status = 'unverified' and authz.can_verify_suppliers(s.legal_entity_id)`;
const OLD_SUPPLIER_ROWS = `
  select s.id as supplier_id, s.created_by <> (select auth.uid()) and s.updated_by <> (select auth.uid()) as can_verify
  from public.suppliers s
  where s.verification_status = 'unverified' and s.status = 'active' and authz.can_verify_suppliers(s.legal_entity_id)`;

type Approvals = Record<string, unknown> & {
  costsAboveBudget: Array<{ taskId: string; canApprove: boolean }>;
  bankDetails: Array<{ supplierId: string; revisionNo: number; canApprove: boolean }>;
  suppliersToVerify: Array<{ supplierId: string; canVerify: boolean }>;
};
const LISTS = ['costsAboveBudget', 'payments', 'funding', 'bankDetails', 'suppliersToVerify', 'cancellations', 'flightFares'] as const;

/** `n` unverified active suppliers in the Deal's entity, made by `by` (owner insert; names sort after the fixtures). */
async function unverifiedSuppliers(n: number, by: string, prefix: string): Promise<void> {
  await owner(
    `insert into public.suppliers (legal_entity_id, name, service_types, city, created_by, updated_by)
     select $1, $2 || lpad(g::text, 3, '0'), '{hotel}', 'Synthetic City', $3, $3 from generate_series(1, $4) g`,
    [await h.entityId(), prefix, by, n],
  );
}

describe('20261204000900 manager_approvals: 50 per list, totals, same rows and rules', () => {
  it('set-based predicates return the 20261130000210 rows (cost above budget, bank details, suppliers) for every viewer', async () => {
    await asOwner(db, async () => {
      const b = await h.approvedDeal([{ ...HOTEL_ITEM, budget: '4500000' }]);
      const task = h.taskOf(b, 'hotel');
      await h.purchaseCost(task, await h.purchaseSupplier(), '5000000');
      // An unverified bank revision and suppliers made by the Manager (self-check rows).
      const s2 = await h.purchaseSupplier();
      await one(PURCHASE, 'select public.supplier_add_beneficiary($1, $2, $3::jsonb) as r', [s2, rid(), JSON.stringify({
        accountHolder: 'Synthetic Stays', bankName: 'Synthetic Bank', ifsc: 'SYNB0000001', accountNumber: '000011119999' })]);
      await unverifiedSuppliers(3, U.managerDelhi, 'Synthetic Self Made ');
      for (const actor of [MANAGER, MANAGER_AMD, ACC, PURCHASE]) {
        const pairs = [
          [OLD_COST_ROWS, 'select * from authz.sm_manager_cost_rows()'],
          [OLD_BANK_ROWS, 'select * from authz.sm_manager_bank_rows()'],
          [OLD_SUPPLIER_ROWS, 'select * from authz.sm_manager_supplier_rows()'],
        ] as const;
        for (const [oldSql, newSql] of pairs) {
          expect(sorted(await ownerAs(actor, newSql)), `${actor.userId} ${newSql}`).toEqual(sorted(await ownerAs(actor, oldSql)));
        }
      }
      expect((await ownerAs(MANAGER, OLD_COST_ROWS)).map((r) => (r as { task_id: string }).task_id)).toContain(task);
      expect((await ownerAs(MANAGER, OLD_BANK_ROWS)).map((r) => (r as { supplier_id: string }).supplier_id)).toContain(s2);
      // After the approval the cost leaves both definitions.
      await one(MANAGER, 'select public.purchase_cost_approve_over_budget($1, $2) as r', [task, 1]);
      const after = await ownerAs<{ task_id: string }>(MANAGER, 'select * from authz.sm_manager_cost_rows()');
      expect(after.map((r) => r.task_id)).not.toContain(task);
      expect(sorted(after)).toEqual(sorted(await ownerAs(MANAGER, OLD_COST_ROWS)));
    });
  });

  it('suppliers to verify: the first 50 by name, the full count, canVerify unchanged; other entities never counted', async () => {
    await asOwner(db, async () => {
      await unverifiedSuppliers(53, U.purchaseJodhpur, 'Synthetic Cap ');
      await unverifiedSuppliers(2, U.managerDelhi, 'Synthetic Cap Self ');
      const otherEntity = (await owner<{ id: string }>(`select id from public.legal_entities where code = 'SYNTHETIC_B'`))[0]!.id;
      await owner(`insert into public.suppliers (legal_entity_id, name, service_types, created_by, updated_by) values ($1, 'Synthetic Other Entity', '{hotel}', $2, $2)`,
        [otherEntity, U.salesEntityB]);

      const expected = await ownerAs<{ supplier_id: string; can_verify: boolean }>(MANAGER,
        `select r.supplier_id, r.can_verify from authz.sm_manager_supplier_rows() r join public.suppliers s on s.id = r.supplier_id
         order by lower(s.name), s.id`);
      expect(expected.length).toBeGreaterThanOrEqual(55);
      const r = await one<Approvals>(MANAGER, APPROVALS);
      expect(r.suppliersToVerify).toHaveLength(50);
      expect(r.suppliersToVerifyTotal).toBe(expected.length);
      expect(r.suppliersToVerify.map((s) => [s.supplierId, s.canVerify])).toEqual(expected.slice(0, 50).map((e) => [e.supplier_id, e.can_verify]));
      const self = await owner<{ id: string }>(`select id from public.suppliers where name like 'Synthetic Cap Self %'`);
      for (const row of r.suppliersToVerify.filter((s) => self.some((x) => x.id === s.supplierId))) expect(row.canVerify).toBe(false);
      expect(JSON.stringify(r)).not.toContain('Synthetic Other Entity');
      for (const key of LISTS) {
        const total = r[`${key}Total`] as number;
        expect(Number.isInteger(total), key).toBe(true);
        expect(total, key).toBeGreaterThanOrEqual((r[key] as unknown[]).length);
        expect((r[key] as unknown[]).length, key).toBe(Math.min(total, 50));
      }
      // Home keeps counting the whole list (canVerify rows), not the 50 shown.
      const home = await one<{ managerApprovals: number }>(MANAGER, 'select public.supplier_money_home_counts() as r');
      expect(home.managerApprovals).toBeGreaterThanOrEqual(expected.filter((e) => e.can_verify).length);
    });
  });

  it('the Manager gate is unchanged: Accounts, Purchase and Sales are refused', async () => {
    await asOwner(db, async () => {
      for (const actor of [ACC, PURCHASE, { userId: U.salesDelhiA }]) await h.refused(actor, APPROVALS, [], 'not_authorized', '42501');
    });
  });
});

describe('20261204000910 accounts_daily_check: same values, set-based', () => {
  // 20261204000410 definitions of the two rewritten keys, for the caller's Accounts entities.
  const OLD_SUPPLIER_REFUNDS_DUE = `
    select count(*)::int as n from public.deal_cancellations c join public.deals d on d.id = c.deal_id
    where c.legal_entity_id = any(authz.acct_a_entities()) and d.is_synthetic = authz.acct_synthetic() and c.status = 'approved'
      and authz.notice_supplier_refund_open(c.id)`;
  const OLD_URGENT = `
    select coalesce(jsonb_agg(jsonb_build_object('branchName', g.name, 'count', g.n) order by g.name), '[]'::jsonb) as v
    from (select b.name, count(*)::int as n
          from public.staff_notices s join public.branches b on b.id = s.branch_id
          where s.legal_entity_id = any(authz.acct_a_entities()) and s.priority = 'urgent' and s.done_at is null and s.resolved_at is null
            and authz.finance_add_working_days((timezone('Asia/Kolkata', s.created_at))::date, 1) < authz.finance_today()
          group by b.name) g`;
  type Daily = { supplierRefundsDue: number; urgentNoticesUnopenedOverOneWorkingDay: unknown };
  async function same(): Promise<Daily> {
    const r = await one<Daily>(ACC, DAILY);
    expect(r.supplierRefundsDue).toBe((await ownerAs<{ n: number }>(ACC, OLD_SUPPLIER_REFUNDS_DUE))[0]!.n);
    expect(r.urgentNoticesUnopenedOverOneWorkingDay).toEqual((await ownerAs<{ v: unknown }>(ACC, OLD_URGENT))[0]!.v);
    return r;
  }

  it('supplier refunds due: expected refund open → 1; part received → 1; all received → 0; urgent notices per branch', async () => {
    await asOwner(db, async () => {
      // Hotel costed, cancellation with a Purchase charge (keeps ₹1,000, refund expected ₹39,000), approved.
      await h.noticesOn();
      const b = await h.approvedDeal([HOTEL_ITEM]);
      const task = h.taskOf(b, 'hotel');
      await h.purchaseCost(task, await h.purchaseSupplier());
      await h.receipt2('2500000');
      await h.refundsOn();
      const cancellationId = await h.openCancellation();
      await one(PURCHASE, SQL2.chargeSet, [task, '100000', '3900000', null, null, 0, rid()]);
      await one(PURCHASE, SQL2.cancelSend, [cancellationId, (await h.cancellationOf())!.row_version, rid()]);
      await one(MANAGER, SQL2.cancelDecide, [cancellationId, 'approve', null, (await h.cancellationOf())!.row_version, rid()]);
      const [charge] = await owner<{ id: string }>(
        'select id from public.purchase_cancellation_charges where cancellation_id = $1 order by revision_no desc limit 1', [cancellationId]);
      // Urgent notices of every branch, 0, 2, 4 and 6 days old (the guard refuses changing created_at, so insert them aged).
      await owner(`insert into public.staff_notices (legal_entity_id, branch_id, recipient_user_id, kind, priority, subject_kind, subject_id, dedup_key, created_at)
        select b.legal_entity_id, b.id, $1, 'cost_over_budget', 'urgent', 'task', gen_random_uuid(), 'lead-speed-' || b.id || '-' || g, now() - g * interval '2 days'
        from public.branches b cross join generate_series(0, 3) g where b.legal_entity_id = $2`, [U.accountsJodhpur, await h.entityId()]);

      const first = await same();
      expect(first.supplierRefundsDue).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(first.urgentNoticesUnopenedOverOneWorkingDay) && first.urgentNoticesUnopenedOverOneWorkingDay.length).toBeGreaterThan(1);
      const record = async (amount: string) => one(ACC, SQL2.supplierRefundRecord, [JSON.stringify({ sourceKind: 'purchase_charge', sourceId: charge!.id,
        amountPaise: amount, receivedOn: today(), mode: 'bank_transfer', reference: `SYNSR${rid().slice(0, 6)}`,
        evidenceId: await h.refundProof('supplier_refund', cancellationId), overExpectedReason: null }), rid()]);
      const before = (await same()).supplierRefundsDue;
      await record('3000000');
      expect((await same()).supplierRefundsDue).toBe(before);
      await record('900000');
      expect((await same()).supplierRefundsDue).toBe(before - 1);
    });
  });
});

describe('20261204000920 manager_cancellations_to_decide: the Approvals rows of manager_cancellation_list', () => {
  const OLD = 'select public.manager_cancellation_list() as r';
  const NEW = 'select public.manager_cancellations_to_decide() as r';
  type Row = { cancellationId: string; status: string; sentAt: string | null; canDecide: boolean };

  it('same rows and values as the full list, only those sent to the Manager, in the Approvals order; other viewers unchanged', async () => {
    await asOwner(db, async () => {
      // A case sent to the Manager (Purchase charge entered); later approved.
      const b = await h.approvedDeal([HOTEL_ITEM]);
      const task = h.taskOf(b, 'hotel');
      await h.purchaseCost(task, await h.purchaseSupplier());
      await h.receipt2('2500000');
      await h.refundsOn();
      const sentId = await h.openCancellation();
      await one(PURCHASE, SQL2.chargeSet, [task, '100000', '3900000', null, null, 0, rid()]);
      await one(PURCHASE, SQL2.cancelSend, [sentId, (await h.cancellationOf())!.row_version, rid()]);
      const full = await one<Row[]>(MANAGER, OLD);
      expect(full.filter((r) => r.cancellationId === sentId).map((r) => r.status)).toEqual(['sent_to_manager']);
      const waiting = await one<Row[]>(MANAGER, NEW);
      const expected = full.filter((r) => r.status === 'sent_to_manager')
        .sort((x, y) => (x.sentAt! < y.sentAt! ? -1 : x.sentAt! > y.sentAt! ? 1 : x.cancellationId < y.cancellationId ? -1 : 1));
      // At most 50 (a seeded stack may hold more waiting cases than the fixtures).
      expect(waiting).toEqual(expected.slice(0, 50));
      if (expected.length <= 50) expect(waiting.map((r) => r.cancellationId)).toContain(sentId);
      // The same cancellations as manager_approvals().cancellations.
      const ap = await one<{ cancellations: Array<{ cancellationId: string }> }>(MANAGER, APPROVALS);
      expect(waiting.map((r) => r.cancellationId)).toEqual(ap.cancellations.map((x) => x.cancellationId));
      // The Purchase person who entered the charge is not a Manager here; Accounts and the other branch's Manager see nothing.
      for (const actor of [ACC, PURCHASE, MANAGER_AMD]) {
        const old = await one<Row[]>(actor, OLD);
        const oldWaiting = old.filter((r) => r.status === 'sent_to_manager')
          .sort((x, y) => (x.sentAt! < y.sentAt! ? -1 : x.sentAt! > y.sentAt! ? 1 : x.cancellationId < y.cancellationId ? -1 : 1));
        expect(await one<Row[]>(actor, NEW), String(actor.userId)).toEqual(oldWaiting.slice(0, 50));
      }
      // Once decided it stays in the full list (approved) and leaves the Approvals rows.
      await one(MANAGER, SQL2.cancelDecide, [sentId, 'approve', null, (await h.cancellationOf())!.row_version, rid()]);
      expect((await one<Row[]>(MANAGER, OLD)).filter((r) => r.cancellationId === sentId).map((r) => r.status)).toEqual(['approved']);
      expect((await one<Row[]>(MANAGER, NEW)).map((r) => r.cancellationId)).not.toContain(sentId);
    });
  });

  it('anonymous callers are refused like the full list', async () => {
    await asOwner(db, async () => {
      await h.refused({ userId: null }, NEW, [], 'permission denied for function manager_cancellations_to_decide', '42501');
    });
  });
});

describe('20261204000930 originals by department: same rows as the department filter over all originals', () => {
  it('the four-argument originals equal the three-argument rows of that department, for every department and state', async () => {
    await asOwner(db, async () => {
      const b = await h.approvedDeal([HOTEL_ITEM]);
      await h.supplierConfirmed(h.taskOf(b, 'hotel'));
      const entity = await h.entityId();
      const all = await owner<Record<string, unknown>>('select * from authz.acct_original_items($1, null, null)', [entity]);
      expect(all.length).toBeGreaterThan(0);
      expect(new Set(all.map((r) => r.department)).size).toBeGreaterThan(1);
      for (const state of [null, 'missing', 'expected', 'any']) {
        const three = await owner<Record<string, unknown>>('select * from authz.acct_original_items($1, null, $2)', [entity, state]);
        expect(sorted(await owner('select * from authz.acct_original_items($1, null, $2, null)', [entity, state]))).toEqual(sorted(three));
        for (const dep of ['sales', 'accounts', 'purchase', 'flight', 'visa']) {
          expect(sorted(await owner('select * from authz.acct_original_items($1, null, $2, $3)', [entity, state, dep])), `${state} ${dep}`)
            .toEqual(sorted(three.filter((r) => r.department === dep)));
        }
      }
      // The workspace with the department filter: every row of that department; the originals rows included.
      for (const dep of ['accounts', 'purchase']) {
        const r = await one<{ items: Array<{ department: string; kind: string }> }>(ACC, 'select public.accounts_records($1::jsonb, null, 100) as r',
          [JSON.stringify({ department: dep })]);
        expect(r.items.every((i) => i.department === dep)).toBe(true);
        const origs = all.filter((o) => o.department === dep).length;
        if (origs > 0) expect(r.items.some((i) => i.kind === 'original')).toBe(true);
      }
    });
  });
});
