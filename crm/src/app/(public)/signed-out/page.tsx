import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthCard } from '@/components/AuthCard';

export const metadata: Metadata = { title: 'Signed out' };

export default async function SignedOutPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; provider?: string }>;
}) {
  const { scope, provider } = await searchParams;
  const global = scope === 'global';
  const providerFailed = global && provider === 'failed';
  const localFailed = !global && provider === 'failed';
  if (localFailed) {
    return (
      <AuthCard title="Sign-out not confirmed">
        <div className="message error" role="alert">
          <strong>Error: </strong>The sign-in service could not confirm signing you out, so this browser may still be
          signed in.
          <ul className="mb-0">
            <li>Go back and use “Sign out” again, or</li>
            <li>close every window of this browser, especially on a shared computer.</li>
          </ul>
        </div>
        <Link className="button secondary" href="/app">
          Back to the CRM
        </Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="You have signed out">
      {providerFailed ? (
        <div className="message error" role="alert">
          <strong>Error: </strong>Database access to CRM data was revoked for all of your sessions, but the sign-in
          service could not confirm signing out your other devices.
          <ul className="mb-0">
            <li>Sign in again and use “Sign out of all devices” again, or</li>
            <li>contact your administrator.</li>
          </ul>
        </div>
      ) : (
        <div className="message success" role="status">
          {global
            ? 'You have been signed out here and on every other device.'
            : 'You have been signed out on this device.'}
        </div>
      )}
      {global ? (
        <p>
          Other devices lose access to CRM data at their next request and must sign in again with your password and
          authenticator app.
        </p>
      ) : null}
      <p>If you use a shared computer, close the browser window as well.</p>
      <Link className="button secondary" href="/sign-in">
        Sign in again
      </Link>
    </AuthCard>
  );
}
