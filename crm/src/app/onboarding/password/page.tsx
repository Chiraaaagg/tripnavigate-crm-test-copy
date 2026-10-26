import type { Metadata } from 'next';
import { AuthCard } from '@/components/AuthCard';
import { redirect } from 'next/navigation';
import { decidePasswordStep } from '@/modules/identity/session-policy';
import { requireSignedIn } from '@/modules/identity/server/session';
import { PasswordForm } from '@/views/auth-forms';

export const metadata: Metadata = { title: 'Choose a password' };

export default async function OnboardingPasswordPage() {
  const { snapshot } = await requireSignedIn();
  const step = decidePasswordStep(snapshot);
  if (step.kind === 'redirect') redirect(step.to);
  return (
    <AuthCard title="Choose your password">
      <p>
        Next you will use your authenticator app. If this is a new account, or your administrator has started
        authenticator recovery, you will set up a new one.
      </p>
      <PasswordForm />
    </AuthCard>
  );
}
