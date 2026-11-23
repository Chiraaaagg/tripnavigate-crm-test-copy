import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_DEALS, FIXTURE_USERS, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACC, ACC2, DEAL, DEAL2, DEAL3, SALES, SALES_B, financeHelpers, rid } from './finance-support';

/**
 * Speed plan E1 (migration 20261117000100): accounts_queue checks Accounts
 * access and the finance gate once per (entity, synthetic flag) instead of once
 * per deal. The answer must be exactly what the previous definition
 * (20261103000100) returns: same items, order, paging cursor and total, for
 * every filter, under both deployment environments.
 */

let db: TestDb;
// Shares fixture deal heads with the other finance suites on one real Postgres.
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
const FILTERS = ['all', 'needs_review', 'returned', 'awaiting_verification', 'cheques_pending'] as const;

/** The 20261103000100 definition, renamed, created inside the rolled-back test transaction. */
function previousDefinition(): [string, string] {
  const sql = readFileSync(new URL('../../supabase/migrations/20261103000100_cash_overview_repairs.sql', import.meta.url), 'utf8');
  const start = sql.indexOf('create function public.accounts_queue(');
  const end = sql.indexOf('$$;', start);
  expect(start, 'previous accounts_queue definition found').toBeGreaterThan(-1);
  return [
    sql.slice(start, end + 3).replace('create function public.accounts_queue(', 'create function public.accounts_queue_previous('),
    'grant execute on function public.accounts_queue_previous(text, text, integer) to authenticated',
  ];
}

type Page = { items: Array<{ dealId: string }>; hasMore: boolean; nextAfter: string | null; totalCount: number };
type Outcome = { ok: Page } | { refused: string };

const SALES_B_ENTITY: Actor = { userId: FIXTURE_USERS.salesEntityB };
const DEAL_B = FIXTURE_DEALS.b001;

/** The answer or the refusal code, inside a savepoint so a refusal keeps the transaction usable. */
async function outcome(actor: Actor, fn: string, args: unknown[]): Promise<Outcome> {
  await db.query('savepoint speed_q');
  try {
    const params = args.map((_, i) => `$${i + 1}`).join(', ');
    const ok = await h.one<Page>(actor, `select public.${fn}(${params}) as r`, args);
    await db.query('release savepoint speed_q');
    return { ok };
  } catch (error) {
    await db.query('rollback to savepoint speed_q');
    return { refused: String((error as { code?: string }).code ?? error) };
  }
}

async function compareAll(actors: Actor[] = [ACC, ACC2]) {
  for (const actor of actors) {
    for (const filter of FILTERS) {
      const now = await outcome(actor, 'accounts_queue', [filter]);
      expect(now, `${actor.userId} ${filter}`).toEqual(await outcome(actor, 'accounts_queue_previous', [filter]));
      // Walk one-item pages: the cursor and hasMore agree at every step.
      let after: string | null = null;
      for (let step = 0; step < 10 && 'ok' in now; step += 1) {
        const a = await outcome(actor, 'accounts_queue', [filter, after, 1]);
        expect(a, `${filter} page ${step}`).toEqual(await outcome(actor, 'accounts_queue_previous', [filter, after, 1]));
        if (!('ok' in a) || !a.ok.hasMore) break;
        after = a.ok.nextAfter;
      }
    }
  }
}

async function dealIds(actor: Actor, filter: string): Promise<string[]> {
  const r = await outcome(actor, 'accounts_queue', [filter]);
  return 'ok' in r ? r.ok.items.map((i) => i.dealId) : [];
}

describe('accounts_queue entity gate (speed plan E1)', () => {
  it('answers exactly as the previous per-deal definition', async () => {
    await asOwner(db, async () => {
      for (const statement of previousDefinition()) await h.owner(statement);
      await h.addSecondAccounts();
      // Accounts Jodhpur also holds Accounts in the finance-DISABLED synthetic entity B.
      await h.owner(
        `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
         select $1, b.legal_entity_id, b.id, 'accounts', 'active' from public.branches b where b.code = 'SB1'`,
        [ACC.userId],
      );
      await compareAll();

      // Receipts in several states on three deals; confirmed bookings with a pending and a returned review.
      await h.record(ACC, DEAL, await h.bankFields());
      await h.record(ACC, DEAL2, await h.cashFields());
      await h.record(ACC, DEAL3, await h.chequeFields());
      await h.verify(ACC2, (await h.record(ACC, DEAL2, await h.cashFields({ amountPaise: '100000' }))).id);
      const returned = await h.confirmedBooking(DEAL);
      await h.confirmedBooking(DEAL2, SALES_B);
      expect(await h.one(ACC, 'select public.accounts_review_return($1, $2, $3) as r', [returned, 'Synthetic: passport copy missing', rid()]))
        .toMatchObject({ status: 'returned' });
      // SYNTHETIC FIXTURE: a confirmed booking on the entity-B deal, inserted as the owner (the
      // booking flow itself is not enabled for entity B). Entity B is not finance-enabled, so it stays out.
      await h.owner(
        `insert into public.booking_versions (deal_id, legal_entity_id, branch_id, version_no, status, content_hash,
           created_by, confirmed_by, confirmed_at)
         select d.id, d.legal_entity_id, d.branch_id, 1, 'confirmed', repeat('a', 64), $2, $2, now()
         from public.deals d where d.id = $1`,
        [DEAL_B, SALES_B_ENTITY.userId],
      );
      await compareAll();
      expect(await dealIds(ACC, 'needs_review')).toEqual([DEAL2]);
      expect(await dealIds(ACC, 'returned')).toEqual([DEAL]);
      expect(await dealIds(ACC, 'cheques_pending')).toEqual([DEAL3]);
      expect(await dealIds(ACC, 'all')).not.toContain(DEAL_B);

      // Entity B finance-enabled while the entity itself is disabled (fixture state): still out.
      await h.owner('select authz.finance_enable_entity(e.id) from public.legal_entities e where e.code = $1', ['SYNTHETIC_B']);
      await compareAll();
      expect(await dealIds(ACC, 'all')).not.toContain(DEAL_B);
      // Entity B enabled and finance-enabled: its deal joins the queue under both definitions.
      await h.owner(`update public.legal_entities set status = 'enabled' where code = 'SYNTHETIC_B'`);
      await compareAll();
      expect(await dealIds(ACC, 'all')).toContain(DEAL_B);
      expect(await dealIds(ACC2, 'all')).not.toContain(DEAL_B);

      // Accounts + Purchase in the same entity loses Accounts there (both definitions).
      await h.owner(
        `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
         select $1, b.legal_entity_id, b.id, 'purchase', 'active' from public.branches b where b.code = 'JDH'`,
        [ACC2.userId],
      );
      await compareAll([ACC, ACC2]);

      // Not Accounts: both definitions refuse in the same way.
      expect(await outcome(SALES, 'accounts_queue', ['all'])).toEqual({ refused: '42501' });
      expect(await outcome(SALES, 'accounts_queue_previous', ['all'])).toEqual({ refused: '42501' });
      // Operational environment: synthetic deals leave both queues.
      await h.setEnvironment('operational');
      await compareAll();
      expect(await dealIds(ACC, 'all')).toEqual([]);
    });
  });

  it('checks access once per entity, not once per deal', async () => {
    const [fn] = await db.query<{ src: string }>(`select prosrc as src from pg_proc where proname = 'accounts_queue'`);
    expect(fn!.src).toMatch(/gate as materialized/);
    const matched = fn!.src.slice(fn!.src.indexOf('matched as ('), fn!.src.indexOf('page as ('));
    expect(matched).not.toMatch(/authz\.can_accounts|authz\.finance_gate_issue/);
  });
});
