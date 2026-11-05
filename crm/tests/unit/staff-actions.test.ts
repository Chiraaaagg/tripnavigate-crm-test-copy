import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Server authorization tests for staff administration actions. They verify
 * the ordering contract: session gate first, then the database command under
 * the actor's own session, and only then the privileged Auth admin API. The
 * actor is never taken from the form.
 */

const requireStaff = vi.fn();
const rpc = vi.fn();
const maybeSingle = vi.fn();
const from = vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }));
const adminFactory = vi.fn();
const admin = {
  auth: {
    resetPasswordForEmail: vi.fn(),
    admin: {
      inviteUserByEmail: vi.fn(),
      listUsers: vi.fn(),
      updateUserById: vi.fn(),
      mfa: { listFactors: vi.fn(), deleteFactor: vi.fn() },
    },
  },
  rpc: vi.fn(),
};

vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => adminFactory() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
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

const staffActions = await import('@/modules/access/server/staff-actions');
const { deactivateStaffAction, grantScopeAction, inviteStaffAction, sendStaffEmailAction } = staffActions;

const ACTOR = 'a0000000-0000-4000-8000-000000000007';
const TARGET = 'a0000000-0000-4000-8000-000000000002';
const BRANCH = 'b0000000-0000-4000-8000-000000000001';
const ENTITY = 'e0000000-0000-4000-8000-000000000001';
const idle = { status: 'idle' as const };

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockResolvedValue({ userId: ACTOR, supabase: { rpc, from } });
  adminFactory.mockReturnValue(admin);
});

describe('inviteStaffAction', () => {
  const valid = { email: 'new.person@example.test', displayName: 'New Person', branchId: BRANCH, roleCode: 'sales' };

  it('stops at the session gate before any database or admin call', async () => {
    requireStaff.mockRejectedValue(new Error('NEXT_REDIRECT /mfa/challenge'));
    await expect(inviteStaffAction(idle, form(valid))).rejects.toThrow('NEXT_REDIRECT');
    expect(rpc).not.toHaveBeenCalled();
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('refuses recipients outside the environment allow-list before calling the database', async () => {
    const result = await inviteStaffAction(idle, form({ ...valid, email: 'real.person@gmail.com' }));
    expect(result.status).toBe('error');
    expect(rpc).not.toHaveBeenCalled();
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('ignores client-supplied actor, entity and inviter fields', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'not authorized' } });
    await inviteStaffAction(
      idle,
      form({ ...valid, invited_by: TARGET, userId: TARGET, legal_entity_id: ENTITY, p_actor: TARGET }),
    );
    expect(rpc).toHaveBeenCalledWith('create_staff_invitation', {
      p_email: 'new.person@example.test',
      p_display_name: 'New Person',
      p_branch_id: BRANCH,
      p_role_code: 'sales',
    });
  });

  it('never touches the privileged client when the database denies the actor', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'not authorized' } });
    const result = await inviteStaffAction(idle, form(valid));
    expect(result).toEqual({
      status: 'error',
      message: 'You do not have permission to do that for this staff member or branch.',
    });
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('records the pending delivery BEFORE the provider call, then the result, then links', async () => {
    const order: string[] = [];
    rpc.mockImplementation(async (name: string) => {
      order.push(`db:${name}`);
      return name === 'create_staff_invitation'
        ? { data: 'inv-1', error: null }
        : { data: { deliveryId: 'del-1', userId: null, status: 'pending' }, error: null };
    });
    admin.auth.admin.inviteUserByEmail.mockImplementation(async () => {
      order.push('provider:invite');
      return { data: { user: { id: TARGET } }, error: null };
    });
    admin.rpc.mockImplementation(async (name: string) => {
      order.push(`service:${name}`);
      return { error: null };
    });
    const result = await inviteStaffAction(idle, form(valid));
    expect(order).toEqual([
      'db:create_staff_invitation',
      'db:request_invitation_email',
      'provider:invite',
      'service:record_staff_email_result',
      'service:link_invitation_user',
    ]);
    expect(rpc).toHaveBeenCalledWith('request_invitation_email', { p_invitation_id: 'inv-1' });
    expect(admin.auth.admin.inviteUserByEmail).toHaveBeenCalledWith('new.person@example.test', {
      redirectTo: 'https://crm-staging.example.test/auth/confirm',
      data: { invitation_id: 'inv-1' },
    });
    expect(admin.rpc).toHaveBeenCalledWith('record_staff_email_result', {
      p_delivery_id: 'del-1',
      p_ok: true,
      p_error_code: null,
    });
    expect(admin.rpc).toHaveBeenCalledWith('link_invitation_user', { p_invitation_id: 'inv-1', p_user_id: TARGET });
    expect(result.status).toBe('success');
    expect(result.message).toMatch(/handed to the mail service/);
    expect(result.message).not.toMatch(/\bdelivered\b/i);
  });

  it('does not call the provider when the delivery request is rate limited', async () => {
    rpc.mockImplementation(async (name: string) =>
      name === 'create_staff_invitation'
        ? { data: 'inv-1', error: null }
        : { data: null, error: { code: '54000', message: 'too soon; retry after 30 seconds' } },
    );
    const result = await inviteStaffAction(idle, form(valid));
    expect(result).toEqual({ status: 'error', message: 'too soon; retry after 30 seconds' });
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('records a provider failure on the delivery row and says no email was sent', async () => {
    rpc.mockImplementation(async (name: string) =>
      name === 'create_staff_invitation'
        ? { data: 'inv-1', error: null }
        : { data: { deliveryId: 'del-1', status: 'pending' }, error: null },
    );
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({ data: { user: null }, error: { code: 'email_exists', status: 422 } });
    admin.auth.admin.listUsers.mockResolvedValue({ data: { users: [] }, error: null });
    admin.rpc.mockResolvedValue({ error: null });
    const result = await inviteStaffAction(idle, form(valid));
    expect(admin.rpc).toHaveBeenCalledWith('record_staff_email_result', {
      p_delivery_id: 'del-1',
      p_ok: false,
      p_error_code: 'email_exists:422',
    });
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/did not accept/);
    // A provider refusal is usually configuration, not a transient error: point at SMTP, not "retry in a minute".
    expect(result.message).toMatch(/check the email \(SMTP\) settings, then resend\.$/);
  });

  it('a thrown provider call is an unknown outcome, never "did not accept" (U03)', async () => {
    rpc.mockImplementation(async (name: string) =>
      name === 'create_staff_invitation'
        ? { data: 'inv-1', error: null }
        : { data: { deliveryId: 'del-1', status: 'pending' }, error: null },
    );
    admin.auth.admin.inviteUserByEmail.mockRejectedValue(new Error('socket hang up'));
    admin.auth.admin.listUsers.mockResolvedValue({ data: { users: [] }, error: null });
    admin.rpc.mockResolvedValue({ error: null });
    const result = await inviteStaffAction(idle, form(valid));
    expect(admin.rpc).toHaveBeenCalledWith('record_staff_email_result', {
      p_delivery_id: 'del-1', p_ok: false, p_error_code: 'provider_outcome_unknown',
    });
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/could not confirm whether the mail service accepted/);
    expect(result.message).not.toMatch(/did not accept/);
  });

  it('a failed result write is reported, not hidden behind a success message (U03)', async () => {
    rpc.mockImplementation(async (name: string) =>
      name === 'create_staff_invitation'
        ? { data: 'inv-1', error: null }
        : { data: { deliveryId: 'del-1', status: 'pending' }, error: null },
    );
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({ data: { user: { id: 'u-1' } }, error: null });
    admin.rpc.mockImplementation(async (name: string) =>
      name === 'record_staff_email_result' ? { error: { code: '08006' } } : { error: null });
    const result = await inviteStaffAction(idle, form(valid));
    expect(result.status).toBe('success');
    expect(result.message).toMatch(/delivery status could not be recorded/);
  });

  it('a failed account lookup after a refusal says it is unknown, never "did not accept" (U03)', async () => {
    rpc.mockImplementation(async (name: string) =>
      name === 'create_staff_invitation'
        ? { data: 'inv-1', error: null }
        : { data: { deliveryId: 'del-1', status: 'pending' }, error: null },
    );
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({ data: { user: null }, error: { code: 'email_exists', status: 422 } });
    admin.auth.admin.listUsers.mockResolvedValue({ data: null, error: { status: 500 } });
    admin.rpc.mockResolvedValue({ error: null });
    const result = await inviteStaffAction(idle, form(valid));
    expect(result.message).toMatch(/could not confirm/);
    expect(result.message).not.toMatch(/did not accept/);
  });

  it('rejects unknown roles before calling the database', async () => {
    const result = await inviteStaffAction(idle, form({ ...valid, roleCode: 'owner' }));
    expect(result.status).toBe('error');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('deactivateStaffAction', () => {
  const valid = { userId: TARGET, reason: 'Left the company on 30 September' };

  it('resetStaffMfaAction no longer exists (replaced by beginMfaRecoveryAction)', () => {
    expect('resetStaffMfaAction' in staffActions).toBe(false);
  });

  it('does not ban when the database denies the actor', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'not authorized' } });
    expect((await deactivateStaffAction(idle, form(valid))).status).toBe('error');
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('bans the Auth user after the database deactivated the staff member', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    admin.auth.admin.updateUserById.mockResolvedValue({ error: null });
    const result = await deactivateStaffAction(idle, form(valid));
    expect(rpc).toHaveBeenCalledWith('deactivate_staff_member', { p_user_id: TARGET, p_reason: valid.reason });
    expect(admin.auth.admin.updateUserById).toHaveBeenCalledWith(TARGET, { ban_duration: '876000h' });
    expect(result.status).toBe('success');
  });

  it('requires a reason before calling the database', async () => {
    expect((await deactivateStaffAction(idle, form({ userId: TARGET, reason: 'short' }))).status).toBe('error');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('grantScopeAction', () => {
  it('passes the target as a request and never an actor identity', async () => {
    rpc.mockResolvedValue({ data: 'g1', error: null });
    await grantScopeAction(
      idle,
      form({
        userId: TARGET,
        permission: 'deal.read',
        legalEntityId: ENTITY,
        branchId: BRANCH,
        reason: 'Covering Ahmedabad during leave',
        granted_by: TARGET,
      }),
    );
    const [name, args] = rpc.mock.calls[0]!;
    expect(name).toBe('grant_access_scope');
    expect(Object.keys(args).sort()).toEqual([
      'p_branch_id',
      'p_expires_at',
      'p_legal_entity_id',
      'p_permission',
      'p_reason',
      'p_user_id',
    ]);
    expect(JSON.stringify(args)).not.toContain(ACTOR);
  });

  it('refuses non-grantable permissions before calling the database', async () => {
    const result = await grantScopeAction(
      idle,
      form({ userId: TARGET, permission: 'staff.manage', legalEntityId: ENTITY, reason: 'Trying to escalate' }),
    );
    expect(result.status).toBe('error');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('sendStaffEmailAction', () => {
  const valid = { userId: TARGET, kind: 'password_reset' };
  const delivery = { deliveryId: 'del-9', userId: TARGET, kind: 'password_reset', status: 'pending', attemptNo: 1 };

  beforeEach(() => {
    maybeSingle.mockResolvedValue({ data: { work_email: 'sales.delhi.b@example.test' }, error: null });
    admin.auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
    admin.rpc.mockResolvedValue({ data: { ...delivery, status: 'handed_to_provider' }, error: null });
  });

  it('asks the database first (rate limit, authority) and only then the mail provider, then records the result', async () => {
    rpc.mockResolvedValue({ data: delivery, error: null });
    const result = await sendStaffEmailAction(idle, form({ ...valid, actor: TARGET, created_by: TARGET }));
    expect(rpc).toHaveBeenCalledWith('request_staff_email', { p_user_id: TARGET, p_kind: 'password_reset' });
    expect(admin.auth.resetPasswordForEmail).toHaveBeenCalledWith('sales.delhi.b@example.test', {
      redirectTo: 'https://crm-staging.example.test/auth/confirm',
    });
    expect(admin.rpc).toHaveBeenCalledWith('record_staff_email_result', {
      p_delivery_id: 'del-9',
      p_ok: true,
      p_error_code: null,
    });
    const order = [
      rpc.mock.invocationCallOrder[0]!,
      admin.auth.resetPasswordForEmail.mock.invocationCallOrder[0]!,
      admin.rpc.mock.invocationCallOrder[0]!,
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(result.status).toBe('success');
    expect(result.message).toMatch(/handed to the mail service/);
    expect(result.message).not.toMatch(/\bdelivered\b/i);
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(ACTOR);
  });

  it('never calls the provider when the database refuses (rate limit or permission)', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '54000', message: 'too soon; retry after 42 seconds' } });
    const limited = await sendStaffEmailAction(idle, form(valid));
    expect(limited).toEqual({ status: 'error', message: 'too soon; retry after 42 seconds' });
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'not authorized' } });
    expect((await sendStaffEmailAction(idle, form(valid))).status).toBe('error');
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('records and reports a provider failure truthfully', async () => {
    rpc.mockResolvedValue({ data: delivery, error: null });
    admin.auth.resetPasswordForEmail.mockResolvedValue({ data: null, error: { code: 'over_email_send_rate_limit', status: 429 } });
    const result = await sendStaffEmailAction(idle, form(valid));
    expect(admin.rpc).toHaveBeenCalledWith('record_staff_email_result', {
      p_delivery_id: 'del-9',
      p_ok: false,
      p_error_code: 'over_email_send_rate_limit:429',
    });
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/did not accept/);
  });

  it('does not email recipients outside the environment allow-list', async () => {
    rpc.mockResolvedValue({ data: delivery, error: null });
    maybeSingle.mockResolvedValue({ data: { work_email: 'real.person@gmail.com' }, error: null });
    const result = await sendStaffEmailAction(idle, form(valid));
    expect(admin.auth.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(admin.rpc).toHaveBeenCalledWith('record_staff_email_result', {
      p_delivery_id: 'del-9',
      p_ok: false,
      p_error_code: 'recipient_not_allowed',
    });
    expect(result.status).toBe('error');
  });

  it('only allows resend and password reset kinds', async () => {
    const result = await sendStaffEmailAction(idle, form({ userId: TARGET, kind: 'invitation' }));
    expect(result.status).toBe('error');
    expect(rpc).not.toHaveBeenCalled();
  });
});
