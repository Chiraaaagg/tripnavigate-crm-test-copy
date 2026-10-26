import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UNRESOLVED_CASH_KINDS, type UnresolvedCashKind } from '@/modules/finance/contracts';
import { AccountsQueueItemSchema, AccountsQueuePageSchema, CashOverviewSchema } from '@/modules/finance/dto';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACC, ACC2, DEAL, DEAL2, DEAL3, SUPER, daysAgo, financeHelpers, rid, today } from './finance-support';

/**
 * Phase 5B Milestone A (phase-5b-milestone-a.md sections 2 and 3; audit
 * findings 6, 7 and 12), migration 20261103000100_cash_overview_repairs.sql:
 *
 * - A reconciliation obligation exists for every business date from the
 *   branch's first cash activity up to yesterday (when the policy in force at
 *   the end of that date requires reconciliation). It never expires with age.
 * - Each obligation is missing, awaiting_verification, stale or verified; only
 *   verified clears it.
 * - Display is bounded to 50 items per kind; totals, the oldest date per kind
 *   and a truncated flag stay complete.
 * - accounts_queue pages by deal reference with a cursor and a total count.
 *
 * "Time passes" is simulated by redefining authz.finance_today() inside the
 * rolled-back owner transaction, so nothing leaks to other suites.
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

const OVERVIEW = 'select public.accounts_cash_overview($1) as r';
const REC = 'select public.cash_reconciliation_record($1, $2::date, $3::bigint, $4, $5) as r';
const VERIFY_REC = 'select public.cash_reconciliation_verify($1, $2) as r';
const POLICY = 'select public.finance_policy_update($1, $2::jsonb, $3::timestamptz, $4, $5) as r';
const QUEUE = 'select public.accounts_queue($1, $2, $3) as r';

type RawItem = { kind: string; businessDate: string | null };
type RawBranch = { branchId: string; unresolved: RawItem[] } & Record<string, unknown>;

/** Moves the database's IST "today" forward by `days` (rolled back with the scenario). */
async function shiftToday(days: number): Promise<void> {
  await h.owner(
    `create or replace function authz.finance_today() returns date
     language sql stable set search_path = '' as $fn$
       select (now() at time zone 'Asia/Kolkata')::date + ${Number(days)}
     $fn$`,
  );
}

function plusDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The raw branch JSON (no schema), so the defect is visible even on the old shape. */
async function rawBranch(code: string): Promise<RawBranch> {
  const branch = await h.branchId(code);
  const overview = await h.one<{ branches: RawBranch[] }>(ACC, OVERVIEW, [await h.entityId()]);
  return overview.branches.find((b) => b.branchId === branch)!;
}

async function branchView(code: string) {
  const branch = await h.branchId(code);
  const overview = CashOverviewSchema.parse(await h.one(ACC, OVERVIEW, [await h.entityId()]));
  return overview.branches.find((b) => b.branchId === branch)!;
}

const datesOf = (items: RawItem[], kind: UnresolvedCashKind) => items.filter((u) => u.kind === kind).map((u) => u.businessDate);

describe('reconciliation obligations never expire (audit finding 6)', () => {
  it('keeps a missing reconciliation listed after 61 days and beyond, with a full total and the oldest date', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const first = daysAgo(2);
      await h.verifiedCash(DEAL, { receivedOn: first });
      await shiftToday(70); // the cash day is now 72 days old and was never reconciled
      const raw = await rawBranch('JDH');
      // Reproduces the defect: the old 60-day window dropped this date entirely.
      expect(datesOf(raw.unresolved, 'reconciliation_missing')).toContain(first);

      const jdh = await branchView('JDH');
      // Every date from the first cash day up to (shifted) yesterday: 2 + 70 = 72 dates.
      expect(jdh.unresolvedTotals.reconciliation_missing).toBe(72);
      expect(jdh.oldestUnresolvedDate.reconciliation_missing).toBe(first);
      const missing = datesOf(jdh.unresolved, 'reconciliation_missing');
      expect(missing).toHaveLength(50);
      expect(missing[0]).toBe(first); // oldest first
      expect(missing[49]).toBe(plusDays(first, 49));
      expect(jdh.unresolvedTruncated).toBe(true);
      // The cash itself is still overdue for deposit and counted.
      expect(jdh.unresolvedTotals.deposit_overdue).toBe(1);
    });
  });

  it('clears an old obligation only once its reconciliation is verified', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const branch = await h.branchId('JDH');
      const first = daysAgo(2);
      await h.verifiedCash(DEAL, { receivedOn: first });
      await shiftToday(70);
      const rec = await h.one<{ id: string }>(ACC, REC, [branch, first, '1000000', null, rid()]);
      let jdh = await branchView('JDH');
      expect(jdh.unresolvedTotals).toMatchObject({ reconciliation_missing: 71, reconciliation_awaiting_verification: 1 });
      expect(datesOf(jdh.unresolved, 'reconciliation_awaiting_verification')).toEqual([first]);
      expect(jdh.oldestUnresolvedDate.reconciliation_missing).toBe(plusDays(first, 1));
      await h.one(ACC2, VERIFY_REC, [rec.id, rid()]);
      jdh = await branchView('JDH');
      expect(jdh.unresolvedTotals).toMatchObject({ reconciliation_missing: 71, reconciliation_awaiting_verification: 0 });
      expect(jdh.oldestUnresolvedDate.reconciliation_awaiting_verification).toBeUndefined();
      expect(datesOf(jdh.unresolved, 'reconciliation_missing')).not.toContain(first);
    });
  });

  it('creates obligations only for dates whose end-of-day policy requires reconciliation', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      await h.verifiedCash(DEAL, { receivedOn: daysAgo(2) });
      // From now on reconciliation is not required; earlier dates keep their obligation.
      await h.one(SUPER, POLICY, [await h.entityId(), JSON.stringify({ reconciliationRequired: false }), null, 'Synthetic: pause daily counts', rid()]);
      await shiftToday(5);
      const jdh = await branchView('JDH');
      expect(datesOf(jdh.unresolved, 'reconciliation_missing')).toEqual([daysAgo(2), daysAgo(1)]);
      expect(jdh.unresolvedTotals.reconciliation_missing).toBe(2);
    });
  });
});

describe('late reconciliation of an outstanding obligation (lead decision, section 2 extension)', () => {
  it('records a 120-day-old obligation late, verifies it by another person, and it clears', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const branch = await h.branchId('JDH');
      const first = daysAgo(2);
      await h.verifiedCash(DEAL, { receivedOn: first });
      await shiftToday(118); // the cash day is now 120 days old
      let jdh = await branchView('JDH');
      expect(jdh.oldestUnresolvedDate.reconciliation_missing).toBe(first);
      const rec = await h.one<{ id: string; status: string }>(ACC, REC, [branch, first, '1000000', null, rid()]);
      expect(rec.status).toBe('recorded');
      const [row] = await h.owner<{ expected: string }>(`select expected_paise::text as expected from public.cash_reconciliations where id = $1`, [rec.id]);
      expect(row!.expected).toBe('1000000');
      // A second current row for the same date is wrong_state, at any age.
      await h.refused(ACC, REC, [branch, first, '1000000', null, rid()], '55000', 'wrong_state');
      jdh = await branchView('JDH');
      expect(datesOf(jdh.unresolved, 'reconciliation_awaiting_verification')).toEqual([first]);
      await h.refused(ACC, VERIFY_REC, [rec.id, rid()], '42501', 'not_self_approval');
      await h.one(ACC2, VERIFY_REC, [rec.id, rid()]);
      jdh = await branchView('JDH');
      expect(jdh.unresolvedTotals.reconciliation_awaiting_verification).toBe(0);
      expect(jdh.unresolvedTotals.reconciliation_missing).toBe(119);
      expect(jdh.oldestUnresolvedDate.reconciliation_missing).toBe(plusDays(first, 1));
      expect(datesOf(jdh.unresolved, 'reconciliation_missing')).not.toContain(first);
    });
  });

  it('still refuses a date older than 90 days that is not an obligation, and any future date', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const jdh = await h.branchId('JDH');
      const first = daysAgo(2);
      await h.verifiedCash(DEAL, { receivedOn: first });
      await shiftToday(118);
      // Before the branch's first cash activity: no obligation.
      await h.refused(ACC, REC, [jdh, plusDays(first, -1), '0', null, rid()], '22023', 'invalid_input');
      // A branch with no cash activity at all.
      await h.refused(ACC, REC, [await h.branchId('DEL'), first, '0', null, rid()], '22023', 'invalid_input');
      // Future dates stay refused.
      await h.refused(ACC, REC, [jdh, plusDays(today(), 119), '1000000', null, rid()], '22023', 'invalid_input');
    });
  });

  it('refuses an old date whose end-of-day policy did not require reconciliation', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const jdh = await h.branchId('JDH');
      await h.verifiedCash(DEAL, { receivedOn: daysAgo(2) });
      await h.one(SUPER, POLICY, [await h.entityId(), JSON.stringify({ reconciliationRequired: false }), null, 'Synthetic: pause daily counts', rid()]);
      await shiftToday(120);
      // today() (real) is now 120 days old, and not required by the policy in force at its end.
      await h.refused(ACC, REC, [jdh, today(), '1000000', null, rid()], '22023', 'invalid_input');
      // The required day before it is still clearable.
      expect((await h.one<{ status: string }>(ACC, REC, [jdh, daysAgo(1), '1000000', null, rid()])).status).toBe('recorded');
    });
  });
});

describe('a branch holding no cash has no daily obligation (contract section 11)', () => {
  it('creates obligations only for activity days, a non-zero balance or outstanding unverified cash', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const branch = await h.branchId('JDH');
      // Cash received and banked on the same day: the branch holds nothing afterwards.
      const cash = await h.verifiedCash(DEAL, { receivedOn: daysAgo(6) });
      const slip = await h.proof(ACC, 'branch', branch, 'deposit_slip');
      const dep = await h.one<{ id: string }>(ACC, 'select public.cash_deposit_record($1, $2::uuid[], $3::date, $4, $5, $6) as r', [
        branch, [cash.id], daysAgo(6), 'SLIP-01', slip, rid(),
      ]);
      await h.one(ACC2, 'select public.cash_deposit_verify($1, $2) as r', [dep.id, rid()]);
      let jdh = await branchView('JDH');
      expect(datesOf(jdh.unresolved, 'reconciliation_missing')).toEqual([daysAgo(6)]);

      // Recorded-unverified cash keeps every later day an obligation while it is outstanding.
      const pending = await h.record(ACC, DEAL2, await h.cashFields({ receivedOn: daysAgo(3), payerPan: 'QWERT1234Y', amountPaise: '200000' }));
      jdh = await branchView('JDH');
      expect(datesOf(jdh.unresolved, 'reconciliation_missing')).toEqual([daysAgo(6), daysAgo(3), daysAgo(2), daysAgo(1)]);
      // Once it is rejected only its own activity day remains.
      await h.reject(ACC2, pending.id, 'data_error');
      jdh = await branchView('JDH');
      expect(datesOf(jdh.unresolved, 'reconciliation_missing')).toEqual([daysAgo(6), daysAgo(3)]);
      expect(jdh.unresolvedTotals.reconciliation_missing).toBe(2);
    });
  });

  it('a Sunday on which the branch holds cash is an obligation even without activity', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      await h.verifiedCash(DEAL, { receivedOn: daysAgo(8) });
      const sunday = [1, 2, 3, 4, 5, 6, 7].map(daysAgo).find((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0)!;
      const jdh = await branchView('JDH');
      const missing = datesOf(jdh.unresolved, 'reconciliation_missing');
      expect(missing).toContain(sunday);
      expect(missing).toHaveLength(8); // daysAgo(8) .. daysAgo(1): cash held every day
    });
  });
});

describe('a date whose every row is stale stays clearable (contract section 11)', () => {
  it('re-records a stale-only obligation date older than 90 days', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const branch = await h.branchId('JDH');
      await h.verifiedCash(DEAL, { receivedOn: daysAgo(2) });
      const rec = await h.one<{ id: string }>(ACC, REC, [branch, daysAgo(2), '1000000', null, rid()]);
      await h.one(ACC2, VERIFY_REC, [rec.id, rid()]);
      await h.verifiedCash(DEAL2, { receivedOn: daysAgo(2), payerPan: 'QWERT1234Y', amountPaise: '200000' });
      await shiftToday(118);
      let jdh = await branchView('JDH');
      expect(datesOf(jdh.unresolved, 'reconciliation_stale')).toEqual([daysAgo(2)]);
      const again = await h.one<{ id: string; status: string }>(ACC, REC, [branch, daysAgo(2), '1200000', null, rid()]);
      expect(again.status).toBe('recorded');
      await h.refused(ACC, REC, [branch, daysAgo(2), '1200000', null, rid()], '55000', 'wrong_state');
      await h.one(ACC2, VERIFY_REC, [again.id, rid()]);
      jdh = await branchView('JDH');
      expect(jdh.unresolvedTotals).toMatchObject({ reconciliation_stale: 0, reconciliation_awaiting_verification: 0 });
      expect(datesOf(jdh.unresolved, 'reconciliation_missing')).not.toContain(daysAgo(2));
    });
  });

  it('re-records a stale-only date that is not an obligation, so it does not stay listed forever', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const branch = await h.branchId('JDH');
      // Reconciliation not required from now on: today's date never becomes an obligation.
      await h.one(SUPER, POLICY, [await h.entityId(), JSON.stringify({ reconciliationRequired: false }), null, 'Synthetic: pause daily counts', rid()]);
      await h.verifiedCash(DEAL, { receivedOn: today() });
      const rec = await h.one<{ id: string }>(ACC, REC, [branch, today(), '1000000', null, rid()]);
      await h.one(ACC2, VERIFY_REC, [rec.id, rid()]);
      await h.verifiedCash(DEAL2, { receivedOn: today(), payerPan: 'QWERT1234Y', amountPaise: '200000' });
      await shiftToday(120);
      let jdh = await branchView('JDH');
      expect(datesOf(jdh.unresolved, 'reconciliation_stale')).toEqual([today()]);
      expect(jdh.unresolvedTotals.reconciliation_missing).toBe(0);
      expect((await h.one<{ status: string }>(ACC, REC, [branch, today(), '1200000', null, rid()])).status).toBe('recorded');
      jdh = await branchView('JDH');
      expect(jdh.unresolved.filter((u) => u.kind.startsWith('reconciliation_'))).toEqual([]);
    });
  });
});

describe('only a verified reconciliation clears the obligation (audit finding 7)', () => {
  it('shows a recorded but unverified reconciliation as awaiting verification, never as clear', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const branch = await h.branchId('JDH');
      await h.verifiedCash(DEAL, { receivedOn: daysAgo(2) });
      const a = await h.one<{ id: string }>(ACC, REC, [branch, daysAgo(2), '1000000', null, rid()]);
      const b = await h.one<{ id: string }>(ACC, REC, [branch, daysAgo(1), '1000000', null, rid()]);
      const raw = await rawBranch('JDH');
      // Reproduces the defect: a recorded row used to make the date disappear from the unresolved list.
      expect(raw.unresolved.filter((u) => u.kind.startsWith('reconciliation_')).map((u) => u.businessDate)).toEqual([
        daysAgo(2),
        daysAgo(1),
      ]);

      let jdh = await branchView('JDH');
      expect(datesOf(jdh.unresolved, 'reconciliation_awaiting_verification')).toEqual([daysAgo(2), daysAgo(1)]);
      expect(jdh.unresolvedTotals).toMatchObject({ reconciliation_missing: 0, reconciliation_awaiting_verification: 2 });
      expect(jdh.oldestUnresolvedDate.reconciliation_awaiting_verification).toBe(daysAgo(2));
      // The branch never looks clear while checker approval is pending.
      expect(UNRESOLVED_CASH_KINDS.some((k) => jdh.unresolvedTotals[k] > 0)).toBe(true);

      await h.one(ACC2, VERIFY_REC, [a.id, rid()]);
      jdh = await branchView('JDH');
      expect(datesOf(jdh.unresolved, 'reconciliation_awaiting_verification')).toEqual([daysAgo(1)]);
      await h.one(ACC2, VERIFY_REC, [b.id, rid()]);
      jdh = await branchView('JDH');
      for (const k of ['reconciliation_missing', 'reconciliation_awaiting_verification', 'reconciliation_stale'] as const) {
        expect(jdh.unresolvedTotals[k], k).toBe(0);
      }
    });
  });

  it('moves a verified reconciliation to stale on a later posting, then awaiting, then verified', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const branch = await h.branchId('JDH');
      await h.verifiedCash(DEAL, { receivedOn: daysAgo(1) });
      const rec = await h.one<{ id: string }>(ACC, REC, [branch, daysAgo(1), '1000000', null, rid()]);
      await h.one(ACC2, VERIFY_REC, [rec.id, rid()]);
      let jdh = await branchView('JDH');
      expect(jdh.unresolved.filter((u) => u.kind.startsWith('reconciliation_'))).toEqual([]);

      // Cash verified later on the same business date makes the verified count stale.
      await h.verifiedCash(DEAL2, { receivedOn: daysAgo(1), payerPan: 'QWERT1234Y', amountPaise: '200000' });
      jdh = await branchView('JDH');
      expect(datesOf(jdh.unresolved, 'reconciliation_stale')).toEqual([daysAgo(1)]);
      expect(jdh.unresolvedTotals).toMatchObject({ reconciliation_stale: 1, reconciliation_missing: 0 });

      const fresh = await h.one<{ id: string }>(ACC, REC, [branch, daysAgo(1), '1200000', null, rid()]);
      jdh = await branchView('JDH');
      expect(jdh.unresolvedTotals).toMatchObject({ reconciliation_stale: 0, reconciliation_awaiting_verification: 1 });
      await h.one(ACC2, VERIFY_REC, [fresh.id, rid()]);
      jdh = await branchView('JDH');
      expect(jdh.unresolved.filter((u) => u.kind.startsWith('reconciliation_'))).toEqual([]);
    });
  });

  it('returns every total as zero, no oldest date and no truncation for a branch without cash work', async () => {
    await asOwner(db, async () => {
      const del = await branchView('DEL');
      expect(del.unresolved).toEqual([]);
      expect(del.unresolvedTotals).toEqual(Object.fromEntries(UNRESOLVED_CASH_KINDS.map((k) => [k, 0])));
      expect(del.oldestUnresolvedDate).toEqual({});
      expect(del.unresolvedTruncated).toBe(false);
    });
  });

  it('a recorded reconciliation for today is not yet an obligation', async () => {
    await asOwner(db, async () => {
      await h.addSecondAccounts();
      const branch = await h.branchId('JDH');
      await h.verifiedCash(DEAL, { receivedOn: today() });
      await h.one(ACC, REC, [branch, today(), '1000000', null, rid()]);
      const jdh = await branchView('JDH');
      expect(jdh.unresolved.filter((u) => u.kind.startsWith('reconciliation_'))).toEqual([]);
    });
  });
});

describe('accounts_queue pages (audit finding 12)', () => {
  it('pages by deal reference with a cursor, a total count and hasMore', async () => {
    await asOwner(db, async () => {
      for (const deal of [DEAL2, DEAL, DEAL3]) await h.record(ACC, deal, await h.bankFields());
      // Real Postgres (CI db job) may hold other synthetic rows: walk every page and assert relative facts.
      const seen: string[] = [];
      let after: string | null = null;
      let total = -1;
      for (let guard = 0; guard < 500; guard += 1) {
        const page = AccountsQueuePageSchema.parse(await h.one(ACC, QUEUE, ['awaiting_verification', after, 1]));
        if (total === -1) total = page.totalCount;
        expect(page.totalCount).toBe(total);
        expect(page.items.length).toBeLessThanOrEqual(1);
        seen.push(...page.items.map((i) => AccountsQueueItemSchema.parse(i).dealReference));
        if (!page.hasMore) {
          expect(page.nextAfter).toBeNull();
          break;
        }
        after = page.nextAfter;
      }
      expect(seen).toHaveLength(total);
      expect(seen.filter((r) => ['SYN-AMD-001', 'SYN-DEL-001', 'SYN-DEL-002'].includes(r))).toEqual([
        'SYN-AMD-001',
        'SYN-DEL-001',
        'SYN-DEL-002',
      ]);
      expect([...seen].sort()).toEqual(seen);

      const first = AccountsQueuePageSchema.parse(await h.one(ACC, QUEUE, ['awaiting_verification', null, 2]));
      expect(first.items).toHaveLength(2);
      expect(first.hasMore).toBe(total > 2);
      expect(first.totalCount).toBe(total);
    });
  });

  it('defaults to 50, clamps the limit to 1..100 and refuses a malformed cursor', async () => {
    await asOwner(db, async () => {
      for (const deal of [DEAL, DEAL2]) await h.record(ACC, deal, await h.bankFields());
      const byDefault = AccountsQueuePageSchema.parse(await h.one(ACC, `select public.accounts_queue('awaiting_verification') as r`));
      expect(byDefault.items.length).toBe(Math.min(byDefault.totalCount, 50));
      expect(byDefault.hasMore).toBe(byDefault.totalCount > 50);
      const zero = AccountsQueuePageSchema.parse(await h.one(ACC, QUEUE, ['awaiting_verification', null, 0]));
      expect(zero.items).toHaveLength(1);
      expect(zero.hasMore).toBe(true);
      const huge = AccountsQueuePageSchema.parse(await h.one(ACC, QUEUE, ['awaiting_verification', null, 100000]));
      expect(huge.items.length).toBe(Math.min(huge.totalCount, 100));
      const nullLimit = AccountsQueuePageSchema.parse(await h.one(ACC, QUEUE, ['awaiting_verification', null, null]));
      expect(nullLimit.items.length).toBe(Math.min(nullLimit.totalCount, 50));
      for (const bad of ['', 'not-a-cursor', `${DEAL}`, `${DEAL}:`, 'zzzzzzzz-0000-4000-8000-000000000001:SYN-DEL-001']) {
        await h.refused(ACC, QUEUE, ['all', bad, 10], '22023', 'invalid_input');
      }
      // The cursor of the very last item gives an empty, final page that still reports the total.
      const last = huge.items.at(-1)!;
      expect(huge.hasMore).toBe(false);
      const end = AccountsQueuePageSchema.parse(
        await h.one(ACC, QUEUE, ['awaiting_verification', `${last.dealId}:${last.dealReference}`, 10]),
      );
      expect(end).toMatchObject({ items: [], hasMore: false, nextAfter: null });
      expect(end.totalCount).toBe(huge.totalCount);
    });
  });
});
