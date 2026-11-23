import 'server-only';
import { z } from 'zod';
import { canSeeLeads, holdsPurchaseAnywhere, type ViewerAccess } from '@/modules/access/policy';
import { type StaffContext, visibleBranches } from '@/modules/identity/server/session';
import { loadBitrixNameLookup, loadRecordOwnerNames } from '@/modules/deals/server/queries';
import { clampPage, type LeadListRowModel, lastPage, toLeadListRow } from '@/modules/deals/list-model';
import type { LeadListFilter } from '@/modules/deals/workspace-contract';
import { LEAD_COLUMNS, type LeadRecordDetail, type LeadRow, toLeadDetail } from '../dto';

/**
 * Read-only lead loaders (lead-screens contract §1). Every read runs under the
 * staff member's own session client, so crm_leads RLS decides the rows. No
 * service-role or secret-key client is used here.
 */

/** Marker for LeadsNoPermissionView: the page renders it and receives no lead data. */
export const NO_PERMISSION = 'no_permission' as const;
export type NoPermission = typeof NO_PERMISSION;

/** Page size of the lead list ("1–50 of N"; same as the Deals list). */
export const LEAD_PAGE_SIZE = 50;

/**
 * One offset page of the lead list (LE-01, batch-1-backend-contract §3),
 * ordered by Bitrix lead number, highest first (`source_lead_id desc, id`), so
 * BXL-10 sorts after BXL-9. Counts are exact over every Lead the viewer can see.
 */
export interface LeadListResult {
  items: LeadListRowModel[];
  filter: LeadListFilter;
  /** 1-based page actually shown (clamped to the last page of the filter). */
  page: number;
  pageSize: number;
  /** Exact count for `filter`; null when it could not be read. */
  total: number | null;
  /** Chip counts; null = could not be read (never 0). */
  counts: Record<LeadListFilter, number | null>;
}

export interface LoadLeadsOptions {
  /** 1-based page from `?page=`. */
  page?: number;
  /** 'mine' = owner_user_id is the viewer. */
  filter?: LeadListFilter;
}

type LeadStaff = Pick<StaffContext, 'userId' | 'displayName' | 'access' | 'supabase'>;

interface QueryError {
  code?: string;
}

/** Purchase in any entity, or no lead-capable role: refuse without querying. */
export function leadAccessDenied(access: ViewerAccess): boolean {
  return holdsPurchaseAnywhere(access) || !canSeeLeads(access);
}

/** 42501 (not_authorized) is an honest refusal; anything else is unexplained and throws. */
function isRefusal(error: QueryError | null | undefined): boolean {
  return error?.code === '42501';
}

async function branchNames(staff: LeadStaff): Promise<Map<string, string>> {
  // Unreadable branches fall back to "Not shown" in the DTO; never fatal.
  const { data, error } = await visibleBranches(staff.supabase);
  if (error || !data) return new Map();
  return new Map(data.map((b) => [b.id as string, b.name as string]));
}

async function ownerName(staff: LeadStaff, ownerUserId: string | null): Promise<string | null> {
  // B1.2 (DEC-37): a Lead waiting for an owner has none to name.
  if (ownerUserId === null) return null;
  if (ownerUserId === staff.userId) return staff.displayName;
  // staff_profiles RLS lets only the profile owner and staff admins read it; B1-4 (DEC-52) names the
  // owner of a Lead the viewer can already open. Both run together; either failing shows no name.
  const [profile, recordNames] = await Promise.all([
    staff.supabase
      .from('staff_profiles')
      .select('display_name')
      .eq('user_id', ownerUserId)
      .maybeSingle()
      .then(
        ({ data, error }) => (error || !data ? null : ((data as { display_name?: string | null }).display_name ?? null)),
        () => null,
      ),
    loadRecordOwnerNames(staff, [ownerUserId]).catch(() => new Map<string, string>()),
  ]);
  return profile ?? recordNames.get(ownerUserId) ?? null;
}

function leadPage(staff: LeadStaff, filter: LeadListFilter, page: number) {
  const offset = (page - 1) * LEAD_PAGE_SIZE;
  const base = staff.supabase.from('crm_leads').select(LEAD_COLUMNS);
  const filtered = filter === 'mine' ? base.eq('owner_user_id', staff.userId) : base;
  return filtered
    .order('source_lead_id', { ascending: false })
    .order('id')
    .range(offset, offset + LEAD_PAGE_SIZE - 1);
}

async function leadCount(staff: LeadStaff, filter: LeadListFilter): Promise<number | null> {
  const base = staff.supabase.from('crm_leads').select('id', { count: 'exact', head: true });
  const { count, error } = await (filter === 'mine' ? base.eq('owner_user_id', staff.userId) : base);
  return error ? null : (count ?? null);
}

/**
 * One page of leads visible to the signed-in staff member, or the
 * no-permission marker. Reads at most LEAD_PAGE_SIZE rows; never unbounded.
 * Purchase (anywhere) and role-less viewers are refused before any query.
 * The two chip counts and the page are read at the same time; only a page
 * beyond the end needs a second read (the last page).
 */
export async function loadLeads(
  staff: LeadStaff,
  { page = 1, filter = 'all' }: LoadLeadsOptions = {},
): Promise<LeadListResult | NoPermission> {
  if (leadAccessDenied(staff.access)) return NO_PERMISSION;
  const requested = Math.max(1, page);
  const [first, all, mine, names, lookup] = await Promise.all([
    leadPage(staff, filter, requested),
    leadCount(staff, 'all'),
    leadCount(staff, 'mine'),
    branchNames(staff),
    loadBitrixNameLookup(staff),
  ]);
  const counts: Record<LeadListFilter, number | null> = { all, mine };
  const total = counts[filter];
  const shownPage = clampPage(requested, total, LEAD_PAGE_SIZE);
  const leads = total !== null && requested > lastPage(total, LEAD_PAGE_SIZE) ? await leadPage(staff, filter, shownPage) : first;
  if (leads.error) {
    if (isRefusal(leads.error)) return NO_PERMISSION;
    throw new Error('Could not load leads. Please retry.');
  }
  const rows = (leads.data ?? []) as unknown as LeadRow[];
  // DEC-52 (B1-4): the owner's display name on Leads the viewer can already open.
  const others = [...new Set(rows.map((r) => r.owner_user_id).filter((id): id is string => id !== null && id !== staff.userId))];
  const ownerNames = await loadRecordOwnerNames(staff, others);
  const now = new Date();
  return {
    items: rows.map((row) => toLeadListRow(staff.access, row, { branchNames: names, names: lookup, ownerNames }, now)),
    filter,
    page: shownPage,
    pageSize: LEAD_PAGE_SIZE,
    total,
    counts,
  };
}

/** Most ids one by-id list read accepts (a search page is 20). */
export const LEAD_BY_IDS_MAX = 50;

/**
 * Batch 5 search (contracts.md §E): the Leads list rows for the given ids, in
 * the given order, through the same read as loadLeads (LEAD_COLUMNS under the
 * viewer's own session, so crm_leads RLS decides) and the same mapping
 * (branch names, Bitrix names, owner names, toLeadListRow). Ids the viewer
 * cannot see are simply absent. Purchase (anywhere) and role-less viewers are
 * refused before any query, as on the Leads page.
 */
export async function loadLeadRowsByIds(staff: LeadStaff, ids: string[]): Promise<LeadListRowModel[] | NoPermission> {
  if (leadAccessDenied(staff.access)) return NO_PERMISSION;
  const wanted = [...new Set(ids)].filter((id) => z.uuid().safeParse(id).success).slice(0, LEAD_BY_IDS_MAX);
  if (wanted.length === 0) return [];
  const [leads, names, lookup] = await Promise.all([
    staff.supabase.from('crm_leads').select(LEAD_COLUMNS).in('id', wanted),
    branchNames(staff),
    loadBitrixNameLookup(staff),
  ]);
  if (leads.error) {
    if (isRefusal(leads.error)) return NO_PERMISSION;
    throw new Error('Could not load leads. Please retry.');
  }
  const rows = (leads.data ?? []) as unknown as LeadRow[];
  const others = [...new Set(rows.map((r) => r.owner_user_id).filter((id): id is string => id !== null && id !== staff.userId))];
  const ownerNames = await loadRecordOwnerNames(staff, others);
  const now = new Date();
  const byId = new Map(rows.map((row) => [row.id, toLeadListRow(staff.access, row, { branchNames: names, names: lookup, ownerNames }, now)]));
  return wanted.map((id) => byId.get(id)).filter((r): r is LeadListRowModel => r !== undefined);
}

/** One lead; null for unknown, malformed or invisible ids (indistinguishable). */
export async function loadLead(staff: LeadStaff, rawId: string): Promise<LeadRecordDetail | null | NoPermission> {
  if (leadAccessDenied(staff.access)) return NO_PERMISSION;
  const id = z.uuid().safeParse(rawId);
  if (!id.success) return null;
  const [lead, names] = await Promise.all([
    staff.supabase.from('crm_leads').select(LEAD_COLUMNS).eq('id', id.data).maybeSingle(),
    branchNames(staff),
  ]);
  if (lead.error) {
    if (isRefusal(lead.error)) return null;
    throw new Error('Could not load the lead. Please retry.');
  }
  if (!lead.data) return null;
  const row = lead.data as unknown as LeadRow;
  return toLeadDetail(staff.access, row, names, await ownerName(staff, row.owner_user_id));
}
