import { B12_SWITCH_KEYS, WORKFLOW_SETTING_KEYS, type B12SwitchKey, type WorkflowSettingKey } from '@/modules/fulfilment/contracts';
import { SETTINGS_REASON_LIMITS } from './contracts';

/*
 * Batch 4 (DA-256): one change flow for every switch of Features and Bitrix
 * connection: choose On/Off, reason, review, confirm. The action refuses a
 * post without the review step's confirm field, so the review is not only in
 * the browser; the database then checks the person, the reason and writes the
 * audit row. Won-only intake keeps its own card (stages, dry run). Pure.
 */

export type ChangeableSwitchKey = WorkflowSettingKey | B12SwitchKey | 'bitrix_name_read';

export const CHANGEABLE_SWITCH_KEYS: readonly ChangeableSwitchKey[] = [...WORKFLOW_SETTING_KEYS, ...B12_SWITCH_KEYS, 'bitrix_name_read'];

export function isWorkflowKey(key: ChangeableSwitchKey): key is WorkflowSettingKey {
  return (WORKFLOW_SETTING_KEYS as readonly string[]).includes(key);
}

export function isB12Key(key: ChangeableSwitchKey): key is B12SwitchKey {
  return (B12_SWITCH_KEYS as readonly string[]).includes(key);
}

/** Frozen form field names (HandForm; the choice is a controlled radio). */
export const SWITCH_FIELD = {
  key: 'settingKey',
  state: 'state',
  reason: 'reason',
  /** 'yes', posted only by the review step's confirm button. */
  confirm: 'confirm',
  /** Visa and passport tasks only: the count shown in the review (for the result line; never a check). */
  reviewedCount: 'reviewedCount',
} as const;

export type SwitchField = 'state' | 'reason' | 'confirm' | 'settingKey';

export type SwitchErrorCode = 'invalid_input' | 'review_required' | 'not_authorized' | 'not_configured' | 'not_installed' | 'settings_busy' | 'session' | 'unexpected';

export type SwitchActionResult =
  | {
      ok: true;
      key: ChangeableSwitchKey;
      state: 'on' | 'off';
      changed: boolean;
      /** Visa and passport tasks switched on: tasks actually created. */
      tasksCreated?: number;
      message: string;
    }
  | { ok: false; code: SwitchErrorCode; fields?: SwitchField[]; message: string };

export interface SwitchForm {
  key: ChangeableSwitchKey;
  on: boolean;
  reason: string;
  reviewedCount: number | null;
}

function value(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === 'string' ? v : '';
}

/**
 * Echo-A L10: a reason keeps its line breaks; only runs of spaces and tabs
 * collapse, and each line and the whole text are trimmed (the database trims too).
 */
export function normaliseReason(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Validates the post. A missing confirm is its own refusal (review_required), checked after the fields. */
export function parseSwitchForm(formData: FormData): { ok: true; value: SwitchForm } | { ok: false; code: 'invalid_input' | 'review_required'; fields: SwitchField[] } {
  const fields: SwitchField[] = [];
  const keyRaw = value(formData, SWITCH_FIELD.key);
  const key = (CHANGEABLE_SWITCH_KEYS as readonly string[]).includes(keyRaw) ? (keyRaw as ChangeableSwitchKey) : null;
  if (!key) fields.push('settingKey');
  const state = value(formData, SWITCH_FIELD.state);
  if (state !== 'on' && state !== 'off') fields.push('state');
  const reason = normaliseReason(value(formData, SWITCH_FIELD.reason));
  if (reason.length < SETTINGS_REASON_LIMITS.min || reason.length > SETTINGS_REASON_LIMITS.max) fields.push('reason');
  if (fields.length > 0 || !key) return { ok: false, code: 'invalid_input', fields };
  if (value(formData, SWITCH_FIELD.confirm) !== 'yes') return { ok: false, code: 'review_required', fields: ['confirm'] };
  const counted = value(formData, SWITCH_FIELD.reviewedCount);
  const reviewedCount = /^\d{1,6}$/.test(counted) ? Number(counted) : null;
  return { ok: true, value: { key, on: state === 'on', reason, reviewedCount } };
}
