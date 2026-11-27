'use server';

import { revalidatePath } from 'next/cache';
import { SESSION_ENDED, staffForAction } from '@/modules/identity/server/session';
import { bookingFlightFaresSave, bookingFlightReturnsAdd } from '../b11-commands';
import type { FlightFaresSaveResult, FlightReturnsAddResult } from '../booking-form-contract';
import { faresHintField, parseFlightFaresForm, parseReturnFlightsForm } from '../booking-form-forms';
import { asRpcClient, BookingCommandError, FUNCTION_MISSING_STATES } from '../commands';
import { BOOKING_FORM_NOT_INSTALLED_TEXT, type BookingActionResult, ERROR_TEXT } from '../contracts';
import { type BookRefreshKind, fail, failWithConflict, isCode, refreshAfterDraftSave } from './b11-results';

/**
 * Book now v2 flight actions (26 October 2026). staffForAction() first (an
 * ended session answers `session`, booking reliability B1-8); the
 * database command runs under the staff member's OWN session and authorizes
 * (booking editor of the draft; the fares also need price access), validates,
 * audits (ids only) and decides in one transaction. No privileged client.
 * Results carry ids, item numbers, row versions and hashes only, never an
 * amount. Signatures fit useActionState.
 */

type Prev<T> = BookingActionResult<T> | null;

/** Re-render after an action (booking reliability B1-6): both actions are draft saves and follow the refresh mode. */
function revalidateBook(dealId: string, kind: BookRefreshKind): void {
  if (kind === 'draft_save') {
    refreshAfterDraftSave();
    return;
  }
  revalidatePath(`/app/deals/${dealId}`);
  revalidatePath(`/app/deals/${dealId}/book`);
  revalidatePath('/app/deals/[id]/book', 'layout');
}

function isMissing(error: unknown): boolean {
  return error instanceof BookingCommandError && error.sqlState !== null && FUNCTION_MISSING_STATES.has(error.sqlState);
}

const TEXT = {
  faresSaved: 'Total fare saved.',
  faresNotAllowed: 'You can’t change the fares on this deal. Ask the deal owner.',
  returnsAdded: (n: number) => `${n} return ${n === 1 ? 'flight' : 'flights'} added. Add the flight number and times.`,
  returnsAlready: 'Return flights are already added.',
  returnsNone: 'No typed flight to reverse. Add the return flight from a screenshot.',
  returnsNoTripEnd: 'Set the return date of the trip in step 1 first. Nothing was added.',
  returnsItemsFixed: 'This is a change to an accepted booking, so no flight can be added here. Nothing was added.',
} as const;

/**
 * "Total fare per person, all flights" (typed only for a traveller type no
 * flight prices): booking_flight_fares_save. FormData: dealId, versionId,
 * rowVersion, requestId, fareAdultTotalRupees, fareChildTotalRupees,
 * fareInfantTotalRupees ('' = not typed).
 */
export async function saveFlightFaresAction(_prev: Prev<FlightFaresSaveResult>, formData: FormData): Promise<BookingActionResult<FlightFaresSaveResult>> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return fail('session');
  const parsed = parseFlightFaresForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields, ERROR_TEXT.invalid_input);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    const result = await bookingFlightFaresSave(rpc, { versionId: v.versionId, expectedRowVersion: v.expectedRowVersion, fares: v.fares, requestId: v.requestId });
    // A draft's fares reach the Flight desk only after Submit (a status change that revalidates it).
    revalidateBook(v.dealId, 'draft_save');
    return { ok: true, data: result, message: TEXT.faresSaved };
  } catch (error) {
    if (isMissing(error)) return fail('wrong_state', undefined, BOOKING_FORM_NOT_INSTALLED_TEXT);
    if (isCode(error, 'version_changed')) revalidateBook(v.dealId, 'draft_save');
    if (isCode(error, 'not_authorized')) return fail('not_authorized', undefined, TEXT.faresNotAllowed);
    if (error instanceof BookingCommandError && error.code === 'invalid_input' && error.hintKeys.length > 0) {
      return fail('invalid_input', [...new Set(error.hintKeys.map(faresHintField))]);
    }
    return failWithConflict(error, rpc, v.dealId);
  }
}

/**
 * "Add return flights": booking_flight_returns_add (one transaction). Every
 * typed onward flight is added reversed, dated to the trip end, flagged as a
 * return flight, with the same travellers and no fare. FormData: dealId,
 * versionId, rowVersion, requestId. outcome 'no_typed_flights' = nothing to
 * reverse (the screen opens a screenshot flight marked return).
 */
export async function addReturnFlightsAction(_prev: Prev<FlightReturnsAddResult>, formData: FormData): Promise<BookingActionResult<FlightReturnsAddResult>> {
  const staff = await staffForAction();
  if (staff === SESSION_ENDED) return fail('session');
  const parsed = parseReturnFlightsForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields, ERROR_TEXT.invalid_input);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    const result = await bookingFlightReturnsAdd(rpc, { versionId: v.versionId, expectedRowVersion: v.expectedRowVersion, requestId: v.requestId });
    if (result.outcome === 'added') {
      revalidateBook(v.dealId, 'draft_save');
    }
    const message = result.outcome === 'added' ? TEXT.returnsAdded(result.itemIds.length) : result.outcome === 'already_added' ? TEXT.returnsAlready : TEXT.returnsNone;
    return { ok: true, data: result, message };
  } catch (error) {
    if (isMissing(error)) return fail('wrong_state', undefined, BOOKING_FORM_NOT_INSTALLED_TEXT);
    if (isCode(error, 'version_changed')) revalidateBook(v.dealId, 'draft_save');
    if (isCode(error, 'revision_items_fixed')) return fail('revision_items_fixed', undefined, TEXT.returnsItemsFixed);
    if (error instanceof BookingCommandError && error.code === 'invalid_input' && error.hintKeys.includes('tripEnd')) {
      return fail('invalid_input', ['tripEnd'], TEXT.returnsNoTripEnd);
    }
    return failWithConflict(error, rpc, v.dealId);
  }
}
