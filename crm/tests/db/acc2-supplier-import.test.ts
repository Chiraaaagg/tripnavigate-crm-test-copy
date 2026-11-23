import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACC, MANAGER, PURCHASE, REASON, SENTINEL2, SQL2, SUPER, acc2Helpers, landed, phase2Sql, rid, sha, waits } from './acc2-support';
import { OWNER } from './acc-support';

/**
 * Accounts Phase 2 contract 5.6 / 13.3 (supplier import, kind 'supplier')
 * and test plan 12.1 "Import", Track F. Matching is by sourceRef only, never
 * by name; verified suppliers are never overwritten; bank columns become an
 * unverified revision that holds payments until a Manager who is not the
 * applier approves; staged account numbers are masked after apply and
 * cancel; apply is refused when anything changed since the dry run.
 * Access: Accounts of the entity or Super Admin (LD21); Purchase refused.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = acc2Helpers(() => db);
const { one, owner } = h;
const READY = landed('vn_import_evaluate', 'import_batch_apply', 'import_batch_get', 'supplier_changes')
  && /import_batches[\s\S]{0,400}'supplier'/.test(phase2Sql());

type Batch = { batchId: string; rowVersion: number; status: string; proposalHash?: string } & Record<string, unknown>;
type Row = { rowNo: number; outcome: string; reasons: string[]; warnings: Array<{ code: string; supplierId: string | null }>; targetId: string | null;
  values: Record<string, unknown> & { panMasked: string | null; bank: { accountLast4: string } | null } };
type Got = { summary?: Record<string, unknown>; rows: Row[] } & Record<string, unknown>;

const row = (over: Record<string, unknown>) => ({
  sourceRef: null, name: null, supplierKind: 'direct', serviceTypes: 'hotel', city: 'Synthetic City', stateCode: null, gstin: null, pan: null,
  address: null, tallyLedgerName: null, contactName: null, contactPhone: null, contactEmail: null, paymentTerms: null, hotelSourceRefs: null,
  bankAccountHolder: null, bankName: null, ifsc: null, accountNumber: null, ...over,
});
const BANK = { bankAccountHolder: 'Synthetic Import Holder', bankName: 'Synthetic Bank', ifsc: 'SYNB0000005', accountNumber: SENTINEL2.accountNumber };

/**
 * Review fix A 0140: account numbers are not kept in the staged rows; import_batch_apply takes them again as
 * p_bank {fileSha256, accounts: {rowNo: number}} from the same file (the screen re-reads it). Until 0140 lands
 * the four-argument apply is used.
 */
const BANK_AT_APPLY = /import_batch_apply\([^)]*p_bank/.test(phase2Sql());
const staged = new Map<string, { sha: string; rows: Array<Record<string, unknown>> }>();
const stage = async (actor: typeof ACC, rows: unknown[], requestId = rid()) => {
  const fileSha = sha();
  const r = await one<{ batchId: string; outcome: string }>(actor, SQL2.importStage, [await h.entityId(), 'supplier', null, 'synthetic suppliers.csv', fileSha,
    JSON.stringify(rows), requestId]);
  if (!staged.has(r.batchId)) staged.set(r.batchId, { sha: fileSha, rows: rows as Array<Record<string, unknown>> });
  return r;
};
const validate = (actor: typeof ACC, id: string) => one<Batch>(actor, SQL2.importValidate, [id]);
const get = (actor: typeof ACC, id: string) => one<Got>(actor, SQL2.importGet, [id, 100, 0]);
/** p_bank for a staged batch: every row with an account number, keyed by row number (1-based). */
function bankFor(batchId: string): string | null {
  const s = staged.get(batchId);
  if (!s) return null;
  const accounts = Object.fromEntries(s.rows.flatMap((r, i) => (r.accountNumber ? [[String(i + 1), r.accountNumber]] : [])));
  return Object.keys(accounts).length ? JSON.stringify({ fileSha256: s.sha, accounts }) : null;
}
const APPLY5 = 'select public.import_batch_apply($1, $2, $3, $4, $5::jsonb) as r';
const applyArgs = (v: Batch) => BANK_AT_APPLY ? [v.batchId, v.rowVersion, REASON, v.proposalHash ?? null, bankFor(v.batchId)]
  : [v.batchId, v.rowVersion, REASON, v.proposalHash ?? null];
const applySql = () => (BANK_AT_APPLY ? APPLY5 : SQL2.importApply);
const apply = (actor: typeof ACC, v: Batch) => one<Batch>(actor, applySql(), applyArgs(v));
async function dryRunApply(actor: typeof ACC, rows: unknown[]) {
  const s = await stage(actor, rows);
  const v = await validate(actor, s.batchId);
  return { s, v, got: await get(actor, s.batchId), applied: await apply(actor, { ...v, batchId: s.batchId }) };
}
const bySource = (ref: string) => owner<{ id: string; name: string; verification_status: string; import_batch_id: string | null; row_version: number;
  tally_ledger_name: string | null; city: string }>(
  'select id, name, verification_status, import_batch_id, row_version, tally_ledger_name, city from public.suppliers where source_ref = $1', [ref]);

describe.skipIf(!READY)(`supplier import${READY ? '' : ` — ${waits('A', "import kind 'supplier'")}`}`, () => {
  it('access: Accounts and Super Admin stage supplier files; Purchase, Sales and Manager are refused', async () => {
    await asOwner(db, async () => {
      for (const actor of [PURCHASE, OWNER, MANAGER]) {
        await h.refused(actor, SQL2.importStage, [await h.entityId(), 'supplier', null, 'x.csv', sha(), JSON.stringify([row({ sourceRef: 'X-1',
          name: 'Synthetic X' })]), rid()], 'not_authorized');
      }
      expect((await stage(ACC, [row({ sourceRef: 'A-1', name: 'Synthetic A' })])).outcome).toBe('created');
      expect((await stage(SUPER, [row({ sourceRef: 'A-2', name: 'Synthetic B' })])).outcome).toBe('created');
      // Supplier batches are not branch-scoped.
      await h.refused(ACC, SQL2.importStage, [await h.entityId(), 'supplier', await h.branchId('DEL'), 'x.csv', sha(),
        JSON.stringify([row({ sourceRef: 'A-3', name: 'Synthetic C' })]), rid()], 'invalid_input');
    });
  });

  it('dry run: create, name_exists, duplicate_in_file, invalid reasons, warnings; apply; bank held until a non-applier Manager approves', async () => {
    await asOwner(db, async () => {
      const existing = await h.newSupplier({ name: 'Synthetic Existing Stays', city: 'Jodhpur', gstin: SENTINEL2.supplierGstin, pan: SENTINEL2.supplierPan,
        stateCode: '08' });
      const hotel = await h.catalogueHotel('Synthetic Imported Hotel', 'HTL-IMP-1');
      const rows = [
        row({ sourceRef: 'TALLY:S-1', name: 'Synthetic Import One', gstin: SENTINEL2.supplierGstin, pan: SENTINEL2.supplierPan, stateCode: '08',
          tallyLedgerName: 'Synthetic Import One (Cr)', contactName: 'Synthetic Import Desk', contactEmail: 'imp1@example.test',
          hotelSourceRefs: 'HTL-IMP-1;HTL-MISSING', ...BANK }),
        row({ sourceRef: 'TALLY:S-2', name: 'Synthetic Existing Stays' }),
        row({ sourceRef: 'TALLY:S-3', name: 'Synthetic Twin' }),
        row({ sourceRef: 'TALLY:S-3', name: 'Synthetic Twin Again' }),
        row({ sourceRef: 'TALLY:S-4', name: 'Synthetic Bad', gstin: '99BAD', pan: 'X', supplierKind: 'agent_channel', serviceTypes: 'hotel;cruise' }),
        row({ sourceRef: 'TALLY:S-5', name: '=HYPERLINK("x")' }),
        row({ sourceRef: 'TALLY:S-6', name: 'Synthetic Half Bank', bankName: 'Synthetic Bank' }),
      ];
      const s = await stage(ACC, rows);
      const v = await validate(ACC, s.batchId);
      const got = await get(ACC, s.batchId);
      const outcomes = got.rows.map((r) => [r.rowNo, r.outcome]);
      expect(outcomes, JSON.stringify(got.rows.map((r) => r.reasons))).toEqual([[1, 'create'], [2, 'invalid'], [3, 'duplicate_in_file'], [4, 'duplicate_in_file'], [5, 'invalid'], [6, 'invalid'], [7, 'invalid']]);
      expect(got.rows[1]!.reasons).toContain('name_exists');
      expect(got.rows[4]!.reasons).toEqual(expect.arrayContaining(['gstin_invalid', 'pan_invalid', 'kind_invalid', 'service_types_invalid']));
      expect(got.rows[5]!.reasons).toContain('formula_cell');
      expect(got.rows[6]!.reasons).toContain('bank_incomplete');
      const w = got.rows[0]!.warnings.map((x) => `${x.code}:${x.supplierId ?? ''}`);
      expect(w).toEqual(expect.arrayContaining([`same_gstin:${existing.supplierId}`, `same_pan:${existing.supplierId}`]));
      expect(got.rows[0]!.warnings.map((x) => x.code)).toContain('hotel_not_found');
      // Values: PAN masked, bank last 4 only.
      expect(got.rows[0]!.values.panMasked).toBe('XXXXX4321X');
      expect(got.rows[0]!.values.bank).toMatchObject({ accountLast4: SENTINEL2.accountLast4 });
      expect(JSON.stringify(got)).not.toContain(SENTINEL2.accountNumber);
      expect(JSON.stringify(got).replaceAll(SENTINEL2.supplierGstin, ''), 'PAN only inside the GSTIN').not.toContain(SENTINEL2.supplierPan);
      const summary = JSON.stringify(got.summary ?? got);
      expect(summary).toContain('withBankDetails');
      expect(summary).toContain('proposalHash');
      // Nothing written before apply.
      expect(await bySource('TALLY:S-1')).toEqual([]);

      const a = await apply(ACC, { ...v, batchId: s.batchId });
      expect(a).toMatchObject({ status: 'applied' });
      const [created] = await bySource('TALLY:S-1');
      expect(created).toMatchObject({ name: 'Synthetic Import One', verification_status: 'unverified', import_batch_id: s.batchId,
        tally_ledger_name: 'Synthetic Import One (Cr)' });
      // A state name is mapped to its code by the CSV mapping (gst-states.ts) before staging.
      expect(await owner('select state_code, gstin from public.suppliers where id = $1', [created!.id])).toEqual([{ state_code: '08',
        gstin: SENTINEL2.supplierGstin }]);
      expect(await owner('select name, is_primary from public.supplier_contacts where supplier_id = $1', [created!.id]))
        .toEqual([{ name: 'Synthetic Import Desk', is_primary: true }]);
      expect(await owner('select source from public.supplier_hotels where supplier_id = $1 and hotel_id = $2', [created!.id, hotel]))
        .toEqual([{ source: 'import' }]);
      // History rows with source import, by the applier.
      const hist = await h.history(created!.id);
      expect(hist.length).toBeGreaterThan(0);
      expect(hist.every((x) => x.changed_by !== null)).toBe(true);
      expect(hist.some((x) => x.source === 'import')).toBe(true);
      // Bank: one unverified revision by the applier; payments on hold.
      const revs = await owner<{ revision_no: number; created_by: string }>(
        'select revision_no, created_by from public.supplier_beneficiary_revisions where supplier_id = $1', [created!.id]);
      expect(revs).toEqual([{ revision_no: 1, created_by: ACC.userId }]);
      expect(await owner('select authz.sm_bank_approved($1) as ok', [created!.id])).toEqual([{ ok: false }]);
      // Staged account number masked after apply.
      const staged = await owner<{ n: string | null }>(`select data ->> 'accountNumber' as n from public.import_rows where batch_id = $1 and row_no = 1`, [s.batchId]);
      expect(staged[0]!.n === null || /^XXXX[0-9]{4}$/.test(staged[0]!.n)).toBe(true);
      expect(JSON.stringify(await owner('select data from public.import_rows where batch_id = $1', [s.batchId]))).not.toContain(SENTINEL2.accountNumber);
      // Accounts applier is not a Manager; the Manager (not the applier) approves.
      await h.refused(ACC, 'select public.supplier_approve_beneficiary($1, $2) as r', [created!.id, 1], 'not_authorized');
      await one(MANAGER, 'select public.supplier_approve_beneficiary($1, $2) as r', [created!.id, 1]);
      expect(await owner('select authz.sm_bank_approved($1) as ok', [created!.id])).toEqual([{ ok: true }]);
      // Audit: the existing import actions with kind supplier.
      expect((await h.audits('import.applied')).at(-1)).toMatchObject({ details: expect.objectContaining({ kind: 'supplier' }) });
    });
  });

  it('re-import: same ref new name → update; same values → unchanged; verified → skipped_checked; same bank → no new revision', async () => {
    await asOwner(db, async () => {
      await dryRunApply(ACC, [row({ sourceRef: 'R-1', name: 'Synthetic Reimport', ...BANK }), row({ sourceRef: 'R-2', name: 'Synthetic Checked' })]);
      const [r1] = await bySource('R-1');
      const [r2] = await bySource('R-2');
      await one(MANAGER, 'select public.supplier_verify($1, $2) as r', [r2!.id, r2!.row_version]);
      const second = await dryRunApply(ACC, [
        row({ sourceRef: 'R-1', name: 'Synthetic Reimport Renamed', ...BANK }),
        row({ sourceRef: 'R-2', name: 'Synthetic Checked Renamed' }),
      ]);
      expect(second.got.rows.map((r) => r.outcome)).toEqual(['update', 'skipped_checked']);
      expect((await bySource('R-1'))[0]!.name).toBe('Synthetic Reimport Renamed');
      expect((await bySource('R-2'))[0]!.name, 'verified supplier never overwritten').toBe('Synthetic Checked');
      expect(await owner('select count(*)::int as n from public.supplier_beneficiary_revisions where supplier_id = $1', [r1!.id]), 'same bank values')
        .toEqual([{ n: 1 }]);
      const third = await dryRunApply(ACC, [row({ sourceRef: 'R-1', name: 'Synthetic Reimport Renamed', ...BANK, accountNumber: '100000000002' })]);
      expect(third.got.rows.map((r) => r.outcome)).toEqual(['update']);
      expect(await owner('select count(*)::int as n from public.supplier_beneficiary_revisions where supplier_id = $1', [r1!.id])).toEqual([{ n: 2 }]);
      expect(await owner('select authz.sm_bank_approved($1) as ok', [r1!.id])).toEqual([{ ok: false }]);
      const fourth = await dryRunApply(ACC, [row({ sourceRef: 'R-1', name: 'Synthetic Reimport Renamed' })]);
      expect(fourth.got.rows.map((r) => r.outcome)).toEqual(['unchanged']);
      // Never by name: a new ref with an existing supplier's exact name is invalid name_exists, not an update.
      const fifth = await dryRunApply(ACC, [row({ sourceRef: 'R-9', name: 'Synthetic Reimport Renamed' })]);
      expect(fifth.got.rows[0]).toMatchObject({ outcome: 'invalid', reasons: expect.arrayContaining(['name_exists']) });
    });
  });

  it('apply refused when a matched supplier changed since the dry run (import_stale); cancel masks staged account numbers', async () => {
    await asOwner(db, async () => {
      await dryRunApply(ACC, [row({ sourceRef: 'ST-1', name: 'Synthetic Stale Supplier' })]);
      const [st] = await bySource('ST-1');
      const s = await stage(ACC, [row({ sourceRef: 'ST-1', name: 'Synthetic Stale Supplier', city: 'Kota' })]);
      const v = await validate(ACC, s.batchId);
      await h.updateSupplier(st!.id, { city: 'Bikaner' });
      await h.refused(ACC, applySql(), applyArgs({ ...v, batchId: s.batchId }), 'import_stale');
      expect((await bySource('ST-1'))[0]!.city).toBe('Bikaner');

      const c = await stage(ACC, [row({ sourceRef: 'CX-1', name: 'Synthetic Cancelled Import', ...BANK })]);
      const cv = await validate(ACC, c.batchId);
      await one(ACC, SQL2.importCancel, [c.batchId, cv.rowVersion]);
      expect(JSON.stringify(await owner('select data from public.import_rows where batch_id = $1', [c.batchId]))).not.toContain(SENTINEL2.accountNumber);
      expect(await bySource('CX-1')).toEqual([]);
    });
  });
});
