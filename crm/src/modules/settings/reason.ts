import type { ChangeableSwitchKey } from './switch';
import { SWITCH_WORDS } from './text';

/*
 * UX redesign R1, owner answers D9 and Q1 (16 and 17 November 2026): the
 * reason for a Settings switch change may be left empty. The database still
 * requires 10 to 500 characters (authz.settings_change_reason and the checks
 * of each settings command), so the server actions turn an empty or blank
 * reason into the words "No reason given" before calling the database. The
 * change, the person and the time stay recorded in the audit row as before.
 *
 * Four families keep a required reason, with today's refusal (STANDING-RULES
 * section 3; lead ruling on Q1, 17 November 2026):
 *  - finance modes: every switch on Settings › Accounts (Tally export,
 *    customer documents, refunds, automatic drafts and release, write-offs,
 *    the Tally import file) and the payment modes (read only in the CRM);
 *  - real booking: the switches that start real department work (Book now
 *    service list: one task per sold service; Visa and passport tasks) and
 *    the real booking switch itself (read only in the CRM);
 *  - supplier confirmation: read only in the CRM (no change action);
 *  - sync scope (Bitrix scope): "Which deals come in", "Bring in deals only
 *    when won" and "Bring in leads whose Bitrix owner is not a CRM
 *    salesperson" (its words are marked `scope`).
 * Those actions never call withOptionalReason. Everything else takes the
 * optional reason: the other Features switches, the Bitrix switches outside
 * the scope (Bitrix names, trip facts, trip details, and "Copy ID proofs to
 * the Bitrix deal": owner decision, 18 November 2026), staff notices, the
 * customer message switches, pilot mode, the timer and the Tally exception
 * owner (owner decision, 18 November 2026). Pilot Deals, text approvals, Tally mapping and the money
 * rules policy are not switches and keep their required reason.
 *
 * Pure: shared by the server actions (the rule) and the dialogs (whether the
 * reason box shows as optional or required).
 */

/** Saved as the reason when a person leaves an optional reason empty. 15 characters: within 10 to 500. */
export const NO_REASON_GIVEN = 'No reason given';

export type ReasonRule = 'optional' | 'required';

/** The four STANDING-RULES families whose reason stays required. */
export type RequiredReasonFamily = 'finance_mode' | 'real_booking' | 'supplier_confirmation' | 'bitrix_scope';

export const REQUIRED_REASON_FAMILIES: readonly RequiredReasonFamily[] = ['finance_mode', 'real_booking', 'supplier_confirmation', 'bitrix_scope'];

/** Features switches that start real department work (tasks for Purchase, Flight and the Visa desk). */
export const REAL_WORK_SWITCHES: readonly ChangeableSwitchKey[] = ['service_items_enabled', 'visa_passport_tasks_enabled'];

/** The family of a switch of the shared change action, or null when it is outside the four (optional reason). */
export function switchFamily(key: ChangeableSwitchKey): RequiredReasonFamily | null {
  if (SWITCH_WORDS[key].scope) return 'bitrix_scope';
  if (REAL_WORK_SWITCHES.includes(key)) return 'real_booking';
  return null;
}

/** Reason rule of a switch of the shared change action (Features and Bitrix connection switches). */
export function switchReasonRule(key: ChangeableSwitchKey): ReasonRule {
  return switchFamily(key) === null ? 'optional' : 'required';
}

/** True when the value is missing, not text, or only spaces, tabs and line breaks. */
export function isBlankReason(raw: unknown): boolean {
  return typeof raw !== 'string' || raw.trim() === '';
}

/** The reason to send to the database: an optional blank reason becomes NO_REASON_GIVEN; anything else is returned as typed. */
export function reasonOrDefault(raw: unknown, rule: ReasonRule): string {
  if (rule === 'optional' && isBlankReason(raw)) return NO_REASON_GIVEN;
  return typeof raw === 'string' ? raw : '';
}

/**
 * The form with an optional blank reason filled in as NO_REASON_GIVEN (a copy;
 * the original is not changed). Every other field and every other reason is
 * passed on unchanged, so the action's own checks run as before.
 */
export function withOptionalReason(formData: FormData, name = 'reason'): FormData {
  if (!isBlankReason(formData.get(name))) return formData;
  const copy = new FormData();
  for (const [k, v] of formData.entries()) if (k !== name) copy.append(k, v);
  copy.set(name, NO_REASON_GIVEN);
  return copy;
}

/** True when the reason that reached the database is the default words (for the result line). */
export function reasonWasGiven(formData: FormData, name = 'reason'): boolean {
  return !isBlankReason(formData.get(name));
}
