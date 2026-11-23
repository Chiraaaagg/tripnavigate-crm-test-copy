import { describe, expect, it } from 'vitest';
import type { AccountsDealDetail, AccountsQueueItem, ActionBlock, ReceiptAction, ReceiptView } from '@/modules/finance/contracts';
import { ACCOUNTS_DEAL_PAGE_TABS, parseAccountsDealPageTab } from '@/views/finance-common';
import { receiptMainAction } from '@/views/finance-receipt-forms';
import { accountsDealNext, accountsDealTabOf, orderReceipts, queueRowNext } from '@/views/finance-views';

/*
 * UX redesign R4 (build plan 4.7, New tests): the Accounts view of a Deal.
 * Old `?tab=` values keep working (money → Receipts); an unknown value opens
 * the tab with the next action; the header "Next:" and the To check row
 * button follow the same order. Synthetic shapes only.
 */

const NONE: Record<ReceiptAction, ActionBlock> = {
  verify: 'wrong_state',
  reject: 'wrong_state',
  cheque_clear: 'wrong_state',
  cheque_mark: 'wrong_state',
  cheque_represent: 'wrong_state',
  reverse: 'wrong_state',
  correct: 'wrong_state',
};

function receipt(n: number, extra: Partial<ReceiptView> = {}): ReceiptView {
  return {
    receiptId: `r-${n}`,
    receiptNo: `R-${n}`,
    mode: 'bank_transfer',
    status: 'verified',
    amountPaise: '2500000',
    receivedOn: '2026-11-03',
    branchName: 'Delhi',
    collectorName: null,
    payerName: 'Synthetic Payer',
    payerPanMasked: null,
    payerMobileMasked: null,
    reference: null,
    chequeNumber: null,
    micrCode: null,
    chequeDate: null,
    rejectionKind: null,
    reversalKind: null,
    reason: null,
    correctsReceiptNo: null,
    correctedByReceiptNo: null,
    recordedByName: 'Synthetic Accounts A',
    recordedAt: '2026-11-03T06:30:00Z',
    verifiedByName: null,
    verifiedAt: null,
    outcomeDate: null,
    policyVersionNo: 1,
    evidence: [],
    actions: NONE,
    destination: null,
    ...extra,
  };
}

function deal(extra: { receipts?: ReceiptView[]; billing?: 'draft' | 'verified' | null; review?: 'pending' | 'returned' | 'approved' | null } = {}): AccountsDealDetail {
  const billing = extra.billing === undefined ? 'verified' : extra.billing;
  const review = extra.review === undefined ? 'approved' : extra.review;
  return {
    dealId: 'd-1',
    dealReference: 'SYN-1',
    dealTitle: 'Synthetic deal',
    receipts: extra.receipts ?? [],
    billing: billing ? ({ status: billing } as AccountsDealDetail['billing']) : null,
    booking: review ? ({ reviewStatus: review } as AccountsDealDetail['booking']) : null,
  } as AccountsDealDetail;
}

const waitingForMe = receipt(1, { status: 'recorded', actions: { ...NONE, verify: null, reject: null } });
const waitingOwn = receipt(2, { status: 'recorded', actions: { ...NONE, verify: 'own_record', reject: 'own_record' } });

describe('Accounts deal tab mapping (R4)', () => {
  it('lists the five tabs in screen order', () => {
    expect(ACCOUNTS_DEAL_PAGE_TABS).toEqual(['receipts', 'dues', 'documents', 'refunds', 'review']);
  });

  it('keeps every tab address; the old money tab opens Receipts and is rewritten in the address', () => {
    for (const tab of ACCOUNTS_DEAL_PAGE_TABS) expect(parseAccountsDealPageTab(tab, 'review')).toEqual({ tab, fromAddress: true });
    expect(parseAccountsDealPageTab('money', 'review')).toEqual({ tab: 'receipts', fromAddress: false });
    expect(parseAccountsDealPageTab(['money', 'review'], 'review')).toEqual({ tab: 'receipts', fromAddress: false });
    expect(parseAccountsDealPageTab(['documents'], 'review')).toEqual({ tab: 'documents', fromAddress: true });
  });

  it('an unknown, missing or prototype-named value gives the fallback', () => {
    for (const raw of [undefined, '', 'history', 'Receipts', ' receipts', 'constructor', 'toString', '__proto__', 7, null]) {
      expect(parseAccountsDealPageTab(raw, 'review'), String(raw)).toEqual({ tab: 'review', fromAddress: false });
    }
  });

  it('an unknown tab opens the tab with the next action', () => {
    expect(accountsDealTabOf(deal({ receipts: [waitingForMe], billing: 'draft', review: 'pending' }), 'history').tab).toBe('receipts');
    expect(accountsDealTabOf(deal({ billing: 'draft' }), 'history').tab).toBe('review');
    expect(accountsDealTabOf(deal({ review: 'pending' }), undefined).tab).toBe('review');
    expect(accountsDealTabOf(deal(), 'nope').tab).toBe('receipts');
    expect(accountsDealTabOf(deal({ billing: 'draft' }), 'money')).toEqual({ tab: 'receipts', fromAddress: false });
    expect(accountsDealTabOf(deal({ billing: 'draft' }), 'refunds')).toEqual({ tab: 'refunds', fromAddress: true });
  });
});

describe('Accounts deal header "Next:" (R4)', () => {
  const hrefOf = (t: string) => `/x?tab=${t}`;

  it('a receipt this person may verify: jump to its row on Receipts, a link from other tabs', () => {
    const d = deal({ receipts: [waitingOwn, waitingForMe] });
    const onReceipts = accountsDealNext(d, 'receipts', hrefOf)!;
    expect(onReceipts.text).toBe('verify receipt R-1 (₹25,000.00, Bank transfer)');
    expect(onReceipts.button).toEqual({ label: 'Verify receipt', jumpTo: 'verify-r-1' });
    expect(accountsDealNext(d, 'review', hrefOf)!.button).toEqual({ label: 'Verify receipt', href: '/x?tab=receipts' });
  });

  it('only the recorder: no button, says another Accounts person verifies', () => {
    const next = accountsDealNext(deal({ receipts: [waitingOwn] }), 'receipts', hrefOf)!;
    expect(next.text).toBe('another Accounts person verifies the receipt waiting on this deal.');
    expect(next.button).toBeUndefined();
  });

  it('billing, then review, then returned, then nothing waiting', () => {
    expect(accountsDealNext(deal({ billing: null }), 'receipts', hrefOf)!.button).toEqual({ label: 'Check billing details', href: '/x?tab=review' });
    expect(accountsDealNext(deal({ billing: 'draft' }), 'review', hrefOf)!.button).toEqual({ label: 'Check billing details', jumpTo: 'fin-billing-section' });
    expect(accountsDealNext(deal({ review: 'pending' }), 'review', hrefOf)!.button).toEqual({ label: 'Review the booking', jumpTo: 'fin-booking-section' });
    expect(accountsDealNext(deal({ review: 'returned' }), 'receipts', hrefOf)!.button).toBeUndefined();
    const nothing = accountsDealNext(deal(), 'receipts', hrefOf)!;
    expect(nothing.text).toBe('nothing waiting. Record a receipt when the customer pays.');
    expect(nothing.button).toBeUndefined();
  });
});

describe('Receipt rows (R4)', () => {
  it('awaiting receipts first, otherwise the database order', () => {
    const list = [receipt(1), receipt(2, { status: 'recorded' }), receipt(3, { status: 'rejected' }), receipt(4, { status: 'pending_clearance', mode: 'cheque' })];
    expect(orderReceipts(list).map((r) => r.receiptNo)).toEqual(['R-2', 'R-4', 'R-1', 'R-3']);
  });

  it('the row action is Verify while a receipt waits (also when blocked, to show why), else Re-present for a bounced cheque', () => {
    expect(receiptMainAction(waitingForMe)).toBe('verify');
    expect(receiptMainAction(waitingOwn)).toBe('verify');
    expect(receiptMainAction(receipt(5, { status: 'bounced', mode: 'cheque', actions: { ...NONE, cheque_represent: null } }))).toBe('cheque_represent');
    expect(receiptMainAction(receipt(6, { status: 'bounced', mode: 'cheque', actions: { ...NONE, cheque_represent: 'mode_not_live' } }))).toBeNull();
    expect(receiptMainAction(receipt(7))).toBeNull();
  });
});

describe('To check row button (R4)', () => {
  const item = (extra: Partial<AccountsQueueItem>): AccountsQueueItem => ({
    dealId: 'd-1',
    dealReference: 'SYN-1',
    dealTitle: 'Synthetic deal',
    branchName: 'Delhi',
    hasConfirmedBooking: true,
    billingStatus: 'verified',
    reviewStatus: 'approved',
    money: { availablePaise: '0', awaitingVerificationPaise: '0', chequesAwaitingClearancePaise: '0' },
    updatedAt: '2026-11-03T09:00:00Z',
    ...extra,
  });

  it('opens the tab of the next step, in the deal page order', () => {
    expect(queueRowNext(item({ money: { availablePaise: '0', awaitingVerificationPaise: '100', chequesAwaitingClearancePaise: '0' }, billingStatus: 'draft' })).button).toEqual({ label: 'Verify', tab: 'receipts' });
    expect(queueRowNext(item({ billingStatus: 'draft' })).button).toEqual({ label: 'Review', tab: 'review' });
    expect(queueRowNext(item({ reviewStatus: 'pending' })).button).toEqual({ label: 'Review', tab: 'review' });
    expect(queueRowNext(item({ reviewStatus: 'returned' })).button).toBeNull();
    expect(queueRowNext(item({ money: { availablePaise: '0', awaitingVerificationPaise: '0', chequesAwaitingClearancePaise: '500' } })).button).toEqual({ label: 'Open', tab: 'receipts' });
    expect(queueRowNext(item({})).button).toBeNull();
    // No booking yet: nothing to review, so no Review button.
    expect(queueRowNext(item({ hasConfirmedBooking: false, billingStatus: null, reviewStatus: null })).button).toBeNull();
  });
});
