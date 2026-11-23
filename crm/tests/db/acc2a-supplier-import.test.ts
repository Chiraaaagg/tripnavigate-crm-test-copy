import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, resetActor } from '../helpers/db';
import { ACC, MANAGER, PURCHASE, SQL, accHelpers, rid, sha } from './acc-support';

/**
 * Accounts phase 2, Track A (builder's own tests): supplier import, contract
 * sections 5.6 and 13.3 (LD21). Track F writes acc2-supplier-import.test.ts.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = accHelpers(() => db);
const { one, owner } = h;
const SUPER: Actor = { userId: U.adminJodhpur };

const SQLI = {
  stage: 'select public.import_batch_stage($1, $2, $3, $4, $5, $6::jsonb, $7, $8) as r',
  validate: 'select public.import_batch_validate($1) as r',
  apply: 'select public.import_batch_apply($1, $2, $3, $4, $5::jsonb) as r',
  get: 'select public.import_batch_get($1, $2, $3) as r',
  cancel: 'select public.import_batch_cancel($1, $2) as r',
  list: 'select public.import_batch_list($1, $2) as r',
  create: 'select public.supplier_create($1, $2::jsonb) as r',
} as const;

type Row = Record<string, string | null>;
type Summary = {
  batchId: string; rowVersion: number; proposalHash: string; rows: number; create: number; update: number; unchanged: number;
  skippedChecked: number; invalid: number; duplicateInFile: number; withBankDetails: number;
  warnings: { similarNameCity: number; sameGstin: number; samePan: number; sameBank: number; hotelNotFound: number };
  proposed: { create: number; update: number };
};
type GetRow = { rowNo: number; outcome: string; reasons: string[]; targetId: string | null; warningCodes: string[];
  warnings: Array<{ code: string; supplierId: string | null; supplierName: string | null; hotelSourceRef: string | null }>;
  values: { panMasked: string | null; bank: { accountLast4: string; ifsc: string } | null; serviceTypes: string[] | null } };

const REASON = 'Synthetic supplier list import for the test';

const r1 = (over: Row = {}): Row => ({
  sourceRef: 'TST-S-001', name: 'Test Lake Hotels Pvt Ltd', supplierKind: 'direct', serviceTypes: 'hotel', city: 'Udaipur', stateCode: '08',
  gstin: '08AAAAA0001A1Z1', pan: 'AAAAA0001A', address: '1 Test Ghat Road', tallyLedgerName: 'Test Lake Hotels Pvt Ltd',
  contactName: 'Test Contact One', contactPhone: '+916000010001', contactEmail: 'res@test-lake.example.test', paymentTerms: '30 days',
  hotelSourceRefs: 'TST-H-001;TST-H-404', bankAccountHolder: 'Test Lake Hotels Pvt Ltd', bankName: 'Test Bank', ifsc: 'TEST0000001',
  accountNumber: '100000000001', ...over,
});

/** The staged file hash per batch (Import sends the same file again for bank numbers, L7). */
const fileSha = new Map<string, string>();
async function stage(actor: Actor, rows: Row[]): Promise<string> {
  const e = await h.entityId();
  const fileHash = sha();
  const id = (await one<{ batchId: string }>(actor, SQLI.stage, [e, 'supplier', null, 'suppliers.csv', fileHash, JSON.stringify(rows), rid(), false])).batchId;
  fileSha.set(id, fileHash);
  return id;
}
const validate = (actor: Actor, id: string) => one<Summary>(actor, SQLI.validate, [id]);
const rowsOf = async (actor: Actor, id: string) => (await one<{ rows: GetRow[] }>(actor, SQLI.get, [id, 100, 0])).rows;

async function catalogueHotel(ref: string): Promise<string> {
  await resetActor(db);
  const [row] = await owner<{ id: string }>(
    `insert into public.hotel_catalogue (legal_entity_id, name, city, source_ref, created_by, updated_by)
     select e.id, 'Test Lake View', 'Udaipur', $1, $2, $2 from public.legal_entities e where e.code = 'HOLIDAY_CHACHA' returning id`,
    [ref, U.adminJodhpur]);
  return row!.id;
}

describe('5.6 access', () => {
  it('Accounts and Super Admin stage supplier batches; Purchase and Manager are refused; no branch', async () => {
    await asOwner(db, async () => {
      const e = await h.entityId();
      expect(await stage(ACC, [r1()])).toMatch(/^[0-9a-f-]{36}$/);
      expect(await stage(SUPER, [r1()])).toMatch(/^[0-9a-f-]{36}$/);
      for (const who of [PURCHASE, MANAGER]) {
        await h.refused(who, SQLI.stage, [e, 'supplier', null, 'x.csv', sha(), JSON.stringify([r1()]), rid(), false], 'not_authorized');
      }
      await h.refusedHint(ACC, SQLI.stage, [e, 'supplier', await h.branchId('JDH'), 'x.csv', sha(), JSON.stringify([r1()]), rid(), false],
        'invalid_input', /^branchId$/);
      expect((await one<{ items: unknown[] }>(ACC, SQLI.list, ['supplier', 20])).items.length).toBeGreaterThan(0);
    });
  });
});

describe('5.6 dry run, apply, re-import', () => {
  it('outcomes, reasons, warnings; apply stores suppliers, primary contact, hotel links and an unverified bank revision; data masked', async () => {
    await asOwner(db, async () => {
      const hid = await catalogueHotel('TST-H-001');
      const rows: Row[] = [
        r1(),
        r1({ sourceRef: 'TST-S-004', name: 'Test Mismatch Travels', gstin: '07AAAAA0004A1Z4', pan: 'AAAAA0004A', stateCode: '08',
          hotelSourceRefs: null, bankAccountHolder: null, bankName: null, ifsc: null, accountNumber: null }),
        r1({ sourceRef: 'TST-S-005', name: 'Test Dup One', gstin: null, pan: null, bankAccountHolder: null, bankName: null, ifsc: null, accountNumber: null }),
        r1({ sourceRef: 'TST-S-005', name: 'Test Dup Two', gstin: null, pan: null, bankAccountHolder: null, bankName: null, ifsc: null, accountNumber: null }),
        r1({ sourceRef: 'TST-S-009', name: 'Test Half Bank', gstin: null, pan: null, bankName: null, accountNumber: null }),
        r1({ sourceRef: 'TST-S-010', name: 'Test Bad Kind', supplierKind: 'wholesaler', serviceTypes: 'boat', gstin: null, pan: null,
          bankAccountHolder: null, bankName: null, ifsc: null, accountNumber: null }),
        r1({ sourceRef: 'TST-S-011', name: '=HYPERLINK("x")', gstin: null, pan: null, bankAccountHolder: null, bankName: null, ifsc: null, accountNumber: null }),
      ];
      const id = await stage(ACC, rows);
      const s = await validate(ACC, id);
      expect(s).toMatchObject({ rows: 7, create: 1, update: 0, invalid: 4, duplicateInFile: 2, withBankDetails: 1,
        warnings: { hotelNotFound: 1 } });
      const got = await rowsOf(ACC, id);
      expect(got.map((r) => [r.rowNo, r.outcome, r.reasons])).toEqual([
        [1, 'create', []],
        [2, 'invalid', ['gstin_state_mismatch']],
        [3, 'duplicate_in_file', ['duplicate_in_file']],
        [4, 'duplicate_in_file', ['duplicate_in_file']],
        [5, 'invalid', ['bank_incomplete']],
        [6, 'invalid', ['kind_invalid', 'service_types_invalid']],
        [7, 'invalid', ['formula_cell']],
      ]);
      expect(got[0]!.warnings).toEqual([{ code: 'hotel_not_found', supplierId: null, supplierName: null, hotelSourceRef: 'TST-H-404' }]);
      expect(got[0]!.values).toMatchObject({ panMasked: 'XXXXX0001X', bank: { accountLast4: '0001', ifsc: 'TEST0000001' }, serviceTypes: ['hotel'] });
      expect(JSON.stringify(got)).not.toMatch(/100000000001|AAAAA0001A[^0-9]/);

      // L7: the full account number is never staged (only XXXX<last4>; no hash).
      expect((await owner<{ n: number }>(`select count(*)::int as n from public.import_rows where batch_id = $1 and data::text like '%100000000001%'`, [id]))[0]!.n).toBe(0);
      const [masked] = await owner<{ d: Record<string, unknown> }>(`select data as d from public.import_rows where batch_id = $1 and row_no = 1`, [id]);
      expect(masked!.d.accountNumber).toBe('XXXX0001');
      expect(Object.keys(masked!.d)).not.toContain('accountNumberHash');
      // Import needs the same file again for the bank number: none, another file, another number -> refused.
      await h.refusedHint(ACC, SQLI.apply, [id, s.rowVersion, REASON, s.proposalHash, null], 'invalid_input', /^file$/);
      await h.refusedHint(ACC, SQLI.apply, [id, s.rowVersion, REASON, s.proposalHash, JSON.stringify({ fileSha256: sha(), accounts: { 1: '100000000001' } })],
        'invalid_input', /^file$/);
      await h.refusedHint(ACC, SQLI.apply, [id, s.rowVersion, REASON, s.proposalHash, JSON.stringify({ fileSha256: fileSha.get(id), accounts: { 1: '100000000009' } })],
        'invalid_input', /^file$/);
      const applied = await one<{ created: number; updated: number }>(ACC, SQLI.apply,
        [id, s.rowVersion, REASON, s.proposalHash, JSON.stringify({ fileSha256: fileSha.get(id), accounts: { 1: '1000 0000 0001' } })]);
      expect(applied).toMatchObject({ created: 1, updated: 0 });
      const [sup] = await owner<{ id: string; source_ref: string; import_batch_id: string; tally_ledger_name: string; contact_name: string;
        verification_status: string }>('select * from public.suppliers where source_ref = $1', ['TST-S-001']);
      expect(sup).toMatchObject({ import_batch_id: id, tally_ledger_name: 'Test Lake Hotels Pvt Ltd', contact_name: 'Test Contact One',
        verification_status: 'unverified' });
      expect((await owner('select 1 from public.supplier_contacts where supplier_id = $1 and is_primary', [sup!.id])).length).toBe(1);
      expect((await owner<{ hotel_id: string; source: string }>('select hotel_id, source from public.supplier_hotels where supplier_id = $1', [sup!.id])))
        .toEqual([{ hotel_id: hid, source: 'import' }]);
      const [rev] = await owner<{ status: string; created_by: string; revision_no: number }>(
        'select status, created_by, revision_no from public.supplier_beneficiary_revisions where supplier_id = $1', [sup!.id]);
      expect(rev).toEqual({ status: 'unverified', created_by: U.accountsJodhpur, revision_no: 1 });
      expect((await owner<{ a: string }>('select account_number as a from public.supplier_beneficiary_revisions where supplier_id = $1', [sup!.id]))[0]!.a)
        .toBe('100000000001');
      // Payment hold until a Manager who is not the applier approves.
      expect((await owner<{ ok: boolean }>('select authz.sm_bank_approved($1) as ok', [sup!.id]))[0]!.ok).toBe(false);
      await one(MANAGER, SQL.supplierApproveBeneficiary, [sup!.id, 1]);
      expect((await owner<{ ok: boolean }>('select authz.sm_bank_approved($1) as ok', [sup!.id]))[0]!.ok).toBe(true);
      // Staged account numbers masked; history source import; no bank number in history.
      const [staged] = await owner<{ a: string }>(`select data ->> 'accountNumber' as a from public.import_rows where batch_id = $1 and row_no = 1`, [id]);
      expect(staged!.a).toBe('XXXX0001');
      const hist = await owner<{ source: string; new_value: string | null }>('select source, new_value from public.supplier_changes where supplier_id = $1', [sup!.id]);
      expect(hist.some((x) => x.source === 'import')).toBe(true);
      expect(JSON.stringify(hist)).not.toMatch(/100000000001/);
      // Apply is idempotent.
      expect(await one<{ outcome: string }>(ACC, SQLI.apply, [id, s.rowVersion, REASON, s.proposalHash, null])).toMatchObject({ outcome: 'existing' });

      // Re-import: same ref + new name = update; same name + another ref = invalid name_exists; similar name warning.
      const id2 = await stage(ACC, [
        r1({ name: 'Test Lake Hotels Udaipur', bankAccountHolder: null, bankName: null, ifsc: null, accountNumber: null, hotelSourceRefs: null }),
        r1({ sourceRef: 'TST-S-099', name: 'Test Lake Hotels Pvt Ltd', gstin: null, pan: null, bankAccountHolder: null, bankName: null, ifsc: null,
          accountNumber: null, hotelSourceRefs: null }),
        r1({ sourceRef: 'TST-S-098', name: 'Test Lake', gstin: null, pan: null, bankAccountHolder: null, bankName: null, ifsc: null,
          accountNumber: null, hotelSourceRefs: null }),
      ]);
      const s2 = await validate(ACC, id2);
      const g2 = await rowsOf(ACC, id2);
      expect(g2.map((r) => [r.outcome, r.reasons])).toEqual([['update', []], ['invalid', ['name_exists']], ['create', []]]);
      expect(g2[2]!.warnings).toEqual([{ code: 'similar_name_city', supplierId: sup!.id, supplierName: 'Test Lake Hotels Pvt Ltd', hotelSourceRef: null }]);
      // A change since the dry run: apply refused as stale.
      await owner(`update public.suppliers set city = 'Jaipur', row_version = row_version + 1 where id = $1`, [sup!.id]);
      await h.refused(ACC, SQLI.apply, [id2, s2.rowVersion, REASON, s2.proposalHash, null], 'import_stale', '40001');
    });
  });

  it('a changed middle digit (same last 4) is never unchanged: Import compares the full number and holds payment again', async () => {
    await asOwner(db, async () => {
      const bankOnly = { hotelSourceRefs: null, contactName: null, contactPhone: null, contactEmail: null };
      const applyWith = async (rows: Row[], numbers: Record<number, string>) => {
        const id = await stage(ACC, rows);
        const s = await validate(ACC, id);
        await one(ACC, SQLI.apply, [id, s.rowVersion, REASON, s.proposalHash, JSON.stringify({ fileSha256: fileSha.get(id), accounts: numbers })]);
        return { id, s };
      };
      await applyWith([r1(bankOnly)], { 1: '100000000001' });
      const [sup] = await owner<{ id: string }>('select id from public.suppliers where source_ref = $1', ['TST-S-001']);
      await one(MANAGER, SQL.supplierApproveBeneficiary, [sup!.id, 1]);
      const revs = () => owner<{ revision_no: number; status: string; account_number: string }>(
        'select revision_no, status, account_number from public.supplier_beneficiary_revisions where supplier_id = $1 order by revision_no', [sup!.id]);
      const approved = async () => (await owner<{ ok: boolean }>('select authz.sm_bank_approved($1) as ok', [sup!.id]))[0]!.ok;
      expect(await approved()).toBe(true);
      // Same number again: the row still goes to Import (never 'unchanged'), and no new revision is made.
      const same = await applyWith([r1({ ...bankOnly, accountNumber: '100000000001' })], { 1: '100000000001' });
      expect(same.s).toMatchObject({ update: 1, unchanged: 0 });
      expect((await revs()).length).toBe(1);
      // A middle digit changed, last 4 the same: a new unverified revision; payments on hold again.
      const changed = await applyWith([r1({ ...bankOnly, accountNumber: '100000990001' })], { 1: '100000990001' });
      expect(changed.s).toMatchObject({ update: 1, unchanged: 0 });
      expect((await revs()).map((r) => [r.revision_no, r.status, r.account_number])).toEqual([[1, 'approved', '100000000001'], [2, 'unverified', '100000990001']]);
      expect(await approved()).toBe(false);
    });
  });

  it('a verified supplier is skipped; cancel masks the staged account number', async () => {
    await asOwner(db, async () => {
      const first = await stage(ACC, [r1({ bankAccountHolder: null, bankName: null, ifsc: null, accountNumber: null, hotelSourceRefs: null })]);
      const s = await validate(ACC, first);
      await one(ACC, SQLI.apply, [first, s.rowVersion, REASON, s.proposalHash, null]);
      const [sup] = await owner<{ id: string; row_version: number }>('select id, row_version from public.suppliers where source_ref = $1', ['TST-S-001']);
      await one(MANAGER, 'select public.supplier_verify($1, $2) as r', [sup!.id, sup!.row_version]);
      const next = await stage(ACC, [r1({ name: 'Renamed Lake Hotels' })]);
      const s2 = await validate(ACC, next);
      expect(s2).toMatchObject({ skippedChecked: 1, update: 0 });
      await one(ACC, SQLI.cancel, [next, s2.rowVersion]);
      const [staged] = await owner<{ a: string }>(`select data ->> 'accountNumber' as a from public.import_rows where batch_id = $1`, [next]);
      expect(staged!.a).toBe('XXXX0001');
    });
  });
});
