import Link from 'next/link';
import { connection } from 'next/server';
import { AuthCard } from '@/components/AuthCard';

export default async function NotFound() {
  // Render per request so the CSP nonce applies to this page's scripts.
  await connection();
  return (
    <AuthCard title="Page not found">
      <p>The page you asked for does not exist.</p>
      <Link href="/app">Go to the CRM home page</Link>
    </AuthCard>
  );
}
