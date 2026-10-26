import type { Metadata } from 'next';
import { AcceptEmailLinkView, parseEmailLink } from '@/views/link-views';

export const metadata: Metadata = { title: 'Continue from email link' };

/** GET target of email links (via /auth/confirm 303). Never spends the token; Continue POSTs it. */
export default async function AcceptEmailLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string | string[]; token_hash?: string | string[] }>;
}) {
  const { type, token_hash: tokenHash } = await searchParams;
  return <AcceptEmailLinkView link={parseEmailLink(type, tokenHash)} />;
}
