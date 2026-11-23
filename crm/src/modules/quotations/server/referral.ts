import 'server-only';
import { z } from 'zod';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import {
  isReferralFunctionMissing,
  ReferralCommandError,
  referralDraftFind,
  referralDraftGet,
  referralDraftsForSubject,
  referralLinkCandidates,
  referralOwnerCandidates,
  workDraftsList,
  type ItineraryWorkPage,
  type QuotationWorkPage,
  type ReferralDraftRecord,
  type ReferralLinkCandidate,
  type ReferralOwnerCandidate,
  type ReferralSubjectDraft,
  type WorkCursor,
  type WorkListFilter,
} from '../referral';

/**
 * Batch 3 reads under the viewer's own session (Atlas definer reads,
 * migration 20261123000100). Each loader answers:
 *   - the record;
 *   - null for a malformed id or anything the viewer may not open (the same
 *     answer for unknown and not-yours);
 *   - 'not_installed' when the database has no Batch 3 functions yet;
 *   - 'error' for anything unexplained (screens say "could not load", never
 *     an empty list or zero).
 */

type Staff = Pick<StaffContext, 'supabase'>;
export const REFERRAL_NOT_INSTALLED = 'not_installed' as const;
export const REFERRAL_LOAD_ERROR = 'error' as const;
type Load<T> = Promise<T | null | typeof REFERRAL_NOT_INSTALLED | typeof REFERRAL_LOAD_ERROR>;

async function guarded<T>(work: () => Promise<T | null>): Load<T> {
  try {
    return await work();
  } catch (error) {
    if (isReferralFunctionMissing(error)) return REFERRAL_NOT_INSTALLED;
    if (error instanceof ReferralCommandError && (error.code === 'not_authorized' || error.code === 'not_found')) return null;
    return REFERRAL_LOAD_ERROR;
  }
}

const uuid = (v: string): string | null => {
  const parsed = z.uuid().safeParse(v);
  return parsed.success ? parsed.data : null;
};

export function loadQuotationWorkList(
  staff: Staff,
  filter: WorkListFilter = {},
  after: WorkCursor | null = null,
  limit?: number,
): Load<QuotationWorkPage> {
  return guarded(() => workDraftsList(asRpcClient(staff.supabase), 'quotations', filter, after, limit));
}

export function loadItineraryWorkList(
  staff: Staff,
  filter: WorkListFilter = {},
  after: WorkCursor | null = null,
  limit?: number,
): Load<ItineraryWorkPage> {
  return guarded(() => workDraftsList(asRpcClient(staff.supabase), 'itineraries', filter, after, limit));
}

export function loadReferralDraft(staff: Staff, draftId: string): Load<ReferralDraftRecord> {
  const id = uuid(draftId);
  if (!id) return Promise.resolve(null);
  return guarded(() => referralDraftGet(asRpcClient(staff.supabase), id));
}

export function findReferralDraft(staff: Staff, reference: string): Load<{ referralDraftId: string }> {
  return guarded(() => referralDraftFind(asRpcClient(staff.supabase), reference));
}

export function loadReferralLinkCandidates(
  staff: Staff,
  draftId: string,
  kind: 'lead' | 'deal',
  query: string | null = null,
): Load<ReferralLinkCandidate[]> {
  const id = uuid(draftId);
  if (!id) return Promise.resolve(null);
  return guarded(() => referralLinkCandidates(asRpcClient(staff.supabase), id, kind, query));
}

export function loadReferralOwnerCandidates(staff: Staff, draftId: string): Load<ReferralOwnerCandidate[]> {
  const id = uuid(draftId);
  if (!id) return Promise.resolve(null);
  return guarded(() => referralOwnerCandidates(asRpcClient(staff.supabase), id));
}

export function loadReferralDraftsForSubject(staff: Staff, kind: 'lead' | 'deal', subjectId: string): Load<ReferralSubjectDraft[]> {
  const id = uuid(subjectId);
  if (!id) return Promise.resolve(null);
  return guarded(() => referralDraftsForSubject(asRpcClient(staff.supabase), kind, id));
}
