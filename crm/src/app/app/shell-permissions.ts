import 'server-only';
import { administeredEntityIds, canManageFinancePolicy, canSeeLeads, canSeeQuotations, canUseAccounts, holdsPurchaseAnywhere } from '@/modules/access/policy';
import { accountsRoleEntityIds, importEntityIds } from '@/modules/parties/import-access';
import type { ViewerAccess } from '@/modules/access/policy';
import type { StaffContext } from '@/modules/identity/server/session';
import type { ShellViewer } from '@/views/StaffShell';
import { settingsTabsFor, type SettingsTabVM } from '@/modules/settings/contracts';
import { loadFlightHomeCounts } from '@/modules/flight/server/queries';
import { loadMyWorkCounts } from '@/modules/fulfilment/server/counts';
import { loadSupplierMoneyHomeCounts } from '@/modules/supplier-money/server/queries';
import { menuCountReads, menuCountsFrom, type MenuCountRoles, type MenuCounts } from './sections';

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
 * The Settings areas this person may open: one rule for the Settings frame's
 * area list (admin/layout.tsx) and the Overview page (admin/page.tsx), so the
 * two never disagree. The shell flags decide the areas (settingsTabsFor), N1
 * hides Features from someone that page would refuse, and R1 (D12) shows
 * Customer messages only to a Super Admin, the only person its page answers
 * (admin_customer_messages returns null for everyone else). Navigation
 * convenience only: every page and database command still decides access.
 */
export function settingsAreasFor(staff: StaffContext, financeEntities: string[]): SettingsTabVM[] {
  const features = canOpenFeaturesSettings(staff.access);
  const canOpenCustomerMessages = staff.memberships.some((m) => m.roleCode === 'super_admin');
  return settingsTabsFor({ ...shellPermissions(staff, financeEntities), canOpenCustomerMessages }).filter((t) => t.category !== 'features' || features);
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
    // Purchase build: own supplier payment requests (Purchase role) and the Approvals page (Manager role).
    // The reads decide every row; these only show the links.
    canSeePurchasePayments: staff.memberships.some((m) => m.roleCode === 'purchase'),
    canSeeApprovals: staff.memberships.some((m) => m.roleCode === 'manager'),
    // B1: Flight tasks for the Flight role. Flight build (contract 11.2): the branch Manager also gets
    // the read-only queue of their branches' flights (flight_queue decides every row).
    canSeeFlightTasks: staff.memberships.some((m) => m.roleCode === 'flight' || m.roleCode === 'manager'),
    // B1.1 (freeze §3.4/§5): the Visa & Passport desk for the `visa` role. Visa build (D2, contract
    // 11.2): the branch Manager also gets the list, read-only (the database decides every row).
    canSeeVisaDesk: staff.memberships.some((m) => m.roleCode === 'visa' || m.roleCode === 'manager'),
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
 * Accounts phase (contract 4.3, 11.8) menu links, kept apart from shellPermissions so the earlier flag
 * set stays as it was: Accounts of the entity (A); a branch Manager who holds no Purchase, Flight or Visa
 * role in that company (M, view only, AL7); Sales for their own Deals' dues. Links only:
 * accounts_records / accounts_dues decide every row and return null otherwise.
 */
export function accountsDeskLinks(staff: Pick<StaffContext, 'memberships' | 'access'>, financeEntities: string[]): Pick<ShellViewer, 'canSeeAccountsDesk' | 'canSeeBranchMoney' | 'canSeeOwnDues'> {
  const a = canUseAccounts(staff.access, financeEntities);
  const inEntity = (entity: string, codes: string[]) => staff.memberships.some((m) => m.legalEntityId === entity && codes.includes(m.roleCode));
  const manager = staff.memberships.some((m) => m.roleCode === 'manager' && financeEntities.includes(m.legalEntityId) && !inEntity(m.legalEntityId, ['purchase', 'flight', 'visa']));
  const sales = staff.memberships.some((m) => m.roleCode === 'sales' && financeEntities.includes(m.legalEntityId) && !inEntity(m.legalEntityId, ['purchase', 'flight', 'visa']));
  return { canSeeAccountsDesk: a, canSeeBranchMoney: !a && manager, canSeeOwnDues: !a && !manager && sales };
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

/**
 * UX redesign R1 (build plan 2.4 N3): the menu counts, from the reads Home
 * already makes (my_work_counts, supplier_money_home_counts,
 * flight_home_counts) under the person's own session; no new read. Only the
 * reads this person's roles need are made. Each read fails on its own to
 * "count not known"; nothing is logged or rethrown, so the menu always
 * renders. The frame does not wait for this: the promise streams to the
 * menu (StaffShell passes it through), so the page shows at once.
 */
export async function loadMenuCounts(staff: StaffContext, financeEntities: string[]): Promise<MenuCounts> {
  const work = homeWorkRoles(staff, financeEntities);
  const roles: MenuCountRoles = {
    bookings: work.bookings,
    purchase: work.purchase,
    flight: work.flight,
    visa: work.visa,
    accounts: work.accounts,
    branchManager: work.branchManager,
    quotations: canSeeQuotations(staff.access),
  };
  const reads = menuCountReads(roles);
  const settle = async <T>(wanted: boolean, read: () => Promise<T | null>): Promise<T | 'failed' | undefined> => {
    if (!wanted) return undefined;
    try {
      return (await read()) ?? 'failed';
    } catch {
      return 'failed';
    }
  };
  const [myWork, supplierMoney, flight] = await Promise.all([
    settle(reads.myWork, () => loadMyWorkCounts(staff)),
    settle(reads.supplierMoney, () => loadSupplierMoneyHomeCounts(staff)),
    settle(reads.flight, () => loadFlightHomeCounts(staff)),
  ]);
  return menuCountsFrom({ myWork, supplierMoney, flight }, roles);
}
