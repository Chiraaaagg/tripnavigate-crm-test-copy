import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthCard } from '@/components/AuthCard';
import { SignInForm } from '@/views/auth-forms';

export const metadata: Metadata = { title: 'Sign in' };

const NOTICES: Record<string, string> = {
  link_invalid:
    'That link is invalid or has expired. Ask your administrator for a new invitation, or request a new password reset email.',
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; notice?: string }>;
}) {
  const { next, notice } = await searchParams;
  const noticeText = notice ? NOTICES[notice] : undefined;
  return (
    <AuthCard title="Sign in">
      {noticeText ? (
        <div className="message info" role="status">
          {noticeText}
        </div>
      ) : null}
      <p>Staff accounts are created by invitation only. Every sign-in requires your authenticator app.</p>
      <SignInForm next={next} />
      <ul className="mt-15">
        <li>
          <Link href="/forgot-password">Forgot your password?</Link>
        </li>
        <li>
          <Link href="/mfa/recovery">Lost access to your authenticator app?</Link>
        </li>
      </ul>
    </AuthCard>
  );
}
