import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MFA recovery server actions (contract R1-R7, T03). The security property is
 * ORDER: the database barrier (begin_mfa_recovery under the administrator's own
 * session) commits before any privileged provider call, and every provider
 * outcome is recorded by the service role and reported truthfully.
 */

const calls: string[] = [];
const requireStaff = vi.fn();
const requireSignedIn = vi.fn();
const rpc = vi.fn();
const userRpc = vi.fn();
const adminFactory = vi.fn();
const admin = {
  auth: { admin: { mfa: { listFactors: vi.fn(), deleteFactor: vi.fn() } } },
  rpc: vi.fn(),
};
const NEW_FACTOR = 'f0000000-0000-4000-8000-00000000000f';
const OLD_FACTOR = 'f0000000-0000-4000-8000-000000000001';
const EXTRA_FACTOR = 'f0000000-0000-4000-8000-000000000002';
const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});

vi.mock('@/modules/identity/server/session', () => ({
  requireStaff: () => requireStaff(),
  requireSignedIn: () => requireSignedIn(),
}));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => adminFactory() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));

const { beginMfaRecoveryAction, confirmMfaRecoveryAction, resumeMfaRecoveryProviderAction, retryMfaRecoveryCleanupAction, registerRecoveryFactorAction } = await import(
  '@/modules/identity/server/recovery-actions'
);

const ACTOR = 'a0000000-0000-4000-8000-000000000007';
const TARGET = 'a0000000-0000-4000-8000-000000000002';
const CASE = 'c0000000-0000-4000-8000-000000000001';
const idle = { status: 'idle' as const };
const reason = 'Lost phone, identity checked by callback';

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
function recoveryCase(status: string, extra: Record<string, unknown> = {}) {
  return {
    caseId: CASE,
    userId: TARGET,
    status,
    providerAttempts: 0,
    lastProviderError: null,
    openedAt: '2026-10-01T10:00:00Z',
    openedBy: ACTOR,
    completedAt: null,
    cleanupCompletedAt: null,
    cleanupError: null,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  requireStaff.mockResolvedValue({ userId: ACTOR, supabase: { rpc } });
  requireSignedIn.mockResolvedValue({
    supabase: { rpc: userRpc },
    snapshot: { claims: { sub: TARGET, aal: 'aal2' }, verifiedFactorCount: 1, hadSessionCookie: true },
    userId: TARGET,
  });
  adminFactory.mockImplementation(() => {
    calls.push('admin-client');
    return admin;
  });
  rpc.mockImplementation(async (name: string) => {
    calls.push(`db:${name}`);
    return { data: recoveryCase('provider_pending'), error: null };
  });
  admin.auth.admin.mfa.listFactors.mockResolvedValue({ data: { factors: [] }, error: null });
  admin.auth.admin.mfa.deleteFactor.mockImplementation(async ({ id }: { id: string }) => {
    calls.push(`provider:delete:${id}`);
    return { data: {}, error: null };
  });
  admin.rpc.mockImplementation(async (name: string, args: { p_ok?: boolean; p_phase?: string; p_error_code?: string | null }) => {
    if (name === 'get_mfa_recovery_deletion_plan') {
      calls.push(`service:${name}:${args.p_phase}`);
      return {
        data: { caseId: CASE, userId: TARGET, keepFactorId: args.p_phase === 'cleanup' ? NEW_FACTOR : null, factorIds: [OLD_FACTOR, EXTRA_FACTOR] },
        error: null,
      };
    }
    calls.push(`service:${name}:${args.p_ok}`);
    if (name === 'record_mfa_recovery_cleanup_result') {
      return { data: recoveryCase('completed', { completedAt: '2026-10-01T11:00:00Z', cleanupCompletedAt: args.p_ok ? '2026-10-01T11:01:00Z' : null, cleanupError: args.p_ok ? null : args.p_error_code }), error: null };
    }
    return { data: recoveryCase(args.p_ok ? 'awaiting_reenrollment' : 'provider_failed'), error: null };
  });
});

describe('beginMfaRecoveryAction', () => {
  it('moves the database barrier BEFORE any admin/provider call, then records the result', async () => {
    const result = await beginMfaRecoveryAction(idle, form({ userId: TARGET, reason }));
    expect(calls).toEqual([
      'db:begin_mfa_recovery',
      'admin-client',
      'service:get_mfa_recovery_deletion_plan:provider',
      `provider:delete:${OLD_FACTOR}`,
      `provider:delete:${EXTRA_FACTOR}`,
      'service:record_mfa_recovery_provider_result:true',
    ]);
    expect(rpc).toHaveBeenCalledWith('begin_mfa_recovery', { p_user_id: TARGET, p_reason: reason });
    expect(admin.rpc).toHaveBeenCalledWith('get_mfa_recovery_deletion_plan', { p_case_id: CASE, p_phase: 'provider' });
    expect(admin.auth.admin.mfa.listFactors).not.toHaveBeenCalled();
    expect(result.status).toBe('success');
  });

  it('never takes the actor from the form', async () => {
    await beginMfaRecoveryAction(idle, form({ userId: TARGET, reason, actor: TARGET, opened_by: TARGET, p_actor: TARGET }));
    const [, args] = rpc.mock.calls[0]!;
    expect(Object.keys(args).sort()).toEqual(['p_reason', 'p_user_id']);
    expect(JSON.stringify(args)).not.toContain(ACTOR);
  });

  it('stops before the database at the session gate, and before the provider when the database denies', async () => {
    requireStaff.mockRejectedValueOnce(new Error('NEXT_REDIRECT /session-expired'));
    await expect(beginMfaRecoveryAction(idle, form({ userId: TARGET, reason }))).rejects.toThrow('NEXT_REDIRECT');
    expect(rpc).not.toHaveBeenCalled();

    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'not authorized' } });
    const denied = await beginMfaRecoveryAction(idle, form({ userId: TARGET, reason }));
    expect(denied.status).toBe('error');
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('validates input before the database', async () => {
    expect((await beginMfaRecoveryAction(idle, form({ userId: 'nope', reason }))).status).toBe('error');
    expect((await beginMfaRecoveryAction(idle, form({ userId: TARGET, reason: 'short' }))).status).toBe('error');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('records a provider failure and reports it truthfully (user stays blocked, retry offered)', async () => {
    admin.auth.admin.mfa.deleteFactor.mockImplementationOnce(async () => {
      calls.push('provider:delete:fail');
      return { data: null, error: { code: 'unexpected_failure', status: 500 } };
    });
    const result = await beginMfaRecoveryAction(idle, form({ userId: TARGET, reason }));
    expect(admin.rpc).toHaveBeenCalledWith('record_mfa_recovery_provider_result', {
      p_case_id: CASE,
      p_ok: false,
      p_error_code: 'unexpected_failure:500',
    });
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/blocked/);
    expect(result.message).toMatch(/failed/);
    expect(result.message).toMatch(/retry/i);
  });

  it('treats a thrown provider error as a recorded failure', async () => {
    admin.auth.admin.mfa.deleteFactor.mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { name: 'AuthRetryableFetchError' }));
    const result = await beginMfaRecoveryAction(idle, form({ userId: TARGET, reason }));
    expect(admin.rpc).toHaveBeenCalledWith('record_mfa_recovery_provider_result', {
      p_case_id: CASE,
      p_ok: false,
      p_error_code: 'AuthRetryableFetchError',
    });
    expect(result.status).toBe('error');
  });

  it('retrying a provider_failed case re-runs only the provider step on the same case', async () => {
    rpc.mockImplementation(async (name: string) => {
      calls.push(`db:${name}`);
      return { data: recoveryCase('provider_failed', { providerAttempts: 1 }), error: null };
    });
    const result = await beginMfaRecoveryAction(idle, form({ userId: TARGET, reason }));
    expect(admin.rpc).toHaveBeenCalledWith('record_mfa_recovery_provider_result', expect.objectContaining({ p_case_id: CASE, p_ok: true }));
    expect(result.status).toBe('success');
  });

  it('never deletes factors once the provider step is done (the new factor must survive)', async () => {
    for (const status of ['awaiting_reenrollment', 'awaiting_admin_confirmation', 'completed']) {
      vi.clearAllMocks();
      rpc.mockResolvedValue({ data: recoveryCase(status), error: null });
      const result = await beginMfaRecoveryAction(idle, form({ userId: TARGET, reason }));
      expect(result.status).toBe('success');
      expect(adminFactory).not.toHaveBeenCalled();
      expect(admin.auth.admin.mfa.deleteFactor).not.toHaveBeenCalled();
    }
  });

  it('reports when the outcome could not be recorded', async () => {
    admin.rpc.mockResolvedValueOnce({ data: { caseId: CASE, userId: TARGET, keepFactorId: null, factorIds: [] }, error: null });
    admin.rpc.mockResolvedValueOnce({ data: null, error: { code: '22023' } });
    const result = await beginMfaRecoveryAction(idle, form({ userId: TARGET, reason }));
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/could not be recorded/);
  });

  it('reports a provider failure whose result was not recorded as unknown, pointing at the pending-case control', async () => {
    admin.auth.admin.mfa.deleteFactor.mockResolvedValueOnce({ data: null, error: { code: 'unexpected_failure', status: 500 } });
    const normal = admin.rpc.getMockImplementation()!;
    admin.rpc.mockImplementation(async (name: string, args) => name === 'record_mfa_recovery_provider_result'
      ? { data: null, error: { code: '08006' } } : normal(name, args));
    const result = await beginMfaRecoveryAction(idle, form({ userId: TARGET, reason }));
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/outcome is unknown/);
    expect(result.message).toMatch(/Check and finish removing the old authenticator/);
    expect(result.message).not.toMatch(/Retry removing the old authenticator/);
  });

  it('reconciles a pending result-write failure on the same case before retrying removal', async () => {
    let state = 'provider_pending';
    let plans = 0;
    let outcomes = 0;
    rpc.mockImplementation(async (name: string) => {
      calls.push(`db:${name}`);
      return { data: recoveryCase(state), error: null };
    });
    const normal = admin.rpc.getMockImplementation()!;
    admin.rpc.mockImplementation(async (name: string, args) => {
      if (name === 'get_mfa_recovery_deletion_plan') {
        calls.push(`service:${name}:${args.p_phase}`);
        return { data: { caseId: CASE, userId: TARGET, keepFactorId: null, factorIds: plans++ === 0 ? [OLD_FACTOR] : [] }, error: null };
      }
      if (name === 'record_mfa_recovery_provider_result' && outcomes++ === 0) {
        calls.push('service:record-failed');
        return { data: null, error: { code: '08006' } };
      }
      state = 'awaiting_reenrollment';
      return normal(name, args);
    });
    expect((await beginMfaRecoveryAction(idle, form({ userId: TARGET, reason }))).status).toBe('error');
    expect((await beginMfaRecoveryAction(idle, form({ userId: TARGET, reason }))).status).toBe('success');
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(admin.auth.admin.mfa.deleteFactor).toHaveBeenCalledTimes(1);
    expect(admin.auth.admin.mfa.deleteFactor).toHaveBeenCalledWith({ id: OLD_FACTOR, userId: TARGET });
    expect(calls).toEqual([
      'db:begin_mfa_recovery', 'admin-client', 'service:get_mfa_recovery_deletion_plan:provider',
      `provider:delete:${OLD_FACTOR}`, 'service:record-failed',
      'db:begin_mfa_recovery', 'admin-client', 'service:get_mfa_recovery_deletion_plan:provider',
      'service:record_mfa_recovery_provider_result:true',
    ]);
    expect(admin.auth.admin.mfa.listFactors).not.toHaveBeenCalled();
  });

  it('does not repeat removal when reconciliation says the pending attempt already advanced', async () => {
    const normal = admin.rpc.getMockImplementation()!;
    admin.rpc.mockImplementation(async (name: string, args) => {
      if (name === 'record_mfa_recovery_provider_result') throw new Error('Lost response after commit');
      return normal(name, args);
    });
    const first = await beginMfaRecoveryAction(idle, form({ userId: TARGET, reason }));
    expect(first.status).toBe('error');
    expect(first.message).toMatch(/could not be recorded/);
    const deleted = admin.auth.admin.mfa.deleteFactor.mock.calls.length;
    const privilegedCalls = admin.rpc.mock.calls.length;
    rpc.mockResolvedValueOnce({ data: recoveryCase('awaiting_admin_confirmation'), error: null });
    expect((await beginMfaRecoveryAction(idle, form({ userId: TARGET, reason }))).status).toBe('success');
    expect(admin.auth.admin.mfa.deleteFactor).toHaveBeenCalledTimes(deleted);
    expect(admin.rpc).toHaveBeenCalledTimes(privilegedCalls);
  });

  it.each([
    ['missing plan', null],
    ['missing IDs', { caseId: CASE, userId: TARGET, keepFactorId: null }],
    ['non-UUID target', { caseId: CASE, userId: 'not-a-user', keepFactorId: null, factorIds: [OLD_FACTOR] }],
    ['non-UUID factor', { caseId: CASE, userId: TARGET, keepFactorId: null, factorIds: ['not-a-factor'] }],
    ['another case', { caseId: 'c0000000-0000-4000-8000-000000000002', userId: TARGET, keepFactorId: null, factorIds: [OLD_FACTOR] }],
  ])('refuses a malformed provider plan: %s', async (_label, data) => {
    admin.rpc.mockResolvedValueOnce({ data, error: null });
    const result = await beginMfaRecoveryAction(idle, form({ userId: TARGET, reason }));
    expect(result.status).toBe('error');
    expect(admin.auth.admin.mfa.deleteFactor).not.toHaveBeenCalled();
    expect(admin.auth.admin.mfa.listFactors).not.toHaveBeenCalled();
    expect(admin.rpc).toHaveBeenCalledWith('record_mfa_recovery_provider_result', {
      p_case_id: CASE, p_ok: false, p_error_code: 'invalid_deletion_plan',
    });
  });

  it('refuses a stale provider plan without touching Auth', async () => {
    admin.rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'recovery no longer needs provider removal' } });
    const result = await beginMfaRecoveryAction(idle, form({ userId: TARGET, reason }));
    expect(result.status).toBe('error');
    expect(admin.auth.admin.mfa.deleteFactor).not.toHaveBeenCalled();
    expect(admin.rpc).toHaveBeenCalledWith('record_mfa_recovery_provider_result', {
      p_case_id: CASE, p_ok: false, p_error_code: 'plan_lookup:22023',
    });
  });

  it('treats a missing or wrong-case provider result as unknown', async () => {
    const normal = admin.rpc.getMockImplementation()!;
    for (const data of [null, recoveryCase('provider_pending'), recoveryCase('awaiting_reenrollment', { caseId: 'c0000000-0000-4000-8000-000000000002' })]) {
      admin.rpc.mockImplementation(async (name: string, args) => name === 'record_mfa_recovery_provider_result'
        ? { data, error: null } : normal(name, args));
      const result = await beginMfaRecoveryAction(idle, form({ userId: TARGET, reason }));
      expect(result.status).toBe('error');
      expect(result.message).toMatch(/could not be recorded/);
    }
  });
});

describe('resumeMfaRecoveryProviderAction', () => {
  it('binds the retry to the posted case before any provider call', async () => {
    const result = await resumeMfaRecoveryProviderAction(idle, form({ caseId: CASE, userId: TARGET }));
    expect(rpc).toHaveBeenCalledWith('resume_mfa_recovery_provider', { p_case_id: CASE });
    expect(rpc).not.toHaveBeenCalledWith('begin_mfa_recovery', expect.anything());
    expect(calls.slice(0, 3)).toEqual(['db:resume_mfa_recovery_provider', 'admin-client', 'service:get_mfa_recovery_deletion_plan:provider']);
    expect(result.status).toBe('success');
  });

  it('a case that moved on changes nothing and never reaches the provider', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'this recovery case has moved on' } });
    const result = await resumeMfaRecoveryProviderAction(idle, form({ caseId: CASE }));
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/moved on since the page loaded. Nothing was changed/);
    expect(adminFactory).not.toHaveBeenCalled();
    expect(admin.auth.admin.mfa.deleteFactor).not.toHaveBeenCalled();
  });

  it('any other 22023 refusal keeps its own message (it is not called a stale page)', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'only active staff can be put through MFA recovery' } });
    const result = await resumeMfaRecoveryProviderAction(idle, form({ caseId: CASE }));
    expect(result.message).toBe('only active staff can be put through MFA recovery');
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('refuses a response for another case and a missing case ID without touching Auth', async () => {
    rpc.mockResolvedValueOnce({ data: recoveryCase('provider_pending', { caseId: 'c0000000-0000-4000-8000-000000000002' }), error: null });
    expect((await resumeMfaRecoveryProviderAction(idle, form({ caseId: CASE }))).status).toBe('error');
    expect((await resumeMfaRecoveryProviderAction(idle, form({}))).status).toBe('error');
    expect(adminFactory).not.toHaveBeenCalled();
  });
});

describe('confirmMfaRecoveryAction', () => {
  const valid = { caseId: CASE, method: 'SYNTHETIC_TEST_CALLBACK', confirmationCode: ' a1b2c3 ', note: 'Called back on file number' };

  it('passes normalized input to the database and never an actor', async () => {
    rpc.mockResolvedValue({ data: recoveryCase('completed', { completedAt: '2026-10-01T11:00:00Z' }), error: null });
    const result = await confirmMfaRecoveryAction(idle, form({ ...valid, completed_by: TARGET }));
    expect(rpc).toHaveBeenCalledWith('confirm_mfa_recovery', {
      p_case_id: CASE,
      p_method: 'SYNTHETIC_TEST_CALLBACK',
      p_confirmation_code: 'A1B2C3',
      p_note: 'Called back on file number',
    });
    expect(result.status).toBe('success');
    expect(result.message).toMatch(/sign in again/);
  });

  it('after completion removes every factor except the registered one, then records it', async () => {
    rpc.mockImplementation(async (name: string) => {
      calls.push(`db:${name}`);
      return { data: recoveryCase('completed', { completedAt: '2026-10-01T11:00:00Z' }), error: null };
    });
    const result = await confirmMfaRecoveryAction(idle, form(valid));
    expect(calls).toEqual([
      'db:confirm_mfa_recovery',
      'admin-client',
      'service:get_mfa_recovery_deletion_plan:cleanup',
      `provider:delete:${OLD_FACTOR}`,
      `provider:delete:${EXTRA_FACTOR}`,
      'service:record_mfa_recovery_cleanup_result:true',
    ]);
    expect(admin.auth.admin.mfa.deleteFactor).not.toHaveBeenCalledWith({ id: NEW_FACTOR, userId: TARGET });
    expect(admin.auth.admin.mfa.listFactors).not.toHaveBeenCalled();
    expect(result.status).toBe('success');
  });

  it('reports a cleanup failure truthfully and records it', async () => {
    rpc.mockResolvedValue({ data: recoveryCase('completed', { completedAt: '2026-10-01T11:00:00Z' }), error: null });
    admin.auth.admin.mfa.deleteFactor.mockResolvedValueOnce({ data: null, error: { code: 'unexpected_failure', status: 500 } });
    const result = await confirmMfaRecoveryAction(idle, form(valid));
    expect(admin.rpc).toHaveBeenCalledWith('record_mfa_recovery_cleanup_result', {
      p_case_id: CASE,
      p_ok: false,
      p_error_code: 'unexpected_failure:500',
    });
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/Recovery confirmed, but removing/);
  });

  it('never touches the provider when the code did not match', async () => {
    rpc.mockResolvedValue({ data: recoveryCase('awaiting_admin_confirmation'), error: null });
    await confirmMfaRecoveryAction(idle, form(valid));
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('never reports successful recovery when recording cleanup fails', async () => {
    rpc.mockResolvedValue({ data: recoveryCase('completed'), error: null });
    admin.rpc.mockImplementation(async (name: string) => name === 'get_mfa_recovery_deletion_plan'
      ? { data: { caseId: CASE, userId: TARGET, keepFactorId: NEW_FACTOR, factorIds: [] }, error: null }
      : { data: null, error: { code: '08006' } });
    const result = await confirmMfaRecoveryAction(idle, form(valid));
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/outcome is unknown/);
    expect(result.message).toMatch(/Access is not confirmed/);
  });

  it('reports a code mismatch as an error without claiming success', async () => {
    rpc.mockResolvedValue({ data: recoveryCase('awaiting_admin_confirmation'), error: null });
    const result = await confirmMfaRecoveryAction(idle, form(valid));
    expect(result).toMatchObject({ status: 'error', message: expect.stringMatching(/did not match/) });
  });

  it('surfaces unapproved method / lockout messages from the database', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'verification method is not approved' } });
    expect((await confirmMfaRecoveryAction(idle, form(valid))).message).toBe('verification method is not approved');
    rpc.mockResolvedValue({ data: null, error: { code: '54000', message: 'too many wrong codes' } });
    expect((await confirmMfaRecoveryAction(idle, form(valid))).message).toBe('too many wrong codes');
  });

  it('rejects malformed codes and methods before the database', async () => {
    expect((await confirmMfaRecoveryAction(idle, form({ ...valid, confirmationCode: '12345' }))).status).toBe('error');
    expect((await confirmMfaRecoveryAction(idle, form({ ...valid, method: "x'; drop" }))).status).toBe('error');
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['missing kept factor', { caseId: CASE, userId: TARGET, keepFactorId: null, factorIds: [OLD_FACTOR] }],
    ['kept factor included for deletion', { caseId: CASE, userId: TARGET, keepFactorId: NEW_FACTOR, factorIds: [OLD_FACTOR, NEW_FACTOR] }],
    ['non-UUID kept factor', { caseId: CASE, userId: TARGET, keepFactorId: 'wrong', factorIds: [OLD_FACTOR] }],
    ['missing factor array', { caseId: CASE, userId: TARGET, keepFactorId: NEW_FACTOR }],
  ])('refuses an unsafe cleanup plan: %s', async (_label, data) => {
    rpc.mockResolvedValueOnce({ data: recoveryCase('completed'), error: null });
    admin.rpc.mockResolvedValueOnce({ data, error: null });
    const result = await confirmMfaRecoveryAction(idle, form(valid));
    expect(result.status).toBe('error');
    expect(admin.auth.admin.mfa.deleteFactor).not.toHaveBeenCalled();
    expect(admin.rpc).toHaveBeenCalledWith('record_mfa_recovery_cleanup_result', {
      p_case_id: CASE, p_ok: false, p_error_code: 'invalid_deletion_plan',
    });
  });

  it('records an unknown cleanup outcome when its result write throws', async () => {
    rpc.mockResolvedValueOnce({ data: recoveryCase('completed'), error: null });
    const normal = admin.rpc.getMockImplementation()!;
    admin.rpc.mockImplementation(async (name: string, args) => {
      if (name === 'record_mfa_recovery_cleanup_result') throw new Error('Response lost');
      return normal(name, args);
    });
    const result = await confirmMfaRecoveryAction(idle, form(valid));
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/outcome is unknown/);
    expect(result.message).not.toMatch(/must sign in again/);
  });
});

describe('retryMfaRecoveryCleanupAction', () => {
  beforeEach(() => {
    rpc.mockImplementation(async (name: string) => {
      calls.push(`db:${name}`);
      return { data: recoveryCase('completed', { cleanupError: 'synthetic_failure' }), error: null };
    });
  });

  it('authorizes the same case before cleanup without reusing a consumed confirmation code', async () => {
    const result = await retryMfaRecoveryCleanupAction(idle, form({ caseId: CASE, actor: TARGET, keepFactorId: OLD_FACTOR }));
    expect(rpc).toHaveBeenCalledWith('retry_mfa_recovery_cleanup', { p_case_id: CASE });
    expect(calls).toEqual([
      'db:retry_mfa_recovery_cleanup', 'admin-client', 'service:get_mfa_recovery_deletion_plan:cleanup',
      `provider:delete:${OLD_FACTOR}`, `provider:delete:${EXTRA_FACTOR}`, 'service:record_mfa_recovery_cleanup_result:true',
    ]);
    expect(admin.auth.admin.mfa.deleteFactor).not.toHaveBeenCalledWith({ id: NEW_FACTOR, userId: TARGET });
    expect(admin.auth.admin.mfa.listFactors).not.toHaveBeenCalled();
    expect(result.status).toBe('success');
  });

  it('stops at the session gate before database or privileged calls', async () => {
    requireStaff.mockRejectedValueOnce(new Error('NEXT_REDIRECT /session-expired'));
    await expect(retryMfaRecoveryCleanupAction(idle, form({ caseId: CASE }))).rejects.toThrow('NEXT_REDIRECT');
    expect(rpc).not.toHaveBeenCalled();
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('refuses malformed input before authorization', async () => {
    expect((await retryMfaRecoveryCleanupAction(idle, form({ caseId: 'bad' }))).status).toBe('error');
    expect(rpc).not.toHaveBeenCalled();
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it.each(['42501', '22023'])('does not touch the provider when retry authorization refuses with %s', async (code) => {
    rpc.mockResolvedValueOnce({ data: null, error: { code, message: 'recovery case is superseded' } });
    const result = await retryMfaRecoveryCleanupAction(idle, form({ caseId: CASE }));
    expect(result.status).toBe('error');
    expect(adminFactory).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(admin.auth.admin.mfa.deleteFactor).not.toHaveBeenCalled();
  });

  it.each([
    recoveryCase('awaiting_admin_confirmation'),
    recoveryCase('completed', { caseId: 'c0000000-0000-4000-8000-000000000002' }),
    null,
  ])('refuses incomplete, mismatched or missing retry authorization', async (data) => {
    rpc.mockResolvedValueOnce({ data, error: null });
    expect((await retryMfaRecoveryCleanupAction(idle, form({ caseId: CASE }))).status).toBe('error');
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('refuses a superseded deletion plan after retry authorization, without deleting factors', async () => {
    admin.rpc.mockResolvedValueOnce({ data: null, error: { code: '22023' } });
    expect((await retryMfaRecoveryCleanupAction(idle, form({ caseId: CASE }))).status).toBe('error');
    expect(admin.auth.admin.mfa.deleteFactor).not.toHaveBeenCalled();
    expect(admin.rpc).toHaveBeenCalledWith('record_mfa_recovery_cleanup_result', {
      p_case_id: CASE, p_ok: false, p_error_code: 'plan_lookup:22023',
    });
  });

  it('retries a failed cleanup and reports provider failure honestly', async () => {
    admin.auth.admin.mfa.deleteFactor.mockResolvedValueOnce({ data: null, error: { code: 'unexpected_failure', status: 500 } });
    const result = await retryMfaRecoveryCleanupAction(idle, form({ caseId: CASE }));
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/failed/);
    expect(result.message).toMatch(/Access is not confirmed/);
    expect(admin.rpc).toHaveBeenCalledWith('record_mfa_recovery_cleanup_result', {
      p_case_id: CASE, p_ok: false, p_error_code: 'unexpected_failure:500',
    });
  });

  it.each([
    { status: 'completed', cleanupCompletedAt: null, cleanupError: null },
    { status: 'completed', cleanupCompletedAt: '2026-10-01T11:01:00Z', cleanupError: 'failed' },
    { status: 'provider_pending', cleanupCompletedAt: '2026-10-01T11:01:00Z', cleanupError: null },
  ])('does not claim cleanup success from an unconfirmed result: %j', async (state) => {
    admin.rpc.mockResolvedValueOnce({ data: { caseId: CASE, userId: TARGET, keepFactorId: NEW_FACTOR, factorIds: [] }, error: null });
    admin.rpc.mockResolvedValueOnce({ data: recoveryCase(state.status, state), error: null });
    const result = await retryMfaRecoveryCleanupAction(idle, form({ caseId: CASE }));
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/outcome is unknown/);
  });

  it('an already successful cleanup plan deletes nothing', async () => {
    admin.rpc.mockResolvedValueOnce({ data: { caseId: CASE, userId: TARGET, keepFactorId: NEW_FACTOR, factorIds: [] }, error: null });
    const result = await retryMfaRecoveryCleanupAction(idle, form({ caseId: CASE }));
    expect(result.status).toBe('success');
    expect(admin.auth.admin.mfa.deleteFactor).not.toHaveBeenCalled();
    expect(admin.auth.admin.mfa.listFactors).not.toHaveBeenCalled();
  });
});

describe('registerRecoveryFactorAction', () => {
  it('requires aal2 before calling the database', async () => {
    requireSignedIn.mockResolvedValueOnce({
      supabase: { rpc: userRpc },
      snapshot: { claims: { sub: TARGET, aal: 'aal1' }, verifiedFactorCount: 0, hadSessionCookie: true },
      userId: TARGET,
    });
    await expect(registerRecoveryFactorAction(idle, form({}))).rejects.toThrow('NEXT_REDIRECT /mfa/enroll');
    expect(userRpc).not.toHaveBeenCalled();
  });

  it('returns the confirmation code in the message', async () => {
    userRpc.mockResolvedValue({ data: { status: 'awaiting_admin_confirmation', confirmation_code: 'A1B2C3' }, error: null });
    const result = await registerRecoveryFactorAction(idle, form({ userId: ACTOR }));
    expect(userRpc).toHaveBeenCalledWith('register_my_recovery_factor');
    expect(result).toMatchObject({ status: 'success', message: expect.stringContaining('A1B2C3') });
  });

  it('reports an extra-factor refusal without a code', async () => {
    userRpc.mockResolvedValue({
      data: { status: 'awaiting_reenrollment', confirmation_code: null, refused: 'extra_factor' },
      error: null,
    });
    const result = await registerRecoveryFactorAction(idle, form({}));
    expect(result).toMatchObject({ status: 'error', message: expect.stringMatching(/More than one new authenticator/) });
  });

  it('asks for a fresh sign-in when the database refuses the session', async () => {
    userRpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'a new multi-factor sign-in is required' } });
    const result = await registerRecoveryFactorAction(idle, form({}));
    expect(result).toMatchObject({ status: 'error', message: expect.stringMatching(/Sign in again/) });
  });
});
