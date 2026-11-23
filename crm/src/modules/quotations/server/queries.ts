import 'server-only';
import { z } from 'zod';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import { isQuotationFunctionMissing, QuotationCommandError, quotationGet, quotationLinkCandidates, quotationList } from '../commands';
import type { QuotationLinkCandidate, QuotationListView, QuotationSubjectKind, QuotationVersionView } from '../contracts';
import { toLinkCandidates, toQuotationListView, toQuotationVersionView } from '../dto';

/**
 * Quotation reads under the viewer's own session (Atlas definer reads).
 * Answers:
 *   - the view;
 *   - null for a malformed id, a subject or quotation that is not visible,
 *     or any viewer who is not an editor (Accounts, Purchase, Flight, the
 *     desk, Super Admin): the same answer for all;
 *   - 'not_installed' when the database has no quotation functions yet
 *     (PGRST202 / 42883): the page shows that quotations are not available;
 * and throw a retry message (never database text) on anything unexplained.
 */

type Staff = Pick<StaffContext, 'supabase'>;

export const QUOTATIONS_NOT_INSTALLED = 'not_installed' as const;
type Load<T> = Promise<T | null | typeof QUOTATIONS_NOT_INSTALLED>;

const RETRY = 'Could not load the quotation. Please retry.';

function refusedAsNull(error: unknown): boolean {
  return error instanceof QuotationCommandError && (error.code === 'not_authorized' || error.code === 'not_found');
}

async function list(staff: Staff, kind: QuotationSubjectKind, subjectId: string): Load<QuotationListView> {
  const id = z.uuid().safeParse(subjectId);
  if (!id.success) return null;
  try {
    const rows = await quotationList(asRpcClient(staff.supabase), kind, id.data);
    return rows ? toQuotationListView(kind, id.data, rows) : null;
  } catch (error) {
    if (isQuotationFunctionMissing(error)) return QUOTATIONS_NOT_INSTALLED;
    if (refusedAsNull(error)) return null;
    throw new Error(RETRY);
  }
}

export function loadQuotationsForLead(staff: Staff, leadId: string): Load<QuotationListView> {
  return list(staff, 'lead', leadId);
}

export function loadQuotationsForDeal(staff: Staff, dealId: string): Load<QuotationListView> {
  return list(staff, 'deal', dealId);
}

/** Batch 3 (Atlas M5, 2e6bf31): every quotation of a referral draft with all versions (draft editors only; null otherwise). */
export function loadQuotationsForReferral(staff: Staff, referralDraftId: string): Load<QuotationListView> {
  return list(staff, 'referral', referralDraftId);
}

export async function loadQuotation(staff: Staff, versionId: string): Load<QuotationVersionView> {
  const id = z.uuid().safeParse(versionId);
  if (!id.success) return null;
  try {
    const record = await quotationGet(asRpcClient(staff.supabase), id.data);
    return record ? toQuotationVersionView(record) : null;
  } catch (error) {
    if (isQuotationFunctionMissing(error)) return QUOTATIONS_NOT_INSTALLED;
    if (refusedAsNull(error)) return null;
    throw new Error(RETRY);
  }
}

/** Deals a Lead quotation may be linked to (stored Bitrix Lead id matches); null when not visible or not installed. */
export async function loadQuotationLinkCandidates(staff: Staff, quotationId: string): Promise<QuotationLinkCandidate[] | null> {
  const id = z.uuid().safeParse(quotationId);
  if (!id.success) return null;
  try {
    const rows = await quotationLinkCandidates(asRpcClient(staff.supabase), id.data);
    return rows ? toLinkCandidates(rows) : null;
  } catch (error) {
    if (isQuotationFunctionMissing(error) || refusedAsNull(error)) return null;
    throw new Error(RETRY);
  }
}
