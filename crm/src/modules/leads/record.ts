import type { QuotationListView } from '@/modules/quotations/contracts';
import { BITRIX_NAMES_OFF, type BitrixNameLookup, bitrixName } from '@/modules/deals/list-model';
import type { LeadTab, LeadWorkspaceVM, RecordOwnerVM, TabItemVM } from '@/modules/deals/workspace-contract';

/*
 * Batch 1 Lead record (LE-02): pure view-model builders for the route
 * `src/app/app/leads/[id]/page.tsx`. Inputs are reads the route already made
 * under the viewer's own session (crm_leads RLS, quotation_list). No contact
 * field, no money. Modules never import views, so the Lead detail is described
 * here structurally (the route passes the existing LeadDetail DTO).
 */

/** The fields of the Lead detail DTO this module reads (structurally the LeadDetail DTO). */
export interface LeadRecordInput {
  id: string;
  reference: string;
  title: string;
  branchName: string;
  relation: 'owner' | 'branch_manager' | 'integration_admin';
  /** Display name when the viewer may read it; null otherwise. */
  ownerName: string | null;
  /**
   * Optional explicit owner state when the DTO carries it (a Lead waiting for
   * an owner). Without it, a non-owner viewer sees "Another staff member".
   */
  ownerState?: 'waiting' | 'assigned';
  source: {
    sourceLeadId: string;
    statusId: string;
    sourceCode: string;
    sourceCreatedAt: string;
    lastSyncedAt: string;
    lastVerifiedAt: string;
    stale: boolean;
  };
}

/** Display order and labels (DA-11). */
export const LEAD_TABS = ['overview', 'quotations', 'bitrix'] as const satisfies readonly LeadTab[];

export const LEAD_TAB_LABEL: Record<LeadTab, string> = {
  overview: 'Overview',
  quotations: 'Quotations',
  bitrix: 'Bitrix details',
};

/** Quotations only when the quotation list was readable for this viewer (Lead's Sales owner, branch Manager). */
export function visibleLeadTabs(access: { quotations: boolean }): LeadTab[] {
  return LEAD_TABS.filter((tab) => tab !== 'quotations' || access.quotations);
}

/** `?tab=` against the allowlist; unknown, repeated or not-permitted values render Overview. */
export function parseLeadTab(raw: unknown, visible: readonly LeadTab[] = LEAD_TABS): LeadTab {
  if (typeof raw !== 'string') return 'overview';
  const tab = (LEAD_TABS as readonly string[]).includes(raw) ? (raw as LeadTab) : null;
  return tab && visible.includes(tab) ? tab : 'overview';
}

export function leadHref(leadId: string, tab: LeadTab = 'overview'): string {
  return tab === 'overview' ? `/app/leads/${leadId}` : `/app/leads/${leadId}?tab=${tab}`;
}

export function leadTabItems(leadId: string, visible: readonly LeadTab[], current: LeadTab): TabItemVM<LeadTab>[] {
  return visible.map((tab) => ({ tab, label: LEAD_TAB_LABEL[tab], href: leadHref(leadId, tab), current: tab === current }));
}

export function leadOwnerVM(lead: Pick<LeadRecordInput, 'relation' | 'ownerName' | 'ownerState'>): RecordOwnerVM {
  if (lead.relation === 'owner') return { kind: 'you' };
  if (lead.ownerState === 'waiting') return { kind: 'waiting' };
  const name = lead.ownerName?.trim();
  return name ? { kind: 'colleague', displayName: name } : { kind: 'colleague' };
}

function ownerActor(owner: RecordOwnerVM): string | undefined {
  if (owner.kind === 'you') return 'You';
  if (owner.kind === 'colleague') return owner.displayName ?? 'Another staff member';
  return undefined;
}

export interface LeadWorkspaceInput {
  lead: LeadRecordInput;
  /** Raw `?tab=` value. */
  tab: unknown;
  /** loadQuotationsForLead result with 'not_installed' already mapped to null. */
  quotations: QuotationListView | null;
  /** Bitrix name map for this render (loadBitrixNameLookup); default switched off (DA-93). */
  names?: BitrixNameLookup;
}

/** Only the current tab's model is built. */
export function buildLeadWorkspace(input: LeadWorkspaceInput): LeadWorkspaceVM {
  const { lead } = input;
  const visible = visibleLeadTabs({ quotations: input.quotations !== null });
  const current = parseLeadTab(input.tab, visible);
  const owner = leadOwnerVM(lead);
  const names = input.names ?? BITRIX_NAMES_OFF;
  const status = bitrixName(names, 'STATUS', lead.source.statusId);
  const source = bitrixName(names, 'SOURCE', lead.source.sourceCode);
  const actor = ownerActor(owner);
  const workspace: LeadWorkspaceVM = {
    header: {
      leadId: lead.id,
      reference: lead.reference,
      title: lead.title,
      status,
      owner,
      branchName: lead.branchName,
      bitrixLate: lead.source.stale,
      next: { text: 'follow up in Bitrix', ...(actor ? { actor } : {}) },
      canCreateQuotation: Boolean(input.quotations?.canCreate),
    },
    tabs: leadTabItems(lead.id, visible, current),
    current,
  };
  if (current === 'overview') {
    workspace.overview = { source, createdInBitrixAt: lead.source.sourceCreatedAt, branchName: lead.branchName, owner };
  }
  if (current === 'bitrix') {
    workspace.bitrix = {
      sourceLeadId: lead.source.sourceLeadId,
      status,
      source,
      createdInBitrixAt: lead.source.sourceCreatedAt,
      lastCheckedAt: lead.source.lastVerifiedAt,
      lastChangeAt: lead.source.lastSyncedAt,
      relation: lead.relation,
    };
  }
  return workspace;
}
