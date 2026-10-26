import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MyWorkCounts } from '@/modules/fulfilment/contracts';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACC, ACC2, financeHelpers } from './finance-support';
import {
  ACCOUNTS, ANON, BUDGETS, COUNTS_SQL, DEAL, DEAL2, DEAL_AMD, FLIGHT, FLIGHT_CLAIM_SQL, HOTEL, MANAGER, MANAGER_AMD, OWNER,
  PURCHASE, PURCHASE_CLAIM_SQL, PURCHASE_LIST_SQL, SALES_AMD, SALES_B, SUMMARY_SQL, SUPER, TRANSFER, b1Helpers,
} from './b1-support';

/**
 * B1 Home counts and Deal progress (migration 20261118000100):
 * my_work_counts per role equals the queue it mirrors (freeze note section 4,
 * Accounts rules per the finance read-through), deal_service_summary with its
 * role filter, the backfill count relationships and the legacy task link.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b1Helpers(() => db);
const { one, refused, owner, setSwitch, openDraft, addItem, confirm, readyPackage, readyHotel, insertRealDeal, addFlight } = h;
const f = financeHelpers(() => db);

// Batch 1 (20261121000120) adds draftsToContinue to the reply; it has its own tests in
// batch1-my-work-list.test.ts. The exact-shape assertions here cover the earlier keys unchanged.
const counts = async (actor = OWNER) => {
  // Batch 3 (20261123000100) adds quotationDraftsToFinish and acceptedQuotesToLink; their own tests are in
  // batch1-my-work-list.test.ts and batch3-referral.test.ts.
  const { draftsToContinue, quotationDraftsToFinish, acceptedQuotesToLink, ...rest } = await one<MyWorkCounts & {
    draftsToContinue?: number | null; quotationDraftsToFinish?: number | null; acceptedQuotesToLink?: number | null }>(actor, COUNTS_SQL);
  void draftsToContinue;
  void quotationDraftsToFinish;
  void acceptedQuotesToLink;
  return rest;
};
// B1.1c (20261119000500): visaTasksWaiting, claimsToProcess, expensesToReview (null when not applicable).
const ZERO: MyWorkCounts & Record<string, unknown> = {
  waitingForMe: 0, returnedToMe: 0, missingDetails: 0, intakeNeeded: 0, receiptsToVerify: null, requestsToApprove: null,
  visaTasksWaiting: null, claimsToProcess: null, expensesToReview: null,
};
const ZERO_ACC = { ...ZERO, claimsToProcess: 0, expensesToReview: 0 };
const ZERO_VISA = { ...ZERO, visaTasksWaiting: 0 }; // visa.jodhpur holds the Visa role (fixtures)

describe('my_work_counts', () => {
  it('Sales and Manager: drafts the caller may edit, their repair subset, returned reviews', async () => {
    await asOwner(db, async () => {
      expect(await counts(OWNER)).toEqual(ZERO);
      expect(await counts(MANAGER)).toEqual({ ...ZERO, requestsToApprove: 0 });
      await refused(ANON, COUNTS_SQL, [], '42501');
      await setSwitch('service_items_enabled', true);
      const opened = await openDraft(OWNER, DEAL); // empty package draft: waiting + missing details
      await openDraft(SALES_B, DEAL2); // another Delhi draft: the branch manager counts both
      await openDraft(SALES_AMD, DEAL_AMD); // Ahmedabad: not Delhi's manager
      expect(await counts(OWNER)).toEqual({ ...ZERO, waitingForMe: 1, missingDetails: 1 });
      expect(await counts(SALES_B)).toEqual({ ...ZERO, waitingForMe: 1, missingDetails: 1 });
      expect(await counts(MANAGER)).toEqual({ ...ZERO, waitingForMe: 2, missingDetails: 2, requestsToApprove: 0 });
      // Manager Ahmedabad holds no live deal.read grant in the fixtures (expired/revoked), so nothing is editable.
      expect(await counts(MANAGER_AMD)).toEqual({ ...ZERO, requestsToApprove: 0 });
      // A ready draft is still waiting but no longer missing details.
      let rv = (await addItem(OWNER, opened.versionId, opened.rowVersion, 'transfer', TRANSFER)).rowVersion;
      rv = (await h.saveTravellers(OWNER, DEAL, rv)).rowVersion;
      rv = (await h.saveSelling(OWNER, opened.versionId, rv)).rowVersion;
      rv = await h.completeB11(OWNER, DEAL, opened.versionId, rv);
      await h.storeEvidence(OWNER, opened.versionId);
      expect((await h.readiness(OWNER, opened.versionId)).issues).toEqual([]);
      expect(await counts(OWNER)).toEqual({ ...ZERO, waitingForMe: 1, missingDetails: 0 });
      // Confirmed: nothing waits for Sales; a returned Accounts review counts for the owner and the branch manager only.
      const { contentHash } = await h.readiness(OWNER, opened.versionId);
      await confirm(OWNER, opened.versionId, contentHash);
      expect(await counts(OWNER)).toEqual(ZERO);
      await one(ACC, 'select public.accounts_review_return($1, $2, $3) as r', [opened.versionId, 'Synthetic return reason for test', crypto.randomUUID()]);
      expect(await counts(OWNER)).toEqual({ ...ZERO, returnedToMe: 1 });
      expect(await counts(MANAGER)).toEqual({ ...ZERO, waitingForMe: 1, missingDetails: 1, returnedToMe: 1, requestsToApprove: 0 });
      expect(await counts(SALES_B)).toEqual({ ...ZERO, waitingForMe: 1, missingDetails: 1 });
      expect(await counts(MANAGER_AMD)).toMatchObject({ returnedToMe: 0 });
      expect(rv).toBeGreaterThan(1);
    });
  });

  it('Purchase and Flight: not-started tasks of their department plus their own in-progress tasks, equal to the queue', async () => {
    await asOwner(db, async () => {
      await addFlight();
      expect(await counts(PURCHASE)).toEqual(ZERO);
      expect(await counts(FLIGHT)).toEqual(ZERO_VISA);
      const ready = await readyPackage(); // hotel, transfer, activity, flight
      const { taskIds } = await confirm(OWNER, ready.versionId, ready.hash);
      const queue = await one<Array<{ taskId: string; status: string }>>(PURCHASE, PURCHASE_LIST_SQL);
      expect(queue).toHaveLength(3);
      expect(await counts(PURCHASE)).toEqual({ ...ZERO, waitingForMe: 3 });
      expect(await counts(FLIGHT)).toEqual({ ...ZERO_VISA, waitingForMe: 1 });
      // Taking a task keeps it in the taker's count (in progress, theirs) and out of nobody else's.
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [queue[0]!.taskId]);
      expect(await counts(PURCHASE)).toEqual({ ...ZERO, waitingForMe: 3 });
      await one(FLIGHT, FLIGHT_CLAIM_SQL, [taskIds![3]]);
      expect(await counts(FLIGHT)).toEqual({ ...ZERO_VISA, waitingForMe: 1 });
      // Same numbers as the queues: not started, or in progress and mine.
      const purchaseQueue = await one<Array<{ status: string; assignedToYou: boolean }>>(PURCHASE, PURCHASE_LIST_SQL);
      expect(purchaseQueue.filter((t) => t.status === 'not_started' || (t.status === 'in_progress' && t.assignedToYou))).toHaveLength(3);
      // Sales still counts nothing for tasks.
      expect(await counts(OWNER)).toEqual(ZERO);
    });
  });

  it('Accounts: waitingForMe = accounts_queue needs_review total; receiptsToVerify excludes own records; null without the role', async () => {
    await asOwner(db, async () => {
      await f.addSecondAccounts();
      // Nobody else gets a receipts count.
      for (const actor of [OWNER, MANAGER, PURCHASE, SUPER]) expect((await counts(actor)).receiptsToVerify).toBeNull();
      const before = await counts(ACCOUNTS);
      expect(before).toEqual({ ...ZERO_ACC, receiptsToVerify: 0 });
      const versionId = await f.confirmedBooking(DEAL, OWNER);
      const queue = await one<{ totalCount: number }>(ACC, `select public.accounts_queue('needs_review') as r`);
      expect(queue.totalCount).toBe(1);
      expect(await counts(ACCOUNTS)).toEqual({ ...ZERO_ACC, waitingForMe: 1, receiptsToVerify: 0 });
      // A receipt recorded by Accounts 1 is "to verify" for Accounts 2 only.
      await f.record(ACC, DEAL, await f.bankFields());
      expect(await counts(ACCOUNTS)).toEqual({ ...ZERO_ACC, waitingForMe: 1, receiptsToVerify: 0 });
      expect(await counts(ACC2)).toEqual({ ...ZERO_ACC, visaTasksWaiting: 0, waitingForMe: 1, receiptsToVerify: 1 });
      const awaiting = await one<{ totalCount: number }>(ACC2, `select public.accounts_queue('awaiting_verification') as r`);
      expect(awaiting.totalCount).toBe(1);
      // Returned review leaves the needs_review queue; the count follows.
      await one(ACC, 'select public.accounts_review_return($1, $2, $3) as r', [versionId, 'Synthetic return reason for test', crypto.randomUUID()]);
      expect((await one<{ totalCount: number }>(ACC, `select public.accounts_queue('needs_review') as r`)).totalCount).toBe(0);
      expect(await counts(ACCOUNTS)).toEqual({ ...ZERO_ACC, waitingForMe: 0, receiptsToVerify: 0 });
      // Accounts holder with an empty gate (environment unset): 0, not null, and no error.
      await f.setEnvironment('unset');
      expect(await counts(ACC2)).toEqual({ ...ZERO_ACC, visaTasksWaiting: 0, waitingForMe: 0, receiptsToVerify: 0 });
    });
  });

  it('intakeNeeded: only while intake_prompt_enabled, Bitrix Deals in a trigger stage without a booking, for the owner and the branch manager', async () => {
    await asOwner(db, async () => {
      const dealId = await insertRealDeal('UC_AD0SLH', 0);
      expect((await counts(OWNER)).intakeNeeded).toBe(0);
      await setSwitch('intake_prompt_enabled', true);
      expect((await counts(OWNER)).intakeNeeded).toBe(1);
      expect((await counts(MANAGER)).intakeNeeded).toBe(1);
      expect((await counts(SALES_B)).intakeNeeded).toBe(0);
      expect((await counts(MANAGER_AMD)).intakeNeeded).toBe(0);
      await owner(`update public.deals set source_stage_id = 'PREPARATION' where id = $1`, [dealId]);
      expect((await counts(OWNER)).intakeNeeded).toBe(0);
      await owner(`update public.deals set source_stage_id = 'UC_AD0SLH' where id = $1`, [dealId]);
      await setSwitch('service_items_enabled', true);
      await openDraft(OWNER, dealId);
      expect((await counts(OWNER)).intakeNeeded).toBe(0);
      // Synthetic Deals never count (no Bitrix stage).
      expect((await counts(SALES_AMD)).intakeNeeded).toBe(0);
    });
  });
});

describe('deal_service_summary', () => {
  it('returns progress and service types per readable Deal, in the order asked, department-filtered for Purchase and Flight', async () => {
    await asOwner(db, async () => {
      await addFlight();
      const ready = await readyPackage();
      const { taskIds } = await confirm(OWNER, ready.versionId, ready.hash);
      await setSwitch('service_items_enabled', true);
      const draft = await openDraft(SALES_B, DEAL2);
      await addItem(SALES_B, draft.versionId, draft.rowVersion, 'activity', { name: 'Synthetic walk', city: 'Synthetic City', date: '2026-12-12', participants: 2 });
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [taskIds![1]]);

      const forManager = await one<Array<Record<string, unknown>>>(MANAGER, SUMMARY_SQL, [[DEAL2, DEAL, DEAL_AMD, crypto.randomUUID()]]);
      expect(forManager.map((d) => d.dealId)).toEqual([DEAL2, DEAL]); // Ahmedabad and the unknown id are omitted
      expect(forManager[0]).toEqual({
        dealId: DEAL2, serviceTypes: ['activity'], total: 1,
        byState: { planned: 1, waitingForLaunch: 0, notStarted: 0, inProgress: 0, supplierConfirmed: 0, completed: 0 }, fulfilled: false, staleCount: 0, needs: ['confirm_version'],
      });
      expect(forManager[1]).toEqual({
        dealId: DEAL, serviceTypes: ['hotel', 'transfer', 'activity', 'flight'], total: 4,
        byState: { planned: 0, waitingForLaunch: 0, notStarted: 3, inProgress: 1, supplierConfirmed: 0, completed: 0 }, fulfilled: false, staleCount: 0, needs: ['take_task', 'supplier_confirmation'],
      });
      // Purchase Jodhpur is assigned to SYN-DEL-001 only: one Deal, purchase items only.
      const forPurchase = await one<Array<Record<string, unknown>>>(PURCHASE, SUMMARY_SQL, [[DEAL, DEAL2]]);
      expect(forPurchase).toEqual([{
        dealId: DEAL, serviceTypes: ['hotel', 'transfer', 'activity'], total: 3,
        byState: { planned: 0, waitingForLaunch: 0, notStarted: 2, inProgress: 1, supplierConfirmed: 0, completed: 0 }, fulfilled: false, staleCount: 0, needs: ['take_task', 'supplier_confirmation'],
      }]);
      // Flight sees nothing until assigned; after the claim, flight items only.
      expect(await one<unknown[]>(FLIGHT, SUMMARY_SQL, [[DEAL]])).toEqual([]);
      await one(FLIGHT, FLIGHT_CLAIM_SQL, [taskIds![3]]);
      expect(await one<Array<Record<string, unknown>>>(FLIGHT, SUMMARY_SQL, [[DEAL]])).toEqual([{
        dealId: DEAL, serviceTypes: ['flight'], total: 1,
        byState: { planned: 0, waitingForLaunch: 0, notStarted: 0, inProgress: 1, supplierConfirmed: 0, completed: 0 }, fulfilled: false, staleCount: 0, needs: ['supplier_confirmation'],
      }]);
      expect(await one<unknown[]>(OWNER, SUMMARY_SQL, [[]])).toEqual([]);
      await refused(OWNER, SUMMARY_SQL, [Array.from({ length: 51 }, () => crypto.randomUUID())], '22023', 'invalid_input');
      await refused(ANON, SUMMARY_SQL, [[DEAL]], '42501');
      expect(JSON.stringify(forPurchase)).not.toMatch(new RegExp(`${BUDGETS.hotel}|Synthetic`));
    });
  });

  it('fulfilled only when every item is supplier-confirmed; a Deal without items has total 0', async () => {
    await asOwner(db, async () => {
      const hotel = await readyHotel();
      const { taskId } = await confirm(OWNER, hotel.versionId, hotel.hash);
      const [row] = await one<Array<Record<string, unknown>>>(OWNER, SUMMARY_SQL, [[DEAL, DEAL2]]);
      expect(row).toMatchObject({ dealId: DEAL, serviceTypes: ['hotel'], total: 1, fulfilled: false, needs: ['take_task'] });
      const [empty] = (await one<Array<Record<string, unknown>>>(SALES_B, SUMMARY_SQL, [[DEAL2]]));
      expect(empty).toEqual({ dealId: DEAL2, serviceTypes: [], total: 0, byState: { planned: 0, waitingForLaunch: 0, notStarted: 0, inProgress: 0, supplierConfirmed: 0, completed: 0 }, fulfilled: false, staleCount: 0, needs: [] });
      // Supplier confirmation through the Phase 4 commands (synthetic task, test environment).
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [taskId]);
      const [entity] = await owner<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`);
      const { supplierId } = await one<{ supplierId: string }>(PURCHASE, 'select public.supplier_create($1, $2::jsonb) as r', [
        entity!.id,
        JSON.stringify({ name: 'Synthetic Stays Ltd', serviceTypes: ['hotel'], city: 'Synthetic City', contactName: 'Synthetic Desk',
          contactPhone: '+91 00000 00000', contactEmail: 'desk@example.test', paymentTerms: 'Synthetic: 50% at confirmation' }),
      ]);
      const { quoteId } = await one<{ quoteId: string }>(PURCHASE, 'select public.purchase_quote_add($1, $2, $3::jsonb) as r', [
        taskId, crypto.randomUUID(),
        JSON.stringify({ supplierId, hotelName: HOTEL.hotelName, roomType: 'Synthetic Deluxe', mealPlan: 'Breakfast', quotedCostPaise: '4000000',
          holdUntil: '2026-11-30', cancellationTerms: 'Synthetic: free until 7 days before arrival' }),
      ]);
      await one(PURCHASE, 'select public.purchase_cost_propose($1, $2, $3, $4::bigint, $5::date, $6, $7) as r', [taskId, quoteId, 0, '4000000', '2026-11-25', null, crypto.randomUUID()]);
      const ev = await one<{ evidenceId: string; objectPath: string }>(PURCHASE, 'select public.purchase_evidence_begin($1, $2, $3, $4, $5, $6) as r', [
        taskId, 'supplier_confirmation', 'supplier.pdf', 'application/pdf', 2048, 'b'.repeat(64),
      ]);
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('purchase-evidence', $1, jsonb_build_object('size', 2048::bigint))`, [ev.objectPath]);
      await one(PURCHASE, 'select public.purchase_evidence_finish($1, true) as r', [ev.evidenceId]);
      const [cost] = await owner<{ version_no: number }>('select max(version_no) as version_no from public.purchase_cost_versions where task_id = $1', [taskId]);
      const confirmed = await one<{ outcome: string }>(PURCHASE, 'select public.purchase_supplier_confirm($1, $2, $3) as r', [taskId, cost!.version_no, 'SYN-CONF-0001']);
      expect(confirmed.outcome).toBe('created');
      const [after] = await one<Array<Record<string, unknown>>>(OWNER, SUMMARY_SQL, [[DEAL]]);
      expect(after).toMatchObject({ total: 1, byState: { planned: 0, waitingForLaunch: 0, notStarted: 0, inProgress: 0, supplierConfirmed: 1, completed: 0 }, fulfilled: true, needs: [] });
      expect(await counts(PURCHASE)).toEqual(ZERO);
    });
  });
});

describe('backfill relationships and the legacy task link', () => {
  it('items = Deals with versions, facts = versions, no task without an item (the migration asserts the same)', async () => {
    await asOwner(db, async () => {
      const hotel = await readyHotel(OWNER, DEAL);
      await confirm(OWNER, hotel.versionId, hotel.hash);
      await readyHotel(SALES_B, DEAL2); // draft only: no item until confirmation or a legacy task row
      const ready = await readyPackage(SALES_AMD, DEAL_AMD, ['transfer', 'flight']);
      await confirm(SALES_AMD, ready.versionId, ready.hash);
      const [c] = await owner<{ deals_with_versions: number; versions: number; items: number; facts: number; unlinked: number; hotel_items: number }>(
        `select (select count(distinct deal_id)::int from public.booking_versions) as deals_with_versions,
                (select count(*)::int from public.booking_versions) as versions,
                (select count(*)::int from public.service_items) as items,
                (select count(*)::int from public.service_item_facts) as facts,
                (select count(*)::int from public.fulfilment_tasks where service_item_id is null) as unlinked,
                (select count(*)::int from public.service_items where service_type = 'hotel') as hotel_items`,
      );
      expect(c).toEqual({ deals_with_versions: 3, versions: 3, items: 3, facts: 3, unlinked: 0, hotel_items: 1 });
      // The helpers the backfill uses are idempotent on a draft version: item created once, facts synced in place.
      const [draft] = await owner<{ id: string; created_by: string; created_at: string }>(`select id, created_by, created_at from public.booking_versions where deal_id = $1`, [DEAL2]);
      const [first] = await owner<{ id: string }>('select authz.hotel_item_for_deal($1, $2, $3::timestamptz) as id', [DEAL2, draft!.created_by, draft!.created_at]);
      const [second] = await owner<{ id: string }>('select authz.hotel_item_for_deal($1, $2, $3::timestamptz) as id', [DEAL2, draft!.created_by, draft!.created_at]);
      expect(second).toEqual(first);
      await owner('select authz.hotel_facts_sync($1, $2)', [draft!.id, first!.id]);
      await owner('select authz.hotel_facts_sync($1, $2)', [draft!.id, first!.id]);
      const [again] = await owner<{ items: number; facts: number; state: string }>(
        `select (select count(*)::int from public.service_items) as items, (select count(*)::int from public.service_item_facts) as facts,
                (select state from public.service_items where id = $1) as state`, [first!.id],
      );
      expect(again).toEqual({ items: 4, facts: 4, state: 'planned' });
      const [facts] = await owner<{ facts: Record<string, unknown>; budget: string }>(
        `select facts, purchase_budget_paise::text as budget from public.service_item_facts where booking_version_id = $1`, [hotel.versionId],
      );
      expect(facts).toEqual({ facts: { ...Object.fromEntries(Object.entries(HOTEL).filter(([, v]) => v !== null)) }, budget: BUDGETS.hotel });
    });
  });
});
