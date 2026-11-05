import type { BookedLegDTO, BookingDiffDTO } from './contracts';

/**
 * "Booking changed" display helpers (Flight build contract, section 8). The
 * database computes the diff (authz.flight_booking_diff, the same function
 * flight_booking_change_apply uses); these only summarise it for the banner.
 * No amounts are involved.
 */

export type LegChange = 'unchanged' | 'changed' | 'removed' | 'added';

export interface DiffLegRow {
  change: LegChange;
  oldLegNo: number | null;
  newLegNo: number | null;
  old: BookedLegDTO | null;
  new: BookedLegDTO | null;
}

/** Every leg of the diff in new-leg order (removed legs after the leg that took their place). */
export function diffLegRows(diff: BookingDiffDTO): DiffLegRow[] {
  const rows: DiffLegRow[] = [
    ...diff.legs.unchanged.map((l) => ({ change: 'unchanged' as const, oldLegNo: l.oldLegNo, newLegNo: l.newLegNo, old: l.leg, new: l.leg })),
    ...diff.legs.changed.map((l) => ({ change: 'changed' as const, oldLegNo: l.oldLegNo, newLegNo: l.newLegNo, old: l.old, new: l.new })),
    ...diff.legs.added.map((l) => ({ change: 'added' as const, oldLegNo: null, newLegNo: l.newLegNo, old: null, new: l.new })),
    ...diff.legs.removed.map((l) => ({ change: 'removed' as const, oldLegNo: l.oldLegNo, newLegNo: null, old: l.old, new: null })),
  ];
  const key = (r: DiffLegRow) => r.newLegNo ?? (r.oldLegNo ?? 0) + 0.5;
  return rows.sort((a, b) => key(a) - key(b));
}

/** True when applying the new booking keeps every sector, traveller and ticket as it is. */
export function diffIsCosmetic(diff: BookingDiffDTO): boolean {
  return diff.legs.changed.length === 0 && diff.legs.removed.length === 0 && diff.legs.added.length === 0
    && diff.passengers.added.length === 0 && diff.passengers.removed.length === 0 && diff.passengers.renamed.length === 0
    && diff.entryMode.old === diff.entryMode.new;
}

/** Plain lines for the banner ("2 flights changed", "1 traveller removed", ...); empty parts are left out. */
export function diffSummaryLines(diff: BookingDiffDTO): string[] {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const lines: string[] = [];
  if (diff.legs.unchanged.length) lines.push(`${n(diff.legs.unchanged.length, 'flight', 'flights')} unchanged`);
  if (diff.legs.changed.length) lines.push(`${n(diff.legs.changed.length, 'flight', 'flights')} changed`);
  if (diff.legs.removed.length) lines.push(`${n(diff.legs.removed.length, 'flight', 'flights')} removed`);
  if (diff.legs.added.length) lines.push(`${n(diff.legs.added.length, 'flight', 'flights')} added`);
  if (diff.entryMode.old !== diff.entryMode.new) {
    lines.push(diff.entryMode.new === 'screenshot' ? 'Sales now sent this flight as a screenshot' : 'Sales now typed this flight');
  }
  if (diff.passengers.added.length) lines.push(`${n(diff.passengers.added.length, 'traveller', 'travellers')} added`);
  if (diff.passengers.removed.length) lines.push(`${n(diff.passengers.removed.length, 'traveller', 'travellers')} removed`);
  if (diff.passengers.renamed.length) lines.push(`${n(diff.passengers.renamed.length, 'traveller', 'travellers')} renamed`);
  const i = diff.impact;
  if (i.ticketsOnRemoved) lines.push(`${n(i.ticketsOnRemoved, 'ticket is', 'tickets are')} on a flight that is no longer booked`);
  if (i.ticketsOfRemovedTravellers) lines.push(`${n(i.ticketsOfRemovedTravellers, 'ticket belongs', 'tickets belong')} to a removed traveller`);
  if (i.ticketsRenamed) lines.push(`${n(i.ticketsRenamed, 'ticket needs', 'tickets need')} a corrected name`);
  if (i.pendingChangesSuperseded) lines.push(`${n(i.pendingChangesSuperseded, 'waiting change ends', 'waiting changes end')}`);
  if (i.approvedChangesOnChangedLegs.length) {
    lines.push(`Check approved change${i.approvedChangesOnChangedLegs.length === 1 ? '' : 's'} ${i.approvedChangesOnChangedLegs.map((c) => c.changeNo).join(', ')}`);
  }
  return lines;
}
