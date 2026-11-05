import 'server-only';
import { z } from 'zod';
import { type StaffContext, visibleBranches } from '@/modules/identity/server/session';
import {
  type AssignmentRow,
  type CommercialRow,
  type DealDetail,
  type DealListItem,
  type DealRow,
  toDealDetail,
  toDealListItem,
} from '../dto';
import { loadRecordOwnerNames as loadOwnerNames } from '@/modules/identity/server/staff-names';
import { loadBitrixNameMap } from '@/modules/integration/server/name-map';
import { BITRIX_NAMES_OFF, type BitrixNameLookup, bitrixNameKey, clampPage, type DealListSort, lastPage, parseListPage } from '../list-model';
import type { DealListFilter } from '../workspace-contract';

// Header and read-only source fields. Never selects commercial values.
const DEAL_COLUMNS =
  'id, legal_entity_id, branch_id, reference, title, owner_user_id, created_at, source_system, source_deal_id, source_stage_id, last_synced_at, last_verified_at';

async function branchNames(staff: StaffContext): Promise<Map<string, string>> {
  const { data, error } = await visibleBranches(staff.supabase);
  if (error) throw new Error('Could not load branches.');
  return new Map((data ?? []).map((b) => [b.id as string, b.name as string]));
}

/** Display names of the given owners that the viewer may read (RLS on staff_profiles). */
async function ownerNames(staff: StaffContext, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { data } = await staff.supabase.from('staff_profiles').select('user_id, display_name').in('user_id', unique);
  return new Map((data ?? []).map((p) => [p.user_id as string, p.display_name as string]));
}

/**
 * Number of deals visible to the signed-in staff member: THE deal count. The
 * Deals page, Home and the Bitrix sync page all use this one query, so their
 * numbers always agree. RLS decides the rows (removed deals never count).
 */
export async function countVisibleDeals(staff: Pick<StaffContext, 'supabase'>): Promise<number> {
  const { count, error } = await staff.supabase.from('deals').select('id', { count: 'exact', head: true });
  if (error) throw new Error('Could not count deals.');
  return count ?? 0;
}

/**
 * Visible deals that moved in Bitrix to a stage outside `stageIds` after import
 * (kept by design: stages decide entry only). Same RLS as countVisibleDeals.
 */
export async function countVisibleOutsideStages(staff: Pick<StaffContext, 'supabase'>, stageIds: string[]): Promise<number> {
  if (stageIds.length === 0) return 0;
  const list = `(${stageIds.map((s) => `"${s.replace(/"/g, '')}"`).join(',')})`;
  const { count, error } = await staff.supabase
    .from('deals')
    .select('id', { count: 'exact', head: true })
    .eq('source_system', 'bitrix')
    .not('source_stage_id', 'in', list);
  if (error) throw new Error('Could not count deals.');
  return count ?? 0;
}

/** Exact head count of visible deals the viewer owns (same RLS as countVisibleDeals). */
function ownedDealsCount(staff: Pick<StaffContext, 'supabase' | 'userId'>) {
  return staff.supabase.from('deals').select('id', { count: 'exact', head: true }).eq('owner_user_id', staff.userId);
}

/**
 * One exact head count (Milestone A section 4): visible deals with an active
 * assignment to the viewer that the viewer does not own (owner may be unset
 * after a Bitrix owner change). Inner join; no id list is fetched or capped.
 */
function assignedDealsCount(staff: Pick<StaffContext, 'supabase' | 'userId'>) {
  return staff.supabase
    .from('deals')
    .select('id, deal_assignments!inner(deal_id)', { count: 'exact', head: true })
    .eq('deal_assignments.user_id', staff.userId)
    .is('deal_assignments.ended_at', null)
    .or(`owner_user_id.is.null,owner_user_id.neq.${staff.userId}`);
}

/** Home page counters: visible (shared count), owned, assigned-but-not-owned. */
export async function countMyDeals(staff: StaffContext): Promise<{ visible: number; owned: number; assigned: number }> {
  const [visible, owned, assigned] = await Promise.all([countVisibleDeals(staff), ownedDealsCount(staff), assignedDealsCount(staff)]);
  if (owned.error || assigned.error || owned.count === null || assigned.count === null) throw new Error('Could not count deals.');
  return { visible, owned: owned.count, assigned: assigned.count };
}

/**
 * Deals list chip counts for "Owned by you" and "Assigned to you, owned by
 * someone else" (batch-1-backend-contract §3). The same two queries as Home's
 * countMyDeals, so the numbers agree; disjoint by construction. A failed count
 * is null (shown as "count unavailable", never 0). The All count is
 * countVisibleDeals, read separately and unchanged.
 */
export async function countDealFilters(staff: Pick<StaffContext, 'supabase' | 'userId'>): Promise<{ owned: number | null; assigned: number | null }> {
  const [owned, assigned] = await Promise.all([ownedDealsCount(staff), assignedDealsCount(staff)]);
  return {
    owned: owned.error ? null : (owned.count ?? null),
    assigned: assigned.error ? null : (assigned.count ?? null),
  };
}

export const PAGE_SIZE = 50;

export interface DealPage {
  items: DealListItem[];
  sort: DealSort;
  /** 1-based page actually shown (clamped to the last page). */
  page: number;
  pageSize: number;
  /** Rows before this page (for "Showing X-Y of N"). */
  offset: number;
}

/**
 * Deal list order: Bitrix deal ID (numeric, source_deal_id bigint), highest
 * first by default. A sync never moves a deal; only a new Bitrix ID does.
 * Deals without a Bitrix ID (synthetic test records) come last; the row id
 * breaks ties so pages never overlap or skip.
 */
export type DealSort = DealListSort;
export const DEFAULT_DEAL_SORT: DealSort = 'id_desc';

/** Parses ?sort=; anything else is the default (highest Bitrix ID first). */
export function parseSort(raw: unknown): DealSort {
  return raw === 'id_asc' ? 'id_asc' : DEFAULT_DEAL_SORT;
}

/** Parses ?page= (1-based); anything else is page 1. */
export function parsePage(raw: unknown): number {
  return parseListPage(raw);
}

/**
 * One page of the deals visible to the signed-in staff member, ordered by
 * Bitrix deal ID (DealSort). RLS decides the rows; the database sorts, so
 * paging stays exact. `total` (the exact count for `filter`) clamps the page.
 *
 * One Data API request (speed plan C3): the page's active assignments and the
 * owners' display names are embedded in the deal read. Embedded rows obey the
 * same row-level security as separate reads (an owner whose profile the viewer
 * may not read has no name), and only this page's assignments are returned.
 *
 * Filters (Batch 1 chips, server side; RLS still decides every row):
 *   - 'owned': owner_user_id = viewer (same predicate as the owned count);
 *   - 'assigned': an aliased inner embed `mine` of the viewer's active
 *     assignments, owner not the viewer (same predicate as the assigned count).
 *     The alias keeps the unfiltered `deal_assignments` embed for the relation.
 */
export async function listVisibleDeals(
  staff: StaffContext,
  page = 1,
  total?: number,
  sort: DealSort = DEFAULT_DEAL_SORT,
  filter: DealListFilter = 'all',
): Promise<DealPage> {
  const current = clampPage(page, total ?? null, PAGE_SIZE);
  const offset = (current - 1) * PAGE_SIZE;
  const columns = filter === 'assigned' ? `${DEAL_COLUMNS}, ${LIST_EMBEDS}, ${ASSIGNED_EMBED}` : `${DEAL_COLUMNS}, ${LIST_EMBEDS}`;
  let query = staff.supabase.from('deals').select(columns).is('deal_assignments.ended_at', null);
  if (filter === 'owned') query = query.eq('owner_user_id', staff.userId);
  if (filter === 'assigned') {
    query = query
      .eq('mine.user_id', staff.userId)
      .is('mine.ended_at', null)
      .or(`owner_user_id.is.null,owner_user_id.neq.${staff.userId}`);
  }
  const [deals, names] = await Promise.all([
    query
      .order('source_deal_id', { ascending: sort === 'id_asc', nullsFirst: false })
      .order('id')
      .range(offset, offset + PAGE_SIZE - 1),
    branchNames(staff),
  ]);
  if (deals.error) throw new Error('Could not load deals.');
  return {
    items: await toListItems(staff, (deals.data ?? []) as unknown as Array<DealRow & EmbeddedListRow>, names),
    sort,
    page: current,
    pageSize: PAGE_SIZE,
    offset,
  };
}

/**
 * List items from rows of the list read (same columns and embeds): owner names
 * from the embed, then DEC-52 (B1-4) names for owners the viewer cannot read
 * directly. Shared by the list page and the search results (Batch 5), so a
 * found Deal is mapped exactly like the same Deal in the list.
 */
async function toListItems(
  staff: StaffContext,
  rows: Array<DealRow & EmbeddedListRow>,
  names: Map<string, string>,
): Promise<DealListItem[]> {
  const owners = new Map<string, string>();
  for (const d of rows) {
    if (d.owner_user_id && d.owner?.display_name) owners.set(d.owner_user_id, d.owner.display_name);
  }
  // DEC-52 (B1-4): the record owner's display name on deals the viewer can read.
  const unnamed = rows
    .map((d) => d.owner_user_id)
    .filter((id): id is string => id !== null && id !== staff.userId && !owners.has(id));
  for (const [id, name] of await loadRecordOwnerNames(staff, unnamed)) owners.set(id, name);
  const now = new Date();
  return rows.map((d) => toDealListItem(staff.access, d, d.deal_assignments ?? [], names, now, owners));
}

/** Most ids one by-id list read accepts (a search page is 20). */
export const LIST_BY_IDS_MAX = 50;

/**
 * Batch 5 search (contracts.md §E): the list items for the given Deal ids, in
 * the given order, through the same list read (same columns, embeds, RLS and
 * mapping as listVisibleDeals). Ids the viewer can no longer see are simply
 * absent. At most LIST_BY_IDS_MAX ids; never unbounded.
 */
export async function listVisibleDealsByIds(staff: StaffContext, ids: string[]): Promise<DealListItem[]> {
  const wanted = [...new Set(ids)].filter((id) => z.uuid().safeParse(id).success).slice(0, LIST_BY_IDS_MAX);
  if (wanted.length === 0) return [];
  const [deals, names] = await Promise.all([
    staff.supabase.from('deals').select(`${DEAL_COLUMNS}, ${LIST_EMBEDS}`).is('deal_assignments.ended_at', null).in('id', wanted),
    branchNames(staff),
  ]);
  if (deals.error) throw new Error('Could not load deals.');
  const items = await toListItems(staff, (deals.data ?? []) as unknown as Array<DealRow & EmbeddedListRow>, names);
  const byId = new Map(items.map((d) => [d.id, d]));
  return wanted.map((id) => byId.get(id)).filter((d): d is DealListItem => d !== undefined);
}

/** Embedded in the list read: active assignments of each deal and the owner's display name. */
const LIST_EMBEDS =
  'deal_assignments(deal_id, user_id, assignment_kind), owner:staff_profiles!deals_owner_user_id_fkey(display_name)';

/** 'assigned' filter only: the viewer's own active assignment, as an inner join under its own alias. */
const ASSIGNED_EMBED = 'mine:deal_assignments!inner(deal_id)';

interface EmbeddedListRow {
  deal_assignments?: AssignmentRow[] | null;
  owner?: { display_name: string | null } | null;
}

export interface DealsPageResult {
  filter: DealListFilter;
  /** Exact count for `filter`; null when that count could not be read. */
  total: number | null;
  /** Chip counts: all = countVisibleDeals (shared with Home and the Bitrix sync page). */
  counts: Record<DealListFilter, number | null>;
  list: DealPage;
}

/**
 * The Deals page: the shared count, the two chip counts and the requested page,
 * read at the same time (speed plan C3). The page is clamped to the last page of
 * the current filter; only a request beyond the last page needs a second read.
 * countVisibleDeals failing still fails the page, as before; a failed chip count
 * is null (never 0).
 */
export async function loadDealsPage(
  staff: StaffContext,
  page: number,
  sort: DealSort = DEFAULT_DEAL_SORT,
  filter: DealListFilter = 'all',
): Promise<DealsPageResult> {
  const [all, chips, first] = await Promise.all([
    countVisibleDeals(staff),
    countDealFilters(staff),
    listVisibleDeals(staff, page, undefined, sort, filter),
  ]);
  const counts: Record<DealListFilter, number | null> = { all, owned: chips.owned, assigned: chips.assigned };
  const total = counts[filter];
  const list = total !== null && first.page > lastPage(total, PAGE_SIZE) ? await listVisibleDeals(staff, page, total, sort, filter) : first;
  return { filter, total, counts, list };
}

// ---------------------------------------------------------------------------
// Batch 1 read hooks (Atlas B1-1, B1-4). Shared by the Leads and Deals loaders.
// ---------------------------------------------------------------------------

/**
 * Bitrix stage, status and source names for this render (B1-1
 * `bitrix_name_map()`, switch `bitrix_name_read`, Off by default). Off and an
 * older database without the read both show the code fallback (DA-93); any
 * failure is 'list_unreadable', never "off" and never an empty list.
 */
export async function loadBitrixNameLookup(staff: Pick<StaffContext, 'supabase'>): Promise<BitrixNameLookup> {
  const view = await loadBitrixNameMap(staff);
  if (view.state === 'switched_off' || view.state === 'not_installed') return BITRIX_NAMES_OFF;
  if (view.state === 'list_unreadable') return { state: 'list_unreadable' };
  return {
    state: 'on',
    names: new Map(view.names.map((n) => [bitrixNameKey(n.entityId, n.code), { name: n.name, missing: n.missing }])),
  };
}

/**
 * Display names of record owners the viewer can already open (B1-4
 * `record_staff_names(uuid[])`, DEC-52: the owner's name only). A failure
 * returns an empty map, so screens keep "Another staff member".
 */
export function loadRecordOwnerNames(staff: Pick<StaffContext, 'supabase'>, userIds: string[]): Promise<Map<string, string>> {
  return loadOwnerNames(staff, userIds);
}

/**
 * The Deal owner's display name for the record header (DEC-52: the owner only).
 * The profile read (own row, staff admins) and the B1-4 read (owners of records
 * the viewer can open) run together, one round trip after the Deal row; the
 * viewer's own row needs neither. Either failing leaves "Another staff member".
 */
async function dealOwnerNames(staff: StaffContext, ownerUserId: string | null): Promise<Map<string, string>> {
  if (ownerUserId === null) return new Map();
  if (ownerUserId === staff.userId) return ownerNames(staff, [ownerUserId]);
  const [profiles, recordNames] = await Promise.all([
    ownerNames(staff, [ownerUserId]).catch(() => new Map<string, string>()),
    loadRecordOwnerNames(staff, [ownerUserId]).catch(() => new Map<string, string>()),
  ]);
  const name = profiles.get(ownerUserId) ?? recordNames.get(ownerUserId);
  return name ? new Map([[ownerUserId, name]]) : new Map();
}

/** Returns null for unknown, malformed or out-of-scope IDs (indistinguishable). */
export async function getVisibleDeal(staff: StaffContext, rawId: string): Promise<DealDetail | null> {
  const id = z.uuid().safeParse(rawId);
  if (!id.success) return null;
  const [deal, assignments, commercial, names] = await Promise.all([
    staff.supabase.from('deals').select(DEAL_COLUMNS).eq('id', id.data).maybeSingle(),
    staff.supabase
      .from('deal_assignments')
      .select('deal_id, user_id, assignment_kind')
      .eq('deal_id', id.data)
      .is('ended_at', null),
    staff.supabase
      .from('deal_commercials')
      .select('deal_id, currency, selling_total_paise, estimated_margin_paise')
      .eq('deal_id', id.data)
      .maybeSingle(),
    branchNames(staff),
  ]);
  if (deal.error || assignments.error || commercial.error) throw new Error('Could not load the deal.');
  if (!deal.data) return null;
  const row = deal.data as DealRow;
  const owners = await dealOwnerNames(staff, row.owner_user_id);
  return toDealDetail(
    staff.access,
    deal.data as DealRow,
    (assignments.data ?? []) as AssignmentRow[],
    (commercial.data as CommercialRow | null) ?? null,
    names,
    new Date(),
    owners,
  );
}
