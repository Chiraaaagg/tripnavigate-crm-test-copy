import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SERVICE_FACT_KEYS } from '@/modules/fulfilment/contracts';
import { validateServiceFacts } from '@/modules/fulfilment/forms';
import {
  VISA_APPLICANT_WORD, VISA_DOCUMENT_CATALOGUE, VISA_ERROR_STATES, VISA_ERROR_TEXT, VISA_HANDOVER_LABEL, VISA_HANDOVER_TEXT, VISA_COST_KIND_LABEL,
  VISA_STEP_LABEL, VISA_TASK_STATUS_WORD, visaNotReadyText,
} from '@/modules/visa/contracts';
import {
  DealVisaHistorySchema, DealVisaSummarySchema, VisaApplicantSchema, VisaHomeCountsSchema, VisaQueueSchema, VisaWorkspaceSchema,
} from '@/modules/visa/dto';
import {
  catalogueCodeForLabel, copyDownFees, normalizePassportNumber, parsePassportNumber, parseVisaTime, rupeesToPaise, visaLabelKey,
} from '@/modules/visa/forms';
import { visaStepViews } from '@/modules/visa/status';
import { travellerSeqHighWater } from '@/views/b11/book-fields';

/**
 * Visa build (contract 8 Nov 2026) test plan 12.3, written from the contract:
 * frozen refusal messages (6.1), catalogue (4), status/step/handover words
 * (8, 10), forms helpers (10), DTO fence keys (9), Track C visa facts (5.5)
 * and the traveller high-water mark (5.6). The function names come from the
 * modules; every expected value comes from the contract.
 */

describe('6.1 refusal tokens and frozen messages', () => {
  const FROZEN: Array<[string, string, string]> = [
    ['not_authorized', '42501', 'You cannot do this on this visa task.'],
    ['not_found', 'P0002', 'This item is no longer available. Reload the page.'],
    ['version_changed', '40001', 'Someone changed this passenger meanwhile. Reload and try again.'],
    ['duplicate_request', '40001', 'This was already sent with different details. Reload the page.'],
    ['task_conflict', '40001', 'Someone at the desk took this task first.'],
    ['invalid_input', '22023', 'Check the highlighted field.'],
    ['task_closed', '55000', 'This task is complete. Nothing can be changed here now.'],
    ['application_closed', '55000', 'This passenger is closed. Nothing can be changed here now.'],
    ['wrong_state', '55000', 'This step is already done for this passenger. Reload the page.'],
    ['applicant_removed', '55000', 'This passenger was removed from the booking. Only the decision, handover or withdrawal can be recorded.'],
    ['duplicate_reference', '23505', 'This reference is already used on this task.'],
    ['applied_date_in_future', '22023', 'The applied date cannot be after today.'],
    ['delivered_date_in_future', '22023', 'The delivery date cannot be after today.'],
    ['duplicate_document', '23505', 'This document is already on the list.'],
    ['too_many_documents', '22023', 'This passenger already has 40 documents.'],
    ['document_received', '55000', 'A received document cannot be removed.'],
    ['outcome_document_required', '55000', 'Upload the visa or refusal document first.'],
    ['already_recorded', '55000', 'This handover is already recorded.'],
    ['receipt_required', '55000', 'Attach the fee receipt first.'],
    ['cost_locked', '55000', 'This fee is with Accounts and cannot be changed now.'],
  ];
  it.each(FROZEN)('%s (%s): frozen wording', (token, code, message) => {
    expect(VISA_ERROR_STATES[token as keyof typeof VISA_ERROR_STATES]).toBe(code);
    expect(VISA_ERROR_TEXT[token as keyof typeof VISA_ERROR_TEXT]).toBe(message);
  });
  it('traveller_changed names the "OK, checked" button (typographic apostrophe allowed)', () => {
    expect(VISA_ERROR_TEXT.traveller_changed.replace('’', "'")).toBe(`The traveller's name changed in the booking. Check it and press "OK, checked" first.`);
    expect(VISA_ERROR_STATES.traveller_changed).toBe('55000');
  });
  it('not_ready carries the reason of the notReady token', () => {
    expect(visaNotReadyText('removed')).toBe('Not ready to apply yet: removed from the booking.');
    expect(visaNotReadyText('traveller_changed')).toBe('Not ready to apply yet: the traveller changed in the booking.');
    expect(visaNotReadyText('no_documents')).toBe('Not ready to apply yet: no document list yet.');
    expect(visaNotReadyText('documents_missing')).toBe('Not ready to apply yet: documents not received.');
    expect(visaNotReadyText('appointment_missing')).toBe('Not ready to apply yet: no appointment date.');
    expect(visaNotReadyText('kind_missing')).toBe('Not ready to apply yet: set the appointment date or choose E-visa.');
  });
});

describe('section 4 document catalogue', () => {
  it('25 codes and labels in the frozen order', () => {
    expect(VISA_DOCUMENT_CATALOGUE.map((d) => d.code)).toEqual([
      'passport_copy', 'photo', 'bank_statement', 'parent_passport', 'travel_insurance', 'stay_proof', 'birth_certificate', 'parent_consent',
      'onward_ticket', 'original_passport', 'old_passports', 'passport_size_photos_2', 'aadhaar_card', 'pan_card', 'itr_last_3_years',
      'salary_slips_3_months', 'employment_letter_or_noc', 'leave_letter', 'cover_letter', 'return_flight_booking', 'visa_application_form_signed',
      'marriage_certificate', 'invitation_letter', 'business_registration_documents', 'school_or_college_id',
    ]);
    expect(VISA_DOCUMENT_CATALOGUE[0]!.label).toBe('Passport copy (front and back)');
    expect(VISA_DOCUMENT_CATALOGUE[11]!.label).toBe('Passport-size photos (2)');
    expect(VISA_DOCUMENT_CATALOGUE[24]!.label).toBe('School or college ID');
  });
  it('label key = lower(trim + single spaces); a typed catalogue label takes its code', () => {
    expect(visaLabelKey('  Bank   Statement (6 months) ')).toBe('bank statement (6 months)');
    expect(catalogueCodeForLabel('pan  CARD')).toBe('pan_card');
    expect(catalogueCodeForLabel('Synthetic club card')).toBeNull();
  });
});

describe('section 10 forms helpers', () => {
  it('rupees text -> whole paise > 0 (one money rule: commas grouping only, no ₹, no inner spaces)', () => {
    expect(rupeesToPaise('6,500')).toBe('650000');
    expect(rupeesToPaise(' 6,500.50 ')).toBe('650050');
    expect(rupeesToPaise('6500.5')).toBe('650050');
    for (const bad of ['0', '0.00', '-5', '6500.505', 'abc', '', null, '₹6,500', ' 6 500.50 ']) expect(rupeesToPaise(bad as string | null)).toBeNull();
  });
  it('passport number: upper case, spaces and dashes removed, 6..15 letters or digits', () => {
    expect(normalizePassportNumber(' p-77 66 554 ')).toBe('P7766554');
    expect(parsePassportNumber('z1234567')).toBe('Z1234567');
    expect(parsePassportNumber('AB12')).toBeNull();
    expect(parsePassportNumber('A'.repeat(16))).toBeNull();
  });
  it('time HH:MM 24 h', () => {
    expect(parseVisaTime('09:15')).toBe('09:15');
    expect(parseVisaTime('23:59')).toBe('23:59');
    expect(parseVisaTime('24:00')).toBeNull();
    expect(parseVisaTime('10:60')).toBeNull();
  });
  it('fee copy-down: the first passenger fills empty boxes only; typed values never overwritten; never split', () => {
    const out = copyDownFees([
      { governmentFee: '6500', serviceFee: '1000' },
      { governmentFee: '', serviceFee: '' },
      { governmentFee: '3250', serviceFee: '' },
    ]);
    expect(out).toEqual([
      { governmentFee: '6500', serviceFee: '1000' },
      { governmentFee: '6500', serviceFee: '1000' },
      { governmentFee: '3250', serviceFee: '1000' },
    ]);
  });
});

describe('section 8 words and step bar', () => {
  it('task status, step labels, applicant and handover words', () => {
    expect(VISA_TASK_STATUS_WORD).toMatchObject({ not_taken: 'Not taken', ready: 'Documents and date pending', applied: 'Not applied yet',
      decision: 'Waiting for decision', handover: 'Handover pending', completed: 'Completed' });
    expect(Object.values(VISA_STEP_LABEL)).toEqual(['Task taken', 'Documents and date', 'Applied', 'Decision', 'Handover']);
    expect(VISA_APPLICANT_WORD).toMatchObject({ removed: 'Removed from the booking', travellerChanged: 'Traveller changed', secondApplication: 'Second application' });
    expect(VISA_HANDOVER_LABEL).toEqual({ office: 'Customer collects from the office', executive: 'Our executive delivers', courier: 'By courier',
      not_with_us: 'Passport is not with us' });
    expect(VISA_COST_KIND_LABEL).toMatchObject({ government_fee: 'Government fee', service_fee: 'Service fee' });
  });
  it('R8: the CRM sends nothing: "E-visa sent to", never "e-mailed"', () => {
    expect(VISA_HANDOVER_TEXT.evisaSent).toBe('E-visa sent to {email}');
    expect(JSON.stringify(VISA_HANDOVER_TEXT)).not.toMatch(/e-?mailed/i);
  });
  it('a step is done only when every earlier step is done; the current one shows "x of y" or "Now"', () => {
    const step = (key: string, met: number, of: number, done: boolean) => ({ key, label: '', met, of, done }) as never;
    const views = visaStepViews([step('take', 1, 1, true), step('ready', 2, 4, false), step('applied', 0, 4, false), step('decision', 0, 4, false),
      step('handover', 0, 4, false)]);
    expect(views.map((v) => [v.key, v.state, v.word])).toEqual([
      ['take', 'done', 'Completed'], ['ready', 'current', '2 of 4'], ['applied', 'pending', 'Pending'], ['decision', 'pending', 'Pending'],
      ['handover', 'pending', 'Pending'],
    ]);
    // A later step marked done by the database after an unfinished one is not shown as done.
    const chain = visaStepViews([step('take', 1, 1, true), step('ready', 0, 1, false), step('applied', 1, 1, true)]);
    expect(chain.map((v) => [v.state, v.word])).toEqual([['done', 'Completed'], ['current', 'Now'], ['pending', 'Pending']]);
  });
});

describe('section 9 DTO fence keys', () => {
  const FORBIDDEN = /sell|listPrice|discount|margin|instalment|^plan$|billing|contact|phone|mobile|address|bank|customerReceipt|funding/i;
  const keysOf = (schema: z.ZodType): string[] => {
    const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as unknown;
    const out: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (o.properties && typeof o.properties === 'object') out.push(...Object.keys(o.properties as object));
        Object.values(o).forEach(walk);
      }
    };
    walk(json);
    return out;
  };
  it.each([
    ['visa_queue', VisaQueueSchema], ['visa_workspace', VisaWorkspaceSchema], ['deal_visa_summary', DealVisaSummarySchema],
    ['deal_visa_history', DealVisaHistorySchema], ['visa_home_counts', VisaHomeCountsSchema],
  ] as Array<[string, z.ZodType]>)('%s has no commercial or contact key', (_name, schema) => {
    expect(keysOf(schema).filter((k) => FORBIDDEN.test(k))).toEqual([]);
  });
  it('Deal reads carry no paise, reference, e-mail or passport keys', () => {
    for (const schema of [DealVisaSummarySchema, DealVisaHistorySchema]) {
      expect(keysOf(schema).filter((k) => /paise|reference|email|passport|courier/i.test(k))).toEqual([]);
    }
  });
  it('identity: a non-assignee applicant has passport null (no masked number)', () => {
    const passport = (VisaApplicantSchema as unknown as z.ZodObject).shape.passport as z.ZodType;
    expect(passport.safeParse(null).success).toBe(true);
    expect(keysOf(VisaApplicantSchema).filter((k) => /masked|last4|dateOfBirth|nationality|expiry/i.test(k))).toEqual([]);
  });
});

describe('Track C visa facts (5.5) and traveller numbers (5.6)', () => {
  const base = { country: 'France', purpose: 'Tourism', travelDate: '2027-02-06', applyBy: null, feePaidBy: 'company', notes: null };
  it('fact keys gain visaKind, jurisdiction, jurisdictionPlace, documentsNeeded (all optional)', () => {
    expect(SERVICE_FACT_KEYS.visa).toEqual(expect.arrayContaining(['visaKind', 'jurisdiction', 'jurisdictionPlace', 'documentsNeeded']));
    expect(validateServiceFacts('visa', base)).toEqual([]);
    expect(validateServiceFacts('visa', { ...base, visaKind: null, jurisdiction: null, jurisdictionPlace: null, documentsNeeded: [] })).toEqual([]);
  });
  it('visaKind e_visa|sticker|null; jurisdiction place required with Yes and absent otherwise', () => {
    expect(validateServiceFacts('visa', { ...base, visaKind: 'sticker', jurisdiction: 'yes', jurisdictionPlace: 'New Delhi' })).toEqual([]);
    expect(validateServiceFacts('visa', { ...base, visaKind: 'paper' })).toContain('visaKind');
    expect(validateServiceFacts('visa', { ...base, jurisdiction: 'maybe' })).toContain('jurisdiction');
    expect(validateServiceFacts('visa', { ...base, jurisdiction: 'yes' })).toContain('jurisdictionPlace');
    expect(validateServiceFacts('visa', { ...base, jurisdiction: 'no', jurisdictionPlace: 'Mumbai' })).toContain('jurisdictionPlace');
    expect(validateServiceFacts('visa', { ...base, jurisdiction: 'yes', jurisdictionPlace: 'x'.repeat(121) })).toContain('jurisdictionPlace');
  });
  it('documentsNeeded: 0..30 labels of 1..120 characters, distinct by label key', () => {
    expect(validateServiceFacts('visa', { ...base, documentsNeeded: ['Passport copy (front and back)', 'Synthetic own document'] })).toEqual([]);
    expect(validateServiceFacts('visa', { ...base, documentsNeeded: ['Photo, white background', '  photo,  WHITE background '] })).toContain('documentsNeeded');
    expect(validateServiceFacts('visa', { ...base, documentsNeeded: [''] })).toContain('documentsNeeded');
    expect(validateServiceFacts('visa', { ...base, documentsNeeded: ['x'.repeat(121)] })).toContain('documentsNeeded');
    expect(validateServiceFacts('visa', { ...base, documentsNeeded: Array.from({ length: 31 }, (_, i) => `Synthetic doc ${i}`) })).toContain('documentsNeeded');
    expect(validateServiceFacts('visa', { ...base, documentsNeeded: Array.from({ length: 30 }, (_, i) => `Synthetic doc ${i}`) })).toEqual([]);
  });
  it('passport facts unchanged (no documents list, VL8)', () => {
    expect(SERVICE_FACT_KEYS.passport).toEqual(['applicationType', 'officeCity', 'neededBy', 'notes']);
  });
  it('travellerSeqHighWater = max(travellerSeqHigh, highest loaded seq)', () => {
    const t = (seq: number) => ({ seq }) as never;
    expect(travellerSeqHighWater({ travellers: [t(1), t(2)], travellerSeqHigh: 5 })).toBe(5);
    expect(travellerSeqHighWater({ travellers: [t(1), t(7)], travellerSeqHigh: 5 })).toBe(7);
    expect(travellerSeqHighWater({ travellers: [t(3)] })).toBe(3);
    expect(travellerSeqHighWater({ travellers: [] })).toBe(0);
  });
});
