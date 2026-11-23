import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, istBusinessDate } from '../helpers/db';
import {
  ACC, BLANK_KIND, DEAL, EVISA, FLIGHT, MANAGER, MANAGER_AMD, OWNER, PASSPORT, PURCHASE, SQL, STICKER, STICKER_DOCS, VISA_A, VISA_B, dayFrom, line, passportOf, rid,
  visaHelpers,
} from './visa-e-support';
import { CONFLICT_STATE } from '../helpers/sqlstates';

/**
 * Visa build (contract 8 Nov 2026) test plan 12.1: claim (C1), the branch
 * Manager's read-only access (D2), the passenger row (C2), documents (C3/C4)
 * and the ready rule (section 4). Written from the contract, not the code.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = visaHelpers(() => db);
const { one, owner, refused, refusedHint, book, stickerTask, workspace, applicants, app, appRow, docRows, makeReady, audits } = h;

describe('C1 claim', () => {
  it('only an active Visa person claims; applications and Sales documents are seeded; a second Visa person gets task_conflict', async () => {
    await asOwner(db, async () => {
      await h.addVisaB();
      await h.addFlightPerson();
      const { taskId } = await stickerTask({ take: false });
      // Manager, Sales, Purchase, Flight and Accounts never claim (can_claim_visa_task: visa role only).
      for (const actor of [MANAGER, OWNER, PURCHASE, FLIGHT, ACC]) {
        await refused(actor, SQL.claim, [taskId], 'not_authorized', '42501');
      }
      const before = (await workspace(taskId))!;
      expect(before).toMatchObject({ canClaim: true, canWork: false, status: { code: 'not_taken' } });
      expect(before.applicants).toEqual([]);
      const claimed = await one<Record<string, unknown>>(VISA_A, SQL.claim, [taskId]);
      expect(claimed).toMatchObject({ taskId, status: 'in_progress', assignedToYou: true, alreadyYours: false, applicationCount: 4 });
      expect(await one(VISA_A, SQL.claim, [taskId])).toMatchObject({ alreadyYours: true });
      await refused(VISA_B, SQL.claim, [taskId], 'task_conflict', CONFLICT_STATE);
      const apps = await applicants(taskId);
      expect(apps.map((a) => [a.seq, a.state, a.removed])).toEqual([[1, 'docs_pending', false], [2, 'docs_pending', false], [3, 'docs_pending', false], [4, 'docs_pending', false]]);
      // One not-received document row per documentsNeeded label, source sales, catalogue code by label key.
      for (const a of apps) {
        expect(a.documents.map((d) => [d.label, d.catalogueCode, d.status, d.source])).toEqual([
          ['Passport copy (front and back)', 'passport_copy', 'not_received', 'sales'],
          ['Photo, white background', 'photo', 'not_received', 'sales'],
          ['Bank statement (6 months)', 'bank_statement', 'not_received', 'sales'],
        ]);
        expect([a.documentsReceived, a.documentsTotal]).toEqual([0, 3]);
      }
      // Snapshots taken at claim (section 5.1).
      expect(await appRow(apps[3]!.applicationId)).toMatchObject({ traveller_name_snapshot: 'Synthetic Traveller Four', traveller_type_snapshot: 'child' });
      const [claimAudit] = await audits('fulfilment.task_claimed', taskId);
      expect(claimAudit!.details).toMatchObject({ applicationCount: 4 });
    });
  });

  it('a passport task starts with no documents; the desk adds them', async () => {
    await asOwner(db, async () => {
      const b = await book({ items: [{ type: 'passport', facts: PASSPORT }] });
      await one(VISA_A, SQL.claim, [b.tasks[0]]);
      const [a] = await applicants(b.tasks[0]!);
      expect(a).toMatchObject({ seq: 1, documents: [], documentsTotal: 0, visaKind: { value: null } });
      expect(a!.notReady).toContain('no_documents');
    });
  });
});

describe('D2: the branch Manager reads, never works', () => {
  it('Manager opens queue and workspace read-only (no identity, no catalogue, every command refused); other branch Manager refused', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const queue = await one<{ isManagerView: boolean; canTake: boolean; tasks: Array<{ taskId: string }> }>(MANAGER, SQL.queue);
      expect(queue.isManagerView).toBe(true);
      expect(queue.canTake).toBe(false);
      expect(queue.tasks.map((t) => t.taskId)).toContain(taskId);
      const w = (await workspace(taskId, MANAGER))!;
      expect(w).toMatchObject({ isManagerView: true, canClaim: false, canWork: false, canUpload: false });
      expect(w.applicants).toHaveLength(4);
      for (const a of w.applicants) {
        expect(a.passport).toBeNull();
        expect(Object.values(a.can).every((v) => v === false)).toBe(true);
      }
      expect(w.catalogue ?? []).toEqual([]); // catalogue: VA only (9.2)
      expect(JSON.stringify(w)).not.toContain(passportOf(1));
      expect(await one(MANAGER, SQL.taskHistory, [taskId])).not.toBeNull();
      // Every command refused for the Manager.
      const a = w.applicants[0]!;
      await refused(MANAGER, SQL.claim, [taskId], 'not_authorized', '42501');
      await refused(MANAGER, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify({ remark: 'Synthetic' }), rid()], 'not_authorized', '42501');
      await refused(MANAGER, SQL.docAdd, [a.applicationId, a.rowVersion, JSON.stringify({ catalogueCode: 'pan_card', received: false }), rid()], 'not_authorized', '42501');
      await refused(MANAGER, SQL.docRemove, [a.documents[0]!.documentId, a.rowVersion, rid()], 'not_authorized', '42501');
      await refused(MANAGER, SQL.apply, [taskId, JSON.stringify({ applicants: [line(a)], paidBy: 'customer_direct' }), rid()], 'not_authorized', '42501');
      await refused(MANAGER, SQL.withdraw, [a.applicationId, a.rowVersion, JSON.stringify({ reason: 'Synthetic', customerInformed: true }), rid()], 'not_authorized', '42501');
      await refused(MANAGER, SQL.reapply, [a.applicationId, a.rowVersion, rid()], 'not_authorized', '42501');
      await refused(MANAGER, SQL.confirmTraveller, [a.applicationId, a.rowVersion, rid()], 'not_authorized', '42501');
      // Other branch: nothing.
      expect(await workspace(taskId, MANAGER_AMD)).toBeNull();
      const other = await one<{ tasks: Array<{ taskId: string }> } | null>(MANAGER_AMD, SQL.queue);
      expect(other?.tasks.map((t) => t.taskId) ?? []).not.toContain(taskId);
      // Purchase, Accounts and Sales get no desk read.
      for (const actor of [PURCHASE, ACC, OWNER]) expect(await workspace(taskId, actor)).toBeNull();
    });
  });
});

describe('C2 passenger row', () => {
  it('appointment date and time rules, documents tick and untick, remark, wrong_state after Applied; version checked', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      let a = await app(taskId, 1);
      await refusedHint(VISA_A, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify({ appointmentTime: '10:30' }), rid()], 'invalid_input', /appointmentTime/);
      await refusedHint(VISA_A, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify({ appointmentDate: '2026-11-20', appointmentTime: '24:00' }), rid()], 'invalid_input', /appointmentTime/);
      await refusedHint(VISA_A, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify({ appointmentDate: '20-11-2026' }), rid()], 'invalid_input', /appointmentDate/);
      await refusedHint(VISA_A, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify({ remark: 'x'.repeat(301) }), rid()], 'invalid_input', /remark/);
      await refusedHint(VISA_A, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify({ documents: [{ documentId: rid(), received: true }] }), rid()], 'invalid_input', /documents/);
      // A past appointment date is allowed (VL20).
      const r = await one<{ applicationId: string; rowVersion: number; ready: boolean; notReady: string[] }>(VISA_A, SQL.setRow, [a.applicationId, a.rowVersion,
        JSON.stringify({ appointmentDate: dayFrom(-30), appointmentTime: '09:15', remark: 'Synthetic remark',
          documents: [{ documentId: a.documents[0]!.documentId, received: true }] }), rid()]);
      expect(r).toMatchObject({ applicationId: a.applicationId, rowVersion: a.rowVersion + 1, ready: false, notReady: ['documents_missing'] });
      await refused(VISA_A, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify({ remark: 'stale' }), rid()], 'version_changed', CONFLICT_STATE);
      a = await app(taskId, 1);
      expect(a.appointment).toEqual({ date: dayFrom(-30), time: '09:15' });
      expect(a.remark).toBe('Synthetic remark');
      expect(a.documents[0]).toMatchObject({ status: 'received' });
      expect(a.documents[0]!.receivedAt).not.toBeNull();
      // Untick back to not received (docs_pending).
      await one(VISA_A, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify({ documents: [{ documentId: a.documents[0]!.documentId, received: false }] }), rid()]);
      a = await app(taskId, 1);
      expect(a.documents[0]).toMatchObject({ status: 'not_received', receivedAt: null });
      // Clearing the date also clears the need for a time; a time alone is refused.
      a = await makeReady(taskId, 1);
      expect(a.ready).toBe(true);
      await h.apply(taskId, [line(a)]);
      a = await app(taskId, 1);
      for (const fields of [{ appointmentDate: dayFrom(-1) }, { documents: [{ documentId: a.documents[0]!.documentId, received: false }] }, { visaKind: 'e_visa' }]) {
        await refused(VISA_A, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify(fields), rid()], 'wrong_state', '55000');
      }
      // Remark and passport number stay editable in any open state.
      await one(VISA_A, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify({ remark: 'After Applied' }), rid()]);
      const audit = await audits('visa.application_row_saved', a.applicationId);
      expect(audit.length).toBeGreaterThanOrEqual(3);
      expect(audit.at(-1)!.details).toMatchObject({ taskId, seq: 1, changedFields: ['remark'] });
      expect(JSON.stringify(audit)).not.toMatch(/Synthetic remark|After Applied/);
    });
  });

  it('passport number: normalised, written to the traveller identity (VA only), no copy on the application; audited without the number', async () => {
    await asOwner(db, async () => {
      await h.addVisaB();
      const { taskId } = await stickerTask();
      let a = await app(taskId, 2);
      expect(a.passport).toMatchObject({ number: passportOf(2) });
      await refusedHint(VISA_A, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify({ passportNumber: 'AB12' }), rid()], 'invalid_input', /passportNumber/);
      await one(VISA_A, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify({ passportNumber: ' p-77 66 554 ' }), rid()]);
      const [identity] = await owner<{ passport_number: string }>(
        `select x.passport_number from public.traveller_identities x join public.deal_travellers t on t.id = x.traveller_id where t.deal_id = $1 and t.seq = 2`, [DEAL]);
      expect(identity!.passport_number).toBe('P7766554');
      a = await app(taskId, 2);
      expect(a.passport).toMatchObject({ number: 'P7766554' });
      expect(Object.values(await appRow(a.applicationId))).not.toContain('P7766554'); // V2
      const saved = (await audits('booking.traveller_identity_saved')).at(-1); // the earlier ones are the booking form's saves
      expect(saved!.details).toMatchObject({ seq: 2, changedFields: ['passportNumber'] });
      expect(JSON.stringify(await owner(`select details, reason from public.audit_events where action like 'visa.%' or action = 'booking.traveller_identity_saved'`)))
        .not.toMatch(/P7766554/);
      // The other Visa person (not the assignee) neither sees nor writes it.
      const other = await app(taskId, 2, VISA_B);
      expect(other.passport).toBeNull();
      await refused(VISA_B, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify({ passportNumber: 'P1111111' }), rid()], 'not_authorized', '42501');
    });
  });

  it('kind and jurisdiction: the desk sets them only while Sales left them blank and before Applied (QB5)', async () => {
    await asOwner(db, async () => {
      const sticker = await stickerTask();
      const s = await app(sticker.taskId, 1);
      expect(s.visaKind).toEqual({ value: 'sticker', source: 'sales' });
      expect(s.jurisdiction).toMatchObject({ required: true, place: 'New Delhi', source: 'sales' });
      await refusedHint(VISA_A, SQL.setRow, [s.applicationId, s.rowVersion, JSON.stringify({ visaKind: 'e_visa' }), rid()], 'invalid_input', /visaKind/);
      await refusedHint(VISA_A, SQL.setRow, [s.applicationId, s.rowVersion, JSON.stringify({ jurisdiction: 'no' }), rid()], 'invalid_input', /jurisdiction/);
    });
    await asOwner(db, async () => {
      const b = await book({ items: [{ type: 'visa', facts: BLANK_KIND }] });
      const taskId = b.tasks[0]!;
      await one(VISA_A, SQL.claim, [taskId]);
      let a = await app(taskId, 1);
      expect(a.visaKind).toEqual({ value: null, source: null });
      await one(VISA_A, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify({ visaKind: 'sticker' }), rid()]);
      a = await app(taskId, 1);
      expect(a.visaKind).toEqual({ value: 'sticker', source: 'desk' });
      // Jurisdiction place needs Yes; Yes needs a place.
      await refusedHint(VISA_A, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify({ jurisdiction: 'yes' }), rid()], 'invalid_input', /jurisdictionPlace/);
      await refusedHint(VISA_A, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify({ jurisdiction: 'no', jurisdictionPlace: 'Mumbai' }), rid()], 'invalid_input', /jurisdictionPlace/);
      await one(VISA_A, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify({ jurisdiction: 'yes', jurisdictionPlace: 'Mumbai' }), rid()]);
      a = await app(taskId, 1);
      expect(a.jurisdiction).toMatchObject({ required: true, place: 'Mumbai', source: 'desk' });
      expect(await appRow(a.applicationId)).toMatchObject({ visa_kind: 'sticker', jurisdiction_required: true, jurisdiction_place: 'Mumbai' });
    });
    await asOwner(db, async () => {
      // Passport tasks: no kind (always null).
      const b = await book({ items: [{ type: 'passport', facts: PASSPORT }] });
      await one(VISA_A, SQL.claim, [b.tasks[0]]);
      const a = await app(b.tasks[0]!, 1);
      await refusedHint(VISA_A, SQL.setRow, [a.applicationId, a.rowVersion, JSON.stringify({ visaKind: 'sticker' }), rid()], 'invalid_input', /visaKind/);
    });
  });
});

describe('C3/C4 documents', () => {
  it('add from the catalogue or "Other"; duplicates by label key; 40 cap; remove only not received; removed rows kept', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      let a = await app(taskId, 1);
      const added = await one<{ documentId: string; rowVersion: number }>(VISA_A, SQL.docAdd, [a.applicationId, a.rowVersion,
        JSON.stringify({ catalogueCode: 'travel_insurance', received: true, remark: null }), rid()]);
      expect(added.rowVersion).toBe(a.rowVersion + 1);
      a = await app(taskId, 1);
      expect(a.documents.find((d) => d.catalogueCode === 'travel_insurance')).toMatchObject({ label: 'Travel insurance', status: 'received', source: 'desk' });
      // A typed label equal to a catalogue label (ignoring case and spaces) takes its code.
      await one(VISA_A, SQL.docAdd, [a.applicationId, a.rowVersion, JSON.stringify({ label: '  pan   CARD ', received: false }), rid()]);
      a = await app(taskId, 1);
      expect(a.documents.find((d) => d.catalogueCode === 'pan_card')).toMatchObject({ status: 'not_received', source: 'desk' });
      // "Other": no code.
      await one(VISA_A, SQL.docAdd, [a.applicationId, a.rowVersion, JSON.stringify({ label: 'Synthetic club membership card', received: false }), rid()]);
      a = await app(taskId, 1);
      expect(a.documents.find((d) => d.label === 'Synthetic club membership card')).toMatchObject({ catalogueCode: null });
      // Duplicates by label key (Sales label, catalogue code, typed).
      await refused(VISA_A, SQL.docAdd, [a.applicationId, a.rowVersion, JSON.stringify({ catalogueCode: 'passport_copy', received: false }), rid()], 'duplicate_document', '23505');
      await refused(VISA_A, SQL.docAdd, [a.applicationId, a.rowVersion, JSON.stringify({ label: 'SYNTHETIC club  membership card', received: false }), rid()], 'duplicate_document', '23505');
      await refusedHint(VISA_A, SQL.docAdd, [a.applicationId, a.rowVersion, JSON.stringify({ catalogueCode: 'not_a_code', received: false }), rid()], 'invalid_input');
      await refusedHint(VISA_A, SQL.docAdd, [a.applicationId, a.rowVersion, JSON.stringify({ catalogueCode: 'pan_card', label: 'PAN card', received: false }), rid()], 'invalid_input');
      await refusedHint(VISA_A, SQL.docAdd, [a.applicationId, a.rowVersion, JSON.stringify({ label: 'x'.repeat(121), received: false }), rid()], 'invalid_input', /label/);
      // Remove: received refused, not received soft-removed; the label can be added again.
      const received = a.documents.find((d) => d.status === 'received')!;
      await refused(VISA_A, SQL.docRemove, [received.documentId, a.rowVersion, rid()], 'document_received', '55000');
      const pan = a.documents.find((d) => d.catalogueCode === 'pan_card')!;
      await refused(VISA_A, SQL.docRemove, [pan.documentId, a.rowVersion - 1, rid()], 'version_changed', CONFLICT_STATE);
      await one(VISA_A, SQL.docRemove, [pan.documentId, a.rowVersion, rid()]);
      a = await app(taskId, 1);
      expect(a.documents.map((d) => d.documentId)).not.toContain(pan.documentId);
      const rows = await docRows(a.applicationId);
      expect(rows.find((r) => r.id === pan.documentId)).toMatchObject({ status: 'not_received' });
      expect(rows.find((r) => r.id === pan.documentId)!.removed_at).not.toBeNull();
      const [removedAudit] = await audits('visa.document_removed');
      expect(removedAudit!.details).toMatchObject({ taskId, seq: 1, documentId: pan.documentId, source: 'desk' });
      await one(VISA_A, SQL.docAdd, [a.applicationId, a.rowVersion, JSON.stringify({ catalogueCode: 'pan_card', received: false }), rid()]);
      // 40 non-removed documents at most.
      a = await app(taskId, 1);
      let rv = a.rowVersion;
      for (let i = a.documents.length; i < 40; i += 1) {
        rv = (await one<{ rowVersion: number }>(VISA_A, SQL.docAdd, [a.applicationId, rv, JSON.stringify({ label: `Synthetic extra document ${i}`, received: false }), rid()])).rowVersion;
      }
      await refused(VISA_A, SQL.docAdd, [a.applicationId, rv, JSON.stringify({ label: 'Synthetic one too many', received: false }), rid()], 'too_many_documents', '22023');
      const [addedAudit] = await audits('visa.document_added');
      expect(addedAudit!.details).toMatchObject({ taskId, seq: 1, catalogueCode: 'travel_insurance', custom: false, received: true });
      expect(JSON.stringify(await audits('visa.document_added'))).not.toMatch(/Synthetic club membership card/);
      // After Applied documents are frozen.
      const b2 = await h.appliedAlone(taskId, 2);
      await refused(VISA_A, SQL.docAdd, [b2.applicationId, b2.rowVersion, JSON.stringify({ catalogueCode: 'pan_card', received: false }), rid()], 'wrong_state', '55000');
    });
  });
});

describe('section 4 ready rule', () => {
  it('each notReady token on its own; e-visa ready without appointment; unknown kind needs a date or a kind; sticker and passport need a date', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      let a = await app(taskId, 1);
      expect(a.notReady).toEqual(['documents_missing', 'appointment_missing']);
      a = await makeReady(taskId, 1, { appointmentDate: null });
      expect(a.notReady).toEqual(['appointment_missing']);
      a = await makeReady(taskId, 1);
      expect([a.ready, a.notReady]).toEqual([true, []]);
      // no_documents: every document removed.
      let b = await app(taskId, 2);
      let rv = b.rowVersion;
      for (const d of b.documents) rv = (await one<{ rowVersion: number }>(VISA_A, SQL.docRemove, [d.documentId, rv, rid()])).rowVersion;
      b = await app(taskId, 2);
      expect(b.notReady[0]).toBe('no_documents');
      expect(b.notReady).not.toContain('documents_missing');
      // wrong_state after Applied.
      await h.apply(taskId, [line(a)]);
      expect((await app(taskId, 1)).notReady).toContain('wrong_state');
    });
    await asOwner(db, async () => {
      const e = await book({ items: [{ type: 'visa', facts: EVISA }] });
      await one(VISA_A, SQL.claim, [e.tasks[0]]);
      const a = await makeReady(e.tasks[0]!, 1, { appointmentDate: null });
      expect([a.ready, a.notReady]).toEqual([true, []]);
    });
    await asOwner(db, async () => {
      const u = await book({ items: [{ type: 'visa', facts: BLANK_KIND }] });
      const taskId = u.tasks[0]!;
      await one(VISA_A, SQL.claim, [taskId]);
      let a = await makeReady(taskId, 1, { appointmentDate: null });
      // Section 4: kind null means an appointment is needed, so both tokens apply (in order).
      expect(a.notReady).toEqual(['appointment_missing', 'kind_missing']);
      a = await makeReady(taskId, 2);
      expect([a.ready, a.notReady]).toEqual([true, []]); // a date makes it ready without a kind
      const c = await app(taskId, 1);
      await one(VISA_A, SQL.setRow, [c.applicationId, c.rowVersion, JSON.stringify({ visaKind: 'e_visa' }), rid()]);
      expect((await app(taskId, 1)).ready).toBe(true);
      const d = await app(taskId, 3);
      await one(VISA_A, SQL.setRow, [d.applicationId, d.rowVersion, JSON.stringify({ visaKind: 'sticker',
        documents: d.documents.map((x) => ({ documentId: x.documentId, received: true })) }), rid()]);
      expect((await app(taskId, 3)).notReady).toEqual(['appointment_missing']);
    });
    await asOwner(db, async () => {
      const p = await book({ items: [{ type: 'passport', facts: PASSPORT }] });
      const taskId = p.tasks[0]!;
      await one(VISA_A, SQL.claim, [taskId]);
      let a = await app(taskId, 1);
      await one(VISA_A, SQL.docAdd, [a.applicationId, a.rowVersion, JSON.stringify({ catalogueCode: 'old_passports', received: true }), rid()]);
      a = await app(taskId, 1);
      expect(a.notReady).toEqual(['appointment_missing']);
      a = await makeReady(taskId, 1, { appointmentDate: istBusinessDate() });
      expect(a.ready).toBe(true);
    });
  });

  it('the documents needed by Sales are the catalogue labels with their codes; the catalogue is offered to the assignee only', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const w = (await workspace(taskId))!;
      expect(w.catalogue).toHaveLength(25);
      expect(w.catalogue![0]).toEqual({ code: 'passport_copy', label: 'Passport copy (front and back)' });
      expect(STICKER_DOCS).toHaveLength(3);
      expect((w.facts as { visa: Record<string, unknown> }).visa).toMatchObject({ visaKind: 'sticker', jurisdiction: 'yes', jurisdictionPlace: 'New Delhi',
        documentsNeeded: STICKER.documentsNeeded });
    });
  });
});
