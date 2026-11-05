import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ViewerAccess } from '@/modules/access/policy';
import {
  bookingClassifyRevision,
  bookingCommercialsSave,
  bookingCustomerSave,
  bookingDiscardDraft,
  bookingFormGet,
  bookingOpenRevision,
  departmentCostSave,
  departmentCostSubmit,
  departmentWorkForm,
  visaApplicationUpdate,
  visaTaskClaim,
  visaTaskGet,
  visaTaskList,
  bookingInstalmentsSave,
  bookingPanelB11,
  bookingTripSave,
  bookingVersionHistory,
  dealTravellersSaveDetails,
  serviceItemTravellersSave,
  submitBooking,
  travellerIdentitySave,
} from '@/modules/fulfilment/b11-commands';
import { toBookNowView, toDepartmentWorkFormView, toVisaTaskView } from '@/modules/fulfilment/b11-dto';
import {
  adminSetWorkflowSetting,
  confirmBooking,
  dealServices,
  intakeChecklist,
  isFunctionMissing,
  myWorkCounts,
  type RpcClient,
  serviceItemSave,
} from '@/modules/fulfilment/commands';
import {
  accountsDealDetail,
  accountsExpenseRecords,
  accountsPaymentClaims,
  dealPaymentClaims,
  paymentClaimReport,
  receiptRecordFromClaim,
} from '@/modules/finance/commands';
import { CLAIMS_CURSOR } from '@/modules/finance/dto';
import { type Actor, type TestDb, asOwner, createTestDb, resetActor, setActor } from '../helpers/db';
import { BILLING, CONTACT, DESK, IDENTITY, TRAVELLERS, TRIP, VISA, b11Helpers, rid } from './b11-support';
import { DEAL, FLIGHT_FACTS, HOTEL, OWNER, PURCHASE, SUPER } from './b1-support';
import { CLAIMS_SUITE_LOCK, claimHelpers } from './b11-claims-support';
import { ACC, DEAL as FIN_DEAL, SALES } from './finance-support';

/** Accounts Jodhpur reviews the b1-support Deal (same fixture user as finance-support ACC). */
const ACC_B1 = ACC;

/**
 * Contract drift guard (lead request, 11 October 2026): the real SQL of
 * migrations 20261119000100 (Book now) and 20261119000200 (claims) runs on
 * PGlite, and its JSON goes through the TS wrappers and zod mirrors the app
 * uses (b11-commands, finance commands). A key renamed or retyped on either
 * side fails here. The wrappers run through an RpcClient adapter that calls
 * the same functions with named arguments under the actor's JWT claims.
 * Synthetic data only.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  if (db.mode === 'postgres') await db.query('select pg_advisory_lock($1::bigint)', [CLAIMS_SUITE_LOCK]);
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const c = claimHelpers(() => db);

/** Runs `public.<fn>(p_x => $n, …)` as the actor, the way PostgREST would; errors come back as { code, message, hint }. */
function rpcAs(actor: Actor): RpcClient {
  return {
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      if (!/^[a-z_]+$/.test(fn)) throw new Error('bad function name');
      const names = Object.keys(args);
      const params = names.map((k) => {
        const v = args[k];
        if (v === null || v === undefined) return null;
        if (Array.isArray(v)) return v.some((x) => typeof x === 'object' && x !== null) ? JSON.stringify(v) : v;
        return typeof v === 'object' ? JSON.stringify(v) : v;
      });
      const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
      await db.exec('savepoint ts_rpc');
      try {
        await setActor(db, actor);
        const rows = await db.query<{ r: unknown }>(sql, params);
        await resetActor(db);
        await db.exec('release savepoint ts_rpc');
        return { data: rows[0]?.r ?? null, error: null };
      } catch (e) {
        await db.exec('rollback to savepoint ts_rpc');
        await resetActor(db);
        const err = e as { code?: string; message?: string; hint?: string };
        return { data: null, error: { code: err.code, message: err.message, hint: err.hint ?? null } };
      }
    },
  };
}

async function viewerFor(actor: Actor, deal: string) {
  const [row] = await h.owner<{ id: string; legal_entity_id: string; branch_id: string; owner_user_id: string; reference: string; title: string; source_system: string | null; source_stage_id: string | null }>(
    'select id, legal_entity_id, branch_id, owner_user_id, reference, title, source_system, source_stage_id from public.deals where id = $1',
    [deal],
  );
  const viewer: ViewerAccess = {
    userId: actor.userId!,
    memberships: [{ legalEntityId: row!.legal_entity_id, branchId: row!.branch_id, roleCode: 'sales' }],
    rolePermissions: [
      { roleCode: 'sales', permissionCode: 'deal.read', scope: 'own' },
      { roleCode: 'sales', permissionCode: 'deal.read_commercial', scope: 'own' },
    ],
    grants: [],
  };
  const facts = {
    id: row!.id,
    legalEntityId: row!.legal_entity_id,
    branchId: row!.branch_id,
    ownerUserId: row!.owner_user_id,
    activeAssigneeIds: [],
    reference: row!.reference,
    title: row!.title,
    sourceSystem: row!.source_system,
    sourceStageId: row!.source_stage_id,
  };
  return { viewer, deal: facts };
}

describe('Book now wrappers against 20261119000100', () => {
  it('every save wrapper parses the real command result, and booking_form_get feeds the Book now view', async () => {
    await asOwner(db, async () => {
      const rpc = rpcAs(OWNER);
      const d = await h.draftWithTravellers(OWNER, undefined, TRAVELLERS);
      let rv = d.rowVersion;
      const hotel = await h.addItem(OWNER, d.versionId, rv, 'hotel', HOTEL);
      rv = hotel.rowVersion;
      const visa = await h.addItem(OWNER, d.versionId, rv, 'visa', VISA);
      rv = visa.rowVersion;
      const flight = await h.addItem(OWNER, d.versionId, rv, 'flight', FLIGHT_FACTS);
      rv = flight.rowVersion;
      const [deal] = await h.owner<{ id: string }>('select deal_id as id from public.booking_versions where id = $1', [d.versionId]);
      const dealId = deal!.id;

      const customer = await bookingCustomerSave(rpc, {
        versionId: d.versionId,
        expectedRowVersion: rv,
        contact: CONTACT as never,
        billing: BILLING as never,
        billingExpectedRowVersion: 0,
        requestId: rid(),
      });
      expect(customer.billing).toMatchObject({ status: 'draft' });
      rv = customer.rowVersion;
      rv = (await bookingTripSave(rpc, { versionId: d.versionId, expectedRowVersion: rv, fields: { ...TRIP, scope: 'international' } as never })).rowVersion;
      const travellers = (TRAVELLERS as Array<Record<string, unknown>>).map((t) => ({
        fullName: String(t.fullName),
        type: t.type as 'adult',
        seq: Number(t.seq),
        ageYears: (t.ageYears as number | undefined) ?? null,
        specialNeeds: null,
      }));
      rv = (await dealTravellersSaveDetails(rpc, { dealId, expectedRowVersion: rv, travellers })).rowVersion;
      rv = (await serviceItemTravellersSave(rpc, { itemId: visa.itemId, versionId: d.versionId, expectedRowVersion: rv, seqs: [1] })).rowVersion;
      const identity = await travellerIdentitySave(rpc, { dealId, seq: 1, expectedRowVersion: 0, fields: IDENTITY as never });
      expect(identity).toEqual({ seq: 1, rowVersion: 1 });
      // B1.2 (20261120000100, DEC-38): identity proofs, so readiness carries no B1.2 code.
      for (const t of TRAVELLERS) await h.storeIdProof(OWNER, dealId, t.seq);
      rv = (await bookingCommercialsSave(rpc, { versionId: d.versionId, expectedRowVersion: rv, listPaise: '10000000', discountPaise: '123457', totalPaise: '9876543' })).rowVersion;
      rv = (
        await bookingInstalmentsSave(rpc, {
          versionId: d.versionId,
          expectedRowVersion: rv,
          instalments: [
            { seq: 1, label: 'Advance', amountPaise: '3000000', dueDate: '2026-11-01' },
            { seq: 2, label: 'Balance', amountPaise: '6876543', dueDate: '2026-12-01' },
          ],
        })
      ).rowVersion;

      const form = await bookingFormGet(rpc, dealId);
      expect(form).not.toBeNull();
      expect(form!.version).toMatchObject({ versionId: d.versionId, status: 'draft', rowVersion: rv, serviceType: 'package' });
      expect(form!.items.map((i) => [i.serviceType, i.participants?.length ?? 0])).toEqual([
        ['hotel', TRAVELLERS.length],
        ['visa', 1],
        ['flight', TRAVELLERS.length],
      ]);
      expect(form!.travellers[0]!.identity).toMatchObject({ passportNumber: IDENTITY.passportNumber, rowVersion: 1 });
      expect(form!.commercials).toEqual({ listPricePaise: '10000000', discountPaise: '123457', sellingTotalPaise: '9876543' });
      expect(form!.plan).toHaveLength(2);

      // The view builder accepts the real reads.
      const panel = await bookingPanelB11(rpc, dealId);
      const checklist = await intakeChecklist(rpc, dealId);
      const claims = await dealPaymentClaims(rpc, dealId);
      let historyMissing = false;
      try {
        await bookingVersionHistory(rpc, dealId);
      } catch (error) {
        historyMissing = isFunctionMissing(error);
      }
      // 20261119000300 (Atlas) installs booking_version_history on this branch.
      expect(historyMissing).toBe(false);
      const { viewer, deal: facts } = await viewerFor(OWNER, dealId);
      const view = toBookNowView({ viewer, deal: facts, form: form!, panel, checklist, claims, history: null });
      expect(view.travellers.find((t) => t.seq === 1)).toMatchObject({ identityRequired: true });
      expect(view.commercials?.sellingTotalPaise).toBe('9876543');
      expect(view.checklist.every((i) => typeof i.step === 'string')).toBe(true);

      // Purchase never reads the form.
      expect(await bookingFormGet(rpcAs(PURCHASE), dealId)).toBeNull();
    });
  });

  it('a standalone visa submission with the desk off returns no task: both submit wrappers accept it', async () => {
    await asOwner(db, async () => {
      const ready = await h.readyDraft(OWNER, DEAL, [['visa', VISA]], { identities: true });
      expect(ready.issues).toEqual([]);
      const result = await submitBooking(rpcAs(OWNER), { versionId: ready.versionId, expectedContentHash: ready.hash });
      expect(result).toMatchObject({ outcome: 'created', taskId: null, taskIds: [] });
      const again = await confirmBooking(rpcAs(OWNER), { versionId: ready.versionId, expectedContentHash: ready.hash });
      expect(again).toMatchObject({ outcome: 'existing', taskId: null });
    });
  });
});

describe('claims wrappers against 20261119000200', () => {
  it('report, Sales projection, Accounts list (cursor), record from claim (receiptId) and Accounts deal detail parse', async () => {
    await asOwner(db, async () => {
      await c.bookedDeal();
      const sales = rpcAs(SALES);
      const first = await paymentClaimReport(sales, { dealId: FIN_DEAL, fields: c.cashClaim() as never, requestId: rid() });
      expect(first).toMatchObject({ outcome: 'created', status: 'reported', rowVersion: 1 });
      await paymentClaimReport(sales, { dealId: FIN_DEAL, fields: (await c.bankClaim()) as never, requestId: rid() });

      const projection = await dealPaymentClaims(sales, FIN_DEAL);
      expect(projection!.claims).toHaveLength(2);
      expect(projection!.reportedPaise).toMatch(/^\d+$/);

      const acc = rpcAs(ACC);
      const page = await accountsPaymentClaims(acc, 'reported', null, 1);
      expect(page.items).toHaveLength(1);
      expect(page.hasMore).toBe(true);
      expect(page.nextAfter).toMatch(CLAIMS_CURSOR);
      const next = await accountsPaymentClaims(acc, 'reported', page.nextAfter, 1);
      expect(next.items).toHaveLength(1);
      expect(next.nextAfter).toBeNull();

      const cashFields = await c.receiptFieldsFor(c.cashClaim());
      const recorded = await receiptRecordFromClaim(acc, {
        claimId: first.id,
        fields: { ...cashFields, mismatchReason: null } as never,
        requestId: rid(),
      });
      expect(recorded).toMatchObject({ outcome: 'created', id: first.id, status: 'linked' });
      expect(recorded.receiptId).toMatch(/^[0-9a-f-]{36}$/);
      expect(recorded.receiptNo).toMatch(/^R-\d{4}-\d{2}-\d{6,}$/);

      const detail = await accountsDealDetail(acc, FIN_DEAL);
      expect(detail!.claims).toHaveLength(2);
      expect(detail!.claims!.find((x) => x.claimId === first.id)).toMatchObject({ status: 'linked', linkedReceiptId: recorded.receiptId, linkKind: 'recorded_from_claim' });
      expect(detail!.claimsReportedPaise).toMatch(/^\d+$/);
      expect(detail!.booking).toMatchObject({ serviceType: 'hotel', paymentPlan: null, services: [] });
    });
  });
});

// ---------------------------------------------------------------------------
// 20261119000300 (revision) and 20261119000500 (desk, work forms, expenses)
// ---------------------------------------------------------------------------

describe('revision wrappers against 20261119000300', () => {
  it('returned booking: panel review/revision keys, open, classify, history and discard parse; the view uses them', async () => {
    await asOwner(db, async () => {
      const base = await h.readyDraft(OWNER, DEAL, [['hotel', HOTEL]]);
      expect(base.issues).toEqual([]);
      await h.confirm(OWNER, base.versionId, base.hash);
      await h.one(ACC_B1, 'select public.accounts_review_return($1, $2, $3) as r', [base.versionId, 'Synthetic return: the check-out date is wrong', rid()]);
      const rpc = rpcAs(OWNER);

      const returned = await bookingPanelB11(rpc, DEAL);
      expect(returned!.accountsReview).toMatchObject({ status: 'returned' });
      expect(returned!.canRevise).toBe(true);

      const opened = await bookingOpenRevision(rpc, base.versionId);
      expect(opened).toMatchObject({ versionNo: 2, revisesVersionId: base.versionId, created: true });
      const form = await bookingFormGet(rpc, DEAL);
      const hotel = form!.items.find((i) => i.serviceType === 'hotel')!;
      const saved = await serviceItemSave(rpc, {
        itemId: hotel.itemId,
        versionId: opened.versionId,
        expectedRowVersion: opened.rowVersion,
        facts: { ...HOTEL, checkOut: '2026-12-12' } as never,
        purchaseBudgetPaise: hotel.purchaseBudgetPaise ?? '0',
      });
      const classified = await bookingClassifyRevision(rpc, { versionId: opened.versionId, expectedRowVersion: saved.rowVersion, changeClass: 'customer_material' });
      expect(classified.changedFields.length).toBeGreaterThan(0);

      const panel = await bookingPanelB11(rpc, DEAL);
      expect(panel!.revision).toMatchObject({ versionId: opened.versionId, changeClass: 'customer_material' });
      const history = await bookingVersionHistory(rpc, DEAL);
      expect(history!.map((v) => [v.versionNo, v.status])).toEqual(expect.arrayContaining([[1, 'confirmed'], [2, 'draft']]));
      const { viewer, deal: facts } = await viewerFor(OWNER, DEAL);
      const view = toBookNowView({
        viewer,
        deal: facts,
        form: (await bookingFormGet(rpc, DEAL))!,
        panel,
        checklist: await intakeChecklist(rpc, DEAL),
        history,
      });
      expect(view.version).toMatchObject({ versionNo: 2, revisesVersionNo: 1, changeClass: 'customer_material' });
      expect(view.history).toHaveLength(2);

      expect(await bookingDiscardDraft(rpc, { versionId: opened.versionId, expectedRowVersion: classified.rowVersion })).toEqual({ outcome: 'discarded' });
    });
  });
});

describe('desk, work form and expense wrappers against 20261119000500', () => {
  it('queue, task before and after the claim, documents, files, cost, submit, work form, counts, expense list, switch result', async () => {
    await asOwner(db, async () => {
      const { taskId } = await h.deskTask(TRAVELLERS.slice(0, 2));
      const desk = rpcAs(DESK);

      const queue = await visaTaskList(desk);
      expect(queue.map((t) => [t.taskId, t.facts.type, t.applicantCount])).toEqual([[taskId, 'visa', 2]]);
      const before = toVisaTaskView((await visaTaskGet(desk, taskId))!);
      expect(before.applicants.map((a) => [a.travellerSeq, a.applicationId, a.state])).toEqual([[1, null, null], [2, null, null]]);
      expect(before.canClaim).toBe(true);

      expect(await visaTaskClaim(desk, taskId)).toMatchObject({ taskId, status: 'in_progress', alreadyYours: false });
      const after = toVisaTaskView((await visaTaskGet(desk, taskId))!);
      expect(after.canWork).toBe(true);
      const a1 = after.applicants[0]!;
      expect(a1).toMatchObject({ state: 'docs_pending', closed: false });
      expect(a1.identity).toMatchObject({ dateOfBirth: '1990-05-17' });
      const updated = await visaApplicationUpdate(desk, { applicationId: a1.applicationId!, expectedRowVersion: a1.rowVersion!, fields: { documents: { passport_copy: 'checked' } } });
      expect(updated).toMatchObject({ state: 'docs_pending', taskCompleted: false });

      const receipt = await h.deskEvidence(DESK, taskId, 'fee_receipt');
      const cost = await departmentCostSave(desk, {
        taskId,
        entryId: null,
        expectedRowVersion: 0,
        fields: { costKind: 'government_fee', amountPaise: '250000', paidBy: 'company', paymentMode: 'upi', paidOn: '2026-10-10', reference: 'VFS-SYN-1', receiptEvidenceId: receipt },
        requestId: rid(),
      });
      expect(cost).toMatchObject({ expenseStatus: 'draft' });
      expect(await departmentCostSubmit(desk, { entryId: cost.entryId, expectedRowVersion: cost.rowVersion })).toMatchObject({ expenseStatus: 'submitted' });

      const formView = toDepartmentWorkFormView((await departmentWorkForm(desk, taskId))!);
      expect(formView).toMatchObject({ department: 'visa', canRecordCost: true });
      expect(formView.documents.map((d) => d.id)).toContain(receipt);
      expect(formView.costs[0]).toMatchObject({ entryId: cost.entryId, expenseStatus: 'submitted', receiptEvidenceId: receipt });
      expect(formView.steps.map((s) => s.code)).toContain('taken');

      const services = await dealServices(rpcAs(OWNER), DEAL);
      const visa = services!.items.find((i) => i.serviceType === 'visa')!;
      expect(visa.task?.status).toBe('in_progress');

      const counts = await myWorkCounts(rpcAs(ACC_B1));
      expect(counts.expensesToReview).toBe(1);
      expect(counts).toHaveProperty('claimsToProcess');
      expect((await myWorkCounts(desk)).visaTasksWaiting).not.toBeUndefined();

      const page = await accountsExpenseRecords(rpcAs(ACC_B1), 'submitted');
      expect(page.items.map((i) => [i.entryId, i.department, i.actions.accept])).toEqual([[cost.entryId, 'visa', null]]);
      expect(page.items[0]!.evidence.map((e) => e.id)).toEqual([receipt]);

      const again = await adminSetWorkflowSetting(rpcAs(SUPER), { key: 'visa_passport_tasks_enabled', value: true, reason: 'Synthetic desk launch for the test' });
      expect(again).toMatchObject({ changed: false, tasksCreated: 0 });
    });
  });
});

describe('null flags from the SQL (real journey, 12 October 2026)', () => {
  it('booking_form_get before any draft, deal_services and booking_panel after a package submission parse; null flags read false', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const rpc = rpcAs(OWNER);
      // No version yet: canConfirm comes back null.
      const raw = await h.one<Record<string, unknown>>(OWNER, 'select public.booking_form_get($1) as r', [DEAL]);
      expect(raw.version).toBeNull();
      expect(raw.canConfirm).toBeNull();
      const empty = await bookingFormGet(rpc, DEAL);
      expect(empty).toMatchObject({ version: null, canConfirm: false });
      const services = await dealServices(rpc, DEAL);
      expect(services).toMatchObject({ version: null, canConfirm: false });
      const { viewer, deal: facts } = await viewerFor(OWNER, DEAL);
      const landing = toBookNowView({ viewer, deal: facts, form: empty!, panel: await bookingPanelB11(rpc, DEAL), checklist: await intakeChecklist(rpc, DEAL) });
      expect(landing).toMatchObject({ version: null, canSubmit: false, canOpenRevision: false });

      // Submitted package, review pending: canRevise may be null; panel and form still parse.
      const ready = await h.readyDraft(OWNER, DEAL, [['hotel', HOTEL]]);
      await h.confirm(OWNER, ready.versionId, ready.hash);
      const rawPanel = await h.one<Record<string, unknown>>(OWNER, 'select public.booking_panel($1) as r', [DEAL]);
      expect(rawPanel.canRevise).toBeNull();
      const panel = await bookingPanelB11(rpc, DEAL);
      expect(panel!.canRevise).toBe(false);
      expect(panel!.version).toMatchObject({ status: 'confirmed' });
      const submitted = await bookingFormGet(rpc, DEAL);
      expect(submitted).toMatchObject({ canConfirm: false, version: { status: 'confirmed' } });
      const view = toBookNowView({ viewer, deal: facts, form: submitted!, panel, checklist: await intakeChecklist(rpc, DEAL) });
      expect(view).toMatchObject({ canEdit: false, canSubmit: false, canOpenRevision: false });
    });
  });
});
