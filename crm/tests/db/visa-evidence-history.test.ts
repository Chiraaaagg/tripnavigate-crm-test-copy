import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, type TestDb, asOwner, createTestDb, istBusinessDate } from '../helpers/db';
import { LEG_JDH_DEL, flightHelpers, typedFlight } from './flight-support';
import { TRAVELLERS } from './b1-support';
import { ACC, DEAL, EVISA, FLIGHT, MANAGER, OWNER, PURCHASE, SALES_B, SQL, STICKER, VISA_A, VISA_B, line, rid, visaHelpers } from './visa-e-support';

/**
 * Visa build, contract 12.1 "Evidence" and "History":
 *   - a visa task holds 200 non-removed files; Flight keeps 50 (C11, VL25);
 *   - C11 links an uploaded file to its document and application;
 *   - applicant documents: the desk (assignee and other Visa) and the branch
 *     Manager download; Sales, Purchase, Flight and Accounts never; Accounts
 *     only receipts of expense records it reviews;
 *   - department_task_history shows every new visa kind of 9.4 with
 *     applicantSeq, clubSize and method; the identity save is not shown;
 *   - deal_visa_history: Sales owner and Manager only (VL5), newest first, a
 *     club of three collapses into one "applied" event.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = visaHelpers(() => db);
/** Traveller 1 renamed in a revision draft (5.6: renames only in revision drafts). */
const TRAVELLERS_RENAMED = TRAVELLERS.map((t) => (t.seq === 1 ? { ...t, fullName: 'Synthetic Traveller Renamed' } : t));
const fh = flightHelpers(() => db);
const { one, owner } = h;

/** SYNTHETIC FIXTURE: `n` stored files on a task, written as the table owner (near the file limit). */
async function seedFiles(taskId: string, n: number, uploader: string): Promise<void> {
  await owner(
    `insert into public.department_evidence (id, task_id, legal_entity_id, kind, object_path, file_name, mime, size_bytes, sha256, uploaded_by, status, stored_at)
     select x.id, t.id, t.legal_entity_id, 'other', t.legal_entity_id::text || '/' || t.id::text || '/' || x.id::text, 'seed.pdf', 'application/pdf',
            10, repeat('a', 64), $3, 'stored', now()
     from public.fulfilment_tasks t cross join lateral (select gen_random_uuid() as id from generate_series(1, $2::int)) x
     where t.id = $1`, [taskId, n, uploader]);
}
const begin = (actor: Actor, taskId: string, kind = 'other') =>
  h.attempt<{ evidenceId: string }>(actor, SQL.evBegin, [taskId, null, kind, 'file.pdf', 'application/pdf', 2048, 'c'.repeat(64)]);

describe('evidence (C11, VL25)', () => {
  it('a visa task holds 200 non-removed files', async () => {
    await asOwner(db, async () => {
      const { taskId } = await h.stickerTask();
      await seedFiles(taskId, 199, VISA_A.userId!);
      const ok = await begin(VISA_A, taskId);
      expect(ok.ok, ok.ok ? '' : ok.error).toBe(true);
      const over = await begin(VISA_A, taskId);
      expect(over).toMatchObject({ ok: false, error: 'evidence_rejected' });
    });
  });

  it('a flight task keeps the limit of 50', async () => {
    await asOwner(db, async () => {
      await fh.addFlightPeople();
      const b = await fh.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]) }]);
      await fh.claim();
      const task = b.flightTasks[0]!;
      const [assignee] = await owner<{ a: string }>('select assignee_user_id::text as a from public.fulfilment_tasks where id = $1', [task]);
      await seedFiles(task, 49, assignee!.a);
      const ok = await begin({ userId: assignee!.a }, task);
      expect(ok.ok, ok.ok ? '' : ok.error).toBe(true);
      expect(await begin({ userId: assignee!.a }, task)).toMatchObject({ ok: false, error: 'evidence_rejected' });
    });
  });

  it('C11 links the file to the document and application; downloads by the desk and Manager only; Accounts only reviewed receipts', async () => {
    await asOwner(db, async () => {
      await h.addVisaB();
      await h.addFlightPerson();
      const { taskId } = await h.stickerTask();
      const a = await h.app(taskId, 1);
      const doc = a.documents[0]!;
      await h.refused(VISA_B, SQL.docFileBegin, [doc.documentId, 'passport.pdf', 'application/pdf', 2048, 'd'.repeat(64)], 'not_authorized', '42501');
      const begun = await one<{ evidenceId: string; objectPath: string }>(VISA_A, SQL.docFileBegin,
        [doc.documentId, 'passport.pdf', 'application/pdf', 2048, 'd'.repeat(64)]);
      expect(await owner('select kind, application_id, visa_document_id from public.department_evidence where id = $1', [begun.evidenceId]))
        .toEqual([{ kind: 'applicant_document', application_id: a.applicationId, visa_document_id: doc.documentId }]);
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('department-evidence', $1, jsonb_build_object('size', 2048::bigint))`,
        [begun.objectPath]);
      expect(await one<{ status: string }>(VISA_A, SQL.evFinish, [begun.evidenceId, true])).toMatchObject({ status: 'stored' });
      // The workspace shows the file under its document.
      const after = await h.app(taskId, 1);
      expect(after.documents.find((d) => d.documentId === doc.documentId)!.files.map((f) => f.evidenceId)).toEqual([begun.evidenceId]);
      for (const actor of [VISA_A, VISA_B, MANAGER]) expect(await one(actor, SQL.evDownload, [begun.evidenceId])).toMatchObject({ mime: 'application/pdf' });
      for (const actor of [OWNER, PURCHASE, FLIGHT, ACC]) await h.refused(actor, SQL.evDownload, [begun.evidenceId], 'not_authorized', '42501');
      // A removed document takes no file.
      const added = await one<{ documentId: string; rowVersion: number }>(VISA_A, SQL.docAdd,
        [a.applicationId, after.rowVersion, JSON.stringify({ label: 'Synthetic other paper', received: false, remark: null }), rid()]);
      await one(VISA_A, SQL.docRemove, [added.documentId, added.rowVersion, rid()]);
      const removed = await h.attempt(VISA_A, SQL.docFileBegin, [added.documentId, 'other.pdf', 'application/pdf', 2048, 'e'.repeat(64)]);
      expect(removed.ok).toBe(false);
      // Receipts: Accounts opens the receipt of a submitted entry, not a loose one.
      const ready = await h.makeReady(taskId, 1);
      const receipt = await h.evidence(VISA_A, taskId, 'fee_receipt');
      const loose = await h.evidence(VISA_A, taskId, 'fee_receipt');
      await h.apply(taskId, [line(ready)], { receiptEvidenceId: receipt });
      expect(await owner('select expense_status from public.department_cost_entries where application_id = $1', [a.applicationId]))
        .toEqual([{ expense_status: 'submitted' }]);
      expect(await one(ACC, SQL.evDownload, [receipt])).toMatchObject({ mime: 'application/pdf' });
      await h.refused(ACC, SQL.evDownload, [loose], 'not_authorized', '42501');
      for (const actor of [OWNER, PURCHASE, FLIGHT]) await h.refused(actor, SQL.evDownload, [receipt], 'not_authorized', '42501');
    });
  });
});

type HistoryEvent = { kind: string; at: string; applicantSeq?: number | null; clubSize?: number | null; method?: string | null; note?: string | null };
type DealEvent = { kind: string; at: string; taskId: string; title: string; travellerName: string | null; note: string | null };

/** A sticker task (4) and an e-visa task (1, 2) taken by VISA_A, worked through every step that writes a 9.4 kind. */
async function workedBooking() {
  const b = await h.book({ items: [{ type: 'visa', facts: STICKER }, { type: 'visa', facts: EVISA, participants: [1, 2] }] });
  const [sticker, evisa] = b.tasks as [string, string];
  await one(VISA_A, SQL.claim, [sticker]);
  await one(VISA_A, SQL.claim, [evisa]);
  // Document added and removed; passport number typed in the row (identity save, not shown in task history).
  let a1 = await h.app(sticker, 1);
  const added = await one<{ documentId: string; rowVersion: number }>(VISA_A, SQL.docAdd,
    [a1.applicationId, a1.rowVersion, JSON.stringify({ catalogueCode: 'travel_insurance', received: false, remark: null }), rid()]);
  await one(VISA_A, SQL.docRemove, [added.documentId, added.rowVersion, rid()]);
  a1 = await h.app(sticker, 1);
  await one(VISA_A, SQL.setRow, [a1.applicationId, a1.rowVersion, JSON.stringify({ passportNumber: 'Z7654321' }), rid()]);
  // Applied together (3), company-paid without a receipt (drafts); one fee sent with its receipt.
  const club = [await h.makeReady(sticker, 1), await h.makeReady(sticker, 2), await h.makeReady(sticker, 3)];
  await h.apply(sticker, club.map((a) => line(a)));
  const [fee] = await owner<{ id: string; row_version: number }>(
    `select id, row_version from public.department_cost_entries where application_id = $1 and cost_kind = 'government_fee'`, [club[0]!.applicationId]);
  const receipt = await h.evidence(VISA_A, sticker, 'fee_receipt');
  await one(VISA_A, SQL.feeSend, [fee!.id, fee!.row_version, JSON.stringify({ amountPaise: '650000', receiptEvidenceId: receipt, remark: null }), rid()]);
  // 1 approved, office, delivered; 2 rejected and applied again; 3 approved by courier; 4 withdrawn.
  await h.decide(sticker, await h.app(sticker, 1), 'approved', { handover: { method: 'office' } });
  const d1 = await h.app(sticker, 1);
  await one(VISA_A, SQL.delivered, [d1.applicationId, d1.rowVersion, JSON.stringify({ deliveredOn: istBusinessDate(), remark: null }), rid()]);
  await h.decide(sticker, await h.app(sticker, 2), 'rejected');
  const r2 = await h.app(sticker, 2);
  await one(VISA_A, SQL.reapply, [r2.applicationId, r2.rowVersion, rid()]);
  await h.decide(sticker, await h.app(sticker, 3), 'approved', { handover: { method: 'courier', courierNumber: 'SYN-COURIER-1' } });
  const a4 = await h.app(sticker, 4);
  await one(VISA_A, SQL.withdraw, [a4.applicationId, a4.rowVersion, JSON.stringify({ reason: 'Synthetic: the customer cancelled', customerInformed: true }), rid()]);
  // E-visa: applied without an appointment, approved with the typed e-mail (sent, closed).
  const e1 = await h.makeReady(evisa, 1, { appointmentDate: null });
  await h.apply(evisa, [line(e1)], { paidBy: 'customer_direct' });
  await h.decide(evisa, await h.app(evisa, 1), 'approved', { recipientEmail: 'evisa.one@example.test' });
  return { b, sticker, evisa };
}

describe('task history (9.4)', () => {
  it('every new visa kind appears with applicantSeq, clubSize and method; no identity, amounts, references or e-mails', async () => {
    await asOwner(db, async () => {
      const { sticker, evisa } = await workedBooking();
      const hist = await one<{ events: HistoryEvent[] }>(VISA_A, SQL.taskHistory, [sticker]);
      const kinds = new Set(hist.events.map((e) => e.kind));
      for (const k of ['taken', 'applicant_row_saved', 'document_added', 'document_removed', 'applied', 'fee_sent', 'approved', 'handover_set',
        'delivered', 'applicant_closed', 'rejected', 'reapplied', 'withdrawn']) expect(kinds.has(k), k).toBe(true);
      const applied = hist.events.filter((e) => e.kind === 'applied');
      expect(applied.map((e) => e.applicantSeq).sort()).toEqual([1, 2, 3]);
      expect(applied.every((e) => e.clubSize === 3)).toBe(true);
      expect(hist.events.filter((e) => e.kind === 'handover_set').map((e) => e.method).sort()).toEqual(['courier', 'office']);
      for (const e of hist.events.filter((x) => /^applicant_|^document_|^(applied|approved|rejected|withdrawn|handover_set|delivered|reapplied)$/.test(x.kind))) {
        expect(typeof e.applicantSeq, `${e.kind} carries applicantSeq`).toBe('number');
      }
      expect(hist.events.find((e) => e.kind === 'rejected')!.note).toBe('Synthetic refusal: bank statement too short');
      expect(hist.events.find((e) => e.kind === 'withdrawn')!.note).toBe('Synthetic: the customer cancelled');
      const text = JSON.stringify(hist);
      expect(text).not.toMatch(/identity|Z7654321|650000|SYN-REF|SYN-COURIER|@example\.test/);
      const ev = await one<{ events: HistoryEvent[] }>(VISA_A, SQL.taskHistory, [evisa]);
      for (const k of ['applied', 'approved', 'evisa_sent', 'applicant_closed']) expect(ev.events.some((e) => e.kind === k), k).toBe(true);
      expect(JSON.stringify(ev)).not.toMatch(/evisa\.one@example\.test/);
      // The branch Manager reads the history of a branch task (D2 widens can_read_task_history).
      expect(await one(MANAGER, SQL.taskHistory, [sticker])).not.toBeNull();
    });
  });

  it('a booking change shows booking_synced; "OK, checked" shows traveller_confirmed', async () => {
    await asOwner(db, async () => {
      const { taskId, versionId } = await h.stickerTask();
      await h.revise(versionId, async (_vid, rv) => {
        const next = (await h.saveTravellers(OWNER, DEAL, rv, TRAVELLERS_RENAMED)).rowVersion;
        await h.storeIdProof(OWNER, DEAL, 1); // a renamed traveller needs a fresh ID proof (B1.2 readiness)
        return next;
      });
      const a = await h.app(taskId, 1);
      expect(a.travellerChanged).not.toBeNull();
      await one(VISA_A, SQL.confirmTraveller, [a.applicationId, a.rowVersion, rid()]);
      const hist = await one<{ events: HistoryEvent[] }>(VISA_A, SQL.taskHistory, [taskId]);
      expect(hist.events.some((e) => e.kind === 'booking_synced')).toBe(true);
      expect(hist.events.find((e) => e.kind === 'traveller_confirmed')).toMatchObject({ applicantSeq: 1 });
      expect(JSON.stringify(hist)).not.toMatch(/Synthetic Traveller (One|Renamed)/);
    });
  });
});

describe('deal_visa_history (9.3, VL5)', () => {
  it('Sales owner and Manager only; newest first; a club of three is one applied event', async () => {
    await asOwner(db, async () => {
      await h.addOtherSales();
      await h.addFlightPerson();
      const { sticker, evisa } = await workedBooking();
      for (const actor of [SALES_B, ACC, PURCHASE, FLIGHT, VISA_A]) expect(await one(actor, SQL.dealHistory, [DEAL]), JSON.stringify(actor)).toBeNull();
      for (const actor of [OWNER, MANAGER]) {
        const hist = await one<{ events: DealEvent[]; truncated: boolean }>(actor, SQL.dealHistory, [DEAL]);
        expect(hist.truncated).toBe(false);
        const times = hist.events.map((e) => new Date(e.at).getTime());
        expect(times).toEqual([...times].sort((x, y) => y - x));
        expect(hist.events.filter((e) => e.kind === 'applied' && e.taskId === sticker)).toHaveLength(1);
        expect(hist.events.filter((e) => e.kind === 'applied' && e.taskId === evisa)).toHaveLength(1);
        const kinds = new Set(hist.events.map((e) => e.kind));
        for (const k of ['taken', 'applied', 'approved', 'rejected', 'withdrawn', 'evisa_sent', 'handed_over', 'delivered', 'reapplied']) {
          expect(kinds.has(k), k).toBe(true);
        }
        expect(hist.events.find((e) => e.kind === 'rejected')!.note).toBe('Synthetic refusal: bank statement too short');
        // No money, references, e-mails or passport numbers on a Deal read (9.3).
        expect(JSON.stringify(hist)).not.toMatch(/650000|SYN-REF|SYN-COURIER|@example\.test|Z7654321|Z100000/);
      }
    });
  });
});
