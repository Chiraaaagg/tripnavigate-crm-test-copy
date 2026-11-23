import type { FlightMoney, MoneyBatch } from '@/views/flight/types';
import type { FlightBatchCancellation, FlightBatchCancellationKeys } from './types';

/*
 * Pure helpers for the Flight "Trip cancelled" panel (server and client safe;
 * the panel itself is a client component).
 */

export type CancelledBatch = MoneyBatch & FlightBatchCancellationKeys & { cancellation: FlightBatchCancellation };

/** Ticket batches the money read sent a cancellation block for (none = no panel). */
export function cancelledBatches(money: FlightMoney | null | 'error'): CancelledBatch[] {
  if (!money || money === 'error') return [];
  return (money.batches as Array<MoneyBatch & FlightBatchCancellationKeys>).filter((b): b is CancelledBatch => !!b.cancellation);
}
