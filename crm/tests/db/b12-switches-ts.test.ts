import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { B12_SWITCH_FIELD } from '@/modules/fulfilment/b11-forms';
import { B12_SWITCH_ACTION_TEXT, B12_SWITCH_TEXT } from '@/modules/fulfilment/contracts';
import { SYNTHETIC_INTAKE_CONFIG as CONFIG, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { OWNER, SUPER, SVC } from './b1-support';
import { b11Helpers } from './b11-support';
import { staffAs } from './b12-ts-support';

/**
 * B1.2 switches through the TS layer on the real SQL (PGlite, synthetic):
 * the Workflow page read (state, open automatic stops, who may switch) and
 * the Super Admin action for the copy switch and the two Bitrix read
 * switches (audited, reason required). Rolled back.
 */

const requireStaff = vi.fn();
vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { setB12SwitchAction } = await import('@/modules/fulfilment/server/b12-switch-actions');
const { loadB12Switches } = await import('@/modules/fulfilment/server/b12-switches');

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one, owner } = h;
const REASON = 'Owner approval APPROVE, synthetic test run';

async function superStaff() {
  const [cfg] = await owner<{ entity: string; branch: string }>('select pilot_legal_entity_id::text as entity, pilot_branch_id::text as branch from public.integration_intake_config where id = $1', [CONFIG]);
  const s = staffAs(() => db, SUPER, [{ legalEntityId: cfg!.entity, branchId: cfg!.branch, roleCode: 'super_admin' }]);
  return s as unknown as Parameters<typeof loadB12Switches>[0];
}
function switchForm(key: string, state: 'on' | 'off', reason = REASON): FormData {
  const f = new FormData();
  f.set(B12_SWITCH_FIELD.key, key);
  f.set(B12_SWITCH_FIELD.state, state);
  f.set(B12_SWITCH_FIELD.reason, reason);
  return f;
}

describe('B1.2 switches', () => {
  it('read: all off by default; the Super Admin may switch; others get no card or no switch', async () => {
    await asOwner(db, async () => {
      const view = await loadB12Switches(await superStaff());
      expect(view).toEqual({
        canSwitch: true,
        switches: [
          { key: 'bitrix_trip_facts_read', title: B12_SWITCH_TEXT.bitrix_trip_facts_read.title, detail: expect.any(String), on: false },
          { key: 'lead_intake_unowned', title: B12_SWITCH_TEXT.lead_intake_unowned.title, detail: expect.any(String), on: false },
          { key: 'bitrix_id_proof_copy', title: B12_SWITCH_TEXT.bitrix_id_proof_copy.title, detail: expect.stringContaining('closes any open automatic stops'), on: false, openStops: 0 },
        ],
        readOnly: [{ key: 'pdf_render_online', title: 'Online PDF maker', detail: expect.any(String), on: false, howToChange: 'Changed in the hosting settings with the owner’s approval, not here.' }],
      });
      expect(await loadB12Switches(staffAs(() => db, OWNER) as unknown as Parameters<typeof loadB12Switches>[0])).toBeNull();
    });
  });

  it('copy switch on (audited, closes open stops) then off; unchanged answers say so', async () => {
    await asOwner(db, async () => {
      const staff = await superStaff();
      requireStaff.mockResolvedValue(staff);
      // One open automatic stop to be closed by switching on.
      await owner('update public.integration_intake_config set bitrix_id_proof_copy = true where id = $1', [CONFIG]);
      const deal = await h.insertRealDeal('C7:NEW', 7, 997001);
      await h.draftWithTravellers(OWNER, deal);
      await h.storeIdProof(OWNER, deal, 1);
      const [job] = await one<Array<{ jobId: string; leaseToken: string }>>(SVC, 'select public.bitrix_id_proof_copy_claim($1, $2) as r', [10, 60]);
      await one(SVC, 'select public.bitrix_id_proof_copy_stop($1, $2, $3) as r', [job!.jobId, job!.leaseToken, 'prior_files_lost']);
      expect((await loadB12Switches(staff))!.switches.find((s) => s.key === 'bitrix_id_proof_copy')).toMatchObject({ on: false, openStops: 1 });

      const on = await setB12SwitchAction(null, switchForm('bitrix_id_proof_copy', 'on'));
      expect(on).toEqual({ ok: true, data: { key: 'bitrix_id_proof_copy', changed: true, on: true }, message: expect.stringContaining('open automatic stops are now closed') });
      expect((await loadB12Switches(staff))!.switches.find((s) => s.key === 'bitrix_id_proof_copy')).toMatchObject({ on: true, openStops: 0 });
      expect(await setB12SwitchAction(null, switchForm('bitrix_id_proof_copy', 'on'))).toMatchObject({ ok: true, data: { changed: false }, message: B12_SWITCH_ACTION_TEXT.unchanged.replace('{state}', 'on') });
      expect(await setB12SwitchAction(null, switchForm('bitrix_id_proof_copy', 'off'))).toMatchObject({ ok: true, data: { on: false }, message: expect.stringContaining('Copying is off') });
      const audits = await owner<{ reason: string | null }>(`select reason from public.audit_events where action = 'integration.id_proof_copy_switch_set' order by occurred_at, id`);
      expect(audits.map((a) => a.reason)).toEqual([REASON, REASON]);
    });
  });

  it('read switches: trip facts and Leads without an owner, one at a time; the other stays', async () => {
    await asOwner(db, async () => {
      const staff = await superStaff();
      requireStaff.mockResolvedValue(staff);
      expect(await setB12SwitchAction(null, switchForm('bitrix_trip_facts_read', 'on'))).toMatchObject({ ok: true, data: { key: 'bitrix_trip_facts_read', changed: true, on: true } });
      const unowned = await setB12SwitchAction(null, switchForm('lead_intake_unowned', 'on'));
      expect(unowned).toMatchObject({ ok: true, data: { key: 'lead_intake_unowned', on: true, requeued: 0, notRequeued: 0 }, message: expect.stringContaining('handed back to the sync') });
      expect((await loadB12Switches(staff))!.switches.map((s) => [s.key, s.on])).toEqual([
        ['bitrix_trip_facts_read', true],
        ['lead_intake_unowned', true],
        ['bitrix_id_proof_copy', false],
      ]);
    });
  });

  it('refusals: a short reason before any call; anyone but the Super Admin is refused by the database', async () => {
    await asOwner(db, async () => {
      requireStaff.mockResolvedValue(await superStaff());
      expect(await setB12SwitchAction(null, switchForm('bitrix_id_proof_copy', 'on', 'short'))).toMatchObject({ ok: false, code: 'invalid_input', fields: [B12_SWITCH_FIELD.reason] });
      expect(await setB12SwitchAction(null, switchForm('pdf_render_online', 'on'))).toMatchObject({ ok: false, code: 'invalid_input', fields: [B12_SWITCH_FIELD.key] });
      requireStaff.mockResolvedValue(staffAs(() => db, OWNER));
      expect(await setB12SwitchAction(null, switchForm('bitrix_trip_facts_read', 'on'))).toMatchObject({ ok: false, code: 'not_authorized' });
    });
  });
});
