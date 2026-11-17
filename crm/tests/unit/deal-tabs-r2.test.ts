import { describe, expect, it } from 'vitest';
import type { DealDetail } from '@/modules/deals/dto';
import {
  buildDealOverview,
  buildDealOverviewMoney,
  buildDealWorkspace,
  canListDealMessages,
  dealHasServices,
  dealTabsFor,
  defaultDealTab,
  isDeskOnlyViewer,
  requestedDealTab,
  type DealWorkspaceInput,
} from '@/modules/deals/workspace';
import type { DealTab } from '@/modules/deals/workspace-contract';
import type { BookNowView, DealServicesView } from '@/modules/fulfilment/contracts';
import type { QuotationListView } from '@/modules/quotations/contracts';

/*
 * UX redesign R2, Deal tab contract (build plan 4.5): every old `?tab=` value
 * lands on the right new tab for every role, the default tab rule (owner,
 * 16 November 2026), and the money fence on Overview for Purchase, Flight and
 * Visa (build plan section 5). Synthetic data only.
 */

const DEAL_ID = '00000000-0000-4000-8000-0000000000d2';

const base: DealDetail = {
  id: DEAL_ID,
  reference: 'BX-7001',
  title: 'Synthetic family, Udaipur',
  branchName: 'Jodhpur',
  relation: 'owner',
  createdOn: '2026-11-01',
  assignments: [{ kind: 'purchase', isYou: false }],
  commercial: { visible: true, currency: 'INR', sellingTotal: '₹2,00,000.00', estimatedMargin: '₹20,000.00' },
};
const withheld: Pick<DealDetail, 'commercial' | 'commercialAbsence'> = { commercial: { visible: false }, commercialAbsence: 'withheld' };

const item = (itemNo: number, over: Record<string, unknown> = {}) => ({
  itemId: `i${itemNo}`,
  itemNo,
  serviceType: 'hotel',
  department: 'purchase',
  state: 'active',
  title: `Synthetic hotel ${itemNo}`,
  facts: {},
  purchaseBudgetPaise: '5000000',
  factsHash: 'h',
  task: { taskId: `t${itemNo}`, status: 'in_progress', assignedToYou: false },
  nextStep: {},
  ...over,
});

const progress = { total: 1, byState: { planned: 0, notStarted: 0, inProgress: 1, supplierConfirmed: 0 }, fulfilled: false, staleCount: 0, needs: [] };

const services = (items: unknown[]): DealServicesView =>
  ({ dealId: DEAL_ID, version: { versionId: 'v1', versionNo: 1, status: 'confirmed', rowVersion: 1, contentHash: 'h', serviceType: 'package' }, items, progress, canEdit: false, canConfirm: false }) as unknown as DealServicesView;

const salesView = (items: unknown[]): BookNowView =>
  ({
    dealId: DEAL_ID,
    stage: null,
    dealNotActive: false,
    serviceItemsEnabled: true,
    canEdit: true,
    canOpenRevision: false,
    accountsReview: { status: 'approved', reviewedAt: null, reason: null, reasonHidden: false },
    checklist: [],
    items,
    progress,
    version: { versionId: 'v1', versionNo: 1, status: 'confirmed', serviceType: 'package', revisesVersionId: null },
    commercials: { listPricePaise: null, discountPaise: null, sellingTotalPaise: '20000000' },
    claims: { dealId: DEAL_ID, sellingTotalPaise: '20000000', reportedPaise: '0', confirmedPaise: '5000000', balancePaise: '15000000', canReport: true, reportBlock: null, destinations: [], claims: [] },
  }) as unknown as BookNowView;

const quotations = { subjectKind: 'deal', subjectId: DEAL_ID, canCreate: true, quotations: [] } as unknown as QuotationListView;

interface Viewer {
  name: string;
  deal: DealDetail;
  roles: string[];
  book: DealWorkspaceInput['book'];
  quotations: QuotationListView | null;
}

const OWNER_VIEW = salesView([item(1)]);
const viewers: Viewer[] = [
  { name: 'Sales owner', deal: base, roles: ['sales'], book: { state: 'ok', view: OWNER_VIEW }, quotations },
  { name: 'branch Manager', deal: { ...base, relation: 'scope' }, roles: ['manager'], book: { state: 'ok', view: OWNER_VIEW }, quotations },
  { name: 'Accounts', deal: { ...base, relation: 'scope' }, roles: ['accounts'], book: { state: 'none' }, quotations: null },
  { name: 'Purchase', deal: { ...base, ...withheld, relation: 'assigned' }, roles: ['purchase'], book: { state: 'none' }, quotations: null },
  { name: 'Flight', deal: { ...base, ...withheld, relation: 'assigned' }, roles: ['flight'], book: { state: 'none' }, quotations: null },
  { name: 'Visa', deal: { ...base, ...withheld, relation: 'assigned' }, roles: ['visa'], book: { state: 'none' }, quotations: null },
];

function build(v: Viewer, tab: unknown, over: Partial<DealWorkspaceInput> = {}) {
  return buildDealWorkspace({
    dealId: DEAL_ID,
    deal: v.deal,
    tab,
    book: v.book,
    legacyBooking: { ok: true, exists: false },
    services: { ok: true, view: services([item(1)]) },
    quotations: v.quotations,
    itinerariesReadable: false,
    leadLink: null,
    documentsAvailable: true,
    messagesListed: canListDealMessages(v.deal.relation, v.roles),
    ...over,
  });
}

/** Expected landing tab per old `?tab=` value, per viewer (null = that viewer's default tab). */
const EXPECTED: Record<string, Record<string, DealTab | null>> = {
  'Sales owner': { overview: 'overview', services: 'services', quotations: 'documents', documents: 'documents', money: 'money', history: 'history', messages: 'messages' },
  'branch Manager': { overview: 'overview', services: 'services', quotations: 'documents', documents: 'documents', money: 'money', history: 'history', messages: 'messages' },
  Accounts: { overview: 'overview', services: 'services', quotations: 'documents', documents: 'documents', money: 'money', history: 'history', messages: 'messages' },
  Purchase: { overview: 'overview', services: 'services', quotations: 'documents', documents: 'documents', money: null, history: 'history', messages: null },
  Flight: { overview: 'overview', services: 'services', quotations: 'documents', documents: 'documents', money: null, history: 'history', messages: null },
  Visa: { overview: 'overview', services: 'services', quotations: 'documents', documents: 'documents', money: null, history: 'history', messages: null },
};

const DEFAULT: Record<string, DealTab> = { 'Sales owner': 'services', 'branch Manager': 'overview', Accounts: 'overview', Purchase: 'overview', Flight: 'overview', Visa: 'overview' };

describe('R2 Deal tab contract: every old ?tab= value, per role', () => {
  it('the retired Quotations value maps to Documents; unknown values map to nothing', () => {
    expect(requestedDealTab('quotations')).toBe('documents');
    expect(requestedDealTab(['quotations', 'money'])).toBe('documents');
    for (const raw of [undefined, null, '', 'Quotations', 'nope', 3]) expect(requestedDealTab(raw)).toBeNull();
  });

  for (const v of viewers) {
    it(`${v.name}: each old value lands on its new tab; unknown and forbidden values land on the default`, () => {
      for (const [raw, expected] of Object.entries(EXPECTED[v.name]!)) {
        expect(build(v, raw).current, `?tab=${raw}`).toBe(expected ?? DEFAULT[v.name]);
      }
      expect(build(v, undefined).current, 'no tab').toBe(DEFAULT[v.name]);
      expect(build(v, 'not-a-tab').current, 'unknown tab').toBe(DEFAULT[v.name]);
      const listed = build(v, undefined).tabs;
      // Tab links always carry ?tab= and never show a count.
      for (const t of listed) {
        expect(t.href).toBe(`/app/deals/${DEAL_ID}?tab=${t.tab}`);
        expect(t).not.toHaveProperty('count');
      }
    });
  }

  it('desk roles never get the Money or Messages tab', () => {
    for (const v of viewers.filter((x) => ['Purchase', 'Flight', 'Visa'].includes(x.name))) {
      const tabs = build(v, undefined).tabs.map((t) => t.tab);
      expect(tabs).not.toContain('money');
      expect(tabs).not.toContain('messages');
    }
  });
});

describe('R2 default tab (owner, 16 November 2026)', () => {
  it('Sales owner with services lands on Services and tasks; without services on Overview', () => {
    expect(defaultDealTab({ relation: 'owner', hasServices: true })).toBe('services');
    expect(defaultDealTab({ relation: 'owner', hasServices: false })).toBe('overview');
    for (const relation of ['assigned', 'scope', 'waiting'] as const) expect(defaultDealTab({ relation, hasServices: true })).toBe('overview');
  });

  it('cancelled services do not count; the booking view or the services read may prove them', () => {
    expect(dealHasServices(null, null)).toBe(false);
    expect(dealHasServices(null, services([item(1, { state: 'cancelled' })]))).toBe(false);
    expect(dealHasServices(null, services([item(1)]))).toBe(true);
    expect(dealHasServices(salesView([item(2)]), services([]))).toBe(true);
  });

  it('the owner of a Deal with no services opens on Overview', () => {
    const owner = viewers[0]!;
    const vm = build({ ...owner, book: { state: 'ok', view: salesView([]) } }, undefined, { services: { ok: true, view: services([]) } });
    expect(vm.current).toBe('overview');
  });

  it('tabsFor gives the same answer as the workspace', () => {
    const owner = viewers[0]!;
    const { current, visible } = dealTabsFor({ deal: owner.deal, tab: undefined, quotations, itinerariesReadable: false, documentsAvailable: false, messagesListed: true, book: owner.book, services: { ok: true, view: services([item(1)]) } });
    expect(current).toBe('services');
    expect(visible).toEqual(['overview', 'services', 'money', 'documents', 'messages', 'history']);
  });
});

describe('R2 money fence on Overview (build plan section 5)', () => {
  const MONEY_KEYS = /"money"|sellingTotal|stillToPay|estimatedMargin|balance|Paise|purchaseBudget/;

  for (const v of viewers.filter((x) => ['Purchase', 'Flight', 'Visa'].includes(x.name))) {
    it(`${v.name}: the Overview model has no money key and no amount`, () => {
      const vm = build(v, 'overview');
      expect(vm.current).toBe('overview');
      expect(vm.overview).toBeDefined();
      expect(vm.overview).not.toHaveProperty('money');
      expect(vm.overview?.links).not.toHaveProperty('money');
      expect(JSON.stringify(vm)).not.toMatch(MONEY_KEYS);
      expect(JSON.stringify(vm)).not.toMatch(/₹|selling|margin|due|receipt/i);
      // The Overview carries no closure checklist (prototype only).
      expect(JSON.stringify(vm.overview)).not.toMatch(/closure|checklist/i);
    });

    it(`${v.name}: even a booking read with prices builds no Overview money lines`, () => {
      expect(buildDealOverviewMoney(v.deal, OWNER_VIEW)).toBeUndefined();
      const overview = buildDealOverview(v.deal, services([item(1)]), undefined, { view: OWNER_VIEW });
      expect(overview).not.toHaveProperty('money');
      expect(JSON.stringify(overview)).not.toMatch(/₹|5000000|20000000|15000000/);
    });
  }

  it('Sales owner: Overview shows the selling total and still to pay, linked to Money; services carry no budget', () => {
    const vm = build(viewers[0]!, 'overview');
    expect(vm.overview?.money).toEqual({ sellingTotal: '₹2,00,000.00', stillToPay: '₹1,50,000.00' });
    expect(vm.overview?.links).toEqual({ services: `/app/deals/${DEAL_ID}?tab=services`, money: `/app/deals/${DEAL_ID}?tab=money` });
    expect(vm.overview?.services).toEqual([{ itemNo: 1, title: 'Synthetic hotel 1', departmentLabel: 'Purchase', statusWord: 'In progress', done: false }]);
    expect(JSON.stringify(vm.overview?.services)).not.toMatch(/Budget|5000000/);
  });

  it('desk-only viewers are recognised by their roles; mixed roles are not desk-only', () => {
    expect(isDeskOnlyViewer(['purchase'])).toBe(true);
    expect(isDeskOnlyViewer(['flight', 'visa'])).toBe(true);
    expect(isDeskOnlyViewer(['purchase', 'sales'])).toBe(false);
    expect(isDeskOnlyViewer([])).toBe(false);
    expect(canListDealMessages('owner', ['purchase'])).toBe(false);
    expect(canListDealMessages('owner', ['sales'])).toBe(true);
    expect(canListDealMessages('assigned', ['sales'])).toBe(false);
    expect(canListDealMessages('scope', ['manager'])).toBe(true);
    expect(canListDealMessages('scope', ['accounts'])).toBe(true);
  });
});
