import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, istBusinessDate } from '../helpers/db';
import { DEAL, HOTEL, OWNER, TRANSFER, rid } from './b1-support';
import { formHelpers, line } from './booking-form-support';

/**
 * Booking form and quotation conversion (migration 20261124000120): a
 * converted draft follows form rules 2, takes the accepted party counts into
 * the version and into per-person line quantities (never amounts), keeps the
 * accepted total, and needs fresh written acceptance when per-person prices
 * add up to a different total. Mercury cases S1, S2.
 * Synthetic data only; every scenario rolls back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = formHelpers(() => db);
const { one, owner } = h;

function addDays(n: number): string {
  const d = new Date(`${istBusinessDate()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const START = addDays(60);
const END = addDays(63);
const QUOTED = '3900000';

type RV = { rowVersion: number };

/** An accepted Deal quotation: 2 adults, 1 child with bed, 1 infant; quoted total ₹39,000. */
async function acceptedQuotation() {
  await h.setSwitch('service_items_enabled', true);
  const created = await one<{ versionId: string; rowVersion: number }>(OWNER,
    'select public.quotation_create($1, $2, $3, $4) as r', ['deal', DEAL, 'Synthetic quotation', rid()]);
  const v = created.versionId;
  let rv = (await one<RV>(OWNER, 'select public.quotation_version_save($1, $2, $3::jsonb) as r', [v, created.rowVersion, JSON.stringify({
    destination: 'Synthetic City', scope: 'domestic', start: START, end: END, adults: 2, childrenWithBed: 1, childrenNoBed: 0, infants: 1,
  })])).rowVersion;
  rv = (await one<RV>(OWNER, 'select public.quotation_tiers_save($1, $2, $3::jsonb) as r',
    [v, rv, JSON.stringify([{ tierKey: 'quoted', label: 'Deluxe' }])])).rowVersion;
  const hotel = await one<{ itemId: string; rowVersion: number }>(OWNER, 'select public.quotation_item_add($1, $2, $3, $4, $5::jsonb) as r',
    [v, rv, 'hotel', null, JSON.stringify({ ...HOTEL, checkIn: START, checkOut: END })]);
  const transfer = await one<{ itemId: string; rowVersion: number }>(OWNER, 'select public.quotation_item_add($1, $2, $3, $4, $5::jsonb) as r',
    [v, hotel.rowVersion, 'transfer', null, JSON.stringify({ ...TRANSFER, date: START })]);
  rv = (await one<RV>(OWNER, 'select public.quotation_contacts_save($1, $2, $3::jsonb) as r',
    [v, transfer.rowVersion, JSON.stringify({ contactName: 'Synthetic Contact', mobile: '9876500011', email: null, companyName: null })])).rowVersion;
  rv = (await one<RV>(OWNER, 'select public.quotation_lines_save($1, $2, $3::jsonb) as r', [v, rv, JSON.stringify([
    { lineNo: 1, optionKey: 'common', itemId: hotel.itemId, categoryKey: 'hotels', description: 'Deluxe room with breakfast',
      unitKind: 'room_night', units: 2, periods: 3, unitSellPaise: '600000', unitCostPaise: '450050' },
    { lineNo: 2, optionKey: 'common', itemId: transfer.itemId, categoryKey: 'transfers', description: 'Airport to hotel by sedan',
      unitKind: 'trip', units: 1, periods: 1, unitSellPaise: '300000', unitCostPaise: null },
  ])])).rowVersion;
  rv = (await one<RV>(OWNER, 'select public.quotation_total_save($1, $2, $3, $4::bigint, $5) as r', [v, rv, 'quoted', QUOTED, true])).rowVersion;
  const ready = await one<{ contentHash: string }>(OWNER, 'select public.quotation_mark_ready($1, $2) as r', [v, rv]);
  await one(OWNER, 'select public.quotation_mark_sent($1, $2, $3, $4) as r', [v, ready.contentHash, 'whatsapp', rid()]);
  const ev = await one<{ evidenceId: string; objectPath: string }>(OWNER, 'select public.quotation_evidence_begin($1, $2, $3, $4, $5, $6) as r',
    [v, 'acceptance_message', 'acceptance.png', 'image/png', 2048, 'c'.repeat(64)]);
  await owner(`insert into storage.objects (bucket_id, name, metadata) values ('quotation-evidence', $1, jsonb_build_object('size', 2048::bigint))`,
    [ev.objectPath]);
  await one(OWNER, 'select public.quotation_evidence_finish($1, true) as r', [ev.evidenceId]);
  await one(OWNER, 'select public.quotation_accept($1, $2, $3, $4, $5) as r', [v, ready.contentHash, ev.evidenceId, 'quoted', rid()]);
  return { versionId: v, hash: ready.contentHash };
}

const convert = (versionId: string, hash: string) =>
  one<{ outcome: string; bookingVersionId: string }>(OWNER, 'select public.quotation_convert_to_booking($1, $2, $3) as r', [versionId, hash, rid()]);

describe('quotation conversion into the booking form', () => {
  it('follows form rules 2 and copies the accepted party into the version and line quantities only', async () => {
    await asOwner(db, async () => {
      const q = await acceptedQuotation();
      const c = await convert(q.versionId, q.hash);
      expect(await owner('select form_rules, pax_total, children_count, infants_count from public.booking_versions where id = $1',
        [c.bookingVersionId])).toEqual([{ form_rules: 2, pax_total: 4, children_count: 1, infants_count: 1 }]);
      expect(await owner(`select category, quantity, purchase_paise, sale_paise from public.booking_version_price_lines
        where booking_version_id = $1 order by category`, [c.bookingVersionId])).toEqual([
        { category: 'adult', quantity: 2, purchase_paise: null, sale_paise: null },
        { category: 'child_bed', quantity: 1, purchase_paise: null, sale_paise: null },
        { category: 'child_no_bed', quantity: 0, purchase_paise: null, sale_paise: null },
        { category: 'infant', quantity: 1, purchase_paise: null, sale_paise: null },
      ]);
      const form = (await h.form(OWNER))!;
      expect(form.prices).toMatchObject({ source: 'quotation_total', linesRequired: false, complete: false, sellingTotalPaise: QUOTED });
      // adults: voice-note batch (20261128000110, lead ruling Q4): the quote's consistent split records its adults.
      expect(form.party).toEqual({ total: 4, children: 1, infants: 1, adults: 2 });
      const issues = await h.issues(OWNER, c.bookingVersionId);
      expect(issues).not.toContain('price_missing');
      expect(issues).not.toContain('pax_missing');
    });
  });

  it('a reused empty draft opened outside the booking form moves to form rules 2', async () => {
    await asOwner(db, async () => {
      const q = await acceptedQuotation();
      const opened = await h.openDraft(OWNER, DEAL);
      expect(await owner('select form_rules from public.booking_versions where id = $1', [opened.versionId])).toEqual([{ form_rules: 1 }]);
      const c = await convert(q.versionId, q.hash);
      expect(c.bookingVersionId).toBe(opened.versionId);
      expect(await owner('select form_rules from public.booking_versions where id = $1', [opened.versionId])).toEqual([{ form_rules: 2 }]);
    });
  });

  it('per-person prices equal to the accepted total need no new acceptance; a different total does (S1, S2)', async () => {
    await asOwner(db, async () => {
      const q = await acceptedQuotation();
      const c = await convert(q.versionId, q.hash);
      const rv = async () => (await owner<{ row_version: number }>('select row_version from public.booking_versions where id = $1',
        [c.bookingVersionId]))[0]!.row_version;
      // Incomplete prices keep the accepted total.
      await h.savePrices(OWNER, c.bookingVersionId, await rv(),
        [line('adult', 2, '1200000', '300000', '1500000'), line('child_bed', 1), line('child_no_bed', 0), line('infant', 1)]);
      expect(await owner('select selling_total_paise::text as t from public.booking_version_commercials where version_id = $1',
        [c.bookingVersionId])).toEqual([{ t: QUOTED }]);
      expect(await h.issues(OWNER, c.bookingVersionId)).toContain('price_missing');
      // S1: 2 × 15,000 + 9,000 + 0 = 39,000.
      const same = await h.savePrices(OWNER, c.bookingVersionId, await rv(),
        [line('adult', 2, '1200000', '300000', '1500000'), line('child_bed', 1, '700000', '200000', '900000'), line('child_no_bed', 0),
          line('infant', 1, '0', '0', '0')]);
      expect(same.sellingTotalPaise).toBe(QUOTED);
      let issues = await h.issues(OWNER, c.bookingVersionId);
      expect(issues).not.toContain('quote_acceptance_stale');
      expect(issues).not.toContain('price_missing');
      // S2: a different total needs fresh written acceptance; the quotation is unchanged.
      const more = await h.savePrices(OWNER, c.bookingVersionId, await rv(),
        [line('adult', 2, '1200000', '350000', '1550000'), line('child_bed', 1, '700000', '200000', '900000'), line('child_no_bed', 0),
          line('infant', 1, '0', '0', '0')]);
      expect(more.sellingTotalPaise).toBe('4000000');
      issues = await h.issues(OWNER, c.bookingVersionId);
      expect(issues).toContain('quote_acceptance_stale');
      expect(await owner('select status, content_hash from public.quotation_versions where id = $1', [q.versionId]))
        .toEqual([{ status: 'accepted', content_hash: q.hash }]);
      await h.storeEvidence(OWNER, c.bookingVersionId);
      expect(await h.issues(OWNER, c.bookingVersionId)).not.toContain('quote_acceptance_stale');
    });
  });
});

describe('review A fixes', () => {
  it('M4: zero or incomplete per-person prices on a converted draft keep the accepted total', async () => {
    await asOwner(db, async () => {
      const q = await acceptedQuotation();
      const c = await convert(q.versionId, q.hash);
      const rv = async () => (await owner<{ row_version: number }>('select row_version from public.booking_versions where id = $1',
        [c.bookingVersionId]))[0]!.row_version;
      const total = () => owner('select selling_total_paise::text as t from public.booking_version_commercials where version_id = $1',
        [c.bookingVersionId]);
      const zero = await h.savePrices(OWNER, c.bookingVersionId, await rv(),
        [line('adult', 2, '0', '0', '0'), line('child_bed', 1, '0', '0', '0'), line('child_no_bed', 0), line('infant', 1, '0', '0', '0')]);
      expect(zero.sellingTotalPaise).toBeNull();
      expect(await total()).toEqual([{ t: QUOTED }]);
      await h.savePrices(OWNER, c.bookingVersionId, await rv(),
        [line('adult', 2), line('child_bed', 1), line('child_no_bed', 0), line('infant', 1)]);
      expect(await total()).toEqual([{ t: QUOTED }]);
      expect(await h.issues(OWNER, c.bookingVersionId)).not.toContain('quote_acceptance_stale');
    });
  });

  it('L3: changing the party counts on a converted draft needs fresh acceptance', async () => {
    await asOwner(db, async () => {
      const q = await acceptedQuotation();
      const c = await convert(q.versionId, q.hash);
      const [v] = await owner<{ row_version: number; trip_destination: string; trip_scope: string; s: string; e: string }>(
        `select row_version, trip_destination, trip_scope, to_char(trip_start, 'YYYY-MM-DD') as s, to_char(trip_end, 'YYYY-MM-DD') as e
         from public.booking_versions where id = $1`, [c.bookingVersionId]);
      expect(await h.issues(OWNER, c.bookingVersionId)).not.toContain('quote_acceptance_stale');
      await h.saveTrip(OWNER, c.bookingVersionId, v!.row_version, { destination: v!.trip_destination, scope: v!.trip_scope,
        // adults: the converted draft records adults (voice-note batch), so the counts must add up.
        start: v!.s, end: v!.e, paxTotal: 6, adults: 4, children: 1, infants: 1 });
      expect(await h.issues(OWNER, c.bookingVersionId)).toContain('quote_acceptance_stale');
      const checklist = await one<{ items: Array<{ code: string }> }>(OWNER, 'select public.intake_checklist($1) as r', [DEAL]);
      expect(checklist.items.map((i) => i.code)).toContain('quote_party_differs');
    });
  });
});
