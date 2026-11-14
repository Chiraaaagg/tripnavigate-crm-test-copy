import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { MANAGER, MANAGER_J2, PURCHASE, SQLB, U, relbHelpers, rid } from './acc3-relb-support';

/**
 * Track E fix-forward 20261205000580 (backend review, MEDIUM): a Manager who
 * also holds Purchase and edited or sent a rate contract cannot approve it
 * (not_self_approval); another Manager can. Synthetic data only.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = relbHelpers(() => db);

describe('rate contract approval: editor and sender are not Approvers', () => {
  it('Purchase creates; a Manager holding Purchase edits the lines and submits; that Manager is refused; another Manager approves', async () => {
    await asOwner(db, async () => {
      await h.people();
      await h.rateContractsOn();
      await h.addRole(U.managerDelhi, 'purchase');
      const hotel = await h.catalogueHotel();
      const supplier = await h.hotelSupplier(hotel);
      const room = await h.roomType(hotel);
      const c = await h.draftContract(supplier, hotel);
      await h.setLines(c.contractId, [h.line(room)], [], MANAGER);
      await h.submit(c.contractId, MANAGER);
      const row = await h.contractRow(c.contractId);
      expect(row).toMatchObject({ entered_by: U.purchaseJodhpur, last_edited_by: U.managerDelhi, submitted_by: U.managerDelhi });

      const got = await h.one<Record<string, unknown>>(MANAGER, SQLB.contractGet, [c.contractId]);
      expect(got).toMatchObject({ isMine: true, can: { approve: false, return: false } });
      await h.refusedToken(MANAGER, SQLB.contractDecide, [c.contractId, 'approve', null, row.row_version, rid()], 'not_self_approval',
        undefined, '42501');

      await h.decideContract(c.contractId, 'approve', MANAGER_J2);
      expect((await h.contractRow(c.contractId)).status).toBe('active');
    });
  });
});
