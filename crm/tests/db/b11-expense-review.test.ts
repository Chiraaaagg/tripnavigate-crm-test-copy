import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { AccountsExpenseRecordsPageSchema } from '@/modules/finance/dto';
import { ACC, ACC2, financeHelpers } from './finance-support';
import { OWNER, PURCHASE } from './b1-support';
import {
  COST_SAVE_SQL, COST_SUBMIT_SQL, DESK, EV_DOWNLOAD_SQL, EXPENSE_ACCEPT_SQL, EXPENSE_LIST_SQL, EXPENSE_RETURN_SQL, VISA_CLAIM_SQL,
  b11Helpers, rid,
} from './b11-support';

/**
 * Expense records, Accounts side (migration 20261119000500; appendix B
 * section 7, Mercury reviews): a different Accounts person accepts or returns;
 * the submitter is refused; the receipt is re-checked; nothing touches money;
 * applicant documents never reach the Accounts read.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const f = financeHelpers(() => db);
const { one, refused, owner, deskTask, deskEvidence } = h;
type Saved = { entryId: string; rowVersion: number; expenseStatus: string | null };
type Page = { items: Array<Record<string, unknown>>; hasMore: boolean; nextAfter: string | null; totalCount: number };
const FEE = { costKind: 'government_fee', amountPaise: '650000', paidBy: 'company', paymentMode: 'upi', paidOn: '2026-10-10' };

async function submittedFee() {
  const { taskId } = await deskTask();
  await one(DESK, VISA_CLAIM_SQL, [taskId]);
  const receipt = await deskEvidence(DESK, taskId, 'fee_receipt');
  await deskEvidence(DESK, taskId, 'applicant_document');
  const saved = await one<Saved>(DESK, COST_SAVE_SQL, [taskId, null, 0, JSON.stringify({ ...FEE, receiptEvidenceId: receipt }), rid()]);
  const sub = await one<Saved>(DESK, COST_SUBMIT_SQL, [saved.entryId, saved.rowVersion]);
  return { taskId, receipt, entryId: saved.entryId, rowVersion: sub.rowVersion };
}

describe('expense records for Accounts', () => {
  it('a different Accounts person accepts; the submitter (also Accounts) is refused; no money, journal or queue changes', async () => {
    await asOwner(db, async () => {
      await f.addSecondAccounts(); // visa.jodhpur (the desk) also holds Accounts
      const e = await submittedFee();
      const money = async () => ({
        journal: await owner('select (select count(*) from public.finance_journal_entries)::int as e, (select count(*) from public.finance_journal_lines)::int as l'),
        receipts: await owner('select count(*)::int as n from public.customer_receipts'),
      });
      const before = await money();
      const page = await one<Page>(ACC, EXPENSE_LIST_SQL, ['submitted', null, null]);
      expect(page.totalCount).toBe(1);
      expect(page.items[0]).toMatchObject({ entryId: e.entryId, department: 'visa', serviceType: 'visa', kind: 'government_fee', amountPaise: '650000',
        status: 'submitted', submittedByName: 'Synthetic Visa Jodhpur', actions: { accept: null, return: null } });
      expect(page.items[0]!.evidence).toEqual([expect.objectContaining({ id: e.receipt, kind: 'fee_receipt', status: 'stored' })]);
      expect(AccountsExpenseRecordsPageSchema.safeParse(page).success).toBe(true);
      expect(JSON.stringify(page)).not.toMatch(/applicant_document/);
      // The submitter is refused even holding Accounts.
      const own = await one<Page>(ACC2, EXPENSE_LIST_SQL, ['submitted', null, null]);
      expect(own.items[0]).toMatchObject({ actions: { accept: 'own_submission', return: 'own_submission' } });
      await refused(ACC2, EXPENSE_ACCEPT_SQL, [e.entryId, e.rowVersion, rid()], '42501', 'not_self_approval');
      await refused(ACC, EXPENSE_ACCEPT_SQL, [e.entryId, e.rowVersion + 1, rid()], '40001', 'version_changed');
      for (const actor of [OWNER, PURCHASE]) await refused(actor, EXPENSE_ACCEPT_SQL, [e.entryId, e.rowVersion, rid()], '42501');
      // Accounts may open the receipt of a record it reviews.
      expect(await one(ACC, EV_DOWNLOAD_SQL, [e.receipt])).toMatchObject({ mime: 'application/pdf' });
      const req = rid();
      const accepted = await one<Record<string, unknown>>(ACC, EXPENSE_ACCEPT_SQL, [e.entryId, e.rowVersion, req]);
      expect(accepted).toMatchObject({ entryId: e.entryId, status: 'accepted' });
      expect(await one(ACC, EXPENSE_ACCEPT_SQL, [e.entryId, e.rowVersion, req])).toMatchObject({ outcome: 'existing', status: 'accepted' });
      await refused(ACC, EXPENSE_RETURN_SQL, [e.entryId, e.rowVersion + 1, 'Synthetic reason after accept', rid()], '55000', 'wrong_state');
      expect(await money()).toEqual(before);
      expect((await one<Page>(ACC, EXPENSE_LIST_SQL, ['accepted', null, null])).totalCount).toBe(1);
      const audit = await owner<{ details: unknown }>(`select details from public.audit_events where action = 'finance.expense_record_accepted'`);
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toMatch(/650000/);
    });
  });

  it('return needs a reason; the desk edits and resubmits; accept re-checks the receipt; counts', async () => {
    await asOwner(db, async () => {
      const e = await submittedFee();
      await refused(ACC, EXPENSE_RETURN_SQL, [e.entryId, e.rowVersion, 'short', rid()], '22023', 'invalid_input');
      const returned = await one<Record<string, unknown>>(ACC, EXPENSE_RETURN_SQL, [e.entryId, e.rowVersion, 'Synthetic: the receipt amount differs', rid()]);
      expect(returned).toMatchObject({ status: 'returned' });
      const edited = await one<Saved>(DESK, COST_SAVE_SQL, [e.taskId, e.entryId, returned.rowVersion, JSON.stringify({ ...FEE, amountPaise: '600000', receiptEvidenceId: e.receipt }), rid()]);
      expect(edited.expenseStatus).toBe('returned');
      const resub = await one<Saved>(DESK, COST_SUBMIT_SQL, [e.entryId, edited.rowVersion]);
      expect(resub.expenseStatus).toBe('submitted');
      expect(await one<Record<string, unknown>>(ACC, 'select public.my_work_counts() as r')).toMatchObject({ expensesToReview: 1 });
      expect(await one<Record<string, unknown>>(DESK, 'select public.my_work_counts() as r')).toMatchObject({ expensesToReview: null });
      // The receipt file is removed from storage evidence (owner SQL): accept refuses receipt_required.
      await owner(`update public.department_evidence set status = 'failed', stored_at = null where id = $1`, [e.receipt]);
      expect((await one<Page>(ACC, EXPENSE_LIST_SQL, ['submitted', null, null])).items[0]).toMatchObject({ actions: { accept: 'receipt_required', return: null } });
      await refused(ACC, EXPENSE_ACCEPT_SQL, [e.entryId, resub.rowVersion, rid()], '55000', 'receipt_required');
      await refused(ACC, EXPENSE_LIST_SQL, ['open', null, null], '22023', 'invalid_input');
      await refused(OWNER, EXPENSE_LIST_SQL, ['all', null, null], '42501', 'not_authorized');
    });
  });

  it('review V4: the Deal seller (holding Accounts) and an Accounts creator who is not the submitter are refused', async () => {
    await asOwner(db, async () => {
      const e = await submittedFee();
      // The Deal owner also holds Accounts: deal conflict.
      await owner(`insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
        select $1, b.legal_entity_id, b.id, 'accounts', 'active' from public.branches b where b.code = 'JDH'`, [OWNER.userId]);
      expect((await one<Page>(OWNER, EXPENSE_LIST_SQL, ['submitted', null, null])).items[0]).toMatchObject({ actions: { accept: 'deal_conflict', return: 'deal_conflict' } });
      await refused(OWNER, EXPENSE_ACCEPT_SQL, [e.entryId, e.rowVersion, rid()], '42501', 'not_self_approval');
      // The entry was created by an Accounts person (owner SQL stands in for a reassigned task): that person may not review it.
      await owner('set local session_replication_role = replica');
      await owner('update public.department_cost_entries set created_by = $2 where id = $1', [e.entryId, ACC.userId]);
      await owner('set local session_replication_role = origin');
      expect((await one<Page>(ACC, EXPENSE_LIST_SQL, ['submitted', null, null])).items[0]).toMatchObject({ actions: { accept: 'own_submission' } });
      await refused(ACC, EXPENSE_RETURN_SQL, [e.entryId, e.rowVersion, 'Synthetic reason for the return', rid()], '42501', 'not_self_approval');
    });
  });
});
