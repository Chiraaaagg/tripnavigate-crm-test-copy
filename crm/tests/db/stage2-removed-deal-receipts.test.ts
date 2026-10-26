import { afterAll, beforeAll, describe, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACC, DEAL, financeHelpers, insertApprovedDestination, rid } from './finance-support';

/**
 * Stage 2 rewrites public.receipt_record (20261110000100) after the Stage 0
 * removed-Deal rule (20261107000300). The rewrite must keep the rule: a Deal
 * removed by the Bitrix sync refuses a new bank-transfer or UPI receipt with
 * 'deal_removed', even when the receipt names an approved, current company
 * destination that would otherwise be accepted.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = financeHelpers(() => db);
const { refused, owner } = h;

/** SYN-DEL-001 becomes an imported Bitrix Deal (test-only provenance relaxations, as in stage0-removed-deals). */
async function markImported(): Promise<void> {
  await db.exec('alter table public.deals drop constraint deals_provenance');
  await db.exec('alter table public.deals drop constraint deals_source_assigned_by_provenance');
  await db.exec('alter table public.deal_commercials drop constraint deal_commercials_synthetic_parent');
  await owner(
    `update public.deals set is_synthetic = false, source_system = 'bitrix', source_portal = 'SYNTHETIC_MEMBER_0001',
       source_deal_id = 990001, source_assigned_by_id = 101 where id = $1`,
    [DEAL],
  );
}

describe('Stage 2 receipt recording keeps the removed-Deal rule', () => {
  it('a removed Deal refuses new bank-transfer and UPI receipts that name an approved current destination', async () => {
    await asOwner(db, async () => {
      await markImported();
      await owner('select authz.remove_bitrix_deals(array[$1]::uuid[], $2)', [DEAL, 'pipeline_not_eligible']);
      await h.setEnvironment('operational');
      await owner(
        `update public.finance_live_settings set bank_transfer_live = true, upi_live = true where legal_entity_id = $1`,
        [await h.entityId()],
      );
      // Real (non-synthetic) destinations matching the now-imported Deal.
      const bankVersion = await insertApprovedDestination(db, DEAL, 'bank');
      const upiVersion = await insertApprovedDestination(db, DEAL, 'upi');
      const bank = { ...(await h.bankFields()), destinationVersionId: bankVersion };
      const upi = { ...(await h.bankFields()), mode: 'upi', destinationVersionId: upiVersion };
      await refused(ACC, h.RECORD, [DEAL, JSON.stringify(bank), rid()], '55000', 'deal_removed');
      await refused(ACC, h.RECORD, [DEAL, JSON.stringify(upi), rid()], '55000', 'deal_removed');
    });
  });
});
