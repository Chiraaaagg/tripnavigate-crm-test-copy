import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, istBusinessDate } from '../helpers/db';
import { ACC, OWNER, PURCHASE, SQL, VISA_A, VISA_B, line, rid, visaHelpers } from './visa-e-support';

/**
 * Visa build (contract 8 Nov 2026) test plan 12.1 "Fees": per-passenger fee
 * entries from Applied (Q6), C12 "Fix fee" / "Send fee to Accounts" for
 * returned and receipt-less draft entries, the receipt rule (V6), Accounts
 * review with reviewer separation (DF:1188, unchanged), department_cost_save
 * refusing task-level visa entries (C15), the per-passenger "other" visa
 * cost of lead decision 16 (VL18 changed), legacy task-level rows still
 * submittable, the per-traveller cost summary (Q10/V9) and applicantName on
 * the Accounts list (9.4).
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = visaHelpers(() => db);
const { one, owner, refused, refusedHint, stickerTask, app, makeReady, evidence, apply, audits } = h;
type Sent = { entryId: string; rowVersion: number; expenseStatus: string };
type Page = { items: Array<Record<string, unknown>>; totalCount: number };
const entry = async (id: string) => (await owner<{ amount_paise: string; expense_status: string; receipt_evidence_id: string | null; row_version: number;
  submitted_by: string | null; return_reason: string | null; application_id: string | null }>(
  'select amount_paise::text, expense_status, receipt_evidence_id, row_version, submitted_by, return_reason, application_id from public.department_cost_entries where id = $1', [id]))[0]!;

describe('C12 visa_fee_send', () => {
  it('returned fee: Fix fee with a new amount and receipt resubmits; Accounts accepts; locked afterwards', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const a = await makeReady(taskId, 1);
      const receipt = await evidence(VISA_A, taskId, 'fee_receipt');
      const applied = await apply(taskId, [line(a, { governmentFeePaise: '650000' })], { receiptEvidenceId: receipt });
      const [entryId] = applied.entryIds as [string];
      const returned = await one<{ rowVersion: number; status: string }>(ACC, SQL.expenseReturn, [entryId, 1, 'Synthetic: the receipt shows a different amount', rid()]);
      expect(returned.status).toBe('returned');
      const w = (await h.workspace(taskId))!;
      expect(w.returnedFees).toEqual([expect.objectContaining({ entryId, applicantName: 'Synthetic Traveller One', costKind: 'government_fee', amountPaise: '650000',
        returnReason: 'Synthetic: the receipt shows a different amount', rowVersion: returned.rowVersion })]);
      expect((await app(taskId, 1)).fees[0]).toMatchObject({ expenseStatus: 'returned', returnReason: 'Synthetic: the receipt shows a different amount' });
      // Field and version rules.
      await refusedHint(VISA_A, SQL.feeSend, [entryId, returned.rowVersion, JSON.stringify({ amountPaise: '0' }), rid()], 'invalid_input', /amountPaise/);
      await refused(VISA_A, SQL.feeSend, [entryId, returned.rowVersion - 1, JSON.stringify({ amountPaise: '640000' }), rid()], 'version_changed', '40001');
      await refused(VISA_B, SQL.feeSend, [entryId, returned.rowVersion, JSON.stringify({ amountPaise: '640000' }), rid()], 'not_authorized', '42501');
      const newReceipt = await evidence(VISA_A, taskId, 'fee_receipt', null, 'f'.repeat(64));
      const sent = await one<Sent>(VISA_A, SQL.feeSend, [entryId, returned.rowVersion,
        JSON.stringify({ amountPaise: '640000', receiptEvidenceId: newReceipt, remark: 'Synthetic: corrected to the receipt' }), rid()]);
      expect(sent.expenseStatus).toBe('submitted');
      expect(await entry(entryId)).toMatchObject({ amount_paise: '640000', expense_status: 'submitted', receipt_evidence_id: newReceipt, return_reason: null,
        submitted_by: VISA_A.userId });
      const [feeAudit] = await audits('visa.fee_sent', entryId);
      expect(feeAudit!.details).toMatchObject({ taskId, entryId, applicationId: a.applicationId, costKind: 'government_fee' });
      expect(feeAudit!.reason).toBe('Synthetic: corrected to the receipt');
      expect(JSON.stringify(await owner(`select details from public.audit_events where action in ('visa.fee_sent', 'department.cost_saved', 'department.cost_submitted')`)))
        .not.toMatch(/640000|650000/);
      await refused(VISA_A, SQL.feeSend, [entryId, sent.rowVersion, JSON.stringify({ amountPaise: '630000' }), rid()], 'cost_locked', '55000');
      expect(await one(ACC, SQL.expenseAccept, [entryId, sent.rowVersion, rid()])).toMatchObject({ status: 'accepted' });
      await refused(VISA_A, SQL.feeSend, [entryId, sent.rowVersion + 1, JSON.stringify({ amountPaise: '630000' }), rid()], 'cost_locked', '55000');
    });
  });

  it('receipt-less draft: receipt_required until a stored fee receipt is attached; customer_direct entry is wrong_state', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const a = await makeReady(taskId, 1);
      const [draftId] = (await apply(taskId, [line(a)])).entryIds as [string];
      expect((await entry(draftId)).expense_status).toBe('draft');
      await refused(VISA_A, SQL.feeSend, [draftId, 1, JSON.stringify({ amountPaise: '650000' }), rid()], 'receipt_required', '55000');
      // An applicant document is not a receipt.
      const notReceipt = await evidence(VISA_A, taskId, 'applicant_document', a.applicationId);
      await refusedHint(VISA_A, SQL.feeSend, [draftId, 1, JSON.stringify({ amountPaise: '650000', receiptEvidenceId: notReceipt }), rid()], 'invalid_input', /receiptEvidenceId/);
      const receipt = await evidence(VISA_A, taskId, 'fee_receipt');
      const sent = await one<Sent>(VISA_A, SQL.feeSend, [draftId, 1, JSON.stringify({ amountPaise: '650000', receiptEvidenceId: receipt }), rid()]);
      expect(sent.expenseStatus).toBe('submitted');
      const b = await makeReady(taskId, 2);
      const [directId] = (await apply(taskId, [line(b)], { paidBy: 'customer_direct' })).entryIds as [string];
      await refused(VISA_A, SQL.feeSend, [directId, 1, JSON.stringify({ amountPaise: '650000', receiptEvidenceId: receipt }), rid()], 'wrong_state', '55000');
      // Replay: same request id, same payload -> existing.
      const c = await makeReady(taskId, 3);
      const [cId] = (await apply(taskId, [line(c)])).entryIds as [string];
      const req = rid();
      const payload = JSON.stringify({ amountPaise: '650000', receiptEvidenceId: receipt, remark: null });
      const first = await one<Record<string, unknown>>(VISA_A, SQL.feeSend, [cId, 1, payload, req]);
      expect(await one(VISA_A, SQL.feeSend, [cId, 1, payload, req])).toMatchObject({ ...first, outcome: 'existing' });
      await refused(VISA_A, SQL.feeSend, [cId, 1, JSON.stringify({ amountPaise: '650001', receiptEvidenceId: receipt, remark: null }), req], 'duplicate_request', '40001');
    });
  });
});

describe('Accounts review stays separated', () => {
  it('the submitter (also holding Accounts) cannot accept; another Accounts person accepts; accept needs a receipt', async () => {
    await asOwner(db, async () => {
      await h.addVisaAccounts();
      const { taskId } = await stickerTask();
      const a = await makeReady(taskId, 1);
      const receipt = await evidence(VISA_A, taskId, 'fee_receipt');
      const [id] = (await apply(taskId, [line(a)], { receiptEvidenceId: receipt })).entryIds as [string];
      await refused(VISA_A, SQL.expenseAccept, [id, 1, rid()], 'not_self_approval', '42501');
      for (const actor of [OWNER, PURCHASE, VISA_B]) expect(await h.attempt(actor, SQL.expenseAccept, [id, 1, rid()])).toMatchObject({ ok: false, code: '42501' });
      const page = await one<Page>(ACC, SQL.expenseList, ['submitted', null, null]);
      const item = page.items.find((i) => i.entryId === id)!;
      expect(item).toMatchObject({ department: 'visa', kind: 'government_fee', applicantName: 'Synthetic Traveller One', actions: { accept: null, return: null } });
      expect(await one(ACC, SQL.expenseAccept, [id, 1, rid()])).toMatchObject({ status: 'accepted' });
    });
  });
});

describe('C15 department_cost_save for visa', () => {
  it('task-level manual visa entries are refused (hint visaFees); legacy task-level rows stay submittable', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const fee = { costKind: 'government_fee', amountPaise: '650000', paidBy: 'company', paymentMode: 'upi', paidOn: istBusinessDate() };
      for (const fields of [fee, { ...fee, costKind: 'service_fee' }, { ...fee, costKind: 'other' }, { ...fee, paidBy: 'customer_direct' }]) {
        await refusedHint(VISA_A, SQL.costSave, [taskId, null, 0, JSON.stringify(fields), rid()], 'invalid_input', /^visaFees$/);
      }
      expect(await owner('select count(*)::int as n from public.department_cost_entries where task_id = $1', [taskId])).toEqual([{ n: 0 }]);
      // SYNTHETIC FIXTURE: a task-level draft saved before the build (application_id null), with a stored receipt.
      const receipt = await evidence(VISA_A, taskId, 'fee_receipt');
      const [legacy] = await owner<{ id: string; row_version: number }>(
        `insert into public.department_cost_entries (legal_entity_id, branch_id, deal_id, task_id, department, cost_kind, amount_paise, paid_by,
           payment_mode, paid_on, expense_status, receipt_evidence_id, created_by, request_id)
         select t.legal_entity_id, d.branch_id, t.deal_id, t.id, 'visa', 'government_fee', 500000, 'company', 'upi', date '2026-10-10', 'draft', $2,
           t.assignee_user_id, gen_random_uuid()
         from public.fulfilment_tasks t join public.deals d on d.id = t.deal_id where t.id = $1 returning id, row_version`, [taskId, receipt]);
      const submitted = await one<Sent>(VISA_A, SQL.costSubmit, [legacy!.id, legacy!.row_version]);
      expect(submitted.expenseStatus).toBe('submitted');
      const w = (await h.workspace(taskId))!;
      expect(w.costSummary.taskLevel).toEqual([expect.objectContaining({ entryId: legacy!.id, costKind: 'government_fee', amountPaise: '500000', paidBy: 'company',
        expenseStatus: 'submitted' })]);
      const page = await one<Page>(ACC, SQL.expenseList, ['submitted', null, null]);
      expect(page.items.find((i) => i.entryId === legacy!.id)).toMatchObject({ applicantName: null });
    });
  });

  it('lead decision 16 (VL18 changed): an "other" cost per passenger, linked to the application, same paid-by and receipt rules', async () => {
    // CONTRACT GAP: section 16 allows "other" visa costs per passenger but names no command. Track A
    // implemented it in department_cost_save (costKind 'other' + applicationId); these assertions test that reading.
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const a = await app(taskId, 1);
      const other = { costKind: 'other', amountPaise: '25000', paidBy: 'company', paymentMode: 'cash', paidOn: istBusinessDate(), applicationId: a.applicationId };
      await refusedHint(VISA_A, SQL.costSave, [taskId, null, 0, JSON.stringify({ ...other, costKind: 'government_fee' }), rid()], 'invalid_input', /^visaFees$/);
      await refusedHint(VISA_A, SQL.costSave, [taskId, null, 0, JSON.stringify({ ...other, applicationId: rid() }), rid()], 'invalid_input', /^visaFees$/);
      const saved = await one<{ entryId: string; rowVersion: number; expenseStatus: string }>(VISA_A, SQL.costSave, [taskId, null, 0, JSON.stringify(other), rid()]);
      expect(saved.expenseStatus).toBe('draft');
      expect(await entry(saved.entryId)).toMatchObject({ application_id: a.applicationId, amount_paise: '25000' });
      await refused(VISA_A, SQL.costSubmit, [saved.entryId, saved.rowVersion], 'receipt_required', '55000');
      const receipt = await evidence(VISA_A, taskId, 'fee_receipt');
      const sent = await one<Sent>(VISA_A, SQL.feeSend, [saved.entryId, saved.rowVersion, JSON.stringify({ amountPaise: '25000', receiptEvidenceId: receipt }), rid()]);
      expect(sent.expenseStatus).toBe('submitted');
      const page = await one<Page>(ACC, SQL.expenseList, ['submitted', null, null]);
      expect(page.items.find((i) => i.entryId === saved.entryId)).toMatchObject({ kind: 'other', applicantName: 'Synthetic Traveller One' });
    });
  });
});

describe('Q10/V9 cost summary per traveller', () => {
  it('sums the recorded fees per traveller (no split, no customer price); company and customer-direct totals', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const a1 = await makeReady(taskId, 1);
      const a2 = await makeReady(taskId, 2);
      await apply(taskId, [line(a1, { governmentFeePaise: '650000', serviceFeePaise: '100000' }), line(a2, { governmentFeePaise: '325000' })]);
      const a3 = await makeReady(taskId, 3);
      await apply(taskId, [line(a3, { governmentFeePaise: '70000' })], { paidBy: 'customer_direct' });
      const s = (await h.workspace(taskId))!.costSummary;
      const bySeq = Object.fromEntries(s.travellers.map((t) => [t.seq, t]));
      expect(bySeq[1]).toMatchObject({ name: 'Synthetic Traveller One', governmentFeePaise: '650000', serviceFeePaise: '100000', paidBy: 'company', expenseStatus: 'draft' });
      expect(bySeq[2]).toMatchObject({ governmentFeePaise: '325000', serviceFeePaise: null });
      expect(bySeq[3]).toMatchObject({ governmentFeePaise: '70000', paidBy: 'customer_direct', expenseStatus: null });
      expect(s.companyTotalPaise).toBe('1075000');
      expect(s.customerDirectTotalPaise).toBe('70000');
      expect(JSON.stringify(s)).not.toMatch(/9876543|12345600|selling|margin/i);
    });
  });
});
