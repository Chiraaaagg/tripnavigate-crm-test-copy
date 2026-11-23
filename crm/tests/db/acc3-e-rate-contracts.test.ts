import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, type TestDb, asOwner, createTestDb, resetActor } from '../helpers/db';
import { FLIGHT, OTHER_ENTITY, VISA } from './acc-support';
import { MANAGER_F } from './acc3-support';
import {
  ACC, HOTEL_ITEM, MANAGER, OWNER, PURCHASE, REASON, SQLB, STAY, type Price, U, relbHelpers, rid, sha, text,
} from './acc3-relb-support';
import { CONFLICT_STATE } from '../helpers/sqlstates';

/**
 * Accounts phase 3, Track T — Release B, Track E: rate contracts (contract
 * section 9, refusals section 13, fences section 14, tests 16.1 E). Written
 * from the contract, not from Track E's code.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = relbHelpers(() => db);
const { one, owner } = h;

/** Switch On, a catalogue hotel, a hotel supplier linked to it, one room type. */
async function base() {
  await h.people();
  await h.rateContractsOn();
  const hotel = await h.catalogueHotel();
  const supplier = await h.hotelSupplier(hotel);
  const room = await h.roomType(hotel);
  return { hotel, supplier, room };
}

describe('9.1 switch and refusals', () => {
  it('rate contracts Off by default: rate_contracts_off (55000); the switch is Super Admin only and audited', async () => {
    await asOwner(db, async () => {
      await h.people();
      const hotel = await h.catalogueHotel();
      const supplier = await h.hotelSupplier(hotel);
      await h.refusedToken(PURCHASE, SQLB.contractSave, [null, 0, JSON.stringify({ supplierId: supplier, hotelId: hotel, validFrom: '2026-11-01',
        validTo: '2027-03-31', cancellationTerms: null, note: null }), rid()], 'rate_contracts_off');
      await h.refused(PURCHASE, SQLB.setRateContracts, [true, REASON], 'not_authorized', '42501');
      await h.refused(MANAGER, SQLB.setRateContracts, [true, REASON], 'not_authorized', '42501');
      await h.rateContractsOn();
      const [audit] = (await h.audits('settings.procurement_changed')).slice(-1);
      expect(audit, 'settings.procurement_changed (17.3)').toBeDefined();
      expect(audit!.reason).toBe(REASON);
    });
  });

  it('link_not_allowed: the supplier must sell hotels and have an active link to the hotel', async () => {
    await asOwner(db, async () => {
      const { hotel } = await base();
      const unlinked = await h.purchaseSupplier();
      await h.refusedToken(PURCHASE, SQLB.contractSave, [null, 0, JSON.stringify({ supplierId: unlinked, hotelId: hotel, validFrom: '2026-11-01',
        validTo: '2027-03-31', cancellationTerms: null, note: null }), rid()], 'link_not_allowed', undefined, '55000');
    });
  });

  it('validity: valid_from <= valid_to and a span of at most 1100 days (invalid_input)', async () => {
    await asOwner(db, async () => {
      const { hotel, supplier } = await base();
      for (const [from, to] of [['2027-01-10', '2027-01-09'], ['2026-11-01', '2029-11-10']]) {
        await h.refusedHint(PURCHASE, SQLB.contractSave, [null, 0, JSON.stringify({ supplierId: supplier, hotelId: hotel, validFrom: from, validTo: to,
          cancellationTerms: null, note: null }), rid()], 'invalid_input', undefined, '22023');
      }
    });
  });
});

describe('9.1 room types', () => {
  it('saved by Purchase; unique active name per hotel; a type used by an active contract cannot be removed (in_use)', async () => {
    await asOwner(db, async () => {
      const { hotel, supplier, room } = await base();
      expect((await h.audits('purchase.room_type_saved')).length).toBeGreaterThanOrEqual(1);
      // ASSUMPTION: a second active type with the same name (any case) is refused already_recorded or answers the existing type.
      const again = await h.attempt<Record<string, unknown>>(PURCHASE, SQLB.roomTypeSave, [hotel, null, 0, 'SYNTHETIC deluxe', rid()]);
      if (again.ok) expect(text(again.value)).toContain(room);
      else expect(again.error).toMatch(/^(already_recorded|invalid_input)$/);
      await h.refused(OWNER, SQLB.roomTypeSave, [hotel, null, 0, 'Synthetic Suite', rid()], 'not_authorized', '42501');
      await h.activeContract(supplier, hotel, [h.line(room)]);
      await h.refusedToken(PURCHASE, SQLB.roomTypeRemove, [room, REASON, rid()], 'in_use');
      const spare = await h.roomType(hotel, 'Synthetic Spare Room');
      await one(PURCHASE, SQLB.roomTypeRemove, [spare, REASON, rid()]);
      expect((await h.audits('purchase.room_type_removed')).length).toBe(1);
    });
  });
});

describe('9.1 lines', () => {
  it('lines of one contract for the same room type and meal plan must not overlap (lines_overlap 22023); other meal plan may', async () => {
    await asOwner(db, async () => {
      const { hotel, supplier, room } = await base();
      const c = await h.draftContract(supplier, hotel);
      await h.refusedToken(PURCHASE, SQLB.linesSet, [c.contractId, (await h.contractRow(c.contractId)).row_version, JSON.stringify([
        h.line(room, { seasonFrom: '2026-11-01', seasonTo: '2026-12-31' }), h.line(room, { seasonFrom: '2026-12-31', seasonTo: '2027-03-31' })]),
      '[]', rid()], 'lines_overlap');
      const ok = await h.setLines(c.contractId, [h.line(room, { seasonFrom: '2026-11-01', seasonTo: '2026-12-31' }),
        h.line(room, { seasonFrom: '2027-01-01', seasonTo: '2027-03-31' }), h.line(room, { mealPlan: 'MAP', ratePaise: '650000' })]);
      expect(ok).toBeTruthy();
      const [count] = await owner<{ n: number }>('select count(*)::int as n from public.rate_contract_lines where contract_id = $1', [c.contractId]);
      expect(count!.n).toBe(3);
      const [audit] = (await h.audits('purchase.rate_contract.lines_set')).slice(-1);
      expect(text(audit!.details)).not.toContain('500000');
    });
  });

  it('a season outside the validity, an unknown meal plan or a zero rate is invalid_input with the line field as hint', async () => {
    await asOwner(db, async () => {
      const { hotel, supplier, room } = await base();
      const c = await h.draftContract(supplier, hotel);
      const rv = (await h.contractRow(c.contractId)).row_version;
      await h.refusedHint(PURCHASE, SQLB.linesSet, [c.contractId, rv, JSON.stringify([h.line(room, { seasonTo: '2027-06-30' })]), '[]', rid()],
        'invalid_input', /^lines\[0\]\.seasonTo$/, '22023');
      await h.refusedHint(PURCHASE, SQLB.linesSet, [c.contractId, rv, JSON.stringify([h.line(room, { mealPlan: 'XX' })]), '[]', rid()],
        'invalid_input', /^lines\[0\]\.mealPlan/, '22023');
      await h.refusedHint(PURCHASE, SQLB.linesSet, [c.contractId, rv, JSON.stringify([h.line(room), h.line(room, { mealPlan: 'AP', ratePaise: '0' })]),
        '[]', rid()], 'invalid_input', /^lines\[1\]\.ratePaise$/, '22023');
    });
  });

  it('submit needs at least one line (not_ready); active contracts are never edited (wrong_state)', async () => {
    await asOwner(db, async () => {
      const { hotel, supplier, room } = await base();
      const c = await h.draftContract(supplier, hotel);
      await h.refusedHint(PURCHASE, SQLB.contractSubmit, [c.contractId, (await h.contractRow(c.contractId)).row_version, rid()], 'not_ready', undefined, '55000');
      await h.setLines(c.contractId, [h.line(room)]);
      await h.submit(c.contractId);
      expect((await h.contractRow(c.contractId)).status).toBe('pending_approval');
      await h.decideContract(c.contractId, 'approve');
      const row = await h.contractRow(c.contractId);
      expect(row.status).toBe('active');
      expect(row.contract_no).toMatch(/^RC-[0-9]{4}-[0-9]{6}$/);
      const r = await h.attempt(PURCHASE, SQLB.linesSet, [c.contractId, row.row_version, JSON.stringify([h.line(room, { ratePaise: '1' })]), '[]', rid()]);
      expect(r.ok).toBe(false);
    });
  });
});

describe('9.3 approval', () => {
  it('approval by a Manager who is not the enterer; return needs a reason; returned can be edited and resubmitted', async () => {
    await asOwner(db, async () => {
      const { hotel, supplier, room } = await base();
      const c = await h.draftContract(supplier, hotel);
      await h.setLines(c.contractId, [h.line(room)]);
      await h.submit(c.contractId);
      // Purchase is not an Approver; another Purchase/Sales person neither.
      await h.refused(PURCHASE, SQLB.contractDecide, [c.contractId, 'approve', null, (await h.contractRow(c.contractId)).row_version, rid()],
        'not_authorized', '42501');
      await h.refusedHint(MANAGER, SQLB.contractDecide, [c.contractId, 'return', null, (await h.contractRow(c.contractId)).row_version, rid()],
        'invalid_input', /reason/, '22023');
      await h.decideContract(c.contractId, 'return', MANAGER, REASON);
      expect((await h.contractRow(c.contractId)).status).toBe('returned');
      await h.setLines(c.contractId, [h.line(room, { ratePaise: '510000' })]);
      await h.submit(c.contractId);
      await h.decideContract(c.contractId, 'approve');
      expect((await h.contractRow(c.contractId)).status).toBe('active');
      expect((await h.audits('purchase.rate_contract.returned')).length).toBe(1);
      expect((await h.audits('purchase.rate_contract.approved')).length).toBe(1);
      await h.refusedToken(MANAGER, SQLB.contractDecide, [c.contractId, 'approve', null, (await h.contractRow(c.contractId)).row_version, rid()],
        'wrong_state', undefined, '55000');
    });
  });

  it('not_self_approval: a Manager who entered the contract cannot approve it (42501)', async () => {
    await asOwner(db, async () => {
      const { hotel, supplier, room } = await base();
      // The Manager also holds supplier management for this scenario (owner SQL role grant).
      await h.addRole(U.managerDelhi, 'purchase');
      const c = await h.draftContract(supplier, hotel, '2026-11-01', '2027-03-31', MANAGER);
      await h.setLines(c.contractId, [h.line(room)], [], MANAGER);
      await h.submit(c.contractId, MANAGER);
      await h.refusedToken(MANAGER, SQLB.contractDecide, [c.contractId, 'approve', null, (await h.contractRow(c.contractId)).row_version, rid()],
        'not_self_approval', undefined, '42501');
    });
  });

  it('approving a new contract ends the overlapped older one of the same supplier and hotel ("Replaced by RC-...")', async () => {
    await asOwner(db, async () => {
      const { hotel, supplier, room } = await base();
      const older = await h.activeContract(supplier, hotel, [h.line(room)]);
      const newer = await h.activeContract(supplier, hotel, [h.line(room, { seasonFrom: '2027-01-01', seasonTo: '2027-06-30', ratePaise: '600000' })],
        { validFrom: '2027-01-01', validTo: '2027-06-30' });
      const old = await h.contractRow(older);
      expect(old.status).toBe('ended');
      expect(old.end_reason).toBe(`Replaced by ${(await h.contractRow(newer)).contract_no}`);
      const [n] = await owner<{ n: number }>(`select count(*)::int as n from public.rate_contracts where supplier_id = $1 and hotel_id = $2 and status = 'active'`,
        [supplier, hotel]);
      expect(n!.n).toBe(1);
    });
  });

  it('E8: a Manager ends an active contract with a reason; Purchase cannot', async () => {
    await asOwner(db, async () => {
      const { hotel, supplier, room } = await base();
      const c = await h.activeContract(supplier, hotel, [h.line(room)]);
      await h.refused(PURCHASE, SQLB.contractEnd, [c, (await h.contractRow(c)).row_version, REASON, rid()], 'not_authorized', '42501');
      await one(MANAGER, SQLB.contractEnd, [c, (await h.contractRow(c)).row_version, REASON, rid()]);
      expect((await h.contractRow(c)).status).toBe('ended');
      expect((await h.audits('purchase.rate_contract.ended')).length).toBe(1);
    });
  });
});

describe('9.2 price lookup', () => {
  it('night by night with the weekend rate on Friday and Saturday nights, times rooms', async () => {
    await asOwner(db, async () => {
      const { hotel, supplier, room } = await base();
      await h.activeContract(supplier, hotel, [h.line(room, { ratePaise: '500000', weekendRatePaise: '700000' })]);
      const p = await h.price(supplier, hotel, room, 'CP');
      expect(p.state).toBe('ok');
      expect(p.nights.map((n) => [n.date, n.ratePaise, n.weekend])).toEqual([
        ['2026-12-10', '500000', false], ['2026-12-11', '700000', true], ['2026-12-12', '700000', true]]);
      expect(p.perRoomTotalPaise).toBe('1900000');
      expect(p.totalPaise).toBe('3800000');
      expect(p.endedOn).toBeNull();
    });
  });

  it('a stay crossing two seasons uses each night\'s own line', async () => {
    await asOwner(db, async () => {
      const { hotel, supplier, room } = await base();
      await h.activeContract(supplier, hotel, [h.line(room, { seasonFrom: '2026-11-01', seasonTo: '2026-12-10', ratePaise: '400000' }),
        h.line(room, { seasonFrom: '2026-12-11', seasonTo: '2027-03-31', ratePaise: '900000' })]);
      const p = await h.price(supplier, hotel, room, 'CP');
      expect(p.nights.map((n) => n.ratePaise)).toEqual(['400000', '900000', '900000']);
      expect(p.totalPaise).toBe(String((400000 + 900000 + 900000) * STAY.rooms));
      expect(new Set(p.nights.map((n) => n.lineId)).size).toBe(2);
    });
  });

  it('a stay crossing two contracts uses each night\'s contract (contractIds lists both)', async () => {
    await asOwner(db, async () => {
      const { hotel, supplier, room } = await base();
      const a = await h.activeContract(supplier, hotel, [h.line(room, { seasonFrom: '2026-11-01', seasonTo: '2026-12-11', ratePaise: '400000' })],
        { validFrom: '2026-11-01', validTo: '2026-12-11' });
      const b = await h.activeContract(supplier, hotel, [h.line(room, { seasonFrom: '2026-12-12', seasonTo: '2027-03-31', ratePaise: '800000' })],
        { validFrom: '2026-12-12', validTo: '2027-03-31' });
      const p = await h.price(supplier, hotel, room, 'CP');
      expect(p.state).toBe('ok');
      expect([...p.contractIds].sort()).toEqual([a, b].sort());
      expect(p.nights.map((n) => n.ratePaise)).toEqual(['400000', '400000', '800000']);
    });
  });

  it('blackout -> blackout; a night not covered -> partial; nothing -> no_contract; only an ended contract -> ended with endedOn', async () => {
    await asOwner(db, async () => {
      const { hotel, supplier, room } = await base();
      const c = await h.activeContract(supplier, hotel, [h.line(room)], { blackouts: [{ fromDate: '2026-12-11', toDate: '2026-12-11' }] });
      expect((await h.price(supplier, hotel, room, 'CP')).state).toBe('blackout');
      expect((await h.price(supplier, hotel, room, 'MAP')).state).toBe('no_contract');
      await one(MANAGER, SQLB.contractEnd, [c, (await h.contractRow(c)).row_version, REASON, rid()]);
      const hotel2 = await h.catalogueHotel();
      const supplier2 = await h.hotelSupplier(hotel2);
      const room2 = await h.roomType(hotel2);
      await h.activeContract(supplier2, hotel2, [h.line(room2, { seasonFrom: '2026-11-01', seasonTo: '2026-12-11' })],
        { validFrom: '2026-11-01', validTo: '2026-12-11' });
      expect((await h.price(supplier2, hotel2, room2, 'CP')).state).toBe('partial');
      // ASSUMPTION: "ended" = no contract covers the stay but one ended before it; an ended contract ends on its valid_to.
      const hotel3 = await h.catalogueHotel();
      const supplier3 = await h.hotelSupplier(hotel3);
      const room3 = await h.roomType(hotel3);
      await h.activeContract(supplier3, hotel3, [h.line(room3, { seasonFrom: '2026-11-01', seasonTo: '2026-11-30' })],
        { validFrom: '2026-11-01', validTo: '2026-11-30' });
      const ended = await h.price(supplier3, hotel3, room3, 'CP');
      expect(ended.state).toBe('ended');
      expect(ended.endedOn).toBe('2026-11-30');
    });
  });
});

describe('9.3 E9 quote with the contract rate', () => {
  async function hotelTaskWithContract() {
    const b = await h.book([HOTEL_ITEM]);
    await h.approve(b.versionId);
    const task = h.taskOf(b, 'hotel');
    await h.rateContractsOn();
    const hotel = await h.catalogueHotel();
    const supplier = await h.hotelSupplier(hotel);
    const room = await h.roomType(hotel);
    await h.activeContract(supplier, hotel, [h.line(room, { ratePaise: '500000', weekendRatePaise: '700000' })]);
    await one(PURCHASE, 'select public.purchase_task_claim($1) as r', [task]);
    return { task, hotel, supplier, room };
  }
  const quote = (task: string, supplier: string, hotel: string, room: string, cost: string, extra: Record<string, unknown> = {}) =>
    one<{ quoteId: string }>(PURCHASE, SQLB.quoteAdd, [task, rid(), JSON.stringify({ supplierId: supplier, hotelName: 'Synthetic Catalogue Hotel',
      roomType: null, mealPlan: null, quotedCostPaise: cost, holdUntil: null, cancellationTerms: null, catalogueHotelId: hotel, roomTypeId: room,
      mealPlanCode: 'CP', ...extra })]);
  const quoteRow = async (id: string) => (await owner<{ contract_state: string; contract_total_paise: string | null; rate_contract_id: string | null;
    contract_deviation_reason: string | null; room_type: string | null; meal_plan: string | null }>(
    `select contract_state, contract_total_paise::text, rate_contract_id, contract_deviation_reason, room_type, meal_plan
     from public.purchase_quotes where id = $1`, [id]))[0]!;

  it('matches when the quoted cost equals the contract total; differs needs a reason (invalid_input hint contractDeviationReason)', async () => {
    await asOwner(db, async () => {
      await h.people();
      const { task, hotel, supplier, room } = await hotelTaskWithContract();
      const m = await quote(task, supplier, hotel, room, '3800000');
      const row = await quoteRow(m.quoteId);
      expect(row).toMatchObject({ contract_state: 'matches', contract_total_paise: '3800000' });
      expect(row.rate_contract_id).not.toBeNull();
      // Free-text room type / meal plan default to the pick-list words (LD21 labels).
      expect(row.meal_plan).toBe('Breakfast');
      await h.refusedHint(PURCHASE, SQLB.quoteAdd, [task, rid(), JSON.stringify({ supplierId: supplier, hotelName: 'Synthetic Catalogue Hotel',
        roomType: null, mealPlan: null, quotedCostPaise: '4000000', holdUntil: null, cancellationTerms: null, catalogueHotelId: hotel, roomTypeId: room,
        mealPlanCode: 'CP' })], 'invalid_input', /^contractDeviationReason$/, '22023');
      const d = await quote(task, supplier, hotel, room, '4000000', { contractDeviationReason: 'Synthetic: supplier added a late check-out' });
      expect(await quoteRow(d.quoteId)).toMatchObject({ contract_state: 'differs', contract_total_paise: '3800000',
        contract_deviation_reason: 'Synthetic: supplier added a late check-out' });
    });
  });

  it('with the switch Off the quote is always none and behaves as today', async () => {
    await asOwner(db, async () => {
      await h.people();
      const { task, hotel, supplier, room } = await hotelTaskWithContract();
      await h.rateContractsOn(false);
      const q = await quote(task, supplier, hotel, room, '4000000');
      expect(await quoteRow(q.quoteId)).toMatchObject({ contract_state: 'none', contract_total_paise: null, rate_contract_id: null });
    });
  });

  it('the Manager sees contractState / contractTotalPaise / contractDeviationReason on the over-budget row', async () => {
    await asOwner(db, async () => {
      await h.people();
      const { task, hotel, supplier, room } = await hotelTaskWithContract();
      // Budget of HOTEL_ITEM is 2,00,000.00: a differing quote of 2,50,000.00 is over budget.
      const q = await quote(task, supplier, hotel, room, '25000000', { contractDeviationReason: 'Synthetic: peak season surcharge' });
      await one(PURCHASE, 'select public.purchase_cost_propose($1, $2, $3, $4::bigint, $5::date, $6, $7) as r', [task, q.quoteId, 0, '25000000', null, null,
        rid()]);
      const approvals = await one<unknown>(MANAGER, SQLB.managerApprovals, []);
      const t = text(approvals);
      expect(t).toContain('"contractState":"differs"');
      expect(t).toContain('"contractTotalPaise":"3800000"');
      expect(t).toContain('Synthetic: peak season surcharge');
    });
  });
});

describe('9.5 reads and fences (section 14: P, M, A read; SO, F, V, other entity null)', () => {
  it('list, get and lookup', async () => {
    await asOwner(db, async () => {
      const { hotel, supplier, room } = await base();
      const c = await h.activeContract(supplier, hotel, [h.line(room)]);
      await h.addAcc2();
      const list = await one<{ items: Array<Record<string, unknown>> }>(PURCHASE, SQLB.contractsList, ['{}', null, 50]);
      // ASSUMPTION: the list answers `{items, nextAfter}` like the Phase 1 / 2 keyset lists.
      expect(list.items.find((r) => r.contractId === c)).toMatchObject({ status: 'active', lineCount: 1, versionNo: 1 });
      const got = await one<Record<string, unknown>>(MANAGER, SQLB.contractGet, [c]);
      expect(got).toMatchObject({ contractId: c, status: 'active' });
      expect(Array.isArray(got.lines)).toBe(true);
      expect(got.can).toMatchObject({ end: true });
      for (const actor of [PURCHASE, MANAGER, ACC] as Actor[]) {
        expect(await h.readOrNull(actor, SQLB.contractGet, [c]), `reader ${actor.userId}`).not.toBeNull();
      }
      await h.addFlightPeople();
      // Addendum L2: a Manager or Accounts person who also holds Flight or Visa does not read rate contracts
      // (MANAGER_F = Manager Delhi + Flight; VISA = Visa Jodhpur, made Accounts by addAcc2 above).
      for (const actor of [OWNER, FLIGHT, VISA, MANAGER_F, OTHER_ENTITY] as Actor[]) {
        expect(await h.readOrNull(actor, SQLB.contractGet, [c]), `fenced ${actor.userId}`).toBeNull();
        expect(await h.readOrNull(actor, SQLB.contractsList, ['{}', null, 50]), `fenced list ${actor.userId}`).toBeNull();
      }
    });
  });

  it('rate_contract_lookup is the task\'s Purchase reader only: 9.2 result plus the hotel\'s room types', async () => {
    await asOwner(db, async () => {
      await h.people();
      const b = await h.book([HOTEL_ITEM]);
      await h.approve(b.versionId);
      const task = h.taskOf(b, 'hotel');
      await h.rateContractsOn();
      const hotel = await h.catalogueHotel();
      const supplier = await h.hotelSupplier(hotel);
      const room = await h.roomType(hotel);
      await h.activeContract(supplier, hotel, [h.line(room, { ratePaise: '500000', weekendRatePaise: '700000' })]);
      await one(PURCHASE, 'select public.purchase_task_claim($1) as r', [task]);
      const r = await one<Price & { roomTypes: Array<Record<string, unknown>> }>(PURCHASE, SQLB.lookup, [task, supplier, hotel, room, 'CP']);
      expect(r).toMatchObject({ state: 'ok', totalPaise: '3800000' });
      expect(text(r.roomTypes)).toContain(room);
      await h.addFlightPeople();
      for (const actor of [OWNER, FLIGHT, VISA, OTHER_ENTITY] as Actor[]) {
        expect(await h.readOrNull(actor, SQLB.lookup, [task, supplier, hotel, room, 'CP']), `fenced ${actor.userId}`).toBeNull();
      }
      // Never leaks into the Sales owner's Deal reads.
      const deal = await one<unknown>(OWNER, 'select public.booking_form_get($1) as r', [b.deal]);
      expect(text(deal)).not.toContain('"contractTotalPaise"');
    });
  });
});

describe('9.1 expiry alerts', () => {
  it('timer task rate_contract_expiry writes one alert at 30 and at 7 days left, none when a later active contract exists', async () => {
    await asOwner(db, async () => {
      const { hotel, supplier, room } = await base();
      const [d30] = await owner<{ d: string }>(`select ((now() at time zone 'Asia/Kolkata')::date + 30)::text as d`);
      const c = await h.activeContract(supplier, hotel, [h.line(room, { seasonFrom: '2026-11-01', seasonTo: d30!.d })],
        { validFrom: '2026-11-01', validTo: d30!.d });
      // A second hotel whose contract ends in 7 days, and a third whose contract ends in 30 days but has a later active contract.
      const [d7, d31, d90] = (await owner<{ d: string }>(`select ((now() at time zone 'Asia/Kolkata')::date + x)::text as d from unnest(array[7, 31, 90]) x`))
        .map((r) => r.d);
      const hotel7 = await h.catalogueHotel();
      const supplier7 = await h.hotelSupplier(hotel7);
      const room7 = await h.roomType(hotel7);
      const c7 = await h.activeContract(supplier7, hotel7, [h.line(room7, { seasonFrom: '2026-11-01', seasonTo: d7! })], { validFrom: '2026-11-01', validTo: d7! });
      const hotelL = await h.catalogueHotel();
      const supplierL = await h.hotelSupplier(hotelL);
      const roomL = await h.roomType(hotelL);
      await h.activeContract(supplierL, hotelL, [h.line(roomL, { seasonFrom: '2026-11-01', seasonTo: d30!.d })], { validFrom: '2026-11-01', validTo: d30!.d });
      await h.activeContract(supplierL, hotelL, [h.line(roomL, { seasonFrom: d31!, seasonTo: d90! })], { validFrom: d31!, validTo: d90! });
      // Addendum L2: the no-argument task wraps authz.rate_contract_expiry_at(p_now) which holds the 09:00 India-time rule.
      const [task] = await owner<{ function_name: string }>(`select function_name from public.timer_tasks where name = 'rate_contract_expiry'`);
      expect(task, 'timer task registered by track E').toBeDefined();
      for (const role of ['authenticated', 'anon', 'service_role']) {
        for (const sig of await h.signatures('authz', 'rate_contract_expiry_at')) expect(await h.canExecute(role, sig), `${role} ${sig}`).toBe(false);
      }
      await resetActor(db);
      const at = (time: string) => owner(`select authz.rate_contract_expiry_at(((now() at time zone 'Asia/Kolkata')::date::text || ' ' || $1)::timestamp at time zone 'Asia/Kolkata')`, [time]);
      const alerts = () => owner<{ contract_id: string; days_left: number }>('select contract_id, days_left from public.rate_contract_alerts');
      await at('08:59');
      expect(await alerts(), 'nothing before 09:00 India time').toEqual([]);
      await at('09:00');
      await at('09:30');
      const got = (await alerts()).sort((a, b) => a.days_left - b.days_left);
      expect(got, 'one alert each at 7 and 30 days, never twice, none with a later active contract')
        .toEqual([{ contract_id: c7, days_left: 7 }, { contract_id: c, days_left: 30 }]);
    });
  });
});

describe('9.4 rate-sheet import', () => {
  type Row = Record<string, string | null>;
  const row = (hotelRef: string, supplierRef: string, over: Row = {}): Row => ({
    supplierRef, hotelRef, validFrom: '2026-11-01', validTo: '2027-03-31', seasonFrom: '2026-11-01', seasonTo: '2027-03-31', roomType: 'Synthetic Deluxe',
    mealPlan: 'CP', rate: '5000', weekendRate: '7000', extraAdult: null, childWithBed: null, childWithoutBed: null, blackoutDates: null,
    cancellationTerms: 'Synthetic terms', ...over,
  });
  async function refs() {
    await h.people();
    await h.rateContractsOn();
    const hotel = await h.catalogueHotel('Synthetic Sheet Hotel', 'SYN-H-RS1');
    const supplier = await h.hotelSupplier(hotel);
    await resetActor(db);
    await owner(`update public.suppliers set source_ref = 'SYN-S-RS1' where id = $1`, [supplier]);
    return { hotel, supplier };
  }
  async function stage(actor: Actor, rows: Row[]) {
    const r = await one<{ batchId: string }>(actor, SQLB.importStage, [await h.entityId(), 'rate_sheet', null, 'rates.csv', sha(), JSON.stringify(rows),
      rid(), true]);
    return r.batchId;
  }
  // ASSUMPTION: the rate-sheet dry run answers like Phase 2's import_batch_validate (rowVersion, proposalHash) plus the 9.4 summary keys.
  type Summary = Record<string, unknown> & { rowVersion: number; proposalHash: string };

  it('Purchase or Super Admin only; dry-run outcomes, reason codes and warnings; summary counts', async () => {
    await asOwner(db, async () => {
      await refs();
      await h.addAcc2();
      expect((await h.attempt(ACC, SQLB.importStage, [await h.entityId(), 'rate_sheet', null, 'rates.csv', sha(), JSON.stringify([row('SYN-H-RS1',
        'SYN-S-RS1')]), rid(), true])).ok).toBe(false);
      expect((await h.attempt(OWNER, SQLB.importStage, [await h.entityId(), 'rate_sheet', null, 'rates.csv', sha(), JSON.stringify([row('SYN-H-RS1',
        'SYN-S-RS1')]), rid(), true])).ok).toBe(false);
      const id = await stage(PURCHASE, [
        row('SYN-H-RS1', 'SYN-S-RS1'),
        row('SYN-H-RS1', 'SYN-S-RS1', { roomType: 'Synthetic Garden Room', mealPlan: 'Breakfast and dinner' }),
        row('SYN-H-404', 'SYN-S-RS1'),
        row('SYN-H-RS1', 'SYN-S-404'),
        row('SYN-H-RS1', 'SYN-S-RS1', { validFrom: '2027-04-01' }),
        row('SYN-H-RS1', 'SYN-S-RS1', { seasonTo: '2027-06-30' }),
        row('SYN-H-RS1', 'SYN-S-RS1', { mealPlan: 'Half board' }),
        row('SYN-H-RS1', 'SYN-S-RS1', { rate: '-1' }),
        row('SYN-H-RS1', 'SYN-S-RS1'),
      ]);
      const s = await one<Summary>(PURCHASE, SQLB.importValidate, [id]);
      const got = await one<{ rows: Array<{ rowNo: number; outcome: string; reasons: string[]; warningCodes?: string[] }> }>(PURCHASE, SQLB.importGet,
        [id, 100, 0]);
      const byNo = new Map(got.rows.map((r) => [r.rowNo, r]));
      expect(byNo.get(1)!.outcome).toBe('create');
      expect(byNo.get(2)!.outcome).toBe('create');
      expect(text(byNo.get(2))).toContain('new_room_type');
      expect(byNo.get(3)!.reasons).toContain('hotel_not_found');
      expect(byNo.get(4)!.reasons).toContain('supplier_not_found');
      expect(byNo.get(5)!.reasons).toContain('dates_invalid');
      expect(byNo.get(6)!.reasons).toContain('season_outside_validity');
      expect(byNo.get(7)!.reasons).toContain('meal_plan_invalid');
      expect(byNo.get(8)!.reasons).toContain('rate_invalid');
      expect(byNo.get(9)!.reasons.some((r) => r === 'duplicate_in_file' || r === 'line_overlap')).toBe(true);
      expect(text(s)).toMatch(/"contracts":1\b/);
      expect(text(s)).toMatch(/"lines":2\b/);
    });
  });

  it('supplier_does_not_sell_hotel; overlaps_active_contract warning', async () => {
    await asOwner(db, async () => {
      const { hotel, supplier } = await refs();
      const room = await h.roomType(hotel);
      await h.activeContract(supplier, hotel, [h.line(room)]);
      const transferOnly = await one<{ supplierId: string }>(PURCHASE, 'select public.supplier_create($1, $2::jsonb) as r', [await h.entityId(),
        JSON.stringify({ name: `Synthetic Cabs ${rid().slice(0, 6)}`, serviceTypes: ['transfer'], city: 'Synthetic City', contactName: null,
          contactPhone: null, contactEmail: 'cabs@example.test', paymentTerms: null })]);
      await resetActor(db);
      await owner(`update public.suppliers set source_ref = 'SYN-S-CAB' where id = $1`, [transferOnly.supplierId]);
      const id = await stage(PURCHASE, [row('SYN-H-RS1', 'SYN-S-RS1'), row('SYN-H-RS1', 'SYN-S-CAB')]);
      await one(PURCHASE, SQLB.importValidate, [id]);
      const got = await one<{ rows: Array<{ rowNo: number; outcome: string; reasons: string[] }> }>(PURCHASE, SQLB.importGet, [id, 100, 0]);
      expect(text(got.rows.find((r) => r.rowNo === 1))).toContain('overlaps_active_contract');
      expect(got.rows.find((r) => r.rowNo === 2)!.reasons).toContain('supplier_does_not_sell_hotel');
    });
  });

  it('apply creates draft contracts (source import) and new room types only, never touches an active contract; stale after a change', async () => {
    await asOwner(db, async () => {
      const { hotel, supplier } = await refs();
      const room = await h.roomType(hotel);
      const active = await h.activeContract(supplier, hotel, [h.line(room)]);
      const before = await h.contractRow(active);
      const id = await stage(PURCHASE, [row('SYN-H-RS1', 'SYN-S-RS1'), row('SYN-H-RS1', 'SYN-S-RS1', { roomType: 'Synthetic Lake Room', mealPlan: 'AP' })]);
      const s = await one<Summary>(PURCHASE, SQLB.importValidate, [id]);
      await one(PURCHASE, SQLB.importApply, [id, s.rowVersion, REASON, s.proposalHash, null]);
      const drafts = await owner<{ status: string; source: string; import_batch_id: string }>(
        `select status, source, import_batch_id from public.rate_contracts where supplier_id = $1 and hotel_id = $2 and id <> $3`, [supplier, hotel, active]);
      expect(drafts).toEqual([{ status: 'draft', source: 'import', import_batch_id: id }]);
      const [types] = await owner<{ n: number }>(`select count(*)::int as n from public.hotel_room_types where hotel_id = $1 and status = 'active'`, [hotel]);
      expect(types!.n).toBe(2);
      expect(await h.contractRow(active)).toEqual(before);
      // A change since the dry run: apply refused as stale (existing proposal-hash rule).
      const id2 = await stage(PURCHASE, [row('SYN-H-RS1', 'SYN-S-RS1', { roomType: 'Synthetic Hill Room' })]);
      const s2 = await one<Summary>(PURCHASE, SQLB.importValidate, [id2]);
      await h.roomType(hotel, 'Synthetic Hill Room');
      await h.refused(PURCHASE, SQLB.importApply, [id2, s2.rowVersion, REASON, s2.proposalHash, null], 'import_stale', CONFLICT_STATE);
    });
  });
});
