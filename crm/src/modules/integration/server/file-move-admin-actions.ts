'use server';

import { revalidatePath } from 'next/cache';
import { SESSION_ENDED, staffForAction } from '@/modules/identity/server/session';
import { SETTINGS_PATH } from '@/modules/settings/contracts';
import {
  fieldOfHint,
  fillText,
  formRefusal,
  parseAcceptLost,
  parseAcknowledge,
  parseBoxChange,
  parseHoldChange,
  parsePilotChange,
  parseRelocate,
  parseRetry,
  parseSwitchChange,
  refusalText,
  switchSavedText,
  type FileMoveActionResult,
} from '@/modules/settings/file-move-rows';
import { FILE_MOVE_TEXT, SETTINGS_TEXT } from '@/modules/settings/text';
import { asRpcClient } from '../commands';
import {
  FileMoveAdminError,
  fileMoveAcceptLost,
  fileMoveAcknowledgeStop,
  fileMoveRelocate,
  fileMoveRetry,
  fileMoveSetAccountsBox,
  fileMoveSetHold,
  fileMoveSetPilot,
  fileMoveSetSwitch,
} from './file-move-admin';

/*
 * S11 "files to Bitrix": the actions of Settings › Bitrix connection ›
 * "Files kept in Bitrix" and its alert list. Every action first runs the
 * requireStaff() decision (staffForAction: active staff at aal2; an ended
 * session answers `session`, so the open dialog keeps what was typed), then
 * checks the form (the review dialog's confirm=yes is required, so the
 * review is not only in the browser), then calls the database command under
 * the person's own session. The database decides who may change what (the
 * Super Admin only), checks the reason again and writes the audit row.
 * Answers carry plain words, ids and states only. A refusal keeps the
 * dialog open with the typed reason and values (ConfirmChange).
 * Live use needs the owner's APPROVE; the dialogs say so.
 */

type Prev = FileMoveActionResult | null;

function refresh(): void {
  revalidatePath(SETTINGS_PATH.bitrix);
}

function sessionEnded(): FileMoveActionResult {
  return { ok: false, code: 'session', message: SETTINGS_TEXT.signedOut };
}

/** A database refusal in plain words; a 22023 marks the field its hint names. */
function refusedFrom(error: unknown): FileMoveActionResult {
  if (error instanceof FileMoveAdminError) {
    const field = error.code === 'invalid_input' ? fieldOfHint(error.hint) : null;
    return {
      ok: false,
      code: error.code,
      ...(error.hint ? { hint: error.hint } : {}),
      ...(field ? { fields: [field] } : {}),
      message: refusalText(error.code, error.hint),
    };
  }
  // A Next.js control-flow error (a sign-in redirect) must reach Next.js.
  if (error && typeof error === 'object' && 'digest' in error) throw error;
  return { ok: false, code: 'unexpected', message: refusalText('unexpected') };
}

/** One of the three switches: fileMoveSwitch, state ('on' | 'off'), reason, confirm=yes. */
export async function setFileMoveSwitchAction(_prev: Prev, formData: FormData): Promise<FileMoveActionResult> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return sessionEnded();
  const parsed = parseSwitchChange(formData);
  if (!parsed.ok) return formRefusal(parsed);
  try {
    const r = await fileMoveSetSwitch(asRpcClient(staff.supabase), parsed.value);
    refresh();
    return { ok: true, changed: r.changed, message: switchSavedText(r.switch, r.on, r.changed) };
  } catch (error) {
    return refusedFrom(error);
  }
}

/** The hold before deleting: minutes (15 to 43200), reason, confirm=yes. */
export async function setFileMoveHoldAction(_prev: Prev, formData: FormData): Promise<FileMoveActionResult> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return sessionEnded();
  const parsed = parseHoldChange(formData);
  if (!parsed.ok) return formRefusal(parsed);
  try {
    const r = await fileMoveSetHold(asRpcClient(staff.supabase), parsed.value);
    refresh();
    return { ok: true, changed: r.changed, message: r.changed ? fillText(FILE_MOVE_TEXT.savedHold, { minutes: r.deleteHoldMinutes }) : FILE_MOVE_TEXT.unchanged };
  } catch (error) {
    return refusedFrom(error);
  }
}

/** The Accounts box (the item key of the "Accounts papers" Deal field): itemKey, reason, confirm=yes. */
export async function setFileMoveAccountsBoxAction(_prev: Prev, formData: FormData): Promise<FileMoveActionResult> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return sessionEnded();
  const parsed = parseBoxChange(formData);
  if (!parsed.ok) return formRefusal(parsed, parsed.sameAsIdentity ? { sameAsIdentity: true } : undefined);
  try {
    const r = await fileMoveSetAccountsBox(asRpcClient(staff.supabase), parsed.value);
    refresh();
    return { ok: true, changed: r.changed, message: r.changed ? fillText(FILE_MOVE_TEXT.savedBox, { box: r.accountsBox ?? FILE_MOVE_TEXT.boxNotSet }) : FILE_MOVE_TEXT.unchanged };
  } catch (error) {
    return refusedFrom(error);
  }
}

/** The pilot deal: dealId (or clear=yes, the company-wide start), reason, confirm=yes. */
export async function setFileMovePilotAction(_prev: Prev, formData: FormData): Promise<FileMoveActionResult> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return sessionEnded();
  const parsed = parsePilotChange(formData);
  if (!parsed.ok) return formRefusal(parsed);
  try {
    const r = await fileMoveSetPilot(asRpcClient(staff.supabase), parsed.value);
    refresh();
    if (!r.changed) return { ok: true, changed: false, message: FILE_MOVE_TEXT.unchanged };
    return {
      ok: true,
      changed: true,
      message: r.pilotBitrixDealId ? fillText(FILE_MOVE_TEXT.savedPilot, { deal: r.pilotBitrixDealId }) : FILE_MOVE_TEXT.savedPilotCleared,
    };
  } catch (error) {
    return refusedFrom(error);
  }
}

/** Acknowledge one automatic stop: stopId, reason, confirm=yes. */
export async function acknowledgeFileMoveStopAction(_prev: Prev, formData: FormData): Promise<FileMoveActionResult> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return sessionEnded();
  const parsed = parseAcknowledge(formData);
  if (!parsed.ok) return formRefusal(parsed);
  try {
    await fileMoveAcknowledgeStop(asRpcClient(staff.supabase), parsed.value);
    refresh();
    return { ok: true, changed: true, message: FILE_MOVE_TEXT.savedAck };
  } catch (error) {
    return refusedFrom(error);
  }
}

/** "Try again" on one file (the worker reads Bitrix first): moveId, confirm=yes. */
export async function retryFileMoveAction(_prev: Prev, formData: FormData): Promise<FileMoveActionResult> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return sessionEnded();
  const parsed = parseRetry(formData);
  if (!parsed.ok) return formRefusal(parsed);
  try {
    await fileMoveRetry(asRpcClient(staff.supabase), parsed.value.moveId);
    refresh();
    return { ok: true, changed: true, message: FILE_MOVE_TEXT.savedRetry };
  } catch (error) {
    return refusedFrom(error);
  }
}

/** "Look in another deal" (a deal merged in Bitrix): moveId, dealId, confirm=yes. */
export async function relocateFileMoveAction(_prev: Prev, formData: FormData): Promise<FileMoveActionResult> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return sessionEnded();
  const parsed = parseRelocate(formData);
  if (!parsed.ok) return formRefusal(parsed);
  try {
    await fileMoveRelocate(asRpcClient(staff.supabase), parsed.value);
    refresh();
    return { ok: true, changed: true, message: fillText(FILE_MOVE_TEXT.savedRelocate, { deal: parsed.value.dealId }) };
  } catch (error) {
    return refusedFrom(error);
  }
}

/** "Accept this file is lost": moveId, reason, confirm=yes. */
export async function acceptFileMoveLostAction(_prev: Prev, formData: FormData): Promise<FileMoveActionResult> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return sessionEnded();
  const parsed = parseAcceptLost(formData);
  if (!parsed.ok) return formRefusal(parsed);
  try {
    await fileMoveAcceptLost(asRpcClient(staff.supabase), parsed.value);
    refresh();
    return { ok: true, changed: true, message: FILE_MOVE_TEXT.savedLost };
  } catch (error) {
    return refusedFrom(error);
  }
}
