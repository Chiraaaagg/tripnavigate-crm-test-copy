import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, expectDbError } from '../helpers/db';
import {
  ACC, DEAL, FLIGHT, MANAGER, OWNER, PURCHASE, SALES_B, SQL, VISA_A, VISA_B, line, rid, visaHelpers,
} from './visa-e-support';
import { CONFLICT_STATE } from '../helpers/sqlstates';

/**
 * Visa build, test plan 12.1 "Notices" and the Home rows (contract sections
 * 5.3, 6 C6/C14, 8, 9.3, Q11, VL3, VL4):
 *   - one result notice per application outcome (Approved / Rejected), none
 *     for Withdrawn; a replayed decision does not add one; a re-application
 *     gets its own;
 *   - the recipient is the Deal's Sales owner, computed at read time; the
 *     branch Manager only when the Deal has no active Sales owner; other
 *     Sales, Purchase, Flight and Visa see none;
 *   - "OK, seen" once, by SO* only;
 *   - visa_home_counts keys per role, null when not applicable;
 *     my_work_counts.visaTasksWaiting unchanged;
 *   - deal_visa_summary task status words and counts.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = visaHelpers(() => db);
const { one, owner } = h;

type Notice = { noticeId: string; taskId: string; title: string; travellerName: string | null; outcome: string; at: string; reason: string | null;
  seen: boolean; canAck: boolean };
type Summary = { tasks: Array<{ taskId: string; serviceType: string; status: { code: string; step: string | null; text: string }; applicantCount: number;
  approved: number; rejected: number; withdrawn: number; waiting: number; addedAfterCompletion: number }>; notices: Notice[] };
type Home = Record<string, unknown>;

const notices = async (actor = OWNER) => ((await h.attempt<Summary | null>(actor, SQL.dealSummary, [DEAL])) as { ok: boolean; value?: Summary | null });
async function expectNoDelete(taskId: string): Promise<void> {
  await expectDbError(db, () => owner('delete from public.visa_result_notices where task_id = $1', [taskId]), {});
  await expectDbError(db, () => owner(`update public.visa_result_notices set outcome = 'rejected' where task_id = $1 and outcome = 'approved'`, [taskId]), {});
}
const noticeRows = (taskId: string) => owner<{ application_id: string; outcome: string; seen_by: string | null }>(
  'select application_id, outcome, seen_by from public.visa_result_notices where task_id = $1 order by created_at, outcome', [taskId]);

/**
 * Sticker task for the four travellers taken by VISA_A: traveller 1 approved,
 * traveller 2 rejected, traveller 3 applied then withdrawn, traveller 4
 * withdrawn before Applied.
 */
async function outcomes() {
  const { taskId } = await h.stickerTask();
  const a1 = await h.appliedAlone(taskId, 1);
  await h.decide(taskId, a1, 'approved');
  const a2 = await h.appliedAlone(taskId, 2);
  await h.decide(taskId, a2, 'rejected');
  const a3 = await h.appliedAlone(taskId, 3);
  await one(VISA_A, SQL.withdraw, [a3.applicationId, a3.rowVersion, JSON.stringify({ reason: 'Synthetic: trip cancelled', customerInformed: true }), rid()]);
  const a4 = await h.app(taskId, 4);
  await one(VISA_A, SQL.withdraw, [a4.applicationId, a4.rowVersion, JSON.stringify({ reason: 'Synthetic: not travelling', customerInformed: true }), rid()]);
  return { taskId, a1, a2, a3, a4 };
}

describe('result notices (5.3, C6, C14, Q11)', () => {
  it('one notice per application outcome; none for withdrawn; a replay or second decision adds none', async () => {
    await asOwner(db, async () => {
      const { taskId } = await h.stickerTask();
      const a1 = await h.appliedAlone(taskId, 1);
      const proof = await h.evidence(VISA_A, taskId, 'authority_outcome', a1.applicationId);
      const req = rid();
      const fields = JSON.stringify({ decision: 'approved', outcomeEvidenceId: proof });
      const first = await one<{ rowVersion: number; state: string }>(VISA_A, SQL.decide, [a1.applicationId, a1.rowVersion, fields, req]);
      expect(first.state).toBe('issued');
      // Same request id and payload: the stored result, no second notice.
      expect(await one(VISA_A, SQL.decide, [a1.applicationId, a1.rowVersion, fields, req])).toMatchObject({ outcome: 'existing' });
      // A second decision cannot happen: stale version, or wrong state on the fresh one.
      await h.refused(VISA_A, SQL.decide, [a1.applicationId, a1.rowVersion, fields, rid()], 'version_changed', CONFLICT_STATE);
      await h.refused(VISA_A, SQL.decide, [a1.applicationId, first.rowVersion, JSON.stringify({ decision: 'rejected', outcomeEvidenceId: proof,
        reason: 'Synthetic second decision' }), rid()], 'wrong_state', '55000');
      expect(await noticeRows(taskId)).toEqual([{ application_id: a1.applicationId, outcome: 'approved', seen_by: null }]);
      // Rejected: one notice; withdrawn (applied or not): none (VL3).
      const a2 = await h.appliedAlone(taskId, 2);
      await h.decide(taskId, a2, 'rejected');
      const a3 = await h.appliedAlone(taskId, 3);
      await one(VISA_A, SQL.withdraw, [a3.applicationId, a3.rowVersion, JSON.stringify({ reason: 'Synthetic: trip cancelled', customerInformed: true }), rid()]);
      const a4 = await h.app(taskId, 4);
      await one(VISA_A, SQL.withdraw, [a4.applicationId, a4.rowVersion, JSON.stringify({ reason: 'Synthetic: not travelling', customerInformed: true }), rid()]);
      const rows = await noticeRows(taskId);
      expect(rows.map((r) => [r.application_id, r.outcome]).sort()).toEqual([[a1.applicationId, 'approved'], [a2.applicationId, 'rejected']].sort());
      // The table is set-once (section 5.3 guard): no delete, outcome never changes.
      await h.refused(VISA_A, SQL.noticeAck, [rid()], '(not_found|not_authorized)');
      await expectNoDelete(taskId);
    });
  });

  it('a re-application after a refusal gets its own notice (QB9)', async () => {
    await asOwner(db, async () => {
      const { taskId } = await h.stickerTask();
      const a2 = await h.appliedAlone(taskId, 2);
      const rejected = await h.decide(taskId, a2, 'rejected');
      const again = await one<{ applicationId: string; rowVersion: number; previousApplicationId: string }>(VISA_A, SQL.reapply,
        [a2.applicationId, rejected.rowVersion, rid()]);
      expect(again.previousApplicationId).toBe(a2.applicationId);
      const n2 = await h.makeReady(taskId, 2);
      expect(n2.applicationId).toBe(again.applicationId);
      await h.apply(taskId, [line(n2, { reference: 'SYN-NOTICE-SECOND' })]);
      await h.decide(taskId, await h.app(taskId, 2), 'approved');
      const rows = await noticeRows(taskId);
      expect(rows.map((r) => [r.application_id, r.outcome])).toEqual([[a2.applicationId, 'rejected'], [again.applicationId, 'approved']]);
      const so = (await notices(OWNER)).value!;
      expect(so.notices.map((n) => n.outcome).sort()).toEqual(['approved', 'rejected']);
    });
  });

  it('the Sales owner sees and acknowledges each notice once; other Sales, Manager, Purchase, Flight and Visa see none', async () => {
    await asOwner(db, async () => {
      await h.addVisaB();
      await h.addFlightPerson();
      await h.addOtherSales(DEAL);
      const { taskId } = await outcomes();
      const so = (await notices(OWNER)).value!;
      expect(so.notices).toHaveLength(2);
      for (const n of so.notices) expect(n).toMatchObject({ taskId, seen: false, canAck: true });
      const rejected = so.notices.find((n) => n.outcome === 'rejected')!;
      expect(rejected.reason).toBe('Synthetic refusal: bank statement too short');
      expect(so.notices.find((n) => n.outcome === 'approved')!.reason).toBeNull();
      expect(so.notices.map((n) => n.travellerName).sort()).toEqual(['Synthetic Traveller One', 'Synthetic Traveller Two']);
      // S and M (the Deal has an active Sales owner): the summary, no notices.
      for (const actor of [SALES_B, MANAGER]) {
        const r = await notices(actor);
        expect(r.ok && r.value, `${actor.userId} summary`).toBeTruthy();
        expect(r.value!.notices, `${actor.userId} notices`).toEqual([]);
      }
      // P, F, V-only, A: no Deal visa summary at all (section 9.3).
      for (const actor of [PURCHASE, FLIGHT, VISA_A, VISA_B, ACC]) {
        const r = await notices(actor);
        expect(r.ok ? r.value : null, `${actor.userId} summary`).toBeNull();
      }
      // Only SO* acknowledges.
      for (const actor of [SALES_B, MANAGER, VISA_A, PURCHASE]) await h.refused(actor, SQL.noticeAck, [rejected.noticeId], 'not_authorized', '42501');
      expect(await one(OWNER, SQL.noticeAck, [rejected.noticeId])).toMatchObject({ outcome: 'updated' });
      expect(await one(OWNER, SQL.noticeAck, [rejected.noticeId])).toMatchObject({ outcome: 'existing' });
      expect(await owner('select seen_by from public.visa_result_notices where id = $1', [rejected.noticeId])).toEqual([{ seen_by: OWNER.userId }]);
      const after = (await notices(OWNER)).value!;
      expect(after.notices.find((n) => n.noticeId === rejected.noticeId)).toMatchObject({ seen: true, canAck: false });
      // No audit for an ack (view state, as flight_change_acknowledge).
      expect(await owner(`select count(*)::int as n from public.audit_events where target_id = $1`, [rejected.noticeId])).toEqual([{ n: 0 }]);
    });
  });

  it('without an active Sales owner the branch Manager sees and acknowledges the open notices (VL4: recipient at read time)', async () => {
    await asOwner(db, async () => {
      await outcomes();
      expect((await notices(MANAGER)).value!.notices).toEqual([]);
      await owner(`update public.memberships set status = 'inactive', deactivated_at = now() where user_id = $1 and role_code = 'sales'`, [U.salesDelhiA]);
      const m = (await notices(MANAGER)).value!;
      expect(m.notices).toHaveLength(2);
      for (const n of m.notices) expect(n.canAck).toBe(true);
      expect(((await one<Home>(MANAGER, SQL.homeCounts)).salesVisaResultsToSee)).toBe(2);
      expect(await one(MANAGER, SQL.noticeAck, [m.notices[0]!.noticeId])).toMatchObject({ outcome: 'updated' });
      expect(((await one<Home>(MANAGER, SQL.homeCounts)).salesVisaResultsToSee)).toBe(1);
      // The former owner (no active Sales role) is no recipient any more.
      await h.refused(OWNER, SQL.noticeAck, [m.notices[1]!.noticeId], 'not_authorized');
    });
  });
});

describe('Deal visa summary (9.3) and Home counts (8)', () => {
  it('deal_visa_summary counts outcomes per task with the frozen status words', async () => {
    await asOwner(db, async () => {
      const { taskId } = await outcomes();
      const s = (await notices(OWNER)).value!;
      const t = s.tasks.find((x) => x.taskId === taskId)!;
      expect(t).toMatchObject({ serviceType: 'visa', applicantCount: 4, approved: 1, rejected: 1, withdrawn: 2, waiting: 0, addedAfterCompletion: 0,
        status: { code: 'in_progress' } });
      // Section 8 frozen words only.
      expect(['Documents and date pending', 'Not applied yet', 'Waiting for decision', 'Handover pending']).toContain(t.status.text);
    });
  });

  it('a task not taken reads "Not taken"; applied and undecided reads "Waiting for decision"', async () => {
    await asOwner(db, async () => {
      const { taskId } = await h.stickerTask({ take: false });
      let t = (await notices(OWNER)).value!.tasks.find((x) => x.taskId === taskId)!;
      expect(t.status).toMatchObject({ code: 'not_taken', text: 'Not taken' });
      await one(VISA_A, SQL.claim, [taskId]);
      t = (await notices(OWNER)).value!.tasks.find((x) => x.taskId === taskId)!;
      expect(t.status).toMatchObject({ code: 'in_progress', step: 'ready', text: 'Documents and date pending' });
      for (const seq of [1, 2, 3, 4]) await h.appliedAlone(taskId, seq, { reference: `SYN-WAIT-${seq}` });
      t = (await notices(OWNER)).value!.tasks.find((x) => x.taskId === taskId)!;
      expect(t).toMatchObject({ waiting: 4, status: { step: 'decision', text: 'Waiting for decision' } });
    });
  });

  it('visa_home_counts: Visa rows for the desk (mine), Sales rows for SO*, null keys where not applicable', async () => {
    await asOwner(db, async () => {
      await h.addVisaB();
      const { taskId } = await h.stickerTask();
      // Traveller 1: applied company-paid without a receipt (draft fee), waiting for the result.
      await h.appliedAlone(taskId, 1);
      // Traveller 2: applied with a receipt (submitted); Accounts returns the fee; approved without handover.
      const r2 = await h.makeReady(taskId, 2);
      const receipt = await h.evidence(VISA_A, taskId, 'fee_receipt');
      const applied = await h.apply(taskId, [line(r2)], { receiptEvidenceId: receipt });
      const [entry] = await owner<{ id: string; row_version: number; expense_status: string }>(
        'select id, row_version, expense_status from public.department_cost_entries where id = any($1::uuid[])', [applied.entryIds]);
      expect(entry!.expense_status).toBe('submitted');
      await one(ACC, SQL.expenseReturn, [entry!.id, entry!.row_version, 'Synthetic: the receipt is unreadable', rid()]);
      await h.decide(taskId, await h.app(taskId, 2), 'approved');

      const mine = await one<Home>(VISA_A, SQL.homeCounts);
      expect(mine).toMatchObject({
        visaApplicantsWaitingResult: 1, visaApplicantsWaitingResultTaskId: taskId,
        visaHandoverPending: 1, visaHandoverPendingTaskId: taskId,
        visaFeesReturned: 1, visaFeesReturnedTaskId: taskId,
        visaFeesWithoutReceipt: 1, visaFeesWithoutReceiptTaskId: taskId,
        visaTravellerChanged: 0,
      });
      expect(mine.salesVisaResultsToSee ?? null).toBeNull();
      // Another Visa person: nothing is theirs.
      const other = await one<Home>(VISA_B, SQL.homeCounts);
      expect(other).toMatchObject({ visaApplicantsWaitingResult: 0, visaHandoverPending: 0, visaFeesReturned: 0, visaFeesWithoutReceipt: 0,
        visaTravellerChanged: 0 });
      expect(other.visaHandoverPendingTaskId ?? null).toBeNull();
      // SO: the result to see, with the Deal link; no desk rows.
      const so = await one<Home>(OWNER, SQL.homeCounts);
      expect(so).toMatchObject({ salesVisaResultsToSee: 1, salesVisaResultsDealId: DEAL });
      for (const k of ['visaApplicantsWaitingResult', 'visaHandoverPending', 'visaFeesReturned', 'visaFeesWithoutReceipt', 'visaTravellerChanged']) {
        expect(so[k] ?? null, `SO ${k}`).toBeNull();
      }
      // Other Sales and Purchase: nothing to see.
      for (const actor of [SALES_B, PURCHASE]) {
        const r = await h.attempt<Home | null>(actor, SQL.homeCounts);
        const v = r.ok ? r.value : null;
        expect(Number(v?.salesVisaResultsToSee ?? 0), `${actor.userId} results`).toBe(0);
        expect(v?.visaHandoverPending ?? null, `${actor.userId} desk rows`).toBeNull();
      }
    });
  });

  it('my_work_counts.visaTasksWaiting is unchanged: untaken tasks for every Visa person, then the taker\'s own', async () => {
    await asOwner(db, async () => {
      await h.addVisaB();
      const { taskId } = await h.stickerTask({ take: false });
      expect((await one<Home>(VISA_A, SQL.myWorkCounts)).visaTasksWaiting).toBe(1);
      expect((await one<Home>(VISA_B, SQL.myWorkCounts)).visaTasksWaiting).toBe(1);
      await one(VISA_A, SQL.claim, [taskId]);
      expect((await one<Home>(VISA_A, SQL.myWorkCounts)).visaTasksWaiting).toBe(1);
      expect((await one<Home>(VISA_B, SQL.myWorkCounts)).visaTasksWaiting).toBe(0);
      expect((await one<Home>(PURCHASE, SQL.myWorkCounts)).visaTasksWaiting ?? null).toBeNull();
    });
  });
});
