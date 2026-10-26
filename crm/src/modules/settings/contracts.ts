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
// Settings tabs (one "Settings" menu item; tabs are links between today's
// /app/admin/* addresses, lead decision L1; no redirects)
// ---------------------------------------------------------------------------

export type SettingsCategory = 'people' | 'company' | 'money' | 'bitrix' | 'imports' | 'features' | 'health';

/** DA-17 order. */
export const SETTINGS_CATEGORIES = ['people', 'company', 'money', 'bitrix', 'imports', 'features', 'health'] as const satisfies readonly SettingsCategory[];

/** DA-17 tab names (Mercury may still reword; the keys stay). */
export const SETTINGS_CATEGORY_LABEL: Record<SettingsCategory, string> = {
  people: 'People and access',
  company: 'Company and branches',
  money: 'Money rules',
  bitrix: 'Bitrix connection',
  imports: 'Imports',
  features: 'Features',
  health: 'System health',
};

/** Addresses (L1). People and access covers Staff and Extra access; Company and branches is the one new page (lead ruling D1). */
export const SETTINGS_PATH = {
  staff: '/app/admin/staff',
  access: '/app/admin/access',
  company: '/app/admin/company',
  money: '/app/admin/finance-policy',
  bitrix: '/app/admin/integration',
  imports: '/app/admin/imports',
  features: '/app/admin/workflow',
  health: '/app/admin/bookings',
} as const;

/** Every Settings address starts with this; the "Settings" menu item is current on all of them. */
export const SETTINGS_PREFIX = '/app/admin';

/** The shell flags that decide which categories a person sees (a subset of ShellViewer; same rules as shell-permissions.ts). */
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
}

export interface SettingsTabVM {
  category: SettingsCategory;
  label: string;
  href: string;
  /** Addresses that mark this tab current (exact or as a path prefix). */
  matchPrefixes: string[];
}

/**
 * The Settings categories this person may open, in DA-17 order. The same list
 * feeds the single "Settings" menu item (its href is the first tab) and the
 * tab bar. Empty = no Settings item and no tab bar.
 */
export function settingsTabsFor(v: Partial<SettingsViewerFlags>): SettingsTabVM[] {
  const anyAdmin = !!(v.canAdministerStaff || v.canManageGrants || v.canManageIntegration || v.canManageFinancePolicy);
  const tabs: SettingsTabVM[] = [];
  const add = (category: SettingsCategory, href: string, matchPrefixes: string[]) =>
    tabs.push({ category, label: SETTINGS_CATEGORY_LABEL[category], href, matchPrefixes });
  if (v.canAdministerStaff || v.canManageGrants) {
    const people: string[] = [];
    if (v.canAdministerStaff) people.push(SETTINGS_PATH.staff);
    if (v.canManageGrants) people.push(SETTINGS_PATH.access);
    add('people', people[0]!, people);
  }
  // Lead ruling D1: read-only page for anyone holding an admin right.
  if (anyAdmin) add('company', SETTINGS_PATH.company, [SETTINGS_PATH.company]);
  if (v.canManageFinancePolicy) add('money', SETTINGS_PATH.money, [SETTINGS_PATH.money]);
  if (v.canOpenBitrixConnection) add('bitrix', SETTINGS_PATH.bitrix, [SETTINGS_PATH.bitrix]);
  if (v.canImport) add('imports', SETTINGS_PATH.imports, [SETTINGS_PATH.imports]);
  if (v.canManageIntegration) {
    add('features', SETTINGS_PATH.features, [SETTINGS_PATH.features]);
    add('health', SETTINGS_PATH.health, [SETTINGS_PATH.health]);
  }
  return tabs;
}

function pathMatches(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The tab that marks the current page, or undefined (longest matching address wins). */
export function currentSettingsTab(tabs: SettingsTabVM[], path: string | null | undefined): SettingsCategory | undefined {
  if (!path) return undefined;
  let best: { category: SettingsCategory; length: number } | undefined;
  for (const tab of tabs) {
    for (const prefix of tab.matchPrefixes) {
      if (pathMatches(prefix, path) && (!best || prefix.length > best.length)) best = { category: tab.category, length: prefix.length };
    }
  }
  return best?.category;
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
