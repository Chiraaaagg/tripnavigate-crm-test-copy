import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewerAccess } from '@/modules/access/policy';
import type { DealDetail } from '@/modules/deals/dto';
import type { DealHeaderVM, DealWorkspaceVM } from '@/modules/deals/workspace-contract';

/**
 * Sync completion §3: "Came from Lead BXL-<id>" on the Deal page, matched only
 * by source portal + Bitrix LEAD_ID, read with the viewer's own client (RLS
 * decides), hidden for Purchase and whenever the Lead is not readable.
 */

const DEAL_ID = '00000000-0000-4000-8000-000000000001';
const LEAD_UUID = '00000000-0000-4000-8000-0000000000d1';
const PORTAL = 'synthetic-member-0001';

const sales: ViewerAccess = {
  userId: 'u-sales',
  memberships: [{ legalEntityId: 'e1', branchId: 'b1', roleCode: 'sales' }],
  rolePermissions: [],
  grants: [],
};
const purchase: ViewerAccess = {
  userId: 'u-purchase',
  memberships: [{ legalEntityId: 'e1', branchId: 'b1', roleCode: 'purchase' }],
  rolePermissions: [],
  grants: [],
};

type Answer = { data: unknown; error: unknown };

/** Records every filter; `answers[table]` is what maybeSingle resolves to. */
function fakeSupabase(answers: Partial<Record<'deals' | 'crm_leads', Answer | (() => never)>>) {
  const log: Array<{ table: string; select: string; filters: Array<[string, unknown]>; limit?: number }> = [];
  return {
    log,
    client: {
      from(table: 'deals' | 'crm_leads') {
        const entry: (typeof log)[number] = { table, select: '', filters: [] };
        log.push(entry);
        const chain = {
          select(columns: string) {
            entry.select = columns;
            return chain;
          },
          eq(column: string, value: unknown) {
            entry.filters.push([column, value]);
            return chain;
          },
          limit(n: number) {
            entry.limit = n;
            return chain;
          },
          async maybeSingle() {
            const answer = answers[table];
            if (typeof answer === 'function') return answer();
            return answer ?? { data: null, error: null };
          },
        };
        return chain;
      },
    },
  };
}

describe('loadDealLeadLink', () => {
  async function load(access: ViewerAccess, answers: Parameters<typeof fakeSupabase>[0]) {
    // The page tests below mock this module; the loader tests use the real one.
    const { loadDealLeadLink } = await vi.importActual<typeof import('@/modules/deals/server/lead-link')>(
      '@/modules/deals/server/lead-link',
    );
    const fake = fakeSupabase(answers);
    const link = await loadDealLeadLink({ access, supabase: fake.client as never }, DEAL_ID);
    return { link, log: fake.log };
  }

  it('links the Lead with the same portal and Bitrix LEAD_ID when the viewer can read it', async () => {
    const { link, log } = await load(sales, {
      deals: { data: { source_portal: PORTAL, source_lead_id: 501 }, error: null },
      crm_leads: { data: { id: LEAD_UUID }, error: null },
    });
    expect(link).toEqual({ href: `/app/leads/${LEAD_UUID}`, reference: 'BXL-501' });
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ table: 'deals', select: 'source_portal, source_lead_id', filters: [['id', DEAL_ID]] });
    // Matched only by identity: no title, name, phone or contact column anywhere.
    expect(log[1]).toEqual({
      table: 'crm_leads',
      select: 'id',
      filters: [
        ['source_system', 'bitrix'],
        ['source_portal', PORTAL],
        ['source_lead_id', '501'],
      ],
      limit: 1,
    });
  });

  it('shows nothing when RLS hides the Lead (no row) or the Lead is not in the CRM', async () => {
    const { link } = await load(sales, {
      deals: { data: { source_portal: PORTAL, source_lead_id: '501' }, error: null },
      crm_leads: { data: null, error: null },
    });
    expect(link).toBeNull();
  });

  it('a Deal without a Lead ID never queries crm_leads', async () => {
    const { link, log } = await load(sales, { deals: { data: { source_portal: PORTAL, source_lead_id: null }, error: null } });
    expect(link).toBeNull();
    expect(log.map((l) => l.table)).toEqual(['deals']);
  });

  it('a malformed Deal id (the raw URL segment) shows nothing without a query (speed plan C4)', async () => {
    const { loadDealLeadLink } = await vi.importActual<typeof import('@/modules/deals/server/lead-link')>(
      '@/modules/deals/server/lead-link',
    );
    for (const bad of ['nope', '', `${DEAL_ID}x`, "1' or '1'='1"]) {
      const fake = fakeSupabase({ deals: { data: { source_portal: PORTAL, source_lead_id: 501 }, error: null } });
      expect(await loadDealLeadLink({ access: sales, supabase: fake.client as never }, bad)).toBeNull();
      expect(fake.log).toEqual([]);
    }
  });

  it('Purchase is refused before any query', async () => {
    const { link, log } = await load(purchase, {
      deals: { data: { source_portal: PORTAL, source_lead_id: 501 }, error: null },
      crm_leads: { data: { id: LEAD_UUID }, error: null },
    });
    expect(link).toBeNull();
    expect(log).toEqual([]);
  });

  it('read errors (including a database without the column yet) show nothing and never throw', async () => {
    expect((await load(sales, { deals: { data: null, error: { code: '42703' } } })).link).toBeNull();
    expect(
      (
        await load(sales, {
          deals: { data: { source_portal: PORTAL, source_lead_id: 501 }, error: null },
          crm_leads: { data: null, error: { code: '42501' } },
        })
      ).link,
    ).toBeNull();
    expect(
      (
        await load(sales, {
          deals: () => {
            throw new Error('network');
          },
        })
      ).link,
    ).toBeNull();
  });
});

describe('Deal page and workspace view', () => {
  const requireStaff = vi.fn();
  const getVisibleDeal = vi.fn();
  const loadBookingForDeal = vi.fn();
  const loadDealLeadLink = vi.fn();

  vi.doMock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
  vi.doMock('@/modules/deals/server/queries', () => ({
    getVisibleDeal: (...a: unknown[]) => getVisibleDeal(...a),
    loadBitrixNameLookup: async () => ({ state: 'switched_off' }),
  }));
  vi.doMock('@/modules/deals/server/lead-link', () => ({ loadDealLeadLink: (...a: unknown[]) => loadDealLeadLink(...a) }));
  vi.doMock('@/modules/fulfilment/server/queries', () => ({ loadBookingForDeal: (...a: unknown[]) => loadBookingForDeal(...a) }));
  vi.doMock('@/lib/config', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/config')>()),
    getAppConfig: () => ({ supabaseUrl: 'http://127.0.0.1:54321', supabasePublishableKey: 'sb_publishable_test' }),
  }));

  const deal: DealDetail = {
    id: DEAL_ID,
    reference: 'BX-9411',
    title: 'Synthetic trip',
    branchName: 'Jodhpur',
    relation: 'owner',
    createdOn: '2026-10-06',
    assignments: [],
    commercial: { visible: false },
    commercialAbsence: 'withheld',
  };

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

  beforeEach(() => {
    vi.clearAllMocks();
    requireStaff.mockResolvedValue({ userId: 'u-sales', access: sales });
    getVisibleDeal.mockResolvedValue(deal);
    loadBookingForDeal.mockResolvedValue(null);
  });

  async function renderPage() {
    const { default: DealPage } = await import('@/app/app/deals/[id]/page');
    const { DealWorkspaceView } = await import('@/views/deal-workspace/workspace');
    const tree = (await DealPage({ params: Promise.resolve({ id: DEAL_ID }) })) as ReactNode;
    return find(tree, DealWorkspaceView);
  }

  function header(view: ReactElement<Record<string, unknown>> | null): DealHeaderVM {
    return (view?.props.workspace as DealWorkspaceVM).header;
  }

  it('passes the readable Lead link into the header model, and the view links it', async () => {
    loadDealLeadLink.mockResolvedValue({ href: `/app/leads/${LEAD_UUID}`, reference: 'BXL-501' });
    const view = await renderPage();
    expect(loadDealLeadLink).toHaveBeenCalledWith({ userId: 'u-sales', access: sales }, DEAL_ID);
    expect(header(view).leadLink).toEqual({ href: `/app/leads/${LEAD_UUID}`, reference: 'BXL-501' });
    const { DealWorkspaceView } = await import('@/views/deal-workspace/workspace');
    const html = renderToStaticMarkup(createElement(DealWorkspaceView, { workspace: view!.props.workspace as DealWorkspaceVM }));
    expect(html).toMatch(new RegExp(`<a [^>]*href="/app/leads/${LEAD_UUID}"[^>]*>[^<]*BXL-501`));
  });

  it('shows no Lead link when there is no readable Lead, or the lookup fails (Purchase is refused in the loader)', async () => {
    loadDealLeadLink.mockResolvedValue(null);
    expect(header(await renderPage())).not.toHaveProperty('leadLink');
    loadDealLeadLink.mockRejectedValue(new Error('read failed'));
    const view = await renderPage();
    expect(view).not.toBeNull();
    expect(header(view)).not.toHaveProperty('leadLink');
    const { DealWorkspaceView } = await import('@/views/deal-workspace/workspace');
    const html = renderToStaticMarkup(createElement(DealWorkspaceView, { workspace: view!.props.workspace as DealWorkspaceVM }));
    expect(html).not.toContain('/app/leads/');
    expect(html).not.toContain('BXL-');
  });
});
