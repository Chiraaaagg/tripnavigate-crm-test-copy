import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { nextPnr } from './flight-support';
import {
  ACC, DEAL, DEAL2, FLIGHT_ITEM, HOTEL_ITEM, PAST_HOTEL_ITEM, PAST_TRIP, ROW_KEYS, SALES_B, SQL, TALLY_KEYS, WORKSPACE_KINDS, type WorkPage, type WorkRow,
  accHelpers, dayFrom, rid, today,
} from './acc-support';

/**
 * Accounts phase contract section 8.1 (Accounts > Documents and money) and
 * 4.5 (originals), test plan 12.2, Track E. Written from the contract, not
 * from Track B's migrations 20261203000200..0399:
 *   - every source appears exactly once with the frozen row shape;
 *   - computed Tally statuses per kind (6.2.1 table);
 *   - filters one by one and combined; unknown filter key refused;
 *   - exact-reference search for every reference type (PNR on two Deals
 *     returns both; punctuation-insensitive bill numbers; ignores other
 *     filters except branchId);
 *   - keyset paging without gaps or duplicates, also with inserts between pages;
 *   - totals on demand equal the rows;
 *   - originals: expected vs missing, bank proof, fee receipt, returned bill,
 *     GST invoice reference.
 * Role fences and the leak scan are in acc-fence.test.ts.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = accHelpers(() => db);
const { one, owner, refusedHint } = h;
const byId = (rows: WorkRow[]) => new Map(rows.map((r) => [r.rowId, r]));
const ids = (rows: WorkRow[]) => rows.map((r) => r.rowId);

/** Contract order: record_date desc, created_at desc, kind asc, record_id desc. */
function inContractOrder(rows: WorkRow[]): boolean {
  for (let i = 1; i < rows.length; i += 1) {
    const a = rows[i - 1]!;
    const b = rows[i]!;
    if (a.recordDate !== b.recordDate) { if (a.recordDate < b.recordDate) return false; continue; }
    const ta = Date.parse(a.createdAt);
    const tb = Date.parse(b.createdAt);
    if (ta !== tb) { if (ta < tb) return false; continue; }
    if (a.kind !== b.kind) { if (a.kind > b.kind) return false; continue; }
    if (a.recordId < b.recordId) return false;
  }
  return true;
}

describe('8.1 every source once, frozen row shape', () => {
  it('lists one row per record of every kind with exactly the frozen keys', async () => {
    await asOwner(db, async () => {
      const k = await h.everyKind();
      const rows = await h.allRecords(ACC);
      const map = byId(rows);
      expect(new Set(ids(rows)).size, 'no row twice').toBe(rows.length);
      const reversalEntry = await h.entryOf(k.reversed.id, 'reversal%');
      const expected: Array<[string, string | undefined]> = [
        ['receipt', k.bank.id], ['receipt', k.cash.id], ['receipt', k.pending.id], ['receipt', k.reversed.id],
        ['receipt_reversal', reversalEntry], ['claim', k.claim.id as string], ['cash_deposit', k.deposit.id], ['cash_count', k.count.id],
        ['supplier_payment', k.paid.id], ['supplier_payment', k.funded.id], ['company_funding', k.funding], ['supplier_invoice', k.invoice.id],
        ['supplier_credit_note', k.credit.id], ['expense', k.flightExpense], ['flight_ticket_batch', k.batch.batchId],
        ['visa_application', k.application!.id], ['tally_gst_invoice', k.gstId],
      ];
      for (const [kind, id] of expected) {
        expect(id, `${kind} id from the scenario`).toBeTruthy();
        const row = map.get(`${kind}:${id}`);
        expect(row, `${kind}:${id} listed`).toBeDefined();
        expect(Object.keys(row!).sort(), `${kind} row keys`).toEqual(ROW_KEYS);
        expect(Object.keys(row!.tally).sort().every((key) => TALLY_KEYS.includes(key)), `${kind} tally keys`).toBe(true);
        expect(row!.kind).toBe(kind);
        expect(row!.recordId).toBe(id);
      }
      // Every listed kind is a contract kind; the draft visa fee (no receipt) is an original, not an expense row (8.1).
      expect(rows.every((r) => (WORKSPACE_KINDS as readonly string[]).includes(r.kind))).toBe(true);
      expect(map.has(`expense:${k.visaFee}`), 'draft company fee without receipt is not an expense row').toBe(false);
      const originals = h.rowsOf(rows, 'original');
      expect(originals.map((o) => o.original?.what).sort()).toEqual(expect.arrayContaining(['airline_bill', 'bank_proof', 'fee_receipt']));
      expect(originals.every((o) => o.original && ['expected', 'missing'].includes(o.original.state))).toBe(true);
      // Directions and amounts (8.1 kind sources).
      expect(map.get(`receipt:${k.bank.id}`)).toMatchObject({ direction: 'in', amountPaise: '2500000', dealId: DEAL, reviewStatus: 'done' });
      expect(map.get(`receipt_reversal:${reversalEntry}`)).toMatchObject({ direction: 'out', amountPaise: '300000' });
      expect(map.get(`cash_deposit:${k.deposit.id}`)).toMatchObject({ direction: 'contra', amountPaise: '1000000' });
      expect(map.get(`claim:${k.claim.id}`)).toMatchObject({ direction: 'info', statusCode: 'reported' });
      expect(map.get(`supplier_invoice:${k.invoice.id}`)).toMatchObject({ direction: 'bill', supplierId: k.supplierId, department: 'purchase' });
      expect(map.get(`supplier_credit_note:${k.credit.id}`)).toMatchObject({ direction: 'credit' });
      expect(map.get(`visa_application:${k.application!.id}`)).toMatchObject({ amountPaise: null, department: 'visa' });
      expect(map.get(`visa_application:${k.application!.id}`)!.otherReferences.join(' ') + (map.get(`visa_application:${k.application!.id}`)!.reference ?? ''))
        .toContain(k.application!.reference);
      expect(map.get(`flight_ticket_batch:${k.batch.batchId}`)!.otherReferences.join(' ')).toContain(k.pnr);
      // Receipt collected by another branch carries the collecting branch name (AL8).
      expect(map.get(`receipt:${k.cash.id}`)!.collectingBranchName).toBeTruthy();
      expect(map.get(`receipt:${k.cash.id}`)!.collectingBranchName).not.toBe(map.get(`receipt:${k.cash.id}`)!.branchName);
      expect(inContractOrder(rows), 'contract order').toBe(true);
    });
  });

  it('computed Tally status per kind (6.2.1): ready / not ready / not applicable / matched', async () => {
    await asOwner(db, async () => {
      const k = await h.everyKind();
      const map = byId(await h.allRecords(ACC));
      const tally = (kind: string, id: string | undefined) => map.get(`${kind}:${id}`)!.tally;
      expect(tally('receipt', k.bank.id)).toMatchObject({ status: 'ready', recordKind: 'journal_entry', rowVersion: 0, exportCount: 0, changedSinceExport: false });
      expect(tally('receipt', k.pending.id)).toMatchObject({ status: 'not_ready' });
      expect(tally('receipt_reversal', await h.entryOf(k.reversed.id, 'reversal%'))).toMatchObject({ status: 'ready', recordKind: 'journal_entry' });
      expect(tally('cash_deposit', k.deposit.id)).toMatchObject({ status: 'ready', recordKind: 'journal_entry' });
      for (const [kind, id] of [['claim', k.claim.id], ['cash_count', k.count.id], ['company_funding', k.funding],
        ['flight_ticket_batch', k.batch.batchId], ['visa_application', k.application!.id]] as Array<[string, string]>) {
        expect(tally(kind, id).status, `${kind} is not applicable`).toBe('not_applicable');
      }
      expect(tally('supplier_payment', k.paid.id)).toMatchObject({ status: 'ready', recordKind: 'supplier_payment' });
      expect(tally('supplier_payment', k.funded.id).status, 'pending request').toBe('not_ready');
      expect(tally('supplier_invoice', k.invoice.id)).toMatchObject({ status: 'not_ready', recordKind: 'supplier_document' });
      expect(tally('expense', k.flightExpense)).toMatchObject({ status: 'not_ready', recordKind: 'expense' });
      expect(tally('tally_gst_invoice', k.gstId)).toMatchObject({ status: 'matched', recordKind: 'tally_gst_invoice' });
      // Accepting the invoice and the expense makes them ready.
      await h.reviewDoc(k.invoice.id, 'accept', null, { userId: U.visaJodhpur });
      const [e] = await owner<{ row_version: number }>('select row_version from public.department_cost_entries where id = $1', [k.flightExpense]);
      await one(ACC, 'select public.expense_record_accept($1, $2, $3) as r', [k.flightExpense, e!.row_version, rid()]);
      const after = byId(await h.allRecords(ACC));
      expect(after.get(`supplier_invoice:${k.invoice.id}`)!.tally.status).toBe('ready');
      expect(after.get(`expense:${k.flightExpense}`)!.tally.status).toBe('ready');
    });
  });
});

describe('8.1 filters', () => {
  it('each filter alone narrows to matching rows; combined filters intersect; unknown keys are refused', async () => {
    await asOwner(db, async () => {
      const k = await h.everyKind();
      const all = await h.allRecords(ACC);
      const only = async (filter: Record<string, unknown>) => h.allRecords(ACC, filter);

      const receipts = await only({ kinds: ['receipt'] });
      expect(receipts.length).toBe(h.rowsOf(all, 'receipt').length);
      expect(receipts.every((r) => r.kind === 'receipt')).toBe(true);

      const two = await only({ kinds: ['supplier_invoice', 'supplier_credit_note'] });
      expect(new Set(two.map((r) => r.kind))).toEqual(new Set(['supplier_invoice', 'supplier_credit_note']));

      const purchase = await only({ department: 'purchase' });
      expect(purchase.length).toBeGreaterThan(0);
      expect(purchase.every((r) => r.department === 'purchase')).toBe(true);

      const supplier = await only({ supplierId: k.supplierId });
      expect(supplier.every((r) => r.supplierId === k.supplierId)).toBe(true);
      expect(ids(supplier)).toEqual(expect.arrayContaining([`supplier_invoice:${k.invoice.id}`, `supplier_payment:${k.paid.id}`]));

      const ready = await only({ tallyStatus: 'ready' });
      expect(ready.length).toBeGreaterThan(0);
      expect(ready.every((r) => r.tally.status === 'ready')).toBe(true);
      const na = await only({ tallyStatus: 'not_applicable' });
      expect(na.every((r) => r.tally.status === 'not_applicable')).toBe(true);

      const missingOrExpected = await only({ originals: 'any' });
      expect(missingOrExpected.length).toBeGreaterThan(0);
      expect(missingOrExpected.every((r) => r.original !== null)).toBe(true);
      const missing = await only({ originals: 'missing' });
      expect(missing.every((r) => r.original?.state === 'missing')).toBe(true);
      expect(missing.map((r) => r.original!.what)).toContain('bank_proof');
      const expectedOnly = await only({ originals: 'expected' });
      expect(expectedOnly.every((r) => r.original?.state === 'expected')).toBe(true);

      const big = await only({ amountMin: '2000000' });
      expect(big.length).toBeGreaterThan(0);
      expect(big.every((r) => r.amountPaise !== null && BigInt(r.amountPaise) >= 2_000_000n)).toBe(true);
      const band = await only({ amountMin: '300000', amountMax: '1000000' });
      expect(band.every((r) => r.amountPaise !== null && BigInt(r.amountPaise) >= 300_000n && BigInt(r.amountPaise) <= 1_000_000n)).toBe(true);

      const jdh = await only({ branchId: await h.branchId('JDH') });
      expect(ids(jdh)).toEqual(expect.arrayContaining([`cash_deposit:${k.deposit.id}`, `cash_count:${k.count.id}`]));

      const dealRows = await only({ dealReference: 'SYN-DEL-001' });
      expect(dealRows.every((r) => r.dealId === DEAL)).toBe(true);

      const old = await only({ to: dayFrom(-1) });
      expect(old.every((r) => r.recordDate <= dayFrom(-1))).toBe(true);
      const todays = await only({ from: today(), to: today() });
      expect(todays.every((r) => r.recordDate === today())).toBe(true);

      const open = await only({ stage: 'open' });
      expect(open.every((r) => r.stage === 'open')).toBe(true);
      const done = await only({ reviewStatus: 'done' });
      expect(done.every((r) => r.reviewStatus === 'done')).toBe(true);
      const changed = await only({ changedSinceExport: true });
      expect(changed.every((r) => r.tally.changedSinceExport)).toBe(true);

      const combined = await only({ kinds: ['receipt'], tallyStatus: 'ready', amountMin: '2000000' });
      expect(ids(combined)).toEqual([`receipt:${k.bank.id}`]);

      await refusedHint(ACC, SQL.records, [JSON.stringify({ colour: 'red' }), null, 50], 'invalid_input', undefined, '22023');
      // p_limit 1..100 (8.1): refused or capped, never more than 100 rows.
      for (const limit of [101, 0]) {
        const r = await h.attempt<{ items: unknown[] } | null>(ACC, SQL.records, [JSON.stringify({}), null, limit]);
        if (r.ok) expect((r.value?.items ?? []).length, `limit ${limit}`).toBeLessThanOrEqual(100);
        else expect(r.error).toBe('invalid_input');
      }
      await refusedHint(ACC, SQL.records, [JSON.stringify({ kinds: ['receipts'] }), null, 50], 'invalid_input', undefined, '22023');
    });
  });
});

describe('8.1 exact-reference search', () => {
  it('R-, SP-, Deal reference, ticket number, invoice number (punctuation-insensitive), Visa and GST references', async () => {
    await asOwner(db, async () => {
      const k = await h.everyKind();
      const search = async (q: string, extra: Record<string, unknown> = {}) => ids(await h.allRecords(ACC, { q, ...extra }));
      const receiptNo = k.reversed.receiptNo!;
      expect(await search(receiptNo)).toEqual(expect.arrayContaining([`receipt:${k.reversed.id}`, `receipt_reversal:${await h.entryOf(k.reversed.id, 'reversal%')}`]));
      expect(await search(` ${receiptNo.toLowerCase()} `), 'trimmed and upper-cased').toContain(`receipt:${k.reversed.id}`);
      expect(await search(k.funded.refNo)).toEqual(expect.arrayContaining([`supplier_payment:${k.funded.id}`, `company_funding:${k.funding}`]));
      const dealHits = await search('SYN-DEL-001');
      expect(dealHits.length).toBeGreaterThanOrEqual(10);
      expect(await search(k.ticket)).toContain(`flight_ticket_batch:${k.batch.batchId}`);
      expect(await search(k.ticket.replace('-', ''))).toContain(`flight_ticket_batch:${k.batch.batchId}`);
      expect(await search('syn inv 001'), 'invoice number with different punctuation').toContain(`supplier_invoice:${k.invoice.id}`);
      expect(await search('SYN-INV/001')).toContain(`supplier_invoice:${k.invoice.id}`);
      expect(await search(k.application!.reference)).toContain(`visa_application:${k.application!.id}`);
      expect(await search('HC/25-26/0042')).toContain(`tally_gst_invoice:${k.gstId}`);
      // No fuzzy match.
      expect(await search(receiptNo.slice(0, -1))).not.toContain(`receipt:${k.reversed.id}`);
      // Search ignores other filters except branchId.
      expect(await search(receiptNo, { kinds: ['claim'], tallyStatus: 'matched' })).toContain(`receipt:${k.reversed.id}`);
      expect(await search(receiptNo, { branchId: await h.branchId('AMD') })).not.toContain(`receipt:${k.reversed.id}`);
    });
  });

  it('a PNR shared by two Deals lists both batches', async () => {
    await asOwner(db, async () => {
      await h.addAcc2();
      await h.book([HOTEL_ITEM, FLIGHT_ITEM]);
      await h.book([HOTEL_ITEM, FLIGHT_ITEM], { deal: DEAL2, actor: SALES_B });
      const pnr = nextPnr();
      const one1 = await h.flightBatch(DEAL, [1], { tickets: { 1: { airlinePnr: pnr } } });
      const one2 = await h.flightBatch(DEAL2, [1], { tickets: { 1: { crsPnr: pnr } } });
      const hits = ids(await h.allRecords(ACC, { q: pnr }));
      expect(hits).toEqual(expect.arrayContaining([`flight_ticket_batch:${one1.batchId}`, `flight_ticket_batch:${one2.batchId}`]));
      expect(hits.filter((x) => x.startsWith('flight_ticket_batch:'))).toHaveLength(2);
      expect(hits.every((x) => x.startsWith('flight_ticket_batch:'))).toBe(true);
    });
  });
});

describe('8.1 keyset paging and totals', () => {
  it('pages of 3 cover every row once in order; a record inserted between pages causes no gap or duplicate', async () => {
    await asOwner(db, async () => {
      await h.everyKind();
      const all = await h.allRecords(ACC, {}, 100);
      const paged: WorkRow[] = [];
      let after: string | null = null;
      let first = true;
      let inserted: string | null = null;
      for (let i = 0; i < 100; i += 1) {
        const page: WorkPage = (await h.records(ACC, {}, after, 3))!;
        expect(page.items.length).toBeLessThanOrEqual(3);
        paged.push(...page.items);
        if (first) {
          // A newer record lands before the cursor: later pages must still continue cleanly.
          const r = await h.receipt(DEAL, '111100');
          inserted = `receipt:${r.id}`;
          first = false;
        }
        if (!page.nextAfter) break;
        expect(page.nextAfter).toMatch(/^\d{4}-\d{2}-\d{2}\|[^|]+\|[a-z_]+\|[0-9a-f-]{36}$/);
        after = page.nextAfter;
      }
      const pagedIds = ids(paged);
      expect(new Set(pagedIds).size, 'no duplicates').toBe(pagedIds.length);
      expect(pagedIds.filter((x) => x !== inserted).sort(), 'no gaps').toEqual(ids(all).sort());
      expect(inContractOrder(paged.filter((r) => r.rowId !== inserted))).toBe(true);
    });
  });

  it('totals on demand count the same rows as the list, per kind with in/out sums', async () => {
    await asOwner(db, async () => {
      await h.everyKind();
      for (const filter of [{}, { kinds: ['receipt', 'receipt_reversal'] }, { department: 'purchase' }]) {
        const rows = await h.allRecords(ACC, filter);
        const totals = await one<{ count: number; byKind: Array<{ kind: string; count: number; inPaise: string; outPaise: string }> }>(
          ACC, SQL.recordsTotals, [JSON.stringify(filter)]);
        expect(totals.count, JSON.stringify(filter)).toBe(rows.length);
        for (const k of totals.byKind) {
          expect(k.count, k.kind).toBe(h.rowsOf(rows, k.kind).length);
          const sum = (dir: string) => h.rowsOf(rows, k.kind).filter((r) => r.direction === dir && r.amountPaise)
            .reduce((acc, r) => acc + BigInt(r.amountPaise!), 0n).toString();
          if (k.kind === 'receipt') expect(k.inPaise).toBe(sum('in'));
          if (k.kind === 'receipt_reversal') expect(k.outPaise).toBe(sum('out'));
        }
      }
    });
  });
});

describe('4.5 originals: expected vs missing', () => {
  it('a paid hotel task expects the supplier invoice; after the stay it is missing; an uploaded invoice satisfies it; a returned one does not', async () => {
    await asOwner(db, async () => {
      await h.addAcc2();
      const b = await h.book([PAST_HOTEL_ITEM], { trip: PAST_TRIP });
      await h.receipt(DEAL, '30000000');
      await h.approve(b.versionId);
      const task = h.taskOf(b, 'hotel');
      const supplierId = await h.purchaseSupplier();
      await h.purchaseCost(task, supplierId);
      await h.goAhead(task);
      const originalsOf = async () => h.rowsOf(await h.allRecords(ACC, { originals: 'any' }), 'original')
        .filter((r) => r.original!.what === 'supplier_invoice' && r.taskId === task);
      expect(await originalsOf(), 'not expected before paid or confirmed').toEqual([]);
      const p = await h.purchaseRequest(task, 2_000_000);
      await h.payThrough(p.id, 'paid');
      expect((await originalsOf())[0]!.original, 'paid: expected').toMatchObject({ what: 'supplier_invoice', state: 'expected', ownerRole: 'purchase' });
      // Missing follows authz.sm_invoice_missing: supplier confirmed and the stay ended.
      await h.confirmSupplier(task);
      const [row] = await originalsOf();
      expect(row!.original).toMatchObject({ what: 'supplier_invoice', state: 'missing', ownerRole: 'purchase' });
      const doc = await h.uploadDoc(task, { number: 'SYN-PAST-1' });
      expect(await originalsOf()).toEqual([]);
      await h.reviewDoc(doc.id, 'return', 'Synthetic: the bill shows another hotel');
      expect((await originalsOf())[0]?.original?.state, 'a returned bill does not satisfy').toBe('missing');
    });
  });

  it('future stay: expected, not missing; bank proof missing at once; GST reference expected then missing after the trip', async () => {
    await asOwner(db, async () => {
      await h.addAcc2();
      const b = await h.book([HOTEL_ITEM]);
      await h.approve(b.versionId);
      const rec = await h.fin.record(ACC, DEAL, await h.fin.bankFields({ amountPaise: '500000' }));
      const originals = h.rowsOf(await h.allRecords(ACC, { originals: 'any' }), 'original');
      expect(originals.find((r) => r.original!.what === 'bank_proof' && r.link.id === rec.id)?.original?.state
        ?? originals.find((r) => r.original!.what === 'bank_proof')?.original?.state).toBe('missing');
      expect(originals.find((r) => r.original!.what === 'gst_invoice_ref' && r.dealId === DEAL)?.original).toMatchObject({ state: 'expected', ownerRole: 'accounts' });
      await h.fin.proof(ACC, 'receipt', rec.id, 'bank_proof');
      expect(h.rowsOf(await h.allRecords(ACC, { originals: 'any' }), 'original').filter((r) => r.original!.what === 'bank_proof')).toEqual([]);
    });
    await asOwner(db, async () => {
      const b = await h.book([PAST_HOTEL_ITEM], { trip: PAST_TRIP });
      await h.approve(b.versionId);
      const originals = h.rowsOf(await h.allRecords(ACC, { originals: 'any' }), 'original');
      expect(originals.find((r) => r.original!.what === 'gst_invoice_ref' && r.dealId === DEAL)?.original?.state).toBe('missing');
      await one(ACC, SQL.invoiceAdd, [DEAL, JSON.stringify({ invoiceRef: 'HC/25-26/0099', invoiceDate: today(), note: null }), rid()]);
      const after = h.rowsOf(await h.allRecords(ACC, { originals: 'any' }), 'original');
      expect(after.filter((r) => r.original!.what === 'gst_invoice_ref' && r.dealId === DEAL)).toEqual([]);
    });
  });
});
