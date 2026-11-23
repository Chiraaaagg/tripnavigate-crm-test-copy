import { describe, expect, it } from 'vitest';
import { QUOTATION_LIST_FILTERS } from '@/modules/quotations/work-contract';
import { parseWorkListQuery, quotationListPageVM } from '@/modules/quotations/work-model';
import { chipsWithPlainLabels } from '@/views/b12/work-lists';

/**
 * UX redesign R2 (B3): the work-list view model writes the count into the
 * chip label ("Open (5)") and the chip prints the count itself, so production
 * showed it twice ("Open (5) (5)"). The list view keeps the label's words only.
 */
describe('work list chips: the count shows once', () => {
  it('strips a trailing count that matches the chip count', () => {
    const out = chipsWithPlainLabels({
      scopeText: 'Counts include all pages.',
      chips: [
        { filter: 'open', label: 'Open (5)', count: 5, href: '/app/quotations', current: true },
        { filter: 'closed_drafts', label: 'Closed drafts (0)', count: 0, href: '/app/quotations?filter=closed_drafts', current: false },
      ],
    });
    expect(out.chips.map((c) => c.label)).toEqual(['Open', 'Closed drafts']);
    expect(out.chips.map((c) => c.count)).toEqual([5, 0]);
    expect(out.scopeText).toBe('Counts include all pages.');
  });

  it('keeps labels without a count, with an unknown count, or ending in other numbers', () => {
    const out = chipsWithPlainLabels({
      scopeText: '',
      chips: [
        { filter: 'open', label: 'Open', count: 5, href: '/a', current: false },
        { filter: 'drafts', label: 'Drafts', count: null, href: '/b', current: false },
        { filter: 'shared', label: 'Shared (2)', count: 3, href: '/c', current: false },
      ],
    });
    expect(out.chips.map((c) => c.label)).toEqual(['Open', 'Drafts', 'Shared (2)']);
  });

  it('the real view model labels come out plain for every quotation filter', () => {
    const counts = Object.fromEntries(QUOTATION_LIST_FILTERS.map((f, i) => [f, i + 1]));
    const vm = quotationListPageVM(parseWorkListQuery('quotations', {}), { applies: true, rows: [], counts, total: 0, next: null, hasMore: false } as unknown as Parameters<typeof quotationListPageVM>[1]);
    // The model still writes the count into the label (unit-tested elsewhere); the view removes it.
    expect(vm.filters.chips.find((c) => c.filter === 'open')?.label).toBe('Open (1)');
    for (const chip of chipsWithPlainLabels(vm.filters).chips) expect(chip.label).not.toMatch(/\(\d+\)$/);
  });
});
