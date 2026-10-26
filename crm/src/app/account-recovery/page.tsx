import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getMySessionStatus } from '@/modules/identity/server/session';
import { AccountRecoveryView } from '@/views/recovery-views';

export const metadata: Metadata = { title: 'Authenticator recovery' };
export const dynamic = 'force-dynamic';

/** Landing page for a staff member whose account is under authenticator recovery. */
export default async function AccountRecoveryPage() {
  const status = await getMySessionStatus();
  switch (status.state) {
    case 'no_session':
      redirect('/sign-in');
    case 'session_expired':
    case 'session_revoked':
      // A session older than the recovery barrier: sign in again to continue.
      redirect('/session-expired');
    case 'mfa_required':
      redirect('/mfa/challenge?next=/account-recovery');
    case 'inactive':
    case 'no_membership':
      redirect('/access-inactive');
    case 'onboarding_incomplete':
      redirect('/onboarding/finish');
    default:
      return <AccountRecoveryView recovery={status.recovery ?? null} />;
  }
}
