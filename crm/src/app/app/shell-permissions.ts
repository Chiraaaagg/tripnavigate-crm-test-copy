import 'server-only';
import { administeredEntityIds, canManageFinancePolicy, canSeeLeads, canSeeQuotations, canUseAccounts, holdsPurchaseAnywhere } from '@/modules/access/policy';
import { accountsRoleEntityIds, importEntityIds } from '@/modules/parties/import-access';
import type { ViewerAccess } from '@/modules/access/policy';
import type { StaffContext } from '@/modules/identity/server/session';
import type { ShellViewer } from '@/views/StaffShell';

/**
 * Settings · Features (carried Batch 4 Low N1): who may open the page and see
 * its tab. Mirrors settings_switch_states(), which returns the workflow
 * section only to a Super Admin or to an integration manager who holds no
 * Purchase role anywhere (Echo-A M1 and L9). A Purchase holder with
 * integration.manage who is not a Super Admin would see only Unknown rows, so
 * the tab is hidden and the page shows its no-permission view. Uses data
 * already loaded; the database still decides every read and change.
 */
export function canOpenFeaturesSettings(access: ViewerAccess): boolean {
  if (administeredEntityIds(access, 'integration.manage').length === 0) return false;
  return !holdsPurchaseAnywhere(access) || access.memberships.some((m) => m.roleCode === 'super_admin');
}

/**
 * Which sections the staff frame (and Home's "next steps") offers this
 * person. One function so the navigation and Home can never disagree.
 * Navigation convenience only: every page, command and database policy still
 * decides access on its own. Uses data already loaded (no extra queries).
 */
export function shellPermissions(
  staff: StaffContext,
  financeEntities: string[],
): Omit<ShellViewer, 'displayName' | 'primaryRole' | 'primaryBranch'> {
  return {
    canAdministerStaff: administeredEntityIds(staff.access, 'staff.manage').length > 0,
    canManageGrants: administeredEntityIds(staff.access, 'access.grant').length > 0,
    canManageIntegration: administeredEntityIds(staff.access, 'integration.manage').length > 0,
    // Batch 4: Settings · Bitrix connection tab. Same rule as the page (it refuses Purchase holders,
    // review M2); the page and the database still decide.
    canOpenBitrixConnection: administeredEntityIds(staff.access, 'integration.manage').length > 0 && !holdsPurchaseAnywhere(staff.access),
    // Leads link per lead-screens contract §2, plus the loader's rule: a Purchase holder in any
    // entity gets no link (the page would refuse them). crm_leads RLS is the control.
    canSeeLeads: canSeeLeads(staff.access) && !holdsPurchaseAnywhere(staff.access),
    // Batch 3 (FP-001, lead ruling 21 Oct): Quotations and Itineraries items and the Home quotation
    // rows: Sales or Manager in an entity without Purchase, and no Purchase anywhere (as Leads, minus
    // integration.manage). The quotation and itinerary reads are the control.
    canSeeQuotations: canSeeQuotations(staff.access),
    // Managers read Purchase work of their branch's deals and the supplier register (Phase 4 A1).
    canSeePurchaseTasks: staff.memberships.some((m) => m.roleCode === 'purchase' || m.roleCode === 'manager'),
    // B1: Flight tasks for the Flight role only (the database returns rows to Flight role holders;
    // managers follow their branch's flight work on the Deal page services card).
    canSeeFlightTasks: staff.memberships.some((m) => m.roleCode === 'flight'),
    // B1.1 (freeze §3.4/§5, lead-owned line): the Visa & Passport desk for the `visa` role only.
    canSeeVisaDesk: staff.memberships.some((m) => m.roleCode === 'visa'),
    canUseAccounts: canUseAccounts(staff.access, financeEntities),
    canManageFinancePolicy: canManageFinancePolicy(staff.access, financeEntities),
    // Voice-note batch (Echo-B N2): the same rules as the pages, not the finance switch.
    // Settings · Imports: Super Admin (hotel list) or Accounts (customer list), without Purchase in
    // that company (import-access.ts). The import commands decide every step.
    canImport: importEntityIds(staff.access, 'hotel').length > 0 || importEntityIds(staff.access, 'customer').length > 0,
    // Accounts · Customers to check: Accounts without Purchase in that company (accountsRoleEntityIds).
    canCheckCustomers: accountsRoleEntityIds(staff.access).length > 0,
  };
}

/**
 * Which "What needs you" counts on Home apply to this person (Direction A,
 * HO-01, plan T4). my_work_counts returns 0 rather than null for the Sales
 * counts to everyone, so Home hides a count unless the person holds a role
 * that the database counts it for. Display convenience only: the database
 * still scopes every number, and every page still decides access on its own.
 * Uses data already loaded (no extra queries).
 */
export interface HomeWorkRoles {
  /** Sales or Manager: booking drafts, returned reviews, missing details, confirmed deals needing a booking. */
  bookings: boolean;
  /** Manager role: the Sales counts also cover the branch's deals (named on Home). */
  branchManager: boolean;
  /** Purchase role (Managers read Purchase work but my_work_counts does not count it for them). */
  purchase: boolean;
  flight: boolean;
  visa: boolean;
  /** Same rule as the Accounts menu group. */
  accounts: boolean;
}

export function homeWorkRoles(staff: Pick<StaffContext, 'memberships' | 'access'>, financeEntities: string[]): HomeWorkRoles {
  const holds = (code: string) => staff.memberships.some((m) => m.roleCode === code);
  return {
    bookings: holds('sales') || holds('manager'),
    branchManager: holds('manager'),
    purchase: holds('purchase'),
    flight: holds('flight'),
    visa: holds('visa'),
    accounts: canUseAccounts(staff.access, financeEntities),
  };
}
