import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACC } from './finance-support';
import {
  ACCOUNTS, DEAL, FLIGHT, FLIGHT_FACTS, FLIGHT_GET_SQL, HOTEL, MANAGER_AMD, OWNER, PURCHASE, PURCHASE_GET_SQL, SALES_B, SUPER, allKeys,
} from './b1-support';
import { b11Helpers, rid } from './b11-support';

/**
 * Stage 3 revision access (migration 20261119000300): only booking editors
 * open, classify, discard or confirm a revision; history and return reasons
 * never reach Purchase, Flight, other branches or Super Admin; department
 * task reads name changed fields without commercial, plan, contact or
 * identity names.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one, refused, owner, readyDraft, confirm, readiness } = h;

describe('revision access', () => {
  it('department readers and outsiders get no history, no reason and no commercial change names', async () => {
    await asOwner(db, async () => {
      await h.addFlight();
      const base = await readyDraft(OWNER, DEAL, [['hotel', HOTEL], ['flight', FLIGHT_FACTS]]);
      const { taskIds } = await confirm(OWNER, base.versionId, base.hash);
      await one(ACC, 'select public.accounts_review_return($1, $2, $3) as r', [base.versionId, 'Synthetic return reason for the test', rid()]);
      for (const actor of [PURCHASE, FLIGHT, SALES_B, MANAGER_AMD, SUPER, ACCOUNTS]) {
        await refused(actor, 'select public.booking_open_revision($1) as r', [base.versionId], '42501', 'not_authorized');
      }
      const opened = await one<{ versionId: string; rowVersion: number }>(OWNER, 'select public.booking_open_revision($1) as r', [base.versionId]);
      for (const actor of [PURCHASE, FLIGHT, SALES_B, SUPER]) {
        expect(await one(actor, 'select public.booking_version_history($1) as r', [DEAL])).toBeNull();
        await refused(actor, 'select public.booking_discard_draft($1, $2) as r', [opened.versionId, opened.rowVersion], '42501', 'not_authorized');
      }
      // Price and plan change plus a budget change; then confirm.
      let rv = (await h.saveCommercials(OWNER, opened.versionId, opened.rowVersion, null, null, '9900000')).rowVersion;
      rv = (await h.savePlan(OWNER, opened.versionId, rv, [{ seq: 1, label: 'Full payment', amountPaise: '9900000', dueDate: '2026-11-01' }])).rowVersion;
      const items = await owner<{ id: string }>('select id from public.service_items where deal_id = $1 order by item_no', [DEAL]);
      rv = (await one<{ rowVersion: number }>(OWNER, 'select public.service_item_save($1, $2, $3, $4::jsonb, $5::bigint) as r',
        [items[0]!.id, opened.versionId, rv, JSON.stringify(HOTEL), '4600000'])).rowVersion;
      const c = await one<{ changedFields: string[] }>(OWNER, 'select public.booking_classify_revision($1, $2, $3) as r', [opened.versionId, rv, 'customer_material']);
      expect(c.changedFields).toEqual(['items.1.purchaseBudgetPaise', 'plan', 'sellingTotal']);
      await h.storeEvidence(OWNER, opened.versionId, 'acceptance_message', 'f'.repeat(64));
      const ready = await readiness(OWNER, opened.versionId);
      await refused(SALES_B, 'select public.booking_confirm($1, $2) as r', [opened.versionId, ready.contentHash], '42501', 'not_authorized');
      await confirm(OWNER, opened.versionId, ready.contentHash);
      const purchase = await one<Record<string, unknown>>(PURCHASE, PURCHASE_GET_SQL, [taskIds![0]]);
      expect(purchase.changedFields).toEqual(['items.1.purchaseBudgetPaise']);
      const flight = await one<Record<string, unknown>>(FLIGHT, FLIGHT_GET_SQL, [taskIds![1]]);
      expect(flight.changedFields).toEqual(['items.1.purchaseBudgetPaise']);
      for (const p of [purchase, flight]) {
        expect([...allKeys(p)].filter((k) => /sellingTotal|reason|review|^plan$/i.test(k))).toEqual([]);
        expect(JSON.stringify(p)).not.toMatch(/9900000|Synthetic return reason/);
      }
    });
  });
});
