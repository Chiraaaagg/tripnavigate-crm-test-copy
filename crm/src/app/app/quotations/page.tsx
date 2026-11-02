import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireStaff } from '@/modules/identity/server/session';
import { findReferralDraft, loadQuotationWorkList } from '@/modules/quotations/server/referral';
import { referralDraftHref } from '@/modules/quotations/subject-links';
import { parseWorkListQuery, quotationListPageVM } from '@/modules/quotations/work-model';
import { QuotationsListScreen } from '@/views/b12/work-lists';

export const metadata: Metadata = { title: 'Quotations' };

type Params = { filter?: string | string[]; scope?: string | string[]; after?: string | string[]; reference?: string | string[] };

/**
 * QL (Direction A Batch 3, FP-040): the person's quotations, scoped by the
 * database (work_drafts_list: Sales own/assigned, branch Manager; nobody else).
 * `?filter=`, `?scope=mine|all`, keyset `?after=`, exact `?reference=TQ-n|TD-n`.
 * A TD-n reference opens the referral draft itself (closed drafts included,
 * owner or branch Manager only; the same "nothing found" otherwise).
 */
export default async function QuotationsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const staff = await requireStaff();
  const query = parseWorkListQuery('quotations', await searchParams);
  if (query.reference?.startsWith('TD-')) {
    const found = await findReferralDraft(staff, query.reference);
    if (found && typeof found === 'object') redirect(referralDraftHref(found.referralDraftId));
  }
  const result = await loadQuotationWorkList(staff, { status: query.filter, scope: query.scope, reference: query.reference }, query.after);
  return <QuotationsListScreen page={quotationListPageVM(query, result)} />;
}
