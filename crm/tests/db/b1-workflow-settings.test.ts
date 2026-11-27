import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACCOUNTS, ANON, MANAGER, OWNER, PURCHASE, REASON, SETTINGS_GET_SQL, SETTING_SQL, SUPER, SVC, b1Helpers } from './b1-support';

/**
 * B1 workflow switches (migration 20261118000100): the single
 * workflow_settings row, admin_set_workflow_setting (Super Admin at aal2,
 * reason 10-500 characters, unknown key refused) and the settings audit
 * trigger (settings.workflow_changed) for the command and for owner SQL.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b1Helpers(() => db);
const { one, run, refused, owner } = h;

type Setting = { key: string; changed: boolean; before: boolean; after: boolean; updatedAt: string };

describe('admin_set_workflow_setting', () => {
  it('Super Admin flips a switch with a reason; the audit row names the person, the command and the reason', async () => {
    await asOwner(db, async () => {
      const before = await one<{ intakePromptEnabled: boolean; serviceItemsEnabled: boolean; updatedAt: string | null }>(OWNER, SETTINGS_GET_SQL);
      // Batch 2 (20261122000100) adds prefillAutoFill, Batch 3 (20261123000100) referralDrafts (both off by default).
      expect(before).toEqual({ intakePromptEnabled: false, serviceItemsEnabled: false, visaPassportTasksEnabled: false, prefillAutoFill: false,
        referralDrafts: false, updatedAt: before.updatedAt });
      const on = await one<Setting>(SUPER, SETTING_SQL, ['service_items_enabled', true, REASON]);
      expect(on).toMatchObject({ key: 'service_items_enabled', changed: true, before: false, after: true });
      expect(typeof on.updatedAt).toBe('string');
      // Idempotent: the same value again changes nothing and writes no audit row.
      const again = await one<Setting>(SUPER, SETTING_SQL, ['service_items_enabled', true, REASON]);
      expect(again).toMatchObject({ changed: false, before: true, after: true });
      const prompt = await one<Setting>(SUPER, SETTING_SQL, ['intake_prompt_enabled', true, REASON]);
      expect(prompt).toMatchObject({ key: 'intake_prompt_enabled', changed: true, before: false, after: true });
      expect(await one(SUPER, SETTINGS_GET_SQL)).toMatchObject({ intakePromptEnabled: true, serviceItemsEnabled: true });
      expect(await run(PURCHASE, 'select intake_prompt_enabled, service_items_enabled from public.workflow_settings')).toEqual([
        { intake_prompt_enabled: true, service_items_enabled: true },
      ]);

      const audit = await owner<{ actor_user_id: string; reason: string; legal_entity_id: string | null; details: Record<string, unknown> }>(
        `select actor_user_id, reason, legal_entity_id, details from public.audit_events where action = 'settings.workflow_changed' order by id`,
      );
      expect(audit).toHaveLength(2);
      expect(audit[0]).toMatchObject({
        actor_user_id: U.adminJodhpur, reason: REASON, legal_entity_id: null,
        details: { operation: 'update', via: 'command', command: 'admin_set_workflow_setting', reasonGiven: true,
          changes: { service_items_enabled: { from: false, to: true } } },
      });
      expect(audit[1]!.details).toMatchObject({ changes: { intake_prompt_enabled: { from: false, to: true } } });
      // A Super Admin reads the company-less workflow rows; Sales does not.
      expect(await run(SUPER, `select action from public.audit_events where action = 'settings.workflow_changed'`)).toHaveLength(2);
      expect(await run(OWNER, `select action from public.audit_events where action = 'settings.workflow_changed'`)).toEqual([]);
      // Switching off again.
      const off = await one<Setting>(SUPER, SETTING_SQL, ['service_items_enabled', false, 'Synthetic: switching back off']);
      expect(off).toMatchObject({ changed: true, before: true, after: false });
    });
  });

  it('refuses a short reason, an unknown key, a null value, non-admins, aal1 and direct writes', async () => {
    await asOwner(db, async () => {
      await refused(SUPER, SETTING_SQL, ['service_items_enabled', true, 'too short'], '22023');
      await refused(SUPER, SETTING_SQL, ['service_items_enabled', true, 'x'.repeat(501)], '22023');
      await refused(SUPER, SETTING_SQL, ['service_items_enabled', true, null], '22023');
      await refused(SUPER, SETTING_SQL, ['real_booking_enabled', true, REASON], '22023', 'invalid_input');
      await refused(SUPER, SETTING_SQL, ['service_items_enabled', null, REASON], '22023', 'invalid_input');
      for (const actor of [OWNER, MANAGER, PURCHASE, ACCOUNTS, { userId: U.adminJodhpur, aal: 'aal1' as const }]) {
        await refused(actor, SETTING_SQL, ['service_items_enabled', true, REASON], '42501', 'not_authorized');
      }
      // No execute grant at all for anon and the secret-key server role.
      await refused(ANON, SETTING_SQL, ['service_items_enabled', true, REASON], '42501');
      await refused(SVC, SETTING_SQL, ['service_items_enabled', true, REASON], '42501');
      await refused(SUPER, 'update public.workflow_settings set service_items_enabled = true where id', [], '42501');
      await refused(SVC, 'update public.workflow_settings set service_items_enabled = true where id', [], '42501');
      await refused(SVC, 'delete from public.workflow_settings', [], '42501');
      expect(await owner('select service_items_enabled, intake_prompt_enabled from public.workflow_settings')).toEqual([
        { service_items_enabled: false, intake_prompt_enabled: false },
      ]);
      expect(await owner(`select 1 from public.audit_events where action = 'settings.workflow_changed'`)).toEqual([]);
      await refused(ANON, SETTINGS_GET_SQL, [], '42501');
      await refused({ userId: U.salesDelhiA, aal: 'aal1' }, SETTINGS_GET_SQL, [], '42501');
    });
  });

  it('owner SQL is audited too (direct_sql, no reason unless named) and updated_at moves; TRUNCATE is refused', async () => {
    await asOwner(db, async () => {
      const [t0] = await owner<{ updated_at: string }>('select updated_at from public.workflow_settings');
      await owner(`select set_config('tripnavigate.change_reason', 'Synthetic owner approval for the test', true)`);
      await owner(`update public.workflow_settings set intake_prompt_enabled = true where id`);
      const [t1] = await owner<{ updated_at: string }>('select updated_at from public.workflow_settings');
      expect(t1!.updated_at >= t0!.updated_at).toBe(true);
      const audit = await owner<{ reason: string | null; details: Record<string, unknown> }>(
        `select reason, details from public.audit_events where action = 'settings.workflow_changed' order by id`,
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.reason).toBe('Synthetic owner approval for the test');
      expect(audit[0]!.details).toMatchObject({ via: 'direct_sql', command: null, changes: { intake_prompt_enabled: { from: false, to: true } } });
      await h.refused(SVC, 'truncate public.workflow_settings', [], '42501');
      await expect(owner('truncate public.workflow_settings')).rejects.toMatchObject({ code: '42501' });
    });
  });
});
