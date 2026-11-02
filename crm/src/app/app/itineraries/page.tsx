import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireStaff } from '@/modules/identity/server/session';
import { findReferralDraft, loadItineraryWorkList } from '@/modules/quotations/server/referral';
import { referralDraftHref } from '@/modules/quotations/subject-links';
import { itineraryListPageVM, parseWorkListQuery } from '@/modules/quotations/work-model';
import { ItinerariesListScreen } from '@/views/b12/work-lists';

export const metadata: Metadata = { title: 'Itineraries' };

type Params = { filter?: string | string[]; scope?: string | string[]; after?: string | string[]; reference?: string | string[] };

/**
 * IL (Direction A Batch 3, FP-051): the person's itineraries, scoped by the
 * database (work_drafts_list). A TD-n reference opens the referral draft.
 */
export default async function ItinerariesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const staff = await requireStaff();
  const query = parseWorkListQuery('itineraries', await searchParams);
  if (query.reference?.startsWith('TD-')) {
    const found = await findReferralDraft(staff, query.reference);
    if (found && typeof found === 'object') redirect(referralDraftHref(found.referralDraftId));
  }
  const result = await loadItineraryWorkList(staff, { status: query.filter, scope: query.scope, reference: query.reference }, query.after);
  return <ItinerariesListScreen page={itineraryListPageVM(query, result)} />;
}
