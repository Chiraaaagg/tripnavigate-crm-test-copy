import 'server-only';
import { refresh } from 'next/cache';
import { BOOK_SAVE_REFRESH_MODE } from '../book-refresh';
import { BookingCommandError, type RpcClient } from '../commands';
import { bookingFormGet } from '../b11-commands';
import { type BookingActionResult, type BookingErrorCode, ERROR_TEXT, type SaveConflict, UNKNOWN_OUTCOME_TEXT } from '../contracts';

/**
 * Result helpers for the B1.1 fulfilment actions. Refusals carry frozen
 * ERROR_TEXT wording and, for invalid_input, the form fields named by the
 * database hint (input keys only, mapped to FIELD names; never database
 * text). A failure the database did not explain is rethrown as
 * UNKNOWN_OUTCOME_TEXT because the command may have committed.
 */

export function fail(code: BookingErrorCode | 'session' | 'upload_failed', fields?: string[], message?: string): BookingActionResult<never> {
  return {
    ok: false,
    code,
    message: message ?? ERROR_TEXT[code],
    ...(fields && fields.length > 0 ? { fields: [...new Set(fields)] } : {}),
  };
}

/** Maps database hint keys ("instalments[2]", "start", "segments[1].from") to form field names. */
export function fieldsFromHint(keys: readonly string[], map: Readonly<Record<string, string>> = {}): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const base = key.replace(/\[\d+\].*$/, '').replace(/\..*$/, '');
    out.push(map[key] ?? map[base] ?? base);
  }
  return [...new Set(out)];
}

export function failFrom(error: unknown, hintMap?: Readonly<Record<string, string>>): BookingActionResult<never> {
  if (error instanceof BookingCommandError && error.code) {
    const fields = error.code === 'invalid_input' ? fieldsFromHint(error.hintKeys, hintMap) : undefined;
    return fail(error.code, fields);
  }
  throw new Error(UNKNOWN_OUTCOME_TEXT);
}

export function isCode(error: unknown, code: BookingErrorCode): boolean {
  return error instanceof BookingCommandError && error.code === code;
}

/**
 * Who saved the draft after the form was opened (booking_form_get version
 * updatedAt / updatedByName). null when the re-read fails or says nothing.
 */
export async function readConflict(rpc: RpcClient, dealId: string): Promise<SaveConflict | null> {
  try {
    const form = await bookingFormGet(rpc, dealId);
    const v = form?.version;
    if (!v?.updatedAt) return null;
    return { savedByName: v.updatedByName, savedAt: v.updatedAt };
  } catch {
    return null;
  }
}

/** failFrom plus the conflict member on version_changed. */
export async function failWithConflict(
  error: unknown,
  rpc: RpcClient,
  dealId: string,
  hintMap?: Readonly<Record<string, string>>,
): Promise<BookingActionResult<never>> {
  const result = failFrom(error, hintMap);
  if (!result.ok && result.code === 'version_changed') {
    const conflict = await readConflict(rpc, dealId);
    if (conflict) return { ...result, conflict };
  }
  return result;
}

/**
 * What a Book now action did, for the re-render after it (booking reliability
 * B1-6). 'draft_save': autosaves, drawer saves, ID-proof attach and remove,
 * fares, and the fresh view after a refused draft save; they follow
 * BOOK_SAVE_REFRESH_MODE. 'status_change': start, submit, revision, discard
 * and the like keep today's revalidatePath calls, because other pages and
 * desks must see them.
 */
export type BookRefreshKind = 'draft_save' | 'status_change';

/**
 * The one re-render after a draft save. 'server': refresh() from next/cache
 * re-renders the page the action was posted from, in the action's own
 * answer (one render, no revalidatePath, so the client router cache and the
 * menu-link prefetches are left alone). 'client': nothing here; the screen
 * calls router.refresh() itself. Never both.
 */
export function refreshAfterDraftSave(): void {
  if (BOOK_SAVE_REFRESH_MODE === 'server') refresh();
}
