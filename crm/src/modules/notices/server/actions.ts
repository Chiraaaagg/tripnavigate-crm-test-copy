'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { requireStaff } from '@/modules/identity/server/session';
import {
  NoticeCommandError,
  adminSetNoticesEnabled,
  noticeMark,
  noticeMarkAllRead,
  noticePreferencesSet,
} from '../commands';
import {
  NOTICE_ACTIONS,
  NOTICE_ERROR_TEXT,
  NOTICE_FAILED_TEXT,
  NOTICE_SWITCH_TEXT,
  type NoticeActionResult,
  type NoticeMarkAction,
  type NoticeMarkAllResult,
  type NoticeMarkResult,
  type NoticePreferencesDTO,
} from '../contracts';
import type { NoticeSwitchResult } from '../dto';

/**
 * Bell commands (contract 7.5, 9.4): mark read / done / open, mark all read,
 * the sound preference and the admin notices switch. Each calls requireStaff()
 * and then the database under the staff member's OWN session; inputs are
 * validated here and the actor is never taken from input. Every function
 * answers { ok: true, data } or { ok: false, code, message } and never shows a
 * database message ("Could not save — try again" on failure). Reads (inbox,
 * history, count) are NOT actions: they go through GET /api/notices
 * (server/feed.ts), so they never queue with the page's own Server Actions.
 * Marking is not audited (view state).
 */

function failure(error: unknown, fallback: string = NOTICE_FAILED_TEXT): Extract<NoticeActionResult<never>, { ok: false }> {
  if (error instanceof NoticeCommandError && error.code) {
    return { ok: false, code: error.code, message: NOTICE_ERROR_TEXT[error.code] };
  }
  return { ok: false, code: 'failed', message: fallback };
}

/** "Mark read" (normal), "Done" (urgent) or "Open" (any; the bell then follows the link). */
export async function markNoticeAction(noticeId: string, action: NoticeMarkAction): Promise<NoticeActionResult<NoticeMarkResult>> {
  const staff = await requireStaff();
  const id = z.uuid().safeParse(noticeId);
  const act = z.enum(NOTICE_ACTIONS).safeParse(action);
  if (!id.success || !act.success) return { ok: false, code: 'invalid_input', message: NOTICE_ERROR_TEXT.invalid_input };
  try {
    return { ok: true, data: await noticeMark(asRpcClient(staff.supabase), id.data, act.data) };
  } catch (error) {
    return failure(error);
  }
}

/** "Mark all read": unread normal notices only (urgent stay until opened or Done). */
export async function markAllNoticesReadAction(): Promise<NoticeActionResult<NoticeMarkAllResult>> {
  const staff = await requireStaff();
  try {
    return { ok: true, data: await noticeMarkAllRead(asRpcClient(staff.supabase)) };
  } catch (error) {
    return failure(error);
  }
}

/** Bell menu "Sound on / off" (personal; ON by default since Accounts phase 2). */
export async function setNoticeSoundAction(soundOn: boolean): Promise<NoticeActionResult<NoticePreferencesDTO>> {
  const staff = await requireStaff();
  const on = z.boolean().safeParse(soundOn);
  if (!on.success) return { ok: false, code: 'invalid_input', message: NOTICE_ERROR_TEXT.invalid_input };
  try {
    return { ok: true, data: await noticePreferencesSet(asRpcClient(staff.supabase), { soundOn: on.data }) };
  } catch (error) {
    return failure(error);
  }
}

/** Bell settings "Pop-ups on / off" (personal; ON by default, Accounts phase 2 contract 8.5). */
export async function setNoticePopupsAction(popupsOn: boolean): Promise<NoticeActionResult<NoticePreferencesDTO>> {
  const staff = await requireStaff();
  const on = z.boolean().safeParse(popupsOn);
  if (!on.success) return { ok: false, code: 'invalid_input', message: NOTICE_ERROR_TEXT.invalid_input };
  try {
    return { ok: true, data: await noticePreferencesSet(asRpcClient(staff.supabase), { popupsOn: on.data }) };
  } catch (error) {
    return failure(error);
  }
}

type PreferencesPrev = NoticeActionResult<NoticePreferencesDTO> | null;

/**
 * Form shape of the same preferences (Addendum L3): fields `soundOn` and / or `popupsOn`, each 'true' | 'false'
 * (at least one). The other value is kept.
 */
export async function setNoticePreferencesAction(_prev: PreferencesPrev, formData: FormData): Promise<NoticeActionResult<NoticePreferencesDTO>> {
  const staff = await requireStaff();
  const fields: { soundOn?: boolean; popupsOn?: boolean } = {};
  for (const key of ['soundOn', 'popupsOn'] as const) {
    const raw = formData.get(key);
    if (raw === null) continue;
    if (raw !== 'true' && raw !== 'false') return { ok: false, code: 'invalid_input', message: NOTICE_ERROR_TEXT.invalid_input };
    fields[key] = raw === 'true';
  }
  if (fields.soundOn === undefined && fields.popupsOn === undefined) {
    return { ok: false, code: 'invalid_input', message: NOTICE_ERROR_TEXT.invalid_input };
  }
  try {
    return { ok: true, data: await noticePreferencesSet(asRpcClient(staff.supabase), fields) };
  } catch (error) {
    return failure(error);
  }
}

type SwitchPrev = NoticeActionResult<NoticeSwitchResult> | null;

/** Admin settings: the notices switch (Super Admin; form fields `enabled` = 'true' | 'false' and `reason`). */
export async function setNoticesEnabledAction(_prev: SwitchPrev, formData: FormData): Promise<NoticeActionResult<NoticeSwitchResult>> {
  const staff = await requireStaff();
  const enabled = formData.get('enabled');
  const reason = formData.get('reason');
  if ((enabled !== 'true' && enabled !== 'false') || typeof reason !== 'string') {
    return { ok: false, code: 'invalid_input', message: NOTICE_ERROR_TEXT.invalid_input };
  }
  const trimmed = reason.trim();
  if (trimmed.length < 10 || trimmed.length > 500) return { ok: false, code: 'invalid_input', message: NOTICE_SWITCH_TEXT.reason };
  try {
    const data = await adminSetNoticesEnabled(asRpcClient(staff.supabase), enabled === 'true', trimmed);
    revalidatePath('/app', 'layout');
    return { ok: true, data };
  } catch (error) {
    if (error instanceof NoticeCommandError && error.code === 'not_authorized') {
      return { ok: false, code: 'not_authorized', message: NOTICE_SWITCH_TEXT.notAllowed };
    }
    if (error instanceof NoticeCommandError && error.code === 'invalid_input') {
      return { ok: false, code: 'invalid_input', message: NOTICE_SWITCH_TEXT.reason };
    }
    return failure(error);
  }
}
