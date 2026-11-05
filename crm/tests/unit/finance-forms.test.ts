import { describe, expect, it } from 'vitest';
import {
  FINANCE_FIELD as F,
  formatPaise,
  normaliseMobile,
  paiseToRupees,
  parseBillingForm,
  parseChequeNote,
  parseDepositForm,
  parseIstDateTime,
  parsePolicyForm,
  parseReceiptForm,
  parseReconciliationForm,
  rupeesToPaise,
} from '@/modules/finance/forms';

/** Phase 5A form parsing (contract sections 3, 7, 9.1, 12, 6). Pure; no database. */

const UUID = '11111111-2222-4333-8444-555555555555';
const UUID2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const TODAY = '2026-10-06';

function form(entries: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
}

describe('rupees to paise (exact BigInt)', () => {
  it.each([
    ['1', '100'],
    ['0.5', '50'],
    ['0.05', '5'],
    ['1,23,456.78', '12345678'],
    ['₹ 49,999', '4999900'],
    ['10000000', '1000000000'],
    ['9999999999999999.99', '999999999999999999'],
  ])('%s -> %s', (input, expected) => {
    expect(rupeesToPaise(input)).toBe(expected);
  });
  it.each(['1.234', '-1', '1e3', 'abc', '1.', '.5', '12345678901234567'])('rejects %s', (input) => {
    expect(rupeesToPaise(input)).toBeUndefined();
  });
  it('treats empty as null and round-trips', () => {
    expect(rupeesToPaise('  ')).toBeNull();
    expect(paiseToRupees('12345678')).toBe('123456.78');
    expect(paiseToRupees('-5')).toBe('-0.05');
    expect(formatPaise('12345678')).toBe('₹1,23,456.78');
    expect(formatPaise('100000000000')).toBe('₹1,00,00,00,000.00');
    expect(formatPaise('5')).toBe('₹0.05');
  });
});

describe('mobile normalisation', () => {
  it.each([
    ['+91 98765 43210', '9876543210'],
    ['09876543210', '9876543210'],
    ['9876543210', '9876543210'],
  ])('%s', (input, expected) => expect(normaliseMobile(input)).toBe(expected));
  it('rejects non-Indian mobiles and treats empty as null', () => {
    expect(normaliseMobile('5876543210')).toBeUndefined();
    expect(normaliseMobile('98765')).toBeUndefined();
    expect(normaliseMobile('')).toBeNull();
  });
});

const BANK = {
  [F.dealId]: UUID,
  [F.requestId]: UUID2,
  [F.mode]: 'bank_transfer',
  [F.destinationVersionId]: UUID,
  [F.amountRupees]: '25,000',
  [F.receivedOn]: TODAY,
  [F.branchId]: UUID,
  [F.payerName]: 'Synthetic Payer',
  [F.payerPan]: 'abcde1234f',
  [F.reference]: 'UTR-123456',
};

describe('receipt form', () => {
  it('parses a bank transfer and upper-cases the PAN', () => {
    const parsed = parseReceiptForm(form(BANK), TODAY);
    expect(parsed).toEqual({
      ok: true,
      value: {
        dealId: UUID,
        requestId: UUID2,
        fields: {
          mode: 'bank_transfer', amountPaise: '2500000', receivedOn: TODAY, branchId: UUID, collectorUserId: null,
          payerName: 'Synthetic Payer', payerPan: 'ABCDE1234F', payerMobile: null, reference: 'UTR-123456',
          micrCode: null, chequeNumber: null, chequeDate: null, accountPayee: null, bookingVersionId: null,
          correctsReceiptId: null, note: null, destinationVersionId: UUID,
        },
      },
    });
  });

  it('requires an approved company account for bank transfer and UPI, never for cash or cheque', () => {
    const missing = parseReceiptForm(form({ ...BANK, [F.destinationVersionId]: '' }), TODAY);
    expect(!missing.ok && missing.fieldErrors[F.destinationVersionId]).toMatch(/approved company account/);
    const cash = parseReceiptForm(form({ ...BANK, [F.mode]: 'cash', [F.collectorUserId]: UUID }), TODAY);
    expect(cash.ok && cash.value.fields.destinationVersionId).toBeNull();
  });

  it('reports field errors mirroring the SQL rules', () => {
    const parsed = parseReceiptForm(
      form({ ...BANK, [F.amountRupees]: '0', [F.receivedOn]: '2026-08-01', [F.payerPan]: '', [F.reference]: 'ab' }),
      TODAY,
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(Object.keys(parsed.fieldErrors).sort()).toEqual([F.amountRupees, F.payerPan, F.receivedOn, F.reference].sort());
    }
  });

  it('requires a collector for cash and account payee for cheques; drops fields of other modes', () => {
    const cash = parseReceiptForm(form({ ...BANK, [F.mode]: 'cash' }), TODAY);
    expect(cash.ok).toBe(false);
    const cashOk = parseReceiptForm(form({ ...BANK, [F.mode]: 'cash', [F.collectorUserId]: UUID }), TODAY);
    expect(cashOk.ok && cashOk.value.fields.reference).toBeNull();
    const cheque = { ...BANK, [F.mode]: 'cheque', [F.micrCode]: '110002003', [F.chequeNumber]: '123456', [F.chequeDate]: TODAY };
    const noPayee = parseReceiptForm(form(cheque), TODAY);
    expect(!noPayee.ok && noPayee.fieldErrors[F.accountPayee]).toBeTruthy();
    const ok = parseReceiptForm(form({ ...cheque, [F.accountPayee]: 'true' }), TODAY);
    expect(ok.ok && ok.value.fields).toMatchObject({ accountPayee: true, reference: null, micrCode: '110002003' });
  });

  it('flags a stale form (missing ids) without field errors', () => {
    const parsed = parseReceiptForm(form({ ...BANK, [F.requestId]: 'nope' }), TODAY);
    expect(!parsed.ok && parsed.fieldErrors._form).toBeTruthy();
  });
});

describe('billing, deposit, reconciliation and cheque note forms', () => {
  const billing = {
    [F.billingName]: 'Synthetic Co',
    [F.addressLine1]: '1 Road',
    [F.city]: 'Jodhpur',
    [F.stateCode]: '08',
    [F.postalCode]: '342 001',
    [F.gstin]: '08abcde1234f1z5',
  };
  it('checks GSTIN against the state code', () => {
    expect(parseBillingForm(form(billing))).toMatchObject({ ok: true, value: { gstin: '08ABCDE1234F1Z5', postalCode: '342001', addressLine2: null } });
    const bad = parseBillingForm(form({ ...billing, [F.stateCode]: '27' }));
    expect(!bad.ok && bad.fieldErrors[F.gstin]).toMatch(/state code/);
  });

  it('deposit needs at least one receipt and sorts unique ids', () => {
    const fd = form({ [F.branchId]: UUID, [F.requestId]: UUID2, [F.receiptIds]: [UUID2, UUID, UUID2], [F.depositedOn]: TODAY, [F.bankReference]: 'SLIP 01' });
    expect(parseDepositForm(fd, TODAY)).toMatchObject({ ok: true, value: { receiptIds: [UUID, UUID2] } });
    const none = parseDepositForm(form({ [F.branchId]: UUID, [F.requestId]: UUID2, [F.depositedOn]: TODAY, [F.bankReference]: 'SLIP' }), TODAY);
    expect(!none.ok && none.fieldErrors[F.receiptIds]).toBeTruthy();
  });

  it('reconciliation accepts zero counted cash', () => {
    const parsed = parseReconciliationForm(form({ [F.branchId]: UUID, [F.requestId]: UUID2, [F.businessDate]: TODAY, [F.countedRupees]: '0' }), TODAY);
    expect(parsed).toMatchObject({ ok: true, value: { countedPaise: '0', note: null } });
  });

  it('allows an old date through to the database eligibility check', () => {
    const parsed = parseReconciliationForm(form({ [F.branchId]: UUID, [F.requestId]: UUID2, [F.businessDate]: '2026-01-01', [F.countedRupees]: '0' }), TODAY);
    expect(parsed).toMatchObject({ ok: true, value: { businessDate: '2026-01-01', requestId: UUID2 } });
  });

  it.each(['2026-10-07', '2026-02-30', '2026-13-01', '2026-1-1', ''])('refuses invalid or future cash dates: %s', (businessDate) => {
    const parsed = parseReconciliationForm(form({ [F.branchId]: UUID, [F.requestId]: UUID2, [F.businessDate]: businessDate, [F.countedRupees]: '0' }), TODAY);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.fieldErrors[F.businessDate]).toBeTruthy();
  });

  it('a cancelled cheque needs a note', () => {
    expect(parseChequeNote(form({}), 'cancelled').ok).toBe(false);
    expect(parseChequeNote(form({}), 'bounced')).toEqual({ ok: true, value: null });
  });
});

describe('policy form', () => {
  const now = new Date('2026-10-06T06:30:00Z'); // 12:00 IST
  it('reads IST wall-clock times; now (within 15 minutes) means immediate', () => {
    expect(parseIstDateTime('2026-10-06T11:50', now)).toBeNull();
    expect(parseIstDateTime('2026-10-06T10:00', now)).toBeUndefined();
    expect(parseIstDateTime('2026-10-07T09:00', now)).toBe('2026-10-07T03:30:00.000Z');
    expect(parseIstDateTime('2026-10-07T25:00', now)).toBeUndefined();
  });

  it('builds the fields; the checkbox absent means not required', () => {
    const parsed = parsePolicyForm(
      form({
        [F.entityId]: UUID, [F.requestId]: UUID2, [F.receiptMaxRupees]: '1,00,00,000', [F.cashPayerDayCapRupees]: '49999',
        [F.cashTripCapRupees]: '0', [F.cashDepositDays]: '2', [F.effectiveAt]: '', [F.reason]: 'Synthetic policy reason',
      }),
      now,
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        entityId: UUID, requestId: UUID2, effectiveAt: null, reason: 'Synthetic policy reason',
        fields: { receiptMaxPaise: '1000000000', cashPayerDayCapPaise: '4999900', cashTripCapPaise: '0', cashDepositDays: 2, reconciliationRequired: false },
      },
    });
    const bad = parsePolicyForm(form({ [F.entityId]: UUID, [F.requestId]: UUID2, [F.cashDepositDays]: '9', [F.reason]: 'short' }), now);
    expect(!bad.ok && Object.keys(bad.fieldErrors).sort()).toEqual([F.cashDepositDays, F.reason].sort());
  });
});
