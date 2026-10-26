
/*
 * Phase 6 Bitrix Lead provenance (contract §2.2). Header fields only: no
 * contact, phone, email, comments, amounts or files. Bitrix owns every field;
 * the CRM shows them read-only and writes nothing back. Purchase never reads
 * leads (RLS), and these views carry no commercial value at all.
 * Layout adapted from the 21st.dev "Leads Data Table" (7491: source pill and
 * status pill per row) with its selection, hover actions, amounts, sparklines
 * and motion removed, and the Phase 5 "Data Refresh State" (29369) provenance
 * strip. See docs/implementation/phase-6/design/21st-dev-log.md.
 */

/** Read-only Bitrix provenance of one CRM lead row (`crm_leads`). */
export interface LeadSourceView {
  system: 'bitrix';
  /** Bitrix lead id (source_lead_id). */
  sourceLeadId: string;
  /** Bitrix STATUS_ID, e.g. NEW. */
  statusId: string;
  /** Plain status name when verified from the portal; null shows the raw id. */
  statusLabel?: string | null;
  /** Bitrix SOURCE_ID, equal to the approved list's source code. */
  sourceCode: string;
  /** Verified portal label for sourceCode (e.g. "CRM form"); null shows the raw code. */
  sourceCodeLabel?: string | null;
  /** Bitrix DATE_CREATE. */
  sourceCreatedAt: string;
  lastSyncedAt: string;
  lastVerifiedAt: string;
  /** True when last_verified_at is older than the proposed 24 h threshold. */
  stale: boolean;
}

/** Why this viewer may read the lead (mirrors the crm_leads RLS read rule). */
export type LeadRelation = 'owner' | 'branch_manager' | 'integration_admin';

export interface LeadListItem {
  id: string;
  /** BXL-<lead id>. */
  reference: string;
  /** Bitrix TITLE (at most 200 characters). */
  title: string;
  branchName: string;
  relation: LeadRelation;
  source: LeadSourceView;
}

export interface LeadDetail extends LeadListItem {
  /** Mapped CRM staff display name; null when this viewer cannot read the profile. */
  ownerName: string | null;
}

// Direction A, Batch 1 screens (src/views/list-leads.tsx), exported from here for the routes.
export { LEAD_SEEN_BECAUSE, LeadNotFoundView, LeadsListScreen, LeadsNoPermissionView, LeadWorkspaceView, leadDayText } from './list-leads';
export type { LeadListRowVM, LeadsListScreenProps, LeadWorkspaceViewProps } from './list-leads';
