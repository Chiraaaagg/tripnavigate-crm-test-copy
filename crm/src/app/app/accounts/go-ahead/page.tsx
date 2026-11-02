import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import { decideGoAheadAction } from '@/modules/procurement/server/actions';
import { loadAccountsGoAheadList } from '@/modules/procurement/server/queries';
import { AccountsGoAheadPage, parseGoAheadTab } from '@/views/accounts/supplier-go-ahead';

export const metadata: Metadata = { title: 'Hotel go-ahead requests' };

/**
 * Accounts · Hotel go-ahead requests (Purchase build, owner decision 1).
 * accounts_go_ahead_list returns only requests in entities where the viewer
 * is Accounts (and not Purchase); the decision command re-checks everything.
 */
export default async function AccountsGoAheadRoute({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const staff = await requireStaff();
  const { tab } = await searchParams;
  const rows = await loadAccountsGoAheadList(staff);
  return <AccountsGoAheadPage rows={rows} tab={parseGoAheadTab(tab)} decideAction={decideGoAheadAction} />;
}
