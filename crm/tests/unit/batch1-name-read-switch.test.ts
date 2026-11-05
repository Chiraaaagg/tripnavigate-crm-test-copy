import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normaliseNameReadReason, toNameReadStateView } from '@/modules/integration/name-map';

/**
 * DEC-55: the "Show Bitrix names" control on the Bitrix sync page. The state
 * read never reports a failure as Off; the server action needs state, a
 * 10-500 character reason and the confirmation, refuses non Super Admins
 * before calling the database, maps every refusal to fixed wording and
 * revalidates the page. Fake clients only.
 */

const requireStaff = vi.fn();
const rpc = vi.fn();
const revalidatePath = vi.fn();
vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const { setBitrixNameReadAction } = await import('@/modules/integration/server/name-map-actions');
const { readBitrixNameReadState } = await import('@/modules/integration/server/name-map');

const SUPER = { access: { memberships: [{ roleCode: 'super_admin', legalEntityId: 'e1', branchId: 'b1' }] }, supabase: { rpc } };
const SALES = { access: { memberships: [{ roleCode: 'sales', legalEntityId: 'e1', branchId: 'b1' }] }, supabase: { rpc } };
const REASON = 'Owner approval APPROVE for names';

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

describe('state read', () => {
  const LAST = { at: '2026-10-19T10:00:00+00:00', byName: 'Synthetic Admin', via: 'command', to: true, reason: REASON };

  it('parses On/Off with last change; anything else is Unknown, never Off', async () => {
    expect(toNameReadStateView({ enabled: true, connectionEnabled: true, effective: true, canSwitch: true, lastChange: LAST }))
      .toEqual({ state: 'known', enabled: true, connectionEnabled: true, effective: true, canSwitch: true, lastChange: LAST });
    expect(toNameReadStateView({ enabled: false, connectionEnabled: true, effective: false, canSwitch: false, lastChange: null }))
      .toEqual({ state: 'known', enabled: false, connectionEnabled: true, effective: false, canSwitch: false, lastChange: null });
    // Echo L1: switch on with the connection off is not "On" in effect.
    expect(toNameReadStateView({ enabled: true, connectionEnabled: false, effective: false, canSwitch: true, lastChange: null }))
      .toMatchObject({ state: 'known', enabled: true, effective: false });
    // An older answer without the new fields is Unknown, never a guess.
    expect(toNameReadStateView({ enabled: true, canSwitch: true, lastChange: null })).toEqual({ state: 'unknown', reason: 'failed' });
    expect(toNameReadStateView({ enabled: 'no' })).toEqual({ state: 'unknown', reason: 'failed' });
    const client = (reply: { data: unknown; error: { code?: string } | null } | Error) => ({
      rpc: async () => {
        if (reply instanceof Error) throw reply;
        return reply;
      },
    });
    expect(await readBitrixNameReadState(client({ data: null, error: { code: '42501' } }))).toEqual({ state: 'unknown', reason: 'not_authorized' });
    expect(await readBitrixNameReadState(client({ data: null, error: { code: '55000' } }))).toEqual({ state: 'unknown', reason: 'not_configured' });
    expect(await readBitrixNameReadState(client({ data: null, error: { code: 'PGRST202' } }))).toEqual({ state: 'unknown', reason: 'not_installed' });
    expect(await readBitrixNameReadState(client(new Error('network')))).toEqual({ state: 'unknown', reason: 'failed' });
  });

  it('reason rules: 10-500 characters after collapsing spaces', () => {
    expect(normaliseNameReadReason('  Owner   approval  APPROVE ')).toBe('Owner approval APPROVE');
    expect(normaliseNameReadReason('short')).toBeNull();
    expect(normaliseNameReadReason('x'.repeat(501))).toBeNull();
    expect(normaliseNameReadReason(null)).toBeNull();
  });
});

describe('setBitrixNameReadAction', () => {
  it('refuses missing state, reason or confirmation without calling the database', async () => {
    requireStaff.mockResolvedValue(SUPER);
    expect(await setBitrixNameReadAction(null, form({ state: 'maybe', reason: 'short' }))).toMatchObject({
      ok: false, code: 'invalid_input', fields: ['state', 'reason', 'confirm'],
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses a person without a Super Admin role before the database', async () => {
    requireStaff.mockResolvedValue(SALES);
    expect(await setBitrixNameReadAction(null, form({ state: 'on', reason: REASON, confirm: 'yes' }))).toMatchObject({ ok: false, code: 'not_authorized' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('calls the audited command under the session and revalidates the page', async () => {
    requireStaff.mockResolvedValue(SUPER);
    rpc.mockResolvedValue({ data: { changed: true, enabled: true }, error: null });
    const r = await setBitrixNameReadAction(null, form({ state: 'on', reason: `  ${REASON}  `, confirm: 'yes' }));
    expect(r).toMatchObject({ ok: true, enabled: true, changed: true });
    expect(rpc).toHaveBeenCalledWith('integration_set_bitrix_name_read', { p_enabled: true, p_reason: REASON });
    expect(revalidatePath).toHaveBeenCalledWith('/app/admin/integration');
    rpc.mockResolvedValue({ data: { changed: false, enabled: false }, error: null });
    expect(await setBitrixNameReadAction(null, form({ state: 'off', reason: REASON, confirm: 'yes' }))).toMatchObject({
      ok: true, changed: false, message: expect.stringContaining('already off'),
    });
  });

  it('maps database refusals to fixed wording (never the database message)', async () => {
    requireStaff.mockResolvedValue(SUPER);
    for (const [code, expected] of [['42501', 'not_authorized'], ['55000', 'not_configured'], ['PGRST202', 'not_installed'], ['XX000', 'failed']] as const) {
      rpc.mockResolvedValue({ data: null, error: { code, message: 'secret detail' } });
      const r = await setBitrixNameReadAction(null, form({ state: 'on', reason: REASON, confirm: 'yes' }));
      expect(r).toMatchObject({ ok: false, code: expected });
      expect(JSON.stringify(r)).not.toContain('secret detail');
    }
    rpc.mockResolvedValue({ data: null, error: { code: '22023' } });
    expect(await setBitrixNameReadAction(null, form({ state: 'on', reason: REASON, confirm: 'yes' }))).toMatchObject({ ok: false, code: 'invalid_input', fields: ['reason'] });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
