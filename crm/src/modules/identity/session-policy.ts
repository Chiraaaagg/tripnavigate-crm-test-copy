/**
 * Pure session/route decision logic.
 *
 * The database decides (public.my_session_status(), authz.session_valid()):
 * aal2, session auth time after the user's barrier, absolute age from
 * public.security_policy, no open MFA recovery case, active staff. This module
 * only (a) validates the RPC result and (b) maps a state to a route. It holds
 * no session-age value of its own: the policy row is the single source.
 */

import { z } from 'zod';
import { RECOVERY_PENDING_ROUTE, type SessionState, type SessionStatus } from './contracts';

export type ProfileStatus = 'invited' | 'active' | 'inactive';

export interface AuthSnapshot {
  /** A Supabase auth cookie was presented, verified or not. */
  hadSessionCookie: boolean;
  /** Verified JWT claims, or null when absent/invalid/expired. */
  claims: null | {
    sub: string;
    aal?: string;
    /** Authentication method timestamps (seconds since epoch). */
    amr?: Array<{ method: string; timestamp: number }>;
  };
  /** Number of verified MFA factors on the account. */
  verifiedFactorCount: number;
}

export type SessionDecision =
  | { kind: 'allow' }
  | { kind: 'redirect'; to: string; reason: string };

export const ROUTES = {
  signIn: '/sign-in',
  sessionExpired: '/session-expired',
  mfaEnroll: '/mfa/enroll',
  mfaChallenge: '/mfa/challenge',
  onboardingPassword: '/onboarding/password',
  finishOnboarding: '/onboarding/finish',
  accessInactive: '/access-inactive',
  accountRecovery: RECOVERY_PENDING_ROUTE,
  signedOut: '/signed-out',
  home: '/app',
} as const;

/**
 * Seconds since the first authentication factor of this session (minimum amr
 * timestamp, the same rule as authz.session_auth_time()). Informational only;
 * the database enforces the limit.
 */
export function sessionAgeSeconds(
  amr: Array<{ method: string; timestamp: number }> | undefined,
  nowSeconds: number,
): number | null {
  if (!amr || amr.length === 0) return null;
  if (amr.some((m) => typeof m?.timestamp !== 'number' || !Number.isFinite(m.timestamp))) return null;
  const first = Math.min(...amr.map((m) => m.timestamp));
  return nowSeconds - first;
}

/** Before any database call: is there a verified session, and is it aal2? */
export function decideMfaStep(snapshot: AuthSnapshot): SessionDecision {
  if (!snapshot.claims) {
    return snapshot.hadSessionCookie
      ? { kind: 'redirect', to: ROUTES.sessionExpired, reason: 'session_invalid' }
      : { kind: 'redirect', to: ROUTES.signIn, reason: 'no_session' };
  }
  if (snapshot.claims.aal !== 'aal2') {
    return snapshot.verifiedFactorCount > 0
      ? { kind: 'redirect', to: ROUTES.mfaChallenge, reason: 'mfa_challenge_required' }
      : { kind: 'redirect', to: ROUTES.mfaEnroll, reason: 'mfa_enrollment_required' };
  }
  return { kind: 'allow' };
}

const SESSION_STATES = [
  'ok',
  'no_session',
  'mfa_required',
  'session_expired',
  'session_revoked',
  'recovery_pending',
  'onboarding_incomplete',
  'inactive',
  'no_membership',
] as const satisfies readonly SessionState[];

const RECOVERY_STATUSES = [
  'provider_pending',
  'provider_failed',
  'awaiting_reenrollment',
  'awaiting_admin_confirmation',
  'completed',
] as const;

const SessionStatusSchema = z.object({
  state: z.enum(SESSION_STATES),
  recovery: z
    .object({
      caseId: z.uuid(),
      status: z.enum(RECOVERY_STATUSES),
      confirmationCode: z.string().regex(/^[0-9A-Z]{6}$/).optional(),
    })
    .optional(),
  sessionMaxAgeSeconds: z.number().int().nonnegative(),
  policyStatus: z.enum(['proposed', 'confirmed']),
});

/** Validates the my_session_status() payload. Anything unexpected is null (caller fails closed). */
export function parseSessionStatus(raw: unknown): SessionStatus | null {
  const parsed = SessionStatusSchema.safeParse(raw);
  return parsed.success ? (parsed.data as SessionStatus) : null;
}

/**
 * Route for a database session state. `verifiedFactorCount` only chooses
 * between enrolment and challenge for 'mfa_required'; it never grants access.
 */
export function routeForSessionState(state: SessionState, verifiedFactorCount: number): SessionDecision {
  switch (state) {
    case 'ok':
      return { kind: 'allow' };
    case 'no_session':
      return { kind: 'redirect', to: ROUTES.signIn, reason: state };
    case 'mfa_required':
      return verifiedFactorCount > 0
        ? { kind: 'redirect', to: ROUTES.mfaChallenge, reason: 'mfa_challenge_required' }
        : { kind: 'redirect', to: ROUTES.mfaEnroll, reason: 'mfa_enrollment_required' };
    case 'session_expired':
    case 'session_revoked':
      return { kind: 'redirect', to: ROUTES.sessionExpired, reason: state };
    case 'recovery_pending':
      return { kind: 'redirect', to: ROUTES.accountRecovery, reason: state };
    case 'onboarding_incomplete':
      return { kind: 'redirect', to: ROUTES.finishOnboarding, reason: state };
    case 'inactive':
    case 'no_membership':
      return { kind: 'redirect', to: ROUTES.accessInactive, reason: state };
    default: {
      const unknown: never = state;
      return { kind: 'redirect', to: ROUTES.sessionExpired, reason: `unknown:${String(unknown)}` };
    }
  }
}

/** Only same-site staff paths are accepted as post-sign-in destinations. */
export function safeNextPath(next: string | null | undefined): string {
  if (!next) return ROUTES.home;
  // The one non-/app target: back to the password step after its MFA challenge.
  if (next === ROUTES.onboardingPassword) return next;
  if (!/^\/app(\/[A-Za-z0-9\-_/]*)?$/.test(next) || next.includes('//')) return ROUTES.home;
  return next;
}

/**
 * The password step (invite or recovery link) is reachable at aal1. An account
 * that still has a verified authenticator must pass its challenge first, so
 * the password alone can never replace the password (AUDIT-013). New invites
 * and administrator MFA recovery have no verified factor and continue at aal1.
 */
export function decidePasswordStep(snapshot: AuthSnapshot): SessionDecision {
  if (snapshot.verifiedFactorCount > 0 && snapshot.claims?.aal !== 'aal2') {
    return {
      kind: 'redirect',
      to: `${ROUTES.mfaChallenge}?next=${encodeURIComponent(ROUTES.onboardingPassword)}`,
      reason: 'mfa_challenge_required',
    };
  }
  return { kind: 'allow' };
}
