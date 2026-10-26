import type { Metadata } from 'next';
import { WorkErrorBoundary } from '@/components/WorkErrorBoundary';
import { accountsRoleEntityIds } from '@/modules/parties/import-access';
import { requireStaff } from '@/modules/identity/server/session';
import { loadPartyForCheck } from '@/modules/parties/server/party-check';
import { checkPartyAction, returnPartyAction, saveCheckedPartyAction } from '@/modules/parties/server/party-check-actions';
import type { B11Action } from '@/views/b11/shapes';
import { CustomerCheckView } from '@/views/accounts/customer-check';
import { notFound } from 'next/navigation';

export const metadata: Metadata = { title: 'Check customer' };

/**
 * One customer for Accounts (voice-note batch, owner item 10): details,
 * documents, Check / Edit / Return with a reason. customer_party_get decides
 * who may read it (never Purchase); this page is for Accounts only (Echo-A L12). A customer that is not visible gets the
 * same not-found page as a missing one.
 */
export default async function CustomerCheckPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const staff = await requireStaff();
  // Echo-A L12: the check screen is Accounts only. Sales and Managers who may read a customer use Bill To;
  // anyone else gets the same not-found page as a missing customer (the database still decides every read).
  if (accountsRoleEntityIds(staff.access).length === 0) notFound();
  // An unexplained read failure reaches the route error boundary ("could not load"), never an empty page.
  const loaded = await loadPartyForCheck(staff, id);
  if (!loaded) notFound();
  return (
    <WorkErrorBoundary title="Check customer">
      <CustomerCheckView
        party={loaded.party}
        backHref="/app/accounts/customers"
        canEdit={loaded.canEdit}
        canCheck={loaded.canCheck}
        checkBlockedReason={loaded.checkBlockedReason}
        actions={{ save: saveCheckedPartyAction as unknown as B11Action, check: checkPartyAction as unknown as B11Action, returnParty: returnPartyAction as unknown as B11Action }}
      />
    </WorkErrorBoundary>
  );
}
