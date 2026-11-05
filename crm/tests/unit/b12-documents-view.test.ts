import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { checkCustomerText } from '@/modules/documents/customer-text';
import { forbiddenKeyPaths } from '@/modules/documents/guard';
import { quotationToEngineQuote } from '@/modules/documents/quotation-adapter';
import { CustomerMoneySchema, QuotationGetSchema, toQuotationDocumentView } from '@/modules/documents/quotation-view';
import { renderView } from '@/modules/documents/render/render-view';
import { istDate, loadQuotationDocumentView } from '@/modules/documents/server/load-quotation-view';
import { itineraryView, quotationView } from './b12-documents-fixtures';

/**
 * B1.2 Phase F: customer quotation view from Atlas quotation_get (+ Mercury
 * staff money, mapped to the customer side), the save-time text check, the
 * loader under the staff session (fake client) and the Node render script.
 * Synthetic values only; no database, no network.
 */

const VERSION = '11111111-1111-4111-8111-111111111111';
const CTX = { preparedBy: { name: 'Synthetic Consultant', role: 'Travel consultant', phone: null }, today: '2026-10-12' };

function quotationGet(money: unknown = staffMoney()) {
  return {
    quotationId: 'q1', reference: 'TQ-12', title: 'Dubai and Abu Dhabi',
    subject: { kind: 'lead', leadId: 'l1', dealId: null, linkedDealId: null, reference: 'BXL-501', title: 'Synthetic lead' },
    version: { versionId: VERSION, versionNo: 2, status: 'sent', validUntil: '2026-10-19', sentAt: '2026-10-12T10:00:00+05:30' },
    trip: { destination: 'UAE', scope: 'international', start: '2026-11-20', end: '2026-11-25' },
    pax: { adults: 2, childrenWithBed: 1, childrenNoBed: 1, infants: 0, remarks: 'Synthetic internal pax remark' },
    requirementsNote: 'Synthetic Booking Notes from Bitrix',
    content: { days: [], includes: ['Daily breakfast'], excludes: ['Visa fees'], terms: [], notes: 'Synthetic staff note' },
    tiers: [{ tierKey: 'quoted', label: 'Deluxe' }, { tierKey: 'upgrade', label: 'Luxury' }],
    items: [
      { itemId: 'i1', itemNo: 1, serviceType: 'hotel', tierKey: null, title: 'h', factsValid: true,
        facts: { hotelName: 'Synthetic Marina Hotel', city: 'Dubai', checkIn: '2026-11-20', checkOut: '2026-11-23', rooms: 2, adults: 2, roomType: 'Deluxe', mealPlan: 'Breakfast', area: 'Marina', specialRequests: 'Synthetic request' } },
      { itemId: 'i2', itemNo: 2, serviceType: 'hotel', tierKey: 'quoted', title: 'h', factsValid: true,
        facts: { hotelName: 'Synthetic Corniche Hotel', city: 'Abu Dhabi', checkIn: '2026-11-23', checkOut: '2026-11-25', rooms: 2, adults: 2 } },
      { itemId: 'i3', itemNo: 3, serviceType: 'hotel', tierKey: 'upgrade', title: 'h', factsValid: true,
        facts: { hotelName: 'Synthetic Palace', city: 'Abu Dhabi', checkIn: '2026-11-23', checkOut: '2026-11-25', rooms: 2, adults: 2 } },
      { itemId: 'i4', itemNo: 4, serviceType: 'flight', tierKey: null, title: 'f', factsValid: true,
        facts: { segments: [{ from: 'BOM', to: 'DXB', date: '2026-11-20' }], passengers: 4 } },
    ],
    contacts: { contactName: 'Synthetic Traveller', mobile: '9555501234', email: 'synthetic.traveller@example.test', companyName: null },
    evidence: [{ id: 'e1', kind: 'acceptance_message', fileName: 'synthetic.pdf' }],
    issues: [],
    canEdit: false,
    conversion: null,
    money,
  };
}

function staffMoney(o: { difference?: string; showPerPerson?: boolean } = {}) {
  return {
    lines: [
      { lineNo: 1, optionKey: 'common', itemId: 'i1', itemNo: 1, chargeKind: 'main', categoryKey: 'hotels', description: 'Dubai hotel, 3 nights', unitKind: 'room_night', units: 2, periods: 3, quantity: 6, unitSellPaise: '1500000', lineSellPaise: '9000000', unitCostPaise: '1200000', lineCostPaise: '7200000', remark: 'Synthetic supplier remark' },
      { lineNo: 2, optionKey: 'quoted', itemId: 'i2', itemNo: 2, chargeKind: 'main', categoryKey: 'hotels', description: 'Abu Dhabi hotel, 2 nights', unitKind: 'room_night', units: 2, periods: 2, quantity: 4, unitSellPaise: '1500000', lineSellPaise: '6000000', unitCostPaise: null, lineCostPaise: null, remark: null },
      { lineNo: 3, optionKey: 'common', itemId: 'i4', itemNo: 4, chargeKind: 'main', categoryKey: 'flights', description: 'Return flights', unitKind: 'line_total', units: 1, periods: 1, quantity: 1, unitSellPaise: '9000000', lineSellPaise: '9000000', unitCostPaise: '8000000', lineCostPaise: '8000000', remark: null },
      { lineNo: 4, optionKey: 'upgrade', itemId: 'i3', itemNo: 3, chargeKind: 'main', categoryKey: 'hotels', description: 'Abu Dhabi palace, 2 nights', unitKind: 'room_night', units: 2, periods: 2, quantity: 4, unitSellPaise: '3000000', lineSellPaise: '12000000', unitCostPaise: null, lineCostPaise: null, remark: null },
    ],
    tiers: [
      { tierKey: 'quoted', label: null, quotedTotalPaise: '24000000', showPerPerson: o.showPerPerson ?? true, lineCount: 3, componentSellPaise: '24000000', differencePaise: o.difference ?? '0', costTotalPaise: null, costComplete: false, marginPaise: null, payingTravellers: 4, perPersonPaise: '6000000', planTotalPaise: '24000000', planCount: 1 },
      { tierKey: 'upgrade', label: 'Luxury', quotedTotalPaise: '30000000', showPerPerson: true, lineCount: 3, componentSellPaise: '30000000', differencePaise: '0', costTotalPaise: null, costComplete: false, marginPaise: '100', payingTravellers: 4, perPersonPaise: '7500000', planTotalPaise: null, planCount: 0 },
    ],
    instalments: [{ tierKey: 'quoted', seq: 1, label: 'Full payment', amountPaise: '24000000', dueRule: 'on_acceptance', dueDays: null, dueDate: null }],
    codes: ['cost_incomplete'],
    costRefreshAllowed: true,
  };
}

/** Mercury `quotation_customer_money` answer for the same synthetic quotation (selling side only). */
function customerMoney(o: { mismatch?: boolean } = {}) {
  const exact = !o.mismatch;
  return {
    tiers: [
      {
        tierKey: 'quoted', label: null, quotedTotalPaise: '24000000', payingTravellers: 4, perPersonPaise: exact ? '6000000' : null,
        breakdownHasAmounts: exact,
        breakdown: [
          { categoryKey: 'hotels', descriptions: ['Dubai hotel, 3 nights', 'Abu Dhabi hotel, 2 nights'], amountPaise: exact ? '15000000' : null },
          { categoryKey: 'flights', descriptions: ['Return flights'], amountPaise: exact ? '9000000' : null },
        ],
        plan: [{ seq: 1, label: 'Full payment', amountPaise: '24000000', dueRule: 'on_acceptance', dueDays: null, dueDate: null }],
      },
      {
        tierKey: 'upgrade', label: 'Luxury', quotedTotalPaise: '30000000', payingTravellers: 4, perPersonPaise: '7500000', breakdownHasAmounts: true,
        breakdown: [
          { categoryKey: 'hotels', descriptions: ['Dubai hotel, 3 nights', 'Abu Dhabi palace, 2 nights'], amountPaise: '21000000' },
          { categoryKey: 'flights', descriptions: ['Return flights'], amountPaise: '9000000' },
        ],
        plan: [],
      },
    ],
  };
}
const MONEY = () => CustomerMoneySchema.parse(customerMoney());

describe('toQuotationDocumentView (quotation_get + quotation_customer_money -> customer view)', () => {
  it('copies only customer fields: no cost, margin, remark, notes, evidence or Bitrix reference', () => {
    const view = toQuotationDocumentView(QuotationGetSchema.parse(quotationGet()), MONEY(), CTX);
    expect(forbiddenKeyPaths(view)).toEqual([]);
    const text = JSON.stringify(view);
    for (const leak of ['1200000', '7200000', 'Synthetic supplier remark', 'Synthetic staff note', 'Synthetic internal pax remark', 'Booking Notes', 'BXL-501', 'synthetic.pdf', 'Synthetic request', 'example.test']) {
      expect(text, leak).not.toContain(leak);
    }
  });

  it('maps tiers like the customer money rules: typed total, exact per person, breakdown only when equal, plan', () => {
    const view = toQuotationDocumentView(QuotationGetSchema.parse(quotationGet()), MONEY(), CTX);
    expect(view.tiers).toEqual([
      {
        tierKey: 'quoted', label: 'Deluxe', quotedTotalPaise: '24000000', payingTravellers: 4, perPersonPaise: '6000000', breakdownHasAmounts: true,
        breakdown: [
          { categoryKey: 'hotels', descriptions: ['Dubai hotel, 3 nights', 'Abu Dhabi hotel, 2 nights'], amountPaise: '15000000' },
          { categoryKey: 'flights', descriptions: ['Return flights'], amountPaise: '9000000' },
        ],
        hotels: null,
        plan: [{ seq: 1, label: 'Full payment', amountPaise: '24000000', dueRule: 'on_acceptance', dueDays: null, dueDate: null }],
      },
      {
        tierKey: 'upgrade', label: 'Luxury', quotedTotalPaise: '30000000', payingTravellers: 4, perPersonPaise: '7500000', breakdownHasAmounts: true,
        breakdown: [
          { categoryKey: 'hotels', descriptions: ['Dubai hotel, 3 nights', 'Abu Dhabi palace, 2 nights'], amountPaise: '21000000' },
          { categoryKey: 'flights', descriptions: ['Return flights'], amountPaise: '9000000' },
        ],
        hotels: ['Synthetic Marina Hotel', 'Synthetic Palace'],
        plan: [],
      },
    ]);
    const mismatch = toQuotationDocumentView(QuotationGetSchema.parse(quotationGet()), CustomerMoneySchema.parse(customerMoney({ mismatch: true })), CTX);
    expect(mismatch.tiers[0]).toMatchObject({ breakdownHasAmounts: false, perPersonPaise: null });
    expect(mismatch.tiers[0]!.breakdown.every((b) => b.amountPaise === null)).toBe(true);
  });

  it('maps trip, stays (common + quoted tier), flights, contacts and content, then adapts cleanly', () => {
    const view = toQuotationDocumentView(QuotationGetSchema.parse(quotationGet()), MONEY(), CTX);
    expect(view).toMatchObject({
      reference: 'TQ-12', versionNo: 2, issueDate: '2026-10-12', validUntil: '2026-10-19',
      customer: { name: 'Synthetic Traveller', phone: '9555501234' },
      serviceTypes: ['hotel', 'flight'],
      includes: ['Daily breakfast'], excludes: ['Visa fees'], terms: null,
    });
    expect(view.stays.map((s) => s.city)).toEqual(['Dubai', 'Abu Dhabi']);
    expect(view.stays[0]).toMatchObject({ hotelName: 'Synthetic Marina Hotel', note: 'Marina', rooms: 2 });
    expect(view.flights).toEqual([{ label: 'Outbound', date: '2026-11-20', legs: [{ carrier: null, number: null, from: 'BOM', to: 'DXB', dep: null, arr: null }], baggage: null }]);
    const r = quotationToEngineQuote(view);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.tiers.map((t) => t.total)).toEqual([240000, 300000]);
  });

  it('ignores the staff money block of quotation_get entirely (cost side never read)', () => {
    const view = toQuotationDocumentView(QuotationGetSchema.parse(quotationGet()), null, CTX);
    expect(view.tiers).toEqual([]);
    expect(JSON.stringify(view)).not.toMatch(/1200000|Synthetic supplier remark/);
  });

  it('without customer money (not a money reader) there are no tiers and the adapter refuses', () => {
    const view = toQuotationDocumentView(QuotationGetSchema.parse(quotationGet(null)), null, CTX);
    expect(view.tiers).toEqual([]);
    expect(quotationToEngineQuote(view)).toMatchObject({ ok: false, refusals: [{ code: 'tier_missing' }] });
  });
});

describe('loadQuotationDocumentView (staff session, fake client)', () => {
  const staff = (o: { purchase?: boolean; rpc?: ReturnType<typeof vi.fn> } = {}) => {
    const rpc =
      o.rpc ?? vi.fn(async (fn: string) => ({ data: fn === 'quotation_customer_money' ? customerMoney() : quotationGet(), error: null }));
    return {
      rpc,
      staff: {
        displayName: 'Synthetic Consultant',
        access: { userId: 'u1', memberships: o.purchase ? [{ legalEntityId: 'e', branchId: 'b', roleCode: 'purchase' }] : [], rolePermissions: [], grants: [] },
        supabase: { rpc },
      } as never,
    };
  };

  it('reads quotation_get under the session and returns the customer view', async () => {
    const { staff: s, rpc } = staff();
    const r = await loadQuotationDocumentView(s, VERSION, new Date('2026-10-12T20:00:00Z'));
    expect(rpc).toHaveBeenCalledWith('quotation_get', { p_version_id: VERSION });
    expect(rpc).toHaveBeenCalledWith('quotation_customer_money', { p_version_id: VERSION });
    expect(r).toMatchObject({ status: 'ok', moneyVisible: true, view: { reference: 'TQ-12' } });
    if (r.status === 'ok') expect(r.view.tiers.map((t) => t.quotedTotalPaise)).toEqual(['24000000', '30000000']);
  });

  it('no price access: customer money null gives a view without tiers; a money read error is error', async () => {
    const noMoney = staff({ rpc: vi.fn(async (fn: string) => ({ data: fn === 'quotation_customer_money' ? null : quotationGet(), error: null })) });
    expect(await loadQuotationDocumentView(noMoney.staff, VERSION)).toMatchObject({ status: 'ok', moneyVisible: false, view: { tiers: [] } });
    const broken = staff({
      rpc: vi.fn(async (fn: string) => (fn === 'quotation_customer_money' ? { data: null, error: { code: 'XX000' } } : { data: quotationGet(), error: null })),
    });
    expect(await loadQuotationDocumentView(broken.staff, VERSION)).toEqual({ status: 'error' });
  });

  it('refuses Purchase before any query; unknown, refused and non-editor answers are not_found; other errors are error', async () => {
    const p = staff({ purchase: true });
    expect(await loadQuotationDocumentView(p.staff, VERSION)).toEqual({ status: 'not_found' });
    expect(p.rpc).not.toHaveBeenCalled();
    expect(await loadQuotationDocumentView(staff().staff, 'not-a-uuid')).toEqual({ status: 'not_found' });
    expect(await loadQuotationDocumentView(staff({ rpc: vi.fn(async () => ({ data: null, error: null })) }).staff, VERSION)).toEqual({ status: 'not_found' });
    expect(await loadQuotationDocumentView(staff({ rpc: vi.fn(async () => ({ data: null, error: { code: '42501' } })) }).staff, VERSION)).toEqual({ status: 'not_found' });
    expect(await loadQuotationDocumentView(staff({ rpc: vi.fn(async () => ({ data: null, error: { code: '57014' } })) }).staff, VERSION)).toEqual({ status: 'error' });
    expect(await loadQuotationDocumentView(staff({ rpc: vi.fn(async () => ({ data: { reference: 1 }, error: null })) }).staff, VERSION)).toEqual({ status: 'error' });
  });

  it('istDate uses the India calendar day', () => {
    expect(istDate(new Date('2026-10-12T19:00:00Z'))).toBe('2026-10-13');
    expect(istDate(new Date('2026-10-12T18:00:00Z'))).toBe('2026-10-12');
  });
});

describe('checkCustomerText (save-time check for Terra)', () => {
  it('passes clean text and reports paths and phrases for unsafe text', () => {
    expect(checkCustomerText({ includes: ['Daily breakfast'], days: [{ title: 'Arrive', text: 'Check in.' }] })).toEqual({ ok: true });
    expect(checkCustomerText({ includes: ['Daily breakfast', 'Lowest price guaranteed'], description: 'Our markup' })).toEqual({
      ok: false,
      hits: [
        { kind: 'sales_pressure', phrase: 'lowest price', path: 'includes[1]' },
        { kind: 'internal_rate', phrase: 'markup', path: 'description' },
      ],
    });
  });
});

describe('render path (Node only)', () => {
  it('renderView renders, refuses and flags', () => {
    const ok = renderView({ view: quotationView() });
    expect(ok.outcome).toBe('rendered');
    if (ok.outcome === 'rendered') expect(ok.html).toContain('GST as applicable');
    const v = quotationView();
    v.tiers[0]!.quotedTotalPaise = '1';
    expect(renderView({ view: v })).toMatchObject({ outcome: 'refused', refusals: [{ code: 'amount_has_paise' }] });
    expect(renderView({ view: { kind: 'other' } })).toMatchObject({ outcome: 'invalid_input' });
    expect(renderView({ view: { kind: 'itinerary' } })).toEqual({ outcome: 'invalid_input', issue: 'view' });
  });

  it('scripts/render-document.mjs writes HTML to stdout and a codes-only report to stderr, with no network', () => {
    const script = join(import.meta.dirname, '..', '..', 'scripts', 'render-document.mjs');
    const run = (payload: unknown) =>
      spawnSync(process.execPath, [script], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' } });

    const ok = run({ view: itineraryView() });
    expect(ok.status).toBe(0);
    expect(ok.stdout.startsWith('<!doctype html>')).toBe(true);
    expect(JSON.parse(ok.stderr.trim())).toMatchObject({ outcome: 'rendered', internalNotes: ['prices_not_shown', 'day_plan_missing'] });

    const v = quotationView();
    v.tiers[0]!.quotedTotalPaise = '1';
    const refused = run({ view: v });
    expect(refused.status).toBe(2);
    expect(refused.stdout).toBe('');
    expect(JSON.parse(refused.stderr.trim())).toEqual({ outcome: 'refused', refusals: [{ code: 'amount_has_paise', path: 'tiers[0].quotedTotalPaise' }] });

    const bad = spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8', timeout: 60_000 });
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stderr.trim())).toEqual({ outcome: 'invalid_input', issue: 'json' });
  }, 120_000);

  it('the render process blocks every outbound network attempt with exit code 4 (review E5-10)', () => {
    const guard = join(import.meta.dirname, '..', '..', 'scripts', 'lib', 'no-network.mjs');
    const attempts: Array<[string, string]> = [
      ['http.request', "(await import('node:http')).request('http://127.0.0.1:9/')"],
      ['https.get', "(await import('node:https')).get('https://127.0.0.1:9/')"],
      ['net.connect', "(await import('node:net')).connect(9, '127.0.0.1')"],
      ['net.Socket.connect', "new (await import('node:net')).Socket().connect(9, '127.0.0.1')"],
      ['tls.connect', "(await import('node:tls')).connect(9, '127.0.0.1')"],
      ['dns.lookup', "(await import('node:dns')).lookup('example.test', () => {})"],
      ['dns.promises.lookup', "await (await import('node:dns')).promises.lookup('example.test')"],
      ['fetch', "await fetch('http://127.0.0.1:9/')"],
    ];
    for (const [api, code] of attempts) {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(guard)}); ${code}; console.log('reached')`], {
        encoding: 'utf8', timeout: 30_000,
      });
      expect(r.status, api).toBe(4);
      expect(r.stdout, api).not.toContain('reached');
      expect(JSON.parse(r.stderr.trim()), api).toEqual({ outcome: 'network_blocked', api });
    }
  }, 120_000);
});
