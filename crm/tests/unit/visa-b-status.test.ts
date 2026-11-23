import { describe, expect, it } from 'vitest';
import { mapVisaError, visaHintKeys } from '@/modules/visa/commands';
import { VISA_ERROR_STATES, VISA_ERROR_TEXT, visaNotReadyText } from '@/modules/visa/contracts';
import { DealVisaHistorySchema, VisaApplicantSchema, VisaCostSummarySchema, VisaHomeCountsSchema, VisaQueueTaskSchema, VisaWorkspaceSchema } from '@/modules/visa/dto';
import {
  parseVisaQueueShow,
  visaApplicantChips,
  visaDealHistoryTitle,
  visaHandoverCell,
  visaLineText,
  visaNoticeText,
  visaQueueCounts,
  visaQueueFilter,
  visaStepViews,
} from '@/modules/visa/status';

/** Visa build, track B: refusal maps, DTO allowlists and display words (contract sections 6.1, 8, 9). Synthetic values only. */

const APP = '55555555-5555-4555-8555-555555555555';
const TASK = '22222222-2222-4222-8222-222222222222';

const applicant = (over: Record<string, unknown> = {}) =>
  VisaApplicantSchema.parse({
    applicationId: APP, seq: 1, fullName: 'Synthetic Traveller', type: 'adult', ageYears: 34, rowVersion: 2,
    state: 'docs_pending', stateText: 'Not applied', ready: false, notReady: ['documents_missing', 'brand_new_token'],
    removed: false, superseded: false, secondApplication: false, previousApplicationId: null, travellerChanged: null,
    passport: null, visaKind: { value: 'sticker', source: 'sales' }, jurisdiction: { required: true, place: 'New Delhi', source: 'sales' },
    appointment: { date: null, time: null }, remark: null, documents: [], documentsReceived: 0, documentsTotal: 0,
    applied: null, decision: null, handover: null, closed: null, fees: [],
    can: { edit: true, select: false, decide: false, handover: false, deliver: false, withdraw: true, reapply: false, confirmTraveller: false },
    sellingPricePaise: '999', customerPhone: '+91 99999 00000',
    ...over,
  });

describe('refusal tokens', () => {
  it('every token maps only with its SQLSTATE and has frozen wording', () => {
    for (const [token, state] of Object.entries(VISA_ERROR_STATES)) {
      expect(mapVisaError({ code: state, message: token })).toBe(token);
      expect(VISA_ERROR_TEXT[token as keyof typeof VISA_ERROR_TEXT]).toBeTruthy();
    }
    expect(mapVisaError({ code: '55000', message: 'duplicate_reference' })).toBeNull();
    expect(mapVisaError({ code: '40001', message: 'request_conflict' })).toBe('duplicate_request');
    expect(mapVisaError({ code: '40001', message: 'something' })).toBeNull();
    expect(mapVisaError({ code: '22P02', message: 'invalid input syntax for type uuid' })).toBe('invalid_input');
    expect(mapVisaError({ code: 'PGRST301', message: 'JWT expired' })).toBe('session');
    expect(VISA_ERROR_TEXT.cost_locked).toBe('This fee is with Accounts and cannot be changed now.');
  });

  it('keeps only plain hint lists (field keys and applicant tokens)', () => {
    expect(visaHintKeys('applicants[1].reference,visaKind')).toEqual(['applicants[1].reference', 'visaKind']);
    expect(visaHintKeys('applicants[2]:documents_missing')).toEqual(['applicants[2]:documents_missing']);
    expect(visaHintKeys('Key (task_id)=(…) already exists')).toEqual([]);
  });

  it('not_ready reason words', () => {
    expect(visaNotReadyText('kind_missing')).toBe('Not ready to apply yet: set the appointment date or choose E-visa.');
    expect(visaNotReadyText('surprise')).toBe('Not ready to apply yet: finish this passenger’s row first.');
  });
});

describe('DTO allowlists', () => {
  it('strip unknown keys and drop unknown notReady tokens', () => {
    const a = applicant();
    expect(a.notReady).toEqual(['documents_missing']);
    expect(Object.keys(a)).not.toContain('sellingPricePaise');
    expect(JSON.stringify(a)).not.toMatch(/99999|sellingPrice/);
  });

  it('queue rows carry canTake / isManagerView; cost rows otherPaise', () => {
    const row = VisaQueueTaskSchema.parse({
      taskId: TASK, serviceType: 'visa', dealReference: 'SYN-JOD-012', branchName: 'Jodhpur', title: 'France visa', factsLine: 'France',
      travelDate: null, status: { code: 'not_taken', step: null, text: 'Not taken' }, applicantCount: 2, readyCount: 0, appliedCount: 0,
      decidedCount: 0, closedCount: 0, assigneeName: null, assignedToYou: false, createdAt: '2026-11-08T05:00:00Z', canTake: true, isManagerView: false,
    });
    expect(row).toMatchObject({ canTake: true, isManagerView: false });
    const cost = VisaCostSummarySchema.parse({
      travellers: [{ seq: 1, name: 'Synthetic Traveller', governmentFeePaise: '650000', serviceFeePaise: null, otherPaise: 45000, paidBy: 'company', expenseStatus: 'draft', state: 'decision_pending' }],
      taskLevel: [], companyTotalPaise: '695000', customerDirectTotalPaise: '0',
    });
    expect(cost.travellers[0]!.otherPaise).toBe('45000');
  });

  it('home counts read absent keys as null', () => {
    expect(VisaHomeCountsSchema.parse({ visaHandoverPending: 2, visaHandoverPendingTaskId: TASK })).toMatchObject({
      visaHandoverPending: 2, visaHandoverPendingTaskId: TASK, salesVisaResultsToSee: null, visaFeesReturned: null,
    });
  });

  it('deal history drops unknown kinds and reads a collapsed club', () => {
    const h = DealVisaHistorySchema.parse({
      events: [
        { at: '2026-11-08T05:00:00Z', kind: 'applied', taskId: TASK, title: 'France visa', travellerName: null, byName: null, byYou: true, note: 'Applied together: 3 travellers' },
        { at: '2026-11-08T04:00:00Z', kind: 'fee_paid', taskId: TASK, title: 'France visa', travellerName: null, byName: null, byYou: false, note: null },
        { at: '2026-11-08T03:00:00Z', kind: 'rejected', taskId: TASK, title: 'France visa', travellerName: 'Synthetic Traveller', byName: null, byYou: false, note: 'Synthetic reason' },
      ],
      truncated: false,
    });
    expect(h.events.map((e) => [e.kind, e.clubSize, e.note])).toEqual([['applied', 3, null], ['rejected', null, 'Synthetic reason']]);
    expect(visaDealHistoryTitle(h.events[0]!)).toBe('Applied together: 3 travellers');
    expect(visaDealHistoryTitle(h.events[1]!)).toBe('Visa rejected');
  });

  it('workspace facts are one of visa / passport', () => {
    const base = {
      taskId: TASK, serviceType: 'passport', dealId: TASK, dealReference: 'SYN-JOD-012', branchName: 'Jodhpur', title: 'Passport',
      status: { code: 'not_taken', step: null, text: 'Not taken' }, assignee: { name: null, isYou: false, takenAt: null },
      canClaim: true, canWork: false, isManagerView: false, versionNo: 1, confirmedAt: '2026-11-08T05:00:00Z',
      facts: { passport: { applicationType: 'renewal', officeCity: 'Jodhpur', neededBy: '2026-11-20', notes: null } },
      steps: [], bookingChange: null, addedAfterCompletion: 0, applicants: [], readyCount: 0, appliedCount: 0, costSummary: null, canUpload: false,
    };
    expect(VisaWorkspaceSchema.parse(base).canManageFees).toBe(false);
    expect(VisaWorkspaceSchema.parse({ ...base, canManageFees: true }).canManageFees).toBe(true);
    expect(VisaWorkspaceSchema.parse(base).facts).toEqual({ passport: { applicationType: 'renewal', officeCity: 'Jodhpur', neededBy: '2026-11-20', notes: null } });
    expect(VisaWorkspaceSchema.safeParse({ ...base, facts: { hotel: {} } }).success).toBe(false);
  });
});

describe('display words', () => {
  it('step bar: done chain, current x of y / Now, pending', () => {
    const views = visaStepViews([
      { key: 'take', label: 'Task taken', met: 1, of: 1, done: true },
      { key: 'ready', label: 'Documents and date', met: 2, of: 4, done: false },
      { key: 'applied', label: 'Applied', met: 4, of: 4, done: true },
      { key: 'decision', label: 'Decision', met: 0, of: 4, done: false },
      { key: 'handover', label: 'Handover', met: 0, of: 1, done: false },
    ]);
    expect(views.map((s) => [s.state, s.word])).toEqual([
      ['done', 'Completed'], ['current', '2 of 4'], ['pending', 'Pending'], ['pending', 'Pending'], ['pending', 'Pending'],
    ]);
    expect(visaStepViews([{ key: 'take', label: 'Task taken', met: 0, of: 1, done: false }])[0]!.word).toBe('Now');
  });

  it('applicant chips and visa line', () => {
    expect(visaApplicantChips(applicant({ ready: true, notReady: [] }))).toEqual(['Ready']);
    expect(visaApplicantChips(applicant({ removed: true, travellerChanged: { was: 'A', now: 'B' } }))).toEqual(['Not applied', 'Removed from the booking', 'Traveller changed']);
    expect(visaLineText(applicant(), 'visa')).toBe('Sticker visa · Passport not with us · Jurisdiction New Delhi');
    expect(visaLineText(applicant({ visaKind: { value: 'e_visa', source: 'desk' } }), 'visa')).toBe('E-visa · Passport photo only');
    expect(visaLineText(applicant(), 'passport')).toBeNull();
    const taken = applicant({ state: 'decision_pending', applied: { reference: 'R', appliedOn: '2026-11-07', clubId: null, clubWith: [], remark: null, passportTaken: true },
      jurisdiction: { required: false, place: null, source: 'desk' } });
    expect(visaLineText(taken, 'visa')).toBe('Sticker visa · Passport with us · No jurisdiction');
  });

  it('handover cell: e-visa sent, method text, not decided, legacy not recorded', () => {
    expect(visaHandoverCell(applicant({ state: 'issued', handover: { kind: 'evisa', recipientEmail: 'pax@example.test', sentAt: '2026-11-08T05:00:00Z' } }), 'visa'))
      .toEqual({ kind: 'evisa', text: 'E-visa sent to pax@example.test' });
    expect(visaHandoverCell(applicant({ state: 'issued', handover: { kind: 'method', method: 'courier', courierNumber: 'SYN-AWB-1' } }), 'visa').text)
      .toBe('Sticker visa return · By courier · Courier number SYN-AWB-1');
    expect(visaHandoverCell(applicant({ state: 'refused', handover: { kind: 'method', method: 'office', deliveredOn: '2026-11-08' } }), 'passport').text)
      .toBe('Passport return · Customer collects from the office · Delivered 8 Nov 26');
    expect(visaHandoverCell(applicant({ state: 'issued', handover: { kind: null } }), 'visa')).toMatchObject({ kind: 'not_decided', action: 'Set handover' });
    expect(visaHandoverCell(applicant({ state: 'issued', visaKind: { value: null, source: null }, handover: { kind: null } }), 'visa'))
      .toMatchObject({ kind: 'not_recorded', action: 'Record handover' });
    expect(visaHandoverCell(applicant(), 'visa')).toEqual({ kind: 'none', text: null });
  });

  it('queue tabs, notices', () => {
    expect(parseVisaQueueShow('mine', false)).toBe('mine');
    expect(parseVisaQueueShow('mine', true)).toBe('not_taken');
    expect(parseVisaQueueShow(['all'], true)).toBe('all');
    const t = (code: 'not_taken' | 'in_progress', mine: boolean) => ({ status: { code, step: null, text: '' }, assignedToYou: mine }) as never;
    const tasks = [t('not_taken', false), t('in_progress', true), t('in_progress', false)];
    expect(visaQueueCounts(tasks)).toEqual({ not_taken: 1, mine: 1, all: 3 });
    expect(visaQueueFilter(tasks, 'mine')).toHaveLength(1);
    expect(visaNoticeText({ outcome: 'approved', travellerName: 'Synthetic Traveller' })).toBe('Visa approved for Synthetic Traveller');
    expect(visaNoticeText({ outcome: 'rejected', travellerName: null })).toBe('Visa rejected for the traveller');
  });
});
