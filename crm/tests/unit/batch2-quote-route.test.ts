import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { quoteVersion, screenData } from '@/app/preview/[state]/b12-quote-fixtures';
import type { PrefillView } from '@/modules/fulfilment/contracts';

/**
 * Batch 2 quotation route (Echo M2 follow-up): the page chooses the prefill
 * screen from the read, as Book now does (lead ruling D1). Switch on
 * (`autoFill.enabled`) → inline; off or absent → today's panel with the same
 * view; no prefill block → nothing. Loaders mocked; synthetic data only.
 */

const loadQuoteScreen = vi.fn();
vi.mock('@/modules/identity/server/session', () => ({ requireStaff: async () => ({ userId: 'u', supabase: {}, access: {} }) }));
vi.mock('@/app/app/quotations/load-screen', () => ({ loadQuoteScreen: (...a: unknown[]) => loadQuoteScreen(...a) }));
vi.mock('@/modules/itineraries/server/queries', () => ({ ITINERARIES_NOT_INSTALLED: 'not_installed', loadItinerariesForQuotation: async () => null }));
vi.mock('@/modules/quotations/server/queries', () => ({ QUOTATIONS_NOT_INSTALLED: 'not_installed' }));
vi.mock('@/app/app/quotations/quote-actions', () => ({ QUOTE_ACTIONS: {} }));
vi.mock('@/app/app/itineraries/itinerary-actions', () => ({ ITINERARY_ACTIONS: { create: async () => null } }));

const { default: QuotationVersionPage } = await import('@/app/app/quotations/[versionId]/page');

const prefill = (enabled: boolean | null): PrefillView => ({
  available: true,
  sourceModifiedAt: null,
  lastVerifiedAt: null,
  issues: [],
  bookingNotes: null,
  notesHidden: false,
  travellerTotal: null,
  customerType: null,
  customerTypeLabel: null,
  unchecked: [],
  fields: [{ field: 'contacts.mobile', label: 'Contact mobile', bitrixValue: '9876500033', state: 'from_bitrix', stateText: null, canUse: true, canMarkChecked: true }],
  ...(enabled === null ? {} : { autoFill: { enabled, run: null, canFillEmpty: true } }),
});

async function pageProps(version: ReturnType<typeof quoteVersion>) {
  loadQuoteScreen.mockResolvedValue({ ...screenData(), version });
  const element = (await QuotationVersionPage({ params: Promise.resolve({ versionId: version.versionId }) })) as ReactElement<{ prefillUi: unknown }>;
  return element.props;
}

const draft = (p: PrefillView | undefined) => quoteVersion({ status: 'draft', canEdit: true, canMarkReady: true, ...(p ? { prefill: p } : {}) });

beforeEach(() => loadQuoteScreen.mockReset());

describe('quotation page: prefill screen follows the switch as read', () => {
  it('switch on → inline view model (markers, section check, fill empty offered for a draft without a creation fill)', async () => {
    const props = await pageProps(draft(prefill(true)));
    expect(props.prefillUi).toMatchObject({ mode: 'inline', available: true, fillEmpty: { offered: true } });
  });

  it('switch off or not reported → today’s panel with the same view', async () => {
    for (const p of [prefill(false), prefill(null)]) {
      const props = await pageProps(draft(p));
      expect(props.prefillUi).toEqual({ mode: 'panel', view: p });
    }
  });

  it('no prefill block (older database) → no prefill screen', async () => {
    const props = await pageProps(draft(undefined));
    expect(props.prefillUi).toBeNull();
  });
});
