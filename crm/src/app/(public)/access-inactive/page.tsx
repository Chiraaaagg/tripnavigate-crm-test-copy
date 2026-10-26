import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthCard } from '@/components/AuthCard';
import { signOutAction } from '@/modules/identity/server/actions';

export const metadata: Metadata = { title: 'No active access' };

const REASONS: Record<string, string> = {
  onboarding_failed: 'Your invitation could not be completed. It may have been cancelled.',
};

export default async function AccessInactivePage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  return (
    <AuthCard title="You do not have active access">
      <div className="message error" role="alert">
        {(reason && REASONS[reason]) ??
          'Your staff account or branch membership is not active. No CRM data is available to this account.'}
      </div>
      <p>If you believe this is a mistake, contact your administrator. They can confirm your branch and role.</p>
      <div className="button-row">
        <form action={signOutAction}>
          <button type="submit" className="button">
            Sign out
          </button>
        </form>
        <Link href="/sign-in">Back to sign in</Link>
      </div>
    </AuthCard>
  );
}
