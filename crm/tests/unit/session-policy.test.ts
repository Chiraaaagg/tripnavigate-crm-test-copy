import { describe, expect, it } from 'vitest';
import type { SessionState } from '@/modules/identity/contracts';
import {
  type AuthSnapshot,
  decideMfaStep,
  parseSessionStatus,
  routeForSessionState,
  safeNextPath,
  sessionAgeSeconds,
} from '@/modules/identity/session-policy';

/**
 * The database (public.my_session_status) is the single session decision; the
 * app only validates its answer and maps states to routes. No session age is
 * configured in the app any more (security_policy row is the single source).
 */

const now = 1_800_000_000;
const amr = [
  { method: 'password', timestamp: now - 600 },
  { method: 'totp', timestamp: now - 590 },
];
const signedIn: AuthSnapshot = { hadSessionCookie: true, claims: { sub: 'u1', aal: 'aal2', amr }, verifiedFactorCount: 1 };

function step(snapshot: AuthSnapshot) {
  const d = decideMfaStep(snapshot);
  return d.kind === 'allow' ? 'allow' : d.to;
}

describe('pre-database MFA step', () => {
  it('allows a verified aal2 session through to the database decision', () => {
    expect(step(signedIn)).toBe('allow');
  });
  it('sends a visitor without a session to sign-in, and an invalid cookie to session-expired', () => {
    expect(step({ ...signedIn, hadSessionCookie: false, claims: null })).toBe('/sign-in');
    expect(step({ ...signedIn, claims: null })).toBe('/session-expired');
  });
  it('picks enrolment or challenge for aal1, and treats a missing aal as aal1', () => {
    expect(step({ ...signedIn, claims: { sub: 'u1', aal: 'aal1', amr }, verifiedFactorCount: 0 })).toBe('/mfa/enroll');
    expect(step({ ...signedIn, claims: { sub: 'u1', aal: 'aal1', amr } })).toBe('/mfa/challenge');
    expect(step({ ...signedIn, claims: { sub: 'u1', amr } })).toBe('/mfa/challenge');
  });
});

describe('route for each database session state', () => {
  const cases: Array<[SessionState, number, string]> = [
    ['ok', 1, 'allow'],
    ['no_session', 0, '/sign-in'],
    ['mfa_required', 0, '/mfa/enroll'],
    ['mfa_required', 1, '/mfa/challenge'],
    ['session_expired', 1, '/session-expired'],
    ['session_revoked', 1, '/session-expired'],
    ['recovery_pending', 1, '/account-recovery'],
    ['onboarding_incomplete', 1, '/onboarding/finish'],
    ['inactive', 1, '/access-inactive'],
    ['no_membership', 1, '/access-inactive'],
  ];
  it.each(cases)('%s (factors=%i) -> %s', (state, factors, expected) => {
    const d = routeForSessionState(state, factors);
    expect(d.kind === 'allow' ? 'allow' : d.to).toBe(expected);
  });
  it('fails closed on an unknown state', () => {
    const d = routeForSessionState('surprise' as SessionState, 1);
    expect(d).toMatchObject({ kind: 'redirect', to: '/session-expired' });
  });
});

describe('my_session_status payload validation (fail closed)', () => {
  const base = { state: 'ok', sessionMaxAgeSeconds: 43200, policyStatus: 'proposed' };
  it('accepts the contract shape, including the recovery view', () => {
    expect(parseSessionStatus(base)).toEqual(base);
    const recovery = {
      ...base,
      state: 'recovery_pending',
      recovery: { caseId: '6f1c1f4e-2b1a-4c8e-9a51-1c2b3d4e5f60', status: 'awaiting_admin_confirmation', confirmationCode: 'A1B2C3' },
    };
    expect(parseSessionStatus(recovery)).toEqual(recovery);
  });
  it.each([
    ['null', null],
    ['unknown state', { ...base, state: 'allowed' }],
    ['missing policy fields', { state: 'ok' }],
    ['snake_case keys', { state: 'ok', session_max_age_seconds: 43200, policy_status: 'proposed' }],
    ['bad code', { ...base, state: 'recovery_pending', recovery: { caseId: '6f1c1f4e-2b1a-4c8e-9a51-1c2b3d4e5f60', status: 'awaiting_admin_confirmation', confirmationCode: 'abc' } }],
  ])('rejects %s', (_name, raw) => {
    expect(parseSessionStatus(raw)).toBeNull();
  });
});

describe('session age (informational mirror of authz.session_auth_time)', () => {
  it('uses the minimum amr timestamp', () => {
    expect(sessionAgeSeconds(amr, now)).toBe(600);
  });
  it('returns null for missing, empty or malformed amr', () => {
    expect(sessionAgeSeconds(undefined, now)).toBeNull();
    expect(sessionAgeSeconds([], now)).toBeNull();
    expect(sessionAgeSeconds([{ method: 'password' } as never], now)).toBeNull();
  });
});

describe('post-sign-in redirect target', () => {
  it.each([
    ['/app/deals', '/app/deals'],
    ['/app', '/app'],
    [undefined, '/app'],
    ['https://evil.example/app', '/app'],
    ['//evil.example/app', '/app'],
    ['/app//evil.example', '/app'],
    ['/sign-in', '/app'],
    ['/app/deals?x=1', '/app'],
    ['/app/../admin', '/app'],
    // The only non-/app target: back to the password step after the MFA challenge (AUDIT-013).
    ['/onboarding/password', '/onboarding/password'],
    ['/onboarding/password/x', '/app'],
    ['/onboarding/finish', '/app'],
  ])('%s -> %s', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});
