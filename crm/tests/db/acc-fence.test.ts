import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import {
  ACC, ANON, DEAL, FLIGHT, MANAGER, MANAGER_AMD, OTHER_ENTITY, OWNER, PURCHASE, SALES_B, SELLING, SENTINEL, SQL, VISA, type WorkPage,
  accHelpers, allKeys, containsToken,
} from './acc-support';

/**
 * Accounts phase contract sections 4.3 (readers), 8 (reads and role fences)
 * and test plan 12.4 (money fence and privacy leak test), Track E.
 *
 * Every read of section 8 as A, A+P, M, M+F, M+P, M+V, SO, other Sales, P,
 * F, V, another entity and anonymous: P/F/V get null everywhere; Accounts +
 * Purchase is not A; a Manager holding Purchase, Flight or Visa gets nothing
 * (AL7); a Manager sees only rows of their branch (or receipts their branch
 * collected, AL8) and has no actions; workspace rows carry no PAN, mobile,
 * passport or selling values; new audit rows carry no amounts, names, PNRs,
 * ticket numbers, PAN or mobile.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = accHelpers(() => db);
const { owner } = h;
/** AL8: Manager Ahmedabad also given a Jodhpur Manager membership (the collecting branch of the cash receipt). */
const M_JDH: Actor = { userId: U.managerAhmedabad };

/** The value of a read, or null when the call is refused (an anonymous caller may get an error). */
async function value<T>(actor: Actor, sql: string, params: unknown[]): Promise<T | null> {
  const r = await h.attempt<T>(actor, sql, params);
  if (!r.ok) {
    expect(r.code, `${sql} as ${actor.userId}: ${r.error}`).toMatch(/^(42501|28000|P0001)$/);
    return null;
  }
  return r.value;
}

/** everyKind, then Visa Jodhpur loses the scenario's Accounts membership (a pure Visa person). */
async function scenario() {
  const k = await h.everyKind();
  await h.dropRole(U.visaJodhpur, 'accounts');
  return k;
}
const rec = (actor: Actor) => value<WorkPage>(actor, SQL.records, [JSON.stringify({}), null, 100]);

describe('4.3 / 8 role fence on every read', () => {
  it('workspace, totals, daily check, dues, Deal dues and payables per reader', async () => {
    await asOwner(db, async () => {
      await scenario();
      // A: everything of the entity, with actions and the A-only Tally fields.
      const a = (await rec(ACC))!;
      expect(a.items.length).toBeGreaterThan(10);
      expect(a.items.some((r) => r.can.match)).toBe(true);
      expect(await value(ACC, SQL.dailyCheck, [])).not.toBeNull();
      expect(await value(ACC, SQL.dues, [JSON.stringify({}), null, 50])).not.toBeNull();
      expect(await value<Record<string, unknown>>(ACC, SQL.dealDues, [DEAL])).toHaveProperty('supplierPayables');
      expect(await value(ACC, SQL.payables, [DEAL])).not.toBeNull();

      // M (Delhi): read-only rows of the branch.
      const m = (await rec(MANAGER))!;
      expect(m.items.length).toBeGreaterThan(0);
      for (const r of m.items) {
        expect(r.can, r.rowId).toEqual({ match: false, exception: false, reopen: false, linkTask: false });
        expect(r.tally.voucherRef ?? null, 'voucherRef is A only').toBeNull();
        expect(r.tally.exceptionReason ?? null, 'exceptionReason is A only').toBeNull();
      }
      expect(await value(MANAGER, SQL.recordsTotals, [JSON.stringify({})])).not.toBeNull();
      expect(await value(MANAGER, SQL.dailyCheck, []), 'daily check is A only').toBeNull();
      expect(await value(MANAGER, SQL.dues, [JSON.stringify({}), null, 50])).not.toBeNull();
      expect(await value<Record<string, unknown>>(MANAGER, SQL.dealDues, [DEAL])).toHaveProperty('supplierPayables');
      expect(await value(MANAGER, SQL.payables, [DEAL])).not.toBeNull();

      // Manager of another branch: no Delhi rows; no Delhi Deal dues.
      const amd = await rec(MANAGER_AMD);
      expect((amd?.items ?? []).filter((r) => r.dealId === DEAL)).toEqual([]);
      expect(await value(MANAGER_AMD, SQL.dealDues, [DEAL])).toBeNull();

      // SO: dues of own Deal (no payables), no workspace.
      expect(await rec(OWNER)).toBeNull();
      const so = await value<Record<string, unknown>>(OWNER, SQL.dealDues, [DEAL]);
      expect(so).not.toBeNull();
      expect(so!.supplierPayables ?? null, 'supplier payables are A and M only').toBeNull();
      const soList = await value<{ items: Array<{ dealId: string }> }>(OWNER, SQL.dues, [JSON.stringify({}), null, 50]);
      expect(soList!.items.map((x) => x.dealId)).toContain(DEAL);
      expect(await value(OWNER, SQL.payables, [DEAL])).toBeNull();

      // Other Sales: no workspace; never the Deal's dues.
      expect(await rec(SALES_B)).toBeNull();
      expect(await value(SALES_B, SQL.dealDues, [DEAL])).toBeNull();
      const otherList = await value<{ items: Array<{ dealId: string }> }>(SALES_B, SQL.dues, [JSON.stringify({}), null, 50]);
      expect((otherList?.items ?? []).map((x) => x.dealId)).not.toContain(DEAL);

      // P, F, V, other entity, anonymous: null on every read.
      for (const actor of [PURCHASE, FLIGHT, VISA, OTHER_ENTITY, ANON]) {
        const who = actor.userId ?? 'anon';
        expect(await rec(actor), `records ${who}`).toBeNull();
        expect(await value(actor, SQL.recordsTotals, [JSON.stringify({})]), `totals ${who}`).toBeNull();
        expect(await value(actor, SQL.dailyCheck, []), `daily ${who}`).toBeNull();
        expect(await value(actor, SQL.dealDues, [DEAL]), `deal dues ${who}`).toBeNull();
        expect(await value(actor, SQL.payables, [DEAL]), `payables ${who}`).toBeNull();
        const list = await value<{ items: unknown[] } | null>(actor, SQL.dues, [JSON.stringify({}), null, 50]);
        expect(list === null || list.items.length === 0, `dues ${who}`).toBe(true);
      }
      expect(await value(PURCHASE, SQL.dues, [JSON.stringify({}), null, 50])).toBeNull();
      expect(await value(FLIGHT, SQL.dues, [JSON.stringify({}), null, 50])).toBeNull();
      expect(await value(VISA, SQL.dues, [JSON.stringify({}), null, 50])).toBeNull();
    });
  });

  it('Accounts + Purchase is not A; a Manager holding Purchase, Flight or Visa gets nothing (AL7)', async () => {
    await asOwner(db, async () => {
      await scenario();
      await h.addRole(U.accountsJodhpur, 'purchase');
      expect(await rec(ACC)).toBeNull();
      expect(await value(ACC, SQL.dailyCheck, [])).toBeNull();
      expect(await value(ACC, SQL.dealDues, [DEAL])).toBeNull();
      expect(await value(ACC, SQL.dues, [JSON.stringify({}), null, 50])).toBeNull();
    });
    for (const role of ['flight', 'purchase', 'visa']) {
      await asOwner(db, async () => {
        await scenario();
        await h.addRole(U.managerDelhi, role, 'DEL');
        expect(await rec(MANAGER), `M+${role}`).toBeNull();
        expect(await value(MANAGER, SQL.dues, [JSON.stringify({}), null, 50]), `M+${role} dues`).toBeNull();
        expect(await value(MANAGER, SQL.dealDues, [DEAL]), `M+${role} deal dues`).toBeNull();
      });
    }
  });

  it('AL8: the Manager of the collecting branch sees that receipt, its deposit and cash count; dues stay with the Deal branch', async () => {
    await asOwner(db, async () => {
      const k = await scenario();
      await h.addRole(U.managerAhmedabad, 'manager', 'JDH');
      const rows = (await rec(M_JDH))!.items;
      const got = rows.map((r) => r.rowId);
      expect(got).toEqual(expect.arrayContaining([`receipt:${k.cash.id}`, `cash_deposit:${k.deposit.id}`, `cash_count:${k.count.id}`]));
      expect(got, 'a receipt collected in Delhi is not the Jodhpur Manager\'s').not.toContain(`receipt:${k.bank.id}`);
      expect(await value(M_JDH, SQL.dealDues, [DEAL]), 'dues belong to the Deal branch (R16.9)').toBeNull();
      // The Delhi Manager sees the Jodhpur-collected receipt of the Delhi Deal too.
      expect((await rec(MANAGER))!.items.map((r) => r.rowId)).toContain(`receipt:${k.cash.id}`);
    });
  });

  it('a Manager cannot widen to another branch with branchId', async () => {
    await asOwner(db, async () => {
      await scenario();
      const r = await h.attempt<WorkPage | null>(MANAGER, SQL.records, [JSON.stringify({ branchId: await h.branchId('AMD') }), null, 50]);
      expect(!r.ok || r.value === null || r.value.items.length === 0).toBe(true);
    });
  });
});

describe('12.4 privacy leak scan', () => {
  it('workspace rows (A and M) carry no PAN, mobile, passport, payer name or selling total', async () => {
    await asOwner(db, async () => {
      await scenario();
      for (const actor of [ACC, MANAGER]) {
        const rows = await h.allRecords(actor);
        const text = JSON.stringify(rows);
        for (const [what, v] of Object.entries({ pan: SENTINEL.pan, panCash: SENTINEL.panCash, mobile: SENTINEL.mobile, passport: SENTINEL.passport,
          selling: SELLING })) {
          expect(containsToken(text, v), `${what} in workspace rows as ${actor.userId}`).toBe(false);
        }
        expect(text).not.toContain(SENTINEL.payerName);
        expect([...allKeys(rows)].filter((key) => /pan|mobile|passport|payer|selling|margin|quot/i.test(key))).toEqual([]);
      }
    });
  });

  it('audit rows written by the new commands carry ids, kinds and counts only', async () => {
    await asOwner(db, async () => {
      const k = await scenario();
      const rows = await owner<{ action: string; details: unknown }>(
        `select action, details from public.audit_events
         where action like 'accounts.%' or action like 'notice.%' or action like 'supplier.%' or action like 'settings.accounts%'
            or action like 'settings.notices%' or action = 'purchase.booking_change_seen'`);
      expect(rows.length).toBeGreaterThan(0);
      const text = JSON.stringify(rows.map((r) => r.details));
      for (const v of [SENTINEL.pan, SENTINEL.panCash, SENTINEL.mobile, SENTINEL.passport, k.pnr, k.ticket, '2500000', '1000000', 'HC/25-26/0042']) {
        expect(containsToken(text, v), `audit details leak ${v}`).toBe(false);
      }
      expect(text).not.toContain(SENTINEL.payerName);
    });
  });
});
