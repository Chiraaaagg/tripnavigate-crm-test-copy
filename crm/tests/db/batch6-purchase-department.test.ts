import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, FLIGHT, FLIGHT_CLAIM_SQL, FLIGHT_GET_SQL, MANAGER, OWNER, PURCHASE, PURCHASE_CLAIM_SQL, SHA } from './b1-support';
import { COST_SAVE_SQL, COST_SUBMIT_SQL, DESK, VISA_CLAIM_SQL, WORK_FORM_SQL, b11Helpers, rid } from './b11-support';

/**
 * Batch 6, item 1 (migration 20261127000100_purchase_department_check):
 * the Purchase commands work only on Purchase department tasks.
 *
 * Before the migration authz.can_work_purchase_task checked the assignee and
 * an active Purchase role but not the task's department, so a person holding
 * both the Flight and the Purchase role could drive a flight task they took
 * through the Purchase commands to supplier_confirmed. The first scenario
 * reproduces that with the previous definitions (installed inside the
 * rolled-back transaction, as speed-accounts-queue.test.ts does), then
 * reinstalls the migration's definitions and proves every Purchase command
 * refuses the flight task while the Purchase task and the Flight desk
 * commands keep working.
 *
 * The same migration limits the Purchase-role read of the Purchase workspace
 * (purchase_workspace and the purchase_* select policies) to Purchase tasks,
 * keeping the branch manager's read, makes purchase_task_reassign require the
 * new assignee to hold the active role of the task's department (the same
 * rule lists the workspace's reassign candidates) and moves the Deal
 * assignment of the task's kind ('purchase', 'flight' or 'visa').
 *
 * Synthetic roles: PURCHASE (Synthetic Purchase Jodhpur) holds Purchase in
 * the fixtures; addFlight(U.purchaseJodhpur) gives the same person Flight.
 * FLIGHT (Synthetic Visa Jodhpur) gets Flight (and, where stated, Purchase)
 * per scenario. MANAGER (Synthetic Manager Delhi) manages the Deal's branch.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { run, one, refused, owner, addFlight, readyPackage, confirm, deskEvidence, deskTask } = h;

const DUAL: Actor = PURCHASE; // Purchase in the fixtures, Flight added per scenario
const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);

const QUOTE_ADD_SQL = 'select public.purchase_quote_add($1, $2, $3::jsonb) as r';
const QUOTE_WITHDRAW_SQL = 'select public.purchase_quote_withdraw($1) as r';
const COST_PROPOSE_SQL = 'select public.purchase_cost_propose($1, $2, $3, $4::bigint, $5::date, $6, $7) as r';
const EV_BEGIN_SQL = 'select public.purchase_evidence_begin($1, $2, $3, $4, $5, $6) as r';
const EV_FINISH_SQL = 'select public.purchase_evidence_finish($1, $2) as r';
const EV_REMOVE_SQL = 'select public.purchase_evidence_remove($1) as r';
const CONFIRM_SQL = 'select public.purchase_supplier_confirm($1, $2, $3) as r';
const WORKSPACE_SQL = 'select public.purchase_workspace($1) as r';
const REASSIGN_SQL = 'select public.purchase_task_reassign($1, $2, $3) as r';

/** Owner SQL: an active Purchase membership in Jodhpur (the fixtures give visa.jodhpur none). */
async function addPurchase(user: string): Promise<void> {
  await addMembership(user, 'purchase');
}

/** Owner SQL: a membership of `role` with `status` at branch `branch` of entity `entity`. */
async function addMembership(user: string, role: string, status = 'active', branch = 'JDH', entity = 'HOLIDAY_CHACHA'): Promise<void> {
  await owner(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, $2, $3
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = $5 and b.code = $4`,
    [user, role, status, branch, entity],
  );
}

type Candidates = { canReassign: boolean; reassignCandidates: Array<{ userId: string; name: string }> };
const candidates = async (taskId: string) =>
  (await one<Candidates>(MANAGER, WORKSPACE_SQL, [taskId])).reassignCandidates.map((c) => c.userId);

/** Open Deal assignments of a person on the Deal, by kind. */
const openKinds = async (user: string, deal: string = DEAL) =>
  (await owner<{ kind: string }>(
    `select assignment_kind as kind from public.deal_assignments
     where deal_id = $1 and user_id = $2 and ended_at is null order by 1`, [deal, user])).map((r) => r.kind);
const readsDeal = async (actor: Actor, deal: string = DEAL) =>
  (await run(actor, 'select id from public.deals where id = $1', [deal])).length === 1;

/** One definition block, from its first line to the closing '$$;'. */
function block(file: string, head: string): string {
  const sql = readFileSync(new URL(file, MIGRATIONS), 'utf8');
  const start = sql.indexOf(head);
  expect(start, `${head} found in ${file}`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$$;', start) + 3);
}

/** The definitions before this migration (20261005000100 and 20261107000300). */
async function installPrevious(): Promise<void> {
  await owner(
    block('20261005000100_purchase_hotel_procurement.sql', 'create function authz.can_work_purchase_task(')
      .replace('create function', 'create or replace function'),
  );
  await owner(block('20261107000300_removed_deal_work_pause.sql', 'create or replace function authz.lock_workable_task('));
}

/** This migration's statements (between its begin and commit). */
async function installCurrent(): Promise<void> {
  const sql = readFileSync(new URL('20261127000100_purchase_department_check.sql', MIGRATIONS), 'utf8');
  const start = sql.indexOf('\nbegin;\n');
  const end = sql.lastIndexOf('\ncommit;');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  // The new helper is created by the migration; the migration has already run on this database.
  await db.exec(sql.slice(start + '\nbegin;\n'.length, end)
    .replace('create function authz.is_active_department_person(', 'create or replace function authz.is_active_department_person('));
}

/** Confirmed package with a hotel and a flight item; returns both task ids. */
async function hotelAndFlight(): Promise<{ hotelTask: string; flightTask: string }> {
  const ready = await readyPackage(OWNER, DEAL, ['hotel', 'flight']);
  const { taskIds } = await confirm(OWNER, ready.versionId, ready.hash);
  const rows = await owner<{ id: string; department: string }>(
    'select id, department from public.fulfilment_tasks where id = any ($1::uuid[])', [taskIds],
  );
  const hotelTask = rows.find((r) => r.department === 'purchase')?.id;
  const flightTask = rows.find((r) => r.department === 'flight')?.id;
  expect(hotelTask && flightTask).toBeTruthy();
  return { hotelTask: hotelTask!, flightTask: flightTask! };
}

async function createSupplier(actor: Actor): Promise<string> {
  const [entity] = await owner<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`);
  const { supplierId } = await one<{ supplierId: string }>(actor, 'select public.supplier_create($1, $2::jsonb) as r', [
    entity!.id,
    JSON.stringify({ name: `Synthetic Stays ${rid().slice(0, 8)}`, serviceTypes: ['hotel'], city: 'Synthetic City',
      contactName: 'Synthetic Desk', contactPhone: '+91 00000 00000', contactEmail: 'desk@example.test',
      paymentTerms: 'Synthetic: 50% at confirmation' }),
  ]);
  return supplierId;
}

const quoteFields = (supplierId: string) => JSON.stringify({
  supplierId, hotelName: 'Synthetic Hotel (fixture)', roomType: 'Synthetic Deluxe', mealPlan: 'Breakfast',
  quotedCostPaise: '4000000', holdUntil: '2026-11-30', cancellationTerms: 'Synthetic: free until 7 days before arrival',
});

/** Begins a supplier confirmation file; with `store`, uploads it and finishes it. */
async function evidence(actor: Actor, taskId: string, store: boolean): Promise<string> {
  const ev = await one<{ evidenceId: string; objectPath: string }>(actor, EV_BEGIN_SQL, [
    taskId, 'supplier_confirmation', 'supplier.pdf', 'application/pdf', 2048, SHA,
  ]);
  if (store) {
    await owner(`insert into storage.objects (bucket_id, name, metadata) values ('purchase-evidence', $1, jsonb_build_object('size', 2048::bigint))`, [ev.objectPath]);
    expect((await one<{ status: string }>(actor, EV_FINISH_SQL, [ev.evidenceId, true])).status).toBe('stored');
  }
  return ev.evidenceId;
}

/** Quote, cost within every item budget, stored confirmation file: everything supplier confirmation needs. */
async function prepare(actor: Actor, taskId: string, supplierId: string): Promise<{ quoteId: string; versionNo: number; storedEv: string }> {
  const { quoteId } = await one<{ quoteId: string }>(actor, QUOTE_ADD_SQL, [taskId, rid(), quoteFields(supplierId)]);
  const { versionNo } = await one<{ versionNo: number }>(actor, COST_PROPOSE_SQL, [taskId, quoteId, 0, '2000000', '2026-11-25', null, rid()]);
  const storedEv = await evidence(actor, taskId, true);
  return { quoteId, versionNo, storedEv };
}

const taskRow = async (taskId: string) =>
  (await owner<{ status: string; assignee_user_id: string | null; supplier_reference: string | null }>(
    'select status, assignee_user_id, supplier_reference from public.fulfilment_tasks where id = $1', [taskId]))[0]!;

const purchaseRows = async (taskId: string) => (await owner<{ quotes: number; costs: number; evidence: string[] }>(
  `select (select count(*)::int from public.purchase_quotes q where q.task_id = $1) as quotes,
          (select count(*)::int from public.purchase_cost_versions c where c.task_id = $1) as costs,
          coalesce((select array_agg(e.status order by e.status) from public.purchase_evidence e where e.task_id = $1), '{}') as evidence`,
  [taskId]))[0]!;

describe('Purchase commands work only on Purchase department tasks', () => {
  it('a Flight + Purchase holder on a flight task: the gap existed before; every Purchase command now refuses and the task does not move', async () => {
    await asOwner(db, async () => {
      await addFlight(U.purchaseJodhpur);
      const { flightTask } = await hotelAndFlight();
      await one(DUAL, FLIGHT_CLAIM_SQL, [flightTask]);
      expect(await taskRow(flightTask)).toMatchObject({ status: 'in_progress', assignee_user_id: U.purchaseJodhpur });
      const supplierId = await createSupplier(DUAL);

      // Before this migration: the Purchase commands accept the flight task.
      await installPrevious();
      const { quoteId, versionNo, storedEv } = await prepare(DUAL, flightTask, supplierId);
      await db.exec('savepoint gap');
      expect((await one<{ outcome: string }>(DUAL, CONFIRM_SQL, [flightTask, versionNo, 'SYN-FLT-0001'])).outcome).toBe('created');
      expect((await taskRow(flightTask)).status).toBe('supplier_confirmed');
      await db.exec('rollback to savepoint gap');
      const pendingEv = await evidence(DUAL, flightTask, false);

      // This migration: every Purchase command refuses the flight task.
      await installCurrent();
      const before = await purchaseRows(flightTask);
      expect(before).toEqual({ quotes: 1, costs: 1, evidence: ['pending_upload', 'stored'] });
      const attempts: Array<[string, string, unknown[]]> = [
        ['purchase_quote_add', QUOTE_ADD_SQL, [flightTask, rid(), quoteFields(supplierId)]],
        ['purchase_quote_withdraw', QUOTE_WITHDRAW_SQL, [quoteId]],
        ['purchase_cost_propose', COST_PROPOSE_SQL, [flightTask, quoteId, versionNo, '3900000', '2026-11-25', null, rid()]],
        ['purchase_evidence_begin', EV_BEGIN_SQL, [flightTask, 'supplier_confirmation', 'supplier.pdf', 'application/pdf', 2048, SHA]],
        ['purchase_evidence_finish', EV_FINISH_SQL, [pendingEv, true]],
        ['purchase_evidence_remove', EV_REMOVE_SQL, [storedEv]],
        ['purchase_supplier_confirm', CONFIRM_SQL, [flightTask, versionNo, 'SYN-FLT-0001']],
      ];
      for (const [name, sql, params] of attempts) {
        await expect(refused(DUAL, sql, params, '42501', 'not_authorized'), name).resolves.toBeUndefined();
      }
      expect(await taskRow(flightTask)).toEqual({ status: 'in_progress', assignee_user_id: U.purchaseJodhpur, supplier_reference: null });
      expect(await purchaseRows(flightTask)).toEqual(before);
      expect((await owner<{ status: string }>('select status from public.purchase_quotes where id = $1', [quoteId]))[0]!.status).toBe('open');
      expect(await owner(
        `select 1 from public.outbox_events where aggregate_id = $1 and event_type = 'fulfilment.supplier_confirmed'`, [flightTask],
      )).toEqual([]);
      expect(await owner(
        `select 1 from public.audit_events where action = 'purchase.supplier_confirmed' and target_id = $1`, [flightTask],
      )).toEqual([]);
      // The Purchase-role read of the flight task is gone (workspace and the select policies); the manager keeps it.
      expect(await one(DUAL, WORKSPACE_SQL, [flightTask])).toBeNull();
      expect(await run(DUAL, 'select id from public.purchase_quotes where task_id = $1', [flightTask])).toEqual([]);
      expect(await run(DUAL, 'select id from public.purchase_cost_versions where task_id = $1', [flightTask])).toEqual([]);
      expect(await run(DUAL, 'select id from public.purchase_evidence where task_id = $1', [flightTask])).toEqual([]);
      await refused(DUAL, 'select public.purchase_evidence_authorize_download($1) as r', [storedEv], '42501', 'not_authorized');
      expect(await run(MANAGER, 'select id from public.purchase_quotes where task_id = $1', [flightTask])).toHaveLength(1);
      expect(await one(MANAGER, WORKSPACE_SQL, [flightTask])).toMatchObject({ canWork: false, canRelease: false });
    });
  });

  it('the same Flight + Purchase holder still works a Purchase task end to end to supplier_confirmed', async () => {
    await asOwner(db, async () => {
      await addFlight(U.purchaseJodhpur);
      const { hotelTask, flightTask } = await hotelAndFlight();
      await one(DUAL, FLIGHT_CLAIM_SQL, [flightTask]);
      await one(DUAL, PURCHASE_CLAIM_SQL, [hotelTask]);
      expect(await one(DUAL, WORKSPACE_SQL, [hotelTask])).toMatchObject({ canWork: true, canRelease: true });
      const supplierId = await createSupplier(DUAL);
      const { quoteId, versionNo } = await prepare(DUAL, hotelTask, supplierId);
      // A withdrawn second quote: the withdraw command still works on the Purchase task.
      const second = await one<{ quoteId: string }>(DUAL, QUOTE_ADD_SQL, [hotelTask, rid(), quoteFields(supplierId)]);
      expect((await one<{ status: string }>(DUAL, QUOTE_WITHDRAW_SQL, [second.quoteId])).status).toBe('withdrawn');
      const extra = await evidence(DUAL, hotelTask, true);
      expect((await one<{ status: string }>(DUAL, EV_REMOVE_SQL, [extra])).status).toBe('removed');
      expect((await one<{ outcome: string }>(DUAL, CONFIRM_SQL, [hotelTask, versionNo, 'SYN-CONF-0001'])).outcome).toBe('created');
      expect(await taskRow(hotelTask)).toEqual({ status: 'supplier_confirmed', assignee_user_id: U.purchaseJodhpur, supplier_reference: 'SYN-CONF-0001' });
      expect((await owner<{ status: string }>('select status from public.purchase_quotes where id = $1', [quoteId]))[0]!.status).toBe('selected');
      // The flight task is untouched.
      expect((await taskRow(flightTask)).status).toBe('in_progress');
    });
  });

  it('a Purchase-only holder still works a Purchase task end to end to supplier_confirmed', async () => {
    await asOwner(db, async () => {
      expect(await owner(
        `select 1 from public.memberships where user_id = $1 and role_code = 'flight'`, [U.purchaseJodhpur],
      )).toEqual([]);
      const { hotelTask } = await hotelAndFlight();
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [hotelTask]);
      const supplierId = await createSupplier(PURCHASE);
      const { versionNo } = await prepare(PURCHASE, hotelTask, supplierId);
      expect((await one<{ outcome: string }>(PURCHASE, CONFIRM_SQL, [hotelTask, versionNo, 'SYN-CONF-0002'])).outcome).toBe('created');
      expect((await taskRow(hotelTask)).status).toBe('supplier_confirmed');
    });
  });

  it('the Flight desk commands still work for the Flight + Purchase holder on the flight task', async () => {
    await asOwner(db, async () => {
      await addFlight(U.purchaseJodhpur);
      const { flightTask } = await hotelAndFlight();
      expect(await one<{ status: string }>(DUAL, FLIGHT_CLAIM_SQL, [flightTask])).toMatchObject({ status: 'in_progress' });
      expect(await one(DUAL, FLIGHT_GET_SQL, [flightTask])).toMatchObject({ status: 'in_progress', assignedToYou: true });
      expect(await one(DUAL, WORK_FORM_SQL, [flightTask])).toMatchObject({ department: 'flight' });
      const fare = { costKind: 'fare', amountPaise: '2500000', paidBy: 'company', paymentMode: 'card', paidOn: '2026-10-10' };
      const saved = await one<{ entryId: string; rowVersion: number; expenseStatus: string }>(DUAL, COST_SAVE_SQL,
        [flightTask, null, 0, JSON.stringify(fare), rid()]);
      expect(saved.expenseStatus).toBe('draft');
      const proof = await deskEvidence(DUAL, flightTask, 'direct_payment_proof');
      const linked = await one<{ rowVersion: number }>(DUAL, COST_SAVE_SQL,
        [flightTask, saved.entryId, saved.rowVersion, JSON.stringify({ ...fare, receiptEvidenceId: proof }), rid()]);
      expect((await one<{ expenseStatus: string }>(DUAL, COST_SUBMIT_SQL, [saved.entryId, linked.rowVersion])).expenseStatus).toBe('submitted');
      expect(await taskRow(flightTask)).toMatchObject({ status: 'in_progress', assignee_user_id: U.purchaseJodhpur });
    });
  });

  it('purchase_workspace: a Purchase-only holder reads hotel tasks but not flight tasks (no traveller names); the branch manager reads both', async () => {
    await asOwner(db, async () => {
      const { hotelTask, flightTask } = await hotelAndFlight();
      const flightForPurchase = await one<unknown>(PURCHASE, WORKSPACE_SQL, [flightTask]);
      expect(flightForPurchase).toBeNull();
      expect(JSON.stringify(flightForPurchase)).not.toMatch(/Synthetic Traveller/);
      const hotelForPurchase = await one<{ task: { taskId: string; department: string } } | null>(PURCHASE, WORKSPACE_SQL, [hotelTask]);
      expect(hotelForPurchase?.task).toMatchObject({ taskId: hotelTask, department: 'purchase' });
      expect(await one(MANAGER, WORKSPACE_SQL, [hotelTask])).toMatchObject({ task: { taskId: hotelTask, department: 'purchase' }, canWork: false });
      expect(await one(MANAGER, WORKSPACE_SQL, [flightTask])).toMatchObject({ task: { taskId: flightTask, department: 'flight' }, canWork: false });
      // After taking the flight task the Flight + Purchase holder still gets nothing from the Purchase workspace.
      await addFlight(U.purchaseJodhpur);
      await one(DUAL, FLIGHT_CLAIM_SQL, [flightTask]);
      expect(await one(DUAL, WORKSPACE_SQL, [flightTask])).toBeNull();
      expect(await one(DUAL, WORKSPACE_SQL, [hotelTask])).toMatchObject({ task: { taskId: hotelTask } });
    });
  });

  it('purchase_task_reassign: a flight task goes only to an active Flight person; a Purchase task only to an active Purchase person', async () => {
    await asOwner(db, async () => {
      const { hotelTask, flightTask } = await hotelAndFlight();
      await addFlight(U.visaJodhpur);
      await one(FLIGHT, FLIGHT_CLAIM_SQL, [flightTask]);
      // Flight task: a Purchase-only person is neither offered nor accepted, the task does not move.
      expect(await one(MANAGER, WORKSPACE_SQL, [flightTask])).toMatchObject({ canReassign: true, reassignCandidates: [] });
      await refused(MANAGER, REASSIGN_SQL, [flightTask, U.visaJodhpur, U.purchaseJodhpur], '22023', 'invalid_input');
      expect(await taskRow(flightTask)).toMatchObject({ status: 'in_progress', assignee_user_id: U.visaJodhpur });
      // With an active Flight role the same person is offered and may take it over.
      await addFlight(U.purchaseJodhpur);
      expect(await one(MANAGER, WORKSPACE_SQL, [flightTask])).toMatchObject({
        reassignCandidates: [{ userId: U.purchaseJodhpur, name: 'Synthetic Purchase Jodhpur' }] });
      expect(await one(MANAGER, REASSIGN_SQL, [flightTask, U.visaJodhpur, U.purchaseJodhpur])).toMatchObject({ outcome: 'created' });
      expect(await taskRow(flightTask)).toMatchObject({ status: 'in_progress', assignee_user_id: U.purchaseJodhpur });
      // And back to a Flight person without any Purchase role.
      expect(await owner(`select 1 from public.memberships where user_id = $1 and role_code = 'purchase'`, [U.visaJodhpur])).toEqual([]);
      expect(await candidates(flightTask)).toEqual([U.visaJodhpur]);
      expect(await one(MANAGER, REASSIGN_SQL, [flightTask, U.purchaseJodhpur, U.visaJodhpur])).toMatchObject({ outcome: 'created' });
      expect(await taskRow(flightTask)).toMatchObject({ status: 'in_progress', assignee_user_id: U.visaJodhpur });
      // Still the branch manager only.
      await refused(PURCHASE, REASSIGN_SQL, [flightTask, U.visaJodhpur, U.purchaseJodhpur], '42501', 'not_authorized');

      // Purchase task: candidates and acceptance unchanged (Purchase people only).
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [hotelTask]);
      expect(await candidates(hotelTask)).toEqual([]);
      await refused(MANAGER, REASSIGN_SQL, [hotelTask, U.purchaseJodhpur, U.visaJodhpur], '22023', 'invalid_input');
      expect(await taskRow(hotelTask)).toMatchObject({ status: 'in_progress', assignee_user_id: U.purchaseJodhpur });
      await addPurchase(U.visaJodhpur);
      await addFlight(U.accountsJodhpur);
      expect(await candidates(hotelTask)).toEqual([U.visaJodhpur]); // the Flight-only person is not offered
      expect(await one(MANAGER, REASSIGN_SQL, [hotelTask, U.purchaseJodhpur, U.visaJodhpur])).toMatchObject({ outcome: 'created' });
      expect(await taskRow(hotelTask)).toMatchObject({ status: 'in_progress', assignee_user_id: U.visaJodhpur });
      // Purchase assignments as before: the new assignee holds one; the old one's ended (no other in-progress task).
      expect(await openKinds(U.visaJodhpur)).toEqual(['flight', 'purchase']);
      expect(await openKinds(U.purchaseJodhpur)).toEqual([]);
    });
  });

  it('flight reassign moves the Deal assignment of kind flight: the old Flight person stops reading the Deal, the new one reads it', async () => {
    await asOwner(db, async () => {
      const { flightTask } = await hotelAndFlight();
      await addFlight(U.visaJodhpur);
      await addFlight(U.salesDelhiB); // Sales Delhi B: reads only owned or assigned Deals (not SYN-DEL-001)
      await one(FLIGHT, FLIGHT_CLAIM_SQL, [flightTask]); // flight_task_claim records kind 'flight'
      const NEW: Actor = { userId: U.salesDelhiB };
      expect(await openKinds(U.visaJodhpur)).toEqual(['flight']);
      expect(await readsDeal(FLIGHT)).toBe(true);
      expect(await readsDeal(NEW)).toBe(false);
      expect(await candidates(flightTask)).toEqual([U.salesDelhiB]);
      expect(await one(MANAGER, REASSIGN_SQL, [flightTask, U.visaJodhpur, U.salesDelhiB])).toMatchObject({ outcome: 'created' });
      expect(await openKinds(U.visaJodhpur)).toEqual([]);
      expect(await openKinds(U.salesDelhiB)).toEqual(['flight']);
      expect(await owner(
        `select 1 from public.deal_assignments where deal_id = $1 and user_id = $2 and assignment_kind = 'flight' and ended_at is not null`,
        [DEAL, U.visaJodhpur],
      )).toHaveLength(1);
      expect(await readsDeal(FLIGHT)).toBe(false);
      expect(await readsDeal(NEW)).toBe(true);
      // The new assignee works the task on the Flight desk.
      expect(await one(NEW, FLIGHT_GET_SQL, [flightTask])).toMatchObject({ status: 'in_progress', assignedToYou: true });
    });
  });

  it('flight reassign refuses a person without a usable Flight membership; the candidates list leaves them out', async () => {
    await asOwner(db, async () => {
      const { flightTask } = await hotelAndFlight();
      await addFlight(U.visaJodhpur);
      await one(FLIGHT, FLIGHT_CLAIM_SQL, [flightTask]);
      const TARGET = U.accountsJodhpur; // Accounts in the fixtures; Flight added per case
      const cases: Array<[string, () => Promise<void>]> = [
        ['inactive Flight membership', () => addMembership(TARGET, 'flight', 'inactive')],
        ['invited Flight membership', () => addMembership(TARGET, 'flight', 'invited')],
        ['inactive staff profile', async () => {
          await addMembership(TARGET, 'flight');
          await owner(`update public.staff_profiles set status = 'inactive', deactivated_at = now() where user_id = $1`, [TARGET]);
        }],
        ['disabled branch', async () => {
          await addMembership(TARGET, 'flight', 'active', 'AMD');
          await owner(`update public.branches set status = 'disabled' where code = 'AMD'`);
        }],
        ['Flight in another entity', async () => {
          await owner(`update public.legal_entities set status = 'enabled' where code = 'SYNTHETIC_B'`);
          await addMembership(TARGET, 'flight', 'active', 'SB1', 'SYNTHETIC_B');
        }],
        ['Purchase only', () => addMembership(TARGET, 'purchase')],
      ];
      for (const [name, setup] of cases) {
        await db.exec('savepoint reassign_case');
        await setup();
        expect(await candidates(flightTask), name).toEqual([]);
        await expect(refused(MANAGER, REASSIGN_SQL, [flightTask, U.visaJodhpur, TARGET], '22023', 'invalid_input'), name).resolves.toBeUndefined();
        expect(await taskRow(flightTask), name).toMatchObject({ status: 'in_progress', assignee_user_id: U.visaJodhpur });
        await db.exec('rollback to savepoint reassign_case');
      }
      // Disabled entity: the task's entity cannot be disabled without ending the manager's own access first, so the
      // entity condition is proven on the shared helper (also used by the candidates list).
      await addMembership(TARGET, 'flight', 'active', 'SB1', 'SYNTHETIC_B'); // SYNTHETIC_B is disabled in the fixtures
      const helper = `select authz.is_active_department_person($1, (select id from public.legal_entities where code = 'SYNTHETIC_B'), 'flight') as ok`;
      expect((await owner<{ ok: boolean }>(helper, [TARGET]))[0]!.ok).toBe(false);
      await owner(`update public.legal_entities set status = 'enabled' where code = 'SYNTHETIC_B'`);
      expect((await owner<{ ok: boolean }>(helper, [TARGET]))[0]!.ok).toBe(true);
      // Control: an active Flight membership in the task's entity is offered and accepted.
      await addMembership(TARGET, 'flight');
      expect(await candidates(flightTask)).toEqual([TARGET]);
      expect(await one(MANAGER, REASSIGN_SQL, [flightTask, U.visaJodhpur, TARGET])).toMatchObject({ outcome: 'created' });
    });
  });

  it('visa task: reassign goes only to an active Visa person and moves the kind visa assignment', async () => {
    await asOwner(db, async () => {
      const { taskId } = await deskTask();
      await one(DESK, VISA_CLAIM_SQL, [taskId]);
      expect(await openKinds(U.visaJodhpur)).toEqual(['visa']);
      expect(await candidates(taskId)).toEqual([]); // visa.jodhpur is the only Visa person
      await refused(MANAGER, REASSIGN_SQL, [taskId, U.visaJodhpur, U.purchaseJodhpur], '22023', 'invalid_input');
      await addFlight(U.accountsJodhpur);
      await refused(MANAGER, REASSIGN_SQL, [taskId, U.visaJodhpur, U.accountsJodhpur], '22023', 'invalid_input');
      await addMembership(U.accountsJodhpur, 'visa');
      expect(await candidates(taskId)).toEqual([U.accountsJodhpur]);
      expect(await one(MANAGER, REASSIGN_SQL, [taskId, U.visaJodhpur, U.accountsJodhpur])).toMatchObject({ outcome: 'created' });
      expect(await taskRow(taskId)).toMatchObject({ status: 'in_progress', assignee_user_id: U.accountsJodhpur });
      expect(await openKinds(U.visaJodhpur)).toEqual([]);
      expect(await openKinds(U.accountsJodhpur)).toEqual(['visa']);
    });
  });

  it('function definitions keep their signature, volatility, security definer, search_path and grants', async () => {
    const rows = await db.query<{
      fn: string; secdef: boolean; volatile: string; config: string[] | null; returns: string; src: string;
      publicExec: boolean; anonExec: boolean; authExec: boolean;
    }>(
      `select p.oid::regprocedure::text as fn, p.prosecdef as secdef, p.provolatile as volatile, p.proconfig as config,
              pg_get_function_result(p.oid) as returns, p.prosrc as src,
              p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) as "publicExec",
              has_function_privilege('anon', p.oid, 'execute') as "anonExec",
              has_function_privilege('authenticated', p.oid, 'execute') as "authExec"
       from pg_proc p
       where p.oid in ('authz.can_work_purchase_task(uuid)'::regprocedure, 'authz.lock_workable_task(uuid)'::regprocedure,
                       'authz.can_read_purchase_workspace(uuid)'::regprocedure,
                       'authz.is_active_department_person(uuid, uuid, text)'::regprocedure,
                       'public.purchase_task_reassign(uuid, uuid, uuid)'::regprocedure,
                       'public.purchase_workspace(uuid)'::regprocedure)
       order by 1`,
    );
    // Every body names the department now; none of the previous bodies did.
    expect(rows.map(({ src, ...rest }) => ({ ...rest, department: /department/.test(src) }))).toEqual([
      { fn: 'authz.can_read_purchase_workspace(uuid)', secdef: true, volatile: 's', config: ['search_path=""'], returns: 'boolean',
        publicExec: false, anonExec: false, authExec: true, department: true },
      { fn: 'authz.can_work_purchase_task(uuid)', secdef: true, volatile: 's', config: ['search_path=""'], returns: 'boolean',
        publicExec: false, anonExec: false, authExec: false, department: true },
      { fn: 'authz.is_active_department_person(uuid,uuid,text)', secdef: true, volatile: 's', config: ['search_path=""'], returns: 'boolean',
        publicExec: false, anonExec: false, authExec: false, department: true },
      { fn: 'authz.lock_workable_task(uuid)', secdef: true, volatile: 'v', config: ['search_path=""'], returns: 'fulfilment_tasks',
        publicExec: false, anonExec: false, authExec: false, department: true },
      { fn: 'purchase_task_reassign(uuid,uuid,uuid)', secdef: true, volatile: 'v', config: ['search_path=""'], returns: 'jsonb',
        publicExec: false, anonExec: false, authExec: true, department: true },
      { fn: 'purchase_workspace(uuid)', secdef: true, volatile: 's', config: ['search_path=""'], returns: 'jsonb',
        publicExec: false, anonExec: false, authExec: true, department: true },
    ]);
    // The reassign command and the workspace read stay closed to the secret-key server client, as before.
    const svc = await db.query<{ ok: boolean }>(
      `select has_function_privilege('service_role', f::regprocedure, 'execute') as ok
       from unnest(array['public.purchase_task_reassign(uuid, uuid, uuid)', 'public.purchase_workspace(uuid)']) f`,
    );
    expect(svc.map((r) => r.ok)).toEqual([false, false]);
  });
});
