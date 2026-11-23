import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { HOTEL_ITEM } from './acc-support';
import { SQL } from './acc-support';
import { ACC, DEAL, MANAGER, OWNER, PURCHASE, REASON, SQL2, SUPER, acc2Helpers, rid, today } from './acc2-support';

/**
 * Accounts phase 2, Track D's own database checks (migrations
 * 20261204000400..0430): Tally mapping pre-fill and D2, mapped CSV columns
 * and narration, LD19 (mapping not hashed), customer documents and
 * "changed since export", sound / pop-ups ON by default with saved choices
 * kept, the refund notice chain 26-29 and 38 with resolutions, and the
 * widened trip_cancelled with its read re-check. Track F's acc2-* suites
 * are the independent tests; these are the builder's.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = acc2Helpers(() => db);
const { one, owner } = h;

type Mapping = { mappingId: string; rowKind: string; serviceClass: string; debitLedger: string | null; creditLedger: string | null;
  voucherType: string | null; rowVersion: number };
type MappingList = { entityId: string; rows: Mapping[]; missingCount: number };
type Lines = { lines: Array<{ lineNo: number; values: Record<string, string | null> }>; nextAfter: number | null };

async function mappingRow(kind: string, cls = 'any'): Promise<Mapping> {
  const list = await one<MappingList>(ACC, SQL2.mappingList, [await h.entityId()]);
  return list.rows.find((r) => r.rowKind === kind && r.serviceClass === cls)!;
}

async function exportLines(kinds: string[], includeExported: boolean): Promise<Array<Record<string, string | null>>> {
  const created = await one<{ exportId: string }>(ACC, 'select public.accounts_tally_export_create($1::jsonb, $2) as r', [JSON.stringify({
    entityId: await h.entityId(), from: '2026-01-01', to: today(), kinds, includeExported }), rid()]);
  const page = await one<Lines>(ACC, SQL2.exportLines, [created.exportId, 0, 1000]);
  return page.lines.map((l) => l.values);
}

describe('8.1 Tally mapping', () => {
  it('pre-filled for every entity (names only, ledgers for Accounts blank); A only; set with reason, history, audit, replay', async () => {
    await asOwner(db, async () => {
      const list = await one<MappingList>(ACC, SQL2.mappingList, [await h.entityId()]);
      // 51 Phase 2 rows + the two Phase 3 write-off rows (Addendum L5; 16.6 setup update by Track T).
      expect(list.rows).toHaveLength(53);
      expect(list.rows.find((r) => r.rowKind === 'customer_invoice' && r.serviceClass === 'hotel'))
        .toMatchObject({ debitLedger: null, creditLedger: 'Hotel Booking', voucherType: 'Hotel Invoice' });
      expect(list.rows.find((r) => r.rowKind === 'customer_credit_note' && r.serviceClass === 'flight_international'))
        .toMatchObject({ debitLedger: 'International Air Ticket', voucherType: 'Int. Cn' });
      expect(list.rows.find((r) => r.rowKind === 'receipt_bank')).toMatchObject({ debitLedger: null, creditLedger: null, voucherType: 'Receipt' });
      const missingBefore = list.missingCount;
      expect(missingBefore).toBeGreaterThan(0);
      expect(await one(MANAGER, SQL2.mappingList, [await h.entityId()])).toBeNull();
      expect(await one(PURCHASE, SQL2.mappingList, [await h.entityId()])).toBeNull();
      const [entities] = await owner<{ n: number; m: number }>(`select count(distinct legal_entity_id)::int as n,
        (select count(*)::int from public.legal_entities) as m from public.tally_ledger_mappings`);
      expect(entities!.n).toBe(entities!.m);

      const row = await mappingRow('receipt_bank');
      const req = rid();
      const set = await one<{ outcome: string; rowVersion: number; fields: string[] }>(ACC, SQL2.mappingSet,
        [row.mappingId, row.rowVersion, JSON.stringify({ debitLedger: 'Synthetic Bank A/c' }), REASON, req]);
      expect(set).toMatchObject({ outcome: 'updated', rowVersion: row.rowVersion + 1, fields: ['debitLedger'] });
      // Exact replay answers 'existing'; a stale version is refused.
      expect((await one<{ outcome: string }>(ACC, SQL2.mappingSet,
        [row.mappingId, row.rowVersion, JSON.stringify({ debitLedger: 'Synthetic Bank A/c' }), REASON, req])).outcome).toBe('existing');
      await h.refusedHint(ACC, SQL2.mappingSet, [row.mappingId, row.rowVersion, JSON.stringify({ debitLedger: 'Other' }), REASON, rid()],
        'version_changed', undefined, '40001');
      await h.refusedHint(ACC, SQL2.mappingSet, [row.mappingId, row.rowVersion + 1, JSON.stringify({ debitLedger: '=SUM(A1)' }), REASON, rid()],
        'invalid_input', /debitLedger/, '22023');
      await h.refusedHint(ACC, SQL2.mappingSet, [row.mappingId, row.rowVersion + 1, JSON.stringify({ debitLedger: 'Bank' }), 'short', rid()],
        'invalid_input', /reason/, '22023');
      await h.refusedHint(MANAGER, SQL2.mappingSet, [row.mappingId, row.rowVersion + 1, JSON.stringify({ debitLedger: 'Bank' }), REASON, rid()],
        'not_authorized', undefined, '42501');
      // No change -> 'existing' and no history row.
      expect((await one<{ outcome: string }>(ACC, SQL2.mappingSet,
        [row.mappingId, row.rowVersion + 1, JSON.stringify({ debitLedger: 'Synthetic Bank A/c' }), REASON, rid()])).outcome).toBe('existing');
      const hist = await owner<{ field: string; old_value: string | null; new_value: string }>(
        'select field, old_value, new_value from public.tally_ledger_mapping_changes where mapping_id = $1', [row.mappingId]);
      expect(hist).toEqual([{ field: 'debit_ledger', old_value: null, new_value: 'Synthetic Bank A/c' }]);
      const audits = await owner<{ details: Record<string, unknown> }>(
        `select details from public.audit_events where action = 'accounts.tally_mapping_changed' and target_id = $1`, [row.mappingId]);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.details).toMatchObject({ mappingId: row.mappingId, fields: ['debitLedger'] });
      expect((await one<MappingList>(ACC, SQL2.mappingList, [await h.entityId()])).missingCount).toBe(missingBefore - 1);
      const history = await one<{ items: Array<{ field: string; newValue: string }> }>(ACC, 'select public.tally_mapping_history($1) as r', [row.mappingId]);
      expect(history.items).toEqual([expect.objectContaining({ field: 'debitLedger', newValue: 'Synthetic Bank A/c' })]);
      expect(await one(MANAGER, 'select public.tally_mapping_history($1) as r', [row.mappingId])).toBeNull();
      await expect(owner('delete from public.tally_ledger_mappings where id = $1', [row.mappingId])).rejects.toThrow(/cannot be deleted/);
    });
  });
});

describe('8.2 export: mapped columns, narration, customer documents', () => {
  it('ADV and receipt lines carry service, mapping and Deal ID narration; mapping change is not "changed since export"; a cancelled ADV is', async () => {
    await asOwner(db, async () => {
      await h.approvedDeal([HOTEL_ITEM]);
      await h.docsOn();
      const rec = await h.receipt2('2500000');
      const adv = await h.releasedAdvance(rec.id);
      await h.exportOn2();
      const first = await exportLines(['customer_document', 'journal_entry'], false);
      const advLine = first.find((v) => v.crmRecordId === adv.id)!;
      const [deal] = await owner<{ reference: string; source_deal_id: string | null }>(
        'select reference, source_deal_id::text from public.deals where id = $1', [DEAL]);
      expect(advLine).toMatchObject({
        recordType: 'Customer advance invoice', reference: adv.number, tallyVoucherType: 'Receipt', tallyDebitLedger: null,
        tallyCreditLedger: null, mappingMissing: 'yes', changedSinceLastExport: 'no',
        narration: `Deal ${deal!.source_deal_id ?? deal!.reference} | ${deal!.reference} | Customer advance invoice ${adv.number}`,
      });
      expect(advLine.service).toBeTruthy();
      const receiptLine = first.find((v) => v.recordType === 'Receipt')!;
      expect(receiptLine.tallyVoucherType).toBe('Receipt');
      expect(receiptLine.narration).toMatch(/^Deal .+ \| .+ \| Receipt R-/);

      // LD19: the mapping is not hashed.
      const row = await mappingRow('customer_advance_invoice');
      await one(ACC, SQL2.mappingSet, [row.mappingId, row.rowVersion, JSON.stringify({ creditLedger: 'Synthetic Customer Advances' }), REASON, rid()]);
      const changed = async () => (await owner<{ ids: string[] }>('select authz.tally_changed_ids(array[$1]::uuid[]) as ids', [await h.entityId()]))[0]!.ids;
      expect(await changed()).not.toContain(adv.id);
      const again = await exportLines(['customer_document'], true);
      expect(again.find((v) => v.crmRecordId === adv.id)).toMatchObject({ tallyCreditLedger: 'Synthetic Customer Advances', mappingMissing: 'no',
        changedSinceLastExport: 'no' });

      // A released document cancelled after export: changed since export, still exportable as exported.
      await one(ACC, SQL2.docCancel, [adv.id, (await h.docRow(adv.id)).row_version, 'Synthetic: payment entered twice', rid()]);
      expect(await changed()).toContain(adv.id);
      const third = await exportLines(['customer_document'], true);
      expect(third.find((v) => v.crmRecordId === adv.id)?.changedSinceLastExport).toBe('yes');
    });
  });
});

describe('8.5 sound and pop-ups ON by default', () => {
  it('a person without a row reads ON; a saved choice stays; either key alone keeps the other', async () => {
    await asOwner(db, async () => {
      expect(await one(OWNER, SQL2.prefsGet, [])).toEqual({ soundOn: true, popupsOn: true });
      expect(await one(OWNER, SQL2.prefsSet, [JSON.stringify({ soundOn: false })])).toEqual({ soundOn: false, popupsOn: true });
      expect(await one(OWNER, SQL2.prefsSet, [JSON.stringify({ popupsOn: false })])).toEqual({ soundOn: false, popupsOn: false });
      expect(await one(OWNER, SQL2.prefsGet, [])).toEqual({ soundOn: false, popupsOn: false });
      expect(await one(PURCHASE, SQL2.prefsGet, [])).toEqual({ soundOn: true, popupsOn: true });
      await h.refusedHint(OWNER, SQL2.prefsSet, [JSON.stringify({})], 'invalid_input', /fields/, '22023');
      await h.refusedHint(OWNER, SQL2.prefsSet, [JSON.stringify({ popupsOn: 'no' })], 'invalid_input', /popupsOn/, '22023');
      const box = await h.inbox(PURCHASE);
      expect(box).toMatchObject({ soundOn: true, popupsOn: true });
      const [col] = await owner<{ d: string }>(`select column_default as d from information_schema.columns
        where table_schema = 'public' and table_name = 'staff_notice_preferences' and column_name = 'sound_on'`);
      expect(col!.d).toBe('true');
    });
  });
});

describe('8.3 notices', () => {
  it('refund chain: 38 to SO*, 26 to the branch Manager (urgent), 27 returned urgent / approved normal, 28 to Accounts, 29 on payout; resolutions', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      const { receipt, cancellationId } = await h.cancelledWithMoney('2500000');
      expect(await h.recipients('refund_to_request')).toEqual([U.salesDelhiA]);
      const r = await h.requestRefund(h.refundFields({ payeeReceiptId: receipt.id }));
      expect((await h.notices('refund_to_request')).every((n) => n.resolved_at !== null)).toBe(true);
      const approve = await h.notices('refund_to_approve');
      expect(approve.map((n) => n.recipient_user_id)).toContain(U.managerDelhi);
      expect(approve.map((n) => n.recipient_user_id)).not.toContain(U.salesDelhiA);
      expect(approve.every((n) => n.priority === 'urgent' && n.params.refNo === r.ref_no && n.subject_kind === 'refund_request')).toBe(true);
      // The Manager sees it in the inbox (re-check passes), with the refund link.
      const mBox = await h.inbox(MANAGER);
      expect(mBox.items.find((i) => i.kind === 'refund_to_approve')?.link).toEqual({ kind: 'refund', id: r.id });

      await h.decideRefund(r.id, 'return');
      expect((await h.notices('refund_to_approve')).every((n) => n.resolved_at !== null)).toBe(true);
      expect((await h.notices('refund_decided')).map((n) => [n.recipient_user_id, n.priority])).toEqual([[U.salesDelhiA, 'urgent']]);
      await one(OWNER, SQL2.refundResubmit, [r.id, (await h.refundRow(r.id)).row_version,
        JSON.stringify(h.refundFields({ payeeReceiptId: receipt.id })), rid()]);
      expect((await h.notices('refund_to_approve')).filter((n) => n.resolved_at === null).length).toBeGreaterThan(0);
      await h.decideRefund(r.id, 'approve');
      const decided = await h.notices('refund_decided');
      expect(decided.map((n) => n.priority)).toEqual(['urgent', 'normal']);
      const payoutDue = await h.recipients('refund_payout_due');
      expect(payoutDue).toContain(U.accountsJodhpur);
      expect(payoutDue).not.toContain(U.salesDelhiA);
      expect(payoutDue).not.toContain(U.managerDelhi);

      await h.payout(r.id);
      expect((await h.notices('refund_payout_due')).every((n) => n.resolved_at !== null)).toBe(true);
      const paid = await h.notices('refund_paid');
      expect(paid.find((n) => n.recipient_user_id === U.salesDelhiA)?.params.status).toBe('requester');
      const oBox = await h.inbox(OWNER);
      expect(oBox.items.map((i) => i.kind)).toEqual(expect.arrayContaining(['refund_paid', 'refund_decided']));
      // Money notices never reach Purchase; no amounts in params.
      const all = await owner<{ recipient_user_id: string; params: Record<string, unknown> }>(
        `select recipient_user_id, params from public.staff_notices where kind like 'refund%'`);
      expect(all.map((n) => n.recipient_user_id)).not.toContain(U.purchaseJodhpur);
      expect(JSON.stringify(all.map((n) => n.params))).not.toMatch(/2500000|100000/);
      expect(cancellationId).toBeTruthy();
    });
  });

  it('widened trip_cancelled: the department queue of an unassigned task, the Sales owner and Accounts; the opener is excluded', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      await h.approvedDeal([HOTEL_ITEM]);
      await h.openCancellation();
      const rows = await h.notices('trip_cancelled');
      const taskRows = rows.filter((n) => n.task_id !== null);
      const dealRows = rows.filter((n) => n.task_id === null);
      expect(taskRows.map((n) => n.recipient_user_id)).toContain(U.purchaseJodhpur);
      expect(dealRows.map((n) => n.recipient_user_id)).toEqual(expect.arrayContaining([U.salesDelhiA, U.accountsJodhpur]));
      expect(rows.map((n) => n.recipient_user_id)).not.toContain(U.managerDelhi);
      expect(rows.every((n) => n.priority === 'urgent')).toBe(true);
      // Re-check at read: the queue holder, the Sales owner and Accounts each see their row.
      for (const actor of [PURCHASE, OWNER, ACC]) {
        expect((await h.inbox(actor)).items.some((i) => i.kind === 'trip_cancelled'), actor.userId!).toBe(true);
      }
      expect((await h.inbox(OWNER)).items.find((i) => i.kind === 'trip_cancelled')?.link).toEqual({ kind: 'cancellation', id: DEAL });
    });
  });

  it('Addendum L6: a reversal after a paid-out refund is not blocked and tells the exception owner and the Sales owner (urgent)', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      const { receipt } = await h.cancelledWithMoney('2500000');
      await h.people.acc3();
      await one(SUPER, SQL.setExceptionOwner, [await h.entityId(), U.invitedStaff, REASON]);
      const r = await h.requestRefund(h.refundFields({ payeeReceiptId: receipt.id, amountPaise: '2500000' }));
      await h.decideRefund(r.id, 'approve');
      await h.payout(r.id);
      expect(await h.notices('refund_shortfall')).toEqual([]);
      // The reversal of the refunded money is allowed (a bank fact).
      await h.fin.reverse(ACC, receipt.id, 'data_error');
      expect(await h.held()).toBeLessThan(0n);
      const rows = await h.notices('refund_shortfall');
      expect(rows.map((n) => n.recipient_user_id).sort()).toEqual([U.invitedStaff, U.salesDelhiA].sort());
      expect(rows.every((n) => n.priority === 'urgent' && n.subject_kind === 'deal' && n.deal_id === DEAL)).toBe(true);
      expect(rows.map((n) => n.recipient_user_id)).not.toContain(U.purchaseJodhpur);
      for (const actor of [OWNER, { userId: U.invitedStaff }]) {
        const item = (await h.inbox(actor)).items.find((i) => i.kind === 'refund_shortfall');
        expect(item, actor.userId!).toMatchObject({ priority: 'urgent', link: { kind: 'deal', id: DEAL } });
      }
    });
  });

  it('Addendum L7: credit note case 2 (no Invoice, released Advance Invoice, payout paid) writes 32 when the request is paid', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      const { receipt } = await h.cancelledWithMoney('2500000');
      await h.docsOn();
      await h.releasedAdvance(receipt.id);
      const r = await h.requestRefund(h.refundFields({ payeeReceiptId: receipt.id }));
      await h.decideRefund(r.id, 'approve');
      expect(await h.notices('credit_note_to_release')).toEqual([]);
      await h.payout(r.id);
      expect((await h.refundRow(r.id)).status).toBe('paid');
      const rows = await h.notices('credit_note_to_release');
      // ACC paid it out (the actor is never told); the second Accounts person is.
      expect(rows.map((n) => n.recipient_user_id)).toEqual([U.visaJodhpur]);
      expect(rows.every((n) => n.subject_kind === 'refund_request' && n.subject_id === r.id && n.shared_key === `cdoc:${r.id}:cn`
        && n.params.refNo === r.ref_no)).toBe(true);
      expect(rows.map((n) => n.recipient_user_id)).not.toContain(U.purchaseJodhpur);
    });
  });
});
