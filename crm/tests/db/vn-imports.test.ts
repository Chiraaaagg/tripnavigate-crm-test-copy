import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACCOUNTS, ANON, MANAGER, OWNER, PURCHASE, SUPER } from './b1-support';
import { GSTIN_08, REASON, SQL, rid, vnHelpers } from './vn-support';

/**
 * Voice-note batch, migration 20261128000140: protected imports of hotels and
 * customers. Rows shaped as the app's CSV parser stages them (strings or
 * null). Dry-run summary (columns, counts, invalid rows with reasons,
 * duplicates in the file and by source reference, same-name warnings,
 * proposed creates and updates), apply by the authorised role only
 * (hotels: Super Admin; customers: Accounts), idempotent, never overwriting a
 * checked record, never matching by name, audit and per-row history.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = vnHelpers(() => db);
const { one, owner, refused } = h;
const SHA = 'd'.repeat(64);

type Batch = Record<string, unknown> & {
  rowVersion: number;
  rowNotes: unknown[];
  proposed: Record<string, number>;
  invalidRows: unknown[];
  duplicateRows: unknown[];
  columns: Array<{ key: string }>;
  rows: Array<Record<string, unknown>>;
  items: unknown[];
};
const stage = async (actor: Actor, kind: string, rows: unknown[], branch: string | null = null, requestId = rid()) =>
  one<{ batchId: string; rowCount: number; outcome: string }>(actor, SQL.importStage,
    [await h.entity(), kind, branch, 'synthetic list.csv', SHA, JSON.stringify(rows), requestId]);
const validate = (actor: Actor, id: string) => one<Batch>(actor, SQL.importValidate, [id]);
const apply = (actor: Actor, id: string, rv: number) => one<Batch>(actor, SQL.importApply, [id, rv, REASON]);

const HOTELS = [
  { sourceRef: 'H-1', name: 'Synthetic Fort Hotel', city: 'Jodhpur', area: 'Old City', starCategory: '4', address: null },
  { sourceRef: 'H-2', name: 'Synthetic Lake Hotel', city: 'Udaipur', area: null, starCategory: '5 star', address: null },
  { sourceRef: null, name: 'Synthetic Fort Hotel', city: 'Jodhpur', area: null, starCategory: null, address: null },
  { sourceRef: 'H-3', name: '', city: 'Jodhpur', area: null, starCategory: '9', address: null },
  { sourceRef: 'H-4', name: 'Synthetic Twin A', city: 'Jaipur', area: null, starCategory: null, address: null },
  { sourceRef: 'H-4', name: 'Synthetic Twin B', city: 'Jaipur', area: null, starCategory: null, address: null },
  { sourceRef: 'H-5', name: 'Synthetic Pool Hotel', city: 'Jaipur', area: null, starCategory: null, address: null, colour: 'blue' },
];

describe('hotel import (Super Admin)', () => {
  it('dry run reports counts, reasons, duplicates and proposed creates; apply creates; a re-import updates by source reference only', async () => {
    await asOwner(db, async () => {
      for (const actor of [OWNER, MANAGER, ACCOUNTS, PURCHASE] as Actor[]) {
        await refused(actor, SQL.importStage, [await h.entity(), 'hotel', null, 'x.csv', SHA, JSON.stringify(HOTELS), rid()], '42501');
      }
      await refused(ANON, SQL.importStage, [await h.entity(), 'hotel', null, 'x.csv', SHA, JSON.stringify(HOTELS), rid()], '42501');
      const s = await stage(SUPER, 'hotel', HOTELS);
      expect(s).toMatchObject({ rowCount: 7, outcome: 'created' });
      const v = await validate(SUPER, s.batchId);
      expect(v).toMatchObject({ status: 'validated', rows: 7, valid: 3, invalid: 2, duplicatesInFile: 2, possibleDuplicates: 2,
        proposed: { create: 3, update: 0, unchanged: 0, skippedChecked: 0 }, fileName: 'synthetic list.csv' });
      expect(v.invalidRows).toEqual([{ rowNo: 4, reasons: ['name_missing', 'star_category_invalid'] }, { rowNo: 7, reasons: ['unknown_column'] }]);
      expect(v.duplicateRows).toEqual([
        { rowNo: 1, sourceRef: 'H-1', kind: 'same_name' }, { rowNo: 3, sourceRef: null, kind: 'same_name' },
        { rowNo: 5, sourceRef: 'H-4', kind: 'in_file' }, { rowNo: 6, sourceRef: 'H-4', kind: 'in_file' }]);
      expect(v.columns.map((c: { key: string }) => c.key)).toEqual(['address', 'area', 'city', 'colour', 'name', 'sourceRef', 'starCategory']);
      // The dry run wrote nothing to the catalogue.
      expect(await owner('select count(*)::int as n from public.hotel_catalogue')).toEqual([{ n: 0 }]);

      await refused(SUPER, SQL.importApply, [s.batchId, v.rowVersion, 'short'], '22023');
      await refused(SUPER, SQL.importApply, [s.batchId, v.rowVersion - 1, REASON], '40001', 'version_changed');
      const a = await apply(SUPER, s.batchId, v.rowVersion);
      expect(a).toEqual({ batchId: s.batchId, status: 'applied', created: 3, updated: 0, unchanged: 0, skippedChecked: 0, invalid: 4 });
      expect(await apply(SUPER, s.batchId, v.rowVersion)).toMatchObject({ created: 3, outcome: 'existing' });
      expect(await owner('select count(*)::int as n from public.hotel_catalogue where verification = $1', ['not_checked'])).toEqual([{ n: 3 }]);
      expect((await h.auditRows('import.applied'))[0]).toMatchObject({ reason: REASON, details: { kind: 'hotel', created: 3 } });

      // Re-import: H-1 renamed (update), H-2 checked meanwhile (skipped), a name-only row (new record, warning), H-9 new.
      const [h2] = await owner<{ id: string }>(`select id from public.hotel_catalogue where source_ref = 'H-2'`);
      await one(SUPER, SQL.hotelSave, [await h.entity(), h2!.id, 1, JSON.stringify({ verification: 'checked' }), REASON]);
      const s2 = await stage(SUPER, 'hotel', [
        { sourceRef: 'H-1', name: 'Synthetic Fort Hotel Renamed', city: 'Jodhpur' },
        { sourceRef: 'H-2', name: 'Synthetic Lake Hotel Overwrite', city: 'Udaipur' },
        { sourceRef: null, name: 'Synthetic Lake Hotel', city: 'Udaipur' },
        { sourceRef: 'H-9', name: 'Synthetic New Hotel', city: 'Bikaner' },
      ]);
      const v2 = await validate(SUPER, s2.batchId);
      expect(v2.proposed).toEqual({ create: 2, update: 1, unchanged: 0, skippedChecked: 1 });
      const a2 = await apply(SUPER, s2.batchId, v2.rowVersion);
      expect(a2).toMatchObject({ created: 2, updated: 1, skippedChecked: 1 });
      expect(await owner(`select name, area, star_category from public.hotel_catalogue where source_ref in ('H-1', 'H-2') order by source_ref`))
        .toEqual([
          // Columns missing from the file (area, starCategory) keep the stored values.
          { name: 'Synthetic Fort Hotel Renamed', area: 'Old City', star_category: '4' },
          { name: 'Synthetic Lake Hotel', area: null, star_category: '5' }]);
      const got = await one<Batch>(SUPER, SQL.importGet, [s2.batchId, 100, 0]);
      expect(got.rows.map((r: Record<string, unknown>) => [r.rowNo, r.outcome])).toEqual([[1, 'update'], [2, 'skipped_checked'], [3, 'create'], [4, 'create']]);
      expect(await owner<{ before: Record<string, unknown> }>('select before from public.import_rows where batch_id = $1 and row_no = 1', [s2.batchId]))
        .toEqual([{ before: { name: 'Synthetic Fort Hotel', city: 'Jodhpur', area: 'Old City', address: null, starCategory: '4', status: 'active' } }]);
      expect((await one<Batch>(SUPER, SQL.importList, ['hotel', 20])).items).toHaveLength(2);
      await refused(ACCOUNTS, SQL.importList, ['hotel', 20], '42501');
      expect(await one(ACCOUNTS, SQL.importGet, [s2.batchId, 100, 0])).toBeNull();
    });
  });

  it('apply refuses a stale dry run and an unvalidated or cancelled batch; staging is idempotent by request id', async () => {
    await asOwner(db, async () => {
      const req = rid();
      const s = await stage(SUPER, 'hotel', [{ sourceRef: 'S-1', name: 'Synthetic Stale', city: 'Jaipur' }], null, req);
      expect(await stage(SUPER, 'hotel', [{ sourceRef: 'S-1', name: 'Synthetic Stale', city: 'Jaipur' }], null, req))
        .toMatchObject({ batchId: s.batchId, outcome: 'existing' });
      await refused(SUPER, SQL.importApply, [s.batchId, 1, REASON], '55000', 'import_not_validated');
      const v = await validate(SUPER, s.batchId);
      // A record with that source reference appears after the dry run.
      await one(SUPER, SQL.hotelSave, [await h.entity(), null, 0, JSON.stringify({ name: 'Synthetic Other', city: 'Jaipur', sourceRef: 'S-1' }), REASON]);
      await refused(SUPER, SQL.importApply, [s.batchId, v.rowVersion, REASON], '40001', 'import_stale');
      const c = await one<Batch>(SUPER, SQL.importCancel, [s.batchId, v.rowVersion]);
      expect(c).toMatchObject({ status: 'cancelled' });
      await refused(SUPER, SQL.importValidate, [s.batchId], '55000', 'wrong_state');
      await refused(SUPER, SQL.importStage, [await h.entity(), 'hotel', null, 'x.csv', SHA, JSON.stringify(new Array(5001).fill({ name: 'x' })), rid()],
        '22023', 'import_too_large');
      await refused(SUPER, SQL.importStage, [await h.entity(), 'hotel', null, 'x.csv', SHA, JSON.stringify([{ 'bad key': 'x' }]), rid()],
        '22023', 'invalid_input');
    });
  });
});

describe('customer import (Accounts)', () => {
  const CUSTOMERS = [
    { sourceRef: 'C-1', partyType: 'personal', name: 'Synthetic Import Person', phone: '98765 00061', stateCode: '8', postalCode: '342001' },
    { sourceRef: 'C-2', partyType: 'business', name: 'Synthetic Import Co', gstin: GSTIN_08, stateCode: '08', city: 'Jodhpur' },
    { sourceRef: 'C-3', partyType: 'business', name: 'Synthetic Unknown GST Co' },
    { sourceRef: 'C-4', partyType: 'company', name: 'Synthetic Bad Type', email: 'not-an-email' },
    { sourceRef: 'C-5', partyType: 'personal', name: 'Synthetic GST Person', gstin: GSTIN_08, stateCode: '08' },
  ];

  it('Accounts only; imported customers are never checked; a checked customer is never overwritten; never matched by name', async () => {
    await asOwner(db, async () => {
      for (const actor of [SUPER, OWNER, MANAGER, PURCHASE] as Actor[]) {
        await refused(actor, SQL.importStage, [await h.entity(), 'customer', null, 'x.csv', SHA, JSON.stringify(CUSTOMERS), rid()], '42501');
      }
      const s = await stage(ACCOUNTS, 'customer', CUSTOMERS, await h.branch('DEL'));
      const v = await validate(ACCOUNTS, s.batchId);
      expect(v).toMatchObject({ rows: 5, valid: 3, invalid: 2, proposed: { create: 3, update: 0, unchanged: 0, skippedChecked: 0 } });
      expect(v.invalidRows).toEqual([{ rowNo: 4, reasons: ['email_invalid', 'party_type_invalid'] }, { rowNo: 5, reasons: ['gst_not_allowed'] }]);
      // Lead ruling Q8: assumed values are flagged per row (never counted as duplicates).
      expect(v).toMatchObject({ possibleDuplicates: 0, assumedRows: 2 });
      expect(v.rowNotes).toEqual([{ rowNo: 1, notes: ['state_code_padded'] }, { rowNo: 2, notes: ['gst_status_assumed_registered'] }]);
      const rows = (await one<Batch>(ACCOUNTS, SQL.importGet, [s.batchId, 100, 0])).rows;
      expect(rows[0]).toMatchObject({ rowNo: 1, warnings: ['state_code_padded'] });
      await refused(SUPER, SQL.importApply, [s.batchId, v.rowVersion, REASON], 'P0002', 'not_found');
      const a = await apply(ACCOUNTS, s.batchId, v.rowVersion);
      expect(a).toMatchObject({ created: 3, invalid: 2 });
      const parties = await owner<Record<string, unknown>>(
        `select source_ref, party_type, phone, state_code, gst_status, check_status, branch_id is not null as has_branch
         from public.customer_parties order by source_ref`);
      expect(parties).toEqual([
        { source_ref: 'C-1', party_type: 'personal', phone: '9876500061', state_code: '08', gst_status: null, check_status: 'not_checked', has_branch: true },
        { source_ref: 'C-2', party_type: 'business', phone: null, state_code: '08', gst_status: 'registered', check_status: 'not_checked', has_branch: true },
        { source_ref: 'C-3', party_type: 'business', phone: null, state_code: null, gst_status: null, check_status: 'not_checked', has_branch: true }]);

      // Accounts checks C-1; a second file tries to overwrite it and to merge a same-name row without a reference.
      const [c1] = await owner<{ id: string }>(`select id from public.customer_parties where source_ref = 'C-1'`);
      await one(ACCOUNTS, SQL.partyAccountsSave, [c1!.id, 1, JSON.stringify({ addressLine1: '1 Synthetic Lane', city: 'Jodhpur' }), null]);
      await one(ACCOUNTS, SQL.partyCheck, [c1!.id, 2, 'checked', null]);
      const s2 = await stage(ACCOUNTS, 'customer', [
        { sourceRef: 'C-1', partyType: 'personal', name: 'Synthetic Overwrite Attempt' },
        { sourceRef: null, partyType: 'personal', name: 'Synthetic Import Person' },
        { sourceRef: 'C-2', partyType: 'business', name: 'Synthetic Import Co', gstin: GSTIN_08, stateCode: '08', city: 'Jodhpur' },
      ], await h.branch('DEL'));
      const v2 = await validate(ACCOUNTS, s2.batchId);
      expect(v2.proposed).toEqual({ create: 1, update: 0, unchanged: 1, skippedChecked: 1 });
      expect(v2.duplicateRows).toEqual([{ rowNo: 2, sourceRef: null, kind: 'same_name' }]);
      await apply(ACCOUNTS, s2.batchId, v2.rowVersion);
      expect(await owner(`select name, check_status from public.customer_parties where id = $1`, [c1!.id]))
        .toEqual([{ name: 'Synthetic Import Person', check_status: 'checked' }]);
      expect(await owner(`select count(*)::int as n from public.customer_parties where name = 'Synthetic Import Person'`)).toEqual([{ n: 2 }]);
      // Audit carries counts, never values.
      const audit = await h.auditRows('import.applied');
      expect(audit.map((x) => x.details.kind)).toEqual(['customer', 'customer']);
      expect(JSON.stringify(await h.auditRows('import.staged'))).not.toContain('Synthetic');
    });
  });
});
