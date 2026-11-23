import { describe, expect, it } from 'vitest';
import * as contracts from '@/modules/flight/contracts';
import * as moneyContracts from '@/modules/flight/money-contracts';

/**
 * Flight build, contract sections 6.3 (refusal tokens and frozen staff
 * messages), 7 (checklist labels and status words) and 10 (CRS labels).
 * The export names inside contracts.ts / money-contracts.ts are not frozen,
 * so this test reads every exported value (objects, maps, arrays, strings)
 * and checks that the frozen token -> message pairs and labels are present.
 */

type Pairs = Map<string, Set<string>>;
/** Every (key -> string value) pair reachable from the module exports. */
function collect(value: unknown, into: Pairs = new Map(), seen = new Set<unknown>()): Pairs {
  if (value === null || typeof value !== 'object' || seen.has(value)) return into;
  seen.add(value);
  const add = (k: string, v: unknown) => {
    if (typeof v === 'string') {
      if (!into.has(k)) into.set(k, new Set());
      into.get(k)!.add(v);
    }
  };
  if (value instanceof Map) {
    for (const [k, v] of value) {
      add(String(k), v);
      collect(v, into, seen);
    }
    return into;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    add(k, v);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      // { token: { message: '...' } } shapes.
      for (const inner of ['message', 'text', 'label', 'staffMessage']) add(k, o[inner]);
      collect(v, into, seen);
    }
  }
  return into;
}
/** Every string reachable from the exports (labels kept in arrays). */
function strings(value: unknown, out = new Set<string>(), seen = new Set<unknown>()): Set<string> {
  if (typeof value === 'string') out.add(value);
  else if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    const entries = value instanceof Map ? [...value.values()] : Object.values(value as Record<string, unknown>);
    for (const v of entries) strings(v, out, seen);
  }
  return out;
}
const pairs = collect({ ...contracts, ...moneyContracts });
const all = strings({ ...contracts, ...moneyContracts });

const MESSAGES: Record<string, string> = {
  not_authorized: 'You cannot do this on this flight.',
  not_found: 'This item is no longer available. Reload the page.',
  version_changed: 'Someone changed this flight meanwhile. Reload and try again.',
  duplicate_request: 'This was already sent with different details. Reload the page.',
  task_conflict: 'Another Flight colleague took these flights first.',
  invalid_input: 'Check the highlighted field.',
  not_ready: 'Finish the steps listed before doing this.',
  booking_changed: 'Sales sent a new booking. Review "Booking changed" first.',
  traveller_not_on_sector: 'A chosen traveller is not on that flight.',
  held_by_change: 'This traveller is waiting for a change decision.',
  already_confirmed: 'This traveller already has a ticket on that flight.',
  no_difference: 'Change at least one detail. It is the same as the current flight.',
  duplicate_flight: 'These travellers are already on this exact flight.',
  not_self_approval: 'You cannot approve your own request.',
  already_decided: 'This was already decided. Reload the page.',
  ticket_number_taken: 'This ticket number already belongs to another traveller.',
  discount_over_fare: 'The discount is more than the fare.',
  over_budget: 'The supplier cost is above the approved budget. Ask the Manager to approve these fares.',
  fare_approval_mismatch: 'The fares changed after the Manager approved them. Ask again.',
  not_over_budget: 'These fares are within the budget. No approval is needed.',
  payment_in_progress: 'A payment for these tickets already exists.',
  direct_payment_over_limit: 'Above ₹50,000 for this supplier on this Deal, raise a payment request.',
  receipt_required: 'Attach the payment proof first.',
  cost_locked: 'This payment record is with Accounts and cannot be changed now.',
  trip_cancelled: 'This trip is cancelled. No new tickets or payments.',
  duplicate_supplier: 'A supplier with this name already exists.',
};
const CHECKLIST: Record<string, string> = {
  booking_changed: 'Booking changes reviewed',
  travellers_unnamed: 'Every traveller is named',
  traveller_without_flight: 'Every traveller has a flight',
  change_pending: 'No change waiting for approval',
  tickets_pending: 'Every traveller confirmed on every active flight',
  traveller_changed: 'Ticket names match the booking',
  fare_approval_pending: 'No fares waiting for the Manager',
  payment_missing: 'Every ticket batch is paid or has an approved payment request',
  payment_returned: 'No payment returned by Accounts',
  eticket_missing: 'E-tickets attached',
};
const CRS: Record<string, string> = { amadeus: 'Amadeus', galileo: 'Galileo', sabre: 'Sabre', airline_direct: 'Airline direct', other: 'Other' };

describe('frozen refusal messages (section 6.3)', () => {
  for (const [token, message] of Object.entries(MESSAGES)) {
    it(`${token}: "${message}"`, () => {
      expect([...(pairs.get(token) ?? [])], `no exported message for ${token}`).toContain(message);
    });
  }
});

describe('checklist labels (section 7) and CRS labels (section 10)', () => {
  for (const [token, label] of Object.entries(CHECKLIST)) {
    it(`${token}: "${label}"`, () => {
      expect([...(pairs.get(token) ?? []), ...(all.has(label) ? [label] : [])]).toContain(label);
    });
  }
  for (const [code, label] of Object.entries(CRS)) {
    it(`CRS ${code}: "${label}"`, () => {
      expect([...(pairs.get(code) ?? [])]).toContain(label);
    });
  }
});

describe('status words (section 7)', () => {
  it('Waiting, All tickets confirmed and Done · ticket issued are frozen strings; DEC-59 wording is gone', () => {
    for (const w of ['Waiting', 'All tickets confirmed', 'Done · ticket issued']) expect(all.has(w), w).toBe(true);
    expect([...all].some((s) => /Confirmed by supplier/.test(s))).toBe(false);
  });
});
