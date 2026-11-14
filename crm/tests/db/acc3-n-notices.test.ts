import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, resetActor } from '../helpers/db';
import { RELEASE_B_NOTICE_KINDS } from './acc3-support';
import { ACC, SQL as P1 } from './acc-support';
import {
  ACTIVITY_ITEM, HOTEL, HOTEL_ITEM, MANAGER, OWNER, PURCHASE, REASON, SQLB, SUPER, U, U2, relbHelpers, rid, text,
} from './acc3-relb-support';

/**
 * Accounts phase 3, Track T — Release B, Track N: notices 50-60 and the two
 * widened kinds (contract section 12, 16.1 N). Notices are written only by the
 * notices track's triggers on the source tables (LD34). Written from the
 * contract, not from Track N's code.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = relbHelpers(() => db);
const { one, owner } = h;
const sorted = (xs: string[]) => [...xs].sort();
const of = async (kind: string, subjectId?: string) =>
  (await h.notices(kind)).filter((n) => !subjectId || n.subject_id === subjectId || n.task_id === subjectId || n.deal_id === subjectId);

describe('12 kind registry', () => {
  it('every Release B kind is registered; none is a money kind (19 keeps its Phase 1 rule, Addendum L10); 53 and 55 are not used', async () => {
    await asOwner(db, async () => {
      const [k] = await owner<{ k: string[] }>('select authz.notice_kinds() as k');
      for (const kind of RELEASE_B_NOTICE_KINDS) expect(k!.k, kind).toContain(kind);
      for (const kind of RELEASE_B_NOTICE_KINDS) {
        const [m] = await owner<{ m: boolean }>('select authz.notice_money_kind($1) as m', [kind]);
        expect(m!.m, `${kind} is not a money kind`).toBe(false);
      }
      // Addendum L10: notice 19 keeps the Phase 1 recipient rule (a Manager holding Purchase still gets it), so it is not a money kind.
      const [c] = await owner<{ m: boolean }>(`select authz.notice_money_kind('cost_over_budget') as m`);
      expect(c!.m).toBe(false);
      // subject kinds (12): change_request, reconfirmation, rate_contract.
      const [def] = await owner<{ d: string }>(`select string_agg(pg_get_constraintdef(c.oid), ' ') as d from pg_constraint c
        where c.conrelid = 'public.staff_notices'::regclass and pg_get_constraintdef(c.oid) like '%subject_kind%'`);
      for (const s of ['change_request', 'reconfirmation', 'rate_contract']) expect(def!.d).toContain(s);
    });
  });
});

describe('50 / 51 change requests', () => {
  it('50 change_to_approve: Approvers (not the requester), urgent, shared; resolved when no longer requested; 51 to the requester', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      const { hotelItem } = await h.committedDeal();
      const cr = await h.requestChange({ itemIds: [hotelItem] });
      // Addendum O2: nothing to approve while drafted; 50 once the filled version is sent.
      expect(await of('change_to_approve', cr.changeRequestId)).toEqual([]);
      await h.sendChange(cr.changeRequestId, hotelItem);
      const fifty = await of('change_to_approve', cr.changeRequestId);
      expect(sorted(fifty.map((n) => n.recipient_user_id))).toEqual([U.managerDelhi]);
      expect(fifty[0]).toMatchObject({ priority: 'urgent', subject_kind: 'change_request', subject_id: cr.changeRequestId });
      expect(fifty[0]!.shared_key).toBe(`cr:${cr.changeRequestId}:approve:${(await h.crRow(cr.changeRequestId)).row_version}`);
      await h.decideChange(cr.changeRequestId, 'return', MANAGER, REASON);
      expect((await of('change_to_approve', cr.changeRequestId)).every((n) => n.resolved_at !== null)).toBe(true);
      const returned = await of('change_decided', cr.changeRequestId);
      expect(returned.map((n) => [n.recipient_user_id, n.priority])).toEqual([[U.salesDelhiA, 'urgent']]);
      // Resubmit -> a new 50 for the new row version; approve -> 51 normal.
      const row = await h.crRow(cr.changeRequestId);
      await one(OWNER, SQLB.crResubmit, [cr.changeRequestId, row.row_version, JSON.stringify({ kind: 'change', itemIds: [hotelItem],
        changeSummary: 'Synthetic change summary, resubmitted', reason: REASON }), rid()]);
      await h.submitChange(cr.changeRequestId, [hotelItem]);  // Addendum O2: sent again
      const open = (await of('change_to_approve', cr.changeRequestId)).filter((n) => n.resolved_at === null);
      expect(open.length).toBe(1);
      expect(open[0]!.shared_key).not.toBe(fifty[0]!.shared_key);
      await h.decideChange(cr.changeRequestId, 'approve');
      const approved = (await of('change_decided', cr.changeRequestId)).filter((n) => n.priority === 'normal');
      expect(approved.map((n) => n.recipient_user_id)).toEqual([U.salesDelhiA]);
      // The actor never notifies themself.
      expect((await of('change_decided', cr.changeRequestId)).some((n) => n.recipient_user_id === U.managerDelhi)).toBe(false);
    });
  });

  it('50 when the branch Manager asks: the other active Managers of the entity, never the requester (LD37)', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      const { hotelItem } = await h.committedDeal();
      const cr = await h.requestChange({ itemIds: [hotelItem] }, MANAGER);
      await h.sendChange(cr.changeRequestId, hotelItem);  // Addendum O2: filled by the Sales owner and sent
      const recipients = (await of('change_to_approve', cr.changeRequestId)).map((n) => n.recipient_user_id);
      expect(recipients).not.toContain(U.managerDelhi);
      expect(recipients).toContain(U2.managerJodhpur2);
      // M holding Flight is not M (AL7).
      expect(recipients).not.toContain(U2.managerFlightDelhi);
    });
  });
});

describe('52 / 19 / 3 / 54 / 56 reconfirmation', () => {
  it('52 reconfirm_supplier to the task assignee (urgent), resolved once recorded; 19 cost_over_budget to Approvers, resolved at approval; 3 booking_changed adds Accounts', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      const { hotelItem, hotelTask } = await h.committedDeal();
      const { cr } = await h.submittedChange(hotelItem);
      const [reconf] = await h.reconfirmations(cr.changeRequestId);
      const fiftyTwo = await of('reconfirm_supplier', hotelTask);
      expect(fiftyTwo.map((n) => [n.recipient_user_id, n.priority])).toEqual([[U.purchaseJodhpur, 'urgent']]);
      expect(fiftyTwo[0]!.dedup_key).toBe(`reconf:${reconf!.id}`);
      // Purchase is never told the selling price in the notice.
      expect(text(fiftyTwo)).not.toMatch(/9123457|8123457/);
      await h.recordReconfirm(reconf!.id, hotelTask, { newRatePaise: '19900000', supplierFeePaise: '500000' });
      expect((await of('reconfirm_supplier', hotelTask)).every((n) => n.resolved_at !== null)).toBe(true);
      const nineteen = (await h.notices('cost_over_budget')).filter((n) => n.shared_key === `reconf:${reconf!.id}:budget`);
      // Addendum L10: the reconfirmation copy of 19 goes only to Managers without P / F / V (Manager Flight Delhi never gets it).
      expect(sorted(nineteen.map((n) => n.recipient_user_id))).toEqual([U.managerDelhi]);
      expect(nineteen.map((n) => n.recipient_user_id)).not.toContain(U2.managerFlightDelhi);
      expect(nineteen[0]!.priority).toBe('urgent');
      await one(MANAGER, SQLB.reconfirmApprove, [reconf!.id, await h.reconfRv(reconf!.id), rid()]);
      expect((await h.notices('cost_over_budget')).filter((n) => n.shared_key === `reconf:${reconf!.id}:budget`).every((n) => n.resolved_at !== null)).toBe(true);
      // Applied: booking_changed also reaches Accounts of the entity.
      expect((await h.crRow(cr.changeRequestId)).status).toBe('applied');
      const changed = (await h.notices('booking_changed')).map((n) => n.recipient_user_id);
      expect(changed).toContain(U.accountsJodhpur);
      expect((await h.notices('booking_changed')).every((n) => n.priority === 'urgent')).toBe(true);
    });
  });

  /** Two hotels: the first confirmed by Purchase Jodhpur (committedDeal), the second by `second` (or Purchase Jodhpur); both changed and submitted. */
  async function twoHotelChange(second: typeof PURCHASE) {
    const { b, hotelItem, hotelTask } = await h.committedDeal([{ ...HOTEL_ITEM, facts: { ...HOTEL, hotelName: 'Synthetic Second Hotel' } }]);
    const secondTask = h.taskOf(b, 'hotel', 1);
    if (second === PURCHASE) await h.supplierConfirmed(secondTask);
    else {
      // The second Purchase person claims, costs, asks the go-ahead and confirms the second hotel (never a reassignment of a confirmed task).
      const supplier = await h.purchaseSupplier();
      await h.purchaseCost(secondTask, supplier, '10000000', second);
      await one(second, P1.bookingRequestSend, [secondTask, 1, 'desk@example.test', [], 'Booking request · SYN · Synthetic', 'Synthetic body.', rid()]);
      const [g] = await owner<{ id: string; row_version: number }>(`select id, row_version from public.purchase_go_ahead_requests where task_id = $1 and status = 'pending'`,
        [secondTask]);
      await one(ACC, P1.goAheadDecide, [g!.id, 'approve', null, g!.row_version, rid()]);
      const ev = await one<{ evidenceId: string; objectPath: string }>(second, 'select public.purchase_evidence_begin($1, $2, $3, $4, $5, $6) as r',
        [secondTask, 'supplier_confirmation', 'supplier.pdf', 'application/pdf', 2048, 'f'.repeat(64)]);
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('purchase-evidence', $1, jsonb_build_object('size', 2048::bigint))`,
        [ev.objectPath]);
      await one(second, 'select public.purchase_evidence_finish($1, true) as r', [ev.evidenceId]);
      await one(second, P1.supplierConfirm, [secondTask, 1, 'SYN-CONF-0003']);
    }
    const secondItem = b.itemIds[1]!;
    const { cr } = await h.submittedChange(hotelItem, {
      itemIds: [hotelItem, secondItem],
      edit: async (v, rv) => h.editHotel(secondItem, v, await h.editHotel(hotelItem, v, rv), { hotelName: 'Synthetic Second Hotel', roomType: 'Synthetic Suite' }),
    });
    const rows = await h.reconfirmations(cr.changeRequestId);
    return { cr, hotelTask, secondTask, first: rows.find((r) => r.task_id === hotelTask)!, other: rows.find((r) => r.task_id === secondTask)! };
  }

  it('56 case A: the voided row is handled by a second Purchase person -> that person is told, the actor is not; 54 to requester and SO*', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      await h.people();
      const SECOND = { userId: U.salesAhmedabad };
      await h.addRole(U.salesAhmedabad, 'purchase');
      const { cr, hotelTask, secondTask, first, other } = await twoHotelChange(SECOND);
      await h.recordReconfirm(other.id, secondTask, { newRatePaise: '9900000', supplierFeePaise: '0' }, SECOND);
      // Purchase Jodhpur (the actor) refuses its own row: the other, recorded row is voided.
      await one(PURCHASE, SQLB.reconfirmRefuse, [first.id, await h.reconfRv(first.id), REASON, rid()]);
      void hotelTask;
      const undo = (await h.notices('reconfirm_undo')).filter((n) => n.dedup_key === `reconf:${other.id}:void`);
      expect(undo.map((n) => [n.recipient_user_id, n.priority])).toEqual([[U.salesAhmedabad, 'urgent']]);
      expect((await h.notices('reconfirm_undo')).map((n) => n.recipient_user_id)).not.toContain(U.purchaseJodhpur);
      const notPossible = await of('change_not_possible', cr.changeRequestId);
      expect(sorted(notPossible.map((n) => n.recipient_user_id))).toEqual([U.salesDelhiA]);
      expect(notPossible.every((n) => n.priority === 'urgent' && n.dedup_key.startsWith(`cr:${cr.changeRequestId}:not_possible`))).toBe(true);
    });
  });

  it('56 case B: the actor handled every voided row -> no 56 for anyone (the refusal screen lists them)', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      await h.people();
      await h.addRole(U.salesAhmedabad, 'purchase');
      const { hotelTask, first, other } = await twoHotelChange(PURCHASE);
      await h.recordReconfirm(first.id, hotelTask, { newRatePaise: '19900000', supplierFeePaise: '500000' });
      await one(PURCHASE, SQLB.reconfirmRefuse, [other.id, await h.reconfRv(other.id), REASON, rid()]);
      expect(await h.notices('reconfirm_undo')).toEqual([]);
    });
  });

  it('56 when the request is withdrawn after a recorded reconfirmation', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      const { hotelItem, hotelTask } = await h.committedDeal();
      const { cr } = await h.submittedChange(hotelItem);
      const [reconf] = await h.reconfirmations(cr.changeRequestId);
      await h.recordReconfirm(reconf!.id, hotelTask, { newRatePaise: '19900000', supplierFeePaise: '500000' });
      await one(OWNER, SQLB.crWithdraw, [cr.changeRequestId, (await h.crRow(cr.changeRequestId)).row_version, REASON, rid()]);
      const undo = (await h.notices('reconfirm_undo')).filter((n) => n.dedup_key === `reconf:${reconf!.id}:void`);
      expect(undo.map((n) => n.recipient_user_id)).toEqual([U.purchaseJodhpur]);
      // The over-budget notice of the voided row is resolved.
      expect((await h.notices('cost_over_budget')).filter((n) => n.shared_key === `reconf:${reconf!.id}:budget`).every((n) => n.resolved_at !== null)).toBe(true);
    });
  });
});

describe('57 removal charges', () => {
  it('57 to the task assignee (urgent), resolved when the charges are complete; 50 only once the charges are complete', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      const { hotelItem, hotelTask } = await h.committedDeal([ACTIVITY_ITEM]);
      await h.serviceChangesOn();
      const cr = await h.requestChange({ kind: 'remove_service', itemIds: [hotelItem], changeSummary: 'Synthetic: the hotel is dropped',
        customerChargePaise: '500000' });
      // Addendum O2: the change version is filled and sent; 57 then (charges open), 50 once they are in.
      const v = await h.openChange(cr.changeRequestId);
      await h.newTotal(v.versionId, v.rowVersion);
      await h.submitChange(cr.changeRequestId, [hotelItem]);
      const charges = await of('removal_charges_to_enter', cr.changeRequestId);
      expect(charges.map((n) => [n.recipient_user_id, n.priority, n.dedup_key])).toEqual([[U.purchaseJodhpur, 'urgent', `cr:${cr.changeRequestId}:charges`]]);
      expect(await of('change_to_approve', cr.changeRequestId)).toEqual([]);
      await one(PURCHASE, SQLB.purchaseCharge, [hotelTask, '1000000', '0', null, null, 0, rid()]);
      expect((await of('removal_charges_to_enter', cr.changeRequestId)).every((n) => n.resolved_at !== null)).toBe(true);
      expect((await of('change_to_approve', cr.changeRequestId)).map((n) => n.recipient_user_id)).toEqual([U.managerDelhi]);
      // Never the customer charge in a notice (Purchase reads it).
      expect(text(await of('removal_charges_to_enter', cr.changeRequestId))).not.toContain('500000');
    });
  });
});

describe('58 / 59 / 60 rate contracts', () => {
  it('58 to Managers of the entity (not the enterer), normal, resolved at decision; 59 to the enterer (returned urgent, approved normal); 60 ending', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      await h.people();
      await h.rateContractsOn();
      const hotel = await h.catalogueHotel();
      const supplier = await h.hotelSupplier(hotel);
      const room = await h.roomType(hotel);
      const c = await h.draftContract(supplier, hotel);
      await h.setLines(c.contractId, [h.line(room)]);
      await h.submit(c.contractId);
      const fiftyEight = await of('contract_to_approve', c.contractId);
      const recipients = fiftyEight.map((n) => n.recipient_user_id);
      expect(recipients).toContain(U.managerDelhi);
      expect(recipients).toContain(U2.managerJodhpur);
      expect(recipients).not.toContain(U.purchaseJodhpur);
      expect(fiftyEight.every((n) => n.priority === 'normal' && n.subject_kind === 'rate_contract')).toBe(true);
      await h.decideContract(c.contractId, 'return', MANAGER, REASON);
      expect((await of('contract_to_approve', c.contractId)).every((n) => n.resolved_at !== null)).toBe(true);
      const returned = await of('contract_decided', c.contractId);
      expect(returned.map((n) => [n.recipient_user_id, n.priority])).toEqual([[U.purchaseJodhpur, 'urgent']]);
      await h.setLines(c.contractId, [h.line(room)]);
      await h.submit(c.contractId);
      await h.decideContract(c.contractId, 'approve');
      const approved = (await of('contract_decided', c.contractId)).filter((n) => n.priority === 'normal');
      expect(approved.map((n) => n.recipient_user_id)).toEqual([U.purchaseJodhpur]);
      // 60: an expiry alert row (owner SQL stands in for the timer task) -> Purchase holders and Managers, normal.
      await resetActor(db);
      await owner(`insert into public.rate_contract_alerts (legal_entity_id, contract_id, days_left)
        select legal_entity_id, id, 7 from public.rate_contracts where id = $1`, [c.contractId]);
      const sixty = await of('contract_ending', c.contractId);
      expect(sixty.every((n) => n.priority === 'normal' && n.dedup_key === `rc:${c.contractId}:ending:7`)).toBe(true);
      const to = sixty.map((n) => n.recipient_user_id);
      expect(to).toContain(U.purchaseJodhpur);
      expect(to).toContain(U.managerDelhi);
      expect(to).not.toContain(U.salesDelhiA);
      expect(to).not.toContain(U.accountsJodhpur);
    });
  });
});

describe('8.2 push for urgent Release B kinds', () => {
  it('an urgent Release B notice queues a push job for each active device of the recipient (switch On)', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      await one(SUPER, 'select public.admin_set_push_enabled($1, $2) as r', [true, REASON]);
      await one(PURCHASE, 'select public.push_device_register($1, $2, $3, $4, $5) as r', [`https://push.example.test/${rid()}`,
        'BOr7synthetic-p256dh-key', 'synthetic-auth-key-0001', 'Chrome on Windows', rid()]);
      const { hotelItem, hotelTask } = await h.committedDeal();
      await h.submittedChange(hotelItem);
      const [n] = await of('reconfirm_supplier', hotelTask);
      const [jobs] = await owner<{ n: number }>('select count(*)::int as n from public.staff_push_jobs where notice_id = $1', [n!.id]);
      expect(jobs!.n).toBe(1);
    });
  });
});
