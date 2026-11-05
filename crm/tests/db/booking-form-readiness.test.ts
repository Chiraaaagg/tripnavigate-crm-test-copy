import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { CHECKLIST_SQL, CONTACT, DEAL, FLIGHT_FACTS, HOTEL, OWNER, SALES_B, TRANSFER, TRAVELLERS, TRIP } from './b1-support';
import { VISA } from './b11-support';
import { ACC } from './finance-support';
import { LINES, PARTY, formHelpers, line } from './booking-form-support';

/**
 * Booking form readiness (migration 20261124000120): hotel night coverage,
 * party counts, trip-wide service dates, the atomic recheck at confirmation,
 * the checklist and the "ask the owner" masking. Mercury cases V1-V7,
 * S3, S10, S12. Synthetic data only; every scenario rolls back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = formHelpers(() => db);
const { one, owner, refused } = h;

const CONTACT_LABELLED = { ...CONTACT, customerType: 'b2d', market: 'uae' };
const HOTEL_CODES = ['hotel_nights_missing', 'hotel_outside_trip', 'hotel_same_day_trip'];
const hotel = (checkIn: string, checkOut: string, extra: Record<string, unknown> = {}) =>
  ['hotel', { ...HOTEL, checkIn, checkOut, ...extra }] as [string, unknown];

/** A ready new-form draft with the given items, then the trip moved to [start, end]. */
async function withTrip(items: Array<[string, unknown]>, start: string, end: string) {
  const r = await h.readyForm(OWNER, DEAL, { items });
  const t = await h.saveTrip(OWNER, r.versionId, r.rowVersion, { ...TRIP, start, end, ...PARTY });
  const form = (await h.form(OWNER))!;
  return { ...r, rowVersion: t.rowVersion, issues: await h.issues(OWNER, r.versionId), coverage: form.coverage as Record<string, unknown> };
}

describe('a complete new-form draft', () => {
  it('has no issues, confirms once and creates exactly one task per service (S10, S12)', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm(OWNER, DEAL, { items: [hotel('2026-12-10', '2026-12-13'), ['transfer', { ...TRANSFER, endDate: '2026-12-13', quantity: 2, includedKms: 250, vendor: 'Synthetic Cabs' }]] });
      expect(r.issues).toEqual([]);
      const checklist = await one<{ items: Array<{ code: string; blocking: boolean }>; canConfirm: boolean }>(OWNER, CHECKLIST_SQL, [DEAL]);
      expect(checklist.items.filter((i) => i.blocking)).toEqual([]);
      expect(checklist.canConfirm).toBe(true);
      const first = await h.confirm(OWNER, r.versionId, r.hash);
      const again = await h.confirm(OWNER, r.versionId, r.hash);
      expect(again).toMatchObject({ outcome: 'existing' });
      expect(first.taskIds).toHaveLength(2);
      expect(await owner('select count(*)::int as n from public.fulfilment_tasks where deal_id = $1', [DEAL])).toEqual([{ n: 2 }]);
    });
  });

  it('confirmation rechecks the booking-form codes under the version lock (S12)', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      // A later change opens a hotel gap: the fresh hash is current, but readiness refuses.
      const t = await h.saveTrip(OWNER, r.versionId, r.rowVersion, { ...TRIP, end: '2026-12-15', ...PARTY });
      expect(await h.issues(OWNER, r.versionId)).toContain('hotel_nights_missing');
      await refused(OWNER, 'select public.booking_confirm($1, $2) as r', [r.versionId, t.contentHash], '55000', 'not_ready');
    });
  });
});

describe('hotel night coverage', () => {
  it('six tour nights need six covered nights; parallel rooms count once (V1, V2)', async () => {
    await asOwner(db, async () => {
      const one6 = await withTrip([hotel('2026-12-10', '2026-12-16')], '2026-12-10', '2026-12-16');
      expect(one6.issues.filter((c) => HOTEL_CODES.includes(c))).toEqual([]);
      expect(one6.coverage).toEqual({ nights: 6, covered: 6, missing: [], outside: [] });
    });
    await asOwner(db, async () => {
      const parallel = await withTrip([hotel('2026-12-10', '2026-12-16'), hotel('2026-12-10', '2026-12-16', { roomType: 'Synthetic Suite' })],
        '2026-12-10', '2026-12-16');
      expect(parallel.coverage).toMatchObject({ nights: 6, covered: 6, missing: [] });
      expect(parallel.issues.filter((c) => HOTEL_CODES.includes(c))).toEqual([]);
    });
  });

  it('a gap is reported even when the stays add up to the tour nights; overlaps never hide it (V3)', async () => {
    await asOwner(db, async () => {
      const overlap = await withTrip([hotel('2026-12-10', '2026-12-13'), hotel('2026-12-11', '2026-12-14')], '2026-12-10', '2026-12-16');
      expect(overlap.coverage).toMatchObject({ nights: 6, covered: 4, missing: ['2026-12-14', '2026-12-15'] });
      expect(overlap.issues).toContain('hotel_nights_missing');
      expect(overlap.issues).not.toContain('hotel_outside_trip');
    });
    await asOwner(db, async () => {
      const split = await withTrip([hotel('2026-12-10', '2026-12-13'), hotel('2026-12-14', '2026-12-17')], '2026-12-10', '2026-12-16');
      expect(split.coverage).toMatchObject({ nights: 6, missing: ['2026-12-13'] });
      expect(split.coverage.outside).toEqual([split.itemIds[1]]);
      expect(split.issues).toEqual(expect.arrayContaining(['hotel_nights_missing', 'hotel_outside_trip']));
    });
  });

  it('a stay before the start or past the end is outside the trip (V4); a same-day trip has no overnight hotel (V5)', async () => {
    await asOwner(db, async () => {
      const early = await withTrip([hotel('2026-12-09', '2026-12-13')], '2026-12-10', '2026-12-13');
      expect(early.issues).toContain('hotel_outside_trip');
      const checklist = await one<{ items: Array<{ code: string; itemNos: number[] }> }>(OWNER, CHECKLIST_SQL, [DEAL]);
      expect(checklist.items.find((i) => i.code === 'hotel_outside_trip')?.itemNos).toEqual([1]);
    });
    await asOwner(db, async () => {
      const sameDay = await withTrip([hotel('2026-12-10', '2026-12-11')], '2026-12-10', '2026-12-10');
      expect(sameDay.issues).toEqual(expect.arrayContaining(['hotel_same_day_trip', 'hotel_outside_trip']));
      expect(sameDay.issues).not.toContain('hotel_nights_missing');
      expect(sameDay.coverage).toMatchObject({ nights: 0, covered: 0, missing: [] });
    });
  });

  it('flight-only and visa-only bookings need no hotel; visa preparation dates may fall before the trip (V6, V7)', async () => {
    await asOwner(db, async () => {
      const flight = await h.readyForm(OWNER, DEAL, { items: [['flight', FLIGHT_FACTS]] });
      expect(flight.issues).toEqual([]);
    });
    await asOwner(db, async () => {
      const visa = await h.readyForm(OWNER, DEAL, { items: [['visa', { ...VISA, applyBy: '2026-11-20' }]] });
      expect(visa.issues.filter((c) => [...HOTEL_CODES, 'service_dates_outside_trip'].includes(c))).toEqual([]);
    });
  });
});

describe('service dates and party counts', () => {
  it('car, activity and flight dates must stay within the trip (service_dates_outside_trip)', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm(OWNER, DEAL, { items: [hotel('2026-12-10', '2026-12-13'),
        ['transfer', { ...TRANSFER, endDate: '2026-12-20' }],
        ['flight', { ...FLIGHT_FACTS, segments: [{ from: 'DEL', to: 'JDH', date: '2026-12-10' },
          { from: 'JDH', to: 'DEL', date: '2026-12-13', arrivalDate: '2026-12-14', airline: 'Synthetic Air', flightNo: 'SA 101',
            departTime: '23:30', arriveTime: '01:10' }] }]] });
      expect(r.issues).toContain('service_dates_outside_trip');
      const checklist = await one<{ items: Array<{ code: string; itemNos: number[]; blocking: boolean }> }>(OWNER, CHECKLIST_SQL, [DEAL]);
      expect(checklist.items.find((i) => i.code === 'service_dates_outside_trip')).toMatchObject({ itemNos: [2, 3], blocking: true });
      // The older warning is not repeated on a new-form draft.
      expect(checklist.items.map((i) => i.code)).not.toContain('dates_outside_trip');
    });
  });

  it('facts validation: car end date before its date, quantity 0 and an arrival date before departure are refused', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const s = await h.start();
      const sql = 'select public.booking_service_save($1, $2, $3, $4, $5::jsonb, $6::bigint, $7::jsonb, $8::integer[], $9) as r';
      await h.refusedWithHint(OWNER, sql, [s.versionId, s.rowVersion, null, 'transfer',
        JSON.stringify({ ...TRANSFER, endDate: '2026-12-09', quantity: 0 }), null, null, null, crypto.randomUUID()], /^endDate,quantity$/);
      await h.refusedWithHint(OWNER, sql, [s.versionId, s.rowVersion, null, 'flight',
        JSON.stringify({ ...FLIGHT_FACTS, segments: [{ from: 'DEL', to: 'JDH', date: '2026-12-10', arrivalDate: '2026-12-09' }] }),
        null, null, null, crypto.randomUUID()], /^segments$/);
    });
  });

  it('pax_missing until the total is entered; pax_types_exceeded when more travellers are named than the counts allow', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const noParty = await h.saveTrip(OWNER, r.versionId, r.rowVersion, { ...TRIP, paxTotal: null, children: null, infants: null });
      expect(await h.issues(OWNER, r.versionId)).toContain('pax_missing');
      // 4 named (3 adults, 1 child) but the counts say 4 with no children.
      await h.saveTrip(OWNER, r.versionId, noParty.rowVersion, { ...TRIP, paxTotal: 4, children: 0, infants: 0 });
      expect(await h.issues(OWNER, r.versionId)).toEqual(expect.arrayContaining(['pax_types_exceeded', 'price_count_mismatch']));
    });
  });

  it('party input: children and infants cannot exceed the total; absent keys keep the stored counts', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      await h.refusedWithHint(OWNER, 'select public.booking_trip_save($1, $2, $3::jsonb) as r',
        [r.versionId, r.rowVersion, JSON.stringify({ ...TRIP, paxTotal: 2, children: 2, infants: 1 })], /^children$/);
      await h.refusedWithHint(OWNER, 'select public.booking_trip_save($1, $2, $3::jsonb) as r',
        [r.versionId, r.rowVersion, JSON.stringify({ ...TRIP, paxTotal: 101 })], /^paxTotal$/);
      await h.saveTrip(OWNER, r.versionId, r.rowVersion, TRIP);
      expect(await owner('select pax_total, children_count, infants_count from public.booking_versions where id = $1', [r.versionId]))
        .toEqual([{ pax_total: 4, children_count: 1, infants_count: 0 }]);
    });
  });
});

describe('older drafts and viewers', () => {
  it('a draft opened outside the booking form keeps the older rules: no party, price, hotel or new Bill To codes (S3)', async () => {
    await asOwner(db, async () => {
      const r = await h.readyDraft(OWNER, DEAL, [['hotel', { ...HOTEL, checkIn: '2026-12-10', checkOut: '2026-12-11' }]]);
      expect(await owner('select form_rules from public.booking_versions where id = $1', [r.versionId])).toEqual([{ form_rules: 1 }]);
      expect(r.issues).toEqual([]);
      const form = (await h.form(OWNER))!;
      expect(form.prices).toMatchObject({ source: 'legacy_total', linesRequired: false, lines: [] });
      expect((form.version as Record<string, unknown>).formRules).toBe(1);
    });
  });

  it('without commercial scope the price codes read prices_ask_owner, once, never the markup sign (Mercury B9)', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      await h.savePrices(OWNER, r.versionId, r.rowVersion, [line('adult', 3, '1000000', '-1', '999999'), line('child_bed', 1), LINES[2], LINES[3]]);
      expect(await h.issues(OWNER, r.versionId)).toEqual(expect.arrayContaining(['price_missing', 'price_below_purchase']));
      await h.addSalesAssignee(DEAL, SALES_B.userId!);
      await owner(`delete from public.role_permissions where role_code = 'sales' and permission_code = 'deal.read_commercial'`);
      const masked = await h.issues(SALES_B, r.versionId);
      expect(masked.filter((c) => c === 'prices_ask_owner')).toHaveLength(1);
      expect(masked.some((c) => c.startsWith('price_'))).toBe(false);
      const checklist = await one<{ items: Array<{ code: string }> }>(SALES_B, CHECKLIST_SQL, [DEAL]);
      const codes = checklist.items.map((i) => i.code);
      expect(codes.filter((c) => c === 'prices_ask_owner')).toHaveLength(1);
      expect(codes.some((c) => c.startsWith('price_'))).toBe(false);
    });
  });
});

describe('revisions of a new-form booking', () => {
  it('copy party, labels, prices and estimates; keep form rules 2; a changed final sale is material (S9)', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      await h.confirm(OWNER, r.versionId, r.hash);
      await one(ACC, 'select public.accounts_review_return($1, $2, $3) as r',
        [r.versionId, 'Synthetic return: the price needs a change', crypto.randomUUID()]);
      const opened = await one<{ versionId: string; rowVersion: number }>(OWNER, 'select public.booking_open_revision($1) as r', [r.versionId]);
      expect(await owner(`select v.form_rules, v.pax_total, v.children_count, v.infants_count,
          (select count(*)::int from public.booking_version_price_lines l where l.booking_version_id = v.id) as lines,
          (select count(*)::int from public.service_item_cost_estimates e where e.booking_version_id = v.id) as estimates,
          (select c.customer_type from public.booking_version_contacts c where c.booking_version_id = v.id) as customer_type
        from public.booking_versions v where v.id = $1`, [opened.versionId]))
        .toEqual([{ form_rules: 2, pax_total: 4, children_count: 1, infants_count: 0, lines: 4, estimates: 1, customer_type: 'individual' }]);
      expect((await h.readiness(OWNER, opened.versionId)).issues).toEqual(['revision_class_missing', 'no_changes']);
      await h.savePrices(OWNER, opened.versionId, opened.rowVersion,
        [line('adult', 3, '1000000', '300000', '1300000'), ...LINES.slice(1)]);
      const changed = await owner<{ f: string[] }>('select authz.revision_changed_fields($1) as f', [opened.versionId]);
      expect(changed[0]!.f).toEqual(['prices.sale', 'sellingTotal']);
      expect(await owner<{ c: string[] }>('select authz.revision_allowed_classes(authz.revision_changed_fields($1)) as c', [opened.versionId]))
        .toEqual([{ c: ['customer_material'] }]);
    });
  });
});

describe('booking_form_start', () => {
  it('starts a draft under form rules 2; an existing draft keeps its rules; contacts keep labels when an older caller omits them', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const first = await h.start();
      expect(first).toMatchObject({ created: true, formRules: 2 });
      expect(await h.start()).toMatchObject({ versionId: first.versionId, created: false, formRules: 2 });
      const rv = (await h.saveContacts(OWNER, first.versionId, first.rowVersion, { ...CONTACT_LABELLED })).rowVersion;
      await h.saveContacts(OWNER, first.versionId, rv);
      expect(await owner('select customer_type, market from public.booking_version_contacts where booking_version_id = $1', [first.versionId]))
        .toEqual([{ customer_type: 'b2d', market: 'uae' }]);
    });
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const legacy = await h.openDraft(OWNER, DEAL);
      expect(await h.start()).toMatchObject({ versionId: legacy.versionId, created: false, formRules: 1 });
    });
  });
});

describe('review A fixes', () => {
  it('H1: a trip over 365 nights is refused for every writer; an older long trip still loads with a capped night list', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      await h.refusedWithHint(OWNER, 'select public.booking_trip_save($1, $2, $3::jsonb) as r',
        [r.versionId, r.rowVersion, JSON.stringify({ ...TRIP, end: '2027-12-11', ...PARTY })], /^end$/);
      // Exactly 365 nights is allowed.
      const boundary = await h.saveTrip(OWNER, r.versionId, r.rowVersion, { ...TRIP, end: '2027-12-10', ...PARTY });
      expect(boundary.rowVersion).toBe(r.rowVersion + 1);
      // Automatic filling writes the row directly: the table constraint refuses it too.
      await db.exec('savepoint h1');
      await expect(owner(`update public.booking_versions set trip_end = trip_start + 366 where id = $1`, [r.versionId]))
        .rejects.toMatchObject({ code: '23514' });
      await db.exec('rollback to savepoint h1');
      // A trip saved before the rule (simulated by lifting the constraint in this rolled-back transaction).
      await owner('alter table public.booking_versions drop constraint booking_versions_trip_length_check');
      await owner(`update public.booking_versions set trip_end = trip_start + 400 where id = $1`, [r.versionId]);
      const form = (await h.form(OWNER))!;
      const coverage = form.coverage as { nights: number; covered: number; missing: string[] };
      expect(coverage.nights).toBe(400);
      expect(coverage.covered).toBe(3);
      expect(coverage.missing).toHaveLength(366);
    });
  });

  it('H1: without a hotel the coverage lists no missing nights', async () => {
    await asOwner(db, async () => {
      await h.readyForm(OWNER, DEAL, { items: [['flight', FLIGHT_FACTS]] });
      expect((await h.form(OWNER))!.coverage).toEqual({ nights: 3, covered: 0, missing: [], outside: [] });
    });
  });

  it('L2: an empty price table reports price_missing only, not price_count_mismatch', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const s = await h.start();
      const rv = (await h.saveTravellers(OWNER, DEAL, s.rowVersion, TRAVELLERS)).rowVersion;
      await h.saveTrip(OWNER, s.versionId, rv, { ...TRIP, ...PARTY });
      const issues = await h.issues(OWNER, s.versionId);
      expect(issues).toContain('price_missing');
      expect(issues).not.toContain('price_count_mismatch');
    });
  });
});
