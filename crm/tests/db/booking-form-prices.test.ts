import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, OWNER, PURCHASE, SALES_B, TRAVELLERS, TRIP, rid } from './b1-support';
import { ADULT_SALE, LINES, LINES_TOTAL, PARTY, PRICES_SQL, formHelpers, line } from './booking-form-support';

/**
 * Booking form per-person prices (migrations 20261124000100/0110/0120):
 * booking_prices_save, the derived selling total, readiness codes and the
 * booking_commercials_save refusal. Mercury cases P1-P21, S5-S7, S11.
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
const { one, owner, refused, refusedWithHint, savePrices } = h;

const EMPTY_HOTEL_FACTS = {
  hotelName: null, city: null, checkIn: null, checkOut: null, rooms: null, roomType: null, mealPlan: null,
  adults: null, children: null, inclusions: null, specialRequests: null, purchaseBudgetPaise: null,
};

/** A new-form draft with travellers and party counts (no prices yet). */
async function partyDraft(party: { paxTotal: number; children: number; infants: number } = PARTY) {
  await h.setSwitch('service_items_enabled', true);
  const s = await h.start();
  let rv = (await h.saveTravellers(OWNER, DEAL, s.rowVersion, TRAVELLERS)).rowVersion;
  rv = (await h.saveTrip(OWNER, s.versionId, rv, { ...TRIP, ...party })).rowVersion;
  return { versionId: s.versionId, rowVersion: rv };
}

const commercials = (versionId: string) =>
  owner<{ selling_total_paise: string; list_price_paise: string | null; discount_paise: string | null }>(
    'select selling_total_paise::text, list_price_paise::text, discount_paise::text from public.booking_version_commercials where version_id = $1',
    [versionId]);

describe('booking_prices_save', () => {
  it('stores purchase and sale per person, derives markup and writes the selling total in the same transaction (P1, P10, P17)', async () => {
    await asOwner(db, async () => {
      const d = await partyDraft();
      const saved = await savePrices(OWNER, d.versionId, d.rowVersion);
      expect(saved.sellingTotalPaise).toBe(LINES_TOTAL);
      expect(saved.rowVersion).toBe(d.rowVersion + 1);
      expect(await commercials(d.versionId)).toEqual([{ selling_total_paise: LINES_TOTAL, list_price_paise: null, discount_paise: null }]);
      const rows = await owner<{ category: string; purchase_paise: string; markup_paise: string; sale_paise: string }>(
        `select category, purchase_paise::text, markup_paise::text, sale_paise::text from public.booking_version_price_lines
         where booking_version_id = $1 and quantity > 0 order by category`, [d.versionId]);
      expect(rows).toEqual([
        { category: 'adult', purchase_paise: '1000000', markup_paise: '234567', sale_paise: ADULT_SALE },
        { category: 'child_bed', purchase_paise: '500000', markup_paise: '100000', sale_paise: '600000' },
      ]);
      // The read gives the same strings back (no float rounding).
      const form = (await h.form(OWNER))!;
      expect(form.prices).toMatchObject({ source: 'per_person', linesRequired: true, complete: true, sellingTotalPaise: LINES_TOTAL });
      // P17: 100 adults at the per-person cap give a safe, exact total.
      const t = await h.saveTrip(OWNER, d.versionId, saved.rowVersion, { ...TRIP, paxTotal: 100, children: 0, infants: 0 });
      const big = await savePrices(OWNER, d.versionId, t.rowVersion,
        [line('adult', 100, '99999999999', '0', '99999999999'), line('child_bed', 0), line('child_no_bed', 0), line('infant', 0)]);
      expect(big.sellingTotalPaise).toBe('9999999999900');
    });
  });

  it('accepts explicit zero and the largest amount; refuses invalid text and amounts over the cap (P8, P9, P16, P17)', async () => {
    await asOwner(db, async () => {
      const d = await partyDraft({ paxTotal: 4, children: 0, infants: 1 });
      // Infant at zero is valid and contributes nothing.
      const zero = await savePrices(OWNER, d.versionId, d.rowVersion, [
        line('adult', 3, '1000000', '0', '1000000'), line('child_bed', 0), line('child_no_bed', 0), line('infant', 1, '0', '0', '0')]);
      expect(zero.sellingTotalPaise).toBe('3000000');
      for (const bad of ['1.001', '-1', '1e3', '₹100', ' ', '100000000000']) {
        await refusedWithHint(OWNER, PRICES_SQL, [d.versionId, zero.rowVersion, JSON.stringify([
          line('adult', 3, bad, '0', bad), line('child_bed', 0), line('child_no_bed', 0), line('infant', 1, '0', '0', '0')]), rid()],
          /lines\[adult\]\.purchasePaise/);
      }
      // Numbers instead of digit strings are refused too.
      await refusedWithHint(OWNER, PRICES_SQL, [d.versionId, zero.rowVersion, JSON.stringify([
        { category: 'adult', quantity: 3, purchasePaise: 100, markupPaise: '0', salePaise: '100' },
        line('child_bed', 0), line('child_no_bed', 0), line('infant', 1, '0', '0', '0')]), rid()], /lines\[adult\]\.purchasePaise/);
      // The cap itself is accepted.
      const capped = await savePrices(OWNER, d.versionId, zero.rowVersion, [
        line('adult', 3, '99999999999', '0', '99999999999'), line('child_bed', 0), line('child_no_bed', 0), line('infant', 1, '0', '0', '0')]);
      expect(capped.sellingTotalPaise).toBe('299999999997');
    });
  });

  it('refuses an inconsistent markup and half-filled lines; stores nothing (P6, P19)', async () => {
    await asOwner(db, async () => {
      const d = await partyDraft();
      const cases: Array<[unknown[], RegExp]> = [
        [[line('adult', 3, '1000000', '1', ADULT_SALE), ...LINES.slice(1)], /^lines\[adult\]\.salePaise$/],
        [[line('adult', 3, '1000000', null, null), ...LINES.slice(1)], /^lines\[adult\]\.markupPaise$/],
        [[line('adult', 3, null, '234567', ADULT_SALE), ...LINES.slice(1)], /^lines\[adult\]\.purchasePaise$/],
        [[line('adult', 3, '1000000', '234567', null), ...LINES.slice(1)], /^lines\[adult\]\.markupPaise$|^lines\[adult\]\.salePaise$/],
      ];
      for (const [lines, hint] of cases) {
        await refusedWithHint(OWNER, PRICES_SQL, [d.versionId, d.rowVersion, JSON.stringify(lines), rid()], hint);
      }
      expect(await owner('select 1 from public.booking_version_price_lines where booking_version_id = $1', [d.versionId])).toEqual([]);
      // Hints never carry a value.
      await refusedWithHint(OWNER, PRICES_SQL, [d.versionId, d.rowVersion, JSON.stringify([line('adult', 3, '1000000', '7', ADULT_SALE), ...LINES.slice(1)]), rid()],
        /^[a-zA-Z_\[\].,]+$/);
    });
  });

  it('quantities follow the party: hidden or stale categories are refused, a short child split is a readiness mismatch (P11-P15, P20)', async () => {
    await asOwner(db, async () => {
      const d = await partyDraft({ paxTotal: 4, children: 1, infants: 1 });
      const ok = [line('adult', 2, '100', '0', '100'), line('child_bed', 1, '100', '0', '100'), line('child_no_bed', 0), line('infant', 1, '0', '0', '0')];
      const tamper: Array<[unknown[], RegExp]> = [
        [[line('adult', 3, '100', '0', '100'), ...ok.slice(1)], /lines\[adult\]\.quantity/],            // P15: sum 5 of 4
        [[ok[0], line('child_bed', 2, '100', '0', '100'), ok[2], ok[3]], /lines\[child_bed\]\.quantity/], // more children than declared
        [[ok[0], ok[1], ok[2], line('infant', 2, '0', '0', '0')], /lines\[infant\]\.quantity/],
        [[ok[0], ok[1], ok[2], line('infant', 0, '0', '0', '0')], /lines\[infant\]\.quantity/],
        [[ok[0], ok[1], ok[2]], /^lines$/],
        [[ok[0], ok[0], ok[2], ok[3]], /^lines$/],
        [[...ok.slice(0, 3), { ...ok[3], extra: 1 }], /^lines$/],
      ];
      for (const [lines, hint] of tamper) {
        await refusedWithHint(OWNER, PRICES_SQL, [d.versionId, d.rowVersion, JSON.stringify(lines), rid()], hint);
      }
      // P12: the child is not split yet: saved, readiness reports the mismatch.
      const short = await savePrices(OWNER, d.versionId, d.rowVersion,
        [ok[0], line('child_bed', 0), line('child_no_bed', 0), ok[3]]);
      expect(await h.issues(OWNER, d.versionId)).toContain('price_count_mismatch');
      const fixed = await savePrices(OWNER, d.versionId, short.rowVersion, ok);
      expect(await h.issues(OWNER, d.versionId)).not.toContain('price_count_mismatch');
      // P13/P20: children go to 0; the child line is now stale and a save that keeps it is refused.
      const t = await h.saveTrip(OWNER, d.versionId, fixed.rowVersion, { ...TRIP, paxTotal: 3, children: 0, infants: 1 });
      expect(await h.issues(OWNER, d.versionId)).toContain('price_count_mismatch');
      await refusedWithHint(OWNER, PRICES_SQL, [d.versionId, t.rowVersion, JSON.stringify(ok), rid()], /lines\[child_bed\]\.quantity/);
      const cleared = await savePrices(OWNER, d.versionId, t.rowVersion,
        [ok[0], line('child_bed', 0), line('child_no_bed', 0), ok[3]]);
      expect(cleared.sellingTotalPaise).toBe('200');
      expect(await h.issues(OWNER, d.versionId)).not.toContain('price_count_mismatch');
    });
  });

  it('a sale below purchase saves as a draft, is flagged and never clamped (P5)', async () => {
    await asOwner(db, async () => {
      const d = await partyDraft();
      const saved = await savePrices(OWNER, d.versionId, d.rowVersion,
        [line('adult', 3, '1000000', '-100000', '900000'), ...LINES.slice(1)]);
      expect(saved.sellingTotalPaise).toBe(String(3 * 900000 + 600000));
      expect(await owner('select markup_paise::text as m from public.booking_version_price_lines where booking_version_id = $1 and category = $2',
        [d.versionId, 'adult'])).toEqual([{ m: '-100000' }]);
      expect(await h.issues(OWNER, d.versionId)).toContain('price_below_purchase');
    });
  });

  it('missing amounts: no total on a new-form draft; all-zero prices give no total either (P6, P7, P18)', async () => {
    await asOwner(db, async () => {
      const d = await partyDraft();
      const full = await savePrices(OWNER, d.versionId, d.rowVersion);
      const partial = await savePrices(OWNER, d.versionId, full.rowVersion,
        [LINES[0], line('child_bed', 1), LINES[2], LINES[3]]);
      expect(partial.sellingTotalPaise).toBeNull();
      expect(await commercials(d.versionId)).toEqual([]);
      let issues = await h.issues(OWNER, d.versionId);
      expect(issues).toEqual(expect.arrayContaining(['price_missing', 'missing_selling_total']));
      const zeros = await savePrices(OWNER, d.versionId, partial.rowVersion,
        [line('adult', 3, '0', '0', '0'), line('child_bed', 1, '0', '0', '0'), LINES[2], LINES[3]]);
      expect(zeros.sellingTotalPaise).toBeNull();
      expect(await commercials(d.versionId)).toEqual([]);
      issues = await h.issues(OWNER, d.versionId);
      expect(issues).toContain('missing_selling_total');
      expect(issues).not.toContain('price_missing');
      // Nothing entered at all on a new-form draft: prices are required.
      const none = await savePrices(OWNER, d.versionId, zeros.rowVersion,
        [line('adult', 3), line('child_bed', 1), LINES[2], LINES[3]]);
      expect(none.sellingTotalPaise).toBeNull();
      expect(await h.issues(OWNER, d.versionId)).toContain('price_missing');
    });
  });

  it('booking_commercials_save and the legacy booking_save_draft total are refused while per-person prices are in use (P21); allowed again once cleared', async () => {
    await asOwner(db, async () => {
      const d = await partyDraft();
      const saved = await savePrices(OWNER, d.versionId, d.rowVersion);
      await refused(OWNER, 'select public.booking_commercials_save($1, $2, $3::bigint, $4::bigint, $5::bigint) as r',
        [d.versionId, saved.rowVersion, null, null, '100'], '55000', 'priced_per_person');
      // The legacy selling path (booking_save_draft) follows the same rule; without a total it still saves.
      await refused(OWNER, 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, $5) as r',
        [d.versionId, saved.rowVersion, JSON.stringify(EMPTY_HOTEL_FACTS), '100', true], '55000', 'priced_per_person');
      await refused(OWNER, 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, $5) as r',
        [d.versionId, saved.rowVersion, JSON.stringify(EMPTY_HOTEL_FACTS), null, true], '55000', 'priced_per_person');
      expect(await commercials(d.versionId)).toEqual([{ selling_total_paise: LINES_TOTAL, list_price_paise: null, discount_paise: null }]);
      const untouched = await one<{ rowVersion: number }>(OWNER, 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, $5) as r',
        [d.versionId, saved.rowVersion, JSON.stringify(EMPTY_HOTEL_FACTS), null, false]);
      expect(await commercials(d.versionId)).toEqual([{ selling_total_paise: LINES_TOTAL, list_price_paise: null, discount_paise: null }]);
      const cleared = await savePrices(OWNER, d.versionId, untouched.rowVersion,
        [line('adult', 3), line('child_bed', 1), LINES[2], LINES[3]]);
      const typed = await h.saveCommercials(OWNER, d.versionId, cleared.rowVersion, '150', '50', '100');
      expect(typed.rowVersion).toBe(cleared.rowVersion + 1);
    });
  });

  it('a legacy-total draft keeps its typed total until per-person prices are complete; list price and discount are then cleared (S3, S4)', async () => {
    await asOwner(db, async () => {
      // A draft opened outside the booking form keeps form rules 1.
      const d = await h.draftWithTravellers();
      expect(await owner('select form_rules from public.booking_versions where id = $1', [d.versionId])).toEqual([{ form_rules: 1 }]);
      let rv = (await h.saveCommercials(OWNER, d.versionId, d.rowVersion, '150', '50', '100')).rowVersion;
      expect(await h.issues(OWNER, d.versionId)).not.toContain('price_missing');
      rv = (await h.saveTrip(OWNER, d.versionId, rv, { ...TRIP, ...PARTY })).rowVersion;
      const partial = await savePrices(OWNER, d.versionId, rv, [LINES[0], line('child_bed', 1), LINES[2], LINES[3]]);
      expect(partial.sellingTotalPaise).toBeNull();
      expect(await commercials(d.versionId)).toEqual([{ selling_total_paise: '100', list_price_paise: '150', discount_paise: '50' }]);
      expect(await h.issues(OWNER, d.versionId)).toContain('price_missing');
      const done = await savePrices(OWNER, d.versionId, partial.rowVersion);
      expect(done.sellingTotalPaise).toBe(LINES_TOTAL);
      expect(await commercials(d.versionId)).toEqual([{ selling_total_paise: LINES_TOTAL, list_price_paise: null, discount_paise: null }]);
    });
  });

  it('stale row version, exact retry, conflicting retry and a stale submit hash (S5, S6, S11)', async () => {
    await asOwner(db, async () => {
      const d = await partyDraft();
      const req = rid();
      const first = await savePrices(OWNER, d.versionId, d.rowVersion, LINES, req);
      const again = await savePrices(OWNER, d.versionId, d.rowVersion, LINES, req);
      expect(again).toEqual({ ...first, outcome: 'existing' });
      expect(await owner(`select count(*)::int as n from public.audit_events where action = 'booking.prices_saved' and target_id = $1`,
        [d.versionId])).toEqual([{ n: 1 }]);
      await refused(OWNER, PRICES_SQL, [d.versionId, d.rowVersion, JSON.stringify([line('adult', 3, '1', '0', '1'), ...LINES.slice(1)]), req],
        '40001', 'request_conflict');
      await refused(OWNER, PRICES_SQL, [d.versionId, d.rowVersion, JSON.stringify(LINES), rid()], '40001', 'version_changed');
      // A markup-only change keeps the total but still moves the content hash: an old submit hash is refused.
      const before = (await h.readiness(OWNER, d.versionId)).contentHash;
      const moved = await savePrices(OWNER, d.versionId, first.rowVersion,
        [line('adult', 3, '1000001', '234566', ADULT_SALE), ...LINES.slice(1)]);
      expect(moved.sellingTotalPaise).toBe(LINES_TOTAL);
      expect(moved.contentHash).not.toBe(before);
      await refused(OWNER, 'select public.booking_confirm($1, $2) as r', [d.versionId, before], '40001', 'version_changed');
    });
  });

  it('only commercial readers who may edit save prices; audit rows carry no amounts', async () => {
    await asOwner(db, async () => {
      const d = await partyDraft();
      const saved = await savePrices(OWNER, d.versionId, d.rowVersion);
      expect(saved.sellingTotalPaise).toBe(LINES_TOTAL);
      await h.addSalesAssignee(DEAL, SALES_B.userId!);
      await owner(`delete from public.role_permissions where role_code = 'sales' and permission_code = 'deal.read_commercial'`);
      await refused(SALES_B, PRICES_SQL, [d.versionId, saved.rowVersion, JSON.stringify(LINES), rid()], '42501', 'not_authorized');
      await refused(PURCHASE, PRICES_SQL, [d.versionId, saved.rowVersion, JSON.stringify(LINES), rid()], '42501', 'not_authorized');
      const audit = await owner<{ details: unknown }>(`select details from public.audit_events where target_id = $1`, [d.versionId]);
      expect(JSON.stringify(audit)).not.toMatch(/1234567|234567|4303701|600000|1000000/);
    });
  });
});
