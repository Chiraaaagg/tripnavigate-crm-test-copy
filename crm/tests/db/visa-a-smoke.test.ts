import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACC } from './finance-support';
import { DEAL, MANAGER, OWNER, PURCHASE, SALES_B, SUPER, TRAVELLERS } from './b1-support';
import { DESK, PASSPORT, SETTING_SQL_B11, SWITCH_REASON, VISA, VISA_CLAIM_SQL, b11Helpers, rid } from './b11-support';

/**
 * Track A smoke checks for the Visa and Passport desk build (migrations
 * 20261202000100..0120): schema shape, the passenger row, documents, clubbed
 * Applied with fees, decision / handover / closure, re-application, notices,
 * completion, reads, revision sync. Synthetic data only.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one, refused, owner, deskTask, deskEvidence } = h;

const QUEUE = 'select public.visa_queue() as r';
const WS = 'select public.visa_workspace($1) as r';
const ROW = 'select public.visa_application_set_row($1, $2, $3::jsonb, $4) as r';
const DOC_ADD = 'select public.visa_application_document_add($1, $2, $3::jsonb, $4) as r';
const DOC_REMOVE = 'select public.visa_application_document_remove($1, $2, $3) as r';
const APPLY = 'select public.visa_applications_apply($1, $2::jsonb, $3) as r';
const DECIDE = 'select public.visa_application_decide($1, $2, $3::jsonb, $4) as r';
const HANDOVER = 'select public.visa_application_set_handover($1, $2, $3::jsonb, $4) as r';
const DELIVER = 'select public.visa_application_mark_delivered($1, $2, $3::jsonb, $4) as r';
const WITHDRAW = 'select public.visa_application_withdraw($1, $2, $3::jsonb, $4) as r';
const REAPPLY = 'select public.visa_application_reapply($1, $2, $3) as r';
const FILE_BEGIN = 'select public.visa_document_file_begin($1, $2, $3, $4, $5) as r';
const FEE_SEND = 'select public.visa_fee_send($1, $2, $3::jsonb, $4) as r';
const CONFIRM_TRAVELLER = 'select public.visa_application_confirm_traveller($1, $2, $3) as r';
const EV_BEGIN = 'select public.department_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r';
const NOTICE_ACK = 'select public.visa_result_notice_ack($1) as r';
const SUMMARY = 'select public.deal_visa_summary($1) as r';
const HISTORY = 'select public.deal_visa_history($1) as r';
const HOME = 'select public.visa_home_counts() as r';
const TASK_HISTORY = 'select public.department_task_history($1) as r';
const COST_SAVE = 'select public.department_cost_save($1, $2, $3, $4::jsonb, $5) as r';
const EXPENSES = 'select public.accounts_expense_records($1, $2, $3) as r';
const EXPENSE_RETURN = 'select public.expense_record_return($1, $2, $3, $4) as r';
const EXPENSE_ACCEPT = 'select public.expense_record_accept($1, $2, $3) as r';

type Doc = { documentId: string; label: string; status: string; catalogueCode: string | null; source: string };
type Applicant = {
  applicationId: string; seq: number; fullName: string | null; rowVersion: number; state: string; ready: boolean; notReady: string[];
  removed: boolean; documents: Doc[]; passport: { number: string | null } | null; closed: { reason: string } | null;
  can: Record<string, boolean>; fees: Array<{ entryId: string; costKind: string; amountPaise: string; expenseStatus: string | null; rowVersion: number }>;
  visaKind: { value: string | null; source: string | null }; travellerChanged: unknown; secondApplication: boolean;
};
type Workspace = {
  applicants: Applicant[]; isManagerView: boolean; canWork: boolean; status: { code: string; step: string | null; text: string };
  steps: Array<{ key: string; met: number; of: number; done: boolean }>; bookingChange: Record<string, unknown> | null;
  previousApplications: unknown[]; catalogue: unknown[]; costSummary: Record<string, unknown>;
};

/** Replaces the confirmed visa facts of the Deal's visa item (Track C keys), owner only, triggers off. */
async function setVisaFacts(extra: Record<string, unknown>) {
  await owner(`set local session_replication_role = replica`);
  await owner(
    `update public.service_item_facts f set facts = f.facts || $1::jsonb
     from public.service_items i where i.id = f.service_item_id and i.deal_id = $2 and i.service_type = 'visa'`,
    [JSON.stringify(extra), DEAL],
  );
  await owner(`set local session_replication_role = origin`);
}

const ws = (actor: typeof DESK, taskId: string) => one<Workspace>(actor, WS, [taskId]);
const app = async (taskId: string, seq: number) => (await ws(DESK, taskId)).applicants.find((a) => a.seq === seq && !a.removed)!;

describe('visa desk schema', () => {
  it('new tables have RLS and no grants; old commands revoked; partial seq index replaces the unique constraint', async () => {
    const rows = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname in ('visa_application_documents', 'visa_result_notices') order by relname`);
    expect(rows).toEqual([{ relname: 'visa_application_documents', relrowsecurity: true }, { relname: 'visa_result_notices', relrowsecurity: true }]);
    const grants = await db.query(`select table_name, grantee from information_schema.role_table_grants
      where table_name in ('visa_application_documents', 'visa_result_notices') and grantee in ('anon', 'authenticated', 'service_role')`);
    expect(grants).toEqual([]);
    const exec = await db.query<{ f: string; ok: boolean }>(
      `select p.proname as f, has_function_privilege('authenticated', p.oid, 'execute') as ok
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('visa_application_update', 'visa_application_set_state', 'visa_applications_apply', 'visa_workspace')
       order by p.proname`);
    expect(exec).toEqual([
      { f: 'visa_application_set_state', ok: false }, { f: 'visa_application_update', ok: false },
      { f: 'visa_applications_apply', ok: true }, { f: 'visa_workspace', ok: true },
    ]);
    const definer = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'visa\\_%' and (not p.prosecdef or not (p.proconfig @> array['search_path=""']))`);
    expect(definer).toEqual([{ n: 0 }]);
    expect(await db.query(`select conname from pg_constraint where conname = 'visa_applications_task_id_traveller_seq_key'`)).toEqual([]);
    expect(await db.query(`select indexname from pg_indexes where indexname = 'visa_applications_current_seq_key'`)).toHaveLength(1);
    expect(await db.query<{ n: number }>(`select count(*)::int as n from authz.visa_document_catalogue()`)).toEqual([{ n: 25 }]);
  });
});

describe('sticker visa journey', () => {
  it('claim seeds documents; row, documents, clubbed Applied with fees; decisions, handover, re-application, notices, completion', async () => {
    await asOwner(db, async () => {
      const { taskId } = await deskTask(TRAVELLERS.slice(0, 2));
      await setVisaFacts({ visaKind: 'sticker', jurisdiction: 'yes', jurisdictionPlace: 'New Delhi',
        documentsNeeded: ['passport copy (front and back)', 'Own  letter'] });
      // Manager reads but never takes.
      const mq = await one<{ isManagerView: boolean; canTake: boolean; tasks: Array<{ taskId: string; status: { code: string } }> }>(MANAGER, QUEUE);
      expect(mq).toMatchObject({ isManagerView: true, canTake: false });
      expect(mq.tasks.map((t) => [t.taskId, t.status.code])).toEqual([[taskId, 'not_taken']]);
      await refused(MANAGER, VISA_CLAIM_SQL, [taskId], '42501', 'not_authorized');
      expect(await one(PURCHASE, WS, [taskId])).toBeNull();
      expect(await one(OWNER, WS, [taskId])).toBeNull();

      expect(await one(DESK, VISA_CLAIM_SQL, [taskId])).toMatchObject({ applicationCount: 2, alreadyYours: false });
      let w = await ws(DESK, taskId);
      expect(w.status).toEqual({ code: 'in_progress', step: 'ready', text: 'Documents and date pending' });
      expect(w.applicants.map((a) => a.documents.map((d) => [d.label, d.catalogueCode, d.source]))).toEqual([
        [['passport copy (front and back)', 'passport_copy', 'sales'], ['Own letter', null, 'sales']],
        [['passport copy (front and back)', 'passport_copy', 'sales'], ['Own letter', null, 'sales']],
      ]);
      expect(w.applicants[0]!.notReady).toEqual(['documents_missing', 'appointment_missing']);
      expect(w.applicants[0]!.passport).toMatchObject({ number: 'Z1000001' });
      expect(w.catalogue).toHaveLength(25);
      const mw = await ws(MANAGER, taskId);
      expect(mw.isManagerView).toBe(true);
      expect(mw.applicants.every((a) => a.passport === null && Object.values(a.can).every((v) => v === false))).toBe(true);
      expect(mw.catalogue).toEqual([]);

      // Passenger rows.
      for (const seq of [1, 2]) {
        const a = await app(taskId, seq);
        const r = await one<{ ready: boolean; rowVersion: number }>(DESK, ROW, [a.applicationId, a.rowVersion, JSON.stringify({
          appointmentDate: '2026-11-01', appointmentTime: '10:30',
          documents: a.documents.map((d) => ({ documentId: d.documentId, received: true })),
          ...(seq === 1 ? { passportNumber: 'p 98-76543' } : {}),
        }), rid()]);
        expect(r.ready).toBe(true);
      }
      expect(await owner(`select x.passport_number from public.traveller_identities x join public.deal_travellers t on t.id = x.traveller_id
        where t.deal_id = $1 and t.seq = 1`, [DEAL])).toEqual([{ passport_number: 'P9876543' }]);
      let a1 = await app(taskId, 1);
      await h.refusedWithHint(DESK, ROW, [a1.applicationId, a1.rowVersion, JSON.stringify({ visaKind: 'e_visa' }), rid()], /^visaKind$/);
      await h.refusedWithHint(DESK, ROW, [a1.applicationId, a1.rowVersion, JSON.stringify({ appointmentDate: null, appointmentTime: '10:00' }), rid()], /appointmentTime/);
      // Documents: Other, duplicate by label key, remove a not-received one, never a received one.
      let d = await one<{ documentId: string; rowVersion: number; ready: boolean }>(DESK, DOC_ADD,
        [a1.applicationId, a1.rowVersion, JSON.stringify({ label: 'Hotel  booking' }), rid()]);
      expect(d.ready).toBe(false);
      await refused(DESK, DOC_ADD, [a1.applicationId, d.rowVersion, JSON.stringify({ catalogueCode: 'stay_proof' }), rid()], '23505', 'duplicate_document');
      await refused(DESK, DOC_REMOVE, [a1.documents[0]!.documentId, d.rowVersion, rid()], '55000', 'document_received');
      d = await one(DESK, DOC_REMOVE, [d.documentId, d.rowVersion, rid()]);
      expect(d.ready).toBe(true);
      // An uploaded document file is linked to its document.
      a1 = await app(taskId, 1);
      const f = await one<{ evidenceId: string }>(DESK, FILE_BEGIN, [a1.documents[0]!.documentId, 'pp.pdf', 'application/pdf', 100, 'c'.repeat(64)]);
      expect(await owner('select visa_document_id, application_id from public.department_evidence where id = $1', [f.evidenceId]))
        .toEqual([{ visa_document_id: a1.documents[0]!.documentId, application_id: a1.applicationId }]);

      // Clubbed Applied with one receipt for both.
      const receipt = await deskEvidence(DESK, taskId, 'fee_receipt');
      const a2 = await app(taskId, 2);
      const applicants = [
        { applicationId: a1.applicationId, expectedRowVersion: a1.rowVersion, reference: 'REF-SYN-1', appliedOn: '2026-11-02', governmentFeePaise: '500000', serviceFeePaise: '100000' },
        { applicationId: a2.applicationId, expectedRowVersion: a2.rowVersion, reference: 'ref-syn-1', appliedOn: '2026-11-02', governmentFeePaise: '500000' },
      ];
      const shared = { passportTaken: true, paidBy: 'company', paymentMode: 'upi', receiptEvidenceId: receipt };
      await refused(DESK, APPLY, [taskId, JSON.stringify({ applicants, ...shared }), rid()], '23505', 'duplicate_reference');
      applicants[1]!.reference = 'REF-SYN-2';
      await refused(DESK, APPLY, [taskId, JSON.stringify({ applicants: [{ ...applicants[0], appliedOn: '2099-01-01' }], ...shared }), rid()], '22023', 'applied_date_in_future');
      const req = rid();
      const applied = await one<{ clubId: string; entryIds: string[]; applications: Array<{ state: string }> }>(DESK, APPLY,
        [taskId, JSON.stringify({ applicants, ...shared }), req]);
      expect(applied.clubId).toBeTruthy();
      expect(applied.entryIds).toHaveLength(3);
      expect(applied.applications.map((x) => x.state)).toEqual(['decision_pending', 'decision_pending']);
      expect(await one(DESK, APPLY, [taskId, JSON.stringify({ applicants, ...shared }), req])).toMatchObject({ outcome: 'existing', clubId: applied.clubId });
      await refused(DESK, APPLY, [taskId, JSON.stringify({ applicants, ...shared, remark: 'other' }), req], '40001', 'duplicate_request');
      expect(await owner(`select application_id is not null as linked, expense_status, amount_paise::text as a from public.department_cost_entries
        where task_id = $1 order by amount_paise, cost_kind`, [taskId])).toEqual([
        { linked: true, expense_status: 'submitted', a: '100000' },
        { linked: true, expense_status: 'submitted', a: '500000' }, { linked: true, expense_status: 'submitted', a: '500000' }]);
      w = await ws(DESK, taskId);
      expect(w.status.step).toBe('decision');
      expect(w.applicants[0]!.visaKind).toEqual({ value: 'sticker', source: 'applied' });

      // Accounts sees the applicant name only.
      const exp = await one<{ items: Array<{ applicantName: string | null }> }>(ACC, EXPENSES, ['submitted', null, 50]);
      expect(exp.items.map((i) => i.applicantName).sort()).toEqual(['Synthetic Traveller One', 'Synthetic Traveller One', 'Synthetic Traveller Two']);

      // Decisions: proof required; courier closes; rejection leaves passport handover open.
      a1 = await app(taskId, 1);
      await refused(DESK, DECIDE, [a1.applicationId, a1.rowVersion, JSON.stringify({ decision: 'approved' }), rid()], '55000', 'outcome_document_required');
      const proof1 = await deskEvidence(DESK, taskId, 'authority_outcome', a1.applicationId);
      await h.refusedWithHint(DESK, DECIDE, [a1.applicationId, a1.rowVersion, JSON.stringify({ decision: 'approved', outcomeEvidenceId: proof1, handover: { method: 'courier' } }), rid()], /handover\.courierNumber/);
      let r = await one<{ closed: boolean; taskCompleted: boolean }>(DESK, DECIDE, [a1.applicationId, a1.rowVersion,
        JSON.stringify({ decision: 'approved', outcomeEvidenceId: proof1, handover: { method: 'courier', courierNumber: 'SYN-CR-1' } }), rid()]);
      expect(r).toMatchObject({ closed: true, taskCompleted: false });
      let b = await app(taskId, 2);
      const proof2 = await deskEvidence(DESK, taskId, 'authority_outcome', b.applicationId);
      r = await one(DESK, DECIDE, [b.applicationId, b.rowVersion, JSON.stringify({ decision: 'rejected', outcomeEvidenceId: proof2, reason: 'Synthetic refusal' }), rid()]);
      expect(r.closed).toBe(false);
      // Re-application: new row, documents copied, custody carried, old superseded and closed.
      b = await app(taskId, 2);
      const re = await one<{ applicationId: string; previousApplicationId: string }>(DESK, REAPPLY, [b.applicationId, b.rowVersion, rid()]);
      expect(re.previousApplicationId).toBe(b.applicationId);
      expect(await owner(`select closed_reason, superseded_by_id from public.visa_applications where id = $1`, [b.applicationId]))
        .toEqual([{ closed_reason: 'reapplied', superseded_by_id: re.applicationId }]);
      w = await ws(DESK, taskId);
      let second = w.applicants.find((x) => x.seq === 2)!;
      expect(second).toMatchObject({ secondApplication: true, state: 'docs_pending', notReady: ['appointment_missing'] });
      expect(second.documents.every((x) => x.status === 'received' && x.source === 'copied')).toBe(true);
      expect(w.previousApplications).toHaveLength(1);
      await one(DESK, ROW, [second.applicationId, second.rowVersion, JSON.stringify({ appointmentDate: '2026-11-03' }), rid()]);
      second = await app(taskId, 2);
      // A re-application needs a new reference (superseded rows count).
      const again = [{ applicationId: second.applicationId, expectedRowVersion: second.rowVersion, reference: 'ref-syn-2', appliedOn: '2026-11-03', governmentFeePaise: '500000' }];
      await refused(DESK, APPLY, [taskId, JSON.stringify({ applicants: again, paidBy: 'customer_direct' }), rid()], '23505', 'duplicate_reference');
      again[0]!.reference = 'REF-SYN-3';
      await one(DESK, APPLY, [taskId, JSON.stringify({ applicants: again, paidBy: 'customer_direct' }), rid()]);
      b = await app(taskId, 2);
      const proof3 = await deskEvidence(DESK, taskId, 'authority_outcome', b.applicationId);
      r = await one(DESK, DECIDE, [b.applicationId, b.rowVersion, JSON.stringify({ decision: 'approved', outcomeEvidenceId: proof3 }), rid()]);
      expect(r.closed).toBe(false);
      b = await app(taskId, 2);
      r = await one(DESK, HANDOVER, [b.applicationId, b.rowVersion, JSON.stringify({ method: 'office' }), rid()]);
      expect(r.closed).toBe(false);
      b = await app(taskId, 2);
      await refused(DESK, HANDOVER, [b.applicationId, b.rowVersion, JSON.stringify({ method: 'office' }), rid()], '55000', 'already_recorded');
      await refused(DESK, DELIVER, [b.applicationId, b.rowVersion, JSON.stringify({ deliveredOn: '2099-01-01' }), rid()], '22023', 'delivered_date_in_future');
      r = await one(DESK, DELIVER, [b.applicationId, b.rowVersion, JSON.stringify({ deliveredOn: '2026-11-05' }), rid()]);
      expect(r).toMatchObject({ closed: true, taskCompleted: true });
      expect(await owner('select status from public.fulfilment_tasks where id = $1', [taskId])).toEqual([{ status: 'completed' }]);

      // Notices: one per application outcome, for the Sales owner only.
      const s = await one<{ tasks: Array<{ approved: number }>; notices: Array<{ noticeId: string; outcome: string; canAck: boolean }> }>(OWNER, SUMMARY, [DEAL]);
      expect(s.notices.map((n) => n.outcome).sort()).toEqual(['approved', 'approved', 'rejected']);
      expect(s.tasks[0]!.approved).toBe(2);
      expect((await one<{ notices: unknown[] } | null>(SALES_B, SUMMARY, [DEAL]))?.notices ?? []).toEqual([]);
      expect(await one(PURCHASE, SUMMARY, [DEAL])).toBeNull();
      expect(await one(ACC, SUMMARY, [DEAL])).toBeNull();
      expect(await one(OWNER, HOME)).toMatchObject({ salesVisaResultsToSee: 3 });
      expect(await one(OWNER, NOTICE_ACK, [s.notices[0]!.noticeId])).toMatchObject({ outcome: 'updated' });
      expect(await one(OWNER, NOTICE_ACK, [s.notices[0]!.noticeId])).toMatchObject({ outcome: 'existing' });
      await refused(SALES_B, NOTICE_ACK, [s.notices[1]!.noticeId], '42501', 'not_authorized');
      // Deal history: club collapsed; no money, references or e-mails.
      const hist = await one<{ events: Array<{ kind: string; note: string | null }> }>(OWNER, HISTORY, [DEAL]);
      expect(hist.events.filter((e) => e.kind === 'applied').map((e) => e.note)).toEqual([null, 'Applied together: 2 travellers']);
      expect(JSON.stringify(hist)).not.toMatch(/REF-SYN|500000|SYN-CR/);
      expect(await one(SALES_B, HISTORY, [DEAL])).toBeNull();
      // Task history kinds (Manager reads too).
      const th = await one<{ events: Array<{ kind: string; applicantSeq: number | null; clubSize: number | null }> }>(MANAGER, TASK_HISTORY, [taskId]);
      for (const k of ['applied', 'approved', 'rejected', 'reapplied', 'handover_set', 'delivered', 'applicant_closed', 'applicant_row_saved', 'document_added', 'document_removed']) {
        expect(th.events.some((e) => e.kind === k)).toBe(true);
      }
      expect(th.events.find((e) => e.kind === 'applied' && e.clubSize === 2)).toBeTruthy();
      const audit = await owner<{ d: string }>(`select details::text || coalesce(reason, '') as d from public.audit_events where action like 'visa.%'`);
      expect(audit.map((x) => x.d).join(' ')).not.toMatch(/REF-SYN|P9876543|Synthetic Traveller|500000/);
    });
  });
});

describe('e-visa, fees and booking changes', () => {
  it('desk picks E-visa; applied without appointment; approval with typed e-mail closes; draft fee sent with receipt', async () => {
    await asOwner(db, async () => {
      const { taskId } = await deskTask(TRAVELLERS.slice(0, 1));
      await setVisaFacts({ documentsNeeded: ['Photo, white background'] });
      await one(DESK, VISA_CLAIM_SQL, [taskId]);
      let a = await app(taskId, 1);
      expect(a.notReady).toEqual(['documents_missing', 'appointment_missing', 'kind_missing']);
      await one(DESK, ROW, [a.applicationId, a.rowVersion, JSON.stringify({ visaKind: 'e_visa', documents: [{ documentId: a.documents[0]!.documentId, received: true }] }), rid()]);
      a = await app(taskId, 1);
      expect(a).toMatchObject({ ready: true, visaKind: { value: 'e_visa', source: 'desk' } });
      // Manual task-level visa cost refused; an "other" cost per passenger allowed.
      await h.refusedWithHint(DESK, COST_SAVE, [taskId, null, null, JSON.stringify({ costKind: 'government_fee', amountPaise: '100', paidBy: 'company', paymentMode: 'upi', paidOn: '2026-11-01' }), rid()], /^visaFees$/);
      expect(await one(DESK, COST_SAVE, [taskId, null, null, JSON.stringify({ applicationId: a.applicationId, costKind: 'other', amountPaise: '25000', paidBy: 'customer_direct', paidOn: '2026-11-01' }), rid()]))
        .toMatchObject({ expenseStatus: null });
      await one(DESK, APPLY, [taskId, JSON.stringify({ applicants: [{ applicationId: a.applicationId, expectedRowVersion: a.rowVersion, reference: 'EV-SYN-1', appliedOn: '2026-11-02', governmentFeePaise: '300000' }], paidBy: 'company', paymentMode: 'card' }), rid()]);
      a = await app(taskId, 1);
      const fee = a.fees.find((x) => x.costKind === 'government_fee')!;
      expect(fee.expenseStatus).toBe('draft');
      expect(await one(DESK, HOME)).toMatchObject({ visaFeesWithoutReceipt: 1, visaFeesWithoutReceiptTaskId: taskId, visaApplicantsWaitingResult: 1 });
      await refused(DESK, FEE_SEND, [fee.entryId, fee.rowVersion, JSON.stringify({}), rid()], '55000', 'receipt_required');
      const receipt = await deskEvidence(DESK, taskId, 'fee_receipt');
      let sent = await one<{ rowVersion: number; expenseStatus: string }>(DESK, FEE_SEND, [fee.entryId, fee.rowVersion, JSON.stringify({ receiptEvidenceId: receipt }), rid()]);
      expect(sent.expenseStatus).toBe('submitted');
      await refused(DESK, FEE_SEND, [fee.entryId, sent.rowVersion, JSON.stringify({}), rid()], '55000', 'cost_locked');
      const ret = await one<{ rowVersion: number }>(ACC, EXPENSE_RETURN, [fee.entryId, sent.rowVersion, 'Synthetic: the amount is wrong', rid()]);
      sent = await one(DESK, FEE_SEND, [fee.entryId, ret.rowVersion, JSON.stringify({ amountPaise: '310000' }), rid()]);
      expect(await one(ACC, EXPENSE_ACCEPT, [fee.entryId, sent.rowVersion, rid()])).toMatchObject({ status: 'accepted' });
      // E-visa approval with the typed e-mail closes and completes.
      const proof = await deskEvidence(DESK, taskId, 'authority_outcome', a.applicationId);
      await h.refusedWithHint(DESK, DECIDE, [a.applicationId, a.rowVersion, JSON.stringify({ decision: 'approved', outcomeEvidenceId: proof }), rid()], /recipientEmail/);
      const r = await one(DESK, DECIDE, [a.applicationId, a.rowVersion, JSON.stringify({ decision: 'approved', outcomeEvidenceId: proof, recipientEmail: 'cust@example.test' }), rid()]);
      expect(r).toMatchObject({ closed: true, taskCompleted: true });
      const mw = await ws(MANAGER, taskId);
      expect(mw.applicants[0]).toMatchObject({ closed: { reason: 'evisa_sent' } });
      expect(JSON.stringify(await one(OWNER, SUMMARY, [DEAL]))).not.toMatch(/cust@example/);
    });
  });

  it('withdraw closes; a revision flags removed passengers (no withdrawal) and adds new ones with a booking change line', async () => {
    await asOwner(db, async () => {
      const TWO = TRAVELLERS.slice(0, 2);
      const ready = await h.readyDraft(OWNER, DEAL, [['visa', VISA]], { identities: true, travellers: TWO });
      const p1 = await h.saveParticipation(OWNER, ready.itemIds[0]!, ready.versionId, ready.rowVersion, [1]);
      await h.confirm(OWNER, ready.versionId, p1.contentHash);
      await one(SUPER, SETTING_SQL_B11, ['visa_passport_tasks_enabled', true, SWITCH_REASON]);
      const [task] = await owner<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'visa'`, [DEAL]);
      await one(DESK, VISA_CLAIM_SQL, [task!.id]);
      await one(ACC, 'select public.accounts_review_return($1, $2, $3) as r', [ready.versionId, 'Synthetic: add the second traveller', rid()]);
      const rev = await one<{ versionId: string; rowVersion: number }>(OWNER, 'select public.booking_open_revision($1) as r', [ready.versionId]);
      let rv = (await h.saveParticipation(OWNER, ready.itemIds[0]!, rev.versionId, rev.rowVersion, [1, 2])).rowVersion;
      await one(OWNER, 'select public.booking_classify_revision($1, $2, $3) as r', [rev.versionId, rv, 'customer_material']);
      await h.storeEvidence(OWNER, rev.versionId, 'acceptance_message', 'a1'.repeat(32));
      await h.confirm(OWNER, rev.versionId, (await h.readiness(OWNER, rev.versionId)).contentHash);
      let w = await ws(DESK, task!.id);
      expect(w.applicants.map((x) => x.seq)).toEqual([1, 2]);
      expect(w.bookingChange).toMatchObject({ added: [{ seq: 2, name: 'Synthetic Traveller Two' }], removed: [] });
      // Second revision drops traveller 2: flagged removed, still docs_pending, not blocking.
      await one(ACC, 'select public.accounts_review_return($1, $2, $3) as r', [rev.versionId, 'Synthetic: the second traveller is not going', rid()]);
      const rev2 = await one<{ versionId: string; rowVersion: number }>(OWNER, 'select public.booking_open_revision($1) as r', [rev.versionId]);
      rv = (await h.saveParticipation(OWNER, ready.itemIds[0]!, rev2.versionId, rev2.rowVersion, [1])).rowVersion;
      await one(OWNER, 'select public.booking_classify_revision($1, $2, $3) as r', [rev2.versionId, rv, 'customer_material']);
      await h.storeEvidence(OWNER, rev2.versionId, 'acceptance_message', 'a2'.repeat(32));
      await h.confirm(OWNER, rev2.versionId, (await h.readiness(OWNER, rev2.versionId)).contentHash);
      w = await ws(DESK, task!.id);
      expect(w.applicants.map((x) => [x.seq, x.removed, x.state])).toEqual([[1, false, 'docs_pending'], [2, true, 'docs_pending']]);
      expect(w.bookingChange).toMatchObject({ removed: [{ seq: 2 }] });
      const removed = w.applicants[1]!;
      await refused(DESK, ROW, [removed.applicationId, removed.rowVersion, JSON.stringify({ remark: 'x' }), rid()], '55000', 'applicant_removed');
      // Finding 5: the removed passenger is withdrawn (closed), then comes back on a third revision: flag cleared.
      await one(DESK, WITHDRAW, [removed.applicationId, removed.rowVersion, JSON.stringify({ reason: 'Not travelling', customerInformed: true }), rid()]);
      await one(ACC, 'select public.accounts_review_return($1, $2, $3) as r', [rev2.versionId, 'Synthetic: the second traveller is back', rid()]);
      const rev3 = await one<{ versionId: string; rowVersion: number }>(OWNER, 'select public.booking_open_revision($1) as r', [rev2.versionId]);
      rv = (await h.saveParticipation(OWNER, ready.itemIds[0]!, rev3.versionId, rev3.rowVersion, [1, 2])).rowVersion;
      await one(OWNER, 'select public.booking_classify_revision($1, $2, $3) as r', [rev3.versionId, rv, 'customer_material']);
      await h.storeEvidence(OWNER, rev3.versionId, 'acceptance_message', 'a3'.repeat(32));
      await h.confirm(OWNER, rev3.versionId, (await h.readiness(OWNER, rev3.versionId)).contentHash);
      w = await ws(DESK, task!.id);
      expect(w.applicants.map((x) => [x.seq, x.removed, x.state])).toEqual([[1, false, 'docs_pending'], [2, false, 'withdrawn']]);
      expect(w.bookingChange).toMatchObject({ back: [{ seq: 2 }] });
      // Withdrawing the only active passenger closes the task.
      const a = w.applicants[0]!;
      await h.refusedWithHint(DESK, WITHDRAW, [a.applicationId, a.rowVersion, JSON.stringify({ reason: 'Customer cancelled' }), rid()], /customerInformed/);
      const r = await one(DESK, WITHDRAW, [a.applicationId, a.rowVersion, JSON.stringify({ reason: 'Customer cancelled', customerInformed: true }), rid()]);
      expect(r).toMatchObject({ state: 'withdrawn', closed: true, taskCompleted: true });
      expect(await owner(`select count(*)::int as n from public.audit_events where action = 'visa.booking_synced'`)).toEqual([{ n: 3 }]);
    });
  });
});

describe('passport task and traveller change', () => {
  it('passport: no Sales documents, desk adds one, appointment required, no custody tick, not_with_us closes and completes', async () => {
    await asOwner(db, async () => {
      const ready = await h.readyDraft(OWNER, DEAL, [['passport', PASSPORT]], { identities: true, travellers: TRAVELLERS.slice(0, 1) });
      await h.confirm(OWNER, ready.versionId, ready.hash);
      await one(SUPER, SETTING_SQL_B11, ['visa_passport_tasks_enabled', true, SWITCH_REASON]);
      const [task] = await owner<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'visa'`, [DEAL]);
      await one(DESK, VISA_CLAIM_SQL, [task!.id]);
      let a = await app(task!.id, 1);
      expect(a.notReady).toEqual(['no_documents', 'appointment_missing']);
      expect(a.visaKind).toEqual({ value: null, source: null });
      await one(DESK, DOC_ADD, [a.applicationId, a.rowVersion, JSON.stringify({ catalogueCode: 'old_passports', received: true }), rid()]);
      a = await app(task!.id, 1);
      await h.refusedWithHint(DESK, ROW, [a.applicationId, a.rowVersion, JSON.stringify({ visaKind: 'sticker' }), rid()], /^visaKind$/);
      await one(DESK, ROW, [a.applicationId, a.rowVersion, JSON.stringify({ appointmentDate: '2026-11-04' }), rid()]);
      a = await app(task!.id, 1);
      const line = { applicationId: a.applicationId, expectedRowVersion: a.rowVersion, reference: 'PP-SYN-1', appliedOn: '2026-11-04', governmentFeePaise: '150000' };
      await h.refusedWithHint(DESK, APPLY, [task!.id, JSON.stringify({ applicants: [line], paidBy: 'customer_direct', passportTaken: true }), rid()], /passportTaken/);
      await one(DESK, APPLY, [task!.id, JSON.stringify({ applicants: [line], paidBy: 'customer_direct' }), rid()]);
      a = await app(task!.id, 1);
      const proof = await deskEvidence(DESK, task!.id, 'authority_outcome', a.applicationId);
      const r = await one(DESK, DECIDE, [a.applicationId, a.rowVersion, JSON.stringify({ decision: 'approved', outcomeEvidenceId: proof, handover: { method: 'not_with_us' } }), rid()]);
      expect(r).toMatchObject({ closed: true, taskCompleted: true });
    });
  });

  it('a renamed traveller blocks Applied until the desk confirms the change', async () => {
    await asOwner(db, async () => {
      const { taskId, versionId } = await deskTask(TRAVELLERS.slice(0, 1));
      await setVisaFacts({ visaKind: 'e_visa', documentsNeeded: ['Photo, white background'] });
      await one(DESK, VISA_CLAIM_SQL, [taskId]);
      let a = await app(taskId, 1);
      await one(DESK, ROW, [a.applicationId, a.rowVersion, JSON.stringify({ documents: [{ documentId: a.documents[0]!.documentId, received: true }] }), rid()]);
      await owner(`set local session_replication_role = replica`);
      await owner(`update public.booking_version_travellers set full_name = 'Synthetic Renamed One' where booking_version_id = $1 and seq = 1`, [versionId]);
      await owner(`set local session_replication_role = origin`);
      a = await app(taskId, 1);
      expect(a.travellerChanged).toEqual({ was: 'Synthetic Traveller One', now: 'Synthetic Renamed One' });
      expect(await one(DESK, HOME)).toMatchObject({ visaTravellerChanged: 1, visaTravellerChangedTaskId: taskId });
      const line = { applicationId: a.applicationId, expectedRowVersion: a.rowVersion, reference: 'EV-SYN-9', appliedOn: '2026-11-04', governmentFeePaise: '150000' };
      await refused(DESK, APPLY, [taskId, JSON.stringify({ applicants: [line], paidBy: 'customer_direct' }), rid()], '55000', 'traveller_changed');
      expect(await one(DESK, CONFIRM_TRAVELLER, [a.applicationId, a.rowVersion, rid()])).toMatchObject({ outcome: 'updated' });
      a = await app(taskId, 1);
      expect(a).toMatchObject({ travellerChanged: null, ready: true });
      await one(DESK, APPLY, [taskId, JSON.stringify({ applicants: [{ ...line, expectedRowVersion: a.rowVersion }], paidBy: 'customer_direct' }), rid()]);
    });
  });
});

describe('fees after completion (review finding 1)', () => {
  async function completedWithDraftFee() {
    const { taskId } = await deskTask(TRAVELLERS.slice(0, 1));
    await setVisaFacts({ visaKind: 'e_visa', documentsNeeded: ['Photo, white background'] });
    await one(DESK, VISA_CLAIM_SQL, [taskId]);
    let a = await app(taskId, 1);
    await one(DESK, ROW, [a.applicationId, a.rowVersion, JSON.stringify({ documents: [{ documentId: a.documents[0]!.documentId, received: true }] }), rid()]);
    a = await app(taskId, 1);
    await one(DESK, APPLY, [taskId, JSON.stringify({ applicants: [{ applicationId: a.applicationId, expectedRowVersion: a.rowVersion, reference: 'EV-SYN-C1', appliedOn: '2026-11-02', governmentFeePaise: '300000' }], paidBy: 'company', paymentMode: 'card' }), rid()]);
    a = await app(taskId, 1);
    const proof = await deskEvidence(DESK, taskId, 'authority_outcome', a.applicationId);
    expect(await one(DESK, DECIDE, [a.applicationId, a.rowVersion, JSON.stringify({ decision: 'approved', outcomeEvidenceId: proof, recipientEmail: 'cust@example.test' }), rid()]))
      .toMatchObject({ taskCompleted: true });
    const w = await ws(DESK, taskId);
    return { taskId, w, fee: w.applicants[0]!.fees[0]!, applicationId: w.applicants[0]!.applicationId };
  }

  it('a draft fee without receipt is sent after the task completed; nothing else reopens', async () => {
    await asOwner(db, async () => {
      const { taskId, w, fee, applicationId } = await completedWithDraftFee();
      expect(w).toMatchObject({ canWork: false, canManageFees: true });
      expect(fee.expenseStatus).toBe('draft');
      expect(await one(DESK, HOME)).toMatchObject({ visaFeesWithoutReceipt: 1, visaFeesWithoutReceiptTaskId: taskId });
      // Only fee receipts may be uploaded now.
      await refused(DESK, EV_BEGIN, [taskId, null, 'applicant_document', 'x.pdf', 'application/pdf', 10, 'c'.repeat(64)], '55000', 'task_closed');
      const receipt = await deskEvidence(DESK, taskId, 'fee_receipt');
      expect(await one(DESK, FEE_SEND, [fee.entryId, fee.rowVersion, JSON.stringify({ receiptEvidenceId: receipt }), rid()])).toMatchObject({ expenseStatus: 'submitted' });
      expect(await one(DESK, HOME)).toMatchObject({ visaFeesWithoutReceipt: 0 });
      // An "other" cost per passenger may still be recorded; the passenger row may not change.
      expect(await one(DESK, COST_SAVE, [taskId, null, null, JSON.stringify({ applicationId, costKind: 'other', amountPaise: '5000', paidBy: 'customer_direct', paidOn: '2026-11-03' }), rid()]))
        .toMatchObject({ expenseStatus: null });
      expect((await ws(DESK, taskId)).costSummary).toMatchObject({ travellers: [expect.objectContaining({ otherPaise: '5000' })] });
      const a = (await ws(DESK, taskId)).applicants[0]!;
      await refused(DESK, ROW, [a.applicationId, a.rowVersion, JSON.stringify({ remark: 'late' }), rid()], '55000', 'task_closed');
      // Nobody else: the branch Manager cannot send fees.
      await refused(MANAGER, FEE_SEND, [fee.entryId, fee.rowVersion + 1, JSON.stringify({}), rid()], '42501', 'not_authorized');
    });
  });

  it('a fee returned by Accounts after completion is fixed and accepted', async () => {
    await asOwner(db, async () => {
      const { taskId, fee } = await completedWithDraftFee();
      const receipt = await deskEvidence(DESK, taskId, 'fee_receipt');
      const sent = await one<{ rowVersion: number }>(DESK, FEE_SEND, [fee.entryId, fee.rowVersion, JSON.stringify({ receiptEvidenceId: receipt }), rid()]);
      const ret = await one<{ rowVersion: number }>(ACC, EXPENSE_RETURN, [fee.entryId, sent.rowVersion, 'Synthetic: the amount is wrong', rid()]);
      expect(await one(DESK, HOME)).toMatchObject({ visaFeesReturned: 1, visaFeesReturnedTaskId: taskId });
      const fixed = await one<{ rowVersion: number }>(DESK, FEE_SEND, [fee.entryId, ret.rowVersion, JSON.stringify({ amountPaise: '310000' }), rid()]);
      expect(await one(ACC, EXPENSE_ACCEPT, [fee.entryId, fixed.rowVersion, rid()])).toMatchObject({ status: 'accepted' });
      expect(await one(DESK, HOME)).toMatchObject({ visaFeesReturned: 0 });
      expect(await owner('select status from public.fulfilment_tasks where id = $1', [taskId])).toEqual([{ status: 'completed' }]);
    });
  });
});
