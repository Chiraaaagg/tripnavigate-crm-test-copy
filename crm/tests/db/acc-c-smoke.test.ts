import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, expectDbError } from '../helpers/db';
import { BUDGETS, HOTEL, MANAGER, OWNER, PURCHASE, PURCHASE_CLAIM_SQL, SAVE_ITEM_SQL, TRANSFER } from './b1-support';
import { b11Helpers, rid } from './b11-support';
import { ACC, ACC2, DEAL, SUPER, financeHelpers } from './finance-support';
import { visaHelpers, OWNER as VISA_OWNER } from './visa-e-support';

/**
 * Accounts phase, track C smoke checks (migrations 20261203000400..0430;
 * contract sections 6.3, 7.5, 7.6, 8.4, 8.5, 9): the notices switch, fan-out
 * of a few kinds, actor and Purchase exclusions, shared resolution with one
 * audit row, urgent vs normal marks, the access re-check (bell read and the
 * own-row select policy), the Visa result sync both ways and the Purchase
 * booking-changed signal. Synthetic data only; every scenario runs in a
 * rolled-back owner transaction. Track E owns the full suites.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const f = financeHelpers(() => db);
const v = visaHelpers(() => db);
const { one, owner, run, refused, readyDraft, confirm, readiness } = h;

const INBOX = 'select public.notice_inbox($1, $2) as r';
const COUNT = 'select public.notice_unread_count() as r';
const MARK = 'select public.notice_mark($1, $2) as r';
const MARK_ALL = 'select public.notice_mark_all_read() as r';
const PREFS_SET = 'select public.notice_preferences_set($1::jsonb) as r';
const PREFS_GET = 'select public.notice_preferences_get() as r';
const CHANGE = 'select public.purchase_booking_change($1) as r';
const ACK = 'select public.purchase_booking_change_ack($1, $2, $3) as r';
const HOME = 'select public.purchase_home_counts() as r';
const RETURN = 'select public.accounts_review_return($1, $2, $3) as r';
const OPEN_REVISION = 'select public.booking_open_revision($1) as r';
const CLASSIFY = 'select public.booking_classify_revision($1, $2, $3) as r';

type Item = { noticeId: string; seq: number; kind: string; priority: string; escalated: boolean; readAt: string | null; doneAt: string | null;
  resolvedAt: string | null; resolvedReason: string | null; dealId: string | null; dealReference: string | null; taskId: string | null;
  department: string | null; params: Record<string, unknown>; link: { kind: string; id: string } | null };
type Inbox = { enabled: boolean; unreadCount: number; urgentCount: number; latestSeq: number | null; soundOn: boolean; items: Item[] };
type Row = { recipient_user_id: string; kind: string; priority: string; resolved_reason: string | null; done_at: string | null };

const noticesOn = (on = true) => owner('update public.notice_settings set notices_enabled = $1 where id', [on]);
const inbox = (actor: Actor, after: number | null = null) => one<Inbox>(actor, INBOX, [after, 50]);
const rows = (kind?: string) => owner<Row>(
  `select recipient_user_id, kind, priority, resolved_reason, done_at from public.staff_notices
   where ($1::text is null or kind = $1) order by seq`, [kind ?? null]);
const resolvedAudits = () => owner<{ details: Record<string, unknown> }>(
  `select details from public.audit_events where action = 'notice.resolved' order by id`);

/** A confirmed hotel + transfer package on SYN-DEL-001. */
async function confirmedPackage() {
  const ready = await readyDraft(OWNER, DEAL, [['hotel', HOTEL], ['transfer', TRANSFER]]);
  expect(ready.issues).toEqual([]);
  const confirmed = await confirm(OWNER, ready.versionId, ready.hash);
  return { versionId: ready.versionId, taskIds: confirmed.taskIds! };
}

describe('switch and task notices (9.1 kinds 1, 2; AL13)', () => {
  it('writes nothing while off; the Super Admin setter needs a reason and is audited', async () => {
    await asOwner(db, async () => {
      await confirmedPackage();
      expect(await rows()).toEqual([]);
      expect(await inbox(PURCHASE)).toMatchObject({ enabled: false, unreadCount: 0, items: [] });
      await refused(PURCHASE, 'select public.admin_set_notices_enabled($1, $2) as r', [true, 'Synthetic switch on for test'], '42501');
      await refused(SUPER, 'select public.admin_set_notices_enabled($1, $2) as r', [true, 'short'], '22023');
      expect(await one(SUPER, 'select public.admin_set_notices_enabled($1, $2) as r', [true, 'Synthetic switch on for test']))
        .toMatchObject({ changed: true, before: false, after: true });
      expect(await owner(`select count(*)::int as n from public.audit_events where action = 'settings.notices_changed'`)).toEqual([{ n: 1 }]);
    });
  });

  it('new tasks reach the department, never the actor; taking a task resolves it for everyone with one audit row', async () => {
    await asOwner(db, async () => {
      await noticesOn();
      const { taskIds } = await confirmedPackage();
      const news = await rows('task_new');
      expect(news.map((r) => r.recipient_user_id)).toEqual([U.purchaseJodhpur, U.purchaseJodhpur]);
      expect(news.every((r) => r.priority === 'normal')).toBe(true);
      const box = await inbox(PURCHASE);
      expect(box).toMatchObject({ enabled: true, unreadCount: 2, urgentCount: 0 });
      expect(box.items[0]).toMatchObject({ kind: 'task_new', department: 'purchase', dealReference: 'SYN-DEL-001', link: { kind: 'task' } });
      expect(Object.keys(box.items[0]!.params).sort()).toEqual(['dealReference', 'department', 'serviceType']);

      await one(PURCHASE, PURCHASE_CLAIM_SQL, [taskIds[0]]);
      // Claimed by the person themselves: no "now yours" notice, the new-task notice is taken.
      expect(await rows('task_assigned')).toEqual([]);
      expect((await rows('task_new')).map((r) => r.resolved_reason)).toEqual(['taken', null]);
      expect(await resolvedAudits()).toEqual([{ details: { kind: 'task_new', reason: 'taken', count: 1 } }]);
      expect(await one(PURCHASE, COUNT)).toEqual({ unreadCount: 1, urgentCount: 0 });
      // The basis row of the Booking-changed signal exists from the first assignment.
      expect(await owner('select count(*)::int as n from public.purchase_task_basis where task_id = $1', [taskIds[0]])).toEqual([{ n: 1 }]);
    });
  });
});

describe('review return, revision and the Purchase signal (kinds 3, 4; 7.6, 8.5)', () => {
  it('urgent return notice for the Sales owner, booking change for the assignee, banner, Home count and OK seen', async () => {
    await asOwner(db, async () => {
      await noticesOn();
      const { versionId, taskIds } = await confirmedPackage();
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [taskIds[0]]);
      await one(ACC, RETURN, [versionId, 'Synthetic return: room type is wrong', rid()]);
      const returned = await rows('review_returned');
      expect(returned).toEqual([expect.objectContaining({ recipient_user_id: U.salesDelhiA, priority: 'urgent', resolved_reason: null })]);
      let ownerBox = await inbox(OWNER);
      expect(ownerBox.urgentCount).toBe(1);
      const urgent = ownerBox.items.find((i) => i.kind === 'review_returned')!;
      // "Read" never closes an urgent notice; "Done" does.
      expect(await one<{ doneAt: string | null }>(OWNER, MARK, [urgent.noticeId, 'read'])).toMatchObject({ doneAt: null });
      expect((await inbox(OWNER)).urgentCount).toBe(1);

      // Revision: room type and budget change; confirm.
      const opened = await one<{ versionId: string; rowVersion: number }>(OWNER, OPEN_REVISION, [versionId]);
      const items = await owner<{ id: string }>('select id from public.service_items where deal_id = $1 order by item_no', [DEAL]);
      const rv = (await one<{ rowVersion: number }>(OWNER, SAVE_ITEM_SQL,
        [items[0]!.id, opened.versionId, opened.rowVersion, JSON.stringify({ ...HOTEL, roomType: 'Synthetic Deluxe Room' }), '4600000'])).rowVersion;
      await one(OWNER, CLASSIFY, [opened.versionId, rv, 'format_only']);
      const ready = await readiness(OWNER, opened.versionId);
      expect(ready.issues).toEqual([]);
      await confirm(OWNER, opened.versionId, ready.contentHash);

      expect((await rows('review_returned'))[0]!.resolved_reason).toBe('revised');
      ownerBox = await inbox(OWNER);
      expect(ownerBox.urgentCount).toBe(0);
      const changed = await rows('booking_changed');
      expect(changed).toEqual([expect.objectContaining({ recipient_user_id: U.purchaseJodhpur, priority: 'urgent' })]);

      // Banner: the room type and a budget flag; nothing commercial.
      const change = await one<Record<string, unknown>>(PURCHASE, CHANGE, [taskIds[0]]);
      expect(change).toMatchObject({ taskId: taskIds[0], basisVersionId: versionId, currentVersionId: opened.versionId,
        basisVersionNo: 1, currentVersionNo: 2, canAck: true, budgetChanged: true, tripChanged: null,
        fields: [{ key: 'roomType', before: 'Synthetic Deluxe', after: 'Synthetic Deluxe Room' }],
        travellers: { added: [], removed: [], renamed: [], typeChanged: [] } });
      expect(JSON.stringify(change)).not.toMatch(/paise|4600000|4500000|9876543|selling|price/i);
      expect(await one(MANAGER, CHANGE, [taskIds[0]])).toMatchObject({ canAck: false });
      expect(await one(OWNER, CHANGE, [taskIds[0]])).toBeNull();
      expect(await one(PURCHASE, HOME)).toEqual({ purchaseBookingChanged: 1, purchaseBookingChangedTaskId: taskIds[0] });
      expect(await one(OWNER, HOME)).toBeNull();

      // OK, seen: stale basis refused; the right one moves the basis and closes the notice.
      await refused(PURCHASE, ACK, [taskIds[0], opened.versionId, rid()], '40001', 'version_changed');
      await refused(MANAGER, ACK, [taskIds[0], versionId, rid()], '42501', 'not_authorized');
      const req = rid();
      expect(await one(PURCHASE, ACK, [taskIds[0], versionId, req])).toMatchObject({ outcome: 'updated', basisVersionId: opened.versionId, rowVersion: 2 });
      expect(await one(PURCHASE, ACK, [taskIds[0], versionId, req])).toMatchObject({ outcome: 'existing' });
      expect(await one(PURCHASE, CHANGE, [taskIds[0]])).toBeNull();
      expect(await one(PURCHASE, HOME)).toEqual({ purchaseBookingChanged: 0, purchaseBookingChangedTaskId: null });
      expect((await rows('booking_changed'))[0]!.done_at).not.toBeNull();
      expect(await owner(`select count(*)::int as n from public.audit_events where action = 'purchase.booking_change_seen'`)).toEqual([{ n: 1 }]);
    });
  });
});

describe('money notices (kind 10): maker excluded, Accounts + Purchase excluded, shared resolution', () => {
  it('a recorded receipt reaches the other Accounts person only and resolves for everyone on verification', async () => {
    await asOwner(db, async () => {
      await noticesOn();
      await f.addSecondAccounts();
      await f.confirmedBooking();
      const rec = await f.record(ACC, DEAL, await f.bankFields());
      const notices = await rows('receipt_to_verify');
      expect(notices).toEqual([expect.objectContaining({ recipient_user_id: U.visaJodhpur, priority: 'normal' })]);
      const item = (await inbox(ACC2)).items.find((i) => i.kind === 'receipt_to_verify')!;
      expect(item).toMatchObject({ escalated: false, link: { kind: 'accounts_deal', id: DEAL } });
      expect(item.params).toMatchObject({ refNo: expect.stringMatching(/^R-/) });
      await f.proof(ACC, 'receipt', rec.id, 'bank_proof');
      await f.verify(ACC2, rec.id);
      expect((await rows('receipt_to_verify'))[0]!.resolved_reason).toBe('acted');
      expect((await resolvedAudits()).at(-1)).toEqual({ details: { kind: 'receipt_to_verify', reason: 'acted', count: 1 } });
    });
  });

  it('an Accounts person who also holds Purchase gets no money notice', async () => {
    await asOwner(db, async () => {
      await noticesOn();
      await f.addSecondAccounts();
      await owner(`insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
                   select $1, b.legal_entity_id, b.id, 'purchase', 'active' from public.branches b where b.code = 'JDH'`, [U.visaJodhpur]);
      await f.confirmedBooking();
      await f.record(ACC, DEAL, await f.bankFields());
      expect(await rows('receipt_to_verify')).toEqual([]);
    });
  });
});

describe('marks, preferences, re-check and the select policy (8.4, 6.3.1)', () => {
  it('mark all read leaves urgent; preferences are personal; params allowlist is enforced', async () => {
    await asOwner(db, async () => {
      await noticesOn();
      const { versionId } = await confirmedPackage();
      await one(ACC, RETURN, [versionId, 'Synthetic return: dates are wrong', rid()]);
      // Purchase holds two normal new-task notices; the owner one urgent return notice.
      expect(await one(PURCHASE, MARK_ALL)).toEqual({ count: 2 });
      expect(await one(PURCHASE, COUNT)).toEqual({ unreadCount: 0, urgentCount: 0 });
      expect(await one(OWNER, MARK_ALL)).toEqual({ count: 0 });
      expect(await one(OWNER, COUNT)).toEqual({ unreadCount: 1, urgentCount: 1 });
      const [n] = (await inbox(OWNER)).items;
      expect(await one(OWNER, MARK, [n!.noticeId, 'done'])).toMatchObject({ noticeId: n!.noticeId, doneAt: expect.any(String) });
      await refused(PURCHASE, MARK, [n!.noticeId, 'done'], 'P0002', 'not_found');
      await refused(OWNER, MARK, [n!.noticeId, 'delete'], '22023', 'invalid_input');

      // Accounts phase 2 (Q12, 8.5): sound and pop-ups ON for people without a row; each person's choice is theirs.
      expect(await one(OWNER, PREFS_GET)).toEqual({ soundOn: true, popupsOn: true });
      expect(await one(OWNER, PREFS_SET, [JSON.stringify({ soundOn: false })])).toMatchObject({ soundOn: false });
      expect(await one(OWNER, PREFS_GET)).toEqual({ soundOn: false, popupsOn: true });
      expect(await one(PURCHASE, PREFS_GET)).toEqual({ soundOn: true, popupsOn: true });
      await refused(OWNER, PREFS_SET, [JSON.stringify({ soundOn: 'yes' })], '22023', 'invalid_input');

      await expectDbError(db, () => owner(
        `insert into public.staff_notices (legal_entity_id, recipient_user_id, kind, priority, subject_kind, subject_id, params, dedup_key)
         select d.legal_entity_id, $1, 'review_approved', 'normal', 'deal', d.id, '{"name":"Synthetic Person"}', 'x' from public.deals d where d.id = $2`,
        [U.salesDelhiA, DEAL]), { code: '23514' });
      // Nothing is deleted or rewritten.
      await expectDbError(db, () => owner('delete from public.staff_notices'), { code: '42501' });
      await expectDbError(db, () => owner(`update public.staff_notices set kind = 'task_new'`), { code: '42501' });
    });
  });

  it('hides notices whose recipient no longer qualifies, at read and through the select policy', async () => {
    await asOwner(db, async () => {
      await noticesOn();
      const { versionId } = await confirmedPackage();
      await one(ACC, RETURN, [versionId, 'Synthetic return: hotel is wrong', rid()]);
      expect((await run<{ n: number }>(OWNER, 'select count(*)::int as n from public.staff_notices'))[0]!.n).toBe(1);
      expect((await run<{ n: number }>(PURCHASE, 'select count(*)::int as n from public.staff_notices'))[0]!.n).toBe(2);
      // No write grant.
      await refused(OWNER, `update public.staff_notices set read_at = now()`, [], '42501');
      // The owner loses the Sales role: hidden and uncounted, row still present.
      await owner(`update public.memberships set status = 'inactive', deactivated_at = now()
                   where user_id = $1 and role_code = 'sales'`, [U.salesDelhiA]);
      await owner(`insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
                   select $1, b.legal_entity_id, b.id, 'manager', 'active' from public.branches b where b.code = 'AMD'`, [U.salesDelhiA]);
      expect(await inbox(OWNER)).toMatchObject({ unreadCount: 0, items: [] });
      expect((await run<{ n: number }>(OWNER, 'select count(*)::int as n from public.staff_notices'))[0]!.n).toBe(0);
      expect(await rows('review_returned')).toHaveLength(1);
      // The Purchase person leaves Purchase: task notices hidden too.
      await owner(`update public.memberships set status = 'inactive', deactivated_at = now() where user_id = $1`, [U.purchaseJodhpur]);
      await owner(`insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
                   select $1, b.legal_entity_id, b.id, 'sales', 'active' from public.branches b where b.code = 'JDH'`, [U.purchaseJodhpur]);
      expect(await one(PURCHASE, COUNT)).toEqual({ unreadCount: 0, urgentCount: 0 });
    });
  });
});

describe('Tally exception (kind 25)', () => {
  it('goes to every Accounts person while no exception owner is set and resolves when the exception clears', async () => {
    await asOwner(db, async () => {
      await noticesOn();
      const [tr] = await owner<{ id: string }>(
        `insert into public.tally_records (legal_entity_id, branch_id, deal_id, record_kind, record_id, status, exception_reason,
           exception_by, exception_at, status_before_exception)
         select d.legal_entity_id, d.branch_id, d.id, 'supplier_document', gen_random_uuid(), 'exception',
                'Synthetic exception reason', $2, now(), 'ready'
         from public.deals d where d.id = $1 returning id`, [DEAL, U.accountsJodhpur]);
      expect(await rows('tally_exception')).toEqual([expect.objectContaining({ recipient_user_id: U.accountsJodhpur, priority: 'normal' })]);
      const item = (await inbox(ACC)).items.find((i) => i.kind === 'tally_exception')!;
      expect(item).toMatchObject({ params: { status: 'supplier_document' }, link: { kind: 'workspace_row', id: tr!.id } });
      await owner(`update public.tally_records set status = 'exported', exception_reason = null, exception_by = null, exception_at = null,
                     status_before_exception = null, row_version = row_version + 1 where id = $1`, [tr!.id]);
      expect((await rows('tally_exception'))[0]!.resolved_reason).toBe('acted');
    });
  });
});

describe('Addendum L1 fixes (20261203000450)', () => {
  /** Returns the confirmed package, opens a revision and saves one item with the given facts, then confirms it. */
  async function revise(versionId: string, item: 0 | 1, facts: unknown, budget: string) {
    const opened = await one<{ versionId: string; rowVersion: number }>(OWNER, OPEN_REVISION, [versionId]);
    const items = await owner<{ id: string }>('select id from public.service_items where deal_id = $1 order by item_no', [DEAL]);
    const rv = (await one<{ rowVersion: number }>(OWNER, SAVE_ITEM_SQL,
      [items[item]!.id, opened.versionId, opened.rowVersion, JSON.stringify(facts), budget])).rowVersion;
    await one(OWNER, CLASSIFY, [opened.versionId, rv, 'format_only']);
    const ready = await readiness(OWNER, opened.versionId);
    expect(ready.issues).toEqual([]);
    await confirm(OWNER, opened.versionId, ready.contentHash);
    return opened.versionId;
  }

  it('L1-2: a notice written while on is resolved while off', async () => {
    await asOwner(db, async () => {
      await noticesOn();
      const { taskIds } = await confirmedPackage();
      await noticesOn(false);
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [taskIds[0]]);
      await noticesOn();
      expect((await rows('task_new')).map((r) => r.resolved_reason)).toEqual(['taken', null]);
      expect(await one(PURCHASE, COUNT)).toEqual({ unreadCount: 1, urgentCount: 0 });
    });
  });

  it('L1-4: only the changed item gets the urgent notice and the banner; an empty diff never shows', async () => {
    await asOwner(db, async () => {
      await noticesOn();
      const { versionId, taskIds } = await confirmedPackage();
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [taskIds[0]]);
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [taskIds[1]]);
      await one(ACC, RETURN, [versionId, 'Synthetic return: vehicle is wrong', rid()]);
      // Only the transfer (item 2) changes.
      const v2 = await revise(versionId, 1, { ...TRANSFER, vehicleType: 'SUV' }, BUDGETS.transfer!);
      const changed = await owner<{ task_id: string }>(`select task_id from public.staff_notices where kind = 'booking_changed'`);
      expect(changed.map((r) => r.task_id)).toEqual([taskIds[1]]);
      expect(await one(PURCHASE, CHANGE, [taskIds[0]])).toBeNull();
      expect(await one(PURCHASE, CHANGE, [taskIds[1]])).toMatchObject({ fields: [{ key: 'vehicleType', before: 'Sedan', after: 'SUV' }] });
      expect(await one(PURCHASE, HOME)).toMatchObject({ purchaseBookingChanged: 1, purchaseBookingChangedTaskId: taskIds[1] });
      // A hash change with nothing visible (same facts, same budget): still no banner, no Home count for the hotel.
      // Synthetic only: bypass the immutability guard and rehash trigger inside the rolled-back transaction.
      await owner('alter table public.service_item_facts disable trigger service_item_facts_a_guard');
      await owner('alter table public.service_item_facts disable trigger service_item_facts_b_rehash');
      await owner(`update public.service_item_facts set facts_hash = repeat('f', 64)
                   where booking_version_id = $1 and service_item_id = (select service_item_id from public.fulfilment_tasks where id = $2)`,
        [v2, taskIds[0]]);
      expect(await one(PURCHASE, CHANGE, [taskIds[0]])).toBeNull();
      expect(await one(PURCHASE, HOME)).toMatchObject({ purchaseBookingChanged: 1 });
    });
  });

  it('L1-6: an exception raised by the exception owner goes to the other Accounts people', async () => {
    await asOwner(db, async () => {
      await noticesOn();
      await f.addSecondAccounts();
      await owner(`insert into public.accounts_settings (legal_entity_id, exception_owner_user_id)
                   select d.legal_entity_id, $2 from public.deals d where d.id = $1`, [DEAL, U.accountsJodhpur]);
      await owner(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: U.accountsJodhpur, role: 'authenticated' })]);
      await owner(
        `insert into public.tally_records (legal_entity_id, branch_id, deal_id, record_kind, record_id, status, exception_reason,
           exception_by, exception_at, status_before_exception)
         select d.legal_entity_id, d.branch_id, d.id, 'expense', gen_random_uuid(), 'exception', 'Synthetic exception reason', $2, now(), 'ready'
         from public.deals d where d.id = $1`, [DEAL, U.accountsJodhpur]);
      await owner(`select set_config('request.jwt.claims', '', true)`);
      expect((await rows('tally_exception')).map((r) => r.recipient_user_id)).toEqual([U.visaJodhpur]);
    });
  });

  it('L1-7: a Sales owner who also holds Purchase is not SO*; the branch Manager is', async () => {
    await asOwner(db, async () => {
      await noticesOn();
      const { versionId } = await confirmedPackage();
      await owner(`insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
                   select $1, b.legal_entity_id, b.id, 'purchase', 'active' from public.branches b where b.code = 'JDH'`, [U.salesDelhiA]);
      await one(ACC, RETURN, [versionId, 'Synthetic return: owner holds purchase', rid()]);
      expect((await rows('review_returned')).map((r) => r.recipient_user_id)).toEqual([U.managerDelhi]);
      expect((await inbox(MANAGER)).items.map((i) => i.kind)).toContain('review_returned');
    });
  });

  it('L1-8: recipients cannot read the actor column (direct select); other columns stay readable', async () => {
    await asOwner(db, async () => {
      await noticesOn();
      await confirmedPackage();
      await refused(PURCHASE, 'select actor_user_id from public.staff_notices', [], '42501');
      await refused(PURCHASE, 'select * from public.staff_notices', [], '42501');
      expect((await run<{ kind: string }>(PURCHASE, 'select kind from public.staff_notices')).map((r) => r.kind)).toEqual(['task_new', 'task_new']);
      expect(await owner(`select has_column_privilege('authenticated', 'public.staff_notices', 'actor_user_id', 'select') as a,
                                 has_column_privilege('authenticated', 'public.staff_notices', 'recipient_user_id', 'select') as r`))
        .toEqual([{ a: false, r: true }]);
    });
  });
});

describe('Visa results in the bell (kind 24, C14)', () => {
  it('a result reaches the Sales owner; the bell marks the card seen and the card marks the bell done', async () => {
    await asOwner(db, async () => {
      await noticesOn();
      const { taskId } = await v.stickerTask();
      const a1 = await v.appliedAlone(taskId, 1);
      await v.decide(taskId, a1, 'approved');
      const a2 = await v.appliedAlone(taskId, 2);
      await v.decide(taskId, a2, 'rejected');
      const bell = await rows('visa_result');
      expect(bell.map((r) => r.recipient_user_id)).toEqual([U.salesDelhiA, U.salesDelhiA]);
      const box = await inbox(VISA_OWNER);
      const [first, second] = box.items.filter((i) => i.kind === 'visa_result').sort((a, b) => a.seq - b.seq);
      expect(first).toMatchObject({ department: 'visa', params: { status: 'approved' }, link: { kind: 'deal' } });
      // Bell -> card.
      await one(VISA_OWNER, MARK, [first!.noticeId, 'open']);
      expect(await owner('select seen_by from public.visa_result_notices where application_id = $1', [a1.applicationId]))
        .toEqual([{ seen_by: U.salesDelhiA }]);
      // Card -> bell.
      const [card] = await owner<{ id: string }>('select id from public.visa_result_notices where application_id = $1', [a2.applicationId]);
      await one(VISA_OWNER, 'select public.visa_result_notice_ack($1) as r', [card!.id]);
      expect((await owner<{ done_at: string | null }>('select done_at from public.staff_notices where id = $1', [second!.noticeId]))[0]!.done_at)
        .not.toBeNull();
    });
  });

  it('owner holding Sales + Purchase: the branch Manager gets the result and the bell marks the card seen (20261203000460)', async () => {
    await asOwner(db, async () => {
      await noticesOn();
      const { taskId } = await v.stickerTask();
      const a1 = await v.appliedAlone(taskId, 1);
      await owner(`insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
                   select $1, b.legal_entity_id, b.id, 'purchase', 'active' from public.branches b where b.code = 'JDH'`, [U.salesDelhiA]);
      await v.decide(taskId, a1, 'approved');
      expect((await rows('visa_result')).map((r) => r.recipient_user_id)).toEqual([U.managerDelhi]);
      const item = (await inbox(MANAGER)).items.find((i) => i.kind === 'visa_result')!;
      await one(MANAGER, MARK, [item.noticeId, 'open']);
      expect(await owner('select seen_by from public.visa_result_notices where application_id = $1', [a1.applicationId]))
        .toEqual([{ seen_by: U.managerDelhi }]);
    });
  });
});
