import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, istBusinessDate } from '../helpers/db';
import { BILLING, CHECKLIST_SQL, CONTACT, HOTEL, TRAVELLERS, TRIP } from './b1-support';
import { FORM_SQL } from './b11-support';
import { ACC, DEAL, DEAL2, FLIGHT, FLIGHT_2, LEG_JDH_DEL, MANAGER, OWNER, SALES_B, SELLING, SQL, type FlightItem, fare, flightHelpers, rid, ticketFor, typedFlight } from './flight-support';

/**
 * Accounts phase, track A smoke checks (contract section 5, Phase 0):
 *   5.1 flight-only bookings need no adult ID proof (readiness, checklist,
 *       booking_form_get.idProofRequired, traveller_id_proofs_for_task);
 *   5.2 accounts_review_return refused after commitment or issued tickets
 *       (review_return_committed), canReturn / returnBlock;
 *   5.3 a pending Flight payment request cancelled by its requester or the
 *       current cost-task owner (canceller), canCancel, audit byTaskOwner.
 * Synthetic data only; every scenario rolls back. Track E owns the full suites.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = flightHelpers(() => db);
const { one, owner, refused } = h;
const TASK_PROOFS = 'select public.traveller_id_proofs_for_task($1) as r';
const DETAIL = 'select public.accounts_deal_detail($1) as r';
const CANCEL = 'select public.supplier_payment_request_cancel($1, $2, $3) as r';
const REASON = 'Synthetic return: please check the booking';

type Checklist = { items: Array<{ code: string; blocking: boolean }>; canConfirm: boolean };

/** A draft on `deal` with the given items and every B1.1 step done, but no ID proofs stored. */
async function draftWithoutProofs(items: FlightItem[], deal = DEAL, actor = OWNER) {
  await h.setSwitch('service_items_enabled', true);
  const opened = await h.openDraft(actor, deal);
  let rv = opened.rowVersion;
  for (const item of items) rv = (await h.addItem(actor, opened.versionId, rv, item.type, item.facts, item.budget ?? '2800000')).rowVersion;
  rv = (await h.saveTravellers(actor, deal, rv, TRAVELLERS)).rowVersion;
  rv = (await h.saveSelling(actor, opened.versionId, rv, SELLING)).rowVersion;
  rv = (await one<{ rowVersion: number }>(actor, 'select public.booking_trip_save($1, $2, $3::jsonb) as r', [opened.versionId, rv, JSON.stringify(TRIP)])).rowVersion;
  const billingRow = await owner<{ row_version: number }>('select row_version from public.customer_billing_profiles where deal_id = $1', [deal]);
  rv = (await one<{ rowVersion: number }>(actor, 'select public.booking_customer_save($1, $2, $3::jsonb, $4::jsonb, $5, $6) as r',
    [opened.versionId, rv, JSON.stringify(CONTACT), billingRow.length ? null : JSON.stringify(BILLING), 0, rid()])).rowVersion;
  const seqs = (await owner<{ seq: number }>('select seq from public.deal_travellers where deal_id = $1 order by seq', [deal])).map((t) => t.seq);
  const rows = await owner<{ id: string }>(
    `select i.id from public.service_items i join public.service_item_facts f on f.service_item_id = i.id
     where f.booking_version_id = $1 order by i.item_no`, [opened.versionId]);
  for (const row of rows) {
    rv = (await one<{ rowVersion: number }>(actor, SQL.participants, [row.id, opened.versionId, rv, seqs])).rowVersion;
  }
  rv = (await one<{ rowVersion: number }>(actor, 'select public.booking_instalments_save($1, $2, $3::jsonb) as r',
    [opened.versionId, rv, JSON.stringify([{ seq: 1, label: 'Full payment', amountPaise: SELLING, dueDate: '2026-11-01' }])])).rowVersion;
  await h.storeEvidence(actor, opened.versionId);
  return { versionId: opened.versionId, rowVersion: rv };
}
const flightOnly = (versionId: string) => owner<{ f: boolean }>('select authz.version_flight_only($1) as f', [versionId]).then((r) => r[0]!.f);
const codes = (c: Checklist) => c.items.map((i) => i.code);

describe('5.1 flight-only ID rule', () => {
  it('a flight-only draft needs no adult ID proof; it confirms and its task says idProofRequired false', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      const d = await draftWithoutProofs([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]) }]);
      expect(await flightOnly(d.versionId)).toBe(true);
      const ready = await h.readiness(OWNER, d.versionId);
      expect(ready.issues).not.toContain('id_proof_missing');
      expect(ready.issues).toEqual([]);
      const list = await one<Checklist>(OWNER, CHECKLIST_SQL, [DEAL]);
      expect(codes(list)).not.toContain('id_proof_missing');
      expect(codes(list)).not.toContain('id_proof_missing_child');
      const form = await one<Record<string, unknown>>(OWNER, FORM_SQL, [DEAL]);
      expect(form.idProofRequired).toBe(false);
      // Uploads stay allowed on a flight-only booking.
      await h.storeIdProof(OWNER, DEAL, 1);
      await h.confirm(OWNER, d.versionId, (await h.readiness(OWNER, d.versionId)).contentHash);
      const [task] = await owner<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'flight'`, [DEAL]);
      await h.claim();
      const proofs = await one<{ idProofRequired: boolean; travellers: unknown[] }>(FLIGHT, TASK_PROOFS, [task!.id]);
      expect(proofs.idProofRequired).toBe(false);
    });
  });

  it('hotel + flight keeps the rule (blocking adult code, child warning, idProofRequired true)', async () => {
    await asOwner(db, async () => {
      const d = await draftWithoutProofs([{ type: 'hotel', facts: HOTEL, budget: '4500000' }, { type: 'flight', facts: typedFlight([LEG_JDH_DEL]) }]);
      expect(await flightOnly(d.versionId)).toBe(false);
      expect((await h.readiness(OWNER, d.versionId)).issues).toContain('id_proof_missing');
      const list = await one<Checklist>(OWNER, CHECKLIST_SQL, [DEAL]);
      expect(list.items.find((i) => i.code === 'id_proof_missing')?.blocking).toBe(true);
      expect(codes(list)).toContain('id_proof_missing_child');
      expect((await one<Record<string, unknown>>(OWNER, FORM_SQL, [DEAL])).idProofRequired).toBe(true);
    });
  });

  it('no version yet: idProofRequired true; the package task list says true', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      expect((await one<Record<string, unknown>>(SALES_B, FORM_SQL, [DEAL2])).idProofRequired).toBe(true);
      expect(await flightOnly(rid())).toBe(false);
      await h.addFlightPeople();
      await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]) }]);
      await h.claim();
      const [task] = await owner<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'flight'`, [DEAL]);
      expect((await one<{ idProofRequired: boolean }>(FLIGHT, TASK_PROOFS, [task!.id])).idProofRequired).toBe(true);
    });
  });
});

type Detail = { booking: { bookingVersionId: string; reviewStatus: string; canReturn: boolean; returnBlock: string | null } };

describe('5.2 Accounts return blocked after commitment', () => {
  it('flight tickets alone do not block (lead correction 0130); an exact replay answers; a completed flight task (committed) blocks', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      const b = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]), budget: '99999999' }]);
      expect((await one<Detail>(ACC, DETAIL, [DEAL])).booking).toMatchObject({ canReturn: true, returnBlock: null });
      // An earlier successful return (its exact retry is replayed below, after tickets).
      const req = rid();
      const first = await one<Record<string, unknown>>(ACC, SQL.reviewReturn, [b.versionId, REASON, req]);
      expect((await one<Detail>(ACC, DETAIL, [DEAL])).booking).toMatchObject({ reviewStatus: 'returned', canReturn: false, returnBlock: null });
      // Owner SQL: the review back to approved, then tickets.
      await owner(`update public.accounts_booking_reviews set status = 'approved' where booking_version_id = $1`, [b.versionId]);
      await h.claim();
      const [leg] = await h.sectors(b.flightTasks[0]!);
      const supplierId = await h.flightSupplier();
      await h.confirmTickets({ sectorIds: [leg!.id], supplierId, seqs: [1] });
      expect(await one(ACC, SQL.reviewReturn, [b.versionId, REASON, req])).toEqual({ ...first, outcome: 'existing' });
      // Tickets issued, Deal not committed: Return still offered and allowed (Flight's "Booking changed" flow follows).
      expect((await one<Detail>(ACC, DETAIL, [DEAL])).booking).toMatchObject({ canReturn: true, returnBlock: null });
      await one(ACC, SQL.reviewReturn, [b.versionId, REASON, rid()]);
      // A completed flight task commits the Deal (owner SQL, triggers off): refused 'committed'.
      await owner(`update public.accounts_booking_reviews set status = 'approved' where booking_version_id = $1`, [b.versionId]);
      await owner('set local session_replication_role = replica');
      await owner(`update public.fulfilment_tasks set status = 'completed', completed_by = assignee_user_id, completed_at = now() where id = $1`, [b.flightTasks[0]]);
      await owner('set local session_replication_role = origin');
      expect(await h.refusedHint(ACC, SQL.reviewReturn, [b.versionId, REASON, rid()], 'review_return_committed')).toBe('committed');
      expect((await one<Detail>(ACC, DETAIL, [DEAL])).booking).toMatchObject({ canReturn: false, returnBlock: 'committed' });
    });
  });

  it('a supplier-confirmed hotel task: return refused (committed)', async () => {
    await asOwner(db, async () => {
      const b = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]) }]);
      const [hotel] = await owner<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'purchase'`, [DEAL]);
      await owner('set local session_replication_role = replica');
      await owner(`update public.fulfilment_tasks set status = 'supplier_confirmed', assignee_user_id = $2, selected_quote_id = gen_random_uuid(),
        supplier_reference = 'SYN-REF', supplier_confirmed_by = $2, supplier_confirmed_at = now() where id = $1`, [hotel!.id, U.purchaseJodhpur]);
      await owner('set local session_replication_role = origin');
      expect(await h.refusedHint(ACC, SQL.reviewReturn, [b.versionId, REASON, rid()], 'review_return_committed')).toBe('committed');
      expect((await one<Detail>(ACC, DETAIL, [DEAL])).booking).toMatchObject({ canReturn: false, returnBlock: 'committed' });
      expect((await owner<{ status: string }>('select coalesce((select status from public.accounts_booking_reviews where booking_version_id = $1), $2) as status',
        [b.versionId, 'pending']))[0]!.status).toBe('pending');
    });
  });
});

type Money = { batches: Array<{ batchId: string; payment: Record<string, unknown> }> };

describe('5.3 Flight cancel by requester or current cost-task owner', () => {
  async function pendingRequest() {
    await h.addFlightPeople();
    await h.addRole(U.salesDelhiB, 'flight');
    const b = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]), budget: '99999999' }]);
    await h.claim();
    const [leg] = await h.sectors(b.flightTasks[0]!);
    const supplierId = await h.flightSupplier();
    await h.approvedBank(supplierId);
    const batch = await one<{ batchId: string }>(FLIGHT, SQL.ticketsConfirm, [DEAL, JSON.stringify({ sectorIds: [leg!.id], supplierId, fareApprovalId: null,
      fares: [fare('adult', { basicPaise: '1900000' })], travellers: [ticketFor(1)] }), rid()]);
    await one(FLIGHT, SQL.paymentRequest, [batch.batchId, JSON.stringify({ dueDate: istBusinessDate(), note: null, proformaEvidenceId: null }), rid()]);
    return batch.batchId;
  }
  const payment = async (actor: typeof FLIGHT, batchId: string) =>
    (await one<Money>(actor, SQL.money, [DEAL])).batches.find((x) => x.batchId === batchId)!.payment;

  it('the requester cancels; canCancel true for them', async () => {
    await asOwner(db, async () => {
      const batchId = await pendingRequest();
      expect(await payment(FLIGHT, batchId)).toMatchObject({ state: 'request_pending', canCancel: true });
      const p = (await h.paymentOf(batchId))!;
      const r = await one<{ status: string }>(FLIGHT, CANCEL, [p.id, p.row_version, rid()]);
      expect(r.status).toBe('cancelled');
      const [audit] = await owner<{ details: { byTaskOwner: boolean } }>(`select details from public.audit_events where action = 'flight.payment_cancelled' order by id desc limit 1`);
      expect(audit!.details.byTaskOwner).toBe(false);
    });
  });

  it('after reassignment the new cost-task owner (not the requester) cancels; another Flight person is refused', async () => {
    await asOwner(db, async () => {
      const batchId = await pendingRequest();
      await one(MANAGER, SQL.groupReassign, [DEAL, U.movedStaff, U.salesAhmedabad, 'Synthetic: covering for leave', rid()]);
      expect(await payment(FLIGHT_2, batchId)).toMatchObject({ state: 'request_pending', canCancel: true });
      // 0130: the requester (no longer assigned) still gets the cancel action; another Flight person does not.
      const pending = (await h.paymentOf(batchId))!;
      expect(await payment(FLIGHT, batchId)).toMatchObject({ canCancel: true, paymentId: pending.id, paymentRowVersion: pending.row_version });
      expect(await payment({ userId: U.salesDelhiB }, batchId)).not.toHaveProperty('canCancel');
      const p = (await h.paymentOf(batchId))!;
      await refused({ userId: U.salesDelhiB }, CANCEL, [p.id, p.row_version, rid()], 'not_authorized', '42501');
      const r = await one<{ status: string }>(FLIGHT_2, CANCEL, [p.id, p.row_version, rid()]);
      expect(r.status).toBe('cancelled');
      const [audit] = await owner<{ details: { byTaskOwner: boolean } }>(`select details from public.audit_events where action = 'flight.payment_cancelled' order by id desc limit 1`);
      expect(audit!.details.byTaskOwner).toBe(true);
      await refused(FLIGHT_2, CANCEL, [p.id, p.row_version + 1, rid()], 'already_decided', '55000');
    });
  });
});
