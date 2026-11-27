import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, type TestDb, asOwner, createTestDb, resetActor } from '../helpers/db';
import { FLIGHT, OTHER_ENTITY, SELLING, VISA } from './acc-support';
import {
  ACC, ACTIVITY_ITEM, DEAL, HOTEL_ITEM, MANAGER, MANAGER_J2, NEW_SELLING, OWNER, PURCHASE, REASON, SQLB, TRANSFER_ITEM, U, relbHelpers, rid, text,
} from './acc3-relb-support';
import { trackLanded } from './acc3-support';

/**
 * Accounts phase 3, Track T — Release B, Track H: add or remove services
 * (contract section 11, refusals 13, fences 14, tests 16.1 H). Written from
 * the contract, not from Track H's code.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = relbHelpers(() => db);
const { one, owner } = h;

const scalar = async <T>(sql: string, params: unknown[]) => {
  await resetActor(db);
  return (await owner<{ r: T }>(sql, params))[0]!.r;
};
const seqs = async () => (await owner<{ seq: number }>('select seq from public.deal_travellers where deal_id = $1 order by seq', [DEAL])).map((t) => t.seq);
const tasksOfItem = (item: string) => owner<{ id: string; department: string }>('select id, department from public.fulfilment_tasks where service_item_id = $1',
  [item]);

/** Both switches On (ASSUMPTION: add / remove requests also need changes_enabled? the contract names only service_changes_enabled; both are On here). */
async function switches() {
  await h.changesOn();
  await h.serviceChangesOn();
}

describe('11.1 switch', () => {
  it('add_service / remove_service need service_changes_enabled (service_changes_off 55000); H1 is Super Admin only and audited', async () => {
    await asOwner(db, async () => {
      const { hotelItem } = await h.committedDeal();
      await h.refusedToken(OWNER, SQLB.crCreate, [DEAL, JSON.stringify({ kind: 'add_service', itemIds: [], changeSummary: 'Synthetic: add a transfer',
        reason: REASON }), rid()], 'service_changes_off');
      await h.refusedToken(OWNER, SQLB.crCreate, [DEAL, JSON.stringify({ kind: 'remove_service', itemIds: [hotelItem], changeSummary: 'Synthetic: drop the hotel',
        reason: REASON }), rid()], 'service_changes_off');
      await h.refused(MANAGER, SQLB.setServiceChanges, [true, REASON], 'not_authorized', '42501');
      await h.serviceChangesOn();
      const [audit] = (await h.audits('settings.booking_changes_changed')).slice(-1);
      expect(audit!.reason).toBe(REASON);
    });
  });

  it('allowed before commitment once a confirmed version exists (a plain change is not); remove_service names exactly one item', async () => {
    await asOwner(db, async () => {
      await h.people();
      const b = await h.book([HOTEL_ITEM, ACTIVITY_ITEM]);
      await h.approveReal(b.versionId);
      await switches();
      expect(await scalar<boolean>(SQLB.dealCommitted, [DEAL])).toBe(false);
      await h.refusedHint(OWNER, SQLB.crCreate, [DEAL, JSON.stringify({ kind: 'change', itemIds: [b.itemIds[0]], changeSummary: 'Synthetic change summary',
        reason: REASON }), rid()], 'not_ready', /not_committed/, '55000');
      await h.refusedHint(OWNER, SQLB.crCreate, [DEAL, JSON.stringify({ kind: 'remove_service', itemIds: b.itemIds, changeSummary: 'Synthetic: drop two',
        reason: REASON }), rid()], 'invalid_input', /itemIds/, '22023');
      const add = await h.requestChange({ kind: 'add_service', itemIds: [], changeSummary: 'Synthetic: add an airport transfer' });
      expect(add.status).toBe('draft');  // Addendum O2
      // One at a time per Deal, shared with changes.
      await h.refusedToken(OWNER, SQLB.crCreate, [DEAL, JSON.stringify({ kind: 'remove_service', itemIds: [b.itemIds[1]], changeSummary: 'Synthetic: drop one',
        reason: REASON }), rid()], 'change_open_exists');
    });
  });
});

describe('11.2 add a service', () => {
  /** Approved add_service request with its change version opened. */
  async function opened() {
    const c = await h.committedDeal([]);
    await h.serviceChangesOn();
    const cr = await h.requestChange({ kind: 'add_service', itemIds: [], changeSummary: 'Synthetic: add an airport transfer' });
    const v = await h.openChange(cr.changeRequestId);
    return { ...c, cr, v };
  }
  async function addTransfer(versionId: string, rv: number) {
    const added = await h.addItem(OWNER, versionId, rv, 'transfer', TRANSFER_ITEM.facts, '8000000');
    const next = (await one<{ rowVersion: number }>(OWNER, 'select public.service_item_travellers_save($1, $2, $3, $4::integer[]) as r',
      [added.itemId, versionId, added.rowVersion, await seqs()])).rowVersion;
    return { itemId: added.itemId, rowVersion: next };
  }

  it('add creates exactly one task per new service for the right department; nothing else changes; Accounts gets no approval step', async () => {
    await asOwner(db, async () => {
      const { cr, v, hotelTask } = await opened();
      const before = await h.snapshot(hotelTask);
      const added = await addTransfer(v.versionId, v.rowVersion);
      await h.newTotal(v.versionId, added.rowVersion);
      // ASSUMPTION: p_expected_changed_item_ids of an add is the list of added items (11.2: "items added are recorded in item_ids").
      await h.submitChange(cr.changeRequestId, [added.itemId]);
      await h.decideChange(cr.changeRequestId, 'approve');  // Addendum O2: the Manager approves the version sent
      expect((await h.crRow(cr.changeRequestId)).status).toBe('applied');
      expect((await h.crRow(cr.changeRequestId)).item_ids).toEqual([added.itemId]);
      const tasks = await tasksOfItem(added.itemId);
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.department).toBe('purchase');
      const [out] = await owner<{ n: number }>(`select count(*)::int as n from public.outbox_events where event_type = 'fulfilment.task_created'
        and payload::text like '%' || $1 || '%'`, [tasks[0]!.id]);
      expect(out!.n).toBe(1);
      // The confirmed hotel is untouched (task, cost, confirmation).
      const after = await h.snapshot(hotelTask);
      expect(after.task).toEqual(before.task);
      expect(after.costs).toEqual(before.costs);
      expect(after.confirmations).toEqual(before.confirmations);
      const [review] = await owner<{ approval_source: string }>('select approval_source from public.accounts_booking_reviews where booking_version_id = $1',
        [v.versionId]);
      expect(review!.approval_source).toBe('change_request');
      const dues = await one<{ totalPaise: string }>(ACC, SQLB.dealDues, [DEAL]);
      expect(dues.totalPaise).toBe(NEW_SELLING);
    });
  });

  it('service_item_add is refused outside the change version of an approved add_service request (revision_items_fixed)', async () => {
    await asOwner(db, async () => {
      const { hotelItem } = await h.committedDeal();
      const cr = await h.requestChange({ itemIds: [hotelItem] });
      const v = await h.openChange(cr.changeRequestId);
      await h.refused(OWNER, SQLB.itemAdd, [v.versionId, v.rowVersion, 'transfer', JSON.stringify(TRANSFER_ITEM.facts), '8000000', rid()],
        'revision_items_fixed');
    });
  });

  it('no existing service\'s facts may change in an add request (change_outside_request)', async () => {
    await asOwner(db, async () => {
      const { cr, v, hotelItem } = await opened();
      const added = await addTransfer(v.versionId, v.rowVersion);
      let rv = await h.editHotel(hotelItem, v.versionId, added.rowVersion);
      rv = await h.newTotal(v.versionId, rv);
      void rv;
      await h.refusedToken(OWNER, SQLB.crSubmit, [cr.changeRequestId, (await h.readiness(OWNER, v.versionId)).contentHash, [added.itemId], rid()],
        'change_outside_request');
    });
  });
});

describe('11.3 remove a service', () => {
  it('simple removal: route simple; approved; facts row absent in the change version; apply closes the task withdrawn; item cancelled', async () => {
    await asOwner(db, async () => {
      const { b } = await h.committedDeal([ACTIVITY_ITEM]);
      await h.serviceChangesOn();
      const activity = b.itemIds[1]!;
      const [activityTask] = await tasksOfItem(activity);
      const cr = await h.requestChange({ kind: 'remove_service', itemIds: [activity], changeSummary: 'Synthetic: the safari is dropped' });
      expect((await h.crRow(cr.changeRequestId)).removal_route).toBe('simple');
      const v = await h.openChange(cr.changeRequestId);
      let rv = (await one<{ rowVersion: number }>(OWNER, SQLB.itemRemove, [activity, v.versionId, v.rowVersion])).rowVersion;
      rv = await h.newTotal(v.versionId, rv);
      void rv;
      await h.submitChange(cr.changeRequestId, [activity]);
      await h.decideChange(cr.changeRequestId, 'approve');  // Addendum O2: the Manager approves the version sent
      expect((await h.crRow(cr.changeRequestId)).status).toBe('applied');
      const task = await h.taskRow(activityTask!.id);
      expect(task).toMatchObject({ closed_state: 'withdrawn', closed_change_request_id: cr.changeRequestId });
      expect(task.closed_at).not.toBeNull();
      expect((await h.itemRow(activity)).state).toBe('cancelled');
      expect((await h.audits('fulfilment.task_closed')).length).toBe(1);
      // The removed service cannot be re-added in a later add request (its facts row is absent).
      const [facts] = await owner<{ n: number }>('select count(*)::int as n from public.service_item_facts where service_item_id = $1 and booking_version_id = $2',
        [activity, v.versionId]);
      expect(facts!.n).toBe(0);
    });
  });

  it('booked removal: charges before approval (charges_missing), never approved by a charge enterer, task cancelled, refund expected, no deal_cancellations row', async () => {
    await asOwner(db, async () => {
      const { b, hotelItem, hotelTask } = await h.committedDeal([ACTIVITY_ITEM]);
      await h.serviceChangesOn();
      await h.refundsOn();
      const activityTask = (await tasksOfItem(b.itemIds[1]!))[0]!.id;
      const activityBefore = await h.taskRow(activityTask);
      // Supplier paid 40,000.00 for the hotel; customer paid the whole selling total.
      // Customer money first (Addendum L9), else the supplier payment needs company funding (funding_pending).
      const receipt = await h.receipt(DEAL, SELLING);
      const paid = await h.payRequest(hotelTask, 4_000_000);
      await h.payThrough(paid.id, 'verified');
      const cr = await h.requestChange({ kind: 'remove_service', itemIds: [hotelItem], changeSummary: 'Synthetic: the hotel is dropped',
        customerChargePaise: '500000' });
      expect(await h.crRow(cr.changeRequestId)).toMatchObject({ removal_route: 'cancellation' });
      // Addendum O2: the Sales owner fills the change version and sends it; then the charges gate the approval.
      const v = await h.openChange(cr.changeRequestId);
      let rv = (await one<{ rowVersion: number }>(OWNER, SQLB.itemRemove, [hotelItem, v.versionId, v.rowVersion])).rowVersion;
      rv = await h.newTotal(v.versionId, rv, NEW_SELLING);
      void rv;
      await h.submitChange(cr.changeRequestId, [hotelItem]);
      await h.refusedToken(MANAGER, SQLB.crDecide, [cr.changeRequestId, 'approve', null, (await h.crRow(cr.changeRequestId)).row_version, rid()],
        'charges_missing');
      // Purchase enters the supplier charges with the existing form, keyed by the change request.
      await one(PURCHASE, SQLB.purchaseCharge, [hotelTask, '1000000', '3000000', null, null, 0, rid()]);
      const [charge] = await owner<{ change_request_id: string; cancellation_id: string | null }>(
        'select change_request_id, cancellation_id from public.purchase_cancellation_charges where task_id = $1', [hotelTask]);
      expect(charge).toEqual({ change_request_id: cr.changeRequestId, cancellation_id: null });
      await h.decideChange(cr.changeRequestId, 'approve');
      expect((await h.crRow(cr.changeRequestId)).status).toBe('applied');
      expect(await h.taskRow(hotelTask)).toMatchObject({ closed_state: 'cancelled', status: 'supplier_confirmed' });
      expect((await h.itemRow(hotelItem)).state).toBe('cancelled');
      // No whole-trip cancellation (LD30).
      const [cancellations] = await owner<{ n: number }>('select count(*)::int as n from public.deal_cancellations where deal_id = $1', [DEAL]);
      expect(cancellations!.n).toBe(0);
      expect(await scalar<boolean>(SQLB.tripCancelled, [DEAL])).toBe(false);
      // Other services untouched.
      expect(await h.taskRow(activityTask)).toEqual(activityBefore);
      // The only supplier-confirmed task is closed: the Deal is no longer committed (closed tasks are not open work).
      expect(await scalar<boolean>(SQLB.dealCommitted, [DEAL])).toBe(false);
      // Supplier refund expectation from the charge row (source purchase_charge, change request).
      const due = await one<unknown>(ACC, SQLB.refundsDue, ['{}', null, 50]);
      expect(text(due)).toContain(cr.changeRequestId);
      expect(text(due)).toContain('3000000');
      // A closed task takes no new payment: refused service_removed at the proforma upload or at the request itself.
      const proforma = await h.attempt<{ evidenceId: string }>(PURCHASE, 'select public.supplier_money_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
        ['proforma', hotelTask, 'proforma.pdf', 'application/pdf', 2048, 'e'.repeat(64), rid()]);
      if (proforma.ok) {
        const pay = await h.attempt(PURCHASE, 'select public.supplier_payment_request_create($1, $2::jsonb, $3) as r', [hotelTask, JSON.stringify({
          expectedCostVersionNo: await h.agreedCostVersion(hotelTask), part: 'deposit', amountPaise: '100000', dueDate: null, note: null,
          proformaEvidenceId: proforma.value.evidenceId, askFunding: false }), rid()]);
        expect(pay).toMatchObject({ ok: false, error: 'service_removed', code: '55000' });
      } else {
        expect(proforma).toMatchObject({ ok: false, error: 'service_removed', code: '55000' });
      }
      // Customer money: the lower total makes an overpayment; the Phase 2 overpayment refund works as it is.
      const dues = await one<{ totalPaise: string; creditPaise: string }>(ACC, SQLB.dealDues, [DEAL]);
      expect(dues.totalPaise).toBe(NEW_SELLING);
      expect(BigInt(dues.creditPaise)).toBe(BigInt(SELLING) - BigInt(NEW_SELLING));
      const refund = await one<{ status: string }>(OWNER, SQLB.refundCreate, [DEAL, JSON.stringify({ reason: REASON, kind: 'overpayment', outcome: 'payout',
        amountPaise: dues.creditPaise, payeeKind: 'original_payer', payeeReceiptId: receipt.id }), rid()]);
      expect(refund.status).toBe('requested');
      // No Credit Note is drafted for a service removal (LD13).
      expect((await h.documents()).filter((d) => d.kind === 'credit_note')).toEqual([]);
    });
  });

  it('not_self_approval: on a Deal with no active Sales owner the branch Manager asks (SO*) and cannot approve; another Manager can (LD37)', async () => {
    await asOwner(db, async () => {
      // Addendum L9 path: the Deal's Sales owner leaves Sales, so the branch Manager (no P/F/V role) makes the request.
      const { b } = await h.committedDeal([ACTIVITY_ITEM]);
      await h.serviceChangesOn();
      const activityItem = b.itemIds[1]!;
      await h.dropRole(U.salesDelhiA, 'sales');
      const cr = await h.requestChange({ kind: 'remove_service', itemIds: [activityItem], changeSummary: 'Synthetic: the activity is dropped' }, MANAGER);
      expect((await h.crRow(cr.changeRequestId)).removal_route).toBe('simple');
      // Addendum O2: the requesting Manager (SO*) fills and sends the change version.
      await h.openChange(cr.changeRequestId, MANAGER);
      await h.submitChange(cr.changeRequestId, [activityItem], MANAGER);
      await h.refusedToken(MANAGER, SQLB.crDecide, [cr.changeRequestId, 'approve', null, (await h.crRow(cr.changeRequestId)).row_version, rid()],
        'not_self_approval', undefined, '42501');
      await h.decideChange(cr.changeRequestId, 'approve', MANAGER_J2);
      // Nothing to reconfirm for a simple removal: approved and applied at once.
      expect((await h.crRow(cr.changeRequestId)).status).toBe('applied');
    });
  });
});

describe('11.1 closed tasks are not open work (T-H sweep)', () => {
  it('a closed task appears in no Purchase list, home count or notice fan-out', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      const { b } = await h.committedDeal([ACTIVITY_ITEM, TRANSFER_ITEM]);
      await h.serviceChangesOn();
      const activity = b.itemIds[1]!;
      const activityTask = (await tasksOfItem(activity))[0]!.id;
      const listBefore = text(await one(PURCHASE, SQLB.purchaseTaskList, []));
      expect(listBefore).toContain(activityTask);
      const cr = await h.requestChange({ kind: 'remove_service', itemIds: [activity], changeSummary: 'Synthetic: the safari is dropped' });
      const v = await h.openChange(cr.changeRequestId);
      let rv = (await one<{ rowVersion: number }>(OWNER, SQLB.itemRemove, [activity, v.versionId, v.rowVersion])).rowVersion;
      rv = await h.newTotal(v.versionId, rv);
      void rv;
      await h.submitChange(cr.changeRequestId, [activity]);
      await h.decideChange(cr.changeRequestId, 'approve');  // Addendum O2: the Manager approves the version sent
      expect((await h.taskRow(activityTask)).closed_state).toBe('withdrawn');
      expect(text(await one(PURCHASE, SQLB.purchaseTaskList, []))).not.toContain(activityTask);
      expect(text(await one(PURCHASE, SQLB.purchaseHome, []))).toBeTruthy();
      await resetActor(db);
      const [closedAt] = await owner<{ t: string }>('select closed_at::text as t from public.fulfilment_tasks where id = $1', [activityTask]);
      // A later change on the Deal fans out notices: none for the closed task.
      const transfer = b.itemIds[2]!;
      await h.submittedChange(transfer, {
        itemIds: [transfer],
        edit: async (ver, r) => (await one<{ rowVersion: number }>(OWNER, SQLB.itemSave, [transfer, ver, r, JSON.stringify({ ...TRANSFER_ITEM.facts as object,
          vehicleType: 'SUV' }), '8000000'])).rowVersion,
      });
      const [late] = await owner<{ n: number }>('select count(*)::int as n from public.staff_notices where task_id = $1 and created_at > $2::timestamptz',
        [activityTask, closedAt!.t]);
      expect(late!.n).toBe(0);
    });
  });
});

describe('11.3 reads and fences', () => {
  it('deal_change_requests adds removalRoute, customerChargePaise, charges, addableTypes; R-H1 for M only; Purchase never sees the customer charge', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal([ACTIVITY_ITEM]);
      await h.serviceChangesOn();
      const cr = await h.requestChange({ kind: 'remove_service', itemIds: [hotelItem], changeSummary: 'Synthetic: the hotel is dropped',
        customerChargePaise: '777001' });
      await one(PURCHASE, SQLB.purchaseCharge, [hotelTask, '1000000', '0', null, null, 0, rid()]);
      const so = await one<{ requests: Array<Record<string, unknown>>; addableTypes?: unknown }>(OWNER, SQLB.dealChanges, [DEAL]);
      const req = so.requests.find((r) => r.id === cr.changeRequestId)!;
      expect(req).toMatchObject({ removalRoute: 'cancellation', customerChargePaise: '777001' });
      expect(Array.isArray(req.charges)).toBe(true);
      expect(so).toHaveProperty('addableTypes');
      const m = await one<unknown>(MANAGER, SQLB.removalCharges, [cr.changeRequestId]);
      expect(text(m)).toContain('777001');
      expect(text(m)).toContain('1000000');
      await h.addFlightPeople();
      for (const actor of [OWNER, PURCHASE, FLIGHT, VISA, OTHER_ENTITY] as Actor[]) {
        expect(await h.readOrNull(actor, SQLB.removalCharges, [cr.changeRequestId]), `fenced ${actor.userId}`).toBeNull();
      }
      // Purchase reads its own charge form (task_cancellation_json via the workspace) without the customer charge.
      const ws = await one<unknown>(PURCHASE, 'select public.purchase_workspace($1) as r', [hotelTask]);
      expect(text(ws)).not.toContain('777001');
      expect(text(ws)).toContain(cr.changeRequestId);
    });
  });
});

/**
 * R12 sweep (contract 11.1 / 20 R12, Addendum L9): every SQL reader of fulfilment_tasks either filters closed tasks
 * (its body names closed_state, or calls a helper whose body does) or is on this allow-list with the reason it may
 * still see a closed task. A new reader fails until it is classified. Reasons:
 *   one_task  a command or screen that acts on one named task (the task's own state checks apply; history stays readable)
 *   access    a permission rule for a named task (who may read or work it), not a list
 *   money     money, charges, Tally and supplier documents: a closed task keeps its money history
 *   history   Deal history, summaries and display helpers that show a removed service as history
 *   core      booking confirmation, change apply, sync and guards that create, lock or close tasks
 *   notices   notice fan-out and bell reads: Track N's (Addendum L9), re-checked once N lands
 */
const R12_REASONS = ['one_task', 'access', 'money', 'history', 'core', 'notices'] as const;
const R12_ALLOW: Record<string, (typeof R12_REASONS)[number]> = {
  // one_task
  'authz.flight_group_assignee': 'one_task', 'public.boarding_pass_slot_link': 'one_task',
  'public.department_evidence_authorize_download': 'one_task',
  // S11: resolves one stored file's task to its deal (files of closed tasks are listed too).
  'authz.file_move_source': 'one_task', 'public.department_evidence_begin': 'one_task',
  'public.department_evidence_finish': 'one_task', 'public.department_evidence_remove': 'one_task', 'public.flight_change_acknowledge': 'one_task',
  'public.flight_change_decide': 'one_task', 'public.flight_change_submit': 'one_task', 'public.flight_change_withdraw': 'one_task',
  'public.flight_group_claim': 'one_task', 'public.flight_group_complete': 'one_task', 'public.flight_group_reassign': 'one_task',
  'public.flight_screenshot_sectors_save': 'one_task', 'public.flight_sector_fill_blanks': 'one_task', 'public.flight_task_claim': 'one_task',
  'public.flight_ticket_correct': 'one_task', 'public.flight_tickets_confirm': 'one_task', 'public.purchase_booking_change_ack': 'one_task',
  'public.purchase_booking_request_send': 'one_task', 'public.purchase_email_mark_result': 'one_task', 'public.purchase_email_record': 'one_task',
  'public.purchase_evidence_authorize_download': 'one_task', 'public.purchase_evidence_begin': 'one_task',
  'public.purchase_evidence_finish': 'one_task', 'public.purchase_evidence_remove': 'one_task', 'public.purchase_task_reassign': 'one_task',
  'public.purchase_task_release': 'one_task', 'public.purchase_voucher_mark_ready': 'one_task', 'public.task_reconfirm_record': 'one_task',
  'public.visa_applications_apply': 'one_task', 'public.visa_task_claim': 'one_task',
  // access
  'authz.b11_can_edit_identity': 'access', 'authz.can_claim_purchase_task': 'access', 'authz.can_claim_visa_task': 'access',
  'authz.can_manage_purchase_task': 'access', 'authz.can_read_department_task': 'access', 'authz.can_read_flight_task': 'access',
  'authz.can_read_purchase_task': 'access', 'authz.can_read_purchase_workspace': 'access', 'authz.can_read_task_history': 'access',
  'authz.can_read_traveller_identity': 'access', 'authz.can_read_visa_task': 'access', 'authz.can_work_department_task': 'access',
  'authz.cr_lock_apply': 'access', 'authz.flight_can_decide_change': 'access',
  'authz.flight_can_enter_charge': 'access', 'authz.flight_can_upload_boarding_pass': 'access', 'authz.flight_can_work': 'access',
  'authz.flight_is_deal_assignee': 'access', 'authz.flight_lock_group': 'access', 'authz.flight_owns_task_record': 'money', 'authz.cr_lock_h': 'core',
  'authz.id_proof_viewer_role': 'access', 'authz.lock_visa_application': 'access', 'authz.lock_workable_task': 'access',
  'authz.service_item_file_viewer': 'access', 'authz.visa_can_manage_fees': 'access', 'authz.visa_lock_application': 'access',
  'authz.visa_require_work': 'access',
  // money
  'authz.acct_original_items': 'money', 'authz.acct_row_json': 'money', 'authz.acct_rows': 'money', 'authz.cancellation_charges_json': 'money',
  'authz.cancellation_needs_charges': 'money', 'authz.cost_version_approved': 'money', 'authz.cr_visa_cancellation_json': 'money',
  'authz.finance_expense_item_json': 'money', 'authz.flight_deal_budget': 'money', 'authz.flight_fare_check': 'money',
  'authz.flight_group_budget': 'money', 'authz.flight_sales_fare_json': 'money', 'authz.flight_task_budget': 'money',
  'authz.purchase_go_ahead_needed': 'money', 'authz.rc_task_stay': 'money', 'authz.sm_accounts_payment_json': 'money',
  'authz.sm_document_refuse_duplicate': 'money', 'authz.sm_document_upload_flight': 'money', 'authz.sm_invoice_missing': 'money',
  'authz.sm_link_eligible': 'money', 'authz.sm_manager_cost_rows': 'money', 'authz.sm_payment_create_flight': 'money',
  'authz.sm_payment_for_command': 'money', 'authz.sm_payment_still_valid': 'money', 'authz.sm_task_facts': 'money', 'authz.sm_task_title': 'money',
  'authz.sm_task_type': 'money', 'authz.sm_trip_end': 'money', 'authz.supplier_refund_sources': 'money', 'authz.tally_source_set': 'money',
  'authz.tally_task_service': 'money', 'authz.tally_touch_source': 'money', 'authz.task_budget': 'money',
  'public.accounts_supplier_documents': 'money', 'public.deal_cancellation_open': 'money', 'public.department_cost_save': 'money',
  'public.department_cost_submit': 'money', 'public.flight_cancellation_charge_set': 'money', 'public.flight_direct_payment_save': 'money',
  'public.flight_fare_approval_decide': 'money', 'public.flight_fare_approval_request': 'money', 'public.flight_fare_approval_sets': 'money',
  'public.flight_fare_approval_withdraw': 'money', 'public.manager_approvals': 'money', 'public.purchase_cancellation_charge_set': 'money',
  'public.purchase_cost_approve_over_budget': 'money', 'public.purchase_cost_propose': 'money', 'public.purchase_go_ahead_decide': 'money',
  'public.purchase_payment_context': 'money', 'public.purchase_payment_requests': 'money', 'public.purchase_quote_add': 'money',
  'public.purchase_quote_withdraw': 'money', 'public.rate_contract_lookup': 'money', 'public.service_removal_charges': 'money',
  'public.supplier_document_link_targets': 'money', 'public.supplier_document_link_task': 'money', 'public.supplier_document_upload': 'money',
  'public.supplier_money_evidence_authorize_download': 'money', 'public.supplier_money_evidence_begin': 'money',
  'public.supplier_money_evidence_finish': 'money', 'public.supplier_refund_record': 'money', 'public.supplier_refunds_due': 'money',
  'public.visa_cancellation_fee_set': 'money', 'public.visa_fee_send': 'money',
  // history
  'authz.deal_commitment_lock': 'history', 'authz.deal_crm_work': 'history', 'authz.deal_progress_json': 'history',
  'authz.flight_booking_diff': 'history', 'authz.flight_change_json': 'history', 'authz.flight_deal_kind': 'history',
  'authz.flight_first_date': 'history', 'authz.flight_group_status_json': 'history',
  'authz.flight_name_slots': 'history', 'authz.flight_progress_json': 'history', 'authz.flight_route_text': 'history',
  'authz.flight_task_json': 'history', 'authz.flight_task_status_json': 'history', 'authz.flight_task_title': 'history',
  'authz.flight_task_travellers': 'history', 'authz.flight_ticket_counts': 'history', 'authz.flight_travellers_json': 'history',
  'authz.flight_unnamed_count': 'history', 'authz.purchase_booking_diff': 'history', 'authz.purchase_task_json': 'history',
  'authz.service_item_json': 'history', 'authz.task_current_version': 'history', 'authz.task_participants_json': 'history',
  'authz.visa_applicants_json': 'history', 'authz.visa_booking_change_json': 'history', 'authz.visa_is_passport_task': 'history',
  'authz.visa_staff_name': 'history', 'authz.visa_task_facts': 'history', 'authz.visa_task_json': 'history', 'authz.visa_task_progress': 'history',
  'authz.visa_task_title': 'history', 'public.booking_health': 'history', 'public.booking_panel': 'history', 'public.deal_change_history': 'history',
  'public.deal_change_requests': 'history', 'public.deal_documents_list': 'history', 'public.deal_flight_history': 'history',
  'public.deal_flight_summary': 'history', 'public.deal_traveller_name_fill': 'history', 'public.deal_visa_history': 'history',
  'public.deal_visa_summary': 'history', 'public.department_task_history': 'history', 'public.department_work_form': 'history',
  'public.flight_workspace': 'history', 'public.purchase_booking_change': 'history', 'public.purchase_workspace': 'history',
  'public.task_customer_files': 'history', 'public.task_customer_message_status': 'history', 'public.task_reconfirmation_get': 'history',
  'public.traveller_id_proofs_for_task': 'history', 'public.visa_workspace': 'history',
  // core
  'authz.booking_create_item_tasks': 'core', 'authz.cmsg_hotel_params': 'core', 'authz.cmsg_on_department_evidence': 'core',
  'authz.cmsg_on_ticket_batch': 'core', 'authz.end_purchase_assignment': 'core', 'authz.flight_insert_booking_sector': 'core',
  'authz.flight_insert_typed_sector': 'core', 'authz.purchase_evidence_guard': 'core',
  'authz.visa_added_after_completion': 'core', 'authz.visa_desk_launch_items': 'core', 'authz.visa_sync_after_revision': 'core',
  'authz.visa_sync_task': 'core', 'authz.visa_task_complete_if_done': 'core', 'public.admin_set_workflow_setting': 'core',
  'public.booking_confirm': 'core', 'public.flight_booking_change_apply': 'core',
  // notices
  'authz.notice_resolve_task_for_others': 'notices', 'authz.notice_task_or_queue': 'notices', 'authz.notice_visible_unread': 'notices',
  'authz.notices_on_boarding_pass_alert': 'notices', 'authz.notices_on_cancellation': 'notices', 'authz.notices_on_cancellation_status': 'notices',
  'authz.notices_on_cost_version': 'notices', 'authz.notices_on_expense': 'notices', 'authz.notices_on_outbox': 'notices',
  'authz.notices_on_supplier_document': 'notices', 'authz.notices_on_supplier_payment': 'notices', 'authz.staff_notice_visible': 'notices',
  'public.notice_history': 'notices', 'public.notice_inbox': 'notices',
};
/** Must hide closed tasks (Addendum L9; after 20261205000750) and the boarding-pass fan-out (notice 45). */
const R12_REQUIRED = ['public.flight_queue', 'public.flight_task_list', 'public.visa_queue', 'public.visa_task_list', 'public.my_work_counts',
  'authz.sm_home_counts', 'public.purchase_task_list', 'public.purchase_home_counts', 'public.flight_home_counts', 'public.visa_home_counts',
  'authz.deal_committed', 'authz.cancellation_charges_missing', 'authz.sm_payment_create', 'authz.flight_boarding_pass_due',
  // Lead review (20261205000770): the Deal's other flights can be marked done after a flight is removed.
  'authz.flight_done_issues', 'public.flight_group_complete', 'authz.can_work_department_task', 'authz.flight_owns_task',
  'authz.visa_can_manage_fees'];
/** Purchase cannot claim or confirm a removed service (Addendum L9): closed_state or the service_removed refusal. */
const R12_REMOVED_CHECK = ['authz.can_work_purchase_task', 'authz.procurement_issues'];
/** Track N must hide closed tasks here (Addendum L9). */
const R12_AFTER_N = ['public.notice_inbox', 'authz.notices_on_cancellation'];

describe('R12 sweep: every reader of fulfilment_tasks hides closed tasks or is allow-listed with a reason', () => {
  it.skipIf(!trackLanded('75'))('static proof over pg_proc', async () => {
    await asOwner(db, async () => {
      const procs = await owner<{ name: string; src: string }>(`select n.nspname || '.' || p.proname as name, string_agg(p.prosrc, ' ') as src
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'authz') group by 1`);
      const src = new Map(procs.map((p) => [p.name, p.src]));
      const closedAware = new Set(procs.filter((p) => /closed_state/i.test(p.src)).map((p) => p.name));
      const hides = (name: string) => {
        const body = src.get(name) ?? '';
        if (/closed_state/i.test(body)) return true;
        return [...closedAware].some((helper) => helper !== name && body.includes(helper));
      };
      for (const name of R12_REQUIRED) {
        expect(src.has(name), `${name} exists`).toBe(true);
        expect(hides(name), `${name} hides closed tasks`).toBe(true);
      }
      for (const name of R12_REMOVED_CHECK) expect(hides(name) || /service_removed/.test(src.get(name) ?? ''), `${name} refuses a removed service`).toBe(true);
      if (trackLanded('8')) for (const name of R12_AFTER_N) expect(hides(name), `${name} (Track N) hides closed tasks`).toBe(true);
      const readers = procs.filter((p) => /fulfilment_tasks/i.test(p.src)).map((p) => p.name);
      const unclassified = readers.filter((n) => !hides(n) && !R12_ALLOW[n] && !R12_REQUIRED.includes(n) && !R12_REMOVED_CHECK.includes(n)
        && !R12_AFTER_N.includes(n));
      expect(unclassified, 'new readers of fulfilment_tasks need a closed_state filter or an allow-list reason').toEqual([]);
      for (const reason of Object.values(R12_ALLOW)) expect(R12_REASONS).toContain(reason);
    });
  });
});
