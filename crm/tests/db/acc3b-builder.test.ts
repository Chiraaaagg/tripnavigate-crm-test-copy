import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { PAST_HOTEL_ITEM, PAST_TRIP, SELLING } from './acc-support';
import { ACC, DEAL, MANAGER, PURCHASE, SQL3, SUPER, WORKER, acc3Helpers, rid } from './acc3-support';

/**
 * Accounts phase 3, track B's own database checks (migrations
 * 20261205000200..0230). Track T's acc3-b-* suites are the independent tests;
 * these cover builder details: Off = nothing happens, the manual release of an
 * automatic draft, the sweep and its pending list, and the shapes of the new
 * reads. Every scenario runs in a rolled-back transaction.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = acc3Helpers(() => db);
const { one, owner, refused } = h;

describe('automatic bills (6.2-6.4)', () => {
  it('Off: no automatic draft, no pending row; cdoc_auto_run says off', async () => {
    await asOwner(db, async () => {
      await h.people();
      await h.docsOn();
      const b = await h.book([PAST_HOTEL_ITEM], { trip: { start: PAST_TRIP.start, end: PAST_TRIP.end } });
      await h.approveReal(b.versionId);
      await h.receipt(DEAL, '2500000');
      expect((await h.documents()).filter((d) => d.auto_rule !== null)).toHaveLength(0);
      const [r] = await owner<{ r: { status: string } }>(SQL3.autoRun, [DEAL, 'auto_sweep']);
      expect(r!.r.status).toBe('off');
      expect(await h.pending()).toHaveLength(0);
    });
  });

  it('release Off: ready drafts wait; the manual release clears the automatic state and keeps the person', async () => {
    await asOwner(db, async () => {
      await h.people();
      await h.docsOn();
      await h.autoBills(true, false);
      const b = await h.book([PAST_HOTEL_ITEM], { trip: { start: PAST_TRIP.start, end: PAST_TRIP.end } });
      await h.approveReal(b.versionId);
      const docs = await h.documents();
      const inv = docs.find((d) => d.kind === 'invoice')!;
      expect(inv).toMatchObject({ status: 'draft', auto_rule: 'inv_on_approval', auto_state: 'ready', created_by: null });
      const [full] = await owner<{ row_version: number; content_sha256: string }>(
        'select row_version, content_sha256 from public.customer_documents where id = $1', [inv.id]);
      await one(ACC, SQL3.docRelease, [inv.id, full!.row_version, full!.content_sha256, rid()]);
      const after = (await h.documents()).find((d) => d.id === inv.id)!;
      expect(after).toMatchObject({ status: 'released', auto_state: null, hold_reasons: [], release_rule: null });
      expect(after.released_by).not.toBeNull();
      const deal = await one<{ autoBills: { drafts: boolean; release: boolean }; documents: Array<Record<string, unknown>> }>(ACC, SQL3.dealDocs, [DEAL]);
      expect(deal.autoBills).toEqual({ drafts: true, release: false });
      expect(deal.documents[0]).toMatchObject({ autoRule: 'inv_on_approval', autoState: null, holdReasons: [], releasedByCrm: false });
    });
  });

  it('the sweep is registered every minute and retries a pending Deal', async () => {
    await asOwner(db, async () => {
      const [task] = await owner<{ function_name: string; every_minutes: number }>(
        `select function_name, every_minutes from public.timer_tasks where name = 'customer_documents_auto_sweep'`);
      expect(task).toEqual({ function_name: 'authz.cdoc_auto_sweep', every_minutes: 1 });
      await h.people();
      await h.docsOn();
      await h.autoBills(true, true);
      await owner(`insert into public.cdoc_auto_pending (deal_id, reason_code) values ($1, 'XX000')`, [DEAL]);
      const [r] = await owner<{ r: Record<string, number> }>('select authz.cdoc_auto_sweep() as r');
      expect(r!.r.deals).toBeGreaterThanOrEqual(1);
      expect(await h.pending()).toHaveLength(0);
    });
  });

  it('change_open stub is false; nobody may call the internal functions', async () => {
    await asOwner(db, async () => {
      const [r] = await owner<{ r: boolean }>(SQL3.changeOpen, [DEAL]);
      expect(r!.r).toBe(false);
      for (const sig of ['authz.cdoc_auto_run(uuid,text)', 'authz.deal_change_open(uuid)', 'authz.cdoc_release_core(uuid,uuid,text,uuid)']) {
        for (const role of ['authenticated', 'anon', 'service_role']) expect(await h.canExecute(role, sig), `${role} ${sig}`).toBe(false);
      }
    });
  });
});

describe('settings, reads and the daily check', () => {
  it('admin_accounts_settings carries every switch; setters refuse a bad limit and non-managers', async () => {
    await asOwner(db, async () => {
      const entity = await h.entityId();
      const s = await one<Record<string, unknown>>(SUPER, SQL3.accountsSettings, [entity]);
      expect(s).toMatchObject({ autoBillsEnabled: false, autoBillReleaseEnabled: true, writeOffEnabled: false, writeOffLimitPaise: '500000',
        tallyXmlEnabled: false, tallyCompanyName: null });
      await refused(SUPER, SQL3.setWriteOff, [entity, true, '500001', 'Synthetic reason for the limit'], 'invalid_input', '22023');
      await refused(ACC, SQL3.setAutoBills, [entity, true, true, 'Synthetic reason for the switch'], 'not_authorized', '42501');
    });
  });

  it('small balances: page shape and fence; monthly totals for the Manager; daily check keys', async () => {
    await asOwner(db, async () => {
      await h.people();
      const b = await h.book([PAST_HOTEL_ITEM], { trip: { start: PAST_TRIP.start, end: PAST_TRIP.end } });
      await h.approveReal(b.versionId);
      await h.receipt(DEAL, String(Number(SELLING) - 300));
      await h.writeOffOn(true);
      const page = await one<{ items: Array<Record<string, unknown>>; nextAfter: string | null; hasMore: boolean }>(
        ACC, SQL3.smallBalances, [JSON.stringify({ preset: 'to_propose' }), null, 50]);
      expect((page as unknown as { settings: unknown }).settings).toEqual({ enabled: true, limitPaise: '500000' });
      const docs = await one<{ autoBills: unknown }>(ACC, SQL3.docsList, ['{}', null, 10]);
      expect(docs.autoBills).toEqual({ drafts: false, release: false });
      const row = page.items.find((i) => i.dealId === DEAL)!;
      expect(row).toMatchObject({ direction: 'due', balancePaise: '300', limitPaise: '500000', writeOff: null, blockedBy: [],
        can: { propose: true, approve: false, return: false, withdraw: false, undo: false } });
      expect(Object.keys(row).sort()).toEqual(['balancePaise', 'blockedBy', 'branchName', 'can', 'dealId', 'dealReference', 'direction',
        'limitPaise', 'tripEnd', 'writeOff']);
      expect(await one(PURCHASE, SQL3.smallBalances, ['{}', null, 50])).toBeNull();
      expect(await one(PURCHASE, SQL3.woMonthly, [new Date().toISOString().slice(0, 10)])).toBeNull();
      const monthly = await one<{ month: string; branches: Array<{ branchName: string; count: number }> }>(
        MANAGER, SQL3.woMonthly, [new Date().toISOString().slice(0, 10)]);
      expect(monthly.month).toMatch(/^\d{4}-\d{2}-01$/);
      const check = await one<Record<string, unknown>>(ACC, SQL3.dailyCheck, []);
      for (const k of ['billsHeldOverOneWorkingDay', 'customerMessagesFailedOverOneWorkingDay', 'tallyFileUnmatchedOverOneWorkingDay',
        'messageQueueOldestMinutes', 'writeOffsToReview']) expect(check, k).toHaveProperty(k);
    });
  });
});

describe('backlog control (20261205000260)', () => {
  it('the sweep releases at most 25 bills per tick; event releases render before sweep releases', async () => {
    await asOwner(db, async () => {
      await h.people();
      await h.docsOn();
      await h.autoBills(true, false);
      const b = await h.book([PAST_HOTEL_ITEM], { trip: { start: PAST_TRIP.start, end: PAST_TRIP.end } });
      await h.approveReal(b.versionId);
      for (let i = 0; i < 27; i += 1) await h.receipt(DEAL, String(10000 + i));
      const ready = async () => (await h.documents()).filter((d) => d.status === 'draft' && d.auto_state === 'ready').length;
      expect(await ready()).toBe(28); // 27 Advance Invoices + the Invoice
      // Release switched on by owner SQL (no trigger runs): the sweep alone releases.
      await owner('update public.accounts_settings set auto_bill_release_enabled = true, row_version = row_version + 1');
      const [first] = await owner<{ r: { released: number; ready: number } }>('select authz.cdoc_auto_sweep() as r');
      expect(first!.r.released).toBe(25);
      expect(await ready()).toBe(3);
      const [second] = await owner<{ r: { released: number } }>('select authz.cdoc_auto_sweep() as r');
      expect(second!.r.released).toBe(3);
      expect(await ready()).toBe(0);
      const [prio] = await owner<{ n: number }>(
        'select count(*)::int as n from public.customer_document_render_jobs where priority = 1 and status = \'queued\'');
      expect(prio!.n).toBe(28);
      // A new verified payment: released inside the event, priority 0, claimed before the 28 older sweep jobs.
      await h.receipt(DEAL, '20000');
      // (One test transaction: every job shares now(), so the priority alone orders them here.)
      const events = await owner<{ id: string }>('select id from public.customer_document_render_jobs where priority = 0');
      expect(events).toHaveLength(1);
      const event = events[0];
      const claimed = await one<{ jobId: string }>(WORKER, 'select public.customer_document_render_claim($1, $2) as r', ['acc3b-test', 60]);
      expect(claimed.jobId).toBe(event!.id);
      const next = await one<{ jobId: string }>(WORKER, 'select public.customer_document_render_claim($1, $2) as r', ['acc3b-test', 60]);
      const [oldest] = await owner<{ id: string }>(
        'select id from public.customer_document_render_jobs where priority = 1 order by available_at, created_at, id limit 1');
      expect(next.jobId).toBe(oldest!.id);
    });
  });
});

describe('only from switch-on (Addendum O3, 20261205000270)', () => {
  it('sources older than auto_bills_since are never drafted; new ones are; manual drafts still allowed', async () => {
    await asOwner(db, async () => {
      await h.people();
      await h.docsOn();
      const b = await h.book([PAST_HOTEL_ITEM], { trip: { start: PAST_TRIP.start, end: PAST_TRIP.end } });
      await h.approveReal(b.versionId);
      const old = await h.receipt(DEAL, '10000');
      // One test transaction shares now(): age the earlier sources by a day (owner SQL, triggers off for this statement).
      await db.exec('set local session_replication_role = replica');
      await owner(`update public.customer_receipts set verified_at = verified_at - interval '1 day' where id = $1`, [old.id]);
      await owner(`update public.accounts_booking_reviews set last_approved_at = last_approved_at - interval '1 day' where deal_id = $1`, [DEAL]);
      await db.exec('set local session_replication_role = origin');
      const on = await one<{ autoBillsSince: string | null }>(SUPER, SQL3.setAutoBills, [await h.entityId(), true, false, 'Synthetic reason for the switch']);
      expect(on.autoBillsSince).not.toBeNull();
      await owner(SQL3.autoRun, [DEAL, 'auto_sweep']);
      expect((await h.documents()).filter((d) => d.auto_rule !== null)).toHaveLength(0);
      // Off and On again keeps the first switch-on time.
      await one(SUPER, SQL3.setAutoBills, [await h.entityId(), false, false, 'Synthetic reason for the switch']);
      const again = await one<{ autoBillsSince: string | null }>(SUPER, SQL3.setAutoBills, [await h.entityId(), true, false, 'Synthetic reason for the switch']);
      expect(again.autoBillsSince).toBe(on.autoBillsSince);
      const fresh = await h.receipt(DEAL, '20000');
      const auto = (await h.documents()).filter((d) => d.auto_rule !== null);
      expect(auto.map((d) => [d.kind, d.receipt_id])).toEqual([['advance_invoice', fresh.id]]);
      const manual = await one<{ outcome: string }>(ACC, SQL3.docDraft, [DEAL, 'advance_invoice', JSON.stringify({ receiptId: old.id }), rid()]);
      expect(manual.outcome).toBe('created');
    });
  });
});
