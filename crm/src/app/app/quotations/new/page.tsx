import type { Metadata } from 'next';
import { financeEnabledEntityIds } from '@/modules/finance/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { NewWorkScreen } from '@/views/b12/referral-views';
import { loadNewWork } from '../new-work';
import { REFERRAL_CREATE } from '../referral-actions';

export const metadata: Metadata = { title: 'New quotation' };

/** QN (Batch 3, FP-041/FP-042): for a lead or deal (links to the lists) or a referral draft (switch on only). */
export default async function NewQuotationPage() {
  const staff = await requireStaff();
  const vm = await loadNewWork(staff, 'quotations', await financeEnabledEntityIds(staff));
  return <NewWorkScreen vm={vm} createAction={REFERRAL_CREATE.quotations} />;
}
