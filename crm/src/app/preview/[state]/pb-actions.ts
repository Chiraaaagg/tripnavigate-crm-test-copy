import type { DecisionAction } from '@/views/accounts/supplier-forms';
import type { PurchaseWorkActions } from '@/views/purchase/work-tab';
import {
  pbAddRateAction,
  pbBookingRequestAction,
  pbCancelPaymentAction,
  pbChargeAction,
  pbConfirmAction,
  pbCreatePaymentAction,
  pbDocumentAction,
  pbEmailAction,
  pbSendChargesAction,
  pbUploadAction,
  pbUseFinalRateAction,
} from './pb-preview-actions';

/** Preview stand-ins for every Work and Files tab action (synthetic answers, no database). */
const act = (a: unknown) => a as DecisionAction;

export const PB_ACTIONS: PurchaseWorkActions = {
  addRate: act(pbAddRateAction),
  useFinalRate: act(pbUseFinalRateAction),
  rateRequest: act(pbEmailAction),
  bookingRequest: act(pbBookingRequestAction),
  cancellationCharge: act(pbChargeAction),
  sendCharges: act(pbSendChargesAction),
  createPayment: act(pbCreatePaymentAction),
  resubmitPayment: act(pbCreatePaymentAction),
  cancelPayment: act(pbCancelPaymentAction),
  uploadSupplierFile: act(pbUploadAction),
  confirmSupplier: pbConfirmAction,
};

export const PB_TRIP_CANCEL_ACTION = act(pbChargeAction);
export const PB_DOCUMENT_ACTION = act(pbDocumentAction);
export const PB_UPLOAD_ACTION = act(pbUploadAction);
