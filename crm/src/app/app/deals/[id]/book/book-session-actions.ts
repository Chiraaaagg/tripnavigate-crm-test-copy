'use server';

import { reportPaymentClaimAction, withdrawPaymentClaimAction } from '@/modules/finance/server/claim-actions';
import type { FinanceActionState } from '@/modules/finance/forms';
import { setDealMessagePrefsAction } from '@/modules/customer-messages/server/actions';
import type { MessageActionResult } from '@/modules/customer-messages/contracts';
import { submitChangeAction } from '@/modules/booking-changes/server/actions';
import type { ChangeActionResult } from '@/modules/booking-changes/contracts';
import { ERROR_TEXT } from '@/modules/fulfilment/contracts';
import { removeBookingEvidenceAction, uploadBookingEvidenceAction } from '@/modules/fulfilment/server/actions';
import { refreshFromBitrixAction } from '@/modules/fulfilment/server/bitrix-refresh-action';
import { dismissPrefillNoticeAction, fillEmptyPrefillAction, markPrefillCheckedAction, usePrefillAction as applyPrefillAction } from '@/modules/fulfilment/server/book-now-prefill-actions';
import { removeServiceItemAction } from '@/modules/fulfilment/server/intake-actions';
import { searchHotelsAction } from '@/modules/hotels/server/hotel-actions';
import { SESSION_ENDED, staffForAction } from '@/modules/identity/server/session';
import { createPartyAction, pickPartyAction, searchPartiesAction } from '@/modules/parties/server/party-actions';

/*
 * Booking reliability B1-8, independent review go-live 1 P1-1. The proxy lets
 * a signed-out action POST through only on the Book now addresses, so every
 * action the Book now pages can call must answer an ended session in the page
 * instead of redirecting it (a redirect navigates away and the typing is
 * lost). The actions below are shared with other screens (Deal page, Purchase,
 * quotations, intake), which keep requireStaff() and today's behaviour; these
 * Book now copies gate with staffForAction() first, answer the session refusal
 * in each action's own result shape with ERROR_TEXT.session, and otherwise
 * hand over unchanged (the inner requireStaff() reuses the same cached
 * per-request decision, so it allows).
 */

const SESSION_TEXT = ERROR_TEXT.session;

type Args<F> = F extends (...args: infer A) => unknown ? A : never;
type Out<F> = F extends (...args: never[]) => Promise<infer R> ? R : never;

const bookingSession = { ok: false as const, code: 'session' as const, message: SESSION_TEXT };

export async function removeServiceItemBookAction(...args: Args<typeof removeServiceItemAction>): Promise<Out<typeof removeServiceItemAction>> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return bookingSession;
  return removeServiceItemAction(...args);
}

export async function uploadBookingEvidenceBookAction(...args: Args<typeof uploadBookingEvidenceAction>): Promise<Out<typeof uploadBookingEvidenceAction>> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return bookingSession;
  return uploadBookingEvidenceAction(...args);
}

export async function removeBookingEvidenceBookAction(...args: Args<typeof removeBookingEvidenceAction>): Promise<Out<typeof removeBookingEvidenceAction>> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return bookingSession;
  return removeBookingEvidenceAction(...args);
}

export async function refreshFromBitrixBookAction(...args: Args<typeof refreshFromBitrixAction>): Promise<Out<typeof refreshFromBitrixAction>> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return bookingSession;
  return refreshFromBitrixAction(...args);
}

/** "Use it" for one Bitrix value (named apart from a React hook: it is a server action). */
export async function applyPrefillBookAction(...args: Args<typeof applyPrefillAction>): Promise<Out<typeof applyPrefillAction>> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return bookingSession;
  return applyPrefillAction(...args);
}

export async function markPrefillCheckedBookAction(...args: Args<typeof markPrefillCheckedAction>): Promise<Out<typeof markPrefillCheckedAction>> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return bookingSession;
  return markPrefillCheckedAction(...args);
}

export async function fillEmptyPrefillBookAction(...args: Args<typeof fillEmptyPrefillAction>): Promise<Out<typeof fillEmptyPrefillAction>> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return bookingSession;
  return fillEmptyPrefillAction(...args);
}

export async function dismissPrefillNoticeBookAction(...args: Args<typeof dismissPrefillNoticeAction>): Promise<Out<typeof dismissPrefillNoticeAction>> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return bookingSession;
  return dismissPrefillNoticeAction(...args);
}

/** Hotel search while typing in the hotel drawer: the search box shows the message. */
export async function searchHotelsBookAction(...args: Args<typeof searchHotelsAction>): Promise<Out<typeof searchHotelsAction>> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return { ok: false, message: SESSION_TEXT };
  return searchHotelsAction(...args);
}

/** Bill To customer search (bound to the Deal id in voiceNoteProps). */
export async function searchPartiesBookAction(...args: Args<typeof searchPartiesAction>): Promise<Out<typeof searchPartiesAction>> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return { ok: false, message: SESSION_TEXT };
  return searchPartiesAction(...args);
}

export async function pickPartyBookAction(...args: Args<typeof pickPartyAction>): Promise<Out<typeof pickPartyAction>> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return { ok: false, message: SESSION_TEXT };
  return pickPartyAction(...args);
}

export async function createPartyBookAction(...args: Args<typeof createPartyAction>): Promise<Out<typeof createPartyAction>> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return bookingSession;
  return createPartyAction(...args);
}

export async function reportPaymentClaimBookAction(...args: Args<typeof reportPaymentClaimAction>): Promise<FinanceActionState> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return { status: 'error', code: 'session', message: SESSION_TEXT };
  return reportPaymentClaimAction(...args);
}

export async function withdrawPaymentClaimBookAction(...args: Args<typeof withdrawPaymentClaimAction>): Promise<FinanceActionState> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return { status: 'error', code: 'session', message: SESSION_TEXT };
  return withdrawPaymentClaimAction(...args);
}

/** Save message settings (the Deal's customer language and WhatsApp card on the customer step). */
export async function setDealMessagePrefsBookAction(...args: Args<typeof setDealMessagePrefsAction>): Promise<MessageActionResult<{ rowVersion: number }>> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return { ok: false, code: 'session', message: SESSION_TEXT };
  return setDealMessagePrefsAction(...args);
}

/** "Send to the Manager" in the change-mode banner above the booking form. */
export async function submitChangeBookAction(...args: Args<typeof submitChangeAction>): Promise<Out<typeof submitChangeAction>> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return { ok: false, code: 'session', message: SESSION_TEXT } satisfies ChangeActionResult<never>;
  return submitChangeAction(...args);
}
