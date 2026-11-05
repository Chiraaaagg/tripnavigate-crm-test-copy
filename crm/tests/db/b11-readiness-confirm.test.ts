import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { CHECKLIST_SQL, DEAL, FLIGHT_FACTS, HOTEL, OWNER, SERVICES_SQL, TRAVELLERS } from './b1-support';
import { BILLING, CONTACT, IDENTITY, PASSPORT, TRIP, VISA, b11Helpers, rid } from './b11-support';

/**
 * B1.1a readiness and submission (migration 20261119000100): every new
 * readiness code and checklist rule, visa/passport items confirmed while the
 * desk switch is off (no task, waiting for launch, outstanding in progress),
 * standalone visa and passport bookings, duplicate submission.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one, owner, readiness, confirm, draftWithTravellers, readyDraft, saveTrip, saveContacts, propose, saveIdentity, savePlan } = h;

type Checklist = { items: Array<{ code: string; blocking: boolean; owner: string; itemNos: number[]; travellerSeqs?: number[] }>; canConfirm: boolean };
const checklist = (deal: string = DEAL) => one<Checklist>(OWNER, CHECKLIST_SQL, [deal]);

describe('readiness codes (package versions)', () => {
  it('walks every new code from missing to satisfied', async () => {
    await asOwner(db, async () => {
      const travellers = [TRAVELLERS[0]!, { ...TRAVELLERS[3]!, ageYears: undefined }];
      const d = await draftWithTravellers(OWNER, DEAL, travellers);
      let rv = (await h.addItem(OWNER, d.versionId, d.rowVersion, 'flight', { ...FLIGHT_FACTS, passengers: 2 })).rowVersion;
      rv = (await h.addItem(OWNER, d.versionId, rv, 'visa', VISA)).rowVersion;
      let issues = (await readiness(OWNER, d.versionId)).issues;
      expect(issues).toEqual(expect.arrayContaining(['contact_missing', 'billing_missing', 'trip_missing', 'child_age_missing',
        'identity_missing', 'missing_selling_total', 'plan_missing', 'missing_acceptance_proof']));
      expect(issues).not.toContain('participation_missing');
      let list = await checklist();
      expect(list.canConfirm).toBe(false);
      expect(list.items.find((i) => i.code === 'child_age_missing')).toMatchObject({ blocking: true, travellerSeqs: [4] });
      expect(list.items.find((i) => i.code === 'identity_missing')).toMatchObject({ blocking: true, travellerSeqs: [1, 4] });
      expect(list.items.find((i) => i.code === 'visa_waiting_for_launch')).toMatchObject({ blocking: false, owner: 'admin', itemNos: [2] });
      expect(list.items.map((i) => i.code)).not.toContain('visa_mentioned');
      // B1.2 (DEC-38): the adult's identity proof blocks; the child's is a warning.
      expect(issues).toContain('id_proof_missing');
      expect(list.items.find((i) => i.code === 'id_proof_missing')).toMatchObject({ blocking: true, travellerSeqs: [1] });
      expect(list.items.find((i) => i.code === 'id_proof_missing_child')).toMatchObject({ blocking: false, travellerSeqs: [4] });

      rv = (await h.saveTravellers(OWNER, DEAL, rv, [TRAVELLERS[0]!, { ...TRAVELLERS[3]!, ageYears: 6 }])).rowVersion;
      rv = (await saveContacts(OWNER, d.versionId, rv, { ...CONTACT, contactConfirmed: false, bookingFor: 'business' })).rowVersion;
      await propose(OWNER, DEAL, 0, BILLING);
      issues = (await readiness(OWNER, d.versionId)).issues;
      expect(issues).toEqual(expect.arrayContaining(['contact_not_confirmed', 'gstin_missing']));
      expect(issues).not.toContain('child_age_missing');
      rv = (await saveContacts(OWNER, d.versionId, rv, CONTACT)).rowVersion;
      rv = (await saveTrip(OWNER, d.versionId, rv, { ...TRIP, scope: 'international' })).rowVersion;
      // Identity: DOB and nationality are required; passport details are a "later" warning.
      await saveIdentity(OWNER, DEAL, 1, 0, { dateOfBirth: '1990-01-01', nationality: 'Indian', passportNumber: null, passportExpiry: null });
      await saveIdentity(OWNER, DEAL, 4, 0, { ...IDENTITY, passportExpiry: '2026-12-01' });
      rv = (await h.saveCommercials(OWNER, d.versionId, rv, null, null, '5000000')).rowVersion;
      rv = (await savePlan(OWNER, d.versionId, rv, [{ seq: 1, label: 'Full', amountPaise: '4000000', dueDate: '2026-11-01' }])).rowVersion;
      await h.storeIdProof(OWNER, DEAL, 1); // the child's proof stays optional
      issues = (await readiness(OWNER, d.versionId)).issues;
      expect(issues).toEqual(['plan_total_mismatch', 'missing_acceptance_proof']);
      list = await checklist();
      expect(list.items.find((i) => i.code === 'passport_details_later')).toMatchObject({ blocking: false, travellerSeqs: [1] });
      expect(list.items.find((i) => i.code === 'passport_expiry_before_trip_end')).toMatchObject({ blocking: false, travellerSeqs: [4] });
      expect(list.items.find((i) => i.code === 'billing_unverified')).toMatchObject({ blocking: false, owner: 'accounts' });
      expect(list.items.find((i) => i.code === 'plan_total_mismatch')).toMatchObject({ blocking: true });
      rv = (await savePlan(OWNER, d.versionId, rv, [{ seq: 1, label: 'Full', amountPaise: '5000000', dueDate: '2026-11-01' }])).rowVersion;
      await h.storeEvidence(OWNER, d.versionId);
      const r = await readiness(OWNER, d.versionId);
      expect(r.issues).toEqual([]);
      expect((await checklist()).canConfirm).toBe(true);
      expect(rv).toBeGreaterThan(1);
    });
  });

  it('dates_outside_trip uses the trip dates when set', async () => {
    await asOwner(db, async () => {
      const d = await draftWithTravellers();
      let rv = (await h.addItem(OWNER, d.versionId, d.rowVersion, 'hotel', HOTEL)).rowVersion; // 10-13 Dec
      rv = (await saveTrip(OWNER, d.versionId, rv, { ...TRIP, start: '2026-12-01', end: '2026-12-05' })).rowVersion;
      expect((await checklist()).items.find((i) => i.code === 'dates_outside_trip')).toMatchObject({ blocking: false, itemNos: [1] });
      await saveTrip(OWNER, d.versionId, rv, TRIP);
      expect((await checklist()).items.map((i) => i.code)).not.toContain('dates_outside_trip');
    });
  });
});

describe('visa and passport before the desk launch', () => {
  it('a package with visa confirms: tasks for the other items only, the visa item is active and waiting; progress counts it outstanding', async () => {
    await asOwner(db, async () => {
      const ready = await readyDraft(OWNER, DEAL, [['hotel', HOTEL], ['visa', VISA]], { identities: true });
      expect(ready.issues).toEqual([]);
      const result = await confirm(OWNER, ready.versionId, ready.hash);
      expect(result.taskIds).toHaveLength(1);
      const items = await owner<{ service_type: string; state: string; tasks: number }>(
        `select i.service_type, i.state, (select count(*)::int from public.fulfilment_tasks t where t.service_item_id = i.id) as tasks
         from public.service_items i where i.deal_id = $1 order by i.item_no`, [DEAL]);
      expect(items).toEqual([{ service_type: 'hotel', state: 'active', tasks: 1 }, { service_type: 'visa', state: 'active', tasks: 0 }]);
      const services = await one<{ items: Array<{ serviceType: string; nextStep: string }>; progress: Record<string, unknown> }>(OWNER, SERVICES_SQL, [DEAL]);
      expect(services.items.map((i) => [i.serviceType, i.nextStep])).toEqual([['hotel', 'take_task'], ['visa', 'waiting_for_desk_launch']]);
      expect(services.progress).toEqual({
        total: 2, byState: { planned: 0, waitingForLaunch: 1, notStarted: 1, inProgress: 0, supplierConfirmed: 0, completed: 0 },
        fulfilled: false, staleCount: 0, needs: ['waiting_for_desk_launch', 'take_task'],
      });
      // Repeat submission: nothing new.
      expect(await confirm(OWNER, ready.versionId, ready.hash)).toMatchObject({ outcome: 'existing', taskIds: result.taskIds });
    });
  });

  it('standalone visa and standalone passport bookings confirm with no task at all and stay outstanding', async () => {
    await asOwner(db, async () => {
      const visa = await readyDraft(OWNER, DEAL, [['visa', VISA]], { identities: true });
      const r1 = await confirm(OWNER, visa.versionId, visa.hash);
      expect(r1).toMatchObject({ outcome: 'created', taskIds: [] });
      expect(await confirm(OWNER, visa.versionId, visa.hash)).toMatchObject({ outcome: 'existing', taskIds: [] });
      expect(await owner('select count(*)::int as n from public.fulfilment_tasks where deal_id = $1', [DEAL])).toEqual([{ n: 0 }]);
      const outbox = await owner<{ payload: Record<string, unknown> }>(`select payload from public.outbox_events where aggregate_id = $1`, [visa.versionId]);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.payload).not.toHaveProperty('task_id');
    });
    await asOwner(db, async () => {
      const passport = await readyDraft(OWNER, DEAL, [['passport', PASSPORT]], { identities: true, travellers: [TRAVELLERS[0]!] });
      expect(passport.issues).toEqual([]);
      expect((await confirm(OWNER, passport.versionId, passport.hash)).taskIds).toEqual([]);
    });
  });

  it('a readiness failure creates nothing (identity missing on a visa traveller)', async () => {
    await asOwner(db, async () => {
      const ready = await readyDraft(OWNER, DEAL, [['visa', VISA]]);
      expect(ready.issues).toEqual(['identity_missing']);
      await h.refused(OWNER, 'select public.booking_confirm($1, $2) as r', [ready.versionId, ready.hash], '55000', 'not_ready');
      expect(rid()).toMatch(/-/);
    });
  });
});
