import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS } from '@/modules/accounts-desk/contracts';
import { csvHeaderLine, narration } from '@/modules/accounts-desk/csv';
import { checkContent, documentTitle, formatNumber, numberKind } from '@/modules/customer-documents/content';
import { DealDocumentsSchema, DocumentRowSchema } from '@/modules/customer-documents/dto';
import { COMPANY_IDENTITY, companyGstinGapFor, companyIdentityFor } from '@/modules/documents/company-identity';
import { NOTICE_KINDS, type NoticeItemDTO, noticePopsUp, noticeText, noticeTone } from '@/modules/notices/contracts';
import { POPUP_ASKED_KEY, POPUP_DEFAULT_ON, decidePopup, nextPoppedSeq, shouldAskPermission } from '@/modules/notices/popup-policy';
import { SOUND_DEFAULT_ON } from '@/modules/notices/sound-policy';
import { DealRefundsSchema } from '@/modules/refunds/dto';
import { checkRefundLimits, maxRefundPaise } from '@/modules/refunds/limits';
import { gstPanStateProblem, isGstin, isPan, isStateCode, maskPan, similarSupplier, supplierNameKey } from '@/modules/suppliers/validate';

/**
 * Accounts Phase 2 test plan 12.2 (unit), Track F. Behaviour from the
 * contract (5.1, 5.7, 6.3-6.5, 7.2, 8.2-8.5, 13.5, Addenda L1/L2); function
 * names are the ones the contract freezes (decidePopup, formatNumber,
 * documentTitle, companyIdentityFor) or the tracks' published module names.
 */

describe('5.1 / 5.7 supplier validators and the name key mirror', () => {
  it('GSTIN, PAN, state code formats and their consistency (field to correct)', () => {
    expect(isGstin('08AAAPZ4321K1Z5')).toBe(true);
    for (const bad of ['08AAAPZ4321K1X5', '8AAAPZ4321K1Z5', '08AAAPZ4321K0Z5', '']) expect(isGstin(bad), bad).toBe(false);
    expect(isPan('AAAPZ4321K')).toBe(true);
    expect(isPan('AAAP4321K')).toBe(false);
    for (const ok of ['01', '08', '27', '38', '97']) expect(isStateCode(ok), ok).toBe(true);
    for (const bad of ['00', '39', '96', '8', 'RJ']) expect(isStateCode(bad), bad).toBe(false);
    expect(gstPanStateProblem({ gstin: '08AAAPZ4321K1Z5', pan: 'AAAPZ4321K', stateCode: '08' })).toBeNull();
    expect(gstPanStateProblem({ gstin: '08AAAPZ4321K1Z5', pan: 'BBBPZ4321K' })).toBe('pan');
    expect(gstPanStateProblem({ gstin: '08AAAPZ4321K1Z5', stateCode: '07' })).toBe('stateCode');
    expect(gstPanStateProblem({ gstin: 'BAD' })).toBe('gstin');
    expect(gstPanStateProblem({})).toBeNull();
    expect(maskPan('AAAPZ4321K')).toBe('XXXXX4321X');
  });

  it('name key: same rule as authz.supplier_name_key (lower, [a-z0-9 ], stop words dropped, spaces removed)', () => {
    expect(supplierNameKey('The Synthetic Palace Hotel Pvt. Ltd.')).toBe('syntheticpalace');
    expect(supplierNameKey('Synthetic Tours & Travels LLP')).toBe('synthetic');
    expect(supplierNameKey('Synthetic Resorts and Hotels Private Limited')).toBe('syntheticresorts');
    expect(supplierNameKey('  SYNTHETIC-123 Stays ')).toBe('synthetic123stays');
  });

  it('similar name (LD24): equal key or prefix of ≥ 5 characters, and same city; never across cities', () => {
    expect(similarSupplier({ name: 'Synthetic Palace Hotel', city: 'Jodhpur' }, { name: 'The Synthetic Palace', city: 'jodhpur ' })).toBe(true);
    expect(similarSupplier({ name: 'Synthetic Palace', city: 'Jodhpur' }, { name: 'Synthetic Palace Grand', city: 'Jodhpur' })).toBe(true);
    expect(similarSupplier({ name: 'Synthetic Palace', city: 'Jodhpur' }, { name: 'Synthetic Palace', city: 'Udaipur' })).toBe(false);
    expect(similarSupplier({ name: 'Abcd', city: 'Jodhpur' }, { name: 'Abcdefgh', city: 'Jodhpur' }), 'shorter key under 5').toBe(false);
    expect(similarSupplier({ name: 'X', city: null }, { name: 'X', city: null }), 'no city: no match').toBe(false);
  });
});

describe('7.2 refund limits mirror', () => {
  const base = { kind: 'cancellation' as const, outcome: 'payout' as const, heldPaise: 2_500_000n, chargePaise: 500_000n, amountPaise: 2_000_000n,
    basisTotalPaise: 9_000_000n, cancellationApproved: true };
  it('cancellation payout / keep credit: 1 ≤ amount ≤ held − charge', () => {
    expect(maxRefundPaise(base)).toBe(2_000_000n);
    expect(checkRefundLimits(base)).toBeNull();
    expect(checkRefundLimits({ ...base, outcome: 'keep_credit' })).toBeNull();
    expect(checkRefundLimits({ ...base, amountPaise: 2_000_001n })).toEqual({ field: 'amountPaise', code: 'refund_exceeds_money' });
    expect(checkRefundLimits({ ...base, amountPaise: 0n })).toEqual({ field: 'amountPaise', code: 'invalid_input' });
    expect(checkRefundLimits({ ...base, cancellationApproved: false })).toMatchObject({ code: 'not_ready' });
  });
  it('charge_only: amount 0 and any charge (even above money held)', () => {
    expect(checkRefundLimits({ ...base, outcome: 'charge_only', amountPaise: 0n, chargePaise: 9_999_999n })).toBeNull();
    expect(checkRefundLimits({ ...base, outcome: 'charge_only', amountPaise: 1n })).toEqual({ field: 'amountPaise', code: 'invalid_input' });
  });
  it('overpayment: charge 0, never charge_only, amount ≤ held − basis total; no basis → nothing', () => {
    const over = { ...base, kind: 'overpayment' as const, chargePaise: 0n, heldPaise: 9_300_000n, amountPaise: 300_000n };
    expect(maxRefundPaise(over)).toBe(300_000n);
    expect(checkRefundLimits(over)).toBeNull();
    expect(checkRefundLimits({ ...over, amountPaise: 300_001n })).toMatchObject({ code: 'refund_exceeds_money' });
    expect(checkRefundLimits({ ...over, chargePaise: 1n })).toEqual({ field: 'customerChargePaise', code: 'invalid_input' });
    expect(checkRefundLimits({ ...over, outcome: 'charge_only', amountPaise: 0n })).toMatchObject({ code: 'invalid_input' });
    expect(maxRefundPaise({ ...over, basisTotalPaise: null })).toBe(0n);
    expect(maxRefundPaise({ ...over, heldPaise: 1n })).toBe(0n);
  });
});

describe('6.3-6.5 customer document content, number, title, identity', () => {
  const content = (over: Record<string, unknown> = {}) => ({
    schema: 'cdoc-1', kind: 'invoice', title: 'Invoice', number: '10101-INV-1', issueDate: '2026-11-11',
    company: { legalName: 'Holiday Chacha Pvt Ltd', registeredAddress: '59A, Babu Rajendra Marg, Jodhpur', pan: 'AAAAA0000A', gstin: '08AAAAA0000A1Z5',
      gstinState: 'Rajasthan' },
    branch: { code: 'DEL', name: 'Delhi' },
    customer: { billingName: 'Synthetic Billing Name', addressLine1: '1 Synthetic Road', addressLine2: null, city: 'Jodhpur', stateCode: '08',
      postalCode: '342001', gstin: null },
    deal: { reference: 'SYN-DEL-001', dealNumber: '10101' },
    trip: { destination: 'Synthetic City, Rajasthan', startDate: '2026-12-10', endDate: '2026-12-13', travellerCount: 2 },
    lines: [{ label: 'Holiday package — Synthetic City, Rajasthan', amountPaise: '9123457' }], totalPaise: '9123457', paidPaise: '2500000',
    balancePaise: '6623457', plan: [{ label: 'Full payment', dueDate: '2026-12-01', amountPaise: '9123457' }], payment: null, credits: null,
    gstInvoiceNumber: 'HC/25-26/0101', replaces: null, ...over,
  });

  it('numbers: <prefix>-ADV|INV|CN-<n>, 1..9999, prefix 1..40; kind read back', () => {
    expect(formatNumber('10101', 'advance_invoice', 1)).toBe('10101-ADV-1');
    expect(formatNumber('SYN-DEL-001', 'invoice', 2)).toBe('SYN-DEL-001-INV-2');
    expect(formatNumber('10101', 'credit_note', 9999)).toBe('10101-CN-9999');
    for (const seq of [0, 10_000, 1.5]) expect(() => formatNumber('10101', 'invoice', seq)).toThrow();
    expect(() => formatNumber('x'.repeat(41), 'invoice', 1)).toThrow();
    expect(numberKind('BX-1001-CN-3')).toBe('credit_note');
    expect(numberKind('10101-XYZ-1')).toBeNull();
  });

  it('titles (Q1): Advance Invoice, Invoice, Credit Note', () => {
    expect([documentTitle('advance_invoice'), documentTitle('invoice'), documentTitle('credit_note')]).toEqual(['Advance Invoice', 'Invoice', 'Credit Note']);
  });

  it('content check: cdoc-1 accepted; extra keys, forbidden key names and unsafe words refused; no "not a tax invoice" line exists', () => {
    expect(checkContent(content())).toMatchObject({ ok: true });
    expect(checkContent(content({ marginPaise: '1' }))).toMatchObject({ ok: false });
    expect(checkContent(content({ lines: [{ label: 'x', amountPaise: '1', supplierCostPaise: '1' }] }))).toMatchObject({ ok: false, code: 'forbidden_field' });
    expect(checkContent(content({ lines: [{ label: 'Best price on the package', amountPaise: '1' }] }))).toMatchObject({ ok: false, code: 'content_safety' });
    expect(checkContent(content({ totalPaise: '12.50' }))).toMatchObject({ ok: false, code: 'input_invalid' });
    expect(checkContent(content({ schema: 'cdoc-2' }))).toMatchObject({ ok: false });
    expect(JSON.stringify(content())).not.toMatch(/tax invoice/i);
  });

  it('company identity (LD1): every known branch prints the company GSTIN; an unknown branch keeps the placeholder', () => {
    for (const code of ['JDH', 'DEL', 'AMD', ' del ']) {
      const line = companyIdentityFor(code);
      expect(line, code).toMatchObject({ gstin: COMPANY_IDENTITY.HOLIDAY_CHACHA.companyGstin, gstinState: 'Rajasthan', placeholders: [] });
      expect(companyGstinGapFor(code)).toBeNull();
    }
    expect(companyIdentityFor('XYZ').placeholders).toEqual(['GSTIN for branch']);
    expect(companyIdentityFor(null).gstin).toBe('[GSTIN for branch]');
  });
});

describe('8.2 CSV mapped columns and narration', () => {
  it('Phase 1 order kept; the seven new columns sit right after "Credit ledger hint"', () => {
    const headers = CSV_COLUMNS.map((c) => c.header);
    const i = headers.indexOf('Credit ledger hint');
    expect(headers.slice(i + 1, i + 8)).toEqual(['Service', 'Tally debit ledger', 'Tally credit ledger', 'Tally voucher type', 'Mapping missing', 'Narration',
      'Tally number']);
    expect(headers).toHaveLength(30);
    expect(headers.at(-1)).toBe('CRM record id');
    expect(csvHeaderLine().endsWith('\r\n')).toBe(true);
  });
  it('narration: "Deal <Deal ID or reference> | <reference> | <record type> <reference>"; references only', () => {
    expect(narration({ deal: 'SYN-DEL-001', bitrixDealId: '10101', recordType: 'Customer invoice', reference: '10101-INV-1' }))
      .toBe('Deal 10101 | SYN-DEL-001 | Customer invoice 10101-INV-1');
    expect(narration({ deal: 'SYN-DEL-001', bitrixDealId: null, recordType: 'Customer refund', reference: 'RF-2026-000001' }))
      .toBe('Deal SYN-DEL-001 | SYN-DEL-001 | Customer refund RF-2026-000001');
  });
});

describe('8.4 / 8.5 / 13.5 pop-ups and sound', () => {
  let n = 0;
  const item = (over: Partial<NoticeItemDTO> = {}): NoticeItemDTO => {
    n += 1;
    return { noticeId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, seq: n, kind: 'trip_cancelled', priority: 'urgent', escalated: false,
      createdAt: '2026-11-11T06:00:00.000Z', readAt: null, doneAt: null, resolvedAt: null, resolvedReason: null, dealId: null, dealReference: 'BX-1001',
      taskId: null, department: null, params: { dealReference: 'BX-1001' }, link: null, ...over } as NoticeItemDTO;
  };
  const input = (over: Partial<Parameters<typeof decidePopup>[0]> = {}) => ({ popupsOn: true, permission: 'granted' as const, supported: true,
    isLeader: true, tabVisibleAndFocused: false, items: [item()], lastPoppedSeq: 0, ...over });

  it('defaults ON (Q12)', () => {
    expect(SOUND_DEFAULT_ON).toBe(true);
    expect(POPUP_DEFAULT_ON).toBe(true);
    expect(POPUP_ASKED_KEY).toBe('tn-notice-popup-asked');
  });
  it('urgent only, leader only, never while the CRM tab is focused (LD26), summary above 3', () => {
    const one = decidePopup(input());
    expect(one).toMatchObject({ show: true });
    if (one.show) expect(one.popups[0]!.tag).toMatch(/^tn-notice-/);
    expect(decidePopup(input({ items: [item({ kind: 'refund_payout_due', priority: 'normal' })] }))).toMatchObject({ show: false });
    expect(decidePopup(input({ isLeader: false }))).toMatchObject({ show: false });
    expect(decidePopup(input({ tabVisibleAndFocused: true }))).toMatchObject({ show: false });
    expect(decidePopup(input({ popupsOn: false }))).toMatchObject({ show: false });
    expect(decidePopup(input({ permission: 'denied' }))).toMatchObject({ show: false });
    expect(decidePopup(input({ supported: false }))).toMatchObject({ show: false });
    const four = decidePopup(input({ items: [item(), item(), item(), item()] }));
    expect(four).toMatchObject({ show: true });
    if (four.show) expect(four.popups).toEqual([expect.objectContaining({ body: '4 urgent notices' })]);
    const three = decidePopup(input({ items: [item(), item(), item()] }));
    if (three.show) expect(three.popups).toHaveLength(3);
    // Older than the cursor: not again.
    const old = item();
    expect(decidePopup(input({ items: [old], lastPoppedSeq: old.seq }))).toMatchObject({ show: false });
    expect(nextPoppedSeq(5, 3, { show: false, reason: 'nothing' })).toBe(5);
  });
  it('pop-up text carries references only (no amounts, names)', () => {
    const d = decidePopup(input({ items: [item({ kind: 'refund_to_approve', params: { dealReference: 'BX-1001', refNo: 'RF-2026-000001' } })] }));
    if (d.show) expect(d.popups[0]!.body.replace(/RF-2026-000001|BX-1001/g, '')).not.toMatch(/₹|INR|\d{4,}/);
  });
  it('permission: asked once per browser on the first input while on; denied never re-asked', () => {
    expect(shouldAskPermission({ popupsOn: true, supported: true, permission: 'default', alreadyAsked: false })).toBe(true);
    expect(shouldAskPermission({ popupsOn: true, supported: true, permission: 'default', alreadyAsked: true })).toBe(false);
    expect(shouldAskPermission({ popupsOn: true, supported: true, permission: 'denied', alreadyAsked: false, force: true })).toBe(false);
    expect(shouldAskPermission({ popupsOn: false, supported: true, permission: 'default', alreadyAsked: false })).toBe(false);
    expect(shouldAskPermission({ popupsOn: true, supported: false, permission: 'default', alreadyAsked: false })).toBe(false);
  });
  it('13.5 tones: urgent for 8, 26, 27 returned, 35, 36, 37; none for 27 approved, 28-33, 38; kind 34 absent (L1)', () => {
    for (const kind of ['trip_cancelled', 'refund_to_approve', 'cancellation_to_approve', 'flight_charges_to_enter', 'visa_cancel_decide']) {
      expect(noticeTone({ kind, priority: 'urgent' } as never), kind).toBe('urgent');
      expect(noticePopsUp({ kind, priority: 'urgent' } as never), kind).toBe(true);
    }
    expect(noticeTone({ kind: 'refund_decided', priority: 'urgent' } as never)).toBe('urgent');
    expect(noticeTone({ kind: 'refund_decided', priority: 'normal' } as never)).toBe('none');
    for (const kind of ['refund_payout_due', 'refund_paid', 'document_to_release', 'document_to_check', 'credit_note_to_release', 'supplier_refund_due',
      'refund_to_request']) {
      expect(noticeTone({ kind, priority: 'normal' } as never), kind).toBe('none');
      expect(noticePopsUp({ kind, priority: 'normal' } as never), kind).toBe(false);
    }
    expect(NOTICE_KINDS).not.toContain('supplier_refund_to_verify' as never);
  });
  it('8.3 templates for 26-38 carry references only', () => {
    const want: Record<string, RegExp> = {
      refund_to_approve: /^Refund RF-2026-000001 on BX-1001 waiting for your approval$/,
      refund_payout_due: /^Refund RF-2026-000001 approved — pay it out$/,
      cancellation_to_approve: /^Trip cancellation on BX-1001 waiting for your approval$/,
      refund_to_request: /^BX-1001 cancellation approved — request the refund$/,
    };
    for (const [kind, re] of Object.entries(want)) {
      expect(noticeText({ kind, params: { dealReference: 'BX-1001', refNo: 'RF-2026-000001' }, dealReference: 'BX-1001', department: null } as never), kind)
        .toMatch(re);
    }
  });
});

describe('DTO fences (12.2): Phase 2 reads list every key; Purchase-side keys absent', () => {
  it('customer document rows and refund reads never carry supplier, cost or margin keys', () => {
    const keysOf = (schema: { shape: Record<string, unknown> }) => Object.keys(schema.shape);
    for (const k of [...keysOf(DocumentRowSchema), ...keysOf(DealDocumentsSchema), ...keysOf(DealRefundsSchema)]) {
      expect(k, k).not.toMatch(/margin|cost|selling/i);
    }
    // Strict: an unknown key is refused (no silent pass-through).
    expect(DocumentRowSchema.safeParse({ marginPaise: '1' }).success).toBe(false);
  });
});
