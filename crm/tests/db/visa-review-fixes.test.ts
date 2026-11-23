import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, istBusinessDate } from '../helpers/db';
import { ACC, EVISA, MANAGER, SQL, STICKER, VISA_A, VISA_B, line, rid, visaHelpers } from './visa-e-support';

/**
 * Visa build: the lead's independent-review fixes of 8 November 2026
 * (migration 20261202000140), tested from the lead's decisions, not the code:
 *   1. money follows separately from completion: on a COMPLETED visa task its
 *      last assignee (still Visa) uploads fee receipts, sends / fixes fees and
 *      records "other" costs; nothing else reopens; Home fee rows count
 *      completed tasks;
 *   2. re-application carries passport custody only while the old
 *      application had no handover; Applied sets custody from the posted flag;
 *   4. costSummary.travellers[].otherPaise;
 *   7. visa_queue tasks[] carry canTake and isManagerView per task.
 * Item 3 (claim racing a revision confirm) is real-Postgres only: visa-concurrency.test.ts (10).
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = visaHelpers(() => db);
const { one, owner, refused, stickerTask, book, app, appRow, makeReady, evidence, apply, decide } = h;
type Home = Record<string, number | string | null>;

/** One e-visa traveller, applied company-paid without a receipt (draft fee), approved with the typed e-mail: task completed. */
async function completedWithDraftFee() {
  const travellers = [{ fullName: 'Synthetic Traveller One', type: 'adult', seq: 1 }];
  const b = await book({ items: [{ type: 'visa', facts: EVISA }], travellers });
  const taskId = b.tasks[0]!;
  await one(VISA_A, SQL.claim, [taskId]);
  const a = await makeReady(taskId, 1, { appointmentDate: null });
  const applied = await apply(taskId, [line(a)]);
  const done = await decide(taskId, await app(taskId, 1), 'approved', { recipientEmail: 'one.synthetic@example.test' });
  expect(done.taskCompleted).toBe(true);
  return { taskId, applicationId: a.applicationId, entryId: applied.entryIds[0]! };
}

describe('fix 1: fees after completion (last assignee only)', () => {
  it('draft fee: receipt upload and Send work; row save refused task_closed; Manager and another Visa person refused', async () => {
    await asOwner(db, async () => {
      await h.addVisaB();
      const t = await completedWithDraftFee();
      expect((await h.taskRow(t.taskId)).status).toBe('completed');
      const w = (await h.workspace(t.taskId))!;
      expect(w).toMatchObject({ canWork: false, canManageFees: true });
      const receipt = await evidence(VISA_A, t.taskId, 'fee_receipt');
      const sent = await one<{ expenseStatus: string }>(VISA_A, SQL.feeSend, [t.entryId, 1, JSON.stringify({ amountPaise: '650000', receiptEvidenceId: receipt }), rid()]);
      expect(sent.expenseStatus).toBe('submitted');
      // Nothing else reopens.
      const a = (await h.applicants(t.taskId))[0]!;
      await refused(VISA_A, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify({ remark: 'Synthetic late remark' }), rid()], 'task_closed', '55000');
      await refused(VISA_A, SQL.evBegin, [t.taskId, null, 'applicant_document', 'late.pdf', 'application/pdf', 10, 'c'.repeat(64)], 'task_closed', '55000');
      expect((await h.taskRow(t.taskId)).status).toBe('completed');
      // Manager and another Visa person never manage the fees.
      for (const actor of [MANAGER, VISA_B]) {
        const r = await h.attempt(actor, SQL.feeSend, [t.entryId, 2, JSON.stringify({ amountPaise: '650000' }), rid()]);
        expect(r.ok ? 'ok' : r.code).toBe('42501');
      }
      expect((await h.workspace(t.taskId, MANAGER))!.canManageFees ?? false).toBe(false);
    });
  });

  it('returned fee on a completed task: Fix fee resubmits; an "other" cost can still be added; Home rows count the completed task', async () => {
    await asOwner(db, async () => {
      const t = await completedWithDraftFee();
      let home = await one<Home>(VISA_A, SQL.homeCounts);
      expect(home).toMatchObject({ visaFeesWithoutReceipt: 1, visaFeesWithoutReceiptTaskId: t.taskId });
      const receipt = await evidence(VISA_A, t.taskId, 'fee_receipt');
      await one(VISA_A, SQL.feeSend, [t.entryId, 1, JSON.stringify({ amountPaise: '650000', receiptEvidenceId: receipt }), rid()]);
      const [row] = await owner<{ row_version: number }>('select row_version from public.department_cost_entries where id = $1', [t.entryId]);
      const ret = await one<{ rowVersion: number }>(ACC, SQL.expenseReturn, [t.entryId, row!.row_version, 'Synthetic: the receipt amount differs', rid()]);
      home = await one<Home>(VISA_A, SQL.homeCounts);
      expect(home).toMatchObject({ visaFeesReturned: 1, visaFeesReturnedTaskId: t.taskId, visaFeesWithoutReceipt: 0 });
      const fixed = await one<{ expenseStatus: string }>(VISA_A, SQL.feeSend, [t.entryId, ret.rowVersion, JSON.stringify({ amountPaise: '640000' }), rid()]);
      expect(fixed.expenseStatus).toBe('submitted');
      expect((await one<Home>(VISA_A, SQL.homeCounts)).visaFeesReturned ?? 0).toBe(0);
      // "Other" cost of the passenger on the completed task (lead decision 16 + fix 1).
      const other = await one<{ entryId: string; expenseStatus: string }>(VISA_A, SQL.costSave, [t.taskId, null, 0, JSON.stringify({ costKind: 'other',
        amountPaise: '25000', paidBy: 'company', paymentMode: 'cash', paidOn: istBusinessDate(), applicationId: t.applicationId }), rid()]);
      expect(other.expenseStatus).toBe('draft');
      // Fix 4: otherPaise per traveller.
      const traveller = (await h.workspace(t.taskId))!.costSummary.travellers.find((x) => x.seq === 1)!;
      expect(traveller).toMatchObject({ governmentFeePaise: '640000', otherPaise: '25000' });
    });
  });
});

describe('fix 2: passport custody on re-application', () => {
  it('handed back before the re-application: custody NOT carried; Applied sets it from the posted flag', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const a = await makeReady(taskId, 1);
      await apply(taskId, [line(a, { reference: 'CUST-1' })], { passportTaken: true });
      const rej = await decide(taskId, await app(taskId, 1), 'rejected');
      const set = await one<{ rowVersion: number }>(VISA_A, SQL.handover, [a.applicationId, rej.rowVersion, JSON.stringify({ method: 'office' }), rid()]);
      const del = await one<{ rowVersion: number }>(VISA_A, SQL.delivered, [a.applicationId, set.rowVersion, JSON.stringify({ deliveredOn: istBusinessDate() }), rid()]);
      expect((await appRow(a.applicationId)).closed_reason).toBe('delivered');
      const re = await one<{ applicationId: string }>(VISA_A, SQL.reapply, [a.applicationId, del.rowVersion, rid()]);
      expect(await appRow(re.applicationId)).toMatchObject({ passport_taken_at: null, passport_taken_by: null });
      // Applied without the tick: custody stays empty (Applied sets it from the posted flag).
      const second = await makeReady(taskId, 1);
      await apply(taskId, [line(second, { reference: 'CUST-2' })], { paidBy: 'customer_direct', passportTaken: false });
      expect(await appRow(re.applicationId)).toMatchObject({ passport_taken_at: null });
    });
  });

  it('no handover yet when re-applying: custody carried over (VL6); Applied with the tick keeps it', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const a = await makeReady(taskId, 2);
      await apply(taskId, [line(a, { reference: 'CUST-3' })], { passportTaken: true });
      const rej = await decide(taskId, await app(taskId, 2), 'rejected');
      const re = await one<{ applicationId: string }>(VISA_A, SQL.reapply, [a.applicationId, rej.rowVersion, rid()]);
      expect((await appRow(re.applicationId)).passport_taken_by).toBe(VISA_A.userId);
      const second = await makeReady(taskId, 2);
      await apply(taskId, [line(second, { reference: 'CUST-4' })], { paidBy: 'customer_direct', passportTaken: true });
      expect((await appRow(re.applicationId)).passport_taken_at).not.toBeNull();
    });
  });
});

describe('fix 7: queue roles per task', () => {
  it('each task row says whether the reader may take it and whether it is a Manager view', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask({ take: false });
      const row = async (actor: typeof VISA_A) => (await one<{ tasks: Array<{ taskId: string; canTake: boolean; isManagerView: boolean }> }>(actor, SQL.queue))
        .tasks.find((t) => t.taskId === taskId)!;
      expect(await row(VISA_A)).toMatchObject({ canTake: true, isManagerView: false });
      expect(await row(MANAGER)).toMatchObject({ canTake: false, isManagerView: true });
      // The Delhi Manager who also holds the Visa role in the same entity works the task as Visa.
      await h.addRole(MANAGER.userId!, 'visa');
      expect(await row(MANAGER)).toMatchObject({ canTake: true, isManagerView: false });
      // LIMITATION: the fixtures' second entity is disabled, so "Visa in one entity, Manager in another" with a task in each
      // cannot be built here; this checks the per-task keys for each role in one entity.
      expect(STICKER.visaKind).toBe('sticker');
    });
  });
});
