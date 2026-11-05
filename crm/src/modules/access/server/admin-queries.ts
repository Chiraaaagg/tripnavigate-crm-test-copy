import 'server-only';
import type {
  RecoveryCase,
  StaffEmailDelivery,
  StaffSecurityInfo,
  VerificationMethodOption,
} from '@/modules/identity/contracts';
import { istDate } from '@/lib/dates';
import type { StaffContext } from '@/modules/identity/server/session';
import { administeredEntityIds } from '../policy';
import type { GrantLine, StaffLine } from '@/views/staff-views';

export const PERMISSION_LABEL: Record<string, string> = {
  'deal.read': 'View deals',
  // S-42
  'deal.read_commercial': 'See prices and margin',
};

export function scopeLabel(branchName: string | undefined, entityName: string | undefined): string {
  return branchName ? `${branchName} branch` : `Whole entity (${entityName ?? 'unknown'})`;
}

async function lookups(staff: StaffContext) {
  const [branches, entities, roles] = await Promise.all([
    staff.supabase.from('branches').select('id, name, legal_entity_id, is_head_office').order('name'),
    staff.supabase.from('legal_entities').select('id, legal_name'),
    staff.supabase.from('roles').select('code, name').order('name'),
  ]);
  if (branches.error || entities.error || roles.error) throw new Error('Could not load reference data.');
  return { branches: branches.data ?? [], entities: entities.data ?? [], roles: roles.data ?? [] };
}

/** Staff list for administrators. RLS returns only entities where the viewer holds staff.manage. */
export async function loadStaffAdmin(staff: StaffContext) {
  const { branches, entities, roles } = await lookups(staff);
  const inviteEntities = new Set(administeredEntityIds(staff.access, 'staff.invite'));
  const [profiles, memberships] = await Promise.all([
    staff.supabase.from('staff_profiles').select('user_id, display_name, work_email, status').order('display_name'),
    staff.supabase.from('memberships').select('user_id, branch_id, role_code, status'),
  ]);
  if (profiles.error || memberships.error) throw new Error('Could not load staff.');
  const { security, verificationMethods } = await loadStaffSecurity(staff);
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const roleName = new Map(roles.map((r) => [r.code, r.name]));
  const lines: StaffLine[] = (profiles.data ?? []).map((p) => ({
    userId: p.user_id,
    displayName: p.display_name,
    email: p.work_email,
    status: p.status,
    isYou: p.user_id === staff.userId,
    access: (memberships.data ?? [])
      .filter((m) => m.user_id === p.user_id && m.status !== 'inactive')
      .map((m) => `${roleName.get(m.role_code) ?? m.role_code}, ${branchName.get(m.branch_id) ?? 'branch'}`),
  }));
  return {
    staff: lines,
    branches: branches
      .filter((b) => inviteEntities.has(b.legal_entity_id))
      .map((b) => ({ value: b.id, label: `${b.name}${b.is_head_office ? ' (head office)' : ''}` })),
    roles: roles.map((r) => ({ value: r.code, label: r.name })),
    entities,
    security,
    verificationMethods,
  };
}

const RECOVERY_COLUMNS = 'id, user_id, status, provider_attempts, last_provider_error, opened_at, opened_by, completed_at, cleanup_completed_at, cleanup_error';
const DELIVERY_COLUMNS = 'id, user_id, invitation_id, kind, status, attempt_no, error_code, created_at, completed_at';

/**
 * Recovery cases and latest email delivery per staff member, plus approved
 * verification methods. RLS limits rows to staff the viewer administers; the
 * confirmation code column is not granted to administrators at all.
 */
async function loadStaffSecurity(staff: StaffContext): Promise<{
  security: Record<string, StaffSecurityInfo>;
  verificationMethods: VerificationMethodOption[];
}> {
  const [cases, deliveries, methods] = await Promise.all([
    staff.supabase.from('mfa_recovery_cases').select(RECOVERY_COLUMNS).order('opened_at', { ascending: false }),
    staff.supabase.from('staff_email_deliveries').select(DELIVERY_COLUMNS).order('created_at', { ascending: false }),
    staff.supabase.from('recovery_verification_methods').select('code, label').eq('active', true).order('label'),
  ]);
  if (cases.error || deliveries.error || methods.error) throw new Error('Could not load staff security status.');

  const security: Record<string, StaffSecurityInfo> = {};
  const entry = (userId: string) => (security[userId] ??= { recovery: null, lastEmail: null });
  // Newest first: the first case per user is the open one if any (at most one is open).
  for (const c of cases.data ?? []) {
    const info = entry(c.user_id);
    if (info.recovery) continue;
    const recovery: RecoveryCase = {
      caseId: c.id,
      userId: c.user_id,
      status: c.status,
      providerAttempts: c.provider_attempts,
      lastProviderError: c.last_provider_error,
      openedAt: c.opened_at,
      openedBy: c.opened_by,
      completedAt: c.completed_at,
      cleanupCompletedAt: c.cleanup_completed_at,
      cleanupError: c.cleanup_error,
    };
    info.recovery = recovery;
  }
  for (const d of deliveries.data ?? []) {
    // First-invitation rows recorded before the Auth user existed have no user yet.
    if (!d.user_id) continue;
    const info = entry(d.user_id);
    if (info.lastEmail) continue;
    const delivery: StaffEmailDelivery = {
      deliveryId: d.id,
      userId: d.user_id,
      invitationId: d.invitation_id ?? null,
      kind: d.kind,
      status: d.status,
      attemptNo: d.attempt_no,
      errorCode: d.error_code,
      createdAt: d.created_at,
      completedAt: d.completed_at,
    };
    info.lastEmail = delivery;
  }
  return {
    security,
    verificationMethods: (methods.data ?? []).map((m) => ({ code: m.code, label: m.label })),
  };
}

export async function loadGrantAdmin(staff: StaffContext) {
  const { branches, entities } = await lookups(staff);
  const grantEntities = new Set(administeredEntityIds(staff.access, 'access.grant'));
  const [grants, profiles, memberships] = await Promise.all([
    staff.supabase
      .from('access_grants')
      .select('id, user_id, permission_code, legal_entity_id, branch_id, reason, created_at, expires_at')
      .is('revoked_at', null)
      .order('created_at', { ascending: false }),
    staff.supabase.from('staff_profiles').select('user_id, display_name, status'),
    staff.supabase.from('memberships').select('user_id, legal_entity_id, status'),
  ]);
  if (grants.error || profiles.error || memberships.error) throw new Error('Could not load access grants.');
  const name = new Map((profiles.data ?? []).map((p) => [p.user_id, p.display_name]));
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const entityName = new Map(entities.map((e) => [e.id, e.legal_name]));
  const now = Date.now();
  const lines: GrantLine[] = (grants.data ?? [])
    .filter((g) => !g.expires_at || Date.parse(g.expires_at) > now)
    .map((g) => ({
      id: g.id,
      staffName: name.get(g.user_id) ?? 'Unknown staff member',
      permissionLabel: PERMISSION_LABEL[g.permission_code] ?? g.permission_code,
      scopeLabel: scopeLabel(g.branch_id ? branchName.get(g.branch_id) : undefined, entityName.get(g.legal_entity_id)),
      reason: g.reason,
      grantedOn: istDate(g.created_at),
      expiresOn: g.expires_at ? istDate(g.expires_at) : null,
    }));
  const eligible = new Set(
    (memberships.data ?? [])
      .filter((m) => m.status === 'active' && grantEntities.has(m.legal_entity_id))
      .map((m) => m.user_id),
  );
  return {
    grants: lines,
    staff: (profiles.data ?? [])
      .filter((p) => p.status === 'active' && eligible.has(p.user_id) && p.user_id !== staff.userId)
      .map((p) => ({ value: p.user_id, label: p.display_name })),
    entities: entities.filter((e) => grantEntities.has(e.id)).map((e) => ({ value: e.id, label: e.legal_name })),
    branches: branches
      .filter((b) => grantEntities.has(b.legal_entity_id))
      .map((b) => ({ value: b.id, label: b.name })),
  };
}

/** The signed-in staff member's own active grants, for the "My access" page. */
export async function loadMyGrants(staff: StaffContext): Promise<GrantLine[]> {
  const [grants, branches] = await Promise.all([
    staff.supabase
      .from('access_grants')
      .select('id, permission_code, legal_entity_id, branch_id, reason, created_at, starts_at, expires_at')
      .eq('user_id', staff.userId)
      .is('revoked_at', null),
    staff.supabase.from('branches').select('id, name'),
  ]);
  if (grants.error || branches.error) throw new Error('Could not load your access grants.');
  const branchName = new Map((branches.data ?? []).map((b) => [b.id, b.name]));
  const entityName = new Map(staff.memberships.map((m) => [m.legalEntityId, m.legalEntityName]));
  const now = Date.now();
  return (grants.data ?? [])
    .filter((g) => Date.parse(g.starts_at) <= now && (!g.expires_at || Date.parse(g.expires_at) > now))
    .map((g) => ({
      id: g.id,
      staffName: staff.displayName,
      permissionLabel: PERMISSION_LABEL[g.permission_code] ?? g.permission_code,
      scopeLabel: scopeLabel(g.branch_id ? branchName.get(g.branch_id) : undefined, entityName.get(g.legal_entity_id)),
      reason: g.reason,
      grantedOn: istDate(g.created_at),
      expiresOn: g.expires_at ? istDate(g.expires_at) : null,
    }));
}
