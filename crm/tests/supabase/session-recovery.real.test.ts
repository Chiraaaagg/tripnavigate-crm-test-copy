import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecoveryCase, SessionStatus } from '@/modules/identity/contracts';
import { FIXTURE_DEALS, FIXTURE_EMAILS, FIXTURE_USERS } from '../helpers/db';
import {
  cookieHeader,
  createRealStack,
  extractConfirmLink,
  hasAuthCookie,
  openEmailLink,
  submitForm,
  resolveRealStackEnv,
  type SignedIn,
  type Totp,
  waitForEmail,
  waitPastBarrierSecond,
} from '../helpers/real-stack';

/**
 * Phase 1.5 session barrier, MFA recovery, revocation, deactivation, direct
 * API adversarial checks and bootstrap against the REAL local Supabase stack
 * (contract docs/implementation/phase-1-5-contract.md, section 6: T02, T03,
 * T05, T06, T09, T10, T11, T13, plus the N06 email templates).
 *
 * Runs only in CI (no Docker locally). Fails, never skips, when
 * REQUIRE_REAL_STACK=1 and the stack is not configured (T16).
 *
 * Each scenario uses its own synthetic fixture user because barrier moves,
 * recovery cases and deactivation are permanent for the rest of the run:
 *   admin        adminJodhpur (super_admin; performs admin commands)
 *   T02/T06      salesDelhiB
 *   T03/T05      visaJodhpur (case left open, awaiting_reenrollment)
 *   T09          managerDelhi
 *   T10          salesAhmedabad (deactivated and banned)
 *   T11          managerAhmedabad
 *   N06 email    movedStaff
 */

const env = resolveRealStackEnv();
const stack = env ? createRealStack(env) : null;

/** Every table under the restrictive require_valid_session policy. */
const TABLES = [
  'legal_entities',
  'branches',
  'staff_profiles',
  'roles',
  'permissions',
  'role_permissions',
  'memberships',
  'access_grants',
  'staff_invitations',
  'deals',
  'deal_assignments',
  'deal_commercials',
  'audit_events',
] as const;

const SYNTHETIC_METHOD = 'SYNTHETIC_TEST_CALLBACK';
const reason = (id: string) => `SYNTHETIC CI test ${id}: lost authenticator device`;

async function rowsIn(client: SupabaseClient, table: string): Promise<number> {
  const { data, error } = await client.from(table).select('*').limit(50);
  // A denial may surface as zero rows (RLS) or as an error; both are "no data".
  if (error) return 0;
  return (data ?? []).length;
}

async function rowsEverywhere(client: SupabaseClient): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of TABLES) out[table] = await rowsIn(client, table);
  return out;
}

const allZero = Object.fromEntries(TABLES.map((t) => [t, 0]));

async function refs(client: SupabaseClient): Promise<string[]> {
  const { data } = await client.from('deals').select('reference').order('reference');
  return (data ?? []).map((d) => d.reference as string);
}

async function sessionState(client: SupabaseClient): Promise<SessionStatus['state'] | 'error'> {
  const { data, error } = await client.rpc('my_session_status');
  if (error) return 'error';
  return (data as SessionStatus).state;
}

/** Every business command must refuse a blocked session. */
async function expectAllCommandsRefused(client: SupabaseClient, targetUserId: string) {
  const calls: Array<[string, Record<string, unknown>]> = [
    ['accept_my_invitation', {}],
    ['register_my_recovery_factor', {}],
    ['begin_mfa_recovery', { p_user_id: targetUserId, p_reason: reason('blocked-command') }],
    ['confirm_mfa_recovery', { p_case_id: randomUUID(), p_method: SYNTHETIC_METHOD, p_confirmation_code: 'AAAAAA', p_note: 'x' }],
    ['request_staff_email', { p_user_id: targetUserId, p_kind: 'password_reset' }],
    ['deactivate_staff_member', { p_user_id: targetUserId, p_reason: reason('blocked-command') }],
    ['create_staff_invitation', { p_email: 'blocked.cmd@example.test', p_display_name: 'Blocked', p_branch_id: randomUUID(), p_role_code: 'sales' }],
    ['grant_access_scope', { p_user_id: targetUserId, p_permission: 'deal.read', p_legal_entity_id: randomUUID(), p_branch_id: null, p_reason: reason('blocked-command') }],
  ];
  for (const [fn, args] of calls) {
    const { error } = await client.rpc(fn, args);
    expect(error, `${fn} must be refused`).not.toBeNull();
  }
}

async function caseStatus(caseId: string): Promise<string | undefined> {
  const { data, error } = await stack!.admin().from('mfa_recovery_cases').select('status').eq('id', caseId).single();
  if (error) throw error;
  return (data as { status: string }).status;
}

async function confirmFailures(caseId: string): Promise<number> {
  const { data, error } = await stack!.admin().from('mfa_recovery_cases').select('confirm_failures').eq('id', caseId).single();
  if (error) throw error;
  return (data as { confirm_failures: number }).confirm_failures;
}

let admin: SignedIn;
async function adminClient(): Promise<SupabaseClient> {
  // Refresh keeps the original authentication time (amr) and aal2.
  const { error } = await admin.client.auth.refreshSession();
  if (error) throw error;
  return admin.client;
}

beforeAll(async () => {
  if (!stack) return;
  admin = await stack.signInAal2(FIXTURE_EMAILS.adminJodhpur, FIXTURE_USERS.adminJodhpur);
});

afterAll(async () => {
  await stack?.cleanup();
});

describe.skipIf(!stack)('real stack: session barrier and MFA recovery', () => {
  describe('T02 + T06: recovery blocks old tokens and completes only through an administrator', () => {
    const userId = FIXTURE_USERS.salesDelhiB;
    const email = FIXTURE_EMAILS.salesDelhiB;
    let oldToken = '';
    let caseId = '';
    let fresh: SignedIn;
    let freshFactor: Totp;
    let confirmationCode = '';

    it('T02: an aal2 token authenticated before begin_mfa_recovery sees nothing and can do nothing', async () => {
      const before = await stack!.signInAal2(email, userId);
      oldToken = before.session.access_token;
      expect(await refs(before.client)).toEqual(['SYN-DEL-002']);
      expect(await sessionState(before.client)).toBe('ok');

      const begin = await (await adminClient()).rpc('begin_mfa_recovery', { p_user_id: userId, p_reason: reason('T02') });
      expect(begin.error).toBeNull();
      const opened = begin.data as RecoveryCase;
      expect(opened.userId).toBe(userId);
      expect(opened.status).toBe('provider_pending');
      caseId = opened.caseId;

      const raw = stack!.withToken(oldToken);
      expect(await rowsEverywhere(raw)).toEqual(allZero);
      expect(await sessionState(raw)).not.toBe('ok');
      await expectAllCommandsRefused(raw, FIXTURE_USERS.salesDelhiA);
    });

    it('a repeated begin returns the same open case', async () => {
      const again = await (await adminClient()).rpc('begin_mfa_recovery', { p_user_id: userId, p_reason: reason('T02 repeat') });
      expect(again.error).toBeNull();
      expect((again.data as RecoveryCase).caseId).toBe(caseId);
    });

    it('provider step succeeds (factors deleted, service role records ok); old token stays denied', async () => {
      expect(await stack!.deleteAllFactors(userId)).toBeGreaterThan(0);
      const rec = await stack!.admin().rpc('record_mfa_recovery_provider_result', {
        p_case_id: caseId,
        p_ok: true,
        p_error_code: null,
      });
      expect(rec.error).toBeNull();
      expect((rec.data as RecoveryCase).status).toBe('awaiting_reenrollment');
      expect(await refs(stack!.withToken(oldToken))).toEqual([]);
    });

    it('T06: a new password session cannot register a factor at aal1', async () => {
      // Provider success moved the barrier again: sign in strictly after it.
      await waitPastBarrierSecond();
      fresh = await stack!.signIn(email);
      expect(await stack!.aal(fresh.client)).toBe('aal1');
      const reg = await fresh.client.rpc('register_my_recovery_factor');
      expect(reg.error).not.toBeNull();
    });

    it('T06: a second post-provider factor (e.g. planted with a stolen password) blocks registration', async () => {
      freshFactor = await stack!.enrolTotp(fresh.client, userId);
      expect(await stack!.aal(fresh.client)).toBe('aal2');
      expect(await refs(fresh.client)).toEqual([]);
      expect(await sessionState(fresh.client)).toBe('recovery_pending');

      // "Attacker" session: same password, reaches aal2 with the new factor,
      // then enrols and verifies a factor of its own.
      const other = await stack!.signIn(email);
      await stack!.verifyTotp(other.client, freshFactor);
      const planted = await stack!.enrolTotp(other.client, userId);

      try {
        // Refusal is a committed result, not a SQL exception: the security
        // audit must survive. Assert the refusal and absence of a code.
        for (const client of [fresh.client, other.client]) {
          const refused = await client.rpc('register_my_recovery_factor');
          expect(refused.error).toBeNull();
          expect(refused.data).toEqual({
            status: 'awaiting_reenrollment', confirmation_code: null, refused: 'extra_factor',
          });
        }
        expect(await caseStatus(caseId)).toBe('awaiting_reenrollment');
        expect(await refs(fresh.client)).toEqual([]);
      } finally {
        // Cleanup must happen even on a failed assertion, avoiding cascades.
        await stack!.deleteFactor(userId, planted.factorId);
      }
    });

    it('T06: registration binds the code to the calling session only', async () => {
      const reg = await fresh.client.rpc('register_my_recovery_factor');
      expect(reg.error).toBeNull();
      const result = reg.data as { status: string; confirmation_code: string };
      expect(result.status).toBe('awaiting_admin_confirmation');
      expect(result.confirmation_code).toMatch(/^[A-Za-z0-9]{6}$/);
      confirmationCode = result.confirmation_code;
      expect(await refs(fresh.client)).toEqual([]);

      const own = await fresh.client.rpc('my_session_status');
      expect((own.data as SessionStatus).recovery?.confirmationCode).toBe(confirmationCode);

      // Another session of the same person (same password, same factor) never sees the code.
      const second = await stack!.signIn(email);
      await stack!.verifyTotp(second.client, freshFactor);
      const status = (await second.client.rpc('my_session_status')).data as SessionStatus;
      expect(status.state).toBe('recovery_pending');
      expect(status.recovery?.confirmationCode).toBeUndefined();
      const reg2 = await second.client.rpc('register_my_recovery_factor');
      expect(JSON.stringify(reg2.data ?? null)).not.toContain(confirmationCode);
      // Re-registration deliberately replaces the code and binds the new one
      // to this second verified session. Confirm using that current code.
      expect(reg2.error).toBeNull();
      expect(reg2.data.status).toBe('awaiting_admin_confirmation');
      expect(reg2.data.confirmation_code).toMatch(/^[A-Za-z0-9]{6}$/);
      confirmationCode = reg2.data.confirmation_code;
      const previous = (await fresh.client.rpc('my_session_status')).data as SessionStatus;
      expect(previous.recovery?.confirmationCode).toBeUndefined();
    });

    it('T06: wrong code, unapproved method and self-confirmation change nothing', async () => {
      const adm = await adminClient();
      const failuresBefore = await confirmFailures(caseId);
      const wrong = confirmationCode.startsWith('A') ? `B${confirmationCode.slice(1)}` : `A${confirmationCode.slice(1)}`;
      // A mismatch is recorded (counter + audit) without raising, so the counter commits.
      const badCode = await adm.rpc('confirm_mfa_recovery', {
        p_case_id: caseId,
        p_method: SYNTHETIC_METHOD,
        p_confirmation_code: wrong,
        p_note: 'SYNTHETIC wrong code',
      });
      expect(badCode.error).toBeNull();
      expect((badCode.data as RecoveryCase).status).toBe('awaiting_admin_confirmation');
      expect(await caseStatus(caseId)).toBe('awaiting_admin_confirmation');
      expect(await confirmFailures(caseId)).toBe(failuresBefore + 1);

      const badMethod = await adm.rpc('confirm_mfa_recovery', {
        p_case_id: caseId,
        p_method: 'UNAPPROVED_PHONE_CALL',
        p_confirmation_code: confirmationCode,
        p_note: 'SYNTHETIC unapproved method',
      });
      expect(badMethod.error).not.toBeNull();
      expect(await caseStatus(caseId)).toBe('awaiting_admin_confirmation');

      const self = await fresh.client.rpc('confirm_mfa_recovery', {
        p_case_id: caseId,
        p_method: SYNTHETIC_METHOD,
        p_confirmation_code: confirmationCode,
        p_note: 'SYNTHETIC self confirmation',
      });
      expect(self.error).not.toBeNull();
      expect(await caseStatus(caseId)).toBe('awaiting_admin_confirmation');
      expect(await refs(fresh.client)).toEqual([]);
    });

    it('T06: confirmation completes and moves the barrier; only a NEW sign-in regains access', async () => {
      const done = await (await adminClient()).rpc('confirm_mfa_recovery', {
        p_case_id: caseId,
        p_method: SYNTHETIC_METHOD,
        p_confirmation_code: confirmationCode,
        p_note: 'SYNTHETIC callback verified (CI)',
      });
      expect(done.error).toBeNull();
      expect((done.data as RecoveryCase).status).toBe('completed');

      // Completion moved the barrier: the re-enrolment session must sign in again.
      expect(await refs(fresh.client)).toEqual([]);
      expect(await sessionState(fresh.client)).toBe('session_revoked');
      expect(await refs(stack!.withToken(oldToken))).toEqual([]);

      await waitPastBarrierSecond();
      const after = await stack!.signInAal2(email, userId);
      expect(after.factor.factorId).toBe(freshFactor.factorId);
      // Even a fresh, correct-factor sign-in is denied until cleanup succeeds.
      expect(await refs(after.client)).toEqual([]);
      const failedCleanup = await stack!.admin().rpc('record_mfa_recovery_cleanup_result', {
        p_case_id: caseId, p_ok: false, p_error_code: 'synthetic_cleanup_failure',
      });
      expect(failedCleanup.error).toBeNull();
      expect(await refs(after.client)).toEqual([]);
      const retryCleanup = await (await adminClient()).rpc('retry_mfa_recovery_cleanup', { p_case_id: caseId });
      expect(retryCleanup.error).toBeNull();
      expect((retryCleanup.data as RecoveryCase).cleanupError).toBe('synthetic_cleanup_failure');
      const deniedPlan = await after.client.rpc('get_mfa_recovery_deletion_plan', { p_case_id: caseId, p_phase: 'cleanup' });
      expect(deniedPlan.error).not.toBeNull();
      const cleanupPlan = await stack!.admin().rpc('get_mfa_recovery_deletion_plan', { p_case_id: caseId, p_phase: 'cleanup' });
      expect(cleanupPlan.error).toBeNull();
      const cleanupIds = (cleanupPlan.data as { factorIds: string[]; keepFactorId: string }).factorIds;
      expect(cleanupIds).not.toContain(freshFactor.factorId);
      for (const id of cleanupIds) await stack!.deleteFactor(userId, id);
      const cleaned = await stack!.admin().rpc('record_mfa_recovery_cleanup_result', {
        p_case_id: caseId, p_ok: true, p_error_code: null,
      });
      expect(cleaned.error).toBeNull();
      expect(await refs(after.client)).toEqual(['SYN-DEL-002']);
      expect(await sessionState(after.client)).toBe('ok');

      // An additional factor planted via the still-available Auth API cannot
      // bypass the recovered-account factor binding, even after cleanup.
      const planted = await stack!.enrolTotp(after.client, userId);
      expect(await refs(after.client)).toEqual([]);
      expect(await sessionState(after.client)).not.toBe('ok');
      await stack!.deleteFactor(userId, planted.factorId);
    });
  });

  describe('T03 + T05: provider failure keeps the user blocked', () => {
    const userId = FIXTURE_USERS.visaJodhpur;
    const email = FIXTURE_EMAILS.visaJodhpur;
    let oldToken = '';
    let caseId = '';
    let windowSession: SignedIn;

    it('T03: failed factor deletion leaves the case provider_failed and the old token denied', async () => {
      const before = await stack!.signInAal2(email, userId);
      oldToken = before.session.access_token;
      expect(await rowsIn(before.client, 'roles')).toBeGreaterThan(0);

      const begin = await (await adminClient()).rpc('begin_mfa_recovery', { p_user_id: userId, p_reason: reason('T03') });
      expect(begin.error).toBeNull();
      caseId = (begin.data as RecoveryCase).caseId;

      // Simulated provider outage: factors are NOT deleted.
      const rec = await stack!.admin().rpc('record_mfa_recovery_provider_result', {
        p_case_id: caseId,
        p_ok: false,
        p_error_code: 'synthetic_provider_outage',
      });
      expect(rec.error).toBeNull();
      const failed = rec.data as RecoveryCase;
      expect(failed.status).toBe('provider_failed');
      expect(failed.providerAttempts).toBe(1);
      expect(failed.lastProviderError).toBe('synthetic_provider_outage');

      expect(await rowsEverywhere(stack!.withToken(oldToken))).toEqual(allZero);
    });

    it('T03: retry returns the same case and counts the attempt; still blocked', async () => {
      const retry = await (await adminClient()).rpc('begin_mfa_recovery', { p_user_id: userId, p_reason: reason('T03 retry') });
      expect(retry.error).toBeNull();
      expect((retry.data as RecoveryCase).caseId).toBe(caseId);
      const rec = await stack!.admin().rpc('record_mfa_recovery_provider_result', {
        p_case_id: caseId,
        p_ok: false,
        p_error_code: 'synthetic_provider_outage',
      });
      expect(rec.error).toBeNull();
      expect((rec.data as RecoveryCase).status).toBe('provider_failed');
      expect((rec.data as RecoveryCase).providerAttempts).toBe(2);
      expect(await rowsIn(stack!.withToken(oldToken), 'roles')).toBe(0);
    });

    it('two concurrent case-bound resumes of the same failed case both resume it; no new case, no barrier move', async () => {
      const client = await adminClient();
      const barrier = async () => {
        const { data, error } = await stack!.admin().from('staff_security_state').select('sessions_valid_after').eq('user_id', userId).single();
        expect(error).toBeNull();
        return (data as { sessions_valid_after: string }).sessions_valid_after;
      };
      const barrierBefore = await barrier();
      const before = await stack!.admin().from('mfa_recovery_cases').select('id', { count: 'exact', head: true }).eq('user_id', userId);
      expect(before.error).toBeNull();
      expect(before.count).toBeGreaterThanOrEqual(1);
      const [one, two] = await Promise.all([
        client.rpc('resume_mfa_recovery_provider', { p_case_id: caseId }),
        client.rpc('resume_mfa_recovery_provider', { p_case_id: caseId }),
      ]);
      expect(one.error).toBeNull();
      expect(two.error).toBeNull();
      expect((one.data as RecoveryCase).caseId).toBe(caseId);
      expect((two.data as RecoveryCase).caseId).toBe(caseId);
      const after = await stack!.admin().from('mfa_recovery_cases').select('id', { count: 'exact', head: true }).eq('user_id', userId);
      expect(after.error).toBeNull();
      expect(after.count).toBe(before.count);
      expect(await barrier(), 'resuming never moves the session barrier').toBe(barrierBefore);
      expect(await caseStatus(caseId)).toBe('provider_failed');
    });

    it('T05: a NEW sign-in with the OLD (undeleted) factor during the open case is denied', async () => {
      await waitPastBarrierSecond();
      const again = await stack!.signInAal2(email, userId); // reuses the surviving factor
      windowSession = again;
      expect(await stack!.aal(again.client)).toBe('aal2');
      expect(await rowsEverywhere(again.client)).toEqual(allZero);
      expect(await sessionState(again.client)).toBe('recovery_pending');
      // Registering is refused while the provider step has not succeeded.
      const reg = await again.client.rpc('register_my_recovery_factor');
      expect(reg.error).not.toBeNull();
      expect(await caseStatus(caseId)).toBe('provider_failed');
    });

    it('a session opened with the old factor during the open case stays dead after provider success', async () => {
      // Provider retry succeeds: the barrier moves to provider_completed_at, so the
      // window session (old, possibly stolen factor) never becomes valid again.
      const [deletion, delayedDeletion] = await Promise.all([
        stack!.admin().rpc('get_mfa_recovery_deletion_plan', { p_case_id: caseId, p_phase: 'provider' }),
        stack!.admin().rpc('get_mfa_recovery_deletion_plan', { p_case_id: caseId, p_phase: 'provider' }),
      ]);
      expect(deletion.error).toBeNull();
      expect(delayedDeletion.error).toBeNull();
      for (const id of (deletion.data as { factorIds: string[] }).factorIds) await stack!.deleteFactor(userId, id);
      // Simulate a lost result write: the same case remains failed, and an empty
      // retry plan must safely reconcile actual provider deletion through the API.
      const resumed = await (await adminClient()).rpc('begin_mfa_recovery', { p_user_id: userId, p_reason: reason('lost result retry') });
      expect(resumed.error).toBeNull();
      expect((resumed.data as RecoveryCase).caseId).toBe(caseId);
      const retryPlan = await stack!.admin().rpc('get_mfa_recovery_deletion_plan', { p_case_id: caseId, p_phase: 'provider' });
      expect(retryPlan.error).toBeNull();
      expect((retryPlan.data as { factorIds: string[] }).factorIds).toEqual([]);
      const rec = await stack!.admin().rpc('record_mfa_recovery_provider_result', {
        p_case_id: caseId,
        p_ok: true,
        p_error_code: null,
      });
      expect(rec.error).toBeNull();
      expect((rec.data as RecoveryCase).status).toBe('awaiting_reenrollment');
      const raw = stack!.withToken(windowSession.session.access_token);
      expect(await sessionState(raw)).toBe('session_revoked');
      expect(await rowsEverywhere(raw)).toEqual(allZero);
      expect((await raw.rpc('register_my_recovery_factor')).error).not.toBeNull();

      // The second worker resumes after actual Auth enrolment. Its earlier
      // captured IDs cannot include or delete the newly enrolled factor.
      await waitPastBarrierSecond();
      const enrolled = await stack!.signInAal2(email, userId);
      const delayedIds = (delayedDeletion.data as { factorIds: string[] }).factorIds;
      expect(delayedIds).not.toContain(enrolled.factor.factorId);
      for (const id of delayedIds) {
        await stack!.admin().auth.admin.mfa.deleteFactor({ userId, id });
      }
      const factors = await stack!.admin().auth.admin.mfa.listFactors({ userId });
      expect(factors.error).toBeNull();
      expect(factors.data!.factors.map((f) => f.id)).toContain(enrolled.factor.factorId);
      const stalePlan = await stack!.admin().rpc('get_mfa_recovery_deletion_plan', { p_case_id: caseId, p_phase: 'provider' });
      expect(stalePlan.error).not.toBeNull();
      const staleResult = await stack!.admin().rpc('record_mfa_recovery_provider_result', {
        p_case_id: caseId, p_ok: false, p_error_code: 'delayed_worker',
      });
      expect(staleResult.error).not.toBeNull();
      expect(await caseStatus(caseId)).toBe('awaiting_reenrollment');

      // A stale Staff page resuming the provider step of this case is refused
      // and opens nothing: the newly enrolled factor survives.
      const staleResume = await (await adminClient()).rpc('resume_mfa_recovery_provider', { p_case_id: caseId });
      expect(staleResume.error?.code).toBe('22023');
      const open = await stack!.admin().from('mfa_recovery_cases').select('id').eq('user_id', userId).neq('status', 'completed');
      expect(open.data?.map((c) => (c as { id: string }).id)).toEqual([caseId]);
      const still = await stack!.admin().auth.admin.mfa.listFactors({ userId });
      expect(still.data!.factors.map((f) => f.id)).toContain(enrolled.factor.factorId);
    });
  });

  describe('T09: sign out of all devices', () => {
    const userId = FIXTURE_USERS.managerDelhi;
    const email = FIXTURE_EMAILS.managerDelhi;

    it('old tokens are denied on the Data API at once; provider refresh fails after global sign-out', async () => {
      const s = await stack!.signInAal2(email, userId);
      const { access_token: oldAccess, refresh_token: oldRefresh } = s.session;
      expect(await rowsIn(s.client, 'roles')).toBeGreaterThan(0);
      expect((await refs(s.client)).length).toBeGreaterThan(0);

      const revoke = await s.client.rpc('revoke_my_sessions');
      expect(revoke.error).toBeNull();

      const raw = stack!.withToken(oldAccess);
      expect(await rowsEverywhere(raw)).toEqual(allZero);
      expect(await sessionState(raw)).toBe('session_revoked');

      const out = await s.client.auth.signOut({ scope: 'global' });
      expect(out.error).toBeNull();
      const refreshed = await stack!.refresh(oldRefresh);
      expect(refreshed.error).not.toBeNull();
      expect(refreshed.data.session).toBeNull();

      await waitPastBarrierSecond();
      const next = await stack!.signInAal2(email, userId);
      expect(await rowsIn(next.client, 'roles')).toBeGreaterThan(0);
      expect(await sessionState(next.client)).toBe('ok');
    });
  });

  describe('T10: deactivation with an open session', () => {
    const userId = FIXTURE_USERS.salesAhmedabad;
    const email = FIXTURE_EMAILS.salesAhmedabad;

    it('Data API is denied at once; after the ban, sign-in and refresh are refused', async () => {
      const s = await stack!.signInAal2(email, userId);
      const { access_token: oldAccess, refresh_token: oldRefresh } = s.session;
      expect(await refs(s.client)).toEqual(['SYN-AMD-001']);

      const deact = await (await adminClient()).rpc('deactivate_staff_member', {
        p_user_id: userId,
        p_reason: reason('T10 deactivation'),
      });
      expect(deact.error).toBeNull();
      expect(await rowsEverywhere(stack!.withToken(oldAccess))).toEqual(allZero);
      expect(await sessionState(stack!.withToken(oldAccess))).not.toBe('ok');

      // The server bans the Auth user right after the command (staff-actions).
      const ban = await stack!.admin().auth.admin.updateUserById(userId, { ban_duration: '876000h' });
      expect(ban.error).toBeNull();

      const signIn = await stack!.anon().auth.signInWithPassword({ email, password: env!.fixturePassword });
      expect(signIn.error).not.toBeNull();
      const refreshed = await stack!.refresh(oldRefresh);
      expect(refreshed.error).not.toBeNull();
    });
  });

  describe('T11: direct API adversarial checks', () => {
    const userId = FIXTURE_USERS.managerAhmedabad;
    const email = FIXTURE_EMAILS.managerAhmedabad;
    const serviceOnly: Array<[string, Record<string, unknown>]> = [
      ['record_mfa_recovery_provider_result', { p_case_id: randomUUID(), p_ok: true, p_error_code: null }],
      ['record_staff_email_result', { p_delivery_id: randomUUID(), p_ok: true, p_error_code: null }],
      [
        'bootstrap_first_admin',
        {
          p_user_id: randomUUID(),
          p_email: 'attacker@example.test',
          p_display_name: 'Attacker',
          p_branch_code: 'JDH',
          p_operator: 'attacker',
        },
      ],
      ['link_invitation_user', { p_invitation_id: randomUUID(), p_user_id: randomUUID() }],
    ];

    it('anon: no table data, no session status, no privileged RPC', async () => {
      const anon = stack!.anon();
      const deals = await anon.from('deals').select('id');
      expect(deals.data ?? []).toEqual([]);
      expect(deals.error?.code).toBe('42501');
      expect((await anon.rpc('my_session_status')).error).not.toBeNull();
      expect((await anon.rpc('begin_mfa_recovery', { p_user_id: userId, p_reason: reason('T11 anon') })).error).not.toBeNull();
      for (const [fn, args] of serviceOnly) {
        expect((await anon.rpc(fn, args)).error, `anon ${fn}`).not.toBeNull();
      }
    });

    it('aal1 (password only): nothing readable, commands refused, status mfa_required', async () => {
      const s = await stack!.signIn(email);
      expect(await rowsEverywhere(s.client)).toEqual(allZero);
      expect(await sessionState(s.client)).toBe('mfa_required');
      expect(
        (await s.client.rpc('begin_mfa_recovery', { p_user_id: FIXTURE_USERS.salesDelhiA, p_reason: reason('T11 aal1') })).error,
      ).not.toBeNull();
      // A stolen password alone cannot sign the real user out everywhere (aal2 required).
      expect((await s.client.rpc('revoke_my_sessions')).error).not.toBeNull();
      expect((await s.client.rpc('register_my_recovery_factor')).error).not.toBeNull();
    });

    it('aal2 staff: no other user deal by ID, no commercials, no service-only RPC, no direct writes', async () => {
      const s = await stack!.signInAal2(email, userId);
      expect(await rowsIn(s.client, 'roles')).toBeGreaterThan(0);

      const deal = await s.client.from('deals').select('id').eq('id', FIXTURE_DEALS.del002);
      expect(deal.data ?? []).toEqual([]);
      const commercial = await s.client.from('deal_commercials').select('*').eq('deal_id', FIXTURE_DEALS.del002);
      expect(commercial.data ?? []).toEqual([]);

      for (const [fn, args] of serviceOnly) {
        expect((await s.client.rpc(fn, args)).error, `authenticated ${fn}`).not.toBeNull();
      }
      // Not an administrator: cannot start recovery or send staff email for others.
      expect(
        (await s.client.rpc('begin_mfa_recovery', { p_user_id: FIXTURE_USERS.salesDelhiA, p_reason: reason('T11 non-admin') })).error,
      ).not.toBeNull();
      expect(
        (await s.client.rpc('request_staff_email', { p_user_id: FIXTURE_USERS.salesDelhiA, p_kind: 'password_reset' })).error,
      ).not.toBeNull();

      const insert = await s.client
        .from('deals')
        .insert({ reference: 'ATTACK-1', title: 'attack', legal_entity_id: randomUUID(), branch_id: randomUUID(), owner_user_id: userId });
      expect(insert.error).not.toBeNull();
      // Moving one's own barrier backwards directly must be impossible.
      const tamper = await s.client
        .from('staff_security_state')
        .update({ sessions_valid_after: '1970-01-01T00:00:00Z' })
        .eq('user_id', FIXTURE_USERS.visaJodhpur)
        .select();
      expect(tamper.data ?? []).toEqual([]);
      const closeCase = await s.client
        .from('mfa_recovery_cases')
        .update({ status: 'completed' })
        .eq('user_id', FIXTURE_USERS.visaJodhpur)
        .select();
      expect(closeCase.data ?? []).toEqual([]);
      expect(await caseStatusForUser(FIXTURE_USERS.visaJodhpur)).toBe('awaiting_reenrollment');
    });

    it('an administrator cannot start recovery on themselves', async () => {
      const self = await (await adminClient()).rpc('begin_mfa_recovery', {
        p_user_id: FIXTURE_USERS.adminJodhpur,
        p_reason: reason('T11 self'),
      });
      expect(self.error).not.toBeNull();
    });
  });

  describe('T13: bootstrap_first_admin on a stack that already has a super administrator', () => {
    it('refuses a second administrator, is repeat-safe for the same one, and is service-role only', async () => {
      const svc = stack!.admin();
      const second = await svc.auth.admin.createUser({
        email: `bootstrap.second.${Date.now()}@example.test`,
        email_confirm: true,
      });
      expect(second.error).toBeNull();
      const secondId = second.data.user!.id;

      const refused = await svc.rpc('bootstrap_first_admin', {
        p_user_id: secondId,
        p_email: second.data.user!.email,
        p_display_name: 'Synthetic Second Admin',
        p_branch_code: 'JDH',
        p_operator: 'ci-real-stack',
      });
      expect(refused.error).not.toBeNull();
      const memberships = await svc.from('memberships').select('user_id').eq('user_id', secondId);
      expect(memberships.data ?? []).toEqual([]);

      const same = await svc.rpc('bootstrap_first_admin', {
        p_user_id: FIXTURE_USERS.adminJodhpur,
        p_email: FIXTURE_EMAILS.adminJodhpur,
        p_display_name: 'Synthetic Admin Jodhpur',
        p_branch_code: 'JDH',
        p_operator: 'ci-real-stack',
      });
      expect(same.error).toBeNull();
      expect((same.data as { outcome: string }).outcome).toBe('already_admin');

      const asStaff = await (await adminClient()).rpc('bootstrap_first_admin', {
        p_user_id: FIXTURE_USERS.adminJodhpur,
        p_email: FIXTURE_EMAILS.adminJodhpur,
        p_display_name: 'x',
        p_branch_code: 'JDH',
        p_operator: 'x',
      });
      expect(asStaff.error).not.toBeNull();

      await svc.auth.admin.deleteUser(secondId);
    });
  });

  describe('N06: emailed links go GET /auth/confirm -> /auth/accept -> same-origin POST', () => {
    /**
     * Follows an emailed link through the running app. GET never spends the
     * token; a cross-origin POST is refused without spending it; the
     * same-origin POST verifies it once and sets the session cookie.
     */
    async function followLink(link: URL, type: 'invite' | 'recovery') {
      const app = env!.appBaseUrl;
      expect(link.origin).toBe(new URL(app).origin);
      expect(link.pathname).toBe('/auth/confirm');

      const { acceptUrl, form } = await openEmailLink(app, link);
      expect(form.fields.type).toBe(type);
      expect(form.fields.token_hash).toBe(link.searchParams.get('token_hash'));
      // Opening the link again (as a mail scanner would) still does not spend it.
      await openEmailLink(app, link);

      const forged = await submitForm(acceptUrl, form, 'https://attacker.example');
      expect(forged.location ?? '').not.toMatch(/\/onboarding\/password/);
      expect(hasAuthCookie(forged.setCookies)).toBe(false);

      const accepted = await submitForm(acceptUrl, form, new URL(app).origin);
      expect(accepted.status).toBeGreaterThanOrEqual(300);
      expect(accepted.status).toBeLessThan(400);
      expect(new URL(accepted.location!, app).pathname).toBe('/onboarding/password');
      expect(hasAuthCookie(accepted.setCookies)).toBe(true);

      // The session cookie opens the password page (aal1 is enough there).
      const page = await fetch(new URL('/onboarding/password', app), {
        headers: { cookie: cookieHeader(accepted.setCookies) },
        redirect: 'manual',
      });
      expect(page.status).toBe(200);

      // One-time: a replayed POST is refused.
      const replay = await submitForm(acceptUrl, form, new URL(app).origin);
      expect(new URL(replay.location ?? '/', app).pathname).not.toBe('/onboarding/password');
      expect(hasAuthCookie(replay.setCookies)).toBe(false);
    }

    it('recovery email (forgot password / resend) works once, only through the same-origin POST', async () => {
      const email = FIXTURE_EMAILS.movedStaff;
      const since = Date.now();
      const sent = await stack!.anon().auth.resetPasswordForEmail(email, {
        redirectTo: `${env!.appBaseUrl}/auth/confirm`,
      });
      expect(sent.error).toBeNull();
      const message = await waitForEmail(env!.mailpitUrl, email, { since });
      await followLink(extractConfirmLink(message, 'recovery'), 'recovery');
    });

    it('invitation email works once, only through the same-origin POST', async () => {
      const email = `invite.check.${Date.now()}@example.test`;
      const since = Date.now();
      const invite = await stack!.admin().auth.admin.inviteUserByEmail(email, {
        redirectTo: `${env!.appBaseUrl}/auth/confirm`,
      });
      expect(invite.error).toBeNull();
      const message = await waitForEmail(env!.mailpitUrl, email, { since });
      expect(message.Subject).toMatch(/invitation/i);
      await followLink(extractConfirmLink(message, 'invite'), 'invite');
      if (invite.data.user) await stack!.admin().auth.admin.deleteUser(invite.data.user.id);
    });

    it('AUDIT-013: a recovery link for an account with a working authenticator needs its code before a new password', async () => {
      // Throwaway Auth user (no CRM profile): the password step only needs a session.
      const email = `password.step.${Date.now()}@example.test`;
      const password = 'Ci-Synthetic-Pass-2026';
      const created = await stack!.admin().auth.admin.createUser({ email, password, email_confirm: true });
      expect(created.error).toBeNull();
      const userId = created.data.user!.id;
      try {
        const signedIn = await stack!.signIn(email, password);
        await stack!.enrolTotp(signedIn.client, userId);

        const since = Date.now();
        const sent = await stack!.anon().auth.resetPasswordForEmail(email, {
          redirectTo: `${env!.appBaseUrl}/auth/confirm`,
        });
        expect(sent.error).toBeNull();
        const message = await waitForEmail(env!.mailpitUrl, email, { since });
        const app = env!.appBaseUrl;
        const { acceptUrl, form } = await openEmailLink(app, extractConfirmLink(message, 'recovery'));
        const accepted = await submitForm(acceptUrl, form, new URL(app).origin);
        expect(new URL(accepted.location!, app).pathname).toBe('/onboarding/password');
        expect(hasAuthCookie(accepted.setCookies)).toBe(true);

        // The link gives an aal1 session; the verified factor must be used first.
        const page = await fetch(new URL('/onboarding/password', app), {
          headers: { cookie: cookieHeader(accepted.setCookies) },
          redirect: 'manual',
        });
        expect(page.status).toBeGreaterThanOrEqual(300);
        expect(page.status).toBeLessThan(400);
        const target = new URL(page.headers.get('location')!, app);
        expect(target.pathname).toBe('/mfa/challenge');
        expect(target.searchParams.get('next')).toBe('/onboarding/password');
      } finally {
        await stack!.admin().auth.admin.deleteUser(userId);
      }
    });
  });
});

async function caseStatusForUser(userId: string): Promise<string | undefined> {
  const { data, error } = await stack!
    .admin()
    .from('mfa_recovery_cases')
    .select('status')
    .eq('user_id', userId)
    .limit(1);
  if (error) throw error;
  return (data?.[0] as { status: string } | undefined)?.status;
}
