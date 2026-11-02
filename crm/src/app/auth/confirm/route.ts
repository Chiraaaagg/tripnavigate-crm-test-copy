import { type NextRequest, NextResponse } from 'next/server';
import { getAppConfig } from '@/lib/config';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Email link target for invitations (type=invite) and password recovery /
 * invitation resends (type=recovery).
 *
 * GET never spends the one-time token (mail link scanners and cross-site
 * navigations would otherwise consume it or sign the victim in to someone
 * else's account): it only validates the parameters and 303-redirects to
 * /auth/accept, a page with a "Continue" button that POSTs them back here.
 *
 * POST requires a same-origin request (Origin header, or Sec-Fetch-Site:
 * same-origin when Origin is absent), verifies the token and 303-redirects to
 * /onboarding/password. MFA, requireStaff() and the database still refuse data
 * while a recovery case is open. Public sign-up is disabled in Supabase Auth.
 */
type LinkType = 'invite' | 'recovery';
const TOKEN_HASH = /^[A-Za-z0-9_-]{16,512}$/;

function parseLink(type: unknown, tokenHash: unknown): { type: LinkType; tokenHash: string } | null {
  if (typeof tokenHash !== 'string' || !TOKEN_HASH.test(tokenHash)) return null;
  if (type !== 'invite' && type !== 'recovery') return null;
  return { type, tokenHash };
}

function invalid(): NextResponse {
  return NextResponse.redirect(new URL('/sign-in?notice=link_invalid', getAppConfig().siteUrl), 303);
}

function isSameOrigin(request: NextRequest): boolean {
  // Next's internal request URL may use localhost behind the public hostname.
  // Only the configured public origin is authoritative, never forwarded hosts.
  const allowed = new URL(getAppConfig().siteUrl).origin;
  const origin = request.headers.get('origin');
  if (origin) return origin === allowed;
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

export async function GET(request: NextRequest) {
  const link = parseLink(request.nextUrl.searchParams.get('type'), request.nextUrl.searchParams.get('token_hash'));
  if (!link) return invalid();
  const target = new URL('/auth/accept', getAppConfig().siteUrl);
  target.searchParams.set('type', link.type);
  target.searchParams.set('token_hash', link.tokenHash);
  return NextResponse.redirect(target, 303);
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return invalid();
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return invalid();
  }
  const link = parseLink(form.get('type'), form.get('token_hash'));
  if (!link) return invalid();

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({ type: link.type, token_hash: link.tokenHash });
  if (error) return invalid();
  return NextResponse.redirect(new URL('/onboarding/password', getAppConfig().siteUrl), 303);
}
