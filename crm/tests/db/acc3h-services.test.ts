import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, resetActor } from '../helpers/db';
import { FLIGHT, FLIGHT_ITEM, VISA_DESK, VISA_ITEM } from './acc-support';
import {
  ACC, ACTIVITY_ITEM, DEAL, HOTEL, MANAGER, MANAGER_J2, NEW_SELLING, OWNER, PURCHASE, REASON, SQLB, TRANSFER_ITEM, U, relbHelpers, rid, text,
} from './acc3-relb-support';

/**
 * Accounts phase 3, track H (contract 11, R12): the builder's own checks next
 * to Track T's acc3-h-services. The sweep (R12) lists every work list / count
 * reading fulfilment_tasks and proves each filters closed tasks or is one the
 * lead was told about; the scenarios cover what T's file does not: a later
 * trip cancellation after a removal, a simple removal that became booked, the
 * resubmit of a returned removal, payments while a removal is open, the
 * additive R-G1 keys and the R-H1 fence for Accounts.
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

const taskOf = async (item: string) =>
  (await owner<{ id: string }>('select id from public.fulfilment_tasks where service_item_id = $1', [item]))[0]!.id;

/** Work lists and counts that read fulfilment_tasks and filter closed tasks (H replaced them). */
const FILTERS_CLOSED = ['public.purchase_task_list', 'public.purchase_home_counts', 'public.flight_home_counts', 'public.visa_home_counts',
  // Addendum L9 (20261205000750).
  'public.flight_queue', 'public.flight_task_list', 'public.visa_queue', 'public.visa_task_list', 'public.my_work_counts', 'authz.sm_home_counts'];
/** Left to track N (notices). */
const REPORTED = ['public.notice_inbox'];
/** Task-scoped helpers whose names look like lists (not work lists). */
const TASK_SCOPED = ['authz.deal_crm_work', 'authz.flight_can_work', 'authz.flight_ticket_counts', 'authz.notice_task_or_queue',
  'authz.visa_require_work', 'public.deal_documents_list'];

describe('R12 sweep: a closed task is not open work', () => {
  it('every work list or count reading fulfilment_tasks is reviewed; the replaced ones filter closed_state', async () => {
    await resetActor(db);
    const rows = await owner<{ name: string; src: string }>(
      `select n.nspname || '.' || p.proname as name, p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'authz') and p.prosrc like '%fulfilment_tasks%'
         and p.proname ~ '(_list|_counts|_queue|_inbox|_work)$'`, []);
    const names = rows.map((r) => r.name).sort();
    const unknown = names.filter((n) => ![...FILTERS_CLOSED, ...REPORTED, ...TASK_SCOPED].includes(n));
    expect(unknown, 'a new work reader of fulfilment_tasks must treat closed tasks as not open work').toEqual([]);
    for (const n of FILTERS_CLOSED) expect(rows.find((r) => r.name === n)?.src, n).toContain('closed_state');
    const committed = (await owner<{ src: string }>(`select prosrc as src from pg_proc where proname = 'deal_committed'`, []))[0]!.src;
    expect(committed).toContain('closed_state');
  });

  it('a later trip cancellation needs no charge for a removed (closed) booked service', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal([ACTIVITY_ITEM, TRANSFER_ITEM]);
      await h.serviceChangesOn();
      const cr = await h.requestChange({ kind: 'remove_service', itemIds: [hotelItem], changeSummary: 'Synthetic: the hotel is dropped',
        customerChargePaise: '0' });
      await one(PURCHASE, SQLB.purchaseCharge, [hotelTask, '1000000', '0', null, null, 0, rid()]);
      const v = await h.openChange(cr.changeRequestId);
      await h.newTotal(v.versionId, v.rowVersion);
      await h.submitChange(cr.changeRequestId, [hotelItem]);
      await h.decideChange(cr.changeRequestId, 'approve');  // Addendum O2: the Manager approves the version sent
      expect((await h.taskRow(hotelTask)).closed_state).toBe('cancelled');
      expect(text(await one(PURCHASE, SQLB.purchaseTaskList, []))).not.toContain(hotelTask);
      const c = await one<{ cancellationId: string }>(MANAGER, 'select public.deal_cancellation_open($1, $2, $3) as r', [DEAL, REASON, rid()]);
      await resetActor(db);
      const [m] = await owner<{ n: number }>('select authz.cancellation_charges_missing($1) as n', [c.cancellationId]);
      expect(m!.n).toBe(0);
      // The removal's charge rows never count for the trip cancellation.
      const [x] = await owner<{ n: number }>('select count(*)::int as n from public.purchase_cancellation_charges where cancellation_id = $1',
        [c.cancellationId]);
      expect(x!.n).toBe(0);
    });
  });
});

describe('11.3 removal rules', () => {
  it('while a simple removal is open Purchase cannot confirm the service; resubmit keeps the simple route rules', async () => {
    await asOwner(db, async () => {
      const { b } = await h.committedDeal([ACTIVITY_ITEM]);
      await h.serviceChangesOn();
      const activity = b.itemIds[1]!;
      const activityTask = await taskOf(activity);
      // Purchase took the safari and agreed a cost, nothing booked or paid yet.
      await h.purchaseCost(activityTask, await h.purchaseSupplier(), '100000');
      await one(PURCHASE, 'select public.purchase_booking_request_send($1, $2, $3, $4, $5, $6, $7) as r',
        [activityTask, 1, 'desk@example.test', [], 'Booking request · SYN · Synthetic', 'Synthetic body.', rid()]);
      const cr = await h.requestChange({ kind: 'remove_service', itemIds: [activity], changeSummary: 'Synthetic: the safari is dropped' });
      expect((await h.crRow(cr.changeRequestId)).removal_route).toBe('simple');
      await h.refusedToken(PURCHASE, 'select public.purchase_supplier_confirm($1, $2, $3) as r', [activityTask, 1, 'SYN-CONF-0009'],
        'service_removed', undefined, '55000');
      // Addendum O2: sent with its change version, then returned.
      await h.openChange(cr.changeRequestId);
      await h.submitChange(cr.changeRequestId, [activity]);
      await h.decideChange(cr.changeRequestId, 'return');
      const row = await h.crRow(cr.changeRequestId);
      const fields = { kind: 'remove_service', itemIds: [activity], changeSummary: 'Synthetic: the safari is dropped', reason: REASON };
      await h.refusedHint(OWNER, SQLB.crResubmit, [cr.changeRequestId, row.row_version, JSON.stringify({ ...fields, customerChargePaise: '250000' }),
        rid()], 'invalid_input', /customerChargePaise/, '22023');
      await one(OWNER, SQLB.crResubmit, [cr.changeRequestId, row.row_version, JSON.stringify(fields), rid()]);
      // Addendum O2: the details are edited while returned; the version is sent again with booking_change_submit.
      expect(await h.crRow(cr.changeRequestId)).toMatchObject({ status: 'returned', removal_route: 'simple' });
    });
  });

  it('a removal may not drop the last service; a simple route takes no customer charge; add names no item', async () => {
    await asOwner(db, async () => {
      const { hotelItem } = await h.committedDeal([]);
      await h.serviceChangesOn();
      await h.refusedHint(OWNER, SQLB.crCreate, [DEAL, JSON.stringify({ kind: 'remove_service', itemIds: [hotelItem],
        changeSummary: 'Synthetic: the hotel is dropped', reason: REASON, customerChargePaise: '0' }), rid()], 'not_ready', /last_service/, '55000');
      await h.refusedHint(OWNER, SQLB.crCreate, [DEAL, JSON.stringify({ kind: 'add_service', itemIds: [hotelItem],
        changeSummary: 'Synthetic: add a transfer', reason: REASON }), rid()], 'invalid_input', /itemIds/, '22023');
    });
    await asOwner(db, async () => {
      const { b } = await h.committedDeal([ACTIVITY_ITEM]);
      await h.serviceChangesOn();
      await h.refusedHint(OWNER, SQLB.crCreate, [DEAL, JSON.stringify({ kind: 'remove_service', itemIds: [b.itemIds[1]],
        changeSummary: 'Synthetic: the safari is dropped', reason: REASON, customerChargePaise: '100' }), rid()], 'invalid_input',
      /customerChargePaise/, '22023');
    });
  });

  it('while a removal is open the service takes no new payment (change_in_progress); withdrawn, nothing closes and no refund is expected', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal([ACTIVITY_ITEM]);
      await h.serviceChangesOn();
      const cr = await h.requestChange({ kind: 'remove_service', itemIds: [hotelItem], changeSummary: 'Synthetic: the hotel is dropped',
        customerChargePaise: '0' });
      const pay = await h.attempt(PURCHASE, 'select public.supplier_payment_request_create($1, $2::jsonb, $3) as r', [hotelTask, JSON.stringify({
        expectedCostVersionNo: await h.agreedCostVersion(hotelTask), part: 'deposit', amountPaise: '100000', dueDate: null, note: null,
        proformaEvidenceId: await h.moneyFile(PURCHASE, hotelTask, 'proforma'), askFunding: false }), rid()]);
      expect(pay).toMatchObject({ ok: false, error: 'change_in_progress', code: '55000' });
      await one(PURCHASE, SQLB.purchaseCharge, [hotelTask, '1000000', '500000', null, null, 0, rid()]);
      await one(OWNER, SQLB.crWithdraw, [cr.changeRequestId, (await h.crRow(cr.changeRequestId)).row_version, REASON, rid()]);
      expect((await h.taskRow(hotelTask)).closed_state).toBeNull();
      expect(text(await one(ACC, SQLB.refundsDue, ['{}', null, 50]))).not.toContain(cr.changeRequestId);
    });
  });
});

describe('Addendum L9: no Purchase work on a removed service', () => {
  it('claim refused while the removal is open; after it is applied claim and the Purchase gate refuse service_removed', async () => {
    await asOwner(db, async () => {
      const { b } = await h.committedDeal([ACTIVITY_ITEM]);
      await h.serviceChangesOn();
      const activity = b.itemIds[1]!;
      const task = await taskOf(activity);
      const cr = await h.requestChange({ kind: 'remove_service', itemIds: [activity], changeSummary: 'Synthetic: the safari is dropped' });
      await h.refusedToken(PURCHASE, 'select public.purchase_task_claim($1) as r', [task], 'service_removed', undefined, '55000');
      const v = await h.openChange(cr.changeRequestId);
      await h.newTotal(v.versionId, v.rowVersion);
      await h.submitChange(cr.changeRequestId, [activity]);
      await h.decideChange(cr.changeRequestId, 'approve');  // Addendum O2: the Manager approves the version sent
      expect((await h.taskRow(task)).closed_state).toBe('withdrawn');
      await h.refusedToken(PURCHASE, 'select public.purchase_task_claim($1) as r', [task], 'service_removed', undefined, '55000');
      await resetActor(db);
      const [g] = await owner<{ g: string }>('select authz.procurement_gate_issue($1) as g', [task]);
      expect(g!.g).toBe('service_removed');
    });
  });
});

describe('Addendum L9 correction (20261205000760): supplier paperwork of a removed booked service', () => {
  it('closed booked task: supplier invoice and credit-note files allowed; a new booking request or proforma refused', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal([ACTIVITY_ITEM]);
      await h.serviceChangesOn();
      const cr = await h.requestChange({ kind: 'remove_service', itemIds: [hotelItem], changeSummary: 'Synthetic: the hotel is dropped',
        customerChargePaise: '0' });
      await one(PURCHASE, SQLB.purchaseCharge, [hotelTask, '1000000', '0', null, null, 0, rid()]);
      const v = await h.openChange(cr.changeRequestId);
      await h.newTotal(v.versionId, v.rowVersion);
      await h.submitChange(cr.changeRequestId, [hotelItem]);
      await h.decideChange(cr.changeRequestId, 'approve');  // Addendum O2: the Manager approves the version sent
      expect((await h.taskRow(hotelTask)).closed_state).toBe('cancelled');
      // The cancellation invoice for the charge kept, as a supplier original.
      const doc = await h.uploadDoc(hotelTask, { kind: 'invoice', number: 'SYN-CXL-0001', totalPaise: '1000000' });
      expect(doc.outcome).toBe('created');
      // A supplier credit note file.
      const credit = await one<{ evidenceId: string }>(PURCHASE, 'select public.supplier_money_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
        ['credit_note', hotelTask, 'credit.pdf', 'application/pdf', 2048, 'c'.repeat(64), rid()]);
      expect(credit.evidenceId).toBeTruthy();
      // Booking and commitment stay blocked.
      await h.refusedToken(PURCHASE, 'select public.supplier_money_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
        ['proforma', hotelTask, 'proforma.pdf', 'application/pdf', 2048, 'd'.repeat(64), rid()], 'service_removed', undefined, '55000');
      await h.refusedToken(PURCHASE, 'select public.purchase_booking_request_send($1, $2, $3, $4::text[], $5, $6, $7) as r',
        [hotelTask, 1, 'desk@example.test', [], 'Booking request · SYN · Synthetic', 'Synthetic body.', rid()], 'service_removed', undefined, '55000');
    });
  });
});

describe('Lead review (20261205000770): removed Flight and Visa services are not work', () => {
  /** Booked removal of `item` with the given department charge step, applied. */
  async function removeBooked(item: string, enterCharge: () => Promise<void>) {
    const cr = await h.requestChange({ kind: 'remove_service', itemIds: [item], changeSummary: 'Synthetic: a service is dropped',
      customerChargePaise: '0' });
    expect((await h.crRow(cr.changeRequestId)).removal_route).toBe('cancellation');
    // Addendum O2: filled and sent first; the charges gate the approval, which applies it at once.
    const v = await h.openChange(cr.changeRequestId);
    await h.newTotal(v.versionId, v.rowVersion);
    await h.submitChange(cr.changeRequestId, [item]);
    await enterCharge();
    await h.decideChange(cr.changeRequestId, 'approve');
    return cr;
  }
  async function applyRemoval(crId: string, item: string) {
    void item;
    expect((await h.crRow(crId)).status).toBe('applied');
  }

  it('a removed booked flight: not Flight work, no e-ticket upload, no payment; it does not block the group', async () => {
    await asOwner(db, async () => {
      const { b } = await h.committedDeal([FLIGHT_ITEM]);
      await h.serviceChangesOn();
      const flightItem = b.itemIds[1]!;
      const batch = await h.flightBatch(DEAL, [1]);
      const cr = await removeBooked(flightItem, async () => {
        await one(FLIGHT, 'select public.flight_cancellation_charge_set($1, $2::jsonb, $3, $4) as r', [batch.batchId,
          JSON.stringify({ airlineChargePaise: '100000', refundExpectedPaise: '0', refundReportedPaise: null, note: null }), 0, rid()]);
      });
      await applyRemoval(cr.changeRequestId, flightItem);
      expect((await h.taskRow(batch.flightTask)).closed_state).toBe('cancelled');
      await h.refusedToken(FLIGHT, 'select public.department_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
        [batch.flightTask, null, 'e_ticket', 'ticket.pdf', 'application/pdf', 2048, 'f'.repeat(64)], 'service_removed', undefined, '55000');
      await h.refusedToken(FLIGHT, 'select public.flight_direct_payment_save($1, $2, $3::jsonb, $4) as r',
        [batch.batchId, 0, JSON.stringify({}), rid()], 'service_removed', undefined, '55000');
      await resetActor(db);
      const [issues] = await owner<{ r: string[] }>('select authz.flight_done_issues($1) as r', [DEAL]);
      expect(issues!.r).not.toContain('tickets_pending');
      expect(issues!.r).not.toContain('payment_missing');
      expect(issues!.r).not.toContain('travellers_unnamed');
    });
  });

  it('a removed booked visa: fee refunds stand once approved; no file, no fee work afterwards', async () => {
    await asOwner(db, async () => {
      await h.addRole(U.salesAhmedabad, 'visa');
      const { b } = await h.committedDeal([{ ...VISA_ITEM, participants: [1] }]);
      await h.serviceChangesOn();
      const visaItem = b.itemIds[1]!;
      const visaTask = await taskOf(visaItem);
      await one(VISA_DESK, 'select public.visa_task_claim($1) as r', [visaTask]);
      await resetActor(db);
      const [app] = await owner<{ id: string }>('select id from public.visa_applications where task_id = $1 order by created_at limit 1', [visaTask]);
      // A company-paid "other" cost of the passenger (visa fees otherwise come from Applied) makes the visa booked.
      await one(VISA_DESK, 'select public.department_cost_save($1, $2, $3, $4::jsonb, $5) as r', [visaTask, null, 0, JSON.stringify({
        costKind: 'other', amountPaise: '25000', paidBy: 'company', paymentMode: 'cash', paidOn: new Date().toISOString().slice(0, 10),
        applicationId: app!.id }), rid()]);
      await resetActor(db);
      const [fee] = await owner<{ id: string }>(`select id from public.department_cost_entries where task_id = $1 and paid_by = 'company'`, [visaTask]);
      const setFee = (rev: number) => [fee!.id, '10000', null, rev, rid()];
      const cr = await removeBooked(visaItem, async () => {
        await one(VISA_DESK, 'select public.visa_cancellation_fee_set($1, $2::bigint, $3, $4, $5) as r', setFee(0));
      });
      // Approval applies a removal at once: the fee refund stands (the closed task is no Visa work any more).
      const again = await h.attempt(VISA_DESK, 'select public.visa_cancellation_fee_set($1, $2::bigint, $3, $4, $5) as r', setFee(1));
      expect(again.ok).toBe(false);
      await applyRemoval(cr.changeRequestId, visaItem);
      await h.refusedToken(VISA_DESK, 'select public.department_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
        [visaTask, null, 'fee_receipt', 'receipt.pdf', 'application/pdf', 2048, 'a'.repeat(64)], 'service_removed', undefined, '55000');
      const ws = await one<{ canManageFees: boolean; canWork: boolean }>(VISA_DESK, 'select public.visa_workspace($1) as r', [visaTask]);
      expect(ws).toMatchObject({ canManageFees: false, canWork: false });
    });
  });
});

describe('Addendum O2: the Manager approves the final version', () => {
  it('draft -> filled -> sent (frozen) -> returned -> edited -> sent -> approved exactly that version; R-H2 shows old and new', async () => {
    await asOwner(db, async () => {
      const { hotelItem } = await h.committedDeal();
      const cr = await h.requestChange({ itemIds: [hotelItem] });
      expect(cr.status).toBe('draft');
      await h.refusedToken(MANAGER, SQLB.crDecide, [cr.changeRequestId, 'approve', null, cr.rowVersion, rid()], 'wrong_state', undefined, '55000');
      const v = await h.sendChange(cr.changeRequestId, hotelItem);
      const sent = await h.crRow(cr.changeRequestId);
      expect(sent.status).toBe('requested');
      // The version sent is frozen.
      const [ver] = await owner<{ row_version: number }>('select row_version from public.booking_versions where id = $1', [v.versionId]);
      await h.refusedToken(OWNER, SQLB.itemSave, [hotelItem, v.versionId, ver!.row_version, JSON.stringify({ ...HOTEL, roomType: 'Synthetic Villa' }), '20000000'],
        'wrong_state', undefined, '55000');
      const review = await one<{ base: { sellingTotalPaise: string }; proposed: { sellingTotalPaise: string; plan: unknown[] };
        sentVersionCurrent: boolean; canDecide: boolean }>(MANAGER, 'select public.change_request_review($1) as r', [cr.changeRequestId]);
      expect(review.proposed.sellingTotalPaise).toBe(NEW_SELLING);
      expect(review.base.sellingTotalPaise).not.toBe(NEW_SELLING);
      expect(review.proposed.plan.length).toBe(1);
      expect(review).toMatchObject({ sentVersionCurrent: true, canDecide: true });
      expect(await h.readOrNull(PURCHASE, 'select public.change_request_review($1) as r', [cr.changeRequestId])).toBeNull();
      // Returned: the same version is edited and sent again.
      await h.decideChange(cr.changeRequestId, 'return');
      const [ver2] = await owner<{ row_version: number }>('select row_version from public.booking_versions where id = $1', [v.versionId]);
      await h.newTotal(v.versionId, ver2!.row_version, '8200000');
      await h.submitChange(cr.changeRequestId, [hotelItem]);
      await h.decideChange(cr.changeRequestId, 'approve');
      const row = await h.crRow(cr.changeRequestId) as Record<string, unknown>;
      expect(row.status).toBe('approved');
      expect(row.approved_content_hash).toBe(row.submitted_content_hash);
      expect((await h.reconfirmations(cr.changeRequestId)).length).toBe(1);
    });
  });
});

describe('Lead decision (20261205000790): no active Sales owner - the branch Manager fills the change version', () => {
  it('with no Sales owner the Manager sets total and plan, sends it, cannot approve it; another Manager approves (LD37)', async () => {
    await asOwner(db, async () => {
      const { b } = await h.committedDeal([ACTIVITY_ITEM]);
      await h.serviceChangesOn();
      await h.dropRole(U.salesDelhiA, 'sales');
      const activity = b.itemIds[1]!;
      const cr = await h.requestChange({ kind: 'remove_service', itemIds: [activity], changeSummary: 'Synthetic: the activity is dropped' }, MANAGER);
      const v = await h.openChange(cr.changeRequestId, MANAGER);
      await h.newTotal(v.versionId, v.rowVersion, NEW_SELLING, MANAGER);
      await h.submitChange(cr.changeRequestId, [activity], MANAGER);
      await h.refusedToken(MANAGER, SQLB.crDecide, [cr.changeRequestId, 'approve', null, (await h.crRow(cr.changeRequestId)).row_version, rid()],
        'not_self_approval', undefined, '42501');
      await h.decideChange(cr.changeRequestId, 'approve', MANAGER_J2);
      expect((await h.crRow(cr.changeRequestId)).status).toBe('applied');
    });
  });

  it('with an active Sales owner the Manager may not set the change version\'s total (not_authorized)', async () => {
    await asOwner(db, async () => {
      const { hotelItem } = await h.committedDeal();
      const cr = await h.requestChange({ itemIds: [hotelItem] });
      const v = await h.openChange(cr.changeRequestId);
      const r = await h.attempt(MANAGER, 'select public.booking_commercials_save($1, $2, $3, $4, $5) as r', [v.versionId, v.rowVersion, null, null,
        NEW_SELLING]);
      expect(r).toMatchObject({ ok: false, error: 'not_authorized', code: '42501' });
    });
  });
});

describe('11.3 reads', () => {
  it('R-G1 additive keys; R-H1 readable by Accounts; add before commitment creates the task on apply', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal([ACTIVITY_ITEM]);
      await h.serviceChangesOn();
      const before = await one<{ serviceChangesEnabled: boolean; serviceBlockedBy: string[]; addableTypes: string[];
        removable: Array<{ itemId: string; route: string }> }>(OWNER, SQLB.dealChanges, [DEAL]);
      expect(before.serviceChangesEnabled).toBe(true);
      expect(before.serviceBlockedBy).toEqual([]);
      expect(before.addableTypes).toContain('transfer');
      expect(before.removable.find((r) => r.itemId === hotelItem)?.route).toBe('cancellation');
      const cr = await h.requestChange({ kind: 'remove_service', itemIds: [hotelItem], changeSummary: 'Synthetic: the hotel is dropped',
        customerChargePaise: '777001' });
      await one(PURCHASE, SQLB.purchaseCharge, [hotelTask, '1000000', '0', null, null, 0, rid()]);
      const acc = await one<{ complete: boolean; customerChargePaise: string }>(ACC, SQLB.removalCharges, [cr.changeRequestId]);
      expect(acc).toMatchObject({ complete: true, customerChargePaise: '777001' });
      const after = await one<{ serviceBlockedBy: string[]; addableTypes: string[] }>(OWNER, SQLB.dealChanges, [DEAL]);
      expect(after.serviceBlockedBy).toContain('change_open');
      expect(after.addableTypes).toEqual([]);
    });
    await asOwner(db, async () => {
      await h.people();
      const b = await h.book([ACTIVITY_ITEM]);
      await h.approveReal(b.versionId);
      await h.serviceChangesOn();
      const cr = await h.requestChange({ kind: 'add_service', itemIds: [], changeSummary: 'Synthetic: add an airport transfer' });
      const v = await h.openChange(cr.changeRequestId);
      const added = await h.addItem(OWNER, v.versionId, v.rowVersion, 'transfer', TRANSFER_ITEM.facts, '8000000');
      expect((await h.crRow(cr.changeRequestId)).item_ids).toEqual([added.itemId]);
      await h.newTotal(v.versionId, added.rowVersion, NEW_SELLING);
      await h.submitChange(cr.changeRequestId, [added.itemId]);
      await h.decideChange(cr.changeRequestId, 'approve');  // Addendum O2: the Manager approves the version sent
      expect((await h.crRow(cr.changeRequestId)).status).toBe('applied');
      const [t] = await owner<{ n: number }>('select count(*)::int as n from public.fulfilment_tasks where service_item_id = $1', [added.itemId]);
      expect(t!.n).toBe(1);
    });
  });
});
