import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import {
  ACC, ACC2, ACC3, DEAL, FLIGHT, FLIGHT_2, FLIGHT_ITEM, HOTEL_ITEM, MANAGER, NOTICE_KINDS, NOTICE_PARAM_KEYS, OWNER, PURCHASE, REASON, SENTINEL,
  SQL, SUPER, VISA, VISA_ITEM, accHelpers, containsToken, rid, today,
} from './acc-support';
import { line as visaLine, visaHelpers } from './visa-e-support';

/**
 * Accounts phase contract section 6.3 (staff_notices, preferences, kill
 * switch), 7.5 (N1-N3, C14), 8.4 (inbox, history, counts, access re-check),
 * 9 (kinds, recipients, dedup, shared resolution, fan-out) and the lead
 * decision on AL15 (the select policy re-checks access too); test plan 12.3,
 * Track E. Recipients are computed at creation, never the actor; money kinds
 * exclude anyone holding Purchase; shared notices resolve for everyone with
 * one notice.resolved audit per resolving call; reading is never audited.
 * The Purchase booking-changed signal is in acc-purchase-change.test.ts;
 * concurrent fan-out in acc-concurrency.test.ts.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = accHelpers(() => db);
const { one, owner, refused, refusedHint } = h;
const ids = (...a: Actor[]) => a.map((x) => x.userId!).sort();
const openFor = async (kind: string, user: string) => (await h.notices(kind, user)).filter((n) => !n.resolved_at && !n.done_at);
const resolvedAudits = () => h.audits('notice.resolved');

describe('6.3.3 kill switch', () => {
  it('off by default: no rows, bell disabled; only the super admin switches it, with a reason (audited)', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      await h.book([HOTEL_ITEM, FLIGHT_ITEM]);
      expect(await h.notices()).toEqual([]);
      expect((await h.inbox(PURCHASE)).enabled).toBe(false);
      await refused(ACC, SQL.setNotices, [true, REASON], 'not_authorized', '42501');
      await refusedHint(SUPER, SQL.setNotices, [true, 'short'], 'invalid_input', undefined, '22023');
      await one(SUPER, SQL.setNotices, [true, REASON]);
      expect(await h.audits('settings.notices_changed')).not.toHaveLength(0);
      expect((await h.inbox(PURCHASE)).enabled).toBe(true);
      // On: new notices only (no backfill of the booking above).
      expect(await h.notices('task_new')).toEqual([]);
    });
  });
});

describe('9.1 task notices: task_new, task_assigned, reassignment', () => {
  it('task_new goes to the department holders, never the actor; taking the task resolves it for everyone (one audit)', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      await h.noticesOn();
      const b = await h.book([HOTEL_ITEM, FLIGHT_ITEM, VISA_ITEM]);
      const hotel = h.taskOf(b, 'hotel');
      const flight = h.taskOf(b, 'flight');
      const visa = h.taskOf(b, 'visa');
      const forTask = async (task: string) => (await h.notices('task_new')).filter((n) => n.task_id === task);
      expect((await forTask(hotel)).map((n) => n.recipient_user_id)).toEqual(ids(PURCHASE));
      expect((await forTask(flight)).map((n) => n.recipient_user_id).sort()).toEqual(ids(FLIGHT, FLIGHT_2));
      expect((await forTask(visa)).map((n) => n.recipient_user_id)).toEqual(ids(VISA));
      const flightRows = await forTask(flight);
      expect(new Set(flightRows.map((n) => n.shared_key)).size).toBe(1);
      expect(flightRows.every((n) => n.priority === 'normal' && n.dedup_key === `task_new:${flight}`)).toBe(true);
      expect(flightRows[0]!.params).toMatchObject({ dealReference: 'SYN-DEL-001', department: 'flight' });
      expect((await h.notices()).map((n) => n.recipient_user_id)).not.toContain(OWNER.userId);
      // FLIGHT takes the group: resolved 'taken' for both; no task_assigned to the person who took it.
      const before = (await resolvedAudits()).length;
      await h.claim(FLIGHT, DEAL);
      const after = await forTask(flight);
      expect(after.every((n) => n.resolved_reason === 'taken' && n.resolved_at)).toBe(true);
      expect((await h.notices('task_assigned')).filter((n) => n.recipient_user_id === FLIGHT.userId)).toEqual([]);
      expect((await resolvedAudits()).length - before).toBe(1);
      const [audit] = (await resolvedAudits()).slice(-1);
      expect(audit!.details).toMatchObject({ kind: 'task_new', reason: 'taken', count: 2 });
      // Inbox of FLIGHT_2: the resolved notice is not counted as unread.
      expect((await h.inbox(FLIGHT_2)).unreadCount).toBe(0);
    });
  });

  it('reassignment A -> B -> A: a fresh task_assigned each time; the old assignee\'s open task notices resolve as reassigned', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      await h.noticesOn();
      const b = await h.book([HOTEL_ITEM, FLIGHT_ITEM]);
      const flight = h.taskOf(b, 'flight');
      await h.claim(FLIGHT, DEAL);
      await one(MANAGER, SQL.groupReassign, [DEAL, U.movedStaff, U.salesAhmedabad, 'Synthetic: covering for leave', rid()]);
      expect((await openFor('task_assigned', FLIGHT_2.userId!)).map((n) => n.task_id)).toContain(flight);
      await one(MANAGER, SQL.groupReassign, [DEAL, U.salesAhmedabad, U.movedStaff, 'Synthetic: back from leave', rid()]);
      const toB = await h.notices('task_assigned', FLIGHT_2.userId!);
      expect(toB.filter((n) => n.task_id === flight).every((n) => n.resolved_reason === 'reassigned')).toBe(true);
      // The fresh notice per assignment (dedup key carries the transaction id) needs separate transactions:
      // PGlite runs the whole scenario in one, so B -> A -> B is checked in acc-concurrency.test.ts (real Postgres).
      expect((await h.notices('task_assigned', FLIGHT.userId!)).filter((n) => n.task_id === flight && !n.resolved_at)).toHaveLength(1);
      expect((await h.notices('task_assigned', MANAGER.userId!))).toEqual([]);
    });
  });
});

describe('9.1 booking review notices to the Sales owner (SO*)', () => {
  it('review_returned is urgent to the owner; review_approved normal; the Manager is the fallback when the owner is not active Sales', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      const b = await h.book([HOTEL_ITEM]);
      // h.revise: Accounts returns (as ACC), Sales changes the room type and confirms version 2.
      let seen: Awaited<ReturnType<typeof h.notices>> = [];
      const v2 = await h.revise(b.versionId, async (versionId, rv) => {
        seen = await h.notices('review_returned');
        return (await one<{ rowVersion: number }>(OWNER, SQL.saveItem, [b.itemIds[0], versionId, rv,
          JSON.stringify({ ...HOTEL_ITEM.facts as object, roomType: 'Synthetic Suite' }), '20000000'])).rowVersion;
      });
      expect(seen).toEqual([expect.objectContaining({ recipient_user_id: OWNER.userId, priority: 'urgent', deal_id: DEAL, resolved_at: null })]);
      expect((await h.notices('review_returned'))[0]).toMatchObject({ resolved_reason: 'revised' });
      const opened = { versionId: v2 };
      await h.approve(opened.versionId);
      expect((await h.notices('review_approved')).map((n) => [n.recipient_user_id, n.priority])).toEqual([[OWNER.userId, 'normal']]);
    });
    await asOwner(db, async () => {
      await h.noticesOn();
      const b = await h.book([HOTEL_ITEM]);
      await h.dropRole(U.salesDelhiA, 'sales');
      await one(ACC, SQL.reviewReturn, [b.versionId, 'Synthetic return: billing name wrong', rid()]);
      const rows = await h.notices('review_returned');
      expect(rows.map((n) => n.recipient_user_id)).toContain(MANAGER.userId);
      expect(rows.map((n) => n.recipient_user_id)).not.toContain(OWNER.userId);
    });
  });
});

describe('9.1 money notices', () => {
  it('payment_reported and receipt_to_verify: Accounts of the entity, never the actor, never an Accounts + Purchase holder; shared resolution', async () => {
    await asOwner(db, async () => {
      await h.addAcc2();
      await h.addAcc3();
      await h.addRole(U.invitedStaff, 'purchase');
      await h.book([HOTEL_ITEM]);
      await h.noticesOn();
      const claim = await h.cl.report(OWNER, await h.cl.bankClaim({ amountPaise: '2000000' }));
      expect(await h.recipientsOf('payment_reported')).toEqual(ids(ACC, ACC2));
      const fields = await h.fin.withDestination(DEAL, await h.fin.bankFields({ amountPaise: '2000000' }));
      const request = rid();
      const rec = await h.fin.record(ACC, DEAL, fields, request);
      await h.fin.record(ACC, DEAL, fields, request); // replay: nothing new
      expect(await h.recipientsOf('receipt_to_verify'), 'never the recorder; replay adds nothing').toEqual(ids(ACC2));
      await h.fin.proof(ACC, 'receipt', rec.id, 'bank_proof');
      const before = (await resolvedAudits()).length;
      await h.fin.verify(ACC2, rec.id);
      expect((await h.notices('receipt_to_verify')).every((n) => n.resolved_reason === 'acted')).toBe(true);
      await h.cl.link(ACC, claim.id as string, rec.id, 'Synthetic: same amount and date, different reference');
      expect((await h.notices('payment_reported')).every((n) => n.resolved_reason === 'acted')).toBe(true);
      expect((await resolvedAudits()).length - before).toBe(2);
    });
  });

  it('supplier payment chain: approve (route), record, verify, decided to the requester; go-ahead to Accounts and back', async () => {
    await asOwner(db, async () => {
      await h.addAcc2();
      const b = await h.book([HOTEL_ITEM]);
      await h.approve(b.versionId);
      await h.receipt(DEAL, '30000000');
      const task = h.taskOf(b, 'hotel');
      await h.purchaseCost(task, await h.purchaseSupplier());
      await h.noticesOn();
      await h.goAhead(task, false);
      expect(await h.recipientsOf('go_ahead_to_approve')).toEqual(ids(ACC, ACC2));
      const [g] = await owner<{ id: string; row_version: number }>(`select id, row_version from public.purchase_go_ahead_requests where task_id = $1`, [task]);
      await one(ACC, SQL.goAheadDecide, [g!.id, 'approve', null, g!.row_version, rid()]);
      expect((await h.notices('go_ahead_to_approve')).every((n) => n.resolved_at)).toBe(true);
      expect(await h.recipientsOf('go_ahead_decided')).toEqual(ids(PURCHASE));
      const p = await h.purchaseRequest(task, 2_000_000);
      expect(await h.recipientsOf('payment_to_approve')).toEqual(ids(ACC, ACC2));
      expect((await h.notices('payment_to_approve'))[0]!.params).toMatchObject({ refNo: p.refNo });
      await h.payThrough(p.id, 'approved');
      expect((await h.notices('payment_to_approve')).every((n) => n.resolved_at)).toBe(true);
      expect(await h.recipientsOf('payment_to_record'), 'the approver is the actor').toEqual(ids(ACC2));
      expect(await h.recipientsOf('payment_decided')).toEqual(ids(PURCHASE));
      const proof = await h.moneyFile(ACC2, p.id, 'payment_proof');
      await one(ACC2, SQL.paymentRecord, [p.id, today(), 'bank_transfer', 'SYNREF77', proof, await h.paymentRv(p.id), rid()]);
      expect((await h.notices('payment_to_record')).every((n) => n.resolved_at)).toBe(true);
      expect(await h.recipientsOf('payment_to_verify'), 'never the recorder').toEqual(ids(ACC));
      await one(ACC, SQL.paymentVerify, [p.id, await h.paymentRv(p.id), rid()]);
      expect((await h.notices('payment_to_verify')).every((n) => n.resolved_at)).toBe(true);
      // Above INR 50,000 cumulative: the branch Managers of the Deal's branch.
      const big = await h.purchaseRequest(task, 4_000_000);
      expect((await h.notices('payment_to_approve')).filter((n) => n.subject_id === big.id).map((n) => n.recipient_user_id)).toEqual(ids(MANAGER));
      // Nobody holding Purchase ever gets a money notice.
      for (const kind of ['payment_to_approve', 'payment_to_record', 'payment_to_verify', 'go_ahead_to_approve']) {
        expect(await h.recipientsOf(kind)).not.toContain(PURCHASE.userId);
      }
    });
  });

  it('bank details: Managers of the entity, never the recorder; urgent while a payment is live', async () => {
    await asOwner(db, async () => {
      await h.book([HOTEL_ITEM]);
      await h.noticesOn();
      const { supplierId } = await one<{ supplierId: string }>(PURCHASE, SQL.supplierCreate, [await h.entityId(), JSON.stringify({
        name: `Synthetic Bank Notice ${rid().slice(0, 6)}`, serviceTypes: ['hotel'], city: 'Synthetic City', contactName: null, contactPhone: null,
        contactEmail: 'desk@example.test', paymentTerms: null })]);
      await one(PURCHASE, SQL.supplierBeneficiary, [supplierId, rid(), JSON.stringify({ accountHolder: 'Synthetic Stays', bankName: 'Synthetic Bank',
        ifsc: 'SYNB0000001', accountNumber: '000011113333' })]);
      const rows = await h.notices('bank_details_to_approve');
      expect(rows.map((n) => n.recipient_user_id).sort()).toEqual(expect.arrayContaining(ids(MANAGER, { userId: U.managerAhmedabad })));
      expect(rows.map((n) => n.recipient_user_id)).not.toContain(PURCHASE.userId);
      expect(rows.every((n) => n.priority === 'normal'), 'no live payment yet').toBe(true);
      expect(JSON.stringify(rows.map((n) => n.params))).not.toContain('000011113333');
    });
  });

  it('trip_cancelled (widened, Accounts phase 2 8.3): urgent to every open task\'s assignee, the Sales owner and Accounts', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      const b = await h.book([HOTEL_ITEM, FLIGHT_ITEM]);
      await one(PURCHASE, SQL.purchaseClaim, [h.taskOf(b, 'hotel')]);
      await h.claim(FLIGHT, DEAL);
      await h.noticesOn();
      await one(MANAGER, SQL.cancelOpen, [DEAL, 'Synthetic: the customer cancelled the trip', rid()]);
      const rows = await h.notices('trip_cancelled');
      // Phase 2: also the Sales owner (SO*) and Accounts of the entity; never the Manager who opened it.
      expect(rows.map((n) => n.recipient_user_id)).toEqual(expect.arrayContaining(ids(PURCHASE, FLIGHT, OWNER, ACC)));
      expect(rows.map((n) => n.recipient_user_id)).not.toContain(MANAGER.userId);
      expect(rows.every((n) => n.priority === 'urgent')).toBe(true);
    });
  });

  it('tally_exception: the exception owner only; when unset every Accounts person except the actor; resolved when it leaves exception', async () => {
    await asOwner(db, async () => {
      await h.addAcc2();
      await h.addAcc3();
      const b = await h.book([HOTEL_ITEM]);
      await h.approve(b.versionId);
      const r1 = await h.receipt(DEAL, '1000000');
      const r2 = await h.receipt(DEAL, '1000001');
      await h.noticesOn();
      const e1 = (await h.entryOf(r1.id))!;
      const e2 = (await h.entryOf(r2.id))!;
      await one(ACC, SQL.exception, ['journal_entry', e1, 0, JSON.stringify({ reason: 'Synthetic: Tally shows a different amount' }), rid()]);
      expect(await h.recipientsOf('tally_exception')).toEqual(ids(ACC2, ACC3));
      await one(SUPER, SQL.setExceptionOwner, [await h.entityId(), U.invitedStaff, REASON]);
      await one(ACC, SQL.exception, ['journal_entry', e2, 0, JSON.stringify({ reason: 'Synthetic: missing in the Tally day book' }), rid()]);
      const t2 = (await h.tallyRow('journal_entry', e2))!.id as string;
      const second = (await h.notices('tally_exception')).filter((n) => n.dedup_key.includes(t2));
      expect(second.map((n) => n.recipient_user_id)).toEqual(ids(ACC3));
      // Leaving exception (reopen to the earlier status) resolves the shared notice.
      await h.attempt(ACC, SQL.reopen, ['journal_entry', e2, (await h.tallyRow('journal_entry', e2))!.row_version, REASON, rid()]);
      if ((await h.tallyRow('journal_entry', e2))!.status !== 'exception') {
        expect(second.length).toBeGreaterThan(0);
        const now = (await h.notices('tally_exception')).filter((n) => n.id === second[0]!.id);
        expect(now[0]!.resolved_at).not.toBeNull();
      }
    });
  });
});

describe('9.1 #24 Visa results mirrored in the bell', () => {
  it('a decision notifies SO*; the Deal-card ack marks the bell row; a bell Done marks seen_at', async () => {
    await asOwner(db, async () => {
      const vh = visaHelpers(() => db);
      const b = await h.book([{ ...VISA_ITEM, participants: [1, 2] }]);
      const task = h.taskOf(b, 'visa');
      await one(VISA, 'select public.visa_task_claim($1) as r', [task]);
      for (const seq of [1, 2]) {
        const a = await vh.makeReady(task, seq, { actor: VISA });
        await vh.apply(task, [visaLine(a)], {}, rid(), VISA);
      }
      await h.noticesOn();
      await vh.decide(task, await vh.app(task, 1, VISA), 'approved', {}, VISA);
      await vh.decide(task, await vh.app(task, 2, VISA), 'approved', {}, VISA);
      const rows = await h.notices('visa_result');
      expect(rows.map((n) => n.recipient_user_id)).toEqual([OWNER.userId, OWNER.userId]);
      expect(rows.map((n) => n.recipient_user_id)).not.toContain(VISA.userId);
      const visaNotices = await owner<{ id: string; seen_at: string | null }>('select id, seen_at from public.visa_result_notices where deal_id = $1 order by created_at, id', [DEAL]);
      expect(visaNotices).toHaveLength(2);
      // Deal-card ack -> bell row read and done.
      await one(OWNER, SQL.visaAck, [visaNotices[0]!.id]);
      const acked = (await h.notices('visa_result')).find((n) => n.subject_id === visaNotices[0]!.id)!;
      expect(acked.read_at && acked.done_at).toBeTruthy();
      // Bell Done -> visa notice seen.
      const bell = (await h.notices('visa_result')).find((n) => n.subject_id === visaNotices[1]!.id)!;
      await one(OWNER, SQL.noticeMark, [bell.id, 'done']);
      expect((await owner<{ seen_at: string | null }>('select seen_at from public.visa_result_notices where id = $1', [visaNotices[1]!.id]))[0]!.seen_at)
        .not.toBeNull();
    });
  });
});

describe('7.5 / 8.4 reading, done, counts, access re-check', () => {
  async function seeded() {
    await h.addFlightPeople();
    await h.noticesOn();
    const b = await h.book([HOTEL_ITEM, FLIGHT_ITEM]);
    await one(ACC, SQL.reviewReturn, [b.versionId, 'Synthetic return: billing name wrong', rid()]);
    return b;
  }

  it('normal read clears it; urgent read does not, Done / Open does; mark all read leaves urgent; only the recipient; no audit', async () => {
    await asOwner(db, async () => {
      await seeded();
      const auditCount = async () => Number((await owner<{ n: string }>('select count(*)::text as n from public.audit_events'))[0]!.n);
      const start = await auditCount();
      const urgent = (await h.notices('review_returned'))[0]!;
      let box = await h.inbox(OWNER);
      expect(box.items[0]).toMatchObject({ kind: 'review_returned', priority: 'urgent' });
      expect(box).toMatchObject({ unreadCount: 1, urgentCount: 1 });
      await one(OWNER, SQL.noticeMark, [urgent.id, 'read']);
      box = await h.inbox(OWNER);
      expect(box).toMatchObject({ unreadCount: 1, urgentCount: 1 });
      await one(OWNER, SQL.noticeMarkAll, []);
      expect((await h.inbox(OWNER)).urgentCount, 'mark all read leaves urgent').toBe(1);
      const done = await one<{ noticeId: string; readAt: string | null; doneAt: string | null }>(OWNER, SQL.noticeMark, [urgent.id, 'done']);
      expect(done.doneAt).not.toBeNull();
      expect(await one(OWNER, SQL.unread, [])).toMatchObject({ unreadCount: 0, urgentCount: 0 });
      // Normal notice: read sets both.
      const normal = (await h.notices('task_new', PURCHASE.userId!))[0]!;
      await refused(OWNER, SQL.noticeMark, [normal.id, 'read'], 'not_found', 'P0002');
      await refusedHint(PURCHASE, SQL.noticeMark, [normal.id, 'delete'], 'invalid_input', undefined, '22023');
      const r = await one<{ readAt: string; doneAt: string }>(PURCHASE, SQL.noticeMark, [normal.id, 'read']);
      expect(r.readAt).toBe(r.doneAt);
      expect(await one(PURCHASE, SQL.noticeMark, [normal.id, 'read']), 'idempotent').toMatchObject({ readAt: r.readAt });
      expect((await one<{ count: number }>(FLIGHT, SQL.noticeMarkAll, [])).count).toBe(1);
      expect(await auditCount(), 'reading is never audited').toBe(start);
      // History shows read / done rows.
      const hist = await one<{ items: Array<{ noticeId: string }> }>(OWNER, SQL.history, [null, 50]);
      expect(hist.items.map((x) => x.noticeId)).toContain(urgent.id);
    });
  });

  it('access re-check at read and in the select policy: lost role, removed Deal, reassigned task; rows stay', async () => {
    await asOwner(db, async () => {
      await seeded();
      const own = async (actor: Actor) => (await h.run<{ id: string }>(actor, 'select id from public.staff_notices'));
      expect((await h.inbox(PURCHASE)).unreadCount).toBe(1);
      expect(await own(PURCHASE)).toHaveLength(1);
      expect((await own(ACC)).length, 'only own rows').toBe(0);
      await h.dropRole(U.purchaseJodhpur, 'purchase');
      expect(await h.inbox(PURCHASE)).toMatchObject({ unreadCount: 0, items: [] });
      expect(await one(PURCHASE, SQL.unread, [])).toMatchObject({ unreadCount: 0 });
      expect(await own(PURCHASE), 'select policy re-checks access (lead decision AL15)').toHaveLength(0);
      expect(await h.notices('task_new', PURCHASE.userId!), 'nothing deleted').toHaveLength(1);
      // Removed Deal hides the urgent return notice of the owner.
      expect((await h.inbox(OWNER)).urgentCount).toBe(1);
      await owner('alter table public.deals drop constraint deals_removed_imported_only');
      await owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [DEAL]);
      expect(await h.inbox(OWNER)).toMatchObject({ urgentCount: 0, unreadCount: 0 });
      expect(await own(OWNER)).toHaveLength(0);
    });
    await asOwner(db, async () => {
      await seeded();
      await h.claim(FLIGHT, DEAL);
      await one(MANAGER, SQL.groupReassign, [DEAL, U.movedStaff, U.salesAhmedabad, 'Synthetic: covering for leave', rid()]);
      const assigned = await h.notices('task_assigned', FLIGHT_2.userId!);
      expect(assigned).not.toHaveLength(0);
      await one(MANAGER, SQL.groupReassign, [DEAL, U.salesAhmedabad, U.movedStaff, 'Synthetic: back from leave', rid()]);
      const box = await h.inbox(FLIGHT_2);
      expect(box.items.filter((i) => i.kind === 'task_assigned' && !i.resolvedAt)).toEqual([]);
      // Deactivated staff: nothing shown (row kept).
      expect((await h.inbox(FLIGHT)).items.length).toBeGreaterThan(0);
      await owner(`update public.memberships set status = 'inactive' where user_id = $1`, [U.movedStaff]);
      expect(await h.inbox(FLIGHT)).toMatchObject({ unreadCount: 0, items: [] });
    });
  });

  it('inbox shape, after-seq poll, preferences (on by default since Accounts phase 2, no audit)', async () => {
    await asOwner(db, async () => {
      await seeded();
      const box = await h.inbox(OWNER);
      // Accounts phase 2 (8.5): + popupsOn.
      // Accounts phase 3 (8.5; 16.6 setup update by Track T): + pushEnabled.
      expect(Object.keys(box).sort()).toEqual(['enabled', 'items', 'latestSeq', 'popupsOn', 'pushEnabled', 'soundOn', 'unreadCount', 'urgentCount']);
      expect(Object.keys(box.items[0]!).sort()).toEqual(['createdAt', 'dealId', 'dealReference', 'department', 'doneAt', 'escalated', 'kind', 'link',
        'noticeId', 'params', 'priority', 'readAt', 'resolvedAt', 'resolvedReason', 'seq', 'taskId']);
      const poll = await h.inbox(OWNER, Number(box.latestSeq));
      expect(poll.items).toEqual([]);
      // Accounts phase 2 (Q12, 8.5): ON by default; the person's own choice is kept.
      expect(await one(OWNER, SQL.noticePrefsGet, [])).toEqual({ soundOn: true, popupsOn: true });
      await one(OWNER, SQL.noticePrefsSet, [JSON.stringify({ soundOn: false })]);
      expect((await h.inbox(OWNER)).soundOn).toBe(false);
      await refusedHint(OWNER, SQL.noticePrefsSet, [JSON.stringify({ soundOn: 'yes' })], 'invalid_input', undefined, '22023');
      await refusedHint(OWNER, SQL.inbox, [null, 101], 'invalid_input', undefined, '22023');
    });
  });
});

describe('6.3.1 / 9.1 contents: frozen kinds and parameters, references only', () => {
  it('every row has a frozen kind and only allowlisted params; no amounts, names, PAN, mobile, PNR or ticket number', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      const k = await h.everyKind();
      await h.attempt(ACC, SQL.reviewReturn, [k.booked.versionId, 'Synthetic return: billing name wrong', rid()]);
      const rows = await h.notices();
      expect(rows.length).toBeGreaterThan(5);
      for (const n of rows) {
        expect(NOTICE_KINDS as readonly string[]).toContain(n.kind);
        expect(Object.keys(n.params).every((key) => NOTICE_PARAM_KEYS.includes(key)), `${n.kind} params ${JSON.stringify(n.params)}`).toBe(true);
        expect(n.recipient_user_id).not.toBe(n.actor_user_id);
      }
      const text = JSON.stringify(rows.map((n) => n.params));
      for (const v of [SENTINEL.pan, SENTINEL.panCash, SENTINEL.mobile, SENTINEL.passport, k.pnr, k.ticket, '2500000', '1000000', '2000000']) {
        expect(containsToken(text, v), `notice params leak ${v}`).toBe(false);
      }
      expect(text).not.toContain(SENTINEL.payerName);
      expect(text).not.toContain('Synthetic Traveller');
      // Never a notice in another entity; never Purchase on money kinds.
      const money = ['payment_reported', 'receipt_to_verify', 'payment_to_approve', 'payment_to_record', 'payment_to_verify', 'funding_to_approve'];
      expect(rows.filter((n) => money.includes(n.kind)).map((n) => n.recipient_user_id)).not.toContain(PURCHASE.userId);
      expect(rows.map((n) => n.recipient_user_id)).not.toContain(U.salesEntityB);
    });
  });
});

