import 'server-only';
import type { StaffContext } from '@/modules/identity/server/session';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { PartyCheckDetail, PartyCheckFilter, PartyCheckRow } from '@/views/booking-form/vn-types';
import { partyHistoryLine, toPartyOption } from '../party-forms';
import { accountsParties, getParty } from './parties-db';

/**
 * Accounts customer check reads (voice-note batch, owner item 10). Under the
 * viewer's own session: customer_party_accounts_list is Accounts-only and
 * customer_party_get decides who may read one customer (never Purchase).
 * Bounded pages; a refused or failed read is null ("could not be read"),
 * never an empty list.
 */

type Staff = Pick<StaffContext, 'supabase'>;

export const PARTY_PAGE_SIZE = 50;
export const PARTY_FILTERS: readonly PartyCheckFilter[] = ['not_checked', 'returned', 'checked'];
export const PARTY_FILTER_LABEL: Record<PartyCheckFilter, string> = { not_checked: 'Not checked', returned: 'Returned', checked: 'Checked' };

export function parsePartyFilter(raw: string | string[] | undefined): PartyCheckFilter {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (PARTY_FILTERS as readonly string[]).includes(v ?? '') ? (v as PartyCheckFilter) : 'not_checked';
}

export function parsePageOffset(raw: string | string[] | undefined): number {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && /^\d{1,5}$/.test(v) && Number(v) % PARTY_PAGE_SIZE === 0 ? Number(v) : 0;
}

export const customerCheckHref = (partyId: string) => `/app/accounts/customers/${partyId}`;
export const partyFileHref = (partyId: string, fileId: string) => `/app/accounts/customers/${partyId}/files/${fileId}`;

export async function loadPartiesToCheck(staff: Staff, status: PartyCheckFilter, offset: number): Promise<{ items: PartyCheckRow[]; hasMore: boolean } | null> {
  try {
    const page = await accountsParties(asRpcClient(staff.supabase), { status, limit: PARTY_PAGE_SIZE, offset });
    return {
      hasMore: page.hasMore,
      items: page.items.map((p) => ({
        partyId: p.id,
        href: customerCheckHref(p.id),
        type: p.partyType,
        name: p.name,
        contactLine: null,
        place: [p.city, p.branchName].filter(Boolean).join(' · ') || null,
        gstLine: p.gstin ? `GSTIN ${p.gstin}` : null,
        status: p.checkStatus,
        sourceLabel: null,
        addedAt: p.createdAt,
        addedByName: p.createdByName ?? null,
      })),
    };
  } catch {
    return null;
  }
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface PartyCheckLoad {
  party: PartyCheckDetail;
  canEdit: boolean;
  canCheck: boolean;
  checkBlockedReason: string | null;
}

/** One customer for the Accounts check screen; null when not visible (same answer as missing). */
export async function loadPartyForCheck(staff: Staff, partyId: string): Promise<PartyCheckLoad | null> {
  if (!/^[0-9a-f-]{36}$/i.test(partyId)) return null;
  const p = await getParty(asRpcClient(staff.supabase), partyId);
  if (!p) return null;
  const party: PartyCheckDetail = {
    ...toPartyOption(p),
    rowVersion: p.rowVersion,
    returnedReason: p.checkStatus === 'returned' ? (p.checkReason ?? null) : null,
    checkedByName: p.checkedByName ?? null,
    checkedAt: p.checkedAt ?? null,
    files: (p.documents ?? [])
      .filter((d) => d.status === 'stored')
      .map((d) => ({ fileId: d.id, kind: d.kind, fileName: d.fileName, sizeLabel: sizeLabel(d.sizeBytes), downloadHref: partyFileHref(p.id, d.id) })),
    // Started uploads and file views are noise on this screen; the rest is listed newest first.
    history: (p.history ?? []).filter((h) => h.action !== 'party.document_started' && h.action !== 'party.document_viewed').map(partyHistoryLine),
    usedOn: (p.usedOn ?? []).map((u) => ({ reference: u.reference ?? u.title ?? 'Deal', href: `/app/accounts/deals/${u.dealId}` })),
  };
  const canCheck = p.canCheck === true;
  return {
    party,
    // The Accounts screen edits with customer_party_accounts_save (Accounts of the customer's company).
    canEdit: p.canAccountsEdit === true,
    canCheck,
    checkBlockedReason: canCheck ? null : 'Only Accounts can check or return customers.',
  };
}
