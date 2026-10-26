import { reportPaymentClaimAction, withdrawPaymentClaimAction } from '@/modules/finance/server/claim-actions';
import { removeBookingEvidenceAction, uploadBookingEvidenceAction } from '@/modules/fulfilment/server/actions';
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
import { addServiceItemAction, removeServiceItemAction, saveServiceItemAction } from '@/modules/fulfilment/server/intake-actions';
import { dismissPrefillNoticeAction, fillEmptyPrefillAction, markPrefillCheckedAction, usePrefillAction } from '@/modules/fulfilment/server/book-now-prefill-actions';
import {
  removeServiceFileAction,
  saveBillToAction,
  saveBookingCustomerAction,
  saveBookingIdentityAction,
  saveBookingPricesAction,
  saveBookingServiceAction,
  saveBookingTravellersAction,
  startBookingFormAction,
  uploadServiceFileAction,
} from '@/modules/fulfilment/server/book-form-actions';
import { searchHotelsAction } from '@/modules/hotels/server/hotel-actions';
import { createPartyAction, pickPartyAction, searchPartiesAction } from '@/modules/parties/server/party-actions';
import { stepHrefs } from '@/views/b11/book-fields';
import type { B11Action, BookActions } from '@/views/b11/shapes';
import type { BookingFormVM } from '@/modules/fulfilment/booking-form-vm';
import type { BookingFormActions } from '@/views/booking-form/types';
import type { VoiceNoteProps } from '@/views/booking-form/vn-types';

/** The frozen server actions behind every Book now screen (B1.1 freeze note §5; B1.2 freeze note §2.1 split saves). */
export const BOOK_ACTIONS: BookActions = {
  // Prefill results have the booking result shape; their codes also cover quotation targets.
  retryIdProofCopy: retryIdProofCopyAction,
  usePrefill: usePrefillAction as unknown as B11Action,
  markPrefillChecked: markPrefillCheckedAction as unknown as B11Action,
  // Batch 2 (inline mode only): "Fill empty fields from Bitrix" and "Keep mine".
  fillEmptyPrefill: fillEmptyPrefillAction as unknown as B11Action,
  dismissPrefillNotice: dismissPrefillNoticeAction as unknown as B11Action,
  openDraft: startBookNowAction,
  saveCustomer: saveBookCustomerAction,
  saveTravellers: saveBookTravellersAction,
  saveTripBlock: saveBookTripBlockAction,
  uploadIdProof: uploadTravellerIdProofAction,
  removeIdProof: removeTravellerIdProofAction,
  saveIdentity: saveTravellerIdentityAction,
  addServiceItem: addServiceItemAction,
  saveServiceItem: saveServiceItemAction,
  removeServiceItem: removeServiceItemAction,
  saveParticipants: saveParticipationAction,
  savePrice: saveBookPriceAction,
  savePlan: saveBookPaymentAction,
  reportClaim: reportPaymentClaimAction,
  withdrawClaim: withdrawPaymentClaimAction,
  uploadEvidence: uploadBookingEvidenceAction,
  removeEvidence: removeBookingEvidenceAction,
  submit: submitBookingAction,
  openRevision: openRevisionAction,
  classifyRevision: classifyRevisionAction,
  discardRevision: discardRevisionAction,
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
  uploadServiceFile: uploadServiceFileAction,
  removeServiceFile: removeServiceFileAction,
  savePrices: saveBookingPricesAction,
  saveBillTo: saveBillToAction,
  // Voice-note batch: passengers only when named, never removed implicitly or twice; extra phones.
  saveTravellers: saveBookingTravellersAction,
  saveIdentity: saveBookingIdentityAction,
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
    searchHotels: searchHotelsAction,
    parties: { search: searchPartiesAction.bind(null, dealId), pick: pickPartyAction, create: createPartyAction as unknown as B11Action, canCreate: editable },
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
