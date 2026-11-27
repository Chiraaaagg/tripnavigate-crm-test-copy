'use server';

import {
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
  switchSavedText,
  type FileMoveActionResult,
} from '@/modules/settings/file-move-rows';
import { FILE_MOVE_TEXT } from '@/modules/settings/text';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY (S11 "files to Bitrix"). Stand-in actions:
 * they read nothing, write nothing and answer like the real actions (same
 * form checks, same words), so the preview states show the review step,
 * refusals that keep the typed values, and results. The gallery is a 404
 * outside local preview mode.
 */

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

export async function previewFileMoveSwitchAction(_prev: FileMoveActionResult | null, formData: FormData): Promise<FileMoveActionResult> {
  const parsed = parseSwitchChange(formData);
  if (!parsed.ok) return settle(formRefusal(parsed));
  return settle({ ok: true, changed: true, message: switchSavedText(parsed.value.switch, parsed.value.on, true) });
}

export async function previewFileMoveHoldAction(_prev: FileMoveActionResult | null, formData: FormData): Promise<FileMoveActionResult> {
  const parsed = parseHoldChange(formData);
  if (!parsed.ok) return settle(formRefusal(parsed));
  return settle({ ok: true, changed: true, message: fillText(FILE_MOVE_TEXT.savedHold, { minutes: parsed.value.minutes }) });
}

export async function previewFileMoveBoxAction(_prev: FileMoveActionResult | null, formData: FormData): Promise<FileMoveActionResult> {
  const parsed = parseBoxChange(formData);
  if (!parsed.ok) return settle(formRefusal(parsed, parsed.sameAsIdentity ? { sameAsIdentity: true } : undefined));
  return settle({ ok: true, changed: true, message: fillText(FILE_MOVE_TEXT.savedBox, { box: parsed.value.itemKey }) });
}

export async function previewFileMovePilotAction(_prev: FileMoveActionResult | null, formData: FormData): Promise<FileMoveActionResult> {
  const parsed = parsePilotChange(formData);
  if (!parsed.ok) return settle(formRefusal(parsed));
  const deal = parsed.value.dealId;
  return settle({ ok: true, changed: true, message: deal ? fillText(FILE_MOVE_TEXT.savedPilot, { deal }) : FILE_MOVE_TEXT.savedPilotCleared });
}

export async function previewFileMoveAckAction(_prev: FileMoveActionResult | null, formData: FormData): Promise<FileMoveActionResult> {
  const parsed = parseAcknowledge(formData);
  if (!parsed.ok) return settle(formRefusal(parsed));
  return settle({ ok: true, changed: true, message: FILE_MOVE_TEXT.savedAck });
}

export async function previewFileMoveRetryAction(_prev: FileMoveActionResult | null, formData: FormData): Promise<FileMoveActionResult> {
  const parsed = parseRetry(formData);
  if (!parsed.ok) return settle(formRefusal(parsed));
  return settle({ ok: true, changed: true, message: FILE_MOVE_TEXT.savedRetry });
}

export async function previewFileMoveRelocateAction(_prev: FileMoveActionResult | null, formData: FormData): Promise<FileMoveActionResult> {
  const parsed = parseRelocate(formData);
  if (!parsed.ok) return settle(formRefusal(parsed));
  return settle({ ok: true, changed: true, message: fillText(FILE_MOVE_TEXT.savedRelocate, { deal: parsed.value.dealId }) });
}

export async function previewFileMoveLostAction(_prev: FileMoveActionResult | null, formData: FormData): Promise<FileMoveActionResult> {
  const parsed = parseAcceptLost(formData);
  if (!parsed.ok) return settle(formRefusal(parsed));
  return settle({ ok: true, changed: true, message: FILE_MOVE_TEXT.savedLost });
}
