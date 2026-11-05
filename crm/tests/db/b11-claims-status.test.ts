import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { CLAIMS_SUITE_LOCK, claimHelpers } from './b11-claims-support';
import { ACC, ACC2, DEAL, SALES, today } from './finance-support';

/**
 * B1.1b claim status for display (appendix B section 3.1) and the Sales
 * projection deal_payment_claims (section 3.2): the status follows the linked
 * receipt through its whole life and its correction chain; Sales never
 * receives receipt internals; reported versus confirmed totals.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  if (db.mode === 'postgres') await db.query('select pg_advisory_lock($1::bigint)', [CLAIMS_SUITE_LOCK]);
});
afterAll(async () => {
  await db?.close();
});

const h = claimHelpers(() => db);

async function status(claimId: string): Promise<string> {
  const view = await h.salesView(SALES);
  return view!.claims.find((c) => c.claimId === claimId)!.displayStatus;
}

async function claimWithReceipt(fields: Record<string, unknown>) {
  const claim = await h.report(SALES, fields);
  const res = await h.fromClaim(ACC, claim.id, await h.receiptFieldsFor(fields));
  return { claimId: claim.id, receiptId: res.receiptId! };
}

describe('display status follows the linked receipt', () => {
  it('bank transfer: reported -> recorded -> verified -> reversed', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      await h.addSecondAccounts();
      const fields = await h.bankClaim();
      const claim = await h.report(SALES, fields);
      expect(await status(claim.id)).toBe('reported');
      const res = await h.fromClaim(ACC, claim.id, await h.receiptFieldsFor(fields));
      expect(await status(claim.id)).toBe('recorded');
      await h.proof(ACC, 'receipt', res.receiptId!, 'bank_proof');
      await h.verify(ACC2, res.receiptId!);
      expect(await status(claim.id)).toBe('verified');
      await h.reverse(ACC, res.receiptId!, 'bank_return');
      expect(await status(claim.id)).toBe('reversed');
    });
  });

  it('cheque: recorded -> pending_clearance -> cleared', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      await h.addSecondAccounts();
      const { claimId, receiptId } = await claimWithReceipt(h.chequeClaim());
      expect(await status(claimId)).toBe('recorded');
      await h.proof(ACC, 'receipt', receiptId, 'cheque_image');
      await h.verify(ACC2, receiptId);
      expect(await status(claimId)).toBe('pending_clearance');
      await h.proof(ACC2, 'receipt', receiptId, 'bank_proof');
      await h.clear(ACC2, receiptId, today());
      expect(await status(claimId)).toBe('cleared');
    });
  });

  it('cheque: bounced, re-presented, stopped all read as not paid or pending', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      await h.addSecondAccounts();
      const { claimId, receiptId } = await claimWithReceipt(h.chequeClaim());
      await h.proof(ACC, 'receipt', receiptId, 'cheque_image');
      await h.verify(ACC2, receiptId);
      await h.proof(ACC2, 'receipt', receiptId, 'bank_proof');
      await h.mark(ACC2, receiptId, 'bounced', 'Synthetic bounce note');
      expect(await status(claimId)).toBe('bounced');
      await h.proof(ACC2, 'receipt', receiptId, 'cheque_image');
      await h.represent(ACC2, receiptId);
      expect(await status(claimId)).toBe('pending_clearance');
      await h.proof(ACC2, 'receipt', receiptId, 'bank_proof');
      await h.mark(ACC2, receiptId, 'stopped', 'Synthetic stop note');
      expect(await status(claimId)).toBe('bounced');
    });
  });

  it('rejected as not received reads rejected; a data error follows its correction', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      await h.addSecondAccounts();
      const a = await claimWithReceipt(h.cashClaim());
      await h.reject(ACC2, a.receiptId, 'not_received');
      expect(await status(a.claimId)).toBe('rejected');
      const bFields = h.cashClaim({ amountPaise: '20000' });
      const b = await claimWithReceipt(bFields);
      await h.reject(ACC2, b.receiptId, 'data_error');
      expect(await status(b.claimId)).toBe('rejected');
      const fix = await h.record(ACC, DEAL, await h.receiptFieldsFor(bFields, { correctsReceiptId: b.receiptId }));
      expect(await status(b.claimId)).toBe('recorded');
      await h.verify(ACC2, fix.id);
      expect(await status(b.claimId)).toBe('verified');
    });
  });

  it('withdrawn and not received come from the claim itself', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const w = await h.report(SALES, h.cashClaim());
      await h.withdraw(SALES, w.id);
      const n = await h.report(SALES, h.cashClaim());
      await h.notReceived(ACC, n.id, 'Synthetic: nothing in the cash book');
      expect(await status(w.id)).toBe('withdrawn');
      expect(await status(n.id)).toBe('not_received');
      const view = await h.salesView(SALES);
      const nView = view!.claims.find((c) => c.claimId === n.id)!;
      expect(nView.notReceivedReason).toBe('Synthetic: nothing in the cash book');
      expect(nView.canWithdraw).toBe(false);
      expect(view!.claims.find((c) => c.claimId === w.id)!.notReceivedReason).toBeNull();
    });
  });
});

describe('Sales projection deal_payment_claims', () => {
  const VIEW_KEYS = ['balancePaise', 'canReport', 'claims', 'confirmedPaise', 'dealId', 'destinations', 'reportBlock',
    'reportedPaise', 'sellingTotalPaise'];
  const CLAIM_KEYS = ['amountPaise', 'canWithdraw', 'chequeDate', 'chequeNumber', 'claimId', 'destinationLabel', 'displayStatus',
    'mode', 'note', 'notReceivedReason', 'paidOn', 'payerName', 'receiptAmountPaise', 'reference', 'reportedAt',
    'reportedByName', 'rowVersion', 'status'];
  const DESTINATION_KEYS = ['accountMasked', 'bankName', 'kind', 'label', 'upiMasked', 'versionId'];

  it('carries exactly the allowlisted keys and no receipt internals', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      await h.addSecondAccounts();
      const fields = await h.bankClaim();
      const claim = await h.report(SALES, fields);
      const res = await h.fromClaim(ACC, claim.id, await h.receiptFieldsFor(fields));
      const view = await h.salesView(SALES);
      expect(Object.keys(view!).sort()).toEqual([...VIEW_KEYS].sort());
      expect(Object.keys(view!.claims[0]!).sort()).toEqual([...CLAIM_KEYS].sort());
      expect(view!.destinations.length).toBeGreaterThan(0);
      for (const d of view!.destinations) expect(Object.keys(d).sort()).toEqual([...DESTINATION_KEYS].sort());
      const text = JSON.stringify(view);
      const [receipt] = await h.owner<{ receipt_no: string; payer_pan: string }>(
        'select receipt_no, payer_pan from public.customer_receipts where id = $1', [res.receiptId],
      );
      for (const secret of [receipt!.receipt_no, receipt!.payer_pan, res.receiptId!, '000123456789', 'micr', 'evidence',
        'recordedBy', 'verifiedBy', 'Synthetic Accounts']) {
        expect(text).not.toContain(secret);
      }
      expect(view!.claims[0]).toMatchObject({ destinationLabel: 'Synthetic fixture destination', receiptAmountPaise: '2500000' });
    });
  });

  it('reported versus confirmed: claims never count as confirmed money', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      await h.addSecondAccounts();
      const a = await h.report(SALES, h.cashClaim({ amountPaise: '1000000' }));
      await h.report(SALES, h.cashClaim({ amountPaise: '500000' }));
      const w = await h.report(SALES, h.cashClaim({ amountPaise: '700000' }));
      await h.withdraw(SALES, w.id);
      let view = await h.salesView(SALES);
      expect(view).toMatchObject({ sellingTotalPaise: '9876543', reportedPaise: '1500000', confirmedPaise: '0', balancePaise: '9876543' });
      const res = await h.fromClaim(ACC, a.id, await h.receiptFieldsFor(h.cashClaim({ amountPaise: '1000000' }), {
        receivedOn: today(), payerName: 'Synthetic Cash Payer',
      }));
      view = await h.salesView(SALES);
      expect(view).toMatchObject({ reportedPaise: '1500000', confirmedPaise: '0' });
      await h.verify(ACC2, res.receiptId!);
      view = await h.salesView(SALES);
      expect(view).toMatchObject({ confirmedPaise: '1000000', balancePaise: '8876543' });
      // Money recorded without any claim counts as confirmed too (journal balance).
      await h.verifiedCash(DEAL, { amountPaise: '250000' });
      view = await h.salesView(SALES);
      expect(view).toMatchObject({ reportedPaise: '1500000', confirmedPaise: '1250000' });
    });
  });

  it('report blocks: no booking, switch off, finance not ready; balance unknown without a total', async () => {
    await asOwner(db, async () => {
      await h.setSwitch(true);
      let view = await h.salesView(SALES);
      expect(view).toMatchObject({ canReport: false, reportBlock: 'no_booking', destinations: [], sellingTotalPaise: null, balancePaise: null });
      await h.draftDeal();
      view = await h.salesView(SALES);
      expect(view).toMatchObject({ canReport: true, reportBlock: null, balancePaise: null });
      await h.setSwitch(false);
      expect((await h.salesView(SALES))!.reportBlock).toBe('service_items_disabled');
      await h.setEnvironment('unset');
      expect((await h.salesView(SALES))!.reportBlock).toBe('finance_not_ready');
    });
  });
});
