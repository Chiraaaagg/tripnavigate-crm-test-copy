import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import { decideCompanyFundingAction, markFundingRecoveredAction } from '@/modules/supplier-money/server/actions';
import { loadAccountsCompanyFunding } from '@/modules/supplier-money/server/queries';
import { AccountsCompanyFundingPage, parseFundingTab } from '@/views/accounts/supplier-funding';
import { accountsSectionViewer } from '../section-viewer';

export const metadata: Metadata = { title: 'Company funding' };

/** Accounts · Company funding: To approve · To recover · All (`?tab=`). */
export default async function AccountsCompanyFundingRoute({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const staff = await requireStaff();
  // Redesign R4 (D5): the Money out tab strip uses the menu's own flags (the frame's cached read, so no new
  // database read); navigation only.
  const sectionViewer = await accountsSectionViewer(staff);
  const { tab: raw } = await searchParams;
  const tab = parseFundingTab(raw);
  const rows = await loadAccountsCompanyFunding(staff, tab);
  return <AccountsCompanyFundingPage rows={rows} tab={tab} actions={{ decide: decideCompanyFundingAction, recover: markFundingRecoveredAction }} sectionViewer={sectionViewer} />;
}
