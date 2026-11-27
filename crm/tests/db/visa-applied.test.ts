import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, istBusinessDate } from '../helpers/db';
import { BLANK_KIND, PASSPORT, SQL, STICKER, VISA_A, dayFrom, line, rid, visaHelpers } from './visa-e-support';
import { CONFLICT_STATE } from '../helpers/sqlstates';

/**
 * Visa build (contract 8 Nov 2026) test plan 12.1 "Applied": C5 for one
 * passenger and for a club in ONE transaction (all or nothing), references
 * unique per task including superseded applications (QB10), no future
 * applied date (V11), exact per-passenger fee entries (Q6), the receipt rule
 * (V6/VL2) and request-id replay.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = visaHelpers(() => db);
const { one, owner, refused, refusedHint, stickerTask, book, app, appRow, makeReady, evidence, apply, audits } = h;

type Entry = { id: string; application_id: string | null; cost_kind: string; amount_paise: string; paid_by: string; payment_mode: string | null;
  paid_on: string | null; reference: string | null; receipt_evidence_id: string | null; expense_status: string | null; submitted_by: string | null };
const entries = (taskId: string) => owner<Entry>(
  `select id, application_id, cost_kind, amount_paise::text, paid_by, payment_mode, to_char(paid_on, 'YYYY-MM-DD') as paid_on, reference,
          receipt_evidence_id, expense_status, submitted_by
   from public.department_cost_entries where task_id = $1 order by application_id, cost_kind`, [taskId]);

describe('C5 one passenger', () => {
  it('moves the applicant to decision_pending (V3) with frozen kind/jurisdiction, custody, fee entries; returns ids and versions', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const a = await makeReady(taskId, 1);
      const receipt = await evidence(VISA_A, taskId, 'fee_receipt');
      const result = await apply(taskId, [line(a, { reference: ' VFS-SYN-0001 ', governmentFeePaise: '650000', serviceFeePaise: '120000' })],
        { passportTaken: true, receiptEvidenceId: receipt, remark: 'Synthetic applied remark' });
      expect(result.clubId).toBeNull();
      expect(result.applications).toEqual([{ applicationId: a.applicationId, rowVersion: a.rowVersion + 1, state: 'decision_pending' }]);
      expect(result.entryIds).toHaveLength(2);
      const row = await appRow(a.applicationId);
      expect(row).toMatchObject({ state: 'decision_pending', reference: 'VFS-SYN-0001', visa_kind: 'sticker', jurisdiction_required: true,
        jurisdiction_place: 'New Delhi', applied_remark: 'Synthetic applied remark', club_id: null, club_size: null, passport_taken_by: VISA_A.userId });
      expect(row.submitted_at).not.toBeNull();
      expect(row.passport_taken_at).not.toBeNull();
      const applied = await app(taskId, 1);
      expect(applied.stateText).toMatch(/Applied/);
      expect(applied.applied).toMatchObject({ reference: 'VFS-SYN-0001', appliedOn: istBusinessDate(), clubId: null, passportTaken: true });
      // Company + receipt: both entries submitted for Accounts, exact amounts, linked to the application.
      expect(await entries(taskId)).toEqual([
        expect.objectContaining({ application_id: a.applicationId, cost_kind: 'government_fee', amount_paise: '650000', paid_by: 'company', payment_mode: 'upi',
          paid_on: istBusinessDate(), reference: 'VFS-SYN-0001', receipt_evidence_id: receipt, expense_status: 'submitted', submitted_by: VISA_A.userId }),
        expect.objectContaining({ application_id: a.applicationId, cost_kind: 'service_fee', amount_paise: '120000', expense_status: 'submitted' }),
      ]);
      expect(applied.fees.map((f) => [f.costKind, f.amountPaise, f.expenseStatus]).sort()).toEqual([['government_fee', '650000', 'submitted'], ['service_fee', '120000', 'submitted']]);
      // Audit per applicant and per entry, existing cost names; no amounts or references.
      const [appliedAudit] = await audits('visa.application_applied', a.applicationId);
      expect(appliedAudit!.details).toMatchObject({ taskId, seq: 1, clubId: null, visaKind: 'sticker', passportTaken: true, paidBy: 'company' });
      expect(await owner(`select count(*)::int as n from public.audit_events where action = 'department.cost_saved' and target_id = any($1::uuid[])`, [result.entryIds])).toEqual([{ n: 2 }]);
      expect(await owner(`select count(*)::int as n from public.audit_events where action = 'department.cost_submitted' and target_id = any($1::uuid[])`, [result.entryIds])).toEqual([{ n: 2 }]);
      expect(JSON.stringify(await owner(`select details, reason from public.audit_events where action like 'visa.%' or action like 'department.cost_%'`)))
        .not.toMatch(/650000|120000|VFS-SYN-0001/);
    });
  });

  it('company without receipt -> draft (VL2); customer_direct -> no expense status; service fee optional; government fee required > 0', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const a1 = await makeReady(taskId, 1);
      await apply(taskId, [line(a1)]);
      const a2 = await makeReady(taskId, 2);
      await apply(taskId, [line(a2, { governmentFeePaise: '70000' })], { paidBy: 'customer_direct' });
      const rows = await entries(taskId);
      expect(rows.filter((r) => r.application_id === a1.applicationId).map((r) => [r.cost_kind, r.expense_status, r.receipt_evidence_id]))
        .toEqual([['government_fee', 'draft', null]]);
      expect(rows.filter((r) => r.application_id === a2.applicationId).map((r) => [r.cost_kind, r.paid_by, r.expense_status, r.payment_mode]))
        .toEqual([['government_fee', 'customer_direct', null, null]]);
      const a3 = await makeReady(taskId, 3);
      // Lead decision (8 Nov 2026): applicant hints are 0-based (applicants[0] = first passenger).
      for (const [over, hint] of [
        [{ governmentFeePaise: '0' }, /applicants\[0\]\.governmentFeePaise/],
        [{ governmentFeePaise: null }, /applicants\[0\]\.governmentFeePaise/],
        [{ governmentFeePaise: '12.50' }, /applicants\[0\]\.governmentFeePaise/],
        [{ serviceFeePaise: '0' }, /applicants\[0\]\.serviceFeePaise/],
        [{ reference: '   ' }, /applicants\[0\]\.reference/],
        [{ reference: 'x'.repeat(121) }, /applicants\[0\]\.reference/],
        [{ appliedOn: '1999-12-31' }, /applicants\[0\]\.appliedOn/],
        [{ appliedOn: '2026-13-01' }, /applicants\[0\]\.appliedOn/],
      ] as Array<[Record<string, unknown>, RegExp]>) {
        await refusedHint(VISA_A, SQL.apply, [taskId, JSON.stringify({ applicants: [line(a3, over)], paidBy: 'company', paymentMode: 'upi' }), rid()], 'invalid_input', hint);
      }
      await refusedHint(VISA_A, SQL.apply, [taskId, JSON.stringify({ applicants: [line(a3)], paidBy: 'company' }), rid()], 'invalid_input', /paymentMode/);
      await refusedHint(VISA_A, SQL.apply, [taskId, JSON.stringify({ applicants: [line(a3)], paidBy: 'friend' }), rid()], 'invalid_input', /paidBy/);
      await refusedHint(VISA_A, SQL.apply, [taskId, JSON.stringify({ applicants: [], paidBy: 'customer_direct' }), rid()], 'invalid_input', /applicants/);
      await refusedHint(VISA_A, SQL.apply, [taskId, JSON.stringify({ applicants: [line(a3)], paidBy: 'company', paymentMode: 'upi', receiptEvidenceId: rid() }), rid()],
        'invalid_input', /receiptEvidenceId/);
      // An applicant decision proof is not a fee receipt.
      const proof = await evidence(VISA_A, taskId, 'authority_outcome', a3.applicationId);
      await refusedHint(VISA_A, SQL.apply, [taskId, JSON.stringify({ applicants: [line(a3)], paidBy: 'company', paymentMode: 'upi', receiptEvidenceId: proof }), rid()],
        'invalid_input', /receiptEvidenceId/);
      await refusedHint(VISA_A, SQL.apply, [taskId, JSON.stringify({ applicants: [line(a3)], paidBy: 'customer_direct' }), null], 'invalid_input', /requestId/);
    });
  });

  it('applied date: today allowed, tomorrow applied_date_in_future (V11); passportTaken only for sticker visas', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const a = await makeReady(taskId, 1);
      await refused(VISA_A, SQL.apply, [taskId, JSON.stringify({ applicants: [line(a, { appliedOn: dayFrom(1) })], paidBy: 'customer_direct' }), rid()],
        'applied_date_in_future', '22023');
      await apply(taskId, [line(a, { appliedOn: dayFrom(-3) })], { paidBy: 'customer_direct' });
      expect(await appRow(a.applicationId)).toMatchObject({ applied_on: expect.anything() });
      expect((await app(taskId, 1)).applied?.appliedOn).toBe(dayFrom(-3));
    });
    await asOwner(db, async () => {
      const p = await book({ items: [{ type: 'passport', facts: PASSPORT }] });
      const taskId = p.tasks[0]!;
      await one(VISA_A, SQL.claim, [taskId]);
      let a = await app(taskId, 1);
      await one(VISA_A, SQL.docAdd, [a.applicationId, a.rowVersion, JSON.stringify({ catalogueCode: 'old_passports', received: true }), rid()]);
      a = await makeReady(taskId, 1);
      await refusedHint(VISA_A, SQL.apply, [taskId, JSON.stringify({ applicants: [line(a)], paidBy: 'customer_direct', passportTaken: true }), rid()],
        'invalid_input', /passportTaken/);
      await apply(taskId, [line(a)], { paidBy: 'customer_direct' });
      expect(await appRow(a.applicationId)).toMatchObject({ state: 'decision_pending', visa_kind: null, jurisdiction_required: null, passport_taken_at: null });
    });
  });

  it('kind unknown: Applied needs the shared visaKind; jurisdiction for a sticker with Sales blank', async () => {
    await asOwner(db, async () => {
      const b = await book({ items: [{ type: 'visa', facts: BLANK_KIND }] });
      const taskId = b.tasks[0]!;
      await one(VISA_A, SQL.claim, [taskId]);
      const a = await makeReady(taskId, 1);
      await refusedHint(VISA_A, SQL.apply, [taskId, JSON.stringify({ applicants: [line(a)], paidBy: 'customer_direct' }), rid()], 'invalid_input', /visaKind/);
      await refusedHint(VISA_A, SQL.apply, [taskId, JSON.stringify({ applicants: [line(a)], paidBy: 'customer_direct', visaKind: 'sticker', jurisdiction: 'yes' }), rid()],
        'invalid_input', /jurisdictionPlace/);
      await apply(taskId, [line(a)], { paidBy: 'customer_direct', visaKind: 'sticker', jurisdiction: 'yes', jurisdictionPlace: 'Mumbai' });
      expect(await appRow(a.applicationId)).toMatchObject({ visa_kind: 'sticker', jurisdiction_required: true, jurisdiction_place: 'Mumbai' });
    });
  });
});

describe('C5 clubbed', () => {
  it('three applicants in one transaction: one club id, size 3, per-passenger exact fees never split, one receipt on all entries', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const ready = [];
      for (const seq of [1, 2, 3]) ready.push(await makeReady(taskId, seq));
      const receipt = await evidence(VISA_A, taskId, 'fee_receipt');
      const result = await apply(taskId, [
        line(ready[0]!, { reference: 'CLUB-1', governmentFeePaise: '650000', serviceFeePaise: '100000' }),
        line(ready[1]!, { reference: 'CLUB-2', governmentFeePaise: '650000', serviceFeePaise: '100000' }),
        line(ready[2]!, { reference: 'CLUB-3', governmentFeePaise: '325000', serviceFeePaise: null }),
      ], { receiptEvidenceId: receipt, passportTaken: true });
      expect(result.clubId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.applications.map((x) => x.state)).toEqual(['decision_pending', 'decision_pending', 'decision_pending']);
      expect(result.entryIds).toHaveLength(5);
      const rows = await owner<{ club_id: string; club_size: number }>('select club_id, club_size from public.visa_applications where task_id = $1 and club_id is not null', [taskId]);
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r) => r.club_id))).toEqual(new Set([result.clubId]));
      expect(rows.every((r) => r.club_size === 3)).toBe(true);
      const all = await entries(taskId);
      expect(all.map((e) => e.amount_paise).sort()).toEqual(['100000', '100000', '325000', '650000', '650000']);
      expect(new Set(all.map((e) => e.receipt_evidence_id))).toEqual(new Set([receipt]));
      expect(all.every((e) => e.expense_status === 'submitted')).toBe(true);
      const third = await app(taskId, 3);
      expect(third.applied).toMatchObject({ reference: 'CLUB-3', clubId: result.clubId });
      expect(third.applied!.clubWith).toEqual(['Synthetic Traveller One', 'Synthetic Traveller Two']);
      expect((await audits('visa.application_applied')).map((x) => x.details)).toEqual(Array(3).fill(expect.objectContaining({ clubId: result.clubId, clubSize: 3 })));
    });
  });

  it('any refusal saves nothing: no partial applicants or entries (not_ready, version, duplicate references, future date)', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const a1 = await makeReady(taskId, 1);
      const a2 = await makeReady(taskId, 2);
      const notReady = await app(taskId, 3);
      const nothingSaved = async () => {
        expect(await owner(`select count(*)::int as n from public.visa_applications where task_id = $1 and state <> 'docs_pending'`, [taskId])).toEqual([{ n: 0 }]);
        expect(await owner('select count(*)::int as n from public.department_cost_entries where task_id = $1', [taskId])).toEqual([{ n: 0 }]);
      };
      const club = (lines: unknown[]) => [taskId, JSON.stringify({ applicants: lines, paidBy: 'customer_direct' }), rid()];
      await refusedHint(VISA_A, SQL.apply, club([line(a1), line(a2), line(notReady)]), 'not_ready', /^applicants\[2\]:documents_missing$/);
      await refused(VISA_A, SQL.apply, club([line(a1), line(a2, { expectedRowVersion: a2.rowVersion - 1 })]), 'version_changed', CONFLICT_STATE);
      await refusedHint(VISA_A, SQL.apply, club([line(a1, { reference: 'SAME-1' }), line(a2, { reference: 'same-1' })]), 'duplicate_reference', /applicants\[1\]\.reference/); // 0-based hints (lead decision 8 Nov)
      await refused(VISA_A, SQL.apply, club([line(a1), line(a2, { appliedOn: dayFrom(1) })]), 'applied_date_in_future', '22023');
      await refusedHint(VISA_A, SQL.apply, club([line(a1), line(a1)]), 'invalid_input');
      await nothingSaved();
      // Against another passenger already applied, and against a superseded application (QB10).
      await apply(taskId, [line(a1, { reference: 'TAKEN-1' })], { paidBy: 'customer_direct' });
      await refusedHint(VISA_A, SQL.apply, club([line(a2, { reference: ' taken-1 ' })]), 'duplicate_reference', /applicants\[0\]\.reference/);
      const one1 = await app(taskId, 1);
      const rejected = await h.decide(taskId, one1, 'rejected');
      expect(rejected.state).toBe('refused');
      await one(VISA_A, SQL.reapply, [one1.applicationId, rejected.rowVersion, rid()]);
      const second = await makeReady(taskId, 1);
      expect(second.secondApplication).toBe(true);
      await refused(VISA_A, SQL.apply, [taskId, JSON.stringify({ applicants: [line(second, { reference: 'TAKEN-1' })], paidBy: 'customer_direct' }), rid()],
        'duplicate_reference', '23505');
      await apply(taskId, [line(second, { reference: 'TAKEN-1-B' })], { paidBy: 'customer_direct' });
    });
  });

  it('wrong_state for an applied applicant; applicant from another task refused; 100 at most', async () => {
    await asOwner(db, async () => {
      const b = await book({ items: [{ type: 'visa', facts: STICKER }, { type: 'visa', facts: { ...STICKER, country: 'Germany' } }] });
      const [t1, t2] = b.tasks as [string, string];
      await one(VISA_A, SQL.claim, [t1]);
      await one(VISA_A, SQL.claim, [t2]);
      const a = await makeReady(t1, 1);
      await apply(t1, [line(a)], { paidBy: 'customer_direct' });
      const applied = await app(t1, 1);
      await refused(VISA_A, SQL.apply, [t1, JSON.stringify({ applicants: [line(applied, { reference: 'OTHER' })], paidBy: 'customer_direct' }), rid()], 'wrong_state', '55000');
      const other = await makeReady(t2, 1);
      await refusedHint(VISA_A, SQL.apply, [t1, JSON.stringify({ applicants: [line(other)], paidBy: 'customer_direct' }), rid()], 'invalid_input');
    });
  });
});

describe('C5 idempotency', () => {
  it('same request id + same payload -> one effect (outcome existing); same id + other payload -> duplicate_request', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const a = await makeReady(taskId, 1);
      const req = rid();
      const fields = JSON.stringify({ applicants: [line(a, { reference: 'REPLAY-1' })], paidBy: 'company', paymentMode: 'upi', receiptEvidenceId: null, remark: null });
      const first = await one<Record<string, unknown>>(VISA_A, SQL.apply, [taskId, fields, req]);
      const again = await one<Record<string, unknown>>(VISA_A, SQL.apply, [taskId, fields, req]);
      expect(again).toMatchObject({ ...first, outcome: 'existing' });
      expect(await owner('select count(*)::int as n from public.department_cost_entries where task_id = $1', [taskId])).toEqual([{ n: 1 }]);
      expect(await audits('visa.application_applied')).toHaveLength(1);
      await refused(VISA_A, SQL.apply, [taskId, JSON.stringify({ applicants: [line(a, { reference: 'REPLAY-2' })], paidBy: 'company', paymentMode: 'upi', receiptEvidenceId: null, remark: null }), req],
        'duplicate_request', CONFLICT_STATE);
    });
  });
});
