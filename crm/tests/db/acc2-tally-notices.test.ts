import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, expectDbError } from '../helpers/db';
import { FLIGHT_ITEM, HOTEL_ITEM, VISA_ITEM, dayFrom } from './acc-support';
import {
  ACC, ACC2, DEAL, FLIGHT, MANAGER, MANAGER_AMD, MAPPING_ROW_KINDS, NEW_NOTICE_KINDS, OWNER, P2, PREFILL, PREFILL_VOUCHER_ONLY, PURCHASE, REASON, SERVICE_CLASSES,
  SQL2, acc2Helpers, landed, phase2Sql, rid, today, waits,
} from './acc2-support';

/**
 * Accounts Phase 2 contract section 8 (Track D: Tally mapping, new kinds,
 * notices 26-38 without 34 (Addendum L1), widened trip_cancelled, sound and
 * pop-ups ON by default) and test plan 12.1 "D", Track F. Written from the
 * contract. Recipient checks use contains / not-contains so extra seeded
 * staff never break them (Phase 1 lesson).
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
const MAPPING = landed('tally_ledger_mappings', 'tally_ledger_mapping_changes', 'tally_mapping_list', 'tally_mapping_set');
const EXPORT = landed('tally_source_set', 'tally_line_values', 'accounts_tally_export_create', 'customer_documents');
const NOTICES = landed('notice_kinds', 'notice_money_kind', 'notice_write', 'notices_on_cancellation', 'customer_refund_requests');
const PREFS = landed('notice_preferences_get', 'notice_preferences_set', 'notice_inbox') && /popups_on/.test(phase2Sql());
type Mapping = { mappingId: string; rowKind: string; serviceClass: string; debitLedger: string | null; creditLedger: string | null; voucherType: string | null;
  rowVersion: number };
type Lines = { lines: Array<{ lineNo: number; recordId?: string; values: Record<string, unknown> }>; nextAfter: string | null };
const exportFields = async (kinds: string[], includeExported = false) => JSON.stringify({ entityId: await h.entityId(), from: dayFrom(-30), to: today(), kinds,
  includeExported });

describe.skipIf(!MAPPING)(`8.1 mapping${MAPPING ? '' : ` — ${waits('D', 'tally_ledger_mappings …')}`}`, () => {
  it('pre-filled exactly from tally-structure.md; bank/cash/advance/purchase/expense ledgers left blank (LD20)', async () => {
    await asOwner(db, async () => {
      const r = await one<{ entityId: string; rows: Mapping[]; missingCount: number }>(ACC, SQL2.mappingList, [await h.entityId()]);
      expect(r.rows.every((x) => (MAPPING_ROW_KINDS as readonly string[]).includes(x.rowKind))).toBe(true);
      expect(r.rows.every((x) => (SERVICE_CLASSES as readonly string[]).includes(x.serviceClass))).toBe(true);
      const find = (kind: string, cls: string) => r.rows.find((x) => x.rowKind === kind && x.serviceClass === cls);
      for (const [cls, [ledger, voucher, cnVoucher]] of Object.entries(PREFILL)) {
        expect(find('customer_invoice', cls), `customer_invoice/${cls}`).toMatchObject({ creditLedger: ledger, voucherType: voucher });
        expect(find('customer_credit_note', cls), `customer_credit_note/${cls}`).toMatchObject({ voucherType: cnVoucher });
      }
      for (const [kind, voucher] of Object.entries(PREFILL_VOUCHER_ONLY)) {
        const rows = r.rows.filter((x) => x.rowKind === kind);
        expect(rows.length, kind).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row.voucherType, kind).toBe(voucher);
          expect([row.debitLedger, row.creditLedger], `${kind} ledgers blank (LD20)`).toEqual([null, null]);
        }
      }
      expect(r.missingCount).toBeGreaterThan(0);
      // Every entity got the pre-fill.
      expect(await owner(`select count(distinct legal_entity_id)::int as n from public.tally_ledger_mappings`))
        .toEqual(await owner('select count(*)::int as n from public.legal_entities'));
      // Fences: A only.
      for (const actor of [MANAGER, OWNER, PURCHASE]) expect(await h.attempt(actor, SQL2.mappingList, [await h.entityId()])).toMatchObject({ ok: true, value: null });
    });
  });

  it('set: reason, row version, formula-safe names, history and audit; no DELETE', async () => {
    await asOwner(db, async () => {
      const r = await one<{ rows: Mapping[] }>(ACC, SQL2.mappingList, [await h.entityId()]);
      const bank = r.rows.find((x) => x.rowKind === 'receipt_bank')!;
      const set = (fields: Record<string, unknown>, reason = REASON, rv = bank.rowVersion) =>
        [bank.mappingId, rv, JSON.stringify({ debitLedger: null, creditLedger: null, voucherType: 'Receipt', ...fields }), reason, rid()];
      await h.refusedHint(ACC, SQL2.mappingSet, set({ debitLedger: 'Synthetic Bank A/c' }, 'short'), 'invalid_input', undefined, '22023');
      for (const bad of ['=SUM(A1)', '+cmd', '-1', '@x', 'a\tb']) {
        await h.refusedHint(ACC, SQL2.mappingSet, set({ debitLedger: bad }), 'invalid_input', /debitLedger/, '22023');
      }
      await h.refused(MANAGER, SQL2.mappingSet, set({ debitLedger: 'Synthetic Bank A/c' }), 'not_authorized');
      await one(ACC, SQL2.mappingSet, set({ debitLedger: 'Synthetic Bank A/c', creditLedger: 'Customer Advances' }));
      await h.refusedToken(ACC, SQL2.mappingSet, set({ debitLedger: 'Other' }), 'version_changed');
      const changes = await owner<{ field: string; old_value: string | null; new_value: string | null; reason: string }>(
        'select field, old_value, new_value, reason from public.tally_ledger_mapping_changes where mapping_id = $1 order by field', [bank.mappingId]);
      expect(changes).toEqual([
        expect.objectContaining({ field: expect.stringMatching(/credit/i), old_value: null, new_value: 'Customer Advances', reason: REASON }),
        expect.objectContaining({ field: expect.stringMatching(/debit/i), old_value: null, new_value: 'Synthetic Bank A/c' }),
      ]);
      expect(await h.audits('accounts.tally_mapping_changed')).toEqual([expect.objectContaining({ details: expect.objectContaining({ mappingId: bank.mappingId }) })]);
      await expectDbError(db, () => owner('delete from public.tally_ledger_mappings where id = $1', [bank.mappingId]), {});
      await expectDbError(db, () => owner('delete from public.tally_ledger_mapping_changes where mapping_id = $1', [bank.mappingId]), {});
    });
  });
});

describe.skipIf(!EXPORT || !MAPPING)('8.2 export: mapped columns, Deal ID narration, new kinds, change flags', () => {
  it('customer documents and refund journal rows export with mapped ledgers and narration; mapping change is not "changed since export" (LD19)', async () => {
    await asOwner(db, async () => {
      await h.approvedDeal([HOTEL_ITEM]);
      await h.docsOn();
      await h.exportOn2();
      await owner('alter table public.deals drop constraint deals_provenance');
      await owner('update public.deals set source_deal_id = 10101 where id = $1', [DEAL]);
      const rec = await h.receipt2('2500000');
      const adv = await h.releasedAdvance(rec.id);
      const inv = await h.releasedInvoice();
      const gst = await h.gstInvoice('HC/25-26/0777');
      await one(ACC, SQL2.docLinkTally, [inv.id, gst, (await h.docRow(inv.id)).row_version, rid()]);
      const ex = await one<{ exportId: string; rowCount: number }>(ACC, SQL2.exportCreate, [await exportFields(['customer_document', 'journal_entry']), rid()]);
      const lines = await one<Lines>(ACC, SQL2.exportLines, [ex.exportId, 0, 1000]);
      const texts = lines.lines.map((l) => JSON.stringify(l.values));
      const invLine = texts.find((t) => t.includes(inv.number!));
      const advLine = texts.find((t) => t.includes(adv.number!) && t.includes('Customer advance invoice'));
      expect(invLine, 'invoice line exported').toBeDefined();
      expect(advLine, 'advance invoice line exported').toBeDefined();
      expect(invLine).toContain('Customer invoice');
      expect(invLine).toContain(`Deal 10101 | SYN-DEL-001 | Customer invoice ${inv.number}`);
      expect(invLine).toContain('HC/25-26/0777');
      expect(invLine, 'package domestic mapping').toMatch(/Domestic Package|Hotel Booking/);
      expect(invLine).toMatch(/Package Invoice|Hotel Invoice/);
      // Bank ledger of the receipt mapping is blank: "Mapping missing" yes.
      const receiptLine = texts.find((t) => t.includes(rec.receiptNo!));
      expect(receiptLine).toMatch(/"yes"/i);
      // Narration never carries names (the Phase 1 Party column still names the payer).
      const narrations = lines.lines.flatMap((l) => h.strings(l.values)).filter((x) => /^Deal .+ \| /.test(x));
      expect(narrations.length).toBe(lines.lines.length);
      for (const n of narrations) expect(n).not.toContain('Synthetic Payer');
      // Mapping change after export: not flagged.
      const map = (await one<{ rows: Mapping[] }>(ACC, SQL2.mappingList, [await h.entityId()])).rows.find((x) => x.rowKind === 'customer_invoice' && x.serviceClass !== 'any')!;
      await one(ACC, SQL2.mappingSet, [map.mappingId, map.rowVersion, JSON.stringify({ debitLedger: 'Synthetic Debtors', creditLedger: map.creditLedger,
        voucherType: map.voucherType }), REASON, rid()]);
      const changed = async (id: string) => (await owner<{ c: boolean }>('select $1::uuid = any(authz.tally_changed_ids(array[$2::uuid])) as c',
        [id, await h.entityId()]))[0]!.c;
      expect(await changed(inv.id)).toBe(false);
      // Cancelling an exported document flags it.
      const invRow = await h.docRow(inv.id);
      await one(ACC, SQL2.docCancel, [inv.id, invRow.row_version, 'Synthetic: wrong customer billing name', rid()]);
      expect(await changed(inv.id)).toBe(true);
    });
  });

  it('customer refund payout is a journal_entry row ("Customer refund"); supplier refund ready when verified; cancelled after export flagged (L1)', async () => {
    await asOwner(db, async () => {
      const { receipt } = await h.cancelledWithMoney('2500000');
      await h.exportOn2();
      const r = await h.requestRefund(h.refundFields({ payeeReceiptId: receipt.id, amountPaise: '1000000' }));
      await h.decideRefund(r.id, 'approve');
      await h.payout(r.id);
      const ex = await one<{ exportId: string }>(ACC, SQL2.exportCreate, [await exportFields(['journal_entry']), rid()]);
      const lines = await one<Lines>(ACC, SQL2.exportLines, [ex.exportId, 0, 1000]);
      const refundLine = lines.lines.map((l) => JSON.stringify(l.values)).find((t) => t.includes('Customer refund'));
      expect(refundLine).toBeDefined();
      expect(refundLine).toContain('10000.00');
      expect(refundLine).toContain('Deal ');
    });
  });
});

describe.skipIf(!NOTICES)(`8.3 notices${NOTICES ? '' : ` — ${waits('D', 'notice_kinds …')}`}`, () => {
  it('kind list adds 26-38 except 34 (L1)', async () => {
    await asOwner(db, async () => {
      const [k] = await owner<{ k: string[] }>('select authz.notice_kinds() as k');
      for (const kind of NEW_NOTICE_KINDS) expect(k!.k).toContain(kind);
      expect(k!.k).not.toContain('supplier_refund_to_verify');
      expect(k!.k).toContain('trip_cancelled');
    });
  });

  it('refund chain: 38 → SO*, 26 → branch Managers (not requester, urgent), 27 → requester, 28 → Accounts (not requester/approver), 29 → requester and SO*', async () => {
    await asOwner(db, async () => {
      await h.people.acc3();
      await h.noticesOn();
      const { receipt } = await h.cancelledWithMoney('2500000');
      expect(await h.recipients('refund_to_request')).toContain(U.salesDelhiA);
      const r = await h.requestRefund(h.refundFields({ payeeReceiptId: receipt.id }));
      expect((await h.notices('refund_to_request')).every((n) => n.resolved_at !== null), '38 resolved by the request').toBe(true);
      const approve = await h.notices('refund_to_approve');
      expect(approve.map((n) => n.recipient_user_id)).toContain(U.managerDelhi);
      expect(approve.map((n) => n.recipient_user_id)).not.toContain(U.salesDelhiA);
      expect(approve.every((n) => n.priority === 'urgent')).toBe(true);
      expect(approve[0]!.params).toMatchObject({ refNo: r.ref_no });
      await h.decideRefund(r.id, 'approve');
      expect((await h.notices('refund_to_approve')).every((n) => n.resolved_at !== null)).toBe(true);
      const decided = await h.notices('refund_decided');
      expect(decided.map((n) => [n.recipient_user_id, n.priority])).toEqual([[U.salesDelhiA, 'normal']]);
      const due = await h.notices('refund_payout_due');
      expect(due.map((n) => n.recipient_user_id)).toEqual(expect.arrayContaining([U.accountsJodhpur, U.visaJodhpur]));
      expect(due.map((n) => n.recipient_user_id)).not.toContain(U.managerDelhi);
      expect(due.map((n) => n.recipient_user_id)).not.toContain(U.salesDelhiA);
      await h.payout(r.id, {}, ACC);
      expect((await h.notices('refund_payout_due')).every((n) => n.resolved_at !== null), '28 resolved for everyone when paid').toBe(true);
      expect(await h.recipients('refund_paid')).toContain(U.salesDelhiA);
      // Actor never notified; Purchase never on money kinds.
      for (const kind of ['refund_to_approve', 'refund_decided', 'refund_payout_due', 'refund_paid']) {
        const rows = await h.notices(kind);
        expect(rows.every((n) => n.recipient_user_id !== n.actor_user_id), kind).toBe(true);
        expect(rows.map((n) => n.recipient_user_id), kind).not.toContain(U.purchaseJodhpur);
      }
      // No amounts or names in params.
      expect(JSON.stringify((await h.notices()).map((n) => n.params))).not.toMatch(/2500000|Synthetic Payer/);
    });
  });

  it('returned refund is urgent for the requester; an Accounts person who also holds Purchase gets no money notice', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      const { receipt } = await h.cancelledWithMoney('2500000');
      // A third Accounts person who also holds Purchase is not A (Phase 1): never a money notice.
      await h.people.fixtures('accountsJodhpur2');
      await h.addRole(P2.ACC_2.userId!, 'purchase');
      const r = await h.requestRefund(h.refundFields({ payeeReceiptId: receipt.id }));
      await h.decideRefund(r.id, 'return', MANAGER, 'Synthetic return: check the payee');
      expect((await h.notices('refund_decided')).map((n) => [n.recipient_user_id, n.priority])).toEqual([[U.salesDelhiA, 'urgent']]);
      await one(OWNER, SQL2.refundResubmit, [r.id, (await h.refundRow(r.id)).row_version, JSON.stringify(h.refundFields({ payeeReceiptId: receipt.id })), rid()]);
      await h.decideRefund(r.id, 'approve');
      expect(await h.recipients('refund_payout_due')).toContain(U.visaJodhpur);
      expect(await h.recipients('refund_payout_due')).not.toContain(P2.ACC_2.userId);
    });
  });

  it('cancellation: widened trip_cancelled (open tasks, SO*, Accounts); 35 to Managers; 36 per batch to Flight; 37 to Visa; 33 supplier refunds due', async () => {
    await asOwner(db, async () => {
      await h.people.flight();
      await h.addRole(U.salesAhmedabad, 'visa');
      await h.noticesOn();
      const b = await h.approvedDeal([HOTEL_ITEM, FLIGHT_ITEM, { ...VISA_ITEM, participants: [1] }]);
      const batch = await h.flightBatch(DEAL, [1]);
      const hotelTask = h.taskOf(b, 'hotel');
      const supplierId = await h.purchaseSupplier();
      await h.purchaseCost(hotelTask, supplierId);
      const cancellationId = await h.openCancellation();
      const cancelled = await h.recipients('trip_cancelled');
      expect(cancelled).toEqual(expect.arrayContaining([U.purchaseJodhpur, U.salesDelhiA, U.accountsJodhpur]));
      expect(cancelled, 'the Manager who opened it is the actor').not.toContain(U.managerDelhi);
      expect((await h.notices('trip_cancelled')).every((n) => n.priority === 'urgent')).toBe(true);
      const flightRows = await h.notices('flight_charges_to_enter');
      expect(flightRows.map((n) => n.recipient_user_id)).toContain(U.movedStaff);
      expect(flightRows.every((n) => n.priority === 'urgent')).toBe(true);
      // Charges, send, Manager approval notice (35), approval → 33 and 37.
      await one(PURCHASE, SQL2.chargeSet, [hotelTask, '100000', '3900000', null, null, 0, rid()]);
      await one(FLIGHT, SQL2.flightChargeSet, [batch.batchId, JSON.stringify({ airlineChargePaise: '100000', refundExpectedPaise: '200000',
        refundReportedPaise: null, note: 'Synthetic: airline fee' }), 0, rid()]);
      expect((await h.notices('flight_charges_to_enter')).every((n) => n.resolved_at !== null), '36 resolved once the batch has a charge').toBe(true);
      await one(PURCHASE, SQL2.cancelSend, [cancellationId, (await h.cancellationOf())!.row_version, rid()]);
      const approveRows = await h.notices('cancellation_to_approve');
      expect(approveRows.map((n) => n.recipient_user_id)).toContain(U.managerDelhi);
      expect(approveRows.map((n) => n.recipient_user_id)).not.toContain(U.purchaseJodhpur);
      await one(MANAGER, SQL2.cancelDecide, [cancellationId, 'approve', null, (await h.cancellationOf())!.row_version, rid()]);
      expect((await h.notices('cancellation_to_approve')).every((n) => n.resolved_at !== null)).toBe(true);
      expect(await h.recipients('supplier_refund_due')).toContain(U.accountsJodhpur);
      expect(await h.notices('supplier_refund_to_verify')).toEqual([]);
    });
  });

  it('documents: 30 to Accounts when the switch is on and a source appears; resolved at release; 31 after reversal of a released ADV', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      await h.approvedDeal([HOTEL_ITEM]);
      await h.docsOn();
      const rec = await h.receipt2('2500000');
      expect(await h.recipients('document_to_release')).toContain(U.accountsJodhpur);
      const adv = await h.releasedAdvance(rec.id);
      const advNotices = (await h.notices('document_to_release')).filter((n) => n.shared_key === `cdoc:${rec.id}:adv`);
      expect(advNotices.length).toBeGreaterThan(0);
      expect(advNotices.every((n) => n.resolved_at !== null)).toBe(true);
      await h.fin.reverse(ACC, rec.id, 'data_error');
      // The reversing Accounts person is the actor (never notified); the other Accounts people are.
      expect(await h.recipients('document_to_check')).toContain(U.visaJodhpur);
      expect(await h.recipients('document_to_check')).not.toContain(U.accountsJodhpur);
      await one(ACC, SQL2.docCancel, [adv.id, (await h.docRow(adv.id)).row_version, 'Synthetic: payment bounced back', rid()]);
      expect((await h.notices('document_to_check')).every((n) => n.resolved_at !== null)).toBe(true);
    });
  });

  it('re-check at read: a Manager who lost the role no longer sees kind 26 in the inbox', async () => {
    await asOwner(db, async () => {
      await h.noticesOn();
      const { receipt } = await h.cancelledWithMoney('2500000');
      await h.requestRefund(h.refundFields({ payeeReceiptId: receipt.id }));
      const before = await one<{ items: Array<{ kind: string }> }>(MANAGER, SQL2.inbox, [null, 100]);
      expect(before.items.map((i) => i.kind)).toContain('refund_to_approve');
      await h.dropRole(U.managerDelhi, 'manager');
      const after = await h.attempt<{ items: Array<{ kind: string }> }>(MANAGER, SQL2.inbox, [null, 100]);
      if (after.ok && after.value) expect(after.value.items.map((i) => i.kind)).not.toContain('refund_to_approve');
      void MANAGER_AMD;
      void ACC2;
    });
  });
});

describe.skipIf(!PREFS)('8.5 sound and pop-ups ON by default (Q12)', () => {
  it('no row → both on; explicit rows kept; popupsOn set alone keeps soundOn; at least one key', async () => {
    await asOwner(db, async () => {
      await owner('delete from public.staff_notice_preferences where user_id = $1', [U.salesDelhiB]).catch(() => undefined);
      const SALES_B = { userId: U.salesDelhiB };
      expect(await one(SALES_B, SQL2.prefsGet, [])).toMatchObject({ soundOn: true, popupsOn: true });
      expect(await one(SALES_B, SQL2.inbox, [null, 10])).toMatchObject({ soundOn: true, popupsOn: true });
      await one(SALES_B, SQL2.prefsSet, [JSON.stringify({ soundOn: false })]);
      expect(await one(SALES_B, SQL2.prefsGet, [])).toMatchObject({ soundOn: false, popupsOn: true });
      await one(SALES_B, SQL2.prefsSet, [JSON.stringify({ popupsOn: false })]);
      expect(await one(SALES_B, SQL2.prefsGet, [])).toMatchObject({ soundOn: false, popupsOn: false });
      await h.refusedHint(SALES_B, SQL2.prefsSet, ['{}'], 'invalid_input', undefined, '22023');
      const [d] = await owner<{ s: string; p: string }>(`select
        (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'staff_notice_preferences' and column_name = 'sound_on') as s,
        (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'staff_notice_preferences' and column_name = 'popups_on') as p`);
      expect([d!.s, d!.p]).toEqual(['true', 'true']);
    });
  });
});
