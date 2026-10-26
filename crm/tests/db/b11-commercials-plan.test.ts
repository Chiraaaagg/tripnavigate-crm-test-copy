import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, expectDbError, resetActor, setActor } from '../helpers/db';
import { ACCOUNTS, FLIGHT, HOTEL, MANAGER, OWNER, PURCHASE, SALES_B } from './b1-support';
import { COMMERCIALS_SQL, PLAN_SQL, b11Helpers } from './b11-support';

/**
 * B1.1a selling price and payment plan (migration 20261119000100): list
 * price, discount and final total; the plan must add up to the total
 * (readiness); both reach the hash only through commercial_revision.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { refused, refusedWithHint, owner, draftWithTravellers, saveCommercials, savePlan, readiness } = h;

const revision = async (versionId: string) =>
  (await owner<{ r: string }>('select commercial_revision::text as r from public.booking_versions where id = $1', [versionId]))[0]!.r;

describe('booking_commercials_save', () => {
  it('stores list, discount and total; refuses inconsistent amounts; redraws the commercial revision on every change', async () => {
    await asOwner(db, async () => {
      const d = await draftWithTravellers();
      const r0 = await revision(d.versionId);
      const saved = await saveCommercials(OWNER, d.versionId, d.rowVersion, '12000000', '2000000', '10000000');
      expect(await owner('select selling_total_paise::text as t, list_price_paise::text as l, discount_paise::text as d from public.booking_version_commercials where version_id = $1',
        [d.versionId])).toEqual([{ t: '10000000', l: '12000000', d: '2000000' }]);
      const r1 = await revision(d.versionId);
      expect(r1).not.toBe(r0);
      // Same total, different list/discount: still a new revision.
      const again = await saveCommercials(OWNER, d.versionId, saved.rowVersion, '11000000', '1000000', '10000000');
      expect(await revision(d.versionId)).not.toBe(r1);
      // Total only.
      const plain = await saveCommercials(OWNER, d.versionId, again.rowVersion, null, null, '9000000');
      for (const [list, discount, total, hint] of [
        [null, null, '0', /^totalPaise$/], [null, null, null, /^totalPaise$/], [null, '100', '9000000', /^discountPaise$/],
        ['9000000', '100', '9000000', /^listPaise$/], ['-1', null, '9000000', /^listPaise$/],
      ] as Array<[string | null, string | null, string | null, RegExp]>) {
        await refusedWithHint(OWNER, COMMERCIALS_SQL, [d.versionId, plain.rowVersion, list, discount, total], hint);
      }
      await refused(OWNER, COMMERCIALS_SQL, [d.versionId, plain.rowVersion - 1, null, null, '1'], '40001', 'version_changed');
      // No amount in the audit.
      const audit = await owner('select details from public.audit_events where action = $1 and target_id = $2', ['booking.commercials_saved', d.versionId]);
      expect(audit).toHaveLength(3);
      expect(JSON.stringify(audit)).not.toMatch(/10000000|9000000/);
    });
  });

  it('only commercial readers who may edit the draft save prices', async () => {
    await asOwner(db, async () => {
      const d = await draftWithTravellers();
      await h.addFlight();
      for (const actor of [SALES_B, PURCHASE, ACCOUNTS, FLIGHT]) {
        await refused(actor, COMMERCIALS_SQL, [d.versionId, d.rowVersion, null, null, '100'], '42501', 'not_authorized');
      }
      // An editor without deal.read_commercial (a Sales assignee whose role permission is withdrawn) is refused.
      await owner(`delete from public.role_permissions where role_code = 'sales' and permission_code = 'deal.read_commercial'`);
      await refused(OWNER, COMMERCIALS_SQL, [d.versionId, d.rowVersion, null, null, '100'], '42501', 'not_authorized');
      await refused(OWNER, PLAN_SQL, [d.versionId, d.rowVersion, '[]'], '42501', 'not_authorized');
    });
  });
});

describe('booking_instalments_save', () => {
  it('replaces the plan; readiness reports a missing plan and a plan that does not add up; the plan redraws the revision', async () => {
    await asOwner(db, async () => {
      const d = await draftWithTravellers();
      let rv = (await h.addItem(OWNER, d.versionId, d.rowVersion, 'hotel', HOTEL)).rowVersion;
      rv = (await saveCommercials(OWNER, d.versionId, rv, null, null, '21000000')).rowVersion;
      expect((await readiness(OWNER, d.versionId)).issues).toContain('plan_missing');
      const r0 = await revision(d.versionId);
      rv = (await savePlan(OWNER, d.versionId, rv, [
        { seq: 1, label: 'Advance', amountPaise: '12000000', dueDate: '2026-10-10' },
        { seq: 2, label: 'Balance', amountPaise: 8000000, dueDate: '2026-10-29' },
      ])).rowVersion;
      expect(await revision(d.versionId)).not.toBe(r0);
      let issues = (await readiness(OWNER, d.versionId)).issues;
      expect(issues).toContain('plan_total_mismatch');
      expect(issues).not.toContain('plan_missing');
      rv = (await savePlan(OWNER, d.versionId, rv, [
        { seq: 1, label: 'Advance', amountPaise: '12000000', dueDate: '2026-10-10' },
        { seq: 2, label: 'Balance', amountPaise: '9000000', dueDate: '2026-10-29' },
      ])).rowVersion;
      issues = (await readiness(OWNER, d.versionId)).issues;
      expect(issues).not.toContain('plan_total_mismatch');
      expect(await owner('select seq, label, amount_paise::text as a, due_date::text as d from public.booking_version_instalments where booking_version_id = $1 order by seq', [d.versionId]))
        .toEqual([{ seq: 1, label: 'Advance', a: '12000000', d: '2026-10-10' }, { seq: 2, label: 'Balance', a: '9000000', d: '2026-10-29' }]);
      for (const bad of [
        [{ seq: 1, label: 'A', amountPaise: '0', dueDate: '2026-10-10' }],
        [{ seq: 1, label: 'A', amountPaise: '1.5', dueDate: '2026-10-10' }],
        [{ seq: 1, label: '', amountPaise: '1', dueDate: '2026-10-10' }],
        [{ seq: 1, label: 'A', amountPaise: '1', dueDate: 'tomorrow' }],
        [{ seq: 1, label: 'A', amountPaise: '1', dueDate: '2026-10-10' }, { seq: 1, label: 'B', amountPaise: '1', dueDate: '2026-10-10' }],
        [{ seq: 1, label: 'A', amountPaise: '1', dueDate: '2026-10-10', mode: 'upi' }],
      ]) {
        await refusedWithHint(OWNER, PLAN_SQL, [d.versionId, rv, JSON.stringify(bad)], /^instalments\[\d\]$/);
      }
      await refusedWithHint(OWNER, PLAN_SQL, [d.versionId, rv, JSON.stringify(Array.from({ length: 13 }, (_, i) => ({ seq: i + 1, label: 'X', amountPaise: '1', dueDate: '2026-10-10' })))], /^instalments$/);
      // Without commercial scope the plan issues read "ask the owner".
      rv = (await savePlan(OWNER, d.versionId, rv, [])).rowVersion;
      await owner(`delete from public.role_permissions where role_code = 'sales' and permission_code = 'deal.read_commercial'`);
      issues = (await readiness(OWNER, d.versionId)).issues;
      expect(issues).toContain('plan_ask_owner');
      expect(issues).not.toContain('plan_missing');
    });
  });

  it('instalments are readable only by commercial booking readers; never Purchase', async () => {
    await asOwner(db, async () => {
      const d = await draftWithTravellers();
      const rv = (await saveCommercials(OWNER, d.versionId, d.rowVersion, null, null, '100')).rowVersion;
      await savePlan(OWNER, d.versionId, rv, [{ seq: 1, label: 'Full', amountPaise: '100', dueDate: '2026-10-10' }]);
      const read = async (actor: typeof OWNER) => {
        await setActor(db, actor);
        const rows = await db.query('select seq from public.booking_version_instalments');
        await resetActor(db);
        return rows.length;
      };
      expect(await read(OWNER)).toBe(1);
      // The branch Manager reads commercial values only on Deals they own or are assigned to (existing rule).
      expect(await read(MANAGER)).toBe(0);
      expect(await read(ACCOUNTS)).toBe(1); // explicit deal.read_commercial grant in the fixtures
      expect(await read(PURCHASE)).toBe(0);
      expect(await read(SALES_B)).toBe(0);
      await setActor(db, { userId: null });
      await expectDbError(db, () => db.query('select * from public.booking_version_instalments'), { code: '42501' });
      await resetActor(db);
    });
  });
});
