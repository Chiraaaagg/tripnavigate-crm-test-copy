import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Voice-note batch: the "Read trip details from Bitrix" switch on the Bitrix
 * connection page. Same rules as the Bitrix names switch: a failed read is
 * Unknown, never Off; the action needs state, a 10-500 character reason and
 * the confirmation, refuses non Super Admins before the database, and maps
 * refusals to fixed wording. Fake clients only.
 */

vi.mock('server-only', () => ({}));
const requireStaff = vi.fn();
const rpc = vi.fn();
const revalidatePath = vi.fn();
vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const { setBitrixTripDetailsReadAction } = await import('@/modules/integration/server/trip-details-actions');
const { loadBitrixTripDetailsReadState } = await import('@/modules/integration/server/trip-details-state');

const SUPER = { access: { memberships: [{ roleCode: 'super_admin', legalEntityId: 'e1', branchId: 'b1' }] }, supabase: { rpc } };
const SALES = { access: { memberships: [{ roleCode: 'sales', legalEntityId: 'e1', branchId: 'b1' }] }, supabase: { rpc } };
const REASON = 'Owner approval APPROVE for trip details';

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  requireStaff.mockReset();
  rpc.mockReset();
  revalidatePath.mockReset();
});

describe('trip details switch state', () => {
  it('known On/Off with last change; refusals and missing command are Unknown, never Off', async () => {
    rpc.mockResolvedValueOnce({ data: { enabled: false, connectionEnabled: true, effective: false, canSwitch: true, lastChange: null }, error: null });
    expect(await loadBitrixTripDetailsReadState({ supabase: { rpc } } as never)).toEqual({
      state: 'known', enabled: false, connectionEnabled: true, effective: false, canSwitch: true, lastChange: null,
    });
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'not_authorized' } });
    expect(await loadBitrixTripDetailsReadState({ supabase: { rpc } } as never)).toEqual({ state: 'unknown', reason: 'not_authorized' });
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'x' } });
    expect(await loadBitrixTripDetailsReadState({ supabase: { rpc } } as never)).toEqual({ state: 'unknown', reason: 'not_installed' });
    rpc.mockRejectedValueOnce(new Error('network'));
    expect(await loadBitrixTripDetailsReadState({ supabase: { rpc } } as never)).toEqual({ state: 'unknown', reason: 'failed' });
  });
});

describe('trip details switch action', () => {
  it('refuses missing fields and non Super Admins before the database', async () => {
    requireStaff.mockResolvedValue(SUPER);
    expect(await setBitrixTripDetailsReadAction(null, form({ state: 'on', reason: 'short' }))).toMatchObject({ ok: false, code: 'invalid_input', fields: ['reason', 'confirm'] });
    requireStaff.mockResolvedValue(SALES);
    expect(await setBitrixTripDetailsReadAction(null, form({ state: 'on', reason: REASON, confirm: 'yes' }))).toMatchObject({ ok: false, code: 'not_authorized' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('switches with the reason, revalidates, and maps a refusal to fixed words', async () => {
    requireStaff.mockResolvedValue(SUPER);
    rpc.mockResolvedValueOnce({ data: { changed: true, enabled: true }, error: null });
    const ok = await setBitrixTripDetailsReadAction(null, form({ state: 'on', reason: REASON, confirm: 'yes' }));
    expect(rpc).toHaveBeenCalledWith('integration_set_bitrix_trip_details_read', { p_enabled: true, p_reason: REASON });
    expect(ok).toMatchObject({ ok: true, enabled: true, changed: true });
    expect(revalidatePath).toHaveBeenCalledWith('/app/admin/integration');
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'not_authorized' } });
    expect(await setBitrixTripDetailsReadAction(null, form({ state: 'off', reason: REASON, confirm: 'yes' }))).toMatchObject({
      ok: false, code: 'not_authorized', message: 'Only the Super Admin can change this setting. Nothing was changed.',
    });
  });
});
