import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, expectDbError, istBusinessDate, resetActor, setActor } from '../helpers/db';
import { ACCOUNTS, DEAL, FLIGHT, HOTEL, MANAGER, OWNER, PURCHASE, SALES_B, SUPER, TRANSFER, b1Helpers, rid } from './b1-support';
import { REPORT, claimHelpers } from './b11-claims-support';

/**
 * B1.2 Phase E quotation money (migration 20261120000300, Mercury): lines,
 * typed totals per tier, payment plan, money codes, hash, access, guard,
 * copy into a new version and conversion into the booking draft. Quotation
 * header, states and conversion command are Atlas's 20261120000200.
 * Synthetic data only; every scenario rolls back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = claimHelpers(() => db);
const { one, owner, refused } = h;
const b1 = b1Helpers(() => db);

const LINES_SQL = 'select public.quotation_lines_save($1, $2, $3::jsonb) as r';
const TOTAL_SQL = 'select public.quotation_total_save($1, $2, $3, $4::bigint, $5) as r';
const PLAN_SQL = 'select public.quotation_plan_save($1, $2, $3, $4::jsonb) as r';
const COSTS_SQL = 'select public.quotation_cost_estimates_save($1, $2::jsonb) as r';
const GET_SQL = 'select public.quotation_get($1) as r';

type RV = { rowVersion: number; status: string };
type Money = {
  lines: Array<Record<string, unknown>>;
  tiers: Array<Record<string, unknown> & { tierKey: string }>;
  instalments: Array<Record<string, unknown>>;
  codes: string[];
  costRefreshAllowed: boolean;
};

function addDays(n: number): string {
  const d = new Date(`${istBusinessDate()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const START = addDays(60);
const END = addDays(63);

async function hintOf(actor: Actor, sql: string, params: unknown[]): Promise<{ code?: string; message?: string; hint?: string }> {
  await db.exec('savepoint q_hint');
  try {
    await setActor(db, actor);
    await db.query(sql, params);
  } catch (e) {
    await db.exec('rollback to savepoint q_hint');
    await resetActor(db);
    return e as { code?: string; message?: string; hint?: string };
  }
  await resetActor(db);
  throw new Error('expected a database error, but the statement succeeded');
}

/** A Deal quotation draft with trip, 3 paying travellers + 1 infant, tiers, a hotel and a transfer. */
async function draft(opts: { upgrade?: boolean; extraBeds?: number } = {}) {
  await h.setSwitch(true);
  const created = await one<{ quotationId: string; versionId: string; rowVersion: number }>(OWNER,
    'select public.quotation_create($1, $2, $3, $4) as r', ['deal', DEAL, 'Synthetic quotation', rid()]);
  const v = created.versionId;
  let rv = created.rowVersion;
  rv = (await one<RV>(OWNER, 'select public.quotation_version_save($1, $2, $3::jsonb) as r', [v, rv, JSON.stringify({
    destination: 'Synthetic City', scope: 'domestic', start: START, end: END,
    adults: 2, childrenWithBed: 1, childrenNoBed: 0, infants: 1,
  })])).rowVersion;
  const tiers = [{ tierKey: 'quoted', label: 'Deluxe' }, ...(opts.upgrade ? [{ tierKey: 'upgrade', label: 'Luxury' }] : [])];
  rv = (await one<RV>(OWNER, 'select public.quotation_tiers_save($1, $2, $3::jsonb) as r', [v, rv, JSON.stringify(tiers)])).rowVersion;
  const hotelFacts = { ...HOTEL, checkIn: START, checkOut: END, ...(opts.extraBeds ? { extraBeds: opts.extraBeds } : {}) };
  const hotel = await one<{ itemId: string; itemNo: number; rowVersion: number }>(OWNER,
    'select public.quotation_item_add($1, $2, $3, $4, $5::jsonb) as r', [v, rv, 'hotel', null, JSON.stringify(hotelFacts)]);
  rv = hotel.rowVersion;
  const transfer = await one<{ itemId: string; itemNo: number; rowVersion: number }>(OWNER,
    'select public.quotation_item_add($1, $2, $3, $4, $5::jsonb) as r', [v, rv, 'transfer', null, JSON.stringify({ ...TRANSFER, date: START })]);
  rv = transfer.rowVersion;
  let upgradeHotel: string | null = null;
  if (opts.upgrade) {
    const up = await one<{ itemId: string; rowVersion: number }>(OWNER,
      'select public.quotation_item_add($1, $2, $3, $4, $5::jsonb) as r',
      [v, rv, 'hotel', 'upgrade', JSON.stringify({ ...hotelFacts, hotelName: 'Synthetic Luxury Hotel' })]);
    rv = up.rowVersion;
    upgradeHotel = up.itemId;
  }
  rv = (await one<RV>(OWNER, 'select public.quotation_contacts_save($1, $2, $3::jsonb) as r',
    [v, rv, JSON.stringify({ contactName: 'Synthetic Contact', mobile: '9876500011', email: null, companyName: null })])).rowVersion;
  return { quotationId: created.quotationId, versionId: v, rowVersion: rv, hotel: hotel.itemId, transfer: transfer.itemId, upgradeHotel };
}

/** Hotel 2 rooms x 3 nights at ₹6,000 (cost ₹4,500.50) and one cab trip at ₹2,500 (cost unknown). */
const baseLines = (d: { hotel: string; transfer: string }) => [
  { lineNo: 1, optionKey: 'common', itemId: d.hotel, categoryKey: 'hotels', description: 'Deluxe room with breakfast',
    unitKind: 'room_night', units: 2, periods: 3, unitSellPaise: '600000', unitCostPaise: '450050', remark: 'Rate sheet October' },
  { lineNo: 2, optionKey: 'common', itemId: d.transfer, categoryKey: 'transfers', description: 'Airport to hotel by sedan',
    unitKind: 'trip', units: 1, periods: 1, unitSellPaise: '250000', unitCostPaise: null },
];

const money = async (actor: Actor, versionId: string) =>
  (await one<{ money?: Money | null } | null>(actor, GET_SQL, [versionId]))?.money ?? null;

async function priced(opts: { upgrade?: boolean; total?: string; plan?: unknown[] } = {}) {
  const d = await draft(opts);
  let rv = (await one<RV>(OWNER, LINES_SQL, [d.versionId, d.rowVersion, JSON.stringify(baseLines(d))])).rowVersion;
  rv = (await one<RV>(OWNER, TOTAL_SQL, [d.versionId, rv, 'quoted', opts.total ?? '3900000', true])).rowVersion;
  if (opts.plan) rv = (await one<RV>(OWNER, PLAN_SQL, [d.versionId, rv, 'quoted', JSON.stringify(opts.plan)])).rowVersion;
  return { ...d, rowVersion: rv };
}

async function readyAndSent(versionId: string, rowVersion: number) {
  const ready = await one<{ contentHash: string; rowVersion: number }>(OWNER, 'select public.quotation_mark_ready($1, $2) as r', [versionId, rowVersion]);
  await one(OWNER, 'select public.quotation_mark_sent($1, $2, $3, $4) as r', [versionId, ready.contentHash, 'whatsapp', rid()]);
  return ready.contentHash;
}

async function accepted(versionId: string, hash: string, tier = 'quoted') {
  const ev = await one<{ evidenceId: string; objectPath: string }>(OWNER,
    'select public.quotation_evidence_begin($1, $2, $3, $4, $5, $6) as r',
    [versionId, 'acceptance_message', 'acceptance.png', 'image/png', 2048, 'c'.repeat(64)]);
  await owner(`insert into storage.objects (bucket_id, name, metadata) values ('quotation-evidence', $1, jsonb_build_object('size', 2048::bigint))`,
    [ev.objectPath]);
  await one(OWNER, 'select public.quotation_evidence_finish($1, true) as r', [ev.evidenceId]);
  await one(OWNER, 'select public.quotation_accept($1, $2, $3, $4, $5) as r', [versionId, hash, ev.evidenceId, tier, rid()]);
}

const convert = (versionId: string, hash: string) =>
  one<{ outcome: string; bookingVersionId: string; itemsCreated: number }>(OWNER,
    'select public.quotation_convert_to_booking($1, $2, $3) as r', [versionId, hash, rid()]);

describe('quotation_lines_save', () => {
  it('stores lines exactly as typed; line totals are exact products; cost may hold paise', async () => {
    await asOwner(db, async () => {
      const d = await draft();
      const saved = await one<RV>(OWNER, LINES_SQL, [d.versionId, d.rowVersion, JSON.stringify(baseLines(d))]);
      expect(saved.status).toBe('draft');
      expect(await owner(`select line_no, units, periods, line_sell_paise::text as s, line_cost_paise::text as c
                          from public.quotation_version_lines where quotation_version_id = $1 order by line_no`, [d.versionId]))
        .toEqual([{ line_no: 1, units: 2, periods: 3, s: '3600000', c: '2700300' }, { line_no: 2, units: 1, periods: 1, s: '250000', c: null }]);
      const m = (await money(OWNER, d.versionId))!;
      expect(m.lines[0]).toMatchObject({ lineNo: 1, unitKind: 'room_night', quantity: 6, lineSellPaise: '3600000', lineCostPaise: '2700300', remark: 'Rate sheet October' });
      // Replacing the set; a stale row version is refused.
      await refused(OWNER, LINES_SQL, [d.versionId, d.rowVersion, '[]'], '40001', 'version_changed');
      const empty = await one<RV>(OWNER, LINES_SQL, [d.versionId, saved.rowVersion, '[]']);
      expect(await owner('select 1 from public.quotation_version_lines where quotation_version_id = $1', [d.versionId])).toHaveLength(0);
      expect(empty.rowVersion).toBe(saved.rowVersion + 1);
    });
  });

  it('refuses bad shapes with the field in the hint, and internal wording in customer text', async () => {
    await asOwner(db, async () => {
      const d = await draft();
      const [hotelLine, cabLine] = baseLines(d);
      const cases: Array<[unknown, RegExp]> = [
        [{ ...hotelLine, unitSellPaise: '600050' }, /^lines\[1\]\.unitSellPaise$/], // not a whole rupee
        [{ ...hotelLine, unitSellPaise: '-100' }, /^lines\[1\]\.unitSellPaise$/],
        [{ ...hotelLine, unitSellPaise: '6000.00' }, /^lines\[1\]\.unitSellPaise$/],
        [{ ...hotelLine, unitCostPaise: '-1' }, /^lines\[1\]\.unitCostPaise$/],
        [{ ...hotelLine, unitKind: 'night' }, /^lines\[1\]\.unitKind$/], // hotel main must be room_night
        [{ ...cabLine, unitKind: 'line_total' }, /^lines\[1\]\.unitKind$/], // cab main must be trip
        [{ ...hotelLine, units: 0 }, /^lines\[1\]\.units$/],
        [{ ...hotelLine, periods: 367 }, /^lines\[1\]\.periods$/],
        [{ ...hotelLine, optionKey: 'premium' }, /^lines\[1\]\.optionKey$/],
        [{ ...hotelLine, categoryKey: 'tax' }, /^lines\[1\]\.categoryKey$/],
        [{ ...hotelLine, itemId: crypto.randomUUID() }, /^lines\[1\]\.itemId$/],
        [{ ...hotelLine, gstPaise: '100' }, /^lines\[1\]\.gstPaise$/],
        [{ ...hotelLine, description: '' }, /^lines\[1\]\.description$/],
        [{ lineNo: 1, optionKey: 'common', itemId: null, chargeKind: 'extra_bed', categoryKey: 'hotels', description: 'Extra bed',
           unitKind: 'night', units: 1, periods: 3, unitSellPaise: '100000' }, /^lines\[1\]\.itemId$/],
        [{ lineNo: 1, optionKey: 'common', itemId: null, categoryKey: 'other', description: 'Service fee',
           unitKind: 'line_total', units: 2, periods: 1, unitSellPaise: '100000' }, /^lines\[1\]\.units$/],
      ];
      for (const [line, hint] of cases) {
        const e = await hintOf(OWNER, LINES_SQL, [d.versionId, d.rowVersion, JSON.stringify([line])]);
        expect(e.code).toBe('22023');
        expect(e.message).toBe('invalid_input');
        expect(e.hint ?? '').toMatch(hint);
      }
      // Duplicate line numbers.
      const dup = await hintOf(OWNER, LINES_SQL, [d.versionId, d.rowVersion, JSON.stringify([hotelLine, { ...cabLine, lineNo: 1 }])]);
      expect(dup.hint).toBe('lines[2].lineNo');
      for (const words of ['Net rate for two rooms', 'Includes our MARGIN', 'Best price guaranteed', 'Hurry, rooms are going']) {
        const e = await hintOf(OWNER, LINES_SQL, [d.versionId, d.rowVersion, JSON.stringify([{ ...hotelLine, description: words }])]);
        expect([e.code, e.message, e.hint]).toEqual(['22023', 'internal_wording', 'lines[1].description']);
      }
      // "International flights" is not "internal"; the remark is internal and never scanned.
      await one(OWNER, LINES_SQL, [d.versionId, d.rowVersion, JSON.stringify([{ ...hotelLine, description: 'International flights and hotel', remark: 'net rate 4500' }])]);
    });
  });

  it('extra-bed and child-without-bed charges take a staff-chosen unit; quantities are never derived from stay counts', async () => {
    await asOwner(db, async () => {
      const d = await draft({ extraBeds: 1 });
      const lines = [...baseLines(d)];
      let rv = (await one<RV>(OWNER, LINES_SQL, [d.versionId, d.rowVersion, JSON.stringify(lines)])).rowVersion;
      rv = (await one<RV>(OWNER, TOTAL_SQL, [d.versionId, rv, 'quoted', '3850000', true])).rowVersion;
      expect((await money(OWNER, d.versionId))!.codes).toContain('extra_bed_not_priced');
      const withBed = [...lines,
        { lineNo: 3, optionKey: 'common', itemId: d.hotel, chargeKind: 'extra_bed', categoryKey: 'hotels', description: 'Extra bed',
          unitKind: 'night', units: 1, periods: 2, unitSellPaise: '120000', unitCostPaise: '90000' },
        { lineNo: 4, optionKey: 'common', itemId: d.hotel, chargeKind: 'child_no_bed', categoryKey: 'hotels', description: 'Child meals',
          unitKind: 'line_total', units: 1, periods: 1, unitSellPaise: '50000', unitCostPaise: '30000' }];
      rv = (await one<RV>(OWNER, LINES_SQL, [d.versionId, rv, JSON.stringify(withBed)])).rowVersion;
      // Stored exactly as typed: 1 bed x 2 nights, although the stay has 3 nights.
      expect(await owner(`select units, periods, line_sell_paise::text as s from public.quotation_version_lines
                          where quotation_version_id = $1 and charge_kind = 'extra_bed'`, [d.versionId]))
        .toEqual([{ units: 1, periods: 2, s: '240000' }]);
      expect((await money(OWNER, d.versionId))!.codes).not.toContain('extra_bed_not_priced');
      // A person unit is refused on a main hotel line but accepted on an extra-bed line.
      const e = await hintOf(OWNER, LINES_SQL, [d.versionId, rv, JSON.stringify([{ ...lines[0], unitKind: 'person', periods: 1 }])]);
      expect(e.hint).toBe('lines[1].unitKind');
    });
  });
});

describe('typed totals, per-person rule and money codes', () => {
  it('the typed total wins; a different component sum is only a warning; per-person printed only when exact', async () => {
    await asOwner(db, async () => {
      const d = await draft();
      let rv = (await one<RV>(OWNER, LINES_SQL, [d.versionId, d.rowVersion, JSON.stringify(baseLines(d))])).rowVersion;
      let m = (await money(OWNER, d.versionId))!;
      expect(m.codes).toEqual(expect.arrayContaining(['quoted_total_missing', 'cost_incomplete']));
      for (const [total, hint] of [['0', /^totalPaise$/], ['99', /^totalPaise$/], ['3900050', /^totalPaise$/]] as Array<[string, RegExp]>) {
        const e = await hintOf(OWNER, TOTAL_SQL, [d.versionId, rv, 'quoted', total, true]);
        expect([e.message, e.hint]).toEqual(['invalid_input', expect.stringMatching(hint)]);
      }
      const badTier = await hintOf(OWNER, TOTAL_SQL, [d.versionId, rv, 'premium', '3900000', true]);
      expect(badTier.hint).toBe('tierKey');
      // Components 38,50,000 paise; typed 39,00,000; 3 paying travellers (infant not counted) -> 13,00,000 each.
      rv = (await one<RV>(OWNER, TOTAL_SQL, [d.versionId, rv, 'quoted', '3900000', true])).rowVersion;
      m = (await money(OWNER, d.versionId))!;
      expect(m.tiers[0]).toMatchObject({ tierKey: 'quoted', label: 'Deluxe', quotedTotalPaise: '3900000', componentSellPaise: '3850000',
        differencePaise: '50000', payingTravellers: 3, perPersonPaise: '1300000', costTotalPaise: null, costComplete: false, marginPaise: null });
      expect(m.codes).toContain('component_mismatch');
      expect(m.codes).not.toContain('quoted_total_missing');
      expect(await owner('select quoted_total_paise::text as t from public.quotation_version_tier_money where quotation_version_id = $1', [d.versionId]))
        .toEqual([{ t: '3900000' }]);
      // Not divisible: 39,00,100 / 3 is not a whole rupee per person.
      rv = (await one<RV>(OWNER, TOTAL_SQL, [d.versionId, rv, 'quoted', '3900100', true])).rowVersion;
      m = (await money(OWNER, d.versionId))!;
      expect(m.tiers[0]!.perPersonPaise).toBeNull();
      expect(m.codes).toContain('per_person_not_exact');
      // Sales switches the per-person line off: no warning.
      rv = (await one<RV>(OWNER, TOTAL_SQL, [d.versionId, rv, 'quoted', '3900100', false])).rowVersion;
      expect((await money(OWNER, d.versionId))!.codes).not.toContain('per_person_not_exact');
      // Costs known and total equal to the components: no mismatch; margin shown; negative margin warns only.
      rv = (await one<RV>(OWNER, LINES_SQL, [d.versionId, rv, JSON.stringify(baseLines(d).map((l) => ({ ...l, unitCostPaise: l.unitCostPaise ?? '200000' })))])).rowVersion;
      rv = (await one<RV>(OWNER, TOTAL_SQL, [d.versionId, rv, 'quoted', '3850000', true])).rowVersion;
      m = (await money(OWNER, d.versionId))!;
      expect(m.tiers[0]).toMatchObject({ differencePaise: '0', costTotalPaise: '2900300', costComplete: true, marginPaise: '949700' });
      expect(m.codes).not.toEqual(expect.arrayContaining(['component_mismatch']));
      rv = (await one<RV>(OWNER, TOTAL_SQL, [d.versionId, rv, 'quoted', '2000000', true])).rowVersion;
      expect((await money(OWNER, d.versionId))!.codes).toContain('margin_negative');
      // Warnings never block mark_ready.
      const ready = await one<{ status: string }>(OWNER, 'select public.quotation_mark_ready($1, $2) as r', [d.versionId, rv]);
      expect(ready.status).toBe('ready');
    });
  });

  it('upgrade tier needs its own typed total; lines of an upgrade item must be upgrade lines', async () => {
    await asOwner(db, async () => {
      const d = await draft({ upgrade: true });
      const upgradeLine = { lineNo: 3, optionKey: 'upgrade', itemId: d.upgradeHotel, categoryKey: 'hotels', description: 'Luxury room',
        unitKind: 'room_night', units: 2, periods: 3, unitSellPaise: '900000', unitCostPaise: '700000' };
      const wrong = await hintOf(OWNER, LINES_SQL, [d.versionId, d.rowVersion, JSON.stringify([...baseLines(d), { ...upgradeLine, optionKey: 'quoted' }])]);
      expect(wrong.hint).toBe('lines[3].optionKey');
      let rv = (await one<RV>(OWNER, LINES_SQL, [d.versionId, d.rowVersion, JSON.stringify([...baseLines(d), upgradeLine])])).rowVersion;
      rv = (await one<RV>(OWNER, TOTAL_SQL, [d.versionId, rv, 'quoted', '3900000', true])).rowVersion;
      let m = (await money(OWNER, d.versionId))!;
      expect(m.codes).toContain('upgrade_total_missing');
      const notReady = await hintOf(OWNER, 'select public.quotation_mark_ready($1, $2) as r', [d.versionId, rv]);
      expect([notReady.code, notReady.message]).toEqual(['55000', 'not_ready']);
      rv = (await one<RV>(OWNER, TOTAL_SQL, [d.versionId, rv, 'upgrade', '7300000', true])).rowVersion;
      m = (await money(OWNER, d.versionId))!;
      expect(m.codes).not.toContain('upgrade_total_missing');
      // Upgrade components: common 38,50,000 + 54,00,000 = 92,50,000.
      expect(m.tiers.find((t) => t.tierKey === 'upgrade')).toMatchObject({ componentSellPaise: '9250000', quotedTotalPaise: '7300000' });
    });
  });

  it('the plan must add up to the typed total before the version is marked ready; due dates must lie ahead', async () => {
    await asOwner(db, async () => {
      const d = await priced();
      let rv = d.rowVersion;
      const bad = [
        [{ seq: 1, label: 'Advance', amountPaise: '1000050', dueRule: 'on_acceptance' }],
        [{ seq: 1, label: 'Advance', amountPaise: '1000000', dueRule: 'fixed_date' }],
        [{ seq: 1, label: 'Advance', amountPaise: '1000000', dueRule: 'on_acceptance', dueDays: 3 }],
        [{ seq: 1, label: 'Advance', amountPaise: '1000000', dueRule: 'days_before_start', dueDays: 0 }],
        [{ seq: 1, label: 'A', amountPaise: '100', dueRule: 'on_acceptance' }, { seq: 1, label: 'B', amountPaise: '100', dueRule: 'on_acceptance' }],
        [{ seq: 1, label: 'A', amountPaise: '100', dueRule: 'on_acceptance', mode: 'upi' }],
      ];
      for (const plan of bad) {
        const e = await hintOf(OWNER, PLAN_SQL, [d.versionId, rv, 'quoted', JSON.stringify(plan)]);
        expect(e.message).toBe('invalid_input');
        expect(e.hint ?? '').toMatch(/^instalments\[\d\]$/);
      }
      const tooMany = await hintOf(OWNER, PLAN_SQL, [d.versionId, rv, 'quoted',
        JSON.stringify(Array.from({ length: 13 }, (_, i) => ({ seq: i + 1, label: 'X', amountPaise: '100', dueRule: 'on_acceptance' })))]);
      expect(tooMany.hint).toBe('instalments');
      const pushy = await hintOf(OWNER, PLAN_SQL, [d.versionId, rv, 'quoted', JSON.stringify([{ seq: 1, label: 'Last chance deposit', amountPaise: '3900000', dueRule: 'on_acceptance' }])]);
      expect([pushy.message, pushy.hint]).toEqual(['internal_wording', 'instalments[1].label']);
      rv = (await one<RV>(OWNER, PLAN_SQL, [d.versionId, rv, 'quoted', JSON.stringify([
        { seq: 1, label: 'On confirmation', amountPaise: '1000000', dueRule: 'on_acceptance' },
        { seq: 2, label: 'Balance', amountPaise: '2800000', dueRule: 'days_before_start', dueDays: 30 },
      ])])).rowVersion;
      expect((await money(OWNER, d.versionId))!.codes).toContain('plan_total_mismatch');
      rv = (await one<RV>(OWNER, PLAN_SQL, [d.versionId, rv, 'quoted', JSON.stringify([
        { seq: 1, label: 'On confirmation', amountPaise: '1000000', dueRule: 'on_acceptance' },
        { seq: 2, label: 'Balance', amountPaise: '2900000', dueRule: 'days_before_start', dueDays: 90 },
      ])])).rowVersion;
      // 90 days before a start 60 days ahead is in the past.
      expect((await money(OWNER, d.versionId))!.codes).toEqual(expect.arrayContaining(['plan_due_invalid']));
      expect((await money(OWNER, d.versionId))!.codes).not.toContain('plan_total_mismatch');
      rv = (await one<RV>(OWNER, PLAN_SQL, [d.versionId, rv, 'quoted', JSON.stringify([
        { seq: 1, label: 'On confirmation', amountPaise: '1000000', dueRule: 'on_acceptance' },
        { seq: 2, label: 'Balance', amountPaise: '2900000', dueRule: 'days_before_start', dueDays: 30 },
      ])])).rowVersion;
      const codes = (await money(OWNER, d.versionId))!.codes;
      expect(codes).not.toContain('plan_due_invalid');
      expect(codes).not.toContain('plan_total_mismatch');
      // An empty plan is allowed (optional).
      rv = (await one<RV>(OWNER, PLAN_SQL, [d.versionId, rv, 'quoted', '[]'])).rowVersion;
      expect((await money(OWNER, d.versionId))!.codes).not.toContain('plan_total_mismatch');
      // No amount in any audit row of these commands.
      const audit = await owner(`select details from public.audit_events where target_id = $1 and action in
        ('quotation.lines_saved', 'quotation.total_saved', 'quotation.plan_saved')`, [d.versionId]);
      expect(audit.length).toBeGreaterThanOrEqual(4);
      expect(JSON.stringify(audit)).not.toMatch(/3900000|2900000|1000000|600000|450050|Deluxe room/);
    });
  });
});

describe('access', () => {
  it('only commercial quotation editors read and edit money; never Purchase, Flight, Accounts, Super Admin or other Sales', async () => {
    await asOwner(db, async () => {
      const d = await priced();
      await b1.addFlight();
      expect(await money(OWNER, d.versionId)).not.toBeNull();
      for (const actor of [SALES_B, PURCHASE, ACCOUNTS, FLIGHT, SUPER]) {
        await refused(actor, LINES_SQL, [d.versionId, d.rowVersion, '[]'], '42501', 'not_authorized');
        await refused(actor, TOTAL_SQL, [d.versionId, d.rowVersion, 'quoted', '100', true], '42501', 'not_authorized');
        await refused(actor, PLAN_SQL, [d.versionId, d.rowVersion, 'quoted', '[]'], '42501', 'not_authorized');
        await refused(actor, COSTS_SQL, [d.versionId, JSON.stringify([{ lineNo: 1, unitCostPaise: '1' }])], '42501', 'not_authorized');
        const got = await one<{ money?: unknown } | null>(actor, GET_SQL, [d.versionId]);
        expect(got?.money ?? null).toBeNull();
      }
      // The branch Manager edits the quotation but reads commercial values only with commercial scope on the Deal
      // (existing rule: own scope on Deals they own or are assigned to, or a branch grant).
      expect((await one<{ money?: unknown } | null>(MANAGER, GET_SQL, [d.versionId]))?.money ?? null).toBeNull();
      await refused(MANAGER, TOTAL_SQL, [d.versionId, d.rowVersion, 'quoted', '100', true], '42501', 'not_authorized');
      await owner(`insert into public.access_grants (user_id, legal_entity_id, branch_id, permission_code, granted_by, reason)
                   select $1, d.legal_entity_id, d.branch_id, 'deal.read_commercial', $2, 'Synthetic branch grant for the test'
                   from public.deals d where d.id = $3`, [MANAGER.userId, SUPER.userId, DEAL]);
      expect(await money(MANAGER, d.versionId)).not.toBeNull();
      // A Sales owner whose commercial permission is withdrawn loses money (not the quotation).
      await owner(`delete from public.role_permissions where role_code = 'sales' and permission_code = 'deal.read_commercial'`);
      expect(await money(OWNER, d.versionId)).toBeNull();
      await refused(OWNER, TOTAL_SQL, [d.versionId, d.rowVersion, 'quoted', '100', true], '42501', 'not_authorized');
    });
  });

  it('Lead quotation: the Lead owner reads money; the branch Manager only with commercial scope; never Purchase', async () => {
    await asOwner(db, async () => {
      await h.setSwitch(true);
      // Synthetic Lead in Delhi owned by Sales Delhi A (intake provenance relaxed inside this rolled-back transaction).
      await db.exec('alter table public.crm_leads drop constraint crm_leads_intake_inbox_id_fkey');
      await db.exec('alter table public.crm_leads drop constraint crm_leads_manifest_id_fkey');
      const [lead] = await owner<{ id: string }>(
        `insert into public.crm_leads (legal_entity_id, branch_id, reference, title, owner_user_id, source_portal, source_lead_id,
           source_status_id, source_id_code, source_created_at, source_modified_at, last_synced_at, last_verified_at, intake_inbox_id, manifest_id)
         select b.legal_entity_id, b.id, 'BXL-77001', 'Synthetic quotation lead', $1, 'SYNTHETIC_MEMBER_0001', 77001,
                'NEW', 'WEBFORM', now(), now(), now(), now(), gen_random_uuid(), gen_random_uuid()
         from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
         where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL' returning id`, [U.salesDelhiA]);
      const created = await one<{ quotationId: string; versionId: string; rowVersion: number }>(OWNER,
        'select public.quotation_create($1, $2, $3, $4) as r', ['lead', lead!.id, 'Synthetic lead quotation', rid()]);
      const rv = (await one<RV>(OWNER, TOTAL_SQL, [created.versionId, created.rowVersion, 'quoted', '100000', true])).rowVersion;
      expect((await money(OWNER, created.versionId))!.tiers[0]!.quotedTotalPaise).toBe('100000');
      for (const actor of [SALES_B, PURCHASE, ACCOUNTS, SUPER]) {
        await refused(actor, TOTAL_SQL, [created.versionId, rv, 'quoted', '200000', true], '42501', 'not_authorized');
      }
      // The Delhi Manager edits Lead quotations but is not the Lead's owner: money only with a branch grant.
      expect((await one<{ money?: unknown } | null>(MANAGER, GET_SQL, [created.versionId]))?.money ?? null).toBeNull();
      await refused(MANAGER, TOTAL_SQL, [created.versionId, rv, 'quoted', '200000', true], '42501', 'not_authorized');
      await owner(`insert into public.access_grants (user_id, legal_entity_id, branch_id, permission_code, granted_by, reason)
                   select $1, l.legal_entity_id, l.branch_id, 'deal.read_commercial', $2, 'Synthetic branch grant for the test'
                   from public.crm_leads l where l.id = $3`, [MANAGER.userId, SUPER.userId, lead!.id]);
      expect((await one<RV>(MANAGER, TOTAL_SQL, [created.versionId, rv, 'quoted', '200000', true])).rowVersion).toBe(rv + 1);
    });
  });

  it('quotation_customer_money: selling side for money readers only; null for everyone else; refused without a session', async () => {
    await asOwner(db, async () => {
      const d = await priced();
      await b1.addFlight();
      const CUSTOMER_SQL = 'select public.quotation_customer_money($1) as r';
      const view = await one<{ tiers: Array<Record<string, unknown>> } | null>(OWNER, CUSTOMER_SQL, [d.versionId]);
      expect(view!.tiers[0]).toMatchObject({ tierKey: 'quoted', quotedTotalPaise: '3900000', perPersonPaise: '1300000' });
      expect(JSON.stringify(view)).not.toMatch(/cost|margin|remark|difference|Rate sheet/i);
      expect(view).toEqual((await owner<{ r: unknown }>('select authz.quotation_customer_money_json($1) as r', [d.versionId]))[0]!.r);
      for (const actor of [SALES_B, PURCHASE, ACCOUNTS, FLIGHT, SUPER, MANAGER]) {
        expect(await one(actor, CUSTOMER_SQL, [d.versionId])).toBeNull();
      }
      expect(await one(OWNER, CUSTOMER_SQL, [crypto.randomUUID()])).toBeNull();
      await refused({ userId: null }, CUSTOMER_SQL, [d.versionId], '42501');
      // Read only: no audit row.
      expect(await owner(`select 1 from public.audit_events where target_id = $1 and action like 'quotation.customer%'`, [d.versionId])).toHaveLength(0);
    });
  });

  it('no Data API access to any money table, for any role', async () => {
    await asOwner(db, async () => {
      await priced();
      for (const actor of [OWNER, MANAGER, ACCOUNTS, PURCHASE]) {
        for (const table of ['quotation_version_lines', 'quotation_version_tier_money', 'quotation_version_instalments']) {
          await setActor(db, actor);
          await expectDbError(db, () => db.query(`select * from public.${table}`), { code: '42501' });
          await resetActor(db);
        }
      }
      for (const fn of ['authz.quotation_money_json(gen_random_uuid())', 'authz.quotation_money_check(gen_random_uuid())',
        'authz.quotation_customer_money_json(gen_random_uuid())']) {
        await setActor(db, OWNER);
        await expectDbError(db, () => db.query(`select ${fn}`), { code: '42501' });
        await resetActor(db);
      }
    });
  });
});

describe('guard, hash and cost refresh', () => {
  it('money rows are frozen once the version leaves draft; cost refresh changes no hash; refused after conversion', async () => {
    await asOwner(db, async () => {
      const d = await priced();
      const hash = await readyAndSent(d.versionId, d.rowVersion);
      for (const sql of [
        `update public.quotation_version_lines set unit_sell_paise = 100 where quotation_version_id = $1`,
        `update public.quotation_version_tier_money set quoted_total_paise = 100 where quotation_version_id = $1`,
        `delete from public.quotation_version_lines where quotation_version_id = $1`,
        // Without the command's marker even a cost-only change is refused.
        `update public.quotation_version_lines set unit_cost_paise = 1 where quotation_version_id = $1`,
      ]) {
        await expectDbError(db, () => owner(sql, [d.versionId]), { code: '42501' });
      }
      // Commands on a sent version: lines refused (Atlas lock), costs allowed.
      const locked = await hintOf(OWNER, LINES_SQL, [d.versionId, d.rowVersion, '[]']);
      expect([locked.code, locked.message]).toEqual(['55000', 'wrong_state']);
      const refreshed = await one<{ updated: number }>(OWNER, COSTS_SQL, [d.versionId, JSON.stringify([{ lineNo: 2, unitCostPaise: '180000' }])]);
      expect(refreshed.updated).toBe(1);
      expect(await owner(`select content_hash from public.quotation_versions where id = $1`, [d.versionId])).toEqual([{ content_hash: hash }]);
      const m = (await money(OWNER, d.versionId))!;
      expect(m.tiers[0]).toMatchObject({ costComplete: true, costTotalPaise: '2880300' });
      const bad = await hintOf(OWNER, COSTS_SQL, [d.versionId, JSON.stringify([{ lineNo: 9, unitCostPaise: '1' }])]);
      expect(bad.hint).toBe('costs[1]');
      await accepted(d.versionId, hash);
      // Same checks as every quotation command: a removed Deal refuses the refresh (provenance relaxed in this rolled-back transaction).
      await owner('alter table public.deals drop constraint deals_removed_imported_only');
      await owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [DEAL]);
      await refused(OWNER, COSTS_SQL, [d.versionId, JSON.stringify([{ lineNo: 2, unitCostPaise: '1' }])], '55000', 'deal_removed');
      await owner('update public.deals set removed_at = null, removed_reason = null where id = $1', [DEAL]);
      await convert(d.versionId, hash);
      await refused(OWNER, COSTS_SQL, [d.versionId, JSON.stringify([{ lineNo: 2, unitCostPaise: '1' }])], '55000', 'wrong_state');
    });
  });

  it('the money hash covers selling lines, totals and plan; never cost or remark', async () => {
    await asOwner(db, async () => {
      const d = await priced();
      const hashOf = async () => (await owner<{ h: string }>('select authz.quotation_money_hash($1) as h', [d.versionId]))[0]!.h;
      const h0 = await hashOf();
      const lines = baseLines(d);
      let rv = (await one<RV>(OWNER, LINES_SQL, [d.versionId, d.rowVersion, JSON.stringify(lines.map((l) => ({ ...l, unitCostPaise: '1', remark: 'Changed remark' })))])).rowVersion;
      expect(await hashOf()).toBe(h0);
      rv = (await one<RV>(OWNER, LINES_SQL, [d.versionId, rv, JSON.stringify(lines.map((l, i) => (i === 1 ? { ...l, unitSellPaise: '260000' } : l)))])).rowVersion;
      const h1 = await hashOf();
      expect(h1).not.toBe(h0);
      rv = (await one<RV>(OWNER, TOTAL_SQL, [d.versionId, rv, 'quoted', '3910000', true])).rowVersion;
      const h2 = await hashOf();
      expect(h2).not.toBe(h1);
      await one<RV>(OWNER, PLAN_SQL, [d.versionId, rv, 'quoted', JSON.stringify([{ seq: 1, label: 'Full', amountPaise: '3910000', dueRule: 'on_acceptance' }])]);
      expect(await hashOf()).not.toBe(h2);
    });
  });
});

describe('new version and customer view', () => {
  it('a new version copies lines (re-pointed to the copied items), totals and plan', async () => {
    await asOwner(db, async () => {
      const d = await priced({ plan: [{ seq: 1, label: 'Full', amountPaise: '3900000', dueRule: 'on_acceptance' }] });
      await readyAndSent(d.versionId, d.rowVersion);
      const next = await one<{ versionId: string }>(OWNER, 'select public.quotation_new_version($1, $2, $3) as r', [d.quotationId, d.versionId, rid()]);
      const copied = await owner<{ line_no: number; item_no: number; s: string }>(
        `select l.line_no, i.item_no, l.line_sell_paise::text as s from public.quotation_version_lines l
         join public.quotation_version_items i on i.id = l.item_id
         where l.quotation_version_id = $1 and i.quotation_version_id = $1 order by l.line_no`, [next.versionId]);
      expect(copied).toEqual([{ line_no: 1, item_no: 1, s: '3600000' }, { line_no: 2, item_no: 2, s: '250000' }]);
      const m = (await money(OWNER, next.versionId))!;
      expect(m.tiers[0]!.quotedTotalPaise).toBe('3900000');
      expect(m.instalments).toHaveLength(1);
      expect(await owner<{ h: string }>('select authz.quotation_money_hash($1) as h', [next.versionId]))
        .toEqual(await owner<{ h: string }>('select authz.quotation_money_hash($1) as h', [d.versionId]));
    });
  });

  it('the customer view has no cost, margin or remark; breakdown amounts only when the components equal the total', async () => {
    await asOwner(db, async () => {
      const d = await priced();
      const view = async () => (await owner<{ r: Record<string, unknown> }>('select authz.quotation_customer_money_json($1) as r', [d.versionId]))[0]!.r;
      let v = await view();
      expect(JSON.stringify(v)).not.toMatch(/cost|margin|remark|difference|Rate sheet|450050/i);
      let tier = (v.tiers as Array<Record<string, unknown>>)[0]!;
      expect(tier).toMatchObject({ quotedTotalPaise: '3900000', perPersonPaise: '1300000', breakdownHasAmounts: false });
      expect((tier.breakdown as Array<Record<string, unknown>>).every((b) => b.amountPaise === null)).toBe(true);
      await one<RV>(OWNER, TOTAL_SQL, [d.versionId, d.rowVersion, 'quoted', '3850000', true]);
      v = await view();
      tier = (v.tiers as Array<Record<string, unknown>>)[0]!;
      expect(tier.breakdownHasAmounts).toBe(true);
      expect(tier.breakdown).toEqual([
        { categoryKey: 'hotels', descriptions: ['Deluxe room with breakfast'], amountPaise: '3600000' },
        { categoryKey: 'transfers', descriptions: ['Airport to hotel by sedan'], amountPaise: '250000' },
      ]);
    });
  });
});

describe('conversion into the booking draft', () => {
  it('fills the selling total (typed), the plan with resolved dates and purchase budgets; never list price or discount', async () => {
    await asOwner(db, async () => {
      const d = await priced({ plan: [
        { seq: 1, label: 'On confirmation', amountPaise: '1000000', dueRule: 'on_acceptance' },
        { seq: 2, label: 'Balance', amountPaise: '2900000', dueRule: 'days_before_start', dueDays: 30 },
      ] });
      const hash = await readyAndSent(d.versionId, d.rowVersion);
      await accepted(d.versionId, hash);
      const conv = await convert(d.versionId, hash);
      expect(conv.outcome).toBe('created');
      const b = conv.bookingVersionId;
      expect(await owner(`select selling_total_paise::text as t, list_price_paise as l, discount_paise as d
                          from public.booking_version_commercials where version_id = $1`, [b]))
        .toEqual([{ t: '3900000', l: null, d: null }]);
      expect(await owner(`select seq, label, amount_paise::text as a, due_date::text as due from public.booking_version_instalments
                          where booking_version_id = $1 order by seq`, [b]))
        .toEqual([
          { seq: 1, label: 'On confirmation', a: '1000000', due: istBusinessDate() },
          { seq: 2, label: 'Balance', a: '2900000', due: addDays(30) },
        ]);
      expect(await owner(`select i.service_type as t, f.purchase_budget_paise::text as b from public.service_item_facts f
                          join public.service_items i on i.id = f.service_item_id
                          where f.booking_version_id = $1 order by i.item_no`, [b]))
        .toEqual([{ t: 'hotel', b: '2700300' }, { t: 'transfer', b: '0' }]);
      const issues = (await h.one<{ issues: string[] }>(OWNER, 'select public.booking_readiness($1) as r', [b])).issues;
      expect(issues).not.toEqual(expect.arrayContaining(['missing_selling_total']));
      expect(issues).not.toContain('plan_total_mismatch');
      expect(issues).not.toContain('plan_missing');
      // Idempotent per version.
      expect((await convert(d.versionId, hash)).outcome).toBe('existing');
      expect(await owner('select 1 from public.booking_version_commercials where version_id = $1', [b])).toHaveLength(1);
      // A claim on the converted draft is checked against the converted total; nothing accepts a quotation id.
      await h.refused(OWNER, REPORT, [DEAL, JSON.stringify(h.cashClaim({ amountPaise: '3900100' })), rid()], '55000', 'claim_over_total');
      expect((await h.report(OWNER, h.cashClaim({ amountPaise: '1000000' }))).status).toBe('reported');
      await h.refused(OWNER, REPORT, [d.quotationId, JSON.stringify(h.cashClaim()), rid()], '42501', 'not_authorized');
    });
  });

  it('the converted draft matches the accepted quotation (no quote_acceptance_stale) until its selling total or plan changes', async () => {
    await asOwner(db, async () => {
      const d = await priced({ plan: [{ seq: 1, label: 'Full', amountPaise: '3900000', dueRule: 'on_acceptance' }] });
      const hash = await readyAndSent(d.versionId, d.rowVersion);
      await accepted(d.versionId, hash);
      const b = (await convert(d.versionId, hash)).bookingVersionId;
      const issues = async () => (await h.one<{ issues: string[] }>(OWNER, 'select public.booking_readiness($1) as r', [b])).issues;
      expect(await issues()).not.toContain('quote_acceptance_stale');
      expect(await issues()).not.toContain('missing_acceptance_proof');
      const [row] = await owner<{ row_version: number }>('select row_version from public.booking_versions where id = $1', [b]);
      // Same total, other plan dates: stale.
      let rv = (await one<{ rowVersion: number }>(OWNER, 'select public.booking_instalments_save($1, $2, $3::jsonb) as r',
        [b, row!.row_version, JSON.stringify([{ seq: 1, label: 'Full', amountPaise: '3900000', dueDate: addDays(5) }])])).rowVersion;
      expect(await issues()).toContain('quote_acceptance_stale');
      // Back to the converted plan: not stale; a different selling total: stale.
      rv = (await one<{ rowVersion: number }>(OWNER, 'select public.booking_instalments_save($1, $2, $3::jsonb) as r',
        [b, rv, JSON.stringify([{ seq: 1, label: 'Full', amountPaise: '3900000', dueDate: istBusinessDate() }])])).rowVersion;
      expect(await issues()).not.toContain('quote_acceptance_stale');
      await one(OWNER, 'select public.booking_commercials_save($1, $2, $3::bigint, $4::bigint, $5::bigint) as r', [b, rv, null, null, '4000000']);
      expect(await issues()).toContain('quote_acceptance_stale');
    });
  });

  it('the stored content hash includes the money hash, at ready, send, acceptance and conversion', async () => {
    await asOwner(db, async () => {
      const d = await priced();
      const recomputed = async () => (await owner<{ h: string }>('select authz.quotation_content_hash($1) as h', [d.versionId]))[0]!.h;
      const stored = async () => (await owner<{ h: string }>('select content_hash as h from public.quotation_versions where id = $1', [d.versionId]))[0]!.h;
      const hash = await readyAndSent(d.versionId, d.rowVersion);
      expect(await stored()).toBe(hash);
      expect(await recomputed()).toBe(hash);
      // The hash really depends on money: with the money part replaced it differs.
      const [noMoney] = await owner<{ differs: boolean }>(
        `select authz.quotation_money_hash($1) <> encode(sha256(convert_to('[]', 'UTF8')), 'hex') as differs`, [d.versionId]);
      expect(noMoney!.differs).toBe(true);
      // An internal cost refresh keeps the hash; acceptance and conversion check the same hash.
      await one(OWNER, COSTS_SQL, [d.versionId, JSON.stringify([{ lineNo: 1, unitCostPaise: '460000' }])]);
      expect(await recomputed()).toBe(hash);
      await accepted(d.versionId, hash);
      expect(await recomputed()).toBe(hash);
      await convert(d.versionId, hash);
      expect(await recomputed()).toBe(hash);
    });
  });

  it('an item whose lines are not all costed converts with budget 0 ("not set"), so the budget_missing warning shows', async () => {
    await asOwner(db, async () => {
      const d = await draft({ extraBeds: 1 });
      const lines = [...baseLines(d).map((l) => ({ ...l, unitCostPaise: '200000' })),
        { lineNo: 3, optionKey: 'common', itemId: d.hotel, chargeKind: 'extra_bed', categoryKey: 'hotels', description: 'Extra bed',
          unitKind: 'night', units: 1, periods: 3, unitSellPaise: '100000', unitCostPaise: null }];
      let rv = (await one<RV>(OWNER, LINES_SQL, [d.versionId, d.rowVersion, JSON.stringify(lines)])).rowVersion;
      rv = (await one<RV>(OWNER, TOTAL_SQL, [d.versionId, rv, 'quoted', '4150000', true])).rowVersion;
      const hash = await readyAndSent(d.versionId, rv);
      await accepted(d.versionId, hash);
      const b = (await convert(d.versionId, hash)).bookingVersionId;
      // Hotel: main line costed (12,00,000) but the extra bed is not: 0, never the partial 12,00,000. Transfer: fully costed.
      expect(await owner(`select i.item_no as n, i.service_type as t, f.purchase_budget_paise::text as b from public.service_item_facts f
                          join public.service_items i on i.id = f.service_item_id where f.booking_version_id = $1 order by i.item_no`, [b]))
        .toEqual([{ n: 1, t: 'hotel', b: '0' }, { n: 2, t: 'transfer', b: '200000' }]);
      const checklist = await h.one<{ items: Array<{ code: string; itemNos?: number[] }> }>(OWNER, 'select public.intake_checklist($1) as r', [DEAL]);
      expect(checklist.items.find((i) => i.code === 'budget_missing')?.itemNos).toEqual([1]);
    });
  });

  it('the upgrade tier converts with its own typed total, its own lines and no plan when it has none', async () => {
    await asOwner(db, async () => {
      const d = await draft({ upgrade: true });
      const lines = [...baseLines(d), { lineNo: 3, optionKey: 'upgrade', itemId: d.upgradeHotel, categoryKey: 'hotels',
        description: 'Luxury room', unitKind: 'room_night', units: 2, periods: 3, unitSellPaise: '900000', unitCostPaise: '700000' }];
      let rv = (await one<RV>(OWNER, LINES_SQL, [d.versionId, d.rowVersion, JSON.stringify(lines)])).rowVersion;
      rv = (await one<RV>(OWNER, TOTAL_SQL, [d.versionId, rv, 'quoted', '3900000', true])).rowVersion;
      rv = (await one<RV>(OWNER, TOTAL_SQL, [d.versionId, rv, 'upgrade', '7200000', true])).rowVersion;
      rv = (await one<RV>(OWNER, PLAN_SQL, [d.versionId, rv, 'quoted', JSON.stringify([{ seq: 1, label: 'Full', amountPaise: '3900000', dueRule: 'on_acceptance' }])])).rowVersion;
      const hash = await readyAndSent(d.versionId, rv);
      await accepted(d.versionId, hash, 'upgrade');
      const b = (await convert(d.versionId, hash)).bookingVersionId;
      expect(await owner('select selling_total_paise::text as t from public.booking_version_commercials where version_id = $1', [b]))
        .toEqual([{ t: '7200000' }]);
      expect(await owner('select 1 from public.booking_version_instalments where booking_version_id = $1', [b])).toHaveLength(0);
      // Budgets: hotel shared line (common) + upgrade hotel line; the quoted-only hotel item is not converted.
      expect(await owner(`select i.service_type as t, f.purchase_budget_paise::text as b from public.service_item_facts f
                          join public.service_items i on i.id = f.service_item_id where f.booking_version_id = $1 order by i.item_no`, [b]))
        .toEqual([{ t: 'hotel', b: '2700300' }, { t: 'transfer', b: '0' }, { t: 'hotel', b: '4200000' }]);
      expect((await h.one<{ issues: string[] }>(OWNER, 'select public.booking_readiness($1) as r', [b])).issues).toContain('plan_missing');
    });
  });

  it('quotation work changes no Accounts queue, money read, cash overview, count, journal or receipt', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const snapshot = async () => {
        const entity = await h.entityId();
        const queue: Record<string, unknown> = {};
        for (const filter of ['all', 'needs_review', 'returned', 'awaiting_verification', 'cheques_pending']) {
          queue[filter] = await h.one(ACCOUNTS, 'select public.accounts_queue($1) as r', [filter]);
        }
        return {
          money: (await owner<{ r: unknown }>('select authz.finance_money_json($1) as r', [DEAL]))[0]!.r,
          cash: await h.one(ACCOUNTS, 'select public.accounts_cash_overview($1) as r', [entity]),
          queue,
          countsAccounts: await h.one<Record<string, unknown>>(ACCOUNTS, 'select public.my_work_counts() as r'),
          journal: await owner(`select (select count(*) from public.finance_journal_entries)::int as e,
                                       (select count(*) from public.finance_journal_lines)::int as l`),
          receipts: await owner('select id, status, row_version from public.customer_receipts order by id'),
          claims: await owner('select count(*)::int as n from public.customer_payment_claims'),
        };
      };
      const before = await snapshot();
      const d = await priced({ plan: [{ seq: 1, label: 'Full', amountPaise: '3900000', dueRule: 'on_acceptance' }] });
      const hash = await readyAndSent(d.versionId, d.rowVersion);
      await one(OWNER, COSTS_SQL, [d.versionId, JSON.stringify([{ lineNo: 2, unitCostPaise: '180000' }])]);
      await accepted(d.versionId, hash);
      await convert(d.versionId, hash);
      expect(await snapshot()).toEqual(before);
    });
  });
});
