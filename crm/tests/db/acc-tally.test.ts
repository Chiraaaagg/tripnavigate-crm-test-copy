import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import {
  ACC, ACC3, CSV_COLUMNS, CSV_VALUE_KEYS, DEAL, HOTEL_ITEM, MANAGER, PURCHASE, REASON, SENTINEL, SQL, SUPER, accHelpers, dayFrom, rid, today,
} from './acc-support';
import { CONFLICT_STATE } from '../helpers/sqlstates';

/**
 * Accounts phase contract sections 6.2.1 (tally_records and computed
 * statuses), 6.2.5-6.2.7, 7.1 (T1-T7), 7.2 (T8-T10) and 7.4 (CSV values),
 * test plan 12.2 "Tally", Track E. Written from the contract:
 *   - match / exception / reopen paths with every refusal token and code,
 *     row versions (0 before a row exists), replay of the same request id;
 *   - export ≠ matched; export selects ready (+ exported when asked), never
 *     matched or exception; snapshot lines never change; a change after
 *     export flags the row; repeated exports never count a record twice;
 *     reversals are their own rows and the original stays matched;
 *     10,001 rows refused; nothing to export; switch off;
 *   - one audit row per export and per download (lines reads are not
 *     audited); CSV values masked (PAN XXXXX1234X, mobile XXXXXX3210);
 *   - GST invoice references T4/T5 and the duplicate rule per financial year;
 *   - exception owner setter T6 (an Accounts person without Purchase only).
 * Two people matching / exporting at once: acc-concurrency.test.ts (real Postgres).
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = accHelpers(() => db);
const { one, owner, refused, refusedHint } = h;
const voucher = (ref = 'SYN-VCH-0001', date = today()) => JSON.stringify({ voucherRef: ref, voucherDate: date });
type Done = { outcome: string; rowVersion: number; status?: string; tallyRecordId?: string };

/** Hotel booking on DEAL, approved; two verified bank receipts (ACC records, ACC2 verifies). */
async function base() {
  await h.addAcc2();
  const b = await h.book([HOTEL_ITEM]);
  await h.approve(b.versionId);
  const r1 = await h.receipt(DEAL, '2500000');
  const r2 = await h.receipt(DEAL, '1234550');
  const e1 = (await h.entryOf(r1.id))!;
  const e2 = (await h.entryOf(r2.id))!;
  return { b, r1, r2, e1, e2 };
}
const status = async (kind: string, id: string) => (await h.tallyRow(kind, id))?.status ?? null;
const rv = async (kind: string, id: string) => (await h.tallyRow(kind, id))?.row_version ?? 0;
const exportFields = async (over: Record<string, unknown> = {}) => JSON.stringify({
  entityId: await h.entityId(), from: dayFrom(-30), to: today(), kinds: ['journal_entry'], includeExported: false, ...over });
type Export = { exportId: string; exportNo: string; rowCount: number; alreadyExportedCount: number; skippedCount: number };
type Lines = { lines: Array<{ lineNo: number; values: unknown }>; nextAfter: number | null };
/** One CSV cell of a snapshot line: values may be an array in column order or an object keyed by column. */
const col = (values: unknown, name: string): unknown => {
  if (Array.isArray(values)) return values[CSV_COLUMNS.indexOf(name)];
  const v = values as Record<string, unknown>;
  return name in v ? v[name] : v[CSV_VALUE_KEYS[name]!];
};

describe('T1 match', () => {
  it('ready -> matched with voucher reference; row version 0 before a row exists; audit keeps the voucher (Addendum B7)', async () => {
    await asOwner(db, async () => {
      const { e1 } = await base();
      const done = await one<Done>(ACC, SQL.match, ['journal_entry', e1, 0, voucher(), rid()]);
      expect(['created', 'updated']).toContain(done.outcome);
      const row = (await h.tallyRow('journal_entry', e1))!;
      expect(row).toMatchObject({ status: 'matched', voucher_ref: 'SYN-VCH-0001', matched_by: U.accountsJodhpur, export_count: 0, row_version: 1 });
      const [audit] = await h.audits('accounts.tally_matched');
      expect(audit!.details).toMatchObject({ tallyRecordId: row.id, rowVersion: 1, fromStatus: 'ready' });
      // Addendum B7 (lead, second review): the voucher is kept in the audit as history.
      expect(JSON.stringify(audit)).toContain('SYN-VCH-0001');
      // Workspace shows matched with the voucher reference for A.
      const rows = await h.allRecords(ACC, { kinds: ['receipt'] });
      expect(rows.find((r) => r.tally.status === 'matched')!.tally).toMatchObject({ voucherRef: 'SYN-VCH-0001', rowVersion: 1 });
      // Again: already_matched; stale version: version_changed.
      await refused(ACC, SQL.match, ['journal_entry', e1, 1, voucher('SYN-VCH-0002'), rid()], 'already_matched', '55000');
      await refused(ACC, SQL.match, ['journal_entry', e1, 0, voucher('SYN-VCH-0002'), rid()], 'version_changed', CONFLICT_STATE);
    });
  });

  it('refusals: not ready, not applicable, bad voucher fields, Manager and Purchase; replay returns the stored result', async () => {
    await asOwner(db, async () => {
      const { e2, b } = await base();
      // Supplier payment requested but not verified -> not ready; returned bill -> not applicable.
      const task = h.taskOf(b, 'hotel');
      const supplierId = await h.purchaseSupplier();
      await h.purchaseCost(task, supplierId);
      await h.goAhead(task);
      const p = await h.purchaseRequest(task, 2_000_000);
      await refused(ACC, SQL.match, ['supplier_payment', p.id, 0, voucher(), rid()], 'tally_not_ready', '55000');
      const doc = await h.uploadDoc(task, { number: 'SYN-RET-1' });
      await h.reviewDoc(doc.id, 'return', 'Synthetic: wrong supplier on the bill');
      await refused(ACC, SQL.match, ['supplier_document', doc.id, 0, voucher(), rid()], 'tally_not_ready', '55000');
      await refusedHint(ACC, SQL.match, ['journal_entry', e2, 0, voucher('SYN-1', dayFrom(1)), rid()], 'invalid_input', /voucherDate/, '22023');
      await refusedHint(ACC, SQL.match, ['journal_entry', e2, 0, voucher('SYN-1', '1999-12-31'), rid()], 'invalid_input', /voucherDate/, '22023');
      await refusedHint(ACC, SQL.match, ['journal_entry', e2, 0, voucher('X'.repeat(61)), rid()], 'invalid_input', /voucherRef/, '22023');
      await refusedHint(ACC, SQL.match, ['journal_entry', e2, 0, voucher('SYN\u0007BELL'), rid()], 'invalid_input', /voucherRef/, '22023');
      await refusedHint(ACC, SQL.match, ['journal_entry', e2, 0, JSON.stringify({ voucherRef: 'A', voucherDate: today(), extra: 1 }), rid()],
        'invalid_input', undefined, '22023');
      await refusedHint(ACC, SQL.match, ['claim', e2, 0, voucher(), rid()], 'invalid_input', undefined, '22023');
      await refusedHint(ACC, SQL.match, ['journal_entry', e2, 0, voucher(), null], 'invalid_input', /requestId/, '22023');
      await refused(MANAGER, SQL.match, ['journal_entry', e2, 0, voucher(), rid()], 'not_authorized', '42501');
      await refused(PURCHASE, SQL.match, ['journal_entry', e2, 0, voucher(), rid()], 'not_authorized', '42501');
      const request = rid();
      const first = await one<Done>(ACC, SQL.match, ['journal_entry', e2, 0, voucher(), request]);
      expect(await one<Done>(ACC, SQL.match, ['journal_entry', e2, 0, voucher(), request])).toEqual({ ...first, outcome: 'existing' });
      expect(await h.audits('accounts.tally_matched')).toHaveLength(1);
    });
  });
});

describe('T2 exception and T3 reopen', () => {
  it('exception from ready / matched; open exception blocks match and a second exception; reopen never dead-ends (Addendum L1)', async () => {
    await asOwner(db, async () => {
      const { e1, e2 } = await base();
      // ready -> exception (amount given) -> reopen: never exported -> back to ready (contract Addendum L1).
      await one(ACC, SQL.exception, ['journal_entry', e1, 0, JSON.stringify({ reason: 'Synthetic: Tally shows a different amount', tallyAmountPaise: '2400000' }), rid()]);
      expect(await h.tallyRow('journal_entry', e1)).toMatchObject({ status: 'exception', status_before_exception: 'ready', });
      expect(String((await h.tallyRow('journal_entry', e1))!.exception_tally_amount_paise)).toBe('2400000');
      const [ex] = await h.audits('accounts.tally_exception_raised');
      expect(ex!.details).toMatchObject({ fromStatus: 'ready', amountGiven: true });
      expect(ex!.reason).toBe('Synthetic: Tally shows a different amount');
      await refused(ACC, SQL.match, ['journal_entry', e1, await rv('journal_entry', e1), voucher(), rid()], 'tally_exception_open', '55000');
      await refused(ACC, SQL.exception, ['journal_entry', e1, await rv('journal_entry', e1), JSON.stringify({ reason: 'Synthetic second exception' }), rid()],
        'tally_exception_open', '55000');
      await one(ACC, SQL.reopen, ['journal_entry', e1, await rv('journal_entry', e1), REASON, rid()]);
      // Addendum B7: back to ready stores no status (the computed status applies).
      expect(await h.tallyRow('journal_entry', e1)).toMatchObject({ status: null, exception_reason: null, status_before_exception: null });
      // Short reason and bad amount are invalid.
      await refusedHint(ACC, SQL.exception, ['journal_entry', e2, 0, JSON.stringify({ reason: 'short' }), rid()], 'invalid_input', /reason/, '22023');
      await refusedHint(ACC, SQL.exception, ['journal_entry', e2, 0, JSON.stringify({ reason: REASON, tallyAmountPaise: '0' }), rid()],
        'invalid_input', /tallyAmountPaise/, '22023');
      // matched -> exception -> reopen -> matched with the voucher kept.
      await one(ACC, SQL.match, ['journal_entry', e2, 0, voucher('SYN-KEEP-1'), rid()]);
      await one(ACC, SQL.exception, ['journal_entry', e2, 1, JSON.stringify({ reason: 'Synthetic: voucher posted to the wrong ledger' }), rid()]);
      expect(await h.tallyRow('journal_entry', e2)).toMatchObject({ status: 'exception', status_before_exception: 'matched' });
      await one(ACC, SQL.reopen, ['journal_entry', e2, 2, REASON, rid()]);
      expect(await h.tallyRow('journal_entry', e2)).toMatchObject({ status: 'matched', voucher_ref: 'SYN-KEEP-1', exception_reason: null, row_version: 3 });
      const reopened = await h.audits('accounts.tally_reopened');
      expect(reopened.map((a) => a.details)).toEqual(expect.arrayContaining([expect.objectContaining({ fromStatus: 'exception', toStatus: 'matched' })]));
      // matched, never exported -> reopen back to ready, voucher cleared (Addendum L1); nothing further to reopen.
      await one(ACC, SQL.reopen, ['journal_entry', e2, 3, REASON, rid()]);
      expect(await h.tallyRow('journal_entry', e2)).toMatchObject({ status: null, voucher_ref: null, voucher_date: null, matched_at: null });
      const reopens = await h.audits('accounts.tally_reopened');
      expect(reopens.map((a) => a.details)).toEqual(expect.arrayContaining([expect.objectContaining({ toStatus: 'ready', previousVoucherRef: 'SYN-KEEP-1' })]));
      await refused(ACC, SQL.reopen, ['journal_entry', e2, 4, REASON, rid()], 'wrong_state', '55000');
    });
  });

  it('after an export: matched -> reopen -> exported (voucher cleared); exception from exported -> reopen -> exported', async () => {
    await asOwner(db, async () => {
      const { e1, e2 } = await base();
      await h.exportOn();
      await one<Export>(ACC, SQL.exportCreate, [await exportFields(), rid()]);
      expect(await status('journal_entry', e1)).toBe('exported');
      await one(ACC, SQL.match, ['journal_entry', e1, await rv('journal_entry', e1), voucher('SYN-X-1'), rid()]);
      await one(ACC, SQL.reopen, ['journal_entry', e1, await rv('journal_entry', e1), REASON, rid()]);
      expect(await h.tallyRow('journal_entry', e1)).toMatchObject({ status: 'exported', voucher_ref: null, matched_at: null, export_count: 1 });
      await one(ACC, SQL.exception, ['journal_entry', e2, await rv('journal_entry', e2), JSON.stringify({ reason: 'Synthetic: missing in Tally day book' }), rid()]);
      expect(await h.tallyRow('journal_entry', e2)).toMatchObject({ status: 'exception', status_before_exception: 'exported' });
      await one(ACC, SQL.reopen, ['journal_entry', e2, await rv('journal_entry', e2), REASON, rid()]);
      expect(await h.tallyRow('journal_entry', e2)).toMatchObject({ status: 'exported', exception_reason: null });
    });
  });
});

describe('T8-T10 export', () => {
  it('switch off: tally_export_off; on: ready rows exported, never matched; export never sets matched; one audit per export and per download', async () => {
    await asOwner(db, async () => {
      const { e1, e2, r1 } = await base();
      await refused(ACC, SQL.exportCreate, [await exportFields(), rid()], 'tally_export_off', '55000');
      await h.exportOn();
      await one(ACC, SQL.match, ['journal_entry', e2, 0, voucher(), rid()]);
      const ex = await one<Export>(ACC, SQL.exportCreate, [await exportFields(), rid()]);
      expect(ex.exportNo).toMatch(/^TE-[0-9]{4}-[0-9]{6}$/);
      expect(ex).toMatchObject({ rowCount: 1, alreadyExportedCount: 0, skippedCount: 0 });
      expect(await h.tallyRow('journal_entry', e1)).toMatchObject({ status: 'exported', export_count: 1, last_export_id: ex.exportId });
      expect(await status('journal_entry', e2), 'matched is never exported').toBe('matched');
      expect(await h.audits('accounts.tally_export_created')).toEqual([expect.objectContaining({
        details: expect.objectContaining({ exportId: ex.exportId, rowCount: 1, alreadyExportedCount: 0 }) })]);
      // Download: T10 once (audited), then T9 pages (not audited).
      const header = await one<Record<string, unknown>>(ACC, SQL.exportDownload, [ex.exportId]);
      expect(header).toMatchObject({ exportNo: ex.exportNo });
      const lines = await one<Lines>(ACC, SQL.exportLines, [ex.exportId, 0, 1000]);
      expect(lines.lines.map((l) => l.lineNo)).toEqual([1]);
      expect(lines.nextAfter ?? null).toBeNull();
      await one<Lines>(ACC, SQL.exportLines, [ex.exportId, 0, 1000]);
      expect(await h.audits('accounts.tally_export_downloaded')).toHaveLength(1);
      await one(ACC, SQL.exportDownload, [ex.exportId]);
      expect(await h.audits('accounts.tally_export_downloaded')).toHaveLength(2);
      // CSV values: masked PAN, exact amount, the record id; nothing says matched.
      const v = lines.lines[0]!.values;
      const text = JSON.stringify(v);
      expect(text).not.toContain(SENTINEL.pan);
      expect(col(v, 'PAN')).toBe('XXXXX1234X');
      expect(col(v, 'Amount (INR)')).toBe('25000.00');
      expect(col(v, 'Reference')).toBe(r1.receiptNo);
      expect(col(v, 'Record type')).toBe('Receipt');
      expect(col(v, 'CRM record id')).toBe(e1);
      for (const c of CSV_COLUMNS) expect(col(v, c), `column ${c} present`).not.toBeUndefined();
      expect(col(v, 'Already exported on') ?? '').toBe('');
      expect(col(v, 'Changed since last export')).toBe('no');
      expect(text.toLowerCase()).not.toContain('matched');
      await refused(ACC, SQL.exportCreate, [await exportFields(), rid()], 'nothing_to_export', '55000');
      // Readers other than A get nothing.
      for (const actor of [MANAGER, PURCHASE]) {
        const r = await h.attempt<Lines | null>(actor, SQL.exportLines, [ex.exportId, 0, 1000]);
        expect(!r.ok || r.value === null, `lines as ${actor.userId}`).toBe(true);
        const d = await h.attempt(actor, SQL.exportDownload, [ex.exportId]);
        expect(!d.ok || d.value === null).toBe(true);
      }
      expect(await h.audits('accounts.tally_export_downloaded')).toHaveLength(2);
    });
  });

  it('includeExported re-exports, flags "already exported", never counts a record twice; replay with the same request id gives one export', async () => {
    await asOwner(db, async () => {
      const { e1, e2 } = await base();
      await h.exportOn();
      const request = rid();
      const fields = await exportFields();
      const first = await one<Export>(ACC, SQL.exportCreate, [fields, request]);
      expect(await one<Export>(ACC, SQL.exportCreate, [fields, request])).toMatchObject({ exportId: first.exportId });
      expect(Number((await owner<{ n: string }>('select count(*)::text as n from public.tally_exports'))[0]!.n)).toBe(1);
      const second = await one<Export>(ACC, SQL.exportCreate, [await exportFields({ includeExported: true }), rid()]);
      expect(second).toMatchObject({ rowCount: 2, alreadyExportedCount: 2 });
      expect(await h.tallyRow('journal_entry', e1)).toMatchObject({ status: 'exported', export_count: 2, last_export_id: second.exportId });
      expect(Number((await owner<{ n: string }>(`select count(*)::text as n from public.tally_records where record_id = any($1::uuid[])`, [[e1, e2]]))[0]!.n))
        .toBe(2);
      const lines = await one<Lines>(ACC, SQL.exportLines, [second.exportId, 0, 1000]);
      for (const l of lines.lines) expect(col(l.values, 'Already exported on')).toBe(today());
      const linesRows = await owner<{ previously_exported_at: string | null }>(
        'select previously_exported_at from public.tally_export_lines where export_id = $1', [second.exportId]);
      expect(linesRows.every((r) => r.previously_exported_at !== null)).toBe(true);
      // Workspace totals are the same before and after a re-export.
      const t = await one<{ count: number }>(ACC, SQL.recordsTotals, [JSON.stringify({ kinds: ['receipt'] })]);
      expect(t.count).toBe(2);
    });
  });

  it('reversal is its own row; the original stays matched; snapshot lines never change; a change after export flags the row', async () => {
    await asOwner(db, async () => {
      const { e1, r1, b } = await base();
      await h.exportOn();
      await one(ACC, SQL.match, ['journal_entry', e1, 0, voucher(), rid()]);
      await h.fin.reverse(ACC, r1.id, 'data_error');
      const reversal = (await h.entryOf(r1.id, 'reversal%'))!;
      const ex = await one<Export>(ACC, SQL.exportCreate, [await exportFields(), rid()]);
      const exported = await owner<{ record_id: string }>('select record_id from public.tally_export_lines where export_id = $1', [ex.exportId]);
      expect(exported.map((x) => x.record_id)).toContain(reversal);
      expect(exported.map((x) => x.record_id)).not.toContain(e1);
      expect(await status('journal_entry', e1)).toBe('matched');
      const line = (await one<Lines>(ACC, SQL.exportLines, [ex.exportId, 0, 1000])).lines.find((l) => col(l.values, 'CRM record id') === reversal)!;
      expect(col(line.values, 'Record type')).toBe('Receipt reversal');
      expect(col(line.values, 'Amount (INR)'), 'unsigned').toBe('25000.00');

      // Supplier credit note exported, then linked to its invoice: changedSinceExport; the snapshot stays.
      const task = h.taskOf(b, 'hotel');
      const supplierId = await h.purchaseSupplier();
      await h.purchaseCost(task, supplierId);
      const inv = await h.uploadDoc(task, { number: 'SYN-INV-77' });
      const cn = await h.uploadDoc(task, { kind: 'credit_note', number: 'SYN-CN-77', totalPaise: '50000' });
      await h.reviewDoc(inv.id, 'accept', null, { userId: U.visaJodhpur });
      await h.reviewDoc(cn.id, 'accept', null, { userId: U.visaJodhpur });
      const docEx = await one<Export>(ACC, SQL.exportCreate, [await exportFields({ kinds: ['supplier_document'] }), rid()]);
      const before = await one<Lines>(ACC, SQL.exportLines, [docEx.exportId, 0, 1000]);
      await one(ACC, SQL.docCredit, [cn.id, inv.id, rid()]);
      const row = (await h.allRecords(ACC, { kinds: ['supplier_credit_note'] }))[0]!;
      expect(row.tally).toMatchObject({ status: 'exported', changedSinceExport: true, exportCount: 1 });
      expect((await h.allRecords(ACC, { changedSinceExport: true })).map((r) => r.rowId)).toContain(`supplier_credit_note:${cn.id}`);
      expect(await one<Lines>(ACC, SQL.exportLines, [docEx.exportId, 0, 1000]), 'snapshot unchanged').toEqual(before);
      const again = await one<Export>(ACC, SQL.exportCreate, [await exportFields({ kinds: ['supplier_document'], includeExported: true }), rid()]);
      const changedLine = (await one<Lines>(ACC, SQL.exportLines, [again.exportId, 0, 1000])).lines.find((l) => col(l.values, 'CRM record id') === cn.id)!;
      expect(col(changedLine.values, 'Changed since last export')).toBe('yes');
      expect(col(changedLine.values, 'Credit note for')).toBe('SYN-INV-77');
    });
  });

  it('more than 10,000 rows: export_too_large (hint from); fields are validated', async () => {
    await asOwner(db, async () => {
      await base();
      await h.exportOn();
      await refusedHint(ACC, SQL.exportCreate, [await exportFields({ from: dayFrom(-400) }), rid()], 'invalid_input', /from|to/, '22023');
      await refusedHint(ACC, SQL.exportCreate, [await exportFields({ to: dayFrom(1) }), rid()], 'invalid_input', /to/, '22023');
      await refusedHint(ACC, SQL.exportCreate, [await exportFields({ kinds: [] }), rid()], 'invalid_input', /kinds/, '22023');
      await refusedHint(ACC, SQL.exportCreate, [await exportFields({ kinds: ['claim'] }), rid()], 'invalid_input', /kinds/, '22023');
      await h.bulkReadyEntries(DEAL, 10_001);
      await refusedHint(ACC, SQL.exportCreate, [await exportFields(), rid()], 'export_too_large', /from/, '22023');
      expect(Number((await owner<{ n: string }>('select count(*)::text as n from public.tally_exports'))[0]!.n)).toBe(0);
    });
  });
});

describe('T4/T5 GST invoice references and T6/T7 settings', () => {
  it('add: matched at creation; duplicate in the same financial year refused (normalised); next year allowed; withdraw -> not applicable', async () => {
    await asOwner(db, async () => {
      await base();
      const added = await one<{ outcome: string; tallyInvoiceId?: string; id?: string }>(ACC, SQL.invoiceAdd,
        [DEAL, JSON.stringify({ invoiceRef: 'HC/25-26/0042', invoiceDate: today(), note: null }), rid()]);
      const id = (added.tallyInvoiceId ?? added.id)!;
      expect(await h.tallyRow('tally_gst_invoice', id)).toMatchObject({ status: 'matched', voucher_ref: 'HC/25-26/0042' });
      await refused(ACC, SQL.invoiceAdd, [DEAL, JSON.stringify({ invoiceRef: 'hc 25 26 0042', invoiceDate: today(), note: null }), rid()],
        'duplicate_tally_invoice', '23505');
      await one(ACC, SQL.invoiceAdd, [DEAL, JSON.stringify({ invoiceRef: 'HC/25-26/0042', invoiceDate: '2025-03-31', note: null }), rid()]);
      await one(ACC, SQL.invoiceAdd, [DEAL, JSON.stringify({ invoiceRef: 'HC/25-26/0043', invoiceDate: today(), note: 'Synthetic second invoice' }), rid()]);
      await refusedHint(ACC, SQL.invoiceAdd, [DEAL, JSON.stringify({ invoiceRef: 'BAD#REF', invoiceDate: today(), note: null }), rid()],
        'invalid_input', /invoiceRef/, '22023');
      await refused(MANAGER, SQL.invoiceAdd, [DEAL, JSON.stringify({ invoiceRef: 'HC/25-26/0050', invoiceDate: today(), note: null }), rid()],
        'not_authorized', '42501');
      const [row] = await owner<{ row_version: number }>('select row_version from public.deal_tally_invoices where id = $1', [id]);
      await one(ACC, SQL.invoiceWithdraw, [id, row!.row_version, 'Synthetic: typed against the wrong Deal', rid()]);
      const deal = await one<{ tallyInvoices?: Array<{ id: string; tallyStatus: string }> }>(ACC, SQL.dealDues, [DEAL]);
      const listed = (deal.tallyInvoices ?? []).find((x) => x.id === id);
      expect(listed === undefined || listed.tallyStatus === 'not_applicable').toBe(true);
      expect((await h.allRecords(ACC, { kinds: ['tally_gst_invoice'] })).find((r) => r.recordId === id)?.tally.status ?? 'not_applicable')
        .toBe('not_applicable');
      // After the withdrawal the same reference may be recorded again.
      await one(ACC, SQL.invoiceAdd, [DEAL, JSON.stringify({ invoiceRef: 'HC/25-26/0042', invoiceDate: today(), note: null }), rid()]);
      expect(await h.audits('accounts.tally_invoice_added')).toHaveLength(4);
      expect(await h.audits('accounts.tally_invoice_withdrawn')).toHaveLength(1);
    });
  });

  it('exception owner: only the policy manager sets it; must be an active Accounts person without Purchase; acct_exception_owner follows access', async () => {
    await asOwner(db, async () => {
      await h.addAcc3();
      const entity = await h.entityId();
      await refused(ACC, SQL.setExceptionOwner, [entity, U.invitedStaff, REASON], 'not_authorized', '42501');
      await refusedHint(SUPER, SQL.setExceptionOwner, [entity, U.purchaseJodhpur, REASON], 'invalid_input', /userId/, '22023');
      await one(SUPER, SQL.setExceptionOwner, [entity, U.invitedStaff, REASON]);
      const ownerNow = async () => (await owner<{ u: string | null }>('select authz.acct_exception_owner($1) as u', [entity]))[0]!.u;
      expect(await ownerNow()).toBe(U.invitedStaff);
      const daily = await one<{ exceptionOwner: { userId: string | null; set: boolean; isYou: boolean } }>(ACC3, SQL.dailyCheck, []);
      expect(daily.exceptionOwner).toMatchObject({ userId: U.invitedStaff, set: true, isYou: true });
      await h.addRole(U.invitedStaff, 'purchase');
      expect(await ownerNow(), 'an owner who gains Purchase is "not set"').toBeNull();
      await one(SUPER, SQL.setExceptionOwner, [entity, null, REASON]);
      expect(await h.audits('settings.accounts_changed')).not.toHaveLength(0);
      for (const a of await h.audits('settings.accounts_changed')) expect(JSON.stringify(a.details)).not.toContain(U.invitedStaff);
      await refused(ACC, SQL.setTallyExport, [entity, true, REASON], 'not_authorized', '42501');
    });
  });
});
