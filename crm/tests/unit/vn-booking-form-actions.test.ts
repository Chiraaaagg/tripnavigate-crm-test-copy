import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOKING_FORM_FIELD, parseBookingCustomerForm, parseBookingServiceForm } from '@/modules/fulfilment/booking-form-forms';
import { dealFactsView } from '@/modules/fulfilment/booking-form-vm';
import { TripFactsSchema } from '@/modules/fulfilment/b11-commands';

/*
 * Voice-note batch (24 Oct 2026): booking form actions with a fake RPC client.
 * Count rule before any write (typed input kept: the refusal names fields),
 * passengers created only when named, never deleted implicitly, never twice;
 * standard requests and extra phones only to a database that has them; hotel
 * without adults; flight passengers follow the selection; Deal facts passed
 * only where the server takes them from Bitrix. Synthetic ids and names only.
 */

const requireStaff = vi.fn();
const rpc = vi.fn();

vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => ({}) }));

const actions = await import('@/modules/fulfilment/server/book-form-actions');

const USER = 'a0000000-0000-4000-8000-000000000001';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';
const ITEM = '33333333-3333-4333-8333-333333333333';
const HOTEL = '55555555-5555-4555-8555-555555555555';
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
const sent = (fn: string) => rpc.mock.calls.find((c) => c[0] === fn)?.[1] as Record<string, unknown> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockResolvedValue({ userId: USER, supabase: { rpc }, access: { userId: USER, memberships: [], rolePermissions: [], grants: [] } });
});

const draft = { dealId: DEAL, versionId: VERSION, rowVersion: '5', requestId: REQUEST };

const fact = <T>(bitrix: T | null, source: 'bitrix' | 'booking' | 'missing' = bitrix === null ? 'missing' : 'bitrix') => ({ bitrix, booking: null, source, differs: false });
const TRIP_FACTS = {
  enabled: true,
  readAt: '2026-10-24T09:00:00Z',
  fields: {
    destination: { bitrix: { optionId: '101', label: 'Goa', listId: 'DEAL_DESTINATION' }, booking: null, source: 'bitrix', differs: false },
    scope: { bitrix: 'domestic', booking: null, source: 'bitrix', classified: true },
    start: fact('2026-12-10'),
    end: fact('2026-12-15'),
    total: fact(5),
    adults: fact(3),
    children: fact(2),
    infants: fact(0),
  },
  countsConsistent: true,
  issues: [],
};

/** booking_form_get: older (booking form only) or with the voice-note change. */
function formGet(opts: { vn?: boolean; travellers?: unknown[]; party?: Record<string, unknown> } = {}): RpcReply {
  const vn = opts.vn ?? true;
  return {
    data: {
      dealId: DEAL, canEdit: true, canConfirm: true, serviceItemsEnabled: true,
      version: { versionId: VERSION, versionNo: 1, status: 'draft', rowVersion: 5, contentHash: HASH, formRules: 2 },
      contacts: null, billing: { status: 'none', rowVersion: 0 }, travellers: opts.travellers ?? [], items: [], evidence: [],
      party: opts.party ?? { total: 5, children: 2, infants: 0, ...(vn ? { adults: 3 } : {}) },
      itemFilesCanEdit: true,
      ...(vn ? { tripFacts: TRIP_FACTS } : {}),
    },
  };
}

const customer = {
  ...draft,
  contactName: 'Test Customer',
  mobile: '98765 43210',
  email: '',
  contactConfirmed: 'on',
  bookingFor: 'individual',
  destination: 'Goa',
  tripScope: 'domestic',
  tripStart: '2026-12-10',
  tripEnd: '2026-12-15',
  paxTotal: '5',
  adults: '3',
  children: '2',
  infants: '0',
};
const saved = { data: { rowVersion: 6, contentHash: HASH } };

describe('customer card: count rule (owner item 2)', () => {
  it('parser reads adults; an empty adults box with a total is worked out', () => {
    const p = parseBookingCustomerForm(form({ ...customer, adults: '' }));
    expect(p.ok && p.value.adults).toBe(3);
    const legacyFields: Record<string, string> = { ...customer };
    delete legacyFields.adults;
    const legacy = parseBookingCustomerForm(form(legacyFields));
    expect(legacy.ok && 'adults' in legacy.value).toBe(false);
  });
  it('5 = 3 adults + 2 children saves; adults is sent to a database that has it', async () => {
    rpcReplies({ booking_form_get: formGet(), booking_customer_save: saved, booking_trip_save: { data: { rowVersion: 7, contentHash: HASH, bitrixFields: ['destination'] } } });
    expect(await actions.saveBookingCustomerAction(null, form(customer))).toMatchObject({ ok: true, message: 'Customer details saved.' });
    expect((sent('booking_trip_save')!.p_fields as Record<string, unknown>).adults).toBe(3);
  });
  it('a larger or smaller split is refused before anything is written, naming the field', async () => {
    rpcReplies({ booking_form_get: formGet() });
    const r = await actions.saveBookingCustomerAction(null, form({ ...customer, children: '3' }));
    expect(r).toMatchObject({ ok: false, code: 'invalid_input', fields: ['adults'] });
    expect(r.ok ? '' : r.message).toMatch(/add up to 6, but the trip has 5 passengers.*use Correct.*Nothing on this card was saved/);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['booking_form_get']);
    rpcReplies({ booking_form_get: formGet() });
    expect(await actions.saveBookingCustomerAction(null, form({ ...customer, adults: '1' }))).toMatchObject({ ok: false, fields: ['adults'] });
  });
  it('a contact-only save with empty total and counts at 0 saves (no count rule; gate 24 Oct regression)', async () => {
    rpcReplies({ booking_form_get: formGet(), booking_customer_save: saved, booking_trip_save: { data: { rowVersion: 7, contentHash: HASH } } });
    const r = await actions.saveBookingCustomerAction(null, form({ ...customer, paxTotal: '', adults: '', children: '0', infants: '0' }));
    expect(r).toMatchObject({ ok: true, message: 'Customer details saved.' });
    expect(sent('booking_trip_save')!.p_fields).toMatchObject({ paxTotal: null, adults: null, children: 0, infants: 0 });
    rpcReplies({ booking_form_get: formGet(), booking_customer_save: saved, booking_trip_save: { data: { rowVersion: 7, contentHash: HASH } } });
    expect(await actions.saveBookingCustomerAction(null, form({ ...customer, paxTotal: '', adults: '', children: '', infants: '' }))).toMatchObject({ ok: true });
  });
  it('an older database never receives the adults key', async () => {
    rpcReplies({ booking_form_get: formGet({ vn: false }), booking_customer_save: saved, booking_trip_save: { data: { rowVersion: 7, contentHash: HASH } } });
    expect(await actions.saveBookingCustomerAction(null, form(customer))).toMatchObject({ ok: true });
    expect(Object.keys(sent('booking_trip_save')!.p_fields as object)).not.toContain('adults');
  });
  it('the database refusing a count below the named passengers is said in plain words', async () => {
    rpcReplies({ booking_form_get: formGet(), booking_customer_save: saved, booking_trip_save: { error: { code: '22023', message: 'traveller_count_exceeded', hint: 'adult' } } });
    const r = await actions.saveBookingCustomerAction(null, form(customer));
    expect(r).toMatchObject({ ok: false, savedRowVersion: 6, fields: ['adults'] });
    expect(r.ok ? '' : r.message).toMatch(/Nobody was removed/);
  });
});

describe('passengers: slots, no duplicates, explicit removal (owner item 2)', () => {
  const stored = [
    { seq: 1, fullName: 'Asha Example', type: 'adult' },
    { seq: 2, fullName: 'Ravi Example', type: 'adult' },
  ];
  const rows = (names: string[], seqs: string[], extra: Record<string, string | string[]> = {}) =>
    form({ ...draft, travellerName: names, travellerType: names.map(() => 'adult'), travellerAge: names.map(() => ''), travellerNeeds: names.map(() => ''), travellerSeq: seqs, travellerSeqMax: '2', ...extra });

  it('saves only named rows with their standard requests (empty slots are never sent)', async () => {
    rpcReplies({ booking_form_get: formGet({ travellers: stored }), deal_travellers_save: saved });
    const r = await actions.saveBookingTravellersAction(null, rows(['Asha Example', 'Ravi Example', 'Neha Example'], ['1', '2', ''], { travellerRequests: ['vegetarian_meals,jain_meals', '', 'wheelchair_help'] }));
    expect(r).toMatchObject({ ok: true, message: 'Passengers saved.' });
    expect(sent('deal_travellers_save')!.p_travellers).toEqual([
      { fullName: 'Asha Example', type: 'adult', seq: 1, ageYears: null, specialNeeds: null, specialRequests: ['vegetarian_meals', 'jain_meals'] },
      { fullName: 'Ravi Example', type: 'adult', seq: 2, ageYears: null, specialNeeds: null, specialRequests: [] },
      { fullName: 'Neha Example', type: 'adult', seq: 3, ageYears: null, specialNeeds: null, specialRequests: ['wheelchair_help'] },
    ]);
  });
  it('refuses a save that would silently delete a saved passenger; removes only on purpose', async () => {
    rpcReplies({ booking_form_get: formGet({ travellers: stored }) });
    const r = await actions.saveBookingTravellersAction(null, rows(['Asha Example'], ['1']));
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(r.ok ? '' : r.message).toMatch(/removed only with Remove passenger/);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['booking_form_get']);
    rpcReplies({ booking_form_get: formGet({ travellers: stored }), deal_travellers_save: saved });
    expect(await actions.saveBookingTravellersAction(null, rows(['Asha Example'], ['1'], { removeTravellerSeq: '2' }))).toMatchObject({ ok: true, message: 'Passengers saved. 1 passenger was removed as you asked.' });
  });
  it('the same person twice (a reopened slot) is refused on the second row', async () => {
    rpcReplies({ booking_form_get: formGet({ travellers: stored }) });
    const r = await actions.saveBookingTravellersAction(null, rows(['Asha Example', 'Ravi Example', 'asha  example'], ['1', '2', '']));
    expect(r).toMatchObject({ ok: false, fields: ['travellerName[2]'] });
    // Echo-A L8: real namesakes are told how to tell them apart.
    expect(r.ok ? '' : r.message).toMatch(/add a middle name or an initial/);
  });
  it('unknown request codes are refused; an older database never gets the key', async () => {
    expect(await actions.saveBookingTravellersAction(null, rows(['Asha Example', 'Ravi Example'], ['1', '2'], { travellerRequests: ['spa_day', ''] }))).toMatchObject({ ok: false, fields: ['travellerRequests[0]'] });
    rpcReplies({ booking_form_get: formGet({ vn: false, travellers: stored }), deal_travellers_save: saved });
    await actions.saveBookingTravellersAction(null, rows(['Asha Example', 'Ravi Example'], ['1', '2'], { travellerRequests: ['baby_cot', ''] }));
    expect((sent('deal_travellers_save')!.p_travellers as Array<Record<string, unknown>>).every((t) => !('specialRequests' in t))).toBe(true);
  });
  it('rows above the counts are refused by the database in plain words', async () => {
    rpcReplies({ booking_form_get: formGet({ vn: false, travellers: stored }), deal_travellers_save: { error: { code: '22023', message: 'traveller_count_exceeded', hint: 'adult' } } });
    const r = await actions.saveBookingTravellersAction(null, rows(['Asha Example', 'Ravi Example', 'Neha Example'], ['1', '2', '']));
    expect(r.ok ? '' : r.message).toMatch(/More passengers are named than the adult, child and infant counts allow/);
  });
  it('Echo-A M2: when the counts come from the Bitrix deal, the words send staff to Bitrix (or remove a passenger)', async () => {
    rpcReplies({ booking_form_get: formGet({ travellers: stored }), deal_travellers_save: { error: { code: '22023', message: 'traveller_count_exceeded', hint: 'adult' } } });
    const r = await actions.saveBookingTravellersAction(null, rows(['Asha Example', 'Ravi Example', 'Neha Example'], ['1', '2', '']));
    expect(r.ok ? '' : r.message).toBe('More passengers are already named than the counts allow. These counts come from the Bitrix deal: correct them in Bitrix, or remove a passenger here. Nobody was removed. Nothing was saved.');
    rpcReplies({ booking_form_get: formGet(), booking_customer_save: saved, booking_trip_save: { error: { code: '22023', message: 'traveller_count_exceeded', hint: 'adult' } } });
    const c = await actions.saveBookingCustomerAction(null, form(customer));
    expect(c).toMatchObject({ ok: false, savedRowVersion: 6 });
    expect(c.ok ? '' : c.message).toMatch(/These counts come from the Bitrix deal: correct them in Bitrix, or remove a passenger here/);
    expect(c.ok ? '' : c.message).not.toMatch(/Remove a passenger on the passengers card first, or keep the counts/);
  });
});

describe('passenger details: extra phones (owner item 3)', () => {
  const identity = { dealId: DEAL, seq: '1', identityRowVersion: '0', dateOfBirth: '', nationality: '', passportNumber: '', passportExpiry: '' };
  it('sends up to three tidy extra phones to a database that has them; DOB stays optional', async () => {
    rpcReplies({ booking_form_get: formGet(), traveller_identity_save: { data: { seq: 1, rowVersion: 1 } } });
    expect(await actions.saveBookingIdentityAction(null, form({ ...identity, passengerPhoneExtra: ['98765 43210', '', '+44 7700 900123'] }))).toMatchObject({ ok: true });
    expect((sent('traveller_identity_save')!.p_fields as Record<string, unknown>).extraPhones).toEqual(['9876543210', '+447700900123']);
  });
  it('a bad or fourth phone is refused with the field; an older database saves the rest and says so', async () => {
    expect(await actions.saveBookingIdentityAction(null, form({ ...identity, passengerPhoneExtra: ['12'] }))).toMatchObject({ ok: false, fields: ['passengerPhoneExtra[0]'] });
    expect(await actions.saveBookingIdentityAction(null, form({ ...identity, passengerPhoneExtra: ['9876543210', '9876543211', '9876543212', '9876543213'] }))).toMatchObject({ ok: false, fields: ['passengerPhoneExtra'] });
    rpcReplies({ booking_form_get: formGet({ vn: false }), traveller_identity_save: { data: { seq: 1, rowVersion: 1 } } });
    const r = await actions.saveBookingIdentityAction(null, form({ ...identity, passengerPhoneExtra: ['9876543210'] }));
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/save after the database update/) });
    expect(Object.keys(sent('traveller_identity_save')!.p_fields as object)).not.toContain('extraPhones');
  });
});

describe('services (owner items 4, 7, 8)', () => {
  const hotel = { ...draft, serviceType: 'hotel', hotelName: 'Test Resort', city: 'Goa', checkIn: '2026-12-10', nights: '2', rooms: '1' };
  const itemSaved = { data: { itemId: ITEM, itemNo: 1, rowVersion: 9, contentHash: HASH } };
  it('hotel without adults: no adults sent (the database takes the booking adults); picked hotel id kept', async () => {
    const p = parseBookingServiceForm(form({ ...hotel, hotelId: HOTEL }));
    expect(p.ok && p.value).toMatchObject({ adultsFromBooking: true, catalogueHotelId: HOTEL });
    rpcReplies({ booking_form_get: formGet(), booking_service_save: itemSaved });
    expect(await actions.saveBookingServiceAction(null, form({ ...hotel, hotelId: HOTEL }))).toMatchObject({ ok: true, message: 'Hotel saved.' });
    const facts = sent('booking_service_save')!.p_facts as Record<string, unknown>;
    expect(facts.adults).toBeUndefined();
    expect(facts.catalogueHotelId).toBe(HOTEL);
  });
  it('hotel without adults on an older database: the saved counts fill it, never invented', async () => {
    rpcReplies({ booking_form_get: formGet({ vn: false }), booking_service_save: itemSaved });
    await actions.saveBookingServiceAction(null, form(hotel));
    expect((sent('booking_service_save')!.p_facts as Record<string, unknown>).adults).toBe(3);
    rpcReplies({ booking_form_get: formGet({ vn: false, party: { total: null, children: null, infants: null } }) });
    expect(await actions.saveBookingServiceAction(null, form(hotel))).toMatchObject({ ok: false, message: expect.stringMatching(/Enter the passenger counts on step 1 first/) });
  });
  it('hotel with no counts and no adult passengers yet: the database refusal says to enter the counts first', async () => {
    rpcReplies({ booking_form_get: formGet(), booking_service_save: { error: { code: '22023', message: 'invalid_input', hint: 'paxTotal' } } });
    const r = await actions.saveBookingServiceAction(null, form(hotel));
    expect(r).toMatchObject({ ok: false, fields: [BOOKING_FORM_FIELD.paxTotal], message: expect.stringMatching(/Enter the passenger counts on step 1 first/) });
  });
  it('an existing hotel keeps its typed adults (posted as hidden)', async () => {
    rpcReplies({ booking_service_save: itemSaved });
    await actions.saveBookingServiceAction(null, form({ ...hotel, adults: '2' }));
    expect((sent('booking_service_save')!.p_facts as Record<string, unknown>).adults).toBe(2);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['booking_service_save']);
  });
  it('flight passengers follow the passengers chosen; "save and attach" says what comes next', async () => {
    rpcReplies({ booking_service_save: itemSaved });
    const r = await actions.saveBookingServiceAction(null, form({ ...draft, serviceType: 'flight', segmentFrom: ['Jodhpur'], segmentTo: ['Goa'], segmentDate: ['2026-12-10'], passengers: '5', participantSeq: ['1', '3'], thenAttach: '1' }));
    expect(r).toMatchObject({ ok: true, data: { itemId: ITEM }, message: 'Flight saved. Now attach the ticket screenshot.' });
    const args = sent('booking_service_save')!;
    expect((args.p_facts as Record<string, unknown>).passengers).toBe(2);
    expect(args.p_participants).toEqual([1, 3]);
  });
});

describe('Deal facts view (owner item 1)', () => {
  it('passes only values the server takes from Bitrix; scope only when classified; counts only when consistent', () => {
    const facts = TripFactsSchema.parse(TRIP_FACTS);
    expect(dealFactsView(facts)).toEqual({ destination: 'Goa', start: '2026-12-10', end: '2026-12-15', total: 5, adults: 3, children: 2, infants: 0, scope: 'domestic', readAt: '2026-10-24T09:00:00Z', bitrixDealHref: null });
    // Book now v2: the loader passes the Bitrix Deal link through.
    const href = 'https://example.bitrix24.in/crm/deal/details/101/';
    expect(dealFactsView(facts, href)).toMatchObject({ bitrixDealHref: href });
    const unclassified = TripFactsSchema.parse({ ...TRIP_FACTS, fields: { ...TRIP_FACTS.fields, scope: { bitrix: null, booking: null, source: 'missing', classified: false } }, countsConsistent: false });
    expect(dealFactsView(unclassified)).toMatchObject({ scope: null, adults: null, children: null, infants: null, total: 5 });
    expect(dealFactsView(TripFactsSchema.parse({ ...TRIP_FACTS, enabled: false }))).toBeNull();
    expect(dealFactsView(null)).toBeNull();
  });
  it('a malformed tripFacts block never fails the booking read', async () => {
    const { BookingFormSchema } = await import('@/modules/fulfilment/b11-commands');
    const parsed = BookingFormSchema.parse({ ...(formGet().data as object), tripFacts: { enabled: 'yes' } });
    expect(parsed.tripFacts).toBeUndefined();
  });
});
