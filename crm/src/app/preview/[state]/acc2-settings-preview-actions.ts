'use server';

import { CHANGEABLE_SWITCH_KEYS, parseSwitchForm, SWITCH_FIELD, type ChangeableSwitchKey, type SwitchActionResult } from '@/modules/settings/switch';
import { reasonWasGiven, switchReasonRule, withOptionalReason } from '@/modules/settings/reason';
import { fillSettingsText } from '@/modules/settings/rows';
import { SETTINGS_TEXT, SWITCH_WORDS } from '@/modules/settings/text';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the Accounts
 * phase 2 settings states (acc2-settings-): fixed synthetic answers, nothing
 * read or written; the gallery is a 404 outside the local preview mode.
 */

type Result = { ok: true; data?: unknown; message: string } | { ok: false; code: string; message: string; field?: string };

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

export async function acc2MappingSaveOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: mapping saved. The next export uses the new names.' });
}
export async function acc2MappingSaveRefused(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Check the highlighted field.', field: 'creditLedger' });
}
export async function acc2SwitchOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: saved. The change is recorded with your reason.' });
}
export async function acc2SwitchRefused(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Check the highlighted field.', field: 'reason' });
}
export async function acc2NoticeNoop(): Promise<{ ok: false; code: 'not_authorized'; message: string }> {
  return settle({ ok: false, code: 'not_authorized', message: 'Preview only.' });
}

/*
 * UX redesign R1 (D9): stand-ins that treat the reason as the real actions
 * now do. An empty reason outside the four STANDING-RULES families is saved
 * as "No reason given"; a Bitrix scope switch still refuses it.
 */

export async function r1SwitchSavedAction(_prev: SwitchActionResult | null, input: FormData): Promise<SwitchActionResult> {
  const raw = input.get(SWITCH_FIELD.key);
  const key = typeof raw === 'string' && (CHANGEABLE_SWITCH_KEYS as readonly string[]).includes(raw) ? (raw as ChangeableSwitchKey) : null;
  const given = reasonWasGiven(input);
  const parsed = parseSwitchForm(key && switchReasonRule(key) === 'optional' ? withOptionalReason(input) : input);
  if (!parsed.ok) return settle({ ok: false, code: parsed.code, fields: parsed.fields, message: parsed.code === 'invalid_input' ? SETTINGS_TEXT.refusedReason : SETTINGS_TEXT.refusedReview });
  const state = parsed.value.on ? 'on' : 'off';
  const template = given ? SETTINGS_TEXT.resultChanged : SETTINGS_TEXT.resultChangedNoReason;
  return settle({ ok: true, key: parsed.value.key, state, changed: true, message: fillSettingsText(template, { switch: SWITCH_WORDS[parsed.value.key].title, state }) });
}

/** The notices switch as the real action answers (no message on success; the view supplies the words). */
export async function r1NoticesSavedAction(_prev: unknown, input: FormData): Promise<{ ok: true; data: { enabled: boolean } } | { ok: false; code: string; message: string }> {
  const formData = withOptionalReason(input);
  const enabled = formData.get('enabled');
  const reason = String(formData.get('reason') ?? '').trim();
  if (enabled !== 'true' && enabled !== 'false') return settle({ ok: false, code: 'invalid_input', message: 'Preview: the switch value is missing.' });
  if (reason.length < 10 || reason.length > 500) return settle({ ok: false, code: 'invalid_input', message: 'Write a reason of 10 to 500 characters.' });
  return settle({ ok: true, data: { enabled: enabled === 'true' } });
}

/** Saves an Accounts setting: the switches need a reason (finance modes); the exception owner (userId) may leave it empty. */
export async function r1AccountsSwitchSaved(_prev: unknown, input: FormData): Promise<Result> {
  const optional = input.has('userId');
  const reason = String((optional ? withOptionalReason(input) : input).get('reason') ?? '').trim();
  if (reason.length < 10) return settle({ ok: false, code: 'invalid_input', message: optional ? 'Write the reason in 10 to 500 characters, or leave it empty.' : 'Write the reason in 10 to 500 characters.', field: 'reason' });
  return settle({ ok: true, message: reasonWasGiven(input) ? 'Synthetic preview: saved with your reason.' : 'Synthetic preview: saved. No reason given; your name and the time are recorded.' });
}
