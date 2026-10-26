import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { RECOVERY_PENDING_ROUTE } from '@/modules/identity/contracts';
import { getMySessionStatus, requireSignedIn } from '@/modules/identity/server/session';
import { FinishOnboardingView } from '@/views/status-views';

export const metadata: Metadata = { title: 'Finish setup' };

export default async function FinishOnboardingPage() {
  const { supabase, snapshot, userId } = await requireSignedIn();
  if (snapshot.claims?.aal !== 'aal2') redirect('/mfa/challenge');
  // verifyEnrollmentAction lands here after any TOTP enrollment, including
  // re-enrollment during authenticator recovery: send those users back to
  // their recovery page instead of onboarding.
  const status = await getMySessionStatus();
  if (status.state === 'recovery_pending') redirect(RECOVERY_PENDING_ROUTE);
  if (status.state === 'ok') redirect('/app');
  const { data: profile } = await supabase
    .from('staff_profiles')
    .select('status')
    .eq('user_id', userId)
    .maybeSingle();
  if (profile?.status === 'active') redirect('/app');
  if (profile?.status !== 'invited') redirect('/access-inactive');
  return <FinishOnboardingView />;
}
