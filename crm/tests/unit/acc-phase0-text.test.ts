import { describe, expect, it } from 'vitest';
import { FINANCE_ERROR_TEXT } from '@/modules/finance/contracts';
import { BOOKING_CHANGE_FIELD_LABEL, bookingChangeLabel } from '@/modules/procurement/booking-change';

/** Accounts phase contract 5.2 / 5.4 frozen text and 8.5 labels (Track E, 12.5 "Phase 0 DTO keys"). */

describe('frozen staff messages', () => {
  it('review_return_committed (5.2)', () => {
    expect(FINANCE_ERROR_TEXT.review_return_committed).toBe('This booking cannot be returned: a supplier has already confirmed it. '
      + 'To stop or change the trip, ask the branch Manager to start a cancellation.');
  });
});

describe('8.5 Purchase change labels', () => {
  it('every label is plain text; no money key has a label', () => {
    for (const [key, label] of Object.entries(BOOKING_CHANGE_FIELD_LABEL)) {
      expect(label.length, key).toBeGreaterThan(1);
      expect(key, 'money keys are never diffed').not.toMatch(/sell|price|discount|instal|paymentPlan|paise|amount|budgetPaise/i);
    }
    expect(typeof bookingChangeLabel('roomType')).toBe('string');
  });
});
