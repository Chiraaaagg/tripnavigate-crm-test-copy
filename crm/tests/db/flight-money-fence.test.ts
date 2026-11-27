import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, type TestDb, asOwner, createTestDb } from '../helpers/db';
import {
  ACC, DEAL, DEAL2, FIXTURE_COMMERCIALS, FLIGHT, FLIGHT_2, LEG_DEL_GOI, LEG_JDH_DEL, MANAGER, OWNER, PURCHASE, SALES_B, SELLING, SQL, VISA, allKeys,
  containsToken, fare, flightHelpers, rid, ticketFor, typedFlight,
} from './flight-support';

/**
 * Flight build, test plan 12.2 (money-fence leak test) and contract section
 * 9.3 table: every flight read called as F (Flight, not assignee), FA (the
 * assignee), M, A, SO (package and flight-only), S (another Sales reader of
 * the Deal), P and V:
 *   - P and V get null / nothing for every flight read and no flight money;
 *   - S gets no flight_money at all;
 *   - SO gets the reduced object (budget, supplier cost, payment state only;
 *     per-person fares only on flight-only Deals);
 *   - package batches never carry markup / discount / customer keys for
 *     anyone, and their DB rows hold nulls;
 *   - no read carries the booking selling price, receipts, funding amount or
 *     reason, or bank values; History and audit details carry no paise, PNR
 *     or ticket number values.
 * Synthetic distinctive values make any leak visible in the JSON text.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = flightHelpers(() => db);
const { one, owner } = h;

// Distinctive synthetic values.
const ADULT_BASIC = '512347'; // basic fare per adult
const MARKUP = '43219';
const DISCOUNT = '12347';
const PNR = 'FNC123';
const CRS_PNR = 'FNC789';
const TICKET = '098-3131313131';
const TICKET_FO = '098-3232323232';
const BANK_ACCOUNT = '000033334444';
const BANK_IFSC = 'SYNB0000001';
const MONEY_KEY = /paise|markup|discount|fare|amount|budget|cost|price|selling|margin|receipt|funding|bank|ifsc|account/i;

type Scenario = { pkgTask: string; foTask: string; pkgBatch: string; foBatch: string; pkgSupplierCost: string; foSupplierCost: string; foCustomer: string };

/**
 * Package Deal SYN-DEL-001 (owner Sales Delhi A) and flight-only Deal
 * SYN-DEL-002 (owner Sales Delhi B), both taken by FLIGHT; tickets confirmed;
 * the package batch paid directly, the flight-only batch by a payment request.
 * Sales Delhi B is also an assigned Sales reader of SYN-DEL-001 (S) and Sales
 * Delhi A of SYN-DEL-002.
 */
async function scenario(): Promise<Scenario> {
  // No second Accounts person here: Visa Jodhpur must stay a pure Visa reader (V).
  await h.addFlightPeople();
  const pkg = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL, LEG_DEL_GOI]), budget: '99999999' }]);
  const fo = await h.flightOnlyDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]), budget: '99999999' }], { deal: DEAL2, actor: SALES_B });
  await h.addSalesAssignee(DEAL, SALES_B.userId!);
  await h.addSalesAssignee(DEAL2, OWNER.userId!);
  await h.claim(FLIGHT, DEAL);
  await h.claim(FLIGHT, DEAL2);
  const supplierId = await h.flightSupplier();
  const rev = await one<{ revisionNo: number }>(FLIGHT, SQL.supplierBeneficiary, [supplierId, rid(),
    JSON.stringify({ accountHolder: 'Synthetic Air Ltd', bankName: 'Synthetic Bank', ifsc: BANK_IFSC, accountNumber: BANK_ACCOUNT })]);
  await one(MANAGER, SQL.supplierApproveBeneficiary, [supplierId, rev.revisionNo]);
  const pkgLegs = await h.sectors(pkg.flightTasks[0]!);
  const pkgBatch = await one<{ batchId: string }>(FLIGHT, SQL.ticketsConfirm, [DEAL, JSON.stringify({ sectorIds: pkgLegs.map((s) => s.id), supplierId,
    fareApprovalId: null, fares: [fare('adult', { basicPaise: ADULT_BASIC })],
    travellers: [ticketFor(1, { airlinePnr: PNR, crsPnr: CRS_PNR, ticketNumber: TICKET })] }), rid()]);
  await h.directPay(pkgBatch.batchId);
  const [foLeg] = await h.sectors(fo.flightTasks[0]!);
  const foBatch = await one<{ batchId: string }>(FLIGHT, SQL.ticketsConfirm, [DEAL2, JSON.stringify({ sectorIds: [foLeg!.id], supplierId,
    fareApprovalId: null, fares: [fare('adult', { basicPaise: ADULT_BASIC, markupPaise: MARKUP, discountPaise: DISCOUNT })],
    travellers: [ticketFor(1, { ticketNumber: TICKET_FO })] }), rid()]);
  await one(FLIGHT, SQL.paymentRequest, [foBatch.batchId, JSON.stringify({ dueDate: h.today(), note: null, proformaEvidenceId: null }), rid()]);
  const supplierCost = String(Number(ADULT_BASIC) + 100_000);
  return { pkgTask: pkg.flightTasks[0]!, foTask: fo.flightTasks[0]!, pkgBatch: pkgBatch.batchId, foBatch: foBatch.batchId,
    pkgSupplierCost: supplierCost, foSupplierCost: supplierCost, foCustomer: String(Number(supplierCost) + Number(MARKUP) - Number(DISCOUNT)) };
}

const value = async (actor: Actor, sql: string, params: unknown[] = []) => {
  const r = await h.attempt(actor, sql, params);
  return r.ok ? r.value : null;
};
/** Every flight read for one actor (null when refused or not available). */
async function reads(actor: Actor, s: Scenario): Promise<Record<string, unknown>> {
  return {
    queue: await value(actor, SQL.queue),
    workspacePkg: await value(actor, SQL.workspace, [DEAL]),
    workspaceFo: await value(actor, SQL.workspace, [DEAL2]),
    moneyPkg: await value(actor, SQL.money, [DEAL]),
    moneyFo: await value(actor, SQL.money, [DEAL2]),
    contextPkg: await value(actor, SQL.paymentContext, [s.pkgBatch]),
    contextFo: await value(actor, SQL.paymentContext, [s.foBatch]),
    summaryPkg: await value(actor, SQL.dealSummary, [DEAL]),
    summaryFo: await value(actor, SQL.dealSummary, [DEAL2]),
    historyPkg: await value(actor, SQL.dealHistory, [DEAL]),
    historyFo: await value(actor, SQL.dealHistory, [DEAL2]),
    homeCounts: await value(actor, SQL.homeCounts),
    taskHistoryPkg: await value(actor, SQL.taskHistory, [s.pkgTask]),
    taskHistoryFo: await value(actor, SQL.taskHistory, [s.foTask]),
    managerApprovals: await value(actor, SQL.managerApprovals),
    accountsPayments: await value(actor, SQL.accountsPayments, ['all']),
    accountsDocuments: await value(actor, SQL.accountsDocuments, ['all']),
    smHomeCounts: await value(actor, SQL.smHomeCounts),
    supplierList: await value(actor, SQL.supplierList),
  };
}
const NEVER = [SELLING, ...FIXTURE_COMMERCIALS, BANK_ACCOUNT, BANK_IFSC];

describe('flight money fence', () => {
  it('Purchase and Visa get no flight read and no flight money anywhere', async () => {
    await asOwner(db, async () => {
      const s = await scenario();
      for (const actor of [PURCHASE, VISA]) {
        const r = await reads(actor, s);
        for (const key of ['workspacePkg', 'workspaceFo', 'moneyPkg', 'moneyFo', 'contextPkg', 'contextFo', 'summaryPkg', 'summaryFo', 'historyPkg',
          'historyFo', 'taskHistoryPkg', 'taskHistoryFo']) {
          expect(r[key], `${actor.userId} ${key}`).toBeNull();
        }
        const groups = (r.queue as { groups?: unknown[] } | null)?.groups ?? [];
        expect(groups, `${actor.userId} queue`).toEqual([]);
        expect(((r.managerApprovals as { flightFares?: unknown[] } | null)?.flightFares ?? []), `${actor.userId} approvals`).toEqual([]);
        const text = JSON.stringify(r);
        for (const v of [s.pkgSupplierCost, s.foSupplierCost, s.foCustomer, ADULT_BASIC, MARKUP, DISCOUNT, ...NEVER]) {
          expect(containsToken(text, v), `${actor.userId} sees ${v}`).toBe(false);
        }
        // Purchase's own reads of the Deal never gain flight money.
        if (actor === PURCHASE) {
          const list = JSON.stringify(await value(PURCHASE, 'select public.purchase_task_list() as r'));
          for (const v of [s.pkgSupplierCost, ADULT_BASIC]) expect(containsToken(list, v)).toBe(false);
        }
      }
    });
  });

  it('other Sales get no flight_money; the Sales owner gets the reduced object; F, FA, M and A the full one', async () => {
    await asOwner(db, async () => {
      const s = await scenario();
      // S: another Sales reader of each Deal.
      expect(await value(SALES_B, SQL.money, [DEAL])).toBeNull();
      expect(await value(OWNER, SQL.money, [DEAL2])).toBeNull();
      // SO package: budget and supplier cost vs budget, payment state only; no fares, routes, ids, totals or approvals.
      const so = (await value(OWNER, SQL.money, [DEAL])) as Record<string, unknown>;
      expect(so).toMatchObject({ dealKind: 'package', supplierCostPaise: s.pkgSupplierCost, overBudget: false });
      const soKeys = allKeys(so);
      for (const k of ['supplierTotals', 'approvals', 'invoices', 'basicPaise', 'kPaise', 'route', 'refNo', 'returnReason', 'entryId', 'paymentId',
        'entryRowVersion', 'paymentRowVersion', 'canPayDirect', 'canRequest', 'markupPaise', 'discountPaise', 'customerTotalPaise']) {
        expect(soKeys.has(k), `package SO key ${k}`).toBe(false);
      }
      expect(containsToken(JSON.stringify(so), ADULT_BASIC)).toBe(false);
      // SO flight-only: per-person fares, markup/discount and customer totals, still no payment internals.
      const soFo = (await value(SALES_B, SQL.money, [DEAL2])) as Record<string, unknown>;
      expect(soFo).toMatchObject({ dealKind: 'flight_only', customerTotalPaise: s.foCustomer });
      const soFoKeys = allKeys(soFo);
      for (const k of ['basicPaise', 'markupPaise', 'discountPaise']) expect(soFoKeys.has(k), `flight-only SO key ${k}`).toBe(true);
      for (const k of ['route', 'refNo', 'paymentId', 'canRequest', 'supplierTotals', 'approvals']) expect(soFoKeys.has(k), `flight-only SO key ${k}`).toBe(false);
      // FA: everything, with the action ids.
      const fa = (await value(FLIGHT, SQL.money, [DEAL])) as { batches: Array<Record<string, unknown>> };
      expect(fa.batches[0]).toMatchObject({ canPayDirect: false, canRequest: false });
      expect(allKeys(fa).has('supplierTotals')).toBe(true);
      expect(allKeys(fa).has('entryId')).toBe(true);
      // F (not the assignee), M and A: fares and totals, never the action ids.
      for (const actor of [MANAGER, ACC, FLIGHT_2]) {
        const m = (await value(actor, SQL.money, [DEAL])) as Record<string, unknown>;
        expect(m, `${actor.userId} money`).not.toBeNull();
        const keys = allKeys(m);
        expect(keys.has('basicPaise'), `${actor.userId} basicPaise`).toBe(true);
        for (const k of ['entryId', 'entryRowVersion', 'paymentId', 'paymentRowVersion', 'canPayDirect', 'canRequest']) {
          expect(keys.has(k), `${actor.userId} ${k}`).toBe(false);
        }
      }
      // Payment context: the assignee only.
      for (const actor of [OWNER, SALES_B, MANAGER, ACC, FLIGHT_2]) expect(await value(actor, SQL.paymentContext, [s.pkgBatch]), `${actor.userId} context`).toBeNull();
      expect(await value(FLIGHT, SQL.paymentContext, [s.pkgBatch])).not.toBeNull();
    });
  });

  it('package batches never carry markup, discount or customer values for anyone; the rows hold nulls', async () => {
    await asOwner(db, async () => {
      const s = await scenario();
      expect(await owner(`select markup_paise, discount_paise from public.flight_batch_fares where batch_id = $1`, [s.pkgBatch]))
        .toEqual([{ markup_paise: null, discount_paise: null }]);
      expect(await owner('select customer_total_paise from public.flight_ticket_batches where id = $1', [s.pkgBatch])).toEqual([{ customer_total_paise: null }]);
      for (const actor of [FLIGHT, FLIGHT_2, MANAGER, ACC, OWNER]) {
        const m = await value(actor, SQL.money, [DEAL]);
        const keys = allKeys(m);
        for (const k of ['markupPaise', 'discountPaise', 'customerTotalPaise', 'customerAmountPaise', 'totalPerPersonPaise']) {
          expect(keys.has(k), `${actor.userId} package ${k}`).toBe(false);
        }
      }
    });
  });

  it('no flight read carries selling price, receipts, funding or bank values; workspace, summary and history carry no money keys', async () => {
    await asOwner(db, async () => {
      const s = await scenario();
      const fundingReasons = (await owner<{ reason: string | null }>('select reason from public.company_funding_requests')).map((r) => r.reason).filter(Boolean) as string[];
      // A funding amount equal to a batch supplier cost (no customer money on the Deal) is legitimately visible as that cost.
      const fundingAmounts = (await owner<{ a: string }>('select amount_paise::text as a from public.company_funding_requests')).map((r) => r.a)
        .filter((a) => a !== s.pkgSupplierCost && a !== s.foSupplierCost);
      for (const actor of [FLIGHT, FLIGHT_2, MANAGER, ACC, OWNER, SALES_B]) {
        const r = await reads(actor, s);
        const flightOnly = { queue: r.queue, workspacePkg: r.workspacePkg, workspaceFo: r.workspaceFo, moneyPkg: r.moneyPkg, moneyFo: r.moneyFo,
          contextPkg: r.contextPkg, contextFo: r.contextFo, summaryPkg: r.summaryPkg, summaryFo: r.summaryFo, historyPkg: r.historyPkg,
          historyFo: r.historyFo, homeCounts: r.homeCounts, taskHistoryPkg: r.taskHistoryPkg, taskHistoryFo: r.taskHistoryFo, supplierList: r.supplierList };
        const text = JSON.stringify(flightOnly);
        for (const v of [...NEVER, ...fundingReasons]) expect(text, `${actor.userId}`).not.toContain(v);
        if (actor !== ACC) for (const v of fundingAmounts) expect(containsToken(text, v), `${actor.userId} funding amount`).toBe(false);
        // Lead-approved addendum (4 Nov 2026, Track A round 2): flight_workspace carries flights[].salesFare, the Sales fare
        // ESTIMATE (cost side), for its readers only (Flight people and the branch Manager). Everyone else reads no workspace.
        const isWorkspaceReader = actor === FLIGHT || actor === FLIGHT_2 || actor === MANAGER;
        for (const k of ['workspacePkg', 'workspaceFo']) {
          if (!isWorkspaceReader) {
            expect(r[k], `${actor.userId} ${k}: not a workspace reader`).toBeNull();
            continue;
          }
          const flights = ((r[k] as { flights?: Array<Record<string, unknown>> } | null)?.flights ?? []);
          for (const f of flights) {
            expect(f, `${actor.userId} ${k} salesFare key`).toHaveProperty('salesFare');
            const fareKeys = [...allKeys(f.salesFare)];
            // An estimate only: never a selling price, markup, discount or customer amount.
            expect(fareKeys.filter((x) => /sell|markup|discount|customer|margin|total/i.test(x)), `${actor.userId} ${k} salesFare keys`).toEqual([]);
          }
          // assigneeUserId is new (addendum): the Manager's reassign form gets the Flight person; Flight people get null.
          const ws = r[k] as { assigneeUserId?: string | null };
          expect(ws.assigneeUserId ?? null, `${actor.userId} ${k} assigneeUserId`).toBe(actor === MANAGER ? FLIGHT.userId : null);
        }
        // Workspace (salesFare set aside, checked above), Deal summary and both histories: no money keys at all.
        const withoutSalesFare = (v: unknown) => {
          const w = v === null || v === undefined ? v : (JSON.parse(JSON.stringify(v)) as { flights?: Array<Record<string, unknown>> });
          for (const f of (w as { flights?: Array<Record<string, unknown>> } | null | undefined)?.flights ?? []) delete f.salesFare;
          return w;
        };
        for (const k of ['workspacePkg', 'workspaceFo', 'summaryPkg', 'summaryFo', 'historyPkg', 'historyFo', 'taskHistoryPkg', 'taskHistoryFo']) {
          const keys = [...allKeys(k.startsWith('workspace') ? withoutSalesFare(r[k]) : r[k])].filter((x) => MONEY_KEY.test(x));
          expect(keys, `${actor.userId} ${k} money keys`).toEqual([]);
        }
        // History never shows PNRs, ticket numbers or paise values.
        const hist = JSON.stringify([r.historyPkg, r.historyFo, r.taskHistoryPkg, r.taskHistoryFo]);
        for (const v of [PNR, CRS_PNR, TICKET, TICKET.replace('-', ''), TICKET_FO, s.pkgSupplierCost, ADULT_BASIC, MARKUP, DISCOUNT]) {
          expect(containsToken(hist, v), `${actor.userId} history ${v}`).toBe(false);
        }
      }
      // Queue: the budget only for Flight and the Manager.
      const q = (await value(FLIGHT, SQL.queue)) as { groups: Array<{ budgetPaise: string | null }> };
      expect(q.groups.length).toBeGreaterThan(0);
      // Audit rows of every flight action: no PNR, number or amount.
      const audit = JSON.stringify(await owner(`select details, reason from public.audit_events where action like 'flight.%' or target_id = any($1::uuid[])`,
        [[s.pkgTask, s.foTask]]));
      for (const v of [PNR, CRS_PNR, TICKET.replace('-', ''), TICKET_FO.replace('-', ''), s.pkgSupplierCost, ADULT_BASIC, MARKUP, DISCOUNT, BANK_ACCOUNT]) {
        expect(containsToken(audit, v), `audit ${v}`).toBe(false);
      }
    });
  });
});
