import {
  acceptQuotationAction,
  convertQuotationAction,
  createQuotationAction,
  declineQuotationAction,
  discardQuotationVersionAction,
  linkQuotationDealAction,
  markQuotationReadyAction,
  markQuotationSentAction,
  newQuotationVersionAction,
  removeQuotationEvidenceAction,
  removeQuotationItemAction,
  saveQuotationContactAction,
  saveQuotationContentAction,
  saveQuotationDetailsAction,
  saveQuotationItemAction,
  saveQuotationTiersAction,
  uploadQuotationEvidenceAction,
} from '@/modules/quotations/server/actions';
import { saveQuotationCostEstimatesAction, saveQuotationLinesAction, saveQuotationPlanAction, saveQuotationTierTotalAction } from '@/modules/quotations/server/money-actions';
import { dismissPrefillNoticeAction, fillEmptyPrefillAction, markPrefillCheckedAction, usePrefillAction } from '@/modules/fulfilment/server/book-now-prefill-actions';
import type { B11Action } from '@/views/b11/shapes';
import type { QuoteActions } from '@/views/b12/quote-kit';

/** The server actions behind every quotation screen (Terra, terra-b12-quotations-handoff §4). */
export const QUOTE_ACTIONS: QuoteActions = {
  create: createQuotationAction,
  saveDetails: saveQuotationDetailsAction,
  saveContact: saveQuotationContactAction,
  saveContent: saveQuotationContentAction,
  saveTiers: saveQuotationTiersAction,
  saveItem: saveQuotationItemAction,
  removeItem: removeQuotationItemAction,
  markReady: markQuotationReadyAction,
  markSent: markQuotationSentAction,
  uploadEvidence: uploadQuotationEvidenceAction,
  removeEvidence: removeQuotationEvidenceAction,
  accept: acceptQuotationAction,
  decline: declineQuotationAction,
  newVersion: newQuotationVersionAction,
  discard: discardQuotationVersionAction,
  linkDeal: linkQuotationDealAction,
  convert: convertQuotationAction,
  saveLines: saveQuotationLinesAction,
  saveTierTotal: saveQuotationTierTotalAction,
  savePlan: saveQuotationPlanAction,
  saveCostEstimates: saveQuotationCostEstimatesAction,
  usePrefill: usePrefillAction as unknown as B11Action,
  markPrefillChecked: markPrefillCheckedAction as unknown as B11Action,
  // Batch 2 (inline mode only): "Fill empty fields from Bitrix" and "Keep mine".
  fillEmptyPrefill: fillEmptyPrefillAction as unknown as B11Action,
  dismissPrefillNotice: dismissPrefillNoticeAction as unknown as B11Action,
};
