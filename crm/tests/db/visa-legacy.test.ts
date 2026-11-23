import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_EMAILS, FIXTURE_USERS, type TestDb, asOwner, expectDbError, fixtureFiles, migrationFiles } from '../helpers/db';
import { TRAVELLERS } from './b1-support';
import { ACC } from './finance-support';
import { APP_STATE_SQL, APP_UPDATE_SQL, COST_SAVE_SQL, COST_SUBMIT_SQL, DESK, EXPENSE_ACCEPT_SQL, EXPENSE_RETURN_SQL, VISA_CLAIM_SQL, VISA_GET_SQL, b11Helpers } from './b11-support';
import { SQL, VISA_A, rid, visaHelpers } from './visa-e-support';

/**
 * Visa build, contract 5.8 and 12.1 "Legacy-row migration": a database at
 * the live schema (every migration up to 20261201000910) gets visa rows in
 * every old shape through the OLD desk commands, COMMITTED; then the visa
 * migrations (everything after 20261201000910) run, and the defensive
 * mappings are checked:
 *   1. documents map missing/received/checked -> rows not_received/received/received,
 *      catalogue labels, unknown codes initcap; the map column is left as is;
 *   2. appointment_at -> IST date and time;
 *   3. submitted -> applied_on (IST), state kept and read as Applied;
 *   4. closed under the old rule -> closed_reason 'legacy';
 *   5. issued without return -> open, "Record handover" (C7 accepted);
 *   6. name/type snapshots from the current version;
 *   7. cost entries untouched, application_id null, accepted immutable, returned
 *      fixable by C12, accepted refused cost_locked;
 *   8. refused without a reason: "Reason not recorded" (reason null);
 *   plus duplicate references deduplicated with " (2)" and audited (5.1).
 *
 * PGlite only: it needs a database built without the visa migrations (the
 * CI real-Postgres stack is already fully migrated).
 */

const url = process.env.TEST_DATABASE_URL;
const LIVE_HEAD = '20261201000910';
const root = join(import.meta.dirname, '..', '..');

let pg: PGlite;
let db: TestDb;
const h = b11Helpers(() => db);
const v = visaHelpers(() => db);
const { one, owner } = h;

type OldApp = { applicationId: string; seq: number; rowVersion: number };
const FIVE = [...TRAVELLERS, { fullName: 'Synthetic Traveller Five', type: 'adult', seq: 5 }];
const FEE = { costKind: 'government_fee', amountPaise: '650000', paidBy: 'company', paymentMode: 'upi', paidOn: '2026-10-10' };

const seeded = {
  taskId: '', apps: {} as Record<number, string>, entries: {} as Record<'draft' | 'submitted' | 'accepted' | 'returned', string>,
  costRows: [] as Array<{ id: string; j: Record<string, unknown> }>, updatedAt1: '',
};

async function buildPreVisaDb(): Promise<void> {
  pg = new PGlite();
  await pg.exec(readFileSync(join(root, 'tests', 'helpers', 'supabase-shim.sql'), 'utf8'));
  const users = Object.entries(FIXTURE_USERS)
    .map(([key, id]) => `('${id}', '${FIXTURE_EMAILS[key as keyof typeof FIXTURE_USERS]}')`).join(',\n');
  await pg.exec(`insert into auth.users (id, email) values ${users};`);
  for (const file of migrationFiles().filter((f) => basename(f).slice(0, 14) <= LIVE_HEAD)) await pg.exec(readFileSync(file, 'utf8'));
  for (const file of fixtureFiles()) await pg.exec(readFileSync(file, 'utf8'));
  db = {
    mode: 'pglite',
    async query(sql, params) { return (await pg.query(sql, params)).rows as never; },
    async exec(sql) { await pg.exec(sql); },
    async close() { await pg.close(); },
  };
}

/** Old desk flow (20261119000500 commands), committed. */
async function seedLegacy(): Promise<void> {
  await db.exec('begin');
  try {
    const { taskId } = await h.deskTask(FIVE);
    seeded.taskId = taskId;
    await one(DESK, VISA_CLAIM_SQL, [taskId]);
    const apps = (await one<{ applicants: OldApp[] }>(DESK, VISA_GET_SQL, [taskId])).applicants;
    const byseq = (s: number) => apps.find((a) => a.seq === s)!;
    for (const a of apps) seeded.apps[a.seq] = a.applicationId;
    const upd = (a: OldApp, rv: number, fields: unknown) => one<{ rowVersion: number }>(DESK, APP_UPDATE_SQL, [a.applicationId, rv, JSON.stringify(fields)]);
    const st = (a: OldApp, rv: number, state: string, ev: string | null = null) => one<{ rowVersion: number }>(DESK, APP_STATE_SQL, [a.applicationId, rv, state, ev]);
    // 1: documents map in every value plus an unknown code; appointment; reference duplicated (case) by 2.
    await upd(byseq(1), byseq(1).rowVersion, {
      documents: { passport_copy: 'missing', photo: 'received', bank_statement: 'checked', employer_letter_x: 'checked' },
      reference: 'SYN-DUP-1', appointmentAt: '2026-11-20T05:00:00Z', appointmentPlace: 'Synthetic centre',
    });
    // 2: submitted (kept as is).
    let r = await upd(byseq(2), byseq(2).rowVersion, { documents: { passport_copy: 'checked' }, reference: 'syn-dup-1' });
    await st(byseq(2), r.rowVersion, 'submitted');
    // 3: issued and documents returned (closed under the old rule).
    r = await upd(byseq(3), byseq(3).rowVersion, { documents: { passport_copy: 'checked' }, reference: 'SYN-L-3' });
    r = await st(byseq(3), r.rowVersion, 'submitted');
    r = await st(byseq(3), r.rowVersion, 'issued', await h.deskEvidence(DESK, taskId, 'authority_outcome', byseq(3).applicationId));
    await st(byseq(3), r.rowVersion, 'documents_returned');
    // 4: refused and customer informed (closed under the old rule), no reason column then.
    r = await upd(byseq(4), byseq(4).rowVersion, { documents: { passport_copy: 'checked' }, reference: 'SYN-L-4' });
    r = await st(byseq(4), r.rowVersion, 'submitted');
    r = await st(byseq(4), r.rowVersion, 'refused', await h.deskEvidence(DESK, taskId, 'authority_outcome', byseq(4).applicationId));
    await st(byseq(4), r.rowVersion, 'customer_informed');
    // 5: issued, nothing returned yet (open; "Record handover").
    r = await upd(byseq(5), byseq(5).rowVersion, { documents: { passport_copy: 'checked' }, reference: 'SYN-L-5' });
    r = await st(byseq(5), r.rowVersion, 'submitted');
    await st(byseq(5), r.rowVersion, 'issued', await h.deskEvidence(DESK, taskId, 'authority_outcome', byseq(5).applicationId));
    // Task-level cost entries in each expense state (old department_cost_save).
    type Saved = { entryId: string; rowVersion: number };
    const save = (fields: unknown) => one<Saved>(DESK, COST_SAVE_SQL, [taskId, null, 0, JSON.stringify(fields), rid()]);
    seeded.entries.draft = (await save(FEE)).entryId;
    for (const status of ['submitted', 'accepted', 'returned'] as const) {
      const receipt = await h.deskEvidence(DESK, taskId, 'fee_receipt');
      const saved = await save({ ...FEE, receiptEvidenceId: receipt });
      const sub = await one<Saved>(DESK, COST_SUBMIT_SQL, [saved.entryId, saved.rowVersion]);
      if (status === 'accepted') await one(ACC, EXPENSE_ACCEPT_SQL, [saved.entryId, sub.rowVersion, rid()]);
      if (status === 'returned') await one(ACC, EXPENSE_RETURN_SQL, [saved.entryId, sub.rowVersion, 'Synthetic: the receipt shows another amount', rid()]);
      seeded.entries[status] = saved.entryId;
    }
    await db.exec('reset role');
    seeded.costRows = await owner<{ id: string; j: Record<string, unknown> }>(
      'select id, to_jsonb(c) as j from public.department_cost_entries c where task_id = $1 order by id', [taskId]);
    seeded.updatedAt1 = (await owner<{ u: string }>('select updated_at::text as u from public.visa_applications where id = $1', [seeded.apps[1]]))[0]!.u;
    await db.exec('commit');
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

beforeAll(async () => {
  if (url) return;
  await buildPreVisaDb();
  await seedLegacy();
  // The visa build migrations (Track A 0100.., Track C 0200.., lead fixes 0900..).
  for (const file of migrationFiles().filter((f) => basename(f).slice(0, 14) > LIVE_HEAD)) await pg.exec(readFileSync(file, 'utf8'));
}, 300_000);
afterAll(async () => {
  await db?.close();
});

const appRow = async (seq: number) => (await owner<Record<string, unknown>>(
  `select a.*, to_char(a.appointment_date, 'YYYY-MM-DD') as appt_date, to_char(a.applied_on, 'YYYY-MM-DD') as applied_text,
     (a.applied_on = (a.submitted_at at time zone 'Asia/Kolkata')::date) as applied_ist
   from public.visa_applications a where a.id = $1`, [seeded.apps[seq]]))[0]!;

describe.skipIf(!!url)('Visa legacy mapping: PGlite only, needs a pre-visa database', () => {
  it('1: the documents map becomes rows (missing -> not received; received and checked -> received); unknown codes get initcap labels', async () => {
    const docs = await owner<{ catalogue_code: string | null; label: string; status: string; source: string; received_at: string | null; removed_at: string | null }>(
      `select catalogue_code, label, status, source, received_at::text, removed_at::text from public.visa_application_documents
       where application_id = $1 order by label`, [seeded.apps[1]]);
    expect(docs.map((d) => [d.catalogue_code, d.label, d.status, d.source])).toEqual([
      ['bank_statement', 'Bank statement (6 months)', 'received', 'legacy'],
      [null, 'Employer Letter X', 'received', 'legacy'],
      ['passport_copy', 'Passport copy (front and back)', 'not_received', 'legacy'],
      ['photo', 'Photo, white background', 'received', 'legacy'],
    ]);
    for (const d of docs) {
      expect(d.removed_at).toBeNull();
      if (d.status === 'received') expect(new Date(d.received_at!).getTime()).toBe(new Date(seeded.updatedAt1).getTime());
      else expect(d.received_at).toBeNull();
    }
    // checked -> received for the submitted ones; the map column is left as is.
    expect(await owner(`select status from public.visa_application_documents where application_id = $1`, [seeded.apps[2]])).toEqual([{ status: 'received' }]);
    expect((await appRow(1)).documents).toEqual({ passport_copy: 'missing', photo: 'received', bank_statement: 'checked', employer_letter_x: 'checked' });
  });

  it('2-3: appointment_at -> IST date and time; submitted keeps its state and gets applied_on in IST, read as Applied', async () => {
    const a1 = await appRow(1);
    expect(a1.appt_date).toBe('2026-11-20');
    expect(a1.appointment_time).toBe('10:30');
    const a2 = await appRow(2);
    expect(a2.state).toBe('submitted');
    expect(a2.applied_ist).toBe(true);
    await asOwner(db, async () => {
      const w = await v.workspace(seeded.taskId, VISA_A);
      const s2 = w!.applicants.find((a) => a.seq === 2)!;
      expect(s2.applied).toMatchObject({ appliedOn: a2.applied_text });
      expect(s2.decision).toBeNull();
      // Refused under the old commands has no reason column: "Reason not recorded" (reason null).
      const s4 = w!.applicants.find((a) => a.seq === 4)!;
      expect(s4.decision).toMatchObject({ outcome: 'rejected', reason: null });
    });
  });

  it('4-5: old-rule closed rows get closed_reason legacy; issued without return stays open and accepts C7', async () => {
    const a3 = await appRow(3);
    expect(a3).toMatchObject({ closed_reason: 'legacy' });
    expect(new Date(a3.closed_at as string).getTime()).toBe(new Date(a3.documents_returned_at as string).getTime());
    expect(a3.closed_by).toBe(a3.documents_returned_by);
    const a4 = await appRow(4);
    expect(a4).toMatchObject({ closed_reason: 'legacy' });
    expect(new Date(a4.closed_at as string).getTime()).toBe(new Date(a4.customer_informed_at as string).getTime());
    expect(a4.closed_by).toBe(a4.updated_by);
    for (const seq of [1, 2, 5]) expect((await appRow(seq)).closed_at, `seq ${seq} open`).toBeNull();
    expect((await appRow(5)).handover_method).toBeNull();
    await asOwner(db, async () => {
      const s5 = await v.app(seeded.taskId, 5);
      expect(s5).toMatchObject({ state: 'issued', closed: null });
      expect(s5.can.handover).toBe(true);
      const r = await one<{ closed: boolean }>(VISA_A, SQL.handover, [s5.applicationId, s5.rowVersion, JSON.stringify({ method: 'not_with_us' }), rid()]);
      expect(r.closed).toBe(true);
      expect(await owner('select closed_reason, handover_method from public.visa_applications where id = $1', [s5.applicationId]))
        .toEqual([{ closed_reason: 'not_with_us', handover_method: 'not_with_us' }]);
    });
  });

  it('6: name and type snapshots are filled from the current version', async () => {
    for (const t of FIVE) {
      const a = await appRow(t.seq);
      expect([a.traveller_name_snapshot, a.traveller_type_snapshot], `seq ${t.seq}`).toEqual([t.fullName, t.type]);
    }
  });

  it('duplicate legacy references: the later one gets " (2)", audited without the reference', async () => {
    const refs = [(await appRow(1)).reference as string, (await appRow(2)).reference as string].sort();
    expect(refs.filter((x) => / \(2\)$/.test(x))).toHaveLength(1);
    expect(refs.map((x) => x.replace(/ \(2\)$/, '').toLowerCase())).toEqual(['syn-dup-1', 'syn-dup-1']);
    const audit = await owner<{ details: unknown; reason: string | null }>(`select details, reason from public.audit_events where action = 'visa.reference_deduplicated'`);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit).toLowerCase()).not.toContain('syn-dup');
    // Other references untouched.
    expect((await appRow(3)).reference).toBe('SYN-L-3');
  });

  it('7: legacy cost entries are untouched (application_id null), task-level in the summary; accepted stays immutable', async () => {
    const after = await owner<{ id: string; j: Record<string, unknown> }>(
      'select id, to_jsonb(c) as j from public.department_cost_entries c where task_id = $1 order by id', [seeded.taskId]);
    expect(after.map((r) => r.id)).toEqual(seeded.costRows.map((r) => r.id));
    for (const [i, row] of after.entries()) {
      expect(row.j.application_id ?? null).toBeNull();
      const { application_id: _drop, ...rest } = row.j;
      void _drop;
      expect(rest).toEqual(seeded.costRows[i]!.j);
    }
    await asOwner(db, async () => {
      await expectDbError(db, () => owner('update public.department_cost_entries set amount_paise = 1 where id = $1', [seeded.entries.accepted]), {});
      const w = await v.workspace(seeded.taskId, VISA_A);
      expect(w!.costSummary.taskLevel.map((e) => e.entryId).sort()).toEqual(Object.values(seeded.entries).sort());
    });
  });

  it('7: the returned legacy fee is fixed by C12; accepted and submitted are cost_locked; a receipt-less draft needs a receipt', async () => {
    await asOwner(db, async () => {
      const rv = async (id: string) => (await owner<{ row_version: number }>('select row_version from public.department_cost_entries where id = $1', [id]))[0]!.row_version;
      const fields = JSON.stringify({ amountPaise: '640000', remark: null });
      const fixed = await one<{ outcome?: string }>(VISA_A, SQL.feeSend, [seeded.entries.returned, await rv(seeded.entries.returned), fields, rid()]);
      expect(fixed).toBeTruthy();
      expect(await owner('select expense_status, amount_paise::text as a, application_id from public.department_cost_entries where id = $1', [seeded.entries.returned]))
        .toEqual([{ expense_status: 'submitted', a: '640000', application_id: null }]);
      await v.refused(VISA_A, SQL.feeSend, [seeded.entries.accepted, await rv(seeded.entries.accepted), fields, rid()], 'cost_locked', '55000');
      await v.refused(VISA_A, SQL.feeSend, [seeded.entries.submitted, await rv(seeded.entries.submitted), fields, rid()], 'cost_locked', '55000');
      await v.refused(VISA_A, SQL.feeSend, [seeded.entries.draft, await rv(seeded.entries.draft), fields, rid()], 'receipt_required', '55000');
      // Existing visa rows stay submit-able by department_cost_submit (C15) once a receipt is on the entry: still receipt_required here.
      await v.refused(VISA_A, SQL.costSubmit, [seeded.entries.draft, await rv(seeded.entries.draft)], 'receipt_required', '55000');
    });
  });
});
