import { describe, expect, it, vi } from 'vitest';
import { ALLOWED_READ_METHODS, BitrixClientError, createBitrixClient } from '@/modules/integration/bitrix/client';
import { resolveBitrixRestTarget } from '@/modules/integration/bitrix/config';
import {
  DEAL_TRIP_FACT_CODES,
  DEAL_TRIP_FACT_FIELDS,
  LEAD_CUSTOMER_TYPE_CODE,
  TRIP_FACT_ISSUES,
  toCalendarDate,
  toCompanySnapshot,
  toContactSnapshot,
  toDealTripFacts,
  toEmails,
  toLeadSourceFacts,
  toPhones,
  toTravellerTotal,
} from '@/modules/integration/bitrix/trip-facts';
import { runInboxBatch, storeTripFacts, type WorkerDeps } from '@/modules/integration/bitrix/worker';
import { asRpcClient } from '@/modules/integration/commands';
import { parseIntakeConfigRow, selectIntakeConfig, type IntakeConfig } from '@/modules/integration/intake-config';

/**
 * B1.2 (DEC-36/37), migration 20261120000400: read-only Bitrix trip facts.
 * MOCK Bitrix only: a stubbed fetch or a fake client; no real portal, no real
 * webhook. Synthetic values only.
 */

const MODIFIED = '2026-10-03T10:00:00+05:30';
const SYNTHETIC_BASE = 'http://127.0.0.1:1/rest/1/syntheticCode0001/';

describe('field codes (owner-named, metadata of 12 October 2026)', () => {
  it('reads exactly the DEC-36 Deal fields and never the integer "Booking Note"', () => {
    expect(DEAL_TRIP_FACT_CODES).toEqual({
      bookingNotes: 'UF_CRM_1784359625',
      travellerTotal: 'UF_CRM_68A83F91534CA',
      tourStart: 'UF_CRM_1763180657',
      tourEnd: 'UF_CRM_68A83F9189BC9',
      customerType: 'UF_CRM_69203B670C550',
    });
    expect(DEAL_TRIP_FACT_FIELDS).not.toContain('UF_CRM_1784372510');
    expect(LEAD_CUSTOMER_TYPE_CODE).toBe('UF_CRM_1761567338034');
    // No file, passport, budget, destination or adult/child field.
    for (const code of ['UF_CRM_1784359513', 'UF_CRM_6876462911034', 'UF_CRM_68A83F913F4EF', 'UF_CRM_6ABA0F263E53D']) {
      expect(DEAL_TRIP_FACT_FIELDS).not.toContain(code);
    }
  });

  it('the client allowlist gains only the two read methods', () => {
    expect(ALLOWED_READ_METHODS).toContain('crm.contact.get');
    expect(ALLOWED_READ_METHODS).toContain('crm.company.get');
    for (const m of ALLOWED_READ_METHODS) expect(m).not.toMatch(/\.(add|update|delete|set)$/);
    expect(ALLOWED_READ_METHODS).not.toContain('crm.contact.list');
  });
});

describe('normalisation', () => {
  it('Total Number of Travelers: whole numbers 0-100 only, with an issue code otherwise', () => {
    expect(toTravellerTotal('4.00')).toEqual({ total: 4, issue: null });
    expect(toTravellerTotal(0)).toEqual({ total: 0, issue: null });
    expect(toTravellerTotal('')).toEqual({ total: null, issue: null });
    expect(toTravellerTotal(null)).toEqual({ total: null, issue: null });
    expect(toTravellerTotal('2.5')).toEqual({ total: null, issue: 'travellers_not_whole' });
    expect(toTravellerTotal('-3')).toEqual({ total: null, issue: 'travellers_not_whole' });
    expect(toTravellerTotal('101')).toEqual({ total: null, issue: 'travellers_out_of_range' });
  });

  it('dates take the calendar day Bitrix sends and refuse impossible ones', () => {
    expect(toCalendarDate('2026-11-20T03:00:00+03:00')).toEqual({ date: '2026-11-20', unreadable: false });
    expect(toCalendarDate('2026-11-20')).toEqual({ date: '2026-11-20', unreadable: false });
    expect(toCalendarDate('')).toEqual({ date: null, unreadable: false });
    expect(toCalendarDate('2026-02-30T00:00:00+03:00')).toEqual({ date: null, unreadable: true });
    expect(toCalendarDate('20/11/2026')).toEqual({ date: null, unreadable: true });
  });

  it('a Deal record becomes the facts shape; unrelated keys never pass', () => {
    const raw = {
      ID: '77', DATE_MODIFY: MODIFIED, OPPORTUNITY: '99999', UF_CRM_1784372510: '5', UF_CRM_1784359513: [{ id: 1 }],
      [DEAL_TRIP_FACT_CODES.bookingNotes]: '  Synthetic notes\u0007 line one\nline two  ',
      [DEAL_TRIP_FACT_CODES.travellerTotal]: '3.00',
      [DEAL_TRIP_FACT_CODES.tourStart]: '2026-11-25T03:00:00+03:00',
      [DEAL_TRIP_FACT_CODES.tourEnd]: '2026-11-20T03:00:00+03:00',
      [DEAL_TRIP_FACT_CODES.customerType]: 5049,
      CONTACT_ID: '0', CONTACT_IDS: ['9002', 9002, '0', 'x'], COMPANY_ID: '7001',
    };
    const facts = toDealTripFacts(raw);
    expect(facts).toEqual({
      dateModify: MODIFIED,
      bookingNotes: 'Synthetic notes line one\nline two',
      travellerTotal: 3,
      tourStart: '2026-11-25',
      tourEnd: '2026-11-20',
      customerTypeId: '5049',
      contactId: null,
      contactIds: ['9002'],
      companyId: '7001',
      issues: ['tour_end_before_start'],
    });
    expect(JSON.stringify(facts)).not.toContain('99999');
    for (const issue of facts.issues) expect(TRIP_FACT_ISSUES).toContain(issue);
  });

  it('long Booking Notes are cut with an issue; unreadable values become issues, never guesses', () => {
    const facts = toDealTripFacts({
      DATE_MODIFY: MODIFIED,
      [DEAL_TRIP_FACT_CODES.bookingNotes]: 'x'.repeat(4100),
      [DEAL_TRIP_FACT_CODES.customerType]: 'B2D',
      [DEAL_TRIP_FACT_CODES.tourStart]: 'soon',
      CONTACT_IDS: Array.from({ length: 25 }, (_, i) => String(100 + i)),
    });
    expect(facts.bookingNotes).toHaveLength(4000);
    expect(facts.customerTypeId).toBeNull();
    expect(facts.contactIds).toHaveLength(20);
    expect(facts.issues).toEqual(['booking_notes_truncated', 'contact_ids_truncated', 'customer_type_unreadable', 'tour_start_unreadable']);
  });

  it('an unusable DATE_MODIFY is sent as null with an issue code, never as an empty string', () => {
    const facts = toDealTripFacts({ DATE_MODIFY: 'yesterday' });
    expect(facts.dateModify).toBeNull();
    expect(facts.issues).toEqual(['date_modify_unreadable']);
    expect(toLeadSourceFacts({}).issues).toEqual(['date_modify_unreadable']);
  });

  it('a Lead gives Customer Type, links and company name only', () => {
    expect(
      toLeadSourceFacts({ DATE_MODIFY: MODIFIED, [LEAD_CUSTOMER_TYPE_CODE]: '1353', CONTACT_ID: '9001', CONTACT_IDS: [], COMPANY_ID: '', COMPANY_TITLE: ' Synthetic\nAgency ' }),
    ).toEqual({
      dateModify: MODIFIED, customerTypeId: '1353', contactId: '9001', contactIds: [], companyId: null, companyTitle: 'Synthetic Agency', issues: [],
    });
  });

  it('Contact and Company snapshots keep name, phones and e-mails only', () => {
    const contact = toContactSnapshot({
      ID: '9001', NAME: 'Synthetic', SECOND_NAME: '', LAST_NAME: 'Traveller', DATE_MODIFY: MODIFIED,
      PHONE: [{ VALUE: '+91 55555 01234', VALUE_TYPE: 'MOBILE' }, { VALUE: 'call me', VALUE_TYPE: 'WORK' }, { VALUE: '+91 55555 01234' }],
      EMAIL: [{ VALUE: 'Synthetic.Traveller@Example.TEST' }, { VALUE: 'not-an-email' }],
    } as never);
    expect(contact).toEqual({
      kind: 'contact', id: '9001', dateModify: MODIFIED, name: 'Synthetic Traveller',
      phones: ['+91 55555 01234'], emails: ['synthetic.traveller@example.test'],
    });
    expect(toCompanySnapshot({ ID: '0', TITLE: 'x' })).toBeNull();
    expect(toCompanySnapshot({ ID: '7001', TITLE: 'Synthetic Travel Co', DATE_MODIFY: 'bad' })).toMatchObject({ name: 'Synthetic Travel Co', dateModify: null });
    expect(toPhones(Array.from({ length: 8 }, (_, i) => ({ VALUE: `55555 0000${i}` })))).toHaveLength(5);
    expect(toEmails('not a list')).toEqual([]);
  });
});

/** A stubbed fetch standing in for the portal (no network). */
function stubFetch(answers: Record<string, unknown>) {
  const calls: Array<{ method: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const method = String(url).replace(SYNTHETIC_BASE, '').replace(/\.json$/, '');
    calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const body = init?.body ? (JSON.parse(String(init.body)) as { id?: string }) : {};
    const answer = answers[method];
    // A record answers only for its own id (anything else is "not found").
    const result =
      answer && typeof answer === 'object' && 'ID' in answer && body.id !== undefined && String((answer as { ID: unknown }).ID) !== body.id
        ? undefined
        : answer;
    if (result === undefined) return new Response(JSON.stringify({ error: 'NOT_FOUND', error_description: 'Not found' }), { status: 400 });
    return new Response(JSON.stringify({ result }), { status: 200 });
  });
  const client = createBitrixClient({
    target: resolveBitrixRestTarget(SYNTHETIC_BASE, 'synthetic.bitrix24.example', 'local'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: async () => undefined,
  });
  return { client, calls };
}

describe('client (stubbed fetch)', () => {
  it('Contact and Company answers are reduced to the basic keys immediately', async () => {
    const { client, calls } = stubFetch({
      'crm.contact.get': {
        ID: '9001', NAME: 'Synthetic', LAST_NAME: 'Traveller', PHONE: [{ VALUE: '+91 55555 01234' }], EMAIL: [],
        BIRTHDATE: '1990-01-01', UF_CRM_1756979555714: 'PASSPORT-SYNTH', ADDRESS: 'Synthetic street', DATE_MODIFY: MODIFIED,
      },
      'crm.company.get': { ID: '7001', TITLE: 'Synthetic Travel Co', UF_CRM_1786707004988: 1, PHONE: [], EMAIL: [], DATE_MODIFY: MODIFIED },
    });
    const c = await client.getContactBasics('9001');
    expect(c.kind).toBe('ok');
    expect(Object.keys(c.kind === 'ok' ? c.contact : {}).sort()).toEqual(['DATE_MODIFY', 'EMAIL', 'ID', 'LAST_NAME', 'NAME', 'PHONE']);
    expect(JSON.stringify(c)).not.toMatch(/PASSPORT|1990|street/);
    const co = await client.getCompanyBasics('7001');
    expect(Object.keys(co.kind === 'ok' ? co.company : {}).sort()).toEqual(['DATE_MODIFY', 'EMAIL', 'ID', 'PHONE', 'TITLE']);
    expect(calls.map((x) => x.method)).toEqual(['crm.contact.get', 'crm.company.get']);
    expect(await client.getContactBasics('9999')).toEqual({ kind: 'not_found' });
    await expect(client.getContactBasics('0')).rejects.toBeInstanceOf(BitrixClientError);
  });

  it('getLead keeps the header only, and the Lead fact keys only when asked', async () => {
    const { client } = stubFetch({
      'crm.lead.get': {
        ID: '501', TITLE: 'T', STATUS_ID: 'NEW', SOURCE_ID: 'WEBFORM', ASSIGNED_BY_ID: '101', DATE_CREATE: MODIFIED, DATE_MODIFY: MODIFIED,
        PHONE: [{ VALUE: '+91 55555 01234' }], COMMENTS: 'synthetic comment', [LEAD_CUSTOMER_TYPE_CODE]: '1353', CONTACT_ID: '9001',
        COMPANY_ID: '0', COMPANY_TITLE: 'Synthetic Agency', UF_CRM_LEAD_1790248546443: 'budget',
      },
    });
    const plain = await client.getLead('501');
    expect(plain).not.toHaveProperty('facts');
    const withFacts = await client.getLead('501', { facts: true });
    expect(withFacts.kind === 'ok' && Object.keys(withFacts.facts ?? {}).sort()).toEqual(
      ['COMPANY_ID', 'COMPANY_TITLE', 'CONTACT_ID', 'DATE_MODIFY', LEAD_CUSTOMER_TYPE_CODE].sort(),
    );
    expect(JSON.stringify(withFacts)).not.toMatch(/55555|synthetic comment|budget/);
  });
});

describe('intake config switches', () => {
  it('read as off when absent (older database) and as set when present', () => {
    const base = {
      portal_domain: 'synthetic.example.test', portal_member_id: 'M', category_id: 7, eligible_stage_ids: ['C7:NEW'],
      cutoff_at: '2026-10-01T00:00:00+05:30', enabled: true,
    };
    expect(parseIntakeConfigRow(base)).toMatchObject({ tripFactsRead: false, leadIntakeUnowned: false });
    expect(parseIntakeConfigRow({ ...base, bitrix_trip_facts_read: true, lead_intake_unowned: true })).toMatchObject({
      tripFactsRead: true, leadIntakeUnowned: true,
    });
  });

  it('falls back to the older column lists on a database without the new columns', async () => {
    const tried: string[] = [];
    const select = async (columns: string) => {
      tried.push(columns);
      return columns.includes('bitrix_trip_facts_read') || columns.includes('deal_entry_stage_ids')
        ? { data: null, error: { code: '42703' } }
        : { data: [], error: null };
    };
    expect((await selectIntakeConfig(select)).error).toBeNull();
    // B1.2 0700 adds one more level (the ID-proof copy switch) on top, and
    // Batch 1 B1-1 (20261121000100) one more (the name-read switch), and the
    // voice-note batch (20261128000100) one more (the trip details switch).
    expect(tried).toHaveLength(6);
    expect(tried[0]).toContain('bitrix_trip_details_read');
    expect(tried[1]).toContain('bitrix_name_read');
    expect(tried[1]).not.toContain('bitrix_trip_details_read');
    expect(tried[2]).toContain('bitrix_id_proof_copy');
    expect(tried[3]).toContain('lead_intake_unowned');
    expect(tried[5]).not.toContain('deal_entry_stage_ids');
  });
});

// ---------------------------------------------------------------------------
// Worker with a fake client and a fake command layer
// ---------------------------------------------------------------------------

const CONFIG = (o: Partial<IntakeConfig> = {}): IntakeConfig => ({
  portalDomain: 'synthetic.bitrix24.example', portalMemberId: 'SYNTH', categoryId: '7', categoryIds: ['7'],
  eligibleStageIds: ['C7:NEW'], cutoffAt: '2026-10-01T00:00:00+05:30', pilotLegalEntityId: null, pilotBranchId: null,
  enabled: true, lastReconciledAt: null, ...o,
});

function fakeRpc(opts: { factsOutcome?: unknown; factsError?: boolean; items?: Array<{ id: string; object: 'deal' | 'lead' }> } = {}) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const items = opts.items ?? [{ id: '81', object: 'deal' as const }];
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
    calls.push({ fn, args });
    switch (fn) {
      case 'integration_claim_inbox':
        return {
          data: items.map((it, i) => ({
            inboxId: `00000000-0000-4000-8000-00000000000${i + 1}`, lockToken: `00000000-0000-4000-8000-0000000000a${i + 1}`,
            portalMemberId: 'SYNTH', sourceObject: it.object, sourceId: it.id,
            eventType: it.object === 'lead' ? 'ONCRMLEADUPDATE' : 'ONCRMDEALUPDATE', origin: 'event', attempts: 1,
          })),
          error: null,
        };
      case 'integration_apply_bitrix_deal':
        return { data: { outcome: 'created', dealId: '00000000-0000-4000-8000-0000000000d1', reasonCode: null }, error: null };
      case 'integration_apply_bitrix_lead':
        return { data: { outcome: 'updated', leadId: '00000000-0000-4000-8000-0000000000e1', reasonCode: null }, error: null };
      case 'integration_apply_bitrix_trip_facts':
        if (opts.factsError) return { data: null, error: { code: '22023', message: 'invalid_input' } };
        return { data: opts.factsOutcome ?? { outcome: 'stored', parties: [{ kind: 'contact', id: '9001' }, { kind: 'company', id: '7001' }] }, error: null };
      case 'integration_apply_bitrix_party':
        return { data: { outcome: 'stored' }, error: null };
      default:
        return { data: null, error: { code: '42883', message: 'unknown' } };
    }
  };
  return { rpc: asRpcClient({ rpc } as never), calls };
}

const dealRecord = {
  ID: '81', TITLE: 'Synthetic', STAGE_ID: 'C7:NEW', CATEGORY_ID: '7', ASSIGNED_BY_ID: '101', DATE_CREATE: MODIFIED, DATE_MODIFY: MODIFIED,
  SOURCE_ID: 'WEB', LEAD_ID: '', [DEAL_TRIP_FACT_CODES.bookingNotes]: 'Synthetic notes', [DEAL_TRIP_FACT_CODES.travellerTotal]: '2.00',
  CONTACT_ID: '9001', CONTACT_IDS: ['9001'], COMPANY_ID: '7001',
};

function fakeBitrix(o: { contactError?: BitrixClientError } = {}) {
  return {
    getDeal: vi.fn(async () => ({ kind: 'ok' as const, deal: dealRecord })),
    getLead: vi.fn(async (_id: string, opts?: { facts?: boolean }) => ({
      kind: 'ok' as const,
      lead: { ID: '82', TITLE: 'L', STATUS_ID: 'NEW', SOURCE_ID: 'WEB', ASSIGNED_BY_ID: '101', DATE_CREATE: MODIFIED, DATE_MODIFY: MODIFIED },
      ...(opts?.facts ? { facts: { DATE_MODIFY: MODIFIED, [LEAD_CUSTOMER_TYPE_CODE]: '1353', CONTACT_ID: '9001' } } : {}),
    })),
    getContactBasics: vi.fn(async (id: string) => {
      if (o.contactError) throw o.contactError;
      return { kind: 'ok' as const, contact: { ID: id, NAME: 'Synthetic', LAST_NAME: 'Traveller', PHONE: [], EMAIL: [], DATE_MODIFY: MODIFIED } };
    }),
    getCompanyBasics: vi.fn(async (id: string) => ({ kind: 'ok' as const, company: { ID: id, TITLE: 'Synthetic Travel Co', PHONE: [], EMAIL: [] } })),
  };
}

describe('worker', () => {
  it('switch off: no facts command and no Contact / Company read; the Lead is read without facts', async () => {
    const { rpc, calls } = fakeRpc({ items: [{ id: '81', object: 'deal' }, { id: '82', object: 'lead' }] });
    const bitrix = fakeBitrix();
    const stats = await runInboxBatch({ rpc, bitrix, config: CONFIG() } as WorkerDeps);
    expect(stats.summary).toMatchObject({ claimed: 2, created: 1, updated: 1 });
    expect(stats.outcome).toBe('ok');
    expect(calls.map((c) => c.fn)).not.toContain('integration_apply_bitrix_trip_facts');
    expect(bitrix.getContactBasics).not.toHaveBeenCalled();
    expect(bitrix.getLead.mock.calls[0]).toEqual(['82']);
  });

  it('switch on: stores the facts, then reads and stores the two linked parties', async () => {
    const { rpc, calls } = fakeRpc();
    const bitrix = fakeBitrix();
    const stats = await runInboxBatch({ rpc, bitrix, config: CONFIG({ tripFactsRead: true }) } as WorkerDeps);
    expect(stats.outcome).toBe('ok');
    const facts = calls.find((c) => c.fn === 'integration_apply_bitrix_trip_facts')!;
    expect(facts.args.p_facts).toEqual({
      dateModify: MODIFIED, bookingNotes: 'Synthetic notes', travellerTotal: 2, tourStart: null, tourEnd: null, customerTypeId: null,
      contactId: '9001', contactIds: ['9001'], companyId: '7001', issues: [],
    });
    const parties = calls.filter((c) => c.fn === 'integration_apply_bitrix_party').map((c) => (c.args.p_party as { kind: string }).kind);
    expect(parties).toEqual(['contact', 'company']);
    // The Deal snapshot itself is unchanged (no fact keys in the apply payload).
    const apply = calls.find((c) => c.fn === 'integration_apply_bitrix_deal')!;
    expect(Object.keys(apply.args.p_deal as object)).not.toContain('bookingNotes');
  });

  it('switch on, Lead row: the facts are the Lead keys', async () => {
    const { rpc, calls } = fakeRpc({ items: [{ id: '82', object: 'lead' }], factsOutcome: { outcome: 'stored', parties: [] } });
    const bitrix = fakeBitrix();
    await runInboxBatch({ rpc, bitrix, config: CONFIG({ tripFactsRead: true }) } as WorkerDeps);
    expect(bitrix.getLead.mock.calls[0]).toEqual(['82', { facts: true }]);
    expect(calls.find((c) => c.fn === 'integration_apply_bitrix_trip_facts')!.args.p_facts).toEqual({
      dateModify: MODIFIED, customerTypeId: '1353', contactId: '9001', contactIds: [], companyId: null, companyTitle: null, issues: [],
    });
  });

  it('a facts failure never fails the processed row; a rate limit on a Contact read is a provider error', async () => {
    const failing = fakeRpc({ factsError: true });
    const s1 = await runInboxBatch({ rpc: failing.rpc, bitrix: fakeBitrix(), config: CONFIG({ tripFactsRead: true }) } as WorkerDeps);
    expect(s1.summary).toMatchObject({ created: 1, failed: 0 });
    expect(failing.calls.map((c) => c.fn)).not.toContain('integration_fail_inbox');
    expect(s1.internalErrors).toBe(1);

    const limited = fakeRpc();
    const s2 = await runInboxBatch({
      rpc: limited.rpc,
      bitrix: fakeBitrix({ contactError: new BitrixClientError('provider_rate_limited', 429) }),
      config: CONFIG({ tripFactsRead: true }),
    } as WorkerDeps);
    expect(s2.summary).toMatchObject({ created: 1, failed: 0 });
    expect(s2.providerErrors).toBe(1);
    expect(limited.calls.map((c) => c.fn)).not.toContain('integration_apply_bitrix_party');
  });

  it('storeTripFacts asks the provider nothing when the database needs no party', async () => {
    const { rpc } = fakeRpc({ factsOutcome: { outcome: 'unchanged', parties: [] } });
    const bitrix = fakeBitrix();
    expect(await storeTripFacts({ rpc, bitrix }, '00000000-0000-4000-8000-000000000001', toDealTripFacts(dealRecord))).toBe('done');
    expect(bitrix.getContactBasics).not.toHaveBeenCalled();
    expect(bitrix.getCompanyBasics).not.toHaveBeenCalled();
  });
});
