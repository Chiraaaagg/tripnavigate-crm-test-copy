import { ChevronRight, ChevronsUpDown, LogOut } from 'lucide-react';
import type { ReactNode } from 'react';
import { type MenuCounts, sectionsFor } from '@/app/app/sections';
import { AccountAccessLink, AccountsSectionStrip, NavLinks } from '@/components/NavLinks';
import { PushSignOutForm } from '@/components/PushSignOutForm';
import { buttonVariants } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { MobileNav } from '@/components/ui/mobile-nav';
import { type DealSearchAction, type LeadSearchAction, QuickSearchBox, QuickSearchButton, QuickSearchRoot } from '@/components/ui/quick-search';
import { Wordmark } from '@/components/ui/sidebar-nav';
import { signOutAction, signOutEverywhereAction } from '@/modules/identity/server/actions';
import { NoticeBell } from './notices/bell';
import { NoticesProvider } from './notices/provider';
import type { NoticesConfig } from './notices/types';
import { UserMenuDismiss } from './user-menu-dismiss';

/** One role the person holds, for the account panel (their own memberships only). */
export interface ShellMembership {
  roleName: string;
  branchName: string;
  isHeadOffice: boolean;
  /** The company (legal entity) of this membership. Optional so older callers fall back to the company name. */
  companyName?: string;
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
  /** Purchase build: holds the Purchase role somewhere: own supplier payment requests. Optional; defaults to hidden. */
  canSeePurchasePayments?: boolean;
  /** Purchase build: holds the Manager role somewhere: the branch Manager's Approvals page. Optional; defaults to hidden. */
  canSeeApprovals?: boolean;
  /** B1: holds the Flight role somewhere: Flight task queue. Optional; defaults to hidden. */
  canSeeFlightTasks?: boolean;
  /** Holds the Visa & Passport desk role (`visa`) or is a branch Manager (Visa build D2: read-only list). */
  canSeeVisaDesk?: boolean;
  /** Accounts phase (contract 11.8): Accounts › Documents and money, Dues, Tally. Optional; defaults to hidden. */
  canSeeAccountsDesk?: boolean;
  /** Branch Manager without Purchase, Flight or Visa (AL7): Documents and money and Dues, view only. */
  canSeeBranchMoney?: boolean;
  /** Sales: Dues of their own Deals. */
  canSeeOwnDues?: boolean;
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

/** The company name when none is given (single-company pilot). */
const DEFAULT_COMPANY = 'Holiday Chacha Pvt LTD';

/** The person's companies, each once, in membership order. */
function companiesOf(viewer: ShellViewer): string[] {
  const names = membershipsOf(viewer)
    .map((m) => m.companyName)
    .filter((n): n is string => !!n);
  return names.length > 0 ? [...new Set(names)] : [DEFAULT_COMPANY];
}

/**
 * The line under the wordmark (N6): the branch for someone who works in one
 * branch; for someone in several branches the company name (or "All
 * companies" across several), never just the first branch.
 */
export function frameScopeLine(viewer: ShellViewer): string {
  const branches = [...new Set(membershipsOf(viewer).map((m) => m.branchName).filter(Boolean))];
  if (branches.length === 1) return `${branches[0]} branch`;
  if (branches.length === 0) return viewer.primaryBranch ? `${viewer.primaryBranch} branch` : DEFAULT_COMPANY;
  const companies = companiesOf(viewer);
  return companies.length === 1 ? companies[0]! : 'All companies';
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
        <p className="m-0 text-sm text-quiet">{companiesOf(viewer).join(', ')}</p>
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
        <PushSignOutForm action={signOutAction} className="m-0">
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
        </PushSignOutForm>
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
            <PushSignOutForm action={signOutEverywhereAction} className="m-0">
              <button type="submit" className={cn(buttonVariants({ variant: 'danger' }), 'w-full')} aria-describedby={helpId}>
                Sign out everywhere
              </button>
            </PushSignOutForm>
          </div>
        </details>
      </div>
    </div>
  );
}

/**
 * Staff app frame (Direction A; UX redesign R1, C1 and C9): on desktop a calm
 * left sidebar with the brand and the bell in one header row, the find box,
 * the grouped, foldable menu (sections.ts), Settings pinned under the
 * scrolling list, and the account panel in the footer. Under 1024px a top
 * bar with a visible "Menu" button (the same groups and account items in a
 * slide-in sheet), the search button and the bell. Page content renders
 * unchanged inside <main>; on an Accounts list page the section tab strip
 * comes first (D5).
 * Structure adapted from the shadcn Sidebar (21st.dev id 1627, MIT): header /
 * content / footer column, group labels and menu buttons, collapsible groups
 * (shadcn Collapsible 847 on Radix). Departures: no rail collapse, no cookie,
 * no tooltip, no inline style (CSP nonce policy), fixed width class instead
 * of a CSS variable, links instead of buttons, fold state in localStorage.
 */
export function StaffShell({
  viewer,
  children,
  currentPath,
  signOutOptionsOpen,
  notices,
  counts,
  search,
}: {
  viewer: ShellViewer;
  children: ReactNode;
  currentPath?: string;
  /** Preview gallery only: render the account panel and the sign-out options expanded. */
  signOutOptionsOpen?: boolean;
  /** Accounts phase (contract 9.4, 11.5): the notification bell on every page; null or absent = no bell. */
  notices?: NoticesConfig | null;
  /**
   * R1 (N3): menu counts per address, or the promise the layout streams in
   * (loadMenuCounts). Absent = no badges.
   */
  counts?: MenuCounts | Promise<MenuCounts>;
  /**
   * R1 (C9): the existing search actions for the quick search dialog; the
   * Leads one only for people who may open Leads. Absent = no find box.
   */
  search?: { deals: DealSearchAction; leads?: LeadSearchAction; defaultOpen?: boolean; defaultQuery?: string };
}) {
  const links = sectionsFor(viewer);
  const scopeLine = frameScopeLine(viewer);
  const sectionViewer = {
    canUseAccounts: viewer.canUseAccounts,
    canCheckCustomers: viewer.canCheckCustomers,
    canSeeAccountsDesk: viewer.canSeeAccountsDesk,
    canSeeBranchMoney: viewer.canSeeBranchMoney,
    canSeeOwnDues: viewer.canSeeOwnDues,
  };
  return (
    <NoticesProvider config={notices ?? null}>
    <QuickSearchRoot searchDeals={search?.deals} searchLeads={search?.leads} defaultOpen={search?.defaultOpen} defaultQuery={search?.defaultQuery}>
    <div className="staff-shell flex min-h-dvh bg-canvas">
      {/* The column carries the white background and border for the full page height; the menu inside stays in view while scrolling. */}
      <div className="hidden w-64 shrink-0 border-r border-line bg-card lg:block print:hidden">
        <div className="sticky top-0 flex h-dvh flex-col font-sans">
          <div className="flex shrink-0 items-center gap-2.5 px-4 pt-4 pb-2.5" data-slot="sidebar-header">
            <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-control bg-brand-strong text-sm font-bold text-white">
              TN
            </span>
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <Wordmark className="text-lg" />
              <span className="truncate text-xs text-quiet">{scopeLine}</span>
            </span>
            <NoticeBell id="notice-bell-sidebar" placement="sidebar" />
          </div>
          {search ? (
            <div className="shrink-0 px-2 pb-2">
              <QuickSearchBox />
            </div>
          ) : null}
          <NavLinks links={links} counts={counts} currentPath={currentPath} />
          <div className="relative shrink-0 border-t border-line p-2">
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
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-card px-3 font-sans sm:px-5 lg:hidden print:hidden">
          <MobileNav>
            <NavLinks links={links} counts={counts} currentPath={currentPath} layout="sheet" />
            <section aria-label="Your account" className="border-t border-line pt-3">
              <AccountPanel viewer={viewer} idPrefix="sheet" currentPath={currentPath} signOutOptionsOpen={signOutOptionsOpen} />
            </section>
          </MobileNav>
          <Wordmark className="text-lg" />
          <span className="ml-auto flex items-center gap-1">
            {search ? <QuickSearchButton /> : null}
            <NoticeBell id="notice-bell-top" placement="top" />
          </span>
        </header>
        <main id="main" className="w-full min-w-0 max-w-[72rem] p-8 max-md:p-5 print:max-w-none print:p-0" tabIndex={-1}>
          <AccountsSectionStrip viewer={sectionViewer} counts={counts} currentPath={currentPath} />
          {children}
        </main>
      </div>
      <UserMenuDismiss menuId={USER_MENU_ID} />
    </div>
    </QuickSearchRoot>
    </NoticesProvider>
  );
}
