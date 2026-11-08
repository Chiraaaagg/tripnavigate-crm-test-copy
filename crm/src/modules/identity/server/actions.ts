'use server';

import { createClient } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getAppConfig, isInviteRecipientAllowed } from '@/lib/config';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { type FormState, fieldValue } from '@/lib/forms';
import {
  ROUTES,
  decideMfaStep,
  decidePasswordStep,
  parseSessionStatus,
  routeForSessionState,
  safeNextPath,
} from '../session-policy';
import { requireSignedIn } from './session';

const GENERIC_SIGN_IN_ERROR =
  'Email or password is incorrect, or this account is not active. Contact your administrator if you need help.';

const SignInInput = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(200),
  next: z.string().max(200).optional(),
});

export async function signInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = SignInInput.safeParse({
    email: fieldValue(formData, 'email'),
    password: fieldValue(formData, 'password'),
    next: fieldValue(formData, 'next'),
  });
  if (!parsed.success) {
    return { status: 'error', message: 'Enter your work email and password.' };
  }
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email.toLowerCase(),
    password: parsed.data.password,
  });
  if (error) {
    // One message for wrong password, unknown user and banned user (no enumeration).
    return { status: 'error', message: GENERIC_SIGN_IN_ERROR };
  }
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const step = decideMfaStep({
    hadSessionCookie: true,
    claims: { sub: 'signed-in', aal: aal?.currentLevel ?? 'aal1' },
    verifiedFactorCount: aal?.nextLevel === 'aal2' ? 1 : 0,
  });
  const next = safeNextPath(parsed.data.next);
  if (step.kind === 'redirect') {
    redirect(`${step.to}?next=${encodeURIComponent(next)}`);
  }
  redirect(next);
}

export async function signOutAction(formData: FormData): Promise<void> {
  if (formData.get('scope') === 'global') {
    await signOutEverywhereAction(formData);
    return;
  }
  const supabase = await createSupabaseServerClient();
  // A provider error can leave this browser's session in place, so the page
  // must not claim a sign-out that did not happen.
  let failed = false;
  try {
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    failed = Boolean(error);
  } catch {
    failed = true;
  }
  redirect(failed ? `${ROUTES.signedOut}?provider=failed` : ROUTES.signedOut);
}

/**
 * "Sign out of all devices". First moves the caller's session barrier in the
 * database (revoke_my_sessions), so every existing access token is denied by
 * RLS at once; then asks the provider to revoke all refresh tokens. If the
 * database step fails (it requires a fresh aal2 session) nothing is claimed
 * and the user stays signed in.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature fixed by contracts.ts (form action)
export async function signOutEverywhereAction(_formData: FormData): Promise<void> {
  const { supabase } = await requireSignedIn();
  const { error } = await supabase.rpc('revoke_my_sessions');
  if (error) {
    throw new Error('Could not sign you out of other devices. Please retry.');
  }
  // Database access is already revoked. If the provider step fails, say so:
  // other devices may still refresh tokens (which the database then denies)
  // and may need to be signed out by hand.
  let providerFailed = false;
  try {
    const { error: signOutError } = await supabase.auth.signOut({ scope: 'global' });
    providerFailed = Boolean(signOutError);
  } catch {
    providerFailed = true;
  }
  redirect(`${ROUTES.signedOut}?scope=global${providerFailed ? '&provider=failed' : ''}`);
}

const PASSWORD_RESET_NOTICE =
  'If that address belongs to a staff account, a password reset link has been handed to the mail service. ' +
  'Check your inbox in a few minutes. You will still need your authenticator app after choosing a new password.';

/**
 * Public "Forgot password?". Always returns the same message (no account
 * enumeration) and writes no database row. Outside production the recipient
 * must be on the environment allow-list, so no real person is emailed by a
 * test deployment. The link lands on /auth/confirm (type=recovery).
 */
export async function requestPasswordResetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = z.email().max(254).safeParse(fieldValue(formData, 'email')?.trim().toLowerCase());
  const config = getAppConfig();
  if (parsed.success && isInviteRecipientAllowed(config, parsed.data)) {
    const publicClient = createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    try {
      await publicClient.auth.resetPasswordForEmail(parsed.data, { redirectTo: `${config.siteUrl}/auth/confirm` });
    } catch {
      // Deliberately ignored: the response must not reveal anything.
    }
  }
  return { status: 'success', message: PASSWORD_RESET_NOTICE };
}

const PasswordInput = z
  .object({
    password: z.string().min(12, 'Use at least 12 characters.').max(200),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { message: 'The two passwords do not match.', path: ['confirm'] });

const FACTOR_READ_FAILED =
  'We could not check your authenticator, so your password was not changed. Please retry in a moment.';

/**
 * Number of verified MFA factors, read from the provider (not from the token)
 * right before a password change. Returns null when the list cannot be read:
 * the caller must then refuse the change (fail closed).
 */
async function readVerifiedFactorCount(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
): Promise<number | null> {
  try {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error || !data || !Array.isArray(data.all)) return null;
    return data.all.filter((factor) => factor.status === 'verified').length;
  } catch {
    return null;
  }
}

/**
 * Password step of invitation onboarding and of password recovery (both
 * arrive through an emailed link with an aal1 session). The factor list is
 * read first and a failed read refuses the change. An account with a verified
 * authenticator must be at aal2 before updateUser is called (AUDIT-013).
 */
export async function setInitialPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { supabase, snapshot } = await requireSignedIn();
  const verifiedFactors = await readVerifiedFactorCount(supabase);
  if (verifiedFactors === null) {
    return { status: 'error', message: FACTOR_READ_FAILED };
  }
  const step = decidePasswordStep({
    ...snapshot,
    verifiedFactorCount: Math.max(snapshot.verifiedFactorCount, verifiedFactors),
  });
  if (step.kind === 'redirect') redirect(step.to);
  const parsed = PasswordInput.safeParse({
    password: fieldValue(formData, 'password'),
    confirm: fieldValue(formData, 'confirm'),
  });
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the password fields.' };
  }
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    return {
      status: 'error',
      message: 'The password was not accepted. Use 12+ characters with upper and lower case letters and digits.',
    };
  }
  // A recovered account already passed its authenticator challenge (aal2):
  // continue where the database says. A new account sets up its authenticator.
  redirect(verifiedFactors > 0 ? await routeAfterMfa(ROUTES.home) : ROUTES.mfaEnroll);
}

export interface EnrollmentStart {
  status: 'ready' | 'error';
  factorId?: string;
  qrCode?: string;
  secret?: string;
  message?: string;
}

/** Starts TOTP enrollment. Returns the QR code and manual-entry key to the user only. */
export async function startTotpEnrollmentAction(): Promise<EnrollmentStart> {
  const { supabase, snapshot } = await requireSignedIn();
  const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
  if (listError) {
    return { status: 'error', message: 'Could not start authenticator setup. Please retry.' };
  }
  // A password-only (aal1) session must not add a factor to an account that
  // already has a verified one: that would let a stolen password replace MFA.
  const hasVerified = (factors?.all ?? []).some((f) => f.status === 'verified');
  if (hasVerified && snapshot.claims?.aal !== 'aal2') {
    return {
      status: 'error',
      message: 'This account already has an authenticator. Use it to sign in, or ask an administrator to reset it.',
    };
  }
  // Remove abandoned, never-verified factors so retries do not accumulate.
  for (const factor of factors?.all ?? []) {
    if (factor.status === 'unverified') {
      await supabase.auth.mfa.unenroll({ factorId: factor.id });
    }
  }
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: `Authenticator app ${new Date().toISOString().slice(0, 16)}`,
  });
  if (error || !data) {
    return { status: 'error', message: 'Could not start authenticator setup. Please retry.' };
  }
  return { status: 'ready', factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
}

const CodeInput = z.object({
  factorId: z.uuid(),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.'),
  next: z.string().max(200).optional(),
});

async function verifyCode(formData: FormData): Promise<FormState | null> {
  const { supabase } = await requireSignedIn();
  const parsed = CodeInput.safeParse({
    factorId: fieldValue(formData, 'factorId'),
    code: fieldValue(formData, 'code')?.replace(/\s/g, ''),
    next: fieldValue(formData, 'next'),
  });
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Enter the 6-digit code.' };
  }
  // Supabase rejects factors that do not belong to the signed-in user.
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId: parsed.data.factorId,
    code: parsed.data.code,
  });
  if (error) {
    return { status: 'error', message: 'That code was not accepted. Wait for a new code and try again.' };
  }
  return null;
}

/**
 * Where to go after a successful MFA step, decided by the database: invited
 * staff finish onboarding, staff under MFA recovery go to /account-recovery,
 * active staff to `fallback`. Unknown answers fail closed to /session-expired.
 */
async function routeAfterMfa(fallback: string): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('my_session_status');
  const status = error ? null : parseSessionStatus(data);
  if (!status) return ROUTES.sessionExpired;
  if (status.state === 'ok') return fallback;
  const decision = routeForSessionState(status.state, 1);
  return decision.kind === 'redirect' ? decision.to : fallback;
}

export async function verifyEnrollmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const failure = await verifyCode(formData);
  if (failure) return failure;
  redirect(await routeAfterMfa(ROUTES.home));
}

export async function verifyChallengeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const failure = await verifyCode(formData);
  if (failure) return failure;
  redirect(await routeAfterMfa(safeNextPath(fieldValue(formData, 'next'))));
}

/**
 * Activates an invited staff member. The database function refuses anything
 * below aal2, so this cannot be reached by skipping the MFA screens.
 */
export async function finishOnboardingAction(): Promise<void> {
  const { supabase, snapshot } = await requireSignedIn();
  if (snapshot.claims?.aal !== 'aal2') {
    redirect(ROUTES.mfaEnroll);
  }
  const { error } = await supabase.rpc('accept_my_invitation');
  if (error) {
    // e.g. an open recovery case or an expired session: let the database say which.
    const next = await routeAfterMfa(`${ROUTES.accessInactive}?reason=onboarding_failed`);
    redirect(next === ROUTES.finishOnboarding ? `${ROUTES.accessInactive}?reason=onboarding_failed` : next);
  }
  redirect(ROUTES.home);
}
