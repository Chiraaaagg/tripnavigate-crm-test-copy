import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { TRAVELLERS } from './b1-support';
import { ACC, DEAL, EVISA, OWNER, PASSPORT, SQL, STICKER, VISA_A, line, passportOf, rid, visaHelpers } from './visa-e-support';

/**
 * Visa build (contract 8 Nov 2026) test plan 12.1 "Revision" with lead
 * decision 16 (no matching of people by name): booking changes reach an
 * open desk task through authz.visa_sync_applications (section 7). A removed
 * traveller's application is kept and flagged (nothing deleted, fees stay);
 * a re-added traveller always gets a NEW application (no relink by name);
 * a rename in a revision draft flags "traveller changed" and blocks Applied
 * until C13; traveller numbers are never reused (QB1, 5.6); new Sales
 * documents reach only passengers not yet applied; field classes (QB6) and
 * deal_committed (QB3).
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = visaHelpers(() => db);
const { one, owner, refused, refusedHint, stickerTask, book, app, applicants, appRow, docRows, makeReady, apply, revise, workspace, audits, taskRow } = h;

const identity = (seq: number) => ({ dateOfBirth: '1990-05-17', nationality: 'Indian', passportNumber: passportOf(seq), passportExpiry: '2030-01-31' });
type Opened = { versionId: string; rowVersion: number };

/** In a revision draft: saves `travellers` and puts every one of them on `itemId`; new seqs get identity and ID proof. */
async function setTravellers(versionId: string, rowVersion: number, itemId: string, travellers: Array<{ seq: number; fullName: string; type: string; ageYears?: number }>) {
  const before = await owner<{ seq: number; full_name: string }>('select seq, full_name from public.deal_travellers where deal_id = $1', [DEAL]);
  let rv = (await h.saveTravellers(OWNER, DEAL, rowVersion, travellers)).rowVersion;
  for (const t of travellers) {
    const was = before.find((x) => x.seq === t.seq);
    if (!was) await h.saveIdentity(OWNER, DEAL, t.seq, 0, identity(t.seq));
    // A new or renamed traveller needs a fresh ID proof (B1.2 readiness rule).
    if (!was || was.full_name !== t.fullName) await h.storeIdProof(OWNER, DEAL, t.seq);
  }
  rv = (await h.saveParticipation(OWNER, itemId, versionId, rv, travellers.map((t) => t.seq))).rowVersion;
  return rv;
}
const T = (seq: number, fullName: string, type = 'adult') => ({ seq, fullName, type });

describe('removed and re-added travellers (section 7 steps 2-3, lead decision 16)', () => {
  it('(a) a removed traveller keeps the application flagged removed, nothing deleted, fees stay; (b) re-added -> new application, never relinked', async () => {
    await asOwner(db, async () => {
      const s = await stickerTask();
      const four = await app(s.taskId, 4);
      const applied3 = await makeReady(s.taskId, 3);
      await apply(s.taskId, [line(applied3)]);
      // Revision 1 removes travellers 3 (applied, with a fee) and 4 (not applied).
      const v2 = await revise(s.versionId, (versionId, rv) => setTravellers(versionId, rv, s.itemIds[0]!, TRAVELLERS.slice(0, 2) as never));
      const w = (await workspace(s.taskId))!;
      const removed = w.applicants.filter((a) => a.removed);
      expect(removed.map((a) => [a.seq, a.state])).toEqual([[3, 'decision_pending'], [4, 'docs_pending']]);
      expect(w.applicants.slice(-2).every((a) => a.removed)).toBe(true); // removed ones last
      const row4 = await appRow(four.applicationId);
      expect(row4.removed_at).not.toBeNull();
      expect(row4.removed_version_id).toBe(v2);
      expect(row4.state).toBe('docs_pending');
      expect(await docRows(four.applicationId)).toHaveLength(3);
      expect(await owner('select count(*)::int as n from public.department_cost_entries where application_id = $1', [applied3.applicationId])).toEqual([{ n: 1 }]);
      expect(w.bookingChange).toMatchObject({ removed: [{ seq: 3 }, { seq: 4 }], added: [], back: [] });
      const [synced] = await audits('visa.booking_synced', s.taskId);
      expect(synced!.details).toMatchObject({ versionId: v2, addedSeqs: [] });
      expect([...(synced!.details.removedSeqs as number[])].sort()).toEqual([3, 4]);
      expect(await audits('visa.application_withdrawn_by_revision')).toEqual([]);
      // Removed: only decide/handover/delivered/withdraw remain; row edits refused with applicant_removed.
      const r4 = removed.find((a) => a.seq === 4)!;
      await refused(VISA_A, SQL.setRow, [r4.applicationId, r4.rowVersion, JSON.stringify({ remark: 'Synthetic' }), rid()], 'applicant_removed', '55000');
      await refused(VISA_A, SQL.docAdd, [r4.applicationId, r4.rowVersion, JSON.stringify({ catalogueCode: 'pan_card', received: false }), rid()], 'applicant_removed', '55000');
      expect(r4.notReady[0]).toBe('removed');
      // Removed docs_pending does not block completion; removed applied does until closed (VL1).
      for (const seq of [1, 2]) {
        const a = await app(s.taskId, seq);
        await one(VISA_A, SQL.withdraw, [a.applicationId, a.rowVersion, JSON.stringify({ reason: 'Synthetic: not needed', customerInformed: true }), rid()]);
      }
      expect((await taskRow(s.taskId)).status).toBe('in_progress');
      const r3 = (await applicants(s.taskId)).find((a) => a.seq === 3)!;
      const done = await one<{ taskCompleted: boolean }>(VISA_A, SQL.withdraw, [r3.applicationId, r3.rowVersion,
        JSON.stringify({ reason: 'Synthetic: removed from the booking', customerInformed: true }), rid()]);
      expect(done.taskCompleted).toBe(true);
    });
  });

  it('(b) the same person re-added (new number, same name and type) gets a new application; the removed records stay apart', async () => {
    await asOwner(db, async () => {
      const s = await stickerTask();
      const old = await app(s.taskId, 4);
      const v2 = await revise(s.versionId, (versionId, rv) => setTravellers(versionId, rv, s.itemIds[0]!, TRAVELLERS.slice(0, 3) as never));
      await revise(v2, (versionId, rv) => setTravellers(versionId, rv, s.itemIds[0]!,
        [...TRAVELLERS.slice(0, 3), { seq: 5, fullName: 'Synthetic Traveller Four', type: 'child', ageYears: 9 }] as never));
      const w = (await workspace(s.taskId))!;
      const fours = w.applicants.filter((a) => a.fullName === 'Synthetic Traveller Four');
      expect(fours.map((a) => [a.seq, a.removed])).toEqual([[5, false], [4, true]]);
      expect(fours[0]!.applicationId).not.toBe(old.applicationId);
      expect((await appRow(old.applicationId)).traveller_seq).toBe(4);
      expect(await audits('visa.application_relinked')).toEqual([]);
      expect(w.bookingChange).toMatchObject({ added: [{ seq: 5 }], back: [] });
      // Its Sales documents are seeded fresh (not_received).
      expect(fours[0]!.documents.map((d) => [d.label, d.status])).toEqual(STICKER.documentsNeeded.map((l) => [l, 'not_received']));
    });
  });
});

describe('traveller numbers are never reused (QB1, 5.6)', () => {
  it('(f) deal_travellers_save refuses a removed seq (traveller_seq_reused); travellerSeqHigh and deal_traveller_seq_high count every source', async () => {
    await asOwner(db, async () => {
      const s = await stickerTask();
      const v2 = await revise(s.versionId, (versionId, rv) => setTravellers(versionId, rv, s.itemIds[0]!, TRAVELLERS.slice(0, 3) as never));
      expect(await owner('select authz.deal_traveller_seq_high($1) as n', [DEAL])).toEqual([{ n: 4 }]);
      await one(ACC, SQL.reviewReturn, [v2, 'Synthetic return: add the child back', rid()]);
      const opened = await one<Opened>(OWNER, SQL.openRevision, [v2]);
      const form = await one<{ travellerSeqHigh: number }>(OWNER, SQL.formGet, [DEAL]);
      expect(form.travellerSeqHigh).toBe(4);
      await refused(OWNER, SQL.travellers, [DEAL, opened.rowVersion, JSON.stringify([...TRAVELLERS.slice(0, 3), TRAVELLERS[3]])], 'traveller_seq_reused', '22023');
      // A number above the high-water is fine.
      await one(OWNER, SQL.travellers, [DEAL, opened.rowVersion, JSON.stringify([...TRAVELLERS.slice(0, 3), { ...TRAVELLERS[3], seq: 5 }])]);
      expect(await owner('select authz.deal_traveller_seq_high($1) as n', [DEAL])).toEqual([{ n: 5 }]);
    });
  });
});

describe('renames (section 4 "traveller changed", VL23)', () => {
  it('(d) a rename in a revision draft flags traveller changed; Applied refused until C13 "OK, checked"; decisions not blocked', async () => {
    await asOwner(db, async () => {
      const s = await stickerTask();
      await makeReady(s.taskId, 2);
      const v2 = await revise(s.versionId, (versionId, rv) => setTravellers(versionId, rv, s.itemIds[0]!,
        TRAVELLERS.map((t) => (t.seq === 2 ? { ...t, fullName: 'Synthetic Traveller Second' } : t)) as never));
      let a = await app(s.taskId, 2);
      expect(a.travellerChanged).toEqual({ was: 'Synthetic Traveller Two', now: 'Synthetic Traveller Second' });
      expect(a.notReady).toContain('traveller_changed');
      expect(a.can.confirmTraveller).toBe(true);
      expect((await workspace(s.taskId))!.bookingChange).toMatchObject({ renamed: [{ seq: 2, oldName: 'Synthetic Traveller Two', newName: 'Synthetic Traveller Second' }] });
      await refusedHint(VISA_A, SQL.apply, [s.taskId, JSON.stringify({ applicants: [line(a)], paidBy: 'customer_direct' }), rid()], 'not_ready', /applicants\[0\]:traveller_changed/)
        .catch(async () => refused(VISA_A, SQL.apply, [s.taskId, JSON.stringify({ applicants: [line(a)], paidBy: 'customer_direct' }), rid()], 'traveller_changed', '55000'));
      const ok = await one<{ outcome: string; rowVersion: number }>(VISA_A, SQL.confirmTraveller, [a.applicationId, a.rowVersion, rid()]);
      expect(ok.outcome).toBe('updated');
      expect(await appRow(a.applicationId)).toMatchObject({ traveller_name_snapshot: 'Synthetic Traveller Second' });
      a = await app(s.taskId, 2);
      expect(a.travellerChanged).toBeNull();
      expect(await one<{ outcome: string }>(VISA_A, SQL.confirmTraveller, [a.applicationId, a.rowVersion, rid()])).toMatchObject({ outcome: 'existing' });
      expect(await audits('visa.traveller_change_confirmed', a.applicationId)).toHaveLength(1);
      await apply(s.taskId, [line(a)], { paidBy: 'customer_direct' });
      // A rename after Applied flags it but does not block the decision.
      await revise(v2, (versionId, rv) => setTravellers(versionId, rv, s.itemIds[0]!,
        TRAVELLERS.map((t) => (t.seq === 2 ? { ...t, fullName: 'Synthetic Traveller Deux' } : t)) as never));
      a = await app(s.taskId, 2);
      expect(a.travellerChanged).not.toBeNull();
      expect((await h.decide(s.taskId, a, 'approved')).state).toBe('issued');
    });
  });

  it('(e) a traveller named only later (snapshot null) is filled silently by sync: no "traveller changed"', async () => {
    await asOwner(db, async () => {
      const s = await stickerTask();
      const a = await app(s.taskId, 1);
      await owner('update public.visa_applications set traveller_name_snapshot = null, traveller_type_snapshot = null where id = $1', [a.applicationId]);
      expect((await app(s.taskId, 1)).travellerChanged).toBeNull();
      await owner('select authz.visa_sync_applications($1)', [s.taskId]);
      expect(await appRow(a.applicationId)).toMatchObject({ traveller_name_snapshot: 'Synthetic Traveller One', traveller_type_snapshot: 'adult' });
      expect((await app(s.taskId, 1)).travellerChanged).toBeNull();
    });
  });
});

describe('Sales facts in a revision', () => {
  it('(g) new Sales documents reach only docs_pending applicants; nothing removed or un-received; removed labels not re-added', async () => {
    await asOwner(db, async () => {
      const s = await stickerTask();
      const applied = await makeReady(s.taskId, 1);
      await apply(s.taskId, [line(applied)], { paidBy: 'customer_direct' });
      let two = await makeReady(s.taskId, 2); // all three received
      // Applicant 3 removes "Bank statement" (not received).
      let three = await app(s.taskId, 3);
      await one(VISA_A, SQL.docRemove, [three.documents.find((d) => d.catalogueCode === 'bank_statement')!.documentId, three.rowVersion, rid()]);
      const facts = { ...STICKER, documentsNeeded: ['Passport copy (front and back)', 'Travel insurance', 'Bank statement (6 months)'] };
      await revise(s.versionId, async (versionId, rv) => (await one<{ rowVersion: number }>(OWNER, SQL.saveItem, [s.itemIds[0], versionId, rv, JSON.stringify(facts), '0'])).rowVersion,
        { cls: 'format_only' });
      const labels = async (seq: number) => (await app(s.taskId, seq)).documents.map((d) => `${d.label}:${d.status}:${d.source}`).sort();
      expect(await labels(1)).toEqual(applied.documents.map((d) => `${d.label}:received:sales`).sort()); // applied: unchanged
      two = await app(s.taskId, 2);
      expect(await labels(2)).toEqual(['Bank statement (6 months):received:sales', 'Passport copy (front and back):received:sales',
        'Photo, white background:received:sales', 'Travel insurance:not_received:sales']); // photo kept, insurance added
      three = await app(s.taskId, 3);
      expect(three.documents.map((d) => d.label)).not.toContain('Bank statement (6 months)');
      expect(three.documents.map((d) => d.label)).toContain('Travel insurance');
      expect((await workspace(s.taskId))!.bookingChange).toMatchObject({ documentsAdded: 3 });
      expect(two.ready).toBe(false);
    });
  });

  it('(h) documentsNeeded, jurisdiction and place allow format_only; visaKind needs customer_material (QB6)', async () => {
    expect(await db.query(`select authz.revision_field_class('items.1.documentsNeeded') as d, authz.revision_field_class('items.1.jurisdiction') as j,
      authz.revision_field_class('items.1.jurisdictionPlace') as p, authz.revision_field_class('items.1.visaKind') as k`))
      .toEqual([{ d: 'choice', j: 'choice', p: 'choice', k: 'material' }]);
    await asOwner(db, async () => {
      const b = await book({ items: [{ type: 'visa', facts: STICKER }] });
      await one(ACC, SQL.reviewReturn, [b.versionId, 'Synthetic return: visa kind', rid()]);
      const opened = await one<Opened>(OWNER, SQL.openRevision, [b.versionId]);
      const rv = (await one<{ rowVersion: number }>(OWNER, SQL.saveItem, [b.itemIds[0], opened.versionId, opened.rowVersion,
        JSON.stringify({ ...STICKER, visaKind: 'e_visa', jurisdiction: null, jurisdictionPlace: null }), '0'])).rowVersion;
      await refused(OWNER, SQL.classify, [opened.versionId, rv, 'format_only'], 'classification_not_allowed', '22023');
      expect(await one(OWNER, SQL.classify, [opened.versionId, rv, 'customer_material'])).toMatchObject({ changedFields: expect.arrayContaining(['items.1.visaKind']) });
    });
  });

  it('(i) deal_committed: a completed visa or passport task does not block a revision; (j) a participant added after completion is counted', async () => {
    await asOwner(db, async () => {
      const travellers = [T(1, 'Synthetic Traveller One')];
      const b = await book({ items: [{ type: 'passport', facts: PASSPORT }, { type: 'visa', facts: EVISA }], travellers });
      for (const t of b.tasks) await one(VISA_A, SQL.claim, [t]);
      const [passportTask, evisaTask] = b.tasks as [string, string];
      const p = await app(passportTask, 1);
      await one(VISA_A, SQL.withdraw, [p.applicationId, p.rowVersion, JSON.stringify({ reason: 'Synthetic: not needed', customerInformed: true }), rid()]);
      const e = await app(evisaTask, 1);
      await one(VISA_A, SQL.withdraw, [e.applicationId, e.rowVersion, JSON.stringify({ reason: 'Synthetic: not needed', customerInformed: true }), rid()]);
      expect((await taskRow(passportTask)).status).toBe('completed');
      expect((await taskRow(evisaTask)).status).toBe('completed');
      expect(await owner('select authz.deal_committed($1) as c', [DEAL])).toEqual([{ c: false }]);
      // The revision opens and adds traveller 2 to the e-visa item.
      await revise(b.versionId, async (versionId, rv) => {
        let next = (await h.saveTravellers(OWNER, DEAL, rv, [...travellers, T(2, 'Synthetic Traveller Two')])).rowVersion;
        await h.saveIdentity(OWNER, DEAL, 2, 0, identity(2));
        await h.storeIdProof(OWNER, DEAL, 2);
        next = (await h.saveParticipation(OWNER, b.itemIds[1]!, versionId, next, [1, 2])).rowVersion;
        return next;
      });
      expect((await taskRow(evisaTask)).status).toBe('completed'); // completed is final
      const w = (await workspace(evisaTask))!;
      expect(w.addedAfterCompletion).toBe(1);
      expect(w.applicants.map((a) => a.seq)).toEqual([1]);
      const summary = await one<{ tasks: Array<{ taskId: string; addedAfterCompletion: number }> }>(OWNER, SQL.dealSummary, [DEAL]);
      expect(summary.tasks.find((t) => t.taskId === evisaTask)!.addedAfterCompletion).toBe(1);
    });
  });
});
