import { TRAVELLER_TYPES, type TravellerType } from '@/modules/fulfilment/contracts';
import type { PassengerRow } from './passenger-drawer';

/*
 * Passenger rows on screen (voice-note batch, owner item 2). Pure functions,
 * so the slot rules are unit-tested: rows come as slots per type from the
 * adult, child and infant counts; an empty slot is never a passenger; a
 * named or saved passenger is never dropped when a count goes down.
 */

export type PartyCountsTyped = { adults: number | null; children: number | null; infants: number | null };

/** A row that is a passenger (saved, or named on screen); the rest are empty slots. */
export const isRealPassenger = (r: PassengerRow) => r.seq !== null || r.name.trim() !== '';

/** One line on screen: a passenger row (stateIndex) or an empty slot of a type. */
export interface DisplayRow {
  key: string;
  type: TravellerType;
  /** Position among the rows of its type (0-based). */
  pos: number;
  stateIndex: number | null;
  row: PassengerRow | null;
}

/** booking-form-forms.ts REMOVE_TRAVELLER_FIELD (that module is server-side). */
export const REMOVE_TRAVELLER_FIELD = 'removeTravellerSeq';

const COUNT_OF: Record<TravellerType, keyof PartyCountsTyped> = { adult: 'adults', child: 'children', infant: 'infants' };

/**
 * The rows on screen, grouped adult, child, infant: every passenger, then
 * empty slots up to the count of that type. Blank unsaved rows beyond the
 * count are not shown (they are not passengers).
 */
export function displayRows(rows: readonly PassengerRow[], counts: PartyCountsTyped): DisplayRow[] {
  const out: DisplayRow[] = [];
  for (const type of TRAVELLER_TYPES) {
    const want = counts[COUNT_OF[type]] ?? 0;
    let pos = 0;
    rows.forEach((row, stateIndex) => {
      if (row.type !== type) return;
      if (!isRealPassenger(row) && pos >= want) return;
      out.push({ key: row.seq !== null ? `seq-${row.seq}` : (row.key ?? `${type}-slot-${pos}`), type, pos, stateIndex, row });
      pos += 1;
    });
    for (; pos < want; pos += 1) out.push({ key: `${type}-slot-${pos}`, type, pos, stateIndex: null, row: null });
  }
  return out;
}

/** Types with more passengers than their count (named or saved rows only). */
export function overCount(rows: readonly PassengerRow[], counts: PartyCountsTyped): Array<{ type: TravellerType; named: number; booked: number }> {
  return TRAVELLER_TYPES.flatMap((type) => {
    const booked = counts[COUNT_OF[type]] ?? 0;
    const named = rows.filter((r) => r.type === type && isRealPassenger(r)).length;
    return named > booked ? [{ type, named, booked }] : [];
  });
}
