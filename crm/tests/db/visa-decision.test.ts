import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, istBusinessDate } from '../helpers/db';
import { EVISA, OWNER, PASSPORT, SQL, STICKER, VISA_A, dayFrom, line, rid, visaHelpers } from './visa-e-support';

/**
 * Visa build (contract 8 Nov 2026) test plan 12.1 "Decision" and
 * "Completion": decision proof required (Q3/V5), e-visa recipient typed by
 * the desk (QB2), handover methods (Q8/V7), courier closes at dispatch
 * (QB8), Mark delivered, withdraw (V4/VL13), re-application after a refusal
 * (QB9/VL6), closure per kind and outcome (section 7, QB4) and task
 * completion, including a passport task (Q12/V12).
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = visaHelpers(() => db);
const { one, owner, refused, refusedHint, stickerTask, book, app, appRow, appliedAlone, decide, evidence, taskRow, audits } = h;

type Result = { applicationId: string; rowVersion: number; state: string; closed: boolean; taskCompleted: boolean };

async function evisaTask(travellers?: unknown) {
  const b = await book({ items: [{ type: 'visa', facts: EVISA }], travellers });
  await one(VISA_A, SQL.claim, [b.tasks[0]]);
  return b.tasks[0]!;
}
async function evisaApplied(taskId: string, seq: number) {
  const a = await h.makeReady(taskId, seq, { appointmentDate: null });
  await h.apply(taskId, [line(a)], { paidBy: 'customer_direct' });
  return app(taskId, seq);
}

describe('C6 decision proof and e-visa', () => {
  it('Approved and Rejected need a stored authority_outcome of this task (not a fee receipt, not another passenger)', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const a = await appliedAlone(taskId, 1);
      const b = await appliedAlone(taskId, 2);
      const receipt = await evidence(VISA_A, taskId, 'fee_receipt');
      const otherProof = await evidence(VISA_A, taskId, 'authority_outcome', b.applicationId);
      for (const decision of ['approved', 'rejected']) {
        const extra = decision === 'rejected' ? { reason: 'Synthetic refusal reason' } : {};
        for (const proof of [null, receipt, otherProof, rid()]) {
          await refused(VISA_A, SQL.decide, [a.applicationId, a.rowVersion, JSON.stringify({ decision, outcomeEvidenceId: proof, ...extra }), rid()],
            'outcome_document_required', '55000');
        }
      }
      // A task-level proof (application_id null) is accepted.
      const taskProof = await evidence(VISA_A, taskId, 'authority_outcome');
      const r = await one<Result>(VISA_A, SQL.decide, [a.applicationId, a.rowVersion, JSON.stringify({ decision: 'approved', outcomeEvidenceId: taskProof }), rid()]);
      expect(r).toMatchObject({ state: 'issued', closed: false, taskCompleted: false });
      expect(await appRow(a.applicationId)).toMatchObject({ state: 'issued', outcome_evidence_id: taskProof, decided_by: VISA_A.userId });
      // Not from docs_pending.
      const c = await app(taskId, 3);
      const p = await evidence(VISA_A, taskId, 'authority_outcome', c.applicationId);
      await refused(VISA_A, SQL.decide, [c.applicationId, c.rowVersion, JSON.stringify({ decision: 'approved', outcomeEvidenceId: p }), rid()], 'wrong_state', '55000');
      // Reject needs a reason (3..300).
      await refusedHint(VISA_A, SQL.decide, [b.applicationId, b.rowVersion, JSON.stringify({ decision: 'rejected', outcomeEvidenceId: otherProof }), rid()], 'invalid_input', /reason/);
      await refusedHint(VISA_A, SQL.decide, [b.applicationId, b.rowVersion, JSON.stringify({ decision: 'rejected', outcomeEvidenceId: otherProof, reason: 'no' }), rid()], 'invalid_input', /reason/);
      await refusedHint(VISA_A, SQL.decide, [b.applicationId, b.rowVersion, JSON.stringify({ decision: 'maybe', outcomeEvidenceId: otherProof }), rid()], 'invalid_input', /decision/);
    });
  });

  it('e-visa Approved needs the typed recipient e-mail, records "sent" and closes evisa_sent; Rejected closes refusal_told with customer informed', async () => {
    await asOwner(db, async () => {
      const taskId = await evisaTask();
      const a = await evisaApplied(taskId, 1);
      const proof = await evidence(VISA_A, taskId, 'authority_outcome', a.applicationId);
      await refusedHint(VISA_A, SQL.decide, [a.applicationId, a.rowVersion, JSON.stringify({ decision: 'approved', outcomeEvidenceId: proof }), rid()], 'invalid_input', /recipientEmail/);
      await refusedHint(VISA_A, SQL.decide, [a.applicationId, a.rowVersion, JSON.stringify({ decision: 'approved', outcomeEvidenceId: proof, recipientEmail: 'not-an-email' }), rid()],
        'invalid_input', /recipientEmail/);
      const r = await one<Result>(VISA_A, SQL.decide, [a.applicationId, a.rowVersion,
        JSON.stringify({ decision: 'approved', outcomeEvidenceId: proof, recipientEmail: 'family.synthetic@example.test', remark: 'Synthetic approve' }), rid()]);
      expect(r).toMatchObject({ state: 'issued', closed: true });
      const row = await appRow(a.applicationId);
      expect(row).toMatchObject({ evisa_recipient_email: 'family.synthetic@example.test', evisa_sent_by: VISA_A.userId, closed_reason: 'evisa_sent', decision_remark: 'Synthetic approve' });
      const shown = (await h.applicants(taskId)).find((x) => x.applicationId === a.applicationId)!;
      expect(shown.handover).toMatchObject({ kind: 'evisa', recipientEmail: 'family.synthetic@example.test' });
      expect(shown.closed).toMatchObject({ reason: 'evisa_sent' });
      for (const action of ['visa.application_approved', 'visa.evisa_sent', 'visa.application_closed']) expect(await audits(action, a.applicationId)).toHaveLength(1);
      expect(JSON.stringify(await owner(`select details, reason from public.audit_events where action like 'visa.%'`))).not.toMatch(/family\.synthetic/);
      // E-visa Rejected: customer told and closed at once (VL14).
      const b = await evisaApplied(taskId, 2);
      const rej = await decide(taskId, b, 'rejected');
      expect(rej).toMatchObject({ state: 'refused', closed: true });
      const brow = await appRow(b.applicationId);
      expect(brow).toMatchObject({ closed_reason: 'refusal_told', refusal_reason: 'Synthetic refusal: bank statement too short' });
      expect(brow.customer_informed_at).not.toBeNull();
      const [rejAudit] = await audits('visa.application_rejected', b.applicationId);
      expect(rejAudit!.reason).toBe('Synthetic refusal: bank statement too short');
      // Closed: nothing more.
      const ca = await app(taskId, 1);
      await refused(VISA_A, SQL.setRow, [ca.applicationId, ca.rowVersion, JSON.stringify({ remark: 'late' }), rid()], 'application_closed', '55000');
    });
  });
});

describe('C7/C8 handover (sticker and passport)', () => {
  it('approve without handover stays open (V7); not_with_us closes; courier needs a number and closes at dispatch (QB8)', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const a = await appliedAlone(taskId, 1, {}, { passportTaken: true });
      const r1 = await decide(taskId, a, 'approved');
      expect(r1).toMatchObject({ state: 'issued', closed: false });
      expect((await appRow(a.applicationId)).handover_method).toBeNull();
      const shown = (await h.applicants(taskId)).find((x) => x.applicationId === a.applicationId)!;
      expect(shown.handover?.method ?? null).toBeNull();
      expect(shown.can.handover).toBe(true);
      await refusedHint(VISA_A, SQL.handover, [a.applicationId, r1.rowVersion, JSON.stringify({ method: 'courier' }), rid()], 'invalid_input', /courierNumber/);
      await refusedHint(VISA_A, SQL.handover, [a.applicationId, r1.rowVersion, JSON.stringify({ method: 'office', courierNumber: 'X1' }), rid()], 'invalid_input', /courierNumber/);
      await refusedHint(VISA_A, SQL.handover, [a.applicationId, r1.rowVersion, JSON.stringify({ method: 'pigeon' }), rid()], 'invalid_input', /method/);
      const c = await one<Result>(VISA_A, SQL.handover, [a.applicationId, r1.rowVersion, JSON.stringify({ method: 'courier', courierNumber: 'SYN-AWB-0001' }), rid()]);
      expect(c.closed).toBe(true);
      const row = await appRow(a.applicationId);
      expect(row).toMatchObject({ handover_method: 'courier', courier_number: 'SYN-AWB-0001', closed_reason: 'courier_dispatched', documents_returned_by: VISA_A.userId });
      await refused(VISA_A, SQL.handover, [a.applicationId, c.rowVersion, JSON.stringify({ method: 'office' }), rid()], 'application_closed', '55000');
      // Approve with "not with us" in the same command closes at once.
      const b = await appliedAlone(taskId, 2);
      const r2 = await decide(taskId, b, 'approved', { handover: { method: 'not_with_us' } });
      expect(r2.closed).toBe(true);
      expect(await appRow(b.applicationId)).toMatchObject({ handover_method: 'not_with_us', closed_reason: 'not_with_us' });
      const [handoverAudit] = await audits('visa.handover_set', b.applicationId);
      expect(handoverAudit!.details).toMatchObject({ taskId, seq: 2, method: 'not_with_us' });
      expect(JSON.stringify(await audits('visa.handover_set'))).not.toMatch(/SYN-AWB-0001/);
    });
  });

  it('office / executive stay open until Mark delivered (date <= today and >= applied date); already_recorded once set', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const a = await appliedAlone(taskId, 1, { appliedOn: dayFrom(-5) });
      const rej = await decide(taskId, a, 'rejected');
      expect(rej.closed).toBe(false); // sticker refused: the passport still has to come back (QB4)
      const set = await one<Result>(VISA_A, SQL.handover, [a.applicationId, rej.rowVersion, JSON.stringify({ method: 'office', remark: 'Synthetic: collect at JDH' }), rid()]);
      expect(set.closed).toBe(false);
      await refused(VISA_A, SQL.handover, [a.applicationId, set.rowVersion, JSON.stringify({ method: 'executive' }), rid()], 'already_recorded', '55000');
      await refused(VISA_A, SQL.delivered, [a.applicationId, set.rowVersion, JSON.stringify({ deliveredOn: dayFrom(1) }), rid()], 'delivered_date_in_future', '22023');
      await refusedHint(VISA_A, SQL.delivered, [a.applicationId, set.rowVersion, JSON.stringify({ deliveredOn: dayFrom(-6) }), rid()], 'invalid_input', /deliveredOn/);
      const d = await one<Result>(VISA_A, SQL.delivered, [a.applicationId, set.rowVersion, JSON.stringify({ deliveredOn: istBusinessDate(), remark: null }), rid()]);
      expect(d.closed).toBe(true);
      const row = await appRow(a.applicationId);
      expect(row).toMatchObject({ closed_reason: 'delivered', delivered_by: VISA_A.userId, documents_returned_by: VISA_A.userId });
      expect(await audits('visa.handover_delivered', a.applicationId)).toHaveLength(1);
      // Mark delivered only for office/executive.
      const b = await appliedAlone(taskId, 2);
      const r = await decide(taskId, b, 'approved');
      await refused(VISA_A, SQL.delivered, [b.applicationId, r.rowVersion, JSON.stringify({ deliveredOn: istBusinessDate() }), rid()], 'wrong_state', '55000');
      const ex = await one<Result>(VISA_A, SQL.handover, [b.applicationId, r.rowVersion, JSON.stringify({ method: 'executive' }), rid()]);
      expect((await one<Result>(VISA_A, SQL.delivered, [b.applicationId, ex.rowVersion, JSON.stringify({ deliveredOn: istBusinessDate() }), rid()])).closed).toBe(true);
    });
  });
});

describe('C9 withdraw and C10 re-application', () => {
  it('withdraw needs reason and customer told; closes customer_informed; optional handover; allowed before or after Applied', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const a = await h.app(taskId, 1);
      await refusedHint(VISA_A, SQL.withdraw, [a.applicationId, a.rowVersion, JSON.stringify({ reason: 'Synthetic: trip cancelled' }), rid()], 'invalid_input', /customerInformed/);
      await refusedHint(VISA_A, SQL.withdraw, [a.applicationId, a.rowVersion, JSON.stringify({ reason: 'Synthetic: trip cancelled', customerInformed: false }), rid()], 'invalid_input', /customerInformed/);
      await refusedHint(VISA_A, SQL.withdraw, [a.applicationId, a.rowVersion, JSON.stringify({ reason: 'no', customerInformed: true }), rid()], 'invalid_input', /reason/);
      const w = await one<Result>(VISA_A, SQL.withdraw, [a.applicationId, a.rowVersion, JSON.stringify({ reason: 'Synthetic: trip cancelled', customerInformed: true }), rid()]);
      expect(w).toMatchObject({ state: 'withdrawn', closed: true });
      expect(await appRow(a.applicationId)).toMatchObject({ withdraw_reason: 'Synthetic: trip cancelled', closed_reason: 'customer_informed' });
      const [wa] = await audits('visa.application_withdrawn', a.applicationId);
      expect(wa!.reason).toBe('Synthetic: trip cancelled');
      // After Applied with the passport taken: handover recorded with the withdrawal.
      const b = await appliedAlone(taskId, 2, {}, { passportTaken: true });
      const wb = await one<Result>(VISA_A, SQL.withdraw, [b.applicationId, b.rowVersion,
        JSON.stringify({ reason: 'Synthetic: customer changed plans', customerInformed: true, handover: { method: 'courier', courierNumber: 'SYN-AWB-0002' } }), rid()]);
      expect(wb.closed).toBe(true);
      expect(await appRow(b.applicationId)).toMatchObject({ state: 'withdrawn', handover_method: 'courier', courier_number: 'SYN-AWB-0002' });
      // Fees stay as recorded.
      expect(await owner('select count(*)::int as n from public.department_cost_entries where application_id = $1', [b.applicationId])).toEqual([{ n: 1 }]);
      // Not after a decision.
      const c = await appliedAlone(taskId, 3);
      const rc = await decide(taskId, c, 'approved');
      await refused(VISA_A, SQL.withdraw, [c.applicationId, rc.rowVersion, JSON.stringify({ reason: 'Synthetic late', customerInformed: true }), rid()], 'wrong_state', '55000');
    });
  });

  it('re-apply only after Rejected: old superseded and closed reapplied; documents and custody copied; new reference and fees; own notice', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      let a = await h.app(taskId, 1);
      await one(VISA_A, SQL.docAdd, [a.applicationId, a.rowVersion, JSON.stringify({ label: 'Synthetic sponsor letter', received: false }), rid()]);
      a = await h.makeReady(taskId, 1);
      await h.apply(taskId, [line(a, { reference: 'FIRST-1' })], { passportTaken: true });
      a = await h.app(taskId, 1);
      await refused(VISA_A, SQL.reapply, [a.applicationId, a.rowVersion, rid()], 'wrong_state', '55000'); // not refused yet
      const rej = await decide(taskId, a, 'rejected');
      const re = await one<{ applicationId: string; rowVersion: number; previousApplicationId: string }>(VISA_A, SQL.reapply, [a.applicationId, rej.rowVersion, rid()]);
      expect(re.previousApplicationId).toBe(a.applicationId);
      const old = await appRow(a.applicationId);
      expect(old).toMatchObject({ superseded_by_id: re.applicationId, closed_reason: 'reapplied' });
      const fresh = await appRow(re.applicationId);
      expect(fresh).toMatchObject({ state: 'docs_pending', traveller_seq: 1, reapplication_of_id: a.applicationId, reference: null, appointment_date: null,
        passport_taken_by: VISA_A.userId, visa_kind: null });
      const copied = await h.docRows(re.applicationId);
      expect(copied.map((d) => [d.label, d.status, d.source]).sort()).toEqual([
        ['Bank statement (6 months)', 'received', 'copied'], ['Passport copy (front and back)', 'received', 'copied'],
        ['Photo, white background', 'received', 'copied'], ['Synthetic sponsor letter', 'received', 'copied'],
      ]);
      const w = (await h.workspace(taskId))!;
      expect(w.applicants.filter((x) => x.seq === 1).map((x) => x.applicationId)).toEqual([re.applicationId]);
      expect(w.applicants.find((x) => x.seq === 1)).toMatchObject({ secondApplication: true, previousApplicationId: a.applicationId, superseded: false });
      expect(w.previousApplications).toEqual([expect.objectContaining({ applicationId: a.applicationId, seq: 1, reference: 'FIRST-1', state: 'refused' })]);
      expect(await audits('visa.application_reapplied', a.applicationId)).toHaveLength(1);
      // The superseded application is closed for every command.
      await refused(VISA_A, SQL.reapply, [a.applicationId, (old.row_version as number), rid()], 'application_closed', '55000');
      // New reference and new fees on the second application; its own notice once decided.
      const second = await h.makeReady(taskId, 1);
      await h.apply(taskId, [line(second, { reference: 'SECOND-1', governmentFeePaise: '700000' })]);
      expect(await owner(`select count(*)::int as n from public.department_cost_entries where task_id = $1 and cost_kind = 'government_fee'`, [taskId])).toEqual([{ n: 2 }]);
      await decide(taskId, await h.app(taskId, 1), 'approved');
      expect(await owner(`select outcome from public.visa_result_notices where task_id = $1 order by created_at`, [taskId])).toEqual([{ outcome: 'rejected' }, { outcome: 'approved' }]);
      // Re-apply refused for an approved or withdrawn application.
      const b = await appliedAlone(taskId, 2);
      const appr = await decide(taskId, b, 'approved');
      await refused(VISA_A, SQL.reapply, [b.applicationId, appr.rowVersion, rid()], 'wrong_state', '55000');
    });
  });
});

describe('section 7 completion', () => {
  it('completes when every blocking application is closed; outbox and audit once; completed is final; finished task no longer locks the booking (QB3)', async () => {
    await asOwner(db, async () => {
      const travellers = [{ fullName: 'Synthetic Traveller One', type: 'adult', seq: 1 }, { fullName: 'Synthetic Traveller Two', type: 'adult', seq: 2 }];
      const taskId = await evisaTask(travellers);
      const a = await evisaApplied(taskId, 1);
      const r1 = await decide(taskId, a, 'approved', { recipientEmail: 'one.synthetic@example.test' });
      expect(r1.taskCompleted).toBe(false);
      const b = await h.app(taskId, 2);
      const w = await one<Result>(VISA_A, SQL.withdraw, [b.applicationId, b.rowVersion, JSON.stringify({ reason: 'Synthetic: not travelling', customerInformed: true }), rid()]);
      expect(w.taskCompleted).toBe(true);
      expect(await taskRow(taskId)).toMatchObject({ status: 'completed', completed_by: VISA_A.userId });
      expect(await owner(`select count(*)::int as n from public.outbox_events where event_type = 'fulfilment.task_completed' and aggregate_id = $1`, [taskId])).toEqual([{ n: 1 }]);
      const ws = (await h.workspace(taskId))!;
      expect(ws.status).toMatchObject({ code: 'completed', text: 'Completed' });
      expect(ws.steps.every((s) => s.done)).toBe(true);
      expect(ws.applicants.every((x) => Object.values(x.can).every((v) => v === false))).toBe(true);
      await refused(VISA_A, SQL.reapply, [b.applicationId, w.rowVersion, rid()], 'task_closed', '55000');
      await refused(VISA_A, SQL.evBegin, [taskId, null, 'other', 'x.pdf', 'application/pdf', 10, 'c'.repeat(64)], 'task_closed', '55000');
      // QB3: the finished visa task does not lock a revision of the booking.
      expect(await owner(`select authz.deal_committed(deal_id) as c from public.fulfilment_tasks where id = $1`, [taskId])).toEqual([{ c: false }]);
    });
  });

  it('a passport task goes from claim to completion (Q12/V12)', async () => {
    await asOwner(db, async () => {
      const p = await book({ items: [{ type: 'passport', facts: PASSPORT }] });
      const taskId = p.tasks[0]!;
      await one(VISA_A, SQL.claim, [taskId]);
      let a = await h.app(taskId, 1);
      await one(VISA_A, SQL.docAdd, [a.applicationId, a.rowVersion, JSON.stringify({ catalogueCode: 'old_passports', received: false }), rid()]);
      a = await h.makeReady(taskId, 1);
      await h.apply(taskId, [line(a, { reference: 'PSK-SYN-1' })], { paidBy: 'customer_direct' });
      a = await h.app(taskId, 1);
      const r = await decide(taskId, a, 'approved');
      expect(r).toMatchObject({ state: 'issued', closed: false, taskCompleted: false });
      const set = await one<Result>(VISA_A, SQL.handover, [a.applicationId, r.rowVersion, JSON.stringify({ method: 'office' }), rid()]);
      const d = await one<Result>(VISA_A, SQL.delivered, [a.applicationId, set.rowVersion, JSON.stringify({ deliveredOn: istBusinessDate() }), rid()]);
      expect(d).toMatchObject({ closed: true, taskCompleted: true });
      expect((await taskRow(taskId)).status).toBe('completed');
      const ws = (await h.workspace(taskId))!;
      expect(ws.serviceType).toBe('passport');
      expect(ws.applicants[0]).toMatchObject({ visaKind: { value: null }, closed: { reason: 'delivered' } });
    });
  });

  it('steps and status words follow the first unfinished step (section 8)', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask({ take: false });
      let w = (await h.workspace(taskId))!;
      expect(w.status).toMatchObject({ code: 'not_taken', text: 'Not taken' });
      await one(VISA_A, SQL.claim, [taskId]);
      w = (await h.workspace(taskId))!;
      expect(w.steps.map((s) => s.key)).toEqual(['take', 'ready', 'applied', 'decision', 'handover']);
      expect(w.steps.map((s) => s.label)).toEqual(['Task taken', 'Documents and date', 'Applied', 'Decision', 'Handover']);
      expect(w.steps[0]).toMatchObject({ met: 1, of: 1, done: true });
      expect(w.steps[1]).toMatchObject({ met: 0, of: 4, done: false });
      expect(w.status).toMatchObject({ code: 'in_progress', step: 'ready', text: 'Documents and date pending' });
      for (const seq of [1, 2, 3, 4]) await h.makeReady(taskId, seq);
      w = (await h.workspace(taskId))!;
      expect(w.status).toMatchObject({ step: 'applied', text: 'Not applied yet' });
      expect(w.readyCount).toBe(4);
      const apps = await h.applicants(taskId);
      await h.apply(taskId, apps.map((a) => line(a)), { paidBy: 'customer_direct' });
      w = (await h.workspace(taskId))!;
      expect(w.status).toMatchObject({ step: 'decision', text: 'Waiting for decision' });
      expect(w.appliedCount).toBe(4);
      for (const a of await h.applicants(taskId)) await decide(taskId, a, 'approved');
      w = (await h.workspace(taskId))!;
      expect(w.status).toMatchObject({ step: 'handover', text: 'Handover pending' });
      expect(w.steps[4]).toMatchObject({ met: 0, of: 4, done: false });
      expect(OWNER.userId).toBeTruthy();
      expect(STICKER.visaKind).toBe('sticker');
    });
  });
});
