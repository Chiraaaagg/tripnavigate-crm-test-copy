import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SettingsReadError, settingsSwitchStates, toSettingsSwitchStates, workflowVisaTaskPreview } from '@/modules/access/settings-state';
import { departmentTaskHistory } from '@/modules/fulfilment/task-history';
import { SyncSettingsError, applySyncSettings, isSyncPreviewMissing, previewSyncSettings } from '@/modules/integration/sync-settings-preview';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { MANAGER, OWNER, PURCHASE, PURCHASE_CLAIM_SQL, SUPER } from './b1-support';
import { b11Helpers } from './b11-support';
import { rpcAs } from './b12-ts-support';

/**
 * Batch 4 TS wrappers (access/settings-state.ts, integration/sync-settings-preview.ts,
 * fulfilment/task-history.ts) against the real SQL of 20261125000100 on PGlite:
 * every reply parses through the zod allowlists, refusals map to their codes,
 * Unknown never becomes Off. Synthetic fixtures; every case rolled back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const REASON = 'Owner approval APPROVE in chat (synthetic test)';
const CUTOFF = '2026-09-01T00:00:00+05:30';

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal');
}

describe('Batch 4 wrappers', () => {
  it('settings states and the Visa preview parse; refusals map to not_authorized', async () => {
    await asOwner(db, async () => {
      const s = await settingsSwitchStates(rpcAs(() => db, SUPER));
      expect(s.workflow).not.toBe('unreadable');
      expect(s.bitrix).not.toBe('unreadable');
      expect(s.live).not.toBe('unreadable');
      expect(typeof s.workflow === 'object' && s.workflow!.switches).toHaveLength(5);
      expect(await workflowVisaTaskPreview(rpcAs(() => db, SUPER))).toEqual({ switchState: 'off', wouldCreate: 0, skipped: 0, deals: 0 });
      const e = await caught(settingsSwitchStates(rpcAs(() => db, OWNER)));
      expect(e).toBeInstanceOf(SettingsReadError);
      expect((e as SettingsReadError).code).toBe('not_authorized');
      // Missing workflow row: every state unknown, never off.
      await h.owner('delete from public.workflow_settings');
      const u = await settingsSwitchStates(rpcAs(() => db, SUPER));
      expect(typeof u.workflow === 'object' && u.workflow!.switches.map((x) => x.state)).toEqual(Array(5).fill('unknown'));
    });
  });

  it('tolerant parse: unknown values read as unknown, unknown keys are dropped, a broken section is unreadable', () => {
    const parsed = toSettingsSwitchStates({
      workflow: { readable: true, canSwitch: true, switches: [
        { key: 'service_items_enabled', state: 'maybe', lastChange: { at: 'x', bogus: 1 } },
        { key: 'future_switch', state: 'on', lastChange: null },
      ] },
      bitrix: { readable: 'yes' },
      live: null,
    });
    expect(parsed.workflow).toMatchObject({ readable: true, canSwitch: true, switches: [{ key: 'service_items_enabled', state: 'unknown' }] });
    // Unreadable parts of a last change become null, never invented.
    expect(typeof parsed.workflow === 'object' && parsed.workflow!.switches[0]!.lastChange).toMatchObject({ at: 'x', byName: null, via: null, to: null });
    expect(typeof parsed.workflow === 'object' && parsed.workflow!.switches).toHaveLength(1);
    expect(parsed.bitrix).toBe('unreadable');
    expect(parsed.live).toBeNull();
    expect(toSettingsSwitchStates('nonsense')).toEqual({ workflow: 'unreadable', bitrix: 'unreadable', live: 'unreadable' });
  });

  it('sync preview then apply; stale, used and refused map to their codes; missing function is detected', async () => {
    await asOwner(db, async () => {
      const rpc = rpcAs(() => db, SUPER);
      const input = { categoryIds: [7], stageIds: ['C7:NEW', 'C7:PREPARATION'], cutoffAt: CUTOFF, syncEnabled: false };
      const p = await previewSyncSettings(rpc, input);
      expect(p).toMatchObject({ changed: true, bringBack: 0, autoSyncChange: expect.any(String) });
      const r = await applySyncSettings(rpc, { previewId: p.previewId, reason: REASON });
      expect(r).toMatchObject({ previewId: p.previewId, removed: p.hide.total, broughtBack: 0 });
      const used = await caught(applySyncSettings(rpc, { previewId: p.previewId, reason: REASON }));
      expect(used).toMatchObject({ code: 'preview_used' });
      const short = await caught(applySyncSettings(rpc, { previewId: p.previewId, reason: 'short' }));
      expect(short).toMatchObject({ code: 'invalid_reason' });
      const p2 = await previewSyncSettings(rpc, { ...input, stageIds: ['C7:NEW'] });
      await h.owner(`update public.integration_intake_config set cutoff_at = cutoff_at - interval '1 day'`);
      expect(await caught(applySyncSettings(rpc, { previewId: p2.previewId, reason: REASON }))).toMatchObject({
        code: 'preview_stale', detail: 'settings_changed' });
      expect(await caught(previewSyncSettings(rpc, { ...input, categoryIds: [] }))).toMatchObject({ code: 'invalid_input', detail: 'categoryIds' });
      expect(await caught(previewSyncSettings(rpcAs(() => db, MANAGER), input))).toMatchObject({ code: 'not_authorized' });
      expect(isSyncPreviewMissing(new SyncSettingsError('integration_preview_sync_settings', null, 'PGRST202'))).toBe(true);
      expect(isSyncPreviewMissing(await caught(applySyncSettings(rpc, { previewId: p.previewId, reason: REASON })))).toBe(false);
    });
  });

  it('task history parses for a reader and is null for others', async () => {
    await asOwner(db, async () => {
      const { hotelTaskId } = await h.deskTask();
      await h.one(PURCHASE, PURCHASE_CLAIM_SQL, [hotelTaskId]);
      const hist = await departmentTaskHistory(rpcAs(() => db, PURCHASE), hotelTaskId);
      expect(hist).toMatchObject({ taskId: hotelTaskId, department: 'purchase', truncated: false });
      expect(hist!.events.map((e) => e.kind)).toEqual(['taken', 'created']);
      expect(await departmentTaskHistory(rpcAs(() => db, OWNER), hotelTaskId)).toBeNull();
      expect(await departmentTaskHistory(rpcAs(() => db, { userId: U.accountsJodhpur }), hotelTaskId)).toBeNull();
    });
  });
});
