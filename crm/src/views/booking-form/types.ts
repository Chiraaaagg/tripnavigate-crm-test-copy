import type { BitrixRefreshOutcome } from '@/modules/fulfilment/booking-form-contract';
import type { BookingFormVM } from '@/modules/fulfilment/booking-form-vm';
import type { BookingActionResult } from '@/modules/fulfilment/contracts';
import type { PrefillUiVM } from '@/modules/fulfilment/prefill-contract';
import type { BookLinks } from '../b11/book-screen';
import type { B11Action, BookActions, BookNowView } from '../b11/shapes';
import type { VoiceNoteProps } from './vn-types';

/*
 * Props of the booking form screen (lead freeze, 22 October 2026; contract
 * docs/implementation/booking-form-2026-10-22/contract.md). Types only, so
 * client components may import this file.
 */

export type FormStep = 'travellers' | 'stay' | 'finish';
export const FORM_STEPS: readonly FormStep[] = ['travellers', 'stay', 'finish'];

/** The existing Book now actions plus the commands added for the booking form. */
export interface BookingFormActions extends BookActions {
  /** booking_service_save: item facts, estimate, budget and participation in one transaction. */
  saveService: B11Action;
  /** Flight screenshot (service_item_file_begin/finish). */
  uploadServiceFile: B11Action;
  removeServiceFile: B11Action;
  /** booking_prices_save (four per-person lines). */
  savePrices: B11Action;
  /** Extended booking_billing_propose. */
  saveBillTo: B11Action;
  /**
   * Book now v2 (build-plan.md §5.1). Optional in this type until the server
   * wiring (book-actions.ts, Agent B / C) lands; the screen hides the matching
   * control while one is absent.
   * booking_flight_fares_save. FormData: dealId, versionId, rowVersion, requestId,
   * fareAdultTotalRupees, fareChildTotalRupees, fareInfantTotalRupees.
   */
  saveFlightFares?: B11Action;
  /** booking_flight_returns_add. FormData: dealId, versionId, rowVersion, requestId. */
  addReturnFlights?: B11Action;
  /** "Refresh from Bitrix now": reads this one Deal from Bitrix at once (never writes to Bitrix). */
  refreshFromBitrix?: (dealId: string) => Promise<BookingActionResult<{ outcome: BitrixRefreshOutcome; readAt: string | null; retryAfterSeconds?: number }>>;
}

export interface BookingFormScreenProps {
  /** Terra's view model (booking-form-vm.ts): BookingFormCore plus the routed checklist. */
  vm: BookingFormVM;
  view: BookNowView;
  actions: BookingFormActions;
  links: BookLinks;
  prefillUi?: PrefillUiVM | null;
  ownerText?: string | null;
  /** Voice-note batch extras (Deal trip facts, stored hotel and customer search); absent = today's screen. */
  vn?: VoiceNoteProps;
}
