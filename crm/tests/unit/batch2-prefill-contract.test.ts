import { describe, expect, expectTypeOf, it } from 'vitest';
import { PrefillApplySchema, PrefillCheckedSchema, PrefillSchema } from '@/modules/fulfilment/b11-commands';
import type { ErrorSummaryItem, ErrorSummaryItemKind, SaveRunReport } from '@/modules/fulfilment/book-flow-contract';
import { PREFILL_MARK_STATE_TEXT, PREFILL_MARK_STATES, PREFILL_SKIP_REASONS, PREFILL_SKIP_TEXT, type PrefillMarkState } from '@/modules/fulfilment/contracts';
import type { BookingStartDraftResult, PrefillFieldStateRead, PrefillUiVM } from '@/modules/fulfilment/prefill-contract';
import { QuotationGetSchema } from '@/modules/quotations/commands';
import type { QuotePartState, QuotePricesSaveReport } from '@/modules/quotations/editor-contract';
import type { BookActions } from '@/views/b11/shapes';
import type { QuoteActions } from '@/views/b12/quote-kit';

/**
 * Batch 2 Step 0 (lead freeze, 20 October 2026): the widened prefill codes
 * and the tolerant parse. A newer database (migration A's `kept`,
 * `replaced_by_quotation`, new skip reasons, or any later code) must never
 * turn a booking or quotation read into a failure. Synthetic values only.
 */

const block = (marks: unknown[]) => ({
  available: true,
  sourceModifiedAt: '2026-10-01T10:00:00Z',
  lastVerifiedAt: '2026-10-02T10:00:00Z',
  issues: [],
  notesHidden: false,
  fields: { bookingNotes: null, travellerTotal: null, tourStart: '2026-12-10', tourEnd: null, customerType: null, contact: null, company: null },
  marks,
});
const mark = (fieldCode: string, state: string) => ({ fieldCode, state, appliedAt: '2026-10-02T10:00:00Z', checkedAt: null });

describe('widened codes (Atlas shapes §4)', () => {
  it('mark states include kept and replaced_by_quotation; skip reasons include the four new ones', () => {
    expect(PREFILL_MARK_STATES).toEqual(['from_bitrix', 'kept', 'checked', 'changed', 'replaced_by_quotation']);
    expect(PREFILL_SKIP_REASONS).toEqual(expect.arrayContaining(['cleared_by_staff', 'not_provable', 'accepted_quotation', 'fill_failed']));
    expect(PREFILL_SKIP_REASONS).toHaveLength(10);
  });

  it('every state and reason has plain words', () => {
    for (const s of PREFILL_MARK_STATES) expect(PREFILL_MARK_STATE_TEXT[s].length).toBeGreaterThan(5);
    for (const r of PREFILL_SKIP_REASONS) expect(PREFILL_SKIP_TEXT[r].length).toBeGreaterThan(5);
    expect(PREFILL_MARK_STATE_TEXT.kept).toBe('From Bitrix, saved, not checked');
  });
});

describe('tolerant prefill read (booking_form_get and quotation_get)', () => {
  it('keeps the known states, incl. kept and replaced_by_quotation', () => {
    const r = PrefillSchema.parse(block([mark('contacts.mobile', 'kept'), mark('trip.start', 'replaced_by_quotation'), mark('contacts.email', 'checked')]));
    expect(r.marks.map((m) => [m.fieldCode, m.state])).toEqual([
      ['contacts.mobile', 'kept'],
      ['trip.start', 'replaced_by_quotation'],
      ['contacts.email', 'checked'],
    ]);
  });

  it('drops an unknown mark state or field code instead of failing the read', () => {
    const r = PrefillSchema.parse(block([mark('contacts.mobile', 'some_future_state'), mark('contacts.fax', 'from_bitrix'), mark('trip.end', 'from_bitrix')]));
    expect(r.marks).toEqual([{ fieldCode: 'trip.end', state: 'from_bitrix', appliedAt: '2026-10-02T10:00:00Z', checkedAt: null }]);
  });

  it('still fails closed on a malformed shape (not a tolerance for anything)', () => {
    expect(() => PrefillSchema.parse(block([{ fieldCode: 'trip.end', state: 7, appliedAt: 'x' }]))).toThrow();
    expect(() => PrefillSchema.parse({ ...block([]), available: 'yes' })).toThrow();
  });

  it('additive Batch 2 keys (autoFill, fieldStates) never fail the read', () => {
    expect(() => PrefillSchema.parse({ ...block([]), autoFill: { enabled: true, run: null, canFillEmpty: true }, fieldStates: [] })).not.toThrow();
  });

  it('quotation_get inherits the same tolerance', () => {
    const prefill = QuotationGetSchema.shape.prefill.parse({ ...block([mark('requirementsNote', 'kept'), mark('contacts.companyName', 'unknown_state')]), unchecked: ['requirementsNote'] });
    expect(prefill?.marks.map((m) => m.state)).toEqual(['kept']);
    expect(prefill?.unchecked).toEqual(['requirementsNote']);
  });
});

describe('tolerant command replies', () => {
  it('apply: new skip reasons kept; unknown reasons and field codes dropped', () => {
    const r = PrefillApplySchema.parse({
      rowVersion: 4,
      applied: ['contacts.mobile', 'contacts.fax'],
      skipped: [
        { field: 'contacts.email', reason: 'cleared_by_staff' },
        { field: 'trip.start', reason: 'accepted_quotation' },
        { field: 'trip.end', reason: 'a_reason_from_the_future' },
        { field: 'contacts.fax', reason: 'no_value' },
      ],
    });
    expect(r.applied).toEqual(['contacts.mobile']);
    expect(r.skipped).toEqual([
      { field: 'contacts.email', reason: 'cleared_by_staff' },
      { field: 'trip.start', reason: 'accepted_quotation' },
    ]);
  });

  it('mark checked: notChecked absent on an older database; known states and null kept, unknown dropped', () => {
    expect(PrefillCheckedSchema.parse({ checked: ['contacts.mobile'] })).toEqual({ checked: ['contacts.mobile'], notChecked: undefined });
    const r = PrefillCheckedSchema.parse({
      checked: ['contacts.mobile'],
      notChecked: [
        { field: 'contacts.email', state: 'changed' },
        { field: 'trip.start', state: null },
        { field: 'trip.end', state: 'later_state' },
      ],
    });
    expect(r.notChecked).toEqual([
      { field: 'contacts.email', state: 'changed' },
      { field: 'trip.start', state: null },
    ]);
  });
});

describe('frozen contract types (compile-time)', () => {
  it('fieldStates use the widened mark state; start draft extends the open-draft reply', () => {
    expectTypeOf<PrefillFieldStateRead['state']>().toEqualTypeOf<PrefillMarkState | null>();
    expectTypeOf<BookingStartDraftResult>().toHaveProperty('rowVersion').toEqualTypeOf<number>();
    expectTypeOf<BookingStartDraftResult['autoFill']>().toEqualTypeOf<'filled' | 'off' | 'existing_draft' | 'unavailable' | 'accepted_quotation' | 'not_package' | 'failed'>();
    expectTypeOf<PrefillUiVM['mode']>().toEqualTypeOf<'panel' | 'inline'>();
  });

  it('error summary lists unsaved first; save reports are shared by Book now and Save prices', () => {
    expectTypeOf<ErrorSummaryItemKind>().toEqualTypeOf<'unsaved' | 'refused' | 'blocking' | 'skipped'>();
    expectTypeOf<ErrorSummaryItem>().toHaveProperty('fieldId').toEqualTypeOf<string | null>();
    expectTypeOf<QuotePricesSaveReport>().toMatchTypeOf<SaveRunReport>();
    expectTypeOf<QuotePartState>().toEqualTypeOf<'not_started' | 'saved' | 'needs_input' | 'optional' | 'read_only' | 'prices_hidden'>();
  });

  it('both action bundles take the two new prefill actions (optional)', () => {
    expectTypeOf<BookActions>().toHaveProperty('fillEmptyPrefill');
    expectTypeOf<BookActions>().toHaveProperty('dismissPrefillNotice');
    expectTypeOf<QuoteActions>().toHaveProperty('fillEmptyPrefill');
    expectTypeOf<QuoteActions>().toHaveProperty('dismissPrefillNotice');
  });
});
