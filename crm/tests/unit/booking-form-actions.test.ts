import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBillToForm, parseBookingCustomerForm, parseBookingPricesForm, parseBookingServiceForm, priceHintField, serviceHintField } from '@/modules/fulfilment/booking-form-forms';
import { PRICE_CATEGORIES } from '@/modules/fulfilment/booking-form-contract';

/*
 * Booking form parsers and actions with a fake RPC client: session first,
 * own-session commands only, the browser never sends a total, honest partial
 * saves (savedRowVersion), database hints mapped to form names (never
 * database text), refusals keep typed values (the action returns fields),
 * results carry ids/row versions only (Mercury B7/B8). Synthetic ids only.
 */

const requireStaff = vi.fn();
const rpc = vi.fn();
const upload = vi.fn();

vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => ({ storage: { from: () => ({ upload: (...a: unknown[]) => upload(...a) }) } }) }));

const actions = await import('@/modules/fulfilment/server/book-form-actions');
const bookNow = await import('@/modules/fulfilment/server/book-now-actions');

const USER = 'a0000000-0000-4000-8000-000000000001';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';
const ITEM = '33333333-3333-4333-8333-333333333333';
const FILE = '44444444-4444-4444-8444-444444444444';
const REQUEST = '77777777-7777-4777-8777-777777777777';
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
function rpcReplies(map: Record<string, RpcReply | RpcReply[]>) {
  const queues = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  rpc.mockImplementation(async (fn: string) => {
    const queue = queues[fn];
    if (!queue || queue.length === 0) throw new Error(`unexpected rpc ${fn}`);
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    return { data: reply.data ?? null, error: reply.error ?? null };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockResolvedValue({ userId: USER, supabase: { rpc }, access: { userId: USER, memberships: [], rolePermissions: [], grants: [] } });
});

const draft = { dealId: DEAL, versionId: VERSION, rowVersion: '5', requestId: REQUEST };

/** booking_form_get as a database with (installed) or without the booking form change. */
function formGet(installed: boolean, contacts: Record<string, unknown> | null = null): RpcReply {
  return {
    data: {
      dealId: DEAL, canEdit: true, canConfirm: true, serviceItemsEnabled: true,
      version: { versionId: VERSION, versionNo: 1, status: 'draft', rowVersion: 5, contentHash: HASH, ...(installed ? { formRules: 2 } : {}) },
      contacts, billing: { status: 'none', rowVersion: 0 }, travellers: [], items: [], evidence: [],
      ...(installed ? { party: { total: 4, children: 1, infants: 1 }, itemFilesCanEdit: true } : {}),
    },
  };
}
const customer = {
  ...draft,
  contactName: 'Riya Mehta',
  mobile: '98765 43210',
  email: '',
  contactConfirmed: 'on',
  bookingFor: 'individual',
  destination: 'Goa',
  tripScope: 'domestic',
  tripStart: '2026-12-10',
  tripEnd: '2026-12-15',
  paxTotal: '4',
  children: '1',
  infants: '1',
  customerType: 'b2d',
  market: 'india',
};

describe('customer card parser', () => {
  it('reads contact, trip, party and labels; never billing', () => {
    const p = parseBookingCustomerForm(form({ ...customer, billingName: 'Should be ignored' }));
    if (!p.ok) throw new Error(p.fields.join());
    expect(p.value.customer.billing).toBeNull();
    expect(p.value.customer.contact).toMatchObject({ contactName: 'Riya Mehta', mobile: '9876543210', customerType: 'b2d', market: 'india' });
    expect(p.value.trip.trip).toEqual({ destination: 'Goa', scope: 'domestic', start: '2026-12-10', end: '2026-12-15', paxTotal: 4, children: 1, infants: 1 });
  });
  it('refuses a split above the total and unknown labels', () => {
    const p = parseBookingCustomerForm(form({ ...customer, children: '3', infants: '2', market: 'mars' }));
    expect(p.ok ? [] : p.fields).toEqual(expect.arrayContaining(['children', 'market']));
    const q = parseBookingCustomerForm(form({ ...customer, paxTotal: '101' }));
    expect(q.ok ? [] : q.fields).toContain('paxTotal');
  });
});

describe('price parser (P9, P13–P16, P19)', () => {
  const rows = (over: Partial<Record<'qty' | 'purchase' | 'markup' | 'sale', string[]>> = {}) =>
    form({
      ...draft,
      priceCategory: [...PRICE_CATEGORIES],
      priceQuantity: over.qty ?? ['2', '1', '0', '1'],
      pricePurchaseRupees: over.purchase ?? ['10000', '8000', '', '0'],
      priceMarkupRupees: over.markup ?? ['2000', '1000', '', '0'],
      priceSaleRupees: over.sale ?? ['12000', '9000', '', '0'],
    });
  it('reads four rows in order as paise strings; zero is a value; no total is read', () => {
    const p = parseBookingPricesForm(rows());
    if (!p.ok) throw new Error(p.fields.join());
    expect(p.value.lines).toEqual([
      { category: 'adult', quantity: 2, purchasePaise: '1000000', markupPaise: '200000', salePaise: '1200000' },
      { category: 'child_bed', quantity: 1, purchasePaise: '800000', markupPaise: '100000', salePaise: '900000' },
      { category: 'child_no_bed', quantity: 0, purchasePaise: null, markupPaise: null, salePaise: null },
      { category: 'infant', quantity: 1, purchasePaise: '0', markupPaise: '0', salePaise: '0' },
    ]);
    expect(Object.keys(p.value)).not.toContain('sellingTotalPaise');
  });
  it('a row without people sends no amounts even if typed', () => {
    const p = parseBookingPricesForm(rows({ qty: ['2', '0', '0', '0'], purchase: ['10000', '5', '', ''], markup: ['2000', '5', '', ''], sale: ['12000', '10', '', ''] }));
    expect(p.ok && p.value.lines[1]).toEqual({ category: 'child_bed', quantity: 0, purchasePaise: null, markupPaise: null, salePaise: null });
  });
  it('a negative markup is kept (draft); an equation break, decimals, symbols and the cap are refused', () => {
    const neg = parseBookingPricesForm(rows({ markup: ['-1000', '1000', '', '0'], sale: ['9000', '9000', '', '0'] }));
    expect(neg.ok && neg.value.lines[0]!.markupPaise).toBe('-100000');
    const bad = parseBookingPricesForm(rows({ purchase: ['1.001', '₹8000', '', '0'], sale: ['12001', '9000', '', '0'] }));
    expect(bad.ok ? [] : bad.fields).toEqual(expect.arrayContaining(['pricePurchaseRupees[adult]', 'pricePurchaseRupees[child_bed]']));
    const off = parseBookingPricesForm(rows({ sale: ['12001', '9000', '', '0'] }));
    expect(off.ok ? [] : off.fields).toEqual(['priceSaleRupees[adult]']);
    const cap = parseBookingPricesForm(rows({ purchase: ['1000000000', '8000', '', '0'] }));
    expect(cap.ok ? [] : cap.fields).toContain('pricePurchaseRupees[adult]');
  });
  it('part of a row names the empty amounts; a missing whole row is allowed (draft)', () => {
    const part = parseBookingPricesForm(rows({ markup: ['', '1000', '', '0'], sale: ['', '9000', '', '0'] }));
    expect(part.ok ? [] : part.fields).toEqual(['priceMarkupRupees[adult]', 'priceSaleRupees[adult]']);
    const none = parseBookingPricesForm(rows({ purchase: ['', '8000', '', '0'], markup: ['', '1000', '', '0'], sale: ['', '9000', '', '0'] }));
    expect(none.ok && none.value.lines[0]).toEqual({ category: 'adult', quantity: 2, purchasePaise: null, markupPaise: null, salePaise: null });
  });
  it('the categories must come in the frozen order, each once', () => {
    const p = parseBookingPricesForm(form({ ...draft, priceCategory: ['adult', 'adult', 'child_no_bed', 'infant'], priceQuantity: ['1', '0', '0', '0'] }));
    expect(p.ok ? [] : p.fields).toContain('priceCategory');
  });
  it('hints map to form names', () => {
    expect(priceHintField('lines[child_bed].salePaise')).toBe('priceSaleRupees[child_bed]');
    expect(priceHintField('lines')).toBe('priceCategory');
  });
});

describe('Bill To parser (B7, B8, B13)', () => {
  const base = { dealId: DEAL, requestId: REQUEST, billingRowVersion: '0', billToType: 'business', billingName: 'Test Travels', contactPerson: 'Riya Mehta', billingPhone: '+971 50 123 4567', billingEmail: 'Accounts@Example.com', addressLine1: 'Test street 1', addressLine2: '', billingCity: 'Jodhpur', stateCode: '08', postalCode: '342 001' };
  it('registered business with a GSTIN of its state', () => {
    const p = parseBillToForm(form({ ...base, gstStatus: 'registered', gstin: '08abcde1234f1z5', gstReason: 'ignored here' }));
    if (!p.ok) throw new Error(p.fields.join());
    expect(p.value.fields).toMatchObject({ billToType: 'business', gstStatus: 'registered', gstin: '08ABCDE1234F1Z5', gstReason: null, phone: '+971501234567', email: 'accounts@example.com', postalCode: '342001' });
    expect(Object.keys(p.value.fields)).not.toContain('status');
    const wrongState = parseBillToForm(form({ ...base, stateCode: '27', gstStatus: 'registered', gstin: '08ABCDE1234F1Z5' }));
    expect(wrongState.ok ? [] : wrongState.fields).toEqual(['gstin']);
  });
  it('unregistered: reason 10–500, no GSTIN stored; personal drops GST answers', () => {
    const un = parseBillToForm(form({ ...base, gstStatus: 'unregistered', gstReason: 'Not registered yet', gstin: '08ABCDE1234F1Z5' }));
    expect(un.ok && un.value.fields).toMatchObject({ gstin: null, gstReason: 'Not registered yet' });
    const short = parseBillToForm(form({ ...base, gstStatus: 'unregistered', gstReason: 'too short' }));
    expect(short.ok ? [] : short.fields).toEqual(['gstReason']);
    const personal = parseBillToForm(form({ ...base, billToType: 'personal', gstStatus: 'registered', gstin: '08ABCDE1234F1Z5' }));
    expect(personal.ok && personal.value.fields).toMatchObject({ contactPerson: null, gstStatus: null, gstin: null });
  });
  it('the stored profile needs name, address, city, state and PIN', () => {
    const p = parseBillToForm(form({ ...base, billingName: '', postalCode: '012345', stateCode: '' }));
    expect(p.ok ? [] : p.fields).toEqual(expect.arrayContaining(['billingName', 'postalCode', 'stateCode']));
  });
});

describe('service parser', () => {
  const hotel = { ...draft, serviceType: 'hotel', hotelName: 'Test Resort', city: 'Goa', checkIn: '2026-12-10', nights: '3', rooms: '2', adults: '3', roomRateRupees: '5000', extraBedRateRupees: '', noBedRateRupees: '' };
  it('hotel: nights give check-out; estimate rates in paise, unknown stays null', () => {
    const p = parseBookingServiceForm(form(hotel));
    if (!p.ok) throw new Error(p.fields.join());
    expect(p.value.facts.facts).toMatchObject({ checkIn: '2026-12-10', checkOut: '2026-12-13', mode: 'specific' });
    expect(p.value.estimate).toEqual({ kind: 'hotel', roomRatePaise: '500000', extraBedRatePaise: null, noBedRatePaise: null });
    // Book now v2 (owner decision D2): no budget input posted = null, so the database sets the budget from the estimate.
    expect(p.value.budgetPaise).toBeNull();
    // An older screen that posts an empty budget on add still sends 0.
    const older = parseBookingServiceForm(form({ ...hotel, purchaseBudgetRupees: '' }));
    expect(older.ok && older.value.budgetPaise).toBe('0');
  });
  it('no estimate inputs posted → estimate null (an editor without price access)', () => {
    const { roomRateRupees: _a, extraBedRateRupees: _b, noBedRateRupees: _c, ...rest } = hotel;
    void [_a, _b, _c];
    const p = parseBookingServiceForm(form(rest));
    expect(p.ok && p.value.estimate).toBeNull();
  });
  it('car: whole-trip keys and the vehicle rate', () => {
    const p = parseBookingServiceForm(form({ ...draft, itemId: ITEM, serviceType: 'transfer', route: 'Airport to hotel', date: '2026-12-10', endDate: '2026-12-15', quantity: '2', includedKms: '300', vendor: 'Test cabs', vehicleRateRupees: '25000', purchaseBudgetRupees: '' }));
    if (!p.ok) throw new Error(p.fields.join());
    expect(p.value.facts.facts).toMatchObject({ endDate: '2026-12-15', quantity: 2, includedKms: 300, vendor: 'Test cabs' });
    expect(p.value.estimate).toEqual({ kind: 'transfer', vehicleRatePaise: '2500000' });
    expect(p.value.budgetPaise).toBeNull();
    const bad = parseBookingServiceForm(form({ ...draft, serviceType: 'transfer', route: 'A to B', date: '2026-12-10', endDate: '2026-12-09', quantity: '0' }));
    expect(bad.ok ? [] : bad.fields).toEqual(expect.arrayContaining(['endDate', 'quantity']));
  });
  it('flight: segment extras align with kept segments (blank rows skipped); times never compared', () => {
    const p = parseBookingServiceForm(
      form({
        ...draft,
        serviceType: 'flight',
        passengers: '2',
        segmentFrom: ['', 'DEL'],
        segmentTo: ['', 'DXB'],
        segmentDate: ['', '2026-12-10'],
        segmentArrivalDate: ['', '2026-12-11'],
        segmentAirline: ['', 'Test Air'],
        segmentFlightNo: ['', 'ta 101'],
        segmentDepartTime: ['', '23:10'],
        segmentArriveTime: ['', '01:20'],
        fareTotalRupees: '18000.50',
        fareAdultRupees: '6000.50',
        fareChildRupees: '',
      }),
    );
    if (!p.ok) throw new Error(p.fields.join());
    const facts = p.value.facts.facts as unknown as { segments: Array<Record<string, unknown>> };
    expect(facts.segments).toEqual([{ from: 'DEL', to: 'DXB', date: '2026-12-10', arrivalDate: '2026-12-11', airline: 'Test Air', flightNo: 'TA 101', departTime: '23:10', arriveTime: '01:20' }]);
    // Book now v2: fare per person; the older total is never written again (fareTotalRupees is ignored).
    expect(p.value.estimate).toEqual({ kind: 'flight', fareTotalPaise: null, fareAdultPaise: '600050', fareChildPaise: null, fareInfantPaise: null });
  });
  it('hints map to form names', () => {
    expect(serviceHintField('segments[1].arrivalDate')).toBe('segmentArrivalDate[1]');
    expect(serviceHintField('estimate.vehicleRatePaise')).toBe('vehicleRateRupees');
    expect(serviceHintField('endDate')).toBe('endDate');
  });
});

describe('actions', () => {
  it('session first: nothing runs without staff', async () => {
    requireStaff.mockRejectedValue(new Error('redirect'));
    await expect(actions.saveBookingPricesAction(null, form({}))).rejects.toThrow('redirect');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('customer card: contact then trip with the new row version; billing null', async () => {
    rpcReplies({ booking_form_get: formGet(true), booking_customer_save: { data: { rowVersion: 6, contentHash: HASH } }, booking_trip_save: { data: { rowVersion: 7, contentHash: HASH } } });
    const r = await actions.saveBookingCustomerAction(null, form(customer));
    expect(r).toMatchObject({ ok: true, data: { rowVersion: 7 }, message: 'Customer details saved.' });
    const call = (fn: string) => rpc.mock.calls.find((c) => c[0] === fn)![1];
    expect(call('booking_customer_save')).toMatchObject({ p_expected_row_version: 5, p_billing: null, p_contact: { customerType: 'b2d', market: 'india' } });
    expect(call('booking_trip_save')).toMatchObject({ p_expected_row_version: 6, p_fields: { destination: 'Goa', scope: 'domestic', start: '2026-12-10', end: '2026-12-15', paxTotal: 4, children: 1, infants: 1 } });
  });

  it('customer card without booking-for: the stored booking-for and payer are kept (read under own session)', async () => {
    const { bookingFor: _bf, ...noBookingFor } = customer;
    void _bf;
    rpcReplies({
      booking_form_get: formGet(true, { contactName: 'Riya Mehta', mobile: '9876543210', email: null, contactConfirmed: false, bookingFor: 'business', payerDifferent: true, payerName: 'Test Travels' }),
      booking_customer_save: { data: { rowVersion: 6, contentHash: HASH } },
      booking_trip_save: { data: { rowVersion: 7, contentHash: HASH } },
    });
    expect(await actions.saveBookingCustomerAction(null, form(noBookingFor))).toMatchObject({ ok: true });
    const save = rpc.mock.calls.find((c) => c[0] === 'booking_customer_save')![1] as { p_contact: Record<string, unknown> };
    expect(save.p_contact).toMatchObject({ bookingFor: 'business', payerDifferent: true, payerName: 'Test Travels' });
  });

  it('customer card: contact saved, trip refused → honest partial with savedRowVersion', async () => {
    rpcReplies({ booking_form_get: formGet(true), booking_customer_save: { data: { rowVersion: 6, contentHash: HASH } }, booking_trip_save: { error: { code: '22023', message: 'invalid_input', hint: 'children' } } });
    const r = await actions.saveBookingCustomerAction(null, form(customer));
    expect(r).toMatchObject({ ok: false, code: 'invalid_input', fields: ['children'], savedRowVersion: 6 });
    expect(r.ok ? '' : r.message).toMatch(/^Saved: contact details\. Not saved: trip dates and passenger counts/);
  });

  it('prices: own session, no total sent, the reply total in words; hints mapped', async () => {
    rpcReplies({ booking_prices_save: { data: { rowVersion: 8, contentHash: HASH, sellingTotalPaise: '3300000' } } });
    const fd = form({ ...draft, priceCategory: [...PRICE_CATEGORIES], priceQuantity: ['2', '1', '0', '0'], pricePurchaseRupees: ['10000', '8000', '', ''], priceMarkupRupees: ['2000', '1000', '', ''], priceSaleRupees: ['12000', '9000', '', ''] });
    const r = await actions.saveBookingPricesAction(null, fd);
    expect(r).toMatchObject({ ok: true, data: { rowVersion: 8, sellingTotalPaise: '3300000' }, message: 'Prices saved. Package selling total ₹33,000.' });
    const args = rpc.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(['p_expected_row_version', 'p_lines', 'p_request_id', 'p_version_id']);
    rpcReplies({ booking_prices_save: { error: { code: '22023', message: 'invalid_input', hint: 'lines[adult].quantity' } } });
    expect(await actions.saveBookingPricesAction(null, fd)).toMatchObject({ ok: false, fields: ['priceQuantity[adult]'] });
    rpcReplies({ booking_prices_save: { error: { code: '42501', message: 'not_authorized' } } });
    const refused = await actions.saveBookingPricesAction(null, fd);
    expect(refused).toMatchObject({ ok: false, code: 'not_authorized', message: 'You can’t change the prices on this deal. Ask the deal owner.' });
    expect(JSON.stringify(refused)).not.toMatch(/10000|12000|1200000/);
  });

  it('prices: an incomplete draft saves and says how many amounts are missing', async () => {
    rpcReplies({ booking_prices_save: { data: { rowVersion: 8, contentHash: HASH, sellingTotalPaise: null } } });
    const fd = form({ ...draft, priceCategory: [...PRICE_CATEGORIES], priceQuantity: ['2', '0', '0', '0'], pricePurchaseRupees: ['', '', '', ''], priceMarkupRupees: ['', '', '', ''], priceSaleRupees: ['', '', '', ''] });
    expect(await actions.saveBookingPricesAction(null, fd)).toMatchObject({ ok: true, message: 'Prices saved. Total not worked out yet: 3 amounts still missing.' });
  });

  it('service: one command with estimate and participants; unknown outcome never "nothing changed"', async () => {
    rpcReplies({ booking_service_save: { data: { itemId: ITEM, itemNo: 1, rowVersion: 9, contentHash: HASH } } });
    const r = await actions.saveBookingServiceAction(null, form({ ...draft, serviceType: 'hotel', hotelName: 'Test Resort', city: 'Goa', checkIn: '2026-12-10', nights: '2', rooms: '1', adults: '2', roomRateRupees: '5000', participantSeq: ['1', '2'] }));
    expect(r).toMatchObject({ ok: true, data: { itemId: ITEM, rowVersion: 9 }, message: 'Hotel saved.' });
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_item_id: null, p_service_type: 'hotel', p_participants: [1, 2], p_estimate: { kind: 'hotel', roomRatePaise: '500000' } });
    rpcReplies({ booking_service_save: { error: { code: 'XX000', message: 'boom' } } });
    await expect(actions.saveBookingServiceAction(null, form({ ...draft, serviceType: 'hotel', hotelName: 'Test Resort', city: 'Goa', checkIn: '2026-12-10', nights: '2', rooms: '1', adults: '2' }))).rejects.toThrow(/could not confirm this was saved/);
  });

  it('Bill To: draft proposal, never a verified status; verified profile refused in words', async () => {
    rpcReplies({ booking_form_get: formGet(true), booking_billing_propose: { data: { outcome: 'created', status: 'draft', rowVersion: 1 } } });
    const fd = form({ dealId: DEAL, requestId: REQUEST, billingRowVersion: '0', billToType: 'personal', billingName: 'Riya Mehta', billingPhone: '9876543210', addressLine1: 'Test street 1', billingCity: 'Jodhpur', stateCode: '08', postalCode: '342001' });
    expect(await actions.saveBillToAction(null, fd)).toMatchObject({ ok: true, message: 'Bill To saved. Accounts checks it before use.' });
    const sent = rpc.mock.calls.find((c) => c[0] === 'booking_billing_propose')![1] as { p_fields: Record<string, unknown> };
    expect(Object.keys(sent.p_fields)).not.toContain('status');
    rpcReplies({ booking_form_get: formGet(true), booking_billing_propose: { error: { code: '55000', message: 'billing_verified' } } });
    expect(await actions.saveBillToAction(null, fd)).toMatchObject({ ok: false, code: 'billing_verified' });
  });

  it('flight screenshot: checked before begin; begin under own session; stored only after finish', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const fd = form({ dealId: DEAL, versionId: VERSION, itemId: ITEM, kind: 'flight_screenshot', requestId: REQUEST });
    fd.set('file', new File([png], 'fare.png', { type: 'image/png' }));
    const path = `${USER}/${DEAL}/${ITEM}/${FILE}`;
    rpcReplies({ service_item_file_begin: { data: { fileId: FILE, objectPath: path, outcome: 'created', status: 'pending_upload', rowVersion: 1 } }, service_item_file_finish: { data: { fileId: FILE, status: 'stored', rowVersion: 2 } } });
    upload.mockResolvedValue({ error: null });
    expect(await actions.uploadServiceFileAction(null, fd)).toMatchObject({ ok: true, data: { fileId: FILE } });
    expect(upload).toHaveBeenCalledWith(path, expect.any(Uint8Array), { contentType: 'image/png', upsert: false });

    const bad = form({ dealId: DEAL, versionId: VERSION, itemId: ITEM, kind: 'flight_screenshot', requestId: REQUEST });
    bad.set('file', new File([new Uint8Array([1, 2, 3])], 'fare.png', { type: 'image/png' }));
    rpc.mockClear();
    expect(await actions.uploadServiceFileAction(null, bad)).toMatchObject({ ok: false, code: 'evidence_rejected' });
    expect(rpc).not.toHaveBeenCalled();

    rpcReplies({ service_item_file_begin: { error: { code: '55000', message: 'item_file_limit' } } });
    expect(await actions.uploadServiceFileAction(null, fd)).toMatchObject({ ok: false, code: 'item_file_limit', message: 'A flight can have at most 5 screenshots. Remove one first. Nothing was uploaded.' });
  });

  it('start: booking_form_start, falling back on an older database', async () => {
    rpcReplies({ booking_form_start: { data: { versionId: VERSION, versionNo: 1, rowVersion: 1, created: true, autoFill: 'off', filled: [], skipped: [], formRules: 2 } } });
    expect(await actions.startBookingFormAction(null, form({ dealId: DEAL }))).toMatchObject({ ok: true, data: { versionId: VERSION, created: true, autoFill: 'off' } });
    rpcReplies({
      booking_form_start: { error: { code: 'PGRST202', message: 'missing' } },
      booking_start_draft: { data: { versionId: VERSION, versionNo: 1, rowVersion: 1, created: false, autoFill: 'existing_draft', filled: [], skipped: [] } },
    });
    expect(await actions.startBookingFormAction(null, form({ dealId: DEAL }))).toMatchObject({ ok: true, message: 'Draft booking opened.' });
  });

  it('Echo M3 · older database: the customer card saves only the fields it knows and says what waits', async () => {
    rpcReplies({ booking_form_get: formGet(false), booking_customer_save: { data: { rowVersion: 6, contentHash: HASH } }, booking_trip_save: { data: { rowVersion: 7, contentHash: HASH } } });
    const r = await actions.saveBookingCustomerAction(null, form(customer));
    expect(r).toMatchObject({ ok: true, message: 'Customer details saved. Passenger counts, customer type and market save after the database update.' });
    const contact = (rpc.mock.calls.find((c) => c[0] === 'booking_customer_save')![1] as { p_contact: Record<string, unknown> }).p_contact;
    const trip = (rpc.mock.calls.find((c) => c[0] === 'booking_trip_save')![1] as { p_fields: Record<string, unknown> }).p_fields;
    expect(Object.keys(contact)).not.toEqual(expect.arrayContaining(['customerType']));
    expect('market' in contact || 'customerType' in contact).toBe(false);
    expect(Object.keys(trip).sort()).toEqual(['destination', 'end', 'scope', 'start']);
  });

  it('Echo M3 · older database: new step 2/3 commands refuse in plain words, nothing saved', async () => {
    const missing = { error: { code: 'PGRST202', message: 'Could not find the function' } };
    const notInstalled = { ok: false, code: 'wrong_state', message: 'This form needs the database update; try again in a few minutes. Nothing was saved.' };
    rpcReplies({ booking_prices_save: missing });
    const prices = form({ ...draft, priceCategory: [...PRICE_CATEGORIES], priceQuantity: ['2', '0', '0', '0'], pricePurchaseRupees: ['', '', '', ''], priceMarkupRupees: ['', '', '', ''], priceSaleRupees: ['', '', '', ''] });
    expect(await actions.saveBookingPricesAction(null, prices)).toMatchObject(notInstalled);
    rpcReplies({ booking_service_save: missing });
    expect(await actions.saveBookingServiceAction(null, form({ ...draft, serviceType: 'hotel', hotelName: 'Test Resort', city: 'Goa', checkIn: '2026-12-10', nights: '2', rooms: '1', adults: '2' }))).toMatchObject(notInstalled);
    rpcReplies({ service_item_file_remove: missing });
    expect(await actions.removeServiceFileAction(null, form({ dealId: DEAL, fileId: FILE, fileRowVersion: '2' }))).toMatchObject(notInstalled);
    rpcReplies({ booking_form_get: formGet(false) });
    const bill = form({ dealId: DEAL, requestId: REQUEST, billingRowVersion: '0', billToType: 'personal', billingName: 'Riya Mehta', billingPhone: '9876543210', addressLine1: 'Test street 1', billingCity: 'Jodhpur', stateCode: '08', postalCode: '342001' });
    expect(await actions.saveBillToAction(null, bill)).toMatchObject(notInstalled);
    expect(rpc.mock.calls.some((c) => c[0] === 'booking_billing_propose')).toBe(false);
  });

  it('Echo L4 · file removal posts the row version the screen showed; a stale screen is refused', async () => {
    rpcReplies({ service_item_file_remove: { data: { fileId: FILE, status: 'removed', rowVersion: 3 } } });
    expect(await actions.removeServiceFileAction(null, form({ dealId: DEAL, fileId: FILE, fileRowVersion: '2' }))).toMatchObject({ ok: true });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['service_item_file_remove']);
    expect(rpc.mock.calls[0]![1]).toEqual({ p_file_id: FILE, p_expected_row_version: 2 });
    expect(await actions.removeServiceFileAction(null, form({ dealId: DEAL, fileId: FILE }))).toMatchObject({ ok: false, fields: ['fileRowVersion'] });
  });
});

describe('Echo review A follow-ups (Atlas fixes)', () => {
  it('L7: screenshot removal refused while service items are off or the deal is lost, in plain words', async () => {
    const fd = form({ dealId: DEAL, fileId: FILE, fileRowVersion: '2' });
    rpcReplies({ service_item_file_remove: { error: { code: '55000', message: 'service_items_disabled' } } });
    expect(await actions.removeServiceFileAction(null, fd)).toMatchObject({ ok: false, code: 'service_items_disabled', message: expect.stringMatching(/screenshot was not removed/) });
    rpcReplies({ service_item_file_remove: { error: { code: '55000', message: 'deal_not_active' } } });
    expect(await actions.removeServiceFileAction(null, fd)).toMatchObject({ ok: false, code: 'deal_not_active', message: expect.stringMatching(/screenshot was not removed/) });
  });
  it('H1: the database hint end (trip over 365 nights) highlights the return date', async () => {
    rpcReplies({ booking_form_get: formGet(true), booking_customer_save: { data: { rowVersion: 6, contentHash: HASH } }, booking_trip_save: { error: { code: '22023', message: 'invalid_input', hint: 'end' } } });
    expect(await actions.saveBookingCustomerAction(null, form(customer))).toMatchObject({ ok: false, fields: ['tripEnd'], savedRowVersion: 6 });
  });
});

describe('Echo H1 and L5', () => {
  it('a trip over 365 nights is refused on the return date', () => {
    const p = parseBookingCustomerForm(form({ ...customer, tripEnd: '2027-12-11' }));
    expect(p.ok ? [] : p.fields).toEqual(['tripEnd']);
    expect(parseBookingCustomerForm(form({ ...customer, tripEnd: '2027-12-10' })).ok).toBe(true);
  });
  it('included kilometres: 0 to 100,000', () => {
    const car = { ...draft, serviceType: 'transfer', route: 'A to B', date: '2026-12-10' };
    expect(parseBookingServiceForm(form({ ...car, includedKms: '100000' })).ok).toBe(true);
    const over = parseBookingServiceForm(form({ ...car, includedKms: '100001' }));
    expect(over.ok ? [] : over.fields).toEqual(['includedKms']);
  });
});

describe('Echo M3 · passenger extras on an older database', () => {
  const identity = { dealId: DEAL, seq: '1', identityRowVersion: '0', dateOfBirth: '1990-01-01', nationality: 'Indian', passportNumber: '', passportExpiry: '', dateOfMarriage: '2015-02-14', passengerPhone: '+971 50 123 4567', passengerEmail: 'riya@example.com' };
  it('new database: the extras are sent', async () => {
    rpcReplies({ booking_form_get: formGet(true), traveller_identity_save: { data: { seq: 1, rowVersion: 1 } } });
    expect(await bookNow.saveTravellerIdentityAction(null, form(identity))).toMatchObject({ ok: true });
    const sent = rpc.mock.calls.find((c) => c[0] === 'traveller_identity_save')![1] as { p_fields: Record<string, unknown> };
    expect(sent.p_fields).toMatchObject({ dateOfMarriage: '2015-02-14', phone: '+971501234567', email: 'riya@example.com' });
  });
  it('older database: core identity saves; the extras wait and the message says so', async () => {
    rpcReplies({ booking_form_get: formGet(false), traveller_identity_save: { data: { seq: 1, rowVersion: 1 } } });
    const r = await bookNow.saveTravellerIdentityAction(null, form(identity));
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.message).toMatch(/save after the database update/);
    const sent = rpc.mock.calls.find((c) => c[0] === 'traveller_identity_save')![1] as { p_fields: Record<string, unknown> };
    expect(Object.keys(sent.p_fields).sort()).toEqual(['dateOfBirth', 'nationality', 'passportExpiry', 'passportNumber']);
  });
});
