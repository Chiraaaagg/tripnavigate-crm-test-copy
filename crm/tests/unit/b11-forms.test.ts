import { describe, expect, it } from 'vitest';
import {
  expectedTotalPaise,
  istLocalToIso,
  normaliseIndianMobile,
  parseApplicantDocumentForm,
  parseBookCustomerForm,
  parseBookPlanForm,
  parseBookPriceForm,
  parseBookTripForm,
  parseClassifyRevisionForm,
  parseDepartmentCostForm,
  parseParticipationForm,
  parseSubmitBookingForm,
  parseTravellerIdentityForm,
  parseVisaStateForm,
  planTotalPaise,
} from '@/modules/fulfilment/b11-forms';
import { FIELD } from '@/modules/fulfilment/forms';
import { FINANCE_FIELD, parseClaimLinkForm, parseClaimReportForm, parseClaimWithdrawForm, parseExpenseReviewForm, parseReceiptFromClaimForm } from '@/modules/finance/forms';

/**
 * B1.1 form parsers with the frozen input names (lead decision of 11 October
 * 2026). Each refusal names the inputs to highlight; actor, entity and branch
 * are never read from a form. Synthetic values only.
 */

const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const APP = '55555555-5555-4555-8555-555555555555';
const EVIDENCE = '99999999-9999-4999-8999-999999999999';
const CLAIM = '88888888-8888-4888-8888-888888888888';
const RECEIPT = '12121212-1212-4212-8212-121212121212';
const BRANCH = 'b0000000-0000-4000-8000-000000000001';
const DEST = '13131313-1313-4313-8313-131313131313';
const REQUEST = '77777777-7777-4777-8777-777777777777';
const HASH = 'c'.repeat(64);

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else fd.set(k, v);
  }
  return fd;
}
const draft = { dealId: DEAL, versionId: VERSION, rowVersion: '5' };

describe('parseBookCustomerForm', () => {
  const contact = { ...draft, requestId: REQUEST, contactName: ' Synthetic  Customer ', mobile: '+91 98765 43210', email: '', contactConfirmed: 'on', bookingFor: 'business' };
  it('contact only: normalises the mobile, no billing proposed', () => {
    expect(parseBookCustomerForm(form(contact))).toEqual({
      ok: true,
      value: {
        dealId: DEAL,
        versionId: VERSION,
        expectedRowVersion: 5,
        requestId: REQUEST,
        contact: { contactName: 'Synthetic Customer', mobile: '9876543210', email: null, contactConfirmed: true, bookingFor: 'business', payerDifferent: false, payerName: null },
        billing: null,
        billingExpectedRowVersion: 0,
      },
    });
  });

  it('with billing: city from billingCity, GSTIN must match the state code; payer name when someone else pays', () => {
    const billing = { billingRowVersion: '0', billingName: 'Synthetic Traders', addressLine1: '1 Fort Road', addressLine2: '', billingCity: 'Jodhpur', stateCode: '08', postalCode: '342001', gstin: '08ABCDE1234F1Z5' };
    const ok = parseBookCustomerForm(form({ ...contact, ...billing, payerDifferent: 'on', payerName: 'Synthetic Parent' }));
    expect(ok).toMatchObject({
      ok: true,
      value: {
        billing: { billingName: 'Synthetic Traders', addressLine1: '1 Fort Road', addressLine2: null, city: 'Jodhpur', stateCode: '08', postalCode: '342001', gstin: '08ABCDE1234F1Z5' },
        contact: { payerDifferent: true, payerName: 'Synthetic Parent' },
      },
    });
    expect(parseBookCustomerForm(form({ ...contact, ...billing, gstin: '27ABCDE1234F1Z5' }))).toEqual({ ok: false, fields: [FIELD.gstin] });
    expect(parseBookCustomerForm(form({ ...contact, ...billing, postalCode: '12345', billingCity: '' })).ok).toBe(false);
  });

  it('needs a name, a mobile or email, a booking-for choice and a payer name when ticked', () => {
    const bad = parseBookCustomerForm(form({ ...draft, requestId: REQUEST, contactName: '', mobile: '', email: '', bookingFor: 'family', payerDifferent: 'on' }));
    expect(bad).toEqual({ ok: false, fields: [FIELD.contactName, FIELD.mobile, FIELD.email, FIELD.bookingFor, FIELD.payerName] });
    expect(parseBookCustomerForm(form({ ...contact, mobile: '12345', email: 'not-an-email' }))).toEqual({ ok: false, fields: [FIELD.mobile, FIELD.email] });
  });

  it('normaliseIndianMobile', () => {
    expect(normaliseIndianMobile('098765 43210')).toBe('9876543210');
    expect(normaliseIndianMobile('919876543210')).toBe('9876543210');
    expect(normaliseIndianMobile('')).toBeNull();
    expect(normaliseIndianMobile('5876543210')).toBeUndefined();
  });
});

describe('parseBookTripForm', () => {
  it('trip block plus travellers; age only for children and infants; seq by position', () => {
    const parsed = parseBookTripForm(
      form({
        ...draft,
        destination: 'Bangkok',
        tripScope: 'international',
        tripStart: '2026-12-10',
        tripEnd: '2026-12-15',
        travellerName: ['Asha Synthetic', '', 'Ravi Synthetic'],
        travellerType: ['adult', '', 'child'],
        travellerAge: ['33', '', '9'],
        travellerNeeds: ['', '', 'Vegetarian'],
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        dealId: DEAL,
        versionId: VERSION,
        expectedRowVersion: 5,
        trip: { destination: 'Bangkok', scope: 'international', start: '2026-12-10', end: '2026-12-15' },
        travellers: [
          { fullName: 'Asha Synthetic', type: 'adult', seq: 1, ageYears: null, specialNeeds: null },
          { fullName: 'Ravi Synthetic', type: 'child', seq: 2, ageYears: 9, specialNeeds: 'Vegetarian' },
        ],
      },
    });
  });

  it('end before start, unknown scope and a child age over 17 are named', () => {
    const parsed = parseBookTripForm(
      form({ ...draft, tripScope: 'space', tripStart: '2026-12-10', tripEnd: '2026-12-01', travellerName: ['Ravi'], travellerType: ['child'], travellerAge: ['18'] }),
    );
    expect(parsed).toEqual({ ok: false, fields: [FIELD.tripScope, FIELD.tripEnd, 'travellerAge[0]'] });
  });
});

describe('identity, participation, price, plan, submit, revision', () => {
  it('identity: passport upper-cased, date of birth in the past, empty clears', () => {
    expect(
      parseTravellerIdentityForm(form({ dealId: DEAL, seq: '1', identityRowVersion: '0', dateOfBirth: '1990-01-01', nationality: 'Indian', passportNumber: 'k 1234567', passportExpiry: '' }), '2026-10-11'),
    ).toEqual({
      ok: true,
      value: { dealId: DEAL, seq: 1, expectedRowVersion: 0, fields: { dateOfBirth: '1990-01-01', nationality: 'Indian', passportNumber: 'K1234567', passportExpiry: null } },
    });
    expect(parseTravellerIdentityForm(form({ dealId: DEAL, seq: '0', identityRowVersion: 'x', dateOfBirth: '2026-10-11', passportNumber: 'AB' }), '2026-10-11')).toEqual({
      ok: false,
      fields: [FIELD.seq, FIELD.identityRowVersion, FIELD.dateOfBirth, FIELD.passportNumber],
    });
  });

  it('participation: distinct seqs; empty is allowed (readiness blocks it)', () => {
    expect(parseParticipationForm(form({ ...draft, itemId: ITEM, participantSeq: ['3', '1'] }))).toMatchObject({ ok: true, value: { seqs: [1, 3] } });
    expect(parseParticipationForm(form({ ...draft, itemId: ITEM }))).toMatchObject({ ok: true, value: { seqs: [] } });
    expect(parseParticipationForm(form({ ...draft, itemId: ITEM, participantSeq: ['1', 'x'] }))).toEqual({ ok: false, fields: [FIELD.participantSeq] });
  });

  it('price: list − discount must equal the total; a discount needs a list price', () => {
    expect(parseBookPriceForm(form({ ...draft, listRupees: '2,50,000', discountRupees: '5,000', sellingTotalRupees: '2,45,000' }))).toEqual({
      ok: true,
      value: { dealId: DEAL, versionId: VERSION, expectedRowVersion: 5, listPaise: '25000000', discountPaise: '500000', totalPaise: '24500000' },
    });
    expect(parseBookPriceForm(form({ ...draft, listRupees: '', discountRupees: '', sellingTotalRupees: '1000' }))).toMatchObject({ ok: true, value: { listPaise: null, discountPaise: null } });
    expect(parseBookPriceForm(form({ ...draft, listRupees: '1000', discountRupees: '100', sellingTotalRupees: '950' }))).toEqual({ ok: false, fields: [FIELD.sellingTotalRupees] });
    expect(parseBookPriceForm(form({ ...draft, discountRupees: '100', sellingTotalRupees: '950' }))).toEqual({ ok: false, fields: [FIELD.listRupees] });
    expect(parseBookPriceForm(form({ ...draft, sellingTotalRupees: '0' }))).toEqual({ ok: false, fields: [FIELD.sellingTotalRupees] });
    expect(expectedTotalPaise('100000', '2500')).toBe('97500');
  });

  it('plan: rows by position, blanks skipped, every row complete, at most 12', () => {
    const parsed = parseBookPlanForm(
      form({ ...draft, instalmentLabel: ['Advance', '', 'Balance'], instalmentAmountRupees: ['1,00,000', '', '1,45,000'], instalmentDueDate: ['2026-10-20', '', '2026-12-01'] }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        instalments: [
          { seq: 1, label: 'Advance', amountPaise: '10000000', dueDate: '2026-10-20' },
          { seq: 2, label: 'Balance', amountPaise: '14500000', dueDate: '2026-12-01' },
        ],
      },
    });
    if (parsed.ok) expect(planTotalPaise(parsed.value.instalments)).toBe('24500000');
    expect(parseBookPlanForm(form({ ...draft, instalmentLabel: ['Advance'], instalmentAmountRupees: ['0'], instalmentDueDate: ['soon'] }))).toEqual({
      ok: false,
      fields: ['instalmentAmountRupees[0]', 'instalmentDueDate[0]'],
    });
    const many = Array.from({ length: 13 }, (_, i) => String(i + 1));
    expect(parseBookPlanForm(form({ ...draft, instalmentLabel: many, instalmentAmountRupees: many, instalmentDueDate: many.map(() => '2026-11-01') }))).toEqual({
      ok: false,
      fields: [FIELD.instalmentLabel],
    });
  });

  it('submit and classify', () => {
    expect(parseSubmitBookingForm(form({ dealId: DEAL, versionId: VERSION, contentHash: HASH, requestId: REQUEST }))).toEqual({
      ok: true,
      value: { dealId: DEAL, versionId: VERSION, contentHash: HASH, requestId: REQUEST },
    });
    expect(parseSubmitBookingForm(form({ dealId: DEAL, versionId: VERSION, contentHash: 'abc' }))).toEqual({ ok: false, fields: [FIELD.contentHash] });
    expect(parseClassifyRevisionForm(form({ ...draft, changeClass: 'customer_material' }))).toMatchObject({ ok: true, value: { changeClass: 'customer_material' } });
    expect(parseClassifyRevisionForm(form({ ...draft, changeClass: 'minor' }))).toEqual({ ok: false, fields: [FIELD.changeClass] });
  });
});

describe('department cost and visa desk forms', () => {
  const cost = { taskId: TASK, rowVersion: '0', requestId: REQUEST, costKind: 'government_fee', amountRupees: '2,500', paidBy: 'company', paymentMode: 'upi', paidOn: '2026-10-10', reference: 'VFS-123' };
  it('company-paid cost: mode and date required; not yet: neither', () => {
    expect(parseDepartmentCostForm(form(cost), '2026-10-11')).toEqual({
      ok: true,
      value: {
        taskId: TASK,
        entryId: null,
        expectedRowVersion: 0,
        requestId: REQUEST,
        fields: { costKind: 'government_fee', amountPaise: '250000', paidBy: 'company', paymentMode: 'upi', paidOn: '2026-10-10', reference: 'VFS-123', receiptEvidenceId: null },
      },
    });
    expect(parseDepartmentCostForm(form({ ...cost, paidBy: 'not_yet' }), '2026-10-11')).toEqual({ ok: false, fields: [FIELD.paymentMode, FIELD.paidOn] });
    expect(parseDepartmentCostForm(form({ ...cost, paidBy: 'not_yet', paymentMode: '', paidOn: '' }), '2026-10-11')).toMatchObject({
      ok: true,
      value: { fields: { paidBy: 'not_yet', paymentMode: null, paidOn: null } },
    });
    expect(parseDepartmentCostForm(form({ ...cost, paidOn: '2026-10-12', amountRupees: '0' }), '2026-10-11')).toEqual({ ok: false, fields: [FIELD.amountRupees, FIELD.paidOn] });
  });

  it('document status, submission time in India time, outcome needs the authority document', () => {
    expect(parseApplicantDocumentForm(form({ taskId: TASK, applicationId: APP, rowVersion: '2', documentCode: 'passport_copy', documentStatus: 'checked' }))).toMatchObject({
      ok: true,
      value: { documentCode: 'passport_copy', documentStatus: 'checked', expectedRowVersion: 2 },
    });
    expect(parseApplicantDocumentForm(form({ taskId: TASK, applicationId: APP, rowVersion: '2', documentCode: 'Passport Copy', documentStatus: 'lost' }))).toEqual({
      ok: false,
      fields: [FIELD.documentCode, FIELD.documentStatus],
    });
    expect(istLocalToIso('2026-10-20T10:30')).toBe('2026-10-20T05:00:00.000Z');
    expect(istLocalToIso('2026-10-20 10:30')).toBeUndefined();
    const outcome = { taskId: TASK, applicationId: APP, rowVersion: '4', state: 'issued' };
    expect(parseVisaStateForm(form(outcome), ['issued', 'refused'])).toEqual({ ok: false, fields: [FIELD.evidenceId] });
    expect(parseVisaStateForm(form({ ...outcome, evidenceId: EVIDENCE }), ['issued', 'refused'])).toMatchObject({ ok: true, value: { state: 'issued', evidenceId: EVIDENCE } });
    expect(parseVisaStateForm(form({ ...outcome, state: 'withdrawn' }), ['issued', 'refused'])).toEqual({ ok: false, fields: [FIELD.state] });
  });
});

describe('finance claim and expense forms', () => {
  const F = FINANCE_FIELD;
  it('claim report: bank transfer needs reference and company account; cash takes neither', () => {
    const bank = { dealId: DEAL, requestId: REQUEST, claimMode: 'bank_transfer', claimAmountRupees: '1,00,000', claimPaidOn: '2026-10-10', claimPayerName: 'Synthetic Customer', claimReference: 'UTR123456', claimDestinationVersionId: DEST };
    expect(parseClaimReportForm(form(bank), '2026-10-11')).toEqual({
      ok: true,
      value: {
        dealId: DEAL,
        requestId: REQUEST,
        fields: { mode: 'bank_transfer', amountPaise: '10000000', paidOn: '2026-10-10', payerName: 'Synthetic Customer', reference: 'UTR123456', chequeNumber: null, chequeDate: null, destinationVersionId: DEST, note: null },
      },
    });
    const missing = parseClaimReportForm(form({ ...bank, claimReference: '', claimDestinationVersionId: '' }), '2026-10-11');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(Object.keys(missing.fieldErrors).sort()).toEqual([F.claimDestinationVersionId, F.claimReference].sort());
    const cash = parseClaimReportForm(form({ ...bank, claimMode: 'cash', claimReference: 'UTR123456' }), '2026-10-11');
    expect(cash.ok).toBe(false);
    const future = parseClaimReportForm(form({ ...bank, claimPaidOn: '2026-10-12' }), '2026-10-11');
    expect(future.ok).toBe(false);
  });

  it('withdraw needs a 10–500 character reason and the row version', () => {
    expect(parseClaimWithdrawForm(form({ claimId: CLAIM, rowVersion: '1', requestId: REQUEST, reason: 'Customer paid twice by mistake' }))).toMatchObject({ ok: true, value: { expectedRowVersion: 1 } });
    expect(parseClaimWithdrawForm(form({ claimId: CLAIM, rowVersion: '1', requestId: REQUEST, reason: 'short' })).ok).toBe(false);
  });

  it('receipt from claim never corrects another receipt; mismatch reason optional 10–500', () => {
    const receipt = {
      dealId: DEAL,
      claimId: CLAIM,
      requestId: REQUEST,
      mode: 'cash',
      amountRupees: '50,000',
      receivedOn: '2026-10-10',
      branchId: BRANCH,
      collectorUserId: BRANCH,
      payerName: 'Synthetic Customer',
      payerMobile: '9876543210',
    };
    const ok = parseReceiptFromClaimForm(form(receipt), '2026-10-11');
    expect(ok).toMatchObject({ ok: true, value: { claimId: CLAIM, fields: { mode: 'cash', amountPaise: '5000000', mismatchReason: null } } });
    if (ok.ok) expect(ok.value.fields).not.toHaveProperty('correctsReceiptId');
    expect(parseReceiptFromClaimForm(form({ ...receipt, correctsReceiptId: RECEIPT }), '2026-10-11').ok).toBe(false);
    expect(parseReceiptFromClaimForm(form({ ...receipt, mismatchReason: 'short' }), '2026-10-11').ok).toBe(false);
  });

  it('link and expense review', () => {
    expect(parseClaimLinkForm(form({ claimId: CLAIM, receiptId: RECEIPT, requestId: REQUEST }))).toMatchObject({ ok: true, value: { reason: null } });
    expect(parseClaimLinkForm(form({ claimId: CLAIM, requestId: REQUEST })).ok).toBe(false);
    expect(parseExpenseReviewForm(form({ entryId: CLAIM, rowVersion: '2', requestId: REQUEST }), false)).toEqual({
      ok: true,
      value: { entryId: CLAIM, expectedRowVersion: 2, requestId: REQUEST, reason: null },
    });
    expect(parseExpenseReviewForm(form({ entryId: CLAIM, rowVersion: '2', requestId: REQUEST }), true).ok).toBe(false);
  });
});
