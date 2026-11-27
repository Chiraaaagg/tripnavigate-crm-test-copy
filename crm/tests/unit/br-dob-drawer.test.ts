import { describe, expect, it } from 'vitest';
import { BOOK_BATCH2_TEXT } from '@/modules/fulfilment/contracts';
import { ageAtTravel, ageForSave, ageOn, ageWarning, draftVersionMove } from '@/views/booking-form/passenger-drawer';

/*
 * Booking reliability B2-1 (build contract section 6, addendum 1 Q4): the
 * passenger drawer's "Age at travel" for a child or infant. Three states:
 * the number field (no saved date of birth), W10b (date of birth saved, no
 * trip dates yet), W10a read-only (the stored age is the age on the trip
 * start). A date of birth that does not fit the type is warned, never refused.
 * Synthetic dates only.
 */

const TRIP = '2026-12-10';

describe('ageOn (same rule as authz.age_on)', () => {
  it('counts whole years on the trip start: the day before, on and after the birthday', () => {
    expect(ageOn('2019-12-11', TRIP)).toBe(6);
    expect(ageOn('2019-12-10', TRIP)).toBe(7);
    expect(ageOn('2019-12-09', TRIP)).toBe(7);
  });

  it('a 29 February birthday counts from 1 March in other years', () => {
    expect(ageOn('2016-02-29', '2027-02-28')).toBe(10);
    expect(ageOn('2016-02-29', '2027-03-01')).toBe(11);
    expect(ageOn('2016-02-29', '2028-02-29')).toBe(12);
  });

  it('is -1 when born after the date and null for a missing or impossible date', () => {
    expect(ageOn('2026-12-11', TRIP)).toBe(-1);
    expect(ageOn('', TRIP)).toBeNull();
    expect(ageOn('2019-02-30', TRIP)).toBeNull();
    expect(ageOn('2019-12-10', null)).toBeNull();
  });
});

describe('the three drawer states', () => {
  it('no saved date of birth: the number field as today', () => {
    expect(ageAtTravel('child', null, TRIP, 9)).toEqual({ kind: 'typed' });
    expect(ageAtTravel('infant', '', null, null)).toEqual({ kind: 'typed' });
  });

  it('date of birth saved, no trip dates: W10b', () => {
    expect(ageAtTravel('child', '2019-12-10', null, null)).toEqual({ kind: 'after_trip_dates' });
    expect(BOOK_BATCH2_TEXT.ageAfterTripDates).toBe('Age at travel is worked out once the trip dates are saved.');
  });

  it('date of birth saved and the stored age is the age on the trip start: W10a, read-only', () => {
    const state = ageAtTravel('child', '2019-12-10', TRIP, 7);
    expect(state).toEqual({ kind: 'derived', years: 7 });
    expect(BOOK_BATCH2_TEXT.ageAtTravel(7)).toBe('Age at travel: 7 (from the date of birth, on the trip start date)');
    expect(ageAtTravel('infant', '2026-01-05', TRIP, 0)).toEqual({ kind: 'derived', years: 0 });
  });

  it('keeps the number field when the database did not derive the age (older database, or 18 or older)', () => {
    expect(ageAtTravel('child', '2019-12-10', TRIP, 9)).toEqual({ kind: 'typed' });
    expect(ageAtTravel('child', '2019-12-10', TRIP, null)).toEqual({ kind: 'typed' });
    expect(ageAtTravel('child', '1990-05-17', TRIP, 9)).toEqual({ kind: 'typed' });
  });

  it('an adult has no age field', () => {
    expect(ageAtTravel('adult', '1990-05-17', TRIP, null)).toEqual({ kind: 'typed' });
  });
});

describe('no typed age is posted while the date of birth decides it', () => {
  it('posts the stored number in W10a and W10b, the typed one only in the number field', () => {
    expect(ageForSave({ kind: 'derived', years: 7 }, '12', '7')).toBe('7');
    expect(ageForSave({ kind: 'after_trip_dates' }, '12', '')).toBe('');
    expect(ageForSave({ kind: 'typed' }, '12', '7')).toBe('12');
  });
});

describe('warn and allow (owner Q4)', () => {
  it('warns when the date of birth does not fit the passenger type (W10e)', () => {
    expect(ageWarning('infant', '2023-06-01', TRIP)).toBe('type_mismatch');
    expect(ageWarning('child', '2026-01-05', TRIP)).toBe('type_mismatch');
    expect(BOOK_BATCH2_TEXT.ageTypeMismatch).toMatch(/The booking can still be saved\.$/);
  });

  it('warns with W10d for a child or infant 18 or older on the trip start', () => {
    expect(ageWarning('child', '2008-12-10', TRIP)).toBe('age_too_high');
    expect(ageWarning('infant', '1990-05-17', TRIP)).toBe('age_too_high');
    expect(BOOK_BATCH2_TEXT.ageTooHigh).toBe('This date of birth makes the passenger 18 or older on the trip start date. Check the date, or change the passenger type. The booking can still be saved.');
  });

  it('no warning when the type fits, without trip dates, or without a date of birth', () => {
    expect(ageWarning('child', '2019-12-10', TRIP)).toBeNull();
    expect(ageWarning('infant', '2026-01-05', TRIP)).toBeNull();
    expect(ageWarning('adult', '1990-05-17', TRIP)).toBeNull();
    // Owner, 27 November 2026: no adult age band (an adult under 12 gets no warning).
    expect(ageWarning('adult', '2019-12-10', TRIP)).toBeNull();
    expect(ageWarning('infant', '2023-06-01', null)).toBeNull();
    expect(ageWarning('child', '', TRIP)).toBeNull();
  });
});

describe('own-save link after an identity save that moved the draft', () => {
  it('reads draftRowVersion from a successful answer only', () => {
    expect(draftVersionMove({ ok: true, data: { seq: 4, rowVersion: 2, ageYears: 7, draftRowVersion: { from: 11, to: 12 } }, message: '' }))
      .toEqual({ from: 11, to: 12 });
    expect(draftVersionMove({ ok: true, data: { seq: 4, rowVersion: 2 }, message: '' })).toBeNull();
    expect(draftVersionMove({ ok: true, data: { seq: 4, rowVersion: 2, draftRowVersion: null }, message: '' })).toBeNull();
    expect(draftVersionMove({ ok: false, code: 'version_changed', message: '' })).toBeNull();
    expect(draftVersionMove({ ok: true, data: { seq: 4, rowVersion: 2, draftRowVersion: { from: 12, to: 12 } }, message: '' })).toBeNull();
  });
});
