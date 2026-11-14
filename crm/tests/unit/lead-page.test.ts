import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLeadWorkspace, leadOwnerVM, parseLeadTab, visibleLeadTabs, type LeadRecordInput } from '@/modules/leads/record';
import type { QuotationListView } from '@/modules/quotations/contracts';

/*
 * Batch 1 Lead record (LE-02, FP-014, FP-015): link tabs parsed on the server,
 * the Quotations tab only for quotation readers, hidden and missing Leads give
 * the same answer, and only the open tab's body is rendered. Synthetic data.
 */

const LEAD_ID = '00000000-0000-4000-8000-0000000000d1';

const lead: LeadRecordInput = {
  id: LEAD_ID,
  reference: 'BXL-501',
  title: 'Synthetic couple, Udaipur',
  branchName: 'Jodhpur',
  relation: 'owner',
  ownerName: 'Synthetic Sales',
  source: {
    sourceLeadId: '501',
    statusId: 'NEW',
    sourceCode: 'WEB',
    sourceCreatedAt: '2026-10-01T05:00:00Z',
    lastSyncedAt: '2026-10-18T05:00:00Z',
    lastVerifiedAt: '2026-10-19T05:00:00Z',
    stale: false,
  },
};

const list: QuotationListView = { subjectKind: 'lead', subjectId: LEAD_ID, quotations: [], canCreate: true };

describe('Lead record view model', () => {
  it('unknown, repeated or not-permitted ?tab values render Overview', () => {
    for (const raw of [undefined, '', 'nope', ['bitrix'], 1]) expect(parseLeadTab(raw)).toBe('overview');
    const noQuotes = visibleLeadTabs({ quotations: false });
    expect(noQuotes).toEqual(['overview', 'bitrix']);
    expect(parseLeadTab('quotations', noQuotes)).toBe('overview');
    expect(parseLeadTab('bitrix', noQuotes)).toBe('bitrix');
  });

  it('Quotations tab and "New quotation" only when the quotation list was readable', () => {
    const without = buildLeadWorkspace({ lead: { ...lead, relation: 'integration_admin' }, tab: 'quotations', quotations: null });
    expect(without.current).toBe('overview');
    expect(without.tabs.map((t) => t.label)).toEqual(['Overview', 'Bitrix details']);
    expect(without.header.canCreateQuotation).toBe(false);
    const withList = buildLeadWorkspace({ lead, tab: 'quotations', quotations: list });
    expect(withList.current).toBe('quotations');
    expect(withList.tabs.map((t) => t.label)).toEqual(['Overview', 'Quotations', 'Bitrix details']);
    expect(withList.tabs[1]).toEqual({ tab: 'quotations', label: 'Quotations', href: `/app/leads/${LEAD_ID}?tab=quotations`, current: true });
    expect(withList.header.canCreateQuotation).toBe(true);
    expect(buildLeadWorkspace({ lead, tab: undefined, quotations: { ...list, canCreate: false } }).header.canCreateQuotation).toBe(false);
  });

  it('header: status and source fall back while the name switch is off; Next names the owner', () => {
    const vm = buildLeadWorkspace({ lead, tab: undefined, quotations: null });
    expect(vm.header.status).toEqual({ code: 'NEW', name: null, labelState: 'switched_off' });
    expect(vm.header.owner).toEqual({ kind: 'you' });
    expect(vm.header.next).toEqual({ text: 'follow up in Bitrix', actor: 'You' });
    expect(vm.overview?.source).toEqual({ code: 'WEB', name: null, labelState: 'switched_off' });
    expect('bitrix' in vm).toBe(false);
  });

  it('a found name is shown; an unreadable list falls back', () => {
    const names = { state: 'on' as const, names: new Map([['STATUS\u0000NEW', { name: 'New lead', missing: false }]]) };
    expect(buildLeadWorkspace({ lead, tab: undefined, quotations: null, names }).header.status).toEqual({ code: 'NEW', name: 'New lead', labelState: 'named' });
    expect(buildLeadWorkspace({ lead, tab: undefined, quotations: null, names: { state: 'list_unreadable' } }).header.status.labelState).toBe('list_unreadable');
  });

  it('Bitrix details tab carries provenance and why the viewer sees it, no contact field', () => {
    const vm = buildLeadWorkspace({ lead: { ...lead, relation: 'branch_manager' }, tab: 'bitrix', quotations: null });
    expect(vm.bitrix).toMatchObject({ sourceLeadId: '501', lastCheckedAt: '2026-10-19T05:00:00Z', lastChangeAt: '2026-10-18T05:00:00Z', relation: 'branch_manager' });
    expect('overview' in vm).toBe(false);
    expect(JSON.stringify(vm)).not.toMatch(/phone|email|mobile|₹/i);
  });

  it('owner words: you, named colleague, unnamed colleague, waiting', () => {
    expect(leadOwnerVM({ relation: 'owner', ownerName: null })).toEqual({ kind: 'you' });
    expect(leadOwnerVM({ relation: 'branch_manager', ownerName: ' Synthetic Sales ' })).toEqual({ kind: 'colleague', displayName: 'Synthetic Sales' });
    expect(leadOwnerVM({ relation: 'branch_manager', ownerName: null })).toEqual({ kind: 'colleague' });
    expect(leadOwnerVM({ relation: 'branch_manager', ownerName: null, ownerState: 'waiting' })).toEqual({ kind: 'waiting' });
    const waiting = buildLeadWorkspace({ lead: { ...lead, relation: 'branch_manager', ownerName: null, ownerState: 'waiting' }, tab: undefined, quotations: null });
    expect(waiting.header.next).toEqual({ text: 'follow up in Bitrix' });
    expect(buildLeadWorkspace({ lead: { ...lead, relation: 'branch_manager', ownerName: null }, tab: undefined, quotations: null }).header.next.actor).toBe('Another staff member');
  });
});

describe('Lead page route', () => {
  const requireStaff = vi.fn();
  const loadLead = vi.fn();
  const loadQuotationsForLead = vi.fn();
  const loadBitrixNameLookup = vi.fn();

  vi.doMock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
  vi.doMock('@/modules/leads/server/queries', () => ({ loadLead: (...a: unknown[]) => loadLead(...a) }));
  vi.doMock('@/modules/deals/server/queries', () => ({ loadBitrixNameLookup: (...a: unknown[]) => loadBitrixNameLookup(...a) }));
  vi.doMock('@/modules/quotations/server/queries', () => ({
    QUOTATIONS_NOT_INSTALLED: 'not_installed',
    loadQuotationsForLead: (...a: unknown[]) => loadQuotationsForLead(...a),
  }));

  async function render(tab?: string) {
    const { default: LeadPage } = await import('@/app/app/leads/[id]/page');
    return (await LeadPage({ params: Promise.resolve({ id: LEAD_ID }), searchParams: Promise.resolve(tab === undefined ? {} : { tab }) })) as ReactNode;
  }

  function el(node: ReactNode): ReactElement<Record<string, unknown>> {
    if (!isValidElement<Record<string, unknown>>(node)) throw new Error('expected an element');
    return node;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    requireStaff.mockResolvedValue({ userId: 'u-sales' });
    loadLead.mockResolvedValue(lead);
    loadQuotationsForLead.mockResolvedValue(list);
    loadBitrixNameLookup.mockResolvedValue({ state: 'switched_off' });
  });

  it('starts the quotation read together with the Lead read', async () => {
    const order: string[] = [];
    loadLead.mockImplementation(async () => {
      order.push('lead');
      return lead;
    });
    loadQuotationsForLead.mockImplementation(async () => {
      order.push('quotations');
      return list;
    });
    await render();
    expect(order).toEqual(['quotations', 'lead']);
  });

  it('a hidden or missing Lead shows the same not-found view, even when quotations would load', async () => {
    const { LeadNotFoundView, LeadsNoPermissionView } = await import('@/views/lead-views');
    loadLead.mockResolvedValue(null);
    expect(el(await render('quotations')).type).toBe(LeadNotFoundView);
    loadLead.mockResolvedValue('no_permission');
    expect(el(await render()).type).toBe(LeadsNoPermissionView);
  });

  it('renders the quotation card only when the Quotations tab is open', async () => {
    const { LeadWorkspaceView } = await import('@/views/lead-views');
    const { SubjectQuotationsCard } = await import('@/views/b12/quote-page');
    const overview = el(await render());
    expect(overview.type).toBe(LeadWorkspaceView);
    expect(overview.props.quotationsTab).toBeUndefined();
    const quotes = el(await render('quotations'));
    expect((quotes.props.workspace as { current: string }).current).toBe('quotations');
    expect(el(quotes.props.quotationsTab as ReactNode).type).toBe(SubjectQuotationsCard);
  });

  it('a failed or not-installed quotation read hides the tab and never hides the Lead', async () => {
    for (const answer of [() => Promise.reject(new Error('read failed')), () => Promise.resolve('not_installed'), () => Promise.resolve(null)]) {
      loadQuotationsForLead.mockImplementation(answer);
      const page = el(await render('quotations'));
      const ws = page.props.workspace as { current: string; tabs: Array<{ tab: string }>; header: { canCreateQuotation: boolean } };
      expect(ws.current).toBe('overview');
      expect(ws.tabs.map((t) => t.tab)).toEqual(['overview', 'bitrix']);
      expect(ws.header.canCreateQuotation).toBe(false);
      expect(page.props.quotationsTab).toBeUndefined();
    }
  });

  it('a Lead waiting for an owner shows "waiting" in the header and names nobody', async () => {
    loadLead.mockResolvedValue({ ...lead, relation: 'branch_manager', ownerName: null, ownerState: 'waiting' });
    const ws = el(await render()).props.workspace as { header: { owner: unknown; next: unknown } };
    expect(ws.header.owner).toEqual({ kind: 'waiting' });
    expect(ws.header.next).toEqual({ text: 'follow up in Bitrix' });
  });

  it('a failed name read falls back to the code wording', async () => {
    loadBitrixNameLookup.mockRejectedValue(new Error('down'));
    const ws = el(await render()).props.workspace as { header: { status: { labelState: string } } };
    expect(ws.header.status.labelState).toBe('list_unreadable');
  });
});
