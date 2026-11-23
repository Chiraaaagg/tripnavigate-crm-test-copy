import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFLICT_SQLSTATE_NEW } from '@/lib/sqlstate';

/*
 * Booking reliability B1-4 (build contract section 6): the passengers save
 * answer lists every posted row by its posted position with the number it was
 * stored under, and the read action that follows a lost answer returns only
 * number, name and type plus the draft row version, and writes nothing.
 * Fake RPC client; synthetic ids and names only.
 */

const staffForAction = vi.fn();
const rpc = vi.fn();
const refresh = vi.fn();
const revalidatePath = vi.fn();

vi.mock('@/modules/identity/server/session', () => ({
  requireStaff: () => staffForAction(),
  staffForAction: () => staffForAction(),
  SESSION_ENDED: Symbol('session_ended'),
}));
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a), refresh: () => refresh() }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => ({}) }));

const actions = await import('@/modules/fulfilment/server/book-form-actions');

const USER = 'a0000000-0000-4000-8000-000000000001';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';
const TRAVELLER = '44444444-4444-4444-8444-444444444444';
const HASH = 'c'.repeat(64);

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else fd.set(k, v);
  }
  return fd;
}

type RpcReply = { data?: unknown; error?: { code: string; message: string; hint?: string } | null };
function rpcReplies(map: Record<string, RpcReply>) {
  rpc.mockImplementation(async (fn: string) => {
    const reply = map[fn];
    if (!reply) throw new Error(`unexpected rpc ${fn}`);
    return { data: reply.data ?? null, error: reply.error ?? null };
  });
}

/** A stored passenger as booking_form_get sends it to an editor, with the restricted parts present. */
const storedAsha = {
  travellerId: TRAVELLER,
  seq: 1,
  fullName: 'Asha Example',
  type: 'adult',
  ageYears: null,
  specialNeeds: 'Synthetic need',
  specialRequests: ['vegetarian_meals'],
  identity: { dateOfBirth: '1990-01-01', gender: 'female', nationality: 'IN', rowVersion: 2 },
  idProofs: [],
};

function formGet(opts: { travellers?: unknown[]; status?: string; rowVersion?: number } = {}): RpcReply {
  return {
    data: {
      dealId: DEAL,
      canEdit: true,
      canConfirm: true,
      serviceItemsEnabled: true,
      version: { versionId: VERSION, versionNo: 1, status: opts.status ?? 'draft', rowVersion: opts.rowVersion ?? 5, contentHash: HASH, formRules: 2 },
      contacts: null,
      billing: { status: 'none', rowVersion: 0 },
      travellers: opts.travellers ?? [],
      items: [],
      evidence: [],
      party: { total: 5, children: 1, infants: 1, adults: 3 },
      itemFilesCanEdit: true,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  staffForAction.mockResolvedValue({ userId: USER, supabase: { rpc }, access: { userId: USER, memberships: [], rolePermissions: [], grants: [] } });
});

describe('saveBookingTravellersAction answer (B1-4 a)', () => {
  it('lists index, seq, fullName and type for every posted named row, in posted order', async () => {
    rpcReplies({ booking_form_get: formGet({ travellers: [{ seq: 1, fullName: 'Asha Example', type: 'adult' }] }), deal_travellers_save: { data: { rowVersion: 6, contentHash: HASH } } });
    // Row 2 of the screen is empty (never posted); rows 3 and 4 are new (no number yet).
    const fd = form({
      dealId: DEAL,
      versionId: VERSION,
      rowVersion: '5',
      travellerName: ['Asha Example', '', 'Ravi  Example', 'Neha Example'],
      travellerType: ['adult', '', 'adult', 'child'],
      travellerAge: ['', '', '', '7'],
      travellerNeeds: ['', '', '', ''],
      travellerSeq: ['1', '', '', ''],
      travellerSeqMax: '1',
    });
    const r = await actions.saveBookingTravellersAction(null, fd);
    expect(r).toEqual({
      ok: true,
      message: 'Passengers saved.',
      data: {
        rowVersion: 6,
        contentHash: HASH,
        travellers: [
          { index: 0, seq: 1, fullName: 'Asha Example', type: 'adult' },
          { index: 1, seq: 2, fullName: 'Ravi Example', type: 'adult' },
          { index: 2, seq: 3, fullName: 'Neha Example', type: 'child' },
        ],
      },
    });
    // The numbers in the answer are exactly the ones sent to the database.
    const sent = rpc.mock.calls.find((c) => c[0] === 'deal_travellers_save')![1] as { p_travellers: Array<{ seq: number; fullName: string }> };
    expect(sent.p_travellers.map((t) => [t.seq, t.fullName])).toEqual([
      [1, 'Asha Example'],
      [2, 'Ravi Example'],
      [3, 'Neha Example'],
    ]);
  });

  it('a refusal carries no traveller list (nothing was stored)', async () => {
    rpcReplies({ booking_form_get: formGet(), deal_travellers_save: { error: { code: CONFLICT_SQLSTATE_NEW, message: 'version_changed' } } });
    const r = await actions.saveBookingTravellersAction(null, form({ dealId: DEAL, versionId: VERSION, rowVersion: '5', travellerName: ['Asha Example'], travellerType: ['adult'], travellerSeqMax: '0' }));
    expect(r).toMatchObject({ ok: false, code: 'version_changed' });
    expect(r).not.toHaveProperty('data');
  });
});

describe('readBookingTravellersAction (B1-4 c)', () => {
  it('returns only number, name and type plus the draft row version, from one read', async () => {
    rpcReplies({ booking_form_get: formGet({ rowVersion: 7, travellers: [storedAsha, { seq: 3, fullName: 'Neha Example', type: 'child', ageYears: 7 }] }) });
    const r = await actions.readBookingTravellersAction(DEAL);
    expect(r).toEqual({
      ok: true,
      message: 'Saved passengers read.',
      data: {
        rowVersion: 7,
        travellers: [
          { seq: 1, fullName: 'Asha Example', type: 'adult' },
          { seq: 3, fullName: 'Neha Example', type: 'child' },
        ],
      },
    });
    // No restricted or extra field anywhere in the answer.
    const text = JSON.stringify(r);
    for (const leak of ['1990-01-01', 'Synthetic need', 'vegetarian', 'identity', 'idProofs', 'ageYears', 'travellerId', TRAVELLER]) {
      expect(text).not.toContain(leak);
    }
  });

  it('performs no write and no refresh: booking_form_get is the only call', async () => {
    rpcReplies({ booking_form_get: formGet({ travellers: [storedAsha] }) });
    await actions.readBookingTravellersAction(DEAL);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['booking_form_get']);
    expect(rpc).toHaveBeenCalledWith('booking_form_get', { p_deal_id: DEAL });
    expect(refresh).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('a malformed id is refused before any call; a hidden Deal reads as not found; no draft is wrong_state', async () => {
    await expect(actions.readBookingTravellersAction('not-a-uuid')).resolves.toMatchObject({ ok: false, code: 'invalid_input' });
    expect(rpc).not.toHaveBeenCalled();
    rpcReplies({ booking_form_get: { data: null } });
    await expect(actions.readBookingTravellersAction(DEAL)).resolves.toMatchObject({ ok: false, code: 'not_found' });
    rpcReplies({ booking_form_get: formGet({ status: 'confirmed' }) });
    await expect(actions.readBookingTravellersAction(DEAL)).resolves.toMatchObject({ ok: false, code: 'wrong_state' });
  });

  it('a refusal maps to its code; an unexplained failure throws (the screen reads it as "could not check")', async () => {
    rpcReplies({ booking_form_get: { error: { code: '42501', message: 'not_authorized' } } });
    await expect(actions.readBookingTravellersAction(DEAL)).resolves.toMatchObject({ ok: false, code: 'not_authorized' });
    rpcReplies({ booking_form_get: { error: { code: '57014', message: 'canceling statement due to statement timeout' } } });
    await expect(actions.readBookingTravellersAction(DEAL)).rejects.toThrow('Could not read the saved passengers.');
  });
});
