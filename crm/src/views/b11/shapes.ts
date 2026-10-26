import type {
  BookChecklistItem as ContractChecklistItem,
  BookingActionResult,
  BookNowView as ContractBookNowView,
  BookServiceItemView,
  BookTravellerView,
  ServiceDepartment,
  ServiceType,
} from '@/modules/fulfilment/contracts';
import type { PaymentClaimDisplayStatus, SalesClaimView, SalesPaymentClaims } from '@/modules/finance/contracts';

/*
 * View-side names for the B1.1 screens, pointed at the frozen TS contracts
 * (claude/b11-ts e93d096). Screens import from here so the contract names stay
 * in one place.
 */

export type { BookSection, BookStep, ChangeClass, BookStepStatus } from '@/modules/fulfilment/contracts';
export type BookNowView = ContractBookNowView;
export type BookChecklistItem = ContractChecklistItem;
export type BookItem = BookServiceItemView;
export type BookTraveller = BookTravellerView;
export type BookServiceType = ServiceType;
export type BookDepartment = ServiceDepartment;
export type SalesClaims = SalesPaymentClaims;
export type SalesClaim = SalesClaimView;
export type ClaimDisplayStatus = PaymentClaimDisplayStatus;

/** The answer shape of finance actions (FinanceActionState), loose enough for both declarations of it. */
export interface FinanceLikeState {
  status: 'idle' | 'ok' | 'error';
  message?: string;
  fieldErrors?: Record<string, unknown>;
  code?: string;
}

/** A frozen server action: booking actions answer BookingActionResult, finance actions FinanceActionState. */
export type B11Action = (prev: never, formData: FormData) => Promise<BookingActionResult<unknown> | FinanceLikeState>;

export interface BookActions {
  openDraft: B11Action;
  saveCustomer: B11Action;
  /** B1.2 step 1 · passengers (deal_travellers_save). */
  saveTravellers: B11Action;
  /** B1.2 step 2 · destinations and dates (booking_trip_save, all four keys). */
  saveTripBlock: B11Action;
  /** B1.2 traveller identity proof (outside the booking version's row version). */
  uploadIdProof: B11Action;
  removeIdProof: B11Action;
  saveIdentity: B11Action;
  addServiceItem: B11Action;
  saveServiceItem: B11Action;
  removeServiceItem: B11Action;
  saveParticipants: B11Action;
  savePrice: B11Action;
  savePlan: B11Action;
  reportClaim: B11Action;
  withdrawClaim: B11Action;
  uploadEvidence: B11Action;
  removeEvidence: B11Action;
  submit: B11Action;
  openRevision: B11Action;
  classifyRevision: B11Action;
  discardRevision: B11Action;
  /** B1.2 Bitrix prefill (0600): use Bitrix values, mark checked. */
  /** B1.2 DEC-43: try the Bitrix copy of an ID proof again. */
  retryIdProofCopy?: B11Action;
  usePrefill?: B11Action;
  markPrefillChecked?: B11Action;
  /** Batch 2 (prefill_fill_empty): "Fill empty fields from Bitrix" (inline mode only). */
  fillEmptyPrefill?: B11Action;
  /** Batch 2 (prefill_notice_dismiss): "Keep mine" on a "Bitrix now says …" notice (inline mode only). */
  dismissPrefillNotice?: B11Action;
}
