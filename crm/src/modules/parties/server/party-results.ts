import 'server-only';
import { createHash } from 'node:crypto';
import type { BookingActionResult, BookingErrorCode } from '@/modules/fulfilment/contracts';
import { UNKNOWN_OUTCOME_TEXT } from '@/modules/fulfilment/contracts';
import { VnDbError } from './parties-db';

/**
 * Result helpers for the customer, hotel and import actions (voice-note
 * batch). Refusals carry plain words and the form fields named by the
 * database hint (input keys only; never database text, never a value).
 * Results reuse the booking result shape so the screens treat them alike.
 */

export type VnResult<T> = BookingActionResult<T>;

/** Plain words per refusal token (Atlas shapes v1). */
export const VN_ERROR_TEXT: Record<string, string> = {
  not_authorized: 'You do not have access to do this. Nothing was changed.',
  not_found: 'This record is not available any more. Reload the page.',
  version_changed: 'Someone changed this in the meantime. Reload the page to see the latest, then try again. Nothing was changed.',
  request_conflict: 'This was already sent with different details. Reload the page and try again. Nothing was changed.',
  invalid_input: 'Check the highlighted fields. Nothing was changed.',
  consent_required: 'Tick that the customer agreed to share this ID for this booking. Nothing was uploaded.',
  party_doc_limit: 'This customer already has 6 documents. Remove one first. Nothing was uploaded.',
  party_returned: 'Accounts returned this customer. Fix the details Accounts asked for first. Nothing was changed.',
  party_checked: 'Accounts has checked this customer, so the details cannot be changed here. Ask Accounts. Nothing was changed.',
  party_incomplete: 'This customer is missing billing details. Add them first. Nothing was changed.',
  billing_verified: 'Accounts has already checked these Bill To details, so they cannot be changed here. Ask Accounts. Nothing on this step was saved.',
  deal_not_active: 'This deal is lost or rejected in Bitrix, so the booking cannot change. Nothing was changed.',
  deal_removed: 'This deal was removed from the CRM. Nothing was changed.',
  import_not_validated: 'Check the file first, then import it.',
  import_applied: 'This file was already imported.',
  import_stale: 'Records changed since this file was checked. Check the file again, then import it. Nothing was imported.',
  import_too_large: 'This file has too many rows. Split it and import the parts one at a time. Nothing was imported.',
  switch_off: 'This is switched off for the CRM. Nothing was changed.',
  session: 'Your session has ended. Sign in again; nothing was changed.',
  evidence_rejected: 'Use a PDF, JPG, PNG or WebP file up to 4 MB. Nothing was uploaded.',
  wrong_state: 'This cannot be changed in its current state. Reload the page. Nothing was changed.',
  service_items_disabled: 'Service items are switched off for this CRM. Nothing was changed.',
  already_confirmed: 'This booking was already submitted. Nothing was changed.',
  not_configured: 'The Bitrix connection is not set up yet. Nothing was changed.',
};

const SHARED_CODES = new Set<BookingErrorCode>([
  'not_authorized', 'not_found', 'version_changed', 'request_conflict', 'invalid_input', 'consent_required', 'billing_verified',
  'deal_not_active', 'deal_removed', 'switch_off', 'evidence_rejected', 'wrong_state', 'service_items_disabled', 'already_confirmed',
]);

/** The result code: the shared refusal code when one exists, else 'wrong_state' (the words say which). */
function resultCode(code: string): BookingErrorCode | 'session' {
  if (code === 'session') return 'session';
  return SHARED_CODES.has(code as BookingErrorCode) ? (code as BookingErrorCode) : 'wrong_state';
}

export function vnFail(code: string, fields?: readonly string[], message?: string): VnResult<never> {
  return {
    ok: false,
    code: resultCode(code),
    message: message ?? VN_ERROR_TEXT[code] ?? VN_ERROR_TEXT.invalid_input!,
    ...(fields && fields.length > 0 ? { fields: [...new Set(fields)] } : {}),
  };
}

/**
 * A database refusal in words; anything unexplained is rethrown as "could
 * not confirm" (the command may have committed).
 */
export function vnFailFrom(error: unknown, hintMap: Readonly<Record<string, string>> = {}): VnResult<never> {
  if (error instanceof VnDbError && error.code && (VN_ERROR_TEXT[error.code] || error.code === 'invalid_input')) {
    const fields = error.hintKeys.map((k) => hintMap[k] ?? hintMap[k.replace(/\[\d+\].*$/, '')] ?? k.replace(/\[\d+\].*$/, '').replace(/\..*$/, ''));
    return vnFail(error.code, error.code === 'invalid_input' || error.code === 'party_incomplete' ? fields : undefined);
  }
  throw new Error(UNKNOWN_OUTCOME_TEXT);
}

export function isVnCode(error: unknown, code: string): boolean {
  return error instanceof VnDbError && error.code === code;
}

/** A second request id derived from the one the screen sent (an exact retry derives the same one). */
export function derivedRequestId(requestId: string, purpose: string): string {
  const h = createHash('sha256').update(`${requestId}:${purpose}`).digest('hex');
  // RFC 4122 shape, version 4 and variant bits set (the database checks the shape only).
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
