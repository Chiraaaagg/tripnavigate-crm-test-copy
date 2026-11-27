import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Booking reliability B1-8 (lead contract C0-form): staffForAction() reaches the
 * same decision as requireStaff() for every session state. The only difference
 * is delivery: where requireStaff() redirects to sign-in or session-expired,
 * staffForAction() returns SESSION_ENDED; every other redirect and every
 * failure is identical.
 */

const rpc = vi.fn();
const getClaims = vi.fn();
const getAal = vi.fn();
const tables = new Map<string, { data: unknown; error: unknown }>();
let cookieNames: string[] = [];

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'order']) c[m] = () => c;
  c.maybeSingle = async () => result;
  c.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return c;
}

const serverClient = {
  rpc,
  from: (table: string) => chain(tables.get(table) ?? { data: [], error: null }),
  auth: { getClaims, mfa: { getAuthenticatorAssuranceLevel: getAal } },
};

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: async () => serverClient }));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => cookieNames.map((name) => ({ name, value: 'x' })) }) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT ${to}`), { redirectTo: to });
  },
}));
vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), cache: <T,>(fn: T) => fn }));

const { requireStaff, staffForAction, SESSION_ENDED } = await import('@/modules/identity/server/session');

const USER = 'a0000000-0000-4000-8000-000000000001';

type Outcome = { kind: 'redirect'; to: string } | { kind: 'ended' } | { kind: 'throw'; message: string } | { kind: 'staff'; userId: string; email: string; memberships: number };

async function outcome(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    const r = await fn();
    if (r === SESSION_ENDED) return { kind: 'ended' };
    const s = r as { userId: string; email: string; memberships: unknown[] };
    return { kind: 'staff', userId: s.userId, email: s.email, memberships: s.memberships.length };
  } catch (error) {
    const to = (error as { redirectTo?: string }).redirectTo;
    if (to) return { kind: 'redirect', to };
    return { kind: 'throw', message: (error as Error).message };
  }
}

const status = (state: string) => ({ data: { state, sessionMaxAgeSeconds: 43200, policyStatus: 'proposed' }, error: null });

function seed(opts: { claims?: boolean; cookie?: boolean; state?: string | null; rpcError?: boolean; factors?: number; profile?: 'active' | 'inactive' | null; memberships?: number; profileError?: boolean; branchError?: boolean }) {
  cookieNames = opts.cookie === false ? [] : ['sb-ref-auth-token'];
  getClaims.mockResolvedValue({ data: opts.claims === false ? null : { claims: { sub: USER, aal: 'aal2' } } });
  getAal.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: (opts.factors ?? 1) > 0 ? 'aal2' : 'aal1' } });
  rpc.mockResolvedValue(opts.rpcError ? { data: null, error: { code: '57014', message: 'timeout' } } : status(opts.state ?? 'ok'));
  tables.clear();
  tables.set('staff_profiles', opts.profileError ? { data: null, error: { message: 'x' } } : { data: opts.profile === null ? null : { display_name: 'Synthetic Sales', work_email: 'sales@example.test', status: opts.profile ?? 'active' }, error: null });
  tables.set('memberships', { data: Array.from({ length: opts.memberships ?? 1 }, () => ({ legal_entity_id: 'e1', branch_id: 'b1', role_code: 'sales' })), error: null });
  tables.set('branches', opts.branchError ? { data: null, error: { message: 'x' } } : { data: [{ id: 'b1', name: 'Delhi', is_head_office: false }], error: null });
  tables.set('legal_entities', { data: [{ id: 'e1', legal_name: 'Synthetic Entity' }], error: null });
  tables.set('roles', { data: [{ code: 'sales', name: 'Sales' }], error: null });
  tables.set('role_permissions', { data: [], error: null });
  tables.set('access_grants', { data: [], error: null });
}

const CASES: Array<[string, Parameters<typeof seed>[0], Outcome]> = [
  ['no claims, no cookie', { claims: false, cookie: false }, { kind: 'redirect', to: '/sign-in' }],
  ['no claims, cookie present (expired or invalid)', { claims: false, cookie: true }, { kind: 'redirect', to: '/session-expired' }],
  ['database: no_session', { state: 'no_session' }, { kind: 'redirect', to: '/sign-in' }],
  ['database: session_expired', { state: 'session_expired' }, { kind: 'redirect', to: '/session-expired' }],
  ['database: session_revoked (barrier moved)', { state: 'session_revoked' }, { kind: 'redirect', to: '/session-expired' }],
  ['database: mfa_required with a factor', { state: 'mfa_required', factors: 1 }, { kind: 'redirect', to: '/mfa/challenge' }],
  ['database: mfa_required without a factor', { state: 'mfa_required', factors: 0 }, { kind: 'redirect', to: '/mfa/enroll' }],
  ['database: recovery_pending', { state: 'recovery_pending' }, { kind: 'redirect', to: '/account-recovery' }],
  ['database: onboarding_incomplete', { state: 'onboarding_incomplete' }, { kind: 'redirect', to: '/onboarding/finish' }],
  ['database: inactive', { state: 'inactive' }, { kind: 'redirect', to: '/access-inactive' }],
  ['database: no_membership', { state: 'no_membership' }, { kind: 'redirect', to: '/access-inactive' }],
  ['session read failed', { rpcError: true }, { kind: 'throw', message: 'Could not verify your session. Please retry.' }],
  ['profile read failed', { profileError: true }, { kind: 'throw', message: 'Could not load staff access. Please retry.' }],
  ['profile inactive', { profile: 'inactive' }, { kind: 'redirect', to: '/access-inactive' }],
  ['no profile', { profile: null }, { kind: 'redirect', to: '/access-inactive' }],
  ['no active membership', { memberships: 0 }, { kind: 'redirect', to: '/access-inactive' }],
  ['branch read failed', { branchError: true }, { kind: 'throw', message: 'Could not load staff access. Please retry.' }],
  ['allowed', {}, { kind: 'staff', userId: USER, email: 'sales@example.test', memberships: 1 }],
];

const ENDED = new Set(['/sign-in', '/session-expired']);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('staffForAction and requireStaff reach the same decision', () => {
  it.each(CASES)('%s', async (_name, state, expected) => {
    seed(state);
    const page = await outcome(() => requireStaff());
    expect(page).toEqual(expected);
    seed(state);
    const action = await outcome(() => staffForAction());
    if (page.kind === 'redirect' && ENDED.has(page.to)) expect(action).toEqual({ kind: 'ended' });
    else expect(action).toEqual(page);
  });

  it('reads the database session decision exactly as often as requireStaff', async () => {
    seed({});
    await requireStaff();
    const pageCalls = rpc.mock.calls.length;
    rpc.mockClear();
    seed({});
    await staffForAction();
    expect(rpc.mock.calls.length).toBe(pageCalls);
    expect(rpc).toHaveBeenCalledWith('my_session_status');
  });
});
