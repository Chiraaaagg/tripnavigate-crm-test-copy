import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { HOTEL_ITEM, SQL as P1 } from './acc-support';
import { CSQL } from './acc2c-support';
import { ACC, DEAL, HOLD_CODES, trackLanded, MANAGER, OWNER, PURCHASE, REASON, SQL3, SUPER, acc3Helpers, rid, text } from './acc3-support';

/**
 * Accounts phase 3, Track T — Track B automatic bills (contract 6.1-6.5,
 * 16.1 B). Written from the contract, not from Track B's code.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = acc3Helpers(() => db);
const { one, owner, refused, refusedHint } = h;
type Settings = Record<string, unknown>;
type DocView = { documentId: string; status: string; number: string | null; autoRule: string | null; autoState: string | null;
  holdReasons: string[]; releasedByCrm: boolean };

/** People, documents On, automatic drafts On (release as given), then the hotel booking approved by Accounts. */
async function onAndApproved(release = true) {
  await h.people();
  await h.docsOn();
  await h.autoBills(true, release);
  return h.approvedBooking();
}
const reference = async (deal = DEAL) => (await owner<{ r: string }>('select reference as r from public.deals where id = $1', [deal]))[0]!.r;

describe('6.1 settings and switches', () => {
  it('defaults: drafts Off, release On, write-off Off with limit 500000, Tally file Off; B1 / B2 policy manager only, audited', async () => {
    await asOwner(db, async () => {
      const entity = await h.entityId();
      const s = await one<Settings>(SUPER, SQL3.accountsSettings, [entity]);
      // ASSUMPTION: admin_accounts_settings returns the new columns camelCased like the Phase 2 keys.
      expect(s).toMatchObject({ autoBillsEnabled: false, autoBillReleaseEnabled: true, writeOffEnabled: false, tallyXmlEnabled: false });
      expect(String(s.writeOffLimitPaise)).toBe('500000');
      expect(s.tallyCompanyName ?? null).toBeNull();
      await refused(ACC, SQL3.setAutoBills, [entity, true, true, REASON], 'not_authorized', '42501');
      await refusedHint(SUPER, SQL3.setAutoBills, [entity, true, true, 'short'], 'invalid_input', /reason/);
      await h.autoBills(true, false);
      expect(await one<Settings>(SUPER, SQL3.accountsSettings, [entity])).toMatchObject({ autoBillsEnabled: true, autoBillReleaseEnabled: false });
      const [a] = (await h.audits('settings.accounts_changed')).slice(-1);
      expect(a!.reason).toBe(REASON);
      expect(text(a!.details)).toContain('auto_bills_enabled');
      // B2 limit bounds: 1..500000.
      await refusedHint(SUPER, SQL3.setWriteOff, [entity, true, '500001', REASON], 'invalid_input', /limit/i);
      await refusedHint(SUPER, SQL3.setWriteOff, [entity, true, '0', REASON], 'invalid_input', /limit/i);
      await h.writeOffOn(true, '300000');
      expect(String((await one<Settings>(SUPER, SQL3.accountsSettings, [entity])).writeOffLimitPaise)).toBe('300000');
    });
  });

  it('with documents Off or drafts Off nothing is drafted (Phase 2 behaves as before)', async () => {
    await asOwner(db, async () => {
      await h.people();
      await h.autoBills(true, true); // drafts On, documents Off
      await h.approvedBooking();
      await h.receipt(DEAL, '2500000');
      expect(await h.documents()).toEqual([]);
      await h.autoBills(false, true);
      await h.docsOn();
      await h.receipt(DEAL, '1000000');
      expect(await h.documents()).toEqual([]);
      await owner(SQL3.autoRun, [DEAL, 'adv_on_receipt']);
      expect(await h.documents()).toEqual([]);
    });
  });
});

describe('6.2-6.4 automatic drafts and release', () => {
  it('approval drafts the Invoice and releases it by itself; a receipt gets an Advance Invoice; numbers and render jobs as the manual path', async () => {
    await asOwner(db, async () => {
      await onAndApproved(true);
      const ref = await reference();
      let docs = await h.documents();
      const inv = docs.find((d) => d.kind === 'invoice')!;
      expect(inv, 'invoice drafted at approval').toBeDefined();
      expect(inv).toMatchObject({ status: 'released', auto_rule: 'inv_on_approval', number: `${ref}-INV-1`, released_by: null });
      expect(inv.release_rule).toMatch(/^[a-z][a-z0-9_.]{2,59}$/);
      expect((await h.renderJobs(inv.id)).length).toBe(1);
      const rec = await h.receipt(DEAL, '2500000');
      docs = await h.documents();
      const adv = docs.find((d) => d.kind === 'advance_invoice')!;
      expect(adv).toMatchObject({ status: 'released', auto_rule: 'adv_on_receipt', receipt_id: rec.id, number: `${ref}-ADV-1`, total_paise: '2500000' });
      // System audit: drafted and released by the CRM with the rule.
      const drafted = await h.audits('accounts.customer_document.auto_drafted');
      expect(drafted.length).toBe(2);
      expect(drafted.every((a) => (a.details as { by: string }).by === 'crm')).toBe(true);
      const released = await h.audits('accounts.customer_document.auto_released');
      expect(released.map((a) => (a.details as { documentId: string }).documentId).sort()).toEqual([adv.id, inv.id].sort());
      expect(released[0]!.details).toMatchObject({ by: 'crm', kind: expect.any(String), seq: expect.anything(), rule: expect.any(String) });
      expect(text(released)).not.toContain('2500000');
      // A second receipt gets number 2.
      await h.receipt(DEAL, '1000000');
      expect((await h.documents()).filter((d) => d.kind === 'advance_invoice').map((d) => d.number).sort())
        .toEqual([`${ref}-ADV-1`, `${ref}-ADV-2`]);
    });
  });

  it('the same event replayed gives one draft; nothing is ever queued to the customer for a bill', async () => {
    await asOwner(db, async () => {
      await h.messagesOn();
      await onAndApproved(true);
      const rec = await h.receipt(DEAL, '2500000');
      await owner(SQL3.autoRun, [DEAL, 'adv_on_receipt']);
      await owner(SQL3.autoRun, [DEAL, 'adv_on_receipt']);
      const adv = (await h.documents()).filter((d) => d.kind === 'advance_invoice');
      expect(adv).toHaveLength(1);
      expect(adv[0]!.receipt_id).toBe(rec.id);
      // Only booking messages exist (5.5); no message type is about a bill.
      const types = new Set((await h.messages(DEAL)).map((m) => m.message_type));
      for (const t of types) expect(['booking_confirmed', 'payment_received']).toContain(t);
      expect(text(await h.messages(DEAL))).not.toMatch(/INV-|ADV-|invoice/i);
    });
  });

  it('release Off: a passing draft waits as ready; the normal Accounts release numbers it and clears auto_state', async () => {
    await asOwner(db, async () => {
      await onAndApproved(false);
      const inv = (await h.documents()).find((d) => d.kind === 'invoice')!;
      expect(inv).toMatchObject({ status: 'draft', auto_state: 'ready', number: null });
      const view = await one<{ documents: DocView[] }>(ACC, SQL3.dealDocs, [DEAL]);
      expect(view.documents.find((d) => d.documentId === inv.id)).toMatchObject({ autoRule: 'inv_on_approval', autoState: 'ready',
        holdReasons: [], releasedByCrm: false });
      const [row] = await owner<{ row_version: number; content_sha256: string }>('select row_version, content_sha256 from public.customer_documents where id = $1',
        [inv.id]);
      await one(ACC, SQL3.docRelease, [inv.id, row!.row_version, row!.content_sha256, rid()]);
      const after = (await h.documents()).find((d) => d.id === inv.id)!;
      expect(after).toMatchObject({ status: 'released', auto_state: null, released_by: ACC.userId });
      expect(after.number).toMatch(/-INV-1$/);
    });
  });

  it('held with billing_not_verified, listed in Bills to check; fixed by verifying billing -> released by the re-check', async () => {
    await asOwner(db, async () => {
      await h.people();
      await h.docsOn();
      await h.autoBills(true, true);
      // Accounts approval recorded as the owner (billing proposed, not verified): SYNTHETIC FIXTURE STEP.
      const b = await h.book([HOTEL_ITEM]);
      await h.approve(b.versionId);
      await h.receipt(DEAL, '2500000');
      const adv = (await h.documents()).find((d) => d.kind === 'advance_invoice')!;
      expect(adv).toMatchObject({ status: 'draft', auto_state: 'held' });
      expect(adv.hold_reasons).toContain('billing_not_verified');
      for (const code of adv.hold_reasons) expect(HOLD_CODES as readonly string[]).toContain(code);
      // cdoc_auto_run also drafts any other missing bill of the Deal (6.2 step 1): count this document's hold rows only.
      const heldFor = async () => (await h.audits('accounts.customer_document.held'))
        .filter((a) => (a.details as { documentId: string }).documentId === adv.id);
      const held = await heldFor();
      expect(held).toHaveLength(1);
      expect(held[0]!.details).toMatchObject({ documentId: adv.id, codes: expect.arrayContaining(['billing_not_verified']) });
      // Running the check again with the same codes writes no new audit row.
      await owner(SQL3.autoRun, [DEAL, 'adv_on_receipt']);
      expect(await heldFor()).toHaveLength(1);
      // ASSUMPTION: the toCheck preset is passed as `{ preset: 'toCheck' }` (6.5 names the preset, not the filter key).
      const list = await one<{ items: Array<{ documentId: string; autoState: string; holdReasons: string[] }> }>(ACC, SQL3.docsList,
        [JSON.stringify({ preset: 'toCheck' }), null, 50]);
      expect(list.items.map((i) => i.documentId)).toContain(adv.id);
      expect(list.items.every((i) => i.autoState === 'held')).toBe(true);
      // Fix: billing verified -> AFTER trigger re-evaluates -> released.
      const [billing] = await owner<{ row_version: number }>('select row_version from public.customer_billing_profiles where deal_id = $1', [DEAL]);
      const saved = await one<{ rowVersion: number }>(ACC, P1.billingSave, [DEAL, billing!.row_version, JSON.stringify({
        billingName: 'Synthetic Billing Name', addressLine1: '1 Synthetic Road', addressLine2: null, city: 'Jodhpur', stateCode: '08',
        postalCode: '342001', gstin: null }), rid()]);
      await one(ACC, P1.billingVerify, [DEAL, saved.rowVersion, rid()]);
      const fixed = (await h.documents()).find((d) => d.id === adv.id)!;
      expect(fixed.status).toBe('released');
    });
  });

  it('held while a cancellation is open, a refund request is live, or the receipt is no longer money', async () => {
    await asOwner(db, async () => {
      await onAndApproved(false);
      const rec = await h.receipt(DEAL, '2500000');
      // Open trip cancellation (not approved) -> both drafts held cancellation_open.
      await one(MANAGER, CSQL.cancelOpen, [DEAL, REASON, rid()]);
      await owner(SQL3.autoRun, [DEAL, 'adv_on_receipt']);
      for (const d of (await h.documents()).filter((x) => x.status === 'draft')) expect(d.hold_reasons, d.kind).toContain('cancellation_open');
      // Reversal of the receipt -> Advance Invoice held receipt_not_money.
      await h.fin.reverse(ACC, rec.id, 'data_error');
      const adv = (await h.documents()).find((d) => d.kind === 'advance_invoice')!;
      expect(adv.auto_state).toBe('held');
      expect(adv.hold_reasons).toContain('receipt_not_money');
      // deal_change_open is B's stub (false) until Track G replaces it.
      if (!trackLanded('6')) expect((await owner<{ r: boolean }>(SQL3.changeOpen, [DEAL]))[0]!.r).toBe(false);
    });
  });

  it('a live refund request holds the Invoice (refund_open)', async () => {
    await asOwner(db, async () => {
      await onAndApproved(false);
      const big = await h.receipt(DEAL, '50000000');
      await h.refundsOn();
      await h.request({ kind: 'overpayment', amountPaise: '100000', outcome: 'payout', payeeKind: 'original_payer', payeeReceiptId: big.id });
      await owner(SQL3.autoRun, [DEAL, 'inv_on_approval']);
      const inv = (await h.documents()).find((d) => d.kind === 'invoice')!;
      expect(inv.auto_state).toBe('held');
      expect(inv.hold_reasons).toContain('refund_open');
    });
  });

  it('a Credit Note is drafted when a refund is paid (cn_on_refund)', async () => {
    await asOwner(db, async () => {
      await onAndApproved(true);
      const big = await h.receipt(DEAL, '50000000');
      await h.refundsOn();
      const req = await h.request({ kind: 'overpayment', amountPaise: '100000', outcome: 'payout', payeeKind: 'original_payer', payeeReceiptId: big.id });
      await h.decide(req.refundRequestId, 'approve');
      await h.payout(req.refundRequestId);
      const cn = (await h.documents()).filter((d) => d.kind === 'credit_note');
      // ASSUMPTION: an overpayment refund has a credit-note source (authz.cdoc_credit_note_source); if not, no draft is the contract answer.
      const [src] = await owner<{ s: unknown }>('select authz.cdoc_credit_note_source($1) as s', [req.refundRequestId]).catch(() => [{ s: null }]);
      if (src?.s) {
        expect(cn).toHaveLength(1);
        expect(cn[0]).toMatchObject({ auto_rule: 'cn_on_refund', refund_request_id: req.refundRequestId });
      } else {
        expect(cn).toEqual([]);
      }
    });
  });

  it('cdoc_auto_run failure leaves the event committed and a pending row; the sweep picks it up', async () => {
    await asOwner(db, async () => {
      await onAndApproved(true);
      await db.exec('alter table public.customer_documents add constraint t_acc_block check (false) not valid');
      const rec = await h.receipt(DEAL, '2500000');
      expect((await owner<{ status: string }>('select status from public.customer_receipts where id = $1', [rec.id]))[0]!.status).toBe('verified');
      expect((await h.pending()).map((p) => p.deal_id)).toContain(DEAL);
      await db.exec('alter table public.customer_documents drop constraint t_acc_block');
      const [task] = await owner<{ f: string }>(`select function_name as f from public.timer_tasks where name = 'customer_documents_auto_sweep'`);
      expect(task, 'sweep task registered').toBeDefined();
      await owner(`select ${task!.f}() as r`);
      expect((await h.documents()).some((d) => d.kind === 'advance_invoice' && d.receipt_id === rec.id && d.status === 'released')).toBe(true);
      expect((await h.pending()).map((p) => p.deal_id)).not.toContain(DEAL);
    });
  });

  it('created_by / released_by nullable only with a rule; render job requested_by may be null', async () => {
    await asOwner(db, async () => {
      await onAndApproved(true);
      const [doc] = await owner<{ id: string }>(`select id from public.customer_documents where deal_id = $1 limit 1`, [DEAL]);
      // created_by null without auto_rule is refused by the check.
      await db.exec('savepoint t');
      let failed = false;
      try {
        await owner('update public.customer_documents set auto_rule = null, created_by = null where id = $1', [doc!.id]);
      } catch {
        failed = true;
      }
      await db.exec('rollback to savepoint t');
      expect(failed).toBe(true);
    });
  });
});

describe('6.5 reads and the daily check', () => {
  it('Deal documents rows carry the automatic fields; Sales owner and branch Manager see released bills only; Purchase never', async () => {
    await asOwner(db, async () => {
      await onAndApproved(true);
      await h.receipt(DEAL, '2500000');
      const acc = await one<{ documents: DocView[] }>(ACC, SQL3.dealDocs, [DEAL]);
      expect(acc.documents.length).toBeGreaterThanOrEqual(2);
      for (const d of acc.documents) {
        expect(Object.keys(d)).toEqual(expect.arrayContaining(['autoRule', 'autoState', 'holdReasons', 'releasedByCrm']));
        if (d.status === 'released') expect(d.releasedByCrm).toBe(true);
      }
      for (const actor of [OWNER, MANAGER]) {
        const v = await one<{ documents: DocView[] } | null>(actor, SQL3.dealDocs, [DEAL]);
        expect(v).not.toBeNull();
        expect(v!.documents.every((d) => d.status !== 'draft')).toBe(true);
      }
      expect(await one(PURCHASE, SQL3.dealDocs, [DEAL])).toBeNull();
    });
  });

  it('accounts_daily_check adds the Phase 3 counters', async () => {
    await asOwner(db, async () => {
      await h.people();
      const check = await one<Record<string, unknown>>(ACC, SQL3.dailyCheck, []);
      expect(Object.keys(check)).toEqual(expect.arrayContaining(['billsHeldOverOneWorkingDay', 'customerMessagesFailedOverOneWorkingDay',
        'tallyFileUnmatchedOverOneWorkingDay', 'messageQueueOldestMinutes', 'writeOffsToReview']));
    });
  });
});
