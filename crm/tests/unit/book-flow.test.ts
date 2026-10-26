import { describe, expect, it } from 'vitest';
import { check, DEAL_ID, draftView, emptyDraft } from '@/app/preview/[state]/b11-fixtures';
import {
  BOOK_PRICE_AND_PAYMENT_LABEL,
  BOOK_PRICE_NOTE,
  bookBlockingItems,
  bookFieldHref,
  bookPriceAccess,
  bookSectionNavState,
  bookStepSections,
  errorSummary,
  nextSectionNeedingInput,
  orderSummaryItems,
  reviewAndSubmitHref,
  saveReportText,
  saveRunReport,
  saveRunSummaryTitle,
  SUMMARY_ITEM_TEXT,
} from '@/modules/fulfilment/book-flow';
import { BOOK_STEP_LABEL } from '@/modules/fulfilment/contracts';
import type { ErrorSummaryItem } from '@/modules/fulfilment/book-flow-contract';
import { BOOK_SECTIONS, type BookSection, type BookStepStatus } from '@/modules/fulfilment/contracts';

/** Batch 2 Book now flow (pure): section list, L3 next section, price access, error summary order, save report. Synthetic. */

const status = (needs: BookSection[], warn: BookSection[] = []): Record<BookSection, BookStepStatus> =>
  Object.fromEntries(BOOK_SECTIONS.map((s) => [s, needs.includes(s) ? 'needs_input' : warn.includes(s) ? 'warnings_only' : 'complete'])) as Record<BookSection, BookStepStatus>;

describe('staff words (DA-150, DA-151)', () => {
  it('step names are the booking form words; the address keys stay', () => {
    expect(BOOK_STEP_LABEL).toEqual({ travellers: 'Customer & passengers', stay: 'Trip & services', finish: 'Price & Bill To' });
  });
});

describe('next section needing input (L3)', () => {
  it('a later section of the same step first, then an earlier one', () => {
    expect(nextSectionNeedingInput(status(['price', 'payment']), 'services')).toBe('price');
    expect(nextSectionNeedingInput(status(['services']), 'payment')).toBe('services');
    expect(nextSectionNeedingInput(status(['passengers']), 'customer')).toBe('passengers');
  });

  it('never jumps to another step', () => {
    expect(nextSectionNeedingInput(status(['trip']), 'customer')).toBeNull();
  });

  it('step 3 with nothing left opens review; review itself and other steps stay put', () => {
    expect(nextSectionNeedingInput(status([]), 'payment')).toBe('review');
    expect(nextSectionNeedingInput(status(['review']), 'payment')).toBe('review');
    expect(nextSectionNeedingInput(status([]), 'review')).toBeNull();
    expect(nextSectionNeedingInput(status([]), 'trip')).toBeNull();
  });
});

describe('section list and price access', () => {
  it('states in words: to finish, check, saved, optional (nothing added and nothing asked)', () => {
    const v = draftView({ checklist: [check('missing_acceptance_proof', true), check('billing_unverified', false)], items: [] });
    expect(bookSectionNavState(v, 'review')).toBe('to_finish');
    expect(bookSectionNavState(v, 'services')).toBe('optional');
    expect(bookSectionNavState(v, 'identity')).toBe('optional');
    expect(bookSectionNavState(v, 'price')).toBe('saved');
  });

  it('editor without price access (Echo M3): only payment leaves the list; price stays as "Price and payment" with one note', () => {
    const without = bookStepSections(draftView({ canEditCommercials: false }), 'finish');
    expect(without.priceAccess).toBe('note');
    expect(without.items.map((i) => i.section)).toEqual(['services', 'identity', 'price', 'review']);
    expect(without.items.find((i) => i.section === 'price')?.label).toBe(BOOK_PRICE_AND_PAYMENT_LABEL);
    expect(without.priceNote).toBe('The price and payment plan are filled by Sales on this deal.');
    expect(without.priceNote).toBe(BOOK_PRICE_NOTE);
    const withAccess = bookStepSections(draftView(), 'finish', 'price');
    expect(withAccess.items.map((i) => i.section)).toEqual(['services', 'identity', 'price', 'payment', 'review']);
    expect(withAccess.items.map((i) => i.label)).toEqual(['Cabs, flights and other services', 'Passport and ID details', 'Selling price', 'Payment plan', 'Review and submit']);
    expect(withAccess.items.find((i) => i.current)?.section).toBe('price');
    expect(withAccess.priceNote).toBeNull();
  });

  it('read-only viewers are not told to ask for the price (no note)', () => {
    expect(bookPriceAccess(draftView({ canEdit: false, canEditCommercials: false }))).toBe('edit');
    expect(bookPriceAccess(draftView({ canEditCommercials: false, dealNotActive: true }))).toBe('edit');
  });
});

describe('links', () => {
  it('Review and submit opens step 3 at the review section', () => {
    expect(reviewAndSubmitHref(DEAL_ID)).toBe(`/app/deals/${DEAL_ID}/book/finish#review`);
  });

  it('same step: fragment only; other step: address with ?at= and the field', () => {
    expect(bookFieldHref(DEAL_ID, 'finish', 'price', 'price-total')).toBe('#price-total');
    expect(bookFieldHref(DEAL_ID, 'finish', 'customer', 'customer-contact-name')).toBe(`/app/deals/${DEAL_ID}/book/travellers?at=customer#customer-contact-name`);
    expect(bookFieldHref(DEAL_ID, null, 'trip', null)).toBe(`/app/deals/${DEAL_ID}/book/stay?at=trip#trip`);
  });

  it('blocking checklist items link to the field input; warnings are not listed', () => {
    const items = bookBlockingItems(emptyDraft(), 'finish');
    expect(items.every((i) => i.kind === 'blocking')).toBe(true);
    expect(items.length).toBe(7);
    expect(items.find((i) => i.partId === 'review')?.href).toBe('#review');
  });
});

describe('error summary order', () => {
  const item = (kind: ErrorSummaryItem['kind'], partId: ErrorSummaryItem['partId'], message: string): ErrorSummaryItem => ({ kind, partId, fieldId: null, message, href: `#${partId}` });

  it('unsaved first, then refused, blocking, skipped; page order inside a kind; duplicates once', () => {
    const ordered = orderSummaryItems([
      item('blocking', 'trip', 'Trip: add dates'),
      item('skipped', 'payment', 'Payment plan'),
      item('unsaved', 'price', 'Price not saved'),
      item('refused', 'customer', 'Customer: mobile'),
      item('blocking', 'customer', 'Customer: name'),
      item('blocking', 'trip', 'Trip: add dates'),
    ]);
    expect(ordered.map((i) => i.message)).toEqual(['Price not saved', 'Customer: mobile', 'Trip: add dates', 'Customer: name', 'Payment plan']);
  });

  it('nothing to show: no summary', () => {
    expect(errorSummary('Title', [])).toBeNull();
  });
});

describe('save run report (honest partial saves)', () => {
  it('outcomes and words', () => {
    const all = saveRunReport({ saved: ['Customer and billing'], refused: null, skipped: [] });
    expect(all.outcome).toBe('all_saved');
    expect(saveReportText(all)).toBe('Saved: Customer and billing.');
    expect(saveReportText(saveRunReport({ saved: [], refused: null, skipped: [] }))).toBe('Nothing to save.');
    const partial = saveRunReport({ saved: ['Options offered'], refused: { label: 'Price lines', partId: 'money', fieldId: null, message: 'Check the unit.' }, skipped: ['Quoted option total'] });
    expect(partial.outcome).toBe('partial');
    expect(saveReportText(partial)).toBe('Saved: Options offered. Not saved: Price lines (reason shown there). Not saved because an earlier part failed: Quoted option total.');
    const refused = saveRunReport({ saved: [], refused: { label: 'Passengers', partId: 'passengers', fieldId: null, message: 'x' }, skipped: [] });
    expect(refused.outcome).toBe('refused');
    expect(saveReportText(refused)).toBe('Nothing was saved. Not saved: Passengers (reason shown there).');
    expect(saveRunSummaryTitle(refused)).toBe('Your changes were not saved');
    expect(saveRunSummaryTitle(partial)).toBe('Some changes were not saved');
    expect(SUMMARY_ITEM_TEXT.refused('Price lines')).toBe('Price lines: not saved (the reason is shown there)');
    expect(SUMMARY_ITEM_TEXT.skipped('Quoted option total')).toBe('Quoted option total: not saved because an earlier part failed');
  });

  it('forms that cannot be saved for you stop the run before anything is sent', () => {
    const r = saveRunReport({ saved: [], refused: null, skipped: [], blocked: ['ID proof for traveller 1'] });
    expect(r.outcome).toBe('refused');
    expect(saveReportText(r)).toBe('You have unsaved changes in: ID proof for traveller 1. Save or undo them first.');
    expect(saveRunSummaryTitle(r)).toBe('Save these first');
    expect(SUMMARY_ITEM_TEXT.blocked('ID proof for traveller 1')).toBe('ID proof for traveller 1: save or undo it there');
  });
});
