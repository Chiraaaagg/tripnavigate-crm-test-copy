import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DealDetail } from '@/modules/deals/dto';
import type { DealWorkspaceVM } from '@/modules/deals/workspace-contract';

const requireStaff = vi.fn();
const getVisibleDeal = vi.fn();
const loadBookingForDeal = vi.fn();
const loadBookNow = vi.fn();
const loadDealServices = vi.fn();
const loadWorkflowSettings = vi.fn();
const loadDealDocuments = vi.fn();

vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('@/modules/deals/server/queries', () => ({
  getVisibleDeal: (...a: unknown[]) => getVisibleDeal(...a),
  loadBitrixNameLookup: async () => ({ state: 'switched_off' }),
}));
vi.mock('@/modules/deals/server/documents', () => ({ loadDealDocuments: (...a: unknown[]) => loadDealDocuments(...a) }));
vi.mock('@/modules/fulfilment/server/queries', () => ({
  loadBookingForDeal: (...a: unknown[]) => loadBookingForDeal(...a),
}));
vi.mock('@/modules/fulfilment/server/intake', () => ({
  loadDealServices: (...a: unknown[]) => loadDealServices(...a),
  loadWorkflowSettings: (...a: unknown[]) => loadWorkflowSettings(...a),
}));
vi.mock('@/modules/fulfilment/server/book-now', () => ({
  BOOK_NOW_NOT_INSTALLED: 'not_installed',
  loadBookNow: (...a: unknown[]) => loadBookNow(...a),
}));
vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  getAppConfig: () => ({ supabaseUrl: 'http://127.0.0.1:54321', supabasePublishableKey: 'sb_publishable_test' }),
}));

const { default: DealPage } = await import('@/app/app/deals/[id]/page');
const { DealWorkspaceView } = await import('@/views/deal-workspace/workspace');
const { HotelBookingPanel, HotelBookingUnavailable } = await import('@/views/booking-views');
const { LiveDealsRefresh } = await import('@/components/LiveDealsRefresh');
const { DealBookingUnavailable, DealBookNowCard } = await import('@/views/b11/book-views');
const { StartBookNowForm } = await import('@/views/b11/book-entry-forms');

const DEAL_ID = '00000000-0000-4000-8000-000000000001';

const salesDeal: DealDetail = {
  id: DEAL_ID,
  reference: 'BX-9411',
  title: 'Synthetic trip',
  branchName: 'Jodhpur',
  relation: 'owner',
  createdOn: '2026-10-06',
  assignments: [],
  commercial: { visible: true, currency: 'INR', sellingTotal: '₹1,23,456.00', estimatedMargin: '₹11,111.00' },
};
const purchaseDeal: DealDetail = { ...salesDeal, relation: 'assigned', commercial: { visible: false }, commercialAbsence: 'withheld' };

function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return null;
  if (node.type === type) return node;
  return find(node.props.children as ReactNode, type);
}

async function render(tab?: string) {
  const tree = (await DealPage({
    params: Promise.resolve({ id: DEAL_ID }),
    searchParams: Promise.resolve(tab === undefined ? {} : { tab }),
  })) as ReactNode;
  const view = find(tree, DealWorkspaceView);
  if (!view) throw new Error('expected the workspace view');
  return { view, workspace: view.props.workspace as DealWorkspaceVM };
}

describe('deal workspace page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireStaff.mockResolvedValue({ userId: 'u1' });
    getVisibleDeal.mockResolvedValue(salesDeal);
    // B1.1 Book now read: null = not an editor/acceptor (the legacy panel rules apply).
    loadBookNow.mockResolvedValue(null);
    loadBookingForDeal.mockResolvedValue(null);
    loadDealServices.mockResolvedValue(null);
    loadWorkflowSettings.mockResolvedValue({ serviceItemsEnabled: false });
    loadDealDocuments.mockResolvedValue({ state: 'ok', files: [] });
  });

  it('passes only view models and server-rendered slots to the view (never BookNowView or DealDetail)', async () => {
    const { view } = await render();
    expect(Object.keys(view.props).sort()).toEqual(['live', 'quotationsTab', 'servicesTab', 'startBookingForm', 'workspace']);
    expect(view.props).not.toHaveProperty('deal');
    expect(view.props).not.toHaveProperty('booking');
  });

  it('Overview by default: no services or quotation body is rendered, and the settings read is not made', async () => {
    const { view, workspace } = await render();
    expect(workspace.current).toBe('overview');
    expect(view.props.servicesTab).toBeUndefined();
    expect(view.props.quotationsTab).toBeUndefined();
    expect(loadWorkflowSettings).not.toHaveBeenCalled();
  });

  it('Services tab: loads the hotel booking for a visible deal and places the legacy panel', async () => {
    loadBookingForDeal.mockResolvedValue({ synthetic: true });
    const { view, workspace } = await render('services');
    expect(loadBookingForDeal).toHaveBeenCalledWith({ userId: 'u1' }, DEAL_ID);
    expect(loadWorkflowSettings).toHaveBeenCalled();
    expect(workspace.current).toBe('services');
    expect(find(view.props.servicesTab as ReactNode, HotelBookingPanel)).not.toBeNull();
    expect(workspace.header.status?.word).toBe('Hotel booking');
    expect(workspace.header.primary).toMatchObject({ kind: 'open_hotel_booking', href: `/app/deals/${DEAL_ID}?tab=services#hotel-booking` });
  });

  it('shows the unavailable panel (not "no booking") when the booking read fails', async () => {
    loadBookingForDeal.mockRejectedValue(new Error('read failed'));
    const { view, workspace } = await render('services');
    expect(find(view.props.servicesTab as ReactNode, HotelBookingUnavailable)).not.toBeNull();
    expect(workspace.header.status?.word).toBe('Could not load');
  });

  it('B1.1: a failed Book now read shows "could not be loaded", never the legacy hotel panel or "Not started"', async () => {
    loadBookingForDeal.mockResolvedValue({ synthetic: true });
    loadBookNow.mockRejectedValue(new Error('read failed'));
    const { view, workspace } = await render('services');
    expect(find(view.props.servicesTab as ReactNode, DealBookingUnavailable)).not.toBeNull();
    expect(find(view.props.servicesTab as ReactNode, HotelBookingPanel)).toBeNull();
    expect(workspace.header.status).toEqual({ state: 'could_not_load', word: 'Could not load' });
    expect(workspace.header.primary).toBeNull();
    expect(workspace.history).toBeUndefined();
    expect((await render('history')).workspace.history).toEqual({ state: 'error' });
  });

  it('places the live-update indicator for this one deal', async () => {
    const live = (await render()).view.props.live as ReactElement<Record<string, unknown>> | undefined;
    expect(live?.type).toBe(LiveDealsRefresh);
    expect(live?.props).toEqual({
      supabaseUrl: 'http://127.0.0.1:54321',
      supabasePublishableKey: 'sb_publishable_test',
      dealId: DEAL_ID,
    });
  });

  it('shows no panel and no primary when the viewer has no booking view', async () => {
    const { view, workspace } = await render('services');
    expect(find(view.props.servicesTab as ReactNode, HotelBookingPanel)).toBeNull();
    expect(workspace.header.primary).toBeNull();
    expect(view.props.startBookingForm).toBeUndefined();
  });

  it('DA-20: the header primary is the existing Start booking server-action form', async () => {
    loadBookNow.mockResolvedValue({
      dealId: DEAL_ID,
      stage: null,
      dealNotActive: false,
      serviceItemsEnabled: true,
      version: null,
      canEdit: true,
      checklist: [],
      items: [],
      progress: { total: 0, byState: { planned: 0, notStarted: 0, inProgress: 0, supplierConfirmed: 0 }, fulfilled: false, staleCount: 0, needs: [] },
      accountsReview: null,
    });
    const { view, workspace } = await render();
    expect(workspace.header.primary).toEqual({ kind: 'start_booking', label: 'Start booking' });
    const form = view.props.startBookingForm as ReactElement<Record<string, unknown>>;
    expect(form.type).toBe(StartBookNowForm);
    expect(form.props).toMatchObject({ dealId: DEAL_ID, label: 'Start booking', continueHref: `/app/deals/${DEAL_ID}/book/travellers` });
  });

  it('Purchase: ?tab=money renders Overview, no Money tab, and no amount anywhere in the props', async () => {
    getVisibleDeal.mockResolvedValue(purchaseDeal);
    const { view, workspace } = await render('money');
    expect(workspace.current).toBe('overview');
    expect(workspace.tabs.map((t) => t.tab)).not.toContain('money');
    expect(workspace).not.toHaveProperty('money');
    expect(JSON.stringify(workspace)).not.toMatch(/₹|selling|margin/i);
    expect(view.props.servicesTab).toBeUndefined();
  });

  it('Sales price reader: Money appears only on the Money tab', async () => {
    expect((await render()).workspace).not.toHaveProperty('money');
    const { workspace } = await render('money');
    expect(workspace.current).toBe('money');
    expect(workspace.money?.dealValue).toEqual({ state: 'shown', sellingTotal: '₹1,23,456.00', estimatedMargin: '₹11,111.00' });
    expect(JSON.stringify(workspace.header)).not.toContain('₹');
  });

  it('Documents: listed, but read only when its tab is open; rows and links pass through unchanged', async () => {
    const { workspace } = await render();
    expect(workspace.tabs.map((t) => t.tab)).toContain('documents');
    expect(loadDealDocuments).not.toHaveBeenCalled();
    const row = { kind: 'id_proof', id: 'f1', fileName: 'id.jpg', mime: 'image/jpeg', uploadedAt: '2026-10-10T00:00:00Z', context: { travellerSeq: 1 }, href: '/app/id-proofs/f1' };
    loadDealDocuments.mockResolvedValue({ state: 'ok', files: [row] });
    const docs = await render('documents');
    expect(loadDealDocuments).toHaveBeenCalledTimes(1);
    expect(loadDealDocuments).toHaveBeenCalledWith({ userId: 'u1' }, DEAL_ID);
    expect(docs.workspace.current).toBe('documents');
    expect(docs.workspace.documents).toEqual({ state: 'ok', rows: [row] });
  });

  it('Documents: a failed read is "could not be loaded"; a database without the read hides the tab', async () => {
    loadDealDocuments.mockResolvedValue({ state: 'error' });
    expect((await render('documents')).workspace.documents).toEqual({ state: 'error' });
    loadDealDocuments.mockResolvedValue({ state: 'not_installed' });
    const old = await render('documents');
    expect(old.workspace.current).toBe('overview');
    expect(old.workspace.tabs.map((t) => t.tab)).not.toContain('documents');
    expect(old.workspace).not.toHaveProperty('documents');
  });

  it('Purchase: Documents shows only what the read returned for them, and no money', async () => {
    getVisibleDeal.mockResolvedValue(purchaseDeal);
    loadDealDocuments.mockResolvedValue({ state: 'ok', files: [] });
    const { workspace } = await render('documents');
    expect(workspace.documents).toEqual({ state: 'ok', rows: [] });
    expect(JSON.stringify(workspace)).not.toMatch(/₹|selling|margin/i);
  });

  describe('one start or continue control on any tab (lead ruling 3)', () => {
    const progress0 = { total: 0, byState: { planned: 0, notStarted: 0, inProgress: 0, supplierConfirmed: 0 }, fulfilled: false, staleCount: 0, needs: [] };
    const base = { dealId: DEAL_ID, stage: null, dealNotActive: false, serviceItemsEnabled: true, canEdit: true, canOpenRevision: true, items: [], progress: progress0, accountsReview: null };
    const draft = { versionId: 'v1', versionNo: 1, status: 'draft', serviceType: 'package', savedAt: null, savedByName: null, revisesVersionId: null };
    const scenarios: Array<[string, Record<string, unknown>]> = [
      ['not started (DA-20)', { ...base, version: null, checklist: [] }],
      ['draft with things to finish (DA-23)', { ...base, version: draft, checklist: [{ blocking: true }] }],
      ['draft ready (DA-24)', { ...base, version: draft, checklist: [] }],
      ['returned (DA-26)', { ...base, version: { ...draft, status: 'confirmed' }, checklist: [], accountsReview: { status: 'returned', reviewedAt: null, reason: null, reasonHidden: true } }],
    ];

    function controls(view: ReactElement<Record<string, unknown>>, workspace: DealWorkspaceVM): number {
      const kinds = ['start_booking', 'start_from_quotation', 'continue_booking', 'review_and_submit', 'fix_and_send_again'];
      const header = kinds.includes(workspace.header.primary?.kind ?? '') ? 1 : 0;
      let body = 0;
      for (const slot of [view.props.servicesTab, view.props.quotationsTab] as ReactNode[]) {
        if (find(slot, StartBookNowForm)) body += 1;
        if (find(slot, DealBookNowCard)) body += 1;
      }
      return header + body;
    }

    for (const [name, bookNow] of scenarios) {
      it(`${name}: exactly one, in the header, on every tab`, async () => {
        loadBookNow.mockResolvedValue(bookNow);
        for (const tab of [undefined, 'services', 'quotations', 'money', 'history', 'documents']) {
          const { view, workspace } = await render(tab);
          expect(controls(view, workspace), `tab ${tab ?? 'overview'}`).toBe(1);
        }
      });
    }

    it('a viewer who may not start still sees the booking card (no start control) on the Services tab', async () => {
      loadBookNow.mockResolvedValue({ ...base, canEdit: false, version: null, checklist: [] });
      const { view, workspace } = await render('services');
      expect(workspace.header.primary).toBeNull();
      const card = find(view.props.servicesTab as ReactNode, DealBookNowCard);
      expect(card).not.toBeNull();
      expect(card?.props).not.toHaveProperty('startForm');
      expect(find(view.props.servicesTab as ReactNode, StartBookNowForm)).toBeNull();
    });
  });

  it('Purchase without a readable booking: no status word and "see Services and tasks"', async () => {
    getVisibleDeal.mockResolvedValue(purchaseDeal);
    const { workspace } = await render();
    expect(workspace.header).not.toHaveProperty('status');
    expect(workspace.header.next).toEqual({ text: 'see Services and tasks' });
    expect(workspace.header.primary).toBeNull();
  });

  it('Purchase assignee: header shows their own task word, never "Being arranged"', async () => {
    getVisibleDeal.mockResolvedValue(purchaseDeal);
    loadDealServices.mockResolvedValue({
      dealId: DEAL_ID,
      version: { versionId: 'v1', versionNo: 1, status: 'confirmed', rowVersion: 1, contentHash: 'h', serviceType: 'package' },
      items: [{ itemNo: 1, department: 'purchase', state: 'active', task: { taskId: 't1', status: 'not_started', assignedToYou: true } }],
      progress: { total: 1, byState: { planned: 0, notStarted: 1, inProgress: 0, supplierConfirmed: 0 }, fulfilled: false, staleCount: 0, needs: [] },
      canEdit: false,
      canConfirm: false,
    });
    const { workspace } = await render();
    expect(workspace.header.status).toEqual({ state: 'own_task', word: 'Waiting to be taken' });
    expect(workspace.header.primary).toMatchObject({ kind: 'see_team_tasks' });
  });
});
