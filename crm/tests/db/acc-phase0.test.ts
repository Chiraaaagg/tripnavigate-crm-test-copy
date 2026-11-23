import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, istBusinessDate } from '../helpers/db';
import { LEG_GOI_JDH, screenshotFlight, typedFlight } from './flight-support';
import {
  ACC, DEAL, DEAL2, FLIGHT, FLIGHT_2, FLIGHT_ITEM, HOTEL_ITEM, MANAGER, OWNER, PASSPORT_ITEM, PURCHASE, SQL, TRANSFER_ITEM,
  VISA_ITEM, accHelpers, rid,
} from './acc-support';
import { CONFLICT_STATE } from '../helpers/sqlstates';

/**
 * Accounts phase contract, Phase 0 (sections 4.1, 4.2, 5, 12.1), Track E.
 * Written from the contract, not from Track A's migrations
 * 20261203000100..0199:
 *   - 5.1 flight-only bookings need no adult ID proof (readiness, checklist,
 *     booking_form_get.idProofRequired, traveller_id_proofs_for_task); every
 *     other mix keeps today's rule (adult blocks, child warns, AL2).
 *   - 5.2 accounts_review_return refused `review_return_committed` (55000,
 *     hint committed) once a supplier confirmed or a non-visa task completed
 *     (lead change 10 Nov: issued Flight tickets alone no longer block); a
 *     completed visa task never blocks; an exact retry of an earlier successful return replays;
 *     accounts_deal_detail.booking.canReturn / returnBlock.
 *   - 5.3 a pending Flight payment request is cancelled by its requester or
 *     the current cost-task owner (audit byTaskOwner); Purchase requests stay
 *     requester-only (AL4); flight_money payment.canCancel.
 * Concurrency of the return block (real Postgres) is in acc-concurrency.test.ts.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = accHelpers(() => db);
const { one, owner, refused, refusedHint } = h;

type Checklist = { items: Array<{ code: string; blocking: boolean; travellerSeqs?: number[] }>; canConfirm: boolean };
const checklist = (deal = DEAL) => one<Checklist>(OWNER, SQL.checklist, [deal]);
const codes = async (deal = DEAL) => (await checklist(deal)).items.map((i) => i.code);
const formRequired = async (deal = DEAL) => (await one<{ idProofRequired: boolean }>(OWNER, SQL.formGet, [deal])).idProofRequired;
const issues = async (versionId: string) => (await h.readiness(OWNER, versionId)).issues;

describe('5.1 flight-only ID rule', () => {
  it('a typed flight-only booking submits without any ID proof: no adult block, no child warning, idProofRequired false', async () => {
    await asOwner(db, async () => {
      const d = await h.draft([FLIGHT_ITEM], { idProofs: false });
      expect(await issues(d.versionId)).not.toContain('id_proof_missing');
      const list = await codes();
      expect(list).not.toContain('id_proof_missing');
      expect(list, 'AL2: no child warning on flight-only').not.toContain('id_proof_missing_child');
      expect(await formRequired()).toBe(false);
      const booked = await h.confirmDraft(d);
      expect(booked.tasks.map((t) => t.department)).toEqual(['flight']);
      // Task ID-proof list carries the flag, computed on the task's current version.
      await h.addFlightPeople();
      await h.claim(FLIGHT, DEAL);
      const forTask = await one<{ idProofRequired: boolean; travellers: unknown[] }>(FLIGHT, SQL.proofsForTask, [booked.tasks[0]!.id]);
      expect(forTask.idProofRequired).toBe(false);
    });
  });

  it('a screenshot flight-only booking (two flights) is flight-only too; uploads stay allowed and nothing is deleted', async () => {
    await asOwner(db, async () => {
      const d = await h.draft([{ type: 'flight', facts: screenshotFlight(4), budget: '2800000' },
        { type: 'flight', facts: typedFlight([LEG_GOI_JDH]), budget: '2800000' }], { idProofs: false });
      expect(await issues(d.versionId)).not.toContain('id_proof_missing');
      expect(await formRequired()).toBe(false);
      const fileId = await h.storeIdProof(OWNER, DEAL, 1);
      expect((await owner<{ status: string }>('select status from public.traveller_id_proofs where id = $1', [fileId]))[0]!.status).toBe('stored');
      expect(await formRequired()).toBe(false);
      expect(await issues(d.versionId)).toEqual([]);
    });
  });

  it.each([
    ['hotel only', [HOTEL_ITEM]],
    ['visa only', [VISA_ITEM]],
    ['passport only', [PASSPORT_ITEM]],
    ['flight + visa', [FLIGHT_ITEM, VISA_ITEM]],
    ['flight + hotel (package)', [HOTEL_ITEM, FLIGHT_ITEM]],
    ['package hotel + transfer + flight', [HOTEL_ITEM, TRANSFER_ITEM, FLIGHT_ITEM]],
  ])('%s keeps today\'s rule: adults block, a child warns, idProofRequired true', async (_label, items) => {
    await asOwner(db, async () => {
      const d = await h.draft(items, { idProofs: false });
      expect(await issues(d.versionId)).toContain('id_proof_missing');
      const list = await checklist();
      expect(list.items.find((i) => i.code === 'id_proof_missing')).toMatchObject({ blocking: true });
      expect(list.canConfirm).toBe(false);
      expect(await formRequired()).toBe(true);
      // Adults stored, child missing: warning only, as today.
      for (const seq of [1, 2, 3]) await h.storeIdProof(OWNER, DEAL, seq);
      const after = await checklist();
      expect(after.items.map((i) => i.code)).not.toContain('id_proof_missing');
      expect(after.items.find((i) => i.code === 'id_proof_missing_child')).toMatchObject({ blocking: false, travellerSeqs: [4] });
      expect(await issues(d.versionId)).toEqual([]);
    });
  });

  it('idProofRequired is true when there is no version yet or no services', async () => {
    await asOwner(db, async () => {
      await h.switchesOn();
      expect(await one<{ idProofRequired?: boolean } | null>(OWNER, SQL.formGet, [DEAL])).toMatchObject({ idProofRequired: true });
      const opened = await h.openDraft(OWNER, DEAL);
      await h.saveTravellers(OWNER, DEAL, opened.rowVersion);
      expect(await formRequired()).toBe(true);
    });
  });

  it('a revision draft of a flight-only booking stays not required; the task list of a package task stays required', async () => {
    await asOwner(db, async () => {
      const booked = await h.book([FLIGHT_ITEM], { idProofs: false });
      await one(ACC, SQL.reviewReturn, [booked.versionId, 'Synthetic return: change the flight date', rid()]);
      const opened = await one<{ versionId: string; rowVersion: number }>(OWNER, SQL.openRevision, [booked.versionId]);
      expect(await formRequired()).toBe(false);
      expect(await issues(opened.versionId)).not.toContain('id_proof_missing');
      // Package on another Deal: the flight task's list says required.
      const pkg = await h.book([HOTEL_ITEM, FLIGHT_ITEM], { deal: DEAL2, actor: { userId: U.salesDelhiB } });
      await h.addFlightPeople();
      await h.claim(FLIGHT, DEAL2);
      const forTask = await one<{ idProofRequired: boolean }>(FLIGHT, SQL.proofsForTask, [h.taskOf(pkg, 'flight')]);
      expect(forTask.idProofRequired).toBe(true);
    });
  });

  it('authz.version_flight_only follows section 4.1', async () => {
    await asOwner(db, async () => {
      const fo = await h.draft([FLIGHT_ITEM], { idProofs: false });
      const flightOnly = async (v: string) => (await owner<{ b: boolean }>('select authz.version_flight_only($1) as b', [v]))[0]!.b;
      expect(await flightOnly(fo.versionId)).toBe(true);
      const mix = await h.draft([FLIGHT_ITEM, VISA_ITEM], { deal: DEAL2, actor: { userId: U.salesDelhiB }, idProofs: false });
      expect(await flightOnly(mix.versionId)).toBe(false);
    });
  });
});

describe('5.2 Accounts return blocked after commitment', () => {
  const RETURN_REASON = 'Synthetic return: please correct the booking';
  const detail = async (deal = DEAL) => (await one<{ booking: { canReturn: boolean; returnBlock: string | null; reviewStatus: string } }>(
    ACC, SQL.dealDetail, [deal])).booking;

  it('refused after a supplier confirmed (hint committed); the detail hides Return with the reason', async () => {
    await asOwner(db, async () => {
      await h.addAcc2();
      const b = await h.book([HOTEL_ITEM, FLIGHT_ITEM]);
      await h.receipt(DEAL, '30000000');
      await h.approve(b.versionId);
      expect(await detail()).toMatchObject({ canReturn: true, returnBlock: null });
      await h.supplierConfirmed(h.taskOf(b, 'hotel'));
      await refusedHint(ACC, SQL.reviewReturn, [b.versionId, RETURN_REASON, rid()], 'review_return_committed', /^committed$/, '55000');
      expect(await detail()).toMatchObject({ canReturn: false, returnBlock: 'committed' });
      expect((await owner<{ status: string }>('select status from public.accounts_booking_reviews where booking_version_id = $1', [b.versionId]))[0]!.status)
        .toBe('approved');
      expect(await h.audits('finance.review_returned')).toEqual([]);
    });
  });

  it('refused after a non-visa task completed; allowed with only a completed visa task', async () => {
    await asOwner(db, async () => {
      const b = await h.book([HOTEL_ITEM, TRANSFER_ITEM, VISA_ITEM]);
      await h.completeTask(h.taskOf(b, 'visa'), U.visaJodhpur);
      expect(await detail()).toMatchObject({ canReturn: true, returnBlock: null });
      const ok = await h.attempt(ACC, SQL.reviewReturn, [b.versionId, RETURN_REASON, rid()]);
      expect(ok, 'a completed visa task never blocks (QB3)').toMatchObject({ ok: true });
    });
    await asOwner(db, async () => {
      // Purchase tasks end at supplier_confirmed; a completed non-visa task is a Flight task (no ticket batch here).
      await h.addFlightPeople();
      const b = await h.book([HOTEL_ITEM, FLIGHT_ITEM]);
      await h.completeTask(h.taskOf(b, 'flight'), U.movedStaff);
      await refusedHint(ACC, SQL.reviewReturn, [b.versionId, RETURN_REASON, rid()], 'review_return_committed', /^committed$/, '55000');
      expect(await detail()).toMatchObject({ canReturn: false, returnBlock: 'committed' });
    });
  });

  it('lead change (10 Nov): issued Flight tickets alone do not block a return; a completed flight task does', async () => {
    await asOwner(db, async () => {
      const b = await h.book([HOTEL_ITEM, FLIGHT_ITEM]);
      await h.flightBatch(DEAL, [1]);
      expect((await owner<{ c: boolean }>('select authz.deal_committed($1) as c', [DEAL]))[0]!.c, 'tickets alone do not commit').toBe(false);
      expect((await owner<{ r: string | null }>('select authz.deal_return_blocked($1) as r', [DEAL]))[0]!.r).toBeNull();
      expect(await detail()).toMatchObject({ canReturn: true, returnBlock: null });
      expect(await h.attempt(ACC, SQL.reviewReturn, [b.versionId, RETURN_REASON, rid()])).toMatchObject({ ok: true });
    });
    await asOwner(db, async () => {
      const b = await h.book([HOTEL_ITEM, FLIGHT_ITEM]);
      const batch = await h.flightBatch(DEAL, [1]);
      await h.completeTask(batch.flightTask, U.movedStaff);
      await refusedHint(ACC, SQL.reviewReturn, [b.versionId, RETURN_REASON, rid()], 'review_return_committed', /^committed$/, '55000');
      expect(await detail()).toMatchObject({ canReturn: false, returnBlock: 'committed' });
    });
  });

  it('an exact retry of an earlier successful return replays its stored result; a fresh request is refused', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      const b = await h.book([HOTEL_ITEM, FLIGHT_ITEM]);
      const request = rid();
      const first = await one<Record<string, unknown>>(ACC, SQL.reviewReturn, [b.versionId, RETURN_REASON, request]);
      expect(first).toMatchObject({ status: 'returned' });
      expect(await detail()).toMatchObject({ canReturn: false, returnBlock: null, reviewStatus: 'returned' });
      await h.completeTask(h.taskOf(b, 'flight'), U.movedStaff);
      expect(await one(ACC, SQL.reviewReturn, [b.versionId, RETURN_REASON, request])).toEqual({ ...first, outcome: 'existing' });
      await refused(ACC, SQL.reviewReturn, [b.versionId, RETURN_REASON, rid()], 'review_return_committed', '55000');
      expect(await h.audits('finance.review_returned')).toHaveLength(1);
    });
  });

  it('the return takes the commitment lock helper (section 4.2) and the helper exists with the contract shape', async () => {
    await asOwner(db, async () => {
      const fns = await owner<{ name: string; definer: boolean; config: string[] | null }>(
        `select p.proname as name, p.prosecdef as definer, p.proconfig as config from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'authz' and p.proname in ('deal_return_blocked', 'deal_commitment_lock', 'version_flight_only') order by 1`);
      expect(fns.map((f) => f.name)).toEqual(['deal_commitment_lock', 'deal_return_blocked', 'version_flight_only']);
      for (const f of fns) {
        expect(f.definer, f.name).toBe(true);
        expect((f.config ?? []).join(','), f.name).toMatch(/search_path=("")?$/);
      }
      const [body] = await owner<{ src: string }>(
        `select p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'accounts_review_return'`);
      expect(body!.src).toMatch(/deal_commitment_lock/);
      expect(body!.src.indexOf('finance_lock_deal')).toBeLessThan(body!.src.indexOf('deal_commitment_lock'));
      const granted = await owner<{ g: boolean }>(`select has_function_privilege('authenticated', 'authz.deal_return_blocked(uuid)', 'execute') as g`);
      expect(granted[0]!.g, 'authz helpers are revoked from everyone').toBe(false);
    });
  });
});

describe('5.3 Flight cancel payment request (requester or current owner)', () => {
  const requestFields = () => JSON.stringify({ dueDate: istBusinessDate(), note: null, proformaEvidenceId: null });
  async function setup() {
    await h.addFlightPeople();
    await h.addAcc2();
    const b = await h.book([HOTEL_ITEM, FLIGHT_ITEM]);
    const batch = await h.flightBatch(DEAL, [1]);
    await one(FLIGHT, SQL.flightPaymentRequest, [batch.batchId, requestFields(), rid()]);
    const pay = (await h.paymentOf(batch.batchId))!;
    return { b, batch, pay };
  }
  type Money = { batches: Array<{ batchId: string; payment: Record<string, unknown> }> };
  const paymentView = async (actor: typeof FLIGHT, batchId: string) =>
    ((await one<Money | null>(actor, SQL.flightMoney, [DEAL]))?.batches ?? []).find((x) => x.batchId === batchId)?.payment;
  const cancelAudit = async () => (await h.audits('flight.payment_cancelled')).map((a) => a.details);

  it('the requester cancels; audit byTaskOwner false; canCancel only while pending', async () => {
    await asOwner(db, async () => {
      const { batch, pay } = await setup();
      expect(await paymentView(FLIGHT, batch.batchId)).toMatchObject({ canCancel: true, paymentId: pay.id });
      expect((await paymentView(ACC, batch.batchId))?.canCancel ?? false, 'Accounts view: no cancel').toBe(false);
      await one(FLIGHT, SQL.paymentCancel, [pay.id, pay.row_version, rid()]);
      expect((await h.paymentOf(batch.batchId))!.status).toBe('cancelled');
      expect(await cancelAudit()).toEqual([expect.objectContaining({ byTaskOwner: false })]);
      expect((await paymentView(FLIGHT, batch.batchId))?.canCancel ?? false).toBe(false);
    });
  });

  it('the current cost-task owner (not the requester) cancels after a reassignment; audit byTaskOwner true', async () => {
    await asOwner(db, async () => {
      const { batch, pay } = await setup();
      // Before the reassignment FLIGHT_2 is just another Flight person: refused with the frozen token.
      await refused(FLIGHT_2, SQL.paymentCancel, [pay.id, pay.row_version, rid()], 'not_authorized', '42501');
      await one(MANAGER, SQL.groupReassign, [DEAL, U.movedStaff, U.salesAhmedabad, 'Synthetic: covering for leave', rid()]);
      expect(await paymentView(FLIGHT_2, batch.batchId)).toMatchObject({ canCancel: true });
      await one(FLIGHT_2, SQL.paymentCancel, [pay.id, pay.row_version, rid()]);
      expect((await h.paymentOf(batch.batchId))!.status).toBe('cancelled');
      expect(await cancelAudit()).toEqual([expect.objectContaining({ byTaskOwner: true })]);
    });
  });

  it('the requester who still holds Flight may cancel after the task moved; a requester without the Flight role may not', async () => {
    await asOwner(db, async () => {
      const { pay, batch } = await setup();
      await one(MANAGER, SQL.groupReassign, [DEAL, U.movedStaff, U.salesAhmedabad, 'Synthetic: covering for leave', rid()]);
      // Lead correction (20261203000130): the requester who is no longer assigned still gets canCancel.
      expect(await paymentView(FLIGHT, batch.batchId)).toMatchObject({ canCancel: true });
      const ok = await h.attempt(FLIGHT, SQL.paymentCancel, [pay.id, pay.row_version, rid()]);
      expect(ok).toMatchObject({ ok: true });
    });
    await asOwner(db, async () => {
      const { pay } = await setup();
      await one(MANAGER, SQL.groupReassign, [DEAL, U.movedStaff, U.salesAhmedabad, 'Synthetic: covering for leave', rid()]);
      await h.dropRole(U.movedStaff, 'flight');
      await refused(FLIGHT, SQL.paymentCancel, [pay.id, pay.row_version, rid()], 'not_authorized', '42501');
    });
  });

  it('approved request: already_decided; stale row version: version_changed; Accounts and Manager cannot cancel', async () => {
    await asOwner(db, async () => {
      const { pay } = await setup();
      await refused(FLIGHT, SQL.paymentCancel, [pay.id, pay.row_version + 5, rid()], 'version_changed', CONFLICT_STATE);
      await refused(ACC, SQL.paymentCancel, [pay.id, pay.row_version, rid()], 'not_authorized', '42501');
      await refused(MANAGER, SQL.paymentCancel, [pay.id, pay.row_version, rid()], 'not_authorized', '42501');
      const approver = pay.route === 'manager' ? MANAGER : ACC;
      await one(approver, SQL.paymentDecide, [pay.id, 'approve', null, pay.row_version, rid()]);
      await refused(FLIGHT, SQL.paymentCancel, [pay.id, pay.row_version + 1, rid()], 'already_decided', '55000');
    });
  });

  it('Purchase requests stay requester-only (AL4): the new Purchase owner is refused', async () => {
    await asOwner(db, async () => {
      await h.addAcc2();
      await h.addRole(U.movedStaff, 'purchase');
      const b = await h.book([HOTEL_ITEM]);
      await h.receipt(DEAL, '30000000');
      await h.approve(b.versionId);
      const task = h.taskOf(b, 'hotel');
      const supplierId = await h.purchaseSupplier();
      await h.purchaseCost(task, supplierId);
      await h.goAhead(task);
      const p = await h.purchaseRequest(task, 2_000_000);
      await one(MANAGER, SQL.purchaseReassign, [task, U.purchaseJodhpur, U.movedStaff]);
      await refused({ userId: U.movedStaff }, SQL.paymentCancel, [p.id, await h.paymentRv(p.id), rid()], 'not_authorized', '42501');
      await one(PURCHASE, SQL.paymentCancel, [p.id, await h.paymentRv(p.id), rid()]);
      expect(await h.audits('purchase.payment_cancelled')).toHaveLength(1);
    });
  });
});

