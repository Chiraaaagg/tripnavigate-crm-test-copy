import { describe, expect, it } from 'vitest';
import { asRpcClient, flightTaskGet, flightTaskList, purchaseTaskGet } from '@/modules/fulfilment/commands';
import { toFlightTaskSummary, toFlightTaskView, toPurchaseTaskView } from '@/modules/fulfilment/dto';

/*
 * Book now v2, department reads (Agent D, extra): a Purchase task view never
 * carries a flight fare or the typed all-flights totals, even when a reply
 * slips them in; the Flight queue reads a flight added from a screenshot
 * (no legs) instead of failing closed; fares reach the Flight view only when
 * the database sent them to the assignee. Synthetic data only.
 */

const TASK = '22222222-2222-4222-8222-222222222222';
const client = (data: unknown) => asRpcClient({ rpc: async () => ({ data, error: null }) } as never);
const FARE = /fare|flightFareTotals/i;

function keysOf(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => keysOf(v, prefix));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [`${prefix}.${k}`, ...keysOf(v, `${prefix}.${k}`)]);
  return [];
}

const purchaseCar = (over: Record<string, unknown> = {}) => ({
  taskId: TASK,
  dealReference: 'SYN-JOD-020',
  serviceType: 'transfer',
  itemTitle: 'Airport pickup',
  facts: { type: 'transfer', facts: { route: 'Airport to hotel', date: '2026-12-10', vehicleType: 'Sedan', passengers: 3, carKind: 'airport_pickup',
    flightItemId: '33333333-3333-4333-8333-333333333333' } },
  hotelName: null, city: null, checkIn: null, checkOut: null, rooms: 0, adults: 0, children: 0,
  purchaseBudgetPaise: '250000',
  status: 'in_progress', assigneeName: 'Test Purchase', assignedToYou: true, branchName: 'Jodhpur', createdAt: '2026-10-22T09:00:00Z', supplierConfirmedAt: null,
  roomType: null, mealPlan: null, inclusions: null, specialRequests: null,
  confirmedAt: '2026-10-22T08:59:00Z', confirmedByName: 'Sample Sales (synthetic)', versionNo: 1, canClaim: false,
  ...over,
});

describe('Purchase task view: never a flight fare', () => {
  it('fare keys slipped into the reply are dropped; the car keeps the flight it meets by id only', async () => {
    const record = await purchaseTaskGet(client(purchaseCar({
      estimate: { kind: 'transfer', vehicleRatePaise: '250000' },
      fareTotals: { adultPaise: '1400000', childPaise: null, infantPaise: null },
      flightFareTotals: { adultPaise: '1400000', childPaise: null, infantPaise: null },
      fareAdultPaise: '600000',
    })), TASK);
    const view = toPurchaseTaskView(record!);
    expect(keysOf(view).filter((k) => FARE.test(k))).toEqual([]);
    expect(JSON.stringify(view)).not.toMatch(/1400000|600000/);
    expect(view.estimate).toEqual({ estimate: { kind: 'transfer', vehicleRatePaise: '250000' }, totalPaise: '250000' });
    expect(JSON.stringify(view.facts)).toMatch(/33333333-3333-4333-8333-333333333333/);
  });
});

const screenshotFlight = {
  taskId: TASK, dealReference: 'SYN-JOD-021', itemTitle: 'From screenshot',
  facts: { segments: [], passengers: 3, entryMode: 'screenshot', screenshotNote: 'Book the 08:00 option' },
  purchaseBudgetPaise: '0', status: 'in_progress', assigneeName: 'Test Flight', assignedToYou: true, branchName: 'Jodhpur',
  createdAt: '2026-10-22T09:00:00Z', supplierConfirmedAt: null,
};
const participants = [
  { seq: 1, type: 'adult', ageYears: null, fullName: 'Synthetic Traveller One', specialNeeds: null },
  { seq: 2, type: 'adult', ageYears: null, fullName: 'Synthetic Traveller Two', specialNeeds: null },
  { seq: 3, type: 'child', ageYears: 9, fullName: 'Synthetic Traveller Three', specialNeeds: null },
];
const detail = { ...screenshotFlight, confirmedAt: '2026-10-22T08:59:00Z', confirmedByName: 'Sample Sales (synthetic)', versionNo: 1, canClaim: false,
  travellerCount: 3, participants };

describe('Flight queue: a flight added from a screenshot', () => {
  it('the list and the detail read it (no legs) and keep the note', async () => {
    const list = await flightTaskList(client([screenshotFlight, { ...screenshotFlight, taskId: '22222222-2222-4222-8222-222222222223',
      facts: { segments: [{ from: 'DEL', to: 'JDH', date: '2026-12-10' }], passengers: 2 }, itemTitle: 'DEL to JDH' }]));
    expect(list.length).toBe(2);
    const summary = toFlightTaskSummary(list[0]!);
    expect(summary.facts).toMatchObject({ segments: [], entryMode: 'screenshot', screenshotNote: 'Book the 08:00 option' });
    const view = toFlightTaskView((await flightTaskGet(client(detail), TASK))!);
    expect(view.facts).toMatchObject({ segments: [], entryMode: 'screenshot' });
  });

  it('a typed flight still needs a leg (fails closed on a broken reply)', async () => {
    await expect(flightTaskList(client([{ ...screenshotFlight, facts: { segments: [], passengers: 2 } }]))).rejects.toThrow();
  });

  it('fares only when the database sent them (assignee): per person times the participants by type, plus the typed totals', async () => {
    const without = toFlightTaskView((await flightTaskGet(client(detail), TASK))!);
    expect(keysOf(without).filter((k) => FARE.test(k) || /estimate/.test(k))).toEqual([]);
    const withFares = toFlightTaskView((await flightTaskGet(client({ ...detail,
      estimate: { kind: 'flight', fareTotalPaise: null, fareAdultPaise: '600000', fareChildPaise: '450000', fareInfantPaise: null },
      fareTotals: { adultPaise: null, childPaise: null, infantPaise: '100000' }, files: [] }), TASK))!);
    expect(withFares.estimate?.totalPaise).toBe('1650000');
    expect(withFares.fareTotals).toEqual({ adultPaise: null, childPaise: null, infantPaise: '100000' });
  });
});
