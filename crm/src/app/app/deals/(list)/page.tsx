import type { Metadata } from 'next';
import { LiveDealsRefresh } from '@/components/LiveDealsRefresh';
import { getAppConfig } from '@/lib/config';
import {
  dealFilters,
  dealsEmptyFor,
  dealsFreshness,
  dealSortLinks,
  dealsListHref,
  listPager,
  parseDealListFilter,
  toDealListRow,
} from '@/modules/deals/list-model';
import { loadBitrixNameLookup, loadDealsPage, parsePage, parseSort } from '@/modules/deals/server/queries';
import { loadDealServiceSummaries } from '@/modules/fulfilment/server/intake';
import { requireStaff } from '@/modules/identity/server/session';
import { searchDealsAction } from '@/modules/search/server/actions';
import { DealsListScreen } from '@/views/deals-list-view';

export const metadata: Metadata = { title: 'Deals' };

type DealsSearchParams = { page?: string | string[]; sort?: string | string[]; filter?: string | string[] };

export default async function DealsPage({ searchParams }: { searchParams: Promise<DealsSearchParams> }) {
  const { page, sort, filter: rawFilter } = await searchParams;
  const staff = await requireStaff();
  const config = getAppConfig();
  const filter = parseDealListFilter(rawFilter);
  // The shared count (same query as Home and the Bitrix sync page) is the All chip; the
  // Owned and Assigned chips are exact server filters. Counts and the page are read
  // together (speed plan C3).
  const [{ total, counts, list }, names] = await Promise.all([
    loadDealsPage(staff, parsePage(page), parseSort(sort), filter),
    loadBitrixNameLookup(staff),
  ]);
  // B1: sold services and progress per deal (read-only projection). When it fails the list
  // still shows, without those two columns and with a one-line notice.
  const services = await loadDealServiceSummaries(
    staff,
    list.items.map((d) => d.id),
  ).catch(() => null);
  const rows = list.items.map((d) => toDealListRow(d, names));
  return (
    <DealsListScreen
      rows={rows}
      filters={dealFilters(counts, filter, list.sort)}
      freshness={dealsFreshness(rows)}
      pager={listPager({
        page: list.page,
        pageSize: list.pageSize,
        shown: rows.length,
        total,
        href: (p) => dealsListHref(filter, p, list.sort),
      })}
      sort={dealSortLinks(filter, list.sort)}
      // DA-94a: only someone who may change the Bitrix names switch is told it is off (display hint; the database decides).
      namesSwitchable={staff.access.memberships.some((m) => m.roleCode === 'super_admin')}
      services={services}
      live={<LiveDealsRefresh supabaseUrl={config.supabaseUrl} supabasePublishableKey={config.supabasePublishableKey} />}
      emptyFor={dealsEmptyFor(staff.access)}
      // Batch 5 (contracts.md §E): search across every Deal the person can see. The words go only
      // in the action's POST body, never in this page's address.
      search={searchDealsAction}
    />
  );
}
