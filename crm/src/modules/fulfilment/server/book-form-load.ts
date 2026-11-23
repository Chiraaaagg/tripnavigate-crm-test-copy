import 'server-only';
import type { StaffContext } from '@/modules/identity/server/session';
import { toBookingFormVM, maskViewChecklist, type BookingFormStep, type BookingFormVM } from '../booking-form-vm';
import type { BookNowView } from '../contracts';
import { BOOK_NOW_NOT_INSTALLED, loadBookNowWithRecord } from './book-now';

/**
 * The one read behind the booking form (/app/deals/[id]/book and
 * /book/[step]): the Book now read under the viewer's own session (the
 * database authorizes; no privileged client), then the booking form view
 * model. Returns null for the same cases as loadBookNow (malformed id, Deal
 * not visible, a viewer who neither edits nor accepts the booking) and
 * 'not_installed' on a database without booking_form_get.
 *
 * Privacy: `vm.prices` and item estimates exist only for viewers who may read
 * the deal's commercials; the view's price readiness texts are masked for
 * everyone else (Mercury money-privacy-copy.md B4, B9).
 */

type Staff = Pick<StaffContext, 'supabase' | 'access'>;

export { BOOK_NOW_NOT_INSTALLED };

export interface BookingFormLoad {
  view: BookNowView;
  vm: BookingFormVM;
}

export async function loadBookingForm(
  staff: Staff,
  dealId: string,
  opts: { step: BookingFormStep | null; ownerText: string | null },
): Promise<BookingFormLoad | null | typeof BOOK_NOW_NOT_INSTALLED> {
  const loaded = await loadBookNowWithRecord(staff, dealId);
  if (loaded === null || loaded === BOOK_NOW_NOT_INSTALLED) return loaded;
  const view = maskViewChecklist(loaded.view, loaded.commercialAllowed);
  const vm = toBookingFormVM({ view, form: loaded.form, commercialAllowed: loaded.commercialAllowed, step: opts.step, ownerText: opts.ownerText });
  return { view, vm };
}
