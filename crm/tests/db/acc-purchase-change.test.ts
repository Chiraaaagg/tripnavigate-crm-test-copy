import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import {
  ACC, DEAL, FLIGHT, HOTEL, HOTEL_ITEM, MANAGER, OWNER, PURCHASE, SELLING, SQL, TRANSFER_ITEM, TRAVELLERS, TRIP, accHelpers, allKeys, containsToken,
  rid,
} from './acc-support';

/**
 * Accounts phase contract 6.3.4 (purchase_task_basis), 7.6 (P1 ack), 8.5
 * (purchase_booking_change, purchase_home_counts) and 9.1 #3 booking_changed;
 * test plan 12.3 "Purchase change", Track E:
 *   - basis created at first assignment (= the task's current version);
 *   - a revision shows fields before/after, travellers renamed, trip dates —
 *     never selling total, price lines, plan, contacts, billing, identity or
 *     budget amounts (sentinel scan; AL18 budget flag only);
 *   - urgent notice to the assignee; ack moves the basis, sets the notice
 *     done, audits; stale expected basis -> version_changed; Home count.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = accHelpers(() => db);
const { one, owner, refused } = h;
const NEW_SELLING = '9912345';
type Change = {
  taskId: string; basisVersionId: string; basisVersionNo: number; currentVersionId: string; currentVersionNo: number; changedAt: string; canAck: boolean;
  fields: Array<{ key: string; label: string; before: unknown; after: unknown }>;
  travellers: { added: Array<{ seq: number }>; removed: Array<{ seq: number }>; renamed: Array<{ seq: number; before: string; after: string }>; typeChanged: unknown[] };
  tripChanged: Record<string, { before: unknown; after: unknown }> | null;
} & Record<string, unknown>;
const basisOf = async (task: string) =>
  (await owner<{ basis_version_id: string; row_version: number }>('select basis_version_id, row_version from public.purchase_task_basis where task_id = $1', [task]))[0];

/** Hotel + transfer booking; Purchase takes the hotel task; Accounts returns; Sales revises (room, a name, trip end, price). */
async function changed() {
  await h.noticesOn();
  const b = await h.book([HOTEL_ITEM, TRANSFER_ITEM]);
  const task = h.taskOf(b, 'hotel');
  await one(PURCHASE, SQL.purchaseClaim, [task]);
  const before = await basisOf(task);
  const v2 = await h.revise(b.versionId, async (versionId, rv) => {
    let next = (await one<{ rowVersion: number }>(OWNER, SQL.saveItem, [b.itemIds[0], versionId, rv,
      JSON.stringify({ ...HOTEL, roomType: 'Synthetic Suite' }), '20000000'])).rowVersion;
    next = (await h.saveTravellers(OWNER, DEAL, next, [TRAVELLERS[0], TRAVELLERS[1], { ...TRAVELLERS[2]!, fullName: 'Synthetic Renamed Three' },
      TRAVELLERS[3]])).rowVersion;
    await h.storeIdProof(OWNER, DEAL, 3);
    next = (await one<{ rowVersion: number }>(OWNER, 'select public.booking_trip_save($1, $2, $3::jsonb) as r',
      [versionId, next, JSON.stringify({ ...TRIP, end: '2026-12-14' })])).rowVersion;
    next = (await h.saveSelling(OWNER, versionId, next, NEW_SELLING)).rowVersion;
    next = (await h.savePlan(OWNER, versionId, next, [{ seq: 1, label: 'Full payment', amountPaise: NEW_SELLING, dueDate: '2026-12-01' }])).rowVersion;
    return next;
  });
  return { b, task, before, v2 };
}

describe('6.3.4 / 8.5 basis and the change read', () => {
  it('basis is the current version at first assignment; nothing changed -> null', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      const b = await h.book([HOTEL_ITEM]);
      const task = h.taskOf(b, 'hotel');
      expect(await basisOf(task)).toBeUndefined();
      await one(PURCHASE, SQL.purchaseClaim, [task]);
      expect(await basisOf(task)).toMatchObject({ basis_version_id: b.versionId });
      expect(await one(PURCHASE, SQL.change, [task])).toBeNull();
      expect(await one(PURCHASE, SQL.purchaseHome, [])).toMatchObject({ purchaseBookingChanged: 0 });
    });
  });

  it('a revision shows room, traveller rename and trip end, never money; readers and canAck', async () => {
    await asOwner(db, async () => {
      const { b, task, before, v2 } = await changed();
      expect(before!.basis_version_id).toBe(b.versionId);
      const c = (await one<Change | null>(PURCHASE, SQL.change, [task]))!;
      expect(c).toMatchObject({ taskId: task, basisVersionId: b.versionId, basisVersionNo: 1, currentVersionId: v2, currentVersionNo: 2, canAck: true });
      expect(c.fields.find((f) => f.key === 'roomType')).toMatchObject({ before: 'Synthetic Deluxe', after: 'Synthetic Suite' });
      // Labels come from the frozen key -> label map in TS (8.5); see tests/unit/acc-booking-change.test.ts.
      expect(c.travellers.renamed).toEqual([expect.objectContaining({ seq: 3, before: 'Synthetic Traveller Three', after: 'Synthetic Renamed Three' })]);
      expect(c.tripChanged?.end).toMatchObject({ before: '2026-12-13', after: '2026-12-14' });
      const text = JSON.stringify(c);
      for (const v of [SELLING, NEW_SELLING, '20000000', '9876500011', 'contact@example.test', 'Z1000001']) {
        expect(containsToken(text, v), `change read leaks ${v}`).toBe(false);
      }
      expect([...allKeys(c)].filter((k) => /sell|price|discount|instal|plan|commercial|margin|billing|contact|passport|identity|amount|paise/i.test(k)))
        .toEqual([]);
      // Readers: Manager read-only; Sales, Accounts, Flight: null.
      expect(await one<Change | null>(MANAGER, SQL.change, [task])).toMatchObject({ canAck: false });
      for (const actor of [OWNER, ACC, FLIGHT]) expect(await h.attempt(actor, SQL.change, [task]), String(actor.userId)).toMatchObject({ value: null });
      // Home count (Purchase only).
      expect(await one(PURCHASE, SQL.purchaseHome, [])).toMatchObject({ purchaseBookingChanged: 1, purchaseBookingChangedTaskId: task });
      expect(await h.attempt(OWNER, SQL.purchaseHome, [])).toMatchObject({ value: null });
      // #3 booking_changed: urgent to the assignee of the in-progress task; not to the unassigned transfer task.
      const n = await h.notices('booking_changed');
      expect(n.map((x) => [x.recipient_user_id, x.priority, x.task_id])).toEqual([[PURCHASE.userId, 'urgent', task]]);
      expect(JSON.stringify(n.map((x) => x.params))).not.toContain(NEW_SELLING);
    });
  });
});

describe('7.6 P1 purchase_booking_change_ack', () => {
  it('stale expected basis -> version_changed; ack moves the basis, marks the notice done and audits; again -> existing', async () => {
    await asOwner(db, async () => {
      const { b, task, v2 } = await changed();
      await refused(PURCHASE, SQL.changeAck, [task, v2, rid()], 'version_changed', '40001');
      await refused(MANAGER, SQL.changeAck, [task, b.versionId, rid()], 'not_authorized', '42501');
      await refused(ACC, SQL.changeAck, [task, b.versionId, rid()], 'not_authorized', '42501');
      const done = await one<{ outcome: string }>(PURCHASE, SQL.changeAck, [task, b.versionId, rid()]);
      expect(['updated', 'created']).toContain(done.outcome);
      expect(await basisOf(task)).toMatchObject({ basis_version_id: v2, row_version: 2 });
      expect(await one(PURCHASE, SQL.change, [task])).toBeNull();
      expect((await h.notices('booking_changed'))[0]!.done_at).not.toBeNull();
      const [audit] = await h.audits('purchase.booking_change_seen');
      expect(audit!.details).toMatchObject({ fromVersionId: b.versionId, toVersionId: v2, rowVersion: 2 });
      expect(await one(PURCHASE, SQL.changeAck, [task, v2, rid()])).toMatchObject({ outcome: 'existing' });
      expect(await one(PURCHASE, SQL.purchaseHome, [])).toMatchObject({ purchaseBookingChanged: 0 });
    });
  });

  it('reassignment: the new assignee acknowledges; the old one cannot', async () => {
    await asOwner(db, async () => {
      await h.addRole(U.movedStaff, 'purchase');
      const { b, task } = await changed();
      await one(MANAGER, SQL.purchaseReassign, [task, U.purchaseJodhpur, U.movedStaff]);
      await refused(PURCHASE, SQL.changeAck, [task, b.versionId, rid()], 'not_authorized', '42501');
      expect(await one({ userId: U.movedStaff }, SQL.change, [task])).toMatchObject({ canAck: true });
      await one({ userId: U.movedStaff }, SQL.changeAck, [task, b.versionId, rid()]);
      expect((await h.notices('booking_changed', U.purchaseJodhpur))[0]!.resolved_reason).toBe('reassigned');
    });
  });
});
