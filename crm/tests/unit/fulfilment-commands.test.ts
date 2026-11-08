import { describe, expect, it, vi } from 'vitest';
import {
  BOOKING_ERROR_STATES,
  BookingCommandError,
  bookingHealth,
  bookingPanel,
  claimPurchaseTask,
  confirmBooking,
  mapBookingError,
  openDraft,
  purchaseTaskGet,
  purchaseTaskList,
  type RpcClient,
  saveDraft,
} from '@/modules/fulfilment/commands';
import type { BookingErrorCode, BookingFacts } from '@/modules/fulfilment/contracts';

const V = '11111111-1111-4111-8111-111111111111';
const T = '22222222-2222-4222-8222-222222222222';
const D = '33333333-3333-4333-8333-333333333333';
const HASH = 'a'.repeat(64);

function client(data: unknown, error: { code?: string; message?: string } | null = null) {
  const rpc = vi.fn(async () => ({ data, error }));
  return { rpc, client: { rpc } as RpcClient };
}

const facts: BookingFacts = {
  hotelName: 'Synthetic Palace',
  city: 'Jaipur',
  checkIn: '2026-11-01',
  checkOut: '2026-11-03',
  rooms: 1,
  roomType: null,
  mealPlan: null,
  adults: 2,
  children: 0,
  inclusions: null,
  specialRequests: null,
  purchaseBudgetPaise: '1500000',
};

describe('mapBookingError', () => {
  it.each(Object.entries(BOOKING_ERROR_STATES))('maps %s only with its SQLSTATE %s', (token, state) => {
    expect(mapBookingError({ code: state, message: token })).toBe(token);
  });

  it('does not trust a token arriving with the wrong SQLSTATE', () => {
    expect(mapBookingError({ code: '55000', message: 'version_changed' })).toBeNull();
    expect(mapBookingError({ code: '40001', message: 'not_ready' })).toBeNull();
  });

  it('never guesses a specific 55000/40001 refusal from a free-text message', () => {
    expect(mapBookingError({ code: '55000', message: 'something about not_ready happened' })).toBeNull();
    expect(mapBookingError({ code: '40001', message: 'could not serialize access' })).toBeNull();
  });

  it('maps unambiguous states and session errors', () => {
    expect(mapBookingError({ code: '42501', message: 'permission denied for table x' })).toBe('not_authorized');
    expect(mapBookingError({ code: 'P0002', message: 'whatever' })).toBe('not_found');
    expect(mapBookingError({ code: '22P02', message: 'invalid input syntax for type uuid' })).toBe('invalid_input');
    expect(mapBookingError({ code: 'PGRST301', message: 'JWT expired' })).toBe('session');
    expect(mapBookingError({ code: 'XX000', message: 'internal' })).toBeNull();
  });

  it('keeps the database message out of the error', async () => {
    const { client: c } = client(null, { code: '42501', message: 'not_authorized SECRET-ARG-ECHO' });
    const error = await openDraft(c, D).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BookingCommandError);
    expect((error as BookingCommandError).code).toBe('not_authorized');
    expect((error as Error).message).not.toContain('SECRET');
  });
});

describe('command wrappers', () => {
  it('passes exactly the documented parameters', async () => {
    const { rpc, client: c } = client({ versionId: V, rowVersion: 2, contentHash: HASH });
    await saveDraft(c, { versionId: V, expectedRowVersion: 1, facts, sellingTotalPaise: '2000000', sellingTotalProvided: true });
    expect(rpc).toHaveBeenCalledWith('booking_save_draft', {
      p_version_id: V,
      p_expected_row_version: 1,
      p_facts: facts,
      p_selling_total_paise: '2000000',
      p_selling_total_provided: true,
    });
  });

  it('save without the selling field leaves the commercial row untouched (provided=false, amount null)', async () => {
    const { rpc, client: c } = client({ versionId: V, rowVersion: 2, contentHash: HASH });
    await saveDraft(c, { versionId: V, expectedRowVersion: 1, facts, sellingTotalPaise: '5', sellingTotalProvided: false });
    expect((rpc.mock.calls[0] as unknown[])[1]).toMatchObject({ p_selling_total_paise: null, p_selling_total_provided: false });
  });

  it('accepts the A4 L4 issue code missing_selling_total_ask_owner', async () => {
    const { readiness } = await import('@/modules/fulfilment/commands');
    const { client: c } = client({ ready: false, issues: ['missing_selling_total_ask_owner'], contentHash: HASH });
    await expect(readiness(c, V)).resolves.toMatchObject({ issues: ['missing_selling_total_ask_owner'] });
  });

  it('confirm returns created/existing and posts the expected hash', async () => {
    const { rpc, client: c } = client({ outcome: 'existing', taskId: T, versionId: V });
    await expect(confirmBooking(c, { versionId: V, expectedContentHash: HASH })).resolves.toEqual({
      outcome: 'existing',
      taskId: T,
      versionId: V,
    });
    expect(rpc).toHaveBeenCalledWith('booking_confirm', { p_version_id: V, p_expected_content_hash: HASH });
  });

  it.each<[string, BookingErrorCode]>([
    ['version_changed', 'version_changed'],
    ['not_ready', 'not_ready'],
    ['booking_disabled', 'booking_disabled'],
    ['environment_unset', 'environment_unset'],
  ])('confirm refusal %s', async (message, code) => {
    const { client: c } = client(null, { code: BOOKING_ERROR_STATES[code], message });
    await expect(confirmBooking(c, { versionId: V, expectedContentHash: HASH })).rejects.toMatchObject({ code });
  });

  it('claim requires assignedToYou: true', async () => {
    const { client: c } = client({ taskId: T, status: 'in_progress', assignedToYou: false, alreadyYours: false });
    await expect(claimPurchaseTask(c, T)).rejects.toMatchObject({ code: null });
  });
});

describe('fail closed on unexpected responses', () => {
  it.each([
    ['null', null],
    ['wrong outcome', { outcome: 'maybe', taskId: T, versionId: V }],
    ['non-uuid task', { outcome: 'created', taskId: 'x', versionId: V }],
    ['string', 'ok'],
  ])('confirm: %s', async (_n, data) => {
    const { client: c } = client(data);
    await expect(confirmBooking(c, { versionId: V, expectedContentHash: HASH })).rejects.toMatchObject({ code: null });
  });

  it('rejects a thrown transport error without detail', async () => {
    const c: RpcClient = { rpc: () => Promise.reject(new Error('fetch failed https://secret.example')) };
    const error = (await openDraft(c, D).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(BookingCommandError);
    expect(error.message).not.toContain('secret');
  });

  it('rejects a fractional or negative budget in the Purchase list', async () => {
    const row = {
      taskId: T,
      dealReference: 'SYN-1',
      hotelName: 'H',
      city: 'C',
      checkIn: '2026-11-01',
      checkOut: '2026-11-02',
      rooms: 1,
      adults: 1,
      children: 0,
      status: 'not_started',
      assigneeName: null,
      assignedToYou: false,
      branchName: 'Delhi',
      createdAt: '2026-10-02T10:00:00Z',
    };
    await expect(purchaseTaskList(client([{ ...row, purchaseBudgetPaise: 10.5 }]).client)).rejects.toMatchObject({ code: null });
    await expect(purchaseTaskList(client([{ ...row, purchaseBudgetPaise: '-1' }]).client)).rejects.toMatchObject({ code: null });
    const ok = await purchaseTaskList(client([{ ...row, purchaseBudgetPaise: 1500000 }]).client);
    expect(ok[0]!.purchaseBudgetPaise).toBe('1500000');
  });

  it('read functions treat null as absent', async () => {
    await expect(bookingPanel(client(null).client, D)).resolves.toBeNull();
    await expect(purchaseTaskGet(client(null).client, T)).resolves.toBeNull();
    await expect(purchaseTaskList(client(null).client)).resolves.toEqual([]);
  });

  it('health rejects negative counts and unknown environments', async () => {
    const base = {
      realBookingEnabled: false,
      environment: 'test',
      drafts: 1,
      draftsNeedingRepair: 1,
      confirmed: 0,
      tasksNotStarted: 0,
      tasksInProgress: 0,
      pendingOutboxEvents: 0,
    };
    await expect(bookingHealth(client(base).client)).resolves.toEqual(base);
    await expect(bookingHealth(client({ ...base, drafts: -1 }).client)).rejects.toMatchObject({ code: null });
    await expect(bookingHealth(client({ ...base, environment: 'prod' }).client)).rejects.toMatchObject({ code: null });
  });
});
