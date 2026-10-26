import type { Metadata } from 'next';
import { financeEnabledEntityIds } from '@/modules/finance/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { NewWorkScreen } from '@/views/b12/referral-views';
import { loadNewWork } from '../../quotations/new-work';
import { REFERRAL_CREATE } from '../../quotations/referral-actions';

export const metadata: Metadata = { title: 'New itinerary' };

/** IN (Batch 3, FP-052/FP-053): from a quotation or deal (links to the lists) or a referral draft "not from a quotation". */
export default async function NewItineraryPage() {
  const staff = await requireStaff();
  const vm = await loadNewWork(staff, 'itineraries', await financeEnabledEntityIds(staff));
  return <NewWorkScreen vm={vm} createAction={REFERRAL_CREATE.itineraries} />;
}
