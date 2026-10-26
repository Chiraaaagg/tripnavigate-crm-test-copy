import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACCOUNTS_LIST, CLAIMS_SUITE_LOCK, claimHelpers } from './b11-claims-support';
import { ACC, ACC2, DEAL, PURCHASE, SALES, rid } from './finance-support';

/**
 * B1.1b: a claim never counts as money (appendix B section 4), the Accounts
 * claims list (section 3.4) and the Home count helper (section 3.5).
 *
 * Static proof: no money read, queue, count, journal or department read
 * references customer_payment_claims. Dynamic proof: every money read,
 * queue, Home count and the journal are identical before and after claims
 * are reported and linked; money appears only when a different Accounts
 * person verifies the receipt, exactly once.
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

/** Functions allowed to read customer_payment_claims (migration 20261119000200 and its later replacements). */
const CLAIM_READERS = new Set([
  'public.payment_claim_report', 'public.payment_claim_withdraw', 'public.receipt_record_from_claim',
  'public.payment_claim_link_receipt', 'public.payment_claim_mark_not_received', 'public.deal_payment_claims',
  'public.accounts_payment_claims', 'public.accounts_deal_detail', 'authz.customer_payment_claims_guard',
  'authz.finance_claim_chain_linked', 'authz.finance_claim_display_status', 'authz.finance_claim_actions',
  'authz.finance_claim_for_command', 'authz.finance_claim_mismatch', 'authz.finance_claim_sales_json',
  'authz.finance_claim_accounts_json', 'authz.finance_claim_list_item_json', 'authz.finance_claims_to_process_count',
  // 20261119000400 (Won-only prune): only checks whether a claim exists for a
  // Deal (CRM work keeps the Deal out of the prune); reads no amount.
  'authz.deal_crm_work',
]);

/** Money, queue, count and department reads that must never read claims. */
const NEVER_READERS = [
  'authz.finance_money_json', 'authz.finance_queue_item_json', 'public.accounts_queue', 'authz.finance_cash_branch_json',
  'authz.finance_unresolved_json', 'public.accounts_cash_overview', 'authz.finance_post', 'authz.finance_check_entry',
  'public.my_work_counts', 'public.receipt_record', 'public.receipt_verify', 'public.receipt_reverse',
  'public.cash_deposit_record', 'public.cash_reconciliation_record', 'authz.purchase_task_json', 'public.deal_services',
  'public.deal_service_summary', 'public.booking_panel', 'public.intake_checklist', 'public.booking_form_get',
];

describe('static proof', () => {
  it('only claim functions read the claims table; money and department reads never do', async () => {
    await asOwner(db, async () => {
      const rows = await h.owner<{ name: string; authenticated: boolean }>(
        `select n.nspname || '.' || p.proname as name, has_function_privilege('authenticated', p.oid, 'execute') as authenticated
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'authz') and p.prosrc ilike '%customer_payment_claims%'`,
      );
      const names = rows.map((r) => r.name);
      for (const never of NEVER_READERS) expect(names).not.toContain(never);
      // Purchase, Flight and Visa & Passport reads never touch claims.
      expect(names.filter((n) => /\.(purchase|flight|visa)_/.test(n))).toEqual([]);
      // Anything else is unexpected: every reader is named in CLAIM_READERS.
      const unexpected = names.filter((n) => !CLAIM_READERS.has(n));
      expect(unexpected).toEqual([]);
    });
  });

  it('the journal and receipts keep their shape: no claim kind, no claim column', async () => {
    await asOwner(db, async () => {
      const cols = await h.owner<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
         where table_schema = 'public' and table_name in ('customer_receipts', 'finance_journal_entries', 'finance_journal_lines')
           and column_name ilike '%claim%'`,
      );
      expect(cols).toEqual([]);
      const [kinds] = await h.owner<{ def: string }>(
        `select pg_get_constraintdef(c.oid) as def from pg_constraint c
         where c.conrelid = 'public.finance_journal_entries'::regclass and pg_get_constraintdef(c.oid) ilike '%receipt_bank%'`,
      );
      expect(kinds!.def).not.toMatch(/claim/);
    });
  });
});

describe('dynamic proof', () => {
  async function snapshot() {
    const entity = await h.entityId();
    const queue: Record<string, unknown> = {};
    for (const filter of ['all', 'needs_review', 'returned', 'awaiting_verification', 'cheques_pending']) {
      queue[filter] = await h.one(ACC, 'select public.accounts_queue($1) as r', [filter]);
    }
    return {
      money: (await h.owner<{ r: unknown }>('select authz.finance_money_json($1) as r', [DEAL]))[0]!.r,
      cash: await h.one(ACC, 'select public.accounts_cash_overview($1) as r', [entity]),
      queue,
      // claimsToProcess (20261119000500) is the claims queue count itself, not money: left out here.
      countsAccounts: { ...(await h.one<Record<string, unknown>>(ACC2, 'select public.my_work_counts() as r')), claimsToProcess: 'n/a' },
      countsSales: await h.one<Record<string, unknown>>(SALES, 'select public.my_work_counts() as r'),
      journal: await h.owner(`select (select count(*) from public.finance_journal_entries)::int as e,
                                     (select count(*) from public.finance_journal_lines)::int as l`),
      receipts: await h.owner('select id, status, row_version from public.customer_receipts order by id'),
    };
  }

  it('reporting, linking and closing claims change no money read, queue, count or journal', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      await h.addSecondAccounts();
      // Some money state first: one verified and one recorded receipt.
      await h.verifiedCash(DEAL, { amountPaise: '300000' });
      const unverified = await h.record(ACC, DEAL, await h.cashFields({ amountPaise: '400000' }));
      const before = await snapshot();

      const big = await h.report(SALES, h.cashClaim({ amountPaise: '9876543' }));
      const bank = await h.report(SALES, await h.bankClaim({ amountPaise: '5000000' }));
      const toLink = await h.report(SALES, h.cashClaim({ amountPaise: '400000' }));
      await h.link(ACC, toLink.id, unverified.id);
      await h.notReceived(ACC, bank.id);
      await h.withdraw(SALES, big.id);
      await h.report(SALES, h.chequeClaim());

      expect(await snapshot()).toEqual(before);
    });
  });

  it('money appears only when a different Accounts person verifies, exactly once', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      await h.addSecondAccounts();
      const fields = h.cashClaim({ amountPaise: '650000' });
      const claim = await h.report(SALES, fields);
      expect(await h.available(DEAL)).toBe('0');
      const res = await h.fromClaim(ACC, claim.id, await h.receiptFieldsFor(fields));
      expect(await h.available(DEAL)).toBe('0');
      await h.verify(ACC2, res.receiptId!);
      expect(await h.available(DEAL)).toBe('650000');
      expect((await h.entries(res.receiptId!)).length).toBe(1);
      await h.checkConstraints();
    });
  });
});

describe('Accounts claims list and Home count', () => {
  it('lists claims oldest first, pages with a cursor and filters by state', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) ids.push((await h.report(SALES, h.cashClaim({ amountPaise: String(10000 + i) }))).id);
      const closed = await h.report(SALES, h.cashClaim());
      await h.notReceived(ACC, closed.id);
      // One transaction: equal reported_at, so the id breaks the tie (and the cursor must too).
      ids.sort();
      const page1 = await h.accountsList(ACC, 'reported', null, 2);
      expect(page1.items.map((i) => i.claimId)).toEqual(ids.slice(0, 2));
      expect(page1).toMatchObject({ hasMore: true, totalCount: 3 });
      expect(page1.nextAfter).toMatch(/^[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      const page2 = await h.accountsList(ACC, 'reported', page1.nextAfter, 2);
      expect(page2.items.map((i) => i.claimId)).toEqual(ids.slice(2));
      expect(page2).toMatchObject({ hasMore: false, nextAfter: null });
      expect((await h.accountsList(ACC, 'closed')).items.map((i) => i.claimId)).toEqual([closed.id]);
      expect((await h.accountsList(ACC, 'all')).totalCount).toBe(4);
      expect((await h.accountsList(ACC, 'linked')).totalCount).toBe(0);
      expect(Object.keys(page1.items[0]!).sort()).toEqual([
        'amountPaise', 'branchName', 'chequeNumber', 'claimId', 'dealId', 'dealReference', 'dealTitle', 'displayStatus',
        'linkedReceiptNo', 'mode', 'paidOn', 'payerName', 'reference', 'reportedAt', 'reportedByName', 'status',
      ].sort());
      await h.refused(ACC, ACCOUNTS_LIST, ['open', null, null], '22023', 'invalid_input');
      await h.refused(ACC, ACCOUNTS_LIST, ['all', 'not-a-cursor', null], '22023', 'invalid_input');
      await h.refused(ACC, ACCOUNTS_LIST, ['all', `${rid()}:2026-13-40T00:00:00.000000Z`, null], '22023', 'invalid_input');
      for (const actor of [SALES, PURCHASE]) await h.refused(actor, ACCOUNTS_LIST, ['all', null, null], '42501', 'not_authorized');
    });
  });

  it('claimsToProcess equals the reported list total for Accounts and is null for everyone else', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      expect(await h.toProcess(ACC)).toBe(0);
      const a = await h.report(SALES, h.cashClaim());
      await h.report(SALES, h.cashClaim());
      expect(await h.toProcess(ACC)).toBe(2);
      await h.notReceived(ACC, a.id);
      expect(await h.toProcess(ACC)).toBe(1);
      expect((await h.accountsList(ACC, 'reported')).totalCount).toBe(1);
      for (const actor of [SALES, PURCHASE]) expect(await h.toProcess(actor)).toBeNull();
      // Not executable through the Data API (my_work_counts calls it as definer).
      await h.refused(ACC, 'select authz.finance_claims_to_process_count() as r', [], '42501');
      // Finance switched off for the environment: Accounts sees 0, not null.
      await h.setEnvironment('unset');
      expect(await h.toProcess(ACC)).toBe(0);
    });
  });
});
