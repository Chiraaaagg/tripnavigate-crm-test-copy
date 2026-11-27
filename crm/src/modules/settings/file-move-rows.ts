import { z } from 'zod';
import { SETTINGS_TEXT, FILE_MOVE_CLASS_WORDS, FILE_MOVE_ITEM_WORDS, FILE_MOVE_SOURCE_WORDS, FILE_MOVE_STATE_WORDS, FILE_MOVE_STOP_WORDS, FILE_MOVE_TEXT } from './text';
import { normaliseReason } from './switch';

/*
 * S11 "files to Bitrix" (hosting-migration file 14 sections 2.5 to 2.7; the
 * staff database API in the slice 0 freeze): the pure part of Settings ›
 * Bitrix connection › "Files kept in Bitrix" and its alert list.
 *
 *  - the reply shapes of the staff database functions (checked with zod;
 *    anything else is treated as "could not be read", never as Off);
 *  - the form fields and their checks (the database checks again and decides);
 *  - database refusal codes in plain words;
 *  - the finished models the views draw (rows, values, alerts).
 *
 * No I/O. The server wrappers are in modules/integration/server/file-move-admin.ts,
 * the actions in file-move-admin-actions.ts, the views in views/files/.
 * Only a Super Admin gets anything: the database answers null for everyone
 * else and the screen then shows nothing at all.
 */

// ---------------------------------------------------------------------------
// Reply shapes (freeze: "Staff DB API")
// ---------------------------------------------------------------------------

const timestamp = z.string().min(1).max(64);
// A Bitrix deal number as text (the freeze); a plain JSON number is accepted too, so a bigint never loses digits on our side.
const bitrixDeal = z.union([z.string().regex(/^[1-9][0-9]{0,18}$/), z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
const code = z.string().regex(/^[a-z_]{1,60}$/);
const itemKey = z.string().regex(/^ufCrm_[0-9A-Za-z_]{1,40}$/);

export const FileMoveSettingsSchema = z.object({
  checkIdProofCopies: z.boolean(),
  moveAccountsFiles: z.boolean(),
  deleteAfterHold: z.boolean(),
  deleteHoldMinutes: z.number().int().min(15).max(43200),
  accountsHoldDays: z.number().int().min(90),
  accountsBox: itemKey.nullable(),
  pilotBitrixDealId: bitrixDeal.nullable(),
  deleteEverOn: z.boolean(),
  enqueueEnabled: z.boolean(),
  openStops: z.number().int().nonnegative(),
  updatedAt: timestamp.nullable(),
});
export type FileMoveSettings = z.output<typeof FileMoveSettingsSchema>;

export const FileMoveAlertsSchema = z.object({
  stops: z
    .array(
      z.object({
        stopId: z.uuid(),
        moveId: z.uuid().nullable(),
        bitrixDealId: bitrixDeal.nullable(),
        reasonCode: code,
        openedAt: timestamp,
        acknowledgedAt: timestamp.nullable(),
      }),
    )
    .max(1000),
  items: z
    .array(
      z.object({
        moveId: z.uuid(),
        kind: code,
        fileClass: code,
        sourceTable: code,
        state: code,
        lastErrorCode: code.nullable(),
        bitrixDealId: bitrixDeal.nullable(),
        updatedAt: timestamp,
      }),
    )
    .max(1000),
  counts: z.object({
    noTarget: z.number().int().nonnegative(),
    missedEnqueue: z.number().int().nonnegative(),
    waitingAccounts: z.number().int().nonnegative(),
    soleCopies: z.number().int().nonnegative(),
  }),
});
export type FileMoveAlerts = z.output<typeof FileMoveAlertsSchema>;

export const FILE_MOVE_SWITCHES = ['check_id_proof_copies', 'move_accounts_files', 'delete_after_hold'] as const;
export type FileMoveSwitch = (typeof FILE_MOVE_SWITCHES)[number];

export const SwitchReplySchema = z.object({ changed: z.boolean(), switch: z.enum(FILE_MOVE_SWITCHES), on: z.boolean() });
export const HoldReplySchema = z.object({ changed: z.boolean(), deleteHoldMinutes: z.number().int() });
export const BoxReplySchema = z.object({ changed: z.boolean(), accountsBox: itemKey.nullable() });
export const PilotReplySchema = z.object({ changed: z.boolean(), pilotBitrixDealId: bitrixDeal.nullable() });
export const AckReplySchema = z.object({ stopId: z.uuid() });
export const RetryReplySchema = z.object({ moveId: z.uuid(), state: code });
export const RelocateReplySchema = z.object({ moveId: z.uuid() });
export const LostReplySchema = z.object({ moveId: z.uuid(), state: z.literal('lost_accepted') });

// ---------------------------------------------------------------------------
// Form fields and checks
// ---------------------------------------------------------------------------

/** Frozen form field names of the S11 settings actions. */
export const FILE_MOVE_FIELD = {
  switch: 'fileMoveSwitch',
  state: 'state',
  reason: 'reason',
  /** 'yes', posted only by the review dialog's confirm button. */
  confirm: 'confirm',
  minutes: 'minutes',
  itemKey: 'itemKey',
  dealId: 'dealId',
  /** 'yes' when the pilot is cleared (the company-wide start). */
  clear: 'clear',
  stopId: 'stopId',
  moveId: 'moveId',
} as const;

/** The identity box (the DEC-43 "Aadhar and Passports" field). The Accounts box must differ. */
export const IDENTITY_BOX_KEY = 'ufCrm_1784359513';

export const HOLD_LIMITS = { min: 15, max: 43200 } as const;
export const REASON_LENGTH = { min: 10, max: 500 } as const;

export type FileMoveField = 'reason' | 'minutes' | 'itemKey' | 'dealId' | 'confirm' | 'state' | 'fileMoveSwitch' | 'stopId' | 'moveId';

export type FormCheck<T> = { ok: true; value: T } | { ok: false; code: 'invalid_input' | 'review_required'; fields: FileMoveField[] };

function text(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === 'string' ? v : '';
}

/** The reason as the database will see it, or null when it is not 10 to 500 characters. */
export function checkReason(raw: string): string | null {
  const reason = normaliseReason(raw);
  return reason.length >= REASON_LENGTH.min && reason.length <= REASON_LENGTH.max ? reason : null;
}

/** Hold minutes: a whole number from 15 to 43200, digits only. */
export function checkMinutes(raw: string): number | null {
  const t = raw.trim();
  if (!/^[0-9]{1,5}$/.test(t)) return null;
  const n = Number(t);
  return n >= HOLD_LIMITS.min && n <= HOLD_LIMITS.max ? n : null;
}

/** A Bitrix deal number (digits, no leading zero), kept as text so no digit is lost. */
export function checkDealNumber(raw: string): string | null {
  const t = raw.trim();
  return /^[1-9][0-9]{0,18}$/.test(t) ? t : null;
}

/** An Accounts box item key; 'same_as_identity' when it names the identity box. */
export function checkItemKey(raw: string): string | 'same_as_identity' | null {
  const t = raw.trim();
  if (!/^ufCrm_[0-9A-Za-z_]{1,40}$/.test(t)) return null;
  return t === IDENTITY_BOX_KEY ? 'same_as_identity' : t;
}

/** The reason, shared by every change that needs one (10 to 500 characters). */
function reasonAndConfirm(formData: FormData, fields: FileMoveField[]): string | null {
  const reason = checkReason(text(formData, FILE_MOVE_FIELD.reason));
  if (reason === null) fields.push('reason');
  return reason;
}

/** A missing confirm is its own refusal, checked after the fields (the review is not only in the browser). */
function finish<T>(formData: FormData, fields: FileMoveField[], value: () => T): FormCheck<T> {
  if (fields.length > 0) return { ok: false, code: 'invalid_input', fields };
  if (text(formData, FILE_MOVE_FIELD.confirm) !== 'yes') return { ok: false, code: 'review_required', fields: ['confirm'] };
  return { ok: true, value: value() };
}

export function parseSwitchChange(formData: FormData): FormCheck<{ switch: FileMoveSwitch; on: boolean; reason: string }> {
  const fields: FileMoveField[] = [];
  const key = text(formData, FILE_MOVE_FIELD.switch);
  const known = (FILE_MOVE_SWITCHES as readonly string[]).includes(key) ? (key as FileMoveSwitch) : null;
  if (!known) fields.push('fileMoveSwitch');
  const state = text(formData, FILE_MOVE_FIELD.state);
  if (state !== 'on' && state !== 'off') fields.push('state');
  const reason = reasonAndConfirm(formData, fields);
  return finish(formData, fields, () => ({ switch: known!, on: state === 'on', reason: reason! }));
}

export function parseHoldChange(formData: FormData): FormCheck<{ minutes: number; reason: string }> {
  const fields: FileMoveField[] = [];
  const minutes = checkMinutes(text(formData, FILE_MOVE_FIELD.minutes));
  if (minutes === null) fields.push('minutes');
  const reason = reasonAndConfirm(formData, fields);
  return finish(formData, fields, () => ({ minutes: minutes!, reason: reason! }));
}

export function parseBoxChange(formData: FormData): FormCheck<{ itemKey: string; reason: string }> & { sameAsIdentity?: true } {
  const fields: FileMoveField[] = [];
  const key = checkItemKey(text(formData, FILE_MOVE_FIELD.itemKey));
  if (key === null || key === 'same_as_identity') fields.push('itemKey');
  const reason = reasonAndConfirm(formData, fields);
  const checked = finish(formData, fields, () => ({ itemKey: key as string, reason: reason! }));
  return key === 'same_as_identity' ? { ...checked, sameAsIdentity: true } : checked;
}

/** Set a pilot deal, or clear it (clear=yes; the company-wide start). */
export function parsePilotChange(formData: FormData): FormCheck<{ dealId: string | null; reason: string }> {
  const fields: FileMoveField[] = [];
  const clear = text(formData, FILE_MOVE_FIELD.clear) === 'yes';
  const deal = clear ? null : checkDealNumber(text(formData, FILE_MOVE_FIELD.dealId));
  if (!clear && deal === null) fields.push('dealId');
  const reason = reasonAndConfirm(formData, fields);
  return finish(formData, fields, () => ({ dealId: deal, reason: reason! }));
}

const uuid = z.uuid();

export function parseAcknowledge(formData: FormData): FormCheck<{ stopId: string; reason: string }> {
  const fields: FileMoveField[] = [];
  const stopId = text(formData, FILE_MOVE_FIELD.stopId);
  if (!uuid.safeParse(stopId).success) fields.push('stopId');
  const reason = reasonAndConfirm(formData, fields);
  return finish(formData, fields, () => ({ stopId, reason: reason! }));
}

export function parseRetry(formData: FormData): FormCheck<{ moveId: string }> {
  const fields: FileMoveField[] = [];
  const moveId = text(formData, FILE_MOVE_FIELD.moveId);
  if (!uuid.safeParse(moveId).success) fields.push('moveId');
  return finish(formData, fields, () => ({ moveId }));
}

export function parseRelocate(formData: FormData): FormCheck<{ moveId: string; dealId: string }> {
  const fields: FileMoveField[] = [];
  const moveId = text(formData, FILE_MOVE_FIELD.moveId);
  if (!uuid.safeParse(moveId).success) fields.push('moveId');
  const deal = checkDealNumber(text(formData, FILE_MOVE_FIELD.dealId));
  if (deal === null) fields.push('dealId');
  return finish(formData, fields, () => ({ moveId, dealId: deal! }));
}

export function parseAcceptLost(formData: FormData): FormCheck<{ moveId: string; reason: string }> {
  const fields: FileMoveField[] = [];
  const moveId = text(formData, FILE_MOVE_FIELD.moveId);
  if (!uuid.safeParse(moveId).success) fields.push('moveId');
  const reason = reasonAndConfirm(formData, fields);
  return finish(formData, fields, () => ({ moveId, reason: reason! }));
}

// ---------------------------------------------------------------------------
// Refusals in plain words
// ---------------------------------------------------------------------------

export type FileMoveErrorCode =
  | 'not_authorized'
  | 'invalid_input'
  | 'review_required'
  | 'wrong_state'
  | 'not_found'
  | 'conflict'
  | 'view_limit'
  | 'not_installed'
  | 'session'
  | 'unexpected';

/** What an S11 settings action answers. ok:false always says "nothing was changed" or "could not confirm". */
export type FileMoveActionResult =
  | { ok: true; changed: boolean; message: string }
  | { ok: false; code: FileMoveErrorCode; hint?: string; fields?: FileMoveField[]; message: string };

/** Postgres and PostgREST states of the S11 functions (freeze, "Error codes"). */
export function errorCodeOf(sqlState: string | undefined | null): FileMoveErrorCode {
  switch (sqlState ?? '') {
    case '42501':
      return 'not_authorized';
    case '22023':
    case '22P02':
    case '22003':
      return 'invalid_input';
    case '55000':
      return 'wrong_state';
    case 'P0002':
      return 'not_found';
    case 'PT409':
      return 'conflict';
    case 'PT429':
      return 'view_limit';
    case 'PGRST202':
    case '42883':
      return 'not_installed';
    case 'PGRST301':
    case 'PGRST302':
    case 'PGRST303':
    case '401':
      return 'session';
    default:
      return 'unexpected';
  }
}

/** The form field a 22023 refusal names (its hint is the argument name). */
export function fieldOfHint(hint: string | undefined | null): FileMoveField | null {
  switch ((hint ?? '').trim()) {
    case 'p_reason':
      return 'reason';
    case 'p_minutes':
      return 'minutes';
    case 'p_item_key':
      return 'itemKey';
    case 'p_source_deal_id':
    case 'p_new_source_deal_id':
      return 'dealId';
    default:
      return null;
  }
}

/** One refusal in plain words. The database's own message is never shown. */
export function refusalText(errorCode: FileMoveErrorCode, hint?: string | null): string {
  switch (errorCode) {
    case 'not_authorized':
      return FILE_MOVE_TEXT.refusedNotAuthorized;
    case 'invalid_input':
      return fieldOfHint(hint) === 'reason' ? FILE_MOVE_TEXT.refusedReason : FILE_MOVE_TEXT.refusedInput;
    case 'review_required':
      return FILE_MOVE_TEXT.refusedReview;
    case 'wrong_state': {
      const h = (hint ?? '').trim();
      if (h === 'pilot_required') return FILE_MOVE_TEXT.refusedPilotRequired;
      if (h === 'open_stops') return FILE_MOVE_TEXT.refusedOpenStops;
      return FILE_MOVE_TEXT.refusedWrongState;
    }
    case 'not_found':
      return FILE_MOVE_TEXT.refusedNotFound;
    case 'conflict':
      return FILE_MOVE_TEXT.refusedConflict;
    case 'view_limit':
      return FILE_MOVE_TEXT.refusedViewLimit;
    case 'not_installed':
      return FILE_MOVE_TEXT.refusedNotInstalled;
    case 'session':
      return SETTINGS_TEXT.signedOut;
    default:
      // The command may have committed: say so honestly, never "not saved".
      return SETTINGS_TEXT.unknownOutcome;
  }
}

/** A refusal result for a form check (before any database call). */
export function formRefusal(check: { code: 'invalid_input' | 'review_required'; fields: FileMoveField[] }, extra?: { sameAsIdentity?: true }): FileMoveActionResult {
  const onlyReason = check.fields.length === 1 && check.fields[0] === 'reason';
  const message = check.code === 'review_required' ? FILE_MOVE_TEXT.refusedReview : onlyReason ? FILE_MOVE_TEXT.refusedReason : extra?.sameAsIdentity ? FILE_MOVE_TEXT.boxSameAsId : FILE_MOVE_TEXT.refusedInput;
  return { ok: false, code: check.code, fields: check.fields, message };
}

// ---------------------------------------------------------------------------
// Models the views draw
// ---------------------------------------------------------------------------

const DATE_TIME = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' });

export function whenText(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : `${DATE_TIME.format(t)} IST`;
}

export function fillText(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** How the page loaded the section. 'hidden' = the database answered null (not the Super Admin): nothing is shown. */
export type FileMoveLoad =
  | { kind: 'hidden' }
  | { kind: 'not_installed' }
  | { kind: 'error' }
  | { kind: 'ready'; settings: FileMoveSettings; alerts: FileMoveAlerts | 'error' | null };

export interface FileMoveSwitchRowModel {
  key: FileMoveSwitch;
  title: string;
  detail: string;
  state: 'on' | 'off';
  /** The review dialog: what switching to the other state does. */
  target: 'on' | 'off';
  confirmLabel: string;
  effect: string;
  /** danger = the confirm button is red (deleting on, or switching a check off). */
  tone: 'primary' | 'danger';
  /** Why Change is disabled now (null = it can be changed). The database decides again. */
  blockedText: string | null;
}

export interface FileMoveValueRowModel {
  key: 'hold' | 'accounts_box' | 'pilot';
  title: string;
  detail: string;
  /** The value in words, e.g. "15 minutes", "Not set". */
  valueText: string;
  /** true when no value is set (drawn as "Off"-like, with its own words). */
  empty: boolean;
  /** What the change dialog says. */
  effect: string;
  confirmLabel: string;
  /** The current value to put in the input (typed input is kept after a refusal by the dialog). */
  inputValue: string;
}

export interface FileMovePilotRowModel extends FileMoveValueRowModel {
  key: 'pilot';
  /** The "Clear the pilot deal" dialog, when a pilot is set. */
  clear: { effect: string; confirmLabel: string } | null;
}

export type FileMoveSectionModel =
  | { kind: 'not_installed'; text: string }
  | { kind: 'error'; text: string }
  | {
      kind: 'ready';
      switches: FileMoveSwitchRowModel[];
      hold: FileMoveValueRowModel;
      box: FileMoveValueRowModel;
      pilot: FileMovePilotRowModel;
      /** Warning lines above the rows (open stops, listing stopped). */
      notices: string[];
      updatedLine: string;
    };

function switchRow(key: FileMoveSwitch, s: FileMoveSettings): FileMoveSwitchRowModel {
  const on = key === 'check_id_proof_copies' ? s.checkIdProofCopies : key === 'move_accounts_files' ? s.moveAccountsFiles : s.deleteAfterHold;
  const state = on ? 'on' : 'off';
  const target = on ? 'off' : 'on';
  const values = { days: s.accountsHoldDays, minutes: s.deleteHoldMinutes, box: s.accountsBox ?? FILE_MOVE_TEXT.boxNotSet, deal: s.pilotBitrixDealId ?? '' };
  let title: string;
  let detail: string;
  let effect: string;
  let blockedText: string | null = null;
  if (key === 'check_id_proof_copies') {
    title = FILE_MOVE_TEXT.checkIdTitle;
    detail = FILE_MOVE_TEXT.checkIdDetail;
    effect = target === 'on' ? FILE_MOVE_TEXT.checkIdOn : FILE_MOVE_TEXT.checkIdOff;
  } else if (key === 'move_accounts_files') {
    title = FILE_MOVE_TEXT.accountsTitle;
    detail = fillText(FILE_MOVE_TEXT.accountsDetail, values);
    effect = target === 'off' ? FILE_MOVE_TEXT.accountsOff : fillText(s.accountsBox ? FILE_MOVE_TEXT.accountsOn : FILE_MOVE_TEXT.accountsOnNoBox, values);
  } else {
    title = FILE_MOVE_TEXT.deleteTitle;
    detail = fillText(FILE_MOVE_TEXT.deleteDetail, values);
    effect = target === 'off' ? FILE_MOVE_TEXT.deleteOff : fillText(s.pilotBitrixDealId ? FILE_MOVE_TEXT.deleteOnPilot : FILE_MOVE_TEXT.deleteOnAll, values);
    if (target === 'on') {
      // Known refusals (pilot_required, open_stops): the button says why instead of offering a review that would be refused.
      if (s.openStops > 0) blockedText = FILE_MOVE_TEXT.deleteNeedsAck;
      else if (!s.deleteEverOn && !s.pilotBitrixDealId) blockedText = FILE_MOVE_TEXT.deleteNeedsPilot;
    }
  }
  const confirmLabel = `Turn ${title} ${target}`;
  // Deleting is the dangerous direction for its switch; for the checks, switching off is (as on every Settings switch).
  const tone = key === 'delete_after_hold' ? (target === 'on' ? 'danger' : 'primary') : target === 'off' ? 'danger' : 'primary';
  return { key, title, detail, state, target, confirmLabel, effect, tone, blockedText };
}

/** The "Files kept in Bitrix" section, or null when nothing is shown (not the Super Admin). */
export function fileMoveSectionModel(load: FileMoveLoad): FileMoveSectionModel | null {
  if (load.kind === 'hidden') return null;
  if (load.kind === 'not_installed') return { kind: 'not_installed', text: FILE_MOVE_TEXT.notInstalled };
  if (load.kind === 'error') return { kind: 'error', text: FILE_MOVE_TEXT.readFailed };
  const s = load.settings;
  const notices: string[] = [];
  if (s.openStops > 0) notices.push(fillText(FILE_MOVE_TEXT.openStopsLine, { n: s.openStops, stops: plural(s.openStops, 'stop is', 'stops are') }));
  if (!s.enqueueEnabled) notices.push(FILE_MOVE_TEXT.listingOff);
  const deal = s.pilotBitrixDealId;
  return {
    kind: 'ready',
    switches: FILE_MOVE_SWITCHES.map((k) => switchRow(k, s)),
    hold: {
      key: 'hold',
      title: FILE_MOVE_TEXT.holdTitle,
      detail: FILE_MOVE_TEXT.holdDetail,
      valueText: fillText(FILE_MOVE_TEXT.holdValue, { minutes: s.deleteHoldMinutes }),
      empty: false,
      effect: FILE_MOVE_TEXT.holdEffect,
      confirmLabel: FILE_MOVE_TEXT.holdConfirm,
      inputValue: String(s.deleteHoldMinutes),
    },
    box: {
      key: 'accounts_box',
      title: FILE_MOVE_TEXT.boxTitle,
      detail: fillText(FILE_MOVE_TEXT.boxDetail, { days: s.accountsHoldDays }),
      valueText: s.accountsBox ?? FILE_MOVE_TEXT.boxNotSet,
      empty: s.accountsBox === null,
      effect: FILE_MOVE_TEXT.boxEffect,
      confirmLabel: FILE_MOVE_TEXT.boxConfirm,
      inputValue: s.accountsBox ?? '',
    },
    pilot: {
      key: 'pilot',
      title: FILE_MOVE_TEXT.pilotTitle,
      detail: FILE_MOVE_TEXT.pilotDetail,
      valueText: deal ? fillText(FILE_MOVE_TEXT.pilotValue, { deal }) : s.deleteEverOn ? FILE_MOVE_TEXT.pilotNoneAll : FILE_MOVE_TEXT.pilotNone,
      empty: deal === null,
      effect: deal ? fillText(FILE_MOVE_TEXT.pilotEffect, { deal }) : FILE_MOVE_TEXT.pilotEffectNew,
      confirmLabel: FILE_MOVE_TEXT.pilotConfirm,
      inputValue: deal ?? '',
      clear: deal ? { effect: fillText(s.deleteAfterHold ? FILE_MOVE_TEXT.clearEffect : FILE_MOVE_TEXT.clearEffectOff, { deal }), confirmLabel: FILE_MOVE_TEXT.clearConfirm } : null,
    },
    notices,
    updatedLine: s.updatedAt ? fillText(FILE_MOVE_TEXT.updated, { at: whenText(s.updatedAt) }) : FILE_MOVE_TEXT.updatedNever,
  };
}

export interface FileMoveStopModel {
  stopId: string;
  open: boolean;
  dealText: string;
  reasonText: string;
  /** "Stopped on … · acknowledged on …". */
  timeText: string;
}

export interface FileMoveItemModel {
  moveId: string;
  kind: string;
  label: string;
  text: string;
  dealText: string;
  /** "Traveller ID proof · ID paper · Only in Bitrix". */
  whatText: string;
  timeText: string;
  errorText: string | null;
  canRetry: boolean;
  canRelocate: boolean;
  canAcceptLost: boolean;
  /** The accessible name tail of this item's buttons ("for the file on Bitrix deal 123"). */
  nameTail: string;
}

export type FileMoveAlertsModel =
  | { kind: 'error'; text: string }
  | { kind: 'ready'; summary: { open: number; items: number; text: string }; stops: FileMoveStopModel[]; items: FileMoveItemModel[]; countLines: string[] };

/** Words for a code this screen does not know yet: a neutral sentence, with the code for the CRM team. */
function unknownCode(prefix: string, value: string): string {
  return `${prefix} (code: ${value.replace(/_/g, ' ')}).`;
}

/** Item kinds that a Super Admin may try again (a read-back first). The database refuses any other state. */
const RETRY_KINDS = new Set(['quarantined', 'needs_manual_check', 'lost_in_bitrix', 'failed', 'stuck']);

/** The alert list on Clean-up, or null when nothing is shown (not the Super Admin, or not installed). */
export function fileMoveAlertsModel(load: FileMoveLoad): FileMoveAlertsModel | null {
  if (load.kind !== 'ready' || load.alerts === null) return null;
  if (load.alerts === 'error') return { kind: 'error', text: FILE_MOVE_TEXT.alertsReadFailed };
  const { stops, items, counts } = load.alerts;
  const days = load.settings.accountsHoldDays;
  const ordered = [...stops.filter((s) => s.acknowledgedAt === null), ...stops.filter((s) => s.acknowledgedAt !== null)];
  const stopModels: FileMoveStopModel[] = ordered.map((s) => {
    const open = s.acknowledgedAt === null;
    const opened = fillText(FILE_MOVE_TEXT.stopOpened, { at: whenText(s.openedAt) });
    return {
      stopId: s.stopId,
      open,
      dealText: s.bitrixDealId ? fillText(FILE_MOVE_TEXT.itemDeal, { deal: s.bitrixDealId }) : FILE_MOVE_TEXT.itemNoDeal,
      reasonText: FILE_MOVE_STOP_WORDS[s.reasonCode] ?? unknownCode('Stopped for a reason this screen does not describe yet. Deleting was switched off', s.reasonCode),
      timeText: s.acknowledgedAt ? `${opened} · ${fillText(FILE_MOVE_TEXT.stopAckAt, { at: whenText(s.acknowledgedAt) })}` : opened,
    };
  });
  const itemModels: FileMoveItemModel[] = items.map((i) => {
    const words = FILE_MOVE_ITEM_WORDS[i.kind];
    const dealText = i.bitrixDealId ? fillText(FILE_MOVE_TEXT.itemDeal, { deal: i.bitrixDealId }) : FILE_MOVE_TEXT.itemNoDeal;
    const what = [FILE_MOVE_SOURCE_WORDS[i.sourceTable] ?? 'File', FILE_MOVE_CLASS_WORDS[i.fileClass], FILE_MOVE_STATE_WORDS[i.state]].filter(Boolean).join(' · ');
    return {
      moveId: i.moveId,
      kind: i.kind,
      label: words?.label ?? 'Needs a look',
      text: words?.text ?? unknownCode('This file needs a look', i.kind),
      dealText,
      whatText: what,
      timeText: fillText(FILE_MOVE_TEXT.itemUpdated, { at: whenText(i.updatedAt) }),
      errorText: i.lastErrorCode ? fillText(FILE_MOVE_TEXT.itemLastError, { error: i.lastErrorCode.replace(/_/g, ' ') }) : null,
      canRetry: RETRY_KINDS.has(i.kind),
      canRelocate: i.kind === 'lost_in_bitrix',
      canAcceptLost: i.kind === 'lost_in_bitrix',
      nameTail: i.bitrixDealId ? `for the file on Bitrix deal ${i.bitrixDealId}` : 'for the file with no Bitrix deal',
    };
  });
  const open = stopModels.filter((s) => s.open).length;
  const countLines: string[] = [];
  if (counts.soleCopies > 0) countLines.push(fillText(FILE_MOVE_TEXT.countSole, { n: counts.soleCopies }));
  if (counts.waitingAccounts > 0) countLines.push(fillText(FILE_MOVE_TEXT.countWaiting, { n: counts.waitingAccounts, days }));
  if (counts.noTarget > 0) countLines.push(fillText(FILE_MOVE_TEXT.countNoTarget, { n: counts.noTarget }));
  if (counts.missedEnqueue > 0) countLines.push(fillText(FILE_MOVE_TEXT.countMissed, { n: counts.missedEnqueue }));
  const summaryText =
    open + itemModels.length === 0
      ? FILE_MOVE_TEXT.alertsNothing
      : fillText(FILE_MOVE_TEXT.alertsCount, { stops: open, stopsWord: plural(open, 'stop', 'stops'), items: itemModels.length, itemsWord: plural(itemModels.length, 'file', 'files') });
  return { kind: 'ready', summary: { open, items: itemModels.length, text: summaryText }, stops: stopModels, items: itemModels, countLines };
}

/** Result words after a switch change. */
export function switchSavedText(key: FileMoveSwitch, on: boolean, changed: boolean): string {
  const title = key === 'check_id_proof_copies' ? FILE_MOVE_TEXT.checkIdTitle : key === 'move_accounts_files' ? FILE_MOVE_TEXT.accountsTitle : FILE_MOVE_TEXT.deleteTitle;
  return fillText(changed ? FILE_MOVE_TEXT.savedSwitch : FILE_MOVE_TEXT.unchangedSwitch, { switch: title, state: on ? 'on' : 'off' });
}
