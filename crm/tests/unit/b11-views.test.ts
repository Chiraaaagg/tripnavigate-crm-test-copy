import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CLAIMS_EMPTY, FLIGHT_1, HOTEL_1, PASSPORT_1, VISA_1, check, draftView, travellers } from '@/app/preview/[state]/b11-fixtures';
import type { BookingReviewView } from '@/modules/finance/contracts';
import { BOOK_SECTIONS, type BookSection, type BookStepStatus } from '@/modules/fulfilment/contracts';
import { AccountsPackageReview } from '@/views/b11/accounts-review';
import {
  BOOK_STEPS,
  bookHref,
  firstOpenStep,
  inr,
  maskPassport,
  nextStep,
  paiseToRupeesText,
  previousStep,
  rupeesTextToPaise,
  stepItems,
  stepHrefs,
  submitDialogLines,
  tasksSentence,
  travellerNeedsIdentity,
} from '@/views/b11/book-fields';
import { BookNowNotAvailableView, DealBookNowCard, SubmittedBookingView, bookNextStep } from '@/views/b11/book-views';
import { normaliseResult } from '@/views/b11/result';
import { factsOf, factsToFormValues, hasBudget, itemSummary } from '@/views/b11/service-fields';

/*
 * B1.1 Book now view helpers and server-rendered pieces (synthetic fixtures
 * from the preview gallery). The browser behaviour is covered by the b11-*
 * e2e suites; this file pins the pure rules and the role-leak guarantees of
 * the read-only views.
 */

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

const allSections = <S extends BookStepStatus>(status: S): Record<BookSection, S> =>
  Object.fromEntries(BOOK_SECTIONS.map((s) => [s, status])) as Record<BookSection, S>;

describe('book-fields', () => {
  it('has the three steps in order with links and neighbours (B1.2)', () => {
    expect(BOOK_STEPS.map((s) => s.key)).toEqual(['travellers', 'stay', 'finish']);
    expect(bookHref('d1', 'finish', 'price')).toBe('/app/deals/d1/book/finish#price');
    expect(bookHref('d1', 'finish')).toBe('/app/deals/d1/book/finish');
    expect(bookHref('d1')).toBe('/app/deals/d1/book');
    expect(nextStep('travellers')).toBe('stay');
    expect(nextStep('finish')).toBeNull();
    expect(previousStep('travellers')).toBeNull();
    expect(previousStep('finish')).toBe('stay');
  });

  it('marks steps from the view and finds the first step that needs input', () => {
    const notStarted = { stepStatus: { travellers: 'needs_input', stay: 'needs_input', finish: 'needs_input' }, sectionStatus: allSections('needs_input') } as const;
    const items = stepItems(notStarted, 'stay', stepHrefs('d1'));
    expect(items.find((s) => s.current)?.key).toBe('stay');
    expect(items.find((s) => s.key === 'travellers')?.status).toBe('needs_input');
    expect(firstOpenStep(notStarted)).toBe('travellers');
    const onlyAcceptance = { stepStatus: { travellers: 'complete', stay: 'complete', finish: 'needs_input' }, sectionStatus: { ...allSections('complete'), review: 'needs_input' } } as const;
    expect(firstOpenStep(onlyAcceptance)).toBe('finish');
    const warn = { stepStatus: { travellers: 'warnings_only', stay: 'complete', finish: 'complete' } } as const;
    expect(stepItems(warn, null, stepHrefs('d1')).find((s) => s.key === 'travellers')?.status).toBe('warnings');
  });

  it('converts rupees and paise without floating point surprises', () => {
    expect(paiseToRupeesText('1250050')).toBe('12500.50');
    expect(paiseToRupeesText('1200000')).toBe('12000');
    expect(paiseToRupeesText('5')).toBe('0.05');
    expect(paiseToRupeesText(null)).toBe('');
    expect(rupeesTextToPaise('12,500.5')).toBe(1250050);
    expect(rupeesTextToPaise('₹ 1,20,000')).toBe(12000000);
    expect(rupeesTextToPaise('')).toBe(0);
    expect(rupeesTextToPaise('12.345')).toBeNull();
    expect(inr('12000000')).toBe('₹1,20,000.00');
    expect(inr(null)).toBeNull();
    expect(maskPassport('Z1234567')).toBe('••••4567');
  });

  it('counts tasks per department and says when visa waits for the desk launch', () => {
    const items = [HOTEL_1, FLIGHT_1, VISA_1];
    expect(tasksSentence(items, false)).toBe('1 task for the Purchase team, 1 task for the Flight team; 1 visa or passport service waits for the Visa & Passport desk launch (no task yet)');
    expect(tasksSentence(items, true)).toContain('1 task for the Visa & Passport desk');
    const lines = submitDialogLines(draftView({ items }));
    expect(lines.join(' ')).toContain('It creates 2 internal tasks');
    expect(lines.join(' ')).toContain('does not book anything');
  });

  it('uses the revision dialog for a fix of a returned booking', () => {
    const v = draftView({ version: { ...draftView().version!, versionNo: 2, revisesVersionId: 'v1', revisesVersionNo: 1 } });
    expect(submitDialogLines(v).join(' ')).toContain('Replaces version 1 (kept in history)');
  });

  it('asks for identity only for travellers the contract marks', () => {
    const view = draftView({ travellers: travellers(true) });
    expect(travellerNeedsIdentity(view, 1)).toBe(true);
    expect(travellerNeedsIdentity(draftView(), 1)).toBe(false);
  });
});

describe('service-fields', () => {
  it('unwraps the contract facts and fills form defaults', () => {
    expect(factsOf(HOTEL_1).hotelName).toBe('Sample Lake Palace Hotel');
    expect(factsToFormValues('hotel', null).mode).toBe('specific');
    expect(factsToFormValues('flight', null).tripType).toBe('return');
    expect(factsToFormValues('visa', null).feePaidBy).toBe('not_decided');
    expect(factsToFormValues('hotel', factsOf(HOTEL_1)).childAges).toBe('8');
    expect(hasBudget('visa')).toBe(false);
    expect(hasBudget('passport')).toBe(false);
    expect(hasBudget('transfer')).toBe(true);
  });

  it('summarises a service in plain words with readable dates', () => {
    expect(itemSummary(HOTEL_1)).toBe('Sample Lake Palace Hotel · Udaipur · 20 Nov 2026 to 23 Nov 2026');
    expect(itemSummary(FLIGHT_1)).toBe('DEL to DXB, DXB to DEL');
    expect(itemSummary(PASSPORT_1)).toBe('renewal · Jaipur');
  });
});

describe('result normaliser', () => {
  it('shows finance answers like booking answers', () => {
    expect(normaliseResult({ status: 'ok', message: 'Done' })).toEqual({ ok: true, data: undefined, message: 'Done' });
    expect(normaliseResult({ status: 'error', code: 'duplicate_claim', message: 'x', fieldErrors: { claimReference: 'dup', _form: 'y' } })).toEqual({
      ok: false,
      code: 'duplicate_claim',
      message: 'x',
      fields: ['claimReference'],
    });
    const booking = { ok: false, code: 'version_changed', message: '' };
    expect(normaliseResult(booking)).toBe(booking);
  });
});

describe('read-only views', () => {
  it('says "not available" the same way for missing, other owner and wrong role', () => {
    expect(html(createElement(BookNowNotAvailableView))).toContain('This booking is not available to you.');
  });

  it('never shows money when the viewer has no commercial scope', () => {
    const view = draftView({ version: { ...draftView().version!, status: 'confirmed' }, commercials: undefined, plan: undefined, claims: undefined, checklist: [] });
    const out = html(createElement(SubmittedBookingView, { view, dealHref: '/app/deals/x' }));
    expect(out).not.toContain('Selling');
    expect(out).not.toContain('₹');
    expect(out).not.toContain('Payment plan');
    expect(out).toContain('Services and tasks');
  });

  it('shows reported payments as not money, beside the verified money', () => {
    const view = draftView({ version: { ...draftView().version!, status: 'confirmed' }, checklist: [], claims: { ...CLAIMS_EMPTY, reportedPaise: '3000000' } });
    const out = html(createElement(SubmittedBookingView, { view, dealHref: '/app/deals/x' }));
    expect(out).toContain('Reported, not checked (not money)');
    expect(out).toContain('Checked by Accounts');
  });

  it('gives the Deal page card one honest next step per state', () => {
    expect(html(createElement(DealBookNowCard, { state: { kind: 'lost', hasBooking: false }, bookHref: '/b' }))).toContain('cannot be started');
    expect(html(createElement(DealBookNowCard, { state: { kind: 'draft', savedAt: null, savedByName: null, needCount: 3, revision: false }, bookHref: '/b' }))).toContain('Booking draft · 3 things to finish');
    expect(html(createElement(DealBookNowCard, { state: { kind: 'submitted', reviewStatus: 'returned' }, bookHref: '/b' }))).toContain('Fix and send again');
    expect(html(createElement(DealBookNowCard, { state: { kind: 'not_started', canStart: false, waitsForWon: true }, bookHref: '/b' }))).toContain('Waiting for Won - Payment Received in Bitrix');
  });

  it('gives one Next line in the Deal header words', () => {
    expect(bookNextStep(draftView({ checklist: [check('stage_not_confirmed', true)] }))).toEqual({ text: 'wait for Won - Payment Received in Bitrix. You can keep preparing.' });
    expect(bookNextStep(draftView({ dealNotActive: true }))).toEqual({ text: 'nothing while the deal is lost or rejected in Bitrix' });
    expect(bookNextStep(draftView({ checklist: [] })).text).toContain('submit');
  });

  it('shows the payment plan Accounts reviews, and whether it adds up', () => {
    const booking = {
      bookingVersionId: 'bv',
      versionNo: 1,
      sellingTotalPaise: '12000000',
      serviceType: 'package',
      listPricePaise: null,
      discountPaise: null,
      paymentPlan: { instalments: [{ seq: 1, label: 'Advance', amountPaise: '12000000', dueDate: '2026-11-01' }], totalPaise: '12000000', matchesSellingTotal: true },
    } as unknown as BookingReviewView;
    const out = html(createElement(AccountsPackageReview, { booking }));
    expect(out).toContain('Adds up to the selling total');
    expect(out).toContain('Instalments are a plan, not money received.');
  });
});
