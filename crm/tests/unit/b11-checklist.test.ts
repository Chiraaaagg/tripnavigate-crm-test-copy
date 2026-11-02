import { describe, expect, it } from 'vitest';
import {
  BOOK_STEPS,
  type BookChecklistCode,
  CHECKLIST_STEP,
  CHECKLIST_TEXT,
  INTAKE_CHECKLIST_CODES,
  ISSUE_TEXT,
} from '@/modules/fulfilment/contracts';
import { ISSUE_CODES } from '@/modules/fulfilment/commands';
import { bookSectionStatus, bookStepStatus, identityRequiredSeqs, mergeBookChecklist } from '@/modules/fulfilment/b11-dto';
import { FIELD } from '@/modules/fulfilment/forms';

/**
 * Frozen checklist → step/field map (freeze note §3.4 answer 3) and the
 * merge of intake_checklist with readiness issues on the Book now form.
 */

describe('CHECKLIST_STEP', () => {
  const codes: BookChecklistCode[] = [...INTAKE_CHECKLIST_CODES, ...ISSUE_CODES];

  it('covers every checklist and readiness code with a known step', () => {
    for (const code of codes) {
      expect(CHECKLIST_STEP[code], code).toBeDefined();
      expect(BOOK_STEPS).toContain(CHECKLIST_STEP[code].step);
    }
  });

  it('every field is a frozen form input name', () => {
    const names = new Set<string>(Object.values(FIELD));
    for (const code of codes) {
      const field = CHECKLIST_STEP[code].field;
      if (field !== null) expect(names.has(field), `${code} → ${field}`).toBe(true);
    }
  });

  it('every code has plain wording', () => {
    for (const code of INTAKE_CHECKLIST_CODES) expect(CHECKLIST_TEXT[code].length).toBeGreaterThan(10);
    for (const code of ISSUE_CODES) expect(ISSUE_TEXT[code].length).toBeGreaterThan(10);
  });

  it('sends each B1.1 gap to the step and section that fixes it (B1.2 three steps)', () => {
    expect(CHECKLIST_STEP.contact_missing).toEqual({ step: 'travellers', section: 'customer', field: 'contactName' });
    expect(CHECKLIST_STEP.gstin_missing).toEqual({ step: 'travellers', section: 'customer', field: 'gstin' });
    expect(CHECKLIST_STEP.identity_missing).toEqual({ step: 'finish', section: 'identity', field: 'dateOfBirth' });
    expect(CHECKLIST_STEP.participation_missing).toEqual({ step: 'finish', section: 'services', field: 'participantSeq' });
    expect(CHECKLIST_STEP.selling_total_missing).toEqual({ step: 'finish', section: 'price', field: 'sellingTotalRupees' });
    expect(CHECKLIST_STEP.plan_total_mismatch).toEqual({ step: 'finish', section: 'payment', field: 'instalmentAmountRupees' });
    expect(CHECKLIST_STEP.revision_class_missing).toEqual({ step: 'finish', section: 'review', field: 'changeClass' });
  });
});

describe('mergeBookChecklist', () => {
  const checklist = {
    items: [
      { code: 'contact_missing' as const, blocking: true, owner: 'sales' as const, itemNos: [] },
      { code: 'identity_missing' as const, blocking: true, owner: 'sales' as const, itemNos: [], travellerSeqs: [2] },
      { code: 'selling_total_missing' as const, blocking: true, owner: 'sales' as const, itemNos: [] },
      { code: 'visa_waiting_for_launch' as const, blocking: false, owner: 'admin' as const, itemNos: [3] },
    ],
    canConfirm: false,
  };

  it('keeps checklist items, adds readiness-only issues once, and names steps and numbers', () => {
    const merged = mergeBookChecklist(checklist, ['missing_selling_total', 'missing_acceptance_proof', 'contact_missing', 'stage_not_confirmed']);
    expect(merged.map((i) => i.code)).toEqual([
      'contact_missing',
      'identity_missing',
      'selling_total_missing',
      'visa_waiting_for_launch',
      'missing_acceptance_proof',
      'stage_not_confirmed',
    ]);
    expect(merged.find((i) => i.code === 'identity_missing')).toMatchObject({ step: 'finish', section: 'identity', travellerSeqs: [2], text: `${CHECKLIST_TEXT.identity_missing} (traveller 2)` });
    expect(merged.find((i) => i.code === 'visa_waiting_for_launch')).toMatchObject({ blocking: false, owner: 'admin', text: `${CHECKLIST_TEXT.visa_waiting_for_launch} (service 3)` });
    expect(merged.find((i) => i.code === 'stage_not_confirmed')).toMatchObject({ owner: 'bitrix', step: 'finish', section: 'review', blocking: true });
  });

  it('step markers: blocking → needs input, warnings only, complete; not started → needs input', () => {
    const merged = mergeBookChecklist(checklist, []);
    expect(bookStepStatus(merged, true)).toEqual({ travellers: 'needs_input', stay: 'complete', finish: 'needs_input' });
    expect(bookSectionStatus(merged, true)).toMatchObject({
      customer: 'needs_input',
      passengers: 'complete',
      trip: 'complete',
      hotels: 'complete',
      services: 'warnings_only',
      identity: 'needs_input',
      price: 'needs_input',
      payment: 'complete',
      review: 'complete',
    });
    expect(Object.values(bookStepStatus([], false))).toEqual(Array(3).fill('needs_input'));
  });
});

describe('identityRequiredSeqs', () => {
  const item = (serviceType: 'visa' | 'passport' | 'flight' | 'hotel', participants: number[]) => ({ serviceType, participants, state: 'planned' as const });
  it('visa/passport participants always; flight participants only on an international trip; never hotel', () => {
    const items = [item('visa', [1]), item('flight', [2, 3]), item('hotel', [4])];
    expect([...identityRequiredSeqs(items, { destination: 'X', scope: 'domestic', start: null, end: null })].sort()).toEqual([1]);
    expect([...identityRequiredSeqs(items, { destination: 'X', scope: 'international', start: null, end: null })].sort()).toEqual([1, 2, 3]);
  });
});
