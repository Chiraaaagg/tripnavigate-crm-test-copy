import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bookingPassportItemsAdd } from '@/modules/fulfilment/b11-commands';
import { parsePassportBatchForm } from '@/modules/fulfilment/booking-form-forms';
import { BookingCommandError, isFunctionMissing, type RpcClient } from '@/modules/fulfilment/commands';
import { BOOK_BATCH2_TEXT, BOOKING_FORM_NOT_INSTALLED_TEXT, ERROR_TEXT, PASSPORT_BATCH_MAX } from '@/modules/fulfilment/contracts';

const staffForAction = vi.fn();
const rpc = vi.fn();
const refresh = vi.fn();
const revalidatePath = vi.fn();
vi.mock('@/modules/identity/server/session', () => ({
  requireStaff: () => Promise.reject(new Error('requireStaff must not gate a Book now action')),
  staffForAction: () => staffForAction(),
  SESSION_ENDED: Symbol.for('test.session_ended'),
}));
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a), refresh: () => refresh() }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => ({}) }));

const actions = await import('@/modules/fulfilment/server/book-form-actions');
const { actionForPost, passportsAddedCount } = await import('@/views/booking-form/service-editor');

/*
 * Booking reliability B2-2 (build contract section 6): a passport service for
 * several applicants from one selection. This file covers what exists before
 * batch 1 merges: the batch form parser (C0-batch2), the database wrapper
 * (booking_passport_items_add, its arguments, answer and refusals) and the
 * wording; and, since go-live 2 is built on batch 1, the server action
 * (addPassportServicesAction) and the drawer's choice of action. Synthetic
 * ids only.
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

  it('a database without the migration answers "function missing" (the choice stays visible; the save answers the existing "needs the database update" text)', async () => {
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

describe('addPassportServicesAction', () => {
  const USER = 'a0000000-0000-4000-8000-000000000001';
  const post = () => form({ ...passport, participantSeq: ['2', '1', '3'] });
  function replies(map: Record<string, { data?: unknown; error?: { code: string; message: string; hint?: string } }>) {
    rpc.mockImplementation(async (fn: string) => {
      const r = map[fn];
      return { data: r?.data ?? null, error: r?.error ?? null };
    });
  }
  beforeEach(() => {
    vi.clearAllMocks();
    staffForAction.mockResolvedValue({ userId: USER, supabase: { rpc }, access: { userId: USER, memberships: [], rolePermissions: [], grants: [] } });
  });

  it('calls booking_passport_items_add once and answers W11c with the count', async () => {
    const answer = { rowVersion: 9, contentHash: HASH, items: ITEMS.map((itemId, i) => ({ itemId, itemNo: i + 1, travellerSeq: i + 1 })) };
    replies({ booking_passport_items_add: { data: answer } });
    const r = await actions.addPassportServicesAction(null, post());
    expect(r).toEqual({ ok: true, data: answer, message: '3 passport services added, one for each applicant.' });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['booking_passport_items_add']);
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_version_id: VERSION, p_expected_row_version: 5, p_participants: [1, 2, 3], p_request_id: REQUEST, p_facts: { applicationType: 'renewal', officeCity: 'Jodhpur' } });
    // A draft save: one refresh, no revalidatePath (booking reliability B1-6).
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('too_many_items answers W11d with nothing added; invalid_input hint travellers marks the applicant chips', async () => {
    replies({ booking_passport_items_add: { error: { code: '22023', message: 'too_many_items' } } });
    expect(await actions.addPassportServicesAction(null, post())).toEqual({ ok: false, code: 'too_many_items', message: BOOK_BATCH2_TEXT.passportLimit, fields: ['participantSeq'] });
    replies({ booking_passport_items_add: { error: { code: '22023', message: 'invalid_input', hint: 'travellers' } } });
    expect(await actions.addPassportServicesAction(null, post())).toMatchObject({ ok: false, code: 'invalid_input', fields: ['participantSeq'] });
  });

  it('refuses a form that is not a new passport for several applicants before any call', async () => {
    expect(await actions.addPassportServicesAction(null, form({ ...passport, participantSeq: ['1', '2'], itemId: ITEMS[0]! }))).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a stale version answers the existing conflict text; session ended answers session without a database call', async () => {
    replies({ booking_passport_items_add: { error: { code: 'PT409', message: 'version_changed' } } });
    expect(await actions.addPassportServicesAction(null, post())).toMatchObject({ ok: false, code: 'version_changed', message: ERROR_TEXT.version_changed });
    vi.clearAllMocks();
    const { SESSION_ENDED } = await import('@/modules/identity/server/session');
    staffForAction.mockResolvedValue(SESSION_ENDED);
    expect(await actions.addPassportServicesAction(null, post())).toEqual({ ok: false, code: 'session', message: ERROR_TEXT.session });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('the function missing (database not updated) answers the existing "database update" text', async () => {
    replies({ booking_passport_items_add: { error: { code: 'PGRST202', message: 'Could not find the function' } } });
    expect(await actions.addPassportServicesAction(null, post())).toMatchObject({ ok: false, code: 'wrong_state', message: BOOKING_FORM_NOT_INSTALLED_TEXT });
  });
});

describe('the passport drawer chooses the action per post', () => {
  const single = async () => ({ ok: true }) as never;
  const batch = async () => ({ ok: true }) as never;

  it('one applicant still posts the existing service save (booking_service_save), unchanged', () => {
    expect(actionForPost(form({ ...passport, participantSeq: ['1'] }), single, batch)).toBe(single);
  });

  it('two or more applicants on a NEW passport go to the batch action', () => {
    expect(actionForPost(form({ ...passport, participantSeq: ['1', '2'] }), single, batch)).toBe(batch);
  });

  it('a saved passport, another service type, or no batch action keeps the service save', () => {
    expect(actionForPost(form({ ...passport, itemId: ITEMS[0]!, participantSeq: ['1', '2'] }), single, batch)).toBe(single);
    expect(actionForPost(form({ ...passport, serviceType: 'visa', participantSeq: ['1', '2'] }), single, batch)).toBe(single);
    expect(actionForPost(form({ ...passport, participantSeq: ['1', '2'] }), single, null)).toBe(single);
  });

  it('the added count comes from the answer lines, else from the applicants posted', () => {
    expect(passportsAddedCount({ ok: true, data: { items: [{}, {}, {}] } } as never, 2)).toBe(3);
    expect(passportsAddedCount({ ok: true } as never, 2)).toBe(2);
  });
});
