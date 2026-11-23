import type { Metadata } from 'next';
import { recordsFilterToParams } from '@/modules/accounts-desk/filters';
import { loadDailyCheck, loadFilterOptions, loadRecords, loadRecordsTotals } from '@/modules/accounts-desk/server/queries';
import { linkSupplierDocumentAction, matchTallyRecordAction, raiseTallyExceptionAction, reopenTallyRecordAction } from '@/modules/accounts-desk/server/actions';
import { SectionTabs } from '@/components/ui/section-tabs';
import { requireStaff } from '@/modules/identity/server/session';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { parseRecordsFilter, readCursor, RECORDS_PATH, wantsTotals } from '@/views/accounts-desk/address';
import { RecordsNoAccess, RecordsWorkspace } from '@/views/accounts-desk/records';
import type { LoadMoreAction } from '@/views/accounts-desk/records-table';
import { loadLinkTargetsAction, loadMoreRecordsAction } from './actions';
import { branchChoices, deskViewerOf, supplierChoices } from './desk-glue';
import { accountsSectionViewer } from '../section-viewer';

export const metadata: Metadata = { title: 'Documents and money' };

const act = (a: unknown) => a as DecisionAction;

/**
 * Accounts › Documents and money (contract 8.1, 11.1). accounts_records
 * decides who reads (Accounts of the company with actions; a branch Manager
 * view only; everyone else null) and every row. Filters live in the address;
 * totals are read only on "Show totals"; the daily check is Accounts only.
 */
export default async function RecordsRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const filter = parseRecordsFilter(sp);
  const after = readCursor(sp);
  const [res, daily, totals, options, sectionViewer] = await Promise.all([
    loadRecords(staff, filter, after),
    loadDailyCheck(staff).catch(() => 'error' as const),
    wantsTotals(sp) ? loadRecordsTotals(staff, filter).then((t) => (t.ok ? t.data : ('error' as const)), () => 'error' as const) : Promise.resolve(undefined),
    // Addendum B2: supplier and branch choices for the filters (ids and names only); a failure falls back to the rows shown.
    loadFilterOptions(staff).catch(() => null),
    accountsSectionViewer(staff),
  ]);
  if (res.ok && res.data === null) return <RecordsNoAccess />;
  const page = res.ok ? res.data! : null;
  const mode = page?.scope.mode ?? (staff.memberships.some((m) => m.roleCode === 'accounts') ? 'accounts' : 'manager');
  const query = recordsFilterToParams(filter).toString();
  return (
    <RecordsWorkspace
      viewer={deskViewerOf(staff, mode)}
      filter={filter}
      page={page ?? 'error'}
      invalidField={res.ok ? undefined : res.invalid}
      totals={totals}
      daily={mode === 'accounts' ? daily : null}
      suppliers={options ? options.suppliers.map((s) => ({ id: s.supplierId, name: s.name })) : supplierChoices(page?.items ?? [], filter.supplierId)}
      branches={options ? options.branches.map((b) => ({ id: b.branchId, name: b.name })) : branchChoices(staff, mode === 'accounts' ? 'accounts' : 'manager')}
      actions={
        mode === 'accounts'
          ? { match: act(matchTallyRecordAction), exception: act(raiseTallyExceptionAction), reopen: act(reopenTallyRecordAction), linkTask: act(linkSupplierDocumentAction) }
          : null
      }
      loadMore={loadMoreRecordsAction.bind(null, query) as LoadMoreAction}
      after={after}
      loadLinkTargets={mode === 'accounts' ? loadLinkTargetsAction : undefined}
      sectionTabs={<SectionTabs section="records" currentHref={RECORDS_PATH} viewer={sectionViewer} />}
    />
  );
}
