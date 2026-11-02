import { isValidElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Speed plan C4: the Deal page starts the booking and Lead link reads together
 * with the deal read. Their results are used only for a visible deal; a hidden
 * or unknown deal still shows the same "not found" view and nothing else.
 */

const order: string[] = [];
const requireStaff = vi.fn();
const getVisibleDeal = vi.fn();
const loadBookingForDeal = vi.fn();
const loadDealLeadLink = vi.fn();
const loadBookNow = vi.fn();
const loadQuotationsForDeal = vi.fn();
const loadWorkflowSettings = vi.fn();
const loadDealDocuments = vi.fn();

vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('@/modules/deals/server/queries', () => ({
  getVisibleDeal: (...a: unknown[]) => getVisibleDeal(...a),
  loadBitrixNameLookup: async () => ({ state: 'switched_off' }),
}));
vi.mock('@/modules/fulfilment/server/book-now', () => ({ BOOK_NOW_NOT_INSTALLED: 'not_installed', loadBookNow: (...a: unknown[]) => loadBookNow(...a) }));
vi.mock('@/modules/quotations/server/queries', () => ({
  QUOTATIONS_NOT_INSTALLED: 'not_installed',
  loadQuotationsForDeal: (...a: unknown[]) => loadQuotationsForDeal(...a),
}));
vi.mock('@/modules/deals/server/documents', () => ({ loadDealDocuments: (...a: unknown[]) => loadDealDocuments(...a) }));
vi.mock('@/modules/fulfilment/server/intake', () => ({
  loadDealServices: async () => null,
  loadWorkflowSettings: (...a: unknown[]) => loadWorkflowSettings(...a),
}));
vi.mock('@/modules/deals/server/lead-link', () => ({ loadDealLeadLink: (...a: unknown[]) => loadDealLeadLink(...a) }));
vi.mock('@/modules/fulfilment/server/queries', () => ({ loadBookingForDeal: (...a: unknown[]) => loadBookingForDeal(...a) }));
vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  getAppConfig: () => ({ supabaseUrl: 'http://127.0.0.1:54321', supabasePublishableKey: 'sb_publishable_test' }),
}));

const { default: DealPage } = await import('@/app/app/deals/[id]/page');
const { DealNotFoundView } = await import('@/views/staff-views');

const DEAL_ID = '00000000-0000-4000-8000-000000000001';
const staff = { userId: 'u1', access: { userId: 'u1', memberships: [], rolePermissions: [], grants: [] } };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  requireStaff.mockResolvedValue(staff);
  loadBookNow.mockResolvedValue(null);
  loadQuotationsForDeal.mockResolvedValue(null);
  loadWorkflowSettings.mockResolvedValue({ serviceItemsEnabled: false });
  loadDealDocuments.mockResolvedValue({ state: 'ok', files: [] });
});

describe('Deal page reads (speed plan C4)', () => {
  it('starts the booking, Book now, quotation and Lead link reads before the deal read has answered', async () => {
    const deal = deferred<unknown>();
    getVisibleDeal.mockImplementation(() => {
      order.push('deal');
      return deal.promise;
    });
    loadBookingForDeal.mockImplementation(async () => {
      order.push('booking');
      return null;
    });
    loadDealLeadLink.mockImplementation(async () => {
      order.push('lead');
      return null;
    });
    loadBookNow.mockImplementation(async () => {
      order.push('book');
      return null;
    });
    loadQuotationsForDeal.mockImplementation(async () => {
      order.push('quotations');
      return null;
    });
    const rendering = DealPage({ params: Promise.resolve({ id: DEAL_ID }) });
    await new Promise((r) => setTimeout(r, 0));
    expect(order.sort()).toEqual(['book', 'booking', 'deal', 'lead', 'quotations']);
    deal.resolve({ id: DEAL_ID, title: 'Synthetic trip', reference: 'BX-1', branchName: 'Jodhpur', relation: 'owner', createdOn: '2026-10-06', assignments: [], commercial: { visible: false }, commercialAbsence: 'withheld' });
    expect(isValidElement(await rendering)).toBe(true);
    expect(loadBookingForDeal).toHaveBeenCalledWith(staff, DEAL_ID);
    expect(loadDealLeadLink).toHaveBeenCalledWith(staff, DEAL_ID);
  });

  it('tab-only reads (Services settings, Documents) start only when their tab is open, still before the deal read answers', async () => {
    const deal = deferred<unknown>();
    getVisibleDeal.mockReturnValue(deal.promise);
    loadBookingForDeal.mockResolvedValue(null);
    loadDealLeadLink.mockResolvedValue(null);
    const overview = DealPage({ params: Promise.resolve({ id: DEAL_ID }), searchParams: Promise.resolve({}) });
    await new Promise((r) => setTimeout(r, 0));
    expect(loadWorkflowSettings).not.toHaveBeenCalled();
    const services = DealPage({ params: Promise.resolve({ id: DEAL_ID }), searchParams: Promise.resolve({ tab: 'services' }) });
    await new Promise((r) => setTimeout(r, 0));
    expect(loadWorkflowSettings).toHaveBeenCalledTimes(1);
    expect(loadDealDocuments).not.toHaveBeenCalled();
    const documents = DealPage({ params: Promise.resolve({ id: DEAL_ID }), searchParams: Promise.resolve({ tab: 'documents' }) });
    await new Promise((r) => setTimeout(r, 0));
    expect(loadDealDocuments).toHaveBeenCalledTimes(1);
    deal.resolve(null);
    await Promise.all([overview, services, documents]);
  });

  it('a hidden deal shows only the not-found view, even when the other reads fail', async () => {
    getVisibleDeal.mockResolvedValue(null);
    loadBookingForDeal.mockRejectedValue(new Error('refused'));
    loadDealLeadLink.mockRejectedValue(new Error('refused'));
    loadBookNow.mockRejectedValue(new Error('refused'));
    loadQuotationsForDeal.mockRejectedValue(new Error('refused'));
    const tree = (await DealPage({ params: Promise.resolve({ id: DEAL_ID }) })) as ReactNode;
    expect(isValidElement(tree) && tree.type).toBe(DealNotFoundView);
  });
});
