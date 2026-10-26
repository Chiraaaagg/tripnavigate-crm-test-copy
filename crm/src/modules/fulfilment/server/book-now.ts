import 'server-only';
import { z } from 'zod';
import { dealPaymentClaims, FinanceCommandError, isFinanceFunctionMissing } from '@/modules/finance/commands';
import type { SalesPaymentClaims } from '@/modules/finance/contracts';
import type { StaffContext } from '@/modules/identity/server/session';
import { canReadDealCommercial } from '@/modules/access/policy';
import { bitrixIdProofCopyStatus, bookingFormGet, bookingPanelB11, bookingVersionHistory, type BookingFormRecord, type HistoryRowRecord, type IdProofCopyStatusRecord } from '../b11-commands';
import { toBookNowView, withIdProofCopies } from '../b11-dto';
import { asRpcClient, BookingCommandError, intakeChecklist, isFunctionMissing, type RpcClient } from '../commands';
import type { BookNowView, IntakeChecklist } from '../contracts';
import { dealHeader } from './intake';

/**
 * The one read behind /app/deals/[id]/book and /book/[step] (freeze note §5):
 * booking_form_get (B1.2: incl. sourceQuotation) + booking_panel (gate,
 * readiness, Accounts review, revision) + intake_checklist +
 * deal_payment_claims + booking_version_history,
 * all under the viewer's own session. Returns:
 *   - a BookNowView;
 *   - null for a malformed id, a Deal that is not visible, or a viewer who
 *     neither edits nor accepts the booking (Purchase, Flight, the desk,
 *     Accounts): the same answer for all;
 *   - 'not_installed' when the database has no booking_form_get yet
 *     (PGRST202 / 42883): the route falls back to the B1 intake screen.
 * Optional parts (claims before 0200, history before 0300) are left out when
 * their function is missing or refused; an unexplained failure throws.
 */

type Staff = Pick<StaffContext, 'supabase' | 'access'>;

export const BOOK_NOW_NOT_INSTALLED = 'not_installed' as const;

const REFUSED = new Set(['not_authorized', 'not_found']);

function isRefusal(error: unknown): boolean {
  return error instanceof BookingCommandError && error.code !== null && REFUSED.has(error.code);
}

async function optionalChecklist(rpc: RpcClient, dealId: string): Promise<IntakeChecklist | null> {
  try {
    return await intakeChecklist(rpc, dealId);
  } catch (error) {
    if (isRefusal(error) || isFunctionMissing(error)) return null;
    throw error;
  }
}

async function optionalHistory(rpc: RpcClient, dealId: string): Promise<HistoryRowRecord[] | null> {
  try {
    return await bookingVersionHistory(rpc, dealId);
  } catch (error) {
    if (isRefusal(error) || isFunctionMissing(error)) return null;
    throw error;
  }
}

/** DEC-43 copy status (0700): optional; nothing on an older database or for a non-editor. */
async function optionalCopyStatus(rpc: RpcClient, dealId: string): Promise<IdProofCopyStatusRecord | null> {
  try {
    return await bitrixIdProofCopyStatus(rpc, dealId);
  } catch (error) {
    if (isRefusal(error) || isFunctionMissing(error)) return null;
    throw error;
  }
}

async function optionalClaims(rpc: RpcClient, dealId: string): Promise<SalesPaymentClaims | null> {
  try {
    return await dealPaymentClaims(rpc, dealId);
  } catch (error) {
    if (isFinanceFunctionMissing(error)) return null;
    if (error instanceof FinanceCommandError && (error.code === 'not_authorized' || error.code === 'not_found')) return null;
    throw error;
  }
}

/** The Book now read plus the raw form record and the commercial decision, for the booking form loader (server/book-form-load.ts). */
export interface BookNowLoad {
  view: BookNowView;
  form: BookingFormRecord;
  /** Same decision toBookNowView used (canReadDealCommercial): may this viewer see prices at all. */
  commercialAllowed: boolean;
}

export async function loadBookNowWithRecord(staff: Staff, dealId: string): Promise<BookNowLoad | null | typeof BOOK_NOW_NOT_INSTALLED> {
  const id = z.uuid().safeParse(dealId);
  if (!id.success) return null;
  const rpc = asRpcClient(staff.supabase);

  let form;
  try {
    form = await bookingFormGet(rpc, id.data);
  } catch (error) {
    if (isFunctionMissing(error)) return BOOK_NOW_NOT_INSTALLED;
    if (isRefusal(error)) return null;
    throw new Error('Could not load the booking form. Please retry.');
  }
  if (!form) return null;

  const deal = await dealHeader(staff, id.data);
  if (!deal) return null;
  try {
    const [panel, checklist, claims, history, copies] = await Promise.all([
      bookingPanelB11(rpc, id.data),
      optionalChecklist(rpc, id.data),
      optionalClaims(rpc, id.data),
      optionalHistory(rpc, id.data),
      optionalCopyStatus(rpc, id.data),
    ]);
    const view = withIdProofCopies(toBookNowView({ viewer: staff.access, deal, form, panel, checklist, claims, history }), copies);
    return { view, form, commercialAllowed: canReadDealCommercial(staff.access, deal) };
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load the booking form. Please retry.');
  }
}

export async function loadBookNow(staff: Staff, dealId: string): Promise<BookNowView | null | typeof BOOK_NOW_NOT_INSTALLED> {
  const loaded = await loadBookNowWithRecord(staff, dealId);
  return loaded === null || loaded === BOOK_NOW_NOT_INSTALLED ? loaded : loaded.view;
}
