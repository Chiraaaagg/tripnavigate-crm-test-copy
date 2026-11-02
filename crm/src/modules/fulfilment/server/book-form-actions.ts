'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { requireStaff } from '@/modules/identity/server/session';
import {
  bookingBillingPropose,
  bookingCustomerSave,
  bookingFormGet,
  bookingFormInstalled,
  bookingFormStartRaw,
  bookingPricesSave,
  bookingServiceSave,
  bookingTripSave,
  dealTravellersSaveDetails,
  serviceItemFileBegin,
  serviceItemFileFinish,
  serviceItemFileRemove,
  travellerIdentitySave,
} from '../b11-commands';
import { IDENTITY_EXTRA_FIELD, parseBookTravellersForm, parseTravellerIdentityForm } from '../b11-forms';
import type { PricesSaveResult, ServiceSaveResult } from '../booking-form-contract';
import { SERVICE_ITEM_FILE_MAX_BYTES } from '../booking-form-contract';
import {
  BILL_TO_HINTS,
  BOOKING_FORM_FIELD,
  BILL_TO_PARTY_FIELD,
  EXTRA_PHONE_FIELD,
  EXTRA_PHONES_MAX,
  REMOVE_TRAVELLER_FIELD,
  TRAVELLER_REQUESTS_FIELD,
  parseBillToForm,
  parseBookingCustomerForm,
  parseBookingPricesForm,
  parseBookingServiceForm,
  parseItemFileRemoveForm,
  parseItemFileUploadForm,
  priceHintField,
  serviceHintField,
} from '../booking-form-forms';
import { formatInr, normalisePhone } from '../booking-form-model';
import { asRpcClient, BookingCommandError, FUNCTION_MISSING_STATES } from '../commands';
import {
  type BillingProposeResult,
  type BookingActionResult,
  BOOKING_FORM_NOT_INSTALLED_TEXT,
  type DraftSaveResult,
  ERROR_TEXT,
  isSpecialRequestCode,
  SPECIAL_REQUEST_CODES,
  type TravellerIdentitySaveResult,
  UNKNOWN_OUTCOME_TEXT,
} from '../contracts';
import { checkEvidenceFile } from '../evidence';
import { FIELD } from '../forms';
import { bookingStartDraft } from '../prefill-auto';
import type { BookingStartDraftResult } from '../prefill-contract';
import { countIssues, planTravellerSave } from '../passenger-slots';
import { selectBillToParty } from '@/modules/parties/server/parties-db';
import { derivedRequestId, isVnCode, vnFailFrom } from '@/modules/parties/server/party-results';
import { fail, failFrom, failWithConflict, fieldsFromHint, isCode } from './b11-results';

/**
 * Booking form server actions (Terra, 22 October 2026). Every action:
 * requireStaff() (aal2, active staff); parse the frozen form names (never an
 * actor, entity, branch, owner or total); run the database command under the
 * staff member's OWN session, which authorizes, validates, audits and
 * decides. The privileged client is used only to store a file after the
 * database authorized it and chose the object path. Refusals carry frozen
 * wording and the form field names to highlight; typed values stay on the
 * screen. Results carry ids, row versions and hashes only, plus the selling
 * total for the price save (a caller without price access is refused by the
 * database before any amount is read). Signatures fit useActionState.
 */

type Prev<T> = BookingActionResult<T> | null;

const SERVICE_BUCKET = 'service-item-files';

function revalidateBook(dealId: string): void {
  revalidatePath(`/app/deals/${dealId}`);
  revalidatePath(`/app/deals/${dealId}/book`);
  revalidatePath('/app/deals/[id]/book', 'layout'); // the overview, the booking form layout (route group) and its steps
}

function isMissing(error: unknown): boolean {
  return error instanceof BookingCommandError && error.sqlState !== null && FUNCTION_MISSING_STATES.has(error.sqlState);
}

/** Echo M3: a booking form command on a database without the change (the app ships first). Nothing was saved. */
function notInstalled(): BookingActionResult<never> {
  return fail('wrong_state', undefined, BOOKING_FORM_NOT_INSTALLED_TEXT);
}

const SERVICE_SAVED: Record<string, string> = {
  hotel: 'Hotel saved.',
  transfer: 'Car saved.',
  flight: 'Flight saved.',
  activity: 'Activity saved.',
  visa: 'Requirements saved.',
  passport: 'Requirements saved.',
};

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/**
 * "Start booking" in the booking form: booking_form_start (a new draft gets
 * the booking form rules; the creation fill from Bitrix runs only while the
 * prefill_auto_fill switch is on). On a database without it, the existing
 * start (same behaviour as before this release).
 */
export async function startBookingFormAction(_prev: Prev<BookingStartDraftResult>, formData: FormData): Promise<BookingActionResult<BookingStartDraftResult>> {
  const staff = await requireStaff();
  const dealId = formData.get(FIELD.dealId);
  const parsedDeal = typeof dealId === 'string' && /^[0-9a-f-]{36}$/i.test(dealId) ? dealId : null;
  if (!parsedDeal) return fail('invalid_input', [FIELD.dealId]);
  const rpc = asRpcClient(staff.supabase);
  try {
    let result: BookingStartDraftResult;
    try {
      const start = await bookingFormStartRaw(rpc, parsedDeal);
      result = { versionId: start.versionId, versionNo: start.versionNo, rowVersion: start.rowVersion, created: start.created, autoFill: start.autoFill, filled: start.filled, skipped: start.skipped };
    } catch (error) {
      if (!isMissing(error)) throw error;
      result = await bookingStartDraft(rpc, parsedDeal);
    }
    revalidateBook(parsedDeal);
    return { ok: true, data: result, message: result.created ? 'Booking started.' : 'Draft booking opened.' };
  } catch (error) {
    return failFrom(error);
  }
}

// ---------------------------------------------------------------------------
// Step 1 · customer card: contact, then trip and party (two commands)
// ---------------------------------------------------------------------------

const CUSTOMER_HINTS = { contact: FIELD.contactName, customerType: BOOKING_FORM_FIELD.customerType, market: BOOKING_FORM_FIELD.market, requestId: FIELD.requestId, version: FIELD.versionId };
const TRIP_HINTS = {
  trip: FIELD.destination,
  destination: FIELD.destination,
  scope: FIELD.tripScope,
  start: FIELD.tripStart,
  end: FIELD.tripEnd,
  paxTotal: BOOKING_FORM_FIELD.paxTotal,
  adults: BOOKING_FORM_FIELD.adults,
  children: BOOKING_FORM_FIELD.children,
  infants: BOOKING_FORM_FIELD.infants,
  // traveller_count_exceeded names the passenger types whose named rows exceed the new count.
  adult: BOOKING_FORM_FIELD.adults,
  child: BOOKING_FORM_FIELD.children,
  infant: BOOKING_FORM_FIELD.infants,
  version: FIELD.versionId,
};

/** Voice-note batch: the count words of the database refusals (the hint keys tell them apart; never database text). */
const COUNT_TEXT = {
  mismatch: 'Adults, children and infants must add up to the total passengers. Nothing on this card was saved.',
  exceeded:
    'More passengers are already named than these counts allow. Nobody was removed. Remove a passenger on the passengers card first, or keep the counts. Nothing on this card was saved.',
} as const;

/**
 * Echo-A M2: when the counts come from the Bitrix Deal (read-only on the card), the repair is in
 * Bitrix, or removing a passenger here; "change the counts" would be advice staff cannot follow.
 */
const COUNTS_FROM_BITRIX_TEXT =
  'More passengers are already named than the counts allow. These counts come from the Bitrix deal: correct them in Bitrix, or remove a passenger here. Nobody was removed.';

type CountSourced = { tripFacts?: { enabled: boolean; fields: Record<'adults' | 'children' | 'infants', { source: string }> } | null };

/** True when the server takes at least one passenger count from the Bitrix Deal. */
function countsFromBitrix(form: CountSourced | null): boolean {
  const f = form?.tripFacts;
  return f?.enabled === true && (['adults', 'children', 'infants'] as const).some((k) => f.fields[k].source === 'bitrix');
}

/** True when the database has the voice-note booking change (adults count, Deal facts). */
function voiceNotesInstalled(form: { tripFacts?: unknown; party?: { adults?: unknown } | null }): boolean {
  return form.tripFacts !== undefined || form.party?.adults !== undefined;
}

/**
 * "Save customer details": booking_customer_save (contact only; Bill To
 * saves in step 3) then booking_trip_save (destination, scope, dates and the
 * party counts). When the contact saves and the trip does not, the answer
 * says exactly that and carries the new row version (savedRowVersion), so the
 * form's own-save chain stays right.
 */
export async function saveBookingCustomerAction(_prev: Prev<DraftSaveResult>, formData: FormData): Promise<BookingActionResult<DraftSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseBookingCustomerForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const { customer, trip, keepStoredContactExtras, adults } = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  let rowVersion: number;
  let legacyDatabase = false;
  let fromBitrix = false;
  try {
    // One read under the caller's session: is the booking form change installed (Echo M3), and the stored booking-for/payer.
    const form = await bookingFormGet(rpc, customer.dealId);
    if (!form) return fail('not_found');
    fromBitrix = countsFromBitrix(form);
    // Voice-note batch: the count rule before anything is written (typed counts stay on the screen).
    if (adults !== undefined) {
      const totalFromDeal = form.tripFacts?.enabled === true && form.tripFacts.fields.total.source === 'bitrix';
      const [issue] = countIssues({ total: trip.trip.paxTotal ?? null, adults, children: trip.trip.children ?? null, infants: trip.trip.infants ?? null }, { totalFromDeal });
      if (issue) return fail('invalid_input', [BOOKING_FORM_FIELD[issue.field]], `${issue.text} Nothing on this card was saved.`);
      if (voiceNotesInstalled(form)) trip.trip = { ...trip.trip, adults };
    }
    if (keepStoredContactExtras) {
      const stored = form.contacts;
      customer.contact = {
        ...customer.contact,
        bookingFor: stored?.bookingFor ?? 'individual',
        payerDifferent: stored?.payerDifferent ?? false,
        payerName: stored?.payerDifferent ? (stored.payerName ?? null) : null,
      };
    }
    if (!bookingFormInstalled(form)) {
      // An older database refuses unknown keys: send only the fields it knows (the new ones save after the update).
      const { customerType: _t, market: _m, ...contact } = customer.contact;
      const { paxTotal: _p, children: _c, infants: _i, ...tripFields } = trip.trip;
      void [_t, _m, _p, _c, _i];
      customer.contact = contact as typeof customer.contact;
      trip.trip = tripFields as typeof trip.trip;
      legacyDatabase = true;
    }
    const r = await bookingCustomerSave(rpc, {
      versionId: customer.versionId,
      expectedRowVersion: customer.expectedRowVersion,
      contact: customer.contact,
      billing: null,
      billingExpectedRowVersion: 0,
      requestId: customer.requestId,
    });
    rowVersion = r.rowVersion;
  } catch (error) {
    if (isCode(error, 'version_changed')) revalidateBook(customer.dealId);
    return failWithConflict(error, rpc, customer.dealId, CUSTOMER_HINTS);
  }
  try {
    const r = await bookingTripSave(rpc, { versionId: trip.versionId, expectedRowVersion: rowVersion, fields: trip.trip });
    revalidateBook(customer.dealId);
    return {
      ok: true,
      data: r,
      message: legacyDatabase ? 'Customer details saved. Passenger counts, customer type and market save after the database update.' : 'Customer details saved.',
    };
  } catch (error) {
    revalidateBook(customer.dealId);
    const refusal = failFrom(error, TRIP_HINTS);
    if (refusal.ok) return refusal;
    const hints = error instanceof BookingCommandError ? error.hintKeys : [];
    const exceeded = hints.some((k) => k === 'adult' || k === 'child' || k === 'infant');
    const countWords = exceeded ? (fromBitrix ? COUNTS_FROM_BITRIX_TEXT : COUNT_TEXT.exceeded) : hints.includes('adults') ? COUNT_TEXT.mismatch : null;
    if (countWords) return { ...refusal, savedRowVersion: rowVersion, message: `Saved: contact details. Not saved: trip dates and passenger counts. ${countWords.replace(' Nothing on this card was saved.', '')}` };
    return { ...refusal, savedRowVersion: rowVersion, message: `Saved: contact details. Not saved: trip dates and passenger counts (${refusal.message})` };
  }
}

/** Older database only: a hotel without adults takes the booking's adults (saved count, else total − children − infants, else named adults). */
const HOTEL_ADULTS_TEXT = 'Enter the passenger counts on step 1 first. The hotel takes its adults from them. Nothing was saved.';

function bookingAdults(form: { party?: { total?: number | null; children?: number | null; infants?: number | null; adults?: number | null } | null; travellers: ReadonlyArray<{ type: string }> }): number | null {
  const p = form.party;
  if (p?.adults && p.adults > 0) return p.adults;
  if (p?.total) {
    const derived = p.total - (p.children ?? 0) - (p.infants ?? 0);
    if (derived > 0) return derived;
  }
  const named = form.travellers.filter((t) => t.type === 'adult').length;
  return named > 0 ? named : null;
}

// ---------------------------------------------------------------------------
// Step 2 · one service (one transaction)
// ---------------------------------------------------------------------------

/** "Save hotel / car / flight / …": booking_service_save (item, estimate and who takes part together; nothing saves partly). */
export async function saveBookingServiceAction(_prev: Prev<ServiceSaveResult>, formData: FormData): Promise<BookingActionResult<ServiceSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseBookingServiceForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    let facts = v.facts.facts as unknown as Record<string, unknown>;
    // Voice-note batch: a hotel without the adults box, or with a stored hotel picked. The database
    // with this change takes the booking's adults itself; an older one needs a value (worked out here
    // from the saved counts, never invented) and does not know catalogueHotelId.
    if (v.serviceType === 'hotel' && (v.adultsFromBooking || v.catalogueHotelId !== undefined)) {
      const form = await bookingFormGet(rpc, v.dealId);
      if (!form) return fail('not_found');
      const installed = voiceNotesInstalled(form);
      if (installed && v.catalogueHotelId) facts = { ...facts, catalogueHotelId: v.catalogueHotelId };
      if (v.adultsFromBooking && !installed) {
        const adults = bookingAdults(form);
        if (adults === null) return fail('invalid_input', [BOOKING_FORM_FIELD.paxTotal], HOTEL_ADULTS_TEXT);
        facts = { ...facts, adults };
      }
    }
    const result = await bookingServiceSave(rpc, {
      versionId: v.versionId,
      expectedRowVersion: v.expectedRowVersion,
      itemId: v.itemId,
      serviceType: v.serviceType,
      facts,
      purchaseBudgetPaise: v.budgetPaise,
      estimate: v.estimate,
      participants: v.participantSeqs,
      requestId: v.requestId,
    });
    revalidateBook(v.dealId);
    revalidatePath('/app/purchase');
    revalidatePath('/app/flight');
    const saved = SERVICE_SAVED[v.serviceType] ?? 'Service saved.';
    return { ok: true, data: result, message: v.thenAttach && v.serviceType === 'flight' ? 'Flight saved. Now attach the ticket screenshot.' : saved };
  } catch (error) {
    if (isMissing(error)) return notInstalled();
    if (isCode(error, 'version_changed')) revalidateBook(v.dealId);
    // A hotel with no counts and no adult passengers yet (the database never stores a hotel without adults).
    if (error instanceof BookingCommandError && error.code === 'invalid_input' && error.hintKeys.includes('paxTotal')) {
      return fail('invalid_input', [BOOKING_FORM_FIELD.paxTotal], HOTEL_ADULTS_TEXT);
    }
    if (error instanceof BookingCommandError && error.code === 'invalid_input' && error.hintKeys.length > 0) {
      return fail('invalid_input', [...new Set(error.hintKeys.map(serviceHintField))]);
    }
    return failWithConflict(error, rpc, v.dealId);
  }
}

// ---------------------------------------------------------------------------
// Step 2 · flight screenshot (private item file)
// ---------------------------------------------------------------------------

const FILE_TEXT = {
  uploaded: 'Screenshot attached.',
  tooBig: 'This file is over 4 MB. Nothing was uploaded.',
  badType: 'Use a PDF, JPG, PNG or WebP file. Nothing was uploaded.',
  removed: 'Screenshot removed.',
  removeSwitchedOff: 'Service items are switched off for this CRM, so the screenshot was not removed. An admin can switch them on.',
  removeDealNotActive: 'This deal is lost or rejected in Bitrix, so the booking cannot change. The screenshot was not removed.',
  stillUploading: 'This screenshot is still uploading. Reload the page in a moment.',
} as const;

function fileName(file: Blob): string {
  return 'name' in file && typeof file.name === 'string' ? file.name : '';
}

/**
 * "Attach flight screenshot": size, declared type and magic bytes checked
 * first; service_item_file_begin under the staff member's own session
 * (authorizes, caps 5 per item, generates the object path); only then the
 * privileged client stores the bytes in the private bucket; finish records
 * 'stored' only when the object exists with the declared size. An exact
 * retry never uploads or finishes twice.
 */
export async function uploadServiceFileAction(_prev: Prev<{ fileId: string }>, formData: FormData): Promise<BookingActionResult<{ fileId: string }>> {
  const staff = await requireStaff();
  const parsed = parseItemFileUploadForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  const file = formData.get(FIELD.file);
  if (!(file instanceof Blob) || file.size === 0) return fail('evidence_rejected', [FIELD.file], FILE_TEXT.badType);
  if (file.size > SERVICE_ITEM_FILE_MAX_BYTES) return fail('evidence_rejected', [FIELD.file], FILE_TEXT.tooBig);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkEvidenceFile({ bytes, declaredMime: file.type, fileName: fileName(file) });
  if (!check.ok || check.sizeBytes > SERVICE_ITEM_FILE_MAX_BYTES) return fail('evidence_rejected', [FIELD.file], FILE_TEXT.badType);

  const rpc = asRpcClient(staff.supabase);
  let begun;
  try {
    begun = await serviceItemFileBegin(rpc, { itemId: v.itemId, versionId: v.versionId, kind: v.kind, fileName: check.fileName, mime: check.mime, sizeBytes: check.sizeBytes, sha256: check.sha256, requestId: v.requestId });
  } catch (error) {
    if (isMissing(error)) return notInstalled();
    const refusal = failFrom(error, { requestId: FIELD.requestId, kind: FIELD.kind, file: FIELD.file });
    if (!refusal.ok && refusal.code === 'evidence_rejected') return { ...refusal, message: FILE_TEXT.badType, fields: [FIELD.file] };
    return refusal;
  }
  if (begun.outcome === 'existing') {
    revalidateBook(v.dealId);
    if (begun.status === 'stored') return { ok: true, data: { fileId: begun.fileId }, message: FILE_TEXT.uploaded };
    if (begun.status === 'pending_upload') return fail('upload_failed', undefined, FILE_TEXT.stillUploading);
    return fail('upload_failed');
  }
  if (begun.objectPath === null) return fail('upload_failed', undefined, UNKNOWN_OUTCOME_TEXT);

  // The database authorized the actor and generated the object path: only now the privileged client.
  let stored = false;
  try {
    const upload = await createSupabaseAdminClient().storage.from(SERVICE_BUCKET).upload(begun.objectPath, bytes, { contentType: check.mime, upsert: false });
    stored = !upload.error;
  } catch {
    stored = false;
  }
  let status: string | null;
  try {
    status = (await serviceItemFileFinish(rpc, begun.fileId, stored)).status;
  } catch {
    // The finish may have committed; never claim an outcome we did not see.
    status = null;
  }
  revalidateBook(v.dealId);
  if (status === 'stored') return { ok: true, data: { fileId: begun.fileId }, message: FILE_TEXT.uploaded };
  if (status === 'failed') return fail('upload_failed');
  return fail('upload_failed', undefined, UNKNOWN_OUTCOME_TEXT);
}

/** "Remove" a flight screenshot (soft removal; the file's own row version is read under the caller's session). */
export async function removeServiceFileAction(_prev: Prev<{ fileId: string }>, formData: FormData): Promise<BookingActionResult<{ fileId: string }>> {
  const staff = await requireStaff();
  const parsed = parseItemFileRemoveForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    // Echo L4: the row version the screen showed guards a stale screen (never re-read here).
    const result = await serviceItemFileRemove(rpc, { fileId: v.fileId, expectedRowVersion: v.expectedRowVersion });
    revalidateBook(v.dealId);
    return { ok: true, data: { fileId: result.fileId }, message: FILE_TEXT.removed };
  } catch (error) {
    if (isMissing(error)) return notInstalled();
    if (isCode(error, 'version_changed')) revalidateBook(v.dealId);
    // Echo review A L7: removal is refused like an upload while service items are off or the Deal is lost.
    if (isCode(error, 'service_items_disabled')) return fail('service_items_disabled', undefined, FILE_TEXT.removeSwitchedOff);
    if (isCode(error, 'deal_not_active')) return fail('deal_not_active', undefined, FILE_TEXT.removeDealNotActive);
    return failWithConflict(error, rpc, v.dealId);
  }
}

// ---------------------------------------------------------------------------
// Step 3 · prices
// ---------------------------------------------------------------------------

/**
 * "Save prices": booking_prices_save. The database checks the categories
 * against the party, derives the markup and recomputes the selling total in
 * the same transaction; the browser never sends a total. Commercial readers
 * only (the database refuses everyone else before reading an amount).
 */
export async function saveBookingPricesAction(_prev: Prev<PricesSaveResult>, formData: FormData): Promise<BookingActionResult<PricesSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseBookingPricesForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields, ERROR_TEXT.invalid_input);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    const result = await bookingPricesSave(rpc, { versionId: v.versionId, expectedRowVersion: v.expectedRowVersion, lines: v.lines, requestId: v.requestId });
    revalidateBook(v.dealId);
    const missing = v.lines.filter((l) => l.quantity > 0).reduce((n, l) => n + [l.purchasePaise, l.markupPaise, l.salePaise].filter((x) => x === null).length, 0);
    const message =
      result.sellingTotalPaise !== null
        ? `Prices saved. Package selling total ${formatInr(result.sellingTotalPaise)}.`
        : missing > 0
          ? `Prices saved. Total not worked out yet: ${missing} ${missing === 1 ? 'amount' : 'amounts'} still missing.`
          : 'Prices saved. Total not worked out yet.';
    return { ok: true, data: result, message };
  } catch (error) {
    if (isMissing(error)) return notInstalled();
    if (isCode(error, 'version_changed')) revalidateBook(v.dealId);
    if (isCode(error, 'not_authorized')) return fail('not_authorized', undefined, 'You can’t change the prices on this deal. Ask the deal owner.');
    if (error instanceof BookingCommandError && error.code === 'invalid_input' && error.hintKeys.length > 0) {
      return fail('invalid_input', [...new Set(error.hintKeys.map(priceHintField))]);
    }
    return failWithConflict(error, rpc, v.dealId);
  }
}

// ---------------------------------------------------------------------------
// Step 3 · Bill To
// ---------------------------------------------------------------------------

/** "Save Bill To": the extended billing proposal (a draft for Accounts; Sales never verifies). */
export async function saveBillToAction(_prev: Prev<BillingProposeResult>, formData: FormData): Promise<BookingActionResult<BillingProposeResult>> {
  const staff = await requireStaff();
  const parsed = parseBillToForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  // Voice-note batch: the stored customer picked or added ('' or absent = typed by hand).
  const partyRaw = formData.get(BILL_TO_PARTY_FIELD);
  const partyId = typeof partyRaw === 'string' && partyRaw.trim() !== '' ? partyRaw.trim().toLowerCase() : null;
  if (partyId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(partyId)) return fail('invalid_input', [BILL_TO_PARTY_FIELD]);
  const rpc = asRpcClient(staff.supabase);
  try {
    // Echo M3: an older database refuses the Bill To keys; say so instead of an unexplained refusal.
    const form = await bookingFormGet(rpc, v.dealId);
    if (!form) return fail('not_found');
    if (!bookingFormInstalled(form)) return notInstalled();
    let billingRowVersion = v.billingExpectedRowVersion;
    if (partyId !== null && form.billing.partyId !== partyId) {
      // A newly picked customer: the database copies it into this Deal's billing (a snapshot that
      // keeps the reference) under the caller's session; the typed edits below then save on top.
      if (!form.version || form.version.status !== 'draft') return fail('wrong_state');
      try {
        const picked = await selectBillToParty(rpc, {
          versionId: form.version.versionId,
          expectedRowVersion: form.version.rowVersion,
          partyId,
          billingExpectedRowVersion: v.billingExpectedRowVersion,
          requestId: derivedRequestId(v.requestId, 'select-party'),
        });
        billingRowVersion = picked.billing.rowVersion;
      } catch (error) {
        if (isVnCode(error, 'billing_verified') || isVnCode(error, 'version_changed')) revalidateBook(v.dealId);
        return vnFailFrom(error, BILL_TO_HINTS);
      }
    }
    const result = await bookingBillingPropose(rpc, { dealId: v.dealId, expectedRowVersion: billingRowVersion, fields: v.fields, requestId: v.requestId });
    revalidateBook(v.dealId);
    return { ok: true, data: result, message: 'Bill To saved. Accounts checks it before use.' };
  } catch (error) {
    if (isCode(error, 'version_changed') || isCode(error, 'billing_verified')) revalidateBook(v.dealId);
    if (isCode(error, 'billing_verified')) {
      return fail('billing_verified', undefined, 'Accounts has already checked these Bill To details, so they can’t be changed here. Ask Accounts. Nothing on this step was saved.');
    }
    if (error instanceof BookingCommandError && error.code === 'invalid_input') return fail('invalid_input', fieldsFromHint(error.hintKeys, BILL_TO_HINTS));
    return failWithConflict(error, rpc, v.dealId, BILL_TO_HINTS);
  }
}

// ---------------------------------------------------------------------------
// Step 1 · passengers (voice-note batch: slots, no duplicates, explicit removal, standard requests)
// ---------------------------------------------------------------------------


const PASSENGER_TEXT = {
  saved: 'Passengers saved.',
  exceeded: 'More passengers are named than the adult, child and infant counts allow. Change the counts on the customer card first, or remove a passenger. Nothing was saved.',
  badRequest: 'Choose special requests from the list. Nothing was saved.',
} as const;

/** Rows the travellers parser keeps (it skips a row with no name, type, age or needs), with their requests. */
function readRowRequests(formData: FormData): { rows: Array<string[] | null>; invalid: number[] } {
  const all = (n: string) => formData.getAll(n).map((v) => (typeof v === 'string' ? v : ''));
  const names = all(FIELD.travellerName);
  const types = all(FIELD.travellerType);
  const ages = all(FIELD.travellerAge);
  const needs = all(FIELD.travellerNeeds);
  const requests = all(TRAVELLER_REQUESTS_FIELD);
  const count = Math.max(names.length, types.length, ages.length, needs.length);
  const rows: Array<string[] | null> = [];
  const invalid: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if ([names[i], types[i], ages[i], needs[i]].every((x) => (x ?? '').trim() === '')) continue;
    const codes = (requests[i] ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c !== '');
    if (codes.some((c) => !isSpecialRequestCode(c)) || codes.length > SPECIAL_REQUEST_CODES.length) invalid.push(i);
    rows.push([...new Set(codes)]);
  }
  return { rows, invalid };
}

function readRemoveSeqs(formData: FormData): number[] | null {
  const out: number[] = [];
  for (const v of formData.getAll(REMOVE_TRAVELLER_FIELD)) {
    if (typeof v !== 'string' || !/^[1-9][0-9]{0,2}$/.test(v.trim()) || Number(v) > 100) return null;
    out.push(Number(v));
  }
  return [...new Set(out)];
}

/**
 * "Save passengers" in the booking form. The database command replaces the
 * whole list (a passenger left out is deleted with their details and ID
 * proofs), so before it runs: every saved passenger must be in the post or
 * removed on purpose (REMOVE_TRAVELLER_FIELD), and one person is never
 * entered twice. Only named rows are posted (empty slots never create a
 * passenger). Standard requests ride along when the database has them.
 */
export async function saveBookingTravellersAction(_prev: Prev<DraftSaveResult>, formData: FormData): Promise<BookingActionResult<DraftSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseBookTravellersForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  const removeSeqs = readRemoveSeqs(formData);
  if (removeSeqs === null) return fail('invalid_input', [REMOVE_TRAVELLER_FIELD]);
  const withRequests = formData.has(TRAVELLER_REQUESTS_FIELD);
  const requests = withRequests ? readRowRequests(formData) : null;
  if (requests && requests.invalid.length > 0) return fail('invalid_input', requests.invalid.map((i) => `${TRAVELLER_REQUESTS_FIELD}[${i}]`), PASSENGER_TEXT.badRequest);
  const rpc = asRpcClient(staff.supabase);
  let fromBitrix = false;
  try {
    const form = await bookingFormGet(rpc, v.dealId);
    if (!form) return fail('not_found');
    fromBitrix = countsFromBitrix(form);
    const plan = planTravellerSave({ stored: form.travellers.map((t) => ({ seq: t.seq, fullName: t.fullName, type: t.type })), posted: v.travellers, removeSeqs });
    if (!plan.ok) {
      revalidateBook(v.dealId);
      const fields = plan.code === 'duplicate_passenger' ? v.travellers.flatMap((t, i) => (plan.seqs.includes(t.seq) ? [`${FIELD.travellerName}[${i}]`] : [])) : [FIELD.travellerName];
      return fail('invalid_input', fields, plan.text);
    }
    // An older database refuses the requests key: send it only when its read carries requests.
    const dbHasRequests = form.travellers.some((t) => t.specialRequests !== undefined) || voiceNotesInstalled(form);
    const byIndex = new Map(v.travellers.map((t, i) => [t.seq, requests?.rows[i] ?? null]));
    const travellers = plan.travellers.map((t) => {
      const codes = byIndex.get(t.seq);
      return dbHasRequests && codes ? { ...t, specialRequests: codes.filter(isSpecialRequestCode) } : t;
    });
    const result = await dealTravellersSaveDetails(rpc, { dealId: v.dealId, expectedRowVersion: v.expectedRowVersion, travellers });
    revalidateBook(v.dealId);
    const removed = plan.removed.length;
    return { ok: true, data: result, message: removed > 0 ? `Passengers saved. ${removed === 1 ? '1 passenger was' : `${removed} passengers were`} removed as you asked.` : PASSENGER_TEXT.saved };
  } catch (error) {
    if (isCode(error, 'version_changed')) revalidateBook(v.dealId);
    if (error instanceof BookingCommandError && error.code === 'invalid_input' && error.hintKeys.some((k) => k === 'adult' || k === 'child' || k === 'infant')) {
      return fail('invalid_input', [FIELD.travellerName], fromBitrix ? `${COUNTS_FROM_BITRIX_TEXT} Nothing was saved.` : PASSENGER_TEXT.exceeded);
    }
    return failWithConflict(error, rpc, v.dealId, { travellers: FIELD.travellerName, version: FIELD.versionId, specialRequests: TRAVELLER_REQUESTS_FIELD });
  }
}


function readExtraPhones(formData: FormData): { phones: string[]; bad: number[] } | null {
  const raw = formData.getAll(EXTRA_PHONE_FIELD).map((v) => (typeof v === 'string' ? v : ''));
  const phones: string[] = [];
  const bad: number[] = [];
  raw.forEach((r, i) => {
    const t = r.replace(/[\s()-]/g, '');
    if (t === '') return;
    const p = normalisePhone(t);
    if (typeof p !== 'string') bad.push(i);
    else if (!phones.includes(p)) phones.push(p);
  });
  if (phones.length > EXTRA_PHONES_MAX) return null;
  return { phones, bad };
}

/**
 * Passenger Details save in the booking form: identity (as before) plus the
 * optional extra phone numbers. Date of birth and marriage date stay
 * optional (the passport rule for international flights is the database's,
 * unchanged). Extras the database does not have yet are not sent (and the
 * answer says they save after the update).
 */
export async function saveBookingIdentityAction(_prev: Prev<TravellerIdentitySaveResult>, formData: FormData): Promise<BookingActionResult<TravellerIdentitySaveResult>> {
  const staff = await requireStaff();
  const parsed = parseTravellerIdentityForm(formData);
  const extras = formData.has(EXTRA_PHONE_FIELD) ? readExtraPhones(formData) : undefined;
  const extraFields = extras === null ? [EXTRA_PHONE_FIELD] : (extras?.bad ?? []).map((i) => `${EXTRA_PHONE_FIELD}[${i}]`);
  if (!parsed.ok || extraFields.length > 0) return fail('invalid_input', [...(parsed.ok ? [] : parsed.fields), ...extraFields]);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    let deferred = false;
    const { dateOfMarriage, phone, email, ...core } = v.fields;
    let fields: typeof v.fields & { extraPhones?: string[] } = v.fields;
    const sendsExtras = dateOfMarriage !== undefined || phone !== undefined || email !== undefined || extras !== undefined;
    if (sendsExtras) {
      const form = await bookingFormGet(rpc, v.dealId);
      if (form && !bookingFormInstalled(form)) {
        fields = core;
        deferred = true;
      } else if (form && extras) {
        if (voiceNotesInstalled(form)) fields = { ...fields, extraPhones: extras.phones };
        else deferred = extras.phones.length > 0;
      }
    }
    const result = await travellerIdentitySave(rpc, { ...v, fields });
    revalidateBook(v.dealId);
    const message = 'Passenger details saved. They are visible only to the people who need them.';
    return { ok: true, data: result, message: deferred ? `${message} Some new details (extra phones or marriage date) save after the database update.` : message };
  } catch (error) {
    if (isCode(error, 'version_changed')) revalidateBook(v.dealId);
    return failFrom(error, { identity: FIELD.dateOfBirth, dateOfMarriage: IDENTITY_EXTRA_FIELD.dateOfMarriage, phone: IDENTITY_EXTRA_FIELD.phone, email: IDENTITY_EXTRA_FIELD.email, extraPhones: EXTRA_PHONE_FIELD });
  }
}
