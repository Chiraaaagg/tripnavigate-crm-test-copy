/*
 * View-side names for the trip-cancellation additions of Accounts phase 2
 * (contract 7.4, Track C). Type-only re-exports of Track C's frozen shapes
 * (`@/modules/cancellations/contracts`), so client components import no
 * runtime code. Flight batches carry `cancellation` / `ticketsCancelled`
 * (flight_money), the Visa workspace `cancellation` (with the company-paid
 * fees and their revision) and applicants `cancellationChoice` /
 * `canChooseCancellation` (visa_workspace), Manager rows `flightCharges` /
 * `chargesKeptPaise` (manager_cancellation_list).
 */

import type {
  CancellationManagerAdditions,
  FlightBatchCancellationView,
  FlightCancellationChargeView,
  VisaCancellationView,
} from '@/modules/cancellations/contracts';

export type { VisaApplicantCancellationKeys } from '@/modules/cancellations/contracts';

export type Paise = string;

export type FlightBatchCancellation = FlightBatchCancellationView;

/** Additive keys on a flight_money batch (optional on the view type so older reads still render). */
export interface FlightBatchCancellationKeys {
  cancellation?: FlightBatchCancellation | null;
  /** A batch of an approved cancellation: the tickets stay as issued, shown cancelled. */
  ticketsCancelled?: boolean;
}

export type VisaCancellationChoice = 'withdraw' | 'finish';

/** visa_workspace `cancellation` (company-paid fees with their refund revision). */
export type VisaWorkspaceCancellation = VisaCancellationView;
export type VisaCancellationFee = VisaCancellationView['fees'][number];

/** manager_cancellation_list additions (M only; null amounts = not entered yet). */
export type ManagerFlightCharge = FlightCancellationChargeView;
export type ManagerCancellationKeys = Partial<CancellationManagerAdditions>;

/** Frozen refusal wording (contract 9, Visa). */
export const TRIP_CANCELLED_VISA_TEXT = 'The trip is cancelled. New fees, applications and payments are stopped.';

/** Paise decimal string → rupees text for an input default ("1250.50"); empty for null. */
export function paiseToRupees(paise: Paise | null | undefined): string {
  if (paise === null || paise === undefined || paise === '') return '';
  try {
    const v = BigInt(paise);
    const neg = v < 0n;
    const a = neg ? -v : v;
    const rem = a % 100n;
    return `${neg ? '-' : ''}${(a / 100n).toString()}${rem === 0n ? '' : `.${rem.toString().padStart(2, '0')}`}`;
  } catch {
    return '';
  }
}
