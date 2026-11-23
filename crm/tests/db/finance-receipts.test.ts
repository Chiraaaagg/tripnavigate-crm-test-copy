import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountsDealDetailSchema } from '@/modules/finance/dto';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACC, ACC2, ANON, DEAL, DEAL2, MANAGER, PURCHASE, SALES, SUPER, daysAgo, financeHelpers, rid, sha, today } from './finance-support';

/**
 * Phase 5A customer receipts (phase-5a-contract.md sections 9-11): record,
 * verify, reject, correction, duplicate references, retry identity, cash caps,
 * cheque transitions and reversal, plus the journal entries each one posts.
 */

let db: TestDb;
// Finance db files share fixture deal heads, the policy head and counters on
// one real Postgres in CI: serialise them with the agreed session lock.
const FINANCE_SUITE_LOCK = 5000000001;
beforeAll(async () => {
  db = await createTestDb();
  await db.query('select pg_advisory_lock($1)', [FINANCE_SUITE_LOCK]);
});
afterAll(async () => {
  await db?.query('select pg_advisory_unlock($1)', [FINANCE_SUITE_LOCK]).catch(() => undefined);
  await db?.close();
});

const h = financeHelpers(() => db);

describe('recording', () => {
  it('records a bank receipt with an internal number and posts nothing', async () => {
    await asOwner(db, async () => {
      const rec = await h.record(ACC, DEAL, await h.bankFields());
      expect(rec).toMatchObject({ outcome: 'created', status: 'recorded' });
      expect(rec.receiptNo).toMatch(/^R-\d{4}-\d{2}-000001$/);
      const second = await h.record(ACC, DEAL, await h.bankFields());
      expect(second.receiptNo).toMatch(/-000002$/);
      expect(await h.entries(rec.id)).toEqual([]);
      const [row] = await h.owner<{ policy: number; fy: string }>(
        `select v.version_no as policy, r.fiscal_year as fy from public.customer_receipts r
         join public.finance_policy_versions v on v.id = r.policy_version_id where r.id = $1`,
        [rec.id],
      );
      expect(row!.policy).toBe(1);
      expect(rec.receiptNo).toContain(row!.fy);
    });
  });

  it('refuses everyone except Accounts', async () => {
    await asOwner(db, async () => {
      const fields = JSON.stringify(await h.bankFields());
      for (const actor of [SALES, PURCHASE, SUPER, MANAGER, ANON]) {
        await h.refused(actor, h.RECORD, [DEAL, fields, rid()], actor === ANON ? '42501' : '42501');
      }
      await h.refused({ ...ACC, aal: 'aal1' }, h.RECORD, [DEAL, fields, rid()], '42501', 'not_authorized');
      // Mixed Accounts + Purchase is refused (Purchase never sees selling totals).
      await h.owner(
        `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
         select $1, b.legal_entity_id, b.id, 'purchase', 'active' from public.branches b where b.code = 'DEL'`,
        [ACC.userId],
      );
      await h.refused(ACC, h.RECORD, [DEAL, fields, rid()], '42501', 'not_authorized');
    });
  });

  it('refuses another entity and gates on the environment', async () => {
    await asOwner(db, async () => {
      const fields = JSON.stringify(await h.bankFields());
      await h.refused(ACC, h.RECORD, ['d0000000-0000-4000-8000-000000000006', fields, rid()], '42501', 'not_authorized');
      await h.setEnvironment('unset');
      await h.refused(ACC, h.RECORD, [DEAL, fields, rid()], '55000', 'environment_unset');
      await h.setEnvironment('staging');
      await h.refused(ACC, h.RECORD, [DEAL, fields, rid()], '55000', 'not_configured');
      // operational: synthetic deals are refused; modes follow the live switches.
      await h.setEnvironment('operational');
      await h.refused(ACC, h.RECORD, [DEAL, fields, rid()], '55000', 'not_configured');
      const entity = await h.entityId();
      const allowed = async () =>
        (await h.owner<{ v: boolean }>(`select authz.finance_mode_allowed($1, 'upi') as v`, [entity]))[0]!.v;
      expect(await allowed()).toBe(false);
      await h.owner(`update public.finance_live_settings set upi_live = true where legal_entity_id = $1`, [entity]);
      expect(await allowed()).toBe(true);
    });
  });

  it('refuses a finance-disabled entity with not_configured', async () => {
    await asOwner(db, async () => {
      const fields = JSON.stringify(await h.bankFields());
      await h.owner(`delete from public.finance_live_settings`);
      await h.refused(ACC, h.RECORD, [DEAL, fields, rid()], '55000', 'not_configured');
    });
  });

  it('validates every field (invalid_input)', async () => {
    await asOwner(db, async () => {
      const bad: Array<Record<string, unknown>> = [
        { amountPaise: '0' },
        { amountPaise: '12.50' },
        { amountPaise: '1000000001' }, // above the receipt maximum
        { receivedOn: daysAgo(31) },
        { receivedOn: '2099-01-01' },
        { payerPan: 'abc', payerMobile: null },
        { payerPan: null, payerMobile: null },
        { payerPan: null, payerMobile: '12345' },
        { reference: 'ab' },
        { reference: null },
        { micrCode: '110002003' },
        { collectorUserId: SALES.userId },
        { branchId: 'b0000000-0000-4000-8000-0000000000b1' },
        { unknownKey: 1 },
        { mode: 'crypto' },
        { note: 'x'.repeat(501) },
      ];
      for (const over of bad) {
        await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify(await h.bankFields(over)), rid()], '22023', 'invalid_input');
      }
      // Mobile normalisation: +91 and a leading 0 are removed.
      const rec = await h.record(ACC, DEAL, await h.bankFields({ payerPan: null, payerMobile: '0 98765 43210' }));
      const [row] = await h.owner<{ m: string }>(`select payer_mobile as m from public.customer_receipts where id = $1`, [rec.id]);
      expect(row!.m).toBe('9876543210');
      // Cheques must be account payee; cash needs a collector.
      await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify(await h.chequeFields({ accountPayee: false })), rid()], '22023', 'invalid_input');
      await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify(await h.cashFields({ collectorUserId: null })), rid()], '22023', 'invalid_input');
    });
  });
});

describe('verification and rejection', () => {
  it('verifies a bank receipt by another Accounts person with stored proof, then posts', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const rec = await h.record(ACC, DEAL, await h.bankFields());
      await h.refused(ACC, 'select public.receipt_verify($1, $2) as r', [rec.id, rid()], '42501', 'not_self_approval');
      await h.refused(ACC2, 'select public.receipt_verify($1, $2) as r', [rec.id, rid()], '55000', 'evidence_required');
      await h.proof(ACC, 'receipt', rec.id, 'bank_proof');
      expect(await h.verify(ACC2, rec.id)).toMatchObject({ outcome: 'updated', status: 'verified' });
      expect(await h.entries(rec.id)).toEqual([
        { kind: 'receipt_bank', lines: [['bank', 2500000, 0], ['customer_advances', 0, 2500000]] },
      ]);
      expect(await h.available(DEAL)).toBe('2500000');
      await h.refused(ACC2, 'select public.receipt_verify($1, $2) as r', [rec.id, rid()], '55000', 'wrong_state');
      await h.checkConstraints();
    });
  });

  it('refuses the deal owner or a Sales assignee holding Accounts (not_self_approval)', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const rec = await h.record(ACC, DEAL, await h.bankFields());
      await h.proof(ACC, 'receipt', rec.id, 'bank_proof');
      await h.addSalesAssignment(DEAL, ACC2.userId!);
      await h.refused(ACC2, 'select public.receipt_verify($1, $2) as r', [rec.id, rid()], '42501', 'not_self_approval');
      await h.refused(ACC2, 'select public.receipt_reject($1, $2, $3, $4) as r', [rec.id, 'data_error', 'Synthetic reason here', rid()], '42501', 'not_self_approval');
    });
  });

  it('verifies cash without evidence (posts to the collecting branch) and rejects with a reason', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const cash = await h.verifiedCash();
      const [entry] = await h.entries(cash.id);
      expect(entry).toEqual({ kind: 'receipt_cash', lines: [['cash_in_hand', 1000000, 0], ['customer_advances', 0, 1000000]] });
      const [line] = await h.owner<{ b: string }>(
        `select l.branch_id as b from public.finance_journal_lines l join public.finance_journal_entries e on e.id = l.entry_id
         where e.receipt_id = $1 and l.account = 'cash_in_hand'`,
        [cash.id],
      );
      expect(line!.b).toBe(await h.branchId('JDH'));

      const other = await h.record(ACC, DEAL, await h.bankFields());
      await h.refused(ACC2, 'select public.receipt_reject($1, $2, $3, $4) as r', [other.id, 'data_error', 'short', rid()], '22023', 'invalid_input');
      await h.refused(ACC2, 'select public.receipt_reject($1, $2, $3, $4) as r', [other.id, 'lost', 'Synthetic long reason', rid()], '22023', 'invalid_input');
      await h.refused(ACC, 'select public.receipt_reject($1, $2, $3, $4) as r', [other.id, 'data_error', 'Synthetic long reason', rid()], '42501', 'not_self_approval');
      expect(await h.reject(ACC2, other.id, 'not_received')).toMatchObject({ status: 'rejected' });
      expect(await h.entries(other.id)).toEqual([]);
    });
  });
});

describe('retry identity', () => {
  it('replays an exact retry, even after a policy change, and refuses a changed payload or actor', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const fields = await h.bankFields();
      const requestId = rid();
      const first = await h.record(ACC, DEAL, fields, requestId);
      await h.one(SUPER, 'select public.finance_policy_update($1, $2::jsonb, null, $3, $4) as r', [
        await h.entityId(), JSON.stringify({ receiptMaxPaise: '100' }), 'Synthetic lower receipt maximum', rid(),
      ]);
      const again = await h.record(ACC, DEAL, fields, requestId);
      expect(again).toEqual({ ...first, outcome: 'existing' });
      expect((await h.owner<{ n: number }>(`select count(*)::int as n from public.customer_receipts where deal_id = $1`, [DEAL]))[0]!.n).toBe(1);
      await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify({ ...fields, amountPaise: '2500001' }), requestId], '40001', 'request_conflict');
      await h.refused(ACC2, h.RECORD, [DEAL, JSON.stringify(fields), requestId], '40001', 'request_conflict');
      // A refusal reserves nothing: the refused id can be used for another command.
      const refusedId = rid();
      await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify(await h.bankFields({ amountPaise: '1000' })), refusedId], '22023', 'invalid_input');
      // (receipt maximum is now 100 paise) a valid amount works with the same id
      expect((await h.record(ACC, DEAL, await h.bankFields({ amountPaise: '100' }), refusedId)).outcome).toBe('created');
      // Verify retry returns the stored result after a later state change.
      await h.proof(ACC, 'receipt', first.id, 'bank_proof');
      const vid = rid();
      await h.verify(ACC2, first.id, vid);
      await h.reverse(ACC, first.id, 'data_error');
      expect((await h.verify(ACC2, first.id, vid)).outcome).toBe('existing');
    });
  });
});

describe('duplicate references and correction', () => {
  it('shares one reference namespace across bank transfer and UPI, and MICR + number for cheques', async () => {
    await asOwner(db, async () => {
      await h.record(ACC, DEAL, await h.bankFields({ reference: 'abc-123456' }));
      await h.refused(ACC, h.RECORD, [DEAL2, JSON.stringify(await h.bankFields({ mode: 'upi', reference: 'ABC123456' })), rid()], '23505', 'duplicate_reference');
      await h.record(ACC, DEAL, await h.chequeFields({ chequeNumber: '555555' }));
      await h.refused(ACC, h.RECORD, [DEAL2, JSON.stringify(await h.chequeFields({ chequeNumber: '555555' })), rid()], '23505', 'duplicate_reference');
      expect((await h.record(ACC, DEAL, await h.chequeFields({ chequeNumber: '555555', micrCode: '400002003' }))).outcome).toBe('created');
    });
  });

  it('corrects a data_error rejection reusing the genuine reference; the original stays linked', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const orig = await h.record(ACC, DEAL, await h.bankFields({ reference: 'UTR777000111', amountPaise: '100' }));
      await h.reject(ACC2, orig.id, 'data_error');
      const fixed = await h.record(ACC, DEAL, await h.bankFields({ reference: 'UTR777000111', correctsReceiptId: orig.id }));
      const [row] = await h.owner<{ c: string }>(`select corrected_by_receipt_id as c from public.customer_receipts where id = $1`, [orig.id]);
      expect(row!.c).toBe(fixed.id);
      // Only once, same deal and mode, and only from a data_error outcome.
      await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify(await h.bankFields({ correctsReceiptId: orig.id })), rid()], '55000', 'wrong_state');
      const notReceived = await h.record(ACC, DEAL, await h.bankFields());
      await h.reject(ACC2, notReceived.id, 'not_received');
      await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify(await h.bankFields({ correctsReceiptId: notReceived.id })), rid()], '55000', 'wrong_state');
      // A correction may only be rejected as data_error.
      await h.refused(ACC2, 'select public.receipt_reject($1, $2, $3, $4) as r', [fixed.id, 'not_received', 'Synthetic long reason', rid()], '22023', 'invalid_input');
      // Detail shows the link both ways.
      const detail = AccountsDealDetailSchema.parse(await h.one(ACC, 'select public.accounts_deal_detail($1) as r', [DEAL]));
      const o = detail.receipts.find((r) => r.receiptId === orig.id)!;
      const f = detail.receipts.find((r) => r.receiptId === fixed.id)!;
      expect(o.correctedByReceiptNo).toBe(fixed.receiptNo);
      expect(f.correctsReceiptNo).toBe(orig.receiptNo);
      expect(o.actions.correct).toBe('wrong_state');
    });
  });
});

describe('cash caps (contract 9.2)', () => {
  it('applies the payer-day cap across deals and branches of the entity', async () => {
    await asOwner(db, async () => {
      await h.record(ACC, DEAL, await h.cashFields({ amountPaise: '4000000' }));
      await h.record(ACC, DEAL2, await h.cashFields({ amountPaise: '999900', branchId: await h.branchId('DEL') }));
      // 40,000 + 9,999 = 49,999 rupees: exactly at the cap. One more paisa breaches it.
      await h.refused(ACC, h.RECORD, [DEAL2, JSON.stringify(await h.cashFields({ amountPaise: '1', payerMobile: '9876500000' })), rid()], '55000', 'cash_cap_exceeded');
      // Another payer is not affected; another day is not affected.
      expect((await h.record(ACC, DEAL2, await h.cashFields({ amountPaise: '1', payerPan: 'ZZZZZ9999Z' }))).outcome).toBe('created');
      expect((await h.record(ACC, DEAL2, await h.cashFields({ amountPaise: '1', receivedOn: daysAgo(1) }))).outcome).toBe('created');
    });
  });

  it('keys on the mobile too, and applies the trip cap per deal', async () => {
    await asOwner(db, async () => {
      await h.record(ACC, DEAL, await h.cashFields({ amountPaise: '4999900', payerPan: null, payerMobile: '9000000001', receivedOn: daysAgo(2) }));
      await h.refused(ACC, h.RECORD, [DEAL2, JSON.stringify(await h.cashFields({ amountPaise: '1', payerPan: 'NEWPN1234A', payerMobile: '9000000001', receivedOn: daysAgo(2) })), rid()], '55000', 'cash_cap_exceeded');
      // Trip cap: a different payer and day on the same deal still breaches.
      await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify(await h.cashFields({ amountPaise: '1', payerPan: 'OTHER1234X' })), rid()], '55000', 'cash_cap_exceeded');
    });
  });

  it('excludes not_received outcomes; a correction neither double counts nor erases cash', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const lost = await h.record(ACC, DEAL, await h.cashFields({ amountPaise: '4999900' }));
      await h.reject(ACC2, lost.id, 'not_received');
      const real = await h.record(ACC, DEAL, await h.cashFields({ amountPaise: '4999900' }));
      await h.reject(ACC2, real.id, 'data_error');
      // Rejected as data_error: the cash arrived and still counts.
      await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify(await h.cashFields({ amountPaise: '1' })), rid()], '55000', 'cash_cap_exceeded');
      // The correction replaces it (the original is excluded), so the same amount fits once.
      const fixed = await h.record(ACC, DEAL, await h.cashFields({ amountPaise: '4999900', correctsReceiptId: real.id }));
      expect(fixed.outcome).toBe('created');
      await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify(await h.cashFields({ amountPaise: '1' })), rid()], '55000', 'cash_cap_exceeded');
      // Rejecting the correction as data_error keeps it counted (cash arrived once).
      await h.reject(ACC2, fixed.id, 'data_error');
      await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify(await h.cashFields({ amountPaise: '1' })), rid()], '55000', 'cash_cap_exceeded');
    });
  });

  it('a zero cap turns cash off; the cap kind arrives in DETAIL', async () => {
    await asOwner(db, async () => {
      await h.one(SUPER, 'select public.finance_policy_update($1, $2::jsonb, null, $3, $4) as r', [
        await h.entityId(), JSON.stringify({ cashTripCapPaise: '0' }), 'Synthetic: cash off by policy', rid(),
      ]);
      await db.exec('savepoint s');
      let detail: string | undefined;
      try {
        await h.record(ACC, DEAL, await h.cashFields({ amountPaise: '1' }));
      } catch (error) {
        detail = (error as { detail?: string }).detail;
        expect((error as { message: string }).message).toBe('cash_cap_exceeded');
      }
      await db.exec('rollback to savepoint s');
      expect(detail).toBe('trip');
    });
  });
});

describe('cheques (contract 9.3)', () => {
  it('verify -> pending_clearance (no posting) -> clear posts; bounce, re-present and stop', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const chq = await h.record(ACC, DEAL, await h.chequeFields());
      await h.refused(ACC2, 'select public.receipt_verify($1, $2) as r', [chq.id, rid()], '55000', 'evidence_required');
      await h.proof(ACC, 'receipt', chq.id, 'cheque_image');
      expect((await h.verify(ACC2, chq.id)).status).toBe('pending_clearance');
      expect(await h.entries(chq.id)).toEqual([]);
      expect(await h.available(DEAL)).toBe('0');
      // Clearance needs bank proof; the recorder cannot clear.
      await h.refused(ACC2, 'select public.cheque_clear($1, $2::date, $3) as r', [chq.id, today(), rid()], '55000', 'evidence_required');
      await h.refused(ACC, 'select public.cheque_clear($1, $2::date, $3) as r', [chq.id, today(), rid()], '42501', 'not_self_approval');
      // Bounce with proof; re-presentation needs NEW evidence.
      await h.proof(ACC, 'receipt', chq.id, 'bank_proof');
      expect((await h.mark(ACC2, chq.id, 'bounced')).status).toBe('bounced');
      await h.refused(ACC2, 'select public.cheque_represent($1, $2) as r', [chq.id, rid()], '55000', 'evidence_required');
      await h.proof(ACC, 'receipt', chq.id, 'cheque_image');
      expect((await h.represent(ACC2, chq.id)).status).toBe('pending_clearance');
      // The old bank proof (before re-presentation) is not enough to clear.
      await h.refused(ACC2, 'select public.cheque_clear($1, $2::date, $3) as r', [chq.id, today(), rid()], '55000', 'evidence_required');
      await h.proof(ACC, 'receipt', chq.id, 'bank_proof');
      await h.refused(ACC2, 'select public.cheque_clear($1, $2::date, $3) as r', [chq.id, daysAgo(1), rid()], '22023', 'invalid_input');
      expect((await h.clear(ACC2, chq.id)).status).toBe('cleared');
      expect(await h.entries(chq.id)).toEqual([
        { kind: 'receipt_bank', lines: [['bank', 3000000, 0], ['customer_advances', 0, 3000000]] },
      ]);
      // Reversal: not by the person who cleared it.
      await h.refused(ACC2, 'select public.receipt_reverse($1, $2, $3, $4) as r', [chq.id, 'bank_return', 'Synthetic bank return', rid()], '42501', 'not_self_approval');
      expect((await h.reverse(ACC, chq.id, 'bank_return')).status).toBe('reversed');
      expect(await h.available(DEAL)).toBe('0');
      await h.checkConstraints();
    });
  });

  it('clearance and bounce proof must be newer than the presentation', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const chq = await h.record(ACC, DEAL, await h.chequeFields());
      await h.proof(ACC, 'receipt', chq.id, 'cheque_image');
      const early = await h.proof(ACC, 'receipt', chq.id, 'bank_proof');
      await h.verify(ACC2, chq.id);
      await h.refused(ACC2, 'select public.cheque_clear($1, $2::date, $3) as r', [chq.id, today(), rid()], '55000', 'evidence_required');
      await h.refused(ACC2, 'select public.cheque_mark($1, $2, $3::date, $4, $5) as r', [chq.id, 'bounced', today(), null, rid()], '55000', 'evidence_required');
      const detail = AccountsDealDetailSchema.parse(await h.one(ACC2, 'select public.accounts_deal_detail($1) as r', [DEAL]));
      expect(detail.receipts.find((r) => r.receiptId === chq.id)!.actions.cheque_clear).toBe('evidence_required');
      // Stored proof can no longer be removed once the cheque is presented.
      await h.refused(ACC, 'select public.finance_evidence_remove($1) as r', [early], '55000', 'wrong_state');
      await h.proof(ACC, 'receipt', chq.id, 'bank_proof');
      expect((await h.clear(ACC2, chq.id)).status).toBe('cleared');
    });
  });

  it('stopped needs bank proof; cancelled needs a note; neither posts', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      for (const kind of ['stopped', 'cancelled'] as const) {
        const chq = await h.record(ACC, DEAL, await h.chequeFields());
        await h.proof(ACC, 'receipt', chq.id, 'cheque_image');
        await h.verify(ACC2, chq.id);
        if (kind === 'stopped') {
          await h.refused(ACC2, 'select public.cheque_mark($1, $2, $3::date, $4, $5) as r', [chq.id, kind, today(), null, rid()], '55000', 'evidence_required');
          await h.proof(ACC, 'receipt', chq.id, 'bank_proof');
          expect((await h.mark(ACC2, chq.id, kind)).status).toBe('stopped');
        } else {
          await h.refused(ACC2, 'select public.cheque_mark($1, $2, $3::date, $4, $5) as r', [chq.id, kind, today(), null, rid()], '22023', 'invalid_input');
          expect((await h.mark(ACC2, chq.id, kind, 'Customer cancelled the synthetic cheque')).status).toBe('cancelled');
        }
        expect(await h.entries(chq.id)).toEqual([]);
      }
    });
  });
});

describe('reversal (contract 9.4)', () => {
  it('reverses a bank receipt with an exact reversal entry; the verifier cannot reverse', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const rec = await h.verifiedBank();
      await h.refused(ACC2, 'select public.receipt_reverse($1, $2, $3, $4) as r', [rec.id, 'bank_return', 'Synthetic bank return', rid()], '42501', 'not_self_approval');
      await h.refused(ACC, 'select public.receipt_reverse($1, $2, $3, $4) as r', [rec.id, 'refund', 'Synthetic bank return', rid()], '22023', 'invalid_input');
      await h.reverse(ACC, rec.id, 'bank_return');
      expect(await h.entries(rec.id)).toEqual([
        { kind: 'receipt_bank', lines: [['bank', 2500000, 0], ['customer_advances', 0, 2500000]] },
        { kind: 'reversal_bank', lines: [['bank', 0, 2500000], ['customer_advances', 2500000, 0]] },
      ]);
      expect(await h.available(DEAL)).toBe('0');
      await h.refused(ACC, 'select public.receipt_reverse($1, $2, $3, $4) as r', [rec.id, 'data_error', 'Synthetic second reversal', rid()], '55000', 'wrong_state');
      await h.checkConstraints();
    });
  });

  it('reverses undeposited cash against cash in hand and lists the custody item', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const cash = await h.verifiedCash();
      await h.refused(ACC, 'select public.receipt_reverse($1, $2, $3, $4) as r', [cash.id, 'bank_return', 'Synthetic bank return', rid()], '22023', 'invalid_input');
      await h.reverse(ACC, cash.id, 'not_received');
      const kinds = (await h.entries(cash.id)).map((e) => e.kind);
      expect(kinds).toEqual(['receipt_cash', 'reversal_cash_undeposited']);
      const overview = await h.one<{ branches: Array<{ branchId: string; cashInHandPaise: string; unresolved: Array<{ kind: string; receiptId: string }> }> }>(
        ACC, 'select public.accounts_cash_overview($1) as r', [await h.entityId()],
      );
      const items = overview.branches.flatMap((b) => b.unresolved.filter((u) => u.receiptId === cash.id));
      expect(items.map((u) => u.kind)).toEqual(['reversed_undeposited']);
      await h.checkConstraints();
    });
  });

  it('refuses reversal of cash in an unverified deposit; after verification it reverses against the bank', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const cash = await h.verifiedCash();
      const branch = await h.branchId('JDH');
      const slip = await h.proof(ACC, 'branch', branch, 'deposit_slip');
      const dep = await h.one<{ id: string }>(ACC, 'select public.cash_deposit_record($1, $2::uuid[], $3::date, $4, $5, $6) as r', [
        branch, [cash.id], today(), 'SLIP-0001', slip, rid(),
      ]);
      await h.refused(ACC2, 'select public.receipt_reverse($1, $2, $3, $4) as r', [cash.id, 'data_error', 'Synthetic data error', rid()], '42501', 'not_self_approval');
      await h.refused(ACC, 'select public.receipt_reverse($1, $2, $3, $4) as r', [cash.id, 'data_error', 'Synthetic data error', rid()], '55000', 'wrong_state');
      const detail = AccountsDealDetailSchema.parse(await h.one(ACC, 'select public.accounts_deal_detail($1) as r', [DEAL]));
      expect(detail.receipts.find((r) => r.receiptId === cash.id)!.actions.reverse).toBe('in_unverified_deposit');
      await h.one(ACC2, 'select public.cash_deposit_verify($1, $2) as r', [dep.id, rid()]);
      await h.reverse(ACC, cash.id, 'data_error');
      expect((await h.entries(cash.id)).map((e) => e.kind)).toEqual(['receipt_cash', 'reversal_cash_deposited']);
      await h.checkConstraints();
    });
  });
});

describe('evidence', () => {
  it('refuses reuse of the same file (sha256) for another receipt and freezes proof behind verified money', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const a = await h.record(ACC, DEAL, await h.bankFields());
      const b = await h.record(ACC, DEAL, await h.bankFields());
      const hash = sha();
      const ev = await h.proof(ACC, 'receipt', a.id, 'bank_proof', hash);
      await h.refused(ACC, 'select public.finance_evidence_begin($1, $2, $3, $4, $5, $6, $7, $8) as r',
        ['receipt', b.id, 'bank_proof', 'proof.pdf', 'application/pdf', 2048, hash, rid()], '23505', 'duplicate_reference');
      // Cash receipts take no bank proof; cheque images only for cheques.
      await h.refused(ACC, 'select public.finance_evidence_begin($1, $2, $3, $4, $5, $6, $7, $8) as r',
        ['receipt', b.id, 'cheque_image', 'proof.pdf', 'application/pdf', 2048, sha(), rid()], '22023', 'invalid_input');
      // Finish refuses a missing object (failed) and other uploaders.
      const begun = await h.one<{ id: string }>(ACC, 'select public.finance_evidence_begin($1, $2, $3, $4, $5, $6, $7, $8) as r',
        ['receipt', b.id, 'bank_proof', 'p.pdf', 'application/pdf', 2048, sha(), rid()]);
      await h.refused(ACC2, 'select public.finance_evidence_finish($1, true) as r', [begun.id], '42501', 'not_authorized');
      expect((await h.one<{ status: string }>(ACC, 'select public.finance_evidence_finish($1, true) as r', [begun.id])).status).toBe('failed');
      await h.verify(ACC2, a.id);
      await h.refused(ACC, 'select public.finance_evidence_remove($1) as r', [ev], '55000', 'wrong_state');
      // Download is authorized and audited for Accounts only.
      expect(await h.one(ACC2, 'select public.finance_evidence_authorize_download($1) as r', [ev])).toMatchObject({ fileName: 'proof.pdf' });
      await h.refused(SALES, 'select public.finance_evidence_authorize_download($1) as r', [ev], '42501', 'not_authorized');
      // While recorded, a stored proof can be removed (then the same file is usable again).
      const ev2 = await h.proof(ACC, 'receipt', b.id, 'bank_proof', hash.replace(/^./, hash[0] === 'a' ? 'b' : 'a'));
      expect((await h.one<{ status: string }>(ACC, 'select public.finance_evidence_remove($1) as r', [ev2])).status).toBe('removed');
    });
  });
});

describe('journal integrity', () => {
  it('refuses update/delete and an unbalanced or wrong-shaped entry at commit', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const rec = await h.verifiedBank();
      await db.exec('savepoint j');
      await expect(db.query(`update public.finance_journal_lines set debit_paise = 1 where debit_paise > 0`)).rejects.toMatchObject({ code: '42501' });
      await db.exec('rollback to savepoint j');
      await expect(db.query(`delete from public.finance_journal_entries`)).rejects.toMatchObject({ code: '42501' });
      await db.exec('rollback to savepoint j');
      await expect(db.query(`update public.customer_receipts set amount_paise = 1 where id = $1`, [rec.id])).rejects.toMatchObject({ code: '42501' });
      await db.exec('rollback to savepoint j');

      // A hand-made reversal with the wrong amount fails the commit-time shape check.
      await h.checkConstraints();
      const [entry] = await h.owner<{ id: string }>(
        `insert into public.finance_journal_entries (legal_entity_id, kind, receipt_id, deal_id, branch_id, business_date,
           reverses_entry_id, posted_by)
         select r.legal_entity_id, 'reversal_bank', r.id, r.deal_id, r.branch_id, r.received_on, e.id, r.recorded_by
         from public.customer_receipts r join public.finance_journal_entries e on e.receipt_id = r.id
         where r.id = $1 returning id`,
        [rec.id],
      );
      await h.owner(
        `insert into public.finance_journal_lines (entry_id, account, deal_id, branch_id, debit_paise, credit_paise)
         select $1, a.account, r.deal_id, r.branch_id, a.d, a.c from public.customer_receipts r,
           (values ('customer_advances', 1::bigint, 0::bigint), ('bank', 0, 1)) as a (account, d, c) where r.id = $2`,
        [entry!.id, rec.id],
      );
      await expect(h.checkConstraints()).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('refuses a reversal entry whose custody path does not match the deposit membership', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const cash = await h.verifiedCash();
      await h.reverse(ACC, cash.id, 'data_error');
      await h.checkConstraints();
      // Undeposited cash reversed as if it were deposited: wrong kind for its membership.
      await h.owner(`alter table public.finance_journal_entries disable trigger finance_journal_entries_append_only`);
      await h.owner(`alter table public.finance_journal_lines disable trigger finance_journal_lines_append_only`);
      await h.owner(
        `update public.finance_journal_entries set kind = 'reversal_cash_deposited'
         where receipt_id = $1 and kind = 'reversal_cash_undeposited'`,
        [cash.id],
      );
      await h.owner(
        `update public.finance_journal_lines l set account = 'bank' from public.finance_journal_entries e
         where e.id = l.entry_id and e.receipt_id = $1 and e.kind = 'reversal_cash_deposited' and l.account = 'cash_in_hand'`,
        [cash.id],
      );
      const [e] = await h.owner<{ id: string }>(`select id from public.finance_journal_entries where receipt_id = $1 and kind = 'reversal_cash_deposited'`, [cash.id]);
      await expect(h.owner('select authz.finance_check_entry($1)', [e!.id])).rejects.toMatchObject({ code: '23514' });
    });
  });
});
