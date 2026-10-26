import { type ViewerAccess, canReadDealCommercial } from '@/modules/access/policy';
import { type DealSourceView, STALE_SYNC_HOURS_PROPOSED } from '@/modules/integration/contracts';
import { istDate } from '@/lib/dates';

/**
 * Data transfer objects for deal screens. A DTO is the ONLY shape that may reach
 * the browser. Commercial values are included only when the application mirror
 * of the policy allows it, in addition to the database already filtering them,
 * so a future query mistake cannot leak selling price or margin to Purchase.
 */

export interface DealRow {
  id: string;
  legal_entity_id: string;
  branch_id: string;
  reference: string;
  title: string;
  /** Null: imported deal waiting for an owner (Bitrix responsible not linked). */
  owner_user_id: string | null;
  created_at: string;
  /** Provenance (Phase 2). All null for synthetic deals. */
  source_system?: string | null;
  source_deal_id?: number | string | null;
  source_stage_id?: string | null;
  last_synced_at?: string | null;
  last_verified_at?: string | null;
}

export interface AssignmentRow {
  deal_id: string;
  user_id: string;
  assignment_kind: string;
}

export interface CommercialRow {
  deal_id: string;
  currency: string;
  selling_total_paise: number | string;
  estimated_margin_paise: number | string;
}

export type ViewerRelation = 'owner' | 'assigned' | 'scope' | 'waiting';

export interface DealListItem {
  id: string;
  reference: string;
  title: string;
  branchName: string;
  relation: ViewerRelation;
  createdOn: string;
  /** Owner display name when the viewer may see it; null when waiting for an owner or not visible. */
  ownerName?: string | null;
  /** Present only for deals imported from Bitrix (read-only source fields). */
  source?: DealSourceView;
}

export interface DealDetail extends DealListItem {
  assignments: Array<{ kind: string; isYou: boolean }>;
  commercial:
    | { visible: true; currency: string; sellingTotal: string; estimatedMargin: string }
    | { visible: false };
  /**
   * Why `commercial` is not visible (absent when it is):
   *   - 'withheld': the viewer's role may not read selling price or margin;
   *   - 'not_recorded': the viewer may read them, but the deal has no commercial row yet.
   * Kept outside `commercial` so the withheld shape stays exactly `{ visible: false }`.
   */
  commercialAbsence?: CommercialAbsence;
}

export type CommercialAbsence = 'withheld' | 'not_recorded';

/** Indian digit grouping (12,34,56,789) on a non-negative integer string. */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

/** Formats integer paise using BigInt only, so no amount is ever a float. */
export function formatPaise(paise: number | string): string {
  const value = BigInt(paise);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const rupees = groupIndian((abs / 100n).toString());
  const rem = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}₹${rupees}.${rem}`;
}

function relationOf(viewer: ViewerAccess, deal: DealRow, assignments: AssignmentRow[]): ViewerRelation {
  if (deal.owner_user_id === null) return 'waiting';
  if (deal.owner_user_id === viewer.userId) return 'owner';
  if (assignments.some((a) => a.deal_id === deal.id && a.user_id === viewer.userId)) return 'assigned';
  return 'scope';
}

/**
 * Source view for a Bitrix-imported deal, or undefined for CRM-native and
 * synthetic deals. `stale` compares last_verified_at (last confirmation of the
 * source state) with the PROPOSED 24 h threshold.
 */
export function toDealSourceView(deal: DealRow, now: Date = new Date()): DealSourceView | undefined {
  if (deal.source_system !== 'bitrix' || deal.source_deal_id == null || !deal.source_stage_id || !deal.last_synced_at) {
    return undefined;
  }
  // Rows written before last_verified_at existed fall back to last_synced_at.
  const lastVerifiedAt = deal.last_verified_at ?? deal.last_synced_at;
  const verified = Date.parse(lastVerifiedAt);
  const staleAfterMs = STALE_SYNC_HOURS_PROPOSED * 60 * 60 * 1000;
  return {
    system: 'bitrix',
    sourceDealId: String(deal.source_deal_id),
    stageId: deal.source_stage_id,
    lastSyncedAt: deal.last_synced_at,
    lastVerifiedAt,
    stale: Number.isNaN(verified) || now.getTime() - verified > staleAfterMs,
  };
}

export function toDealListItem(
  viewer: ViewerAccess,
  deal: DealRow,
  assignments: AssignmentRow[],
  branchNames: Map<string, string>,
  now: Date = new Date(),
  ownerNames: Map<string, string> = new Map(),
): DealListItem {
  const source = toDealSourceView(deal, now);
  return {
    ownerName: deal.owner_user_id ? (ownerNames.get(deal.owner_user_id) ?? null) : null,
    id: deal.id,
    reference: deal.reference,
    title: deal.title,
    branchName: branchNames.get(deal.branch_id) ?? 'Other branch',
    relation: relationOf(viewer, deal, assignments),
    createdOn: istDate(deal.created_at),
    ...(source ? { source } : {}),
  };
}

export function toDealDetail(
  viewer: ViewerAccess,
  deal: DealRow,
  assignments: AssignmentRow[],
  commercial: CommercialRow | null,
  branchNames: Map<string, string>,
  now: Date = new Date(),
  ownerNames: Map<string, string> = new Map(),
): DealDetail {
  const dealAssignments = assignments.filter((a) => a.deal_id === deal.id);
  const allowed = canReadDealCommercial(viewer, {
    legalEntityId: deal.legal_entity_id,
    branchId: deal.branch_id,
    ownerUserId: deal.owner_user_id,
    activeAssigneeIds: dealAssignments.map((a) => a.user_id),
  });
  return {
    ...toDealListItem(viewer, deal, assignments, branchNames, now, ownerNames),
    assignments: dealAssignments.map((a) => ({ kind: a.assignment_kind, isYou: a.user_id === viewer.userId })),
    commercial:
      allowed && commercial
        ? {
            visible: true,
            currency: commercial.currency,
            sellingTotal: formatPaise(commercial.selling_total_paise),
            estimatedMargin: formatPaise(commercial.estimated_margin_paise),
          }
        : { visible: false },
    ...(allowed && commercial ? {} : { commercialAbsence: (allowed ? 'not_recorded' : 'withheld') satisfies CommercialAbsence }),
  };
}
