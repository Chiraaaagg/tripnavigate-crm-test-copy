import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, expectDbError, istBusinessDate, resetActor, setActor } from '../helpers/db';
import { ACC } from './finance-support';
import { ACCOUNTS, DEAL, MANAGER, OWNER, PURCHASE, PURCHASE_GET_SQL, SALES_AMD, SERVICES_SQL, SUPER, TRAVELLERS, allKeys } from './b1-support';
import {
  APP_STATE_SQL, APP_UPDATE_SQL, DESK, EV_BEGIN_SQL, EV_DOWNLOAD_SQL, IDENTITY_SQL, SETTING_SQL_B11, SWITCH_REASON, VISA, VISA_CLAIM_SQL,
  VISA_GET_SQL, VISA_LIST_SQL, WORK_FORM_SQL, b11Helpers, rid,
} from './b11-support';
import { SQL as V, line, visaHelpers } from './visa-e-support';

/**
 * Visa & Passport desk (migration 20261119000500): queue, claim, one
 * application per applicant, the documents gate, outcome only with the
 * authority document, completion (issued + returned, or refused + informed),
 * privacy of applicant documents and identity, nothing commercial.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const vh = visaHelpers(() => db);
const { one, refused, owner, deskTask, deskEvidence } = h;
type App = { applicationId: string; seq: number; rowVersion: number; state: string; identity?: Record<string, unknown> | null };
type Task = { applicants: App[]; status: string; canClaim: boolean; canWork: boolean } & Record<string, unknown>;

const TWO = TRAVELLERS.slice(0, 2);

describe('the desk queue and a task', () => {
  it('lists the task without anything commercial; claim opens one application per applicant; identity only for the assignee', async () => {
    await asOwner(db, async () => {
      const { taskId } = await deskTask(TWO);
      const list = await one<Array<Record<string, unknown>>>(DESK, VISA_LIST_SQL);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ taskId, serviceType: 'visa', itemTitle: 'United Arab Emirates · Tourism', status: 'not_started', applicantCount: 2 });
      const before = await one<Task>(DESK, VISA_GET_SQL, [taskId]);
      expect(before.canClaim).toBe(true);
      expect(before.applicants.map((a) => [a.seq, a.applicationId])).toEqual([[1, null], [2, null]]);
      expect(before.applicants[0]).not.toHaveProperty('identity');
      const keys = [...allKeys(before)];
      expect(keys.filter((k) => /selling|listPrice|discount|^plan$|instalment|claim(?!$)|contact|billing|payer/i.test(k))).toEqual([]);
      expect(JSON.stringify(before)).not.toMatch(/9876543|9876500011|contact@example/);
      // Not for Purchase, Sales or Accounts.
      for (const actor of [PURCHASE, OWNER, ACCOUNTS]) expect(await one(actor, VISA_GET_SQL, [taskId])).toBeNull();
      await refused(PURCHASE, VISA_CLAIM_SQL, [taskId], '42501', 'not_authorized');

      // Visa build (contract C1): the exact claim result { taskId, status, assignedToYou, alreadyYours } replaced by the
      // existing keys plus applicationCount (one current application per participant).
      expect(await one(DESK, VISA_CLAIM_SQL, [taskId])).toMatchObject({ taskId, status: 'in_progress', assignedToYou: true, alreadyYours: false, applicationCount: 2 });
      expect(await one(DESK, VISA_CLAIM_SQL, [taskId])).toMatchObject({ alreadyYours: true });
      const mine = await one<Task>(DESK, VISA_GET_SQL, [taskId]);
      expect(mine.applicants.map((a) => [a.seq, a.state])).toEqual([[1, 'docs_pending'], [2, 'docs_pending']]);
      expect(mine.applicants[0]!.identity).toMatchObject({ dateOfBirth: '1990-05-17', passportNumber: 'Z1000001' });
      // The desk saves the passport of its own applicant; not of a traveller outside the item.
      const [identityRow] = await owner<{ row_version: number }>(
        `select x.row_version from public.traveller_identities x join public.deal_travellers t on t.id = x.traveller_id where t.deal_id = $1 and t.seq = 1`, [DEAL]);
      await one(DESK, IDENTITY_SQL, [DEAL, 1, identityRow!.row_version, JSON.stringify({ dateOfBirth: '1990-05-17', nationality: 'Indian', passportNumber: 'P7654321', passportExpiry: '2031-01-01' })]);
      // Assigned desk person: department-scoped Deal services (no travellers, no contacts).
      const services = await one<Record<string, unknown>>(DESK, SERVICES_SQL, [DEAL]);
      expect(services).not.toHaveProperty('travellers');
      expect((services.items as Array<{ serviceType: string }>).map((i) => i.serviceType)).toEqual(['visa']);
      expect(await one(DESK, PURCHASE_GET_SQL, [(await owner<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'purchase'`, [DEAL]))[0]!.id])).toBeNull();
    });
  });

  it('documents gate submission; outcome needs the authority document; completion needs issued + returned or refused + informed', async () => {
    // Visa build (contract C16, Q3, Q4, V3, section 7): the old visa_application_update / visa_application_set_state steps are
    // revoked; the same rules are asserted through the new commands. Old -> new, assertion by assertion:
    //   documents_not_checked -> not_ready (hint applicants[1]:no_documents / documents_missing; "received" replaces "checked");
    //   reference required (hint reference) -> invalid_input hint applicants[1].reference on Applied (C5);
    //   state 'submitted' -> 'decision_pending' (V3: Applied waits for the decision);
    //   outcome_document_required (fee receipt or none) -> unchanged token on C6;
    //   documents_returned before an outcome (outcome_required) -> wrong_state on C7 (handover only after a decision);
    //   issued + documents_returned -> approved with office handover + Mark delivered (C8, closes 'delivered');
    //   application_closed on a closed applicant -> unchanged token (C2 on a closed row);
    //   withdrawn + customer_informed -> one C9 withdraw with customerInformed (closes 'customer_informed').
    await asOwner(db, async () => {
      const { taskId } = await deskTask(TWO);
      await one(DESK, VISA_CLAIM_SQL, [taskId]);
      let a1 = await vh.app(taskId, 1, DESK);
      // Applied refused until a document list exists and every listed document is received.
      await vh.refusedHint(DESK, V.apply, [taskId, JSON.stringify({ applicants: [line(a1)], visaKind: 'sticker', paidBy: 'customer_direct' }), rid()],
        'not_ready', /^applicants\[0\]:no_documents$/ /* 0-based hints, lead decision 8 Nov */);
      for (const catalogueCode of ['passport_copy', 'photo']) {
        await one(DESK, V.docAdd, [a1.applicationId, a1.rowVersion, JSON.stringify({ catalogueCode, received: false, remark: null }), rid()]);
        a1 = await vh.app(taskId, 1, DESK);
      }
      await one(DESK, V.setRow, [a1.applicationId, a1.rowVersion, JSON.stringify({ appointmentDate: '2026-11-10',
        documents: [{ documentId: a1.documents[0]!.documentId, received: true }] }), rid()]);
      a1 = await vh.app(taskId, 1, DESK);
      await vh.refusedHint(DESK, V.apply, [taskId, JSON.stringify({ applicants: [line(a1)], visaKind: 'sticker', paidBy: 'customer_direct' }), rid()],
        'not_ready', /^applicants\[0\]:documents_missing$/);
      await one(DESK, V.setRow, [a1.applicationId, a1.rowVersion, JSON.stringify({ documents: a1.documents.map((d) => ({ documentId: d.documentId, received: true })) }), rid()]);
      a1 = await vh.app(taskId, 1, DESK);
      await vh.refusedHint(DESK, V.apply, [taskId, JSON.stringify({ applicants: [line(a1, { reference: '   ' })], visaKind: 'sticker', paidBy: 'customer_direct' }), rid()],
        'invalid_input', /applicants\[0\]\.reference/);
      const applied = await one<{ applications: Array<{ state: string }> }>(DESK, V.apply,
        [taskId, JSON.stringify({ applicants: [line(a1, { reference: 'VFS-SYN-001' })], visaKind: 'sticker', paidBy: 'customer_direct' }), rid()]);
      expect(applied.applications).toEqual([expect.objectContaining({ state: 'decision_pending' })]);
      a1 = await vh.app(taskId, 1, DESK);
      // A fee receipt is not an outcome document; none at all is refused too.
      const fee = await deskEvidence(DESK, taskId, 'fee_receipt');
      await refused(DESK, V.decide, [a1.applicationId, a1.rowVersion, JSON.stringify({ decision: 'approved', outcomeEvidenceId: fee }), rid()], '55000', 'outcome_document_required');
      await refused(DESK, V.decide, [a1.applicationId, a1.rowVersion, JSON.stringify({ decision: 'approved', outcomeEvidenceId: null }), rid()], '55000', 'outcome_document_required');
      await refused(DESK, V.handover, [a1.applicationId, a1.rowVersion, JSON.stringify({ method: 'office' }), rid()], '55000', 'wrong_state');
      const grant = await deskEvidence(DESK, taskId, 'authority_outcome', a1.applicationId);
      let r = await one<{ rowVersion: number; taskCompleted: boolean; closed: boolean }>(DESK, V.decide,
        [a1.applicationId, a1.rowVersion, JSON.stringify({ decision: 'approved', outcomeEvidenceId: grant, handover: { method: 'office' } }), rid()]);
      expect(r.closed).toBe(false);
      r = await one(DESK, V.delivered, [a1.applicationId, r.rowVersion, JSON.stringify({ deliveredOn: istBusinessDate(), remark: null }), rid()]);
      expect(r.taskCompleted).toBe(false); // applicant 2 is still open
      await refused(DESK, V.setRow, [a1.applicationId, r.rowVersion, JSON.stringify({ remark: 'Synthetic late remark' }), rid()], '55000', 'application_closed');
      // Applicant 2 withdraws; telling the customer closes it and completes the task.
      const a2 = await vh.app(taskId, 2, DESK);
      r = await one(DESK, V.withdraw, [a2.applicationId, a2.rowVersion, JSON.stringify({ reason: 'Synthetic: not travelling', customerInformed: true }), rid()]);
      expect(r.taskCompleted).toBe(true);
      expect(await owner('select status, completed_by from public.fulfilment_tasks where id = $1', [taskId])).toEqual([{ status: 'completed', completed_by: DESK.userId }]);
      expect(await owner(`select count(*)::int as n from public.outbox_events where event_type = 'fulfilment.task_completed' and aggregate_id = $1`, [taskId]))
        .toEqual([{ n: 1 }]);
      // Progress counts it as done; nothing more can change on the task.
      const services = await one<{ items: Array<{ serviceType: string; nextStep: string }>; progress: { byState: Record<string, number> } }>(OWNER, SERVICES_SQL, [DEAL]);
      expect(services.items.find((i) => i.serviceType === 'visa')!.nextStep).toBe('done');
      expect(services.progress.byState.completed).toBe(1);
      await refused(DESK, EV_BEGIN_SQL, [taskId, null, 'other', 'x.pdf', 'application/pdf', 10, 'c'.repeat(64)], '55000', 'task_closed');
      await expectDbError(db, () => owner(`update public.fulfilment_tasks set status = 'in_progress' where id = $1`, [taskId]), { code: '42501' });
      // The work form (unchanged for one release, C16) shows the steps.
      const form = await one<{ steps: Array<{ code: string }>; references: Array<{ value: string }> }>(DESK, WORK_FORM_SQL, [taskId]);
      expect(form.steps.map((s) => s.code)).toEqual(expect.arrayContaining(['taken', 'submitted', 'issued', 'documents_returned', 'customer_informed', 'completed']));
      expect(form.references.map((x) => x.value)).toContain('VFS-SYN-001');
      // The old commands are revoked (C16, VL17).
      await expectDbError(db, () => h.run(DESK, APP_UPDATE_SQL, [a2.applicationId, 1, JSON.stringify({ reference: 'X' })]), { code: '42501' });
      await expectDbError(db, () => h.run(DESK, APP_STATE_SQL, [a2.applicationId, 1, 'withdrawn', null]), { code: '42501' });
    });
  });

  it('applicant documents: desk and branch Manager download; Purchase, Accounts and Sales never; no Data API read', async () => {
    await asOwner(db, async () => {
      const { taskId } = await deskTask(TWO);
      await one(DESK, VISA_CLAIM_SQL, [taskId]);
      const doc = await deskEvidence(DESK, taskId, 'applicant_document');
      expect(await one(DESK, EV_DOWNLOAD_SQL, [doc])).toMatchObject({ mime: 'application/pdf' });
      expect(await one(MANAGER, EV_DOWNLOAD_SQL, [doc])).toMatchObject({ mime: 'application/pdf' });
      for (const actor of [PURCHASE, ACC, OWNER]) await refused(actor, EV_DOWNLOAD_SQL, [doc], '42501', 'not_authorized');
      for (const actor of [DESK, MANAGER, OWNER]) {
        // Visa build (5.2, 5.3): the new desk tables are not readable either.
        for (const table of ['visa_applications', 'department_evidence', 'department_cost_entries', 'visa_application_documents', 'visa_result_notices']) {
          await setActor(db, actor);
          await expectDbError(db, () => db.query(`select * from public.${table}`), { code: '42501' });
          await resetActor(db);
        }
      }
      // Sales gets no work form (no costs for Sales); the Manager reads it.
      expect(await one(OWNER, WORK_FORM_SQL, [taskId])).toBeNull();
      expect(await one(MANAGER, WORK_FORM_SQL, [taskId])).toMatchObject({ department: 'visa', canWork: false });
    });
  });

  it('review V1: a revision adds or removes applicants of an open desk task; completion needs every current applicant', async () => {
    // Visa build (contract section 7 step 3, VL1): a removed applicant is no longer auto-withdrawn. The old assertions
    // (state 'withdrawn', closed, one 'visa.application_withdrawn_by_revision' audit) are replaced by: the application is
    // flagged removed, its state stays docs_pending, nothing is deleted, no auto-withdraw audit, one visa.booking_synced
    // audit; a removed docs_pending applicant does not block completion, so the revision still completes the task.
    await asOwner(db, async () => {
      // Visa for traveller 1 only; Accounts returns the booking after the desk took the task.
      const ready = await h.readyDraft(OWNER, DEAL, [['visa', VISA]], { identities: true, travellers: TWO });
      const p1 = await h.saveParticipation(OWNER, ready.itemIds[0]!, ready.versionId, ready.rowVersion, [1]);
      await h.confirm(OWNER, ready.versionId, p1.contentHash);
      await one(SUPER, SETTING_SQL_B11, ['visa_passport_tasks_enabled', true, SWITCH_REASON]);
      const [task] = await owner<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'visa'`, [DEAL]);
      await one(DESK, VISA_CLAIM_SQL, [task!.id]);
      expect((await one<Task>(DESK, VISA_GET_SQL, [task!.id])).applicants.map((a) => [a.seq, a.state])).toEqual([[1, 'docs_pending']]);
      await one(ACC, 'select public.accounts_review_return($1, $2, $3) as r', [ready.versionId, 'Synthetic: add the second traveller', rid()]);
      const rev = await one<{ versionId: string; rowVersion: number }>(OWNER, 'select public.booking_open_revision($1) as r', [ready.versionId]);
      let rv = (await h.saveParticipation(OWNER, ready.itemIds[0]!, rev.versionId, rev.rowVersion, [1, 2])).rowVersion;
      await one(OWNER, 'select public.booking_classify_revision($1, $2, $3) as r', [rev.versionId, rv, 'customer_material']);
      await h.storeEvidence(OWNER, rev.versionId, 'acceptance_message', 'a1'.repeat(32));
      await h.confirm(OWNER, rev.versionId, (await h.readiness(OWNER, rev.versionId)).contentHash);
      // The new applicant has an application now.
      let apps = (await one<Task>(DESK, VISA_GET_SQL, [task!.id])).applicants;
      expect(apps.map((a) => [a.seq, a.state, a.applicationId !== null])).toEqual([[1, 'docs_pending', true], [2, 'docs_pending', true]]);
      // Closing applicant 1 (withdrawn, customer told: C9) does not complete the task while applicant 2 is open.
      const r = await one<{ rowVersion: number; taskCompleted: boolean }>(DESK, V.withdraw,
        [apps[0]!.applicationId, apps[0]!.rowVersion, JSON.stringify({ reason: 'Synthetic: not travelling', customerInformed: true }), rid()]);
      expect(r.taskCompleted).toBe(false);
      // A second revision removes applicant 2: the application is flagged removed (records kept) and the task can complete.
      await one(ACC, 'select public.accounts_review_return($1, $2, $3) as r', [rev.versionId, 'Synthetic: the second traveller is not going', rid()]);
      const rev2 = await one<{ versionId: string; rowVersion: number }>(OWNER, 'select public.booking_open_revision($1) as r', [rev.versionId]);
      rv = (await h.saveParticipation(OWNER, ready.itemIds[0]!, rev2.versionId, rev2.rowVersion, [1])).rowVersion;
      await one(OWNER, 'select public.booking_classify_revision($1, $2, $3) as r', [rev2.versionId, rv, 'customer_material']);
      await h.storeEvidence(OWNER, rev2.versionId, 'acceptance_message', 'a2'.repeat(32));
      await h.confirm(OWNER, rev2.versionId, (await h.readiness(OWNER, rev2.versionId)).contentHash);
      apps = (await one<Task>(DESK, VISA_GET_SQL, [task!.id])).applicants;
      expect(await owner(`select state, removed_at is not null as removed, closed_at is null as open from public.visa_applications
        where task_id = $1 and traveller_seq = 2`, [task!.id])).toEqual([{ state: 'docs_pending', removed: true, open: true }]);
      expect(await owner(`select count(*)::int as n from public.audit_events where action = 'visa.application_withdrawn_by_revision'`)).toEqual([{ n: 0 }]);
      expect(await owner(`select count(*)::int as n from public.audit_events where action = 'visa.booking_synced' and target_id = $1`, [task!.id])).toEqual([{ n: 2 }]);
      // Every current applicant is closed or removed before Applied: the revision confirmation completed the task.
      expect(await owner('select status, completed_by from public.fulfilment_tasks where id = $1', [task!.id]))
        .toEqual([{ status: 'completed', completed_by: OWNER.userId }]);
      void apps;
    });
  });

  it('review V4: a Flight person may not download applicant documents', async () => {
    await asOwner(db, async () => {
      const { taskId } = await deskTask(TWO);
      await one(DESK, VISA_CLAIM_SQL, [taskId]);
      const doc = await deskEvidence(DESK, taskId, 'applicant_document');
      await owner(`insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
        select $1, b.legal_entity_id, b.id, 'flight', 'active' from public.branches b where b.code = 'JDH'`, [SALES_AMD.userId]);
      await refused(SALES_AMD, EV_DOWNLOAD_SQL, [doc], '42501', 'not_authorized');
    });
  });
});

