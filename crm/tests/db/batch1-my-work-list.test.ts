import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACC } from './finance-support';
import {
  ACCOUNTS, ANON, COUNTS_SQL, DEAL, DEAL2, DEAL_AMD, MANAGER, MANAGER_AMD, OWNER, PURCHASE, SALES_AMD, SALES_B, SUPER, TRANSFER,
  allKeys, b1Helpers,
} from './b1-support';
import { DESK } from './b11-support';

/**
 * Direction A Batch 1 B1-3 (migration 20261121000120_my_work_list): the Home
 * work rows behind the counts. Each list has the predicate of its count key
 * (drafts = draftsToContinue, missing_details = missingDetails, returned =
 * returnedToMe, needs_booking = intakeNeeded); Sales and Manager only; keyset
 * pages; no money, reason or staff identity. my_work_counts keeps every
 * existing key and gains draftsToContinue. Synthetic fixtures; rolled back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b1Helpers(() => db);
const { one, refused, owner, setSwitch, openDraft } = h;

const LIST_SQL = 'select public.my_work_list($1, $2::jsonb, $3) as r';
type Row = { dealId: string; reference: string; title: string; branchId: string; versionNo?: number; since: string };
type Page = { applies: boolean; available?: boolean; reason?: string; rows?: Row[]; hasMore?: boolean; next?: { since: string; dealId: string } | null };
type Counts = Record<string, number | null>;

const counts = (actor: Actor) => one<Counts>(actor, COUNTS_SQL);
const page = (actor: Actor, kind: string, after: unknown = null, limit: number | null = null) =>
  one<Page>(actor, LIST_SQL, [kind, after === null ? null : JSON.stringify(after), limit]);
/** Every row of a kind, following the cursor with the given page size. */
async function all(actor: Actor, kind: string, limit = 50): Promise<Row[]> {
  const out: Row[] = [];
  let after: unknown = null;
  for (let i = 0; i < 100; i += 1) {
    const p = await page(actor, kind, after, limit);
    out.push(...(p.rows ?? []));
    if (!p.hasMore) return out;
    after = p.next;
  }
  throw new Error('pagination did not end');
}
const KIND_COUNT: Record<string, string> = { drafts: 'draftsToContinue', missing_details: 'missingDetails', returned: 'returnedToMe', needs_booking: 'intakeNeeded' };

async function expectListsEqualCounts(actor: Actor, label: string) {
  const c = await counts(actor);
  for (const [kind, key] of Object.entries(KIND_COUNT)) {
    const p = await page(actor, kind);
    if (kind === 'needs_booking' && p.available === false) {
      expect({ label, kind, n: c[key] }).toEqual({ label, kind, n: 0 });
      continue;
    }
    expect({ label, kind, n: (await all(actor, kind)).length }).toEqual({ label, kind, n: c[key] });
  }
}

/** Three Delhi drafts (OWNER on DEAL, SALES_B on DEAL2, OWNER on a new Delhi Deal) and one Ahmedabad draft. */
async function drafts(): Promise<{ extra: string }> {
  await setSwitch('service_items_enabled', true);
  const extra = 'd0000000-0000-4000-8000-0000000000e1';
  await owner(
    `insert into public.deals (id, legal_entity_id, branch_id, reference, title, owner_user_id)
     select $1::uuid, b.legal_entity_id, b.id, 'SYN-DEL-0E1', 'Synthetic extra Delhi deal', $2::uuid
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'`, [extra, U.salesDelhiA]);
  await openDraft(OWNER, DEAL);
  await openDraft(SALES_B, DEAL2);
  await openDraft(OWNER, extra);
  await openDraft(SALES_AMD, DEAL_AMD);
  return { extra };
}

describe('my_work_counts keeps its keys and adds draftsToContinue', () => {
  it('existing keys unchanged; draftsToContinue only for Sales and Manager', async () => {
    await asOwner(db, async () => {
      await drafts();
      expect(await counts(OWNER)).toEqual({
        waitingForMe: 2, returnedToMe: 0, missingDetails: 2, intakeNeeded: 0, receiptsToVerify: null, requestsToApprove: null,
        visaTasksWaiting: null, claimsToProcess: null, expensesToReview: null, draftsToContinue: 2,
        // Batch 3 (20261123000100, FP-081): two new keys, every earlier key unchanged.
        quotationDraftsToFinish: 0, acceptedQuotesToLink: 0,
      });
      expect((await counts(MANAGER)).draftsToContinue).toBe(3);
      for (const actor of [PURCHASE, DESK, ACCOUNTS, SUPER]) {
        const c = await counts(actor);
        expect(c.draftsToContinue).toBeNull();
        // Echo-B L8: the keys are present (as JSON null), not merely missing.
        expect(c).toHaveProperty('quotationDraftsToFinish');
        expect(c.quotationDraftsToFinish).toBeNull();
        expect(c).toHaveProperty('acceptedQuotesToLink');
        expect(c.acceptedQuotesToLink).toBeNull();
      }
    });
  });

  it('mixed roles: draftsToContinue equals the drafts list while waitingForMe stays the combined number', async () => {
    await asOwner(db, async () => {
      // A confirmed flight booking on DEAL (one flight task), then drafts on DEAL2 and DEAL_AMD.
      const ready = await h.readyPackage(OWNER, DEAL, ['flight']);
      await h.confirm(OWNER, ready.versionId, ready.hash);
      await openDraft(SALES_B, DEAL2);
      await openDraft(SALES_AMD, DEAL_AMD);
      // Manager plus Accounts (Delhi Manager also holds Accounts).
      await owner(`insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
                   select $1, b.legal_entity_id, b.id, 'accounts', 'active' from public.branches b
                   join public.legal_entities e on e.id = b.legal_entity_id where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'`, [U.managerDelhi]);
      // Sales plus Flight (Sales Delhi B also holds Flight).
      await h.addFlight(U.salesDelhiB, 'DEL');
      for (const [actor, label] of [[MANAGER, 'manager+accounts'], [SALES_B, 'sales+flight']] as const) {
        const c = await counts(actor);
        expect((await all(actor, 'drafts')).length).toBe(c.draftsToContinue);
        expect(c.waitingForMe).toBeGreaterThan(c.draftsToContinue as number);
        await expectListsEqualCounts(actor, label);
      }
    });
  });
});

describe('my_work_list', () => {
  it('each list length equals its own count key, per role (including a Manager whose branch access comes from a grant)', async () => {
    await asOwner(db, async () => {
      await drafts();
      await owner(`insert into public.access_grants (user_id, legal_entity_id, branch_id, permission_code, granted_by, reason)
                   select $1, d.legal_entity_id, d.branch_id, 'deal.read', $2, 'Synthetic cross-branch grant for the test'
                   from public.deals d where d.id = $3`, [MANAGER_AMD.userId, SUPER.userId, DEAL]);
      for (const [actor, label] of [[OWNER, 'owner'], [SALES_B, 'sales b'], [MANAGER, 'manager'], [MANAGER_AMD, 'manager amd + grant'], [SALES_AMD, 'sales amd']] as const) {
        await expectListsEqualCounts(actor, label);
      }
      expect((await all(MANAGER, 'drafts')).map((r) => r.reference).sort()).toEqual(['SYN-DEL-001', 'SYN-DEL-002', 'SYN-DEL-0E1']);
      expect((await all(OWNER, 'drafts')).map((r) => r.reference).sort()).toEqual(['SYN-DEL-001', 'SYN-DEL-0E1']);
    });
  });

  it('missing_details shrinks when a draft becomes ready; returned follows an Accounts return', async () => {
    await asOwner(db, async () => {
      await setSwitch('service_items_enabled', true);
      const opened = await openDraft(OWNER, DEAL);
      let rv = (await h.addItem(OWNER, opened.versionId, opened.rowVersion, 'transfer', TRANSFER)).rowVersion;
      rv = (await h.saveTravellers(OWNER, DEAL, rv)).rowVersion;
      rv = (await h.saveSelling(OWNER, opened.versionId, rv)).rowVersion;
      expect((await all(OWNER, 'missing_details')).map((r) => r.dealId)).toEqual([DEAL]);
      rv = await h.completeB11(OWNER, DEAL, opened.versionId, rv);
      await h.storeEvidence(OWNER, opened.versionId);
      expect(await all(OWNER, 'missing_details')).toEqual([]);
      expect((await all(OWNER, 'drafts')).map((r) => r.versionNo)).toEqual([1]);
      const { contentHash } = await h.readiness(OWNER, opened.versionId);
      await h.confirm(OWNER, opened.versionId, contentHash);
      expect(await all(OWNER, 'drafts')).toEqual([]);
      await one(ACC, 'select public.accounts_review_return($1, $2, $3) as r', [opened.versionId, 'Synthetic return reason for test', crypto.randomUUID()]);
      const returned = await all(OWNER, 'returned');
      expect(returned).toHaveLength(1);
      expect(Object.keys(returned[0]!).sort()).toEqual(['branchId', 'dealId', 'reference', 'since', 'title']);
      expect((await all(MANAGER, 'returned')).map((r) => r.dealId)).toEqual([DEAL]);
      expect(await all(SALES_B, 'returned')).toEqual([]);
      await expectListsEqualCounts(OWNER, 'owner after return');
      await expectListsEqualCounts(MANAGER, 'manager after return');
      // No return reason, money or staff identity in any row.
      const raw = JSON.stringify(returned);
      expect(raw).not.toMatch(/Synthetic return reason|9876543|Synthetic Sales/);
      expect([...allKeys(returned)].filter((k) => /reason|sell|margin|amount|paise|owner|name|contact|traveller/i.test(k))).toEqual([]);
      expect(rv).toBeGreaterThan(1);
    });
  });

  it('needs_booking follows the intake prompt switch', async () => {
    await asOwner(db, async () => {
      const dealId = await h.insertRealDeal('UC_AD0SLH', 0);
      expect(await page(OWNER, 'needs_booking')).toEqual({ applies: true, available: false, reason: 'switched_off' });
      await setSwitch('intake_prompt_enabled', true);
      expect((await all(OWNER, 'needs_booking')).map((r) => r.dealId)).toEqual([dealId]);
      expect((await all(MANAGER, 'needs_booking')).map((r) => r.dealId)).toEqual([dealId]);
      expect(await all(SALES_B, 'needs_booking')).toEqual([]);
      await expectListsEqualCounts(OWNER, 'owner intake');
      await expectListsEqualCounts(MANAGER, 'manager intake');
    });
  });

  it('Purchase, Flight, Visa, Accounts and Super Admin get applies:false and no rows; anon and aal1 are refused', async () => {
    await asOwner(db, async () => {
      await drafts();
      await h.addFlight(U.movedStaff);
      for (const actor of [PURCHASE, { userId: U.movedStaff }, DESK, ACCOUNTS, SUPER]) {
        for (const kind of Object.keys(KIND_COUNT)) expect(await page(actor, kind)).toEqual({ applies: false });
      }
      await refused(ANON, LIST_SQL, ['drafts', null, null], '42501');
      await refused({ userId: U.salesDelhiA, aal: 'aal1' }, LIST_SQL, ['drafts', null, null], '42501', 'not_authorized');
    });
  });

  it('removed Deals never appear (and are not in draftsToContinue)', async () => {
    await asOwner(db, async () => {
      await drafts();
      await owner('alter table public.deals drop constraint deals_removed_imported_only');
      await owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [DEAL]);
      expect((await all(OWNER, 'drafts')).map((r) => r.reference)).toEqual(['SYN-DEL-0E1']);
      expect((await all(OWNER, 'missing_details')).map((r) => r.reference)).toEqual(['SYN-DEL-0E1']);
      expect((await counts(OWNER)).draftsToContinue).toBe(1);
      // The existing keys already leave the removed Deal's draft out (the draft is no longer editable), so lists equal counts.
      expect(await counts(OWNER)).toMatchObject({ waitingForMe: 1, missingDetails: 1 });
      await expectListsEqualCounts(OWNER, 'owner after removal');
      await expectListsEqualCounts(MANAGER, 'manager after removal');
    });
  });

  it('keyset pages are stable with inserts between pages; bad input is refused with a hint', async () => {
    await asOwner(db, async () => {
      await drafts();
      // Distinct save times (one transaction gives every draft the same now()).
      await owner(`update public.booking_versions v set updated_at = now() - (interval '1 minute' * x.n)
                   from (select id, row_number() over (order by deal_id) as n from public.booking_versions where status = 'draft') x
                   where v.id = x.id`);
      const first = await page(MANAGER, 'drafts', null, 2);
      expect(first.rows).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      // A newer draft appears between pages: it sorts before the cursor, so the next page neither repeats nor skips.
      const newer = 'd0000000-0000-4000-8000-0000000000e2';
      await owner(
        `insert into public.deals (id, legal_entity_id, branch_id, reference, title, owner_user_id)
         select $1::uuid, b.legal_entity_id, b.id, 'SYN-DEL-0E2', 'Synthetic newer deal', $2::uuid
         from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
         where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'`, [newer, U.salesDelhiB]);
      await openDraft(SALES_B, newer);
      await owner(`update public.booking_versions set updated_at = now() + interval '1 minute' where deal_id = $1`, [newer]);
      const second = await page(MANAGER, 'drafts', first.next, 2);
      expect(second.hasMore).toBe(false);
      expect(second.next).toBeNull();
      const seen = [...first.rows!, ...second.rows!].map((r) => r.dealId);
      expect(new Set(seen).size).toBe(3);
      expect(seen).not.toContain(newer);
      // Order: since desc, dealId asc.
      const since = seen.map((_, i) => [...first.rows!, ...second.rows!][i]!.since);
      expect([...since].sort().reverse()).toEqual(since);
      expect((await all(MANAGER, 'drafts', 1)).length).toBe(4);
      for (const [kind, after, limit, hint] of [
        ['everything', null, null, 'kind'], [null, null, null, 'kind'], ['drafts', null, 0, 'limit'], ['drafts', null, 51, 'limit'],
        ['drafts', { since: 'not-a-time', dealId: DEAL }, null, 'after'], ['drafts', { since: '2026-10-01T00:00:00Z' }, null, 'after'],
        ['drafts', { since: '2026-10-01T00:00:00Z', dealId: 'x' }, null, 'after'], ['drafts', [1], null, 'after'],
        ['drafts', { since: '2026-10-01T00:00:00Z', dealId: DEAL, extra: 1 }, null, 'after'],
      ] as const) {
        await db.exec('savepoint bad');
        let err: { code?: string; message?: string; hint?: string } | undefined;
        try {
          await page(OWNER, kind as string, after, limit as number | null);
        } catch (e) {
          err = e as typeof err;
        }
        await db.exec('rollback to savepoint bad');
        expect({ input: [kind, after, limit], code: err?.code, message: err?.message, hint: err?.hint })
          .toEqual({ input: [kind, after, limit], code: '22023', message: 'invalid_input', hint });
      }
    });
  });

  it('reads write nothing; definer, empty search path, authenticated only', async () => {
    await asOwner(db, async () => {
      await drafts();
      const audit = await h.count('select 1 from public.audit_events');
      const versions = await owner('select id, row_version, updated_at from public.booking_versions order by id');
      for (const kind of Object.keys(KIND_COUNT)) await page(MANAGER, kind);
      await counts(MANAGER);
      expect(await h.count('select 1 from public.audit_events')).toBe(audit);
      expect(await owner('select id, row_version, updated_at from public.booking_versions order by id')).toEqual(versions);
      const fns = await owner<{ fn: string; definer: boolean; config: string[]; auth: boolean; svc: boolean; anon: boolean }>(
        `select p.oid::regprocedure::text as fn, p.prosecdef as definer, p.proconfig as config,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc,
                has_function_privilege('anon', p.oid, 'execute') as anon
         from pg_proc p where p.oid in ('public.my_work_list(text, jsonb, integer)'::regprocedure, 'public.my_work_counts()'::regprocedure)
         order by 1`);
      expect(fns.map((f) => ({ ...f, svc: undefined }))).toEqual([
        { fn: 'my_work_counts()', definer: true, config: ['search_path=""'], auth: true, svc: undefined, anon: false },
        { fn: 'my_work_list(text,jsonb,integer)', definer: true, config: ['search_path=""'], auth: true, svc: undefined, anon: false },
      ]);
      expect(fns.find((f) => f.fn.startsWith('my_work_list'))!.svc).toBe(false);
    });
  });
});
