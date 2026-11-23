import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ANON, FLIGHT_ITEM, HOTEL_ITEM, OTHER_ENTITY, SALES_B, SELLING, SENTINEL, VISA, containsToken } from './acc-support';
import {
  ACC, DEAL, FLIGHT, MANAGER, MANAGER_AMD, OWNER, P2, PURCHASE, SENTINEL2, SQL2, acc2Helpers, landed, readOrNull, rid, waits,
} from './acc2-support';

/**
 * Accounts Phase 2 contract section 10 (fences) and test plan 12.1 "Fence
 * leak", Track F. Every new read as A, A+P, M, M+F, SO, other Sales, P, F, V,
 * another entity and anonymous, with sentinel values (selling total, refund
 * amount, payer name, PAN, account number). P/F/V are null on every
 * customer-side read; Purchase/Flight/Visa workspaces never carry the
 * sentinels; notices, audit details and refusal messages carry no amounts,
 * names, PAN or bank numbers.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = acc2Helpers(() => db);
const { owner } = h;
const READY = landed('customer_documents', 'deal_customer_documents', 'customer_document_get', 'customer_documents_list', 'customer_refund_requests',
  'deal_refunds', 'refund_requests_list', 'supplier_refunds_due');
const REFUND = SENTINEL2.refundAmount; // 1234567 paise

/**
 * DEAL (Delhi): hotel + flight, approved; ₹25,000 from "Synthetic Payer"
 * (PAN ABCDE1234F); ADV and Invoice released; cancellation approved; refund
 * of 1234567 paise requested, approved and paid; a flight batch for FLIGHT.
 * Then Visa Jodhpur loses the scenario's Accounts membership (a pure Visa person).
 */
async function scenario() {
  await h.people.flight();
  const b = await h.approvedDeal([HOTEL_ITEM, FLIGHT_ITEM]);
  await h.docsOn();
  const rec = await h.receipt2('2500000');
  const adv = await h.releasedAdvance(rec.id);
  const inv = await h.releasedInvoice();
  const batch = await h.flightBatch(DEAL, [1]);
  await h.refundsOn();
  const cancellationId = await h.openCancellation();
  await h.one(FLIGHT, SQL2.flightChargeSet, [batch.batchId, JSON.stringify({ airlineChargePaise: '100000', refundExpectedPaise: '0', refundReportedPaise: null,
    note: 'Synthetic airline fee' }), 0, rid()]).catch(() => undefined);
  const c = (await h.cancellationOf())!;
  if (c.status !== 'open') await h.one(FLIGHT, SQL2.cancelSend, [cancellationId, c.row_version, rid()]).catch(() => undefined);
  const c2 = (await h.cancellationOf())!;
  await h.one(MANAGER, SQL2.cancelDecide, [cancellationId, 'approve', null, c2.row_version, rid()]);
  const r = await h.requestRefund(h.refundFields({ payeeReceiptId: rec.id, amountPaise: REFUND }));
  await h.decideRefund(r.id, 'approve');
  await h.payout(r.id);
  await h.dropRole(U.visaJodhpur, 'accounts');
  await h.people.fixtures('visaJodhpur2', 'managerFlightDelhi', 'flightJodhpur');
  return { b, rec, adv, inv, refund: r, batch };
}

describe.skipIf(!READY)(`section 10 fences${READY ? '' : ` — ${waits('B/C', 'customer_documents, customer_refund_requests …')}`}`, () => {
  it('customer documents and refunds per reader', async () => {
    await asOwner(db, async () => {
      const k = await scenario();
      const reads = (deal = DEAL) => ({
        dealDocs: [SQL2.dealDocs, [deal]] as const,
        docGet: [SQL2.docGet, [k.inv.id]] as const,
        docsList: [SQL2.docsList, [JSON.stringify({}), null, 50]] as const,
        dealRefunds: [SQL2.dealRefunds, [deal]] as const,
        refundList: [SQL2.refundList, [JSON.stringify({}), null, 50]] as const,
        supplierRefundsDue: [SQL2.supplierRefundsDue, [JSON.stringify({}), null, 50]] as const,
      });
      const val = async (actor: Actor, key: keyof ReturnType<typeof reads>) => {
        const [sql, params] = reads()[key];
        const p = [...params];
        return readOrNull<Record<string, unknown>>(h, actor, sql, p);
      };
      // A: everything.
      for (const key of ['dealDocs', 'docGet', 'docsList', 'dealRefunds', 'refundList', 'supplierRefundsDue'] as const) {
        expect(await val(ACC, key), `A ${key}`).not.toBeNull();
      }
      // M (Delhi): read; no A-only lists (supplier refunds due, mapping).
      for (const key of ['dealDocs', 'docGet', 'docsList', 'dealRefunds', 'refundList'] as const) expect(await val(MANAGER, key), `M ${key}`).not.toBeNull();
      expect(await val(MANAGER, 'supplierRefundsDue')).toBeNull();
      if (landed('tally_mapping_list')) expect(await readOrNull(h, MANAGER, SQL2.mappingList, [await h.entityId()])).toBeNull();
      // Manager of another branch: nothing of this Deal.
      expect(await val(MANAGER_AMD, 'dealDocs')).toBeNull();
      expect(await val(MANAGER_AMD, 'dealRefunds')).toBeNull();
      // SO: own Deal's documents (released only) and refunds; no Accounts lists.
      const so = (await val(OWNER, 'dealDocs')) as { viewer: string; candidates?: unknown; documents: Array<{ status: string; can: Record<string, boolean> }> };
      expect(so.viewer).toBe('sales');
      expect(so.candidates ?? null, 'candidates are A only').toBeNull();
      expect(so.documents.every((d) => d.status !== 'draft')).toBe(true);
      expect(so.documents.every((d) => !d.can.release && !d.can.cancel && !d.can.replace)).toBe(true);
      expect(await val(OWNER, 'dealRefunds')).not.toBeNull();
      expect(await val(OWNER, 'docsList')).toBeNull();
      expect(await val(OWNER, 'supplierRefundsDue')).toBeNull();
      // Other Sales: nothing of this Deal.
      for (const key of ['dealDocs', 'docGet', 'dealRefunds'] as const) expect(await val(SALES_B, key), `other Sales ${key}`).toBeNull();
      const otherList = (await val(SALES_B, 'refundList')) as { items: Array<{ dealId: string }> } | null;
      expect((otherList?.items ?? []).map((x) => x.dealId)).not.toContain(DEAL);
      // P, F, V, another entity, anonymous: null on every customer-side read.
      for (const actor of [PURCHASE, FLIGHT, VISA, P2.VISA_2, P2.FLIGHT_JDH, P2.MANAGER_FLIGHT_DEL, OTHER_ENTITY, ANON]) {
        for (const key of Object.keys(reads()) as Array<keyof ReturnType<typeof reads>>) {
          const got = await val(actor, key) as { items?: unknown[] } | null;
          // A Sales person of another entity may list "own Deals" (none): an empty page is not a leak.
          if (actor === OTHER_ENTITY && got && Array.isArray(got.items)) expect(got.items, `${key} other entity`).toEqual([]);
          else expect(got, `${actor.userId ?? 'anon'} ${key}`).toBeNull();
        }
        if (landed('tally_mapping_list')) expect(await readOrNull(h, actor, SQL2.mappingList, [await h.entityId()])).toBeNull();
        await h.refused(actor, SQL2.docDownload, [k.adv.id], 'not_authorized').catch(async () => {
          const r = await h.attempt(actor, SQL2.docDownload, [k.adv.id]);
          expect(r.ok, `${actor.userId ?? 'anon'} download`).toBe(false);
        });
      }
    });
  });

  it('Accounts + Purchase is not A; a Manager holding Flight, Purchase or Visa is not M (AL7)', async () => {
    await asOwner(db, async () => {
      await scenario();
      await h.addRole(U.accountsJodhpur, 'purchase');
      for (const sql of [SQL2.dealDocs, SQL2.dealRefunds]) expect(await readOrNull(h, ACC, sql, [DEAL]), `A+P ${sql}`).toBeNull();
      expect(await readOrNull(h, ACC, SQL2.docsList, [JSON.stringify({}), null, 50])).toBeNull();
    });
    for (const role of ['flight', 'purchase', 'visa']) {
      await asOwner(db, async () => {
        await scenario();
        await h.addRole(U.managerDelhi, role, 'DEL');
        for (const sql of [SQL2.dealDocs, SQL2.dealRefunds]) expect(await readOrNull(h, MANAGER, sql, [DEAL]), `M+${role} ${sql}`).toBeNull();
      });
    }
  });

  it('department workspaces, notices, audit details and refusals never carry the sentinels', async () => {
    await asOwner(db, async () => {
      const k = await scenario();
      await h.noticesOn();
      const sentinels: Record<string, string> = { selling: SELLING, refund: REFUND, pan: SENTINEL.pan, payer: SENTINEL.payerName, account: SENTINEL2.accountNumber };
      const scan = (label: string, value: unknown, keys: string[] = Object.keys(sentinels)) => {
        const text = JSON.stringify(value ?? null);
        for (const key of keys) {
          const v = sentinels[key]!;
          expect(/^[0-9]+$/.test(v) ? containsToken(text, v) : text.includes(v), `${label} carries ${key}`).toBe(false);
        }
      };
      scan('flight_money (Flight)', await readOrNull(h, FLIGHT, SQL2.flightMoney, [DEAL]));
      scan('purchase workspace', await readOrNull(h, PURCHASE, SQL2.workspace, [h.taskOf(k.b, 'hotel')]));
      scan('cancellation summary (Purchase)', await readOrNull(h, PURCHASE, SQL2.cancelSummary, [DEAL]));
      // Notices: params of every row, and the inbox of every reader.
      scan('notice params', (await h.notices()).map((n) => n.params));
      for (const actor of [ACC, MANAGER, OWNER, PURCHASE, FLIGHT]) scan(`inbox ${actor.userId}`, await readOrNull(h, actor, SQL2.inbox, [null, 100]), ['refund', 'pan', 'payer', 'account']);
      // Audit details of the Phase 2 actions.
      const audit = await owner<{ action: string; details: unknown }>(`select action, details from public.audit_events
        where action like 'accounts.customer_document.%' or action like 'refund.%' or action like 'accounts.supplier_refund.%'
           or action like 'accounts.refund_evidence.%' or action like 'flight.cancellation%' or action like 'visa.cancellation%'
           or action like 'supplier.%' or action = 'accounts.tally_mapping_changed'`);
      expect(audit.length).toBeGreaterThan(0);
      scan('audit details', audit.map((a) => a.details));
      expect(JSON.stringify(audit.map((a) => a.details))).not.toContain('2500000');
      // A refusal message is the token only (no amounts).
      const r = await h.attempt(OWNER, SQL2.refundCreate, [DEAL, JSON.stringify(h.refundFields({ payeeReceiptId: k.rec.id, amountPaise: '99999999' })), rid()]);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatch(/^[a-z_]+$/);
        scan('refusal', [r.error, r.hint ?? '']);
      }
    });
  });
});
