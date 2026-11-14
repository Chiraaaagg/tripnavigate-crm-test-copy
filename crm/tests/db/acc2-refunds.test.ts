import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, expectDbError } from '../helpers/db';
import { HOTEL_ITEM } from './acc-support';
import {
  ACC, ACC2, DEAL, MANAGER, MANAGER_AMD, OWNER, P2, PURCHASE, REASON, SQL2, SUPER, acc2Helpers, idOf, landed, phase2Sql, rid, today, waits,
} from './acc2-support';

/**
 * Accounts Phase 2 contract section 7 (Track C: refunds, credit-note
 * sources, supplier refunds) and test plan 12.1 "C refunds", Track F.
 * Written from the contract. Owner answers: Q6 one Accounts person records
 * and verifies the payout; requester ≠ approver ≠ payer; Addendum L1 one-step
 * supplier refunds (supplier_refund_cancel); Addendum L5 audit names.
 * Flight/Visa cancellation is in acc2-cancellation.test.ts.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = acc2Helpers(() => db);
const { one, owner } = h;
const READY = landed('customer_refund_requests', 'customer_refund_payouts', 'refund_evidence', 'customer_refund_request_create', 'customer_refund_decide',
  'customer_refund_payout_record', 'deal_refunds', 'refund_requests_list', 'admin_set_refunds_enabled');
const DOCS = landed('customer_documents', 'cdoc_credit_note_source', 'customer_document_draft_create');
const L6 = /shortfallPaise/.test(phase2Sql());
const SREFUND = landed('supplier_refund_receipts', 'supplier_refund_record', 'supplier_refund_cancel');

/** Cancelled package Deal with ₹25,000 verified (payer "Synthetic Payer"); refunds on. */
async function cancelled(amount = '2500000') {
  return h.cancelledWithMoney(amount);
}
const original = (receiptId: string, over: Record<string, unknown> = {}) => h.refundFields({ payeeReceiptId: receiptId, ...over });
type Lines = Array<{ account: string; debit_paise: string; credit_paise: string }>;
const linesOf = (entryId: string) => owner<Lines[number]>(
  `select account, debit_paise::text as debit_paise, credit_paise::text as credit_paise from public.finance_journal_lines where entry_id = $1 order by account`,
  [entryId]);

describe.skipIf(!READY)(`7.2 request rules${READY ? '' : ` — ${waits('C', 'customer_refund_requests …')}`}`, () => {
  it('refunds_off; not_ready without an approved cancellation; limits held − charge; charge_only amount 0', async () => {
    await asOwner(db, async () => {
      await h.approvedDeal([HOTEL_ITEM]);
      const rec = await h.receipt2('2500000');
      await h.refusedToken(OWNER, SQL2.refundCreate, [DEAL, JSON.stringify(original(rec.id)), rid()], 'refunds_off');
      await h.refundsOn();
      await h.refusedToken(OWNER, SQL2.refundCreate, [DEAL, JSON.stringify(original(rec.id)), rid()], 'not_ready');
      await h.openCancellation();
      await h.refusedToken(OWNER, SQL2.refundCreate, [DEAL, JSON.stringify(original(rec.id)), rid()], 'not_ready');
      await h.approveCancellation();
      expect(await h.held()).toBe(2500000n);
      // amount > held − charge
      await h.refusedToken(OWNER, SQL2.refundCreate, [DEAL, JSON.stringify(original(rec.id, { customerChargePaise: '500000', amountPaise: '2000001' })), rid()],
        'refund_exceeds_money', /amountPaise/);
      // payout of 0 is not a payout
      await h.refusedHint(OWNER, SQL2.refundCreate, [DEAL, JSON.stringify(original(rec.id, { amountPaise: '0' })), rid()], 'invalid_input', undefined, '22023');
      // decimals / floats refused
      await h.refusedHint(OWNER, SQL2.refundCreate, [DEAL, JSON.stringify(original(rec.id, { amountPaise: '100.5' })), rid()], 'invalid_input', undefined, '22023');
      // exactly held − charge is fine
      const r = await h.requestRefund(original(rec.id, { customerChargePaise: '500000', amountPaise: '2000000' }));
      expect(r).toMatchObject({ status: 'requested', amount_paise: '2000000', customer_charge_paise: '500000', ref_no: expect.stringMatching(/^RF-[0-9]{4}-[0-9]{6}$/) });
      expect(await h.audits('refund.requested')).toEqual([expect.objectContaining({ details: expect.objectContaining({ refundRequestId: r.id, dealId: DEAL,
        kind: 'cancellation', outcome: 'payout' }) })]);
      // charge_only: amount 0, any charge (customer may owe more).
      await one(OWNER, SQL2.refundWithdraw, [r.id, r.row_version, 'Synthetic: replace with a charge-only settlement', rid()]);
      const co = await h.requestRefund(h.refundFields({ outcome: 'charge_only', amountPaise: '0', customerChargePaise: '9000000', payeeKind: null }));
      expect(co).toMatchObject({ outcome: 'charge_only', amount_paise: '0' });
    });
  });

  it('overpayment: no cancellation; amount ≤ held − basis total (dues credit); charge must be 0', async () => {
    await asOwner(db, async () => {
      await h.approvedDeal([HOTEL_ITEM]);
      await h.refundsOn();
      const selling = BigInt((await owner<{ s: string }>(`select c.selling_total_paise::text as s from public.booking_version_commercials c
        join public.booking_versions v on v.id = c.version_id where v.deal_id = $1 order by v.version_no desc limit 1`, [DEAL]))[0]!.s);
      const rec = await h.receipt2(String(selling + 300000n));
      const over = { kind: 'overpayment' as const, payeeReceiptId: rec.id };
      await h.refusedToken(OWNER, SQL2.refundCreate, [DEAL, JSON.stringify(h.refundFields({ ...over, amountPaise: '300001' })), rid()], 'refund_exceeds_money');
      await h.refusedHint(OWNER, SQL2.refundCreate, [DEAL, JSON.stringify(h.refundFields({ ...over, amountPaise: '100000', customerChargePaise: '1' })), rid()],
        'invalid_input', undefined, '22023');
      await h.refusedHint(OWNER, SQL2.refundCreate, [DEAL, JSON.stringify(h.refundFields({ ...over, outcome: 'charge_only', amountPaise: '0' })), rid()],
        'invalid_input', undefined, '22023');
      const r = await h.requestRefund(h.refundFields({ ...over, amountPaise: '300000' }));
      expect(r).toMatchObject({ kind: 'overpayment', amount_paise: '300000' });
    });
  });

  it('payee: original payer copies the receipt payer name; other needs a typed name and a reason; foreign or unverified receipts refused', async () => {
    await asOwner(db, async () => {
      const { receipt } = await cancelled();
      const r = await h.requestRefund(original(receipt.id, { payeeName: 'Typed Name Ignored' }));
      expect(r.payee_name, 'copied from the receipt, not typed').toBe('Synthetic Payer');
      await one(OWNER, SQL2.refundWithdraw, [r.id, r.row_version, 'Synthetic: payee changes to another person', rid()]);
      await h.refusedHint(OWNER, SQL2.refundCreate, [DEAL, JSON.stringify(h.refundFields({ payeeKind: 'other', payeeName: 'Synthetic Other Payee',
        payeeReason: 'short' })), rid()], 'invalid_input', /payeeReason/, '22023');
      await h.refusedHint(OWNER, SQL2.refundCreate, [DEAL, JSON.stringify(h.refundFields({ payeeKind: 'original_payer', payeeReceiptId: null })), rid()],
        'invalid_input', /payeeReceiptId/, '22023');
      const pending = await h.fin.record(ACC, DEAL, await h.fin.bankFields({ amountPaise: '100000' }));
      await h.refusedHint(OWNER, SQL2.refundCreate, [DEAL, JSON.stringify(original(pending.id)), rid()], 'invalid_input', /payeeReceiptId/, '22023');
      const other = await h.requestRefund(h.refundFields({ payeeKind: 'other', payeeName: 'Synthetic Other Payee',
        payeeReason: 'Synthetic: the payer asked to refund the traveller' }));
      expect(other.payee_name).toBe('Synthetic Other Payee');
      // No customer bank numbers are stored (LD8): the table has no such column.
      const cols = (await owner<{ c: string }>(`select column_name as c from information_schema.columns where table_schema = 'public'
        and table_name in ('customer_refund_requests', 'customer_refund_payouts')`)).map((x) => x.c);
      expect(cols.filter((c) => /account|ifsc|bank_name/.test(c))).toEqual([]);
    });
  });

  it('who requests: the Sales owner; the branch Manager only when there is no active Sales owner; never A, P, other Sales', async () => {
    await asOwner(db, async () => {
      const { receipt } = await cancelled();
      for (const actor of [ACC, PURCHASE, MANAGER, { userId: U.salesDelhiB } as Actor]) {
        await h.refused(actor, SQL2.refundCreate, [DEAL, JSON.stringify(original(receipt.id)), rid()], 'not_authorized');
      }
      await h.people.noSalesOwner();
      await h.refused(OWNER, SQL2.refundCreate, [DEAL, JSON.stringify(original(receipt.id)), rid()], 'not_authorized');
      const byManager = await h.requestRefund(original(receipt.id), DEAL, MANAGER);
      expect(byManager.status).toBe('requested');
      // LD32: requested by the branch's only Manager → any other active Manager of the entity approves.
      await h.refusedToken(MANAGER, SQL2.refundDecide, [byManager.id, 'approve', byManager.amount_paise, byManager.customer_charge_paise, null,
        byManager.row_version, rid()], 'not_self_approval');
      await h.decideRefund(byManager.id, 'approve', MANAGER_AMD);
      expect((await h.refundRow(byManager.id)).status).toBe('approved');
    });
  });

  it('one live request per Deal (refund_open_exists 23505); sequential partial refunds within current held − charge (LD5)', async () => {
    await asOwner(db, async () => {
      const { receipt } = await cancelled('2500000');
      const r1 = await h.requestRefund(original(receipt.id, { amountPaise: '1000000' }));
      await h.refusedToken(OWNER, SQL2.refundCreate, [DEAL, JSON.stringify(original(receipt.id, { amountPaise: '100' })), rid()], 'refund_open_exists');
      // Same request id replays (no second row).
      const req = rid();
      await one(OWNER, SQL2.refundWithdraw, [r1.id, r1.row_version, 'Synthetic: amount was wrong, starting again', rid()]);
      const r2 = await h.requestRefund(original(receipt.id, { amountPaise: '1000000' }), DEAL, OWNER, req);
      expect(idOf(await one(OWNER, SQL2.refundCreate, [DEAL, JSON.stringify(original(receipt.id, { amountPaise: '1000000' })), req]))).toBe(r2.id);
      await h.decideRefund(r2.id, 'approve');
      await h.payout(r2.id);
      expect(await h.held()).toBe(1500000n);
      await h.refusedToken(OWNER, SQL2.refundCreate, [DEAL, JSON.stringify(original(receipt.id, { amountPaise: '1500001' })), rid()], 'refund_exceeds_money');
      const r3 = await h.requestRefund(original(receipt.id, { amountPaise: '1500000' }));
      expect(r3.status).toBe('requested');
    });
  });
});

describe.skipIf(!READY)('7.3 approval, return/resubmit, withdraw (LD31)', () => {
  it('approval binds the exact amounts; return needs a reason; the requester resubmits; facts frozen after approval', async () => {
    await asOwner(db, async () => {
      const { receipt } = await cancelled();
      const r = await h.requestRefund(original(receipt.id, { amountPaise: '1000000', customerChargePaise: '200000' }));
      await h.refusedToken(MANAGER, SQL2.refundDecide, [r.id, 'approve', '1000001', '200000', null, r.row_version, rid()], 'version_changed');
      await h.refusedToken(MANAGER, SQL2.refundDecide, [r.id, 'approve', '1000000', '200001', null, r.row_version, rid()], 'version_changed');
      await h.refusedHint(MANAGER, SQL2.refundDecide, [r.id, 'return', '1000000', '200000', null, r.row_version, rid()], 'invalid_input', undefined, '22023');
      await h.decideRefund(r.id, 'return', MANAGER, 'Synthetic return: the charge is too low');
      const ret = await h.refundRow(r.id);
      expect(ret.status).toBe('returned');
      expect((await h.audits('refund.returned'))[0]?.reason).toBe('Synthetic return: the charge is too low');
      await h.refused({ userId: U.salesDelhiB }, SQL2.refundResubmit, [r.id, ret.row_version, JSON.stringify(original(receipt.id)), rid()], 'not_authorized');
      await one(OWNER, SQL2.refundResubmit, [r.id, ret.row_version, JSON.stringify(original(receipt.id, { amountPaise: '900000', customerChargePaise: '300000' })),
        rid()]);
      const again = await h.refundRow(r.id);
      expect(again).toMatchObject({ status: 'requested', amount_paise: '900000', customer_charge_paise: '300000' });
      await h.decideRefund(r.id, 'approve');
      expect(await h.audits('refund.approved')).toHaveLength(1);
      await h.refusedToken(MANAGER, SQL2.refundDecide, [r.id, 'approve', '900000', '300000', null, (await h.refundRow(r.id)).row_version, rid()], 'wrong_state');
      await expectDbError(db, () => owner('update public.customer_refund_requests set amount_paise = 1 where id = $1', [r.id]), {});
      await expectDbError(db, () => owner('delete from public.customer_refund_requests where id = $1', [r.id]), {});
    });
  });

  it('withdraw: requester while requested/returned; approved and unpaid only by the approving or another branch Manager, with reason', async () => {
    await asOwner(db, async () => {
      const { receipt } = await cancelled();
      const r = await h.requestRefund(original(receipt.id));
      await h.decideRefund(r.id, 'approve');
      const a = await h.refundRow(r.id);
      await h.refusedToken(OWNER, SQL2.refundWithdraw, [r.id, a.row_version, 'Synthetic: customer changed their mind', rid()], 'wrong_state')
        .catch(async () => h.refused(OWNER, SQL2.refundWithdraw, [r.id, a.row_version, 'Synthetic: customer changed their mind', rid()], 'not_authorized'));
      await h.people.manager2Del();
      await one(MANAGER_AMD, SQL2.refundWithdraw, [r.id, a.row_version, 'Synthetic: customer changed their mind', rid()]);
      expect((await h.refundRow(r.id)).status).toBe('withdrawn');
      expect((await h.audits('refund.withdrawn'))[0]?.reason).toBe('Synthetic: customer changed their mind');
    });
  });
});

describe.skipIf(!READY)('C6 payout (Q6: one Accounts person records and verifies)', () => {
  it('posts refund_bank: customer_advances Dr / bank Cr; journal shape; dues and money held fall; sm_customer_money_available reduced', async () => {
    await asOwner(db, async () => {
      const { receipt } = await cancelled('2500000');
      const before = BigInt((await owner<{ v: string }>('select authz.sm_customer_money_available($1, null)::text as v', [DEAL]))[0]!.v);
      const r = await h.requestRefund(original(receipt.id, { amountPaise: '2000000', customerChargePaise: '500000' }));
      await h.decideRefund(r.id, 'approve');
      const paid = await h.payout(r.id);
      const row = await h.refundRow(r.id);
      expect(row.status).toBe('paid');
      const [p] = await owner<{ id: string; journal_entry_id: string; recorded_by: string; amount_paise: string }>(
        'select id, journal_entry_id, recorded_by, amount_paise::text as amount_paise from public.customer_refund_payouts where refund_request_id = $1', [r.id]);
      expect(p).toMatchObject({ recorded_by: U.accountsJodhpur, amount_paise: '2000000' });
      const [entry] = await owner<{ kind: string; receipt_id: string | null; refund_payout_id: string; business_date: string }>(
        'select kind, receipt_id, refund_payout_id, business_date::text as business_date from public.finance_journal_entries where id = $1', [p!.journal_entry_id]);
      expect(entry).toEqual({ kind: 'refund_bank', receipt_id: null, refund_payout_id: p!.id, business_date: today() });
      expect(await linesOf(p!.journal_entry_id)).toEqual([
        { account: 'bank', debit_paise: '0', credit_paise: '2000000' },
        { account: 'customer_advances', debit_paise: '2000000', credit_paise: '0' },
      ]);
      expect(await h.held()).toBe(500000n);
      const after = BigInt((await owner<{ v: string }>('select authz.sm_customer_money_available($1, null)::text as v', [DEAL]))[0]!.v);
      expect(before - after).toBe(2000000n);
      expect(await h.audits('refund.paid')).toEqual([expect.objectContaining({ details: expect.objectContaining({ refundRequestId: r.id, payoutId: p!.id,
        journalEntryId: p!.journal_entry_id, mode: 'bank_transfer' }) })]);
      // Dues after settlement (LD10): total = charge, basis cancelled, plan ignored.
      const dues = await one<{ basis: { kind: string }; totalPaise: string; verifiedPaise: string; balancePaise: string;
        refunds: { live: unknown; paidPaise: string; keptAsCreditPaise: string } }>(ACC, SQL2.dealDues, [DEAL]);
      expect(dues.basis.kind).toBe('cancelled');
      expect(dues.totalPaise).toBe('500000');
      expect(dues.refunds).toMatchObject({ live: null, paidPaise: '2000000' });
      expect(BigInt(dues.balancePaise)).toBe(0n);
      // Append-only payout; journal rows immutable.
      await expectDbError(db, () => owner('update public.customer_refund_payouts set amount_paise = 1 where id = $1', [p!.id]), {});
      await expectDbError(db, () => owner('delete from public.finance_journal_entries where id = $1', [p!.journal_entry_id]), {});
      void paid;
    });
  });

  it('refusals: evidence_missing, paidOn before approval or after today, reference required unless cash, wrong_state for keep_credit / not approved', async () => {
    await asOwner(db, async () => {
      const { receipt } = await cancelled();
      const r = await h.requestRefund(original(receipt.id));
      const rv = async () => (await h.refundRow(r.id)).row_version;
      await h.refusedToken(ACC, SQL2.payout, [r.id, await rv(), JSON.stringify({ mode: 'bank_transfer', paidOn: today(), reference: 'SYNRF0001',
        evidenceId: null }), rid()], 'wrong_state');
      await h.decideRefund(r.id, 'approve');
      await h.refusedToken(ACC, SQL2.payout, [r.id, await rv(), JSON.stringify({ mode: 'bank_transfer', paidOn: today(), reference: 'SYNRF0001',
        evidenceId: null }), rid()], 'evidence_missing');
      const ev = await h.refundProof('customer_refund', r.id);
      await h.refusedHint(ACC, SQL2.payout, [r.id, await rv(), JSON.stringify({ mode: 'bank_transfer', paidOn: '2020-01-01', reference: 'SYNRF0001',
        evidenceId: ev }), rid()], 'invalid_input', /paidOn/, '22023');
      await h.refusedHint(ACC, SQL2.payout, [r.id, await rv(), JSON.stringify({ mode: 'bank_transfer', paidOn: '2099-01-01', reference: 'SYNRF0001',
        evidenceId: ev }), rid()], 'invalid_input', /paidOn/, '22023');
      await h.refusedHint(ACC, SQL2.payout, [r.id, await rv(), JSON.stringify({ mode: 'bank_transfer', paidOn: today(), reference: null, evidenceId: ev }), rid()],
        'invalid_input', /reference/, '22023');
      await h.refused(MANAGER, SQL2.payout, [r.id, await rv(), JSON.stringify({ mode: 'bank_transfer', paidOn: today(), reference: 'SYNRF0001',
        evidenceId: ev }), rid()], 'not_authorized');
      await h.payout(r.id, { evidenceId: ev });
      expect((await h.refundRow(r.id)).status).toBe('paid');
    });
    await asOwner(db, async () => {
      const { receipt } = await cancelled();
      const k = await h.requestRefund(original(receipt.id, { outcome: 'keep_credit', payeeKind: null, payeeReceiptId: null }));
      await h.decideRefund(k.id, 'approve');
      expect((await h.refundRow(k.id)).status).toBe('approved');
      await h.refusedToken(ACC, SQL2.refundEvidenceBegin, ['customer_refund', k.id, 'k.pdf', 'application/pdf', 2048, 'a'.repeat(64), rid()], 'wrong_state');
      await h.refusedToken(ACC, SQL2.payout, [k.id, (await h.refundRow(k.id)).row_version, JSON.stringify({ mode: 'bank_transfer', paidOn: today(),
        reference: 'SYNRF0002', evidenceId: rid() }), rid()], 'wrong_state');
      expect(await h.held(), 'keep as credit: the money stays').toBe(2500000n);
    });
  });

  it('requester ≠ approver ≠ payer: approver cannot pay out; an Accounts holder can never request (so never pays their own request)', async () => {
    // Payer is the approver (Accounts person who is also the Delhi Manager).
    await asOwner(db, async () => {
      const { receipt } = await cancelled();
      await h.people.fixtures('accountsJodhpur2');
      await h.addRole(U.accountsJodhpur, 'manager', 'DEL');
      const r = await h.requestRefund(original(receipt.id));
      await h.decideRefund(r.id, 'approve', ACC);
      const ev = await h.refundProof('customer_refund', r.id, P2.ACC_2);
      await h.refusedToken(ACC, SQL2.payout, [r.id, (await h.refundRow(r.id)).row_version, JSON.stringify({ mode: 'bank_transfer', paidOn: today(),
        reference: 'SYNRF0003', evidenceId: ev }), rid()], 'not_self_approval');
      await h.payout(r.id, { evidenceId: ev }, P2.ACC_2);
      expect((await h.refundRow(r.id)).status).toBe('paid');
    });
    // A Sales owner who also holds Accounts is not a requester (7.2: never A).
    await asOwner(db, async () => {
      const { receipt } = await cancelled();
      await h.addRole(U.salesDelhiA, 'accounts', 'DEL');
      await h.refused(OWNER, SQL2.refundCreate, [DEAL, JSON.stringify(original(receipt.id)), rid()], 'not_authorized');
    });
  });

  it('reversal between approval and payout → refund_exceeds_money; approve re-checks too', async () => {
    await asOwner(db, async () => {
      const { receipt } = await cancelled('2500000');
      const r = await h.requestRefund(original(receipt.id, { amountPaise: '2500000' }));
      const second = await h.receipt2('100000');
      await h.fin.reverse(ACC, receipt.id, 'data_error');
      await h.refusedToken(MANAGER, SQL2.refundDecide, [r.id, 'approve', '2500000', '0', null, r.row_version, rid()], 'refund_exceeds_money');
      void second;
    });
    await asOwner(db, async () => {
      const { receipt } = await cancelled('2500000');
      const r = await h.requestRefund(original(receipt.id, { amountPaise: '2500000' }));
      await h.decideRefund(r.id, 'approve');
      const ev = await h.refundProof('customer_refund', r.id);
      await h.fin.reverse(ACC, receipt.id, 'data_error');
      await h.refusedToken(ACC, SQL2.payout, [r.id, (await h.refundRow(r.id)).row_version, JSON.stringify({ mode: 'bank_transfer', paidOn: today(),
        reference: 'SYNRF0005', evidenceId: ev }), rid()], 'refund_exceeds_money');
    });
  });

  it('cash refund: refund_cash with cash_in_hand Cr; makes the branch reconciliation stale (LD30)', async () => {
    await asOwner(db, async () => {
      await h.approvedDeal([HOTEL_ITEM]);
      const del = await h.branchId('DEL');
      const cash = await h.fin.record(ACC, DEAL, await h.fin.cashFields({ amountPaise: '1000000', branchId: del }));
      await h.fin.verify(ACC2, cash.id);
      await h.refundsOn();
      await h.approveCancellation();
      const count = await one<{ id: string }>(ACC, 'select public.cash_reconciliation_record($1, $2::date, $3::bigint, $4, $5) as r',
        [del, today(), '1000000', null, rid()]);
      const r = await h.requestRefund(original(cash.id, { amountPaise: '400000' }));
      await h.decideRefund(r.id, 'approve');
      await h.payout(r.id, { mode: 'cash', reference: null });
      const [p] = await owner<{ journal_entry_id: string }>('select journal_entry_id from public.customer_refund_payouts where refund_request_id = $1', [r.id]);
      expect(await owner('select kind from public.finance_journal_entries where id = $1', [p!.journal_entry_id])).toEqual([{ kind: 'refund_cash' }]);
      expect(await linesOf(p!.journal_entry_id)).toEqual([
        { account: 'cash_in_hand', debit_paise: '0', credit_paise: '400000' },
        { account: 'customer_advances', debit_paise: '400000', credit_paise: '0' },
      ]);
      expect(await owner('select stale from public.cash_reconciliations where id = $1', [count.id])).toEqual([{ stale: true }]);
    });
  });

  it('journal shape check refuses a malformed refund entry (R3: finance suites unchanged)', async () => {
    await asOwner(db, async () => {
      const { receipt } = await cancelled();
      const r = await h.requestRefund(original(receipt.id));
      await h.decideRefund(r.id, 'approve');
      await h.payout(r.id);
      const [p] = await owner<{ id: string; journal_entry_id: string }>('select id, journal_entry_id from public.customer_refund_payouts where refund_request_id = $1', [r.id]);
      // A refund kind without a payout, or a deposit with a payout id, violates the checks.
      const [e] = await owner<{ legal_entity_id: string; deal_id: string; branch_id: string; posted_by: string }>(
        'select legal_entity_id, deal_id, branch_id, posted_by from public.finance_journal_entries where id = $1', [p!.journal_entry_id]);
      await expectDbError(db, () => owner(`insert into public.finance_journal_entries (legal_entity_id, kind, receipt_id, deal_id, branch_id, business_date, posted_by)
        values ($1, 'refund_bank', null, $2, $3, current_date, $4)`, [e!.legal_entity_id, e!.deal_id, e!.branch_id, e!.posted_by]), {});
    });
  });
});

describe.skipIf(!READY)('R-C1 / R-C2 reads', () => {
  it('deal_refunds: held, max refund, payers, requests with can-flags; refund_requests_list presets and keyset', async () => {
    await asOwner(db, async () => {
      const { receipt } = await cancelled();
      const so = await one<{ heldPaise: string; maxRefundPaise: string; canRequest: boolean; payers: Array<{ receiptId: string; payerName: string }> }>(
        OWNER, SQL2.dealRefunds, [DEAL]);
      expect(so).toMatchObject({ heldPaise: '2500000', maxRefundPaise: '2500000', canRequest: true });
      expect(so.payers).toEqual([expect.objectContaining({ receiptId: receipt.id, payerName: 'Synthetic Payer' })]);
      const r = await h.requestRefund(original(receipt.id));
      const m = await one<{ requests: Array<{ id: string; can: Record<string, boolean> }> }>(MANAGER, SQL2.dealRefunds, [DEAL]);
      expect(m.requests.find((x) => x.id === r.id)!.can).toMatchObject({ approve: true, return: true, payout: false });
      const toApprove = await one<{ items: Array<{ id: string; refNo: string; ageWorkingDays: number }> }>(MANAGER, SQL2.refundList,
        [JSON.stringify({ preset: 'to_approve' }), null, 50]);
      expect(toApprove.items.map((x) => x.id)).toContain(r.id);
      await h.decideRefund(r.id, 'approve');
      const due = await one<{ items: Array<{ id: string }> }>(ACC, SQL2.refundList, [JSON.stringify({ preset: 'payout_due' }), null, 50]);
      expect(due.items.map((x) => x.id)).toContain(r.id);
      const own = await one<{ items: Array<{ id: string }> }>(OWNER, SQL2.refundList, [JSON.stringify({}), null, 50]);
      expect(own.items.map((x) => x.id)).toContain(r.id);
      expect(await one(PURCHASE, SQL2.refundList, [JSON.stringify({}), null, 50])).toBeNull();
      expect(await one(PURCHASE, SQL2.dealRefunds, [DEAL])).toBeNull();
    });
  });

  it('switch setter: policy rights and a reason; audited as settings.accounts_changed', async () => {
    await asOwner(db, async () => {
      await h.refused(ACC, SQL2.setRefundsEnabled, [await h.entityId(), true, REASON], 'not_authorized');
      await h.refusedHint(SUPER, SQL2.setRefundsEnabled, [await h.entityId(), true, 'short'], 'invalid_input', undefined, '22023');
      await h.refundsOn();
      expect(await owner('select refunds_enabled from public.accounts_settings where legal_entity_id = $1', [await h.entityId()]))
        .toEqual([{ refunds_enabled: true }]);
      expect((await h.audits('settings.accounts_changed')).length).toBeGreaterThan(0);
    });
  });
});

describe.skipIf(!READY || !DOCS)('7.6 credit-note sources (LD3, LD6)', () => {
  it('case 1: settlement with a released Invoice → CN of Invoice total − charge − earlier CNs (also keep_credit / charge_only)', async () => {
    await asOwner(db, async () => {
      await h.approvedDeal([HOTEL_ITEM]);
      await h.docsOn();
      const rec = await h.receipt2('2500000');
      const inv = await h.releasedInvoice();
      await h.refundsOn();
      await h.approveCancellation();
      const r = await h.requestRefund(original(rec.id, { outcome: 'keep_credit', payeeKind: null, payeeReceiptId: null, amountPaise: '1000000',
        customerChargePaise: '300000' }));
      // Not before approval.
      await h.refusedToken(ACC, SQL2.draftCreate, [DEAL, 'credit_note', JSON.stringify({ refundRequestId: r.id }), rid()], 'not_ready');
      await h.decideRefund(r.id, 'approve');
      const [src] = await owner<{ s: { amountPaise: string; creditsDocumentId: string | null } }>('select authz.cdoc_credit_note_source($1) as s', [r.id]);
      expect(src!.s).toMatchObject({ amountPaise: String(BigInt(inv.total_paise) - 300000n), creditsDocumentId: inv.id });
      const cn = await h.draft('credit_note', { refundRequestId: r.id });
      expect(cn).toMatchObject({ kind: 'credit_note', credits_document_id: inv.id, refund_request_id: r.id, total_paise: String(BigInt(inv.total_paise) - 300000n) });
      expect((cn.content as { credits: unknown }).credits).toMatchObject({ number: inv.number });
      const released = await h.release(cn.id);
      // After a released CN the source is used up.
      const [after] = await owner<{ s: unknown }>('select authz.cdoc_credit_note_source($1) as s', [r.id]);
      expect(after!.s === null || BigInt((after!.s as { amountPaise: string }).amountPaise) <= 0n).toBe(true);
      void released;
    });
  });

  it('case 2: no Invoice, payout recorded, released ADVs → CN of the refund amount after payout; case 3: overpayment with Invoice → none', async () => {
    await asOwner(db, async () => {
      await h.approvedDeal([HOTEL_ITEM]);
      await h.docsOn();
      const rec = await h.receipt2('2500000');
      const adv = await h.releasedAdvance(rec.id);
      await h.refundsOn();
      await h.approveCancellation();
      const r = await h.requestRefund(original(rec.id, { amountPaise: '2000000', customerChargePaise: '500000' }));
      await h.decideRefund(r.id, 'approve');
      expect((await owner<{ s: unknown }>('select authz.cdoc_credit_note_source($1) as s', [r.id]))[0]!.s, 'case 2 waits for the payout').toBeNull();
      await h.payout(r.id);
      const [src] = await owner<{ s: { amountPaise: string; creditsDocumentId: string | null; creditedAdvanceNumbers: string[] } }>(
        'select authz.cdoc_credit_note_source($1) as s', [r.id]);
      expect(src!.s).toMatchObject({ amountPaise: '2000000', creditsDocumentId: null, creditedAdvanceNumbers: [adv.number] });
    });
    await asOwner(db, async () => {
      await h.approvedDeal([HOTEL_ITEM]);
      await h.docsOn();
      const selling = BigInt((await owner<{ s: string }>(`select c.selling_total_paise::text as s from public.booking_version_commercials c
        join public.booking_versions v on v.id = c.version_id where v.deal_id = $1 order by v.version_no desc limit 1`, [DEAL]))[0]!.s);
      const rec = await h.receipt2(String(selling + 200000n));
      await h.releasedInvoice();
      await h.refundsOn();
      const r = await h.requestRefund(h.refundFields({ kind: 'overpayment', payeeReceiptId: rec.id, amountPaise: '200000' }));
      await h.decideRefund(r.id, 'approve');
      await h.payout(r.id);
      expect((await owner<{ s: unknown }>('select authz.cdoc_credit_note_source($1) as s', [r.id]))[0]!.s).toBeNull();
    });
  });
});

describe.skipIf(!READY || !SREFUND)('supplier refunds (Addendum L1: one step; cancel with reason)', () => {
  /** Hotel costed with a supplier, cancellation with a Purchase charge (keeps ₹1,000, refund expected ₹39,000), approved. */
  async function supplierCase() {
    const b = await h.approvedDeal([HOTEL_ITEM]);
    const task = h.taskOf(b, 'hotel');
    const supplierId = await h.purchaseSupplier();
    await h.purchaseCost(task, supplierId);
    await h.receipt2('2500000');
    await h.refundsOn();
    const cancellationId = await h.openCancellation();
    await one(PURCHASE, SQL2.chargeSet, [task, '100000', '3900000', null, null, 0, rid()]);
    const c = (await h.cancellationOf())!;
    await one(PURCHASE, SQL2.cancelSend, [cancellationId, c.row_version, rid()]);
    const sent = (await h.cancellationOf())!;
    await one(MANAGER, SQL2.cancelDecide, [cancellationId, 'approve', null, sent.row_version, rid()]);
    const [charge] = await owner<{ id: string }>('select id from public.purchase_cancellation_charges where cancellation_id = $1 order by revision_no desc limit 1',
      [cancellationId]);
    return { task, supplierId, cancellationId, chargeId: charge!.id };
  }
  // Supplier refund proofs hang on the cancellation (Track C reading: the receipt row does not exist yet at upload).
  const fields = async (sourceId: string, amount: string, over: Record<string, unknown> = {}) => ({ sourceKind: 'purchase_charge', sourceId,
    amountPaise: amount, receivedOn: today(), mode: 'bank_transfer', reference: `SYNSR${rid().slice(0, 6)}`,
    evidenceId: await h.refundProof('supplier_refund', (await h.cancellationOf())!.id), overExpectedReason: null, ...over });

  it('one Accounts person records → verified at once; over-expected needs a reason; never in customer dues; cancel → rejected', async () => {
    await asOwner(db, async () => {
      const s = await supplierCase();
      const duesBefore = await one<Record<string, unknown>>(ACC, SQL2.dealDues, [DEAL]);
      const rec = await one(ACC, SQL2.supplierRefundRecord, [JSON.stringify(await fields(s.chargeId, '3000000')), rid()]);
      const id = idOf(rec, 'supplierRefundId');
      const [row] = await owner<{ status: string; recorded_by: string; verified_by: string; recorded_at: string; verified_at: string }>(
        'select status, recorded_by, verified_by, recorded_at::text, verified_at::text from public.supplier_refund_receipts where id = $1', [id]);
      expect(row).toMatchObject({ status: 'verified', recorded_by: U.accountsJodhpur, verified_by: U.accountsJodhpur });
      expect(row!.verified_at).toBe(row!.recorded_at);
      expect(await h.audits('accounts.supplier_refund.verified')).toHaveLength(1);
      expect(await h.audits('supplier_refund.recorded')).toEqual([]);
      // Over expected (3,000,000 + 1,000,000 > 3,900,000) without a reason.
      await h.refusedToken(ACC, SQL2.supplierRefundRecord, [JSON.stringify(await fields(s.chargeId, '1000000')), rid()], 'over_expected', /overExpectedReason/);
      await one(ACC, SQL2.supplierRefundRecord, [JSON.stringify(await fields(s.chargeId, '1000000', { overExpectedReason:
        'Synthetic: the supplier also returned the booking fee' })), rid()]);
      // Never posts to the customer journal; never in dues.
      const duesAfter = await one<Record<string, unknown>>(ACC, SQL2.dealDues, [DEAL]);
      expect(duesAfter.verifiedPaise).toBe(duesBefore.verifiedPaise);
      expect(await h.held()).toBe(2500000n);
      // Payables show expected and received side by side.
      const pay = JSON.stringify(await one(ACC, SQL2.payables, [DEAL]));
      expect(pay).toContain('supplierRefundsExpectedPaise');
      expect(pay).toContain('supplierRefundsReceivedPaise');
      // Cancel: any Accounts person, including the recorder; reason 10..500.
      const rv = (await owner<{ row_version: number }>('select row_version from public.supplier_refund_receipts where id = $1', [id]))[0]!.row_version;
      await h.refusedHint(ACC, SQL2.supplierRefundCancel, [id, rv, 'short', rid()], 'invalid_input', undefined, '22023');
      await one(ACC, SQL2.supplierRefundCancel, [id, rv, 'Synthetic: recorded against the wrong supplier', rid()]);
      expect(await owner('select status from public.supplier_refund_receipts where id = $1', [id])).toEqual([{ status: 'rejected' }]);
      expect((await h.audits('accounts.supplier_refund.rejected'))[0]?.reason).toBe('Synthetic: recorded against the wrong supplier');
      // No verify command and no self-approval refusal exist for supplier refunds.
      expect(await owner(`select count(*)::int as n from pg_proc where proname = 'supplier_refund_verify'`)).toEqual([{ n: 0 }]);
      // Not Accounts: refused.
      await h.refused(PURCHASE, SQL2.supplierRefundRecord, [JSON.stringify({ ...(await fields(s.chargeId, '1')), evidenceId: null }), rid()], 'not_authorized');
    });
  });

  it('not_ready before the cancellation is approved or without an expected refund on the source', async () => {
    await asOwner(db, async () => {
      const b = await h.approvedDeal([HOTEL_ITEM]);
      const task = h.taskOf(b, 'hotel');
      await h.purchaseCost(task, await h.purchaseSupplier());
      await h.refundsOn();
      await h.openCancellation();
      await one(PURCHASE, SQL2.chargeSet, [task, '100000', '0', null, null, 0, rid()]);
      const [charge] = await owner<{ id: string }>('select id from public.purchase_cancellation_charges order by entered_at desc limit 1');
      const c = (await h.cancellationOf())!;
      await h.refusedToken(ACC, SQL2.refundEvidenceBegin, ['supplier_refund', c.id, 'p.pdf', 'application/pdf', 2048, 'e'.repeat(64), rid()], 'not_ready');
      const r = await h.attempt(ACC, SQL2.supplierRefundRecord, [JSON.stringify({ sourceKind: 'purchase_charge', sourceId: charge!.id, amountPaise: '100',
        receivedOn: today(), mode: 'bank_transfer', reference: 'SYNSR0001', evidenceId: rid(), overExpectedReason: null }), rid()]);
      expect(r).toMatchObject({ ok: false, error: 'not_ready' });
    });
  });
});

describe.skipIf(!READY)('C5 refund proof files', () => {
  it('begin/finish by Accounts; duplicate file refused; download for A and the branch Manager only, audited', async () => {
    await asOwner(db, async () => {
      const { receipt } = await cancelled();
      const r = await h.requestRefund(original(receipt.id));
      await h.refusedToken(ACC, SQL2.refundEvidenceBegin, ['customer_refund', r.id, 'early.pdf', 'application/pdf', 2048, 'f'.repeat(64), rid()], 'wrong_state');
      await h.decideRefund(r.id, 'approve');
      const hash = 'c'.repeat(64);
      const ev = await h.refundProof('customer_refund', r.id, ACC, hash);
      await h.refused(ACC, SQL2.refundEvidenceBegin, ['customer_refund', r.id, 'again.pdf', 'application/pdf', 2048, hash, rid()], 'duplicate_file');
      await h.refused(OWNER, SQL2.refundEvidenceBegin, ['customer_refund', r.id, 'x.pdf', 'application/pdf', 2048, 'd'.repeat(64), rid()], 'not_authorized');
      expect(await one(ACC, SQL2.refundEvidenceDownload, [ev])).toMatchObject({ objectPath: expect.stringMatching(new RegExp(`/refund/${r.id}/`)) });
      expect(await one(MANAGER, SQL2.refundEvidenceDownload, [ev])).toBeTruthy();
      for (const actor of [OWNER, PURCHASE]) await h.refused(actor, SQL2.refundEvidenceDownload, [ev], 'not_authorized');
      expect(await h.audits('accounts.refund_evidence.downloaded')).toHaveLength(2);
    });
  });
});

describe.skipIf(!READY || !L6)('Addendum L6: receipt reversed after a paid-out refund', () => {
  it('allowed; money held below zero; shortfall due now (charge part too after a settlement); no new refund; urgent notice', async () => {
    await asOwner(db, async () => {
      // Lead example: cancelled Deal, ₹10,000 charge, ₹40,000 refund paid, ₹50,000 receipt reversed.
      const { receipt } = await cancelled('5000000');
      const r = await h.requestRefund(original(receipt.id, { customerChargePaise: '1000000', amountPaise: '4000000' }));
      await h.decideRefund(r.id, 'approve');
      await h.payout(r.id);
      expect(await h.held()).toBe(1000000n);
      // The notice kind (Track D 0440) is checked once it is in the kind list.
      const L6_NOTICE = (await owner<{ k: boolean }>(`select 'refund_shortfall' = any(authz.notice_kinds()) as k`))[0]!.k;
      if (L6_NOTICE) {
        await h.people.fixtures('accountsJodhpur3');
        await one(SUPER, 'select public.admin_set_accounts_exception_owner($1, $2, $3) as r', [await h.entityId(), P2.ACC_3.userId, REASON]);
        await h.noticesOn();
      }
      // The reversal is a bank fact: never refused because of the negative balance.
      await h.fin.reverse(ACC, receipt.id, 'data_error');
      expect(await h.held()).toBe(-4000000n);
      const dues = await one<{ totalPaise: string; balancePaise: string; dueNowPaise: string; status: string;
        refunds: { shortfallPaise: string; paidPaise: string } }>(ACC, SQL2.dealDues, [DEAL]);
      expect(dues.refunds.shortfallPaise).toBe('4000000');
      expect(dues.totalPaise, 'settlement: total = charge').toBe('1000000');
      expect(dues).toMatchObject({ balancePaise: '5000000', dueNowPaise: '5000000' });
      expect(['due_now', 'overdue']).toContain(dues.status);
      // No new refund while money held is below zero.
      const card = await one<{ canRequest: boolean }>(OWNER, SQL2.dealRefunds, [DEAL]);
      expect(card.canRequest).toBe(false);
      await h.refusedToken(OWNER, SQL2.refundCreate, [DEAL, JSON.stringify(h.refundFields({ amountPaise: '1', payeeKind: 'other',
        payeeName: 'Synthetic Other Payee', payeeReason: 'Synthetic: the original payment was reversed' })), rid()],
        'refund_exceeds_money', /heldPaise/);
      if (L6_NOTICE) {
        const rows = await h.notices('refund_shortfall');
        expect(rows.map((n) => n.recipient_user_id)).toEqual(expect.arrayContaining([P2.ACC_3.userId, OWNER.userId]));
        expect(rows.map((n) => n.recipient_user_id), 'never the reversing actor').not.toContain(ACC.userId);
        expect(rows.every((n) => n.priority === 'urgent')).toBe(true);
        expect(rows.every((n) => n.dedup_key.startsWith('refund_shortfall:'))).toBe(true);
        expect(JSON.stringify(rows.map((n) => n.params))).not.toMatch(/4000000|5000000|Synthetic Payer/);
      }
    });
  });
});
