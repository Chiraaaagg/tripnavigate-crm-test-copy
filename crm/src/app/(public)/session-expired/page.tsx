import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { AuthCard } from '@/components/AuthCard';

export const metadata: Metadata = { title: 'Session ended' };

export default async function SessionExpiredPage() {
  // Rendered per request so the CSP nonce is applied.
  await connection();
  return (
    <AuthCard title="Your session has ended">
      <div className="message info" role="status">
        Your session has expired or was ended. No CRM data is available to it.
      </div>
      <p>Sessions end for security when:</p>
      <ul>
        <li>you have been inactive for a while, or the session reached its maximum length, even while active;</li>
        <li>you, on any device, chose “Sign out of all devices”;</li>
        <li>your administrator started authenticator recovery for your account;</li>
        <li>your account was deactivated.</li>
      </ul>
      <p>
        Any change you had not saved was not recorded. Sign in again with your password and authenticator app to
        continue. If your account is under recovery or deactivated, you will see what to do next after signing in.
      </p>
      <Link className="button" href="/sign-in">
        Sign in again
      </Link>
    </AuthCard>
  );
}
