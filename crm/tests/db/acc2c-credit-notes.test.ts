import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { HOTEL_ITEM, SELLING } from './acc-support';
import { ACC, CSQL, DEAL, MANAGER, OWNER, REASON, SUPER, acc2cHelpers, rid } from './acc2c-support';

/**
 * Accounts phase 2 contract 7.6 (LD3, LD6), Track C: credit-note sources
 * (authz.cdoc_credit_note_source, replacing Track B's stub) end to end with
 * Track B's document commands.
 *  1. Approved cancellation settlement + released Invoice: invoice total -
 *     charge - released credit notes on it (also charge_only / keep_credit).
 *  2. No released Invoice, payout paid, released Advance Invoices: the refund amount.
 *  3. Overpayment refund with an Invoice: none.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const c = acc2cHelpers(() => db);
const { one, owner } = c;

const DOC = {
  draft: 'select public.customer_document_draft_create($1, $2, $3::jsonb, $4) as r',
  release: 'select public.customer_document_release($1, $2, $3, $4) as r',
  setOn: 'select public.admin_set_customer_documents_enabled($1, $2, $3) as r',
};
type Done = { documentId: string; rowVersion: number; contentSha256: string; number: string | null; status: string };
const source = async (id: string) =>
  (await owner<{ s: Record<string, unknown> | null }>('select authz.cdoc_credit_note_source($1) as s', [id]))[0]!.s;
const draft = (kind: string, src: Record<string, unknown> = {}) => one<Done>(ACC, DOC.draft, [DEAL, kind, JSON.stringify(src), rid()]);
const release = (d: Done) => one<Done>(ACC, DOC.release, [d.documentId, d.rowVersion, d.contentSha256, rid()]);

async function base(paid = '5000000') {
  await c.people();
  const b = await c.book([HOTEL_ITEM]);
  await c.approveReal(b.versionId);
  const receipt = await c.receipt(DEAL, paid);
  await one(SUPER, DOC.setOn, [await c.entityId(), true, REASON]);
  await c.refundsOn();
  return receipt;
}

describe('7.6 credit-note sources', () => {
  it('case 1: settlement with a released Invoice -> invoice total - charge; released CN closes the source', async () => {
    await asOwner(db, async () => {
      await base();
      const inv = await release(await draft('invoice'));
      await c.cancelApproved();
      const r = await c.request({ kind: 'cancellation', outcome: 'charge_only', customerChargePaise: '1000000', amountPaise: '0' });
      expect(await source(r.refundRequestId)).toBeNull(); // not approved yet
      await c.decide(r.refundRequestId, 'approve');
      const s = await source(r.refundRequestId);
      expect(s).toEqual({ amountPaise: String(BigInt(SELLING) - 1000000n), creditsDocumentId: inv.documentId,
        reasonWords: 'trip cancellation', creditedAdvanceNumbers: [] });
      const cnDraft = await draft('credit_note', { refundRequestId: r.refundRequestId });
      // Fence 10: a credit-note DRAFT is shown to Accounts only, never to the Sales owner or the Manager.
      type View = { requests: Array<{ creditNote: { status: string } | null }> };
      expect((await one<View>(ACC, CSQL.dealRefunds, [DEAL])).requests[0]!.creditNote).toMatchObject({ status: 'draft' });
      expect((await one<View>(OWNER, CSQL.dealRefunds, [DEAL])).requests[0]!.creditNote).toBeNull();
      expect((await one<View>(MANAGER, CSQL.dealRefunds, [DEAL])).requests[0]!.creditNote).toBeNull();
      const cn = await release(cnDraft);
      expect(cn.number).toMatch(/-CN-1$/);
      expect(await source(r.refundRequestId)).toBeNull();
      // R-C1 shows the credit note on the request.
      const view = await one<{ requests: Array<{ creditNote: { number: string } | null }> }>(OWNER, CSQL.dealRefunds, [DEAL]);
      expect(view.requests[0]!.creditNote).toMatchObject({ number: cn.number });
    });
  });

  it('case 2: no Invoice, payout paid, released Advance Invoices -> the refund amount crediting the advances', async () => {
    await asOwner(db, async () => {
      const receipt = await base('5000000');
      const adv = await release(await draft('advance_invoice', { receiptId: receipt.id }));
      await c.cancelApproved();
      const r = await c.request({ kind: 'cancellation', outcome: 'payout', customerChargePaise: '1000000', amountPaise: '4000000',
        payeeKind: 'original_payer', payeeReceiptId: receipt.id });
      await c.decide(r.refundRequestId, 'approve');
      expect(await source(r.refundRequestId)).toBeNull(); // case 2 waits for the payout
      await c.payout(r.refundRequestId);
      expect(await source(r.refundRequestId)).toEqual({ amountPaise: '4000000', creditsDocumentId: null,
        reasonWords: 'trip cancellation refund', creditedAdvanceNumbers: [adv.number] });
    });
  });

  it('case 3: overpayment refund with a released Invoice -> no credit note', async () => {
    await asOwner(db, async () => {
      const receipt = await base(String(BigInt(SELLING) + 300000n));
      await release(await draft('invoice'));
      const r = await c.request({ kind: 'overpayment', outcome: 'payout', amountPaise: '300000', payeeKind: 'original_payer',
        payeeReceiptId: receipt.id });
      await c.decide(r.refundRequestId, 'approve');
      await c.payout(r.refundRequestId);
      expect(await source(r.refundRequestId)).toBeNull();
    });
  });
});
