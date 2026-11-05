import 'server-only';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { ViewerAccess } from '@/modules/access/policy';
import type { SessionStatus } from '../contracts';
import {
  type AuthSnapshot,
  ROUTES,
  decideMfaStep,
  parseSessionStatus,
  routeForSessionState,
} from '../session-policy';

type ServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export interface StaffMembershipView {
  legalEntityId: string;
  legalEntityName: string;
  branchId: string;
  branchName: string;
  isHeadOffice: boolean;
  roleCode: string;
  roleName: string;
}

export interface StaffContext {
  userId: string;
  email: string;
  displayName: string;
  memberships: StaffMembershipView[];
  access: ViewerAccess;
  supabase: ServerClient;
}

async function readSessionBasics(supabase: ServerClient, hadSessionCookie: boolean): Promise<AuthSnapshot> {
  // getClaims() verifies the JWT (signature + expiry). Never use getSession()
  // data from cookies for authorization.
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims as
    | { sub: string; aal?: string; amr?: Array<{ method: string; timestamp: number }> }
    | undefined;
  // nextLevel is derived from the account's verified factors; used only to pick
  // between enrollment and challenge, never to grant access.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  return {
    hadSessionCookie,
    claims: claims?.sub ? { sub: claims.sub, aal: claims.aal, amr: claims.amr } : null,
    verifiedFactorCount: aal?.nextLevel === 'aal2' ? 1 : 0,
  };
}

async function hasAuthCookie(): Promise<boolean> {
  const { cookies } = await import('next/headers');
  return (await cookies()).getAll().some((c) => /^sb-.+-auth-token/.test(c.name));
}

/** For MFA/onboarding/recovery pages: requires a valid (aal1 or aal2) session. */
export async function requireSignedIn() {
  const supabase = await createSupabaseServerClient();
  const snapshot = await readSessionBasics(supabase, await hasAuthCookie());
  if (!snapshot.claims) {
    const decision = decideMfaStep(snapshot);
    redirect(decision.kind === 'redirect' ? decision.to : ROUTES.signIn);
  }
  return { supabase, snapshot, userId: snapshot.claims.sub };
}

/**
 * The branches the signed-in user may read (RLS), once per request. Shared by
 * requireStaff and the list loaders that show branch names, so a page reads
 * the branch table once (speed plan C2). Keyed by the request's own client.
 */
export const visibleBranches = cache(async (supabase: ServerClient) => await supabase.from('branches').select('id, name, is_head_office'));

const NO_SESSION: SessionStatus = { state: 'no_session', sessionMaxAgeSeconds: 0, policyStatus: 'proposed' };

/** Asks the database for the session decision. Throws (fails closed) on any unexpected answer. */
async function fetchSessionStatus(supabase: ServerClient): Promise<SessionStatus> {
  const { data, error } = await supabase.rpc('my_session_status');
  const status = error ? null : parseSessionStatus(data);
  if (!status) throw new Error('Could not verify your session. Please retry.');
  return status;
}

/**
 * The database session decision for status pages (/account-recovery,
 * /session-expired, ...). Never redirects. Without a verified JWT it returns
 * state 'no_session' (sessionMaxAgeSeconds 0 = not read) without a database call.
 */
export async function getMySessionStatus(): Promise<SessionStatus> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims?.sub) return NO_SESSION;
  return fetchSessionStatus(supabase);
}

/**
 * Authoritative gate for every protected page and server action. The single
 * decision is public.my_session_status() (aal2, auth time after the barrier,
 * absolute age, no open recovery case, active staff, active membership).
 * Identity comes only from verified claims, never from request parameters.
 * Cached per request.
 */
export const requireStaff = cache(async (): Promise<StaffContext> => {
  const supabase = await createSupabaseServerClient();
  const hadCookie = await hasAuthCookie();
  const { data: claimsData } = await supabase.auth.getClaims();
  const userId = (claimsData?.claims as { sub?: string } | undefined)?.sub;
  if (!userId) {
    redirect(hadCookie ? ROUTES.sessionExpired : ROUTES.signIn);
  }

  const status = await fetchSessionStatus(supabase);
  if (status.state !== 'ok') {
    let factors = 0;
    if (status.state === 'mfa_required') {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      factors = aal?.nextLevel === 'aal2' ? 1 : 0;
    }
    const decision = routeForSessionState(status.state, factors);
    redirect(decision.kind === 'redirect' ? decision.to : ROUTES.sessionExpired);
  }

  // These reads run under the user's own session, so RLS applies (and would
  // return nothing if the session became invalid in between). They run as one
  // wave after the session decision (speed plan C1): the profile and
  // membership checks are applied first, exactly as before.
  const reads = await Promise.all([
    supabase.from('staff_profiles').select('display_name, work_email, status').eq('user_id', userId).maybeSingle(),
    supabase
      .from('memberships')
      .select('legal_entity_id, branch_id, role_code')
      .eq('user_id', userId)
      .eq('status', 'active'),
    visibleBranches(supabase),
    supabase.from('legal_entities').select('id, legal_name'),
    supabase.from('roles').select('code, name'),
    supabase.from('role_permissions').select('role_code, permission_code, scope'),
    supabase
      .from('access_grants')
      .select('permission_code, legal_entity_id, branch_id, starts_at, expires_at')
      .eq('user_id', userId)
      .is('revoked_at', null),
  ]);
  const [profileRes, membershipRes, branchesRes, entitiesRes, rolesRes, rolePermsRes, grantsRes] = reads;
  if (profileRes.error || membershipRes.error) {
    throw new Error('Could not load staff access. Please retry.');
  }
  const profile = profileRes.data;
  const memberships = membershipRes.data ?? [];
  if (profile?.status !== 'active' || memberships.length === 0) {
    redirect(ROUTES.accessInactive);
  }
  for (const res of [branchesRes, entitiesRes, rolesRes, rolePermsRes, grantsRes]) {
    if (res.error) throw new Error('Could not load staff access. Please retry.');
  }
  const now = Date.now();
  const branchById = new Map((branchesRes.data ?? []).map((b) => [b.id, b]));
  const entityById = new Map((entitiesRes.data ?? []).map((e) => [e.id, e]));
  const roleByCode = new Map((rolesRes.data ?? []).map((r) => [r.code, r]));

  return {
    userId,
    email: profile!.work_email,
    displayName: profile!.display_name,
    supabase,
    memberships: memberships.map((m) => ({
      legalEntityId: m.legal_entity_id,
      legalEntityName: entityById.get(m.legal_entity_id)?.legal_name ?? 'Unknown entity',
      branchId: m.branch_id,
      branchName: branchById.get(m.branch_id)?.name ?? 'Unknown branch',
      isHeadOffice: Boolean(branchById.get(m.branch_id)?.is_head_office),
      roleCode: m.role_code,
      roleName: roleByCode.get(m.role_code)?.name ?? m.role_code,
    })),
    access: {
      userId,
      memberships: memberships.map((m) => ({
        legalEntityId: m.legal_entity_id,
        branchId: m.branch_id,
        roleCode: m.role_code,
      })),
      rolePermissions: (rolePermsRes.data ?? []).map((rp) => ({
        roleCode: rp.role_code,
        permissionCode: rp.permission_code,
        scope: rp.scope as 'own' | 'entity',
      })),
      grants: (grantsRes.data ?? [])
        .filter((g) => Date.parse(g.starts_at) <= now && (!g.expires_at || Date.parse(g.expires_at) > now))
        .map((g) => ({ permissionCode: g.permission_code, legalEntityId: g.legal_entity_id, branchId: g.branch_id })),
    },
  };
});
