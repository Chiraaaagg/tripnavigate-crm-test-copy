import Link from 'next/link';
import { AuthCard } from '@/components/AuthCard';

export type EmailLinkType = 'invite' | 'recovery';

const TOKEN_HASH = /^[A-Za-z0-9_-]{16,512}$/;

/** Validates the email-link parameters; null when malformed (shown as an invalid link). */
export function parseEmailLink(type: unknown, tokenHash: unknown): { type: EmailLinkType; tokenHash: string } | null {
  if ((type !== 'invite' && type !== 'recovery') || typeof tokenHash !== 'string' || !TOKEN_HASH.test(tokenHash)) {
    return null;
  }
  return { type, tokenHash };
}

/**
 * Interstitial for email links. The one-time token is only spent by the POST
 * this page sends when a person selects Continue, so mail scanners that
 * prefetch links cannot use it up.
 */
export function AcceptEmailLinkView({ link }: { link: { type: EmailLinkType; tokenHash: string } | null }) {
  if (!link) {
    return (
      <AuthCard title="This link cannot be used">
        <div className="message error" role="alert">
          <strong>Error: </strong>The link is incomplete or invalid. It may have been copied only in part.
        </div>
        <ul>
          <li>For a new invitation, ask your administrator to resend it.</li>
          <li>
            To reset your password, <Link href="/forgot-password">request a new reset email</Link>.
          </li>
        </ul>
        <Link href="/sign-in">Back to sign in</Link>
      </AuthCard>
    );
  }
  const invite = link.type === 'invite';
  return (
    <AuthCard title={invite ? 'Accept your invitation' : 'Reset your password'}>
      <p id="accept-help">
        {invite
          ? 'Select Continue to accept your TripNavigate CRM invitation. You will then choose a password and set up an authenticator app.'
          : 'Select Continue to choose a new password. Your authenticator app is still required to sign in.'}
      </p>
      <p className="hint">The link works once and expires. If it has expired, you will be asked to get a new one.</p>
      <form method="post" action="/auth/confirm">
        <input type="hidden" name="type" value={link.type} />
        <input type="hidden" name="token_hash" value={link.tokenHash} />
        <button type="submit" className="button" aria-describedby="accept-help">
          Continue
        </button>
      </form>
      <p className="mt-15">
        <Link href="/sign-in">Back to sign in</Link>
      </p>
    </AuthCard>
  );
}
