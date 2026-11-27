import 'server-only';
import { z } from 'zod';
import { dealPaymentClaims, FinanceCommandError, isFinanceFunctionMissing } from '@/modules/finance/commands';
import type { SalesPaymentClaims } from '@/modules/finance/contracts';
import type { StaffContext } from '@/modules/identity/server/session';
import { canReadDealCommercial } from '@/modules/access/policy';
import { bitrixIdProofCopyStatus, bookingFormGet, bookingPanelB11, bookingVersionHistory, type BookingFormRecord, type HistoryRowRecord, type IdProofCopyStatusRecord } from '../b11-commands';
import { toBookNowView, withIdProofCopies } from '../b11-dto';
import { asRpcClient, BookingCommandError, intakeChecklist, isFunctionMissing, type RpcClient } from '../commands';
import type { BookNowPart, BookNowView, IntakeChecklist } from '../contracts';
import { dealHeader } from './intake';

/**
 * The one read behind /app/deals/[id]/book and /book/[step] (freeze note §5):
 * booking_form_get (B1.2: incl. sourceQuotation) + booking_panel (gate,
 * readiness, Accounts review, revision) + intake_checklist +
 * deal_payment_claims + booking_version_history + bitrix_id_proof_copy_status,
 * all under the viewer's own session. Returns:
 *   - a BookNowView;
 *   - null for a malformed id, a Deal that is not visible, or a viewer who
 *     neither edits nor accepts the booking (Purchase, Flight, the desk,
 *     Accounts): the same answer for all;
 *   - 'not_installed' when the database has no booking_form_get yet
 *     (PGRST202 / 42883): the route falls back to the B1 intake screen.
 *
 * Required reads (booking_form_get, booking_panel, the Deal header) fail the
 * load. The four optional parts (checklist, payment claims, history, ID-proof
 * copy status) never do (booking reliability B1-3): a refusal or a missing
 * function leaves the part out, as before; any other failure leaves it out
 * AND names it in view.partsNotLoaded, so the screen says it did not load
 * instead of losing the whole form. A session failure (ended JWT) still
 * propagates and fails the load.
 */

type Staff = Pick<StaffContext, 'supabase' | 'access'>;

export const BOOK_NOW_NOT_INSTALLED = 'not_installed' as const;

const REFUSED = new Set(['not_authorized', 'not_found']);

function isRefusal(error: unknown): boolean {
  return error instanceof BookingCommandError && error.code !== null && REFUSED.has(error.code);
}

function isSessionFailure(error: unknown): boolean {
  return (error instanceof BookingCommandError || error instanceof FinanceCommandError) && error.code === 'session';
}

/** "Did not load" for an optional part: the part is left out and named. */
const NOT_LOADED = Symbol('not_loaded');
type Optional<T> = T | null | typeof NOT_LOADED;

/**
 * Runs one optional reader. `absent(error)` says which errors mean "not
 * available to this viewer or not installed" (null, as before). A session
 * failure rethrows; anything else is "did not load".
 */
async function optional<T>(read: () => Promise<T | null>, absent: (error: unknown) => boolean): Promise<Optional<T>> {
  try {
    return await read();
  } catch (error) {
    if (absent(error)) return null;
    if (isSessionFailure(error)) throw error;
    return NOT_LOADED;
  }
}

const bookingAbsent = (error: unknown) => isRefusal(error) || isFunctionMissing(error);

function financeAbsent(error: unknown): boolean {
  if (isFinanceFunctionMissing(error)) return true;
  return error instanceof FinanceCommandError && (error.code === 'not_authorized' || error.code === 'not_found');
}

function optionalChecklist(rpc: RpcClient, dealId: string): Promise<Optional<IntakeChecklist>> {
  return optional(() => intakeChecklist(rpc, dealId), bookingAbsent);
}

function optionalHistory(rpc: RpcClient, dealId: string): Promise<Optional<HistoryRowRecord[]>> {
  return optional(() => bookingVersionHistory(rpc, dealId), bookingAbsent);
}

/** DEC-43 copy status (0700): optional; nothing on an older database or for a non-editor. */
function optionalCopyStatus(rpc: RpcClient, dealId: string): Promise<Optional<IdProofCopyStatusRecord>> {
  return optional(() => bitrixIdProofCopyStatus(rpc, dealId), bookingAbsent);
}

function optionalClaims(rpc: RpcClient, dealId: string): Promise<Optional<SalesPaymentClaims>> {
  return optional(() => dealPaymentClaims(rpc, dealId), financeAbsent);
}

/** Splits optional results into the values toBookNowView takes and the parts that did not load. */
function collectOptionalParts<C, P, H, I>(parts: { checklist: Optional<C>; claims: Optional<P>; history: Optional<H>; idProofCopies: Optional<I> }): {
  checklist: C | null;
  claims: P | null;
  history: H | null;
  idProofCopies: I | null;
  partsNotLoaded: BookNowPart[];
} {
  const partsNotLoaded: BookNowPart[] = [];
  const take = <T>(part: BookNowPart, value: Optional<T>): T | null => {
    if (value === NOT_LOADED) {
      partsNotLoaded.push(part);
      return null;
    }
    return value;
  };
  return {
    checklist: take('checklist', parts.checklist),
    claims: take('claims', parts.claims),
    history: take('history', parts.history),
    idProofCopies: take('idProofCopies', parts.idProofCopies),
    partsNotLoaded,
  };
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
    const [panel, checklist, claims, history, idProofCopies] = await Promise.all([
      bookingPanelB11(rpc, id.data),
      optionalChecklist(rpc, id.data),
      optionalClaims(rpc, id.data),
      optionalHistory(rpc, id.data),
      optionalCopyStatus(rpc, id.data),
    ]);
    const parts = collectOptionalParts({ checklist, claims, history, idProofCopies });
    const view = withIdProofCopies(
      toBookNowView({ viewer: staff.access, deal, form, panel, checklist: parts.checklist, claims: parts.claims, history: parts.history, partsNotLoaded: parts.partsNotLoaded }),
      parts.idProofCopies,
    );
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
