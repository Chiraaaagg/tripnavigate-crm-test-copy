import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_REASON_GIVEN, reasonOrDefault } from '@/modules/settings/reason';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { SETTING_SQL, SUPER, b1Helpers } from './b1-support';

/**
 * UX redesign R1, owner answers D9 and Q1: an empty Settings reason is sent
 * to the database as "No reason given" (modules/settings/reason.ts, used by
 * the server actions). No migration: the database still requires 10 to 500
 * characters (authz.settings_change_reason). This proves the words pass that
 * rule and that the audit row still names the person, the change and the
 * time, with "No reason given" as the reason. Synthetic fixture users only.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b1Helpers(() => db);
const { one, refused, owner } = h;

type Audit = { actor_user_id: string; reason: string; occurred_at: string; details: Record<string, unknown> };

describe('"No reason given" for an empty optional reason', () => {
  it('the helper turns an empty or blank reason into the words, which the database accepts', () => {
    expect(reasonOrDefault('', 'optional')).toBe(NO_REASON_GIVEN);
    expect(reasonOrDefault('  \n\t ', 'optional')).toBe(NO_REASON_GIVEN);
    expect(NO_REASON_GIVEN.length).toBeGreaterThanOrEqual(10);
  });

  it('a Features switch: the audit row has the person, the change, the time and "No reason given"', async () => {
    await asOwner(db, async () => {
      const r = await one<{ changed: boolean; after: boolean }>(SUPER, SETTING_SQL, ['referral_drafts', true, reasonOrDefault('', 'optional')]);
      expect(r).toMatchObject({ changed: true, after: true });
      const audit = await owner<Audit>(
        `select actor_user_id, reason, occurred_at::text as occurred_at, details from public.audit_events where action = 'settings.workflow_changed' order by id desc limit 1`,
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor_user_id: U.adminJodhpur,
        reason: NO_REASON_GIVEN,
        details: { via: 'command', command: 'admin_set_workflow_setting', changes: { referral_drafts: { from: false, to: true } } },
      });
      expect(Number.isNaN(Date.parse(audit[0]!.occurred_at))).toBe(false);
    });
  });

  it('the staff notices switch: the audit row is written with "No reason given"', async () => {
    await asOwner(db, async () => {
      expect(await one(SUPER, 'select public.admin_set_notices_enabled($1, $2) as r', [true, reasonOrDefault('   ', 'optional')])).toMatchObject({ changed: true, after: true });
      const audit = await owner<Audit>(
        `select actor_user_id, reason, occurred_at::text as occurred_at, details from public.audit_events where action = 'settings.notices_changed' order by id desc limit 1`,
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_user_id: U.adminJodhpur, reason: NO_REASON_GIVEN });
    });
  });

  it('the database rule is unchanged: an empty or short reason sent as typed is still refused', async () => {
    await asOwner(db, async () => {
      // A required-reason family keeps the typed text (the helper returns it unchanged), so the database refuses it.
      await refused(SUPER, SETTING_SQL, ['referral_drafts', false, reasonOrDefault('', 'required')], '22023');
      await refused(SUPER, SETTING_SQL, ['referral_drafts', false, reasonOrDefault('short', 'optional')], '22023');
      await refused(SUPER, 'select public.admin_set_notices_enabled($1, $2) as r', [false, ''], '22023');
    });
  });
});
