import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * requireStaff() asks the database (my_session_status) for the single session
 * decision; sign-out-everywhere moves the database barrier before the provider
 * sign-out; "Forgot password?" is generic, allow-listed and writes nothing.
 */

const calls: string[] = [];
const rpc = vi.fn();
const getClaims = vi.fn();
const getAal = vi.fn();
const signOut = vi.fn();
const resetPasswordForEmail = vi.fn();
const fromQuery = vi.fn();
const listFactors = vi.fn();
const enroll = vi.fn();
const unenroll = vi.fn();
const createClient = vi.fn();
const updateUser = vi.fn();

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'order']) c[m] = () => c;
  c.maybeSingle = async () => result;
  c.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return c;
}

const serverClient = {
  rpc,
  from: (table: string) => fromQuery(table),
  auth: { getClaims, mfa: { getAuthenticatorAssuranceLevel: getAal, listFactors, enroll, unenroll }, signOut, updateUser },
};

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: async () => serverClient }));
vi.mock('@supabase/supabase-js', () => ({ createClient: (...args: unknown[]) => createClient(...args) }));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [{ name: 'sb-ref-auth-token', value: 'x' }] }) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    calls.push(`redirect:${to}`);
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), cache: <T,>(fn: T) => fn }));
vi.mock('@/lib/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/config')>();
  const config = original.parseAppConfig({
    APP_ENV: 'local',
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example_not_a_secret',
    NEXT_PUBLIC_SITE_URL: 'https://crm-staging.example.test',
  });
  return { ...original, getAppConfig: () => config };
});

const { requireStaff, getMySessionStatus } = await import('@/modules/identity/server/session');
const { requestPasswordResetAction, setInitialPasswordAction, signOutEverywhereAction, signOutAction, startTotpEnrollmentAction } = await import(
  '@/modules/identity/server/actions'
);

const USER = 'a0000000-0000-4000-8000-000000000001';
const status = (state: string, extra: Record<string, unknown> = {}) => ({
  data: { state, sessionMaxAgeSeconds: 43200, policyStatus: 'proposed', ...extra },
  error: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  getClaims.mockResolvedValue({ data: { claims: { sub: USER, aal: 'aal2' } } });
  getAal.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' } });
  signOut.mockImplementation(async (opts: unknown) => {
    calls.push(`provider:signOut:${JSON.stringify(opts)}`);
    return { error: null };
  });
  createClient.mockReturnValue({ auth: { resetPasswordForEmail } });
  resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
});

describe('requireStaff uses my_session_status as the single decision', () => {
  it.each([
    ['session_expired', '/session-expired'],
    ['session_revoked', '/session-expired'],
    ['recovery_pending', '/account-recovery'],
    ['onboarding_incomplete', '/onboarding/finish'],
    ['inactive', '/access-inactive'],
    ['no_membership', '/access-inactive'],
    ['mfa_required', '/mfa/challenge'],
  ])('%s -> %s, before reading any table', async (state, route) => {
    rpc.mockResolvedValue(status(state));
    await expect(requireStaff()).rejects.toThrow(`NEXT_REDIRECT ${route}`);
    expect(rpc).toHaveBeenCalledWith('my_session_status');
    expect(fromQuery).not.toHaveBeenCalled();
  });

  it('mfa_required without a verified factor goes to enrolment', async () => {
    rpc.mockResolvedValue(status('mfa_required'));
    getAal.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal1' } });
    await expect(requireStaff()).rejects.toThrow('NEXT_REDIRECT /mfa/enroll');
  });

  it('no verified claims: sign-in (or session-expired with a stale cookie) without a database call', async () => {
    getClaims.mockResolvedValue({ data: null });
    await expect(requireStaff()).rejects.toThrow('NEXT_REDIRECT /session-expired');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('fails closed on an RPC error or an unexpected payload', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501' } });
    await expect(requireStaff()).rejects.toThrow(/Could not verify your session/);
    rpc.mockResolvedValue({ data: { state: 'allowed' }, error: null });
    await expect(requireStaff()).rejects.toThrow(/Could not verify your session/);
    expect(fromQuery).not.toHaveBeenCalled();
  });

  it('loads the staff context only after state ok', async () => {
    rpc.mockResolvedValue(status('ok'));
    fromQuery.mockImplementation((table: string) => {
      switch (table) {
        case 'staff_profiles':
          return chain({ data: { display_name: 'Synthetic', work_email: 's@example.test', status: 'active' }, error: null });
        case 'memberships':
          return chain({ data: [{ legal_entity_id: 'e1', branch_id: 'b1', role_code: 'sales' }], error: null });
        default:
          return chain({ data: [], error: null });
      }
    });
    const staff = await requireStaff();
    expect(staff.userId).toBe(USER);
    expect(staff.memberships).toHaveLength(1);
  });

  it('getMySessionStatus never redirects', async () => {
    rpc.mockResolvedValue(status('recovery_pending', { recovery: { caseId: 'c0000000-0000-4000-8000-000000000001', status: 'provider_failed' } }));
    expect((await getMySessionStatus()).state).toBe('recovery_pending');
    getClaims.mockResolvedValue({ data: null });
    expect((await getMySessionStatus()).state).toBe('no_session');
    expect(calls.some((c) => c.startsWith('redirect'))).toBe(false);
  });
});

describe('signOutEverywhereAction', () => {
  it('moves the database barrier first, then signs out globally, then redirects', async () => {
    rpc.mockImplementation(async (name: string) => {
      calls.push(`db:${name}`);
      return { data: null, error: null };
    });
    await expect(signOutEverywhereAction(new FormData())).rejects.toThrow('NEXT_REDIRECT /signed-out?scope=global');
    expect(calls).toEqual(['db:revoke_my_sessions', 'provider:signOut:{"scope":"global"}', 'redirect:/signed-out?scope=global']);
  });

  it('says so when the provider global sign-out fails (database access already revoked)', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    signOut.mockResolvedValueOnce({ error: { code: 'unexpected_failure' } });
    await expect(signOutEverywhereAction(new FormData())).rejects.toThrow(
      'NEXT_REDIRECT /signed-out?scope=global&provider=failed',
    );
    signOut.mockRejectedValueOnce(new Error('network'));
    await expect(signOutEverywhereAction(new FormData())).rejects.toThrow(
      'NEXT_REDIRECT /signed-out?scope=global&provider=failed',
    );
  });

  it('does not claim success when the database step fails', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501' } });
    await expect(signOutEverywhereAction(new FormData())).rejects.toThrow(/Could not sign you out/);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('does not claim a local sign-out the provider did not confirm', async () => {
    signOut.mockResolvedValueOnce({ error: { code: 'unexpected_failure' } });
    await expect(signOutAction(new FormData())).rejects.toThrow('NEXT_REDIRECT /signed-out?provider=failed');
    signOut.mockRejectedValueOnce(new Error('network'));
    await expect(signOutAction(new FormData())).rejects.toThrow('NEXT_REDIRECT /signed-out?provider=failed');
    signOut.mockResolvedValueOnce({ error: null });
    await expect(signOutAction(new FormData())).rejects.toThrow(/^NEXT_REDIRECT \/signed-out$/);
  });
  it('the legacy scope=global sign-out form takes the same path', async () => {
    rpc.mockImplementation(async (name: string) => {
      calls.push(`db:${name}`);
      return { data: null, error: null };
    });
    const fd = new FormData();
    fd.set('scope', 'global');
    await expect(signOutAction(fd)).rejects.toThrow('NEXT_REDIRECT /signed-out?scope=global');
    expect(calls[0]).toBe('db:revoke_my_sessions');
  });
});

describe('requestPasswordResetAction', () => {
  const submit = (email: string) => {
    const fd = new FormData();
    fd.set('email', email);
    return requestPasswordResetAction({ status: 'idle' }, fd);
  };

  it('sends the recovery email for allow-listed addresses through the publishable key', async () => {
    const result = await submit(' Sales.Delhi.A@Example.test ');
    expect(createClient).toHaveBeenCalledWith(
      'http://127.0.0.1:54321',
      'sb_publishable_example_not_a_secret',
      expect.anything(),
    );
    expect(resetPasswordForEmail).toHaveBeenCalledWith('sales.delhi.a@example.test', {
      redirectTo: 'https://crm-staging.example.test/auth/confirm',
    });
    expect(result.status).toBe('success');
    expect(rpc).not.toHaveBeenCalled(); // writes no database row
  });

  it('returns the identical message for unknown, disallowed, malformed and failing requests', async () => {
    const ok = await submit('sales.delhi.a@example.test');
    const disallowed = await submit('real.person@gmail.com');
    const malformed = await submit('not-an-email');
    resetPasswordForEmail.mockRejectedValueOnce(new Error('network'));
    const failing = await submit('unknown@example.test');
    for (const r of [disallowed, malformed, failing]) expect(r).toEqual(ok);
    expect(resetPasswordForEmail).toHaveBeenCalledTimes(2);
    expect(ok.message).not.toMatch(/delivered/i);
  });
});

describe('startTotpEnrollmentAction (finding 11)', () => {
  beforeEach(() => {
    enroll.mockResolvedValue({ data: { id: 'f-new', totp: { qr_code: 'qr', secret: 's' } }, error: null });
  });

  it('refuses an aal1 session when the account already has a verified factor', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: USER, aal: 'aal1' } } });
    listFactors.mockResolvedValue({ data: { all: [{ id: 'f1', status: 'verified' }] }, error: null });
    const result = await startTotpEnrollmentAction();
    expect(result.status).toBe('error');
    expect(enroll).not.toHaveBeenCalled();
    expect(unenroll).not.toHaveBeenCalled();
  });

  it('fails closed when factors cannot be listed', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: USER, aal: 'aal1' } } });
    listFactors.mockResolvedValue({ data: null, error: { code: 'unexpected_failure' } });
    expect((await startTotpEnrollmentAction()).status).toBe('error');
    expect(enroll).not.toHaveBeenCalled();
  });

  it('allows first enrolment at aal1 and adding a factor at aal2', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: USER, aal: 'aal1' } } });
    listFactors.mockResolvedValue({ data: { all: [{ id: 'u1', status: 'unverified' }] }, error: null });
    expect((await startTotpEnrollmentAction()).status).toBe('ready');
    expect(unenroll).toHaveBeenCalledWith({ factorId: 'u1' });
    getClaims.mockResolvedValue({ data: { claims: { sub: USER, aal: 'aal2' } } });
    listFactors.mockResolvedValue({ data: { all: [{ id: 'f1', status: 'verified' }] }, error: null });
    expect((await startTotpEnrollmentAction()).status).toBe('ready');
  });
});
describe('setInitialPasswordAction (AUDIT-013, Milestone A section 5)', () => {
  const PASSWORD = 'Synthetic-Pass-2026';
  const submit = () => {
    const fd = new FormData();
    fd.set('password', PASSWORD);
    fd.set('confirm', PASSWORD);
    return setInitialPasswordAction({ status: 'idle' }, fd);
  };
  const verifiedFactor = { data: { all: [{ id: 'f1', status: 'verified' }], totp: [] }, error: null };
  const noFactor = { data: { all: [], totp: [] }, error: null };
  beforeEach(() => {
    updateUser.mockResolvedValue({ data: {}, error: null });
    listFactors.mockResolvedValue(noFactor);
    rpc.mockResolvedValue(status('ok'));
  });
  it('an aal1 session on an account with a working authenticator is sent to the challenge first', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: USER, aal: 'aal1' } } });
    getAal.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' } });
    listFactors.mockResolvedValue(verifiedFactor);
    await expect(submit()).rejects.toThrow('NEXT_REDIRECT /mfa/challenge?next=%2Fonboarding%2Fpassword');
    expect(updateUser).not.toHaveBeenCalled();
  });
  it('recovery on an account with an existing factor requires aal2 even when the token says no factor', async () => {
    // A recovery link gives aal1. The assurance level read from the token
    // (nextLevel) is not trusted for this decision: the provider factor list is.
    getClaims.mockResolvedValue({ data: { claims: { sub: USER, aal: 'aal1' } } });
    getAal.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal1' } });
    listFactors.mockResolvedValue(verifiedFactor);
    await expect(submit()).rejects.toThrow('NEXT_REDIRECT /mfa/challenge?next=%2Fonboarding%2Fpassword');
    expect(listFactors).toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });
  it('recovery at aal2 with an existing factor changes the password and continues where the database says', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: USER, aal: 'aal2' } } });
    getAal.mockResolvedValue({ data: { currentLevel: 'aal2', nextLevel: 'aal2' } });
    listFactors.mockResolvedValue(verifiedFactor);
    await expect(submit()).rejects.toThrow('NEXT_REDIRECT /app');
    expect(updateUser).toHaveBeenCalledWith({ password: PASSWORD });
    expect(rpc).toHaveBeenCalledWith('my_session_status');
  });
  it.each([
    ['an error', async () => ({ data: null, error: { name: 'AuthApiError', status: 500 } })],
    ['a thrown failure', async () => Promise.reject(new Error('network down'))],
    ['an unexpected shape', async () => ({ data: { totp: [] }, error: null })],
  ])('refuses the change when listing factors returns %s (fail closed)', async (_label, impl) => {
    for (const aal of ['aal1', 'aal2']) {
      updateUser.mockClear();
      getClaims.mockResolvedValue({ data: { claims: { sub: USER, aal } } });
      getAal.mockResolvedValue({ data: { currentLevel: aal, nextLevel: 'aal1' } });
      listFactors.mockImplementation(impl);
      const result = await submit();
      expect(result.status).toBe('error');
      expect(result.message).toMatch(/password was not changed/);
      expect(updateUser).not.toHaveBeenCalled();
    }
  });
  it('reads the factors before any password change, never after', async () => {
    const order: string[] = [];
    getClaims.mockResolvedValue({ data: { claims: { sub: USER, aal: 'aal2' } } });
    listFactors.mockImplementation(async () => {
      order.push('listFactors');
      return noFactor;
    });
    updateUser.mockImplementation(async () => {
      order.push('updateUser');
      return { data: {}, error: null };
    });
    await expect(submit()).rejects.toThrow('NEXT_REDIRECT');
    expect(order).toEqual(['listFactors', 'updateUser']);
  });
  it('allows the password at aal1 when the account has no verified factor (new invite or MFA recovery)', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: USER, aal: 'aal1' } } });
    getAal.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal1' } });
    listFactors.mockResolvedValue({ data: { all: [{ id: 'u1', status: 'unverified' }], totp: [] }, error: null });
    await expect(submit()).rejects.toThrow('NEXT_REDIRECT /mfa/enroll');
    expect(updateUser).toHaveBeenCalledWith({ password: PASSWORD });
  });
  it('allows the password at aal2', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: USER, aal: 'aal2' } } });
    getAal.mockResolvedValue({ data: { currentLevel: 'aal2', nextLevel: 'aal2' } });
    await expect(submit()).rejects.toThrow('NEXT_REDIRECT');
    expect(updateUser).toHaveBeenCalledWith({ password: PASSWORD });
  });
});
