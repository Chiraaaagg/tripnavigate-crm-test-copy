import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { PAST_HOTEL_ITEM, PAST_TRIP, SELLING } from './acc-support';
import { ACC, DEAL, MANAGER, OWNER, REASON, SQL3, acc3Helpers, rid } from './acc3-support';

/**
 * Lead fix-forward 20261205000250 (contract 6.6, LD15): after an approved
 * write-off, the Sales "Still to pay (based on checked money)" figure on the
 * Deal page Money tab (deal_payment_claims.balancePaise) follows the adjusted
 * total, like deal_dues. Before the fix it still showed the written-off amount.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = acc3Helpers(() => db);
const { one, owner } = h;
const CLAIMS = 'select public.deal_payment_claims($1) as r';
type Claims = { sellingTotalPaise: string; confirmedPaise: string; balancePaise: string };
type WO = { writeOffId: string; status: string };

describe('deal_payment_claims balance after a write-off', () => {
  it('due: still to pay is the gap, zero once approved, the gap again after undo; selling total unchanged', async () => {
    await asOwner(db, async () => {
      await h.people();
      const b = await h.book([PAST_HOTEL_ITEM], { trip: { start: PAST_TRIP.start, end: PAST_TRIP.end } });
      await h.approveReal(b.versionId);
      await h.receipt(DEAL, String(Number(SELLING) - 300));
      await h.writeOffOn(true);

      const before = await one<Claims>(OWNER, CLAIMS, [DEAL]);
      expect(before.balancePaise).toBe('300');
      const p = await one<WO>(ACC, SQL3.woPropose, [DEAL, JSON.stringify({ direction: 'due', amountPaise: '300', reason: REASON }), rid()]);
      // Proposed only: nothing changes yet.
      expect((await one<Claims>(OWNER, CLAIMS, [DEAL])).balancePaise).toBe('300');
      const rowVersion = async () => (await owner<{ v: number }>('select row_version as v from public.deal_write_offs where id = $1', [p.writeOffId]))[0]!.v;
      await one<WO>(MANAGER, SQL3.woDecide, [p.writeOffId, 'approve', '300', null, await rowVersion(), rid()]);

      const after = await one<Claims>(OWNER, CLAIMS, [DEAL]);
      expect(after.balancePaise).toBe('0');
      expect(after.sellingTotalPaise).toBe(before.sellingTotalPaise);
      expect(after.confirmedPaise).toBe(before.confirmedPaise);
      // Same figure as the dues card.
      expect((await one<{ balancePaise: string }>(ACC, SQL3.dealDues, [DEAL])).balancePaise).toBe('0');

      await one(MANAGER, SQL3.woUndo, [p.writeOffId, await rowVersion(), REASON, rid()]);
      expect((await one<Claims>(OWNER, CLAIMS, [DEAL])).balancePaise).toBe('300');
    });
  });
});
