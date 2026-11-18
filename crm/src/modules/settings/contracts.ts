import type { BitrixSwitchKey, LastChange, SettingsSwitchStates, SwitchState, VisaTaskPreview } from '@/modules/access/settings-state';
import type { WorkflowSettingKey } from '@/modules/fulfilment/contracts';
import type { TaskHistory, TaskHistoryKind } from '@/modules/fulfilment/task-history';
import type { ReceiptMode } from '@/modules/finance/contracts';
import type { SyncPreviewStaleReason, SyncSettingsApplyResult, SyncSettingsErrorCode as SyncCommandErrorCode, SyncSettingsInput, SyncSettingsPreview } from '@/modules/integration/sync-settings-preview';

/*
 * Batch 4 Step 0 (frozen contract, 23 October 2026). Settings area
 * (Direction A R6; copy-catalogue DA-17; money-privacy-settings §6),
 * department task tabs (DA-16) and Accounts deal page tabs (DA-15, plan T1).
 *
 * Database records are Atlas's parsed types (atlas-batch4-shapes.md v1,
 * migration 20261125000100; wrappers src/modules/access/settings-state.ts,
 * src/modules/integration/sync-settings-preview.ts,
 * src/modules/fulfilment/task-history.ts), re-exported here under one name
 * each so the view models and Terra's loaders have a single import. View
 * models are what the pages pass to the views.
 * Everything here is types, constants and pure functions; nothing reads or
 * writes. Navigation and tabs are convenience only: every page, command and
 * database policy still decides access on its own.
 */

// ---------------------------------------------------------------------------
// Settings areas (R1, design plan 1.4; build plan 4.4). One list feeds the
// single "Settings" menu item (its href is the first area), the area list on
// the left of every Settings page (a select on phones), the area heading and
// the Overview landing. Every area is a link to today's /app/admin/* address
// (lead decision L1, kept); Overview is the one new address (/app/admin).
// Convenience only: every page, command and database policy still decides
// access on its own.
// ---------------------------------------------------------------------------

export type SettingsCategory = 'overview' | 'people' | 'company' | 'money' | 'accounts' | 'bitrix' | 'features' | 'messages' | 'imports' | 'health';

/** Area order (design plan 1.4 table). */
export const SETTINGS_CATEGORIES = ['overview', 'people', 'company', 'money', 'accounts', 'bitrix', 'features', 'messages', 'imports', 'health'] as const satisfies readonly SettingsCategory[];

/** One name per area, used in the list, the heading and the page title (audit S1). */
export const SETTINGS_CATEGORY_LABEL: Record<SettingsCategory, string> = {
  overview: 'Overview',
  people: 'People and access',
  company: 'Company and branches',
  money: 'Money rules',
  // Accounts phase (contract 11.8): customer documents and refunds switches, Tally export, Tally exception owner.
  accounts: 'Accounts',
  bitrix: 'Bitrix connection',
  features: 'Features',
  // D12: its own area (it sat under Features before R1).
  messages: 'Customer messages',
  imports: 'Imports',
  health: 'System health',
};

/** The one muted line under each area heading (audit S2: one heading and one line). */
export const SETTINGS_AREA_LINE: Record<SettingsCategory, string> = {
  overview: 'Changes here affect every branch. Live changes need the owner’s APPROVE first. Every change is recorded with the person and the time.',
  people: 'Staff accounts, sign-in recovery, their roles and branches, and extra access to deals.',
  company: 'Company details printed on quotations and itineraries, and the branches.',
  money: 'Receipt and cash limits, and which payment modes Accounts can record.',
  accounts: 'Customer documents and refunds switches, the Tally export, Tally ledger mapping and who owns Tally exceptions.',
  bitrix: 'How the CRM reads from Bitrix: status, which deals and leads come in, and the Bitrix switches.',
  features: 'Switch CRM features on or off for every branch.',
  messages: 'The nine booking messages customers get by e-mail and WhatsApp. Every message is in English.',
  imports: 'Hotels, customers and suppliers from a CSV file: check first, then import.',
  health: 'Bookings, PDFs, e-mail alerts and Bitrix updates at a glance. Read only.',
};

/** Addresses (L1). Overview is new in R1; every other address is unchanged. */
export const SETTINGS_PATH = {
  overview: '/app/admin',
  staff: '/app/admin/staff',
  access: '/app/admin/access',
  company: '/app/admin/company',
  money: '/app/admin/finance-policy',
  accounts: '/app/admin/accounts',
  bitrix: '/app/admin/integration',
  imports: '/app/admin/imports',
  features: '/app/admin/workflow',
  messages: '/app/admin/customer-messages',
  health: '/app/admin/bookings',
} as const;

/** Read-only "Roles and branches" list (D8 deferred: no way to give a role yet). A view of the Staff page. */
export const SETTINGS_ROLES_PATH = `${SETTINGS_PATH.staff}?tab=roles`;

/** Accounts Phase 3 (contract 15): customer message switches, pilot list, templates and the timer. Its own area since R1 (D12). */
export const SETTINGS_CUSTOMER_MESSAGES_PATH = SETTINGS_PATH.messages;

/** Every Settings address starts with this; the "Settings" menu item is current on all of them. */
export const SETTINGS_PREFIX = '/app/admin';

/** The shell flags that decide which areas a person sees (a subset of ShellViewer; same rules as shell-permissions.ts). */
export interface SettingsViewerFlags {
  canAdministerStaff: boolean;
  canManageGrants: boolean;
  canManageIntegration: boolean;
  /** integration.manage and no Purchase role anywhere (the Bitrix connection page's own gate). */
  canOpenBitrixConnection: boolean;
  canManageFinancePolicy: boolean;
  /**
   * Voice-note batch: Settings · Imports (hotel list for a Super Admin, customer list for
   * Accounts). Optional; defaults to hidden. The page and the database decide each step.
   */
  canImport?: boolean;
  /**
   * R1 (D12): the Customer messages area. Its page answers only a Super Admin. Optional: when
   * not given, the area follows canManageIntegration, as the link on Features did before R1.
   */
  canOpenCustomerMessages?: boolean;
}

export interface SettingsTabVM {
  category: SettingsCategory;
  label: string;
  href: string;
  /** Addresses that mark this area current (exact or as a path prefix). */
  matchPrefixes: string[];
  /** Overview only: current on its exact address, never as a prefix of the other areas. */
  exact?: boolean;
}

/** Overview is offered to anyone holding an admin right (the same people as Company and branches, lead ruling D1). */
function hasAdminRight(v: Partial<SettingsViewerFlags>): boolean {
  return !!(v.canAdministerStaff || v.canManageGrants || v.canManageIntegration || v.canManageFinancePolicy);
}

/**
 * The Settings areas this person may open, in area order. The same list feeds
 * the single "Settings" menu item (its href is the first area: Overview for
 * anyone with an admin right, else their only area) and the area list.
 * Empty = no Settings item and no area list.
 */
export function settingsTabsFor(v: Partial<SettingsViewerFlags>): SettingsTabVM[] {
  const anyAdmin = hasAdminRight(v);
  const tabs: SettingsTabVM[] = [];
  const add = (category: SettingsCategory, href: string, matchPrefixes: string[], exact?: boolean) =>
    tabs.push({ category, label: SETTINGS_CATEGORY_LABEL[category], href, matchPrefixes, ...(exact ? { exact } : {}) });
  if (anyAdmin) add('overview', SETTINGS_PATH.overview, [SETTINGS_PATH.overview], true);
  if (v.canAdministerStaff || v.canManageGrants) {
    const people: string[] = [];
    if (v.canAdministerStaff) people.push(SETTINGS_PATH.staff);
    if (v.canManageGrants) people.push(SETTINGS_PATH.access);
    add('people', people[0]!, people);
  }
  // Lead ruling D1: read-only page for anyone holding an admin right.
  if (anyAdmin) add('company', SETTINGS_PATH.company, [SETTINGS_PATH.company]);
  if (v.canManageFinancePolicy) add('money', SETTINGS_PATH.money, [SETTINGS_PATH.money]);
  // Accounts phase (contract 7.1 T6/T7, 6.3.3): the same people as Money rules (the page and the database decide).
  if (v.canManageFinancePolicy) add('accounts', SETTINGS_PATH.accounts, [SETTINGS_PATH.accounts]);
  if (v.canOpenBitrixConnection) add('bitrix', SETTINGS_PATH.bitrix, [SETTINGS_PATH.bitrix]);
  if (v.canManageIntegration) add('features', SETTINGS_PATH.features, [SETTINGS_PATH.features]);
  if (v.canOpenCustomerMessages ?? v.canManageIntegration) add('messages', SETTINGS_PATH.messages, [SETTINGS_PATH.messages]);
  if (v.canImport) add('imports', SETTINGS_PATH.imports, [SETTINGS_PATH.imports]);
  if (v.canManageIntegration) add('health', SETTINGS_PATH.health, [SETTINGS_PATH.health]);
  return tabs;
}

function pathMatches(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The area that marks the current page, or undefined (longest matching address wins; Overview only on its own address). */
export function currentSettingsTab(tabs: SettingsTabVM[], path: string | null | undefined): SettingsCategory | undefined {
  if (!path) return undefined;
  const bare = path.split(/[?#]/)[0]!;
  let best: { category: SettingsCategory; length: number } | undefined;
  for (const tab of tabs) {
    for (const prefix of tab.matchPrefixes) {
      const hit = tab.exact ? bare === prefix : pathMatches(prefix, bare);
      if (hit && (!best || prefix.length > best.length)) best = { category: tab.category, length: prefix.length };
    }
  }
  return best?.category;
}

/**
 * The address a "Settings area" choice may go to: one of this person's areas,
 * else null (the Overview page's no-script area picker posts it as ?area=).
 */
export function settingsAreaTarget(tabs: SettingsTabVM[], raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  return tabs.some((t) => t.href === value) ? value : null;
}

/** The address the "Settings" menu item opens: the first area (Overview when the person may see it). */
export function settingsHomeHref(tabs: SettingsTabVM[]): string | null {
  return tabs[0]?.href ?? null;
}

// ---------------------------------------------------------------------------
// Overview landing (R1, audit N7): one row per area with its state. Each row
// is worked out from a read that already exists and fails on its own to
// "Not known" (build plan 2.4). Pure: the page passes the facts it read.
// ---------------------------------------------------------------------------

/** The state word of a row. 'unknown' = the read failed or could not be parsed: never shown as Off or 0. */
export type OverviewTone = 'ok' | 'attention' | 'info' | 'off' | 'unknown' | 'none';

export interface OverviewStateVM {
  tone: OverviewTone;
  /** The words on the badge ("All set", "4 of 6 on", "Not known"); empty for 'none'. */
  label: string;
}

export interface OverviewRowVM {
  category: SettingsCategory;
  label: string;
  href: string;
  state: OverviewStateVM;
  /** One plain line: what is true now in this area. */
  text: string;
}

/** A fact the page read for one area: the value, 'unknown' (the read failed), or undefined (no read for this area). */
export type OverviewFact<T> = T | 'unknown' | undefined;

export interface OverviewFacts {
  people?: OverviewFact<{ active: number; invited: number }>;
  company?: OverviewFact<{ missingGstin: string[]; notApproved: number }>;
  money?: OverviewFact<{ on: number; total: number }>;
  bitrix?: OverviewFact<{ autoSync: SwitchState }>;
  features?: OverviewFact<{ on: number; total: number; unknown: number }>;
  /** `company`: the company the numbers belong to, named when the person is Super Admin of more than one (R1 review). */
  messages?: OverviewFact<{ on: number; total: number; pilotOnly: boolean; pilotDeals: number; keysMissing: number; company?: string }>;
  health?: OverviewFact<{ realBooking: SwitchState }>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listText = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

export const OVERVIEW_TEXT = {
  unknownState: 'Not known',
  unknownLine: 'Could not be read just now. Open the area to check; this is not the same as Off.',
} as const;

const UNKNOWN_ROW: Pick<OverviewRowVM, 'state' | 'text'> = { state: { tone: 'unknown', label: OVERVIEW_TEXT.unknownState }, text: OVERVIEW_TEXT.unknownLine };

function rowFor(category: SettingsCategory, facts: OverviewFacts): Pick<OverviewRowVM, 'state' | 'text'> {
  const none = (text = SETTINGS_AREA_LINE[category]): Pick<OverviewRowVM, 'state' | 'text'> => ({ state: { tone: 'none', label: '' }, text });
  switch (category) {
    case 'people': {
      const f = facts.people;
      if (f === undefined) return none();
      if (f === 'unknown') return UNKNOWN_ROW;
      const invited = f.invited > 0 ? ` · ${plural(f.invited, 'invitation')} not accepted yet` : '';
      return { state: f.invited > 0 ? { tone: 'attention', label: 'Needs attention' } : { tone: 'ok', label: 'All set' }, text: `${plural(f.active, 'active staff member')}${invited}` };
    }
    case 'company': {
      const f = facts.company;
      if (f === undefined) return none();
      if (f === 'unknown') return UNKNOWN_ROW;
      if (f.missingGstin.length === 0 && f.notApproved === 0) return { state: { tone: 'ok', label: 'All set' }, text: 'Every branch has its GSTIN.' };
      const parts: string[] = [];
      if (f.missingGstin.length > 0) parts.push(`${listText(f.missingGstin)} ${f.missingGstin.length === 1 ? 'has' : 'have'} no GSTIN yet: final PDFs there are blocked.`);
      if (f.notApproved > 0) parts.push(`${plural(f.notApproved, 'branch', 'branches')} not in the approved company details.`);
      return { state: { tone: 'attention', label: 'Needs attention' }, text: parts.join(' ') };
    }
    case 'money': {
      const f = facts.money;
      if (f === undefined) return none();
      if (f === 'unknown') return UNKNOWN_ROW;
      return { state: { tone: 'info', label: `${f.on} of ${f.total} on` }, text: `${f.on} of ${plural(f.total, 'payment mode')} Accounts can record.` };
    }
    case 'bitrix': {
      const f = facts.bitrix;
      if (f === undefined) return none();
      if (f === 'unknown' || f.autoSync === 'unknown') return UNKNOWN_ROW;
      return f.autoSync === 'on'
        ? { state: { tone: 'ok', label: 'Receiving deals' }, text: 'Deals and leads come in from Bitrix automatically.' }
        : { state: { tone: 'off', label: 'Off' }, text: 'Deals do not come in from Bitrix automatically.' };
    }
    case 'features': {
      const f = facts.features;
      if (f === undefined) return none();
      if (f === 'unknown') return UNKNOWN_ROW;
      const unknown = f.unknown > 0 ? ` · ${f.unknown} not known` : '';
      return { state: { tone: 'info', label: `${f.on} of ${f.total} on` }, text: `${plural(f.on, 'feature')} switched on for every branch${unknown}.` };
    }
    case 'messages': {
      const f = facts.messages;
      if (f === undefined) return none();
      if (f === 'unknown') return UNKNOWN_ROW;
      const pilot = f.pilotOnly ? `pilot list on (${plural(f.pilotDeals, 'Deal')})` : 'every Deal';
      const keys = f.keysMissing > 0 ? ` · ${plural(f.keysMissing, 'sending key')} not saved yet` : '';
      return { state: f.keysMissing > 0 ? { tone: 'attention', label: 'Set-up not finished' } : { tone: 'info', label: `${f.on} of ${f.total} on` }, text: `${f.company ? `${f.company}: ` : ''}${f.on} of ${f.total} on · ${pilot}${keys}` };
    }
    case 'health': {
      const f = facts.health;
      if (f === undefined) return none();
      if (f === 'unknown' || f.realBooking === 'unknown') return UNKNOWN_ROW;
      return f.realBooking === 'on'
        ? { state: { tone: 'ok', label: 'Real bookings on' }, text: 'Bookings go to suppliers for real.' }
        : { state: { tone: 'off', label: 'Real bookings off' }, text: 'Bookings are recorded but not sent to suppliers for real.' };
    }
    default:
      return none();
  }
}

/** One row per area this person may open (not Overview itself), in area order. */
export function settingsOverviewRows(tabs: SettingsTabVM[], facts: OverviewFacts): OverviewRowVM[] {
  return tabs
    .filter((t) => t.category !== 'overview')
    .map((t) => ({ category: t.category, label: t.label, href: t.href, ...rowFor(t.category, facts) }));
}

/** The browser key of the last Settings area opened (a per-viewer convenience; a missing value is fine). */
export const SETTINGS_LAST_AREA_KEY = 'tn.settings.lastArea';

// ---------------------------------------------------------------------------
// People and access (R1, audit S9 to S11): the Staff list as a queue, the
// sub-sections, and plain words for a stored failure code. Pure; the page
// filters rows it already loaded (the list is not paged on the server).
// ---------------------------------------------------------------------------

/** Shown when no identity-verification method is approved (recovery cannot finish). */
export const STAFF_NO_METHOD_TEXT =
  'No identity-verification method has been approved yet; recovery cannot be completed in this environment.';

export type PeopleSection = 'staff' | 'access' | 'roles';
/** Staff page views: the list (default) or the read-only Roles and branches list. `?tab=` values. */
export const STAFF_PAGE_TABS = ['staff', 'roles'] as const satisfies readonly PeopleSection[];

export type StaffStatusFilter = 'all' | 'invited' | 'active' | 'inactive';
export const STAFF_STATUS_FILTERS = ['all', 'invited', 'active', 'inactive'] as const satisfies readonly StaffStatusFilter[];
export const STAFF_STATUS_FILTER_LABEL: Record<StaffStatusFilter, string> = { all: 'All', invited: 'Invited', active: 'Active', inactive: 'Deactivated' };

interface StaffQueueRow {
  displayName: string;
  email: string;
  status: 'invited' | 'active' | 'inactive';
}

/** The rows shown for a search (name or e-mail, any case) and a status chip, with the count behind each chip. */
export function staffQueue<T extends StaffQueueRow>(rows: T[], filter: { q?: string; status?: StaffStatusFilter }): { rows: T[]; counts: Record<StaffStatusFilter, number> } {
  const q = (filter.q ?? '').trim().toLowerCase();
  const found = q ? rows.filter((r) => r.displayName.toLowerCase().includes(q) || r.email.toLowerCase().includes(q)) : rows;
  const counts: Record<StaffStatusFilter, number> = { all: found.length, invited: 0, active: 0, inactive: 0 };
  for (const r of found) counts[r.status] += 1;
  const status = filter.status ?? 'all';
  return { rows: status === 'all' ? found : found.filter((r) => r.status === status), counts };
}

/**
 * Plain words for a failure code the CRM stored (e-mail delivery, authenticator
 * removal). The code itself stays available behind "Details" for the CRM team
 * (audit S10); it is never the only thing a Super Admin reads.
 */
export function staffFailureWords(code: string | null | undefined, service: 'mail' | 'sign-in'): string {
  const c = (code ?? '').toLowerCase();
  const who = service === 'mail' ? 'The mail service' : 'The sign-in service';
  if (!c) return `${who} gave no reason.`;
  if (c === 'recipient_unavailable') return 'The CRM could not read this person’s work e-mail address.';
  if (c === 'recipient_not_allowed') return 'This CRM is not allowed to e-mail that address.';
  if (c === 'provider_outcome_unknown') return `${who} did not answer, so it is not known whether it worked.`;
  if (c === 'invalid_deletion_plan' || c.startsWith('plan_lookup')) return 'The list of authenticators to remove did not match this recovery.';
  if (c.includes('rate_limit') || c.endsWith(':429')) return `${who} refused because too many requests came in a short time. Wait a few minutes, then retry.`;
  if (/:5\d\d$/.test(c) || c.includes('unavailable') || c.includes('timeout')) return `${who} was not available. Retry in a few minutes.`;
  if (c.includes('smtp') || c.includes('reject')) return `${who} refused the message.`;
  return `${who} refused the request.`;
}

// ---------------------------------------------------------------------------
// Switch states and "last changed" (Atlas settings_switch_states, §1–§2)
// ---------------------------------------------------------------------------

/** 'unknown' = not read, row missing or ambiguous. Never shown as Off, and never offers a change form. (Atlas type.) */
export type { SwitchState, BitrixSwitchKey };

export function toSwitchState(value: unknown): SwitchState {
  return value === 'on' || value === 'off' ? value : 'unknown';
}

/** Atlas §1 LastChange, one recorded change (the wire null = nothing recorded is kept apart, see toLastChangeVM). */
export type LastChangeRecord = NonNullable<LastChange>;

/** What a row says about its last change. 'unknown' (read failed or not readable) is never shown as 'none'. */
export type LastChangeVM =
  | { kind: 'person'; at: string; byName: string; byYou: boolean; reason: string | null }
  /** DA-140: "Last changed on {date} by a system update (no person recorded)". */
  | { kind: 'system'; at: string; reason: string | null }
  | { kind: 'none' }
  | { kind: 'unknown' };

/**
 * Record -> view model. `undefined` (the section or key was not in the reply,
 * the section was unreadable, or the read failed) is Unknown; `null` (read
 * fine, nothing recorded since the audit trigger existed) is None.
 */
export function toLastChangeVM(record: LastChange | undefined): LastChangeVM {
  if (record === undefined) return { kind: 'unknown' };
  if (record === null) return { kind: 'none' };
  if (record.byName === null) return { kind: 'system', at: record.at, reason: record.reason };
  return { kind: 'person', at: record.at, byName: record.byName, byYou: record.byYou, reason: record.reason };
}

/**
 * Atlas §2 settings_switch_states(). Per section: the record; null = this
 * person may not read it (no tab, no card); 'unreadable' = answered but not
 * parseable (rows Unknown, never Off).
 */
export type SettingsSwitchStatesRecord = SettingsSwitchStates;

// ---------------------------------------------------------------------------
// Setting rows (pattern P-SETTING, gap G5)
// ---------------------------------------------------------------------------

/** Every row the Settings area shows. Read-only rows (R7) never get a control. */
export type SettingKey =
  | WorkflowSettingKey
  | BitrixSwitchKey
  | 'auto_sync'
  | 'real_booking'
  | 'supplier_confirmation'
  | 'pdf_render_online'
  | 'finance_mode';

export type SettingControlVM =
  /** canChange false: the row shows blockedText instead of "Change". state 'unknown' always gives canChange false. */
  | { kind: 'switch'; canChange: boolean; blockedText: string | null }
  | { kind: 'read_only'; text: string };

export interface SettingReviewVM {
  /** Consequence lines shown in the review step, per target state. */
  onText: string;
  offText: string;
  /** R5: owner approval line inside every review step. */
  approvalLine: string;
  /** Visa and passport tasks only (M5): read before the review step. count null = could not be counted. */
  preview?: { kind: 'visa_tasks'; count: number | null; skipped: number | null; text: string };
}

export interface SettingRowVM {
  key: SettingKey;
  /** finance_mode rows only: the company and the payment mode. */
  scope?: { legalEntityId: string; legalName: string; mode: ReceiptMode };
  title: string;
  detail: string;
  /** "Who it affects" line. */
  affects: string;
  state: SwitchState;
  lastChange: LastChangeVM;
  control: SettingControlVM;
  /** null for read-only rows and for rows whose state is unknown. */
  review: SettingReviewVM | null;
}

// ---------------------------------------------------------------------------
// Visa task preview (Atlas §4 workflow_visa_task_preview): { switchState, wouldCreate, skipped, deals }
// ---------------------------------------------------------------------------

export type VisaTaskPreviewRecord = VisaTaskPreview;

// ---------------------------------------------------------------------------
// Sync scope: preview id, two phases (Atlas §3; M1 enforced in the database:
// integration_preview_sync_settings -> integration_apply_sync_settings(previewId, reason);
// the old six-argument command refuses preview_required for everyone)
// ---------------------------------------------------------------------------

/** Preview input. cutoffAt: the database uses 00:00 India time of that day. */
export type SyncPreviewInput = SyncSettingsInput;
/** Preview reply: valid 10 minutes, one use, this person only; hide/bringBack exact, recheck not exact. */
export type SyncPreviewRecord = SyncSettingsPreview;
export type SyncHideCounts = SyncSettingsPreview['hide'];
export type SyncApplyRecord = SyncSettingsApplyResult;
/** preview_stale reason from the database. */
export type SyncStaleHint = SyncPreviewStaleReason;

/**
 * Codes a sync-scope screen can show: the command refusals (Atlas: not_authorized,
 * not_configured, preview_required, preview_used, preview_stale, settings_busy,
 * invalid_reason, invalid_input) plus the page-level ones. Words: Mercury.
 */
export type SyncSettingsErrorCode = SyncCommandErrorCode | 'not_installed' | 'session' | 'unexpected';

/** What the staff member ticked and typed (form values; strings as posted). Kept on screen after every refusal (R10). */
export interface SyncScopeDraft {
  categoryIds: string[];
  stageIds: string[];
  /** YYYY-MM-DD (India time). */
  cutoff: string;
  syncEnabled: boolean;
}

/** The review step (gap G16). Only a 'ready' review offers "Confirm"; apply sends previewId + reason, never the values again. */
export type SyncScopeReviewVM =
  | {
      state: 'ready';
      draft: SyncScopeDraft;
      previewId: string;
      expiresAt: string;
      changed: boolean;
      hide: SyncHideCounts;
      bringBack: number;
      recheck: number;
      autoSyncChange: 'none' | 'on' | 'off';
    }
  | { state: 'refused'; draft: SyncScopeDraft; code: SyncSettingsErrorCode; hint: SyncStaleHint | null; fields: string[] };

/** Server action replies (the same ok/code/message shape as the other admin actions). */
export type SyncPreviewActionResult = { ok: true; review: Extract<SyncScopeReviewVM, { state: 'ready' }>; message: string } | { ok: false; code: SyncSettingsErrorCode; hint: SyncStaleHint | null; message: string; fields?: string[] };
export type SyncApplyActionResult = { ok: true; data: SyncApplyRecord; message: string } | { ok: false; code: SyncSettingsErrorCode; hint: SyncStaleHint | null; message: string; fields?: string[] };

/** Frozen form field names for the sync-scope change (HandForm; controlled ticks). */
export const SETTINGS_FIELD = {
  categoryId: 'categoryId',
  stageId: 'stageId',
  cutoff: 'cutoff',
  syncEnabled: 'syncEnabled',
  previewId: 'previewId',
  reason: 'reason',
  /** Pressed button: 'preview' (Review changes) | 'apply' (Confirm) | 'back' (Change again). */
  intent: 'intent',
} as const;

export const SETTINGS_REASON_LIMITS = { min: 10, max: 500 } as const;

// ---------------------------------------------------------------------------
// Department task tabs (DA-16) and task History
// ---------------------------------------------------------------------------

export type TaskTab = 'details' | 'work' | 'files' | 'history';
export const TASK_TABS = ['details', 'work', 'files', 'history'] as const satisfies readonly TaskTab[];
export const TASK_TAB_LABEL: Record<TaskTab, string> = { details: 'Details', work: 'Work', files: 'Files', history: 'History' };

/**
 * Tabs this viewer gets, from what the server read for them (never from roles
 * alone). A viewer with none of Work, Files or History (Sales or Accounts on a
 * Purchase task: status only) gets no tab bar at all: [].
 */
export function taskTabsFor(has: { work: boolean; files: boolean; history: boolean }): TaskTab[] {
  if (!has.work && !has.files && !has.history) return [];
  return TASK_TABS.filter((t) => t === 'details' || has[t]);
}

/**
 * Whether the History tab is offered (Echo-A L5). null (not readable for this
 * viewer) = no tab. A read that is not installed or failed shows the tab (with
 * its honest line) only to viewers who already have Work or Files, so it never
 * gives a status-only viewer (Sales, Accounts) a tab bar.
 */
export function historyTabFor(load: object | null | 'not_installed' | 'error', hasWorkOrFiles: boolean): boolean {
  if (load === null) return false;
  if (load === 'not_installed' || load === 'error') return hasWorkOrFiles;
  return true;
}

/** Server allowlist: a tab the viewer does not have, or anything unknown, is Details. */
export function parseTaskTab(raw: string | string[] | undefined, tabs: readonly TaskTab[]): TaskTab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return tabs.some((t) => t === v) ? (v as TaskTab) : 'details';
}

export interface DepartmentTaskTabsVM {
  /** [] = status-only viewer: no tab bar. */
  tabs: TaskTab[];
  current: TaskTab;
}

/** Atlas §5 department_task_history(p_task_id) reply (null = not visible): only that task's events, allowlisted kinds. */
export type DepartmentTaskHistoryRecord = TaskHistory;

export interface TaskHistoryEventVM {
  id: string;
  kind: TaskHistoryKind;
  at: string;
  title: string;
  /** "You", a name, or null when no person was recorded. */
  byText: string | null;
  detail?: string;
}

/** A failed read is an error, never "no history". */
export type TaskHistoryVM = { state: 'ok'; events: TaskHistoryEventVM[] } | { state: 'error' } | { state: 'not_installed' };

// ---------------------------------------------------------------------------
// Accounts deal page tabs (DA-15, plan T1: own address kept)
// ---------------------------------------------------------------------------

export type AccountsDealTab = 'money' | 'review' | 'receipts' | 'documents';
export const ACCOUNTS_DEAL_TABS = ['money', 'review', 'receipts', 'documents'] as const satisfies readonly AccountsDealTab[];
export const ACCOUNTS_DEAL_TAB_LABEL: Record<AccountsDealTab, string> = { money: 'Money', review: 'Review', receipts: 'Receipts', documents: 'Documents' };

/**
 * The tab of the next action (screen plan AC-02; lead ruling D6: billing sits
 * on Review). Same order as today's "Next" line on the page.
 */
export function accountsDealDefaultTab(d: { receiptsAwaitingVerification: number; billingVerified: boolean; reviewWaiting: boolean }): AccountsDealTab {
  if (d.receiptsAwaitingVerification > 0) return 'receipts';
  if (!d.billingVerified || d.reviewWaiting) return 'review';
  return 'receipts';
}

/** Server allowlist: anything else is the default tab. */
export function parseAccountsDealTab(raw: string | string[] | undefined, fallback: AccountsDealTab): AccountsDealTab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return ACCOUNTS_DEAL_TABS.some((t) => t === v) ? (v as AccountsDealTab) : fallback;
}

/** Link to a tab; the default tab keeps the bare address. */
export function tabHref<T extends string>(basePath: string, tab: T, defaultTab: T): string {
  return tab === defaultTab ? basePath : `${basePath}?tab=${tab}`;
}

// ---------------------------------------------------------------------------
// Loaders Terra calls (Atlas wrappers, frozen names):
//   src/modules/access/server/settings-state.ts   loadSettingsSwitchStates(staff), loadVisaTaskPreview(staff)
//   src/modules/integration/sync-settings-preview.ts previewSyncSettings(client, input), applySyncSettings(client, { previewId, reason })
//     (both throw SyncSettingsError: .code, .detail = stale reason or refused field, .entryStagePipeline)
//   src/modules/fulfilment/server/task-history.ts  loadTaskHistory(staff, taskId)
// ---------------------------------------------------------------------------

/** A loader's answer: the record, null (not authorized / not visible), not installed, or a failed read. Never "off" or "empty" for the last two. */
export type SettingsLoad<T> = T | null | 'not_installed' | 'error';
