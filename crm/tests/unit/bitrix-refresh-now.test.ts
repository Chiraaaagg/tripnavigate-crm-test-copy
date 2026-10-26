import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_READ_METHODS } from '@/modules/integration/bitrix/client';
import { resolveBitrixRestTarget } from '@/modules/integration/bitrix/config';
import { DEAL_TRIP_DETAIL_CODES } from '@/modules/integration/bitrix/trip-details';
import { DEAL_TRIP_FACT_CODES } from '@/modules/integration/bitrix/trip-facts';
import { withLinkedParties } from '@/modules/integration/bitrix/worker';
import { asRpcClient } from '@/modules/integration/commands';
import type { IntakeConfig } from '@/modules/integration/intake-config';
import {
  createRefreshBitrixClient,
  refreshDealWith,
  type RefreshDealDeps,
  type RefreshDealOutcome,
} from '@/modules/integration/server/refresh-deal';
import { startMockBitrix, syntheticDeal, type MockBitrix } from '../helpers/mock-bitrix';

/**
 * Book now v2: "Refresh from Bitrix now" (build plan section 3). The real
 * read-only Bitrix client against the in-process MOCK Bitrix server, with a
 * fake command layer (the SQL is tested in tests/db/bitrix-refresh-now.test.ts).
 * Synthetic values only; no real portal, no real webhook.
 */

const PORTAL = 'synthetic.bitrix24.example';
const MEMBER = 'SYNTH';
const DEAL_ID = 'd0000000-0000-4000-8000-0000000000aa';
const INBOX = '00000000-0000-4000-8000-000000000001';
const TOKEN = '00000000-0000-4000-8000-0000000000a1';
const MODIFIED = '2026-10-03T10:00:00+05:30';

let mock: MockBitrix;
beforeAll(async () => {
  mock = await startMockBitrix();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.deals.clear();
  mock.contacts.clear();
  mock.companies.clear();
  mock.requests.length = 0;
});

const CONFIG = (o: Partial<IntakeConfig> = {}): IntakeConfig => ({
  portalDomain: PORTAL, portalMemberId: MEMBER, categoryId: '7', categoryIds: ['7'], eligibleStageIds: ['C7:NEW'],
  cutoffAt: '2026-10-01T00:00:00+05:30', pilotLegalEntityId: null, pilotBranchId: null, enabled: true,
  lastReconciledAt: null, tripFactsRead: true, tripDetailsRead: true, ...o,
});

const ALLOWED = {
  allowed: true, inboxId: INBOX, lockToken: TOKEN, portalMemberId: MEMBER, sourceDealId: '81',
  sourceObject: 'deal', eventType: 'RECONCILE', origin: 'staff_refresh', attempts: 1,
};

type Answer = { data: unknown; error: { code: string; message: string } | null };
interface FakeOptions {
  begin?: Answer;
  apply?: unknown;
  facts?: unknown;
  party?: unknown;
}

/** Fake command layer: records every call; the user and admin clients are kept apart. */
function fakeDb(o: FakeOptions = {}) {
  const user: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const admin: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const userRpc = async (fn: string, args: Record<string, unknown> = {}): Promise<Answer> => {
    user.push({ fn, args });
    if (fn === 'booking_bitrix_refresh_begin') return o.begin ?? { data: ALLOWED, error: null };
    return { data: null, error: { code: '42501', message: 'not allowed on the user session' } };
  };
  const adminRpc = async (fn: string, args: Record<string, unknown> = {}): Promise<Answer> => {
    admin.push({ fn, args });
    switch (fn) {
      case 'integration_apply_bitrix_deal':
        return { data: o.apply ?? { outcome: 'updated', dealId: DEAL_ID, reasonCode: null }, error: null };
      case 'integration_apply_bitrix_trip_facts':
        return { data: o.facts ?? { outcome: 'unchanged', parties: [] }, error: null };
      case 'integration_apply_bitrix_party':
        return { data: o.party ?? { outcome: 'unchanged' }, error: null };
      case 'integration_fail_inbox':
        return { data: { status: 'failed' }, error: null };
      case 'integration_release_inbox':
        return { data: { status: 'pending' }, error: null };
      default:
        return { data: null, error: { code: '42883', message: 'unknown' } };
    }
  };
  return { user, admin, userRpc: asRpcClient({ rpc: userRpc } as never), adminRpc: asRpcClient({ rpc: adminRpc } as never) };
}

function deps(db: ReturnType<typeof fakeDb>, o: Partial<RefreshDealDeps> & { timeoutMs?: number; config?: IntakeConfig } = {}): RefreshDealDeps {
  return {
    userRpc: db.userRpc,
    adminRpc: () => db.adminRpc,
    loadConfig: async () => o.config ?? CONFIG(),
    bitrix: () => createRefreshBitrixClient(resolveBitrixRestTarget(mock.baseUrl, PORTAL, 'local'), { timeoutMs: o.timeoutMs ?? 10_000 }),
    runtimeAllowed: () => true,
    requestId: () => '00000000-0000-4000-8000-0000000000f1',
    now: () => Date.parse('2026-10-26T10:00:00Z'),
    ...o,
  };
}

function bitrixDeal(o: Record<string, unknown> = {}) {
  return syntheticDeal(81, {
    STAGE_ID: 'C7:NEW', ASSIGNED_BY_ID: '101', DATE_CREATE: MODIFIED, DATE_MODIFY: MODIFIED, LEAD_ID: '',
    [DEAL_TRIP_FACT_CODES.bookingNotes]: 'Synthetic notes',
    [DEAL_TRIP_FACT_CODES.travellerTotal]: '3',
    [DEAL_TRIP_DETAIL_CODES.adults]: '2',
    [DEAL_TRIP_DETAIL_CODES.children]: '1',
    CONTACT_ID: '9001', CONTACT_IDS: ['9001'], COMPANY_ID: '7001',
    ...o,
  });
}
function seedParties() {
  mock.contacts.set('9001', { ID: '9001', NAME: 'Synthetic', LAST_NAME: 'Traveller', PHONE: [], EMAIL: [], DATE_MODIFY: MODIFIED, COMMENTS: 'drop me' });
  mock.companies.set('7001', { ID: '7001', TITLE: 'Synthetic Travel Co', PHONE: [], EMAIL: [], DATE_MODIFY: MODIFIED });
}
const methods = () => mock.requests.map((r) => r.method);
const READ_AT = '2026-10-26T10:00:00.000Z';

describe('refreshDealWith (mock Bitrix)', () => {
  it('updated: reads the Deal and its linked Contact and Company, read methods only', async () => {
    mock.deals.set('81', bitrixDeal());
    seedParties();
    const db = fakeDb();
    expect(await refreshDealWith(deps(db), DEAL_ID)).toEqual<RefreshDealOutcome>({ kind: 'updated', readAt: READ_AT });

    // Authorization first, under the user's session; the privileged client only after it.
    expect(db.user.map((c) => c.fn)).toEqual(['booking_bitrix_refresh_begin']);
    expect(db.user[0]!.args).toEqual({ p_deal_id: DEAL_ID, p_request_id: '00000000-0000-4000-8000-0000000000f1' });
    expect(db.admin.map((c) => c.fn)).toEqual([
      'integration_apply_bitrix_deal',
      'integration_apply_bitrix_trip_facts',
      'integration_apply_bitrix_party',
      'integration_apply_bitrix_party',
    ]);
    expect(db.admin[0]!.args).toMatchObject({ p_inbox_id: INBOX, p_lock_token: TOKEN });
    // The database asked for no party; the refresh reads them anyway.
    expect(methods()).toEqual(['crm.deal.get', 'crm.contact.get', 'crm.company.get']);
    for (const m of methods()) expect(ALLOWED_READ_METHODS).toContain(m);
    expect(methods().some((m) => /\.(add|update|delete|set)$/.test(m))).toBe(false);
    // Values reach only the database commands; the outcome carries none.
    const facts = db.admin[1]!.args.p_facts as Record<string, unknown>;
    expect(facts).toMatchObject({ bookingNotes: 'Synthetic notes', travellerTotal: 3, adults: 2, children: 1, contactId: '9001' });
    expect(JSON.stringify(db.admin[2]!.args)).not.toContain('drop me');
  });

  it('unchanged: an unchanged Deal (stale_ignored) still stores its facts and re-reads its parties', async () => {
    mock.deals.set('81', bitrixDeal());
    seedParties();
    const db = fakeDb({ apply: { outcome: 'stale_ignored', dealId: DEAL_ID, reasonCode: 'stale_ignored' } });
    expect(await refreshDealWith(deps(db), DEAL_ID)).toEqual({ kind: 'unchanged', readAt: READ_AT });
    expect(db.admin.map((c) => c.fn)).toContain('integration_apply_bitrix_trip_facts');
    expect(methods()).toEqual(['crm.deal.get', 'crm.contact.get', 'crm.company.get']);
  });

  it('unchanged Deal with new facts or a changed Contact counts as updated', async () => {
    mock.deals.set('81', bitrixDeal());
    seedParties();
    const stale = { outcome: 'stale_ignored', dealId: DEAL_ID, reasonCode: 'stale_ignored' };
    const facts = fakeDb({ apply: stale, facts: { outcome: 'stored', parties: [] } });
    expect((await refreshDealWith(deps(facts), DEAL_ID)).kind).toBe('updated');
    const party = fakeDb({ apply: stale, party: { outcome: 'stored' } });
    expect((await refreshDealWith(deps(party), DEAL_ID)).kind).toBe('updated');
  });

  it('a Deal outside the sync (ignored) reads as unchanged with no read time', async () => {
    mock.deals.set('81', bitrixDeal());
    const db = fakeDb({ apply: { outcome: 'ignored', dealId: null, reasonCode: 'not_in_manifest' } });
    expect(await refreshDealWith(deps(db), DEAL_ID)).toEqual({ kind: 'unchanged', readAt: null });
    expect(db.admin.map((c) => c.fn)).not.toContain('integration_apply_bitrix_trip_facts');
  });

  it('not found: the apply gets null and the answer is bitrix_deal_not_found', async () => {
    const db = fakeDb({ apply: { outcome: 'needs_review', dealId: null, reasonCode: 'source_deal_not_found' } });
    expect(await refreshDealWith(deps(db), DEAL_ID)).toEqual({ kind: 'bitrix_deal_not_found' });
    expect(db.admin[0]).toMatchObject({ fn: 'integration_apply_bitrix_deal', args: { p_deal: null } });
    expect(methods()).toEqual(['crm.deal.get']);
  });

  it('a Deal the CRM keeps for review (owner or data issue) is not_applied', async () => {
    mock.deals.set('81', bitrixDeal());
    const db = fakeDb({ apply: { outcome: 'needs_review', dealId: null, reasonCode: 'unmapped_owner' } });
    expect(await refreshDealWith(deps(db), DEAL_ID)).toEqual({ kind: 'bitrix_unavailable', detail: 'not_applied' });
  });

  it('timeout: bitrix_unavailable, the row is failed as a retryable provider timeout', async () => {
    mock.deals.set('81', bitrixDeal());
    mock.failNext('crm.deal.get', 'hang');
    const db = fakeDb();
    expect(await refreshDealWith(deps(db, { timeoutMs: 50 }), DEAL_ID)).toEqual({ kind: 'bitrix_unavailable', detail: 'provider' });
    expect(db.admin.map((c) => c.fn)).toEqual(['integration_fail_inbox']);
    expect(db.admin[0]!.args).toMatchObject({ p_error_code: 'provider_timeout', p_retryable: true });
  });

  it('rate limit: one request only (no retry), the row is failed as rate limited', async () => {
    mock.deals.set('81', bitrixDeal());
    mock.failNext('crm.deal.get', { status: 503, body: { error: 'QUERY_LIMIT_EXCEEDED', error_description: 'Too many requests' } });
    const db = fakeDb();
    expect(await refreshDealWith(deps(db), DEAL_ID)).toEqual({ kind: 'bitrix_unavailable', detail: 'provider' });
    expect(methods()).toEqual(['crm.deal.get']);
    expect(db.admin[0]!.args).toMatchObject({ p_error_code: 'provider_rate_limited', p_retryable: true });
  });

  it('rate limit on the Contact read: the Deal is applied, the answer is partial', async () => {
    mock.deals.set('81', bitrixDeal());
    seedParties();
    mock.failNext('crm.contact.get', { status: 503, body: { error: 'QUERY_LIMIT_EXCEEDED', error_description: 'Too many requests' } });
    const db = fakeDb();
    expect(await refreshDealWith(deps(db), DEAL_ID)).toEqual({ kind: 'bitrix_unavailable', detail: 'partial' });
    expect(db.admin.map((c) => c.fn)).not.toContain('integration_fail_inbox');
    expect(methods()).toEqual(['crm.deal.get', 'crm.contact.get']);
  });

  it('switched off: no privileged call and no Bitrix request', async () => {
    const db = fakeDb({ begin: { data: { allowed: false, reason: 'switched_off' }, error: null } });
    const adminRpc = vi.fn(() => db.adminRpc);
    expect(await refreshDealWith(deps(db, { adminRpc }), DEAL_ID)).toEqual({ kind: 'switched_off' });
    expect(adminRpc).not.toHaveBeenCalled();
    expect(mock.requests).toEqual([]);
  });

  it('too soon: the wait in seconds, nothing read', async () => {
    const db = fakeDb({ begin: { data: { allowed: false, reason: 'too_soon', retryAfterSeconds: 14 }, error: null } });
    expect(await refreshDealWith(deps(db), DEAL_ID)).toEqual({ kind: 'too_soon', scope: 'deal', retryAfterSeconds: 14 });
    expect(db.admin).toEqual([]);
    expect(mock.requests).toEqual([]);
  });

  it('per-staff limit (10 a minute): too_soon with scope staff, nothing read', async () => {
    const db = fakeDb({ begin: { data: { allowed: false, reason: 'staff_limit', retryAfterSeconds: 37 }, error: null } });
    expect(await refreshDealWith(deps(db), DEAL_ID)).toEqual({ kind: 'too_soon', scope: 'staff', retryAfterSeconds: 37 });
    expect(db.admin).toEqual([]);
    expect(mock.requests).toEqual([]);
  });

  it('scheduled sync paused: sync_paused, nothing read', async () => {
    const db = fakeDb({ begin: { data: { allowed: false, reason: 'sync_paused' }, error: null } });
    expect(await refreshDealWith(deps(db), DEAL_ID)).toEqual({ kind: 'sync_paused' });
    expect(db.admin).toEqual([]);
    expect(mock.requests).toEqual([]);
  });

  it('not a Bitrix Deal / removed: refused before any read', async () => {
    for (const reason of ['not_bitrix_deal', 'deal_removed'] as const) {
      const db = fakeDb({ begin: { data: { allowed: false, reason }, error: null } });
      expect(await refreshDealWith(deps(db), DEAL_ID)).toEqual({ kind: reason });
    }
    expect(mock.requests).toEqual([]);
  });

  it('database refusals map to codes; an unknown error is rethrown', async () => {
    const cases: Array<[Answer['error'], RefreshDealOutcome]> = [
      [{ code: '42501', message: 'not_authorized' }, { kind: 'not_authorized' }],
      [{ code: '22023', message: 'invalid_input' }, { kind: 'invalid_input' }],
      [{ code: '55000', message: 'environment_unset' }, { kind: 'environment_unset' }],
      [{ code: '55000', message: 'not_configured' }, { kind: 'bitrix_unavailable', detail: 'not_configured' }],
      [{ code: '23505', message: 'request_conflict' }, { kind: 'bitrix_unavailable', detail: 'unconfirmed' }],
    ];
    for (const [error, expected] of cases) {
      const db = fakeDb({ begin: { data: null, error } });
      expect(await refreshDealWith(deps(db), DEAL_ID)).toEqual(expected);
      expect(db.admin).toEqual([]);
    }
    const odd = fakeDb({ begin: { data: { allowed: true }, error: null } });
    await expect(refreshDealWith(deps(odd), DEAL_ID)).rejects.toThrow();
  });

  it('no read credential or a Preview runtime: the lease is handed back, nothing read', async () => {
    const noClient = fakeDb();
    expect(await refreshDealWith(deps(noClient, { bitrix: () => null }), DEAL_ID)).toEqual({ kind: 'bitrix_unavailable', detail: 'not_configured' });
    expect(noClient.admin.map((c) => c.fn)).toEqual(['integration_release_inbox']);
    const preview = fakeDb();
    expect(await refreshDealWith(deps(preview, { runtimeAllowed: () => false }), DEAL_ID)).toEqual({
      kind: 'bitrix_unavailable', detail: 'not_configured',
    });
    expect(preview.admin.map((c) => c.fn)).toEqual(['integration_release_inbox']);
    expect(mock.requests).toEqual([]);
  });

  it('facts switch off (details only): no Contact or Company read', async () => {
    mock.deals.set('81', bitrixDeal());
    seedParties();
    const db = fakeDb();
    await refreshDealWith(deps(db, { config: CONFIG({ tripFactsRead: false }) }), DEAL_ID);
    expect(methods()).toEqual(['crm.deal.get']);
    expect(db.admin[1]!.args.p_facts).not.toHaveProperty('contactId');
  });
});

describe('withLinkedParties', () => {
  it('adds the primary Contact (CONTACT_ID, else the lowest id) and the Company once', () => {
    const facts = { dateModify: null, contactId: null, contactIds: ['9010', '9002'], companyId: '7001' };
    expect(withLinkedParties([{ kind: 'company', id: '7001' }], facts)).toEqual([
      { kind: 'company', id: '7001' },
      { kind: 'contact', id: '9002' },
    ]);
    expect(withLinkedParties([], { dateModify: null })).toEqual([]);
    const lead = { dateModify: null, customerTypeId: null, contactId: '1', contactIds: [], companyId: '2', companyTitle: null, issues: [] };
    expect(withLinkedParties([], lead)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Server action
// ---------------------------------------------------------------------------

const { refreshDealNow, revalidatePath, requireStaff } = vi.hoisted(() => ({
  refreshDealNow: vi.fn(),
  revalidatePath: vi.fn(),
  requireStaff: vi.fn(async () => ({ userId: 'u1', supabase: { rpc: vi.fn() } })),
}));
vi.mock('@/modules/integration/server', () => ({ refreshDealNow }));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@/modules/identity/server/session', () => ({ requireStaff }));

describe('refreshFromBitrixAction', () => {
  beforeEach(() => {
    refreshDealNow.mockReset();
    revalidatePath.mockReset();
  });
  const act = async (outcome: RefreshDealOutcome, dealId = DEAL_ID) => {
    refreshDealNow.mockResolvedValueOnce(outcome);
    const { refreshFromBitrixAction } = await import('@/modules/fulfilment/server/bitrix-refresh-action');
    return refreshFromBitrixAction(dealId);
  };

  it('updated / unchanged: ok with the frozen data shape, and the book route is revalidated', async () => {
    expect(await act({ kind: 'updated', readAt: READ_AT })).toEqual({
      ok: true, data: { outcome: 'updated', readAt: READ_AT }, message: 'Updated from Bitrix. The trip facts now match the Deal.',
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/app/deals/${DEAL_ID}/book`);
    expect(revalidatePath).toHaveBeenCalledWith('/app/deals/[id]/book', 'layout');
    const same = await act({ kind: 'unchanged', readAt: READ_AT });
    expect(same).toMatchObject({ ok: true, data: { outcome: 'unchanged', readAt: READ_AT } });
    expect(same.message).toMatch(/^Checked Bitrix\. Nothing has changed/);
    expect((await act({ kind: 'unchanged', readAt: null })).message).toMatch(/outside what the CRM copies/);
  });

  it('refusals carry the frozen BitrixRefreshRefusal codes and plain messages', async () => {
    const cases: Array<[RefreshDealOutcome, string, RegExp]> = [
      [{ kind: 'too_soon', scope: 'deal', retryAfterSeconds: 14 }, 'refresh_too_soon', /refreshed a moment ago\. Try again in 14 seconds\./],
      [{ kind: 'too_soon', scope: 'staff', retryAfterSeconds: 37 }, 'refresh_too_soon', /10 times in the last minute\. Try again in 37 seconds\./],
      [{ kind: 'switched_off' }, 'refresh_switched_off', /switched off/],
      [{ kind: 'sync_paused' }, 'refresh_switched_off', /^Bitrix updates are paused by an admin, so this Deal cannot be refreshed now\.$/],
      [{ kind: 'not_bitrix_deal' }, 'refresh_not_bitrix_deal', /did not come from Bitrix/],
      [{ kind: 'deal_removed' }, 'refresh_not_bitrix_deal', /no longer copied from Bitrix/],
      [{ kind: 'bitrix_deal_not_found' }, 'bitrix_deal_not_found', /cannot find this Deal/],
      [{ kind: 'bitrix_unavailable', detail: 'provider' }, 'bitrix_unavailable', /did not answer just now/],
      [{ kind: 'bitrix_unavailable', detail: 'partial' }, 'bitrix_unavailable', /part-way/],
      [{ kind: 'bitrix_unavailable', detail: 'not_applied' }, 'bitrix_unavailable', /could not take these details/],
      [{ kind: 'bitrix_unavailable', detail: 'not_configured' }, 'bitrix_unavailable', /not set up on this server/],
      [{ kind: 'bitrix_unavailable', detail: 'unconfirmed' }, 'bitrix_unavailable', /could not confirm/],
      [{ kind: 'not_authorized' }, 'not_authorized', /can’t do this on this deal/],
      [{ kind: 'environment_unset' }, 'environment_unset', /not set up yet/],
    ];
    for (const [outcome, code, message] of cases) {
      const r = await act(outcome);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe(code);
        expect(r.message).toMatch(message);
      }
    }
  });

  it('refusals before any read do not revalidate; an invalid id is refused without a call', async () => {
    await act({ kind: 'too_soon', scope: 'deal', retryAfterSeconds: 5 });
    await act({ kind: 'sync_paused' });
    await act({ kind: 'switched_off' });
    expect(revalidatePath).not.toHaveBeenCalled();
    refreshDealNow.mockReset();
    const { refreshFromBitrixAction } = await import('@/modules/fulfilment/server/bitrix-refresh-action');
    expect(await refreshFromBitrixAction('not-a-uuid')).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(refreshDealNow).not.toHaveBeenCalled();
  });
});
