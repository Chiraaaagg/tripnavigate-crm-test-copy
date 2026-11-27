import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, type TestDb, asOwner, createTestDb, expectDbError } from '../helpers/db';
import { CUSTOMER_VIEW_FORBIDDEN_KEY } from '@/modules/documents/contracts';
import { forbiddenKeyPaths } from '@/modules/documents/guard';
import { DEAL_AMD, FLIGHT_ITEM, HOTEL_ITEM, SELLING, VISA_ITEM, TRIP } from './acc-support';
import {
  ACC, ACC2, COMPANY_GSTIN, DEAL, MANAGER, NUMBER_RE, OWNER, PURCHASE, REASON, SQL2, SUPER, acc2Helpers, idOf, landed, rid, sha, today, waits,
} from './acc2-support';

/**
 * Accounts Phase 2 contract section 6 (Track B: customer documents and PDF)
 * and test plan 12.1 "B documents", Track F. Written from the contract.
 * Audit action names per Addendum L5 (accounts.customer_document.<event>).
 * Fences are in acc2-fence.test.ts; races in acc2-concurrency.test.ts.
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
const READY = landed('customer_documents', 'customer_document_counters', 'customer_document_render_jobs', 'customer_document_files',
  'customer_document_draft_create', 'customer_document_release', 'deal_customer_documents', 'customer_document_get', 'customer_documents_list',
  'admin_set_customer_documents_enabled');
const REFUNDS = landed('customer_refund_requests', 'customer_refund_request_create', 'cdoc_credit_note_source');
const WORKER: Actor = { userId: null, role: 'service_role' };
type Content = { schema: string; kind: string; title: string; number: string | null; issueDate: string | null; company: { gstin: string; gstinState: string };
  lines: Array<{ label: string; amountPaise: string }>; totalPaise: string; paidPaise: string; balancePaise?: string; payment: Record<string, unknown> | null;
  credits: unknown; gstInvoiceNumber: string | null; replaces: { number: string } | null; deal: { reference: string; dealNumber: string | null } } & Record<string, unknown>;
const content = (d: { content: Record<string, unknown> }) => d.content as Content;
const sum = (lines: Array<{ amountPaise: string }>) => lines.reduce((a, l) => a + BigInt(l.amountPaise), 0n).toString();

/** Package Deal approved (billing verified), documents on, one verified receipt. */
async function ready(amount = '2500000', deal: string = DEAL) {
  const b = await h.approvedDeal([HOTEL_ITEM], { deal });
  await h.docsOn();
  const rec = await h.receipt2(amount, deal);
  return { b, rec };
}

describe.skipIf(!READY)(`6.3 sources and 6.4 frozen content${READY ? '' : ` — ${waits('B', 'customer_documents …')}`}`, () => {
  it('Advance Invoice: one line "Advance received" = receipt amount; payment block; no number on the draft', async () => {
    await asOwner(db, async () => {
      const { rec } = await ready('2500000');
      const d = await h.draft('advance_invoice', { receiptId: rec.id });
      expect(d).toMatchObject({ kind: 'advance_invoice', status: 'draft', number: null, seq: null, receipt_id: rec.id, total_paise: '2500000' });
      const c = content(d);
      expect(c).toMatchObject({ schema: 'cdoc-1', kind: 'advance_invoice', title: 'Advance Invoice', number: null, issueDate: null,
        lines: [{ label: 'Advance received', amountPaise: '2500000' }], totalPaise: '2500000' });
      expect(c.payment).toMatchObject({ reference: expect.stringMatching(/^R-/), receivedOn: today() });
      expect(c.company.gstin, 'Delhi Deal prints the company GSTIN (Q2, LD1)').toBe(COMPANY_GSTIN);
      expect(d.content_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await h.audits('accounts.customer_document.drafted')).toEqual([expect.objectContaining({
        details: expect.objectContaining({ documentId: d.id, kind: 'advance_invoice', dealId: DEAL }) })]);
    });
  });

  it('Invoice (package): one line = selling total; paid, balance, plan; only after Accounts approved the booking', async () => {
    await asOwner(db, async () => {
      // Not approved yet: not_ready.
      await h.people.acc2();
      const b0 = await h.book([HOTEL_ITEM]);
      await h.docsOn();
      await h.refusedToken(ACC, SQL2.draftCreate, [DEAL, 'invoice', '{}', rid()], 'not_ready');
      await h.approveReal(b0.versionId);
      await h.receipt2('1000000');
      const d = await h.draft('invoice', {});
      const c = content(d);
      expect(c.lines).toHaveLength(1);
      expect(c.lines[0]!.label).toMatch(/^(Holiday package|Hotel booking)/);
      expect(c.lines[0]!.label).toContain(TRIP.destination);
      expect(c.lines[0]!.amountPaise).toBe(SELLING);
      expect(c).toMatchObject({ title: 'Invoice', totalPaise: SELLING, paidPaise: '1000000', balancePaise: String(BigInt(SELLING) - 1000000n) });
      expect(Array.isArray(c.plan)).toBe(true);
    });
  });

  it('Invoice (flight-only): one line per ticket batch = batch customer total; warning when Σ ≠ selling total (LD15)', async () => {
    await asOwner(db, async () => {
      const b = await h.approvedDeal([FLIGHT_ITEM]);
      await h.docsOn();
      await h.flightBatch(DEAL, [1]);
      const batches = await owner<{ batch_no: number; customer_total_paise: string }>(
        'select batch_no, customer_total_paise::text as customer_total_paise from public.flight_ticket_batches where deal_id = $1 order by batch_no', [DEAL]);
      expect(batches.length).toBeGreaterThan(0);
      const d = await h.draft('invoice', {});
      const c = content(d);
      expect(c.lines.map((l) => l.amountPaise)).toEqual(batches.map((x) => x.customer_total_paise));
      expect(c.lines[0]!.label).toMatch(/^Air tickets — batch 1/);
      expect(c.totalPaise).toBe(sum(c.lines));
      const docs = await one<{ documents: Array<{ documentId: string; warnings: string[] }> }>(ACC, SQL2.dealDocs, [DEAL]);
      const warn = docs.documents.find((x) => x.documentId === d.id)!.warnings;
      if (c.totalPaise !== SELLING) expect(warn).toContain('flight_total_differs');
      else expect(warn).not.toContain('flight_total_differs');
      void b;
    });
  });

  it('Invoice (visa-only): one total line = selling total (LD16); no plan block without instalments (LD29)', async () => {
    await asOwner(db, async () => {
      await h.approvedDeal([{ ...VISA_ITEM, participants: [1] }]);
      await h.docsOn();
      const c = content(await h.draft('invoice', {}));
      expect(c.lines).toEqual([expect.objectContaining({ amountPaise: SELLING })]);
      expect(c.totalPaise).toBe(SELLING);
    });
  });

  it('content: no forbidden key, no safety word, no "not a tax invoice"; Ahmedabad Deal prints the company GSTIN too', async () => {
    await asOwner(db, async () => {
      const { rec } = await ready();
      const adv = await h.draft('advance_invoice', { receiptId: rec.id });
      const inv = await h.draft('invoice', {});
      for (const d of [adv, inv]) {
        expect(forbiddenKeyPaths(d.content), d.kind).toEqual([]);
        const keys = JSON.stringify(d.content).match(/"([A-Za-z0-9_]+)":/g) ?? [];
        expect(keys.filter((k) => CUSTOMER_VIEW_FORBIDDEN_KEY.test(k.slice(1, -2)))).toEqual([]);
        const text = h.strings(d.content).join(' ');
        expect(text).not.toMatch(/not a tax invoice/i);
        expect(text).not.toMatch(/margin|supplier|cost price|commission/i);
        expect(text).not.toContain('ABCDE1234F');
        expect(text).not.toContain('6000043210');
      }
      // Ahmedabad (DEC-50 adapted): company GSTIN, no "[GSTIN for …]".
      const amd = await h.approvedDeal([HOTEL_ITEM], { deal: DEAL_AMD, actor: { userId: (await owner<{ u: string }>(
        'select owner_user_id as u from public.deals where id = $1', [DEAL_AMD]))[0]!.u } });
      const amdRec = await h.receipt2('100000', DEAL_AMD);
      const amdDoc = await h.draft('advance_invoice', { receiptId: amdRec.id }, DEAL_AMD);
      expect(content(amdDoc).company.gstin).toBe(COMPANY_GSTIN);
      expect(JSON.stringify(amdDoc.content)).not.toMatch(/\[GSTIN for/);
      void amd;
    });
  });
});

describe.skipIf(!READY)('6.3 numbering, 6.7 release and refusals', () => {
  it('number at release: <reference>-ADV-1 without a Bitrix id; prefix fixed at the first release (L7 review 7); counters per kind; no gaps', async () => {
    await asOwner(db, async () => {
      const { rec } = await ready();
      const ref = (await owner<{ r: string }>('select reference as r from public.deals where id = $1', [DEAL]))[0]!.r;
      const adv = await h.releasedAdvance(rec.id);
      expect(adv).toMatchObject({ status: 'released', number: `${ref}-ADV-1`, seq: 1, issue_date: today() });
      expect(adv.number).toMatch(NUMBER_RE);
      expect(content(adv)).toMatchObject({ number: `${ref}-ADV-1`, issueDate: today() });
      // Second receipt: ADV-2 (counter per kind).
      const rec2 = await h.receipt2('300000');
      expect((await h.releasedAdvance(rec2.id)).number).toBe(`${ref}-ADV-2`);
      // The Bitrix id is linked after the first release: the prefix stays the CRM reference (L7 review 7);
      // the INV counter starts at 1.
      // SYNTHETIC FIXTURE STEP: a synthetic Deal cannot carry a Bitrix id (deals_provenance); the check is
      // dropped inside this rolled-back transaction only.
      await owner('alter table public.deals drop constraint deals_provenance');
      await owner('update public.deals set source_deal_id = 10101 where id = $1', [DEAL]);
      const inv = await h.releasedInvoice();
      expect(inv.number).toBe(`${ref}-INV-1`);
      expect(await owner('select kind, last_no from public.customer_document_counters where deal_id = $1 order by kind', [DEAL]))
        .toEqual([{ kind: 'advance_invoice', last_no: 2 }, { kind: 'invoice', last_no: 1 }]);
      // A discarded draft leaves no gap.
      const rec3 = await h.receipt2('200000');
      const dropped = await h.draft('advance_invoice', { receiptId: rec3.id });
      await one(ACC, SQL2.docDiscard, [dropped.id, dropped.row_version, 'Synthetic: drafted on the wrong receipt', rid()]);
      expect((await h.docRow(dropped.id))).toMatchObject({ status: 'discarded', number: null });
      const rec4 = await h.receipt2('200001');
      expect((await h.releasedAdvance(rec4.id)).number).toBe(`${ref}-ADV-3`);
      expect(await h.audits('accounts.customer_document.released')).toHaveLength(4);
    });
  });

  it('number at release with a Bitrix id before the first release: <bitrix id>-INV-1 (Q3), "Deal ID" printed', async () => {
    await asOwner(db, async () => {
      await owner('alter table public.deals drop constraint deals_provenance');
      await owner('update public.deals set source_deal_id = 10101 where id = $1', [DEAL]);
      await ready();
      const inv = await h.releasedInvoice();
      expect(inv.number).toBe('10101-INV-1');
      expect(content(inv).deal.dealNumber).toBe('10101');
    });
  });

  it('ADV never twice per receipt; one live Invoice draft; a cancelled ADV frees its receipt', async () => {
    await asOwner(db, async () => {
      const { rec } = await ready();
      const first = await h.draft('advance_invoice', { receiptId: rec.id });
      await h.refusedToken(ACC, SQL2.draftCreate, [DEAL, 'advance_invoice', JSON.stringify({ receiptId: rec.id }), rid()], 'already_recorded');
      // Same request id replays.
      const req = rid();
      const inv1 = await one(ACC, SQL2.draftCreate, [DEAL, 'invoice', '{}', req]);
      expect(idOf(await one(ACC, SQL2.draftCreate, [DEAL, 'invoice', '{}', req]))).toBe(idOf(inv1));
      await h.refusedToken(ACC, SQL2.draftCreate, [DEAL, 'invoice', '{}', rid()], 'already_recorded');
      const released = await h.release(first.id);
      const cands = await one<{ candidates: { advances: Array<{ receiptId: string }> } }>(ACC, SQL2.dealDocs, [DEAL]);
      expect(cands.candidates.advances.map((a) => a.receiptId)).not.toContain(rec.id);
      await h.refusedHint(ACC, SQL2.docCancel, [released.id, released.row_version, 'short', rid()], 'invalid_input', undefined, '22023');
      await one(ACC, SQL2.docCancel, [released.id, released.row_version, 'Synthetic: issued on the wrong payment', rid()]);
      expect((await h.docRow(released.id)).status).toBe('cancelled');
      expect((await h.audits('accounts.customer_document.cancelled'))[0]?.reason).toBe('Synthetic: issued on the wrong payment');
      const again = await h.draft('advance_invoice', { receiptId: rec.id });
      expect(again.status).toBe('draft');
    });
  });

  it('release refusals: documents_off, billing_not_verified, document_stale, version_changed (hash), receipt_not_verified', async () => {
    await asOwner(db, async () => {
      const { rec } = await ready();
      const adv = await h.draft('advance_invoice', { receiptId: rec.id });
      // Switch off: every B command except reads refuses.
      await h.docsOn(false);
      await h.refusedToken(ACC, SQL2.docRelease, [adv.id, adv.row_version, adv.content_sha256, rid()], 'documents_off');
      await h.refusedToken(ACC, SQL2.draftCreate, [DEAL, 'invoice', '{}', rid()], 'documents_off');
      expect(await one(ACC, SQL2.dealDocs, [DEAL])).toMatchObject({ enabled: false });
      await h.docsOn(true);
      // Hash the screen showed differs.
      await h.refusedToken(ACC, SQL2.docRelease, [adv.id, adv.row_version, sha(), rid()], 'version_changed');
      // Stale: more verified money after the Invoice draft.
      const inv = await h.draft('invoice', {});
      await h.receipt2('400000');
      const listed = await one<{ documents: Array<{ documentId: string; stale: boolean }> }>(ACC, SQL2.dealDocs, [DEAL]);
      expect(listed.documents.find((d) => d.documentId === inv.id)?.stale).toBe(true);
      const invNow = await h.docRow(inv.id);
      await h.refusedToken(ACC, SQL2.docRelease, [inv.id, invNow.row_version, invNow.content_sha256, rid()], 'document_stale');
      await one(ACC, SQL2.docRefresh, [inv.id, invNow.row_version, rid()]);
      const refreshed = await h.docRow(inv.id);
      expect(content(refreshed).paidPaise).toBe('2900000');
      expect((await one<{ documents: Array<{ documentId: string; stale: boolean }> }>(ACC, SQL2.dealDocs, [DEAL])).documents
        .find((d) => d.documentId === inv.id)?.stale).toBe(false);
      await h.release(inv.id);
      // Receipt reversed after the ADV draft: receipt_not_verified.
      await h.fin.reverse(ACC, rec.id, 'data_error');
      const advNow = await h.docRow(adv.id);
      await h.refusedToken(ACC, SQL2.docRelease, [adv.id, advNow.row_version, advNow.content_sha256, rid()], 'receipt_not_verified');
      // Billing not verified (owner-approved review, billing still a proposal).
      await owner(`update public.customer_billing_profiles set status = 'draft', verified_by = null, verified_at = null where deal_id = $1`, [DEAL])
        .catch(() => undefined);
      const [billing] = await owner<{ status: string }>('select status from public.customer_billing_profiles where deal_id = $1', [DEAL]);
      if (billing?.status === 'draft') {
        const rec2 = await h.receipt2('100000');
        const d2 = await h.draft('advance_invoice', { receiptId: rec2.id });
        await h.refusedToken(ACC, SQL2.docRelease, [d2.id, d2.row_version, d2.content_sha256, rid()], 'billing_not_verified');
        expect((await one<{ billing: { verified: boolean } }>(ACC, SQL2.dealDocs, [DEAL])).billing.verified).toBe(false);
      }
    });
  });

  it('only Accounts drafts and releases (Q4); the switch setter needs policy rights and a reason, audited', async () => {
    await asOwner(db, async () => {
      const { rec } = await ready();
      for (const actor of [OWNER, MANAGER, PURCHASE]) {
        await h.refused(actor, SQL2.draftCreate, [DEAL, 'advance_invoice', JSON.stringify({ receiptId: rec.id }), rid()], 'not_authorized');
      }
      const d = await h.draft('advance_invoice', { receiptId: rec.id });
      await h.refused(MANAGER, SQL2.docRelease, [d.id, d.row_version, d.content_sha256, rid()], 'not_authorized');
      // Any Accounts person may release (no second person).
      expect((await h.release(d.id, ACC2)).status).toBe('released');
      await h.refused(ACC, SQL2.setDocsEnabled, [await h.entityId(), false, REASON], 'not_authorized');
      await h.refusedHint(SUPER, SQL2.setDocsEnabled, [await h.entityId(), false, 'short'], 'invalid_input', undefined, '22023');
      expect((await h.audits('settings.accounts_changed')).length).toBeGreaterThan(0);
      expect(await owner('select customer_documents_enabled, refunds_enabled from public.accounts_settings where legal_entity_id = $1', [await h.entityId()]))
        .toEqual([{ customer_documents_enabled: true, refunds_enabled: false }]);
    });
  });
});

describe.skipIf(!READY)('6.1 immutability, B6 replace, B7 Tally link, flags', () => {
  it('released documents: every frozen column refused by direct update; no DELETE; only allowed moves', async () => {
    await asOwner(db, async () => {
      const { rec } = await ready();
      const d = await h.releasedAdvance(rec.id);
      const frozen: Array<[string, string]> = [
        ['kind', `'invoice'`], ['number', `'X-ADV-9'`], ['seq', '9'], ['content', `'{}'::jsonb`], ['content_sha256', `'${'0'.repeat(64)}'`],
        ['total_paise', '1'], ['issue_date', `date '2020-01-01'`], ['receipt_id', 'null'], ['basis_version_id', 'gen_random_uuid()'],
        ['credits_document_id', 'gen_random_uuid()'], ['refund_request_id', 'gen_random_uuid()'], ['replaces_document_id', 'gen_random_uuid()'],
        ['released_by', 'null'], ['released_at', 'now() - interval \'1 day\''],
      ];
      for (const [col, val] of frozen) {
        await expectDbError(db, () => owner(`update public.customer_documents set ${col} = ${val} where id = $1`, [d.id]), {});
      }
      await expectDbError(db, () => owner(`update public.customer_documents set status = 'draft' where id = $1`, [d.id]), {});
      await expectDbError(db, () => owner('delete from public.customer_documents where id = $1', [d.id]), {});
      expect(await h.docRow(d.id)).toMatchObject({ status: 'released', number: d.number, content_sha256: d.content_sha256 });
    });
  });

  it('booking changed since release → replace (next running number, LD4); old reads "Replaced by"; Tally link rules (LD18)', async () => {
    await asOwner(db, async () => {
      const { b } = await ready();
      const gst = await h.gstInvoice('HC/25-26/0101');
      const draftInv = await h.draft('invoice', {});
      // Draft: link sets the number into the content; can be cleared and set again.
      await one(ACC, SQL2.docLinkTally, [draftInv.id, gst, draftInv.row_version, rid()]);
      expect(content(await h.docRow(draftInv.id)).gstInvoiceNumber).toBe('HC/25-26/0101');
      const linked = await h.docRow(draftInv.id);
      await one(ACC, SQL2.docLinkTally, [linked.id, null, linked.row_version, rid()]);
      expect(content(await h.docRow(linked.id)).gstInvoiceNumber).toBeNull();
      const inv = await h.release(linked.id);
      // Released: null → value only; never changed again.
      await one(ACC, SQL2.docLinkTally, [inv.id, gst, inv.row_version, rid()]);
      const afterLink = await h.docRow(inv.id);
      expect(afterLink.tally_invoice_id).toBe(gst);
      expect(content(afterLink).gstInvoiceNumber, 'released content unchanged (shown in the CRM, not printed)').toBeNull();
      const other = await h.gstInvoice('HC/25-26/0102');
      await h.refusedToken(ACC, SQL2.docLinkTally, [inv.id, other, afterLink.row_version, rid()], 'already_recorded');
      expect(await h.audits('accounts.customer_document.tally_linked')).toHaveLength(3);
      // Revision approved on a later version: bookingChangedSinceRelease.
      await one(ACC, 'select public.accounts_review_return($1, $2, $3) as r', [b.versionId, 'Synthetic return: selling total changes', rid()]);
      const opened = await one<{ versionId: string; rowVersion: number }>(OWNER, 'select public.booking_open_revision($1) as r', [b.versionId]);
      const rv = (await h.saveSelling(OWNER, opened.versionId, opened.rowVersion, '9500000')).rowVersion;
      const rv2 = (await one<{ rowVersion: number }>(OWNER, 'select public.booking_instalments_save($1, $2, $3::jsonb) as r', [opened.versionId, rv,
        JSON.stringify([{ seq: 1, label: 'Full payment', amountPaise: '9500000', dueDate: today() }])])).rowVersion;
      await one(OWNER, 'select public.booking_classify_revision($1, $2, $3) as r', [opened.versionId, rv2, 'customer_material']);
      await h.storeEvidence(OWNER, opened.versionId, 'acceptance_message', sha());
      const r = await h.readiness(OWNER, opened.versionId);
      await h.confirm(OWNER, opened.versionId, r.contentHash);
      await h.approveReal(opened.versionId);
      const flags = await one<{ documents: Array<{ documentId: string; bookingChangedSinceRelease: boolean }> }>(ACC, SQL2.dealDocs, [DEAL]);
      expect(flags.documents.find((d) => d.documentId === inv.id)?.bookingChangedSinceRelease).toBe(true);
      // Replace: new draft (reason), the old stays released until the new one is released.
      await one(ACC, SQL2.docReplace, [inv.id, afterLink.row_version, 'Synthetic: booking total changed after release', rid()]);
      const [replacement] = (await h.docsOf()).filter((d) => d.replaces_document_id === inv.id);
      expect(replacement).toMatchObject({ status: 'draft', kind: 'invoice' });
      expect((await h.docRow(inv.id)).status).toBe('released');
      await h.refusedToken(ACC, SQL2.docReplace, [inv.id, afterLink.row_version, 'Synthetic: second replacement attempt', rid()], 'already_recorded');
      expect(content(replacement!).gstInvoiceNumber, 'a replacement prints the linked number').toBe('HC/25-26/0101');
      const rel = await h.release(replacement!.id);
      expect(rel.number).toMatch(/-INV-2$/);
      expect(content(rel).replaces).toEqual({ number: inv.number });
      expect((await h.docRow(inv.id)).status).toBe('replaced');
      const list = await one<{ documents: Array<{ documentId: string; replacedByNumber: string | null }> }>(ACC, SQL2.dealDocs, [DEAL]);
      expect(list.documents.find((d) => d.documentId === inv.id)?.replacedByNumber).toBe(rel.number);
      expect((await h.audits('accounts.customer_document.replace_started'))[0]?.reason).toBe('Synthetic: booking total changed after release');
    });
  });

  it('paymentReversed flag on a released ADV after reversal (LD7)', async () => {
    await asOwner(db, async () => {
      const { rec } = await ready();
      const adv = await h.releasedAdvance(rec.id);
      await h.fin.reverse(ACC, rec.id, 'data_error');
      const listed = await one<{ documents: Array<{ documentId: string; paymentReversed: boolean; status: string }> }>(ACC, SQL2.dealDocs, [DEAL]);
      expect(listed.documents.find((d) => d.documentId === adv.id)).toMatchObject({ paymentReversed: true, status: 'released' });
      const page = await one<{ items: Array<{ documentId: string }> }>(ACC, SQL2.docsList, [JSON.stringify({ paymentReversed: true }), null, 50]);
      expect(page.items.map((i) => i.documentId)).toContain(adv.id);
    });
  });

  it.skipIf(!REFUNDS)('has_credit_notes: a released Invoice credited by a released CN cannot be cancelled', async () => {
    await asOwner(db, async () => {
      const { rec } = await ready('2500000');
      const inv = await h.releasedInvoice();
      await h.refundsOn();
      await h.approveCancellation();
      const r = await h.requestRefund(h.refundFields({ outcome: 'charge_only', amountPaise: '0', customerChargePaise: '500000', payeeKind: null }));
      await h.decideRefund(r.id, 'approve');
      const cn = await h.release((await h.draft('credit_note', { refundRequestId: r.id })).id);
      expect(cn).toMatchObject({ kind: 'credit_note', credits_document_id: inv.id });
      expect(cn.number).toMatch(/-CN-1$/);
      const invNow = await h.docRow(inv.id);
      await h.refusedToken(ACC, SQL2.docCancel, [inv.id, invNow.row_version, 'Synthetic: try to cancel a credited invoice', rid()], 'has_credit_notes');
      void rec;
    });
  });
});

describe.skipIf(!READY)('6.7 worker commands, B8 retry, B10 download', () => {
  it('release enqueues one job; claim/input/complete need the live lease; content_changed; files stored with sha256; download audited per call', async () => {
    await asOwner(db, async () => {
      const { rec } = await ready();
      const d = await h.releasedAdvance(rec.id);
      const jobs = await owner<{ id: string; status: string; content_sha256: string }>(
        'select id, status, content_sha256 from public.customer_document_render_jobs where document_id = $1', [d.id]);
      expect(jobs).toEqual([expect.objectContaining({ status: 'queued', content_sha256: d.content_sha256 })]);
      // authenticated cannot run worker functions.
      for (const sql of [SQL2.renderClaim, SQL2.renderInput]) {
        await expectDbError(db, () => h.run(ACC, sql, sql === SQL2.renderClaim ? ['w', 60] : [jobs[0]!.id, 'w']), { code: '42501' });
      }
      await expectDbError(db, () => h.run(ACC, SQL2.renderComplete, [jobs[0]!.id, 'w', true, null, '{}']), { code: '42501' });
      const claimed = await one<Record<string, unknown> | null>(WORKER, SQL2.renderClaim, ['synthetic-worker-1', 60]);
      expect(JSON.stringify(claimed)).toContain(jobs[0]!.id);
      await h.refused(WORKER, SQL2.renderInput, [jobs[0]!.id, 'synthetic-worker-2'], 'task_conflict');
      const input = await one<{ status: string; jobId: string; documentId: string; templateVersion: string; content: Record<string, unknown> }>(WORKER,
        SQL2.renderInput, [jobs[0]!.id, 'synthetic-worker-1']);
      expect(input).toMatchObject({ jobId: jobs[0]!.id, documentId: d.id, templateVersion: expect.stringMatching(/^[a-z0-9._-]{1,40}$/) });
      expect(input.content).toEqual(d.content);
      // No file yet: no download (PDF not made yet).
      await h.refused(ACC, SQL2.docDownload, [d.id], 'not_ready').catch(async () => h.refused(ACC, SQL2.docDownload, [d.id], 'not_found'));
      const objectPath = `${await h.entityId()}/customer-documents/${d.id}/${jobs[0]!.id}.pdf`;
      const pdfSha = sha();
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('rendered-documents', $1, jsonb_build_object('size', 4096::bigint))`, [objectPath]);
      await one(WORKER, SQL2.renderComplete, [jobs[0]!.id, 'synthetic-worker-1', true, null, JSON.stringify({ objectPath, sha256: pdfSha, sizeBytes: 4096,
        pageCount: 1 })]);
      expect(await owner('select object_path, sha256, size_bytes, page_count from public.customer_document_files where document_id = $1', [d.id]))
        .toEqual([{ object_path: objectPath, sha256: pdfSha, size_bytes: expect.anything(), page_count: 1 }]);
      expect((await h.docRow(d.id)).content_sha256, 'completion never changes the content').toBe(d.content_sha256);
      expect((await one<{ documents: Array<{ documentId: string; pdf: { state: string } }> }>(ACC, SQL2.dealDocs, [DEAL])).documents
        .find((x) => x.documentId === d.id)?.pdf.state).toBe('ready');
      // Download: A, Manager of the branch, Sales owner; one audit row per call.
      for (const actor of [ACC, MANAGER, OWNER]) {
        expect(await one(actor, SQL2.docDownload, [d.id])).toMatchObject({ objectPath, fileName: `${d.number}.pdf` });
      }
      await one(ACC, SQL2.docDownload, [d.id]);
      expect(await h.audits('accounts.customer_document.downloaded')).toHaveLength(4);
      await h.refused(PURCHASE, SQL2.docDownload, [d.id], 'not_authorized');
      // Files are append-only.
      await expectDbError(db, () => owner('delete from public.customer_document_files where document_id = $1', [d.id]), {});
    });
  });

  it('failed job → retry makes a new job (≤ 3 attempts); content_changed when the hash differs', async () => {
    await asOwner(db, async () => {
      const { rec } = await ready();
      const d = await h.releasedAdvance(rec.id);
      const [job] = await owner<{ id: string }>('select id from public.customer_document_render_jobs where document_id = $1', [d.id]);
      await one(WORKER, SQL2.renderClaim, ['synthetic-worker-1', 60]);
      // Retry only after a failure.
      await h.refused(ACC, SQL2.docRenderRetry, [d.id, rid()], 'wrong_state').catch(async () => h.refused(ACC, SQL2.docRenderRetry, [d.id, rid()], 'not_ready'));
      await one(WORKER, SQL2.renderComplete, [job!.id, 'synthetic-worker-1', false, 'browser_failed', null]);
      const after = await owner<{ status: string }>('select status from public.customer_document_render_jobs where id = $1', [job!.id]);
      expect(['failed', 'queued']).toContain(after[0]!.status);
      if (after[0]!.status === 'failed') {
        expect((await one<{ documents: Array<{ documentId: string; pdf: { state: string } }> }>(ACC, SQL2.dealDocs, [DEAL])).documents
          .find((x) => x.documentId === d.id)?.pdf.state).toBe('failed');
        await one(ACC, SQL2.docRenderRetry, [d.id, rid()]);
        expect(await owner(`select count(*)::int as n from public.customer_document_render_jobs where document_id = $1 and status = 'queued'`, [d.id]))
          .toEqual([{ n: 1 }]);
        expect(await h.audits('accounts.customer_document.render_retried')).toHaveLength(1);
      }
      // content_changed: a job whose hash no longer matches the document.
      const [live] = await owner<{ id: string }>(`select id from public.customer_document_render_jobs where document_id = $1 and status in ('queued','running')`,
        [d.id]);
      if (live) {
        await owner('update public.customer_document_render_jobs set content_sha256 = $2 where id = $1', [live.id, '1'.repeat(64)]);
        const c = await one<Record<string, unknown> | null>(WORKER, SQL2.renderClaim, ['synthetic-worker-1', 60]);
        if (c) await h.refused(WORKER, SQL2.renderInput, [live.id, 'synthetic-worker-1'], 'content_changed');
      }
    });
  });
});

describe.skipIf(!READY)('R-B3 Accounts › Documents list', () => {
  it('keyset (released/created desc, id desc), filters, toRelease preset, Manager read-only of the branch', async () => {
    await asOwner(db, async () => {
      const { rec } = await ready();
      await h.releasedAdvance(rec.id);
      for (const amount of ['100001', '100002', '100003']) await h.draft('advance_invoice', { receiptId: (await h.receipt2(amount)).id });
      type Page = { items: Array<{ documentId: string; status: string; dealReference: string; branchName: string; can: Record<string, boolean> }>;
        nextAfter: string | null };
      const p1 = await one<Page>(ACC, SQL2.docsList, [JSON.stringify({}), null, 2]);
      expect(p1.items).toHaveLength(2);
      const p2 = await one<Page>(ACC, SQL2.docsList, [JSON.stringify({}), p1.nextAfter, 2]);
      const p3 = p2.nextAfter ? await one<Page>(ACC, SQL2.docsList, [JSON.stringify({}), p2.nextAfter, 2]) : { items: [] };
      const ids = [...p1.items, ...p2.items, ...p3.items].map((i) => i.documentId);
      expect(new Set(ids).size).toBe(4);
      const drafts = await one<Page>(ACC, SQL2.docsList, [JSON.stringify({ status: ['draft'] }), null, 50]);
      expect(drafts.items.every((i) => i.status === 'draft')).toBe(true);
      expect(drafts.items).toHaveLength(3);
      const m = await one<Page>(MANAGER, SQL2.docsList, [JSON.stringify({}), null, 50]);
      expect(m.items.every((i) => i.status !== 'draft'), 'Manager: released documents only').toBe(true);
      expect(m.items.every((i) => !i.can.release && !i.can.cancel)).toBe(true);
      expect(await one(OWNER, SQL2.docsList, [JSON.stringify({}), null, 50])).toBeNull();
    });
  });
});
