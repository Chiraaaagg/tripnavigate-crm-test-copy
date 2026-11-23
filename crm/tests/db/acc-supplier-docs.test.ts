import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import {
  ACC, ACC2, DEAL, DEAL2, HOTEL_ITEM, MANAGER, PAST_HOTEL_ITEM, PAST_TRIP, PURCHASE, REASON, SALES_B, SQL, TRANSFER_ITEM, accHelpers, rid, today,
} from './acc-support';

/**
 * Accounts phase contract sections 6.2.2 (duplicate rule), 6.2.3 (task
 * links, credit note link, sm_invoice_missing), 7.3 (S1-S3) and test plan
 * 12.2 "Supplier documents", Track E:
 *   - duplicates refused on supplier + kind + normalised number + financial
 *     year (case, spaces, dashes, slashes ignored); other FY, other supplier,
 *     other kind (credit note) allowed; returned documents ignored (re-issue);
 *     a number made only of punctuation is invalid (hint number);
 *   - one bill linked to several tasks/Deals by Accounts or by the target
 *     task's assignee; wrong supplier refused (link_not_allowed); linking
 *     twice is 'existing'; unlink by Accounts with a reason;
 *   - credit note -> invoice link set once (already_recorded), also at upload;
 *   - authz.sm_invoice_missing honours links; a returned bill never satisfies;
 *   - the migration's duplicate guard stops when duplicates exist.
 * The upload race (two uploads at once) is in acc-concurrency.test.ts.
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

/** Two hotel tasks with the same supplier (DEAL and DEAL2) and one with another supplier (DEAL2 transfer). */
async function twoDeals(opts: { past?: boolean } = {}) {
  await h.addAcc2();
  const item = opts.past ? PAST_HOTEL_ITEM : HOTEL_ITEM;
  const trip = opts.past ? PAST_TRIP : undefined;
  const a = await h.book([item], { trip });
  const b = await h.book([item, TRANSFER_ITEM],
    { deal: DEAL2, actor: SALES_B, trip });
  await h.approve(a.versionId);
  await h.approve(b.versionId);
  const supplierId = await h.purchaseSupplier();
  const other = await h.purchaseSupplier();
  const taskA = h.taskOf(a, 'hotel');
  const taskB = h.taskOf(b, 'hotel');
  const taskOther = h.taskOf(b, 'transfer');
  await h.purchaseCost(taskA, supplierId);
  await h.purchaseCost(taskB, supplierId);
  await h.purchaseCost(taskOther, other);
  return { a, b, supplierId, other, taskA, taskB, taskOther };
}

describe('6.2.2 duplicate supplier documents', () => {
  it('the same normalised number of the same supplier, kind and financial year is refused, however it is typed', async () => {
    await asOwner(db, async () => {
      const s = await twoDeals();
      await h.uploadDoc(s.taskA, { number: 'SYN/INV-001' });
      for (const number of ['syn/inv-001', 'SYN INV 001', 'SYN-INV/001', 'SYNINV001', ' syn.inv.001 ']) {
        await refusedHint(PURCHASE, SQL.docUpload, [s.taskB, JSON.stringify({ kind: 'invoice', number, docDate: today(), totalPaise: '100000',
          gstIncluded: true, evidenceId: await h.moneyFile(PURCHASE, s.taskB, 'invoice') }), rid()], 'duplicate_supplier_document', /^number$/, '23505');
      }
      // Other financial year, other supplier and the other kind are fine.
      await h.uploadDoc(s.taskB, { number: 'SYN/INV-001', docDate: '2026-03-31' });
      await h.uploadDoc(s.taskOther, { number: 'SYN/INV-001' });
      await h.uploadDoc(s.taskA, { kind: 'credit_note', number: 'SYN/INV-001', totalPaise: '1000' });
      const rows = await owner<{ number_norm: string; fiscal_year: string }>('select number_norm, fiscal_year from public.supplier_documents order by uploaded_at');
      expect(rows[0]).toEqual({ number_norm: 'SYNINV001', fiscal_year: expect.stringMatching(/^2026-27$|^2026-2027$|^2026$/) });
    });
  });

  it('a returned document is ignored: the corrected bill may be uploaded again with the same number', async () => {
    await asOwner(db, async () => {
      const s = await twoDeals();
      const first = await h.uploadDoc(s.taskA, { number: 'SYN-RE-9' });
      await h.reviewDoc(first.id, 'return', 'Synthetic: wrong GST number on the bill');
      const again = await h.uploadDoc(s.taskA, { number: 'SYN-RE-9' });
      expect(again.outcome).toBe('created');
      await refused(PURCHASE, SQL.docUpload, [s.taskA, JSON.stringify({ kind: 'invoice', number: 'SYN-RE-9', docDate: today(), totalPaise: '100000',
        gstIncluded: true, evidenceId: await h.moneyFile(PURCHASE, s.taskA, 'invoice') }), rid()], 'duplicate_supplier_document', '23505');
    });
  });

  it('a number with no letters or digits is invalid (hint number); replay of the same request is existing', async () => {
    await asOwner(db, async () => {
      const s = await twoDeals();
      await refusedHint(PURCHASE, SQL.docUpload, [s.taskA, JSON.stringify({ kind: 'invoice', number: '--/--', docDate: today(), totalPaise: '100000',
        gstIncluded: true, evidenceId: await h.moneyFile(PURCHASE, s.taskA, 'invoice') }), rid()], 'invalid_input', /number/, '22023');
      const request = rid();
      const first = await h.uploadDoc(s.taskA, { number: 'SYN-RP-1' }, PURCHASE, request);
      const ev = (await owner<{ evidence_id: string }>('select evidence_id from public.supplier_documents where id = $1', [first.id]))[0]!.evidence_id;
      const replay = await one<{ outcome: string; id: string }>(PURCHASE, SQL.docUpload, [s.taskA, JSON.stringify({ kind: 'invoice', number: 'SYN-RP-1',
        docDate: today(), totalPaise: '10000000', gstIncluded: true, evidenceId: ev }), request]);
      expect(replay).toMatchObject({ id: first.id });
    });
  });

  it('the migration guard stops when duplicates exist (no row changed automatically)', async () => {
    await asOwner(db, async () => {
      const s = await twoDeals();
      const one1 = await h.uploadDoc(s.taskA, { number: 'SYN-DUP-1' });
      const two = await h.uploadDoc(s.taskB, { number: 'SYN-DUP-2' });
      // Seed a duplicate the way live data could hold one (before the index existed).
      await owner('drop index public.supplier_documents_no_duplicate');
      await owner('alter table public.supplier_documents disable trigger user');
      await owner('update public.supplier_documents set number = (select number from public.supplier_documents where id = $1) where id = $2', [one1.id, two.id]);
      await owner('alter table public.supplier_documents enable trigger user');
      const dir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
      const file = readdirSync(dir).find((f) => f.startsWith('20261203000210'));
      expect(file, 'Track B migration 20261203000210 present').toBeDefined();
      const sql = readFileSync(join(dir, file!), 'utf8');
      const guard = sql.match(/do \$\$[\s\S]*?supplier_document_duplicates_exist[\s\S]*?\$\$;/i)?.[0];
      expect(guard, 'duplicate guard block in the migration').toBeDefined();
      await db.exec('savepoint guard');
      let message = '';
      try {
        await db.exec(guard!);
      } catch (e) {
        message = (e as Error).message;
        await db.exec('rollback to savepoint guard');
      }
      expect(message).toMatch(/supplier_document_duplicates_exist/);
    });
  });
});

describe('6.2.3 / 7.3 links and credit notes', () => {
  it('Accounts links one bill to another Deal\'s task; the target assignee may link while the bill is uploaded; wrong supplier refused', async () => {
    await asOwner(db, async () => {
      const s = await twoDeals();
      const doc = await h.uploadDoc(s.taskA, { number: 'SYN-GRP-1' });
      const linked = await one<{ outcome: string; linkId?: string; id?: string }>(PURCHASE, SQL.docLink, [doc.id, s.taskB, rid()]);
      expect(linked.outcome).toBe('created');
      expect(await one<{ outcome: string }>(ACC, SQL.docLink, [doc.id, s.taskB, rid()])).toMatchObject({ outcome: 'existing' });
      await refusedHint(ACC, SQL.docLink, [doc.id, s.taskOther, rid()], 'link_not_allowed', /taskId/, '55000');
      await refused(ACC, SQL.docLink, [doc.id, s.taskA, rid()], 'link_not_allowed', '55000');
      await refused(MANAGER, SQL.docLink, [doc.id, s.taskB, rid()], 'not_authorized', '42501');
      const [audit] = await h.audits('supplier.document_linked');
      expect(audit!.details).toMatchObject({ documentId: doc.id, taskId: s.taskB, dealId: DEAL2 });
      const rows = await owner<{ id: string; deal_id: string; unlinked_at: string | null }>('select id, deal_id, unlinked_at from public.supplier_document_tasks');
      expect(rows).toEqual([expect.objectContaining({ deal_id: DEAL2, unlinked_at: null })]);
      // Workspace: the bill row says it covers two tasks via the link; the row can be linked by A.
      const row = (await h.allRecords(ACC, { kinds: ['supplier_invoice'] })).find((r) => r.recordId === doc.id)!;
      expect(row.can.linkTask).toBe(true);
      // Accepted bill: only Accounts links (the assignee path ends once reviewed).
      await h.reviewDoc(doc.id, 'accept', null, ACC2);
      // Unlink: Accounts only, with a reason; then it may be linked again.
      await refused(PURCHASE, SQL.docUnlink, [rows[0]!.id, REASON, rid()], 'not_authorized', '42501');
      await refusedHint(ACC, SQL.docUnlink, [rows[0]!.id, 'short', rid()], 'invalid_input', /reason/, '22023');
      await one(ACC, SQL.docUnlink, [rows[0]!.id, REASON, rid()]);
      expect(await h.audits('supplier.document_unlinked')).toHaveLength(1);
      expect(await one<{ outcome: string }>(ACC, SQL.docLink, [doc.id, s.taskB, rid()])).toMatchObject({ outcome: 'created' });
    });
  });

  it('a returned bill cannot be linked; a link satisfies sm_invoice_missing on the other task; a returned bill does not', async () => {
    await asOwner(db, async () => {
      const s = await twoDeals({ past: true });
      await h.receipt(DEAL, '30000000');
      await h.receipt(DEAL2, '30000000');
      for (const t of [s.taskA, s.taskB]) await h.goAhead(t);
      await h.confirmSupplier(s.taskB);
      const missing = async (task: string) => (await owner<{ m: boolean }>('select authz.sm_invoice_missing($1) as m', [task]))[0]!.m;
      expect(await missing(s.taskB)).toBe(true);
      const doc = await h.uploadDoc(s.taskA, { number: 'SYN-MONTHLY-1' });
      await one(ACC, SQL.docLink, [doc.id, s.taskB, rid()]);
      expect(await missing(s.taskB), 'linked bill satisfies the other task').toBe(false);
      await h.reviewDoc(doc.id, 'return', 'Synthetic: the bill covers another month');
      expect(await missing(s.taskB), 'returned bill does not satisfy').toBe(true);
      const second = await h.uploadDoc(s.taskA, { number: 'SYN-MONTHLY-2' });
      await h.reviewDoc(second.id, 'return', 'Synthetic: the bill covers another month');
      await refused(ACC, SQL.docLink, [second.id, s.taskB, rid()], '(link_not_allowed|wrong_state)', '55000');
    });
  });

  it('credit note -> invoice: set once (already_recorded); same supplier only; also at upload; never on an invoice', async () => {
    await asOwner(db, async () => {
      const s = await twoDeals();
      const inv = await h.uploadDoc(s.taskA, { number: 'SYN-INV-50' });
      const otherInv = await h.uploadDoc(s.taskOther, { number: 'SYN-OTHER-50' });
      const cn = await h.uploadDoc(s.taskA, { kind: 'credit_note', number: 'SYN-CN-50', totalPaise: '1000' });
      await refusedHint(ACC, SQL.docCredit, [cn.id, otherInv.id, rid()], 'invalid_input', undefined, '22023');
      await refused(PURCHASE, SQL.docCredit, [cn.id, inv.id, rid()], 'not_authorized', '42501');
      await one(ACC, SQL.docCredit, [cn.id, inv.id, rid()]);
      await refused(ACC, SQL.docCredit, [cn.id, inv.id, rid()], 'already_recorded', '55000');
      expect(await h.audits('supplier.credit_note_linked')).toHaveLength(1);
      await refused(ACC, SQL.docCredit, [inv.id, cn.id, rid()], '(invalid_input|wrong_state)');
      const cn2 = await h.uploadDoc(s.taskA, { kind: 'credit_note', number: 'SYN-CN-51', totalPaise: '1000', creditsDocumentId: inv.id });
      expect((await owner<{ c: string }>('select credits_document_id as c from public.supplier_documents where id = $1', [cn2.id]))[0]!.c).toBe(inv.id);
      await refusedHint(PURCHASE, SQL.docUpload, [s.taskA, JSON.stringify({ kind: 'invoice', number: 'SYN-INV-52', docDate: today(), totalPaise: '1000',
        gstIncluded: true, evidenceId: await h.moneyFile(PURCHASE, s.taskA, 'invoice'), creditsDocumentId: inv.id }), rid()], 'invalid_input', /creditsDocumentId/, '22023');
      // The guard: the link column changes only from null to a value.
      await db.exec('savepoint guard');
      let blocked = false;
      try { await owner('update public.supplier_documents set credits_document_id = null where id = $1', [cn.id]); } catch { blocked = true; await db.exec('rollback to savepoint guard'); }
      expect(blocked).toBe(true);
    });
  });
});
