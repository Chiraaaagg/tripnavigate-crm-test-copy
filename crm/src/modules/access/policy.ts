/**
 * Application mirror of the database access model (supabase/migrations).
 *
 * The database is authoritative: RLS and command functions enforce every rule
 * below independently. This module exists so server code can (a) shape DTOs that
 * omit restricted fields even if a query returned them, and (b) render only the
 * navigation a user can use. Keep it in sync with authz.* in SQL; the unit tests
 * pin the shared behaviour.
 */

export const PERMISSIONS = [
  'deal.read',
  'deal.read_commercial',
  'staff.invite',
  'staff.manage',
  'access.grant',
  'audit.read',
  'integration.manage',
  // Phase 3 (role-derived, never grantable).
  'booking.manage_draft',
  'booking.confirm',
  'purchase_task.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface MembershipFact {
  legalEntityId: string;
  branchId: string;
  roleCode: string;
}

export interface RolePermissionFact {
  roleCode: string;
  permissionCode: string;
  scope: 'own' | 'entity';
}

export interface GrantFact {
  permissionCode: string;
  legalEntityId: string;
  branchId: string | null;
}

/** Only ACTIVE memberships and ACTIVE (unrevoked, unexpired) grants belong here. */
export interface ViewerAccess {
  userId: string;
  memberships: MembershipFact[];
  rolePermissions: RolePermissionFact[];
  grants: GrantFact[];
}

export interface DealScopeFacts {
  legalEntityId: string;
  branchId: string;
  /** Null for an imported deal waiting for an owner (readable by entity scope only). */
  ownerUserId: string | null;
  activeAssigneeIds: string[];
}

function rolesIn(viewer: ViewerAccess, entityId: string): string[] {
  return viewer.memberships.filter((m) => m.legalEntityId === entityId).map((m) => m.roleCode);
}

function hasRolePermission(
  viewer: ViewerAccess,
  permission: Permission,
  entityId: string,
  scope: 'own' | 'entity',
): boolean {
  const roles = new Set(rolesIn(viewer, entityId));
  return viewer.rolePermissions.some(
    (rp) =>
      roles.has(rp.roleCode) &&
      rp.permissionCode === permission &&
      (scope === 'own' || rp.scope === 'entity'),
  );
}

function hasGrant(viewer: ViewerAccess, permission: Permission, entityId: string, branchId: string): boolean {
  if (!viewer.memberships.some((m) => m.legalEntityId === entityId)) return false;
  return viewer.grants.some(
    (g) =>
      g.permissionCode === permission &&
      g.legalEntityId === entityId &&
      (g.branchId === null || g.branchId === branchId),
  );
}

function isOwnerOrAssignee(viewer: ViewerAccess, deal: DealScopeFacts): boolean {
  return deal.ownerUserId === viewer.userId || deal.activeAssigneeIds.includes(viewer.userId);
}

function canUse(viewer: ViewerAccess, permission: Permission, deal: DealScopeFacts): boolean {
  return (
    (isOwnerOrAssignee(viewer, deal) && hasRolePermission(viewer, permission, deal.legalEntityId, 'own')) ||
    hasRolePermission(viewer, permission, deal.legalEntityId, 'entity') ||
    // Explicit grants cover owned deals only (authz.can_read_deal, 20261007000100).
    (deal.ownerUserId !== null && hasGrant(viewer, permission, deal.legalEntityId, deal.branchId))
  );
}

export function canReadDeal(viewer: ViewerAccess, deal: DealScopeFacts): boolean {
  return canUse(viewer, 'deal.read', deal);
}

/** Confirmed rule: anyone holding the Purchase role in the entity never sees selling price or margin. */
export function canReadDealCommercial(viewer: ViewerAccess, deal: DealScopeFacts): boolean {
  if (rolesIn(viewer, deal.legalEntityId).includes('purchase')) return false;
  return canReadDeal(viewer, deal) && canUse(viewer, 'deal.read_commercial', deal);
}

/** Entity-scoped administrative capability (role-derived only; never grantable). */
export function canAdminister(viewer: ViewerAccess, permission: Permission, entityId: string): boolean {
  return hasRolePermission(viewer, permission, entityId, 'entity');
}

export function administeredEntityIds(viewer: ViewerAccess, permission: Permission): string[] {
  const entities = new Set(viewer.memberships.map((m) => m.legalEntityId));
  return [...entities].filter((id) => canAdminister(viewer, permission, id));
}

// ---------------------------------------------------------------------------
// Phase 3 booking -> Purchase task (mirrors authz.* in
// supabase/migrations/20261004000100_booking_purchase_task.sql, contract §4).
// ---------------------------------------------------------------------------

/** Deal facts plus the users holding an ACTIVE 'sales' assignment on it. */
export interface BookingDealFacts extends DealScopeFacts {
  activeSalesAssigneeIds: string[];
}

export interface PurchaseTaskScopeFacts {
  legalEntityId: string;
  deal: DealScopeFacts;
}

function holdsRole(viewer: ViewerAccess, role: string, entityId: string): boolean {
  return rolesIn(viewer, entityId).includes(role);
}

/** P3-D3a (owner-confirmed): manager role with an active membership in the deal's branch. */
export function isBranchSalesManager(viewer: ViewerAccess, deal: DealScopeFacts): boolean {
  return viewer.memberships.some(
    (m) => m.legalEntityId === deal.legalEntityId && m.branchId === deal.branchId && m.roleCode === 'manager',
  );
}

/** authz.can_edit_booking_draft */
export function canEditBookingDraft(viewer: ViewerAccess, deal: BookingDealFacts): boolean {
  if (!canReadDeal(viewer, deal) || holdsRole(viewer, 'purchase', deal.legalEntityId)) return false;
  const salesActor =
    (deal.ownerUserId === viewer.userId || deal.activeSalesAssigneeIds.includes(viewer.userId)) &&
    holdsRole(viewer, 'sales', deal.legalEntityId);
  return salesActor || isBranchSalesManager(viewer, deal);
}

/** authz.can_confirm_booking: the deal owner (Sales) or a branch Sales Manager; never an assignee alone. */
export function canConfirmBooking(viewer: ViewerAccess, deal: DealScopeFacts): boolean {
  if (!canReadDeal(viewer, deal) || holdsRole(viewer, 'purchase', deal.legalEntityId)) return false;
  return (
    (deal.ownerUserId === viewer.userId && holdsRole(viewer, 'sales', deal.legalEntityId)) ||
    isBranchSalesManager(viewer, deal)
  );
}

/** authz.can_read_booking: booking facts (booking_versions rows, booking_panel). Never Purchase. */
export function canReadBooking(viewer: ViewerAccess, deal: DealScopeFacts): boolean {
  return canReadDeal(viewer, deal) && !holdsRole(viewer, 'purchase', deal.legalEntityId);
}

/** authz.can_read_booking_evidence (amendment A4 M2): only those who may edit or confirm the booking. */
export function canReadBookingEvidence(viewer: ViewerAccess, deal: BookingDealFacts): boolean {
  return canEditBookingDraft(viewer, deal) || canConfirmBooking(viewer, deal);
}

/** authz.can_read_purchase_task: Purchase sees every task in its entity (P3-D4); deal readers see their deal's task. */
export function canReadPurchaseTask(viewer: ViewerAccess, task: PurchaseTaskScopeFacts): boolean {
  if (holdsRole(viewer, 'purchase', task.legalEntityId)) return true;
  return canReadDeal(viewer, task.deal);
}

/** authz.can_claim_purchase_task */
export function canClaimPurchaseTask(viewer: ViewerAccess, task: Pick<PurchaseTaskScopeFacts, 'legalEntityId'>): boolean {
  return holdsRole(viewer, 'purchase', task.legalEntityId);
}

// ---------------------------------------------------------------------------
// Phase 6 lead screens (lead-screens contract §1–§2). Navigation convenience
// only: crm_leads RLS is the control.
// ---------------------------------------------------------------------------

/** True when the viewer holds the Purchase role in any entity (lead pages then never query). */
export function holdsPurchaseAnywhere(viewer: ViewerAccess): boolean {
  return viewer.memberships.some((m) => m.roleCode === 'purchase');
}

/**
 * Lead nav predicate: an entity where the viewer holds an active `sales` or
 * `manager` membership, or administers `integration.manage`, and does not hold
 * `purchase` in that entity. Callers pass only ACTIVE memberships.
 */
export function canSeeLeads(viewer: ViewerAccess): boolean {
  const entities = new Set(viewer.memberships.map((m) => m.legalEntityId));
  return [...entities].some((entityId) => {
    if (holdsRole(viewer, 'purchase', entityId)) return false;
    return (
      holdsRole(viewer, 'sales', entityId) ||
      holdsRole(viewer, 'manager', entityId) ||
      canAdminister(viewer, 'integration.manage', entityId)
    );
  });
}

/**
 * Quotations and Itineraries menu items, and the Home quotation rows
 * (Direction A Batch 3, FP-001/FP-040/FP-051; lead ruling 21 October 2026):
 * an entity where the viewer holds an active `sales` or `manager` membership
 * and no `purchase` membership, and no `purchase` membership anywhere (as the
 * Leads link). This mirrors who may edit quotations today (Deal: Sales owner
 * or assignee, branch Manager; Lead: Lead owner with Sales, branch Manager;
 * never a Purchase holder). Super Admin, Accounts, Flight and the Visa desk
 * never get it by role. Navigation convenience only: the quotation and
 * itinerary reads decide every row. Callers pass only ACTIVE memberships.
 */
export function canSeeQuotations(viewer: ViewerAccess): boolean {
  if (holdsPurchaseAnywhere(viewer)) return false;
  const entities = new Set(viewer.memberships.map((m) => m.legalEntityId));
  return [...entities].some((entityId) => holdsRole(viewer, 'sales', entityId) || holdsRole(viewer, 'manager', entityId));
}

// ---------------------------------------------------------------------------
// Phase 5A Accounts and finance policy (phase-5a-contract.md §4, §15).
// Navigation convenience only: authz.can_accounts and
// authz.can_manage_finance_policy in the database decide every read and
// command. Callers pass only ACTIVE memberships (inactive staff have none).
// `financeEnabledEntityIds` lists the entities with a finance_live_settings
// row; when omitted, no entity is treated as enabled (fail closed).
// ---------------------------------------------------------------------------

function financeEnabled(entityId: string, financeEnabledEntityIds: readonly string[] | undefined): boolean {
  return financeEnabledEntityIds?.includes(entityId) ?? false;
}

function entityIdsOf(viewer: ViewerAccess): string[] {
  return [...new Set(viewer.memberships.map((m) => m.legalEntityId))];
}

/**
 * Entities where the viewer may use Accounts: an active `accounts` membership,
 * finance enabled for the entity, and no `purchase` membership in that entity
 * (Purchase must never see selling totals).
 */
export function accountsEntityIds(viewer: ViewerAccess, financeEnabledEntityIds?: readonly string[]): string[] {
  return entityIdsOf(viewer).filter(
    (entityId) =>
      financeEnabled(entityId, financeEnabledEntityIds) &&
      holdsRole(viewer, 'accounts', entityId) &&
      !holdsRole(viewer, 'purchase', entityId),
  );
}

/** Accounts navigation predicate (mirrors authz.can_accounts for at least one entity). */
export function canUseAccounts(viewer: ViewerAccess, financeEnabledEntityIds?: readonly string[]): boolean {
  return accountsEntityIds(viewer, financeEnabledEntityIds).length > 0;
}

/**
 * Entities whose finance policy the viewer may edit: `super_admin` there,
 * finance enabled, and no `accounts` role in that entity (a person cannot both
 * set the cash cap and handle cash).
 */
export function financePolicyEntityIds(viewer: ViewerAccess, financeEnabledEntityIds?: readonly string[]): string[] {
  return entityIdsOf(viewer).filter(
    (entityId) =>
      financeEnabled(entityId, financeEnabledEntityIds) &&
      holdsRole(viewer, 'super_admin', entityId) &&
      !holdsRole(viewer, 'accounts', entityId),
  );
}

/** Finance policy navigation predicate (mirrors authz.can_manage_finance_policy for at least one entity). */
export function canManageFinancePolicy(viewer: ViewerAccess, financeEnabledEntityIds?: readonly string[]): boolean {
  return financePolicyEntityIds(viewer, financeEnabledEntityIds).length > 0;
}

/**
 * Deal conflict for Accounts approvals (§4): the deal owner or an active Sales
 * assignee may record but never verify, reject, clear, reverse or approve.
 */
export function hasFinanceDealConflict(viewer: ViewerAccess, deal: Pick<BookingDealFacts, 'ownerUserId' | 'activeSalesAssigneeIds'>): boolean {
  return deal.ownerUserId === viewer.userId || deal.activeSalesAssigneeIds.includes(viewer.userId);
}
