import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, resetActor, setActor } from '../helpers/db';
import {
  ACC, DEAL, DEAL2, FLIGHT, FLIGHT_2, FLIGHT_ITEM, HOTEL_ITEM, MANAGER, MANAGER_AMD, OWNER, PURCHASE, SALES_B, SQL, TRANSFER_ITEM, VISA, accHelpers,
  rid, today,
} from './acc-support';

/**
 * Accounts phase, Track B additions approved by the lead (contract.md
 * addendum B2, migration 20261203000260), Track E:
 *   - supplier_document_link_targets(document): Accounts of the entity see
 *     every eligible task (same supplier, not the bill's own task) and the
 *     active links; the S1 assignee path sees only the caller's own tasks
 *     while the bill is uploaded; everyone else null;
 *   - accounts_filter_options(): fenced like the workspace (A entity, M own
 *     branches; Accounts + Purchase, Manager + Purchase/Flight/Visa, Sales,
 *     Purchase, Flight, Visa null);
 *   - duplicate_supplier_document carries DETAIL existingDocumentId=<id> only
 *     when the caller may read that bill.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = accHelpers(() => db);
const { one } = h;
const PURCHASE_2: Actor = { userId: U.movedStaff };
const TARGETS = 'select public.supplier_document_link_targets($1) as r';
const OPTIONS = 'select public.accounts_filter_options() as r';
/** Every taskId string anywhere in a JSON value. */
const taskIds = (v: unknown): string[] => {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) { if (k === 'taskId' && typeof y === 'string') out.push(y); walk(y); }
  };
  walk(v);
  return out;
};
const value = async <T>(actor: Actor, sql: string, params: unknown[] = []) => {
  const r = await h.attempt<T>(actor, sql, params);
  return r.ok ? r.value : null;
};
/** The refusal's message, hint and detail (savepoint keeps the transaction usable). */
async function refusal(actor: Actor, sql: string, params: unknown[]) {
  await db.exec('savepoint acc_detail');
  try {
    await setActor(db, actor);
    await db.query(sql, params);
    throw new Error('expected a refusal');
  } catch (e) {
    await db.exec('rollback to savepoint acc_detail');
    await resetActor(db);
    const err = e as { message: string; code?: string; hint?: string; detail?: string };
    return { message: err.message, code: err.code, hint: err.hint, detail: err.detail ?? null };
  }
}

/** Hotel tasks on DEAL (PURCHASE) and DEAL2 (PURCHASE_2) with one supplier; a transfer task on DEAL2 with another supplier. */
async function bills() {
  await h.addAcc2();
  await h.addRole(U.movedStaff, 'purchase');
  const a = await h.book([HOTEL_ITEM]);
  const b = await h.book([HOTEL_ITEM, TRANSFER_ITEM], { deal: DEAL2, actor: SALES_B });
  await h.approve(a.versionId);
  await h.approve(b.versionId);
  const supplierId = await h.purchaseSupplier();
  const other = await h.purchaseSupplier();
  const taskA = h.taskOf(a, 'hotel');
  const taskB = h.taskOf(b, 'hotel');
  const taskOther = h.taskOf(b, 'transfer');
  await h.purchaseCost(taskA, supplierId);
  await h.purchaseCost(taskB, supplierId, '10000000', PURCHASE_2);
  await h.purchaseCost(taskOther, other);
  const doc = await h.uploadDoc(taskA, { number: 'SYN-LT-1' });
  return { taskA, taskB, taskOther, doc, supplierId };
}

describe('B2 supplier_document_link_targets fence', () => {
  it('Accounts: eligible tasks of the same supplier only; the S1 assignee path: own tasks only while uploaded; others null', async () => {
    await asOwner(db, async () => {
      const s = await bills();
      const acc = await one<unknown>(ACC, TARGETS, [s.doc.id]);
      expect(taskIds(acc)).toContain(s.taskB);
      expect(taskIds(acc), 'other supplier').not.toContain(s.taskOther);
      // The assignee of the target task (PURCHASE_2) sees that task; PURCHASE (not its assignee) does not.
      expect(taskIds(await value(PURCHASE_2, TARGETS, [s.doc.id]))).toContain(s.taskB);
      expect(taskIds(await value(PURCHASE, TARGETS, [s.doc.id]))).not.toContain(s.taskB);
      // PURCHASE_2 is Moved Staff, so the Flight reader here is Sales Ahmedabad with a Flight role.
      await h.addRole(U.salesAhmedabad, 'flight');
      // (Visa Jodhpur is the second Accounts person in this scenario, so it is not a "no access" reader here.)
      for (const actor of [MANAGER, OWNER]) expect(await value(actor, TARGETS, [s.doc.id]), String(actor.userId)).toBeNull();
      // A Flight person with no eligible task gets an empty result (Track B returns an object, not null: reported to the lead).
      const flight = await value<{ items?: unknown[]; links?: unknown[] }>(FLIGHT_2, TARGETS, [s.doc.id]);
      expect(flight === null || (taskIds(flight).length === 0 && (flight.links ?? []).length === 0)).toBe(true);
      // Linked: the active link is listed for Accounts.
      await one(ACC, SQL.docLink, [s.doc.id, s.taskB, rid()]);
      const after = await one<{ links?: unknown[] }>(ACC, TARGETS, [s.doc.id]);
      expect(JSON.stringify(after.links ?? after)).toContain(s.taskB);
      // Accepted bill: only Accounts keeps the list (the S1 assignee path ends once reviewed).
      await h.reviewDoc(s.doc.id, 'accept', null, { userId: U.visaJodhpur });
      expect(taskIds(await value(PURCHASE_2, TARGETS, [s.doc.id]))).not.toContain(s.taskB);
      expect(await one(ACC, TARGETS, [s.doc.id])).not.toBeNull();
      expect(JSON.stringify(acc)).not.toMatch(/10000000|SYN-LT-1.*Paise/);
    });
  });
});

describe('B2 accounts_filter_options fence', () => {
  it('A: the entity; M: own branches; Purchase, Flight, Visa, Sales and mixed roles: null', async () => {
    await asOwner(db, async () => {
      await h.book([HOTEL_ITEM]);
      const del = await h.branchId('DEL');
      const amd = await h.branchId('AMD');
      const a = await one<{ branches: Array<{ branchId: string }> }>(ACC, OPTIONS, []);
      expect(a.branches.map((b) => b.branchId)).toEqual(expect.arrayContaining([del, amd]));
      const m = await one<{ branches: Array<{ branchId: string }> }>(MANAGER, OPTIONS, []);
      expect(m.branches.map((b) => b.branchId)).toEqual([del]);
      const mAmd = await one<{ branches: Array<{ branchId: string }> }>(MANAGER_AMD, OPTIONS, []);
      expect(mAmd.branches.map((b) => b.branchId)).not.toContain(del);
      await h.addFlightPeople();
      for (const actor of [OWNER, PURCHASE, FLIGHT, VISA]) expect(await value(actor, OPTIONS), String(actor.userId)).toBeNull();
      const text = JSON.stringify(a);
      expect(text).not.toMatch(/@example\.test|paise|Paise/);
    });
    for (const [user, role, branch] of [[U.accountsJodhpur, 'purchase', 'JDH'], [U.managerDelhi, 'flight', 'DEL']] as const) {
      await asOwner(db, async () => {
        await h.addRole(user, role, branch);
        expect(await value({ userId: user }, OPTIONS), `${user} + ${role}`).toBeNull();
      });
    }
  });
});

describe('B2 existingDocumentId on duplicate refusals', () => {
  it('Purchase uploader who may read the bill gets the id; a Flight person of another Deal gets no detail', async () => {
    await asOwner(db, async () => {
      const s = await bills();
      const ev = await h.moneyFile(PURCHASE, s.taskA, 'invoice');
      const mine = await refusal(PURCHASE, SQL.docUpload, [s.taskA, JSON.stringify({ kind: 'invoice', number: 'syn lt 1', docDate: today(),
        totalPaise: '100000', gstIncluded: true, evidenceId: ev }), rid()]);
      expect(mine).toMatchObject({ message: 'duplicate_supplier_document', code: '23505', hint: 'number', detail: `existingDocumentId=${s.doc.id}` });
    });
    await asOwner(db, async () => {
      await h.addFlightPeople();
      await h.addAcc2();
      await h.book([HOTEL_ITEM, FLIGHT_ITEM]);
      await h.book([HOTEL_ITEM, FLIGHT_ITEM], { deal: DEAL2, actor: SALES_B });
      const first = await h.flightBatch(DEAL, [1]);
      await h.claim(FLIGHT_2, DEAL2);
      const t2 = (await h.owner<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'flight'`, [DEAL2]))[0]!.id;
      const [leg2] = await h.sectors(t2);
      await h.confirmTickets({ deal: DEAL2, sectorIds: [leg2!.id], supplierId: first.supplierId, seqs: [1], actor: FLIGHT_2 });
      const upload = async (actor: Actor, task: string) => {
        const evidenceId = await h.moneyFile(actor, task, 'invoice');
        return [task, JSON.stringify({ kind: 'invoice', number: 'SYN-AIR-77', docDate: today(), totalPaise: '600000', gstIncluded: false, evidenceId,
          supplierId: first.supplierId }), rid()];
      };
      await one(FLIGHT, SQL.docUpload, await upload(FLIGHT, first.flightTask));
      const [docRow] = await h.owner<{ id: string }>(`select id from public.supplier_documents where number = 'SYN-AIR-77'`);
      const other = await refusal(FLIGHT_2, SQL.docUpload, await upload(FLIGHT_2, t2));
      expect(other).toMatchObject({ message: 'duplicate_supplier_document', code: '23505', detail: null });
      const same = await refusal(FLIGHT, SQL.docUpload, await upload(FLIGHT, first.flightTask));
      expect(same.detail).toBe(`existingDocumentId=${docRow!.id}`);
    });
  });
});
