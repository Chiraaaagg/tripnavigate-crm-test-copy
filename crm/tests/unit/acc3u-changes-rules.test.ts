import { describe, expect, it } from 'vitest';
import { blockedWord, fieldWord, KIND_WORD, RECONFIRM_WORD, REFUSAL_TEXT, STATUS_WORD } from '@/views/booking-changes/labels';
import {
  changeModeItemState,
  itemNosText,
  liveRequest,
  outsideRequestItemNos,
  overBudgetHint,
  paiseText,
  reconfirmProgress,
  requestBlockedReason,
  rupeeTextToPaise,
} from '@/views/booking-changes/rules';
import type { ChangeRequestView, DealChangeRequestsView, ReconfirmationLineView } from '@/views/booking-changes/types';

const NO_CAN = { resubmit: false, withdraw: false, openVersion: false, submit: false };
function req(over: Partial<ChangeRequestView>): ChangeRequestView {
  return {
    id: 'r1',
    refNo: 'CR-2026-000001',
    kind: 'change',
    status: 'applied',
    itemNos: [1],
    changeSummary: 'Synthetic change summary.',
    reason: 'Synthetic reason text.',
    requestedByName: 'Synthetic Sales',
    requestedAt: '2026-11-13T05:00:00Z',
    decidedByName: null,
    decidedAt: null,
    returnReason: null,
    changeVersionId: null,
    reconfirmations: [],
    closeReason: null,
    rowVersion: 1,
    can: NO_CAN,
    ...over,
  };
}
function view(over: Partial<DealChangeRequestsView> = {}): DealChangeRequestsView {
  return {
    dealId: 'd1',
    enabled: true,
    canRequest: true,
    blockedBy: [],
    confirmed: [{ itemId: 'i1', itemNo: 1, serviceTitle: 'Hotel', department: 'purchase', taskStatus: 'supplier_confirmed', supplierName: null, reference: null }],
    requests: [],
    ...over,
  };
}

describe('change screens: words', () => {
  it('has a word for every status, kind and reconfirmation state', () => {
    for (const s of ['requested', 'returned', 'approved', 'submitted', 'applied', 'not_possible', 'withdrawn'] as const) expect(STATUS_WORD[s]).toBeTruthy();
    for (const k of ['change', 'add_service', 'remove_service'] as const) expect(KIND_WORD[k]).toBeTruthy();
    for (const r of ['pending', 'recorded', 'refused', 'applied', 'void'] as const) expect(RECONFIRM_WORD[r]).toBeTruthy();
  });
  it('keeps the frozen refusal texts of contract section 13', () => {
    expect(REFUSAL_TEXT.change_open_exists).toBe('This Deal already has a change in progress. Finish or withdraw it first.');
    expect(REFUSAL_TEXT.change_outside_request).toBe('Some changed services are not part of the approved request.');
    expect(REFUSAL_TEXT.charges_missing).toBe('The supplier charges for this service are not entered yet.');
    expect(REFUSAL_TEXT.changes_off).toBe('Changes after confirmation (adding or removing services) are not switched on yet.');
  });
  it('names blocked codes and unknown codes plainly', () => {
    expect(blockedWord('refund_open')).toMatch(/refund request is open/);
    expect(blockedWord('something_new')).toBe('Not possible right now.');
  });
  it('makes field keys readable', () => {
    expect(fieldWord('checkIn')).toBe('Check-in');
    expect(fieldWord('extraBedCount')).toBe('Extra bed count');
    expect(fieldWord('pickup_time')).toBe('Pickup time');
  });
});

describe('requestBlockedReason', () => {
  it('allows a change on a committed Deal with a confirmed service', () => {
    expect(requestBlockedReason(view(), 'change')).toBeNull();
  });
  it('says who may ask when the viewer cannot', () => {
    expect(requestBlockedReason(view({ canRequest: false }), 'change')).toMatch(/Sales owner or the branch Manager/);
  });
  it('separates the change switch from the add / remove switch', () => {
    const v = view({ enabled: false, serviceChangesEnabled: true });
    expect(requestBlockedReason(v, 'change')).toBe(REFUSAL_TEXT.changes_off);
    expect(requestBlockedReason(v, 'add_service')).toBeNull();
    expect(requestBlockedReason(view({ serviceChangesEnabled: false }), 'remove_service')).toBe(REFUSAL_TEXT.service_changes_off);
  });
  it('blocks while a request is live (one at a time)', () => {
    const v = view({ requests: [req({ status: 'submitted', refNo: 'CR-2026-000009' }), req({})] });
    expect(liveRequest(v)?.refNo).toBe('CR-2026-000009');
    expect(requestBlockedReason(v, 'add_service')).toBe('Change CR-2026-000009 is in progress. Finish or withdraw it first.');
  });
  it('uses the database blockedBy codes, but lets add / remove through before commitment', () => {
    expect(requestBlockedReason(view({ blockedBy: ['not_committed'] }), 'change')).toMatch(/not committed/);
    expect(requestBlockedReason(view({ blockedBy: ['not_committed'] }), 'add_service')).toBeNull();
    expect(requestBlockedReason(view({ blockedBy: ['trip_cancelled'] }), 'remove_service')).toMatch(/cancelled/);
  });
  it('needs a confirmed service for a change', () => {
    expect(requestBlockedReason(view({ confirmed: [] }), 'change')).toMatch(/No service has a supplier confirmation/);
  });
});

describe('reconfirmProgress', () => {
  const line = (over: Partial<ReconfirmationLineView>): ReconfirmationLineView => ({ taskId: 't', serviceTitle: 'Hotel A', status: 'pending', overBudget: false, refusedReason: null, ...over });
  it('is null when no supplier needs to reconfirm', () => {
    expect(reconfirmProgress([])).toBeNull();
    expect(reconfirmProgress([line({ status: 'void' })])).toBeNull();
  });
  it('counts agreed suppliers and Manager approvals waiting', () => {
    expect(reconfirmProgress([line({ status: 'recorded', overBudget: true }), line({ taskId: 'u' })])).toBe('1 of 2 suppliers agreed; 1 above budget waiting for the Manager');
    expect(reconfirmProgress([line({ status: 'recorded' })])).toBe('1 of 1 supplier agreed');
  });
  it('says a refusal first', () => {
    expect(reconfirmProgress([line({ status: 'recorded' }), line({ status: 'refused', serviceTitle: 'Hotel B' })])).toMatch(/^Hotel B: the supplier refused/);
  });
});

describe('change mode', () => {
  it('classifies each service', () => {
    expect(changeModeItemState('a', ['a'], ['a'])).toBe('changed');
    expect(changeModeItemState('a', ['a'], [])).toBe('in_request');
    expect(changeModeItemState('b', ['a'], ['b'])).toBe('outside_request');
  });
  it('lists services changed outside the request by number, sorted', () => {
    expect(outsideRequestItemNos(['a'], ['a', 'c', 'b'], { a: 1, b: 2, c: 3 })).toEqual([2, 3]);
    expect(outsideRequestItemNos(['a'], ['a'], { a: 1 })).toEqual([]);
  });
  it('words item numbers', () => {
    expect(itemNosText([])).toBe('No services');
    expect(itemNosText([2])).toBe('Service 2');
    expect(itemNosText([3, 1, 2])).toBe('Services 1, 2 and 3');
  });
});

describe('over-budget hint (display aid; the database decides)', () => {
  it('parses rupee text to whole paise without floats', () => {
    expect(rupeeTextToPaise('12,500.5')).toBe(1250050n);
    expect(rupeeTextToPaise(' 49,000 ')).toBe(4900000n);
    // One money rule (D4): a rupee sign, spaces inside and odd commas give no hint.
    for (const bad of ['₹ 49000', '49 000', '4,9,000', '-5']) expect(rupeeTextToPaise(bad), bad).toBeNull();
    expect(overBudgetHint('₹49000', '0', '5000000')).toBeNull();
    expect(rupeeTextToPaise('1.234')).toBeNull();
    expect(rupeeTextToPaise('abc')).toBeNull();
    expect(rupeeTextToPaise('0.1')).toBe(10n);
  });
  it('compares rate plus fee with the budget', () => {
    expect(overBudgetHint('49000', '2500', '5000000')).toEqual({ over: true, totalPaise: 5150000n });
    expect(overBudgetHint('46000', '', '5000000')).toEqual({ over: false, totalPaise: 4600000n });
    expect(overBudgetHint('50000', '0', '5000000')).toEqual({ over: false, totalPaise: 5000000n });
  });
  it('treats no budget as above budget, and waits for a valid rate', () => {
    expect(overBudgetHint('100', '0', null)?.over).toBe(true);
    expect(overBudgetHint('', '0', '100')).toBeNull();
    expect(overBudgetHint('100', 'x', '100')).toBeNull();
  });
  it('formats paise in Indian grouping', () => {
    expect(paiseText(515000000n)).toBe('₹51,50,000.00');
    expect(paiseText(5n)).toBe('₹0.05');
  });
});
