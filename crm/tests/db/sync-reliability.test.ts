import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaimedInboxItem } from '@/modules/integration/contracts';
import {
  type Actor,
  FIXTURE_USERS as U,
  type TestDb,
  asOwner,
  createTestDb,
  expectDbError,
  resetActor,
  setActor,
} from '../helpers/db';

/**
 * Sync reliability (9 October 2026), migration 20261113000100_sync_reliability:
 *
 * 1. integration_auto_sync_status().runs24h counts every heartbeat of the last
 *    24 hours per kind and outcome, so the admin page can never show a clean
 *    sync while runs fail.
 * 2. The full resync re-queues a stored, current Deal whose Lead link differs
 *    from the listed Bitrix LEAD_ID, so the next resync fills deals.source_lead_id
 *    and the Deal page can show "Came from Lead BXL-<id>".
 *
 * Synthetic fixtures only (Deal manifest 5000-9999, business day 2026-09-15 IST,
 * source SYNTHETIC_SRC; Bitrix 101 -> Sales Delhi A). Rolled back per case.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const SVC: Actor = { userId: null, role: 'service_role' };
const ADMIN: Actor = { userId: U.adminJodhpur };
const MEMBER = 'SYNTHETIC_MEMBER_0001';
const CONFIG = 'c0000000-0000-4000-8000-000000000001';
const first = <T>(rows: Array<{ r: T }>): T => rows[0]!.r;

async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  await setActor(db, actor);
  const rows = await db.query<T>(sql, params);
  await resetActor(db);
  return rows;
}

describe('integration_auto_sync_status().runs24h', () => {
  const record = (run_: Record<string, unknown>) =>
    run(SVC, 'select public.integration_record_worker_run($1::jsonb)', [
      JSON.stringify({
        startedAt: new Date(Date.now() - 2000).toISOString(),
        finishedAt: new Date().toISOString(),
        ...run_,
      }),
    ]);

  it('counts every run of the last 24 hours by kind and outcome, with the items those runs could not save', async () => {
    await asOwner(db, async () => {
      await db.exec('delete from public.integration_worker_runs');
      await record({ kind: 'worker', outcome: 'ok', claimed: 2, updated: 2 });
      await record({ kind: 'worker', outcome: 'internal_error', claimed: 3, failed: 3 });
      await record({ kind: 'worker', outcome: 'internal_error', claimed: 1, failed: 1 });
      await record({ kind: 'worker', outcome: 'partial', claimed: 4, updated: 1, failed: 2, deadLettered: 1 });
      await record({ kind: 'reconcile', outcome: 'ok', enqueued: 0 });
      await record({ kind: 'reconcile', outcome: 'provider_error' });
      // Older than 24 hours: not counted.
      await db.query(
        `insert into public.integration_worker_runs (kind, started_at, finished_at, outcome, failed)
         values ('worker', now() - interval '30 hours', now() - interval '30 hours', 'internal_error', 9)`,
      );

      const status = first(await run<{ r: { runs24h: Record<string, unknown> } }>(ADMIN, 'select public.integration_auto_sync_status() as r'));
      expect(status.runs24h).toMatchObject({
        worker: { ok: 1, partial: 1, providerError: 0, internalError: 2 },
        reconcile: { ok: 1, partial: 0, providerError: 1, internalError: 0 },
        itemsFailed: 6,
        itemsDeadLettered: 1,
      });
      expect(typeof status.runs24h.lastFailedAt).toBe('string');
      // Existing keys are unchanged.
      expect(Object.keys(status).sort()).toEqual(
        ['cronInstalled', 'enabled', 'failingSince', 'job', 'lastCalls', 'lastOkCallAt', 'runs24h'].sort(),
      );
    });
  });

  it('a clean day reports zero problems and no failure time', async () => {
    await asOwner(db, async () => {
      await db.exec('delete from public.integration_worker_runs');
      await record({ kind: 'worker', outcome: 'ok', claimed: 1, created: 1 });
      const status = first(await run<{ r: { runs24h: Record<string, unknown> } }>(ADMIN, 'select public.integration_auto_sync_status() as r'));
      expect(status.runs24h).toMatchObject({
        worker: { ok: 1, partial: 0, providerError: 0, internalError: 0 },
        itemsFailed: 0,
        itemsDeadLettered: 0,
        lastFailedAt: null,
      });
    });
  });

  it('only integration admins read it', async () => {
    await asOwner(db, async () => {
      await expectDbError(db, () => run({ userId: U.salesDelhiA }, 'select public.integration_auto_sync_status()'), { code: '42501' });
    });
  });
});

describe('integration_inbox_row_status', () => {
  it('service role reads one row\'s status; unknown row is null; staff and admins are refused', async () => {
    await asOwner(db, async () => {
      const rec = first(
        await run<{ r: { inboxId: string } }>(SVC, 'select public.integration_record_bitrix_event($1, $2, $3, $4) as r', [
          MEMBER, 'ONCRMDEALUPDATE', 9731, 1_804_000_000,
        ]),
      );
      expect(first(await run<{ r: unknown }>(SVC, 'select public.integration_inbox_row_status($1) as r', [rec.inboxId]))).toEqual({
        status: 'pending',
      });
      expect(
        first(await run<{ r: unknown }>(SVC, 'select public.integration_inbox_row_status($1) as r', ['00000000-0000-4000-8000-000000000999'])),
      ).toBeNull();
      await expectDbError(db, () => run(ADMIN, 'select public.integration_inbox_row_status($1)', [rec.inboxId]), { code: '42501' });
    });
  });
});

describe('the full resync fills a missing or changed Lead link', () => {
  type Job = { jobId: string; lockToken: string; cursorId: number };
  type Item = { id: number; modified: number; leadId?: unknown };
  const nextJob = () => run<{ r: Job | null }>(SVC, 'select public.integration_resync_next($1, 60) as r', [MEMBER]).then(first);
  const page = (job: Job, items: Item[], last: boolean) =>
    run<{ r: { enqueued: number; scanned: number; cursorId: number; leadLinkRequeued: number } }>(
      SVC,
      'select public.integration_resync_page($1, $2, $3::jsonb, $4, $5) as r',
      [job.jobId, job.lockToken, JSON.stringify(items), null, last],
    ).then(first);

  let ts = 1_803_000_000;
  const DATE = '2026-09-15T10:00:00+05:30';
  const MODIFIED = Math.floor(Date.parse(DATE) / 1000);
  const deal = (id: number, o: Record<string, unknown> = {}) => ({
    id: String(id),
    sourceId: 'SYNTHETIC_SRC',
    title: `Synthetic resync link deal ${id}`,
    stageId: 'C7:NEW',
    categoryId: '7',
    assignedById: '101',
    dateCreate: DATE,
    dateModify: DATE,
    ...o,
  });
  const lead = (id: number) => ({
    id: String(id), title: `Synthetic resync lead ${id}`, statusId: 'CONVERTED', sourceId: 'WEBFORM', assignedById: '101',
    dateCreate: '2026-10-02T11:00:00+05:30', dateModify: '2026-10-02T11:00:00+05:30',
  });

  async function claimAll(): Promise<ClaimedInboxItem[]> {
    return (await run<{ r: ClaimedInboxItem }>(SVC, 'select r from public.integration_claim_inbox(100, 60) as r')).map((x) => x.r);
  }
  async function applyEvent(event: 'ONCRMDEALUPDATE' | 'ONCRMLEADUPDATE', snapshot: Record<string, unknown>) {
    const rec = first(
      await run<{ r: { inboxId: string } }>(SVC, 'select public.integration_record_bitrix_event($1, $2, $3, $4) as r', [
        MEMBER, event, Number(snapshot.id), (ts += 1),
      ]),
    );
    const item = (await claimAll()).find((c) => c.inboxId === rec.inboxId)!;
    const fn = event === 'ONCRMDEALUPDATE' ? 'integration_apply_bitrix_deal' : 'integration_apply_bitrix_lead';
    return first(
      await run<{ r: { outcome: string } }>(SVC, `select public.${fn}($1, $2, $3::jsonb) as r`, [
        item.inboxId, item.lockToken, JSON.stringify(snapshot),
      ]),
    );
  }
  const linkOf = async (id: number) =>
    (await db.query<{ l: string | null }>('select source_lead_id::text as l from public.deals where source_portal = $1 and source_deal_id = $2', [MEMBER, id]))[0]?.l;
  const openRows = async (id: number) =>
    db.query<{ status: string; origin: string; attempts: number }>(
      `select status, origin, attempts from public.integration_inbox
       where portal_member_id = $1 and source_object = 'deal' and source_deal_id = $2 and status in ('pending', 'processing', 'failed')`,
      [MEMBER, id],
    );
  /** What the Deal page asks (lead-link.ts): the Lead with the Deal's portal and Lead id, under RLS. */
  const visibleLink = (actor: Actor, dealId: number) =>
    run<{ reference: string }>(
      actor,
      `select l.reference from public.crm_leads l
       where l.source_system = 'bitrix' and (l.source_portal, l.source_lead_id) = (
         select d.source_portal, d.source_lead_id from public.deals d where d.source_portal = $1 and d.source_deal_id = $2)`,
      [MEMBER, dealId],
    );

  it('re-queues only stored Deals whose link differs; the worker re-read writes it; the Deal page then shows the Lead', async () => {
    await asOwner(db, async () => {
      await db.query(`update public.integration_intake_config set lead_intake_mode = 'scope' where id = $1`, [CONFIG]);
      expect(await applyEvent('ONCRMLEADUPDATE', lead(41701))).toMatchObject({ outcome: 'created' });
      // Stored before LEAD_ID was read: no link.
      expect(await applyEvent('ONCRMDEALUPDATE', deal(9701))).toMatchObject({ outcome: 'created' });
      expect(await applyEvent('ONCRMDEALUPDATE', deal(9703, { leadId: '41703' }))).toMatchObject({ outcome: 'created' });
      expect(await applyEvent('ONCRMDEALUPDATE', deal(9704, { leadId: '41704' }))).toMatchObject({ outcome: 'created' });
      expect(await applyEvent('ONCRMDEALUPDATE', deal(9705))).toMatchObject({ outcome: 'created' });
      expect(await applyEvent('ONCRMDEALUPDATE', deal(9706))).toMatchObject({ outcome: 'created' });
      expect(await linkOf(9701)).toBeNull();

      const job = (await nextJob())!;
      const result = await page(
        job,
        [
          { id: 9701, modified: MODIFIED, leadId: '41701' }, // missing link -> re-read
          { id: 9703, modified: MODIFIED, leadId: '41703' }, // same link -> nothing
          { id: 9704, modified: MODIFIED, leadId: '' }, // link removed in Bitrix -> re-read
          { id: 9705, modified: MODIFIED }, // older app (no leadId key) -> as before
          { id: 9706, modified: MODIFIED, leadId: 'L-1' }, // malformed -> nothing
        ],
        true,
      );
      expect(result).toMatchObject({ enqueued: 0, scanned: 5, leadLinkRequeued: 2 });
      expect(await openRows(9701)).toEqual([{ status: 'pending', origin: 'manual_retry', attempts: 0 }]);
      expect(await openRows(9704)).toHaveLength(1);
      for (const id of [9703, 9705, 9706]) expect(await openRows(id), String(id)).toEqual([]);

      // The worker re-reads Bitrix: same DATE_MODIFY, changed leadId -> applied.
      const bitrix: Record<string, Record<string, unknown>> = { '9701': deal(9701, { leadId: '41701' }), '9704': deal(9704, { leadId: '' }) };
      const claimed = await claimAll();
      expect(claimed.map((c) => c.sourceDealId).sort()).toEqual(['9701', '9704']);
      for (const item of claimed) {
        const applied = first(
          await run<{ r: { outcome: string } }>(SVC, 'select public.integration_apply_bitrix_deal($1, $2, $3::jsonb) as r', [
            item.inboxId, item.lockToken, JSON.stringify(bitrix[item.sourceDealId]),
          ]),
        );
        expect(applied, item.sourceDealId).toMatchObject({ outcome: 'updated' });
      }
      expect(await linkOf(9701)).toBe('41701');
      expect(await linkOf(9704)).toBeNull();
      expect(await linkOf(9703)).toBe('41703');

      // "Came from Lead BXL-41701": the Lead's Sales owner sees it; Purchase and another branch do not.
      expect(await visibleLink({ userId: U.salesDelhiA }, 9701)).toEqual([{ reference: 'BXL-41701' }]);
      expect(await visibleLink({ userId: U.purchaseJodhpur }, 9701)).toEqual([]);
      expect(await visibleLink({ userId: U.salesAhmedabad }, 9701)).toEqual([]);
      // A link to a Lead the CRM does not hold shows nothing.
      expect(await visibleLink({ userId: U.salesDelhiA }, 9703)).toEqual([]);
    });
  });

  it('converges: a stored Deal newer than the listing, a removed Deal and a held newest row are left alone; a second resync re-queues nothing', async () => {
    await asOwner(db, async () => {
      await db.exec(`delete from public.integration_inbox where status in ('pending', 'processing', 'failed')`);
      // Stored version newer than what Bitrix lists: the apply would answer stale, so no re-queue.
      expect(await applyEvent('ONCRMDEALUPDATE', deal(9721, { dateModify: '2026-09-15T12:00:00+05:30' }))).toMatchObject({ outcome: 'created' });
      // Removed Deal: excluded.
      expect(await applyEvent('ONCRMDEALUPDATE', deal(9722))).toMatchObject({ outcome: 'created' });
      await db.query(
        `update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where source_portal = $1 and source_deal_id = 9722`,
        [MEMBER],
      );
      // Newest inbox row held for review: an admin decides, the resync does not.
      expect(await applyEvent('ONCRMDEALUPDATE', deal(9723))).toMatchObject({ outcome: 'created' });
      await db.query(
        `update public.integration_inbox set status = 'needs_review', reason_code = 'unmapped_owner'
         where id = (select id from public.integration_inbox where portal_member_id = $1 and source_deal_id = 9723
                     order by received_at desc, id desc limit 1)`,
        [MEMBER],
      );
      // Missing link, same version: re-queued once.
      expect(await applyEvent('ONCRMDEALUPDATE', deal(9724))).toMatchObject({ outcome: 'created' });

      const items: Item[] = [9721, 9722, 9723, 9724].map((id) => ({ id, modified: MODIFIED, leadId: '41720' }));
      const job = (await nextJob())!;
      expect(await page(job, items, true)).toMatchObject({ leadLinkRequeued: 1 });
      for (const id of [9721, 9722, 9723]) expect(await openRows(id), String(id)).toEqual([]);
      expect(await openRows(9724)).toHaveLength(1);

      // The worker writes the link; the job completes once the inbox has drained.
      for (const item of await claimAll()) {
        expect(
          first(
            await run<{ r: { outcome: string } }>(SVC, 'select public.integration_apply_bitrix_deal($1, $2, $3::jsonb) as r', [
              item.inboxId, item.lockToken, JSON.stringify(deal(Number(item.sourceDealId), { leadId: '41720' })),
            ]),
          ),
        ).toMatchObject({ outcome: 'updated' });
      }
      expect(await linkOf(9724)).toBe('41720');
      const finished = first(
        await run<{ r: { done: boolean } }>(SVC, 'select public.integration_resync_finish($1, $2) as r', [job.jobId, job.lockToken]),
      );
      expect(finished.done).toBe(true);

      // Next resync with the same Bitrix data: nothing left to re-queue.
      await run(SVC, 'select public.integration_queue_resync($1)', [MEMBER]);
      const again = (await nextJob())!;
      expect(again.jobId).not.toBe(job.jobId);
      expect(await page(again, items, true)).toMatchObject({ leadLinkRequeued: 0 });
      for (const id of [9721, 9722, 9723, 9724]) expect(await openRows(id), String(id)).toEqual([]);
    });
  });

  it('a Deal already waiting in the inbox is not re-queued twice', async () => {
    await asOwner(db, async () => {
      expect(await applyEvent('ONCRMDEALUPDATE', deal(9711))).toMatchObject({ outcome: 'created' });
      // A new event is waiting for this Deal.
      await run(SVC, 'select public.integration_record_bitrix_event($1, $2, $3, $4)', [MEMBER, 'ONCRMDEALUPDATE', 9711, (ts += 1)]);
      const job = (await nextJob())!;
      expect(await page(job, [{ id: 9711, modified: MODIFIED, leadId: '41711' }], true)).toMatchObject({ leadLinkRequeued: 0 });
      expect(await openRows(9711)).toHaveLength(1);
    });
  });

  it('the page answer without leadId items is unchanged apart from the zero count', async () => {
    await asOwner(db, async () => {
      const job = (await nextJob())!;
      expect(await page(job, [], true)).toEqual({ enqueued: 0, scanned: 0, cursorId: 0, leadLinkRequeued: 0 });
    });
  });
});
