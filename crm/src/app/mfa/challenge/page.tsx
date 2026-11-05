import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/AuthCard';
import { requireSignedIn } from '@/modules/identity/server/session';
import { safeNextPath } from '@/modules/identity/session-policy';
import { MfaChallengeForm } from '@/views/auth-forms';

export const metadata: Metadata = { title: 'Verify sign-in' };

export default async function MfaChallengePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const { supabase, snapshot } = await requireSignedIn();
  if (snapshot.claims?.aal === 'aal2') redirect(safeNextPath(next));
  const { data } = await supabase.auth.mfa.listFactors();
  const factors = (data?.totp ?? [])
    .filter((f) => f.status === 'verified')
    .map((f) => ({ id: f.id, name: f.friendly_name ?? 'Authenticator app' }));
  if (factors.length === 0) redirect('/mfa/enroll');
  return (
    <AuthCard title="Enter your authenticator code">
      <MfaChallengeForm factors={factors} next={next} />
      <p className="mt-15">
        <Link href="/mfa/recovery">Lost access to your authenticator app?</Link>
      </p>
    </AuthCard>
  );
}
