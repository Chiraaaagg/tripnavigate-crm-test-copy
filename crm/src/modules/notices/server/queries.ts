import 'server-only';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import { NoticeCommandError, isNoticeFunctionMissing, noticeHistory, noticeInbox, noticePreferencesGet, noticeUnreadCount } from '../commands';
import type { NoticeCountsDTO, NoticeHistoryDTO, NoticeInboxDTO, NoticePreferencesDTO } from '../contracts';

/**
 * Bell reads for server components (contract 8.4) under the staff member's
 * own session. The database returns only the caller's rows that pass the
 * access re-check. A refusal or a database without the notice functions maps
 * to null (the shell hides the bell; Home counts and queues still show the
 * work); any other failure throws a plain retry message, never a fabricated
 * empty list.
 */

type Staff = Pick<StaffContext, 'supabase'>;

function quiet(error: unknown): boolean {
  return (
    isNoticeFunctionMissing(error) ||
    (error instanceof NoticeCommandError && (error.code === 'not_authorized' || error.code === 'session'))
  );
}

/** The first page for the shell (null = no bell for this person). */
export async function loadNoticeInbox(staff: Staff, afterSeq: number | null = null): Promise<NoticeInboxDTO | null> {
  try {
    return await noticeInbox(asRpcClient(staff.supabase), afterSeq);
  } catch (error) {
    if (quiet(error)) return null;
    throw new Error('Could not load notices. Please retry.');
  }
}

export async function loadNoticeHistory(staff: Staff, beforeSeq: number | null = null): Promise<NoticeHistoryDTO | null> {
  try {
    return await noticeHistory(asRpcClient(staff.supabase), beforeSeq);
  } catch (error) {
    if (quiet(error)) return null;
    throw new Error('Could not load notice history. Please retry.');
  }
}

/** Badge counts; null when not available (the badge is left out). */
export async function loadNoticeCounts(staff: Staff): Promise<NoticeCountsDTO | null> {
  try {
    return await noticeUnreadCount(asRpcClient(staff.supabase));
  } catch {
    return null;
  }
}

export async function loadNoticePreferences(staff: Staff): Promise<NoticePreferencesDTO | null> {
  try {
    return await noticePreferencesGet(asRpcClient(staff.supabase));
  } catch {
    return null;
  }
}

/** The notices switch as staff see it (admin settings page): true / false, or null when unknown. */
export async function loadNoticesEnabled(staff: Staff): Promise<boolean | null> {
  try {
    const inbox = await noticeInbox(asRpcClient(staff.supabase), null, 1);
    return inbox ? inbox.enabled : null;
  } catch {
    return null;
  }
}
