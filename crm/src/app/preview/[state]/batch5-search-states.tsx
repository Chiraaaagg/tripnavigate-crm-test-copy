import type { ReactNode } from 'react';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { DealsListScreen } from '@/views/deals-list-view';
import { LeadsListScreen, type LeadListRowVM } from '@/views/lead-views';
import { WorkflowNoPermissionView } from '@/views/workflow-views';
import { previewDealsProps, previewLeadsProps } from './batch1-fixtures';
import { PREVIEW_SEARCH_DEALS, PREVIEW_SEARCH_LEADS } from './batch5-search-fixtures';
import {
  previewSearchDealsAction,
  previewSearchDealsErrorAction,
  previewSearchDealsNotInstalledAction,
  previewSearchLeadsAction,
  previewSearchLeadsErrorAction,
  previewSearchLeadsMoreFailsAction,
  previewSearchLeadsNotAuthorizedAction,
  previewSearchLeadsNotInstalledAction,
  previewSearchLeadsSlowAction,
} from './batch5-search-preview-actions';
import { PreviewLiveIndicator } from './preview-live';
import { PreviewRefreshButton } from './preview-refresh';
import { SettingsShell } from './settings-preview-frame';
import type { DealListItem } from '@/modules/deals/dto';

/*
 * Batch 5 preview states: the Leads and Deals search box (contracts.md §E,
 * copy DA-300 to DA-319) with stand-in actions over a synthetic pool. The
 * list shows the first page of the pool; searching reaches all of it.
 * Synthetic props only; rendered by the design-review gallery (page.tsx),
 * never in production.
 */

const NOW = '2026-10-23T06:00:00Z';

const sales: ShellViewer = {
  displayName: 'Synthetic Sales Delhi A',
  primaryRole: 'Sales',
  primaryBranch: 'Delhi',
  canAdministerStaff: false,
  canManageGrants: false,
  canSeeLeads: true,
};

/** The list page shows the first 8 rows of the pool; 44 can be found. */
const LEAD_PAGE: LeadListRowVM[] = PREVIEW_SEARCH_LEADS.slice(0, 8);

/** The Deals list fixture takes the older list item; built from the same pool rows. */
const DEAL_PAGE: DealListItem[] = PREVIEW_SEARCH_DEALS.slice(0, 8).map((d): DealListItem => ({
  id: d.id,
  reference: d.reference,
  title: d.title,
  branchName: d.branchName,
  createdOn: d.details.createdOn,
  relation: d.details.relation,
  ownerName: d.owner.kind === 'colleague' ? (d.owner.displayName ?? null) : null,
  source: {
    system: 'bitrix',
    sourceDealId: d.details.sourceDealId!,
    stageId: d.stage!.code,
    stageLabel: d.stage!.name,
    lastVerifiedAt: d.details.lastCheckedAt!,
    lastSyncedAt: d.details.lastChangeAt!,
    stale: d.late,
  },
}));

type LeadAction = typeof previewSearchLeadsAction;
type DealAction = typeof previewSearchDealsAction;

function leads(action: LeadAction | undefined, extra: { rows?: LeadListRowVM[]; total?: number; filter?: 'all' | 'mine'; refresh?: boolean } = {}): ReactNode {
  const rows = extra.rows ?? LEAD_PAGE;
  const total = extra.total ?? (extra.filter === 'mine' ? 0 : 44);
  return (
    <StaffShell viewer={sales} currentPath="/app/leads">
      <LeadsListScreen {...previewLeadsProps({ rows, total, pageSize: 8, filter: extra.filter, mine: extra.filter === 'mine' ? 0 : undefined })} now={NOW} search={action} />
      {extra.refresh ? <PreviewRefreshButton /> : null}
    </StaffShell>
  );
}

function deals(action: DealAction | undefined, extra: { refresh?: boolean } = {}): ReactNode {
  return (
    <StaffShell viewer={sales} currentPath="/app/deals">
      <DealsListScreen {...previewDealsProps({ items: DEAL_PAGE, total: 44, pageSize: 8 })} live={<PreviewLiveIndicator />} now={NOW} search={action} />
      {extra.refresh ? <PreviewRefreshButton /> : null}
    </StaffShell>
  );
}

export function renderBatch5SearchState(state: string): ReactNode | null {
  switch (state) {
    case 'b5-leads-search':
      return leads(previewSearchLeadsAction, { refresh: true });
    case 'b5-leads-search-slow':
      return leads(previewSearchLeadsSlowAction);
    case 'b5-leads-search-more-fails':
      return leads(previewSearchLeadsMoreFailsAction);
    case 'b5-leads-search-not-installed':
      return leads(previewSearchLeadsNotInstalledAction);
    case 'b5-leads-search-not-authorized':
      return leads(previewSearchLeadsNotAuthorizedAction);
    case 'b5-leads-search-error':
      return leads(previewSearchLeadsErrorAction);
    case 'b5-leads-search-filter-empty':
      // "Mine" shows nothing on this page, but search still reaches every lead the person can see.
      return leads(previewSearchLeadsAction, { rows: [], filter: 'mine' });
    case 'b5-leads-search-nothing-visible':
      // The person can see no lead at all: no search box.
      return leads(previewSearchLeadsAction, { rows: [], total: 0 });
    case 'b5-leads-page-only':
      // No search action passed (older route): today's "Search this page".
      return leads(undefined);
    case 'b5-deals-search':
      return deals(previewSearchDealsAction, { refresh: true });
    case 'b5-deals-search-not-installed':
      return deals(previewSearchDealsNotInstalledAction);
    case 'b5-deals-search-error':
      return deals(previewSearchDealsErrorAction);
    case 'b5-features-no-permission-purchase':
      // N1: manages the Bitrix connection but also works in Purchase (not a Super Admin).
      return (
        <SettingsShell viewer={{ ...sales, displayName: 'Synthetic Purchase Jodhpur', primaryRole: 'Purchase', primaryBranch: 'Jodhpur', canSeeLeads: false, canSeePurchaseTasks: true }} currentPath="/app/admin/workflow">
          <WorkflowNoPermissionView reason="purchase" />
        </SettingsShell>
      );
    default:
      return null;
  }
}
