import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, HOTEL, OWNER, SALES_B, SERVICES_SQL, SUPER } from './b1-support';
import { SETTING_SQL_B11, SWITCH_REASON, VISA, b11Helpers } from './b11-support';

/**
 * The desk switch (migration 20261119000500): off = sold visa/passport items
 * wait; switching on creates each missing task once (removed and lost Deals
 * skipped); confirmations while on create the task directly; off again
 * creates and deletes nothing. Every change is audited.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one, refused, owner, readyDraft, confirm } = h;
const visaTasks = () => owner<{ id: string; task_key: string; department: string }>(
  `select id, task_key, department from public.fulfilment_tasks where service_purpose in ('visa', 'passport') order by created_at`);

describe('visa_passport_tasks_enabled', () => {
  it('switching on creates each missing task once; switching again creates none; off deletes nothing', async () => {
    await asOwner(db, async () => {
      const ready = await readyDraft(OWNER, DEAL, [['hotel', HOTEL], ['visa', VISA]], { identities: true });
      await confirm(OWNER, ready.versionId, ready.hash);
      expect(await visaTasks()).toEqual([]);
      await refused(SALES_B, SETTING_SQL_B11, ['visa_passport_tasks_enabled', true, SWITCH_REASON], '42501', 'not_authorized');
      const on = await one<Record<string, unknown>>(SUPER, SETTING_SQL_B11, ['visa_passport_tasks_enabled', true, SWITCH_REASON]);
      expect(on).toMatchObject({ key: 'visa_passport_tasks_enabled', changed: true, before: false, after: true, tasksCreated: 1, skipped: 0 });
      const tasks = await visaTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.task_key).toBe(`item:${ready.itemIds[1]}:visa`);
      expect(tasks[0]!.department).toBe('visa');
      // Off and on again: nothing new, nothing deleted.
      expect(await one(SUPER, SETTING_SQL_B11, ['visa_passport_tasks_enabled', false, SWITCH_REASON])).toMatchObject({ after: false });
      expect(await visaTasks()).toHaveLength(1);
      expect(await one(SUPER, SETTING_SQL_B11, ['visa_passport_tasks_enabled', true, SWITCH_REASON])).toMatchObject({ tasksCreated: 0 });
      expect(await visaTasks()).toHaveLength(1);
      const services = await one<{ items: Array<{ serviceType: string; nextStep: string }>; progress: { byState: Record<string, number> } }>(OWNER, SERVICES_SQL, [DEAL]);
      expect(services.items.find((i) => i.serviceType === 'visa')!.nextStep).toBe('take_task');
      expect(services.progress.byState).toMatchObject({ waitingForLaunch: 0, notStarted: 2 });
      // Audited as a settings change with the reason; outbox and audit per created task.
      const audit = await owner<{ details: Record<string, unknown>; reason: string }>(
        `select details, reason from public.audit_events where action = 'settings.workflow_changed' order by id`);
      expect(audit.map((a) => Object.keys(a.details.changes as object))).toContainEqual(['visa_passport_tasks_enabled']);
      expect(await owner(`select count(*)::int as n from public.outbox_events where event_type = 'fulfilment.task_created' and aggregate_id = $1`, [tasks[0]!.id]))
        .toEqual([{ n: 1 }]);
    });
  });

  it('a Deal removed by the sync or lost is skipped (counted); a confirmation while on creates the visa task directly', async () => {
    await asOwner(db, async () => {
      // A test-only imported Deal (removal applies to imported Deals only).
      const dealId = await h.insertRealDeal('UC_AD0SLH');
      const ready = await readyDraft(OWNER, dealId, [['visa', VISA]], { identities: true });
      expect(ready.issues).toEqual([]);
      await confirm(OWNER, ready.versionId, ready.hash);
      await owner(`update public.deals set removed_at = now(), removed_reason = 'outside_entry_stage' where id = $1`, [dealId]);
      expect(await one(SUPER, SETTING_SQL_B11, ['visa_passport_tasks_enabled', true, SWITCH_REASON])).toMatchObject({ tasksCreated: 0, skipped: 1 });
      expect(await visaTasks()).toEqual([]);
    });
    await asOwner(db, async () => {
      await one(SUPER, SETTING_SQL_B11, ['visa_passport_tasks_enabled', true, SWITCH_REASON]);
      const ready = await readyDraft(OWNER, DEAL, [['hotel', HOTEL], ['visa', VISA]], { identities: true });
      expect((await h.readiness(OWNER, ready.versionId)).issues).toEqual([]);
      const result = await confirm(OWNER, ready.versionId, ready.hash);
      expect(result.taskIds).toHaveLength(2);
      expect((await visaTasks()).map((t) => t.department)).toEqual(['visa']);
      // Not waiting for the launch any more.
      const list = await one<{ items: Array<{ code: string }> }>(OWNER, 'select public.intake_checklist($1) as r', [DEAL]);
      expect(list.items.map((i) => i.code)).not.toContain('visa_waiting_for_launch');
    });
  });

  it('review V3: switching on again repairs a Deal that was skipped while removed', async () => {
    await asOwner(db, async () => {
      const dealId = await h.insertRealDeal('UC_AD0SLH');
      const ready = await readyDraft(OWNER, dealId, [['visa', VISA]], { identities: true });
      await confirm(OWNER, ready.versionId, ready.hash);
      await owner(`update public.deals set removed_at = now(), removed_reason = 'outside_entry_stage' where id = $1`, [dealId]);
      expect(await one(SUPER, SETTING_SQL_B11, ['visa_passport_tasks_enabled', true, SWITCH_REASON])).toMatchObject({ tasksCreated: 0, skipped: 1 });
      await owner('update public.deals set removed_at = null, removed_reason = null where id = $1', [dealId]);
      const again = await one<Record<string, unknown>>(SUPER, SETTING_SQL_B11, ['visa_passport_tasks_enabled', true, SWITCH_REASON]);
      expect(again).toMatchObject({ changed: false, tasksCreated: 1, skipped: 0 });
      expect(await visaTasks()).toHaveLength(1);
    });
  });
});
