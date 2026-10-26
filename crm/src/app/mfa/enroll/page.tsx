import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/AuthCard';
import { requireSignedIn } from '@/modules/identity/server/session';
import { MfaEnrollForm } from '@/views/auth-forms';

export const metadata: Metadata = { title: 'Set up authenticator' };

export default async function MfaEnrollPage() {
  const { supabase, snapshot } = await requireSignedIn();
  if (snapshot.claims?.aal !== 'aal2') {
    // An account that already has a verified authenticator (for example after a
    // password reset) must prove it, not add a new one at aal1.
    const { data } = await supabase.auth.mfa.listFactors();
    if ((data?.totp ?? []).some((f) => f.status === 'verified')) redirect('/mfa/challenge');
  }
  return (
    <AuthCard title="Set up your authenticator app">
      <p>Every TripNavigate staff account must use an authenticator app. CRM data stays locked until this is done.</p>
      <MfaEnrollForm />
    </AuthCard>
  );
}
