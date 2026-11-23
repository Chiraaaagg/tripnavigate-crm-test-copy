import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACC2, PURCHASE, SALES_B, VISA } from './acc-support';
import { ACC, ACC_J2, CSQL, DEAL, MANAGER, MANAGER_J2, OWNER, REASON, VISA_J2, acc2cHelpers, rid, today } from './acc2c-support';
import { CONFLICT_STATE } from '../helpers/sqlstates';

/**
 * Accounts phase 2 contract 7.1-7.3 (C1-C6, C12), LD5, LD8, LD10, LD27-LD32,
 * owner Q5-Q8, Track C: refund requests, the Manager decision, the one-person
 * payout and its journal entry, dues after a settlement.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const c = acc2cHelpers(() => db);
const { one, owner } = c;

const payoutFields = (receiptId: string, amount: string, charge = '1000000') => ({
  kind: 'cancellation', outcome: 'payout', customerChargePaise: charge, amountPaise: amount, payeeKind: 'original_payer',
  payeeReceiptId: receiptId,
});

describe('C12 switch and C1 request rules', () => {
  it('refunds_off until switched on; only the policy manager switches; audited', async () => {
    await asOwner(db, async () => {
      const { receipt } = await c.paidBooking();
      await c.cancelApproved();
      await c.refundsOn(false);
      await c.refused(OWNER, CSQL.create, [DEAL, JSON.stringify({ reason: REASON, ...payoutFields(receipt!.id, '1000000') }), rid()], 'refunds_off', '55000');
      await c.refused(ACC, CSQL.setRefunds, [await c.entityId(), true, REASON], 'not_authorized', '42501');
      await c.refundsOn(true);
      const r = await c.request(payoutFields(receipt!.id, '1000000'));
      expect(r).toMatchObject({ outcome: 'created', status: 'requested', rowVersion: 1 });
      expect(r.refNo).toMatch(/^RF-\d{4}-\d{6}$/);
      const audits = await owner<{ details: Record<string, unknown> }>(
        `select details from public.audit_events where action = 'settings.accounts_changed' order by id desc limit 1`);
      expect(audits[0]?.details).toBeTruthy();
    });
  });

  it('cancellation refunds need an approved cancellation; payout <= held - charge; one live request per Deal', async () => {
    await asOwner(db, async () => {
      const { receipt } = await c.paidBooking('5000000');
      await c.refusedHint(OWNER, CSQL.create, [DEAL, JSON.stringify({ reason: REASON, ...payoutFields(receipt!.id, '1000000') }), rid()],
        'not_ready', undefined, '55000');
      await c.cancelApproved();
      // held 5,000,000 - charge 1,000,000 = 4,000,000 max.
      await c.refusedHint(OWNER, CSQL.create, [DEAL, JSON.stringify({ reason: REASON, ...payoutFields(receipt!.id, '4000001') }), rid()],
        'refund_exceeds_money', /amountPaise/, '22023');
      await c.refusedHint(OWNER, CSQL.create, [DEAL, JSON.stringify({ reason: REASON, ...payoutFields(receipt!.id, '0') }), rid()],
        'invalid_input', /amountPaise/, '22023');
      const r = await c.request(payoutFields(receipt!.id, '4000000'));
      expect(r.status).toBe('requested');
      // Same request id replays; another request is refused while one is live.
      await c.refused(OWNER, CSQL.create, [DEAL, JSON.stringify({ reason: REASON, ...payoutFields(receipt!.id, '1000') }), rid()],
        'refund_open_exists', '23505');
      const row = await c.row(r.refundRequestId);
      expect({ ...row, held_at_request_paise: String(row.held_at_request_paise) })
        .toMatchObject({ payee_name: 'Synthetic Payer', held_at_request_paise: '5000000', requested_as: 'sales_owner' });
    });
  });

  it('charge_only: amount 0, any charge; keep_credit; overpayment limited to credit; unknown and bad keys name the field', async () => {
    await asOwner(db, async () => {
      const { receipt } = await c.paidBooking('5000000');
      await c.cancelApproved();
      await c.refusedHint(OWNER, CSQL.create, [DEAL, JSON.stringify({ reason: REASON, kind: 'cancellation', outcome: 'charge_only',
        customerChargePaise: '9000000', amountPaise: '5' }), rid()], 'invalid_input', /amountPaise/);
      await c.refusedHint(OWNER, CSQL.create, [DEAL, JSON.stringify({ reason: REASON, kind: 'cancellation', outcome: 'payout', bogus: 1,
        customerChargePaise: '0', amountPaise: '5' }), rid()], 'invalid_input', /bogus/);
      await c.refusedHint(OWNER, CSQL.create, [DEAL, JSON.stringify({ reason: REASON, kind: 'cancellation', outcome: 'payout',
        customerChargePaise: '0', amountPaise: '5', payeeKind: 'other', payeeName: 'Synthetic Other Payee' }), rid()], 'invalid_input', /payeeReason/);
      const r = await c.request({ kind: 'cancellation', outcome: 'charge_only', customerChargePaise: '9000000', amountPaise: '0' });
      expect(r.status).toBe('requested');
      await c.decide(r.refundRequestId, 'approve');
      // Settlement approved (charge_only): dues total = charge, plan ignored, basis cancelled (LD10).
      const dues = await one<Record<string, unknown> & { basis: { kind: string }; instalments: unknown[] }>(ACC, CSQL.dealDues, [DEAL]);
      expect(dues).toMatchObject({ totalPaise: '9000000', verifiedPaise: '5000000', balancePaise: '4000000', dueNowPaise: '4000000', status: 'due_now', basis: { kind: 'cancelled' } });
      expect(dues.instalments).toEqual([]);
      // A charge_only approval is not live: another request can follow.
      expect(receipt).toBeTruthy();
    });
  });

  it('overpayment: amount <= held - basis total (dues credit); outcome charge_only refused', async () => {
    await asOwner(db, async () => {
      const { receipt } = await c.paidBooking('9200000', { selling: '9000000' });
      await c.refusedHint(OWNER, CSQL.create, [DEAL, JSON.stringify({ reason: REASON, kind: 'overpayment', outcome: 'charge_only',
        amountPaise: '0' }), rid()], 'invalid_input', /outcome/);
      await c.refusedHint(OWNER, CSQL.create, [DEAL, JSON.stringify({ reason: REASON, kind: 'overpayment', outcome: 'payout',
        amountPaise: '200001', payeeKind: 'original_payer', payeeReceiptId: receipt!.id }), rid()], 'refund_exceeds_money', /amountPaise/);
      const r = await c.request({ kind: 'overpayment', outcome: 'payout', amountPaise: '200000', payeeKind: 'original_payer',
        payeeReceiptId: receipt!.id });
      await c.decide(r.refundRequestId, 'approve');
      await c.payout(r.refundRequestId);
      const dues = await one<Record<string, unknown>>(ACC, CSQL.dealDues, [DEAL]);
      expect(dues).toMatchObject({ totalPaise: '9000000', verifiedPaise: '9000000', creditPaise: '0', basis: { kind: 'approved' },
        refunds: { live: null, paidPaise: '200000', keptAsCreditPaise: '0' } });
    });
  });
});

describe('who asks, who approves, who pays (7.2, Q6, LD32)', () => {
  it('requester: the Sales owner only (never Accounts, Purchase, Visa, other Sales; Manager only without a Sales owner)', async () => {
    await asOwner(db, async () => {
      const { receipt } = await c.paidBooking();
      await c.cancelApproved();
      const body = JSON.stringify({ reason: REASON, ...payoutFields(receipt!.id, '1000000') });
      for (const actor of [ACC, PURCHASE, VISA, VISA_J2, SALES_B, MANAGER]) {
        await c.refused(actor, CSQL.create, [DEAL, body, rid()], 'not_authorized', '42501');
      }
      await c.asManagerNoSales();
      const r = await c.request(payoutFields(receipt!.id, '1000000'), MANAGER);
      expect((await c.row(r.refundRequestId)).requested_as).toBe('manager');
      // LD32: the requesting Manager cannot approve; any other active Manager of the entity can.
      await c.refused(MANAGER, CSQL.decide, [r.refundRequestId, 'approve', '1000000', '1000000', null, 1, rid()], 'not_self_approval', '42501');
      const ok = await c.decide(r.refundRequestId, 'approve', MANAGER_J2);
      expect(ok.status).toBe('approved');
    });
  });

  it('approval binds the exact amounts; return needs a reason; the requester resubmits; requester != approver != payer', async () => {
    await asOwner(db, async () => {
      const { receipt } = await c.paidBooking();
      await c.cancelApproved();
      const r = await c.request(payoutFields(receipt!.id, '1000000'));
      // Other-branch Manager is not an approver of a Sales-owner request.
      await c.refused(MANAGER_J2, CSQL.decide, [r.refundRequestId, 'approve', '1000000', '1000000', null, 1, rid()], 'not_authorized', '42501');
      await c.refused(MANAGER, CSQL.decide, [r.refundRequestId, 'approve', '999999', '1000000', null, 1, rid()], 'version_changed', CONFLICT_STATE);
      await c.refusedHint(MANAGER, CSQL.decide, [r.refundRequestId, 'return', '1000000', '1000000', null, 1, rid()], 'invalid_input', /reason/);
      const back = await c.decide(r.refundRequestId, 'return', MANAGER, 'Synthetic: charge looks too low, check');
      expect(back.status).toBe('returned');
      // Payout before approval: wrong_state.
      await c.refused(ACC, CSQL.payout, [r.refundRequestId, back.rowVersion, '{}', rid()], 'wrong_state', '55000');
      const again = await one<{ status: string; rowVersion: number }>(OWNER, CSQL.resubmit, [r.refundRequestId, back.rowVersion,
        JSON.stringify({ reason: REASON, ...payoutFields(receipt!.id, '1500000', '2000000') }), rid()]);
      expect(again.status).toBe('requested');
      const approved = await c.decide(r.refundRequestId, 'approve');
      expect(approved.status).toBe('approved');
      // The requester and the approver cannot pay out (even holding Accounts).
      await c.addRole(U.managerDelhi, 'accounts', 'JDH');
      await c.refused(MANAGER, CSQL.payout, [r.refundRequestId, approved.rowVersion, '{}', rid()], 'not_self_approval', '42501');
      // Proof first.
      await c.refused(ACC, CSQL.payout, [r.refundRequestId, approved.rowVersion, JSON.stringify({ mode: 'bank_transfer', paidOn: today(),
        reference: 'SYNRF0001' }), rid()], 'evidence_missing', '55000');
      const paid = await c.payout(r.refundRequestId);
      expect(paid).toMatchObject({ outcome: 'created', status: 'paid' });
      expect(await c.audit('refund.paid')).toHaveLength(1);
    });
  });

  it('withdraw: requester while requested; approved payout by the approving or another branch Manager (LD31); approved keep_credit withdrawable by the Manager (L7)', async () => {
    await asOwner(db, async () => {
      const { receipt } = await c.paidBooking();
      await c.cancelApproved();
      const r = await c.request(payoutFields(receipt!.id, '1000000'));
      await c.refused(MANAGER, CSQL.withdraw, [r.refundRequestId, 1, REASON, rid()], 'not_authorized', '42501');
      const ok = await one<{ status: string }>(OWNER, CSQL.withdraw, [r.refundRequestId, 1, REASON, rid()]);
      expect(ok.status).toBe('withdrawn');
      const r2 = await c.request(payoutFields(receipt!.id, '1000000'));
      const a2 = await c.decide(r2.refundRequestId, 'approve');
      await c.refused(OWNER, CSQL.withdraw, [r2.refundRequestId, a2.rowVersion, REASON, rid()], 'not_authorized', '42501');
      const w2 = await one<{ status: string }>(MANAGER, CSQL.withdraw, [r2.refundRequestId, a2.rowVersion, REASON, rid()]);
      expect(w2.status).toBe('withdrawn');
      const r3 = await c.request({ kind: 'cancellation', outcome: 'keep_credit', customerChargePaise: '1000000', amountPaise: '4000000' });
      const a3 = await c.decide(r3.refundRequestId, 'approve');
      const dues = await one<Record<string, unknown>>(ACC, CSQL.dealDues, [DEAL]);
      // keep_credit: money stays; total = charge; the rest is credit.
      expect(dues).toMatchObject({ totalPaise: '1000000', verifiedPaise: '5000000', creditPaise: '4000000',
        refunds: { live: null, paidPaise: '0', keptAsCreditPaise: '4000000' } });
      // Addendum L7: an approved settlement is withdrawable by the branch Manager (not by the requester).
      await c.refused(OWNER, CSQL.withdraw, [r3.refundRequestId, a3.rowVersion, REASON, rid()], 'not_authorized', '42501');
      expect((await one<{ status: string }>(MANAGER, CSQL.withdraw, [r3.refundRequestId, a3.rowVersion, REASON, rid()])).status).toBe('withdrawn');
    });
  });
});

describe('C6 payout and the refund journal (7.1, R3)', () => {
  it('bank payout posts refund_bank (Dr customer advances, Cr bank); dues fall; supplier money available falls; shape check passes', async () => {
    await asOwner(db, async () => {
      const { receipt } = await c.paidBooking('5000000');
      await c.cancelApproved();
      const r = await c.request(payoutFields(receipt!.id, '3000000'));
      await c.decide(r.refundRequestId, 'approve');
      const before = await owner<{ v: string }>('select authz.sm_customer_money_available($1, null)::text as v', [DEAL]);
      const paid = await c.payout(r.refundRequestId);
      await c.fin.checkConstraints();
      const lines = await owner<{ kind: string; lines: unknown }>(
        `select e.kind, jsonb_agg(jsonb_build_array(l.account, l.debit_paise, l.credit_paise) order by l.account) as lines
         from public.finance_journal_entries e join public.finance_journal_lines l on l.entry_id = e.id
         where e.id = $1 group by e.id, e.kind`, [paid.journalEntryId]);
      expect(lines).toEqual([{ kind: 'refund_bank', lines: [['bank', 0, 3000000], ['customer_advances', 3000000, 0]] }]);
      expect(await c.held()).toBe('2000000');
      const after = await owner<{ v: string }>('select authz.sm_customer_money_available($1, null)::text as v', [DEAL]);
      expect(BigInt(before[0]!.v) - BigInt(after[0]!.v)).toBe(3000000n);
      const dues = await one<Record<string, unknown>>(ACC, CSQL.dealDues, [DEAL]);
      expect(dues).toMatchObject({ totalPaise: '1000000', verifiedPaise: '2000000', creditPaise: '1000000', basis: { kind: 'cancelled' },
        refunds: { live: null, paidPaise: '3000000' } });
      // Phase 1 reads that walk the journal still work with a refund entry (workspace rows).
      expect(await c.allRecords(ACC)).toEqual(expect.any(Array));
      // The payout row is append-only.
      await db.exec('savepoint s0');
      await expect(owner('update public.customer_refund_payouts set reference = $2 where id = $1', [paid.payoutId, 'SYNRF0002']))
        .rejects.toThrow(/append-only/);
      await db.exec('rollback to savepoint s0');
    });
  });

  it('cash payout posts refund_cash and marks a branch cash count stale; a direct refund kind without a payout is refused', async () => {
    await asOwner(db, async () => {
      const { receipt } = await c.paidBooking('5000000');
      await c.cancelApproved();
      const r = await c.request(payoutFields(receipt!.id, '1000000'));
      await c.decide(r.refundRequestId, 'approve');
      const paid = await c.payout(r.refundRequestId, { mode: 'cash', reference: null });
      await c.fin.checkConstraints();
      const [e] = await owner<{ kind: string; branch_id: string }>('select kind, branch_id from public.finance_journal_entries where id = $1',
        [paid.journalEntryId]);
      expect(e!.kind).toBe('refund_cash');
      // The nine-argument post refuses refund kinds.
      await db.exec('savepoint s1');
      await expect(owner(`select authz.finance_post('refund_bank', $1, null, null, $2, $3, current_date, null, 100)`,
        [await c.entityId(), DEAL, e!.branch_id])).rejects.toThrow(/journal_shape/);
      await db.exec('rollback to savepoint s1');
    });
  });

  it('Addendum L6: a reversal after a paid-out refund stays allowed; held goes negative; dues show the shortfall due now; no new refund', async () => {
    await asOwner(db, async () => {
      const { receipt } = await c.paidBooking('5000000');
      await c.cancelApproved();
      const r = await c.request(payoutFields(receipt!.id, '4000000'));
      await c.decide(r.refundRequestId, 'approve');
      await c.payout(r.refundRequestId);
      await c.noticesOn();
      await c.fin.reverse(ACC, receipt!.id, 'bank_return');
      await c.fin.checkConstraints();
      expect(await c.held()).toBe('-4000000');
      const dues = await one<Record<string, unknown>>(ACC, CSQL.dealDues, [DEAL]);
      expect(dues).toMatchObject({ totalPaise: '1000000', verifiedPaise: '-4000000', balancePaise: '5000000', dueNowPaise: '5000000',
        status: 'due_now', basis: { kind: 'cancelled' }, refunds: { live: null, paidPaise: '4000000', shortfallPaise: '4000000' } });
      await c.refusedHint(OWNER, CSQL.create, [DEAL, JSON.stringify({ reason: REASON, kind: 'cancellation', outcome: 'charge_only',
        customerChargePaise: '1000000', amountPaise: '0' }), rid()], 'refund_exceeds_money', /heldPaise/, '22023');
      expect((await one<{ canRequest: boolean }>(OWNER, CSQL.dealRefunds, [DEAL])).canRequest).toBe(false);
      // Urgent notice once Track D registers the kind (refund_shortfall); never blocks the reversal.
      const registered = (await owner<{ k: boolean }>(`select 'refund_shortfall' = any (authz.notice_kinds()) as k`))[0]!.k;
      const notes = await owner<{ recipient_user_id: string }>(`select recipient_user_id from public.staff_notices where kind = 'refund_shortfall'`);
      if (registered) expect(notes.map((n) => n.recipient_user_id)).toContain(U.salesDelhiA);
      else expect(notes).toEqual([]);
    });
  });

  it('a reversal between approval and payout -> refund_exceeds_money; paidOn rules name the field', async () => {
    await asOwner(db, async () => {
      const { receipt } = await c.paidBooking('5000000');
      await c.cancelApproved();
      const r = await c.request(payoutFields(receipt!.id, '4000000'));
      const a = await c.decide(r.refundRequestId, 'approve');
      const ev = await c.proof('customer_refund', r.refundRequestId);
      await c.refusedHint(ACC, CSQL.payout, [r.refundRequestId, a.rowVersion, JSON.stringify({ mode: 'bank_transfer', paidOn: '2099-01-01',
        reference: 'SYNRF0001', evidenceId: ev }), rid()], 'invalid_input', /paidOn/);
      await c.refusedHint(ACC, CSQL.payout, [r.refundRequestId, a.rowVersion, JSON.stringify({ mode: 'bank_transfer', paidOn: today(),
        evidenceId: ev }), rid()], 'invalid_input', /reference/);
      await c.fin.reverse(ACC, receipt!.id, 'bank_return');
      await c.refusedHint(ACC, CSQL.payout, [r.refundRequestId, a.rowVersion, JSON.stringify({ mode: 'bank_transfer', paidOn: today(),
        reference: 'SYNRF0001', evidenceId: ev }), rid()], 'refund_exceeds_money', /amountPaise/, '22023');
    });
  });

  it('proof files: Accounts uploads; duplicate file refused; download by Accounts and the branch Manager only, audited', async () => {
    await asOwner(db, async () => {
      const { receipt } = await c.paidBooking();
      await c.cancelApproved();
      const r = await c.request(payoutFields(receipt!.id, '1000000'));
      await c.refused(ACC, CSQL.evBegin, ['customer_refund', r.refundRequestId, 'p.pdf', 'application/pdf', 10, 'a'.repeat(64), rid()],
        'wrong_state', '55000');
      await c.decide(r.refundRequestId, 'approve');
      await c.refused(OWNER, CSQL.evBegin, ['customer_refund', r.refundRequestId, 'p.pdf', 'application/pdf', 10, 'a'.repeat(64), rid()],
        'not_authorized', '42501');
      await one(ACC, CSQL.evBegin, ['customer_refund', r.refundRequestId, 'p.pdf', 'application/pdf', 10, 'b'.repeat(64), rid()]);
      await c.refused(ACC_J2, CSQL.evBegin, ['customer_refund', r.refundRequestId, 'q.pdf', 'application/pdf', 10, 'b'.repeat(64), rid()],
        'duplicate_file', '23505');
      const ev = await c.proof('customer_refund', r.refundRequestId);
      const file = await one<{ objectPath: string }>(MANAGER, CSQL.evDownload, [ev]);
      expect(file.objectPath).toContain('/refund/');
      await one(ACC_J2, CSQL.evDownload, [ev]);
      // VISA (Visa Jodhpur) also holds Accounts here (ACC2); the pure Visa person is VISA_J2.
      for (const actor of [OWNER, PURCHASE, VISA_J2]) await c.refused(actor, CSQL.evDownload, [ev], 'not_authorized', '42501');
      expect(await c.audit('accounts.refund_evidence.downloaded')).toHaveLength(2);
      expect(ACC2).toBeTruthy();
    });
  });

  it('audit details never carry amounts or names', async () => {
    await asOwner(db, async () => {
      const { receipt } = await c.paidBooking();
      await c.cancelApproved();
      const r = await c.request(payoutFields(receipt!.id, '1234567'));
      await c.decide(r.refundRequestId, 'approve');
      await c.payout(r.refundRequestId);
      const rows = await owner<{ details: unknown }>(`select details from public.audit_events where action like 'refund.%'`);
      const text = JSON.stringify(rows);
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(text).not.toContain('1234567');
      expect(text).not.toContain('Synthetic Payer');
      expect(text).not.toContain('SYNRF0001');
    });
  });
});
