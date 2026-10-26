/*
 * Passenger counts and passenger slots (Terra, voice-note batch, 24 October
 * 2026). Pure functions; no server imports, so the screens (Luna) and the
 * server actions use the same rules. The database stays authoritative.
 *
 * Owner rules (work order items 1 and 2):
 *   - adults + children + infants must equal the trip's total passengers
 *     (from the Deal in Bitrix when it has one, else entered once on the
 *     booking). A larger or inconsistent split is refused with plain words;
 *     the typed counts stay on the screen;
 *   - passenger rows of the right types appear automatically ("slots"); an
 *     empty slot is only a place to type a name and is never saved;
 *   - a passenger is created only when named; reopening, saving or changing
 *     counts never duplicates a passenger;
 *   - lowering a count never deletes a named passenger or their documents:
 *     the extra passengers stay and are listed until staff remove one
 *     explicitly or change the counts back.
 */

import { PAX_TOTAL_MAX } from './booking-form-contract';
import type { TravellerDetails, TravellerType } from './contracts';

// ---------------------------------------------------------------------------
// Count rule
// ---------------------------------------------------------------------------

export interface PassengerCounts {
  total: number | null;
  adults: number | null;
  children: number | null;
  infants: number | null;
}

export type CountIssueCode = 'total_missing' | 'total_range' | 'count_range' | 'split_over_total' | 'split_under_total' | 'split_incomplete';

export interface CountIssue {
  code: CountIssueCode;
  /** Form field to mark (paxTotal | adults | children | infants). */
  field: 'paxTotal' | 'adults' | 'children' | 'infants';
  text: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The count rule. No total and nobody counted (all empty, or 0) is allowed (a
 * draft without counts, e.g. a contact-only save; readiness asks for them). Otherwise the total is needed and the three counts must add
 * up to it exactly. `totalFromDeal` only changes the wording (the total is
 * then corrected in Bitrix or with "Correct", not typed here).
 */
export function countIssues(c: PassengerCounts, opts: { totalFromDeal?: boolean } = {}): CountIssue[] {
  const issues: CountIssue[] = [];
  const { total, adults, children, infants } = c;
  // No total and no one counted (empty, or the 0 the steppers start at) = no counts yet: a contact-only
  // save goes through (gate run 2026-10-24: a contact save was refused with "Enter the total" on 0/0).
  if (total === null && !adults && !children && !infants) return issues;
  for (const [field, v] of [
    ['adults', adults],
    ['children', children],
    ['infants', infants],
  ] as const) {
    if (v !== null && (!Number.isSafeInteger(v) || v < 0 || v > PAX_TOTAL_MAX)) issues.push({ code: 'count_range', field, text: `Enter a whole number from 0 to ${PAX_TOTAL_MAX}.` });
  }
  if (total === null) {
    issues.push({ code: 'total_missing', field: 'paxTotal', text: 'Enter the total number of passengers first.' });
    return issues;
  }
  if (!Number.isSafeInteger(total) || total < 1 || total > PAX_TOTAL_MAX) {
    issues.push({ code: 'total_range', field: 'paxTotal', text: `Total passengers must be 1 to ${PAX_TOTAL_MAX}.` });
    return issues;
  }
  if (issues.length > 0) return issues;
  const sum = (adults ?? 0) + (children ?? 0) + (infants ?? 0);
  const fix = opts.totalFromDeal ? `Change the counts so they add up to ${total}. If the total on the Deal is wrong, use Correct.` : `Change the counts so they add up to ${total}.`;
  if (sum > total) {
    issues.push({ code: 'split_over_total', field: 'adults', text: `Adults, children and infants add up to ${sum}, but the trip has ${plural(total, 'passenger', 'passengers')}. ${fix}` });
  } else if (adults === null) {
    issues.push({ code: 'split_incomplete', field: 'adults', text: `Enter the number of adults. Adults, children and infants must add up to ${total}.` });
  } else if (sum < total) {
    issues.push({ code: 'split_under_total', field: 'adults', text: `Adults, children and infants add up to ${sum}, but the trip has ${plural(total, 'passenger', 'passengers')}. ${fix}` });
  }
  return issues;
}

/**
 * Adults when staff left the box empty: total − children − infants, when that
 * is 0 or more (the same derivation the booking used before adults had its
 * own box). null when it cannot be worked out.
 */
export function derivedAdults(c: Pick<PassengerCounts, 'total' | 'children' | 'infants'>): number | null {
  if (c.total === null) return null;
  const a = c.total - (c.children ?? 0) - (c.infants ?? 0);
  return a >= 0 ? a : null;
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export interface NamedPassenger {
  seq: number;
  type: TravellerType;
  fullName: string;
  /** Identity details or ID-proof files exist (shown when a removal is asked for). */
  hasDetails?: boolean;
}

export type PassengerSlot =
  | { kind: 'named'; key: string; type: TravellerType; seq: number; fullName: string; overCount: boolean }
  | { kind: 'empty'; key: string; type: TravellerType; position: number };

export interface SlotPlan {
  /** Adults first, then children, then infants; named passengers in seq order, then empty places. */
  slots: PassengerSlot[];
  /** Named passengers beyond their type's count: kept, flagged, never deleted. */
  overCount: NamedPassenger[];
  /** Plain words for the over-count case (null when none). */
  overCountText: string | null;
}

const TYPE_ORDER: readonly TravellerType[] = ['adult', 'child', 'infant'];
const TYPE_WORD: Record<TravellerType, [string, string]> = { adult: ['adult', 'adults'], child: ['child', 'children'], infant: ['infant', 'infants'] };

/**
 * The passenger rows the card shows for the saved counts. Empty places carry
 * a stable key (type + position) so a re-render never duplicates them; they
 * are never posted unless staff type a name.
 */
export function passengerSlots(counts: Pick<PassengerCounts, 'adults' | 'children' | 'infants'>, named: readonly NamedPassenger[]): SlotPlan {
  const want: Record<TravellerType, number> = { adult: Math.max(0, counts.adults ?? 0), child: Math.max(0, counts.children ?? 0), infant: Math.max(0, counts.infants ?? 0) };
  const slots: PassengerSlot[] = [];
  const overCount: NamedPassenger[] = [];
  for (const type of TYPE_ORDER) {
    const ofType = named.filter((p) => p.type === type).sort((a, b) => a.seq - b.seq);
    ofType.forEach((p, i) => {
      const over = i >= want[type];
      if (over) overCount.push(p);
      slots.push({ kind: 'named', key: `p-${p.seq}`, type, seq: p.seq, fullName: p.fullName, overCount: over });
    });
    for (let pos = ofType.length + 1; pos <= want[type]; pos += 1) slots.push({ kind: 'empty', key: `${type}-${pos}`, type, position: pos });
  }
  let overCountText: string | null = null;
  if (overCount.length > 0) {
    const parts = TYPE_ORDER.flatMap((t) => {
      const n = named.filter((p) => p.type === t).length;
      return n > want[t] ? [`${plural(n, TYPE_WORD[t][0], TYPE_WORD[t][1])} named but the count says ${want[t]}`] : [];
    });
    overCountText = `${parts.join('; ')}. Nobody was removed. Remove a passenger or change the counts.`;
  }
  return { slots, overCount, overCountText };
}

// ---------------------------------------------------------------------------
// Save plan (server side, before deal_travellers_save, which replaces the list)
// ---------------------------------------------------------------------------

export interface StoredTraveller {
  seq: number;
  fullName: string;
  type: TravellerType;
  hasDetails?: boolean;
}

export type TravellerSavePlan =
  | { ok: true; travellers: TravellerDetails[]; removed: number[]; created: number[] }
  | { ok: false; code: 'removal_unconfirmed'; seqs: number[]; text: string }
  | { ok: false; code: 'duplicate_passenger'; seqs: number[]; text: string }
  | { ok: false; code: 'removal_conflict'; seqs: number[]; text: string };

const nameKey = (n: string) => n.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Checks one passengers save against what is stored. The database command
 * replaces the whole list (a stored passenger missing from the post is
 * deleted with their details), so:
 *   - a stored passenger missing from the post must be named in `removeSeqs`
 *     (an explicit "Remove passenger"), otherwise nothing is saved;
 *   - two passengers with the same name and type in one save are refused
 *     (a reopened or double-posted slot never creates a second person);
 *     real namesakes are told to add a middle name or initial (Echo-A L8 ruling);
 *   - a removal that is also posted is refused (which one is meant?).
 * Posted rows are only named rows (the parser drops empty slots).
 */
export function planTravellerSave(input: { stored: readonly StoredTraveller[]; posted: readonly TravellerDetails[]; removeSeqs: readonly number[] }): TravellerSavePlan {
  const postedSeqs = new Set(input.posted.map((t) => t.seq));
  const remove = new Set(input.removeSeqs);
  const conflict = [...remove].filter((s) => postedSeqs.has(s));
  if (conflict.length > 0) return { ok: false, code: 'removal_conflict', seqs: conflict, text: 'A passenger was both kept and removed. Reload the page and try again. Nothing was saved.' };
  const missing = input.stored.filter((t) => !postedSeqs.has(t.seq) && !remove.has(t.seq)).map((t) => t.seq);
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'removal_unconfirmed',
      seqs: missing,
      text: `${missing.length === 1 ? 'A named passenger is' : `${missing.length} named passengers are`} missing from this save. Passengers are removed only with Remove passenger. Reload the page to see everyone. Nothing was saved.`,
    };
  }
  const seen = new Map<string, number>();
  const dupes: number[] = [];
  for (const t of input.posted) {
    const k = `${t.type}\u0000${nameKey(t.fullName)}`;
    const first = seen.get(k);
    if (first !== undefined) dupes.push(t.seq);
    else seen.set(k, t.seq);
  }
  if (dupes.length > 0) return { ok: false, code: 'duplicate_passenger', seqs: dupes, text: 'Two passengers have the same name. If they are two different people, add a middle name or an initial to one of them (for example "Ravi K Sharma"). Nothing was saved.' };
  const storedSeqs = new Set(input.stored.map((t) => t.seq));
  return {
    ok: true,
    travellers: [...input.posted].sort((a, b) => a.seq - b.seq),
    removed: input.stored.filter((t) => remove.has(t.seq)).map((t) => t.seq),
    created: input.posted.filter((t) => !storedSeqs.has(t.seq)).map((t) => t.seq),
  };
}
