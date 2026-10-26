import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import {
  ACCOUNTS, DEAL, FLIGHT, FLIGHT_FACTS, FLIGHT_GET_SQL, FLIGHT_CLAIM_SQL, HOTEL, MANAGER, OWNER, PURCHASE, PURCHASE_CLAIM_SQL,
  PURCHASE_GET_SQL, SALES_B, SHA, SUPER, allKeys, rid,
} from './b1-support';
import { IDENTITY } from './b11-support';
import {
  ADULT_SALE, FILE_BEGIN_SQL, FILE_DOWNLOAD_SQL, FILE_FINISH_SQL, FILE_REMOVE_SQL, LINES_TOTAL, SERVICE_SQL, formHelpers,
} from './booking-form-support';

/**
 * Booking form privacy and access (migrations 20261124000100/0110/0120):
 * Purchase, Flight, the Visa desk and Accounts never receive per-person
 * prices, the selling total or Bill To through the new tables and reads;
 * estimates reach commercial readers and the item's task assignee only;
 * passenger extras follow the identity gate; flight screenshots follow their
 * own viewers. Mercury part B checks 1, 3, 10, 11, 12, 14 (database layer).
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
const { one, owner, refused, refusedWithHint } = h;

const SEARCH = /1234567|12,345\.67|12345\.67|234567|2,345\.67|4303701|salePaise|markupPaise|purchasePaise|sellingTotal|priceLines|"prices"|markup/;
const NEW_TABLES = ['booking_version_price_lines', 'service_item_cost_estimates', 'service_item_files'];

describe('new tables', () => {
  it('have no Data API read for anyone, the commercial reader included (check 1)', async () => {
    await asOwner(db, async () => {
      await h.readyForm();
      expect(await owner('select count(*)::int as n from public.booking_version_price_lines')).toEqual([{ n: 4 }]);
      for (const table of NEW_TABLES) {
        for (const actor of [OWNER, MANAGER, PURCHASE, FLIGHT, ACCOUNTS, SUPER]) {
          await refused(actor, `select * from public.${table}`, [], '42501');
        }
      }
    });
  });
});

describe('booking_form_get', () => {
  it('prices and estimates are absent (not null) without commercial scope; Purchase and Flight get nothing (check 3)', async () => {
    await asOwner(db, async () => {
      await h.readyForm();
      const full = (await h.form(OWNER))!;
      expect(full.prices).toMatchObject({ sellingTotalPaise: LINES_TOTAL, source: 'per_person' });
      expect((full.items as Array<Record<string, unknown>>)[0]!.estimate).toEqual({
        kind: 'hotel', roomRatePaise: '450000', extraBedRatePaise: null, noBedRatePaise: null });
      await h.addSalesAssignee(DEAL, SALES_B.userId!);
      await owner(`delete from public.role_permissions where role_code = 'sales' and permission_code = 'deal.read_commercial'`);
      const limited = (await h.form(SALES_B))!;
      expect('prices' in limited).toBe(false);
      expect('commercials' in limited).toBe(false);
      expect('plan' in limited).toBe(false);
      expect((limited.items as Array<Record<string, unknown>>).every((i) => !('estimate' in i))).toBe(true);
      expect(JSON.stringify(limited)).not.toMatch(SEARCH);
      for (const actor of [PURCHASE, FLIGHT, ACCOUNTS, SUPER]) {
        expect(await h.form(actor)).toBeNull();
      }
    });
  });

  it('passenger extras follow the identity gate; marriage before birth is refused; absent keys keep stored values', async () => {
    await asOwner(db, async () => {
      await h.readyForm();
      const IDENTITY_SQL = 'select public.traveller_identity_save($1, $2, $3, $4::jsonb) as r';
      const saved = await one<{ rowVersion: number }>(OWNER, IDENTITY_SQL,
        [DEAL, 1, 0, JSON.stringify({ ...IDENTITY, dateOfMarriage: '2015-02-14', phone: '+44 7700 900123', email: 'Traveller@Example.test' })]);
      await refusedWithHint(OWNER, IDENTITY_SQL, [DEAL, 1, saved.rowVersion, JSON.stringify({ ...IDENTITY, dateOfMarriage: '1980-01-01' })],
        /^dateOfMarriage$/);
      await refusedWithHint(OWNER, IDENTITY_SQL, [DEAL, 1, saved.rowVersion, JSON.stringify({ ...IDENTITY, phone: '12345' })], /^phone$/);
      // An older caller (no extras keys) keeps them.
      await one(OWNER, IDENTITY_SQL, [DEAL, 1, saved.rowVersion, JSON.stringify(IDENTITY)]);
      const traveller = ((await h.form(OWNER))!.travellers as Array<{ seq: number; identity: Record<string, unknown> }>)
        .find((t) => t.seq === 1)!;
      expect(traveller.identity).toMatchObject({ dateOfMarriage: '2015-02-14', phone: '+447700900123', email: 'traveller@example.test' });
      for (const actor of [PURCHASE, ACCOUNTS]) {
        await refused(actor, IDENTITY_SQL, [DEAL, 1, 2, JSON.stringify(IDENTITY)], '42501', 'not_authorized');
      }
      const audit = await owner<{ details: unknown }>(
        `select details from public.audit_events where action = 'booking.traveller_identity_saved' and target_id = $1`, [DEAL]);
      expect(JSON.stringify(audit)).toMatch(/dateOfMarriage/);
      expect(JSON.stringify(audit)).not.toMatch(/2015-02-14|7700|traveller@/i);
    });
  });
});

describe('department tasks after submission', () => {
  it('Purchase sees no price, total or Bill To key; the estimate only once it holds the task (checks 11, 12)', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm(OWNER, DEAL, { items: [['hotel', HOTEL], ['flight', FLIGHT_FACTS]] });
      expect(r.issues).toEqual([]);
      const confirmed = await h.confirm(OWNER, r.versionId, r.hash);
      const [hotelTask, flightTask] = confirmed.taskIds!;
      const before = await one<Record<string, unknown>>(PURCHASE, PURCHASE_GET_SQL, [hotelTask]);
      expect(JSON.stringify(before)).not.toMatch(SEARCH);
      expect('estimate' in before).toBe(false);
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [hotelTask]);
      const mine = await one<Record<string, unknown>>(PURCHASE, PURCHASE_GET_SQL, [hotelTask]);
      expect(mine.estimate).toEqual({ kind: 'hotel', roomRatePaise: '450000', extraBedRatePaise: null, noBedRatePaise: null });
      expect(JSON.stringify(mine)).not.toMatch(SEARCH);
      expect([...allKeys(mine)].filter((k) => /sale|markup|selling|billTo|gst|prices/i.test(k))).toEqual([]);
      // Flight assignee: estimate (none stored here) and the screenshot list.
      await h.addFlight();
      await one(FLIGHT, FLIGHT_CLAIM_SQL, [flightTask]);
      const flight = await one<Record<string, unknown>>(FLIGHT, FLIGHT_GET_SQL, [flightTask]);
      expect(flight).toMatchObject({ estimate: null, files: [] });
      expect(JSON.stringify(flight)).not.toMatch(SEARCH);
    });
  });

  it('department field lists never name prices or billing; price and estimate classes (check 10, S9)', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      await owner(`update public.booking_versions set changed_fields = $2 where id = $1`,
        [r.versionId, ['items.1.hotelName', 'items.1.estimate', 'prices.cost', 'prices.sale', 'billing.gstin', 'contacts.market']]);
      expect(await owner<{ f: string[] }>('select authz.revision_department_fields($1) as f', [r.versionId]))
        .toEqual([{ f: ['items.1.estimate', 'items.1.hotelName'] }]);
      const classes = await owner<{ f: string; c: string }>(
        `select f, authz.revision_field_class(f) as c from unnest($1::text[]) f order by f`,
        [['prices.sale', 'prices.cost', 'items.1.estimate', 'contacts.customerType', 'items.2.vendor', 'trip.paxTotal']]);
      expect(Object.fromEntries(classes.map((x) => [x.f, x.c]))).toEqual({
        'contacts.customerType': 'choice', 'items.1.estimate': 'internal', 'items.2.vendor': 'choice',
        'prices.cost': 'internal', 'prices.sale': 'material', 'trip.paxTotal': 'material' });
    });
  });

  it('audit rows of price, estimate and service saves carry ids and counts only (check 10)', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const audit = await owner<{ action: string; details: unknown }>(
        `select action, details from public.audit_events where action like 'booking.%' order by id`);
      expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['booking.prices_saved', 'booking.estimate_saved']));
      expect(JSON.stringify(audit)).not.toMatch(/1234567|234567|4303701|450000|"1000000"/);
      void r;
      void ADULT_SALE;
    });
  });
});

describe('supplier estimates through booking_service_save', () => {
  it('commercial readers only; unknown stays null; a change never moves the total, the prices or the budget (H2, H5)', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const itemId = r.itemIds[0]!;
      const snapshot = () => owner(`select (select selling_total_paise::text from public.booking_version_commercials where version_id = $1) as total,
          (select purchase_budget_paise::text from public.service_item_facts where booking_version_id = $1 and service_item_id = $2) as budget,
          (select jsonb_agg(l order by l.category) from public.booking_version_price_lines l where l.booking_version_id = $1) as lines`,
        [r.versionId, itemId]);
      const before = await snapshot();
      const saved = await h.saveService(OWNER, r.versionId, r.rowVersion, { itemId, facts: HOTEL,
        estimate: { roomRatePaise: '1000000', extraBedRatePaise: '200000', noBedRatePaise: null } });
      expect(await snapshot()).toEqual(before);
      expect(await owner('select room_rate_paise::text, no_bed_rate_paise from public.service_item_cost_estimates where service_item_id = $1',
        [itemId])).toEqual([{ room_rate_paise: '1000000', no_bed_rate_paise: null }]);
      await refusedWithHint(OWNER, SERVICE_SQL, [r.versionId, saved.rowVersion, itemId, null, JSON.stringify(HOTEL), null,
        JSON.stringify({ vehicleRatePaise: '1' }), null, rid()], /^estimate$/);
      await refusedWithHint(OWNER, SERVICE_SQL, [r.versionId, saved.rowVersion, itemId, null, JSON.stringify(HOTEL), null,
        JSON.stringify({ roomRatePaise: '-1' }), null, rid()], /^estimate\.roomRatePaise$/);
      // Without commercial scope: facts save fine, an estimate is refused.
      await h.addSalesAssignee(DEAL, SALES_B.userId!);
      await owner(`delete from public.role_permissions where role_code = 'sales' and permission_code = 'deal.read_commercial'`);
      const facts = await h.saveService(SALES_B, r.versionId, saved.rowVersion, { itemId, facts: { ...HOTEL, mealPlan: 'Half board' } });
      await refused(SALES_B, SERVICE_SQL, [r.versionId, facts.rowVersion, itemId, null, JSON.stringify(HOTEL), null,
        JSON.stringify({ roomRatePaise: null }), null, rid()], '42501', 'not_authorized');
    });
  });

  it('one transaction: an exact retry returns the same item; a refused participation leaves nothing behind', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const req = rid();
      const added = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'transfer', facts: { route: 'Synthetic airport to hotel',
        date: '2026-12-10', endDate: '2026-12-13', quantity: 2, includedKms: 300, vendor: 'Synthetic Cabs' },
        estimate: { vehicleRatePaise: '2500000' }, participants: [1, 2], requestId: req });
      const again = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'transfer', facts: { route: 'Synthetic airport to hotel',
        date: '2026-12-10', endDate: '2026-12-13', quantity: 2, includedKms: 300, vendor: 'Synthetic Cabs' },
        estimate: { vehicleRatePaise: '2500000' }, participants: [1, 2], requestId: req });
      expect(again).toEqual({ ...added, outcome: 'existing' });
      expect(await owner('select count(*)::int as n from public.service_items where deal_id = $1', [DEAL])).toEqual([{ n: 2 }]);
      // Participation naming an unknown traveller: the whole save is refused, no third item.
      await refusedWithHint(OWNER, SERVICE_SQL, [r.versionId, added.rowVersion, null, 'activity',
        JSON.stringify({ name: 'Synthetic safari', city: 'Synthetic City', date: '2026-12-11', participants: 2 }), null, null, [1, 99], rid()],
        /^travellers$/);
      expect(await owner('select count(*)::int as n from public.service_items where deal_id = $1', [DEAL])).toEqual([{ n: 2 }]);
    });
  });
});

describe('flight screenshots (service_item_files)', () => {
  it('editors upload to flights only; five live files per flight; viewers: Sales, Manager, the Flight assignee (check 14)', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm(OWNER, DEAL, { items: [['hotel', HOTEL], ['flight', FLIGHT_FACTS]] });
      const [hotelItem, flightItem] = r.itemIds;
      const file = { fileName: 'flight option.png', mime: 'image/png', sizeBytes: 2048, sha256: SHA };
      await refusedWithHint(OWNER, FILE_BEGIN_SQL, [hotelItem, r.versionId, 'flight_screenshot', JSON.stringify(file), rid()], /^kind$/);
      await refused(OWNER, FILE_BEGIN_SQL, [flightItem, r.versionId, 'flight_screenshot', JSON.stringify({ ...file, mime: 'text/plain' }), rid()],
        '22023', 'evidence_rejected');
      await refused(OWNER, FILE_BEGIN_SQL, [flightItem, r.versionId, 'flight_screenshot', JSON.stringify({ ...file, sizeBytes: 4194305 }), rid()],
        '22023', 'evidence_rejected');
      await refused(PURCHASE, FILE_BEGIN_SQL, [flightItem, r.versionId, 'flight_screenshot', JSON.stringify(file), rid()], '42501', 'not_authorized');
      const req = rid();
      const begun = await one<{ fileId: string; objectPath: string; outcome: string }>(OWNER, FILE_BEGIN_SQL,
        [flightItem, r.versionId, 'flight_screenshot', JSON.stringify(file), req]);
      expect(begun.objectPath).toMatch(new RegExp(`/${DEAL}/${flightItem}/${begun.fileId}$`));
      expect((await one<{ outcome: string }>(OWNER, FILE_BEGIN_SQL, [flightItem, r.versionId, 'flight_screenshot', JSON.stringify(file), req])).outcome)
        .toBe('existing');
      // No storage object yet: finishing marks it failed, never stored.
      const failed = await one<{ status: string }>(OWNER, FILE_FINISH_SQL, [begun.fileId, true]);
      expect(failed.status).toBe('failed');
      const second = await one<{ fileId: string; objectPath: string }>(OWNER, FILE_BEGIN_SQL,
        [flightItem, r.versionId, 'flight_screenshot', JSON.stringify(file), rid()]);
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('service-item-files', $1, jsonb_build_object('size', 2048::bigint))`,
        [second.objectPath]);
      expect((await one<{ status: string }>(OWNER, FILE_FINISH_SQL, [second.fileId, true])).status).toBe('stored');
      expect((await one<{ objectPath: string }>(OWNER, FILE_DOWNLOAD_SQL, [second.fileId])).objectPath).toBe(second.objectPath);
      for (const actor of [PURCHASE, ACCOUNTS, SUPER]) {
        await refused(actor, FILE_DOWNLOAD_SQL, [second.fileId], '42501', 'not_authorized');
      }
      // Cap: five live files per flight.
      for (let i = 0; i < 4; i += 1) {
        await one(OWNER, FILE_BEGIN_SQL, [flightItem, r.versionId, 'flight_screenshot', JSON.stringify({ ...file, fileName: `option ${i}.png` }), rid()]);
      }
      await refused(OWNER, FILE_BEGIN_SQL, [flightItem, r.versionId, 'flight_screenshot', JSON.stringify(file), rid()], '55000', 'item_file_limit');
      const form = (await h.form(OWNER))!;
      const flightView = (form.items as Array<Record<string, unknown>>).find((i) => i.itemId === flightItem)!;
      expect((flightView.files as unknown[]).length).toBe(5);
      expect((form.items as Array<Record<string, unknown>>).find((i) => i.itemId === hotelItem)!.files).toBeUndefined();
      expect(form.itemFilesCanEdit).toBe(true);
      // The Flight assignee may view after submission; removal is soft.
      const confirmed = await h.confirm(OWNER, r.versionId, (await h.readiness(OWNER, r.versionId)).contentHash);
      await h.addFlight();
      await one(FLIGHT, FLIGHT_CLAIM_SQL, [confirmed.taskIds![1]]);
      expect((await one<{ fileName: string }>(FLIGHT, FILE_DOWNLOAD_SQL, [second.fileId])).fileName).toBe('flight option.png');
      const removed = await one<{ status: string }>(OWNER, FILE_REMOVE_SQL, [second.fileId, 2]);
      expect(removed.status).toBe('removed');
      await refused(FLIGHT, FILE_DOWNLOAD_SQL, [second.fileId], 'P0002', 'not_found');
      const audit = await owner<{ details: unknown }>(`select details from public.audit_events where action like 'booking.item_file_%'`);
      expect(JSON.stringify(audit)).not.toMatch(/flight option/);
    });
  });
});

describe('review A fixes', () => {
  it('M1: Accounts reads the selling side of per-person prices only, never purchase or markup', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      await h.confirm(OWNER, r.versionId, r.hash);
      const detail = await one<{ booking: { prices: Record<string, unknown> } }>(ACCOUNTS, 'select public.accounts_deal_detail($1) as r', [DEAL]);
      expect(detail.booking.prices).toEqual({
        lines: [{ category: 'adult', quantity: 3, salePaise: ADULT_SALE }, { category: 'child_bed', quantity: 1, salePaise: '600000' }],
        source: 'per_person', sellingTotalPaise: LINES_TOTAL });
      expect([...allKeys(detail)].filter((k) => /purchasePaise|markupPaise/.test(k))).toEqual([]);
      expect(JSON.stringify(detail)).not.toMatch(/"1000000"|"234567"|"500000"|"100000"/);
    });
  });

  it('L1: version history hides price, plan and billing names from viewers without commercial scope', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      await owner(`update public.booking_versions set changed_fields = $2 where id = $1`,
        [r.versionId, ['items.1.hotelName', 'prices.sale', 'prices.cost', 'sellingTotal', 'plan', 'billing.gstin', 'trip.paxTotal']]);
      const names = async (actor: typeof OWNER) =>
        (await one<Array<{ changedFields: string[] }>>(actor, 'select public.booking_version_history($1) as r', [DEAL]))[0]!.changedFields;
      expect(await names(OWNER)).toEqual(['items.1.hotelName', 'prices.sale', 'prices.cost', 'sellingTotal', 'plan', 'billing.gstin', 'trip.paxTotal']);
      await h.addSalesAssignee(DEAL, SALES_B.userId!);
      await owner(`delete from public.role_permissions where role_code = 'sales' and permission_code = 'deal.read_commercial'`);
      expect(await names(SALES_B)).toEqual(['items.1.hotelName', 'trip.paxTotal']);
    });
  });
});
