import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import {
  ACCOUNTS, ANON, BUDGETS, CHECKLIST_SQL, DEAL, FLIGHT, FLIGHT_CLAIM_SQL, FLIGHT_FACTS, FLIGHT_GET_SQL, FLIGHT_LIST_SQL, FORBIDDEN_KEY, HOTEL, MANAGER,
  MANAGER_AMD, OTHER_ENTITY, OWNER, PANEL_SQL, PURCHASE, PURCHASE_CLAIM_SQL, PURCHASE_GET_SQL, PURCHASE_LIST_SQL, SALES_AMD,
  SALES_B, SELLING, SERVICES_SQL, SVC, TRAVELLERS, allKeys, b1Helpers,
} from './b1-support';

/**
 * B1 access (migration 20261118000100): RLS on the new tables per role,
 * branch and assignment; the Purchase and Flight DTOs never carry a selling
 * price, margin, acceptance proof, traveller names or another department's
 * budget; the Flight queue mirrors Purchase; and every RLS predicate column
 * of the new tables leads an index (AUDIT-030).
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b1Helpers(() => db);
const { one, run, refused, owner, addFlight, addSalesAssignee, confirm, readyPackage } = h;

const NEW_TABLES = ['service_items', 'service_item_facts', 'deal_travellers', 'booking_version_travellers'] as const;

async function visible(actor: Actor, table: string): Promise<number> {
  return (await run<{ id: string }>(actor, `select id from public.${table}`)).length;
}

describe('row level security on the new tables', () => {
  it('readers of the booking see the rows; Purchase, Flight, other branches and entities, aal1 and anon do not', async () => {
    await asOwner(db, async () => {
      await addFlight();
      await addSalesAssignee(DEAL, U.salesDelhiB);
      const ready = await readyPackage();
      await confirm(OWNER, ready.versionId, ready.hash);
      const expected: Array<[string, Actor, number, number, number, number]> = [
        // actor, service_items, facts, deal_travellers, snapshot
        ['owner', OWNER, 4, 4, 4, 4],
        ['sales assignee', SALES_B, 4, 4, 4, 4],
        ['branch manager', MANAGER, 4, 4, 4, 4],
        ['accounts (entity-wide deal.read grant)', ACCOUNTS, 4, 4, 4, 4],
        ['manager of another branch', MANAGER_AMD, 0, 0, 0, 0],
        ['sales of another branch', SALES_AMD, 0, 0, 0, 0],
        ['purchase (never reads booking rows)', PURCHASE, 0, 0, 0, 0],
        ['flight (never reads booking rows)', FLIGHT, 0, 0, 0, 0],
        ['other entity', OTHER_ENTITY, 0, 0, 0, 0],
        ['owner at aal1', { userId: U.salesDelhiA, aal: 'aal1' }, 0, 0, 0, 0],
      ];
      for (const [name, actor, ...counts] of expected) {
        for (const [i, table] of NEW_TABLES.entries()) {
          expect(await visible(actor, table), `${name} ${table}`).toBe(counts[i]);
        }
      }
      for (const table of NEW_TABLES) {
        await refused(ANON, `select id from public.${table}`, [], '42501');
        await refused(OWNER, `update public.${table} set legal_entity_id = legal_entity_id`, [], '42501');
        await refused(OWNER, `delete from public.${table}`, [], '42501');
        await refused(SVC, `delete from public.${table}`, [], '42501');
      }
      // Flight reads its department's task rows directly; Purchase reads only purchase rows.
      const flightRows = await run<{ department: string }>(FLIGHT, 'select department from public.fulfilment_tasks');
      expect(flightRows).toEqual([{ department: 'flight' }]);
      const purchaseRows = await run<{ department: string }>(PURCHASE, 'select department from public.fulfilment_tasks order by department');
      expect(purchaseRows).toEqual([{ department: 'purchase' }, { department: 'purchase' }, { department: 'purchase' }]);
      // The Deal owner (Sales) sees every task of the Deal.
      expect(await run(OWNER, 'select id from public.fulfilment_tasks')).toHaveLength(4);
    });
  });

  it('every RLS predicate column of the new tables leads an index', async () => {
    await asOwner(db, async () => {
      for (const [table, column] of [
        ['service_items', 'deal_id'], ['service_item_facts', 'service_item_id'], ['deal_travellers', 'deal_id'],
        ['booking_version_travellers', 'booking_version_id'], ['fulfilment_tasks', 'service_item_id'],
      ]) {
        const rows = await owner<{ indexname: string }>(
          `select i.relname as indexname
             from pg_index x
             join pg_class i on i.oid = x.indexrelid
             join pg_class t on t.oid = x.indrelid
             join pg_namespace n on n.oid = t.relnamespace
             join pg_attribute a on a.attrelid = t.oid and a.attnum = x.indkey[0]
            where n.nspname = 'public' and t.relname = $1 and a.attname = $2`,
          [table, column],
        );
        expect(rows, `${table}.${column}`).not.toEqual([]);
      }
    });
  });
});

describe('Purchase and Flight DTOs', () => {
  it('Purchase sees its three tasks with service type, title, facts and the item budget, and nothing commercial', async () => {
    await asOwner(db, async () => {
      await addFlight();
      const ready = await readyPackage();
      const { taskIds } = await confirm(OWNER, ready.versionId, ready.hash);
      const list = await one<Array<Record<string, unknown>>>(PURCHASE, PURCHASE_LIST_SQL);
      expect(list.map((t) => t.serviceType).sort()).toEqual(['activity', 'hotel', 'transfer']);
      expect(list.map((t) => t.department)).toEqual(['purchase', 'purchase', 'purchase']);
      const keys = allKeys(list);
      expect([...keys].filter((k) => FORBIDDEN_KEY.test(k))).toEqual([]);
      const text = JSON.stringify(list);
      expect(text).not.toMatch(new RegExp(`${SELLING}|${BUDGETS.flight}|Synthetic Traveller|DEL to JDH`));
      const transfer = list.find((t) => t.serviceType === 'transfer')!;
      expect(transfer).toMatchObject({
        itemTitle: 'Synthetic airport to hotel', hotelName: null, city: null, checkIn: null, checkOut: null, nights: 0, rooms: 0,
        adults: 4, children: 0, purchaseBudgetPaise: BUDGETS.transfer, status: 'not_started', assigneeName: null, assignedToYou: false,
        facts: { type: 'transfer', facts: { route: 'Synthetic airport to hotel', date: '2026-12-10', vehicleType: 'Sedan', passengers: 4, pickupTime: '09:30' } },
      });
      const hotel = list.find((t) => t.serviceType === 'hotel')!;
      expect(hotel).toMatchObject({ itemTitle: 'Synthetic Hotel (fixture) · Synthetic City', nights: 3, rooms: 2, adults: 3, children: 1, purchaseBudgetPaise: BUDGETS.hotel });
      const detail = await one<Record<string, unknown>>(PURCHASE, PURCHASE_GET_SQL, [hotel.taskId as string]);
      expect(detail).toMatchObject({ roomType: 'Synthetic Deluxe', mealPlan: 'Breakfast', inclusions: null, specialRequests: null, canClaim: true, versionNo: 1 });
      // B1.1 (freeze note 3.1): the detail lists the item's participants (name, type, age, needs), never identity.
      expect([...allKeys(detail)].filter((k) => FORBIDDEN_KEY.test(k) && k !== 'fullName')).toEqual([]);
      expect([...allKeys(detail)].filter((k) => /dateOfBirth|nationality|passport/i.test(k))).toEqual([]);
      // The flight task is invisible to Purchase and cannot be claimed by Purchase.
      const flightTask = taskIds!.find((id) => !list.some((t) => t.taskId === id))!;
      expect(await one(PURCHASE, PURCHASE_GET_SQL, [flightTask])).toBeNull();
      await refused(PURCHASE, PURCHASE_CLAIM_SQL, [flightTask], '42501', 'not_authorized');
      // Sales/Manager (deal readers) still see every task through purchase_task_get, as today.
      expect(await one<Record<string, unknown>>(OWNER, PURCHASE_GET_SQL, [flightTask])).toMatchObject({ serviceType: 'flight', department: 'flight' });
      // Workspace budget comes from the item.
      const [budgets] = await owner<{ b: string[] }>(
        `select array_agg(authz.task_budget(id)::text order by created_at) as b from public.fulfilment_tasks where booking_version_id = $1`, [ready.versionId],
      );
      expect(budgets!.b.sort()).toEqual([BUDGETS.activity, BUDGETS.flight, BUDGETS.hotel, BUDGETS.transfer].sort());
    });
  });

  it('Flight sees only its task: flight facts, its budget, a traveller count and nothing else; claim mirrors Purchase', async () => {
    await asOwner(db, async () => {
      await addFlight();
      const ready = await readyPackage();
      const { taskIds } = await confirm(OWNER, ready.versionId, ready.hash);
      // Before the flight membership exists, the queue is empty for the visa person.
      const list = await one<Array<Record<string, unknown>>>(FLIGHT, FLIGHT_LIST_SQL);
      expect(list).toHaveLength(1);
      const task = list[0]!;
      expect(task).toMatchObject({
        taskId: taskIds![3], dealReference: 'SYN-DEL-001', itemTitle: 'DEL to JDH, JDH to DEL',
        facts: { segments: FLIGHT_FACTS.segments, passengers: 4, cabin: 'Economy' },
        purchaseBudgetPaise: BUDGETS.flight, status: 'not_started', assigneeName: null, assignedToYou: false,
        branchName: 'Delhi', supplierConfirmedAt: null,
      });
      expect(task.facts).not.toHaveProperty('type');
      expect([...allKeys(list)].filter((k) => FORBIDDEN_KEY.test(k))).toEqual([]);
      expect(JSON.stringify(list)).not.toMatch(new RegExp(`${SELLING}|${BUDGETS.hotel}|${BUDGETS.transfer}|${BUDGETS.activity}|Synthetic Traveller|Synthetic Hotel`));
      const detail = await one<Record<string, unknown>>(FLIGHT, FLIGHT_GET_SQL, [task.taskId as string]);
      expect(detail).toMatchObject({ confirmedByName: 'Synthetic Sales Delhi A', versionNo: 1, canClaim: true, travellerCount: 4 });
      expect(typeof detail.confirmedAt).toBe('string');
      // B1.1 (freeze note 3.1): the detail lists the item's participants (name, type, age, needs), never identity.
      expect([...allKeys(detail)].filter((k) => FORBIDDEN_KEY.test(k) && k !== 'fullName')).toEqual([]);
      expect([...allKeys(detail)].filter((k) => /dateOfBirth|nationality|passport/i.test(k))).toEqual([]);
      // Purchase tasks are invisible to Flight; Flight cannot claim them; Purchase cannot claim flight tasks.
      expect(await one(FLIGHT, FLIGHT_GET_SQL, [taskIds![0]])).toBeNull();
      await refused(FLIGHT, FLIGHT_CLAIM_SQL, [taskIds![0]], '42501', 'not_authorized');
      await refused(FLIGHT, PURCHASE_CLAIM_SQL, [taskIds![0]], '42501', 'not_authorized');
      await refused(PURCHASE, FLIGHT_CLAIM_SQL, [task.taskId as string], '42501', 'not_authorized');
      await refused(OWNER, FLIGHT_CLAIM_SQL, [task.taskId as string], '42501', 'not_authorized');
      // Like purchase_task_list, the Flight queue is empty (not an error) for people without the role.
      expect(await one<unknown[]>(OWNER, FLIGHT_LIST_SQL)).toEqual([]);
      expect(await one<unknown[]>(MANAGER, FLIGHT_LIST_SQL)).toEqual([]);
      await refused(ANON, FLIGHT_LIST_SQL, [], '42501');
      // Claim: in_progress, a 'flight' assignment, idempotent for the same person.
      const claimed = await one<Record<string, unknown>>(FLIGHT, FLIGHT_CLAIM_SQL, [task.taskId as string]);
      expect(claimed).toEqual({ taskId: task.taskId, status: 'in_progress', assignedToYou: true, alreadyYours: false });
      expect(await one(FLIGHT, FLIGHT_CLAIM_SQL, [task.taskId as string])).toEqual({ ...claimed, alreadyYours: true });
      expect(await owner(`select assignment_kind from public.deal_assignments where deal_id = $1 and user_id = $2 and ended_at is null`, [DEAL, U.visaJodhpur])).toEqual([
        { assignment_kind: 'flight' },
      ]);
      expect((await one<Record<string, unknown>>(FLIGHT, FLIGHT_GET_SQL, [task.taskId as string]))).toMatchObject({ status: 'in_progress', assignedToYou: true, canClaim: false, assigneeName: 'Synthetic Visa Jodhpur' });
      // Review E1/E2: the claim made the Flight person a Deal assignee; Purchase tasks (and their budgets) stay invisible.
      expect(await one(FLIGHT, PURCHASE_LIST_SQL)).toEqual([]);
      expect(await one(FLIGHT, PURCHASE_GET_SQL, [taskIds![0]])).toBeNull();
      await refused(FLIGHT, CHECKLIST_SQL, [DEAL], '42501', 'not_authorized');
      const panelAfterClaim = await one<Record<string, unknown>>(FLIGHT, PANEL_SQL, [DEAL]);
      expect(panelAfterClaim?.task ?? null).toBeNull();
      const audit = await owner<{ details: Record<string, unknown> }>(`select details from public.audit_events where action = 'fulfilment.task_claimed' order by id desc limit 1`);
      expect(audit[0]!.details).toMatchObject({ department: 'flight', dealId: DEAL });
    });
  });

  it('deal_services and booking_panel filter by role: full view for booking readers, department view for Purchase and Flight, null otherwise', async () => {
    await asOwner(db, async () => {
      await addFlight();
      const ready = await readyPackage();
      await confirm(OWNER, ready.versionId, ready.hash);
      const full = await one<Record<string, unknown>>(OWNER, SERVICES_SQL, [DEAL]);
      expect(full).toMatchObject({ dealId: DEAL, canEdit: false, canConfirm: false, travellers: TRAVELLERS });
      expect(full.version).toMatchObject({ versionId: ready.versionId, versionNo: 1, status: 'confirmed', serviceType: 'package' });
      const items = full.items as Array<Record<string, unknown>>;
      expect(items.map((i) => [i.itemNo, i.serviceType, i.department, i.state, i.purchaseBudgetPaise, i.nextStep])).toEqual([
        [1, 'hotel', 'purchase', 'active', BUDGETS.hotel, 'take_task'],
        [2, 'transfer', 'purchase', 'active', BUDGETS.transfer, 'take_task'],
        [3, 'activity', 'purchase', 'active', BUDGETS.activity, 'take_task'],
        [4, 'flight', 'flight', 'active', BUDGETS.flight, 'take_task'],
      ]);
      expect(items[0]).toMatchObject({ itemId: ready.items.hotel!.itemId, title: 'Synthetic Hotel (fixture) · Synthetic City', facts: { type: 'hotel' } });
      expect(items[0]!.factsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(items[0]!.task).toMatchObject({ status: 'not_started', assigneeName: null, assignedToYou: false, supplierConfirmedAt: null });
      expect(full.progress).toEqual({
        total: 4, byState: { planned: 0, waitingForLaunch: 0, notStarted: 4, inProgress: 0, supplierConfirmed: 0, completed: 0 }, fulfilled: false, staleCount: 0, needs: ['take_task'],
      });
      // No selling value anywhere, even for the owner (it lives in booking_panel.version only).
      expect(JSON.stringify(full)).not.toContain(SELLING);

      const purchase = await one<Record<string, unknown>>(PURCHASE, SERVICES_SQL, [DEAL]);
      expect(purchase).not.toHaveProperty('travellers');
      expect((purchase.items as Array<Record<string, unknown>>).map((i) => [i.serviceType, i.purchaseBudgetPaise])).toEqual([
        ['hotel', BUDGETS.hotel], ['transfer', BUDGETS.transfer], ['activity', BUDGETS.activity],
      ]);
      expect(purchase).toMatchObject({ canEdit: false, canConfirm: false });
      expect((purchase.progress as Record<string, unknown>).total).toBe(3);
      expect([...allKeys(purchase)].filter((k) => FORBIDDEN_KEY.test(k))).toEqual([]);
      expect(JSON.stringify(purchase)).not.toMatch(new RegExp(`${SELLING}|${BUDGETS.flight}|Synthetic Traveller`));

      // A Flight person who is not assigned to the Deal has no deal.read: null (the queue is their way in).
      expect(await one(FLIGHT, SERVICES_SQL, [DEAL])).toBeNull();
      await one(FLIGHT, FLIGHT_CLAIM_SQL, [(items[3]!.task as Record<string, unknown>).taskId as string]);
      const flight = await one<Record<string, unknown>>(FLIGHT, SERVICES_SQL, [DEAL]);
      expect(flight).not.toHaveProperty('travellers');
      expect((flight.items as Array<Record<string, unknown>>).map((i) => [i.serviceType, i.purchaseBudgetPaise, i.nextStep])).toEqual([['flight', BUDGETS.flight, 'supplier_confirmation']]);
      expect((flight.items as Array<Record<string, unknown>>)[0]!.task).toMatchObject({ status: 'in_progress', assignedToYou: true });
      expect(flight.progress).toMatchObject({ total: 1, byState: { planned: 0, waitingForLaunch: 0, notStarted: 0, inProgress: 1, supplierConfirmed: 0, completed: 0 }, needs: ['supplier_confirmation'] });
      expect(JSON.stringify(flight)).not.toMatch(new RegExp(`${SELLING}|${BUDGETS.hotel}|Synthetic Traveller|Synthetic Hotel`));

      for (const actor of [OTHER_ENTITY, SALES_AMD, MANAGER_AMD]) expect(await one(actor, SERVICES_SQL, [DEAL])).toBeNull();
      await refused(ANON, SERVICES_SQL, [DEAL], '42501');
      await refused({ userId: U.salesDelhiA, aal: 'aal1' }, SERVICES_SQL, [DEAL], '42501');

      // booking_panel: services and progress for booking readers; still null for Purchase and Flight.
      const panel = await one<Record<string, unknown>>(OWNER, PANEL_SQL, [DEAL]);
      const fresh = await one<Record<string, unknown>>(MANAGER, SERVICES_SQL, [DEAL]);
      expect(panel.services).toEqual(fresh.items);
      expect(panel.progress).toEqual(fresh.progress);
      expect(fresh.progress).toMatchObject({ byState: { planned: 0, waitingForLaunch: 0, notStarted: 3, inProgress: 1, supplierConfirmed: 0, completed: 0 }, needs: ['take_task', 'supplier_confirmation'] });
      expect(panel.version).toMatchObject({ serviceType: 'package', sellingTotalPaise: SELLING });
      expect(panel.task).toMatchObject({ taskId: (items[0]!.task as Record<string, unknown>).taskId, status: 'not_started' });
      expect(await one(PURCHASE, PANEL_SQL, [DEAL])).toBeNull();
      // An assigned Flight person is a Deal reader (as any non-Purchase assignee today): the panel
      // shows their department's items only, no proof files and no selling total.
      const flightPanel = await one<Record<string, unknown>>(FLIGHT, PANEL_SQL, [DEAL]);
      expect((flightPanel.services as Array<Record<string, unknown>>).map((i) => i.serviceType)).toEqual(['flight']);
      expect(flightPanel).toMatchObject({ evidence: [], evidenceVisible: false, canEdit: false, canConfirm: false });
      expect(flightPanel.version).not.toHaveProperty('sellingTotalPaise');
      expect(JSON.stringify(flightPanel)).not.toMatch(new RegExp(`${SELLING}|${BUDGETS.hotel}|Synthetic Traveller`));
    });
  });

  it('a Purchase person who is a Deal assignee only sees their department; a draft Deal shows planned items to the owner', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const opened = await h.openDraft();
      const added = await h.addItem(OWNER, opened.versionId, opened.rowVersion, 'flight', FLIGHT_FACTS);
      await h.addItem(OWNER, opened.versionId, added.rowVersion, 'hotel', HOTEL);
      const draft = await one<Record<string, unknown>>(OWNER, SERVICES_SQL, [DEAL]);
      expect(draft).toMatchObject({ canEdit: true, canConfirm: true });
      expect((draft.items as Array<Record<string, unknown>>).map((i) => [i.state, i.task, i.nextStep])).toEqual([
        ['planned', null, 'confirm_version'], ['planned', null, 'confirm_version'],
      ]);
      expect(draft.progress).toMatchObject({ total: 2, byState: { planned: 2, waitingForLaunch: 0, notStarted: 0, inProgress: 0, supplierConfirmed: 0, completed: 0 }, needs: ['confirm_version'] });
      // Purchase Jodhpur is assigned to SYN-DEL-001 (fixture) but holds the purchase role: only purchase items, planned, no budget leak of flight.
      const purchase = await one<Record<string, unknown>>(PURCHASE, SERVICES_SQL, [DEAL]);
      expect((purchase.items as Array<Record<string, unknown>>).map((i) => i.serviceType)).toEqual(['hotel']);
      expect(JSON.stringify(purchase)).not.toContain(BUDGETS.flight);
    });
  });
});
