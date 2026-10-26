import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { AuthCard } from '@/components/AuthCard';
import { ForgotPasswordForm } from '@/views/auth-forms';

export const metadata: Metadata = { title: 'Forgot password' };

export default async function ForgotPasswordPage() {
  // Rendered per request so the CSP nonce is applied.
  await connection();
  return (
    <AuthCard title="Reset your password">
      <p>
        Enter your work email. If it belongs to an active staff account, we send a link to choose a new password. You
        will still need your authenticator app to sign in.
      </p>
      <ForgotPasswordForm />
      <p className="mt-15">
        <Link href="/sign-in">Back to sign in</Link>
      </p>
    </AuthCard>
  );
}
