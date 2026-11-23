import type { ViewerAccess } from '@/modules/access/policy';
import { type LeadRow, leadRelation, toLeadSourceView } from '@/modules/leads/dto';
import type { DealListItem, ViewerRelation } from './dto';
import type {
  BitrixNameVM,
  DealListFilter,
  LeadListFilter,
  ListFiltersVM,
  ListFreshnessVM,
  ListPagerVM,
  RecordOwnerVM,
} from './workspace-contract';

/*
 * Batch 1 list models (LE-01 Leads list, DE-01 Deals list). Pure functions:
 * no database, no React. The routes call the loaders in
 * src/modules/{leads,deals}/server/queries.ts and turn their results into the
 * view models of the frozen contract (workspace-contract.ts) with these helpers.
 *
 * The row models below are structural copies of LeadListRowVM and
 * DealListRowVM (declared by the UI in src/views). Modules never import from
 * views, so the shapes are repeated here and stay assignable; a drift breaks
 * the route's typecheck.
 *
 * Rules: counts are exact over every record the viewer can see (never this
 * page) and null when they could not be read (never 0); every count names its
 * scope; freshness comes from the rows shown (lead decision 2); hrefs keep the
 * filter and order and reset the page where the filter or order changes.
 */

// ---------------------------------------------------------------------------
// Query string
// ---------------------------------------------------------------------------

export const LEADS_PATH = '/app/leads';
export const DEALS_PATH = '/app/deals';

export type DealListSort = 'id_desc' | 'id_asc';

function single(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

/** `?page=` (1-based, at most six digits); anything else is page 1. */
export function parseListPage(raw: unknown): number {
  const value = single(raw);
  return value !== undefined && /^[1-9][0-9]{0,5}$/.test(value) ? Number(value) : 1;
}

/**
 * Leads filter from `?filter=mine` (the canonical address) or a bare `?mine`
 * / `?mine=1`. Anything else, including an old `?after=` keyset link, is All.
 */
export function parseLeadListFilter(params: { filter?: unknown; mine?: unknown }): LeadListFilter {
  if (single(params.filter) === 'mine') return 'mine';
  const mine = single(params.mine);
  return mine === '' || mine === '1' || mine === 'true' ? 'mine' : 'all';
}

/** Deals filter from `?filter=owned|assigned`; anything else is All. */
export function parseDealListFilter(raw: unknown): DealListFilter {
  const value = single(raw);
  return value === 'owned' || value === 'assigned' ? value : 'all';
}

/** `/app/leads` with the filter and page (defaults left out). */
export function leadsListHref(filter: LeadListFilter, page = 1): string {
  const q = new URLSearchParams();
  if (filter !== 'all') q.set('filter', filter);
  if (page > 1) q.set('page', String(page));
  const qs = q.toString();
  return qs ? `${LEADS_PATH}?${qs}` : LEADS_PATH;
}

/**
 * `/app/deals` with order, filter and page (defaults left out). With the
 * default filter the address equals today's `dealsHref(page, sort)`.
 */
export function dealsListHref(filter: DealListFilter, page = 1, sort: DealListSort = 'id_desc'): string {
  const q = new URLSearchParams();
  if (sort === 'id_asc') q.set('sort', sort);
  if (filter !== 'all') q.set('filter', filter);
  if (page > 1) q.set('page', String(page));
  const qs = q.toString();
  return qs ? `${DEALS_PATH}?${qs}` : DEALS_PATH;
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/** Last 1-based page for an exact total (at least 1). */
export function lastPage(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Requested page clamped to [1, last page]; an unknown total clamps only below. */
export function clampPage(page: number, total: number | null, pageSize: number): number {
  const low = Math.max(1, page);
  return total === null ? low : Math.min(low, lastPage(total, pageSize));
}

/**
 * "1–25 of N" pager. With an unknown total, Next is offered only when this page
 * is full (the screen shows the range without "of N").
 */
export function listPager(input: {
  page: number;
  pageSize: number;
  shown: number;
  total: number | null;
  href: (page: number) => string;
}): ListPagerVM {
  const { page, pageSize, shown, total, href } = input;
  const offset = (page - 1) * pageSize;
  const hasNext = total === null ? shown === pageSize : offset + shown < total;
  return {
    from: shown === 0 ? 0 : offset + 1,
    to: offset + shown,
    total,
    previousHref: page > 1 ? href(page - 1) : null,
    nextHref: hasNext ? href(page + 1) : null,
  };
}

// ---------------------------------------------------------------------------
// Filter chips (batch-1-backend-contract §3)
// ---------------------------------------------------------------------------

export const LEAD_FILTER_LABEL: Record<LeadListFilter, string> = {
  all: 'All leads you can see',
  mine: 'Mine',
};

export const DEAL_FILTER_LABEL: Record<DealListFilter, string> = {
  all: 'All deals you can see',
  owned: 'Owned by you',
  // DA-132: "Assigned to you"; the screen adds ", owned by someone else" for screen readers.
  assigned: 'Assigned to you',
};

/** DA-132: one small line on the chip row. */
export const LEAD_COUNT_SCOPE = 'Counts include all pages.';
export const DEAL_COUNT_SCOPE = 'Counts include all pages.';

/** Chips All / Mine. Labels carry no number: the screen adds `({count})`, or "count unavailable" for null. */
export function leadFilters(counts: Record<LeadListFilter, number | null>, current: LeadListFilter): ListFiltersVM<LeadListFilter> {
  const order: LeadListFilter[] = ['all', 'mine'];
  return {
    chips: order.map((filter) => ({
      filter,
      label: LEAD_FILTER_LABEL[filter],
      count: counts[filter],
      href: leadsListHref(filter, 1),
      current: filter === current,
    })),
    scopeText: LEAD_COUNT_SCOPE,
  };
}

/** Chips All (countVisibleDeals) / Owned by you / Assigned to you, owned by someone else. Owned and assigned are disjoint. */
export function dealFilters(
  counts: Record<DealListFilter, number | null>,
  current: DealListFilter,
  sort: DealListSort = 'id_desc',
): ListFiltersVM<DealListFilter> {
  const order: DealListFilter[] = ['all', 'owned', 'assigned'];
  return {
    chips: order.map((filter) => ({
      filter,
      label: DEAL_FILTER_LABEL[filter],
      count: counts[filter],
      href: dealsListHref(filter, 1, sort),
      current: filter === current,
    })),
    scopeText: DEAL_COUNT_SCOPE,
  };
}

/** "Newest first" / "Oldest first" links: page reset to 1, filter kept. */
export function dealSortLinks(filter: DealListFilter, current: DealListSort): { current: DealListSort; newestHref: string; oldestHref: string } {
  return { current, newestHref: dealsListHref(filter, 1, 'id_desc'), oldestHref: dealsListHref(filter, 1, 'id_asc') };
}

// ---------------------------------------------------------------------------
// Freshness (DA-45, lead decision 2)
// ---------------------------------------------------------------------------

export interface FreshnessInput {
  /** Absent for a CRM-native or synthetic row (no Bitrix source). */
  lastCheckedAt?: string | null;
  late: boolean;
  bitrix: boolean;
}

/**
 * The oldest last-checked time among the Bitrix rows shown, and whether any
 * shown row is late. "Unknown" when the page has no Bitrix rows or any Bitrix
 * row lacks a readable time (the oldest cannot then be named honestly).
 */
export function listFreshness(rows: FreshnessInput[]): ListFreshnessVM {
  const bitrix = rows.filter((r) => r.bitrix);
  if (bitrix.length === 0) return { state: 'unknown' };
  let oldest: { iso: string; ms: number } | null = null;
  for (const row of bitrix) {
    const ms = row.lastCheckedAt ? Date.parse(row.lastCheckedAt) : Number.NaN;
    if (!row.lastCheckedAt || Number.isNaN(ms)) return { state: 'unknown' };
    if (oldest === null || ms < oldest.ms) oldest = { iso: row.lastCheckedAt, ms };
  }
  return { state: 'known', oldestCheckedAt: oldest!.iso, anyLate: bitrix.some((r) => r.late) };
}

// ---------------------------------------------------------------------------
// Bitrix names (B1-1, switch bitrix_name_read, Off by default)
// ---------------------------------------------------------------------------

/**
 * What the name map read returned for this render. 'switched_off' until the
 * B1-1 read is wired and switched on; 'list_unreadable' when the read failed.
 * Keys of `names` come from bitrixNameKey(entityId, code).
 */
export type BitrixNameLookup =
  | { state: 'switched_off' }
  | { state: 'list_unreadable' }
  | { state: 'on'; names: ReadonlyMap<string, { name: string; missing: boolean }> };

export const BITRIX_NAMES_OFF: BitrixNameLookup = { state: 'switched_off' };

export function bitrixNameKey(entityId: string, code: string): string {
  return `${entityId}\u0000${code}`;
}

/** Bitrix stage list of a deal stage code: "C2:WON" is in DEAL_STAGE_2, "WON" in DEAL_STAGE. */
export function dealStageEntity(stageId: string): string {
  const match = /^C([0-9]{1,9}):/.exec(stageId);
  return match ? `DEAL_STAGE_${match[1]}` : 'DEAL_STAGE';
}

/** A code shown by name only when the map is on and has it (DA-90 to DA-93). */
export function bitrixName(lookup: BitrixNameLookup, entityId: string, code: string): BitrixNameVM {
  if (lookup.state === 'switched_off') return { code, name: null, labelState: 'switched_off' };
  if (lookup.state === 'list_unreadable') return { code, name: null, labelState: 'list_unreadable' };
  const hit = lookup.names.get(bitrixNameKey(entityId, code));
  const name = hit?.name.trim();
  if (!hit || !name) return { code, name: null, labelState: 'not_in_list' };
  return hit.missing ? { code, name, labelState: 'named', noLongerInList: true } : { code, name, labelState: 'named' };
}

// ---------------------------------------------------------------------------
// Owner (DEC-52: the record owner's display name only, via B1-4)
// ---------------------------------------------------------------------------

/** Owner of a record for lists and headers. `ownerName` only from B1-4 or a profile the viewer may read. */
export function recordOwner(ownerUserId: string | null, viewerId: string, ownerName?: string | null): RecordOwnerVM {
  if (ownerUserId === null) return { kind: 'waiting' };
  if (ownerUserId === viewerId) return { kind: 'you' };
  const name = ownerName?.trim();
  return name ? { kind: 'colleague', displayName: name } : { kind: 'colleague' };
}

/** Deal list owner from the DTO's relation and owner name (the DTO carries no owner id). */
export function dealRowOwner(deal: Pick<DealListItem, 'relation' | 'ownerName'>): RecordOwnerVM {
  if (deal.relation === 'waiting') return { kind: 'waiting' };
  if (deal.relation === 'owner') return { kind: 'you' };
  const name = deal.ownerName?.trim();
  return name ? { kind: 'colleague', displayName: name } : { kind: 'colleague' };
}

// ---------------------------------------------------------------------------
// Rows (structural copies of LeadListRowVM / DealListRowVM)
// ---------------------------------------------------------------------------

export interface LeadListRowModel {
  id: string;
  reference: string;
  title: string;
  status: BitrixNameVM;
  source: BitrixNameVM;
  owner: RecordOwnerVM;
  branchName: string;
  createdInBitrixAt: string;
  late: boolean;
  details: {
    sourceLeadId: string;
    lastCheckedAt: string;
    relation: 'owner' | 'branch_manager' | 'integration_admin';
  };
}

export interface DealListRowModel {
  id: string;
  reference: string;
  title: string;
  branchName: string;
  owner: RecordOwnerVM;
  stage?: BitrixNameVM;
  testRecord: boolean;
  late: boolean;
  details: {
    relation: ViewerRelation;
    createdOn: string;
    sourceDealId?: string;
    lastCheckedAt?: string;
    lastChangeAt?: string;
  };
}

/** Shown when the viewer may not read the branch name (same as the lead DTO). */
const BRANCH_NOT_SHOWN = 'Not shown';

/** One Leads list row: header and provenance only (LEAD_COLUMNS), never contact fields. */
export function toLeadListRow(
  viewer: ViewerAccess,
  lead: LeadRow,
  ctx: { branchNames: Map<string, string>; names: BitrixNameLookup; ownerNames: Map<string, string> },
  now: Date = new Date(),
): LeadListRowModel {
  const source = toLeadSourceView(lead, now);
  return {
    id: lead.id,
    reference: lead.reference,
    title: lead.title,
    status: bitrixName(ctx.names, 'STATUS', lead.source_status_id),
    source: bitrixName(ctx.names, 'SOURCE', lead.source_id_code),
    owner: recordOwner(lead.owner_user_id, viewer.userId, lead.owner_user_id ? ctx.ownerNames.get(lead.owner_user_id) : null),
    branchName: ctx.branchNames.get(lead.branch_id) ?? BRANCH_NOT_SHOWN,
    createdInBitrixAt: lead.source_created_at,
    late: source.stale,
    details: {
      sourceLeadId: source.sourceLeadId,
      lastCheckedAt: source.lastVerifiedAt,
      relation: leadRelation(viewer, lead),
    },
  };
}

/** One Deals list row from the existing DTO (no money: the list DTO has none). */
export function toDealListRow(deal: DealListItem, names: BitrixNameLookup): DealListRowModel {
  const source = deal.source;
  return {
    id: deal.id,
    reference: deal.reference,
    title: deal.title,
    branchName: deal.branchName,
    owner: dealRowOwner(deal),
    ...(source ? { stage: bitrixName(names, dealStageEntity(source.stageId), source.stageId) } : {}),
    testRecord: !source,
    late: source?.stale ?? false,
    details: {
      relation: deal.relation,
      createdOn: deal.createdOn,
      ...(source
        ? { sourceDealId: source.sourceDealId, lastCheckedAt: source.lastVerifiedAt, lastChangeAt: source.lastSyncedAt }
        : {}),
    },
  };
}

/** Freshness of a Leads page (every lead comes from Bitrix). */
export function leadsFreshness(rows: LeadListRowModel[]): ListFreshnessVM {
  return listFreshness(rows.map((r) => ({ bitrix: true, lastCheckedAt: r.details.lastCheckedAt, late: r.late })));
}

/** Freshness of a Deals page (test records without a Bitrix source are left out). */
export function dealsFreshness(rows: DealListRowModel[]): ListFreshnessVM {
  return listFreshness(rows.map((r) => ({ bitrix: !r.testRecord, lastCheckedAt: r.details.lastCheckedAt ?? null, late: r.late })));
}

/**
 * Role-specific empty text on the Deals list (DE-01): only when every role the
 * viewer holds is Accounts, or every role is Super Admin. Display only; the
 * database already decided that no deal is visible.
 */
export function dealsEmptyFor(viewer: Pick<ViewerAccess, 'memberships'>): 'accounts' | 'super_admin' | undefined {
  const roles = new Set(viewer.memberships.map((m) => m.roleCode));
  if (roles.size !== 1) return undefined;
  if (roles.has('accounts')) return 'accounts';
  if (roles.has('super_admin')) return 'super_admin';
  return undefined;
}
