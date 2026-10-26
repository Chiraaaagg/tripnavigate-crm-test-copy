import { ChevronRight, ChevronsUpDown, LogOut } from 'lucide-react';
import type { ReactNode } from 'react';
import { AccountAccessLink, NavLinks, type NavItem } from '@/components/NavLinks';
import { buttonVariants } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { MobileNav } from '@/components/ui/mobile-nav';
import { Wordmark } from '@/components/ui/sidebar-nav';
import { signOutAction, signOutEverywhereAction } from '@/modules/identity/server/actions';
import { SETTINGS_PREFIX, settingsTabsFor } from '@/modules/settings/contracts';
import { UserMenuDismiss } from './user-menu-dismiss';

/** One role the person holds, for the account panel (their own memberships only). */
export interface ShellMembership {
  roleName: string;
  branchName: string;
  isHeadOffice: boolean;
}

export interface ShellViewer {
  displayName: string;
  primaryRole: string;
  primaryBranch: string;
  /**
   * Every active role and branch the person holds (account panel, FP-004).
   * Optional so older callers fall back to the primary role and branch.
   */
  memberships?: ShellMembership[];
  canAdministerStaff: boolean;
  canManageGrants: boolean;
  /** integration.manage in at least one entity. Optional so older callers default to hidden. */
  canManageIntegration?: boolean;
  /**
   * Batch 4: the Settings · Bitrix connection tab: integration.manage and no Purchase role
   * anywhere (the page's own gate, admin/integration/page.tsx). Optional; defaults to hidden.
   */
  canOpenBitrixConnection?: boolean;
  /** Holds the Purchase role somewhere (Purchase task queue). Optional so older callers default to hidden. */
  canSeePurchaseTasks?: boolean;
  /**
   * Bitrix Leads link (lead-screens contract §2): active Sales or Manager membership, or
   * integration.manage, in an entity where the viewer does not hold Purchase; hidden for anyone
   * holding Purchase in any entity (the page refuses them). Convenience only; crm_leads RLS is
   * the control. Optional so older callers default to hidden.
   */
  canSeeLeads?: boolean;
  /**
   * Batch 3 (FP-001): Quotations and Itineraries items (and the Home quotation rows): Sales or
   * Manager in an entity without Purchase, and no Purchase anywhere (policy.ts canSeeQuotations).
   * Convenience only; the quotation and itinerary reads decide every row. Optional so older
   * callers default to hidden.
   */
  canSeeQuotations?: boolean;
  /**
   * Accounts group (phase-5a-contract.md §15): canUseAccounts in at least one finance-enabled entity.
   * Convenience only; authz.can_accounts decides every read. Optional so older callers default to hidden.
   */
  canUseAccounts?: boolean;
  /** Money rules link under Settings: canManageFinancePolicy. Optional; defaults to hidden. */
  canManageFinancePolicy?: boolean;
  /** Voice-note batch: Settings · Imports tab (Super Admin: hotels; Accounts: customers). Optional; defaults to hidden. */
  canImport?: boolean;
  /** Voice-note batch: Accounts · Customers to check (Accounts role, not tied to the finance switch). Optional; defaults to hidden. */
  canCheckCustomers?: boolean;
  /** B1: holds the Flight role somewhere: Flight task queue. Optional; defaults to hidden. */
  canSeeFlightTasks?: boolean;
  /** B1.1: holds the Visa & Passport desk role (`visa`) somewhere. Managers follow visa work on the Deal page (freeze §3.4). */
  canSeeVisaDesk?: boolean;
}

/**
 * The person's menu, grouped as Direction A (copy-catalogue §16.1, DA-01 to
 * DA-07): Work, then Accounts, then Settings. The same permission rules as
 * before (shell-permissions.ts) decide each item; a person with several roles
 * gets the union, never a duplicate. "My access" is not in the menu (plan T5):
 * it sits in the account panel and /app/access still opens. Quotations and
 * Itineraries (Batch 3, FP-001/040/051) follow Deals for quotation editors
 * only (canSeeQuotations: Sales or Manager, no Purchase anywhere).
 * Navigation convenience only: every page, command and database policy still
 * decides access on its own.
 */
export function navItemsFor(viewer: ShellViewer): NavItem[] {
  const items: NavItem[] = [{ href: '/app', label: 'Home', group: 'Work' }];
  if (viewer.canSeeLeads) items.push({ href: '/app/leads', label: 'Leads', group: 'Work' });
  items.push({ href: '/app/deals', label: 'Deals', group: 'Work' });
  if (viewer.canSeeQuotations) {
    items.push({ href: '/app/quotations', label: 'Quotations', group: 'Work' }, { href: '/app/itineraries', label: 'Itineraries', group: 'Work' });
  }
  if (viewer.canSeePurchaseTasks) {
    items.push({ href: '/app/purchase', label: 'Purchase tasks', group: 'Work' }, { href: '/app/purchase/suppliers', label: 'Suppliers', group: 'Work' });
  }
  if (viewer.canSeeFlightTasks) items.push({ href: '/app/flight', label: 'Flight tasks', group: 'Work' });
  if (viewer.canSeeVisaDesk) items.push({ href: '/app/visa', label: 'Visa and passport tasks', group: 'Work' });
  if (viewer.canUseAccounts) {
    // Branch cash and Company accounts open for anyone holding the Accounts role (the pages'
    // own first check); canUseAccounts already requires that role, so no extra read is needed.
    items.push(
      { href: '/app/accounts', label: 'To check', group: 'Accounts' },
      // Voice-note batch (owner item 10): stored customers that Accounts checks (same rule as the page).
      ...(viewer.canCheckCustomers ? [{ href: '/app/accounts/customers', label: 'Customers to check', group: 'Accounts' as const }] : []),
      { href: '/app/accounts/claims', label: 'Reported payments', group: 'Accounts' },
      { href: '/app/accounts/expenses', label: 'Department costs', group: 'Accounts' },
      { href: '/app/accounts/cash', label: 'Branch cash', group: 'Accounts' },
      { href: '/app/accounts/destinations', label: 'Company accounts', group: 'Accounts' },
    );
  } else if (viewer.canCheckCustomers) {
    // Finance switched off: customer checks do not depend on it (Echo-B N2).
    items.push({ href: '/app/accounts/customers', label: 'Customers to check', group: 'Accounts' });
  }
  // Batch 4 (DA-250): one "Settings" item for anyone who can open at least one Settings tab.
  // Its address is the person's first tab; it stays current on every /app/admin/* page.
  const settingsTabs = settingsTabsFor({
    canAdministerStaff: viewer.canAdministerStaff,
    canManageGrants: viewer.canManageGrants,
    canManageIntegration: !!viewer.canManageIntegration,
    canOpenBitrixConnection: !!viewer.canOpenBitrixConnection,
    canManageFinancePolicy: !!viewer.canManageFinancePolicy,
    canImport: !!viewer.canImport,
  });
  if (settingsTabs.length > 0) items.push({ href: settingsTabs[0]!.href, label: 'Settings', group: 'Settings', activePrefix: SETTINGS_PREFIX });
  return items;
}

/** Two-letter initials for the avatar (decorative; the name is always given in text). */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

function membershipsOf(viewer: ShellViewer): ShellMembership[] {
  if (viewer.memberships && viewer.memberships.length > 0) return viewer.memberships;
  return viewer.primaryRole ? [{ roleName: viewer.primaryRole, branchName: viewer.primaryBranch, isHeadOffice: false }] : [];
}

const USER_MENU_ID = 'account-menu';

/**
 * Account panel content (Direction A SH-03, catalog gap G9: the arrangement is
 * a composition): name, every role and branch, My access, Sign out, and
 * "Sign out everywhere" behind a second step (copy G-16). Same server actions
 * as before. Used in the sidebar footer (desktop) and the phone Menu sheet;
 * `idPrefix` keeps element ids unique when both copies are in the page.
 */
function AccountPanel({
  viewer,
  idPrefix,
  currentPath,
  signOutOptionsOpen,
}: {
  viewer: ShellViewer;
  idPrefix: string;
  currentPath?: string;
  signOutOptionsOpen?: boolean;
}) {
  const memberships = membershipsOf(viewer);
  const helpId = `${idPrefix}-signout-everywhere-help`;
  const rolesId = `${idPrefix}-roles`;
  return (
    <div className="flex flex-col gap-3 font-sans text-base text-copy">
      <div className="px-2.5">
        <p className="m-0 font-semibold text-ink">{viewer.displayName}</p>
        <p className="m-0 text-sm text-quiet">Holiday Chacha Pvt LTD</p>
      </div>
      {memberships.length > 0 ? (
        <div className="px-2.5">
          <p id={rolesId} className="m-0 text-xs font-semibold text-quiet">
            Your roles
          </p>
          <ul aria-labelledby={rolesId} className="m-0 mt-0.5 flex list-none flex-col gap-0.5 p-0">
            {memberships.map((m, index) => (
              // The same role and branch can exist in two companies: the position keeps keys unique.
              <li key={`${index}-${m.roleName}-${m.branchName}`} className="m-0 text-sm text-copy">
                {m.roleName} · {m.branchName}
                {m.isHeadOffice ? ' (head office)' : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-col gap-1 border-t border-line pt-2">
        <AccountAccessLink currentPath={currentPath} />
        <form action={signOutAction} className="m-0">
          <button
            type="submit"
            className={cn(
              'flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-control border-0 bg-transparent px-2.5 py-1.5 text-left font-sans text-base font-medium text-copy hover:bg-wash hover:text-ink',
              focusRing,
              'focus-visible:outline-offset-0',
            )}
          >
            <LogOut aria-hidden="true" className="size-4 shrink-0 text-quiet" />
            Sign out<span className="sr-only"> of this device</span>
          </button>
        </form>
        <details className="group/more m-0" open={signOutOptionsOpen}>
          <summary
            className={cn(
              'flex min-h-9 cursor-pointer list-none items-center gap-2.5 rounded-control px-2.5 text-sm font-medium text-quiet hover:bg-wash hover:text-ink [&::-webkit-details-marker]:hidden',
              focusRing,
              'focus-visible:outline-offset-0',
            )}
          >
            <ChevronRight
              aria-hidden="true"
              className="size-4 shrink-0 transition-transform duration-(--ui-duration-quick) group-open/more:rotate-90 motion-reduce:transition-none"
            />
            More sign-out options
          </summary>
          <div className="mt-1.5 rounded-control border border-status-danger-line bg-status-danger-tint p-3">
            <p id={helpId} className="m-0 mb-3 text-sm text-copy">
              Signs you out on this and every other device. You will need your password and authenticator app to sign in again.
            </p>
            <form action={signOutEverywhereAction} className="m-0">
              <button type="submit" className={cn(buttonVariants({ variant: 'danger' }), 'w-full')} aria-describedby={helpId}>
                Sign out everywhere
              </button>
            </form>
          </div>
        </details>
      </div>
    </div>
  );
}

/**
 * Staff app frame (Direction A, R0): a calm left sidebar on desktop (brand,
 * grouped menu, account panel in the footer) and, under 1024px, a top bar with
 * a visible "Menu" button that opens the same groups and account items in a
 * slide-in sheet. Page content renders unchanged inside <main>.
 * Structure adapted from the shadcn Sidebar (21st.dev id 1627, MIT): header /
 * content / footer column, group labels and menu buttons. Departures: no
 * collapse, no cookie, no tooltip, no inline style (CSP nonce policy), fixed
 * width class instead of a CSS variable, links instead of buttons.
 */
export function StaffShell({
  viewer,
  children,
  currentPath,
  signOutOptionsOpen,
}: {
  viewer: ShellViewer;
  children: ReactNode;
  currentPath?: string;
  /** Preview gallery only: render the account panel and the sign-out options expanded. */
  signOutOptionsOpen?: boolean;
}) {
  const items = navItemsFor(viewer);
  const branchLine = viewer.primaryBranch ? `${viewer.primaryBranch} branch` : 'Holiday Chacha Pvt LTD';
  return (
    <div className="staff-shell flex min-h-dvh bg-canvas">
      {/* The column carries the white background and border for the full page height; the menu inside stays in view while scrolling. */}
      <div className="hidden w-64 shrink-0 border-r border-line bg-card lg:block">
        <div className="sticky top-0 flex h-dvh flex-col font-sans">
          <div className="flex items-center gap-2.5 px-4.5 pt-4.5 pb-3">
            <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-control bg-brand-strong text-sm font-bold text-white">
              TN
            </span>
            <span className="flex min-w-0 flex-col leading-tight">
              <Wordmark className="text-lg" />
              <span className="truncate text-xs text-quiet">{branchLine}</span>
            </span>
          </div>
          <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            <NavLinks items={items} currentPath={currentPath} />
          </nav>
          <div className="relative border-t border-line p-2">
            <details id={USER_MENU_ID} className="group m-0" open={signOutOptionsOpen}>
              <summary
                className={cn(
                  'flex min-h-12 min-w-0 cursor-pointer list-none items-center gap-2.5 rounded-control px-2 py-1.5 select-none hover:bg-wash group-open:bg-wash [&::-webkit-details-marker]:hidden',
                  focusRing,
                  'focus-visible:outline-offset-0',
                )}
              >
                <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-tint-2 text-xs font-semibold text-brand-deep">
                  {initialsOf(viewer.displayName)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
                  <span className="truncate text-sm font-semibold text-ink">{viewer.displayName}</span>
                  <span className="truncate text-xs text-quiet">
                    {viewer.primaryRole} · {viewer.primaryBranch}
                  </span>
                </span>
                <span className="sr-only">: account menu</span>
                <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-quiet" />
              </summary>
              <div className="absolute right-2 bottom-full left-2 z-30 mb-1.5 max-h-[calc(100dvh-6rem)] overflow-y-auto overscroll-contain rounded-card border border-line bg-card p-2 pt-3 shadow-raised">
                <AccountPanel viewer={viewer} idPrefix="sidebar" currentPath={currentPath} signOutOptionsOpen={signOutOptionsOpen} />
              </div>
            </details>
          </div>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-card px-3 font-sans sm:px-5 lg:hidden">
          <MobileNav>
            <nav aria-label="Main">
              <NavLinks items={items} currentPath={currentPath} />
            </nav>
            <section aria-label="Your account" className="border-t border-line pt-3">
              <AccountPanel viewer={viewer} idPrefix="sheet" currentPath={currentPath} signOutOptionsOpen={signOutOptionsOpen} />
            </section>
          </MobileNav>
          <Wordmark className="text-lg" />
        </header>
        <main id="main" className="w-full min-w-0 max-w-[72rem] p-8 max-md:p-5" tabIndex={-1}>
          {children}
        </main>
      </div>
      <UserMenuDismiss menuId={USER_MENU_ID} />
    </div>
  );
}
