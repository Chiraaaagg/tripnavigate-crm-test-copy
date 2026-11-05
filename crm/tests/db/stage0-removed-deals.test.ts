import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_DEALS as D, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACC, ACC2, DEAL, financeHelpers, rid, today } from './finance-support';

/**
 * Stage 0 removed-Deal rule (owner decision, 8 October 2026), migrations
 * 20261107000100_integration_sync_transition (removal records participants) and
 * 20261107000300_removed_deal_work_pause (command checks, conflict history):
 *
 *   - a Deal soft-removed by the Bitrix sync (deals.removed_at) refuses NEW booking,
 *     commitment and receipt work with 'deal_removed' (SQLSTATE 55000);
 *   - recorded money, history, reversals, verification, existing cash deposit and
 *     cheque clearance stay usable;
 *   - the owner and Sales assignees recorded at removal stay in approval-conflict
 *     checks, also after a restore.
 *
 * Only imported Deals can be removed. Each scenario builds its booking, purchase or
 * finance history on the synthetic fixture deal SYN-DEL-001 (owner Sales Delhi A),
 * then marks that row imported inside the rolled-back transaction (the provenance
 * checks are dropped for the test only, as in finance-race-caps) and removes it
 * through authz.remove_bitrix_deals, the one removal path of the sync.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = financeHelpers(() => db);
const { one, refused, owner } = h;

const SALES_A: Actor = { userId: U.salesDelhiA }; // owner of SYN-DEL-001
const SALES_B: Actor = { userId: U.salesDelhiB };
const PURCHASE: Actor = { userId: U.purchaseJodhpur };
const MANAGER: Actor = { userId: U.managerDelhi };
const OTHER_ENTITY: Actor = { userId: U.salesEntityB };
const ANON: Actor = { userId: null };

const FACTS = {
  hotelName: 'Synthetic Hotel (fixture)', city: 'Synthetic City', checkIn: '2026-12-10', checkOut: '2026-12-13',
  rooms: 2, roomType: 'Synthetic Deluxe', mealPlan: 'Breakfast', adults: 3, children: 1,
  inclusions: 'Synthetic pickup', specialRequests: null, purchaseBudgetPaise: '4500000',
};
const SAVE = 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, true) as r';
const BEGIN_EVIDENCE = 'select public.booking_begin_evidence($1, $2, $3, $4, $5, $6) as r';
const QUOTE = 'select public.purchase_quote_add($1, $2, $3::jsonb) as r';
const PROPOSE = 'select public.purchase_cost_propose($1, $2, $3, $4::bigint, $5::date, $6, $7) as r';
const CONFIRM = 'select public.purchase_supplier_confirm($1, $2, $3) as r';
const APPROVE_COST = 'select public.purchase_cost_approve_over_budget($1, $2) as r';

/** SYN-DEL-001 becomes an imported Bitrix Deal (Bitrix responsible 101 = Sales Delhi A). */
async function markImported(dealId: string = DEAL): Promise<void> {
  await db.exec('alter table public.deals drop constraint deals_provenance');
  await db.exec('alter table public.deals drop constraint deals_source_assigned_by_provenance');
  // Its synthetic commercial row keeps pointing at the synthetic flag.
  await db.exec('alter table public.deal_commercials drop constraint deal_commercials_synthetic_parent');
  await owner(
    `update public.deals set is_synthetic = false, source_system = 'bitrix', source_portal = 'SYNTHETIC_MEMBER_0001',
       source_deal_id = 990001, source_assigned_by_id = 101 where id = $1`,
    [dealId],
  );
}
async function removeDeal(dealId: string = DEAL, reason = 'pipeline_not_eligible'): Promise<number> {
  return (await owner<{ n: number }>('select authz.remove_bitrix_deals(array[$1]::uuid[], $2) as n', [dealId, reason]))[0]!.n;
}
async function addMembership(userId: string, branchCode: string, role: string): Promise<void> {
  await owner(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, $3, 'active' from public.branches b where b.code = $2`,
    [userId, branchCode, role],
  );
}
async function operational(): Promise<void> {
  await h.setEnvironment('operational');
  await owner(
    `update public.finance_live_settings set bank_transfer_live = true, upi_live = true, cash_live = true, cheque_live = true
     where legal_entity_id = $1`,
    [await h.entityId()],
  );
}

async function draft(actor: Actor = SALES_A): Promise<{ versionId: string; rowVersion: number }> {
  const opened = await one<{ versionId: string; rowVersion: number }>(actor, 'select public.booking_open_draft($1) as r', [DEAL]);
  const saved = await one<{ rowVersion: number }>(actor, SAVE, [opened.versionId, opened.rowVersion, JSON.stringify(FACTS), '9876543']);
  return { versionId: opened.versionId, rowVersion: saved.rowVersion };
}

/** Claimed purchase task on SYN-DEL-001 with a supplier, an open quote and one over-budget proposal. */
async function purchaseTask(): Promise<{ taskId: string; quoteId: string; supplierId: string }> {
  await h.confirmedBooking(DEAL, SALES_A);
  const [task] = await owner<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1`, [DEAL]);
  await one(PURCHASE, 'select public.purchase_task_claim($1) as r', [task!.id]);
  const { supplierId } = await one<{ supplierId: string }>(PURCHASE, 'select public.supplier_create($1, $2::jsonb) as r', [
    await h.entityId(),
    JSON.stringify({
      name: 'Synthetic Stays Ltd', serviceTypes: ['hotel'], city: 'Synthetic City', contactName: 'Synthetic Desk',
      contactPhone: '+91 00000 00000', contactEmail: 'desk@example.test', paymentTerms: 'Synthetic: 50% at confirmation',
    }),
  ]);
  const { quoteId } = await one<{ quoteId: string }>(PURCHASE, QUOTE, [task!.id, rid(), quoteFields(supplierId)]);
  await one(PURCHASE, PROPOSE, [task!.id, quoteId, 0, '4600000', '2026-11-25', null, rid()]);
  return { taskId: task!.id, quoteId, supplierId };
}
const quoteFields = (supplierId: string) =>
  JSON.stringify({
    supplierId, hotelName: 'Synthetic Hotel (fixture)', roomType: 'Synthetic Deluxe', mealPlan: 'Breakfast',
    quotedCostPaise: '4000000', holdUntil: '2026-11-30', cancellationTerms: 'Synthetic: free until 7 days before arrival',
  });

describe('removal keeps who was on the Deal', () => {
  it('records the owner and every active assignee, then clears the owner and ends (keeps) the assignments', async () => {
    await asOwner(db, async () => {
      // The fixture already assigns Purchase Jodhpur to SYN-DEL-001.
      await h.addSalesAssignment(DEAL, U.salesDelhiB);
      await markImported();
      expect(await removeDeal()).toBe(1);
      // Removing again changes nothing (idempotent).
      expect(await removeDeal()).toBe(0);

      const [deal] = await owner<{ owner_user_id: string | null; removed_reason: string }>(
        'select owner_user_id, removed_reason from public.deals where id = $1',
        [DEAL],
      );
      expect(deal).toEqual({ owner_user_id: null, removed_reason: 'pipeline_not_eligible' });
      const assignments = await owner<{ user_id: string; ended: boolean }>(
        `select user_id, ended_at is not null as ended from public.deal_assignments where deal_id = $1 order by user_id`,
        [DEAL],
      );
      expect(assignments).toHaveLength(2); // Purchase (fixture) and Sales Delhi B
      expect(assignments.every((a) => a.ended)).toBe(true);

      const recorded = await owner<{ user_id: string; participation: string; removed_reason: string }>(
        `select user_id, participation, removed_reason from public.deal_removal_participants
         where deal_id = $1 order by participation, user_id`,
        [DEAL],
      );
      expect(recorded).toEqual(
        expect.arrayContaining([
          { user_id: U.salesDelhiA, participation: 'owner', removed_reason: 'pipeline_not_eligible' },
          { user_id: U.salesDelhiB, participation: 'sales', removed_reason: 'pipeline_not_eligible' },
          { user_id: U.purchaseJodhpur, participation: 'purchase', removed_reason: 'pipeline_not_eligible' },
        ]),
      );
    });
  });

  it('the history is append-only and has no API access', async () => {
    await asOwner(db, async () => {
      await markImported();
      await removeDeal();
      const fails = (sql: string) => refused(SALES_A, sql, [], '42501');
      await fails('select * from public.deal_removal_participants');
      await refused(ACC, 'select * from public.deal_removal_participants', [], '42501');
      // Even the owner connection cannot rewrite it.
      await expect(
        db.query(`update public.deal_removal_participants set user_id = $1 where deal_id = $2`, [U.salesDelhiB, DEAL]),
      ).rejects.toMatchObject({ code: '42501' });
    });
    await asOwner(db, async () => {
      await markImported();
      await removeDeal();
      await expect(db.query('delete from public.deal_removal_participants where deal_id = $1', [DEAL])).rejects.toMatchObject({
        code: '42501',
      });
    });
  });
});

describe('booking: new work refuses deal_removed', () => {
  it('open, save, evidence and confirm refuse deal_removed for entity members; others keep not_authorized', async () => {
    await asOwner(db, async () => {
      const d = await draft();
      await markImported();
      await removeDeal();
      await refused(SALES_A, 'select public.booking_open_draft($1) as r', [DEAL], '55000', 'deal_removed');
      await refused(SALES_A, SAVE, [d.versionId, d.rowVersion, JSON.stringify(FACTS), '9876543'], '55000', 'deal_removed');
      await refused(
        SALES_A,
        BEGIN_EVIDENCE,
        [d.versionId, 'acceptance_message', 'acceptance.pdf', 'application/pdf', 2048, 'a'.repeat(64)],
        '55000',
        'deal_removed',
      );
      await refused(SALES_A, 'select public.booking_confirm($1, $2) as r', [d.versionId, 'x'.repeat(64)], '55000', 'deal_removed');
      // The branch manager (entity member) gets the same answer.
      await refused(MANAGER, 'select public.booking_open_draft($1) as r', [DEAL], '55000', 'deal_removed');
      // Outside the legal entity or signed out: nothing about the removal is revealed.
      await refused(OTHER_ENTITY, 'select public.booking_open_draft($1) as r', [DEAL], '42501', 'not_authorized');
      await refused(ANON, 'select public.booking_open_draft($1) as r', [DEAL], '42501');
      // Nothing was written.
      const [n] = await owner<{ n: number }>('select count(*)::int as n from public.booking_versions where deal_id = $1', [DEAL]);
      expect(n!.n).toBe(1);
    });
  });

  it('a Deal that is not removed is unaffected (control)', async () => {
    await asOwner(db, async () => {
      const d = await draft();
      expect(d.rowVersion).toBeGreaterThan(0);
    });
  });
});

describe('purchase: new commitment refuses deal_removed', () => {
  it('quote, cost proposal, over-budget approval and supplier confirmation refuse deal_removed', async () => {
    await asOwner(db, async () => {
      const { taskId, quoteId, supplierId } = await purchaseTask();
      await markImported();
      await removeDeal();
      await refused(PURCHASE, QUOTE, [taskId, rid(), quoteFields(supplierId)], '55000', 'deal_removed');
      await refused(PURCHASE, PROPOSE, [taskId, quoteId, 1, '4000000', '2026-11-25', null, rid()], '55000', 'deal_removed');
      await refused(PURCHASE, CONFIRM, [taskId, 1, 'SYN-CONF-REMOVED'], '55000', 'deal_removed');
      await refused(PURCHASE, 'select public.purchase_evidence_begin($1, $2, $3, $4, $5, $6) as r',
        [taskId, 'supplier_confirmation', 'supplier.pdf', 'application/pdf', 2048, 'b'.repeat(64)], '55000', 'deal_removed');
      await refused(MANAGER, APPROVE_COST, [taskId, 1], '55000', 'deal_removed');
      const [costs] = await owner<{ n: number }>('select count(*)::int as n from public.purchase_cost_versions where task_id = $1', [taskId]);
      expect(costs!.n).toBe(1);
    });
  });
});

describe('finance: new receipts refuse deal_removed; recorded money stays usable', () => {
  it('record refuses; an exact retry replays; verify, reverse, cheque clearance and cash deposit work', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      // History recorded while the Deal was current (synthetic, test environment).
      const bankFields = await h.bankFields();
      const bankRequest = rid();
      const bank = await h.record(ACC, DEAL, bankFields, bankRequest);
      await h.proof(ACC, 'receipt', bank.id, 'bank_proof');
      await h.verify(ACC2, bank.id);
      const cashPending = await h.record(ACC, DEAL, await h.cashFields());
      const cashVerified = await h.verifiedCash(DEAL, { payerPan: 'LMNOP4321Q', amountPaise: '500000' });
      const cheque = await h.record(ACC, DEAL, await h.chequeFields());
      await h.proof(ACC, 'receipt', cheque.id, 'cheque_image');
      expect((await h.verify(ACC2, cheque.id)).status).toBe('pending_clearance');
      await h.proof(ACC, 'receipt', cheque.id, 'bank_proof');

      await markImported();
      await removeDeal();
      // Imported Deals are finance work only in the operational environment.
      await operational();

      // New money on the removed Deal: refused, for every mode.
      for (const fields of [await h.bankFields(), await h.cashFields({ payerPan: 'ZYXWV9876A' }), await h.chequeFields()]) {
        await refused(ACC, h.RECORD, [DEAL, JSON.stringify(fields), rid()], '55000', 'deal_removed');
      }
      // The exact retry of a receipt recorded before the removal replays the stored result.
      expect(await h.record(ACC, DEAL, bankFields, bankRequest)).toMatchObject({ outcome: 'existing', id: bank.id });

      // Recorded money stays usable.
      expect((await h.verify(ACC2, cashPending.id)).status).toBe('verified');
      expect((await h.reverse(ACC, bank.id, 'data_error')).status).toBe('reversed');
      expect((await h.clear(ACC2, cheque.id)).status).toBe('cleared');
      const branch = await h.branchId('JDH');
      const slip = await h.proof(ACC, 'branch', branch, 'deposit_slip');
      const dep = await one<{ id: string; status: string }>(
        ACC,
        'select public.cash_deposit_record($1, $2::uuid[], $3::date, $4, $5, $6) as r',
        [branch, [cashVerified.id], today(), 'SLIP-REMOVED-01', slip, rid()],
      );
      expect(dep.status).toBe('recorded');
      await one(ACC2, 'select public.cash_deposit_verify($1, $2) as r', [dep.id, rid()]);
      // History reads still work.
      const detail = await one<{ receipts: Array<{ receiptId: string }> }>(ACC, 'select public.accounts_deal_detail($1) as r', [DEAL]);
      expect(detail.receipts.map((r) => r.receiptId)).toEqual(expect.arrayContaining([bank.id, cashPending.id, cheque.id]));
    });
  });
});

describe('approval conflicts survive removal', () => {
  it('the removed owner and Sales assignee stay conflicted (also after a restore); others are not', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      await h.addSalesAssignment(DEAL, U.salesDelhiB);
      const pending = await h.record(ACC, DEAL, await h.cashFields());
      const pending2 = await h.record(ACC, DEAL, await h.cashFields({ payerPan: 'QWERT1234Y', amountPaise: '20000' }));
      await markImported();
      await removeDeal();
      await operational();
      // Both people later hold Accounts.
      await addMembership(U.salesDelhiA, 'DEL', 'accounts');
      await addMembership(U.salesDelhiB, 'DEL', 'accounts');
      for (const actor of [SALES_A, SALES_B]) {
        await refused(actor, 'select public.receipt_verify($1, $2) as r', [pending.id, rid()], '42501', 'not_self_approval');
      }
      const detail = await one<{ receipts: Array<{ receiptId: string; actions: Record<string, string | null> }> }>(
        SALES_B,
        'select public.accounts_deal_detail($1) as r',
        [DEAL],
      );
      expect(detail.receipts.find((r) => r.receiptId === pending.id)!.actions.verify).toBe('deal_conflict');

      // A restore by the sync does not erase the history.
      await owner(`update public.deals set removed_at = null, removed_reason = null where id = $1`, [DEAL]);
      await refused(SALES_B, 'select public.receipt_verify($1, $2) as r', [pending.id, rid()], '42501', 'not_self_approval');

      // Someone who was never on the Deal verifies normally.
      expect((await h.verify(ACC2, pending.id)).status).toBe('verified');
      expect((await h.verify(ACC2, pending2.id)).status).toBe('verified');
    });
  });

  it('control: without a removal, an ended Sales assignment is still not a conflict', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const cash = await h.record(ACC, D.del001, await h.cashFields());
      await owner(
        `insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, ended_at)
         select d.id, d.legal_entity_id, $2, 'sales', now() from public.deals d where d.id = $1`,
        [D.del001, U.visaJodhpur],
      );
      expect((await h.verify(ACC2, cash.id)).status).toBe('verified');
    });
  });
});
