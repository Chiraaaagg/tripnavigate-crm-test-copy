import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_TEXT } from '@/modules/fulfilment/contracts';

/*
 * Booking reliability B1-8 (build contract section 6): every Book now action
 * gates with staffForAction(). When the session has ended it answers the
 * existing code `session` (ERROR_TEXT.session) instead of redirecting, so the
 * open form keeps what was typed, and it calls no database command, stores no
 * file and re-renders nothing. Any other gate outcome (MFA needed, inactive
 * staff) still redirects exactly as requireStaff() does. Every exported action
 * of the four files is enumerated, so a new action cannot skip the gate.
 */

const staffForAction = vi.fn();
const requireStaff = vi.fn();
const rpc = vi.fn();
const adminFactory = vi.fn(() => ({}));
const refresh = vi.fn();
const revalidatePath = vi.fn();

vi.mock('@/modules/identity/server/session', () => ({
  requireStaff: () => requireStaff(),
  staffForAction: () => staffForAction(),
  SESSION_ENDED: Symbol('session_ended'),
}));
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a), refresh: () => refresh() }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => adminFactory() }));

const { SESSION_ENDED } = await import('@/modules/identity/server/session');
const MODULES = {
  'book-form-actions': await import('@/modules/fulfilment/server/book-form-actions'),
  'book-now-actions': await import('@/modules/fulfilment/server/book-now-actions'),
  'id-proof-actions': await import('@/modules/fulfilment/server/id-proof-actions'),
  'flight-fares-actions': await import('@/modules/fulfilment/server/flight-fares-actions'),
} as const;

const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';
const REQUEST = '77777777-7777-4777-8777-777777777777';

/** A post that would pass every parser it reaches, so only the gate can stop it. */
function anyPost(): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ dealId: DEAL, versionId: VERSION, rowVersion: '5', requestId: REQUEST, contentHash: 'c'.repeat(64) })) fd.set(k, v);
  return fd;
}

/** Review go-live 1 P1-1: the Book now copies of actions shared with other screens (each in its own result shape). */
const BOOK_COPIES = await import('@/app/app/deals/[id]/book/book-session-actions');

type Action = (...args: unknown[]) => Promise<unknown>;
const ACTIONS: Array<[string, Action]> = Object.entries(MODULES).flatMap(([file, mod]) =>
  Object.entries(mod as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'function')
    .map(([name, fn]) => [`${file} ${name}`, fn as Action] as [string, Action]),
);

beforeEach(() => {
  vi.clearAllMocks();
  staffForAction.mockResolvedValue(SESSION_ENDED);
  requireStaff.mockRejectedValue(new Error('requireStaff must not gate a Book now action'));
});

describe('session ended while Book now is open', () => {
  it('covers the save actions of all four files', () => {
    const names = ACTIONS.map(([n]) => n);
    for (const expected of [
      'book-form-actions saveBookingCustomerAction',
      'book-form-actions saveBookingServiceAction',
      'book-form-actions addPassportServicesAction',
      'book-form-actions saveBookingTravellersAction',
      'book-form-actions readBookingTravellersAction',
      'book-form-actions saveBookingIdentityAction',
      'book-form-actions saveBookingPricesAction',
      'book-form-actions saveBillToAction',
      'book-form-actions uploadServiceFileAction',
      'book-form-actions removeServiceFileAction',
      'book-now-actions saveBookCustomerAction',
      'book-now-actions saveParticipationAction',
      'book-now-actions submitBookingAction',
      'id-proof-actions uploadTravellerIdProofAction',
      'id-proof-actions removeTravellerIdProofAction',
      'flight-fares-actions saveFlightFaresAction',
      'flight-fares-actions addReturnFlightsAction',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it.each(ACTIONS)('%s answers `session` and calls no database command', async (_name, action) => {
    const result = await action(null, anyPost());
    expect(result).toEqual({ ok: false, code: 'session', message: ERROR_TEXT.session });
    expect(staffForAction).toHaveBeenCalledTimes(1);
    expect(requireStaff).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(adminFactory).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each(ACTIONS)('%s: any other gate outcome still redirects, before any call', async (_name, action) => {
    staffForAction.mockRejectedValue(new Error('NEXT_REDIRECT /mfa/challenge'));
    await expect(action(null, anyPost())).rejects.toThrow('NEXT_REDIRECT');
    expect(rpc).not.toHaveBeenCalled();
    expect(adminFactory).not.toHaveBeenCalled();
  });

  const COPIES: Array<[string, Action]> = Object.entries(BOOK_COPIES as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'function')
    .map(([name, fn]) => [name, fn as Action]);

  it('the Book now copies cover every shared action the Book now pages call', () => {
    expect(COPIES.map(([n]) => n).sort()).toEqual(
      [
        'applyPrefillBookAction',
        'createPartyBookAction',
        'dismissPrefillNoticeBookAction',
        'fillEmptyPrefillBookAction',
        'markPrefillCheckedBookAction',
        'pickPartyBookAction',
        'refreshFromBitrixBookAction',
        'removeBookingEvidenceBookAction',
        'removeServiceItemBookAction',
        'reportPaymentClaimBookAction',
        'searchHotelsBookAction',
        'searchPartiesBookAction',
        'setDealMessagePrefsBookAction',
        'submitChangeBookAction',
        'uploadBookingEvidenceBookAction',
        'withdrawPaymentClaimBookAction',
      ].sort(),
    );
  });

  it.each(COPIES)('Book now copy %s answers the session text in the page and never reaches the shared action', async (_name, action) => {
    const result = (await action(null, anyPost())) as { ok?: boolean; status?: string; code?: string; message?: string };
    expect(result.message).toBe(ERROR_TEXT.session);
    expect(result.ok === false || result.status === 'error').toBe(true);
    expect(requireStaff).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(adminFactory).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('a live session hands the Book now copy over to the shared action unchanged', async () => {
    const live = { userId: 'a0000000-0000-4000-8000-000000000001', supabase: { rpc }, access: { userId: 'a0000000-0000-4000-8000-000000000001', memberships: [], rolePermissions: [], grants: [] } };
    staffForAction.mockResolvedValue(live);
    requireStaff.mockResolvedValue(live);
    rpc.mockResolvedValue({ data: { items: [], hasMore: false }, error: null });
    await BOOK_COPIES.searchHotelsBookAction('Goa beach');
    expect(requireStaff).toHaveBeenCalledTimes(1);
  });

  it('a live session goes on to the database under the staff member’s own client', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    staffForAction.mockResolvedValue({ userId: 'a0000000-0000-4000-8000-000000000001', supabase: { rpc }, access: { userId: 'a0000000-0000-4000-8000-000000000001', memberships: [], rolePermissions: [], grants: [] } });
    await MODULES['book-form-actions'].readBookingTravellersAction(DEAL);
    expect(rpc).toHaveBeenCalledWith('booking_form_get', { p_deal_id: DEAL });
  });
});
