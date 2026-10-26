import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { AuthCard } from '@/components/AuthCard';

export const metadata: Metadata = { title: 'Authenticator recovery' };

/** Recovery is deliberately administrator-assisted; there is no self-service bypass. */
export default async function MfaRecoveryPage() {
  // Rendered per request so the CSP nonce is applied.
  await connection();
  return (
    <AuthCard title="Lost your authenticator app?">
      <p>
        You cannot sign in without your authenticator. There is no email or SMS fallback, because that would weaken
        the protection on customer and payment records.
      </p>
      <h2>What to do</h2>
      <ol className="steps">
        <li>If you set up a second authenticator (recommended), sign in and choose it on the code screen.</li>
        <li>
          Otherwise, contact your administrator in person or by phone. They will confirm your identity using a channel
          they already know, not one you supply in the request.
        </li>
        <li>
          The administrator starts authenticator recovery and records a reason. From that moment every session on your
          account is blocked, on all devices. They cannot do this for their own account.
        </li>
        <li>Sign in with your password and set up a new authenticator app.</li>
        <li>
          Your screen then shows a 6-character confirmation code. Read it to your administrator over the channel you
          agreed. When they confirm it, your access returns.
        </li>
      </ol>
      <div className="message info" role="note">
        If your phone was lost or stolen, tell your administrator immediately so your sessions can be reviewed.
      </div>
      <Link href="/sign-in">Back to sign in</Link>
    </AuthCard>
  );
}
