import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { CLAIMS_SUITE_LOCK, REPORT, WITHDRAW, claimHelpers, utr } from './b11-claims-support';
import { ANON, DEAL, DEAL2, MANAGER, PURCHASE, SALES, SALES_B, SUPER, ACC, daysAgo, rid, today } from './finance-support';

/**
 * B1.1b advance claims, Sales side (appendix B section 2.1 and 2.2):
 * payment_claim_report and payment_claim_withdraw. Field rules per mode,
 * destination rule, totals, duplicates among open claims, retry identity,
 * switch, removed and lost Deals, and who may report.
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
const fields = (o: Record<string, unknown>) => JSON.stringify(o);

describe('payment_claim_report', () => {
  it('reports a bank claim on the accepted version without creating money', async () => {
    await asOwner(db, async () => {
      const versionId = await h.bookedDeal();
      const claim = await h.bankClaim();
      const res = await h.report(SALES, claim);
      expect(res).toMatchObject({ outcome: 'created', status: 'reported', rowVersion: 1 });
      const row = await h.claimRow(res.id);
      expect(row).toMatchObject({
        booking_version_id: versionId, mode: 'bank_transfer', amount_paise: 2500000, status: 'reported',
        reported_by: U.salesDelhiA, reference_norm: String(claim.reference).toUpperCase(),
      });
      const [audit] = await h.owner<{ details: Record<string, unknown>; reason: string | null }>(
        `select details, reason from public.audit_events where action = 'finance.claim_reported' and target_id = $1`, [res.id],
      );
      expect(Object.keys(audit!.details).sort()).toEqual(['bookingVersionId', 'dealId', 'mode']);
      expect(JSON.stringify(audit!.details)).not.toContain(String(claim.reference));
      expect(await h.owner('select 1 from public.customer_receipts')).toEqual([]);
      expect(await h.owner('select 1 from public.finance_journal_entries')).toEqual([]);
    });
  });

  it('attaches to the open draft when there is one, and reports without a selling total', async () => {
    await asOwner(db, async () => {
      const draftId = await h.draftDeal();
      const res = await h.report(SALES, h.cashClaim({ amountPaise: '99999999' }));
      expect((await h.claimRow(res.id)).booking_version_id).toBe(draftId);
    });
  });

  it('accepts cash, UPI and cheque with their own field rules', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      expect((await h.report(SALES, h.cashClaim())).status).toBe('reported');
      expect((await h.report(SALES, await h.bankClaim({ mode: 'upi', reference: 'UPI/2026-0001' }))).status).toBe('reported');
      expect((await h.report(SALES, h.chequeClaim())).status).toBe('reported');
      // Reporting is allowed while a mode is not live (M5): recording is gated instead.
      expect(await h.owner('select 1 from public.finance_live_settings where cash_live')).toEqual([]);
    });
  });

  it('refuses malformed fields with invalid_input', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const bank = await h.bankClaim();
      const cases: Array<Record<string, unknown>> = [
        { ...bank, extra: 'x' },
        { ...bank, mode: 'card' },
        { ...bank, amountPaise: '0' },
        { ...bank, amountPaise: '12.50' },
        { ...bank, amountPaise: 2500000 },
        { ...bank, amountPaise: '1000000001' }, // over the receipt maximum (policy 1000000000)
        { ...bank, paidOn: '2099-01-01' },
        { ...bank, paidOn: daysAgo(366) },
        { ...bank, paidOn: '2026-02-30' },
        { ...bank, payerName: ' ' },
        { ...bank, reference: 'ab' },
        { ...bank, reference: 'UTR 123 456' },
        { ...bank, reference: null },
        { ...bank, destinationVersionId: null },
        { ...bank, chequeNumber: '123456' },
        { ...h.cashClaim(), reference: utr() },
        { ...h.cashClaim(), destinationVersionId: bank.destinationVersionId },
        { ...h.chequeClaim(), chequeNumber: '12345' },
        { ...h.chequeClaim(), chequeDate: daysAgo(91) },
        { ...h.chequeClaim(), chequeDate: null },
        { ...h.cashClaim(), note: 'x'.repeat(501) },
      ];
      for (const c of cases) {
        await h.refused(SALES, REPORT, [DEAL, fields(c), rid()], '22023', 'invalid_input');
      }
      await h.refused(SALES, REPORT, [DEAL, fields(bank), null], '22023', 'invalid_input');
      await h.refused(SALES, REPORT, [DEAL, '[]', rid()], '22023', 'invalid_input');
    });
  });

  it('needs an approved current destination of the right kind (destination_changed)', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const upiDest = (await h.bankClaim({ mode: 'upi', reference: utr() })).destinationVersionId;
      // A UPI destination for a bank transfer.
      await h.refused(SALES, REPORT, [DEAL, fields(await h.bankClaim({ destinationVersionId: upiDest })), rid()], '55000', 'destination_changed');
      // A retired destination.
      const bank = await h.bankClaim();
      await h.owner(
        `update public.company_destinations d set retired_at = now(), retired_by = $2, retire_reason = 'Synthetic retirement reason'
         from public.company_destination_versions v where v.id = $1 and d.id = v.destination_id`,
        [bank.destinationVersionId, U.accountsJodhpur],
      );
      await h.refused(SALES, REPORT, [DEAL, fields(bank), rid()], '55000', 'destination_changed');
      // An unknown version.
      await h.refused(SALES, REPORT, [DEAL, fields(await h.bankClaim({ destinationVersionId: rid() })), rid()], '55000', 'destination_changed');
    });
  });

  it('refuses an amount over the final selling total (claim_over_total), per claim', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal(); // total 9876543
      await h.refused(SALES, REPORT, [DEAL, fields(h.cashClaim({ amountPaise: '9876544' })), rid()], '55000', 'claim_over_total');
      expect((await h.report(SALES, h.cashClaim({ amountPaise: '9876543' }))).status).toBe('reported');
      // No sum rule: a second claim of the same size is accepted.
      expect((await h.report(SALES, h.cashClaim({ amountPaise: '9876543' }))).status).toBe('reported');
    });
  });

  it('keeps one open claim per reference or cheque number, and frees it after closure', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const bank = await h.bankClaim({ reference: 'UTR-ABC-12345' });
      const first = await h.report(SALES, bank);
      // Same normalised reference (spaces/dashes/case) is a duplicate while open.
      await h.refused(SALES, REPORT, [DEAL, fields({ ...bank, reference: 'utrabc12345' }), rid()], '23505', 'duplicate_claim');
      const cheque = h.chequeClaim();
      await h.report(SALES, cheque);
      await h.refused(SALES, REPORT, [DEAL, fields(h.chequeClaim({ chequeNumber: cheque.chequeNumber })), rid()], '23505', 'duplicate_claim');
      await h.withdraw(SALES, first.id);
      expect((await h.report(SALES, { ...bank, reference: 'utrabc12345' })).status).toBe('reported');
    });
  });

  it('a receipt with the same reference does not refuse the claim (link case)', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      await h.addSecondAccounts();
      const claim = await h.bankClaim();
      await h.record(ACC, DEAL, await h.receiptFieldsFor(claim));
      expect((await h.report(SALES, claim)).status).toBe('reported');
    });
  });

  it('replays an exact retry and refuses a changed one', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const claim = h.cashClaim();
      const requestId = rid();
      const first = await h.report(SALES, claim, DEAL, requestId);
      const again = await h.report(SALES, claim, DEAL, requestId);
      expect(again).toMatchObject({ outcome: 'existing', id: first.id });
      expect((await h.owner('select 1 from public.customer_payment_claims')).length).toBe(1);
      await h.refused(SALES, REPORT, [DEAL, fields({ ...claim, amountPaise: '1000001' }), requestId], '40001', 'request_conflict');
      await h.addSalesAssignment(DEAL, U.salesDelhiB);
      await h.refused(SALES_B, REPORT, [DEAL, fields(claim), requestId], '40001', 'request_conflict');
    });
  });

  it('refuses while the switch is off, without a booking, and on removed Deals', async () => {
    await asOwner(db, async () => {
      await h.setSwitch(true);
      await h.refused(SALES, REPORT, [DEAL, fields(h.cashClaim()), rid()], '55000', 'wrong_state');
      await h.bookedDeal();
      await h.setSwitch(false);
      await h.refused(SALES, REPORT, [DEAL, fields(h.cashClaim()), rid()], '55000', 'service_items_disabled');
      await h.setSwitch(true);
      await h.markImported();
      await h.owner('alter table public.deals drop constraint deals_removed_imported_only'); // test-only: keep it synthetic
      await h.owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [DEAL]);
      await h.refused(SALES, REPORT, [DEAL, fields(h.cashClaim()), rid()], '55000', 'deal_removed');
    });
  });

  it('refuses a lost Bitrix Deal (deal_not_active)', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      await h.markImported('LOSE');
      await h.refused(SALES, REPORT, [DEAL, fields(h.cashClaim()), rid()], '55000', 'deal_not_active');
    });
  });

  it('gates on the finance environment', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      await h.setEnvironment('unset');
      await h.refused(SALES, REPORT, [DEAL, fields(h.cashClaim()), rid()], '55000', 'environment_unset');
      await h.setEnvironment('staging');
      await h.refused(SALES, REPORT, [DEAL, fields(h.cashClaim()), rid()], '55000', 'not_configured');
    });
  });

  it('only the owner and an active Sales assignee with commercial access may report', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const body = () => [DEAL, fields(h.cashClaim()), rid()];
      // The branch Manager edits bookings but holds deal.read_commercial only on
      // own Deals (reference data), so claims stay closed to them (M6).
      for (const actor of [SALES_B, PURCHASE, ACC, SUPER, MANAGER, { userId: U.visaJodhpur }]) {
        await h.refused(actor, REPORT, body(), '42501', 'not_authorized');
      }
      await h.refused(ANON, REPORT, body(), '42501'); // no execute grant for anon
      await h.refused({ ...SALES, aal: 'aal1' }, REPORT, body(), '42501', 'not_authorized');
      await h.addSalesAssignment(DEAL, U.salesDelhiB);
      expect((await h.report(SALES_B, h.cashClaim())).status).toBe('reported');
      // Another Deal of another owner.
      await h.refused(SALES, REPORT, [DEAL2, fields(h.cashClaim()), rid()], '42501', 'not_authorized');
    });
  });

  it('an editor without commercial access may not report', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const [before] = await h.owner<{ ok: boolean }>(
        `select exists (select 1 from public.role_permissions where role_code = 'sales' and permission_code = 'deal.read_commercial') as ok`,
      );
      expect(before!.ok).toBe(true);
      await h.owner(`delete from public.role_permissions where role_code = 'sales' and permission_code = 'deal.read_commercial'`);
      await h.refused(SALES, REPORT, [DEAL, fields(h.cashClaim()), rid()], '42501', 'not_authorized');
    });
  });
});

describe('payment_claim_withdraw', () => {
  it('withdraws a reported claim with a reason and is audited', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const res = await h.report(SALES, h.cashClaim());
      const out = await h.withdraw(SALES, res.id, 1, 'Synthetic: customer paid by mistake');
      expect(out).toMatchObject({ outcome: 'updated', status: 'withdrawn', rowVersion: 2 });
      const row = await h.claimRow(res.id);
      expect(row).toMatchObject({ status: 'withdrawn', closed_by: U.salesDelhiA, closed_reason: 'Synthetic: customer paid by mistake' });
      const [audit] = await h.owner<{ reason: string }>(
        `select reason from public.audit_events where action = 'finance.claim_withdrawn' and target_id = $1`, [res.id],
      );
      expect(audit!.reason).toBe('Synthetic: customer paid by mistake');
    });
  });

  it('checks row version, state, reason, retry and who may withdraw', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const res = await h.report(SALES, h.cashClaim());
      await h.refused(SALES, WITHDRAW, [res.id, 2, 'Synthetic withdrawal reason', rid()], '40001', 'version_changed');
      await h.refused(SALES, WITHDRAW, [res.id, 1, 'short', rid()], '22023', 'invalid_input');
      await h.refused(SALES_B, WITHDRAW, [res.id, 1, 'Synthetic withdrawal reason', rid()], '42501', 'not_authorized');
      await h.refused(ACC, WITHDRAW, [res.id, 1, 'Synthetic withdrawal reason', rid()], '42501', 'not_authorized');
      await h.refused(SALES, WITHDRAW, [rid(), 1, 'Synthetic withdrawal reason', rid()], 'P0002', 'not_found');
      const requestId = rid();
      // An active Sales assignee may withdraw a claim the owner reported.
      await h.addSalesAssignment(DEAL, U.salesDelhiB);
      await h.withdraw(SALES_B, res.id, 1, 'Synthetic withdrawal reason', requestId);
      expect((await h.withdraw(SALES_B, res.id, 1, 'Synthetic withdrawal reason', requestId)).outcome).toBe('existing');
      await h.refused(SALES, WITHDRAW, [res.id, 2, 'Synthetic withdrawal reason', rid()], '55000', 'wrong_state');
    });
  });

  it('still works while the switch is off', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const res = await h.report(SALES, h.cashClaim({ paidOn: today() }));
      await h.setSwitch(false);
      expect((await h.withdraw(SALES, res.id)).status).toBe('withdrawn');
    });
  });
});
