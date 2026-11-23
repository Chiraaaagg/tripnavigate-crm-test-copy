import type { ViewerAccess } from '@/modules/access/policy';
import { STALE_SYNC_HOURS_PROPOSED } from '@/modules/integration/contracts';
import type { LeadDetail, LeadListItem, LeadRelation, LeadSourceView } from '@/views/lead-views';

/**
 * Data transfer objects for the read-only lead screens (lead-screens contract
 * §1). Only header and provenance fields: no contact, phone, email, comments,
 * amounts or files. RLS decides which rows exist; `relation` is a display hint.
 */

/** Columns selected from public.crm_leads (contract §1). Never add contact fields. */
export const LEAD_COLUMNS =
  'id, reference, title, branch_id, owner_user_id, source_lead_id, source_status_id, source_id_code, source_created_at, last_synced_at, last_verified_at, source_portal';

export interface LeadRow {
  id: string;
  reference: string;
  title: string;
  branch_id: string;
  /** Null = waiting for an owner (B1.2, DEC-37; visible to the branch Manager only). */
  owner_user_id: string | null;
  source_lead_id: number | string;
  source_status_id: string;
  source_id_code: string;
  source_created_at: string;
  last_synced_at: string;
  last_verified_at: string | null;
  source_portal: string;
}

/** Shown when the viewer may not read the branch or owner name. */
export const NOT_SHOWN = 'Not shown';

/** True when last_verified_at is missing, unparsable or older than the proposed threshold. */
export function isLeadStale(lastVerifiedAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!lastVerifiedAt) return true;
  const verified = Date.parse(lastVerifiedAt);
  if (Number.isNaN(verified)) return true;
  return now.getTime() - verified > STALE_SYNC_HOURS_PROPOSED * 60 * 60 * 1000;
}

/** Display-only relation (contract §1). The database already decided visibility. */
export function leadRelation(viewer: ViewerAccess, lead: Pick<LeadRow, 'owner_user_id' | 'branch_id'>): LeadRelation {
  if (lead.owner_user_id === viewer.userId) return 'owner';
  if (viewer.memberships.some((m) => m.branchId === lead.branch_id && m.roleCode === 'manager')) {
    return 'branch_manager';
  }
  return 'integration_admin';
}

export function toLeadSourceView(lead: LeadRow, now: Date = new Date()): LeadSourceView {
  // Rows written before last_verified_at was set fall back to last_synced_at.
  const lastVerifiedAt = lead.last_verified_at ?? lead.last_synced_at;
  return {
    system: 'bitrix',
    sourceLeadId: String(lead.source_lead_id),
    statusId: lead.source_status_id,
    statusLabel: null,
    sourceCode: lead.source_id_code,
    sourceCodeLabel: null,
    sourceCreatedAt: lead.source_created_at,
    lastSyncedAt: lead.last_synced_at,
    lastVerifiedAt,
    stale: isLeadStale(lastVerifiedAt, now),
  };
}

export function toLeadListItem(
  viewer: ViewerAccess,
  lead: LeadRow,
  branchNames: Map<string, string>,
  now: Date = new Date(),
): LeadListItem {
  return {
    id: lead.id,
    reference: lead.reference,
    title: lead.title,
    branchName: branchNames.get(lead.branch_id) ?? NOT_SHOWN,
    relation: leadRelation(viewer, lead),
    source: toLeadSourceView(lead, now),
  };
}

/**
 * The Lead record DTO: LeadDetail plus whether the Lead has an owner at all.
 * `ownerState` 'waiting' = no owner yet (B1.2, DEC-37); the owner's id itself
 * never leaves the server.
 */
export type LeadRecordDetail = LeadDetail & { ownerState: 'waiting' | 'assigned' };

export function toLeadDetail(
  viewer: ViewerAccess,
  lead: LeadRow,
  branchNames: Map<string, string>,
  ownerName: string | null,
  now: Date = new Date(),
): LeadRecordDetail {
  const ownerState = lead.owner_user_id === null ? 'waiting' : 'assigned';
  return {
    ...toLeadListItem(viewer, lead, branchNames, now),
    ownerName: ownerState === 'waiting' ? null : ownerName?.trim() || null,
    ownerState,
  };
}
