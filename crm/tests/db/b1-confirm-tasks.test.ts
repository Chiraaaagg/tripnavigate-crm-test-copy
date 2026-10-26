import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConfirmBookingResult } from '@/modules/fulfilment/contracts';
import { type TestDb, asOwner, createTestDb, expectDbError } from '../helpers/db';
import {
  ADD_SQL, BUDGETS, CHECKLIST_SQL, CONFIRM_SQL, DEAL, FLIGHT, FLIGHT_CLAIM_SQL, HOTEL, MANAGER, OTHER_ENTITY, OWNER, PURCHASE, PURCHASE_GET_SQL,
  REMOVE_SQL, SALES_B, SAVE_ITEM_SQL, SELLING, TRANSFER, TRAVELLERS, TRAVELLERS_SQL, b1Helpers, rid,
} from './b1-support';

/**
 * B1 booking_confirm for 'package' versions (migration 20261118000100):
 * one task per service item exactly once, dedupe on repeat, the trigger-stage
 * check for synced Deals, lost/removed Deal refusals on every new command, the
 * switch, and the legacy hotel path that still produces one 'booking:' task.
 *
 * Concurrency: PGlite is one in-process connection, so two confirmations
 * cannot run at the same time here. The lock order is the same as Phase 3
 * (FOR UPDATE on the version row first; a concurrent confirmation waits and
 * then sees 'confirmed' and returns 'existing'); the unique task keys
 * (task_key, (service_item_id, service_purpose), (booking_version_id,
 * service_item_id)) refuse a second row even for the table owner, proved
 * below. True parallel confirmations run against real Postgres in
 * tests/supabase/b1-journey.real.test.ts.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b1Helpers(() => db);
const { one, refused, owner, setSwitch, openDraft, addItem, saveTravellers, readiness, confirm, readyPackage, readyHotel, insertRealDeal } = h;

describe('package confirmation', () => {
  it('creates exactly one task per sold service, in one transaction, with outbox and audit rows per task', async () => {
    await asOwner(db, async () => {
      const ready = await readyPackage();
      const before = await owner<{ n: number }>('select coalesce(max(id), 0)::int as n from public.audit_events');
      const result = await confirm(OWNER, ready.versionId, ready.hash);
      expect(result.outcome).toBe('created');
      expect(result.versionId).toBe(ready.versionId);
      expect(result.taskIds).toHaveLength(4);
      expect(result.taskId).toBe(result.taskIds![0]);

      const tasks = await owner<{ id: string; task_key: string; service_purpose: string; department: string; status: string; service_item_id: string; item_no: number; state: string }>(
        `select t.id, t.task_key, t.service_purpose, t.department, t.status, t.service_item_id, i.item_no, i.state
         from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
         where t.booking_version_id = $1 order by i.item_no`, [ready.versionId],
      );
      expect(tasks.map((t) => t.id)).toEqual(result.taskIds);
      expect(tasks.map((t) => [t.item_no, t.service_purpose, t.department, t.status, t.state])).toEqual([
        [1, 'hotel', 'purchase', 'not_started', 'active'],
        [2, 'transfer', 'purchase', 'not_started', 'active'],
        [3, 'activity', 'purchase', 'not_started', 'active'],
        [4, 'flight', 'flight', 'not_started', 'active'],
      ]);
      for (const t of tasks) expect(t.task_key).toBe(`item:${t.service_item_id}:${t.service_purpose}`);

      const snapshot = await owner<{ seq: number; full_name: string }>(
        'select seq, full_name from public.booking_version_travellers where booking_version_id = $1 order by seq', [ready.versionId],
      );
      expect(snapshot).toEqual(TRAVELLERS.map((t) => ({ seq: t.seq, full_name: t.fullName })));

      const outbox = await owner<{ event_type: string; aggregate_id: string; payload: Record<string, unknown> }>(
        `select event_type, aggregate_id, payload from public.outbox_events
         where aggregate_id = $1 or aggregate_id = any($2::uuid[]) order by event_type, aggregate_id`,
        [ready.versionId, result.taskIds],
      );
      expect(outbox.filter((o) => o.event_type === 'booking.version_confirmed')).toHaveLength(1);
      const created = outbox.filter((o) => o.event_type === 'fulfilment.task_created');
      expect(created).toHaveLength(4);
      for (const o of created) {
        const task = tasks.find((t) => t.id === o.aggregate_id)!;
        expect(o.payload).toEqual({
          task_id: task.id, version_id: ready.versionId, deal_id: DEAL, version_no: 1,
          service_purpose: task.service_purpose, service_item_id: task.service_item_id, service_type: task.service_purpose,
        });
      }
      expect(JSON.stringify(outbox)).not.toMatch(new RegExp(`${SELLING}|${BUDGETS.hotel}|${BUDGETS.flight}|Synthetic`));

      const audit = await owner<{ action: string; target_id: string; details: Record<string, unknown> }>(
        'select action, target_id, details from public.audit_events where id > $1 order by id', [before[0]!.n],
      );
      const actions = audit.map((a) => a.action);
      expect(actions.filter((a) => a === 'fulfilment.task_created')).toHaveLength(4);
      expect(actions.filter((a) => a === 'booking.version_confirmed')).toHaveLength(1);
      expect(audit.find((a) => a.action === 'booking.version_confirmed')!.details).toMatchObject({ taskIds: result.taskIds, serviceType: 'package' });
      expect(JSON.stringify(audit)).not.toMatch(new RegExp(`${SELLING}|${BUDGETS.hotel}|Synthetic Hotel|Traveller`));

      // The version is frozen; the draft commands refuse.
      await refused(OWNER, ADD_SQL, [ready.versionId, ready.rowVersion, 'hotel', JSON.stringify(HOTEL), BUDGETS.hotel, rid()], '55000', 'already_confirmed');
      await refused(OWNER, SAVE_ITEM_SQL, [ready.items.hotel!.itemId, ready.versionId, ready.rowVersion, JSON.stringify(HOTEL), '1'], '55000', 'already_confirmed');
      await refused(OWNER, TRAVELLERS_SQL, [DEAL, ready.rowVersion, JSON.stringify(TRAVELLERS)], 'P0002', 'not_found');
    });
  });

  it('a repeated confirm returns existing with the same task ids and creates nothing twice', async () => {
    await asOwner(db, async () => {
      const ready = await readyPackage(OWNER, DEAL, ['hotel', 'flight']);
      const first = await confirm(OWNER, ready.versionId, ready.hash);
      const counts = async () => owner<{ tasks: number; outbox: number; items: number }>(
        `select (select count(*)::int from public.fulfilment_tasks where booking_version_id = $1) as tasks,
                (select count(*)::int from public.outbox_events) as outbox,
                (select count(*)::int from public.service_items where deal_id = $2) as items`, [ready.versionId, DEAL],
      );
      const after = await counts();
      expect(after[0]).toEqual({ tasks: 2, outbox: 3, items: 2 });
      const again = await confirm(MANAGER, ready.versionId, ready.hash);
      expect(again).toEqual({ outcome: 'existing', taskId: first.taskId, versionId: ready.versionId, taskIds: first.taskIds });
      // Even a wrong hash on a confirmed version is 'existing' (nothing to compare any more).
      expect(await confirm(OWNER, ready.versionId, 'f'.repeat(64))).toMatchObject({ outcome: 'existing' });
      expect(await counts()).toEqual(after);
      // Dedupe keys refuse a second task per (item, purpose) even for the table owner.
      for (const key of [`item:${ready.items.hotel!.itemId}:hotel`, `booking:${ready.versionId}:hotel`]) {
        await expectDbError(
          db,
          () => owner(
            `insert into public.fulfilment_tasks (deal_id, legal_entity_id, branch_id, booking_version_id, service_purpose, task_key, created_by, service_item_id)
             select deal_id, legal_entity_id, branch_id, id, 'hotel', $2, created_by, $3 from public.booking_versions where id = $1`,
            [ready.versionId, key, ready.items.hotel!.itemId],
          ),
          { code: '23505' },
        );
      }
    });
  });

  it('not_ready: missing services, invalid facts, traveller mismatch, missing proof; readiness lists the issues', async () => {
    await asOwner(db, async () => {
      await setSwitch('service_items_enabled', true);
      const opened = await openDraft();
      // B1.1 (20261119000100) readiness codes are covered by b11-readiness-confirm.test.ts; here only the B1 ones.
      const B11 = new Set(['contact_missing', 'contact_not_confirmed', 'billing_missing', 'gstin_missing', 'trip_missing',
        'child_age_missing', 'participation_missing', 'identity_missing', 'plan_missing', 'plan_total_mismatch',
        // B1.2 (20261120000100)
        'id_proof_missing']);
      const b1Only = (issues: string[]) => issues.filter((i) => !B11.has(i));
      const r0 = await readiness(OWNER, opened.versionId);
      expect(b1Only(r0.issues)).toEqual(['no_services', 'missing_selling_total', 'missing_acceptance_proof']);
      await refused(OWNER, CONFIRM_SQL, [opened.versionId, r0.contentHash], '55000', 'not_ready');
      const added = await addItem(OWNER, opened.versionId, opened.rowVersion, 'transfer', TRANSFER); // 4 passengers
      let rv = (await saveTravellers(OWNER, DEAL, added.rowVersion, TRAVELLERS.slice(0, 2))).rowVersion;
      expect(b1Only((await readiness(OWNER, opened.versionId)).issues)).toEqual(['traveller_count_mismatch', 'missing_selling_total', 'missing_acceptance_proof']);
      rv = (await saveTravellers(OWNER, DEAL, rv, [])).rowVersion;
      expect(b1Only((await readiness(OWNER, opened.versionId)).issues)).toEqual(['traveller_missing', 'missing_selling_total', 'missing_acceptance_proof']);
      rv = (await saveTravellers(OWNER, DEAL, rv, TRAVELLERS)).rowVersion;
      rv = (await h.saveSelling(OWNER, opened.versionId, rv)).rowVersion;
      rv = await h.completeB11(OWNER, DEAL, opened.versionId, rv);
      // Review E5: a package version needs the customer's acceptance message itself; a bill alone is not it,
      // and the intake checklist says the same.
      await h.storeEvidence(OWNER, opened.versionId, 'bill');
      expect((await readiness(OWNER, opened.versionId)).issues).toEqual(['missing_acceptance_proof']);
      expect((await one<{ items: Array<{ code: string }> }>(OWNER, CHECKLIST_SQL, [DEAL])).items.map((i) => i.code)).toContain('acceptance_missing');
      await h.storeEvidence(OWNER, opened.versionId, 'acceptance_message', 'c'.repeat(64));
      expect((await readiness(OWNER, opened.versionId)).issues).toEqual([]);
      expect((await one<{ items: Array<{ code: string }> }>(OWNER, CHECKLIST_SQL, [DEAL])).items.map((i) => i.code)).not.toContain('acceptance_missing');
      // Facts made invalid by a later item (stored facts are validated at every read).
      await owner(`update public.service_item_facts set facts = facts || '{"passengers": 500}' where service_item_id = $1`, [added.itemId]);
      const r1 = await readiness(OWNER, opened.versionId);
      expect(r1.issues).toEqual(['service_facts_invalid', 'traveller_count_mismatch']);
      await refused(OWNER, CONFIRM_SQL, [opened.versionId, r1.contentHash], '55000', 'not_ready');
      expect(await owner('select 1 from public.fulfilment_tasks where booking_version_id = $1', [opened.versionId])).toEqual([]);
      expect(rv).toBeGreaterThan(1);
    });
  });

  it('synced Deal: confirms at "Won - Payment Received" (pipeline 0) and is not ready in any other stage or pipeline', async () => {
    await asOwner(db, async () => {
      const dealId = await insertRealDeal('UC_AD0SLH', 0);
      const ready = await readyPackage(OWNER, dealId, ['hotel', 'transfer']);
      const [stageOk] = await owner<{ ok: boolean }>('select authz.deal_in_trigger_stage($1) as ok', [dealId]);
      expect(stageOk).toEqual({ ok: true });
      for (const [stage, category] of [['PREPARATION', 0], ['NEW', 0], ['WON', 0], ['C1:WON', 1], ['UC_AD0SLH', 1]] as const) {
        await owner('update public.deals set source_stage_id = $2, source_category_id = $3 where id = $1', [dealId, stage, category]);
        const r = await readiness(OWNER, ready.versionId);
        expect(r.issues, `${category}/${stage}`).toEqual(['stage_not_confirmed']);
        await refused(OWNER, CONFIRM_SQL, [ready.versionId, r.contentHash], '55000', 'not_ready');
      }
      // The checklist names Bitrix as the owner of that item.
      const checklist = await one<{ items: Array<{ code: string; owner: string; blocking: boolean }>; canConfirm: boolean }>(OWNER, 'select public.intake_checklist($1) as r', [dealId]);
      expect(checklist.items).toContainEqual({ code: 'stage_not_confirmed', owner: 'bitrix', blocking: true, itemNos: [] });
      expect(checklist.canConfirm).toBe(false);
      await owner('update public.deals set source_stage_id = $2, source_category_id = 0 where id = $1', [dealId, 'UC_AD0SLH']);
      const r = await readiness(OWNER, ready.versionId);
      expect(r.issues).toEqual([]);
      const result = await confirm(OWNER, ready.versionId, r.contentHash);
      expect(result.outcome).toBe('created');
      expect(result.taskIds).toHaveLength(2);
      // The trigger list is data: an added row makes another stage a trigger stage.
      const dealB = await insertRealDeal('C1:WON', 1, 990002);
      await owner(`insert into authz.task_trigger_stages (category_id, stage_id, label) values (1, 'C1:WON', 'Synthetic test stage')`);
      const readyB = await readyPackage(OWNER, dealB, ['activity']);
      expect((await readiness(OWNER, readyB.versionId)).issues).toEqual([]);
      await owner(`delete from authz.task_trigger_stages where stage_id = 'C1:WON'`);
      expect((await readiness(OWNER, readyB.versionId)).issues).toEqual(['stage_not_confirmed']);
    });
  });

  it('a synthetic Deal has no Bitrix stage and never raises stage_not_confirmed; a hotel version never checks the stage', async () => {
    await asOwner(db, async () => {
      const [ok] = await owner<{ ok: boolean }>('select authz.deal_in_trigger_stage($1) as ok', [DEAL]);
      expect(ok).toEqual({ ok: true });
      const dealId = await insertRealDeal('PREPARATION', 0);
      const hotel = await readyHotel(OWNER, dealId);
      expect((await confirm(OWNER, hotel.versionId, hotel.hash)).outcome).toBe('created');
    });
  });

  it('switch off: a package draft cannot be confirmed (service_items_disabled); switching back on allows it', async () => {
    await asOwner(db, async () => {
      const ready = await readyPackage(OWNER, DEAL, ['hotel']);
      await setSwitch('service_items_enabled', false);
      await refused(OWNER, CONFIRM_SQL, [ready.versionId, ready.hash], '55000', 'service_items_disabled');
      await refused(SALES_B, CONFIRM_SQL, [ready.versionId, ready.hash], '42501', 'not_authorized');
      await setSwitch('service_items_enabled', true);
      expect((await confirm(OWNER, ready.versionId, ready.hash)).outcome).toBe('created');
      // A confirmed package version replays 'existing' even while the switch is off.
      await setSwitch('service_items_enabled', false);
      expect((await confirm(OWNER, ready.versionId, ready.hash)).outcome).toBe('existing');
    });
  });
});

describe('lost or removed Deals take no new work', () => {
  it('removed Deal: every new command refuses deal_removed; non-members keep not_authorized', async () => {
    await asOwner(db, async () => {
      const ready = await readyPackage(OWNER, DEAL, ['flight']);
      await owner('alter table public.deals drop constraint deals_removed_imported_only');
      await owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [DEAL]);
      const item = ready.items.flight!.itemId;
      await refused(OWNER, ADD_SQL, [ready.versionId, ready.rowVersion, 'hotel', JSON.stringify(HOTEL), BUDGETS.hotel, rid()], '55000', 'deal_removed');
      await refused(OWNER, SAVE_ITEM_SQL, [item, ready.versionId, ready.rowVersion, JSON.stringify(HOTEL), '1'], '55000', 'deal_removed');
      await refused(OWNER, REMOVE_SQL, [item, ready.versionId, ready.rowVersion], '55000', 'deal_removed');
      await refused(OWNER, TRAVELLERS_SQL, [DEAL, ready.rowVersion, JSON.stringify(TRAVELLERS)], '55000', 'deal_removed');
      await refused(OWNER, CONFIRM_SQL, [ready.versionId, ready.hash], '55000', 'deal_removed');
      await refused(OTHER_ENTITY, CONFIRM_SQL, [ready.versionId, ready.hash], '42501', 'not_authorized');
      expect(await owner('select 1 from public.fulfilment_tasks where deal_id = $1', [DEAL])).toEqual([]);
    });
  });

  it('removed Deal with an existing flight task: the claim refuses deal_removed', async () => {
    await asOwner(db, async () => {
      const ready = await readyPackage(OWNER, DEAL, ['flight']);
      const { taskId } = await confirm(OWNER, ready.versionId, ready.hash);
      await h.addFlight();
      await owner('alter table public.deals drop constraint deals_removed_imported_only');
      await owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [DEAL]);
      await refused(FLIGHT, FLIGHT_CLAIM_SQL, [taskId], '55000', 'deal_removed');
    });
  });

  it('lost Deal (Bitrix stage LOSE): no new draft, no items or travellers on an existing draft, confirm not ready', async () => {
    await asOwner(db, async () => {
      const dealId = await insertRealDeal('UC_AD0SLH', 0);
      const ready = await readyPackage(OWNER, dealId, ['hotel']);
      await owner(`update public.deals set source_stage_id = 'LOSE' where id = $1`, [dealId]);
      await refused(OWNER, ADD_SQL, [ready.versionId, ready.rowVersion, 'transfer', JSON.stringify(TRANSFER), '0', rid()], '55000', 'deal_not_active');
      await refused(OWNER, SAVE_ITEM_SQL, [ready.items.hotel!.itemId, ready.versionId, ready.rowVersion, JSON.stringify(HOTEL), '1'], '55000', 'deal_not_active');
      await refused(OWNER, REMOVE_SQL, [ready.items.hotel!.itemId, ready.versionId, ready.rowVersion], '55000', 'deal_not_active');
      await refused(OWNER, TRAVELLERS_SQL, [dealId, ready.rowVersion, JSON.stringify(TRAVELLERS)], '55000', 'deal_not_active');
      expect((await readiness(OWNER, ready.versionId)).issues).toEqual(['stage_not_confirmed']);
      await refused(OWNER, CONFIRM_SQL, [ready.versionId, ready.hash], '55000', 'not_ready');
    });
  });
});

describe('legacy hotel path (switch off) behaves exactly as today', () => {
  it('confirms one hotel task with the booking: key and backfills the Deal\'s hotel item and facts', async () => {
    await asOwner(db, async () => {
      const hotel = await readyHotel();
      const result = await confirm(OWNER, hotel.versionId, hotel.hash);
      expect(result).toEqual({ outcome: 'created', taskId: result.taskId, versionId: hotel.versionId, taskIds: [result.taskId] });
      const [task] = await owner<{ task_key: string; service_purpose: string; department: string; item_no: number; service_type: string; state: string; facts: Record<string, unknown>; budget: string }>(
        `select t.task_key, t.service_purpose, t.department, i.item_no, i.service_type, i.state, f.facts, f.purchase_budget_paise::text as budget
         from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
         join public.service_item_facts f on f.service_item_id = i.id and f.booking_version_id = t.booking_version_id
         where t.id = $1`, [result.taskId],
      );
      expect(task).toEqual({
        task_key: `booking:${hotel.versionId}:hotel`, service_purpose: 'hotel', department: 'purchase',
        item_no: 1, service_type: 'hotel', state: 'active', budget: BUDGETS.hotel,
        facts: { hotelName: HOTEL.hotelName, city: HOTEL.city, checkIn: HOTEL.checkIn, checkOut: HOTEL.checkOut, rooms: 2, adults: 3, roomType: 'Synthetic Deluxe', mealPlan: 'Breakfast', children: 1 },
      });
      // Hash of the hotel version is the Phase 3 hotel hash (unchanged by the facts row).
      const [hash] = await owner<{ same: boolean }>(
        `select v.content_hash = authz.booking_hash(v.hotel_name, v.city, v.check_in, v.check_out, v.rooms, v.room_type, v.meal_plan,
           v.adults, v.children, v.inclusions, v.special_requests, v.purchase_budget_paise, v.commercial_revision, authz.booking_stored_evidence(v.id)) as same
         from public.booking_versions v where v.id = $1`, [hotel.versionId],
      );
      expect(hash).toEqual({ same: true });
      // Outbox payloads are exactly the Phase 3 ones.
      const outbox = await owner<{ event_type: string; payload: Record<string, unknown> }>(
        'select event_type, payload from public.outbox_events order by event_type',
      );
      expect(outbox).toEqual([
        { event_type: 'booking.version_confirmed', payload: { version_id: hotel.versionId, deal_id: DEAL, task_id: result.taskId, version_no: 1, service_purpose: 'hotel' } },
        { event_type: 'fulfilment.task_created', payload: { task_id: result.taskId, version_id: hotel.versionId, deal_id: DEAL, version_no: 1, service_purpose: 'hotel' } },
      ]);
      // Repeat: existing with taskIds; Purchase sees the hotel task with serviceType and facts.
      expect(await confirm(MANAGER, hotel.versionId, hotel.hash)).toEqual({ outcome: 'existing', taskId: result.taskId, versionId: hotel.versionId, taskIds: [result.taskId] });
      const view = await one<Record<string, unknown>>(PURCHASE, PURCHASE_GET_SQL, [result.taskId]);
      expect(view).toMatchObject({
        taskId: result.taskId, serviceType: 'hotel', department: 'purchase', itemTitle: `${HOTEL.hotelName} · ${HOTEL.city}`,
        hotelName: HOTEL.hotelName, city: HOTEL.city, checkIn: HOTEL.checkIn, checkOut: HOTEL.checkOut, nights: 3, rooms: 2,
        adults: 3, children: 1, purchaseBudgetPaise: BUDGETS.hotel, roomType: 'Synthetic Deluxe', mealPlan: 'Breakfast',
        inclusions: null, specialRequests: null, canClaim: true, versionNo: 1,
      });
      expect(view.facts).toEqual({ type: 'hotel', facts: task!.facts });
      const [budget] = await owner<{ b: string }>('select authz.task_budget($1)::text as b', [result.taskId]);
      expect(budget).toEqual({ b: BUDGETS.hotel });
    });
  });

  it('a task inserted the legacy way (no item named) is linked to the Deal\'s hotel item by the insert trigger', async () => {
    await asOwner(db, async () => {
      await owner(
        `insert into public.booking_versions (deal_id, legal_entity_id, branch_id, version_no, created_by)
         select id, legal_entity_id, branch_id, 1, owner_user_id from public.deals where id = $1`, [DEAL],
      );
      await owner(
        `insert into public.fulfilment_tasks (deal_id, legal_entity_id, branch_id, booking_version_id, task_key, created_by)
         select deal_id, legal_entity_id, branch_id, id, 'booking:' || id || ':hotel', created_by from public.booking_versions where deal_id = $1`, [DEAL],
      );
      const rows = await owner<{ item_no: number; service_type: string; department: string; state: string }>(
        `select i.item_no, i.service_type, t.department, i.state from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id where t.deal_id = $1`, [DEAL],
      );
      expect(rows).toEqual([{ item_no: 1, service_type: 'hotel', department: 'purchase', state: 'planned' }]);
      // An 'item:' key without an item is refused.
      await expectDbError(
        db,
        () => owner(
          `insert into public.fulfilment_tasks (deal_id, legal_entity_id, branch_id, booking_version_id, service_purpose, task_key, created_by)
           select deal_id, legal_entity_id, branch_id, id, 'transfer', 'item:' || gen_random_uuid() || ':transfer', created_by from public.booking_versions where deal_id = $1`, [DEAL],
        ),
        { code: '22023' },
      );
    });
  });

  it('a hotel draft opened while the switch is off stays a hotel version after the switch turns on', async () => {
    await asOwner(db, async () => {
      const hotel = await readyHotel();
      await setSwitch('service_items_enabled', true);
      expect((await openDraft()).created).toBe(false);
      const result: ConfirmBookingResult = await confirm(OWNER, hotel.versionId, hotel.hash);
      expect(result.taskIds).toEqual([result.taskId]);
      const [t] = await owner<{ task_key: string }>('select task_key from public.fulfilment_tasks where id = $1', [result.taskId]);
      expect(t!.task_key).toBe(`booking:${hotel.versionId}:hotel`);
    });
  });
});
