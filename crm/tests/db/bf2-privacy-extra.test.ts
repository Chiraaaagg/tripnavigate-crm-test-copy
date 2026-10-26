import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import {
  DEAL, FLIGHT, FLIGHT_CLAIM_SQL, FLIGHT_FACTS, FLIGHT_GET_SQL, FLIGHT_LIST_SQL, OWNER, PURCHASE, PURCHASE_CLAIM_SQL, PURCHASE_GET_SQL,
  PURCHASE_LIST_SQL, SERVICES_SQL, TRANSFER, rid,
} from './b1-support';
import { formHelpers } from './booking-form-support';

/**
 * Book now v2, extra privacy checks (Agent D): Purchase never receives the
 * flight fare per person or the typed all-flights totals on any read path
 * (booking_form_get, the Purchase task list and detail, the Deal services
 * read, the Flight task reads), and a Flight user sees them only once the
 * task is theirs. Synthetic data only; one rolled-back owner transaction per
 * scenario.
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

const FARES_SQL = 'select public.booking_flight_fares_save($1, $2, $3::jsonb, $4) as r';
// Distinctive synthetic amounts, so a leak shows up in any serialised read.
const ADULT = '611111';
const CHILD = '422222';
const TOTAL_INFANT = '133333';
const FARE_TEXT = new RegExp(`${ADULT}|${CHILD}|${TOTAL_INFANT}|fareAdult|fareChild|fareInfant|fareTotals|flightFareTotals`);

/** A submitted draft with a priced flight, a car that meets it and the typed totals; Purchase owns the car task. */
async function submitted() {
  const r = await h.readyForm();
  const flight = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'flight', facts: FLIGHT_FACTS, participants: [1, 2, 3, 4],
    estimate: { fareAdultPaise: ADULT, fareChildPaise: CHILD } });
  const car = await h.saveService(OWNER, r.versionId, flight.rowVersion, { type: 'transfer',
    facts: { ...TRANSFER, carKind: 'airport_pickup', flightItemId: flight.itemId }, estimate: { vehicleRatePaise: '250000' } });
  await one(OWNER, FARES_SQL, [r.versionId, car.rowVersion, JSON.stringify({ infantPaise: TOTAL_INFANT }), rid()]);
  await h.confirm(OWNER, r.versionId, (await h.readiness(OWNER, r.versionId)).contentHash);
  const taskOf = async (itemId: string) =>
    (await owner<{ id: string }>('select id from public.fulfilment_tasks where service_item_id = $1', [itemId]))[0]!.id;
  return { r, flight, car, flightTask: await taskOf(flight.itemId), carTask: await taskOf(car.itemId), hotelTask: await taskOf(r.itemIds[0]!) };
}

describe('Purchase never receives fares', () => {
  it('booking_form_get, task list and detail, Deal services and the Flight reads', async () => {
    await asOwner(db, async () => {
      const s = await submitted();
      // The booking form is not a Purchase read at all.
      expect(await one(PURCHASE, 'select public.booking_form_get($1) as r', [DEAL])).toBeNull();
      // Purchase task list and the claimed car and hotel tasks: the cost estimate of their own item only.
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [s.carTask]);
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [s.hotelTask]);
      const list = await one<unknown[]>(PURCHASE, PURCHASE_LIST_SQL);
      expect(list.length).toBe(2);
      expect(JSON.stringify(list)).not.toMatch(FARE_TEXT);
      const car = await one<Record<string, unknown>>(PURCHASE, PURCHASE_GET_SQL, [s.carTask]);
      expect(car.estimate).toEqual({ kind: 'transfer', vehicleRatePaise: '250000' });
      // The car names the flight it meets by id only.
      expect((car.facts as { facts: Record<string, unknown> }).facts.flightItemId).toBe(s.flight.itemId);
      expect(JSON.stringify(car)).not.toMatch(FARE_TEXT);
      expect(JSON.stringify(await one(PURCHASE, PURCHASE_GET_SQL, [s.hotelTask]))).not.toMatch(FARE_TEXT);
      // A flight task is not a Purchase task.
      expect(await one(PURCHASE, PURCHASE_GET_SQL, [s.flightTask])).toBeNull();
      // Deal services as Purchase: no flight fare and no typed totals.
      expect(JSON.stringify(await one(PURCHASE, SERVICES_SQL, [DEAL]))).not.toMatch(FARE_TEXT);
      // The Flight reads give Purchase nothing.
      expect(await one(PURCHASE, FLIGHT_LIST_SQL)).toEqual([]);
      expect(await one(PURCHASE, FLIGHT_GET_SQL, [s.flightTask])).toBeNull();
    });
  });

  it('the fare tables have no Data API privilege for any signed-in role', async () => {
    await asOwner(db, async () => {
      expect(await owner(`select has_table_privilege('authenticated', 'public.booking_version_flight_fares', 'select') as fares,
          has_column_privilege('authenticated', 'public.service_item_cost_estimates', 'fare_adult_paise', 'select') as adult,
          has_table_privilege('anon', 'public.booking_version_flight_fares', 'select') as anon`))
        .toEqual([{ fares: false, adult: false, anon: false }]);
    });
  });
});

describe('Flight team: fares only for the task assignee', () => {
  it('an unclaimed task shows no fares; after claiming, the fare per person and the typed totals', async () => {
    await asOwner(db, async () => {
      const s = await submitted();
      await h.addFlight();
      const before = await one<Record<string, unknown>>(FLIGHT, FLIGHT_GET_SQL, [s.flightTask]);
      expect(before).not.toHaveProperty('estimate');
      expect(before).not.toHaveProperty('fareTotals');
      expect(JSON.stringify(before)).not.toMatch(FARE_TEXT);
      const flightList = await one<unknown[]>(FLIGHT, FLIGHT_LIST_SQL);
      expect(flightList.length).toBe(1);
      expect(JSON.stringify(flightList)).not.toMatch(FARE_TEXT);
      await one(FLIGHT, FLIGHT_CLAIM_SQL, [s.flightTask]);
      const after = await one<Record<string, unknown>>(FLIGHT, FLIGHT_GET_SQL, [s.flightTask]);
      expect(after.estimate).toEqual({ kind: 'flight', fareTotalPaise: null, fareAdultPaise: ADULT, fareChildPaise: CHILD, fareInfantPaise: null });
      expect(after.fareTotals).toEqual({ adultPaise: null, childPaise: null, infantPaise: TOTAL_INFANT });
      // The list never carries fares, also for the assignee.
      expect(JSON.stringify(await one(FLIGHT, FLIGHT_LIST_SQL))).not.toMatch(FARE_TEXT);
    });
  });
});

describe('audit rows carry ids only', () => {
  it('no fare amount in any booking audit row', async () => {
    await asOwner(db, async () => {
      await submitted();
      const audit = await owner<{ action: string; details: unknown }>(`select action, details from public.audit_events where action like 'booking.%'`);
      expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['booking.estimate_saved', 'booking.flight_fares_saved']));
      expect(JSON.stringify(audit)).not.toMatch(new RegExp(`${ADULT}|${CHILD}|${TOTAL_INFANT}`));
    });
  });
});
