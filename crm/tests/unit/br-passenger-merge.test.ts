import { describe, expect, it } from 'vitest';
import {
  adoptSavedNumbers,
  checkLostTravellersSave,
  renamesThatDetachProofs,
  travellersRetryStep,
  type PostedTraveller,
  type SavedTravellersSnapshot,
} from '@/modules/fulfilment/passenger-slots';
import { displayRows, mergePassengerRows, passengersContent, postedTravellers } from '@/views/booking-form/passenger-display';
import type { PassengerRow } from '@/views/booking-form/passenger-drawer';

/*
 * Booking reliability B1-4 (BR-02, BR-03, BR-32) and B1-9 (BR-04), screen
 * side: passenger numbers learned from the save answer by posted position,
 * rows that keep their place, the one read after a lost answer, "Try again"
 * that reads first, and the renames that would remove ID proofs.
 */

const row = (seq: number | null, name: string, type: PassengerRow['type'] = 'adult', key?: string): PassengerRow => ({ seq, name, type, age: '', needs: '', requests: [], ...(key ? { key } : {}) });
const counts = { adults: 3, children: 0, infants: 0 };

describe('passenger numbers from the save answer (B1-4 a)', () => {
  it('writes each number into the row posted at that position', () => {
    const rows = [row(null, 'Asha Rao', 'adult', 'adult-slot-0'), row(null, 'Ravi Rao', 'adult', 'adult-slot-1')];
    const posted = postedTravellers(rows);
    expect(posted.map((p) => p.key)).toEqual(['adult-slot-0', 'adult-slot-1']);
    const next = adoptSavedNumbers(rows, posted, [
      { index: 0, seq: 1, fullName: 'Asha Rao', type: 'adult' },
      { index: 1, seq: 2, fullName: 'Ravi Rao', type: 'adult' },
    ]);
    expect(next.map((r) => r.seq)).toEqual([1, 2]);
    expect(next.map((r) => r.name)).toEqual(['Asha Rao', 'Ravi Rao']);
  });

  it('a row edited during the save keeps its text and gains its number', () => {
    const atSend = [row(null, 'Asha', 'adult', 'adult-slot-0')];
    const posted = postedTravellers(atSend);
    // Typed meanwhile: the name grew and a second passenger was started.
    const now = [row(null, 'Asha Rao', 'adult', 'adult-slot-0'), row(null, 'Ra', 'adult', 'adult-slot-1')];
    const next = adoptSavedNumbers(now, posted, [{ index: 0, seq: 4, fullName: 'Asha', type: 'adult' }]);
    expect(next[0]).toMatchObject({ seq: 4, name: 'Asha Rao' });
    expect(next[1]).toMatchObject({ seq: null, name: 'Ra' });
  });

  it('skips an answer row whose name or type differs from what was posted there', () => {
    const rows = [row(null, 'Asha Rao', 'adult', 'adult-slot-0')];
    const posted = postedTravellers(rows);
    expect(adoptSavedNumbers(rows, posted, [{ index: 0, seq: 1, fullName: 'Someone Else', type: 'adult' }])[0]!.seq).toBeNull();
    expect(adoptSavedNumbers(rows, posted, [{ index: 0, seq: 1, fullName: 'Asha Rao', type: 'child' }])[0]!.seq).toBeNull();
  });

  it('never overwrites a number a row already has, and never gives a number twice', () => {
    const rows = [row(3, 'Asha Rao'), row(null, 'Ravi Rao', 'adult', 'adult-slot-1')];
    const posted = postedTravellers(rows);
    const next = adoptSavedNumbers(rows, posted, [
      { index: 0, seq: 9, fullName: 'Asha Rao', type: 'adult' },
      { index: 1, seq: 3, fullName: 'Ravi Rao', type: 'adult' },
    ]);
    expect(next.map((r) => r.seq)).toEqual([3, null]);
  });

  it('matches names as the save does (case and spaces)', () => {
    const rows = [row(null, '  asha   RAO ', 'adult', 'adult-slot-0')];
    const posted = postedTravellers(rows);
    expect(adoptSavedNumbers(rows, posted, [{ index: 0, seq: 1, fullName: 'Asha Rao', type: 'adult' }])[0]!.seq).toBe(1);
  });

  it('posted order is adults, then children, then infants (the parser order)', () => {
    const rows = [row(null, 'Kid', 'child', 'child-slot-0'), row(null, 'Mum', 'adult', 'adult-slot-0'), row(null, '', 'adult', 'adult-slot-1')];
    expect(postedTravellers(rows).map((p) => p.fullName)).toEqual(['Mum', 'Kid']);
  });
});

describe('rows keep their place (B1-4 b)', () => {
  it('a name typed in row 3 stays in row 3 after the save and the saved list arrive', () => {
    // Typing in slot 3 creates rows for slots 1 and 2 first (writeRow), so nothing moves.
    const typed = [row(null, '', 'adult', 'adult-slot-0'), row(null, '', 'adult', 'adult-slot-1'), row(null, 'Asha Rao', 'adult', 'adult-slot-2')];
    const adopted = adoptSavedNumbers(typed, postedTravellers(typed), [{ index: 0, seq: 1, fullName: 'Asha Rao', type: 'adult' }]);
    const merged = mergePassengerRows(adopted, [row(1, 'Asha Rao')]);
    const shown = displayRows(merged, counts);
    expect(shown.map((d) => d.row?.name ?? '')).toEqual(['', '', 'Asha Rao']);
    // The line keeps its screen key, so the field is not re-created.
    expect(shown[2]!.key).toBe('adult-slot-2');
  });

  it('then a name in row 1 is a second passenger, not joined to the first', () => {
    const before = [row(null, 'Ravi Rao', 'adult', 'adult-slot-0'), row(null, '', 'adult', 'adult-slot-1'), row(1, 'Asha Rao', 'adult', 'adult-slot-2')];
    const posted = postedTravellers(before);
    expect(posted.map((p) => [p.seq, p.fullName])).toEqual([
      [null, 'Ravi Rao'],
      [1, 'Asha Rao'],
    ]);
    const adopted = adoptSavedNumbers(before, posted, [
      { index: 0, seq: 2, fullName: 'Ravi Rao', type: 'adult' },
      { index: 1, seq: 1, fullName: 'Asha Rao', type: 'adult' },
    ]);
    const merged = mergePassengerRows(adopted, [row(1, 'Asha Rao'), row(2, 'Ravi Rao')]);
    expect(displayRows(merged, counts).map((d) => [d.row?.seq ?? null, d.row?.name ?? ''])).toEqual([
      [2, 'Ravi Rao'],
      [null, ''],
      [1, 'Asha Rao'],
    ]);
  });

  it('a saved passenger not on screen goes to the first empty slot of its type', () => {
    const current = [row(null, '', 'adult', 'adult-slot-0'), row(1, 'Asha Rao', 'adult', 'adult-slot-1')];
    const merged = mergePassengerRows(current, [row(1, 'Asha Rao'), row(5, 'From a colleague')]);
    expect(merged.map((r) => [r.seq, r.name, r.key])).toEqual([
      [5, 'From a colleague', 'adult-slot-0'],
      [1, 'Asha Rao', 'adult-slot-1'],
    ]);
  });

  it('a passenger no longer saved leaves an empty slot in the same place', () => {
    const current = [row(1, 'Asha Rao'), row(2, 'Ravi Rao')];
    const merged = mergePassengerRows(current, [row(2, 'Ravi Rao')]);
    expect(displayRows(merged, counts).map((d) => d.row?.name ?? '')).toEqual(['', 'Ravi Rao', '']);
  });

  it('the saved content ignores where the rows sit on screen', () => {
    const a = { travellers: [row(null, '', 'adult', 'adult-slot-0'), row(1, 'Asha Rao', 'adult', 'adult-slot-1')], removed: [] };
    const b = { travellers: [row(1, 'Asha Rao')], removed: [] };
    expect(passengersContent(a)).toBe(passengersContent(b));
    expect(passengersContent({ travellers: [row(1, 'Asha R')], removed: [] })).not.toBe(passengersContent(b));
  });
});

describe('the read after a lost answer (B1-4 c)', () => {
  const posted: PostedTraveller[] = [
    { key: 'seq-1', seq: 1, fullName: 'Asha Rao', type: 'adult' },
    { key: 'adult-slot-1', seq: null, fullName: 'Ravi Rao', type: 'adult' },
  ];
  const read = (rowVersion: number, travellers: SavedTravellersSnapshot['travellers']): SavedTravellersSnapshot => ({ rowVersion, travellers });

  it('stored, one step on: adopt the numbers and link the own save', () => {
    const check = checkLostTravellersSave({ posted, removed: [], postedRowVersion: 7, read: read(8, [{ seq: 1, fullName: 'Asha Rao', type: 'adult' }, { seq: 2, fullName: 'ravi  rao', type: 'adult' }]) });
    expect(check).toEqual({ kind: 'stored', seqs: [1, 2], ownStep: true });
  });

  it('stored but the row version moved more than one step: adopt without the own-save link', () => {
    const check = checkLostTravellersSave({ posted, removed: [], postedRowVersion: 7, read: read(10, [{ seq: 1, fullName: 'Asha Rao', type: 'adult' }, { seq: 2, fullName: 'Ravi Rao', type: 'adult' }]) });
    expect(check).toEqual({ kind: 'stored', seqs: [1, 2], ownStep: false });
  });

  it('not stored: a posted name is missing, or nothing was saved since the post', () => {
    expect(checkLostTravellersSave({ posted, removed: [], postedRowVersion: 7, read: read(8, [{ seq: 1, fullName: 'Asha Rao', type: 'adult' }]) })).toEqual({ kind: 'not_stored' });
    expect(checkLostTravellersSave({ posted, removed: [], postedRowVersion: 7, read: read(7, [{ seq: 1, fullName: 'Asha Rao', type: 'adult' }, { seq: 2, fullName: 'Ravi Rao', type: 'adult' }]) })).toEqual({ kind: 'not_stored' });
  });

  it('not stored: a passenger removed in the post is still saved', () => {
    expect(checkLostTravellersSave({ posted: posted.slice(0, 1), removed: [4], postedRowVersion: 7, read: read(8, [{ seq: 1, fullName: 'Asha Rao', type: 'adult' }, { seq: 4, fullName: 'Old', type: 'adult' }]) })).toEqual({ kind: 'not_stored' });
  });

  it('unclear: the same name and type twice, a failed read, a number that does not fit, or extra passengers', () => {
    const twice = read(8, [{ seq: 1, fullName: 'Asha Rao', type: 'adult' }, { seq: 2, fullName: 'Ravi Rao', type: 'adult' }, { seq: 3, fullName: 'Ravi Rao', type: 'adult' }]);
    expect(checkLostTravellersSave({ posted, removed: [], postedRowVersion: 7, read: twice })).toEqual({ kind: 'unclear' });
    expect(checkLostTravellersSave({ posted, removed: [], postedRowVersion: 7, read: null })).toEqual({ kind: 'unclear' });
    expect(checkLostTravellersSave({ posted, removed: [], postedRowVersion: 7, read: read(8, [{ seq: 6, fullName: 'Asha Rao', type: 'adult' }, { seq: 2, fullName: 'Ravi Rao', type: 'adult' }]) })).toEqual({ kind: 'unclear' });
    expect(checkLostTravellersSave({ posted, removed: [], postedRowVersion: 7, read: read(9, [{ seq: 1, fullName: 'Asha Rao', type: 'adult' }, { seq: 2, fullName: 'Ravi Rao', type: 'adult' }, { seq: 3, fullName: 'Third', type: 'adult' }]) })).toEqual({ kind: 'unclear' });
    expect(checkLostTravellersSave({ posted, removed: [], postedRowVersion: 7, read: read(6, []) })).toEqual({ kind: 'unclear' });
  });

  it('unclear: two posted rows with the same name and type', () => {
    const same: PostedTraveller[] = [
      { key: 'a', seq: null, fullName: 'Ravi Rao', type: 'adult' },
      { key: 'b', seq: null, fullName: 'Ravi Rao', type: 'adult' },
    ];
    expect(checkLostTravellersSave({ posted: same, removed: [], postedRowVersion: 1, read: read(2, [{ seq: 1, fullName: 'Ravi Rao', type: 'adult' }]) })).toEqual({ kind: 'unclear' });
  });
});

describe('"Try again" on passengers reads first (B1-4 e)', () => {
  const posted: PostedTraveller[] = [{ key: 'adult-slot-0', seq: null, fullName: 'Asha Rao', type: 'adult' }];

  it('sends only when not stored and the base is the stored version', () => {
    const r = { rowVersion: 7, travellers: [] };
    expect(travellersRetryStep(checkLostTravellersSave({ posted, removed: [], postedRowVersion: 7, read: r }), 7, r)).toBe('send');
  });

  it('someone saved meanwhile: a conflict, nothing sent', () => {
    const r = { rowVersion: 9, travellers: [{ seq: 1, fullName: 'Other', type: 'adult' as const }] };
    expect(travellersRetryStep(checkLostTravellersSave({ posted, removed: [], postedRowVersion: 7, read: r }), 7, r)).toBe('conflict');
  });

  it('stored after all: adopt; unclear: no send', () => {
    const r = { rowVersion: 8, travellers: [{ seq: 1, fullName: 'Asha Rao', type: 'adult' as const }] };
    expect(travellersRetryStep(checkLostTravellersSave({ posted, removed: [], postedRowVersion: 7, read: r }), 7, r)).toBe('adopt');
    expect(travellersRetryStep(checkLostTravellersSave({ posted, removed: [], postedRowVersion: 7, read: null }), 7, null)).toBe('unclear');
  });
});

describe('warn before a rename removes ID proofs (B1-9)', () => {
  const stored = [
    { seq: 1, fullName: 'Asha Rao', liveProofs: 2 },
    { seq: 2, fullName: 'Ravi Rao', liveProofs: 0 },
  ];

  it('asks for a saved passenger with proofs whose name changes', () => {
    expect(renamesThatDetachProofs([row(1, 'Asha Sharma'), row(2, 'Ravi Rao')], stored)).toEqual([{ seq: 1, from: 'Asha Rao', to: 'Asha Sharma' }]);
  });

  it('does not ask for spacing or case only, for a passenger without proofs, a new row or an empty name', () => {
    expect(renamesThatDetachProofs([row(1, '  asha   rao '), row(2, 'Ravi Kumar'), row(null, 'New Person'), row(1, '')], stored)).toEqual([]);
  });
});
