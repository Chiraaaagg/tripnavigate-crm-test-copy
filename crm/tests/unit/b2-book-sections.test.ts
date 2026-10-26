import { describe, expect, it } from 'vitest';
import type { BookSection, BookStepStatus } from '@/modules/fulfilment/contracts';
import type { ErrorSummaryItem } from '@/modules/fulfilment/book-flow-contract';
import { bookStepSections, nextSectionNeedingInput } from '@/modules/fulfilment/book-flow';
import type { BookSectionNavItem } from '@/modules/fulfilment/book-flow-contract';
import { initialCurrentSection, initialOpenSections } from '@/views/b11/step-sections-model';
import { orderSummaryItems } from '@/views/b11/summary-model';

const FINISH: BookSection[] = ['services', 'identity', 'price', 'payment', 'review'];

function status(over: Partial<Record<BookSection, BookStepStatus>> = {}): Record<BookSection, BookStepStatus> {
  const all: BookSection[] = ['customer', 'passengers', 'trip', 'hotels', ...FINISH];
  return { ...(Object.fromEntries(all.map((s) => [s, 'complete'])) as Record<BookSection, BookStepStatus>), ...over };
}

describe('Batch 2 step 3 section list (screen side)', () => {
  const item = (section: BookSection, state: BookSectionNavItem['state']): BookSectionNavItem => ({ section, label: section, state, href: `#${section}`, current: false });

  it('opens review plus the first section that needs input (and a section a preview pre-answers)', () => {
    const items = [item('services', 'saved'), item('identity', 'to_finish'), item('price', 'to_finish'), item('payment', 'saved'), item('review', 'to_finish')];
    expect(initialOpenSections(items)).toEqual(['review', 'identity']);
    expect(initialOpenSections(items, ['payment'])).toEqual(['review', 'identity', 'payment']);
    expect(initialOpenSections([item('services', 'saved'), item('review', 'to_finish')])).toEqual(['review']);
  });

  it('one current section: the first open one that is not review, else none', () => {
    expect(initialCurrentSection(['review', 'identity', 'payment'])).toBe('identity');
    expect(initialCurrentSection(['review'])).toBeNull();
  });

  it('the screen and the route use one next-section rule (Terra): later, then earlier, then review on step 3', () => {
    const status = (over: Partial<Record<BookSection, BookStepStatus>>) => ({ ...(Object.fromEntries(['customer', 'passengers', 'trip', 'hotels', ...FINISH].map((s) => [s, 'complete'])) as Record<BookSection, BookStepStatus>), ...over });
    expect(nextSectionNeedingInput(status({ price: 'needs_input', payment: 'needs_input' }), 'identity')).toBe('price');
    expect(nextSectionNeedingInput(status({ services: 'needs_input' }), 'payment')).toBe('services');
    expect(nextSectionNeedingInput(status({}), 'payment')).toBe('review');
  });

  it('an editor without price access gets one "Price and payment" entry from the route builder (Echo M3)', () => {
    const vm = bookStepSections(
      { dealId: 'd', sectionStatus: status(), items: [], travellers: [], canEdit: true, canEditCommercials: false, version: { status: 'draft' } as never, dealNotActive: false },
      'finish',
    );
    expect(vm.priceAccess).toBe('note');
    expect(vm.items.map((i) => i.section)).not.toContain('payment');
  });
});

describe('Batch 2 page error summary order', () => {
  const item = (kind: ErrorSummaryItem['kind'], partId: ErrorSummaryItem['partId'], message: string): ErrorSummaryItem => ({ kind, partId, fieldId: null, message, href: `#${partId}` });

  it('unsaved first, then the refusal, blocking checks, not tried; page order inside a kind', () => {
    const out = orderSummaryItems([item('blocking', 'price', 'b1'), item('skipped', 'payment', 's1'), item('unsaved', 'trip', 'u1'), item('refused', 'customer', 'r1'), item('blocking', 'hotels', 'b2'), item('unsaved', 'customer', 'u2')]);
    expect(out.map((i) => i.message)).toEqual(['u1', 'u2', 'r1', 'b1', 'b2', 's1']);
  });

  it('the same message for the same part is listed once (pax_missing and traveller_count_missing say one thing)', () => {
    const out = orderSummaryItems([item('blocking', 'details', 'Add the number of travellers.'), item('blocking', 'details', 'Add the number of travellers.'), item('blocking', 'money', 'Add the number of travellers.')]);
    expect(out).toHaveLength(2);
  });
});
