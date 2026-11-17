import { describe, expect, it } from 'vitest';
import { asRpcClient, flightTaskGet, FlightSummarySchema, purchaseTaskGet, ServiceFactsSchema } from '@/modules/fulfilment/commands';
import { copyFacts, toFlightTaskView, toPurchaseTaskView } from '@/modules/fulfilment/dto';

/*
 * Booking form fact keys on department screens: a Purchase car task and a
 * Flight task keep the new non-money keys (vehicle count, end date,
 * kilometres, vendor; arrival date, airline, flight number, local times) and
 * never carry an estimate or a price. Synthetic data only.
 */

const TASK = '22222222-2222-4222-8222-222222222222';
const MONEY = /estimate|ratePaise|fareTotal|salePaise|markup|purchasePaise|sellingTotal|priceLines|\.prices/i;

function keysOf(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => keysOf(v, prefix));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [`${prefix}.${k}`, ...keysOf(v, `${prefix}.${k}`)]);
  return [];
}

describe('car facts on a Purchase task', () => {
  it('parse and copy keep the new keys; unknown keys still refuse (fail closed)', () => {
    const facts = ServiceFactsSchema.parse({
      type: 'transfer',
      facts: { route: 'Airport to hotel', date: '2026-12-10', vehicleType: 'Sedan', passengers: 3, endDate: '2026-12-15', quantity: 2, includedKms: 300, vendor: 'Test cabs' },
    });
    const copied = copyFacts(facts);
    expect(copied.facts).toMatchObject({ endDate: '2026-12-15', quantity: 2, includedKms: 300, vendor: 'Test cabs' });
    expect(keysOf(copied).filter((k) => MONEY.test(k))).toEqual([]);
    expect(ServiceFactsSchema.safeParse({ type: 'transfer', facts: { route: 'A to B', date: '2026-12-10', vehicleType: null, passengers: null, vehicleRatePaise: '100' } }).success).toBe(false);
    expect(ServiceFactsSchema.safeParse({ type: 'transfer', facts: { route: 'A to B', date: '2026-12-10', vehicleType: null, passengers: null, quantity: 0 } }).success).toBe(false);
  });
});

describe('flight facts on a Flight task', () => {
  it('keeps the requested flight details and no money', () => {
    const summary = FlightSummarySchema.parse({
      taskId: TASK,
      dealReference: 'SYN-JOD-020',
      itemTitle: 'DEL → GOI',
      facts: { segments: [{ from: 'DEL', to: 'GOI', date: '2026-12-10', arrivalDate: '2026-12-10', airline: 'Test Air', flightNo: 'TA 101', departTime: '23:10', arriveTime: '01:20' }], passengers: 2 },
      purchaseBudgetPaise: '4000000',
      status: 'in_progress',
      assigneeName: null,
      assignedToYou: true,
      branchName: 'Jodhpur',
      createdAt: '2026-10-22T09:00:00Z',
    });
    const view = toFlightTaskView({ ...summary, confirmedAt: '2026-10-22T08:59:00Z', confirmedByName: 'Sample Sales (synthetic)', versionNo: 1, canClaim: false, travellerCount: 2 } as never);
    expect(keysOf(view).filter((k) => /arrivalDate|airline|flightNo|departTime|arriveTime/.test(k)).length).toBeGreaterThanOrEqual(5);
    expect(keysOf(view).filter((k) => MONEY.test(k))).toEqual([]);
    expect(ServiceFactsSchema.safeParse({ type: 'flight', facts: { segments: [{ from: 'DEL', to: 'GOI', date: '2026-12-10', departTime: '25:00' }], passengers: 1 } }).success).toBe(false);
  });
});

const SALE = /salePaise|markup|sellingTotal|priceLines|\.prices|listPrice|discount|\.plan|\.claims?($|\.)|claimId/i;
const client = (data: unknown) => asRpcClient({ rpc: async () => ({ data, error: null }) } as never);
const FILE = '77777777-7777-4777-8777-777777777777';

const purchaseDetail = (over: Record<string, unknown> = {}) => ({
  taskId: TASK,
  dealReference: 'SYN-JOD-020',
  serviceType: 'transfer',
  itemTitle: 'Airport to hotel',
  facts: { type: 'transfer', facts: { route: 'Airport to hotel', date: '2026-12-10', vehicleType: 'Sedan', passengers: 3, endDate: '2026-12-15', quantity: 2 } },
  hotelName: null, city: null, checkIn: null, checkOut: null, rooms: 0, adults: 0, children: 0,
  purchaseBudgetPaise: '0',
  status: 'not_started', assigneeName: 'Test Purchase', assignedToYou: true, branchName: 'Jodhpur', createdAt: '2026-10-22T09:00:00Z', supplierConfirmedAt: null,
  roomType: null, mealPlan: null, inclusions: null, specialRequests: null,
  confirmedAt: '2026-10-22T08:59:00Z', confirmedByName: 'Sample Sales (synthetic)', versionNo: 1, canClaim: false,
  ...over,
});

describe('Purchase task: estimate only when the database sends it; never a price (contract ruling 9)', () => {
  it('assignee: cost estimate worked out from the item facts', async () => {
    const record = await purchaseTaskGet(client(purchaseDetail({ estimate: { kind: 'transfer', vehicleRatePaise: '2500000' } })), TASK);
    const view = toPurchaseTaskView(record!);
    expect(view.estimate).toEqual({ estimate: { kind: 'transfer', vehicleRatePaise: '2500000' }, totalPaise: '5000000' });
    expect(keysOf(view).filter((k) => SALE.test(k))).toEqual([]);
  });
  it('anyone else (no estimate key sent): no estimate key at all', async () => {
    const view = toPurchaseTaskView((await purchaseTaskGet(client(purchaseDetail()), TASK))!);
    expect('estimate' in view).toBe(false);
    expect(keysOf(view).filter((k) => MONEY.test(k) || SALE.test(k))).toEqual([]);
  });
  it('a price key slipped into the reply is dropped, never shown', async () => {
    const view = toPurchaseTaskView((await purchaseTaskGet(client(purchaseDetail({ sellingTotalPaise: '9999', prices: { lines: [] }, salePaise: '1' })), TASK))!);
    expect(keysOf(view).filter((k) => SALE.test(k))).toEqual([]);
  });
});

describe('Flight task: estimated fare and stored screenshots for the assignee (contract ruling 14)', () => {
  const flight = {
    taskId: TASK, dealReference: 'SYN-JOD-020', itemTitle: 'DEL → GOI',
    facts: { segments: [{ from: 'DEL', to: 'GOI', date: '2026-12-10' }], passengers: 2 },
    purchaseBudgetPaise: '4000000', status: 'in_progress', assigneeName: null, assignedToYou: true, branchName: 'Jodhpur', createdAt: '2026-10-22T09:00:00Z', supplierConfirmedAt: null,
    confirmedAt: '2026-10-22T08:59:00Z', confirmedByName: 'Sample Sales (synthetic)', versionNo: 1, canClaim: false, travellerCount: 2,
  };
  it('maps stored files to the Flight download route; removed files and removal are not offered', async () => {
    const record = await flightTaskGet(
      client({
        ...flight,
        estimate: { kind: 'flight', fareTotalPaise: '1800050' },
        files: [
          { fileId: FILE, kind: 'flight_screenshot', fileName: 'fare.png', mime: 'image/png', sizeBytes: 2048, status: 'stored', createdAt: '2026-10-22T08:00:00Z', storedAt: '2026-10-22T08:00:05Z', rowVersion: 2, uploadedByYou: false },
          { fileId: '77777777-7777-4777-8777-777777777778', kind: 'flight_screenshot', fileName: 'old.png', mime: 'image/png', sizeBytes: 2048, status: 'removed', createdAt: '2026-10-22T08:00:00Z', rowVersion: 3 },
        ],
      }),
      TASK,
    );
    const view = toFlightTaskView(record!);
    expect(view.estimate?.totalPaise).toBe('1800050');
    expect(view.files).toEqual([expect.objectContaining({ fileId: FILE, downloadHref: `/app/flight/files/${FILE}`, canRemove: false, uploadedAt: '2026-10-22T08:00:05Z' })]);
    expect(keysOf(view).filter((k) => SALE.test(k))).toEqual([]);
  });
  it('without the keys (not the assignee, older database): absent', async () => {
    const view = toFlightTaskView((await flightTaskGet(client(flight), TASK))!);
    expect('estimate' in view || 'files' in view).toBe(false);
  });
});
