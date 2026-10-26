import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, expectDbError, resetActor, setActor } from '../helpers/db';
import { CLAIMS_SUITE_LOCK, FROM_CLAIM, LINK, NOT_RECEIVED, claimHelpers } from './b11-claims-support';
import { ACC, ACC2, DEAL, DEAL2, SALES, insertApprovedDestination, rid } from './finance-support';

/**
 * B1.1b advance claims, Accounts side (appendix B sections 2.3-2.5):
 * receipt_record_from_claim (existing receipt rules unchanged), linking an
 * existing receipt, money not found, maker/checker, retry identity and the
 * claim guard.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  if (db.mode === 'postgres') await db.query('select pg_advisory_lock($1::bigint)', [CLAIMS_SUITE_LOCK]);
});
afterAll(async () => {
  await db?.close();
});

const h = claimHelpers(() => db);
const json = (o: Record<string, unknown>) => JSON.stringify(o);

async function reported(fields: Record<string, unknown>) {
  const res = await h.report(SALES, fields);
  return { id: res.id, fields };
}

describe('receipt_record_from_claim', () => {
  it('records exactly one receipt, links it, and a different Accounts person verifies it', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      await h.addSecondAccounts();
      const claim = await reported(await h.bankClaim());
      const before = await h.available(DEAL);
      const res = await h.fromClaim(ACC, claim.id, await h.receiptFieldsFor(claim.fields));
      expect(res).toMatchObject({ outcome: 'created', id: claim.id, status: 'linked', rowVersion: 2 });
      expect(res.receiptNo).toMatch(/^R-\d{4}-\d{2}-000001$/);
      const receipts = await h.owner<{ id: string; recorded_by: string; status: string; amount_paise: string }>(
        'select id, recorded_by, status, amount_paise::text as amount_paise from public.customer_receipts',
      );
      expect(receipts).toEqual([{ id: res.receiptId, recorded_by: U.accountsJodhpur, status: 'recorded', amount_paise: '2500000' }]);
      expect(await h.claimRow(claim.id)).toMatchObject({
        status: 'linked', linked_receipt_id: res.receiptId, link_kind: 'recorded_from_claim', linked_by: U.accountsJodhpur, link_reason: null,
      });
      // Nothing is money yet.
      expect(await h.available(DEAL)).toBe(before);
      expect(await h.entries(res.receiptId!)).toEqual([]);
      // Maker/checker: the recorder cannot verify; a second Accounts person can.
      await h.proof(ACC, 'receipt', res.receiptId!, 'bank_proof');
      await h.refused(ACC, 'select public.receipt_verify($1, $2) as r', [res.receiptId, rid()], '42501', 'not_self_approval');
      await h.verify(ACC2, res.receiptId!);
      expect(BigInt(await h.available(DEAL)) - BigInt(before)).toBe(2500000n);
      const audits = await h.owner<{ action: string; details: Record<string, unknown> }>(
        `select action, details from public.audit_events where action in ('finance.claim_receipt_recorded', 'finance.receipt_recorded')
         order by id`,
      );
      expect(audits.map((a) => a.action)).toEqual(['finance.receipt_recorded', 'finance.claim_receipt_recorded']);
      expect(audits[1]!.details).toMatchObject({ receiptId: res.receiptId, mismatch: false });
    });
  });

  it('replays an exact retry without a second receipt or receipt number', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const claim = await reported(h.cashClaim());
      const fields = await h.receiptFieldsFor(claim.fields);
      const requestId = rid();
      const first = await h.fromClaim(ACC, claim.id, fields, requestId);
      const again = await h.fromClaim(ACC, claim.id, fields, requestId);
      expect(again).toMatchObject({ outcome: 'existing', id: claim.id, receiptId: first.receiptId, receiptNo: first.receiptNo });
      expect((await h.owner('select 1 from public.customer_receipts')).length).toBe(1);
      const next = await h.record(ACC, DEAL, await h.cashFields({ amountPaise: '1000' }));
      expect(next.receiptNo).toMatch(/-000002$/);
      await h.refused(ACC, FROM_CLAIM, [claim.id, json({ ...fields, note: 'changed' }), requestId], '40001', 'request_conflict');
      // A new request on a linked claim is refused.
      await h.refused(ACC, FROM_CLAIM, [claim.id, json(fields), rid()], '55000', 'wrong_state');
    });
  });

  it('keeps every receipt rule: cash cap, duplicate reference, destination, removed Deal', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      // Cash over the payer-day cap (policy 4999900).
      const cash = await reported(h.cashClaim({ amountPaise: '5000000' }));
      await h.refused(ACC, FROM_CLAIM, [cash.id, json(await h.receiptFieldsFor(cash.fields)), rid()], '55000', 'cash_cap_exceeded');
      // The same bank reference was already recorded as a receipt.
      const bank = await reported(await h.bankClaim());
      await h.record(ACC, DEAL, await h.receiptFieldsFor(bank.fields));
      await h.refused(ACC, FROM_CLAIM, [bank.id, json(await h.receiptFieldsFor(bank.fields)), rid()], '23505', 'duplicate_reference');
      // The destination the claim named was replaced after the report.
      const moved = await reported(await h.bankClaim());
      const newVersion = await insertApprovedDestination(db, DEAL, 'bank');
      await h.owner(
        `update public.company_destination_versions set status = 'superseded' where id = $1`, [moved.fields.destinationVersionId],
      );
      await h.owner(
        `update public.company_destinations d set current_version_id = null
         from public.company_destination_versions v where v.id = $1 and d.id = v.destination_id`,
        [moved.fields.destinationVersionId],
      );
      await h.refused(ACC, FROM_CLAIM, [moved.id, json(await h.receiptFieldsFor(moved.fields)), rid()], '55000', 'destination_changed');
      const ok = await h.fromClaim(ACC, moved.id, await h.receiptFieldsFor(moved.fields, { destinationVersionId: newVersion }));
      expect(ok.status).toBe('linked');
      // Nothing was left behind by the refusals.
      expect((await h.claimRow(cash.id)).status).toBe('reported');
      expect((await h.claimRow(bank.id)).status).toBe('reported');
    });
  });

  it('a removed Deal takes no receipt from a claim', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const claim = await reported(h.cashClaim());
      await h.markImported();
      await h.owner('alter table public.deals drop constraint deals_removed_imported_only'); // test-only
      await h.owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [DEAL]);
      await h.refused(ACC, FROM_CLAIM, [claim.id, json(await h.receiptFieldsFor(claim.fields)), rid()], '55000', 'deal_removed');
      // Money not found still works on a removed Deal (Accounts keeps working).
      expect((await h.notReceived(ACC, claim.id)).status).toBe('not_received');
    });
  });

  it('a mode that is not live blocks recording (operational, real Deal)', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const claim = await reported(h.cashClaim());
      await h.markImported();
      await h.owner('alter table public.deal_commercials drop constraint deal_commercials_synthetic_parent');
      await h.owner('update public.deals set is_synthetic = false where id = $1', [DEAL]);
      await h.setEnvironment('operational');
      await h.refused(ACC, FROM_CLAIM, [claim.id, json(await h.receiptFieldsFor(claim.fields)), rid()], '55000', 'mode_not_live');
    });
  });

  it('a different amount, mode, reference or cheque number needs a reason', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const claim = await reported(await h.bankClaim());
      const differs = await h.receiptFieldsFor(claim.fields, { amountPaise: '2499000' });
      await h.refused(ACC, FROM_CLAIM, [claim.id, json(differs), rid()], '22023', 'invalid_input');
      await h.refused(ACC, FROM_CLAIM, [claim.id, json({ ...differs, mismatchReason: 'short' }), rid()], '22023', 'invalid_input');
      const res = await h.fromClaim(ACC, claim.id, { ...differs, mismatchReason: 'Synthetic: bank charges deducted by the payer bank' });
      expect(await h.claimRow(claim.id)).toMatchObject({ link_reason: 'Synthetic: bank charges deducted by the payer bank' });
      const [receipt] = await h.owner<{ amount_paise: string }>(
        'select amount_paise::text as amount_paise from public.customer_receipts where id = $1', [res.receiptId]);
      expect(receipt!.amount_paise).toBe('2499000');
      const cheque = await reported(h.chequeClaim());
      await h.refused(ACC, FROM_CLAIM, [cheque.id, json(await h.receiptFieldsFor(cheque.fields, { chequeNumber: '999999' })), rid()], '22023', 'invalid_input');
      // Reference compared after normalisation: case, spaces and dashes do not count.
      const bank2 = await reported(await h.bankClaim({ reference: 'UTR-77-ABCDEF' }));
      const same = await h.fromClaim(ACC, bank2.id, await h.receiptFieldsFor(bank2.fields, { reference: 'utr77abcdef' }));
      expect(same.status).toBe('linked');
    });
  });

  it('refuses a correction key, bad fields and the wrong people', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const claim = await reported(h.cashClaim());
      const fields = await h.receiptFieldsFor(claim.fields);
      await h.refused(ACC, FROM_CLAIM, [claim.id, json({ ...fields, correctsReceiptId: rid() }), rid()], '22023', 'invalid_input');
      await h.refused(ACC, FROM_CLAIM, [claim.id, json({ ...fields, branchId: null }), rid()], '22023', 'invalid_input');
      await h.refused(ACC, FROM_CLAIM, [claim.id, json(fields), null], '22023', 'invalid_input');
      await h.refused(ACC, FROM_CLAIM, [rid(), json(fields), rid()], 'P0002', 'not_found');
      await h.refused(SALES, FROM_CLAIM, [claim.id, json(fields), rid()], '42501', 'not_authorized');
      // An Accounts person who sells this Deal (Sales assignment) must not handle it.
      await h.addSalesAssignment(DEAL, U.accountsJodhpur);
      await h.refused(ACC, FROM_CLAIM, [claim.id, json(fields), rid()], '42501', 'not_self_approval');
      // A correction key explicitly null is accepted.
      await h.addSecondAccounts();
      expect((await h.fromClaim(ACC2, claim.id, { ...fields, correctsReceiptId: null })).status).toBe('linked');
    });
  });
});

describe('payment_claim_link_receipt', () => {
  it('links an existing receipt of the same Deal without creating money or a receipt', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const claim = await reported(await h.bankClaim());
      const receipt = await h.record(ACC, DEAL, await h.receiptFieldsFor(claim.fields));
      const res = await h.link(ACC, claim.id, receipt.id);
      expect(res).toMatchObject({ outcome: 'updated', status: 'linked', receiptId: receipt.id, receiptNo: receipt.receiptNo });
      expect(await h.claimRow(claim.id)).toMatchObject({ link_kind: 'linked_existing', linked_receipt_id: receipt.id });
      expect((await h.owner('select 1 from public.customer_receipts')).length).toBe(1);
      expect(await h.owner('select 1 from public.finance_journal_entries')).toEqual([]);
      const requestId = rid();
      const other = await reported(h.cashClaim());
      const cashReceipt = await h.record(ACC, DEAL, await h.receiptFieldsFor(other.fields));
      await h.link(ACC, other.id, cashReceipt.id, null, requestId);
      expect((await h.link(ACC, other.id, cashReceipt.id, null, requestId)).outcome).toBe('existing');
    });
  });

  it('refuses another Deal, superseded, rejected or already linked receipts', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      await h.addSecondAccounts();
      const a = await reported(h.cashClaim());
      const b = await reported(h.cashClaim());
      // Another Deal's receipt looks like a missing one.
      const elsewhere = await h.record(ACC, DEAL2, await h.cashFields());
      await h.refused(ACC, LINK, [a.id, elsewhere.id, null, rid()], '22023', 'invalid_input');
      await h.refused(ACC, LINK, [a.id, rid(), null, rid()], '22023', 'invalid_input');
      // Rejected (not received) cannot back a claim.
      const rejected = await h.record(ACC, DEAL, await h.receiptFieldsFor(a.fields));
      await h.reject(ACC2, rejected.id, 'not_received');
      await h.refused(ACC, LINK, [a.id, rejected.id, null, rid()], '55000', 'wrong_state');
      // Linked once only.
      const r1 = await h.record(ACC, DEAL, await h.receiptFieldsFor(a.fields));
      await h.link(ACC, a.id, r1.id);
      await h.refused(ACC, LINK, [b.id, r1.id, null, rid()], '23505', 'receipt_already_linked');
      // Through a correction chain: r1 rejected as a data error and corrected by r2.
      await h.reject(ACC2, r1.id, 'data_error');
      const r2 = await h.record(ACC, DEAL, await h.receiptFieldsFor(a.fields, { correctsReceiptId: r1.id }));
      await h.refused(ACC, LINK, [b.id, r2.id, null, rid()], '23505', 'receipt_already_linked');
      // The corrected original is not the end of its chain.
      const c = await reported(h.cashClaim({ amountPaise: '7000' }));
      await h.refused(ACC, LINK, [c.id, r1.id, 'Synthetic reason for a mismatch', rid()], '55000', 'wrong_state');
      // The first claim now follows the correction.
      const [status] = await h.owner<{ s: string }>('select authz.finance_claim_display_status($1) as s', [a.id]);
      expect(status!.s).toBe('recorded');
    });
  });

  it('a mismatch needs a reason; the reason and the mismatch are audited', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const claim = await reported(h.cashClaim({ amountPaise: '1000000' }));
      const receipt = await h.record(ACC, DEAL, await h.cashFields({ amountPaise: '900000' }));
      await h.refused(ACC, LINK, [claim.id, receipt.id, null, rid()], '22023', 'invalid_input');
      await h.link(ACC, claim.id, receipt.id, 'Synthetic: customer paid the rest later');
      const [audit] = await h.owner<{ reason: string; details: Record<string, unknown> }>(
        `select reason, details from public.audit_events where action = 'finance.claim_linked' and target_id = $1`, [claim.id],
      );
      expect(audit).toMatchObject({ reason: 'Synthetic: customer paid the rest later', details: { mismatch: true, receiptId: receipt.id } });
    });
  });

  it('refuses a handled claim and the wrong people', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const claim = await reported(h.cashClaim());
      const receipt = await h.record(ACC, DEAL, await h.receiptFieldsFor(claim.fields));
      await h.refused(SALES, LINK, [claim.id, receipt.id, null, rid()], '42501', 'not_authorized');
      await h.notReceived(ACC, claim.id);
      await h.refused(ACC, LINK, [claim.id, receipt.id, null, rid()], '55000', 'wrong_state');
    });
  });
});

describe('payment_claim_mark_not_received', () => {
  it('closes a reported claim with a reason Sales will see', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const claim = await reported(await h.bankClaim());
      const res = await h.notReceived(ACC, claim.id, 'Synthetic: no such credit on 11 October');
      expect(res).toMatchObject({ outcome: 'updated', status: 'not_received', rowVersion: 2 });
      expect(await h.claimRow(claim.id)).toMatchObject({ closed_by: U.accountsJodhpur, closed_reason: 'Synthetic: no such credit on 11 October' });
      await h.refused(ACC, NOT_RECEIVED, [claim.id, 'Synthetic reason again', rid()], '55000', 'wrong_state');
      // Sales may report the same reference again.
      expect((await h.report(SALES, claim.fields)).status).toBe('reported');
    });
  });

  it('needs a reason, an unhandled claim and a person outside the Deal', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const claim = await reported(h.cashClaim());
      await h.refused(ACC, NOT_RECEIVED, [claim.id, 'short', rid()], '22023', 'invalid_input');
      await h.refused(SALES, NOT_RECEIVED, [claim.id, 'Synthetic reason long enough', rid()], '42501', 'not_authorized');
      await h.addSalesAssignment(DEAL, U.accountsJodhpur);
      await h.refused(ACC, NOT_RECEIVED, [claim.id, 'Synthetic reason long enough', rid()], '42501', 'not_self_approval');
      const linked = await reported(h.cashClaim());
      await h.addSecondAccounts();
      await h.fromClaim(ACC2, linked.id, await h.receiptFieldsFor(linked.fields));
      await h.refused(ACC2, NOT_RECEIVED, [linked.id, 'Synthetic reason long enough', rid()], '55000', 'wrong_state');
    });
  });
});

describe('claim guard', () => {
  it('facts are immutable, handled claims are permanent and nothing is deleted', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const claim = await reported(h.cashClaim());
      const fail = async (sql: string, params: unknown[]) => {
        await resetActor(db);
        await expectDbError(db, () => db.query(sql, params), { code: '42501' });
      };
      await fail('update public.customer_payment_claims set amount_paise = 1 where id = $1', [claim.id]);
      await fail('delete from public.customer_payment_claims where id = $1', [claim.id]);
      await h.notReceived(ACC, claim.id);
      await fail(`update public.customer_payment_claims set status = 'reported', closed_at = null, closed_by = null,
                    closed_reason = null where id = $1`, [claim.id]);
      await fail(`update public.customer_payment_claims set closed_reason = 'Synthetic other reason' where id = $1`, [claim.id]);
      await setActor(db, ACC);
      await resetActor(db);
    });
  });
});
