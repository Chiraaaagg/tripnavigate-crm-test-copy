/**
 * Phase 1.5 frozen contracts (lead-owned). See
 * docs/implementation/phase-1-5-contract.md. Database functions return these
 * shapes as jsonb; server actions and views import them from here only.
 */

import type { FormState } from '@/lib/forms';

/** Result of public.my_session_status(); the single session decision. */
export type SessionState =
  | 'ok'
  | 'no_session'
  | 'mfa_required'
  | 'session_expired'
  | 'session_revoked'
  | 'recovery_pending'
  | 'onboarding_incomplete'
  | 'inactive'
  | 'no_membership';

export interface SessionStatus {
  state: SessionState;
  /** Present when state = 'recovery_pending'. */
  recovery?: OwnRecoveryView;
  /** Seconds; value from public.security_policy (PROPOSED, owner approval pending). */
  sessionMaxAgeSeconds: number;
  policyStatus: 'proposed' | 'confirmed';
}

export type RecoveryStatus =
  | 'provider_pending'
  | 'provider_failed'
  | 'awaiting_reenrollment'
  | 'awaiting_admin_confirmation'
  | 'completed';

/** What the staff member under recovery sees about their own case. */
export interface OwnRecoveryView {
  caseId: string;
  status: RecoveryStatus;
  /** Only when status = 'awaiting_admin_confirmation'. Read to the administrator out of band. */
  confirmationCode?: string;
}

/** Administrator view of a recovery case (public.begin_mfa_recovery etc.). */
export interface RecoveryCase {
  caseId: string;
  userId: string;
  status: RecoveryStatus;
  providerAttempts: number;
  lastProviderError: string | null;
  openedAt: string;
  openedBy: string;
  completedAt: string | null;
  /** Absent on older command responses; never interpret absence as successful cleanup. */
  cleanupCompletedAt?: string | null;
  cleanupError?: string | null;
}

/**
 * Cleanup state of a completed recovery case. The person keeps no CRM access
 * until cleanup is recorded successful (authz.recovered_session_allowed), so
 * only `done` means usable access. Missing fields mean `pending`, never `done`.
 */
export type RecoveryCleanupState = 'done' | 'failed' | 'stuck' | 'pending';

/**
 * `stuck`: the database refused the cleanup plan (22023: the registered new
 * authenticator is missing or the case is no longer the latest), so retrying
 * this case cannot succeed; only a new recovery can restore access.
 */
export function recoveryCleanupState(c: Pick<RecoveryCase, 'cleanupCompletedAt' | 'cleanupError'>): RecoveryCleanupState {
  if (typeof c.cleanupError === 'string' && c.cleanupError.startsWith('plan_lookup:22023')) return 'stuck';
  if (typeof c.cleanupError === 'string' && c.cleanupError.length > 0) return 'failed';
  if (typeof c.cleanupCompletedAt === 'string' && c.cleanupCompletedAt.length > 0 && c.cleanupError === null) return 'done';
  return 'pending';
}

export type StaffEmailKind = 'invitation' | 'invitation_resend' | 'password_reset';
export type StaffEmailStatus = 'pending' | 'handed_to_provider' | 'failed';

export interface StaffEmailDelivery {
  deliveryId: string;
  /** Null for a first invitation until the Auth user is linked. */
  userId: string | null;
  invitationId: string | null;
  kind: StaffEmailKind;
  status: StaffEmailStatus;
  attemptNo: number;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** Approved identity-verification methods (empty in production until O06 is decided). */
export interface VerificationMethodOption {
  code: string;
  label: string;
}

/**
 * Server action signatures implemented by agent A and consumed by agent C.
 * All use React useActionState form-action shape unless noted.
 */
export interface IdentityActions {
  /** Admin: begin (or retry) MFA recovery for formData userId + reason. */
  beginMfaRecoveryAction: (prev: FormState, formData: FormData) => Promise<FormState>;
  /** Admin: confirm recovery with formData caseId, method, confirmationCode, note. */
  confirmMfaRecoveryAction: (prev: FormState, formData: FormData) => Promise<FormState>;
  /** Target user (aal2, new factor): register factor; returns code via FormState.message. */
  registerRecoveryFactorAction: (prev: FormState, formData: FormData) => Promise<FormState>;
  /** Admin: formData userId + kind ('invitation_resend' | 'password_reset'). */
  sendStaffEmailAction: (prev: FormState, formData: FormData) => Promise<FormState>;
  /** Public: formData email; always the same generic success message. */
  requestPasswordResetAction: (prev: FormState, formData: FormData) => Promise<FormState>;
  /** Signed-in user: move own barrier, then provider global sign-out; redirects to /signed-out?scope=global. */
  signOutEverywhereAction: (formData: FormData) => Promise<void>;
}

/** Module paths where the actions above live (agent A). */
export const IDENTITY_ACTION_MODULES = {
  recovery: '@/modules/identity/server/recovery-actions',
  session: '@/modules/identity/server/actions',
  staffEmail: '@/modules/access/server/staff-actions',
} as const;

/**
 * Exact module of each action (agent A implements; agent C imports):
 *   '@/modules/identity/server/recovery-actions':
 *       beginMfaRecoveryAction, confirmMfaRecoveryAction, registerRecoveryFactorAction
 *   '@/modules/access/server/staff-actions':
 *       sendStaffEmailAction (plus existing invite/deactivate/grant/revoke actions;
 *       resetStaffMfaAction is REMOVED and replaced by beginMfaRecoveryAction)
 *   '@/modules/identity/server/actions':
 *       requestPasswordResetAction, signOutEverywhereAction (plus existing actions)
 */

/** Per-staff extras returned by loadStaffAdmin() (agent A) for the Staff page (agent C). */
export interface StaffSecurityInfo {
  recovery: RecoveryCase | null;
  lastEmail: StaffEmailDelivery | null;
}

/**
 * Server read functions (agent A, server-only):
 *   '@/modules/access/server/admin-queries':
 *       loadStaffAdmin(staff) -> existing fields plus
 *         security: Record<userId, StaffSecurityInfo>
 *         verificationMethods: VerificationMethodOption[]
 *   '@/modules/identity/server/session':
 *       getMySessionStatus(): Promise<SessionStatus>   (never redirects; for status pages)
 *       requireSignedIn(), requireStaff()              (existing; requireStaff now uses
 *                                                        my_session_status and redirects
 *                                                        'recovery_pending' to /account-recovery)
 */
export const RECOVERY_PENDING_ROUTE = '/account-recovery';
