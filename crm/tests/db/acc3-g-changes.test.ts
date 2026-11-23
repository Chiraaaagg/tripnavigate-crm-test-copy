import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, type TestDb, asOwner, createTestDb, resetActor } from '../helpers/db';
import { FLIGHT, OTHER_ENTITY, SALES_B, SELLING, VISA } from './acc-support';
import {
  ACC, DEAL, HOTEL, HOTEL_ITEM, MANAGER, MANAGER_J2, NEW_SELLING, OWNER, PURCHASE, REASON, SQLB, TRANSFER_ITEM, U, relbHelpers, rid, text,
} from './acc3-relb-support';
import { CONFLICT_STATE } from '../helpers/sqlstates';

/**
 * Accounts phase 3, Track T — Release B, Track G: change after a supplier
 * confirmed (contract section 10, refusals 13, fences 14, tests 16.1 G).
 * Written from the contract, not from Track G's code.
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

describe('10.1 the gap fix — over-budget approvals bound to the booking version (always on)', () => {
  /** Hotel task over budget (2,50,000.00 > 2,00,000.00), cost version 1 approved by the Manager. */
  async function overBudget() {
    await h.people();
    const b = await h.book([HOTEL_ITEM, TRANSFER_ITEM]);
    await h.approve(b.versionId);
    const task = h.taskOf(b, 'hotel');
    const supplier = await h.purchaseSupplier();
    await h.purchaseCost(task, supplier, '25000000');
    return { b, task };
  }

  it('the approval stores the current booking version; it stops counting after a newer version is confirmed; re-approval is allowed', async () => {
    await asOwner(db, async () => {
      const { b, task } = await overBudget();
      expect(await scalar<string[]>(SQLB.procurementIssues, [task])).toContain('over_budget');
      await one(MANAGER, SQLB.approveOverBudget, [task, 1]);
      const [row] = await owner<{ booking_version_id: string }>('select booking_version_id from public.purchase_cost_approvals where task_id = $1', [task]);
      expect(row!.booking_version_id).toBe(b.versionId);
      expect(await scalar<boolean>(SQLB.costApproved, [task, 1])).toBe(true);
      expect(await scalar<string[]>(SQLB.procurementIssues, [task])).not.toContain('over_budget');
      // A newer booking version (Accounts return + revision) is confirmed: the old approval no longer counts.
      const v2 = await h.revise(b.versionId, async (versionId, rv) =>
        (await one<{ rowVersion: number }>(OWNER, SQLB.itemSave, [b.itemIds[1], versionId, rv, JSON.stringify({ ...TRANSFER_ITEM.facts as object,
          vehicleType: 'SUV' }), '8000000'])).rowVersion);
      expect(await scalar<string>(SQLB.taskCurrentVersion, [task])).toBe(v2);
      expect(await scalar<boolean>(SQLB.costApproved, [task, 1])).toBe(false);
      expect(await scalar<string[]>(SQLB.procurementIssues, [task])).toContain('over_budget');
      // Re-approval for the new version is allowed (unique key now includes the booking version).
      await one(MANAGER, SQLB.approveOverBudget, [task, 1]);
      expect(await scalar<boolean>(SQLB.costApproved, [task, 1])).toBe(true);
      const rows = await owner<{ booking_version_id: string }>('select booking_version_id from public.purchase_cost_approvals where task_id = $1 order by approved_at',
        [task]);
      expect(rows.map((r) => r.booking_version_id)).toEqual([b.versionId, v2]);
    });
  });

  it('legacy rows (booking_version_id null) count only when no booking version with the task\'s item was confirmed after approved_at', async () => {
    await asOwner(db, async () => {
      const { b, task } = await overBudget();
      await resetActor(db);
      await owner(`insert into public.purchase_cost_approvals (task_id, legal_entity_id, version_no, approved_by, approved_at)
        select t.id, t.legal_entity_id, 1, $2, now() + interval '1 second' from public.fulfilment_tasks t where t.id = $1`, [task, U.managerDelhi]);
      expect(await scalar<boolean>(SQLB.costApproved, [task, 1])).toBe(true);
      // SYNTHETIC FIXTURE STEP: back-date the legacy row past the append-only guard (triggers off for this one statement, rolled back).
      await db.exec(`set local session_replication_role = replica`);
      await owner(`update public.purchase_cost_approvals set approved_at = (select confirmed_at - interval '1 hour' from public.booking_versions where id = $2)
        where task_id = $1`, [task, b.versionId]);
      await db.exec(`set local session_replication_role = origin`);
      expect(await scalar<boolean>(SQLB.costApproved, [task, 1]), 'confirmed after the legacy approval').toBe(false);
      // No existing row is changed by the migration (column stays null).
      const [r] = await owner<{ v: string | null }>('select booking_version_id as v from public.purchase_cost_approvals where task_id = $1', [task]);
      expect(r!.v).toBeNull();
    });
  });
});

describe('10.2 / 10.3 request rules', () => {
  it('switch Off -> changes_off; not committed -> not_ready (not_committed); second request -> change_open_exists (23505)', async () => {
    await asOwner(db, async () => {
      await h.people();
      const b = await h.book([HOTEL_ITEM, TRANSFER_ITEM]);
      await h.approveReal(b.versionId);
      await h.refusedToken(OWNER, SQLB.crCreate, [DEAL, JSON.stringify({ kind: 'change', itemIds: [b.itemIds[0]], changeSummary: 'Synthetic change summary',
        reason: REASON }), rid()], 'changes_off');
      await h.changesOn();
      await h.refusedHint(OWNER, SQLB.crCreate, [DEAL, JSON.stringify({ kind: 'change', itemIds: [b.itemIds[0]], changeSummary: 'Synthetic change summary',
        reason: REASON }), rid()], 'not_ready', /not_committed/, '55000');
      await h.supplierConfirmed(h.taskOf(b, 'hotel'));
      expect(await scalar<boolean>(SQLB.changeOpen, [DEAL])).toBe(false);
      const cr = await h.requestChange({ itemIds: [b.itemIds[0]!] });
      expect(cr.status).toBe('draft');  // Addendum O2: drafted first, sent with its version
      expect(cr.refNo).toMatch(/^CR-[0-9]{4}-[0-9]{6}$/);
      expect(await scalar<boolean>(SQLB.changeOpen, [DEAL]), 'deal_change_open true while live').toBe(true);
      await h.refusedToken(OWNER, SQLB.crCreate, [DEAL, JSON.stringify({ kind: 'change', itemIds: [b.itemIds[1]], changeSummary: 'Synthetic change summary',
        reason: REASON }), rid()], 'change_open_exists');
      const [audit] = await h.audits('booking.change_requested');
      expect(audit!.details).toMatchObject({ changeRequestId: cr.changeRequestId, dealId: DEAL, kind: 'change', itemCount: 1 });
    });
  });

  it('a replayed request id answers the same request; invalid_input names the field', async () => {
    await asOwner(db, async () => {
      const { hotelItem } = await h.committedDeal();
      const request = rid();
      const a = await h.requestChange({ itemIds: [hotelItem] }, OWNER, DEAL, request);
      const b = await h.requestChange({ itemIds: [hotelItem] }, OWNER, DEAL, request);
      expect(b.changeRequestId).toBe(a.changeRequestId);
      expect(b.outcome ?? 'existing').toBe('existing');
    });
  });

  it('invalid_input: summary or reason too short; change with no item or more than 20 items', async () => {
    await asOwner(db, async () => {
      const { hotelItem } = await h.committedDeal();
      await h.refusedHint(OWNER, SQLB.crCreate, [DEAL, JSON.stringify({ kind: 'change', itemIds: [hotelItem], changeSummary: 'short', reason: REASON }), rid()],
        'invalid_input', /changeSummary/, '22023');
      await h.refusedHint(OWNER, SQLB.crCreate, [DEAL, JSON.stringify({ kind: 'change', itemIds: [hotelItem], changeSummary: 'Synthetic change summary',
        reason: 'short' }), rid()], 'invalid_input', /reason/, '22023');
      await h.refusedHint(OWNER, SQLB.crCreate, [DEAL, JSON.stringify({ kind: 'change', itemIds: [], changeSummary: 'Synthetic change summary',
        reason: REASON }), rid()], 'invalid_input', /itemIds/, '22023');
    });
  });

  it('trip cancelled -> not_ready (trip_cancelled); other Sales and Purchase may not ask', async () => {
    await asOwner(db, async () => {
      const { hotelItem } = await h.committedDeal();
      await h.refused(SALES_B, SQLB.crCreate, [DEAL, JSON.stringify({ kind: 'change', itemIds: [hotelItem], changeSummary: 'Synthetic change summary',
        reason: REASON }), rid()], 'not_authorized', '42501');
      await h.refused(PURCHASE, SQLB.crCreate, [DEAL, JSON.stringify({ kind: 'change', itemIds: [hotelItem], changeSummary: 'Synthetic change summary',
        reason: REASON }), rid()], 'not_authorized', '42501');
      await one(MANAGER, 'select public.deal_cancellation_open($1, $2, $3) as r', [DEAL, REASON, rid()]);
      await h.refusedHint(OWNER, SQLB.crCreate, [DEAL, JSON.stringify({ kind: 'change', itemIds: [hotelItem], changeSummary: 'Synthetic change summary',
        reason: REASON }), rid()], 'not_ready', /trip_cancelled/, '55000');
    });
  });

  it('LD36: an old hotel-only booking version is not changeable here (change_not_supported)', async () => {
    await asOwner(db, async () => {
      const { b, hotelItem } = await h.committedDeal();
      // SYNTHETIC FIXTURE STEP: relabel the confirmed version as a pre-package hotel-only version.
      await resetActor(db);
      await db.exec(`set local session_replication_role = replica`);
      await owner(`update public.booking_versions set service_type = 'hotel' where id = $1`, [b.versionId]);
      await db.exec(`set local session_replication_role = origin`);
      await h.refusedToken(OWNER, SQLB.crCreate, [DEAL, JSON.stringify({ kind: 'change', itemIds: [hotelItem], changeSummary: 'Synthetic change summary',
        reason: REASON }), rid()], 'change_not_supported');
    });
  });

  it('G4: the Approver only; a requesting Manager needs another Manager (not_self_approval 42501, LD37); return needs a reason', async () => {
    await asOwner(db, async () => {
      const { hotelItem } = await h.committedDeal();
      const mine = await h.requestChange({ itemIds: [hotelItem] }, MANAGER);
      // Addendum O2: nothing to decide until the filled version is sent.
      await h.refusedToken(MANAGER_J2, SQLB.crDecide, [mine.changeRequestId, 'approve', null, mine.rowVersion, rid()], 'wrong_state', undefined, '55000');
      await h.sendChange(mine.changeRequestId, hotelItem);  // the Sales owner fills and sends it (SO*)
      mine.rowVersion = (await h.crRow(mine.changeRequestId)).row_version;
      await h.refusedToken(MANAGER, SQLB.crDecide, [mine.changeRequestId, 'approve', null, mine.rowVersion, rid()], 'not_self_approval', undefined, '42501');
      await h.refused(OWNER, SQLB.crDecide, [mine.changeRequestId, 'approve', null, mine.rowVersion, rid()], 'not_authorized', '42501');
      await h.refused(ACC, SQLB.crDecide, [mine.changeRequestId, 'approve', null, mine.rowVersion, rid()], 'not_authorized', '42501');
      await h.refusedHint(MANAGER_J2, SQLB.crDecide, [mine.changeRequestId, 'return', null, mine.rowVersion, rid()], 'invalid_input', /reason/, '22023');
      await h.decideChange(mine.changeRequestId, 'return', MANAGER_J2, REASON);
      expect((await h.crRow(mine.changeRequestId)).status).toBe('returned');
      // Resubmit by the requester; then approved by the other Manager.
      const row = await h.crRow(mine.changeRequestId);
      await one(MANAGER, SQLB.crResubmit, [mine.changeRequestId, row.row_version, JSON.stringify({ kind: 'change', itemIds: [hotelItem],
        changeSummary: 'Synthetic change summary, resubmitted', reason: REASON }), rid()]);
      expect((await h.crRow(mine.changeRequestId)).status).toBe('returned');
      // Sent again (the same version) - Addendum O2.
      await h.submitChange(mine.changeRequestId, [hotelItem]);
      expect((await h.crRow(mine.changeRequestId)).status).toBe('requested');
      await h.decideChange(mine.changeRequestId, 'approve', MANAGER_J2);
      expect((await h.crRow(mine.changeRequestId)).status).toBe('approved');
      await h.refusedToken(MANAGER_J2, SQLB.crDecide, [mine.changeRequestId, 'approve', null, (await h.crRow(mine.changeRequestId)).row_version, rid()],
        'wrong_state', undefined, '55000');
      expect((await h.audits('booking.change_returned')).length).toBe(1);
      expect((await h.audits('booking.change_approved')).length).toBe(1);
    });
  });
});

describe('10.3 change version and submit', () => {
  it('the change version opens only under an approved request; open is idempotent; booking_confirm refuses it (use_change_flow)', async () => {
    await asOwner(db, async () => {
      const { hotelItem } = await h.committedDeal();
      const cr = await h.requestChange({ itemIds: [hotelItem] });
      // Addendum O2: the version opens while the request is drafted; nothing to approve before it is sent.
      await h.refusedToken(MANAGER, SQLB.crDecide, [cr.changeRequestId, 'approve', null, cr.rowVersion, rid()], 'wrong_state', undefined, '55000');
      const v = await h.openChange(cr.changeRequestId);
      const again = await h.openChange(cr.changeRequestId);
      expect(again.versionId).toBe(v.versionId);
      expect(again.outcome).toBe('existing');
      const [ver] = await owner<{ change_request_id: string; revises_version_id: string | null; status: string }>(
        'select change_request_id, revises_version_id, status from public.booking_versions where id = $1', [v.versionId]);
      expect(ver).toMatchObject({ change_request_id: cr.changeRequestId, status: 'draft' });
      expect(ver!.revises_version_id).not.toBeNull();
      const rv = await h.editHotel(hotelItem, v.versionId, v.rowVersion);
      void rv;
      const ready = await h.readiness(OWNER, v.versionId);
      expect(ready.issues, 'no customer_acceptance_required for a change version').not.toContain('customer_acceptance_required');
      await h.refusedToken(OWNER, SQLB.bookingConfirm, [v.versionId, ready.contentHash], 'use_change_flow');
      // The ordinary return-and-revise path refuses while the change version exists.
      expect((await h.attempt(OWNER, SQLB.openRevision, [v.versionId])).ok).toBe(false);
    });
  });

  it('submit refuses a changed service outside the request (change_outside_request 22023, hint item numbers) and a stale list (version_changed)', async () => {
    await asOwner(db, async () => {
      const { b, hotelItem } = await h.committedDeal();
      const cr = await h.requestChange({ itemIds: [hotelItem] });
      const v = await h.openChange(cr.changeRequestId);
      let rv = await h.editHotel(hotelItem, v.versionId, v.rowVersion);
      rv = (await one<{ rowVersion: number }>(OWNER, SQLB.itemSave, [b.itemIds[1], v.versionId, rv, JSON.stringify({ ...TRANSFER_ITEM.facts as object,
        vehicleType: 'SUV' }), '8000000'])).rowVersion;
      const ready = await h.readiness(OWNER, v.versionId);
      await h.refusedToken(OWNER, SQLB.crSubmit, [cr.changeRequestId, ready.contentHash, [hotelItem, b.itemIds[1]], rid()], 'change_outside_request', /2/);
      await h.refusedToken(OWNER, SQLB.crSubmit, [cr.changeRequestId, ready.contentHash, [hotelItem], rid()], 'change_outside_request', /2/);
      // Put the transfer back: a list different from what changed is version_changed.
      rv = (await one<{ rowVersion: number }>(OWNER, SQLB.itemSave, [b.itemIds[1], v.versionId, rv, JSON.stringify(TRANSFER_ITEM.facts), '8000000'])).rowVersion;
      void rv;
      const ready2 = await h.readiness(OWNER, v.versionId);
      await h.refusedToken(OWNER, SQLB.crSubmit, [cr.changeRequestId, ready2.contentHash, [hotelItem, b.itemIds[1]], rid()], 'version_changed', undefined,
        CONFLICT_STATE);
      await h.refusedToken(OWNER, SQLB.crSubmit, [cr.changeRequestId, 'f'.repeat(64), [hotelItem], rid()], 'version_changed', undefined, CONFLICT_STATE);
    });
  });

  it('reconfirmation rows only for changed Purchase tasks that are supplier-confirmed; status submitted; payments refused change_in_progress', async () => {
    await asOwner(db, async () => {
      const { b, hotelItem, hotelTask } = await h.committedDeal();
      const { cr } = await h.submittedChange(hotelItem, {
        itemIds: [hotelItem, b.itemIds[1]!],
        edit: async (versionId, rv) => {
          const next = await h.editHotel(hotelItem, versionId, rv);
          return (await one<{ rowVersion: number }>(OWNER, SQLB.itemSave, [b.itemIds[1], versionId, next, JSON.stringify({
            ...TRANSFER_ITEM.facts as object, vehicleType: 'SUV' }), '8000000'])).rowVersion;
        },
      });
      expect((await h.crRow(cr.changeRequestId)).status).toBe('approved');  // Addendum O2: approved = waiting for the suppliers
      const rows = await h.reconfirmations(cr.changeRequestId);
      expect(rows.map((r) => [r.task_id, r.status])).toEqual([[hotelTask, 'pending']]);
      const [audit] = await h.audits('booking.change_submitted');
      expect(audit!.details).toMatchObject({ changeRequestId: cr.changeRequestId });
      // While pending: a new supplier payment request for the task is refused.
      const r = await h.attempt(PURCHASE, 'select public.supplier_payment_request_create($1, $2::jsonb, $3) as r', [hotelTask, JSON.stringify({
        expectedCostVersionNo: await h.agreedCostVersion(hotelTask), part: 'deposit', amountPaise: '100000', dueDate: null, note: null,
        proformaEvidenceId: await h.moneyFile(PURCHASE, hotelTask, 'proforma'), askFunding: false }), rid()]);
      expect(r).toMatchObject({ ok: false, error: 'change_in_progress', code: '55000' });
    });
  });

  it('a change with no confirmed Purchase service needs no reconfirmation and is applied at once', async () => {
    await asOwner(db, async () => {
      const { b } = await h.committedDeal();
      const transfer = b.itemIds[1]!;
      const { cr, versionId } = await h.submittedChange(transfer, {
        itemIds: [transfer],
        edit: async (v, rv) => (await one<{ rowVersion: number }>(OWNER, SQLB.itemSave, [transfer, v, rv, JSON.stringify({ ...TRANSFER_ITEM.facts as object,
          vehicleType: 'SUV' }), '8000000'])).rowVersion,
      });
      expect((await h.crRow(cr.changeRequestId)).status).toBe('applied');
      expect(await h.reconfirmations(cr.changeRequestId)).toEqual([]);
      const [v] = await owner<{ status: string }>('select status from public.booking_versions where id = $1', [versionId]);
      expect(v!.status).toBe('confirmed');
    });
  });
});

describe('10.3 / 10.4 reconfirmation and apply', () => {
  it('G7 within budget applies: base superseded, review approved by change request, two committed costs, history, dues, go-ahead, audit', async () => {
    await asOwner(db, async () => {
      const { b, hotelItem, hotelTask } = await h.committedDeal();
      const { cr, versionId } = await h.submittedChange(hotelItem);
      const [reconf] = await h.reconfirmations(cr.changeRequestId);
      // Only the task's Purchase assignee records.
      await h.refused(MANAGER, SQLB.reconfirmRecord, [reconf!.id, reconf!.row_version, JSON.stringify({ newRatePaise: '12000000', supplierFeePaise: '0',
        newReference: 'SYN-CONF-0002', evidenceId: null, note: null }), rid()], 'not_authorized', '42501');
      await h.refusedToken(PURCHASE, SQLB.reconfirmRecord, [reconf!.id, reconf!.row_version, JSON.stringify({ newRatePaise: '12000000',
        supplierFeePaise: '0', newReference: 'SYN-CONF-0002', evidenceId: null, note: null }), rid()], 'evidence_missing', undefined, '55000');
      await h.recordReconfirm(reconf!.id, hotelTask, { newRatePaise: '12000000', supplierFeePaise: '500000' });
      expect((await h.crRow(cr.changeRequestId)).status).toBe('applied');
      expect((await h.reconfirmations(cr.changeRequestId))[0]!.status).toBe('applied');
      // 1. Base superseded; change version confirmed and frozen; acceptance from the base.
      const versions = await owner<{ id: string; status: string; acceptance_from_version_id: string | null }>(
        'select id, status, acceptance_from_version_id from public.booking_versions where id = any ($1::uuid[]) order by version_no', [[b.versionId, versionId]]);
      expect(versions.map((v) => v.status)).toEqual(['superseded', 'confirmed']);
      expect(versions[1]!.acceptance_from_version_id).toBe(b.versionId);
      // 2. Accounts review of the new version: approved by the change request, no Accounts reviewer.
      const [review] = await owner<{ status: string; approval_source: string; change_request_id: string; reviewed_by: string | null;
        last_approved_at: string | null }>('select status, approval_source, change_request_id, reviewed_by, last_approved_at from public.accounts_booking_reviews where booking_version_id = $1',
      [versionId]);
      expect(review).toMatchObject({ status: 'approved', approval_source: 'change_request', change_request_id: cr.changeRequestId, reviewed_by: null });
      expect(review!.last_approved_at).not.toBeNull();
      // 3. Cost history: two committed rows, confirmation numbers 1 and 2; amount = rate + fee; change fee kept apart.
      const committed = await owner<{ confirmation_no: number; amount_paise: string; change_fee_paise: string | null }>(
        `select confirmation_no, amount_paise::text, change_fee_paise::text from public.purchase_cost_versions where task_id = $1 and stage = 'committed'
         order by confirmation_no`, [hotelTask]);
      expect(committed.map((c) => c.confirmation_no)).toEqual([1, 2]);
      expect(committed[1]).toMatchObject({ amount_paise: '12500000', change_fee_paise: '500000' });
      const confirmations = await owner<{ confirmation_no: number; supplier_reference: string; change_request_id: string | null; booking_version_id: string }>(
        'select confirmation_no, supplier_reference, change_request_id, booking_version_id from public.task_confirmations where task_id = $1 order by confirmation_no',
        [hotelTask]);
      expect(confirmations).toEqual([
        { confirmation_no: 1, supplier_reference: 'SYN-CONF-0001', change_request_id: null, booking_version_id: b.versionId },
        { confirmation_no: 2, supplier_reference: 'SYN-CONF-0002', change_request_id: cr.changeRequestId, booking_version_id: versionId },
      ]);
      const task = await h.taskRow(hotelTask);
      expect(task).toMatchObject({ status: 'supplier_confirmed', supplier_reference: 'SYN-CONF-0002' });
      // Dues follow the new version without an Accounts step.
      const dues = await one<{ totalPaise: string; basis: { versionNo: number; kind: string } }>(ACC, SQLB.dealDues, [DEAL]);
      expect(dues.totalPaise).toBe(NEW_SELLING);
      expect(dues.basis.kind).toBe('approved');
      // The go-ahead check passes for the task's current version (LD24).
      expect(await scalar<boolean>(SQLB.goAheadValid, [hotelTask])).toBe(true);
      // 5. Audit and outbox.
      const [applied] = await h.audits('booking.change_applied');
      expect(applied!.details).toMatchObject({ changeRequestId: cr.changeRequestId, versionId, baseVersionId: b.versionId });
      expect((applied!.details as { taskIds: string[] }).taskIds).toContain(hotelTask);
      const [out] = await owner<{ n: number }>(`select count(*)::int as n from public.outbox_events where event_type = 'booking.version_revised'
        and payload::text like '%' || $1 || '%'`, [versionId]);
      expect(out!.n).toBeGreaterThanOrEqual(1);
      expect(text(await h.audits('purchase.reconfirm_recorded'))).not.toContain('12000000');
      expect(await scalar<boolean>(SQLB.changeOpen, [DEAL])).toBe(false);
    });
  });

  it('over budget -> waits; Approver (not the recorder) approves the cost -> applied with a cost approval bound to the new version', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal();
      const { cr, versionId } = await h.submittedChange(hotelItem);
      const [reconf] = await h.reconfirmations(cr.changeRequestId);
      await h.recordReconfirm(reconf!.id, hotelTask, { newRatePaise: '19800000', supplierFeePaise: '500000' });
      const recorded = (await h.reconfirmations(cr.changeRequestId))[0]!;
      expect(recorded).toMatchObject({ status: 'recorded', over_budget: true });
      expect((await h.crRow(cr.changeRequestId)).status).toBe('approved');
      await h.refused(PURCHASE, SQLB.reconfirmApprove, [reconf!.id, recorded.row_version, rid()], 'not_authorized', '42501');
      await h.refused(OWNER, SQLB.reconfirmApprove, [reconf!.id, recorded.row_version, rid()], 'not_authorized', '42501');
      await one(MANAGER, SQLB.reconfirmApprove, [reconf!.id, recorded.row_version, rid()]);
      expect((await h.crRow(cr.changeRequestId)).status).toBe('applied');
      const approvals = await owner<{ booking_version_id: string; reconfirmation_id: string; approved_by: string }>(
        'select booking_version_id, reconfirmation_id, approved_by from public.purchase_cost_approvals where task_id = $1 and reconfirmation_id is not null',
        [hotelTask]);
      expect(approvals).toEqual([{ booking_version_id: versionId, reconfirmation_id: reconf!.id, approved_by: U.managerDelhi }]);
      // Addendum L7: the approval is stored on the agreed (proposed) cost version, bound to the change version by 10.1.
      expect(await scalar<boolean>(SQLB.costApproved, [hotelTask, await h.agreedCostVersion(hotelTask)])).toBe(true);
      expect((await h.audits('purchase.reconfirm_over_budget_approved')).length).toBe(1);
    });
  });

  it('a record is refused payment_in_progress while a live supplier payment request exists on the task', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal();
      await h.payRequest(hotelTask, 1_000_000);
      const { cr } = await h.submittedChange(hotelItem);
      const [reconf] = await h.reconfirmations(cr.changeRequestId);
      const evidenceId = await h.reconfirmProof(hotelTask);
      await h.refusedToken(PURCHASE, SQLB.reconfirmRecord, [reconf!.id, reconf!.row_version, JSON.stringify({ newRatePaise: '12000000',
        supplierFeePaise: '0', newReference: 'SYN-CONF-0002', evidenceId, note: null }), rid()], 'payment_in_progress', undefined, '55000');
    });
  });

  it('paid more than the new cost -> a supplier refund is expected (source reconfirmation); a later payment sees the new agreed cost', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal();
      // Customer money first, so the supplier payment needs no company funding (Phase 1 rule).
      await h.receipt(DEAL, '5000000');
      const paid = await h.payRequest(hotelTask, 4_000_000);
      await h.payThrough(paid.id, 'verified');
      const { cr } = await h.submittedChange(hotelItem);
      const [reconf] = await h.reconfirmations(cr.changeRequestId);
      await h.recordReconfirm(reconf!.id, hotelTask, { newRatePaise: '3000000', supplierFeePaise: '0' });
      expect((await h.crRow(cr.changeRequestId)).status).toBe('applied');
      const due = await one<unknown>(ACC, SQLB.refundsDue, ['{}', null, 50]);
      // ASSUMPTION: the expected supplier refund is listed by supplier_refunds_due with the change request and amount 40,000.00 - 30,000.00.
      expect(text(due)).toContain(cr.changeRequestId);
      expect(text(due)).toContain('1000000');
      // Purchase never sees selling data in the reconfirmation read.
      const view = await one<unknown>(PURCHASE, SQLB.reconfirmGet, [hotelTask]);
      expect(text(view)).not.toContain(NEW_SELLING);
    });
  });

  it('G9 supplier refuses -> nothing changed: task, costs, confirmations, versions, dues and bills identical; other rows void; not_possible', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal();
      const before = await h.snapshot(hotelTask);
      const { cr, versionId } = await h.submittedChange(hotelItem);
      const [reconf] = await h.reconfirmations(cr.changeRequestId);
      await h.refusedHint(PURCHASE, SQLB.reconfirmRefuse, [reconf!.id, reconf!.row_version, 'short', rid()], 'invalid_input', /reason/, '22023');
      await one(PURCHASE, SQLB.reconfirmRefuse, [reconf!.id, reconf!.row_version, REASON, rid()]);
      expect(await h.snapshot(hotelTask)).toEqual(before);
      const req = await h.crRow(cr.changeRequestId);
      expect(req.status).toBe('not_possible');
      expect((await h.reconfirmations(cr.changeRequestId))[0]!.status).toBe('refused');
      const [v] = await owner<{ status: string }>('select status from public.booking_versions where id = $1', [versionId]);
      expect(v!.status).toBe('discarded');
      expect((await h.audits('purchase.reconfirm_refused')).length).toBe(1);
      expect((await h.audits('booking.change_not_possible')).length).toBe(1);
      expect(await scalar<boolean>(SQLB.changeOpen, [DEAL])).toBe(false);
    });
  });

  it('with two suppliers, one refusal voids the other recorded reconfirmation', async () => {
    await asOwner(db, async () => {
      const { b, hotelItem, hotelTask } = await h.committedDeal([{ ...HOTEL_ITEM, facts: { ...HOTEL, hotelName: 'Synthetic Second Hotel' } }]);
      const secondTask = h.taskOf(b, 'hotel', 1);
      await h.supplierConfirmed(secondTask);
      const second = b.itemIds[1]!;
      const { cr } = await h.submittedChange(hotelItem, {
        itemIds: [hotelItem, second],
        edit: async (v, rv) => h.editHotel(second, v, await h.editHotel(hotelItem, v, rv), { hotelName: 'Synthetic Second Hotel', roomType: 'Synthetic Suite' }),
      });
      const rows = await h.reconfirmations(cr.changeRequestId);
      expect(rows.length).toBe(2);
      const first = rows.find((r) => r.task_id === hotelTask)!;
      const other = rows.find((r) => r.task_id === secondTask)!;
      await h.recordReconfirm(first.id, hotelTask, { newRatePaise: '19900000', supplierFeePaise: '500000' });
      await one(PURCHASE, SQLB.reconfirmRefuse, [other.id, await h.reconfRv(other.id), REASON, rid()]);
      const after = await h.reconfirmations(cr.changeRequestId);
      expect(after.find((r) => r.id === first.id)!.status).toBe('void');
      expect(after.find((r) => r.id === other.id)!.status).toBe('refused');
    });
  });

  it('G3 withdraw after a recorded reconfirmation voids it and discards the change version', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal();
      const before = await h.snapshot(hotelTask);
      const { cr, versionId } = await h.submittedChange(hotelItem);
      const [reconf] = await h.reconfirmations(cr.changeRequestId);
      await h.recordReconfirm(reconf!.id, hotelTask, { newRatePaise: '19900000', supplierFeePaise: '500000' });
      expect((await h.reconfirmations(cr.changeRequestId))[0]!.status).toBe('recorded');
      await h.refused(PURCHASE, SQLB.crWithdraw, [cr.changeRequestId, (await h.crRow(cr.changeRequestId)).row_version, REASON, rid()], 'not_authorized', '42501');
      await one(OWNER, SQLB.crWithdraw, [cr.changeRequestId, (await h.crRow(cr.changeRequestId)).row_version, REASON, rid()]);
      expect((await h.crRow(cr.changeRequestId)).status).toBe('withdrawn');
      expect((await h.reconfirmations(cr.changeRequestId))[0]!.status).toBe('void');
      const [v] = await owner<{ status: string }>('select status from public.booking_versions where id = $1', [versionId]);
      expect(v!.status).toBe('discarded');
      expect(await h.snapshot(hotelTask)).toEqual(before);
      expect((await h.audits('booking.change_withdrawn')).length).toBe(1);
    });
  });

  it('apply drafts a replacement bill (track B) and queues booking_changed once per channel (track A)', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal([TRANSFER_ITEM], { changes: false });
      await h.docsOn();
      await h.autoBills(true, true);
      await h.messagesOn(['booking_changed']);
      await h.changesOn();
      // A released Invoice exists for the approved basis (manual Phase 2 path keeps the test independent of track B's triggers).
      const docsBefore = await h.documents();
      const invoice = docsBefore.find((d) => d.kind === 'invoice' && d.status === 'released');
      const { cr } = await h.submittedChange(hotelItem);
      const [reconf] = await h.reconfirmations(cr.changeRequestId);
      await h.recordReconfirm(reconf!.id, hotelTask, { newRatePaise: '12000000', supplierFeePaise: '0' });
      const docs = await h.documents();
      if (invoice) {
        const replacement = docs.find((d) => d.replaces_document_id === invoice.id);
        expect(replacement, 'replacement Invoice drafted').toBeDefined();
        expect(replacement!.auto_rule).toBe('inv_replace_on_change');
        expect(docs.find((d) => d.id === invoice.id)!.status, 'old bill stays released until the new one is released').toMatch(/^(released|replaced)$/);
      }
      // The synthetic Deal is a test Deal: one skipped row per channel, once (5.5 order: test_deal first).
      const msgs = (await h.messages(DEAL, 'booking_changed')).filter((m) => m.event_key === `cr:${cr.changeRequestId}`);
      expect(msgs.map((m) => m.channel).sort()).toEqual(['email', 'whatsapp']);
      expect(msgs.every((m) => m.status === 'skipped' && m.skip_reason === 'test_deal')).toBe(true);
    });
  });
});

describe('10.5 reads and fences', () => {
  it('deal_change_requests: SO, branch M, A read; P, F, V, other Sales, other entity null; never costs', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal();
      const { cr } = await h.submittedChange(hotelItem);
      await h.addFlightPeople();
      const so = await one<Record<string, unknown>>(OWNER, SQLB.dealChanges, [DEAL]);
      expect(so).toMatchObject({ dealId: DEAL, enabled: true });
      const req = (so.requests as Array<Record<string, unknown>>).find((r) => r.id === cr.changeRequestId)!;
      expect(req).toMatchObject({ kind: 'change', status: 'approved' });
      expect(text(req.reconfirmations)).toContain(hotelTask);
      // supplierName and reference are for M and A only.
      expect(text(so)).not.toContain('SYN-CONF-0001');
      expect(text(await one(MANAGER, SQLB.dealChanges, [DEAL]))).toContain('SYN-CONF-0001');
      for (const actor of [MANAGER, ACC] as Actor[]) expect(await h.readOrNull(actor, SQLB.dealChanges, [DEAL])).not.toBeNull();
      for (const actor of [PURCHASE, FLIGHT, VISA, SALES_B, OTHER_ENTITY] as Actor[]) {
        expect(await h.readOrNull(actor, SQLB.dealChanges, [DEAL]), `fenced ${actor.userId}`).toBeNull();
      }
      for (const actor of [OWNER, MANAGER, ACC] as Actor[]) {
        const t = text(await one(actor, SQLB.dealChanges, [DEAL]));
        expect(t, 'costs and rates never in R-G1').not.toMatch(/"(amountPaise|ratePaise|newRatePaise|costPaise)"/);
        expect(t).not.toContain('10000000');
      }
    });
  });

  it('change_requests_list: M preset to_approve, SO own Deals, A read-only; others null', async () => {
    await asOwner(db, async () => {
      const { hotelItem } = await h.committedDeal();
      const cr = await h.requestChange({ itemIds: [hotelItem] });
      await h.sendChange(cr.changeRequestId, hotelItem);  // Addendum O2: to approve once sent
      const m = await one<{ items: Array<{ id: string }> }>(MANAGER, SQLB.changesList, [JSON.stringify({ preset: 'to_approve' }), null, 50]);
      expect(m.items.map((r) => r.id)).toContain(cr.changeRequestId);
      const so = await one<{ items: Array<{ id: string }> }>(OWNER, SQLB.changesList, ['{}', null, 50]);
      expect(so.items.map((r) => r.id)).toContain(cr.changeRequestId);
      const other = await h.readOrNull<{ items: Array<{ id: string }> }>(SALES_B, SQLB.changesList, ['{}', null, 50]);
      expect(other === null || !other.items.some((r) => r.id === cr.changeRequestId)).toBe(true);
      expect(await h.readOrNull(ACC, SQLB.changesList, ['{}', null, 50])).not.toBeNull();
      expect(await h.readOrNull(PURCHASE, SQLB.changesList, ['{}', null, 50])).toBeNull();
    });
  });

  it('task_reconfirmation_get: the task\'s Purchase reader and M; never a selling price; Sales null', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal();
      await h.submittedChange(hotelItem);
      const r = await one<Record<string, unknown>>(PURCHASE, SQLB.reconfirmGet, [hotelTask]);
      expect(r).toMatchObject({ taskId: hotelTask });
      expect(r.reconfirmation).toMatchObject({ status: 'pending' });
      expect(r.can).toMatchObject({ record: true, refuse: true });
      expect(text(r)).not.toContain(NEW_SELLING);
      expect(text(r)).not.toContain(SELLING);
      expect(await h.readOrNull(MANAGER, SQLB.reconfirmGet, [hotelTask])).not.toBeNull();
      for (const actor of [OWNER, SALES_B, VISA, OTHER_ENTITY] as Actor[]) {
        expect(await h.readOrNull(actor, SQLB.reconfirmGet, [hotelTask]), `fenced ${actor.userId}`).toBeNull();
      }
    });
  });

  it('deal_change_history: versions and confirmations in time order; amounts for M and A only; Purchase own tasks only; SO without supplier costs', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal();
      const { cr } = await h.submittedChange(hotelItem);
      const [reconf] = await h.reconfirmations(cr.changeRequestId);
      await h.recordReconfirm(reconf!.id, hotelTask, { newRatePaise: '12000000', supplierFeePaise: '500000' });
      const m = await one<{ versions: Array<Record<string, unknown>>; confirmations: Array<Record<string, unknown>> }>(MANAGER, SQLB.changeHistory, [DEAL]);
      expect(m.versions.length).toBeGreaterThanOrEqual(2);
      expect(m.confirmations.map((c) => c.confirmationNo)).toEqual([1, 2]);
      expect(m.confirmations[1]).toMatchObject({ amountPaise: '12500000', changeFeePaise: '500000', reference: 'SYN-CONF-0002' });
      expect(text(m.versions)).toContain(cr.refNo!);
      const so = await one<{ confirmations: Array<Record<string, unknown>> }>(OWNER, SQLB.changeHistory, [DEAL]);
      expect(text(so)).not.toMatch(/"(amountPaise|changeFeePaise)"/);
      const p = await one<Record<string, unknown>>(PURCHASE, SQLB.changeHistory, [DEAL]);
      expect(text(p)).not.toContain(NEW_SELLING);
      expect(text(p)).not.toContain(SELLING);
      await h.addFlightPeople();
      for (const actor of [FLIGHT, VISA, OTHER_ENTITY] as Actor[]) {
        expect(await h.readOrNull(actor, SQLB.changeHistory, [DEAL]), `fenced ${actor.userId}`).toBeNull();
      }
    });
  });
});

describe('17.2 switches and grants', () => {
  it('G1 admin_set_booking_changes_enabled: Super Admin only, audited; booking_change_apply is internal (no grant)', async () => {
    await asOwner(db, async () => {
      await h.people();
      await h.refused(MANAGER, SQLB.setChanges, [true, REASON], 'not_authorized', '42501');
      await h.changesOn();
      const [audit] = (await h.audits('settings.booking_changes_changed')).slice(-1);
      expect(audit!.reason).toBe(REASON);
      for (const sig of await h.signatures('authz', 'booking_change_apply')) {
        expect(await h.canExecute('authenticated', sig)).toBe(false);
        expect(await h.canExecute('service_role', sig)).toBe(false);
      }
    });
  });
});
