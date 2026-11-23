import { describe, expect, it } from 'vitest';
import { bookingPassportItemsAdd } from '@/modules/fulfilment/b11-commands';
import { parsePassportBatchForm } from '@/modules/fulfilment/booking-form-forms';
import { BookingCommandError, isFunctionMissing, type RpcClient } from '@/modules/fulfilment/commands';
import { BOOK_BATCH2_TEXT, PASSPORT_BATCH_MAX } from '@/modules/fulfilment/contracts';

/*
 * Booking reliability B2-2 (build contract section 6): a passport service for
 * several applicants from one selection. This file covers what exists before
 * batch 1 merges: the batch form parser (C0-batch2), the database wrapper
 * (booking_passport_items_add, its arguments, answer and refusals) and the
 * wording. The action (addPassportServicesAction in book-form-actions.ts) is
 * written after the batch 1 merge, when the file passes to slice S6; its
 * cases are listed below as todo. Synthetic ids only.
 */

const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';
const REQUEST = '77777777-7777-4777-8777-777777777777';
const ITEMS = ['33333333-3333-4333-8333-333333333331', '33333333-3333-4333-8333-333333333332', '33333333-3333-4333-8333-333333333333'];
const HASH = 'c'.repeat(64);

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else fd.set(k, v);
  }
  return fd;
}

const passport = { dealId: DEAL, versionId: VERSION, rowVersion: '5', requestId: REQUEST, serviceType: 'passport', applicationType: 'renewal', officeCity: 'Jodhpur' };

describe('parsePassportBatchForm', () => {
  it('reads one passport service for several applicants (same field names as the service form)', () => {
    const p = parsePassportBatchForm(form({ ...passport, participantSeq: ['3', '1', '2'] }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value).toMatchObject({ dealId: DEAL, versionId: VERSION, expectedRowVersion: 5, requestId: REQUEST, participantSeqs: [1, 2, 3] });
    expect(p.value.facts).toMatchObject({ applicationType: 'renewal', officeCity: 'Jodhpur' });
  });

  it('refuses no applicant, a repeated applicant, an existing item and another service type', () => {
    expect(parsePassportBatchForm(form({ ...passport }))).toMatchObject({ ok: false, fields: expect.arrayContaining(['participantSeq']) });
    expect(parsePassportBatchForm(form({ ...passport, participantSeq: ['1', '1'] }))).toMatchObject({ ok: false });
    expect(parsePassportBatchForm(form({ ...passport, participantSeq: ['1', '2'], itemId: ITEMS[0]! }))).toMatchObject({ ok: false, fields: expect.arrayContaining(['itemId']) });
    expect(parsePassportBatchForm(form({ ...passport, serviceType: 'visa', participantSeq: ['1', '2'] }))).toMatchObject({ ok: false });
  });

  it('keeps the field refusals of the service form (typed values are kept by the screen)', () => {
    const p = parsePassportBatchForm(form({ ...passport, officeCity: '', participantSeq: ['1', '2'] }));
    expect(p).toMatchObject({ ok: false, fields: expect.arrayContaining(['officeCity']) });
  });

  it('allows at most PASSPORT_BATCH_MAX applicants', () => {
    expect(PASSPORT_BATCH_MAX).toBe(20);
    const seqs = Array.from({ length: PASSPORT_BATCH_MAX + 1 }, (_, i) => String(i + 1));
    expect(parsePassportBatchForm(form({ ...passport, participantSeq: seqs }))).toMatchObject({ ok: false, fields: expect.arrayContaining(['participantSeq']) });
  });
});

describe('bookingPassportItemsAdd (booking_passport_items_add)', () => {
  function client(reply: { data?: unknown; error?: { code: string; message: string; hint?: string } }) {
    const calls: Array<{ fn: string; args: Record<string, unknown> | undefined }> = [];
    const c: RpcClient = {
      rpc: async (fn, args) => {
        calls.push({ fn, args });
        return { data: reply.data ?? null, error: reply.error ?? null };
      },
    };
    return { c, calls };
  }
  const facts = { applicationType: 'renewal' as const, officeCity: 'Jodhpur', neededBy: null, notes: null };
  const input = { versionId: VERSION, expectedRowVersion: 5, facts, participants: [1, 2, 3], requestId: REQUEST };

  it('sends one call with the version, facts, applicants and request id, and reads one line per applicant', async () => {
    const answer = { rowVersion: 11, contentHash: HASH, items: ITEMS.map((itemId, i) => ({ itemId, itemNo: i + 2, travellerSeq: i + 1 })) };
    const { c, calls } = client({ data: answer });
    expect(await bookingPassportItemsAdd(c, input)).toEqual(answer);
    expect(calls).toEqual([{ fn: 'booking_passport_items_add', args: { p_version_id: VERSION, p_expected_row_version: 5, p_facts: facts, p_participants: [1, 2, 3], p_request_id: REQUEST } }]);
  });

  it('a replayed answer (outcome existing) still parses', async () => {
    const answer = { rowVersion: 11, contentHash: HASH, items: [{ itemId: ITEMS[0]!, itemNo: 2, travellerSeq: 1 }], outcome: 'existing' };
    const { c } = client({ data: answer });
    expect((await bookingPassportItemsAdd(c, input)).items).toHaveLength(1);
  });

  it('fails closed on a malformed answer', async () => {
    const { c } = client({ data: { rowVersion: 11, contentHash: HASH, items: [] } });
    await expect(bookingPassportItemsAdd(c, input)).rejects.toMatchObject({ code: null });
  });

  it('maps the limit, the applicant and the conflict refusals to their codes', async () => {
    const cases: Array<[{ code: string; message: string; hint?: string }, string]> = [
      [{ code: '22023', message: 'too_many_items' }, 'too_many_items'],
      [{ code: '22023', message: 'invalid_input', hint: 'travellers' }, 'invalid_input'],
      [{ code: '40001', message: 'version_changed' }, 'version_changed'],
      [{ code: 'PT409', message: 'version_changed' }, 'version_changed'],
      [{ code: '40001', message: 'request_conflict' }, 'request_conflict'],
      [{ code: '42501', message: 'not_authorized' }, 'not_authorized'],
    ];
    for (const [error, code] of cases) {
      const { c } = client({ error });
      const e = await bookingPassportItemsAdd(c, input).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(BookingCommandError);
      expect((e as BookingCommandError).code).toBe(code);
    }
  });

  it('a database without the migration answers "function missing" (the screen then offers one applicant only)', async () => {
    const { c } = client({ error: { code: 'PGRST202', message: 'Could not find the function' } });
    const e = await bookingPassportItemsAdd(c, input).catch((x: unknown) => x);
    expect(isFunctionMissing(e)).toBe(true);
  });
});

describe('wording (W11a to W11d)', () => {
  it('is the approved text', () => {
    expect(BOOK_BATCH2_TEXT.applicantsLabel).toBe('Applicants');
    expect(BOOK_BATCH2_TEXT.applicantsHelp).toBe('One passport service is added for each person you choose.');
    expect(BOOK_BATCH2_TEXT.passportsAdded(3)).toBe('3 passport services added, one for each applicant.');
    expect(BOOK_BATCH2_TEXT.passportLimit).toBe('A Deal can hold 20 services. Choose fewer applicants, or remove a service first. Nothing was added.');
  });
});

describe('addPassportServicesAction (after the batch 1 merge; book-form-actions.ts passes to S6 then)', () => {
  it.todo('one applicant chosen still posts the existing saveBookingServiceAction (booking_service_save), unchanged');
  it.todo('two or more applicants call booking_passport_items_add once and answer W11c with the count');
  it.todo('too_many_items answers W11d with nothing added; invalid_input hint travellers marks the applicant chips');
  it.todo('a stale version answers the existing conflict text; session ended answers session without a database call');
  it.todo('the function missing (database not updated) answers the existing "save after the database update" text');
});
