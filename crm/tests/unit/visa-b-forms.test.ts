import { describe, expect, it } from 'vitest';
import { VISA_DOCUMENT_CATALOGUE, VISA_FIELD, visaApplicantField } from '@/modules/visa/contracts';
import {
  catalogueCodeForLabel,
  catalogueNotListed,
  copyDownFees,
  defaultAppliedOn,
  normalizePassportNumber,
  notReadyTokenFromHint,
  paiseToRupeesText,
  parseApplyForm,
  parseDecideForm,
  parseDocumentAddForm,
  parseFeeSendForm,
  parseHandoverForm,
  parseOtherCostForm,
  parsePassportNumber,
  parseRowForm,
  parseVisaDate,
  parseVisaTime,
  parseWithdrawForm,
  rupeesToPaise,
  todayIst,
  visaFieldsFromHint,
  visaLabelKey,
} from '@/modules/visa/forms';

/** Visa build, track B: pure helpers and form parsers of src/modules/visa/forms.ts. Synthetic values only. */

const TASK = '22222222-2222-4222-8222-222222222222';
const APP = '55555555-5555-4555-8555-555555555555';
const APP2 = '55555555-5555-4555-8555-555555555556';
const DOC1 = '33333333-3333-4333-8333-333333333331';
const DOC2 = '33333333-3333-4333-8333-333333333332';
const REQ = '77777777-7777-4777-8777-777777777777';
const EV = '66666666-6666-4666-8666-666666666666';

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else fd.set(k, v);
  }
  return fd;
}
const target = { taskId: TASK, applicationId: APP, expectedRowVersion: '3', requestId: REQ };

describe('rupees and paise', () => {
  it.each([
    ['6500', '650000'],
    ['₹6,500', '650000'],
    [' 6 500.5 ', '650050'],
    ['6500.05', '650005'],
    ['0.01', '1'],
    ['1,00,000', '10000000'],
    ['007', '700'],
  ])('%s -> %s paise', (input, paise) => expect(rupeesToPaise(input)).toBe(paise));

  it.each(['', '0', '0.00', '-5', '6.505', 'abc', '1e3', '12.', '1234567890123456'])('refuses %j', (input) => {
    expect(rupeesToPaise(input)).toBeNull();
  });

  it('formats paise back to Indian grouped rupees', () => {
    expect(paiseToRupeesText('650000')).toBe('6,500');
    expect(paiseToRupeesText('650050')).toBe('6,500.50');
    expect(paiseToRupeesText('10000000')).toBe('1,00,000');
    expect(paiseToRupeesText('5')).toBe('0.05');
  });
});

describe('passport number, time, date, label key', () => {
  it('normalises passport numbers like the database', () => {
    expect(normalizePassportNumber(' z 12-34 567 ')).toBe('Z1234567');
    expect(parsePassportNumber('z1234567')).toBe('Z1234567');
    expect(parsePassportNumber('Z12')).toBeNull();
    expect(parsePassportNumber('Z12345678901234567')).toBeNull();
    expect(parsePassportNumber('Z123/4567')).toBeNull();
  });

  it.each([
    ['9:30', '09:30'],
    ['0930', '09:30'],
    ['21:05', '21:05'],
    ['7:05 pm', '19:05'],
    ['12:00 am', '00:00'],
    ['12:15 PM', '12:15'],
  ])('time %s -> %s', (input, out) => expect(parseVisaTime(input)).toBe(out));

  it.each(['24:00', '9:60', '13:00 pm', 'noon', ''])('refuses time %j', (input) => expect(parseVisaTime(input)).toBeNull());

  it('accepts real calendar dates in range only', () => {
    expect(parseVisaDate('2026-11-08')).toBe('2026-11-08');
    expect(parseVisaDate('2026-02-30')).toBeNull();
    expect(parseVisaDate('1999-12-31')).toBeNull();
    expect(parseVisaDate('8 Nov 26')).toBeNull();
  });

  it('IST today and the applied date default', () => {
    expect(todayIst(new Date('2026-11-07T19:00:00Z'))).toBe('2026-11-08');
    expect(todayIst(new Date('2026-11-07T18:00:00Z'))).toBe('2026-11-07');
    expect(defaultAppliedOn('2026-11-05', '2026-11-08')).toBe('2026-11-05');
    expect(defaultAppliedOn('2026-11-10', '2026-11-08')).toBe('2026-11-08');
    expect(defaultAppliedOn(null, '2026-11-08')).toBe('2026-11-08');
  });

  it('label key mirrors lower(regexp_replace(btrim(label), \\s+, " "))', () => {
    expect(visaLabelKey('  Passport   copy (front and BACK) ')).toBe('passport copy (front and back)');
    expect(visaLabelKey('Bank\tstatement')).toBe('bank statement');
    expect(catalogueCodeForLabel('pan  CARD')).toBe('pan_card');
    expect(catalogueCodeForLabel('Synthetic own letter')).toBeNull();
    expect(catalogueNotListed(['Photo, white background', 'pan card']).map((d) => d.code)).not.toContain('pan_card');
    expect(catalogueNotListed([])).toHaveLength(VISA_DOCUMENT_CATALOGUE.length);
  });

  it('the catalogue is the frozen 25 items with unique codes and label keys', () => {
    expect(VISA_DOCUMENT_CATALOGUE).toHaveLength(25);
    expect(new Set(VISA_DOCUMENT_CATALOGUE.map((d) => d.code)).size).toBe(25);
    expect(new Set(VISA_DOCUMENT_CATALOGUE.map((d) => visaLabelKey(d.label))).size).toBe(25);
    expect(VISA_DOCUMENT_CATALOGUE[0]).toEqual({ code: 'passport_copy', label: 'Passport copy (front and back)' });
    expect(VISA_DOCUMENT_CATALOGUE[24]).toEqual({ code: 'school_or_college_id', label: 'School or college ID' });
  });
});

describe('copyDownFees', () => {
  it('fills only empty boxes from the first line, never overwrites, never splits', () => {
    const out = copyDownFees([
      { id: 'a', governmentFee: '6500', serviceFee: '500' },
      { id: 'b', governmentFee: '', serviceFee: '' },
      { id: 'c', governmentFee: '7000', serviceFee: ' ' },
    ]);
    expect(out).toEqual([
      { id: 'a', governmentFee: '6500', serviceFee: '500' },
      { id: 'b', governmentFee: '6500', serviceFee: '500' },
      { id: 'c', governmentFee: '7000', serviceFee: '500' },
    ]);
    expect(copyDownFees([])).toEqual([]);
  });
});

describe('row form (C2)', () => {
  it('sends only posted fields; empty clears; documents from the two lists', () => {
    const r = parseRowForm(form({
      ...target, appointmentDate: '2026-11-20', appointmentTime: '10:00', passportNumber: 'z-123 4567',
      documentIds: [DOC1, DOC2], receivedDocumentIds: [DOC2], remark: '',
    }));
    expect(r).toEqual({
      ok: true,
      value: {
        target: { taskId: TASK, dealId: null, applicationId: APP, expectedRowVersion: 3, requestId: REQ },
        fields: {
          appointmentDate: '2026-11-20', appointmentTime: '10:00', passportNumber: 'Z1234567', remark: null,
          documents: [{ documentId: DOC1, received: false }, { documentId: DOC2, received: true }],
        },
      },
    });
    const kindOnly = parseRowForm(form({ ...target, visaKind: 'e_visa' }));
    expect(kindOnly.ok && kindOnly.value.fields).toEqual({ visaKind: 'e_visa' });
    const clearKind = parseRowForm(form({ ...target, visaKind: '' }));
    expect(clearKind.ok && clearKind.value.fields).toEqual({ visaKind: null });
  });

  it('names the bad fields and needs at least one field', () => {
    expect(parseRowForm(form({ ...target, appointmentDate: '2026-02-30', passportNumber: 'Z1', visaKind: 'tourist' })))
      .toEqual({ ok: false, fields: [VISA_FIELD.appointmentDate, VISA_FIELD.passportNumber, VISA_FIELD.visaKind] });
    expect(parseRowForm(form({ ...target, appointmentDate: '', appointmentTime: '10:00' }))).toEqual({ ok: false, fields: [VISA_FIELD.appointmentTime] });
    expect(parseRowForm(form({ ...target, jurisdiction: 'yes', jurisdictionPlace: '' }))).toEqual({ ok: false, fields: [VISA_FIELD.jurisdictionPlace] });
    expect(parseRowForm(form({ ...target, documentIds: [DOC1, DOC1] }))).toEqual({ ok: false, fields: [VISA_FIELD.documentIds] });
    expect(parseRowForm(form(target))).toEqual({ ok: false, fields: ['fields'] });
    expect(parseRowForm(form({ taskId: TASK, remark: 'x' }))).toEqual({
      ok: false, fields: [VISA_FIELD.applicationId, VISA_FIELD.expectedRowVersion, VISA_FIELD.requestId],
    });
  });

  it('jurisdiction no clears the place', () => {
    const r = parseRowForm(form({ ...target, jurisdiction: 'no', jurisdictionPlace: 'Mumbai' }));
    expect(r.ok && r.value.fields).toEqual({ jurisdiction: 'no', jurisdictionPlace: null });
  });
});

describe('document add (C3)', () => {
  it('catalogue code, Other label, typed catalogue label takes its code', () => {
    expect(parseDocumentAddForm(form({ ...target, catalogueCode: 'pan_card', received: 'on' }))).toMatchObject({
      ok: true, value: { fields: { catalogueCode: 'pan_card', received: true, remark: null } },
    });
    expect(parseDocumentAddForm(form({ ...target, catalogueCode: 'other', label: '  Synthetic   own  letter ' }))).toMatchObject({
      ok: true, value: { fields: { label: 'Synthetic own letter', received: false } },
    });
    expect(parseDocumentAddForm(form({ ...target, catalogueCode: 'other', label: 'aadhaar CARD' }))).toMatchObject({
      ok: true, value: { fields: { catalogueCode: 'aadhaar_card' } },
    });
    expect(parseDocumentAddForm(form({ ...target, catalogueCode: 'visa_letter' }))).toEqual({ ok: false, fields: [VISA_FIELD.catalogueCode] });
    expect(parseDocumentAddForm(form({ ...target, label: 'x'.repeat(121) }))).toEqual({ ok: false, fields: [VISA_FIELD.label] });
  });
});

describe('apply form (C5)', () => {
  const line = (i: number, id: string, over: Record<string, string> = {}) => ({
    [visaApplicantField(i, 'applicationId')]: id,
    [visaApplicantField(i, 'expectedRowVersion')]: '4',
    [visaApplicantField(i, 'reference')]: `SYN-REF-${i}`,
    [visaApplicantField(i, 'appliedOn')]: '2026-11-07',
    [visaApplicantField(i, 'governmentFee')]: '₹6,500',
    [visaApplicantField(i, 'serviceFee')]: '',
    ...over,
  });

  it('builds every line with exact paise and the shared fields', () => {
    const r = parseApplyForm(form({
      taskId: TASK, requestId: REQ, applicantCount: '2', paidBy: 'company', paymentMode: 'upi', receiptEvidenceId: EV,
      passportTaken: 'on', visaKind: 'sticker', jurisdiction: 'yes', jurisdictionPlace: 'New Delhi', remark: 'Synthetic',
      ...line(0, APP), ...line(1, APP2, { [visaApplicantField(1, 'serviceFee')]: '1,000.50' }),
    }));
    expect(r).toEqual({
      ok: true,
      value: {
        taskId: TASK, dealId: null, requestId: REQ,
        fields: {
          applicants: [
            { applicationId: APP, expectedRowVersion: 4, reference: 'SYN-REF-0', appliedOn: '2026-11-07', governmentFeePaise: '650000', serviceFeePaise: null },
            { applicationId: APP2, expectedRowVersion: 4, reference: 'SYN-REF-1', appliedOn: '2026-11-07', governmentFeePaise: '650000', serviceFeePaise: '100050' },
          ],
          paidBy: 'company', paymentMode: 'upi', receiptEvidenceId: EV, passportTaken: true, visaKind: 'sticker',
          jurisdiction: 'yes', jurisdictionPlace: 'New Delhi', remark: 'Synthetic',
        },
      },
    });
  });

  it('names refused lines like the database hints', () => {
    const r = parseApplyForm(form({
      taskId: TASK, requestId: REQ, applicantCount: '2', paidBy: 'company',
      ...line(0, APP, { [visaApplicantField(0, 'governmentFee')]: '0' }),
      ...line(1, APP2, { [visaApplicantField(1, 'reference')]: 'syn-ref-0', [visaApplicantField(1, 'appliedOn')]: '7/11/26' }),
    }));
    expect(r).toEqual({
      ok: false,
      fields: ['applicants[0].governmentFee', 'applicants[1].appliedOn', VISA_FIELD.paymentMode],
    });
    const dupRef = parseApplyForm(form({
      taskId: TASK, requestId: REQ, applicantCount: '2', paidBy: 'customer_direct',
      ...line(0, APP), ...line(1, APP2, { [visaApplicantField(1, 'reference')]: 'syn-ref-0' }),
    }));
    expect(dupRef).toEqual({ ok: false, fields: ['applicants[1].reference'] });
    expect(parseApplyForm(form({ taskId: TASK, requestId: REQ, applicantCount: '0' }))).toEqual({ ok: false, fields: [VISA_FIELD.applicantCount] });
  });

  it('customer paid: payment mode optional', () => {
    const r = parseApplyForm(form({ taskId: TASK, requestId: REQ, applicantCount: '1', paidBy: 'customer_direct', ...line(0, APP) }));
    expect(r.ok && r.value.fields.paymentMode).toBeUndefined();
  });
});

describe('decision, handover, delivered, withdraw, fee forms', () => {
  it('approve and reject shapes', () => {
    expect(parseDecideForm(form({ ...target, decision: 'approved', outcomeEvidenceId: EV, recipientEmail: 'pax@example.test', remark: '' })))
      .toMatchObject({ ok: true, value: { fields: { decision: 'approved', outcomeEvidenceId: EV, recipientEmail: 'pax@example.test', remark: null } } });
    expect(parseDecideForm(form({ ...target, decision: 'rejected', outcomeEvidenceId: EV, reason: 'no', handoverMethod: 'courier', courierNumber: '' })))
      .toEqual({ ok: false, fields: [VISA_FIELD.reason, VISA_FIELD.courierNumber] });
    expect(parseDecideForm(form({ ...target, decision: 'approved' }))).toEqual({ ok: false, fields: [VISA_FIELD.outcomeEvidenceId] });
    const sticker = parseDecideForm(form({ ...target, decision: 'approved', outcomeEvidenceId: EV, handoverMethod: '' }));
    expect(sticker.ok && sticker.value.fields.handover).toBeUndefined();
    expect(parseDecideForm(form({ ...target, decision: 'approved', outcomeEvidenceId: EV, recipientEmail: 'not-an-email' })))
      .toEqual({ ok: false, fields: [VISA_FIELD.recipientEmail] });
  });

  it('handover: method, legacy e-mail, legacy customer told', () => {
    expect(parseHandoverForm(form({ ...target, handoverMethod: 'courier', courierNumber: 'SYN-AWB-9' }))).toMatchObject({
      ok: true, value: { fields: { method: 'courier', courierNumber: 'SYN-AWB-9', remark: null } },
    });
    expect(parseHandoverForm(form({ ...target, handoverMethod: 'not_with_us' }))).toMatchObject({ ok: true, value: { fields: { method: 'not_with_us' } } });
    expect(parseHandoverForm(form({ ...target, recipientEmail: 'pax@example.test' }))).toMatchObject({ ok: true, value: { fields: { recipientEmail: 'pax@example.test' } } });
    expect(parseHandoverForm(form({ ...target, customerTold: 'on' }))).toMatchObject({ ok: true, value: { fields: { customerTold: true } } });
    expect(parseHandoverForm(form({ ...target }))).toEqual({ ok: false, fields: [VISA_FIELD.handoverMethod] });
  });

  it('withdraw needs a reason and the customer-told tick', () => {
    expect(parseWithdrawForm(form({ ...target, reason: 'ab' }))).toEqual({ ok: false, fields: [VISA_FIELD.reason, VISA_FIELD.customerInformed] });
    expect(parseWithdrawForm(form({ ...target, reason: 'Synthetic cancel', customerInformed: 'on', handoverMethod: 'office' }))).toMatchObject({
      ok: true, value: { fields: { reason: 'Synthetic cancel', customerInformed: true, handover: { method: 'office' } } },
    });
  });

  it('fee send and other cost', () => {
    expect(parseFeeSendForm(form({ taskId: TASK, entryId: EV, expectedRowVersion: '2', requestId: REQ, amount: '6,000', receiptEvidenceId: '' }))).toMatchObject({
      ok: true, value: { fields: { amountPaise: '600000', receiptEvidenceId: null, remark: null } },
    });
    expect(parseFeeSendForm(form({ taskId: TASK, entryId: EV, expectedRowVersion: '2', requestId: REQ, amount: '' }))).toEqual({ ok: false, fields: [VISA_FIELD.amount] });
    expect(parseOtherCostForm(form({ taskId: TASK, applicationId: APP, requestId: REQ, amount: '450', paidBy: 'company', paymentMode: 'cash', paidOn: '2026-11-07' })))
      .toMatchObject({ ok: true, value: { entryId: null, expectedRowVersion: 0, fields: { amountPaise: '45000', paidBy: 'company', paymentMode: 'cash' } } });
    expect(parseOtherCostForm(form({ taskId: TASK, applicationId: APP, requestId: REQ, amount: '450', paidBy: 'company', paidOn: '2026-11-07' })))
      .toEqual({ ok: false, fields: [VISA_FIELD.paymentMode] });
    expect(parseOtherCostForm(form({ taskId: TASK, applicationId: APP, entryId: EV, requestId: REQ, amount: '450', paidBy: 'customer_direct', paidOn: '2026-11-07' })))
      .toEqual({ ok: false, fields: [VISA_FIELD.expectedRowVersion] });
  });
});

describe('database hints to screen fields', () => {
  it('maps command keys to form names and applicant tokens to rows', () => {
    expect(visaFieldsFromHint(['applicants[1].governmentFeePaise', 'applicants[0].reference', 'visaKind'])).toEqual([
      'applicants[1].governmentFee', 'applicants[0].reference', 'visaKind',
    ]);
    expect(visaFieldsFromHint(['applicants[2]:documents_missing'])).toEqual(['applicants[2]']);
    expect(visaFieldsFromHint(['handover.courierNumber', 'documents', 'amountPaise'])).toEqual([
      VISA_FIELD.courierNumber, VISA_FIELD.documentIds, VISA_FIELD.amount,
    ]);
    expect(notReadyTokenFromHint(['applicants[2]:appointment_missing'])).toBe('appointment_missing');
    expect(notReadyTokenFromHint(['visaKind'])).toBeNull();
  });
});
