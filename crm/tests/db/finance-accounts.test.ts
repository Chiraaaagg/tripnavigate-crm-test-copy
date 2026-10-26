import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountsDealDetailSchema,
  AccountsDealLookupSchema,
  AccountsQueuePageSchema,
  CashOverviewSchema,
  FinancePolicyPageSchema,
} from '@/modules/finance/dto';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACC, ACC2, ANON, DEAL, DEAL2, PURCHASE, SALES, SUPER, daysAgo, financeHelpers, rid, sha, today } from './finance-support';

/**
 * Phase 5A Accounts workspace (phase-5a-contract.md sections 4-8, 10-12):
 * grants and RLS, billing details, booking review, reads in the contract
 * shapes, cash custody, reconciliation (including the stale flag) and the
 * versioned finance policy.
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

const FINANCE_TABLES = [
  'finance_live_settings', 'finance_legal_limits', 'finance_policy_heads', 'finance_policy_versions', 'finance_deal_heads',
  'finance_receipt_counters', 'finance_command_results', 'customer_billing_profiles', 'accounts_booking_reviews',
  'customer_receipts', 'cash_deposits', 'cash_deposit_items', 'cash_reconciliations', 'finance_evidence',
  'finance_journal_entries', 'finance_journal_lines',
];

const BILLING = {
  billingName: 'Synthetic Traveller Pvt Ltd',
  addressLine1: '1 Synthetic Road',
  addressLine2: null,
  city: 'Jodhpur',
  stateCode: '08',
  postalCode: '342001',
  gstin: '08ABCDE1234F1Z5',
};
const SAVE = 'select public.accounts_billing_save($1, $2, $3::jsonb, $4) as r';
const VERIFY_BILLING = 'select public.accounts_billing_verify($1, $2, $3) as r';
const APPROVE = 'select public.accounts_review_approve($1, $2, $3) as r';
const RETURN = 'select public.accounts_review_return($1, $2, $3) as r';
const POLICY = 'select public.finance_policy_update($1, $2::jsonb, $3::timestamptz, $4, $5) as r';

describe('schema, grants and defaults', () => {
  it('enables RLS with no table privilege for anon or authenticated', async () => {
    const rows = await asOwner(db, () =>
      h.owner<{ relname: string; rls: boolean; auth_select: boolean; anon_select: boolean }>(
        `select c.relname, c.relrowsecurity as rls,
                has_table_privilege('authenticated', c.oid, 'select') as auth_select,
                has_table_privilege('anon', c.oid, 'select') as anon_select
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = any($1)`,
        [FINANCE_TABLES],
      ),
    );
    expect(rows).toHaveLength(FINANCE_TABLES.length);
    for (const r of rows) expect(r, r.relname).toMatchObject({ rls: true, auth_select: false, anon_select: false });
  });

  it('grants execute to authenticated only on the public RPCs', async () => {
    const rows = await asOwner(db, () =>
      h.owner<{ fn: string; anon: boolean; auth: boolean }>(
        `select p.proname as fn, has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where (n.nspname = 'public' and (p.proname like 'accounts_%' or p.proname like 'receipt_%' or p.proname like 'cheque_%'
                or p.proname like 'cash_%' or p.proname like 'finance_%'))
            or (n.nspname = 'authz' and (p.proname like 'finance_%' or p.proname in ('can_accounts', 'can_manage_finance_policy')))`,
      ),
    );
    expect(rows.filter((r) => r.anon)).toEqual([]);
    expect(rows.filter((r) => r.auth).map((r) => r.fn).sort()).toEqual([
      'accounts_billing_save', 'accounts_billing_verify', 'accounts_cash_overview', 'accounts_deal_detail', 'accounts_deal_lookup',
      'accounts_queue', 'accounts_review_approve', 'accounts_review_return', 'cash_deposit_record', 'cash_deposit_reject',
      'cash_deposit_verify', 'cash_reconciliation_record', 'cash_reconciliation_verify', 'cheque_clear', 'cheque_mark',
      'cheque_represent', 'finance_enabled_entities', 'finance_evidence_authorize_download', 'finance_evidence_begin',
      'finance_evidence_finish', 'finance_evidence_remove', 'finance_policy_get', 'finance_policy_update', 'receipt_record',
      'receipt_reject', 'receipt_reverse', 'receipt_verify',
      // B1.1b (20261119000200): the two claim RPCs that match these name patterns.
      'accounts_payment_claims', 'receipt_record_from_claim',
      // B1.1c (20261119000500): the Accounts expense-record list.
      'accounts_expense_records',
    ].sort());
  });

  it('enables finance for HOLIDAY_CHACHA only, with every mode off and policy version 1', async () => {
    await asOwner(db, async () => {
      const settings = await h.owner(`select s.*, e.code from public.finance_live_settings s join public.legal_entities e on e.id = s.legal_entity_id`);
      expect(settings).toHaveLength(1);
      expect(settings[0]).toMatchObject({ code: 'HOLIDAY_CHACHA', bank_transfer_live: false, upi_live: false, cash_live: false, cheque_live: false });
      const [v] = await h.owner(`select version_no, receipt_max_paise::text, cash_payer_day_cap_paise::text, cash_trip_cap_paise::text,
        cash_deposit_days, reconciliation_required from public.finance_policy_versions`);
      expect(v).toEqual({ version_no: 1, receipt_max_paise: '1000000000', cash_payer_day_cap_paise: '4999900', cash_trip_cap_paise: '4999900', cash_deposit_days: 1, reconciliation_required: true });
      const [l] = await h.owner(`select cash_cap_ceiling_paise::text as c, receipt_max_ceiling_paise::text as r from public.finance_legal_limits`);
      expect(l).toEqual({ c: '19999900', r: '10000000000' });
      const perms = await h.owner(`select role_code, permission_code, scope from public.role_permissions where permission_code like 'finance.%' order by 1`);
      expect(perms).toEqual([
        { role_code: 'accounts', permission_code: 'finance.accounts', scope: 'entity' },
        { role_code: 'super_admin', permission_code: 'finance.policy_manage', scope: 'entity' },
      ]);
      const [bucket] = await h.owner(`select public, file_size_limit::int as size from storage.buckets where id = 'finance-evidence'`);
      expect(bucket).toEqual({ public: false, size: 4194304 });
    });
  });
});

describe('reads', () => {
  it('queue, lookup and detail return the contract shapes for Accounts only', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const rec = await h.record(ACC, DEAL, await h.bankFields());
      const queue = AccountsQueuePageSchema.parse(await h.one(ACC, `select public.accounts_queue('all') as r`));
      expect(queue).toMatchObject({ totalCount: 1, hasMore: false, nextAfter: null });
      expect(queue.items.map((q) => q.dealReference)).toEqual(['SYN-DEL-001']);
      expect(queue.items[0]!.money).toEqual({ availablePaise: '0', awaitingVerificationPaise: '2500000', chequesAwaitingClearancePaise: '0' });
      expect((await h.one<{ items: unknown[] }>(ACC, `select public.accounts_queue('awaiting_verification') as r`)).items).toHaveLength(1);
      expect(await h.one(ACC, `select public.accounts_queue('returned') as r`)).toEqual({ items: [], hasMore: false, nextAfter: null, totalCount: 0 });
      await h.refused(ACC, `select public.accounts_queue('everything') as r`, [], '22023', 'invalid_input');

      const lookup = AccountsDealLookupSchema.parse(await h.one(ACC, `select public.accounts_deal_lookup('SYN-DEL-002') as r`));
      expect(lookup).toMatchObject({ dealId: DEAL2, hasConfirmedBooking: false });
      expect(await h.one(ACC, `select public.accounts_deal_lookup('SYN-B-001') as r`)).toBeNull();
      const audits = await h.owner(`select count(*)::int as n from public.audit_events where action = 'finance.deal_lookup'`);
      expect(audits[0]).toEqual({ n: 2 });

      const detail = AccountsDealDetailSchema.parse(await h.one(ACC2, 'select public.accounts_deal_detail($1) as r', [DEAL]));
      expect(detail.receipts).toHaveLength(1);
      expect(detail.receipts[0]!.payerPanMasked).toBe('XXXXX1234X');
      expect(detail.receipts[0]!.actions).toEqual({
        verify: 'evidence_required', reject: null, cheque_clear: 'wrong_state', cheque_mark: 'wrong_state',
        cheque_represent: 'wrong_state', reverse: 'wrong_state', correct: 'wrong_state',
      });
      const own = AccountsDealDetailSchema.parse(await h.one(ACC, 'select public.accounts_deal_detail($1) as r', [DEAL]));
      expect(own.receipts[0]!.actions.verify).toBe('own_record');
      expect(own.modesAllowed).toEqual({ bank_transfer: true, upi: true, cash: true, cheque: true });
      expect(own.liveModes).toEqual({ bank_transfer: false, upi: false, cash: false, cheque: false });
      expect(own.policy.versionNo).toBe(1);
      expect(rec.id).toBe(own.receipts[0]!.receiptId);
    });
  });

  it('refuses Sales, Purchase, Super Admin and anon; Super Admin + Accounts gets Accounts but not policy edit', async () => {
    await asOwner(db, async () => {
      for (const actor of [SALES, PURCHASE, SUPER]) {
        await h.refused(actor, `select public.accounts_queue('all') as r`, [], '42501', 'not_authorized');
        await h.refused(actor, 'select public.accounts_cash_overview($1) as r', [await h.entityId()], '42501', 'not_authorized');
      }
      // anon has no execute grant at all.
      await h.refused(ANON, `select public.accounts_queue('all') as r`, [], '42501');
      // Detail: not visible looks like not found.
      expect(await h.one(SALES, 'select public.accounts_deal_detail($1) as r', [DEAL])).toBeNull();
      await h.owner(
        `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
         select $1, b.legal_entity_id, b.id, 'accounts', 'active' from public.branches b where b.code = 'JDH'`,
        [SUPER.userId],
      );
      expect(await h.one(SUPER, `select public.accounts_queue('all') as r`)).toEqual({ items: [], hasMore: false, nextAfter: null, totalCount: 0 });
      const page = FinancePolicyPageSchema.parse(await h.one(SUPER, 'select public.finance_policy_get($1) as r', [await h.entityId()]));
      expect(page.canEdit).toBe(false);
      await h.refused(SUPER, POLICY, [await h.entityId(), '{}', null, 'Synthetic attempt to edit', rid()], '42501', 'not_authorized');
    });
  });
});

describe('billing details and booking review', () => {
  it('saves, verifies (the editor may verify), checks versions and GSTIN', async () => {
    await asOwner(db, async () => {
      const saved = await h.one<{ outcome: string; rowVersion: number }>(ACC, SAVE, [DEAL, 0, JSON.stringify(BILLING), rid()]);
      expect(saved).toMatchObject({ outcome: 'created', status: 'draft', rowVersion: 1 });
      await h.refused(ACC, SAVE, [DEAL, 0, JSON.stringify(BILLING), rid()], '40001', 'version_changed');
      await h.refused(ACC, SAVE, [DEAL, 1, JSON.stringify({ ...BILLING, gstin: '27ABCDE1234F1Z5' }), rid()], '22023', 'invalid_input');
      await h.refused(ACC, SAVE, [DEAL, 1, JSON.stringify({ ...BILLING, stateCode: '39' }), rid()], '22023', 'invalid_input');
      await h.refused(ACC, SAVE, [DEAL, 1, JSON.stringify({ ...BILLING, postalCode: '042001' }), rid()], '22023', 'invalid_input');
      await h.refused(SALES, SAVE, [DEAL, 1, JSON.stringify(BILLING), rid()], '42501', 'not_authorized');
      expect(await h.one(ACC, VERIFY_BILLING, [DEAL, 1, rid()])).toMatchObject({ status: 'verified', rowVersion: 2 });
      const [audit] = await h.owner<{ details: { editedBy: string; verifiedBy: string } }>(
        `select details from public.audit_events where action = 'finance.billing_verified'`);
      expect(audit!.details).toMatchObject({ editedBy: ACC.userId, verifiedBy: ACC.userId });
      // An edit returns it to draft.
      expect(await h.one(ACC, SAVE, [DEAL, 2, JSON.stringify({ ...BILLING, city: 'Jodhpur City' }), rid()])).toMatchObject({ status: 'draft', rowVersion: 3 });
      const [changed] = await h.owner<{ details: { changedFields: string[] } }>(
        `select details from public.audit_events where action = 'finance.billing_saved' order by id desc limit 1`);
      expect(changed!.details.changedFields).toEqual(['city']);
    });
  });

  it('approval needs verified billing, another person than the confirmer, and no deal conflict; edits reset it', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const version = await h.confirmedBooking();
      await h.refused(ACC, APPROVE, [version, 0, rid()], '55000', 'billing_not_verified');
      await h.one(ACC, SAVE, [DEAL, 0, JSON.stringify(BILLING), rid()]);
      await h.one(ACC, VERIFY_BILLING, [DEAL, 1, rid()]);
      await h.addSalesAssignment(DEAL, ACC2.userId!);
      await h.refused(ACC2, APPROVE, [version, 0, rid()], '42501', 'not_self_approval');
      await h.refused(ACC, APPROVE, [version, 3, rid()], '40001', 'version_changed');
      expect(await h.one(ACC, APPROVE, [version, 0, rid()])).toMatchObject({ status: 'approved', rowVersion: 1 });
      await h.refused(ACC, APPROVE, [version, 1, rid()], '55000', 'wrong_state');
      const detail = AccountsDealDetailSchema.parse(await h.one(ACC, 'select public.accounts_deal_detail($1) as r', [DEAL]));
      expect(detail.booking).toMatchObject({ reviewStatus: 'approved', sellingTotalPaise: '9876543', canApprove: false, approveBlock: 'wrong_state' });
      // Billing edit -> review back to pending.
      await h.one(ACC, SAVE, [DEAL, 2, JSON.stringify({ ...BILLING, addressLine2: 'Floor 2' }), rid()]);
      const [rv] = await h.owner<{ status: string }>(`select status from public.accounts_booking_reviews where booking_version_id = $1`, [version]);
      expect(rv!.status).toBe('pending');
      // Return keeps the reason inside Accounts; a short reason is refused.
      await h.refused(ACC, RETURN, [version, 'short', rid()], '22023', 'invalid_input');
      expect(await h.one(ACC, RETURN, [version, 'Synthetic: passport copy missing', rid()])).toMatchObject({ status: 'returned' });
      expect((await h.one<{ items: unknown[] }>(ACC, `select public.accounts_queue('returned') as r`)).items).toHaveLength(1);
      // Approving after a return resolves it: the reason stays in history but is no longer shown.
      const returned = AccountsDealDetailSchema.parse(await h.one(ACC, 'select public.accounts_deal_detail($1) as r', [DEAL]));
      expect(returned.booking!.returnReason).toBe('Synthetic: passport copy missing');
      await h.one(ACC, SAVE, [DEAL, returned.billing!.rowVersion, JSON.stringify(BILLING), rid()]);
      await h.one(ACC, VERIFY_BILLING, [DEAL, returned.billing!.rowVersion + 1, rid()]);
      await h.one(ACC, APPROVE, [version, returned.booking!.reviewRowVersion, rid()]);
      const approved = AccountsDealDetailSchema.parse(await h.one(ACC, 'select public.accounts_deal_detail($1) as r', [DEAL]));
      expect(approved.booking).toMatchObject({ reviewStatus: 'approved', returnReason: null });
      const [kept] = await h.owner<{ r: string }>(`select return_reason as r from public.accounts_booking_reviews where booking_version_id = $1`, [version]);
      expect(kept!.r).toBe('Synthetic: passport copy missing');
      // Nothing posted by review work.
      expect((await h.owner(`select 1 from public.finance_journal_entries`)).length).toBe(0);
    });
  });
});

describe('cash custody and reconciliation', () => {
  it('records a deposit with a slip, keeps membership exclusive, verifies by another person, funds unchanged', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const branch = await h.branchId('JDH');
      const a = await h.verifiedCash();
      const b = await h.verifiedCash(DEAL2, { payerPan: 'LMNOP4321Q', amountPaise: '500000' });
      const DEPOSIT = 'select public.cash_deposit_record($1, $2::uuid[], $3::date, $4, $5, $6) as r';
      await h.refused(ACC, DEPOSIT, [branch, [a.id], today(), 'SLIP-01', null, rid()], '55000', 'evidence_required');
      const slip = await h.proof(ACC, 'branch', branch, 'deposit_slip');
      await h.refused(ACC, DEPOSIT, [await h.branchId('DEL'), [a.id], today(), 'SLIP-01', slip, rid()], '22023', 'invalid_input');
      const dep = await h.one<{ id: string; status: string }>(ACC, DEPOSIT, [branch, [b.id, a.id], today(), 'SLIP-01', slip, rid()]);
      expect(dep.status).toBe('recorded');
      const slip2 = await h.proof(ACC, 'branch', branch, 'deposit_slip');
      await h.refused(ACC, DEPOSIT, [branch, [a.id], today(), 'SLIP-02', slip2, rid()], '55000', 'wrong_state');
      const before = [await h.available(DEAL), await h.available(DEAL2)];
      await h.refused(ACC, 'select public.cash_deposit_verify($1, $2) as r', [dep.id, rid()], '42501', 'not_self_approval');
      await h.one(ACC2, 'select public.cash_deposit_verify($1, $2) as r', [dep.id, rid()]);
      expect([await h.available(DEAL), await h.available(DEAL2)]).toEqual(before);
      const [entry] = await h.owner<{ lines: unknown }>(
        `select jsonb_agg(jsonb_build_array(l.account, l.debit_paise, l.credit_paise) order by l.account) as lines
         from public.finance_journal_entries e join public.finance_journal_lines l on l.entry_id = e.id
         where e.deposit_id = $1`, [dep.id]);
      expect(entry!.lines).toEqual([['bank', 1500000, 0], ['cash_in_hand', 0, 1500000]]);
      const overview = CashOverviewSchema.parse(await h.one(ACC, 'select public.accounts_cash_overview($1) as r', [await h.entityId()]));
      const jdh = overview.branches.find((x) => x.branchId === branch)!;
      expect(jdh.cashInHandPaise).toBe('0');
      expect(jdh.undepositedVerified).toEqual([]);
      expect(jdh.deposits[0]).toMatchObject({ status: 'verified', totalPaise: '1500000' });
      await h.checkConstraints();
    });
  });

  it('a rejected deposit frees its receipts', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const branch = await h.branchId('JDH');
      const a = await h.verifiedCash();
      const hash = sha();
      const slip = await h.proof(ACC, 'branch', branch, 'deposit_slip', hash);
      const DEPOSIT = 'select public.cash_deposit_record($1, $2::uuid[], $3::date, $4, $5, $6) as r';
      const BEGIN = 'select public.finance_evidence_begin($1, $2, $3, $4, $5, $6, $7, $8) as r';
      const dep = await h.one<{ id: string }>(ACC, DEPOSIT, [branch, [a.id], today(), 'SLIP-01', slip, rid()]);
      // While the deposit stands, its slip is frozen and the same file cannot back another deposit.
      await h.refused(ACC, 'select public.finance_evidence_remove($1) as r', [slip], '55000', 'wrong_state');
      await h.refused(ACC, BEGIN, ['branch', branch, 'deposit_slip', 's.pdf', 'application/pdf', 2048, hash, rid()], '23505', 'duplicate_reference');
      await h.refused(ACC, 'select public.cash_deposit_reject($1, $2, $3) as r', [dep.id, 'Synthetic slip mismatch', rid()], '42501', 'not_self_approval');
      await h.one(ACC2, 'select public.cash_deposit_reject($1, $2, $3) as r', [dep.id, 'Synthetic slip mismatch', rid()]);
      // The rejected deposit releases its slip: the same file can be uploaded again, and the old slip removed.
      const slip2 = await h.proof(ACC, 'branch', branch, 'deposit_slip', hash);
      expect((await h.one<{ status: string }>(ACC, 'select public.finance_evidence_remove($1) as r', [slip])).status).toBe('removed');
      expect((await h.one<{ status: string }>(ACC, DEPOSIT, [branch, [a.id], today(), 'SLIP-02', slip2, rid()])).status).toBe('recorded');
    });
  });

  it('reconciles against the cash-in-hand balance, needs a note for a difference, and turns stale on a later posting', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const branch = await h.branchId('JDH');
      await h.verifiedCash(DEAL, { receivedOn: daysAgo(2) });
      const REC = 'select public.cash_reconciliation_record($1, $2::date, $3::bigint, $4, $5) as r';
      await h.refused(ACC, REC, [branch, daysAgo(1), '999999', null, rid()], '22023', 'invalid_input');
      const rec = await h.one<{ id: string }>(ACC, REC, [branch, daysAgo(1), '1000000', null, rid()]);
      await h.refused(ACC, REC, [branch, daysAgo(1), '1000000', null, rid()], '55000', 'wrong_state');
      await h.refused(ACC, 'select public.cash_reconciliation_verify($1, $2) as r', [rec.id, rid()], '42501', 'not_self_approval');
      await h.one(ACC2, 'select public.cash_reconciliation_verify($1, $2) as r', [rec.id, rid()]);
      // Recorded-but-unverified cash before the date is shown separately.
      const pending = await h.record(ACC, DEAL2, await h.cashFields({ receivedOn: daysAgo(3), payerPan: 'QWERT1234Y', amountPaise: '200000' }));
      const rec2 = await h.one<{ id: string }>(ACC, REC, [branch, daysAgo(2), '1000000', null, rid()]);
      const view = CashOverviewSchema.parse(await h.one(ACC, 'select public.accounts_cash_overview($1) as r', [await h.entityId()]));
      const recs = view.branches.find((x) => x.branchId === branch)!.reconciliations;
      expect(recs.find((r) => r.reconciliationId === rec2.id)).toMatchObject({ expectedPaise: '1000000', unverifiedCashPaise: '200000', differencePaise: '0' });
      // Verifying older cash posts on an earlier business date: both reconciliations become stale.
      await h.verify(ACC2, pending.id);
      const stale = await h.owner<{ stale: boolean }>(`select stale from public.cash_reconciliations where branch_id = $1 order by business_date`, [branch]);
      expect(stale.every((s) => s.stale)).toBe(true);
      const after = CashOverviewSchema.parse(await h.one(ACC, 'select public.accounts_cash_overview($1) as r', [await h.entityId()]));
      const unresolved = after.branches.find((x) => x.branchId === branch)!.unresolved.map((u) => u.kind);
      expect(unresolved).toContain('reconciliation_stale');
      // A stale reconciliation cannot be verified, but a fresh one can be recorded for the same date.
      await h.refused(ACC, 'select public.cash_reconciliation_verify($1, $2) as r', [rec2.id, rid()], '55000', 'wrong_state');
      expect((await h.one<{ status: string }>(ACC, REC, [branch, daysAgo(1), '1200000', null, rid()])).status).toBe('recorded');
      await h.checkConstraints();
    });
  });
});

describe('finance policy', () => {
  it('versions changes, enforces ceilings and timing, and records the version on receipts', async () => {
    await asOwner(db, async () => {
      const entity = await h.entityId();
      await h.refused(ACC, POLICY, [entity, '{}', null, 'Synthetic policy change', rid()], '42501', 'not_authorized');
      await h.refused(SUPER, POLICY, [entity, JSON.stringify({ cashTripCapPaise: '20000000' }), null, 'Synthetic over ceiling', rid()], '22023', 'invalid_input');
      await h.refused(SUPER, POLICY, [entity, JSON.stringify({ cashDepositDays: 8 }), null, 'Synthetic too many days', rid()], '22023', 'invalid_input');
      await h.refused(SUPER, POLICY, [entity, '{}', '2000-01-01T00:00:00Z', 'Synthetic past effect', rid()], '22023', 'invalid_input');
      await h.refused(SUPER, POLICY, [entity, '{}', null, 'short', rid()], '22023', 'invalid_input');
      const v2 = await h.one<{ rowVersion: number; status: string }>(SUPER, POLICY, [entity, JSON.stringify({ cashPayerDayCapPaise: '2000000' }), null, 'Synthetic lower payer cap', rid()]);
      expect(v2).toMatchObject({ outcome: 'created', rowVersion: 2, status: 'effective' });
      const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
      const v3 = await h.one<{ rowVersion: number; status: string }>(SUPER, POLICY, [entity, JSON.stringify({ cashDepositDays: 2 }), future, 'Synthetic scheduled change', rid()]);
      expect(v3).toMatchObject({ rowVersion: 3, status: 'scheduled' });
      // Not before the latest scheduled version.
      await h.refused(SUPER, POLICY, [entity, '{}', null, 'Synthetic earlier than scheduled', rid()], '22023', 'invalid_input');

      const page = FinancePolicyPageSchema.parse(await h.one(SUPER, 'select public.finance_policy_get($1) as r', [entity]));
      expect(page.current).toMatchObject({ versionNo: 2, cashPayerDayCapPaise: '2000000', cashTripCapPaise: '4999900', cashDepositDays: 1 });
      expect(page.scheduled.map((v) => v.versionNo)).toEqual([3]);
      expect(page.history.map((v) => v.versionNo)).toEqual([1]);
      expect(page.canEdit).toBe(true);
      // The current version applies to new receipts.
      await h.refused(ACC, h.RECORD, [DEAL, JSON.stringify(await h.cashFields({ amountPaise: '2000001' })), rid()], '55000', 'cash_cap_exceeded');
      const rec = await h.record(ACC, DEAL, await h.cashFields({ amountPaise: '2000000' }));
      const [row] = await h.owner<{ v: number }>(`select v.version_no as v from public.customer_receipts r
        join public.finance_policy_versions v on v.id = r.policy_version_id where r.id = $1`, [rec.id]);
      expect(row!.v).toBe(2);
      // Policy versions are append-only.
      await db.exec('savepoint p');
      await expect(db.query(`update public.finance_policy_versions set reason = 'Rewritten history here'`)).rejects.toMatchObject({ code: '42501' });
      await db.exec('rollback to savepoint p');
      // Exact retry of the policy update returns the stored result.
      const id = rid();
      const first = await h.one<{ id: string }>(SUPER, POLICY, [entity, JSON.stringify({ receiptMaxPaise: '500000000' }), future, 'Synthetic retry change', id]);
      const again = await h.one<{ id: string; outcome: string }>(SUPER, POLICY, [entity, JSON.stringify({ receiptMaxPaise: '500000000' }), future, 'Synthetic retry change', id]);
      expect(again).toMatchObject({ id: first.id, outcome: 'existing' });
    });
  });
});
