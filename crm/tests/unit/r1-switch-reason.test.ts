import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_REASON_GIVEN, isBlankReason, reasonOrDefault, switchFamily, switchReasonRule, withOptionalReason } from '@/modules/settings/reason';
import { CHANGEABLE_SWITCH_KEYS } from '@/modules/settings/switch';

/**
 * UX redesign R1, owner answers D9 and Q1 (with the lead's ruling of 17
 * November 2026): the reason of a Settings switch may be left empty, except in
 * the four STANDING-RULES families: finance modes (every Settings › Accounts
 * switch), real booking (Book now service list, Visa and passport tasks),
 * supplier confirmation (no change action) and the Bitrix scope (sync scope,
 * "leads whose owner is not a CRM salesperson"). Outside them an empty or
 * blank reason reaches the database as "No reason given"; inside them it is
 * refused before any database call, as today. A typed reason is sent as
 * typed, and a short one is still refused. Fake RPC client, synthetic ids only.
 */

const requireStaff = vi.fn();
const rpc = vi.fn();

vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/server', () => ({ after: () => undefined }));

const settings = await import('@/modules/settings/server/actions');
const notices = await import('@/modules/notices/server/actions');
const desk = await import('@/modules/accounts-desk/server/actions');
const tallyFile = await import('@/modules/accounts-desk/server/tally-file-actions');
const documents = await import('@/modules/customer-documents/server/actions');
const refunds = await import('@/modules/refunds/server/actions');
const writeOffs = await import('@/modules/write-offs/server/actions');
const nameMap = await import('@/modules/integration/server/name-map-actions');
const tripDetails = await import('@/modules/integration/server/trip-details-actions');
const messages = await import('@/modules/customer-messages/server/actions');

const USER = 'a0000000-0000-4000-8000-000000000001';
const ENTITY = 'e0000000-0000-4000-8000-000000000001';
const OTHER = 'a0000000-0000-4000-8000-000000000002';

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** Every RPC answers "not allowed": the action stops after the database call, so the reason it sent can be read. */
function rpcRefuses() {
  rpc.mockImplementation(async () => ({ data: null, error: { code: '42501', message: 'not_authorized' } }));
}

/** The reason value the action sent to the database (the RPC argument whose name holds "reason"). */
function sentReasons(): unknown[] {
  return rpc.mock.calls.flatMap(([, args]) =>
    Object.entries((args ?? {}) as Record<string, unknown>)
      .filter(([k]) => /reason/i.test(k))
      .map(([, v]) => v),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockResolvedValue({ userId: USER, supabase: { rpc }, access: { userId: USER, memberships: [], rolePermissions: [], grants: [] }, memberships: [] });
  rpcRefuses();
});

describe('the reason helper', () => {
  it('blank means missing, empty or only spaces, tabs and line breaks', () => {
    expect(isBlankReason(null)).toBe(true);
    expect(isBlankReason('')).toBe(true);
    expect(isBlankReason(' \n\t ')).toBe(true);
    expect(isBlankReason('x')).toBe(false);
  });

  it('optional: blank becomes "No reason given"; anything typed is kept as typed', () => {
    expect(reasonOrDefault('', 'optional')).toBe(NO_REASON_GIVEN);
    expect(reasonOrDefault('  ', 'optional')).toBe(NO_REASON_GIVEN);
    expect(reasonOrDefault('ok', 'optional')).toBe('ok');
    expect(reasonOrDefault('Owner approved on 17 Nov', 'optional')).toBe('Owner approved on 17 Nov');
  });

  it('required: blank stays blank, so the action refuses it as today', () => {
    expect(reasonOrDefault('', 'required')).toBe('');
    expect(reasonOrDefault('   ', 'required')).toBe('   ');
  });

  it('withOptionalReason fills only a blank reason and keeps every other field', () => {
    const filled = withOptionalReason(form({ entityId: ENTITY, enabled: 'true', reason: '  ' }));
    expect([...filled.entries()]).toEqual([
      ['entityId', ENTITY],
      ['enabled', 'true'],
      ['reason', NO_REASON_GIVEN],
    ]);
    const typed = form({ enabled: 'true', reason: 'Owner approved on 17 Nov' });
    expect(withOptionalReason(typed)).toBe(typed);
    expect(withOptionalReason(form({ enabled: 'false' })).get('reason')).toBe(NO_REASON_GIVEN);
  });

  it('the shared change action: real department work and the Bitrix scope keep a required reason; every other switch is optional', () => {
    const required: Record<string, string> = {
      service_items_enabled: 'real_booking',
      visa_passport_tasks_enabled: 'real_booking',
      lead_intake_unowned: 'bitrix_scope',
    };
    // Owner decision, 18 Nov: the ID-proof copy to Bitrix takes the optional reason like the other switches.
    expect(switchReasonRule('bitrix_id_proof_copy')).toBe('optional');
    for (const key of CHANGEABLE_SWITCH_KEYS) {
      expect(switchReasonRule(key), key).toBe(key in required ? 'required' : 'optional');
      expect(switchFamily(key), key).toBe(required[key] ?? null);
    }
  });
});

describe('Features and Bitrix switches (changeSettingSwitchAction)', () => {
  const post = (settingKey: string, reason: string) => settings.changeSettingSwitchAction(null, form({ settingKey, state: 'on', reason, confirm: 'yes' }));

  // bitrix_name_read is a key of this action, but the Bitrix connection page posts its own action (setBitrixNameReadAction, below).
  it.each(['intake_prompt_enabled', 'prefill_auto_fill', 'referral_drafts', 'bitrix_trip_facts_read', 'bitrix_id_proof_copy', 'bitrix_name_read'])(
    '%s (optional): an empty reason reaches the database as "No reason given"',
    async (key) => {
      await post(key, '');
      expect(rpc).toHaveBeenCalled();
      expect(sentReasons()).toEqual([NO_REASON_GIVEN]);
    },
  );

  it('a typed reason is sent as typed; a short one is still refused before the database', async () => {
    await post('referral_drafts', 'Owner APPROVE on 17 Nov (synthetic)');
    expect(sentReasons()).toEqual(['Owner APPROVE on 17 Nov (synthetic)']);
    rpc.mockClear();
    const short = await post('referral_drafts', 'ok');
    expect(short).toMatchObject({ ok: false, code: 'invalid_input', fields: ['reason'] });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['service_items_enabled', 'real booking (one task per sold service)'],
    ['visa_passport_tasks_enabled', 'real booking (Visa desk tasks)'],
    ['lead_intake_unowned', 'Bitrix scope'],
  ])('%s (required, %s): an empty or blank reason is refused as today, with no database call', async (key) => {
    for (const reason of ['', '   ']) {
      const r = await post(key, reason);
      expect(r).toMatchObject({ ok: false, code: 'invalid_input', fields: ['reason'] });
    }
    expect(rpc).not.toHaveBeenCalled();
    await post(key, 'Owner APPROVE on 17 Nov (synthetic)');
    expect(sentReasons()).toEqual(['Owner APPROVE on 17 Nov (synthetic)']);
  });

  it('a save without a reason says so in the result line', async () => {
    rpc.mockImplementation(async () => ({ data: { key: 'referral_drafts', changed: true, before: false, after: true, updatedAt: '2026-11-17T10:00:00Z' }, error: null }));
    const r = await post('referral_drafts', '');
    expect(r).toMatchObject({ ok: true, message: 'Referral drafts is now on. Recorded with your name and the time (no reason given).' });
  });

  it('the review step is still required', async () => {
    const r = await settings.changeSettingSwitchAction(null, form({ settingKey: 'referral_drafts', state: 'on', reason: '' }));
    expect(r).toMatchObject({ ok: false, code: 'review_required' });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('staff notices and the Tally exception owner (optional)', () => {
  const cases: Array<[string, (fd: FormData) => Promise<unknown>, Record<string, string>]> = [
    ['staff notices', (fd) => notices.setNoticesEnabledAction(null, fd), { enabled: 'true' }],
    ['Tally exception owner', (fd) => desk.setExceptionOwnerAction(null as never, fd), { entityId: ENTITY, userId: OTHER }],
  ];

  it.each(cases)('%s: an empty reason reaches the database as "No reason given"', async (_name, run, fields) => {
    await run(form({ ...fields, reason: '' }));
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(sentReasons()).toEqual([NO_REASON_GIVEN]);
  });

  it.each(cases)('%s: a blank reason (spaces and line breaks) is treated the same', async (_name, run, fields) => {
    await run(form({ ...fields, reason: ' \n  ' }));
    expect(sentReasons()).toEqual([NO_REASON_GIVEN]);
  });

  it.each(cases)('%s: a typed reason is sent as typed', async (_name, run, fields) => {
    await run(form({ ...fields, reason: 'Owner approved on 17 Nov (synthetic)' }));
    expect(sentReasons()).toEqual(['Owner approved on 17 Nov (synthetic)']);
  });

  it.each(cases)('%s: a reason under 10 characters is still refused before the database', async (_name, run, fields) => {
    const r = await run(form({ ...fields, reason: 'short' }));
    expect(r).toMatchObject({ ok: false });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('Bitrix names and trip details: the actions the Bitrix connection page really posts (optional)', () => {
  const SUPER = { userId: USER, supabase: { rpc }, access: { userId: USER, memberships: [{ roleCode: 'super_admin', legalEntityId: ENTITY, branchId: null }], rolePermissions: [], grants: [] }, memberships: [] };
  const cases: Array<[string, (fd: FormData) => Promise<unknown>]> = [
    ['Bitrix names (setBitrixNameReadAction)', (fd) => nameMap.setBitrixNameReadAction(null, fd)],
    ['Bitrix trip details (setBitrixTripDetailsReadAction)', (fd) => tripDetails.setBitrixTripDetailsReadAction(null, fd)],
  ];

  it.each(cases)('%s: an empty or blank reason reaches the database as "No reason given"', async (_name, run) => {
    requireStaff.mockResolvedValue(SUPER);
    for (const reason of ['', ' \n ']) {
      rpc.mockClear();
      await run(form({ state: 'on', reason, confirm: 'yes' }));
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(sentReasons()).toEqual([NO_REASON_GIVEN]);
    }
  });

  it.each(cases)('%s: a typed reason is sent as typed; a short one is refused; the confirm step is still required', async (_name, run) => {
    requireStaff.mockResolvedValue(SUPER);
    await run(form({ state: 'off', reason: 'Owner approved on 18 Nov (synthetic)', confirm: 'yes' }));
    expect(sentReasons()).toEqual(['Owner approved on 18 Nov (synthetic)']);
    rpc.mockClear();
    expect(await run(form({ state: 'on', reason: 'short', confirm: 'yes' }))).toMatchObject({ ok: false, code: 'invalid_input', fields: ['reason'] });
    expect(await run(form({ state: 'on', reason: '' }))).toMatchObject({ ok: false, code: 'invalid_input', fields: ['confirm'] });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('Customer messages: the switches, pilot mode and the timer (optional); pilot Deals and text approvals (required)', () => {
  const optional: Array<[string, (fd: FormData) => Promise<unknown>, Record<string, string>]> = [
    ['message switch (A7)', (fd) => messages.setMessageSwitchAction(null as never, fd), { entityId: ENTITY, type: 'booking_confirmed', channel: 'email', enabled: 'true', expectedRowVersion: '1' }],
    ['pilot mode (A8)', (fd) => messages.setPilotOnlyAction(null as never, fd), { entityId: ENTITY, pilotOnly: 'false' }],
    ['timer (A11)', (fd) => messages.setTimerEnabledAction(null as never, fd), { enabled: 'true' }],
  ];
  const required: Array<[string, (fd: FormData) => Promise<unknown>, Record<string, string>]> = [
    ['pilot Deal add or remove (A9)', (fd) => messages.setPilotDealAction(null as never, fd), { entityId: ENTITY, dealId: OTHER, inPilot: 'true' }],
    ['WhatsApp text approval (A10)', (fd) => messages.setTemplateStatusAction(null as never, fd), { entityId: ENTITY, templateCode: 'tn_booking_confirmed_en_v1', status: 'approved' }],
  ];

  it.each(optional)('%s: an empty reason reaches the database as "No reason given"; a typed one is kept; a short one is refused', async (_name, run, fields) => {
    await run(form({ ...fields, reason: '' }));
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(sentReasons()).toEqual([NO_REASON_GIVEN]);
    rpc.mockClear();
    await run(form({ ...fields, reason: 'Owner approved on 18 Nov (synthetic)' }));
    expect(sentReasons()).toEqual(['Owner approved on 18 Nov (synthetic)']);
    rpc.mockClear();
    expect(await run(form({ ...fields, reason: 'short' }))).toMatchObject({ ok: false });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(required)('%s: not a switch, so an empty reason is refused as today, with no database call', async (_name, run, fields) => {
    for (const reason of ['', '  ']) expect(await run(form({ ...fields, reason }))).toMatchObject({ ok: false });
    expect(rpc).not.toHaveBeenCalled();
    await run(form({ ...fields, reason: 'Owner approved on 18 Nov (synthetic)' }));
    expect(sentReasons()).toEqual(['Owner approved on 18 Nov (synthetic)']);
  });
});

describe('finance modes: the Settings › Accounts switches keep a required reason (lead ruling on Q1)', () => {
  const cases: Array<[string, (fd: FormData) => Promise<unknown>, Record<string, string>]> = [
    ['Tally export', (fd) => desk.setTallyExportEnabledAction(null as never, fd), { entityId: ENTITY, enabled: 'true' }],
    ['customer documents', (fd) => documents.setCustomerDocumentsEnabledAction(null as never, fd), { entityId: ENTITY, enabled: 'true' }],
    ['automatic bills (drafts and release)', (fd) => documents.setAutoBillsAction(null as never, fd), { entityId: ENTITY, drafts: 'true', release: 'true' }],
    ['refunds', (fd) => refunds.setRefundsEnabledAction(null as never, fd), { entityId: ENTITY, enabled: 'true' }],
    ['write-offs', (fd) => writeOffs.setWriteOffAction(null as never, fd), { entityId: ENTITY, enabled: 'true', limitRupees: '5000' }],
    ['Tally import file', (fd) => tallyFile.setTallyXmlAction(null as never, fd), { entityId: ENTITY, enabled: 'true', companyName: 'Synthetic Company (Tally)' }],
  ];

  it.each(cases)('%s: an empty or blank reason is refused as today, with no database call', async (_name, run, fields) => {
    for (const reason of ['', ' \n  ']) {
      const r = await run(form({ ...fields, reason }));
      expect(r).toMatchObject({ ok: false, code: 'invalid_input' });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(cases)('%s: a typed reason is sent as typed (never replaced)', async (_name, run, fields) => {
    await run(form({ ...fields, reason: 'Owner approved on 17 Nov (synthetic)' }));
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(sentReasons()).toEqual(['Owner approved on 17 Nov (synthetic)']);
  });
});

describe('the four families keep a required reason', () => {
  it('finance modes, real booking and supplier confirmation have no change action in the CRM (read-only rows)', () => {
    for (const key of ['finance_mode', 'real_booking', 'supplier_confirmation']) {
      expect((CHANGEABLE_SWITCH_KEYS as readonly string[]).includes(key), key).toBe(false);
    }
  });

  it('Bitrix scope: "Which deals come in" refuses an empty reason as today, with no database call', async () => {
    const r = await settings.applySyncScopeAction(null, form({ previewId: '0b4e0000-0000-4000-8000-000000000001', reason: '' }));
    expect(r).toMatchObject({ ok: false, code: 'invalid_reason' });
    expect(rpc).not.toHaveBeenCalled();
  });
});
