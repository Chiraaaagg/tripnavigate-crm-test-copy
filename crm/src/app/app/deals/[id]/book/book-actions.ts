import {
  classifyRevisionAction,
  discardRevisionAction,
  openRevisionAction,
  saveBookCustomerAction,
  saveBookPaymentAction,
  saveBookPriceAction,
  saveBookTravellersAction,
  saveBookTripBlockAction,
  saveParticipationAction,
  saveTravellerIdentityAction,
  startBookNowAction,
  submitBookingAction,
} from '@/modules/fulfilment/server/book-now-actions';
import { removeTravellerIdProofAction, retryIdProofCopyAction, uploadTravellerIdProofAction } from '@/modules/fulfilment/server/id-proof-actions';
import { addServiceItemAction, saveServiceItemAction } from '@/modules/fulfilment/server/intake-actions';
import {
  createPartyBookAction,
  dismissPrefillNoticeBookAction,
  fillEmptyPrefillBookAction,
  markPrefillCheckedBookAction,
  pickPartyBookAction,
  refreshFromBitrixBookAction,
  removeBookingEvidenceBookAction,
  removeServiceItemBookAction,
  reportPaymentClaimBookAction,
  searchHotelsBookAction,
  searchPartiesBookAction,
  uploadBookingEvidenceBookAction,
  applyPrefillBookAction,
  withdrawPaymentClaimBookAction,
} from './book-session-actions';
import {
  removeServiceFileAction,
  saveBillToAction,
  saveBookingCustomerAction,
  saveBookingIdentityAction,
  saveBookingPricesAction,
  saveBookingServiceAction,
  readBookingTravellersAction,
  saveBookingTravellersAction,
  startBookingFormAction,
  uploadServiceFileAction,
} from '@/modules/fulfilment/server/book-form-actions';
import { addReturnFlightsAction, saveFlightFaresAction } from '@/modules/fulfilment/server/flight-fares-actions';
import { stepHrefs } from '@/views/b11/book-fields';
import type { B11Action, BookActions } from '@/views/b11/shapes';
import type { BookingFormVM } from '@/modules/fulfilment/booking-form-vm';
import type { BookingFormActions } from '@/views/booking-form/types';
import type { VoiceNoteProps } from '@/views/booking-form/vn-types';

/**
 * The frozen server actions behind every Book now screen (B1.1 freeze note §5; B1.2 freeze note §2.1 split saves).
 * Booking reliability B1-8 / review P1-1: actions shared with other screens are the Book now copies of
 * book-session-actions.ts, which answer an ended session in the page instead of redirecting it.
 */
export const BOOK_ACTIONS: BookActions = {
  // Prefill results have the booking result shape; their codes also cover quotation targets.
  retryIdProofCopy: retryIdProofCopyAction,
  usePrefill: applyPrefillBookAction as unknown as B11Action,
  markPrefillChecked: markPrefillCheckedBookAction as unknown as B11Action,
  // Batch 2 (inline mode only): "Fill empty fields from Bitrix" and "Keep mine".
  fillEmptyPrefill: fillEmptyPrefillBookAction as unknown as B11Action,
  dismissPrefillNotice: dismissPrefillNoticeBookAction as unknown as B11Action,
  openDraft: startBookNowAction,
  saveCustomer: saveBookCustomerAction,
  saveTravellers: saveBookTravellersAction,
  saveTripBlock: saveBookTripBlockAction,
  uploadIdProof: uploadTravellerIdProofAction,
  removeIdProof: removeTravellerIdProofAction,
  saveIdentity: saveTravellerIdentityAction,
  addServiceItem: addServiceItemAction,
  saveServiceItem: saveServiceItemAction,
  removeServiceItem: removeServiceItemBookAction,
  saveParticipants: saveParticipationAction,
  savePrice: saveBookPriceAction,
  savePlan: saveBookPaymentAction,
  reportClaim: reportPaymentClaimBookAction,
  withdrawClaim: withdrawPaymentClaimBookAction,
  uploadEvidence: uploadBookingEvidenceBookAction,
  removeEvidence: removeBookingEvidenceBookAction,
  submit: submitBookingAction,
  openRevision: openRevisionAction,
  classifyRevision: classifyRevisionAction,
  discardRevision: discardRevisionAction,
};

/**
 * Book now v2 (26 October 2026): the total fare per person of all flights,
 * "Add return flights" (both useActionState shapes: FormData in, ids out) and
 * "Refresh from Bitrix now" (dealId in; reads that one Deal, never writes to
 * Bitrix). Kept as their own object so the screen types gain them in one
 * place (BookingFormActions in views/booking-form/types.ts).
 */
export const BOOKING_FORM_V2_ACTIONS = {
  saveFlightFares: saveFlightFaresAction,
  addReturnFlights: addReturnFlightsAction,
  refreshFromBitrix: refreshFromBitrixBookAction,
};

/**
 * Booking reliability B1-4: "what is saved" for the passengers card after a
 * save whose answer was lost, and before its "Try again" (dealId in; a read
 * that returns passenger numbers, names and types and the draft row version;
 * never writes). Its own object, like the v2 actions, so the screen types
 * gain it in one place (BookingFormActions in views/booking-form/types.ts).
 */
export const BOOKING_FORM_RELIABILITY_ACTIONS = {
  readTravellers: readBookingTravellersAction,
};

/**
 * The booking form (22 October 2026): the Book now actions plus the booking
 * form commands. Start uses booking_form_start (new drafts get the booking
 * form rules); the customer card saves contact, trip and party (billing moved
 * to Bill To in step 3).
 */
export const BOOKING_FORM_ACTIONS: BookingFormActions = {
  ...BOOK_ACTIONS,
  openDraft: startBookingFormAction,
  saveCustomer: saveBookingCustomerAction,
  saveService: saveBookingServiceAction,
  // Review round 1: the older item commands never run behind the booking form (they bypass the
  // v2 rules); the keys stay because BookActions requires them, so they point at the v2 save.
  addServiceItem: saveBookingServiceAction,
  saveServiceItem: saveBookingServiceAction,
  uploadServiceFile: uploadServiceFileAction,
  removeServiceFile: removeServiceFileAction,
  savePrices: saveBookingPricesAction,
  saveBillTo: saveBillToAction,
  // Voice-note batch: passengers only when named, never removed implicitly or twice; extra phones.
  saveTravellers: saveBookingTravellersAction,
  saveIdentity: saveBookingIdentityAction,
  // Book now v2
  ...BOOKING_FORM_V2_ACTIONS,
  // Booking reliability fix batch 1
  ...BOOKING_FORM_RELIABILITY_ACTIONS,
};

/**
 * Voice-note batch extras of the booking form screen (luna-vn-props.md):
 * the Deal facts from the view model, the stored hotel search and the stored
 * customer search bound to this Deal. The bound Deal id travels to the
 * browser and back in clear (Next encrypts closure variables only, not
 * .bind() arguments); that is fine because customer_party_search checks
 * that the caller edits that Deal's booking (Echo-A L11). Customers can be
 * added only while the draft is editable.
 */
export function voiceNoteProps(dealId: string, vm: Pick<BookingFormVM, 'dealFacts'>, editable: boolean): VoiceNoteProps {
  return {
    dealFacts: vm.dealFacts ?? null,
    searchHotels: searchHotelsBookAction,
    parties: { search: searchPartiesBookAction.bind(null, dealId), pick: pickPartyBookAction, create: createPartyBookAction as unknown as B11Action, canCreate: editable },
  };
}

export function bookLinks(dealId: string, current: string) {
  const base = `/app/deals/${dealId}/book`;
  return {
    steps: stepHrefs(dealId),
    reload: current,
    deal: `/app/deals/${dealId}`,
    book: base,
  };
}
