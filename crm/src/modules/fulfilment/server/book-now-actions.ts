'use server';

import { revalidatePath } from 'next/cache';
import { requireStaff } from '@/modules/identity/server/session';
import {
  bookingClassifyRevision,
  bookingCommercialsSave,
  bookingCustomerSave,
  bookingDiscardDraft,
  bookingInstalmentsSave,
  bookingOpenRevision,
  bookingFormGet,
  bookingFormInstalled,
  bookingTripSave,
  dealTravellersSaveDetails,
  serviceItemTravellersSave,
  submitBooking,
  travellerIdentitySave,
} from '../b11-commands';
import {
  parseBookCustomerForm,
  parseBookPlanForm,
  parseBookPriceForm,
  parseBookTravellersForm,
  parseBookTripBlockForm,
  parseBookTripForm,
  parseClassifyRevisionForm,
  parseOpenRevisionForm,
  parseParticipationForm,
  parseSubmitBookingForm,
  parseTravellerIdentityForm,
  parseVersionRowForm,
  IDENTITY_EXTRA_FIELD,
} from '../b11-forms';
import { asRpcClient, BookingCommandError, readiness } from '../commands';
import { bookingStartDraft } from '../prefill-auto';
import type { BookingStartDraftResult } from '../prefill-contract';
import {
  type BookingActionResult,
  type BookingCustomerSaveResult,
  type ClassifyRevisionResult,
  type DiscardDraftResult,
  type DraftSaveResult,
  ERROR_TEXT,
  INTAKE_CONFIRM_EXISTING_TEXT,
  INTAKE_CONFIRM_NO_TASK_TEXT,
  INTAKE_CONFIRM_SUCCESS_TEXT,
  type OpenRevisionResult,
  REVISION_DISCARD_SUCCESS_TEXT,
  type SubmitBookingResult,
  type TravellerIdentitySaveResult,
} from '../contracts';
import { FIELD, readUuid } from '../forms';
import { fail, failFrom, failWithConflict, isCode } from './b11-results';

/**
 * Book now server actions (freeze note §5, appendix D §5.3 renamed). Every
 * action: requireStaff() (aal2, active staff); parse the form (frozen FIELD
 * names; never actor, entity, branch or ownership); run the database command
 * under the staff member's OWN session — the database authorizes, validates,
 * audits and decides. No privileged client here. Refusals carry frozen
 * ERROR_TEXT wording, `fields` for invalid input and, on version_changed,
 * `conflict` (who saved, when). Signatures fit useActionState.
 */

type Prev<T> = BookingActionResult<T> | null;

// B0-14: the reassurance stays once at Start booking and in the submit dialog.
const SAVED = 'Saved.';
const REVISION_SAVED_TEXT = 'The fixed booking replaced the returned version, which stays in history. Accounts will check it. No new task was created.';

function revalidateBook(dealId: string): void {
  revalidatePath(`/app/deals/${dealId}`);
  revalidatePath(`/app/deals/${dealId}/intake`);
  revalidatePath(`/app/deals/${dealId}/book`);
  revalidatePath('/app/deals/[id]/book', 'layout'); // the overview, the booking form layout (route group) and its steps
}

const CUSTOMER_HINTS = { contact: FIELD.contactName, city: FIELD.billingCity, billing: FIELD.billingName, requestId: FIELD.requestId, version: FIELD.versionId };
const TRIP_HINTS = { trip: FIELD.destination, scope: FIELD.tripScope, start: FIELD.tripStart, end: FIELD.tripEnd, travellers: FIELD.travellerName, version: FIELD.versionId };
const IDENTITY_HINTS = { identity: FIELD.dateOfBirth, dateOfMarriage: IDENTITY_EXTRA_FIELD.dateOfMarriage, phone: IDENTITY_EXTRA_FIELD.phone, email: IDENTITY_EXTRA_FIELD.email };
const PARTICIPATION_HINTS = { travellers: FIELD.participantSeq };
const PRICE_HINTS = { totalPaise: FIELD.sellingTotalRupees, listPaise: FIELD.listRupees, discountPaise: FIELD.discountRupees };
const PLAN_HINTS = { instalments: FIELD.instalmentLabel };

/**
 * Book now: start (or reopen) the package draft. Batch 2: booking_start_draft
 * (the creation fill from Bitrix runs inside the same transaction only when
 * the prefill_auto_fill switch is on and the draft is new); on a database
 * without migration A the wrapper falls back to booking_open_draft. The
 * message never announces a fill (copy BP-12: fields show their marker).
 */
export async function startBookNowAction(_prev: Prev<BookingStartDraftResult>, formData: FormData): Promise<BookingActionResult<BookingStartDraftResult>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FIELD.dealId);
  if (!dealId) return fail('invalid_input', [FIELD.dealId]);
  try {
    const result = await bookingStartDraft(asRpcClient(staff.supabase), dealId);
    revalidateBook(dealId);
    return { ok: true, data: result, message: result.created ? 'Booking started.' : 'Draft booking opened.' };
  } catch (error) {
    return failFrom(error);
  }
}

/** Step 1 · customer: contacts and (when filled) the billing proposal, in one transaction (booking_customer_save). */
export async function saveBookCustomerAction(
  _prev: Prev<BookingCustomerSaveResult>,
  formData: FormData,
): Promise<BookingActionResult<BookingCustomerSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseBookCustomerForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    const result = await bookingCustomerSave(rpc, {
      versionId: v.versionId,
      expectedRowVersion: v.expectedRowVersion,
      contact: v.contact,
      billing: v.billing,
      billingExpectedRowVersion: v.billingExpectedRowVersion,
      requestId: v.requestId,
    });
    revalidateBook(v.dealId);
    const billing = result.billing ? ' Billing details sent to Accounts as a proposal; Accounts verifies them.' : '';
    const replay = result.replayed ? ' (already saved; nothing changed)' : '';
    return { ok: true, data: result, message: `${SAVED}${billing}${replay}` };
  } catch (error) {
    if (isCode(error, 'version_changed') || isCode(error, 'billing_verified')) revalidateBook(v.dealId);
    return failWithConflict(error, rpc, v.dealId, CUSTOMER_HINTS);
  }
}

/**
 * B1.1 step 2 (kept for one release; no B1.2 screen posts it): trip block,
 * then the traveller list (two commands, in that order).
 * When the trip saves and the travellers do not, the message says exactly
 * that; the typed values stay on screen.
 */
export async function saveBookTripAction(_prev: Prev<DraftSaveResult>, formData: FormData): Promise<BookingActionResult<DraftSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseBookTripForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  let trip: DraftSaveResult;
  try {
    trip = await bookingTripSave(rpc, { versionId: v.versionId, expectedRowVersion: v.expectedRowVersion, fields: v.trip });
  } catch (error) {
    if (isCode(error, 'version_changed')) revalidateBook(v.dealId);
    return failWithConflict(error, rpc, v.dealId, TRIP_HINTS);
  }
  try {
    const result = await dealTravellersSaveDetails(rpc, { dealId: v.dealId, expectedRowVersion: trip.rowVersion, travellers: v.travellers });
    revalidateBook(v.dealId);
    return { ok: true, data: result, message: SAVED };
  } catch (error) {
    revalidateBook(v.dealId);
    const refusal = failFrom(error, TRIP_HINTS);
    if (refusal.ok) return refusal;
    return { ...refusal, message: `Trip details saved. The travellers were not saved: ${refusal.message}` };
  }
}

const TRAVELLERS_HINTS = { travellers: FIELD.travellerName, version: FIELD.versionId };
const TRIP_BLOCK_HINTS = { trip: FIELD.destination, destination: FIELD.destination, scope: FIELD.tripScope, start: FIELD.tripStart, end: FIELD.tripEnd, version: FIELD.versionId };

/**
 * B1.2 step 1 · passengers: the traveller list only (deal_travellers_save,
 * guarded by the working version's row version). One command, one
 * transaction: saved or refused as a whole.
 */
export async function saveBookTravellersAction(_prev: Prev<DraftSaveResult>, formData: FormData): Promise<BookingActionResult<DraftSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseBookTravellersForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    const result = await dealTravellersSaveDetails(rpc, { dealId: v.dealId, expectedRowVersion: v.expectedRowVersion, travellers: v.travellers });
    revalidateBook(v.dealId);
    return { ok: true, data: result, message: SAVED };
  } catch (error) {
    if (isCode(error, 'version_changed')) revalidateBook(v.dealId);
    return failWithConflict(error, rpc, v.dealId, TRAVELLERS_HINTS);
  }
}

/**
 * B1.2 step 2 · destinations and dates: the trip block only
 * (booking_trip_save replaces all four keys, so the form always posts
 * destination, scope, start and end together).
 */
export async function saveBookTripBlockAction(_prev: Prev<DraftSaveResult>, formData: FormData): Promise<BookingActionResult<DraftSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseBookTripBlockForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    const result = await bookingTripSave(rpc, { versionId: v.versionId, expectedRowVersion: v.expectedRowVersion, fields: v.trip });
    revalidateBook(v.dealId);
    return { ok: true, data: result, message: SAVED };
  } catch (error) {
    if (isCode(error, 'version_changed')) revalidateBook(v.dealId);
    return failWithConflict(error, rpc, v.dealId, TRIP_BLOCK_HINTS);
  }
}

/** Identity details of one traveller (restricted; traveller_identity_save). */
export async function saveTravellerIdentityAction(
  _prev: Prev<TravellerIdentitySaveResult>,
  formData: FormData,
): Promise<BookingActionResult<TravellerIdentitySaveResult>> {
  const staff = await requireStaff();
  const parsed = parseTravellerIdentityForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    // Echo M3: the passenger extras exist only after the booking form database change; an older database refuses them.
    let deferred = false;
    const { dateOfMarriage, phone, email, ...core } = v.fields;
    if (dateOfMarriage !== undefined || phone !== undefined || email !== undefined) {
      const form = await bookingFormGet(rpc, v.dealId);
      if (form && !bookingFormInstalled(form)) {
        v.fields = core;
        deferred = true;
      }
    }
    const result = await travellerIdentitySave(rpc, v);
    revalidateBook(v.dealId);
    const message = 'Identity details saved. They are visible only to the people who need them.';
    return { ok: true, data: result, message: deferred ? `${message} Marriage date and passenger phone or email save after the database update.` : message };
  } catch (error) {
    if (isCode(error, 'version_changed')) revalidateBook(v.dealId);
    return failFrom(error, IDENTITY_HINTS);
  }
}

/** Who takes part in one service (service_item_travellers_save). */
export async function saveParticipationAction(_prev: Prev<DraftSaveResult>, formData: FormData): Promise<BookingActionResult<DraftSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseParticipationForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    const result = await serviceItemTravellersSave(rpc, { itemId: v.itemId, versionId: v.versionId, expectedRowVersion: v.expectedRowVersion, seqs: v.seqs });
    revalidateBook(v.dealId);
    return { ok: true, data: result, message: SAVED };
  } catch (error) {
    if (isCode(error, 'version_changed')) revalidateBook(v.dealId);
    return failWithConflict(error, rpc, v.dealId, PARTICIPATION_HINTS);
  }
}

/** Step 3 · price: list price, discount and the final selling total (commercial readers; booking_commercials_save). */
export async function saveBookPriceAction(_prev: Prev<DraftSaveResult>, formData: FormData): Promise<BookingActionResult<DraftSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseBookPriceForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    const result = await bookingCommercialsSave(rpc, v);
    revalidateBook(v.dealId);
    return { ok: true, data: result, message: SAVED };
  } catch (error) {
    if (isCode(error, 'version_changed')) revalidateBook(v.dealId);
    return failWithConflict(error, rpc, v.dealId, PRICE_HINTS);
  }
}

/** Step 3 · payment: the payment plan only (claims use reportPaymentClaimAction). */
export async function saveBookPaymentAction(_prev: Prev<DraftSaveResult>, formData: FormData): Promise<BookingActionResult<DraftSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseBookPlanForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    const result = await bookingInstalmentsSave(rpc, v);
    revalidateBook(v.dealId);
    return { ok: true, data: result, message: SAVED };
  } catch (error) {
    if (isCode(error, 'version_changed')) revalidateBook(v.dealId);
    return failWithConflict(error, rpc, v.dealId, PLAN_HINTS);
  }
}

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), template);
}

/**
 * Step 3 · review: "Submit booking and create tasks" (booking_confirm). A revision
 * draft is saved as the fixed booking (outcome 'revised', no new task). On
 * not_ready the repair list comes from the side-effect-free readiness read.
 */
export async function submitBookingAction(_prev: Prev<SubmitBookingResult>, formData: FormData): Promise<BookingActionResult<SubmitBookingResult>> {
  const staff = await requireStaff();
  const parsed = parseSubmitBookingForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    const result = await submitBooking(rpc, { versionId: v.versionId, expectedContentHash: v.contentHash });
    revalidateBook(v.dealId);
    revalidatePath('/app/purchase');
    revalidatePath('/app/flight');
    revalidatePath('/app/visa');
    revalidatePath('/app');
    const n = result.taskIds.length;
    const message =
      result.outcome === 'revised'
        ? REVISION_SAVED_TEXT
        : result.outcome === 'existing'
          ? INTAKE_CONFIRM_EXISTING_TEXT
          : n === 0
            ? INTAKE_CONFIRM_NO_TASK_TEXT
            : fill(INTAKE_CONFIRM_SUCCESS_TEXT, { taskCount: n, taskNoun: n === 1 ? 'task' : 'tasks' });
    return { ok: true, data: result, message };
  } catch (error) {
    if (isCode(error, 'not_ready')) {
      const issues = await readiness(rpc, v.versionId)
        .then((r) => r.issues)
        .catch(() => undefined);
      revalidateBook(v.dealId);
      return { ok: false, code: 'not_ready', message: ERROR_TEXT.not_ready, ...(issues ? { issues } : {}) };
    }
    if (isCode(error, 'version_changed')) revalidateBook(v.dealId);
    return failWithConflict(error, rpc, v.dealId);
  }
}

/** "Fix this booking": open (or reopen) the revision draft of a returned version. */
export async function openRevisionAction(_prev: Prev<OpenRevisionResult>, formData: FormData): Promise<BookingActionResult<OpenRevisionResult>> {
  const staff = await requireStaff();
  const parsed = parseOpenRevisionForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  try {
    const result = await bookingOpenRevision(asRpcClient(staff.supabase), parsed.value.baseVersionId);
    revalidateBook(parsed.value.dealId);
    return {
      ok: true,
      data: result,
      message: result.created ? 'Fix started as a new version. The returned version stays in history.' : 'Your fix of this booking is open again.',
    };
  } catch (error) {
    if (error instanceof BookingCommandError && error.code) revalidateBook(parsed.value.dealId);
    return failFrom(error);
  }
}

/** "What kind of change is this?" (booking_classify_revision). */
export async function classifyRevisionAction(
  _prev: Prev<ClassifyRevisionResult>,
  formData: FormData,
): Promise<BookingActionResult<ClassifyRevisionResult>> {
  const staff = await requireStaff();
  const parsed = parseClassifyRevisionForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    const result = await bookingClassifyRevision(rpc, v);
    revalidateBook(v.dealId);
    return { ok: true, data: result, message: 'Kind of change saved.' };
  } catch (error) {
    if (isCode(error, 'not_ready')) return fail('not_ready', undefined, `${ERROR_TEXT.not_ready} Nothing has changed from the returned version.`);
    if (isCode(error, 'version_changed')) revalidateBook(v.dealId);
    return failWithConflict(error, rpc, v.dealId, { changeClass: FIELD.changeClass, version: FIELD.versionId });
  }
}

/** "Discard this revision" (revision drafts only; booking_discard_draft). */
export async function discardRevisionAction(_prev: Prev<DiscardDraftResult>, formData: FormData): Promise<BookingActionResult<DiscardDraftResult>> {
  const staff = await requireStaff();
  const parsed = parseVersionRowForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    const result = await bookingDiscardDraft(rpc, v);
    revalidateBook(v.dealId);
    return { ok: true, data: result, message: REVISION_DISCARD_SUCCESS_TEXT };
  } catch (error) {
    if (isCode(error, 'version_changed')) revalidateBook(v.dealId);
    return failWithConflict(error, rpc, v.dealId);
  }
}
