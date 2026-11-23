import type { Metadata } from 'next';
import { leadFilters, leadsFreshness, leadsListHref, listPager, parseLeadListFilter, parseListPage } from '@/modules/deals/list-model';
import { requireStaff } from '@/modules/identity/server/session';
import { loadLeads } from '@/modules/leads/server/queries';
import { searchLeadsAction } from '@/modules/search/server/actions';
import { LeadsListScreen, LeadsNoPermissionView } from '@/views/lead-views';

export const metadata: Metadata = { title: 'Leads' };

type LeadsSearchParams = { page?: string | string[]; filter?: string | string[]; mine?: string | string[] };

export default async function LeadsPage({ searchParams }: { searchParams: Promise<LeadsSearchParams> }) {
  const staff = await requireStaff();
  // LE-01: true pages (`?page=`) and the "Mine" chip (`?filter=mine`). Unknown values, and old
  // keyset links (`?after=`), show page 1 of All.
  const params = await searchParams;
  const filter = parseLeadListFilter(params);
  // Purchase holders get no lead data at all; the loader does not query for them (contract §1).
  const leads = await loadLeads(staff, { page: parseListPage(params.page), filter });
  if (leads === 'no_permission') return <LeadsNoPermissionView />;
  return (
    <LeadsListScreen
      rows={leads.items}
      filters={leadFilters(leads.counts, leads.filter)}
      freshness={leadsFreshness(leads.items)}
      pager={listPager({
        page: leads.page,
        pageSize: leads.pageSize,
        shown: leads.items.length,
        total: leads.total,
        href: (page) => leadsListHref(leads.filter, page),
      })}
      // DA-94a: only someone who may change the Bitrix names switch is told it is off (display hint; the database decides).
      namesSwitchable={staff.access.memberships.some((m) => m.roleCode === 'super_admin')}
      // Batch 5 (contracts.md §E): search across every Lead the person can see. The words go only
      // in the action's POST body, never in this page's address.
      search={searchLeadsAction}
    />
  );
}
