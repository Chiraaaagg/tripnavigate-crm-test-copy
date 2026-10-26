import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACCOUNTS, ANON, DEAL, HOTEL, MANAGER, OWNER, PURCHASE, PURCHASE_CLAIM_SQL, SUPER } from './b1-support';
import { APP_UPDATE_SQL, COST_SAVE_SQL, COST_SUBMIT_SQL, DESK, EXPENSE_RETURN_SQL, SETTING_SQL_B11, SWITCH_REASON, VISA, VISA_CLAIM_SQL, VISA_GET_SQL, b11Helpers, rid } from './b11-support';

/**
 * Direction A Batch 4 (migration 20261125000100): Settings backend.
 *   - settings_switch_states(): state + who/when/how/why per switch; Unknown never Off; sections by role
 *   - workflow_visa_task_preview(): exact count of Visa desk tasks switching on would create
 *   - integration_preview_sync_settings / integration_apply_sync_settings: M1, enforced in the database
 *   - department_task_history(): only that task's events, only for the task page's readers, no money
 *
 * Every scenario runs in one rolled-back transaction (asOwner). Synthetic data only.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one, refused, owner } = h;

const SUPER_AAL1: Actor = { userId: U.adminJodhpur, aal: 'aal1' };
const REASON = 'Owner approval APPROVE in chat (synthetic test)';
const STATES_SQL = 'select public.settings_switch_states() as r';
const VISA_PREVIEW_SQL = 'select public.workflow_visa_task_preview() as r';
const PREVIEW_SQL = 'select public.integration_preview_sync_settings($1::bigint[], $2::text[], $3::timestamptz, $4) as r';
const APPLY_SQL = 'select public.integration_apply_sync_settings($1, $2) as r';
const OLD_SQL = 'select public.integration_update_sync_settings($1::bigint[], $2::text[], $3::timestamptz, $4) as r';
const HISTORY_SQL = 'select public.department_task_history($1) as r';
const STAGES = ['C7:NEW', 'C7:PREPARATION'];
const CUTOFF = '2026-09-01T00:00:00+05:30';
const NOT_SUPER: Actor[] = [OWNER, MANAGER, PURCHASE, ACCOUNTS, DESK];

type LastChange = {
  at: string; byName: string | null; byYou: boolean; via: string; command: string | null;
  from: boolean | null; to: boolean | null; fields: string[]; reason: string | null;
} | null;
type Sw = { key: string; state: string; lastChange: LastChange };
type States = {
  workflow: { readable: boolean; canSwitch: boolean; switches: Sw[] } | null;
  bitrix: {
    readable: boolean; canSwitch: boolean; canManageSync: boolean; connectionEnabled: boolean | null;
    pilotBranchName: string | null; switches: Sw[];
    syncSettings: { autoSync: string; stageIds: string[] | null; lastScopeChange: LastChange; lastSaved: Record<string, unknown> | null };
  } | null;
  live: { realBooking: { state: string; lastChange: LastChange }; supplierConfirmation: { state: string };
          financeModes: Array<{ legalName: string; modes: Array<{ key: string; state: string }> }> } | null;
};
type Hide = { total: number; beforeSyncDate: number; pipelineNotEligible: number; stageNotEligible: number; withCrmWork: number };
type Preview = { previewId: string; changed: boolean; hide: Hide; bringBack: number; recheck: number; autoSyncChange: string;
                 proposed: { cutoffAt: string }; current: { autoSync: boolean | null } };

const states = (actor: Actor = SUPER) => one<States>(actor, STATES_SQL);
const sw = (list: Sw[], key: string) => list.find((s) => s.key === key)!;
const preview = (actor: Actor, cats: number[], stages: string[], cutoff: string, sync = false) =>
  one<Preview>(actor, PREVIEW_SQL, [cats, stages, cutoff, sync]);
const apply = (actor: Actor, previewId: string, reason: string | null = REASON) =>
  one<Record<string, unknown>>(actor, APPLY_SQL, [previewId, reason]);
const auditCount = async () => (await owner<{ n: number }>('select count(*)::int as n from public.audit_events'))[0]!.n;
const previewCount = async () => (await owner<{ n: number }>('select count(*)::int as n from public.integration_sync_previews'))[0]!.n;
const dealState = async (id: string) =>
  (await owner<{ removed_reason: string | null; hidden: boolean }>(
    'select removed_reason, removed_at is not null as hidden from public.deals where id = $1', [id]))[0]!;

async function addMembership(userId: string, branchCode: string, role: string): Promise<void> {
  await owner(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, $3, 'active' from public.branches b where b.code = $2`,
    [userId, branchCode, role],
  );
}

// ===========================================================================
// settings_switch_states
// ===========================================================================

describe('settings_switch_states: who may read it', () => {
  it('Super Admin at aal2 reads all three sections; aal1, staff, anonymous are refused', async () => {
    await asOwner(db, async () => {
      const s = await states();
      expect(s.workflow).toMatchObject({ readable: true, canSwitch: true });
      expect(s.workflow!.switches.map((x) => x.key)).toEqual(
        ['service_items_enabled', 'intake_prompt_enabled', 'visa_passport_tasks_enabled', 'prefill_auto_fill', 'referral_drafts']);
      expect(s.bitrix).toMatchObject({ readable: true, canSwitch: true, canManageSync: true, connectionEnabled: true, pilotBranchName: 'Delhi' });
      expect(s.bitrix!.switches.map((x) => x.key)).toEqual(
        // Voice-note batch (20261128000100): the trip details switch follows the earlier list.
        ['bitrix_trip_facts_read', 'lead_intake_unowned', 'bitrix_id_proof_copy', 'bitrix_name_read', 'won_only_intake',
          'bitrix_trip_details_read']);
      expect(s.bitrix!.syncSettings).toMatchObject({ stageIds: STAGES });
      expect(['on', 'off']).toContain(s.bitrix!.syncSettings.autoSync);
      expect(s.live).not.toBeNull();
      expect(s.live!.financeModes.length).toBeGreaterThan(0);
      for (const actor of [SUPER_AAL1, ...NOT_SUPER]) await refused(actor, STATES_SQL, [], '42501', 'not_authorized');
      await refused(ANON, STATES_SQL, [], '42501'); // no execute grant for anon
    });
  });

  it('a Super Admin of another company only (not the pilot company) gets no Bitrix section', async () => {
    await asOwner(db, async () => {
      // salesEntityB's company (disabled in the fixtures; enabled here): Super Admin there only.
      await owner(`update public.legal_entities set status = 'enabled' where code = 'SYNTHETIC_B'`);
      await owner(
        `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
         select $1, m.legal_entity_id, m.branch_id, 'super_admin', 'active' from public.memberships m where m.user_id = $1 limit 1`,
        [U.salesEntityB],
      );
      const s = await states({ userId: U.salesEntityB });
      expect(s.workflow).not.toBeNull();
      expect(s.bitrix).toBeNull();
      expect(s.live!.financeModes.every((f) => f.legalName !== 'Holiday Chacha Pvt LTD')).toBe(true);
    });
  });
});

describe('Echo-A fix round: Purchase holders and integration managers', () => {
  it('M1: a Purchase holder with integration.manage (Super Admin) is refused sync preview/apply and gets no Bitrix section', async () => {
    await asOwner(db, async () => {
      const p = await preview(SUPER, [7], STAGES, CUTOFF);
      await addMembership(U.purchaseJodhpur, 'JDH', 'super_admin');
      await refused(PURCHASE, PREVIEW_SQL, [[7], STAGES, CUTOFF, false], '42501', 'not_authorized');
      await refused(PURCHASE, APPLY_SQL, [p.previewId, REASON], '42501', 'not_authorized');
      const s = await states(PURCHASE);
      expect(s.bitrix).toBeNull();
      // Workflow and live rows stay as for any Super Admin (no Bitrix data in them).
      expect(s.workflow).toMatchObject({ readable: true, canSwitch: true });
      // The same with an ambiguous configuration: still no Bitrix section.
      await owner(
        `insert into public.integration_intake_config (id, portal_domain, portal_member_id, category_id, eligible_stage_ids, cutoff_at,
           pilot_legal_entity_id, pilot_branch_id, enabled)
         select gen_random_uuid(), 'second-portal.example.test', 'SYNTHETIC_MEMBER_0002', category_id, eligible_stage_ids, cutoff_at,
           pilot_legal_entity_id, pilot_branch_id, false from public.integration_intake_config`,
      );
      expect((await states(PURCHASE)).bitrix).toBeNull();
    });
  });

  it('M1: an integration manager who also holds Purchase (any company) is refused the same way', async () => {
    await asOwner(db, async () => {
      await owner(`insert into public.role_permissions (role_code, permission_code, scope, policy_status, note)
                   values ('manager', 'integration.manage', 'entity', 'proposed', 'test only')`);
      await addMembership(U.managerDelhi, 'JDH', 'purchase');
      await refused(MANAGER, PREVIEW_SQL, [[7], STAGES, CUTOFF, false], '42501', 'not_authorized');
      await refused(MANAGER, STATES_SQL, [], '42501', 'not_authorized');
    });
  });

  it('L9: an integration manager who is not a Super Admin reads workflow switch states read-only (no change right) and the Bitrix section', async () => {
    await asOwner(db, async () => {
      await owner(`insert into public.role_permissions (role_code, permission_code, scope, policy_status, note)
                   values ('manager', 'integration.manage', 'entity', 'proposed', 'test only')`);
      await one(SUPER, SETTING_SQL_B11, ['intake_prompt_enabled', true, REASON]);
      const s = await states(MANAGER);
      expect(s.workflow).toMatchObject({ readable: true, canSwitch: false });
      expect(sw(s.workflow!.switches, 'intake_prompt_enabled')).toMatchObject({ state: 'on', lastChange: { to: true, byYou: false } });
      expect(s.bitrix).toMatchObject({ readable: true, canSwitch: false, canManageSync: true });
      expect(s.live).toBeNull();
      // and may preview / apply sync settings (integration.manage, no Purchase)
      const p = await preview(MANAGER, [7], STAGES, CUTOFF);
      expect(await apply(MANAGER, p.previewId)).toMatchObject({ previewId: p.previewId });
      // but not switch workflow switches
      await refused(MANAGER, SETTING_SQL_B11, ['intake_prompt_enabled', false, REASON], '42501', 'not_authorized');
    });
  });
});

describe('settings_switch_states: last changed by, when, how and why', () => {
  it('per switch from the audit rows: command with person and reason, owner SQL without a person; others untouched', async () => {
    await asOwner(db, async () => {
      const before = await states();
      await one(SUPER, SETTING_SQL_B11, ['intake_prompt_enabled', true, REASON]);
      await owner(`select set_config('tripnavigate.change_reason', 'Owner SQL with approval text', true)`);
      await owner('update public.workflow_settings set referral_drafts = true where id');
      const after = await states();
      expect(sw(after.workflow!.switches, 'intake_prompt_enabled')).toMatchObject({
        state: 'on',
        lastChange: { byName: 'Synthetic Admin Jodhpur', byYou: true, via: 'command', command: 'admin_set_workflow_setting',
                      from: false, to: true, fields: ['intake_prompt_enabled'], reason: REASON },
      });
      expect(sw(after.workflow!.switches, 'referral_drafts')).toMatchObject({
        state: 'on', lastChange: { byName: null, byYou: false, via: 'direct_sql', from: false, to: true, reason: 'Owner SQL with approval text' },
      });
      for (const key of ['service_items_enabled', 'visa_passport_tasks_enabled', 'prefill_auto_fill']) {
        expect(sw(after.workflow!.switches, key)).toEqual(sw(before.workflow!.switches, key));
      }
      // Another Super Admin sees the same row, not as "you".
      await addMembership(U.managerAhmedabad, 'JDH', 'super_admin');
      expect(sw((await states({ userId: U.managerAhmedabad })).workflow!.switches, 'intake_prompt_enabled').lastChange)
        .toMatchObject({ byName: 'Synthetic Admin Jodhpur', byYou: false });
    });
  });

  it('Bitrix switches, Won-only intake and the live switches carry their own last change', async () => {
    await asOwner(db, async () => {
      await one(SUPER, 'select public.integration_set_bitrix_read_switches($1, $2, $3) as r', [true, null, REASON]);
      await one(SUPER, 'select public.integration_set_deal_entry_stages($1::text[], $2) as r', [['C7:NEW'], REASON]);
      await one(SUPER, 'select public.admin_set_booking_live($1, $2) as r', [true, REASON]);
      const s = await states();
      expect(sw(s.bitrix!.switches, 'bitrix_trip_facts_read')).toMatchObject({
        state: 'on', lastChange: { via: 'command', command: 'integration_set_bitrix_read_switches', from: false, to: true, reason: REASON } });
      expect(sw(s.bitrix!.switches, 'lead_intake_unowned').lastChange?.fields ?? []).not.toContain('bitrix_trip_facts_read');
      expect(sw(s.bitrix!.switches, 'won_only_intake')).toMatchObject({
        state: 'on', lastChange: { command: 'integration_set_deal_entry_stages', from: false, to: true, fields: ['deal_entry_stage_ids'] } });
      expect(s.live!.realBooking).toMatchObject({ state: 'on', lastChange: { to: true, reason: REASON, byYou: true } });
    });
  });

  it('Unknown, never Off: a missing workflow row or an ambiguous Bitrix configuration', async () => {
    await asOwner(db, async () => {
      await owner('delete from public.workflow_settings');
      await owner(
        `insert into public.integration_intake_config (id, portal_domain, portal_member_id, category_id, eligible_stage_ids, cutoff_at,
           pilot_legal_entity_id, pilot_branch_id, enabled)
         select gen_random_uuid(), 'second-portal.example.test', 'SYNTHETIC_MEMBER_0002', category_id, eligible_stage_ids, cutoff_at,
           pilot_legal_entity_id, pilot_branch_id, false from public.integration_intake_config`,
      );
      const s = await states();
      expect(s.workflow!.readable).toBe(false);
      expect(s.workflow!.switches.map((x) => x.state)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
      expect(s.bitrix).toMatchObject({ readable: false, canSwitch: false, canManageSync: false, connectionEnabled: null });
      expect(s.bitrix!.switches.every((x) => x.state === 'unknown' && x.lastChange === null)).toBe(true);
      expect(s.bitrix!.syncSettings.autoSync).toBe('unknown');
      expect(JSON.stringify(s.workflow)).not.toMatch(/"off"/);
    });
  });

  it('reads write nothing', async () => {
    await asOwner(db, async () => {
      const [a, p] = [await auditCount(), await previewCount()];
      await states();
      await one(SUPER, VISA_PREVIEW_SQL);
      expect([await auditCount(), await previewCount()]).toEqual([a, p]);
    });
  });
});

// ===========================================================================
// workflow_visa_task_preview
// ===========================================================================

describe('workflow_visa_task_preview', () => {
  it('Super Admin only; the count is exactly what switching on creates (removed Deals counted as skipped)', async () => {
    await asOwner(db, async () => {
      for (const actor of [SUPER_AAL1, ...NOT_SUPER]) await refused(actor, VISA_PREVIEW_SQL, [], '42501', 'not_authorized');
      await refused(ANON, VISA_PREVIEW_SQL, [], '42501');
      expect(await one(SUPER, VISA_PREVIEW_SQL)).toEqual({ switchState: 'off', wouldCreate: 0, skipped: 0, deals: 0 });
      const ready = await h.readyDraft(OWNER, DEAL, [['hotel', HOTEL], ['visa', VISA]], { identities: true });
      await h.confirm(OWNER, ready.versionId, ready.hash);
      const removedDeal = await h.insertRealDeal('UC_AD0SLH');
      const ready2 = await h.readyDraft(OWNER, removedDeal, [['visa', VISA]], { identities: true });
      await h.confirm(OWNER, ready2.versionId, ready2.hash);
      await owner(`update public.deals set removed_at = now(), removed_reason = 'outside_entry_stage' where id = $1`, [removedDeal]);
      const shown = await one<{ wouldCreate: number; skipped: number; deals: number }>(SUPER, VISA_PREVIEW_SQL);
      expect(shown).toEqual({ switchState: 'off', wouldCreate: 1, skipped: 1, deals: 1 });
      const on = await one<{ tasksCreated: number; skipped: number }>(SUPER, SETTING_SQL_B11, ['visa_passport_tasks_enabled', true, SWITCH_REASON]);
      expect({ created: on.tasksCreated, skipped: on.skipped }).toEqual({ created: shown.wouldCreate, skipped: shown.skipped });
      expect(await one(SUPER, VISA_PREVIEW_SQL)).toEqual({ switchState: 'on', wouldCreate: 0, skipped: 1, deals: 0 });
    });
  });
});

// ===========================================================================
// Sync settings: preview -> apply (M1)
// ===========================================================================

describe('sync settings: preview and apply', () => {
  it('role matrix: only the integration administrator at aal2; the old one-step command refuses preview_required', async () => {
    await asOwner(db, async () => {
      const p = await preview(SUPER, [7], STAGES, CUTOFF);
      for (const actor of [SUPER_AAL1, ...NOT_SUPER]) {
        await refused(actor, PREVIEW_SQL, [[7], STAGES, CUTOFF, false], '42501', 'not_authorized');
        await refused(actor, APPLY_SQL, [p.previewId, REASON], '42501', 'not_authorized');
        await refused(actor, OLD_SQL, [[7], STAGES, CUTOFF, false], '42501');
      }
      for (const sql of [PREVIEW_SQL, OLD_SQL]) await refused(ANON, sql, [[7], STAGES, CUTOFF, false], '42501');
      await refused(ANON, APPLY_SQL, [p.previewId, REASON], '42501');
      await refused(SUPER, OLD_SQL, [[7], STAGES, CUTOFF, false], '55000', 'preview_required');
      // Validation is the same as the old command's.
      await refused(SUPER, PREVIEW_SQL, [[], STAGES, CUTOFF, false], '22023', 'choose at least one pipeline');
      await refused(SUPER, PREVIEW_SQL, [[7], STAGES, '2999-01-01T00:00:00Z', false], '22023', 'the start date must be in the past');
    });
  });

  it('counts are exact; apply hides and brings back exactly those Deals; Deals with CRM work are hidden, kept and come back', async () => {
    await asOwner(db, async () => {
      // Normalise the fixture's sync date first (it is not an IST midnight).
      await apply(SUPER, (await preview(SUPER, [7], STAGES, CUTOFF)).previewId);
      const a = await h.insertRealDeal('C7:NEW', 7, 990101);
      const b = await h.insertRealDeal('C7:PREPARATION', 7, 990102);
      const c = await h.insertRealDeal('C7:PREPARATION', 7, 990103);
      const d = await h.insertRealDeal('C9:NEW', 9, 990104);
      // b carries CRM work (a booking draft).
      await h.setSwitch('service_items_enabled', true);
      await h.openDraft(OWNER, b);
      const crmWorkBefore = (await owner<{ n: number }>('select count(*)::int as n from public.booking_versions where deal_id = $1', [b]))[0]!.n;
      expect(crmWorkBefore).toBe(1);

      const auditBefore = await auditCount();
      const p = await preview(SUPER, [7], ['C7:NEW'], CUTOFF);
      expect(p).toMatchObject({
        changed: true,
        hide: { total: 3, beforeSyncDate: 0, pipelineNotEligible: 1, stageNotEligible: 2, withCrmWork: 1 },
        bringBack: 0, autoSyncChange: 'none',
      });
      // The preview changed nothing and wrote no audit row.
      expect(await auditCount()).toBe(auditBefore);
      expect([await dealState(b), await dealState(c), await dealState(d)].every((x) => !x.hidden)).toBe(true);

      const r = await apply(SUPER, p.previewId);
      expect(r).toMatchObject({ removed: 3, restored: 0, previewId: p.previewId, broughtBack: 0, hidden: p.hide });
      expect(await dealState(a)).toMatchObject({ hidden: false });
      expect(await dealState(b)).toMatchObject({ hidden: true, removed_reason: 'stage_not_eligible' });
      expect(await dealState(c)).toMatchObject({ hidden: true, removed_reason: 'stage_not_eligible' });
      expect(await dealState(d)).toMatchObject({ hidden: true, removed_reason: 'pipeline_not_eligible' });

      // Widening brings back exactly what the preview says; the booking draft is still there.
      const back = await preview(SUPER, [7, 9], ['C7:NEW', 'C7:PREPARATION', 'C9:NEW'], CUTOFF);
      expect(back).toMatchObject({ hide: { total: 0, withCrmWork: 0 }, bringBack: 3 });
      expect(await apply(SUPER, back.previewId)).toMatchObject({ removed: 0, restored: 3, broughtBack: 3 });
      for (const id of [b, c, d]) expect(await dealState(id)).toMatchObject({ hidden: false, removed_reason: null });
      expect((await owner<{ n: number }>('select count(*)::int as n from public.booking_versions where deal_id = $1', [b]))[0]!.n).toBe(1);

      // A later date hides by date (the inserted Deals were created 3 days ago).
      const later = new Date(Date.now() - 86_400_000).toISOString();
      const p3 = await preview(SUPER, [7, 9], ['C7:NEW', 'C7:PREPARATION', 'C9:NEW'], later);
      expect(p3.hide).toEqual({ total: 4, beforeSyncDate: 4, pipelineNotEligible: 0, stageNotEligible: 0, withCrmWork: 1 });
    });
  });

  it('reason 10-500 characters is required; nothing changes on a refusal; a refusal leaves the preview usable', async () => {
    await asOwner(db, async () => {
      const p = await preview(SUPER, [7], ['C7:NEW'], CUTOFF);
      const cfg = async () => (await owner('select eligible_stage_ids, cutoff_at from public.integration_intake_config'))[0];
      const before = await cfg();
      for (const bad of [null, '', '   \t\n  ', 'too short', 'x'.repeat(501)]) {
        await refused(SUPER, APPLY_SQL, [p.previewId, bad], '22023', 'a reason of 10 to 500 characters is required');
      }
      expect(await cfg()).toEqual(before);
      expect(await apply(SUPER, p.previewId, `  ${'y'.repeat(10)}  `)).toMatchObject({ previewId: p.previewId });
    });
  });

  it('apply refuses without a matching fresh preview: unknown, another person’s, used, expired, settings changed, counts changed', async () => {
    await asOwner(db, async () => {
      await apply(SUPER, (await preview(SUPER, [7], STAGES, CUTOFF)).previewId);
      await refused(SUPER, APPLY_SQL, [crypto.randomUUID(), REASON], '55000', 'preview_required');
      await refused(SUPER, APPLY_SQL, [null, REASON], '55000', 'preview_required');

      // Another integration administrator cannot use my preview.
      await addMembership(U.managerAhmedabad, 'JDH', 'super_admin');
      const mine = await preview(SUPER, [7], STAGES, CUTOFF, true);
      await refused({ userId: U.managerAhmedabad }, APPLY_SQL, [mine.previewId, REASON], '55000', 'preview_required');

      // Used once only.
      await apply(SUPER, mine.previewId);
      await refused(SUPER, APPLY_SQL, [mine.previewId, REASON], '55000', 'preview_used');

      // Expired (older than 10 minutes).
      const old = await preview(SUPER, [7], ['C7:NEW'], CUTOFF, true);
      await owner(`update public.integration_sync_previews set created_at = now() - interval '20 minutes',
                   expires_at = now() - interval '10 minutes' where id = $1`, [old.previewId]);
      await refused(SUPER, APPLY_SQL, [old.previewId, REASON], '40001', 'preview_stale');

      // Settings changed since the preview (here: automatic updates switched by another path).
      const p2 = await preview(SUPER, [7], ['C7:NEW'], CUTOFF, true);
      await owner('update public.integration_sync_schedule set enabled = not enabled where id');
      await refused(SUPER, APPLY_SQL, [p2.previewId, REASON], '40001', 'preview_stale');
      await owner('update public.integration_sync_schedule set enabled = not enabled where id');

      // Counts changed: a new Deal arrives in the stage being unticked.
      const p3 = await preview(SUPER, [7], ['C7:NEW'], CUTOFF, true);
      expect(p3.hide.total).toBe(0);
      const newcomer = await h.insertRealDeal('C7:PREPARATION', 7, 990201);
      await refused(SUPER, APPLY_SQL, [p3.previewId, REASON], '40001', 'preview_stale');
      expect(await dealState(newcomer)).toMatchObject({ hidden: false });
      expect((await owner<{ s: string[] }>('select eligible_stage_ids as s from public.integration_intake_config'))[0]!.s).toEqual(STAGES);

      // A fresh preview then applies and hides it.
      const p4 = await preview(SUPER, [7], ['C7:NEW'], CUTOFF, true);
      expect(p4.hide.total).toBe(1);
      expect(await apply(SUPER, p4.previewId)).toMatchObject({ removed: 1 });
    });
  });

  it('Echo L1: an equal-size swap (one Deal leaves the set, another enters) is refused counts_changed; nothing changes', async () => {
    await asOwner(db, async () => {
      await apply(SUPER, (await preview(SUPER, [7], STAGES, CUTOFF)).previewId);
      const x = await h.insertRealDeal('C7:PREPARATION', 7, 990401);
      const y = await h.insertRealDeal('C7:NEW', 7, 990402);
      const p = await preview(SUPER, [7], ['C7:NEW'], CUTOFF, true);
      expect(p.hide.total).toBe(1);
      // x leaves the unticked stage, y enters it: same counts, different Deals.
      await owner(`update public.deals set source_stage_id = 'C7:NEW' where id = $1`, [x]);
      await owner(`update public.deals set source_stage_id = 'C7:PREPARATION' where id = $1`, [y]);
      await refused(SUPER, APPLY_SQL, [p.previewId, REASON], '40001', 'preview_stale');
      expect(await dealState(x)).toMatchObject({ hidden: false });
      expect(await dealState(y)).toMatchObject({ hidden: false });
      const again = await preview(SUPER, [7], ['C7:NEW'], CUTOFF, true);
      expect(await apply(SUPER, again.previewId)).toMatchObject({ removed: 1 });
      expect(await dealState(y)).toMatchObject({ hidden: true });
      expect(await dealState(x)).toMatchObject({ hidden: false });
    });
  });

  it('Echo L8: deleting the configuration removes its previews (on delete cascade)', async () => {
    const [fk] = await db.query<{ action: string }>(
      `select confdeltype::text as action from pg_constraint
       where conrelid = 'public.integration_sync_previews'::regclass and contype = 'f'
         and confrelid = 'public.integration_intake_config'::regclass`);
    expect(fk!.action).toBe('c');
  });

  it('the stale hints say why', async () => {
    await asOwner(db, async () => {
      const hintOf = async (previewId: string) => {
        await db.exec('savepoint b4_hint');
        try {
          await h.run(SUPER, APPLY_SQL, [previewId, REASON]);
          return 'applied';
        } catch (e) {
          return (e as { hint?: string }).hint ?? null;
        } finally {
          await db.exec('rollback to savepoint b4_hint');
        }
      };
      const p = await preview(SUPER, [7], ['C7:NEW'], CUTOFF, true);
      await owner(`update public.integration_sync_previews set created_at = now() - interval '20 minutes', expires_at = now() - interval '1 minute' where id = $1`, [p.previewId]);
      expect(await hintOf(p.previewId)).toBe('expired');
      const p2 = await preview(SUPER, [7], ['C7:NEW'], CUTOFF, true);
      await owner(`update public.integration_intake_config set cutoff_at = cutoff_at - interval '1 day'`);
      expect(await hintOf(p2.previewId)).toBe('settings_changed');
      const p3 = await preview(SUPER, [7], ['C7:NEW'], CUTOFF, true);
      await h.insertRealDeal('C7:PREPARATION', 7, 990301);
      expect(await hintOf(p3.previewId)).toBe('counts_changed');
    });
  });

  it('audit: the settings row and integration.settings_updated carry the person, the reason and the preview', async () => {
    await asOwner(db, async () => {
      const p = await preview(SUPER, [7], ['C7:NEW'], CUTOFF, true);
      await apply(SUPER, p.previewId);
      const rows = await owner<{ action: string; actor_user_id: string; reason: string; details: Record<string, unknown> }>(
        `select action, actor_user_id, reason, details from public.audit_events
         where action in ('settings.intake_config_changed', 'integration.settings_updated') order by id desc limit 2`);
      const saved = rows.find((r) => r.action === 'integration.settings_updated')!;
      expect(saved).toMatchObject({ actor_user_id: U.adminJodhpur, reason: REASON, details: { previewId: p.previewId, hiddenByReason: p.hide } });
      expect(rows.find((r) => r.action === 'settings.intake_config_changed')).toMatchObject({
        reason: REASON, details: { via: 'command', command: 'integration_apply_sync_settings' } });
      // The Settings read shows it.
      const s = await states();
      expect(s.bitrix!.syncSettings.lastSaved).toMatchObject({ byYou: true, reason: REASON, autoSync: true, hidden: 0 });
      expect(s.bitrix!.syncSettings.lastScopeChange).toMatchObject({ via: 'command', reason: REASON });
    });
  });

  it('privileges: the preview table is closed to every API role; the new functions run for authenticated only', async () => {
    const t = await db.query<{ r: string; any: boolean }>(
      `select r, has_table_privilege(r, 'public.integration_sync_previews', 'select,insert,update,delete') as any
       from unnest(array['anon', 'authenticated', 'service_role']) r`);
    expect(t.filter((x) => x.any)).toEqual([]);
    const f = await db.query<{ name: string; anon: boolean; auth: boolean; svc: boolean; secdef: boolean; config: string[] }>(
      `select p.oid::regprocedure::text as name, has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc, p.prosecdef as secdef, p.proconfig as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('settings_switch_states', 'workflow_visa_task_preview',
         'integration_preview_sync_settings', 'integration_apply_sync_settings', 'department_task_history')
       order by 1`);
    expect(f).toHaveLength(5);
    expect(f.every((x) => x.auth && !x.anon && !x.svc && x.secdef && x.config[0] === 'search_path=""')).toBe(true);
    const helpers = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'authz' and p.proname in ('settings_last_change', 'switch_state', 'visa_desk_launch_items',
         'sync_settings_manager', 'sync_settings_validate', 'sync_scope_snapshot', 'sync_scope_plan', 'sync_scope_counts',
         'sync_scope_changed', 'can_read_task_history')
         and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')
              or has_function_privilege('service_role', p.oid, 'execute'))`);
    expect(helpers[0]!.n).toBe(0);
  });
});

// ===========================================================================
// department_task_history
// ===========================================================================

type History = { taskId: string; department: string; truncated: boolean;
  events: Array<{ kind: string; byName: string | null; byYou: boolean; toName: string | null; toYou: boolean;
                  applicantSeq: number | null; state: string | null; note: string | null }> };
const EVENT_KEYS = ['applicantSeq', 'at', 'byName', 'byYou', 'kind', 'note', 'state', 'toName', 'toYou'];

describe('department_task_history', () => {
  it('Purchase task: Purchase and the branch Manager read it; names only for the assignee; others get null', async () => {
    await asOwner(db, async () => {
      const { hotelTaskId, taskId: visaTaskId } = await h.deskTask();
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [hotelTaskId]);
      const forPurchase = await one<History>(PURCHASE, HISTORY_SQL, [hotelTaskId]);
      expect(forPurchase).toMatchObject({ taskId: hotelTaskId, department: 'purchase', truncated: false });
      expect(forPurchase.events.map((e) => e.kind)).toEqual(['taken', 'created']);
      expect(forPurchase.events[0]).toMatchObject({ kind: 'taken', byYou: true, byName: 'Synthetic Purchase Jodhpur' });
      // Created by Sales: Sales is not shown on the task page, so no name.
      expect(forPurchase.events[1]).toMatchObject({ kind: 'created', byYou: false, byName: null });
      const forManager = await one<History>(MANAGER, HISTORY_SQL, [hotelTaskId]);
      expect(forManager.events[0]).toMatchObject({ kind: 'taken', byYou: false, byName: 'Synthetic Purchase Jodhpur' });
      for (const e of forManager.events) expect(Object.keys(e).sort()).toEqual(EVENT_KEYS);
      // Not the task page's readers: Sales, Accounts, Super Admin, the Visa/Flight desk.
      for (const actor of [OWNER, ACCOUNTS, SUPER, DESK]) expect(await one(actor, HISTORY_SQL, [hotelTaskId])).toBeNull();
      // Only that task's events.
      expect(JSON.stringify(forPurchase)).not.toContain(visaTaskId);
      await refused(ANON, HISTORY_SQL, [hotelTaskId], '42501');
      expect(await one(PURCHASE, HISTORY_SQL, [crypto.randomUUID()])).toBeNull();
    });
  });

  it('Visa task: the desk only; applicant and cost events without any amount; Purchase never reads it', async () => {
    await asOwner(db, async () => {
      const { taskId } = await h.deskTask();
      await one(DESK, VISA_CLAIM_SQL, [taskId]);
      const task = await one<{ applicants: Array<{ applicationId: string; rowVersion: number }> }>(DESK, VISA_GET_SQL, [taskId]);
      const app = task.applicants[0]!;
      await one(DESK, APP_UPDATE_SQL, [app.applicationId, app.rowVersion, JSON.stringify({ documents: { passport_copy: 'checked', photo: 'received' } })]);
      await one(DESK, COST_SAVE_SQL, [taskId, null, 0,
        JSON.stringify({ costKind: 'government_fee', amountPaise: '650000', paidBy: 'customer_direct', paymentMode: 'upi',
          paidOn: '2026-10-10', reference: 'GOV-SYN-1' }), rid()]);
      const auditBefore = await auditCount();
      const hist = await one<History>(DESK, HISTORY_SQL, [taskId]);
      expect(await auditCount()).toBe(auditBefore);
      expect(hist.department).toBe('visa');
      expect(hist.events.map((e) => e.kind)).toEqual(['cost_recorded', 'applicant_updated', 'taken', 'created']);
      expect(hist.events.find((e) => e.kind === 'applicant_updated')).toMatchObject({ applicantSeq: expect.any(Number), byYou: true });
      const text = JSON.stringify(hist);
      expect(text).not.toMatch(/650000|6500|amount|paise|selling|margin|budget/i);
      for (const actor of [PURCHASE, MANAGER, OWNER, ACCOUNTS, SUPER]) expect(await one(actor, HISTORY_SQL, [taskId])).toBeNull();
    });
  });
  it('Accounts returning a company-paid fee shows on the desk task with its reason; the file and the submission too; no amount', async () => {
    await asOwner(db, async () => {
      const { taskId } = await h.deskTask();
      await one(DESK, VISA_CLAIM_SQL, [taskId]);
      const receipt = await h.deskEvidence(DESK, taskId, 'fee_receipt');
      const saved = await one<{ entryId: string; rowVersion: number }>(DESK, COST_SAVE_SQL, [taskId, null, 0,
        JSON.stringify({ costKind: 'government_fee', amountPaise: '650000', paidBy: 'company', paymentMode: 'upi', paidOn: '2026-10-10',
                         receiptEvidenceId: receipt }), rid()]);
      const sub = await one<{ rowVersion: number }>(DESK, COST_SUBMIT_SQL, [saved.entryId, saved.rowVersion]);
      const why = 'Synthetic: the receipt is not readable';
      await one(ACCOUNTS, EXPENSE_RETURN_SQL, [saved.entryId, sub.rowVersion, why, rid()]);
      const hist = await one<History>(DESK, HISTORY_SQL, [taskId]);
      expect(hist.events.map((e) => e.kind)).toEqual(['accounts_returned', 'sent_to_accounts', 'cost_recorded', 'file_added', 'taken', 'created']);
      // Accounts is not shown on the task page: no name, but the reason.
      expect(hist.events[0]).toMatchObject({ kind: 'accounts_returned', byName: null, byYou: false, note: why });
      expect(hist.events.filter((e) => e.kind !== 'accounts_returned').every((e) => e.note === null)).toBe(true);
      expect(JSON.stringify(hist)).not.toMatch(/650000|amount|paise|upi/i);
    });
  });

  // Batch 5 carried N3 (money-privacy-settings.md section 11.1, T-B4-05 amended): the department-cost
  // return reason may show to the task page's readers; the Accounts booking review return reason never does.
  it('task History never returns a booking review return reason; the department-cost return reason stays', async () => {
    await asOwner(db, async () => {
      const { versionId, hotelTaskId, taskId } = await h.deskTask();
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [hotelTaskId]);
      await one(DESK, VISA_CLAIM_SQL, [taskId]);
      const receipt = await h.deskEvidence(DESK, taskId, 'fee_receipt');
      const saved = await one<{ entryId: string; rowVersion: number }>(DESK, COST_SAVE_SQL, [taskId, null, 0,
        JSON.stringify({ costKind: 'government_fee', amountPaise: '650000', paidBy: 'company', paymentMode: 'upi', paidOn: '2026-10-10',
                         receiptEvidenceId: receipt }), rid()]);
      const sub = await one<{ rowVersion: number }>(DESK, COST_SUBMIT_SQL, [saved.entryId, saved.rowVersion]);
      const costReason = 'Synthetic N3: the fee receipt is blurred';
      await one(ACCOUNTS, EXPENSE_RETURN_SQL, [saved.entryId, sub.rowVersion, costReason, rid()]);
      // Accounts returns the whole booking with its own review reason.
      const bookingReason = 'Synthetic N3 booking review: the check-out date is wrong';
      await one(ACCOUNTS, 'select public.accounts_review_return($1, $2, $3) as r', [versionId, bookingReason, rid()]);
      const [stored] = await owner<{ n: number }>(
        `select count(*)::int as n from public.accounts_booking_reviews where booking_version_id = $1 and status = 'returned' and return_reason = $2`,
        [versionId, bookingReason]);
      expect(stored!.n).toBeGreaterThan(0); // the reason exists in the database...
      const reads: Array<[Actor, string]> = [[PURCHASE, hotelTaskId], [MANAGER, hotelTaskId], [DESK, taskId]];
      for (const [actor, id] of reads) {
        const hist = await one<History>(actor, HISTORY_SQL, [id]);
        expect(hist).not.toBeNull();
        const text = JSON.stringify(hist);
        expect(text).not.toContain('Synthetic N3 booking review'); // ...but never in any task History
        expect(text).not.toMatch(/check-out date/i);
      }
      // The department-cost return reason is still shown on the desk task (allowed, DA-281).
      const desk = await one<History>(DESK, HISTORY_SQL, [taskId]);
      expect(desk.events.filter((e) => e.kind === 'accounts_returned').map((e) => e.note)).toEqual([costReason]);
      // The Purchase task never carries an accounts_returned event from the booking review.
      const purchase = await one<History>(PURCHASE, HISTORY_SQL, [hotelTaskId]);
      expect(purchase.events.some((e) => e.kind === 'accounts_returned')).toBe(false);
      expect(purchase.events.every((e) => e.note === null)).toBe(true);
    });
  });
});
