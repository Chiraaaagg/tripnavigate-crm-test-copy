import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { expectConflict } from '../helpers/sqlstates';
import { ACCOUNTS, DEAL, FLIGHT, OWNER, PURCHASE, SUPER, TRAVELLERS } from './b1-support';
import { relbHelpers } from './acc3-relb-support';
import { DESK, IDENTITY, PARTICIPATION_SQL, PASSPORT, SETTING_SQL_B11, SWITCH_REASON, VISA_CLAIM_SQL } from './b11-support';
import { formHelpers } from './booking-form-support';
import type { Actor } from '../helpers/db';

/**
 * Booking reliability fix batch 2, B2-2 (migration 20261210000200; build
 * contract section 6): booking_passport_items_add makes one passport service
 * per applicant from one selection, in one transaction, replay-safe under one
 * request id, inside the Deal limit of 20 services. Each service keeps exactly
 * one applicant. Synthetic data only; every scenario is rolled back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = formHelpers(() => db);
const { one, owner } = h;

const BATCH_SQL = 'select public.booking_passport_items_add($1, $2, $3::jsonb, $4::integer[], $5) as r';
type Batch = { rowVersion: number; contentHash: string; items: Array<{ itemId: string; itemNo: number; travellerSeq: number }>; outcome?: string };
const batch = (actor: Actor, versionId: string, rowVersion: number, seqs: number[], requestId: string = crypto.randomUUID(), facts: unknown = PASSPORT) =>
  one<Batch>(actor, BATCH_SQL, [versionId, rowVersion, JSON.stringify(facts), seqs, requestId]);

/** A conflict refusal (40001 or PT409 while stage 1 runs; PT409 after stage 2). */
async function conflict(actor: Actor, sql: string, params: unknown[], token: string): Promise<void> {
  await db.exec('savepoint br_conflict');
  let error: unknown;
  try {
    await one(actor, sql, params);
  } catch (e) {
    error = e;
    await db.exec('rollback to savepoint br_conflict');
  }
  expectConflict(error, token);
}

/** A booking-form draft on DEAL with TRAVELLERS saved. */
async function draft(travellers: unknown = TRAVELLERS) {
  await h.setSwitch('service_items_enabled', true);
  const s = await h.start(OWNER, DEAL);
  const rv = (await h.saveTravellers(OWNER, DEAL, s.rowVersion, travellers)).rowVersion;
  return { versionId: s.versionId, rowVersion: rv };
}
const passportItems = (deal: string = DEAL) => owner<{ id: string; item_no: number; seqs: number[] }>(
  `select i.id, i.item_no, coalesce((select array_agg(p.traveller_seq order by p.traveller_seq) from public.service_item_travellers p
     where p.service_item_id = i.id), '{}'::integer[]) as seqs
   from public.service_items i where i.deal_id = $1 and i.service_type = 'passport' order by i.item_no`, [deal]);

describe('booking_passport_items_add', () => {
  it('three applicants give three passport services, one applicant each, in order, one version chain and the audit rows', async () => {
    await asOwner(db, async () => {
      const d = await draft();
      const r = await batch(OWNER, d.versionId, d.rowVersion, [3, 1, 2]);
      expect(r.items.map((i) => i.travellerSeq)).toEqual([1, 2, 3]);
      const nos = r.items.map((i) => i.itemNo);
      expect(nos).toEqual([...nos].sort((a, b) => a - b));
      const items = await passportItems();
      expect(items.map((i) => [i.id, i.item_no, i.seqs])).toEqual(r.items.map((i) => [i.itemId, i.itemNo, [i.travellerSeq]]));
      const [v] = await owner<{ row_version: number; content_hash: string; ok: boolean }>(
        'select row_version, content_hash, content_hash = authz.booking_content_hash(id) as ok from public.booking_versions where id = $1', [d.versionId]);
      expect(v).toEqual({ row_version: r.rowVersion, content_hash: r.contentHash, ok: true });
      expect(r.rowVersion).toBeGreaterThan(d.rowVersion);
      // The existing per-item audit rows, plus one for the batch (numbers only).
      const added = await owner<{ n: number }>(`select count(*)::int as n from public.audit_events where action = 'booking.service_item_added'`);
      expect(added).toEqual([{ n: 3 }]);
      const rows = await owner<{ details: Record<string, unknown> }>(`select details from public.audit_events where action = 'booking.passport_items_added'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.details).toMatchObject({ dealId: DEAL, versionId: d.versionId, itemNos: nos, count: 3, rowVersion: r.rowVersion });
      expect(JSON.stringify(rows)).not.toMatch(/Synthetic Traveller|Jodhpur|renewal/);
    });
  });

  it('the same request id again creates nothing and returns the first answer; another payload under it is refused', async () => {
    await asOwner(db, async () => {
      const d = await draft();
      const request = crypto.randomUUID();
      const first = await batch(OWNER, d.versionId, d.rowVersion, [1, 2], request);
      const again = await batch(OWNER, d.versionId, d.rowVersion, [1, 2], request);
      expect(again).toEqual({ ...first, outcome: 'existing' });
      expect(await passportItems()).toHaveLength(2);
      await conflict(OWNER, BATCH_SQL, [d.versionId, d.rowVersion, JSON.stringify(PASSPORT), [1], request], 'request_conflict');
      expect(await passportItems()).toHaveLength(2);
    });
  });

  it('the Deal limit of 20 services: a group larger than the room left is refused and nothing is created', async () => {
    await asOwner(db, async () => {
      const many = Array.from({ length: 21 }, (_, i) => ({ fullName: `Synthetic Applicant ${i + 1}`, type: 'adult', seq: i + 1 }));
      const d = await draft(many);
      const r = await batch(OWNER, d.versionId, d.rowVersion, Array.from({ length: 18 }, (_, i) => i + 1));
      expect(r.items).toHaveLength(18);
      await h.refused(OWNER, BATCH_SQL, [d.versionId, r.rowVersion, JSON.stringify(PASSPORT), [19, 20, 21], crypto.randomUUID()], '22023', 'too_many_items');
      expect(await passportItems()).toHaveLength(18);
      // More than 20 applicants in one batch is refused as input.
      await h.refusedWithHint(OWNER, BATCH_SQL, [d.versionId, r.rowVersion, JSON.stringify(PASSPORT), Array.from({ length: 21 }, (_, i) => i + 1),
        crypto.randomUUID()], /^travellers$/);
    });
  });

  it('refuses an unknown, repeated or missing applicant, a stale version and bad facts; nothing is created', async () => {
    await asOwner(db, async () => {
      const d = await draft();
      for (const seqs of [[1, 9], [1, 1], [], [null]]) {
        await h.refusedWithHint(OWNER, BATCH_SQL, [d.versionId, d.rowVersion, JSON.stringify(PASSPORT), seqs, crypto.randomUUID()], /^travellers$/);
      }
      await conflict(OWNER, BATCH_SQL, [d.versionId, d.rowVersion - 1, JSON.stringify(PASSPORT), [1, 2], crypto.randomUUID()], 'version_changed');
      await h.refusedWithHint(OWNER, BATCH_SQL, [d.versionId, d.rowVersion, JSON.stringify({ ...PASSPORT, officeCity: '' }), [1, 2], crypto.randomUUID()],
        /officeCity/);
      await h.refusedWithHint(OWNER, BATCH_SQL, [d.versionId, d.rowVersion, JSON.stringify(PASSPORT), [1, 2], null], /^requestId$/);
      expect(await passportItems()).toEqual([]);
    });
  });

  it('Purchase, Flight and Accounts holders are refused', async () => {
    await asOwner(db, async () => {
      const d = await draft();
      await h.addFlight();
      for (const actor of [PURCHASE, FLIGHT, ACCOUNTS]) {
        await h.refused(actor, BATCH_SQL, [d.versionId, d.rowVersion, JSON.stringify(PASSPORT), [1, 2], crypto.randomUUID()], '42501', 'not_authorized');
      }
      expect(await passportItems()).toEqual([]);
    });
  });

  it('editing a passport service still allows one applicant only', async () => {
    await asOwner(db, async () => {
      const d = await draft();
      const r = await batch(OWNER, d.versionId, d.rowVersion, [1, 2]);
      await h.refusedWithHint(OWNER, PARTICIPATION_SQL, [r.items[0]!.itemId, d.versionId, r.rowVersion, [1, 2]], /^travellers$/);
    });
  });

  it('confirmation gives one Visa & Passport desk task and one application per passport line (switch on)', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const opened = await h.openDraft(OWNER, DEAL);
      let rv = (await h.saveTravellers(OWNER, DEAL, opened.rowVersion, TRAVELLERS)).rowVersion;
      rv = (await h.saveSelling(OWNER, opened.versionId, rv)).rowVersion;
      rv = await h.completeB11(OWNER, DEAL, opened.versionId, rv);
      const r = await batch(OWNER, opened.versionId, rv, [1, 2, 3]);
      for (const seq of [1, 2, 3]) await h.saveIdentity(OWNER, DEAL, seq, 0, { ...IDENTITY, passportNumber: `Z${1000000 + seq}` });
      await h.storeEvidence(OWNER, opened.versionId);
      const ready = await h.readiness(OWNER, opened.versionId);
      expect(ready.issues).toEqual([]);
      await h.confirm(OWNER, opened.versionId, ready.contentHash);
      await one(SUPER, SETTING_SQL_B11, ['visa_passport_tasks_enabled', true, SWITCH_REASON]);
      const tasks = await owner<{ id: string; service_item_id: string }>(
        `select id, service_item_id from public.fulfilment_tasks where deal_id = $1 and department = 'visa' order by created_at, id`, [DEAL]);
      expect(tasks.map((t) => t.service_item_id).sort()).toEqual(r.items.map((i) => i.itemId).sort());
      // The desk takes each task: one application per task, for its one applicant.
      for (const t of tasks) expect(await one(DESK, VISA_CLAIM_SQL, [t.id])).toMatchObject({ applicationCount: 1 });
      const apps = await owner<{ task_id: string; traveller_seq: number }>(
        'select task_id, traveller_seq from public.visa_applications where deal_id = $1 order by traveller_seq', [DEAL]);
      expect(apps.map((a) => a.traveller_seq)).toEqual([1, 2, 3]);
      expect(new Set(apps.map((a) => a.task_id)).size).toBe(3);
    });
  });

  it('a change version of an approved "add a service" request accepts the batch', async () => {
    await asOwner(db, async () => {
      const rb = relbHelpers(() => db);
      await rb.committedDeal([]);
      await rb.serviceChangesOn();
      const cr = await rb.requestChange({ kind: 'add_service', itemIds: [], changeSummary: 'Synthetic: add passport services' });
      const v = await rb.openChange(cr.changeRequestId);
      const seqs = (await owner<{ seq: number }>('select seq from public.deal_travellers where deal_id = $1 order by seq', [DEAL])).map((t) => t.seq);
      const r = await batch(OWNER, v.versionId, v.rowVersion, seqs.slice(0, 2));
      expect(r.items).toHaveLength(2);
      const items = await owner<{ n: number }>(
        `select count(*)::int as n from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
         where f.booking_version_id = $1 and i.service_type = 'passport'`, [v.versionId]);
      expect(items).toEqual([{ n: 2 }]);
    });
  });
});
