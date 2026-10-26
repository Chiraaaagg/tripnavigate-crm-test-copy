import {
  closeReferralDraftAction,
  createReferralItineraryAction,
  createReferralQuotationAction,
  linkReferralDraftAction,
  reassignReferralDraftAction,
  reopenReferralDraftAction,
  saveReferralDraftAction,
  unlinkReferralDraftAction,
} from '@/modules/quotations/server/referral-actions';
import type { ReferralActions } from '@/views/b12/referral-forms';

/** The server actions behind the referral draft page (Terra, Batch 3 T-3). */
export const REFERRAL_ACTIONS: ReferralActions = {
  save: saveReferralDraftAction,
  close: closeReferralDraftAction,
  reopen: reopenReferralDraftAction,
  reassign: reassignReferralDraftAction,
  link: linkReferralDraftAction,
  unlink: unlinkReferralDraftAction,
};

/** "Create referral quotation" / "Create referral itinerary" (NewWorkScreen, per list kind). */
export const REFERRAL_CREATE = {
  quotations: createReferralQuotationAction,
  itineraries: createReferralItineraryAction,
} as const;
