import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACC2_FIXTURE_USERS, type Actor, type TestDb, activateAcc2People, asOwner, createTestDb, expectDbError } from '../helpers/db';
import { companyIdentityFor } from '@/modules/documents/company-identity';
import { forbiddenKeyPaths } from '@/modules/documents/guard';
import { CustomerDocumentContentSchema } from '@/modules/customer-documents/content';
import {
  ACC, ACC2, DEAL, FLIGHT, FLIGHT_ITEM, HOTEL_ITEM, VISA_ITEM, MANAGER, OWNER, PURCHASE, REASON, SALES_B, SELLING, SUPER, accHelpers, rid, today,
} from './acc-support';

/**
 * Accounts phase 2, Track B builder tests (contract section 6): customer
 * documents on PGlite. Sources and content (6.3, 6.4), numbering, release
 * refusals, replace / cancel / discard, Tally link (LD18), fences (section
 * 10), worker commands and download audit. Track F's suites are independent.
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
const WORKER: Actor = { userId: null, role: 'service_role' };

const SQL = {
  draft: 'select public.customer_document_draft_create($1, $2, $3::jsonb, $4) as r',
  refresh: 'select public.customer_document_refresh($1, $2, $3) as r',
  release: 'select public.customer_document_release($1, $2, $3, $4) as r',
  discard: 'select public.customer_document_discard($1, $2, $3, $4) as r',
  cancel: 'select public.customer_document_cancel($1, $2, $3, $4) as r',
  replace: 'select public.customer_document_replace($1, $2, $3, $4) as r',
  link: 'select public.customer_document_link_tally($1, $2, $3, $4) as r',
  retry: 'select public.customer_document_render_retry($1, $2) as r',
  download: 'select public.customer_document_authorize_download($1) as r',
  setOn: 'select public.admin_set_customer_documents_enabled($1, $2, $3) as r',
  settings: 'select public.admin_customer_documents_settings($1) as r',
  dealDocs: 'select public.deal_customer_documents($1) as r',
  get: 'select public.customer_document_get($1) as r',
  list: 'select public.customer_documents_list($1::jsonb, $2, $3) as r',
  claim: 'select public.customer_document_render_claim($1, $2) as r',
  input: 'select public.customer_document_render_input($1, $2) as r',
  complete: 'select public.customer_document_render_complete($1, $2, $3, $4, $5::jsonb) as r',
  invoiceAdd: 'select public.accounts_tally_invoice_add($1, $2::jsonb, $3) as r',
} as const;

type Done = { outcome: string; documentId: string; status: string; number: string | null; rowVersion: number; contentSha256: string;
  warnings?: string[]; renderJobId?: string; seq?: number };
type Content = Record<string, unknown> & { lines: Array<{ label: string; amountPaise: string }>; number: string | null; totalPaise: string;
  paidPaise: string; company: { gstin: string; gstinState: string | null }; replaces: { number: string } | null; gstInvoiceNumber: string | null;
  plan?: unknown[] };
type DocRow = { documentId: string; status: string; number: string | null; stale: boolean; bookingChangedSinceRelease: boolean;
  paymentReversed: boolean; pdf: { state: string; fileId: string | null }; replacedByNumber: string | null; replacesNumber: string | null;
  gstInvoiceNumber: string | null; endReason?: string | null; releasedByName?: string | null; can: Record<string, boolean> };
type DealDocs = { viewer: string; enabled: boolean; billing: { verified: boolean; missing: boolean };
  candidates: { advances: Array<{ receiptId: string }>; invoice: { totalPaise: string; lines: unknown[] } | null; creditNotes: unknown[] } | null;
  documents: DocRow[] };

const docsOn = async (on = true) => one(SUPER, SQL.setOn, [await h.entityId(), on, REASON]);
const content = async (id: string) => (await owner<{ content: Content }>('select content from public.customer_documents where id = $1', [id]))[0]!.content;
const draft = (kind: string, source: Record<string, unknown> = {}, deal = DEAL) => one<Done>(ACC, SQL.draft, [deal, kind, JSON.stringify(source), rid()]);
const release = (d: Done) => one<Done>(ACC, SQL.release, [d.documentId, d.rowVersion, d.contentSha256, rid()]);

/** Hotel Deal approved by Accounts (billing saved and verified), documents switched on, ACC2 verifies receipts. */
async function base() {
  await h.addAcc2();
  const b = await h.book([HOTEL_ITEM]);
  await h.approveReal(b.versionId);
  await docsOn();
  return b;
}

describe('B9 switch and documents_off', () => {
  it('default Off; policy manager switches it with a reason; every command refuses documents_off while Off', async () => {
    await asOwner(db, async () => {
      await h.addAcc2();
      const b = await h.book([HOTEL_ITEM]);
      await h.approveReal(b.versionId);
      const rec = await h.receipt(DEAL, '2500000');
      expect(await one(SUPER, SQL.settings, [await h.entityId()])).toMatchObject({ customerDocumentsEnabled: false, refundsEnabled: false });
      await refused(ACC, SQL.draft, [DEAL, 'advance_invoice', JSON.stringify({ receiptId: rec.id }), rid()], 'documents_off', '55000');
      await refused(ACC, SQL.setOn, [await h.entityId(), true, REASON], 'not_authorized', '42501');
      await refusedHint(SUPER, SQL.setOn, [await h.entityId(), true, 'short'], 'invalid_input', /reason/);
      expect(await docsOn()).toMatchObject({ changed: true, customerDocumentsEnabled: true });
      const [audit] = (await h.audits('settings.accounts_changed')).slice(-1);
      expect(audit!.details).toMatchObject({ command: 'admin_set_customer_documents_enabled' });
      expect((audit!.details as { columns: string[] }).columns).toContain('customer_documents_enabled');
      expect(audit!.reason).toBe(REASON);
      const d = await draft('advance_invoice', { receiptId: rec.id });
      await docsOn(false);
      await refused(ACC, SQL.release, [d.documentId, d.rowVersion, d.contentSha256, rid()], 'documents_off', '55000');
    });
  });
});

describe('6.3 / 6.4 Advance Invoice', () => {
  it('draft from a verified receipt, frozen content, release numbers <reference>-ADV-1, never twice per receipt', async () => {
    await asOwner(db, async () => {
      await base();
      const rec = await h.receipt(DEAL, '2500000');
      const view = await one<DealDocs>(ACC, SQL.dealDocs, [DEAL]);
      expect(view.viewer).toBe('accounts');
      expect(view.candidates!.advances.map((a) => a.receiptId)).toEqual([rec.id]);
      const d = await draft('advance_invoice', { receiptId: rec.id });
      expect(d).toMatchObject({ outcome: 'created', status: 'draft', number: null });
      const c = await content(d.documentId);
      expect(CustomerDocumentContentSchema.safeParse(c).success).toBe(true);
      expect(c).toMatchObject({ schema: 'cdoc-1', kind: 'advance_invoice', title: 'Advance Invoice', number: null, issueDate: null,
        lines: [{ label: 'Advance received', amountPaise: '2500000' }], totalPaise: '2500000', paidPaise: '2500000' });
      expect(c.payment).toMatchObject({ reference: expect.stringMatching(/^R-/), receivedOn: expect.any(String) });
      expect(forbiddenKeyPaths(c)).toEqual([]);
      expect(JSON.stringify(c).toLowerCase()).not.toContain('not a tax invoice');
      // Q2 / LD1: Delhi Deal prints the company GSTIN; SQL mirror equals the TS record.
      const line = companyIdentityFor('DEL');
      expect(c.company).toEqual({ legalName: line.legalName, registeredAddress: line.registeredAddress, pan: line.pan, gstin: line.gstin,
        gstinState: line.gstinState });
      // Never twice for the same receipt.
      await refused(ACC, SQL.draft, [DEAL, 'advance_invoice', JSON.stringify({ receiptId: rec.id }), rid()], 'already_recorded', '55000');
      expect((await one<DealDocs>(ACC, SQL.dealDocs, [DEAL])).candidates!.advances).toEqual([]);
      // Release: number and issue date, render job queued, audit.
      const r = await release(d);
      const ref = (await owner<{ reference: string }>('select reference from public.deals where id = $1', [DEAL]))[0]!.reference;
      expect(r).toMatchObject({ status: 'released', number: `${ref}-ADV-1`, seq: 1 });
      const after = await content(d.documentId);
      expect(after).toMatchObject({ number: `${ref}-ADV-1`, issueDate: today() });
      expect(r.contentSha256).not.toBe(d.contentSha256);
      expect(await owner('select status, content_sha256 from public.customer_document_render_jobs where document_id = $1', [d.documentId]))
        .toEqual([{ status: 'queued', content_sha256: r.contentSha256 }]);
      expect((await h.audits('accounts.customer_document.released'))[0]!.details).toMatchObject({ documentId: d.documentId, kind: 'advance_invoice', seq: 1 });
      // Second receipt -> ADV-2 (counter per Deal and kind).
      const rec2 = await h.receipt(DEAL, '100000');
      expect((await release(await draft('advance_invoice', { receiptId: rec2.id }))).number).toBe(`${ref}-ADV-2`);
      // Replay of the same request id returns the stored result.
      const req = rid();
      const rec3 = await h.receipt(DEAL, '200000');
      const first = await one<Done>(ACC, SQL.draft, [DEAL, 'advance_invoice', JSON.stringify({ receiptId: rec3.id }), req]);
      expect(await one<Done>(ACC, SQL.draft, [DEAL, 'advance_invoice', JSON.stringify({ receiptId: rec3.id }), req]))
        .toMatchObject({ outcome: 'existing', documentId: first.documentId });
    });
  });

  it('release refusals: billing not verified, hash mismatch, receipt reversed; not_ready for an unverified receipt', async () => {
    await asOwner(db, async () => {
      await base();
      const rec = await h.receipt(DEAL, '2500000');
      const d = await draft('advance_invoice', { receiptId: rec.id });
      await refused(ACC, SQL.release, [d.documentId, d.rowVersion, '0'.repeat(64), rid()], 'version_changed', '40001');
      await refused(ACC, SQL.release, [d.documentId, d.rowVersion + 1, d.contentSha256, rid()], 'version_changed', '40001');
      await owner(`update public.customer_billing_profiles set status = 'draft', verified_by = null, verified_at = null,
                   row_version = row_version + 1 where deal_id = $1`, [DEAL]).catch(() => undefined);
      const [billing] = await owner<{ status: string }>('select status from public.customer_billing_profiles where deal_id = $1', [DEAL]);
      if (billing!.status === 'draft') {
        await refused(ACC, SQL.release, [d.documentId, d.rowVersion, d.contentSha256, rid()], 'billing_not_verified', '55000');
        const docs = await one<DealDocs>(ACC, SQL.dealDocs, [DEAL]);
        expect(docs.billing).toEqual({ verified: false, missing: false });
        expect(docs.documents[0]!.can.release).toBe(false);
        await owner(`update public.customer_billing_profiles set status = 'verified', verified_by = $2, verified_at = now(),
                     row_version = row_version + 1 where deal_id = $1`, [DEAL, ACC.userId]);
      }
      await one(ACC, 'select public.receipt_reverse($1, $2, $3, $4) as r', [rec.id, 'bank_return', 'Synthetic reversal reason', rid()]);
      await refused(ACC, SQL.release, [d.documentId, d.rowVersion, d.contentSha256, rid()], 'receipt_not_verified', '55000');
      const row = (await one<DealDocs>(ACC, SQL.dealDocs, [DEAL])).documents.find((x) => x.documentId === d.documentId)!;
      expect(row).toMatchObject({ paymentReversed: true, stale: true });
      // A receipt that is not verified money gives no draft.
      const fields = await h.fin.bankFields({ amountPaise: '300000' });
      const unverified = await h.fin.record(ACC, DEAL, fields);
      await refusedHint(ACC, SQL.draft, [DEAL, 'advance_invoice', JSON.stringify({ receiptId: unverified.id }), rid()], 'not_ready', /receiptId/, '55000');
    });
  });
});

describe('6.3 Invoice, stale drafts, replace, Tally link', () => {
  it('one line = selling total, plan, balance; stale after money changes; refresh; one live Invoice', async () => {
    await asOwner(db, async () => {
      await base();
      const view = await one<DealDocs>(ACC, SQL.dealDocs, [DEAL]);
      expect(view.candidates!.invoice).toMatchObject({ totalPaise: SELLING });
      const d = await draft('invoice');
      const c = await content(d.documentId);
      expect(c.lines).toHaveLength(1);
      expect(c.lines[0]!.amountPaise).toBe(SELLING);
      expect(c.lines[0]!.label).toMatch(/^Hotel booking/);
      expect(c).toMatchObject({ totalPaise: SELLING, paidPaise: '0', balancePaise: SELLING });
      expect(Array.isArray(c.plan) && c.plan.length).toBe(1);
      await refused(ACC, SQL.draft, [DEAL, 'invoice', '{}', rid()], 'already_recorded', '55000');
      // Money changes -> the draft is stale; release refused; refresh clears it.
      await h.receipt(DEAL, '100000');
      expect((await one<DealDocs>(ACC, SQL.dealDocs, [DEAL])).documents[0]!.stale).toBe(true);
      await refused(ACC, SQL.release, [d.documentId, d.rowVersion, d.contentSha256, rid()], 'document_stale', '40001');
      const fresh = await one<Done>(ACC, SQL.refresh, [d.documentId, d.rowVersion, rid()]);
      expect((await content(d.documentId)).paidPaise).toBe('100000');
      const r = await release(fresh);
      expect(r.number).toMatch(/-INV-1$/);
      await refused(ACC, SQL.draft, [DEAL, 'invoice', '{}', rid()], 'already_recorded', '55000');
      // Immutable after release (direct owner update refused for frozen columns).
      for (const set of [`content = '{}'::jsonb`, `total_paise = 1`, `number = 'X-INV-9'`, `issue_date = current_date - 1`, `status = 'draft'`]) {
        await expectDbError(db, () => owner(`update public.customer_documents set ${set}, row_version = row_version + 1 where id = $1`,
          [d.documentId]), {});
      }
      await expectDbError(db, () => owner('delete from public.customer_documents where id = $1', [d.documentId]), {});
    });
  });

  it('replace takes the next number; old shows Replaced by; cancel and discard need reasons; Tally link LD18', async () => {
    await asOwner(db, async () => {
      await base();
      const gst = await one<{ id: string }>(ACC, SQL.invoiceAdd, [DEAL, JSON.stringify({ invoiceRef: 'HC/26-27/0101', invoiceDate: today(), note: null }), rid()]);
      const d = await draft('invoice');
      const linked = await one<Done>(ACC, SQL.link, [d.documentId, gst.id, d.rowVersion, rid()]);
      expect((await content(d.documentId)).gstInvoiceNumber).toBe('HC/26-27/0101');
      const cleared = await one<Done>(ACC, SQL.link, [d.documentId, null, linked.rowVersion, rid()]);
      expect((await content(d.documentId)).gstInvoiceNumber).toBeNull();
      const r1 = await release(cleared);
      // LD18: after release null -> value only; content unchanged.
      const after = await one<Done>(ACC, SQL.link, [d.documentId, gst.id, r1.rowVersion, rid()]);
      expect(after.contentSha256).toBe(r1.contentSha256);
      await refused(ACC, SQL.link, [d.documentId, gst.id, after.rowVersion, rid()], 'already_recorded', '55000');
      expect((await one<DealDocs>(ACC, SQL.dealDocs, [DEAL])).documents[0]!.gstInvoiceNumber).toBe('HC/26-27/0101');
      // Replace: reason required; new draft prints the Tally number and replaces.number.
      await refusedHint(ACC, SQL.replace, [d.documentId, after.rowVersion, 'short', rid()], 'invalid_input', /reason/);
      const rep = await one<Done>(ACC, SQL.replace, [d.documentId, after.rowVersion, 'Synthetic: booking total changed after release', rid()]);
      const repContent = await content(rep.documentId);
      expect(repContent.replaces).toEqual({ number: r1.number });
      expect(repContent.gstInvoiceNumber).toBe('HC/26-27/0101');
      await refused(ACC, SQL.replace, [d.documentId, after.rowVersion, REASON, rid()], 'already_recorded', '55000');
      // Cancel of the old one is refused while its replacement is a draft.
      await refusedHint(ACC, SQL.cancel, [d.documentId, after.rowVersion, REASON, rid()], 'wrong_state', /replacement/);
      const r2 = await release(rep);
      expect(r2.number).toMatch(/-INV-2$/);
      const old = (await owner<{ status: string; end_reason: string }>('select status, end_reason from public.customer_documents where id = $1',
        [d.documentId]))[0]!;
      expect(old).toEqual({ status: 'replaced', end_reason: 'Synthetic: booking total changed after release' });
      const rows = (await one<DealDocs>(ACC, SQL.dealDocs, [DEAL])).documents;
      expect(rows.find((x) => x.documentId === d.documentId)).toMatchObject({ replacedByNumber: r2.number });
      expect(rows.find((x) => x.documentId === rep.documentId)).toMatchObject({ replacesNumber: r1.number, status: 'released' });
      // Cancel with reason; has_credit_notes when a released CN credits it (synthetic CN row, owner SQL).
      const cn = rid();
      // SYNTHETIC FIXTURE STEP: a released credit note row without Track C's refund request (its FK lifted in this rolled-back transaction).
      await owner('alter table public.customer_documents drop constraint if exists customer_documents_refund_request_fk');
      await owner(`insert into public.customer_documents (id, legal_entity_id, branch_id, deal_id, kind, status, number, seq, refund_request_id,
          credits_document_id, content, content_sha256, source_hash, total_paise, created_by, request_id, released_by, released_at,
          release_request_id, issue_date)
        select $1, c.legal_entity_id, c.branch_id, c.deal_id, 'credit_note', 'released', 'SYN-CN-1', 1, gen_random_uuid(), c.id, '{}'::jsonb,
          repeat('a', 64), repeat('b', 64), 1, $3, gen_random_uuid(), $3, now(), gen_random_uuid(), current_date
        from public.customer_documents c where c.id = $2`, [cn, rep.documentId, ACC.userId]);
      await refused(ACC, SQL.cancel, [rep.documentId, r2.rowVersion, REASON, rid()], 'has_credit_notes', '55000');
      // Discard a draft with a reason.
      const rec = await h.receipt(DEAL, '100000');
      const adv = await draft('advance_invoice', { receiptId: rec.id });
      const gone = await one<Done>(ACC, SQL.discard, [adv.documentId, adv.rowVersion, REASON, rid()]);
      expect(gone.status).toBe('discarded');
      expect((await h.audits('accounts.customer_document.discarded'))[0]!.reason).toBe(REASON);
      // The receipt is free again.
      expect((await one<DealDocs>(ACC, SQL.dealDocs, [DEAL])).candidates!.advances.map((a) => a.receiptId)).toContain(rec.id);
    });
  });

  it('Bitrix Deal id is the number prefix when known (10101-INV-1)', async () => {
    await asOwner(db, async () => {
      await base();
      // SYNTHETIC FIXTURE STEP: synthetic Deals carry no Bitrix id; the provenance check is lifted inside this rolled-back transaction.
      await owner('alter table public.deals drop constraint deals_provenance');
      await owner('update public.deals set source_deal_id = 10101 where id = $1', [DEAL]);
      const r = await release(await draft('invoice'));
      expect(r.number).toBe('10101-INV-1');
      expect(((await content(r.documentId)).deal as { dealNumber: string }).dealNumber).toBe('10101');
    });
  });
});

describe('6.3 Invoice lines by service class (LD15, LD16)', () => {
  it('flight-only: one line per ticket batch, total = batches, warning when it differs from the booking total', async () => {
    await asOwner(db, async () => {
      await h.addAcc2();
      const b = await h.book([FLIGHT_ITEM]);
      await h.approveReal(b.versionId);
      await docsOn();
      expect((await owner<{ c: string }>('select authz.deal_service_class($1) as c', [b.versionId]))[0]!.c).toBe('flight_domestic');
      await h.flightBatch(DEAL, [1]);
      const [batch] = await owner<{ t: string }>('select customer_total_paise::text as t from public.flight_ticket_batches where deal_id = $1', [DEAL]);
      const d = await draft('invoice');
      const c = await content(d.documentId);
      expect(c.lines).toEqual([{ label: expect.stringMatching(/^Air tickets — batch 1 \(.+ → .+\)$/), amountPaise: batch!.t }]);
      expect(c.totalPaise).toBe(batch!.t);
      expect(d.warnings).toEqual(batch!.t === SELLING ? [] : ['flight_total_differs']);
      expect(forbiddenKeyPaths(c)).toEqual([]);
    });
  });

  it('visa-only: one total line', async () => {
    await asOwner(db, async () => {
      await h.addAcc2();
      const b = await h.book([VISA_ITEM]);
      await h.approveReal(b.versionId);
      await docsOn();
      expect((await owner<{ c: string }>('select authz.deal_service_class($1) as c', [b.versionId]))[0]!.c).toBe('visa');
      const c = await content((await draft('invoice')).documentId);
      expect(c.lines).toHaveLength(1);
      expect(c.lines[0]).toMatchObject({ label: expect.stringMatching(/^Visa services/), amountPaise: SELLING });
    });
  });

  it('Advance Invoice replacement keeps the receipt and takes ADV-2', async () => {
    await asOwner(db, async () => {
      await base();
      const rec = await h.receipt(DEAL, '2500000');
      const r1 = await release(await draft('advance_invoice', { receiptId: rec.id }));
      const rep = await one<Done>(ACC, SQL.replace, [r1.documentId, r1.rowVersion, REASON, rid()]);
      const r2 = await release(rep);
      expect(r2.number).toMatch(/-ADV-2$/);
      expect((await content(r2.documentId)).replaces).toEqual({ number: r1.number });
      await refused(ACC, SQL.draft, [DEAL, 'advance_invoice', JSON.stringify({ receiptId: rec.id }), rid()], 'already_recorded', '55000');
    });
  });
});

describe('Section 10 fences, R-B2, R-B3', () => {
  it('A all; Manager and Sales owner released only with download/printView; Purchase, Visa, other Sales null', async () => {
    await asOwner(db, async () => {
      await base();
      const rec = await h.receipt(DEAL, '2500000');
      const d = await draft('advance_invoice', { receiptId: rec.id });
      await draft('invoice');
      const r = await release(d);
      for (const [actor, viewer] of [[MANAGER, 'manager'], [OWNER, 'sales']] as const) {
        const v = await one<DealDocs>(actor, SQL.dealDocs, [DEAL]);
        expect(v.viewer).toBe(viewer);
        expect(v.candidates).toBeNull();
        expect(v.documents.map((x) => x.documentId)).toEqual([d.documentId]);
        const can = v.documents[0]!.can;
        expect(Object.entries(can).filter(([, on]) => on).map(([k]) => k)).toEqual(['printView']);
        expect(await one(actor, SQL.get, [d.documentId])).toMatchObject({ documentId: d.documentId, content: expect.any(Object) });
      }
      expect((await one<DealDocs>(OWNER, SQL.dealDocs, [DEAL])).documents[0]!.releasedByName).toBeNull();
      await activateAcc2People(db, ['visaJodhpur2', 'flightJodhpur', 'managerFlightDelhi']);
      await h.addFlightPeople();
      const pure: Actor[] = [PURCHASE, SALES_B, FLIGHT, { userId: ACC2_FIXTURE_USERS.visaJodhpur2 }, { userId: ACC2_FIXTURE_USERS.flightJodhpur },
        { userId: ACC2_FIXTURE_USERS.managerFlightDelhi }];
      for (const actor of pure) {
        expect(await one(actor, SQL.dealDocs, [DEAL])).toBeNull();
        expect(await one(actor, SQL.get, [d.documentId])).toBeNull();
        expect(await one(actor, SQL.list, ['{}', null, 50])).toBeNull();
      }
      // List: A sees both, Manager released only; keyset.
      const a = await one<{ items: Array<{ documentId: string; dealReference: string }>; hasMore: boolean; nextAfter: string | null }>(
        ACC, SQL.list, ['{}', null, 1]);
      expect(a.items).toHaveLength(1);
      expect(a.hasMore).toBe(true);
      // List rows carry what the release / cancel / replace forms need (no per-Deal read).
      expect(a.items[0]).toMatchObject({ dealId: DEAL, rowVersion: expect.any(Number), contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        status: expect.any(String), can: expect.any(Object) });
      const a2 = await one<{ items: Array<{ documentId: string }>; hasMore: boolean }>(ACC, SQL.list, ['{}', a.nextAfter, 1]);
      expect(a2.items).toHaveLength(1);
      expect(a2.items[0]!.documentId).not.toBe(a.items[0]!.documentId);
      const m = await one<{ items: Array<{ documentId: string }> }>(MANAGER, SQL.list, ['{}', null, 50]);
      expect(m.items.map((x) => x.documentId)).toEqual([d.documentId]);
      expect((await one<{ items: unknown[] }>(ACC, SQL.list, [JSON.stringify({ toRelease: true }), null, 50])).items).toHaveLength(1);
      expect((await one<{ items: unknown[] }>(ACC, SQL.list, [JSON.stringify({ kind: ['advance_invoice'], pdfState: 'queued' }), null, 50])).items)
        .toHaveLength(1);
      await refusedHint(ACC, SQL.list, [JSON.stringify({ nope: 1 }), null, 50], 'invalid_input', /nope/);
      expect(r.number).toMatch(/-ADV-1$/);
    });
  });
});

describe('6.7 worker commands, B8 retry, B10 download', () => {
  it('claim / input / complete with lease rules; file stored; download audited per call; worker functions service_role only', async () => {
    await asOwner(db, async () => {
      await base();
      const rec = await h.receipt(DEAL, '2500000');
      const r = await release(await draft('advance_invoice', { receiptId: rec.id }));
      for (const fn of ['customer_document_render_claim(text, integer)', 'customer_document_render_input(uuid, text)',
        'customer_document_render_complete(uuid, text, boolean, text, jsonb)']) {
        const [p] = await owner<{ a: boolean; s: boolean }>(
          `select has_function_privilege('authenticated', 'public.${fn}', 'execute') as a, has_function_privilege('service_role', 'public.${fn}', 'execute') as s`);
        expect(p).toEqual({ a: false, s: true });
      }
      const job = await one<{ jobId: string; objectPath: string; contentSha256: string }>(WORKER, SQL.claim, ['local-1', 60]);
      expect(job.contentSha256).toBe(r.contentSha256);
      await refused(WORKER, SQL.input, [job.jobId, 'other-worker'], 'task_conflict', '40001');
      const input = await one<{ status: string; content: Content }>(WORKER, SQL.input, [job.jobId, 'local-1']);
      expect(input.status).toBe('running');
      expect(input.content.number).toBe(r.number);
      // Not uploaded: upload_failed, back to the queue.
      const file = { objectPath: job.objectPath, sha256: 'c'.repeat(64), sizeBytes: 1234, pageCount: 1 };
      expect(await one(WORKER, SQL.complete, [job.jobId, 'local-1', true, null, JSON.stringify(file)])).toMatchObject({ status: 'queued', errorCode: 'upload_failed' });
      await owner(`update public.customer_document_render_jobs set available_at = now() where id = $1`, [job.jobId]);
      const again = await one<{ jobId: string }>(WORKER, SQL.claim, ['local-1', 60]);
      expect(again.jobId).toBe(job.jobId);
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('rendered-documents', $1, jsonb_build_object('size', '1234'))`, [job.objectPath]);
      expect(await one(WORKER, SQL.complete, [job.jobId, 'local-1', true, null, JSON.stringify(file)])).toMatchObject({ status: 'succeeded' });
      const row = (await one<DealDocs>(OWNER, SQL.dealDocs, [DEAL])).documents[0]!;
      expect(row.pdf.state).toBe('ready');
      expect(row.can.download).toBe(true);
      // Download: A, M, SO; one audit row per call; Purchase refused.
      for (const actor of [ACC, MANAGER, OWNER]) {
        expect(await one(actor, SQL.download, [r.documentId])).toMatchObject({ objectPath: job.objectPath, fileName: `${r.number}.pdf` });
      }
      expect(await h.audits('accounts.customer_document.downloaded')).toHaveLength(3);
      await refused(PURCHASE, SQL.download, [r.documentId], 'not_authorized', '42501');
      await refused(ACC, SQL.retry, [r.documentId, rid()], 'wrong_state', '55000');
      await expectDbError(db, () => owner('delete from public.customer_document_files where document_id = $1', [r.documentId]), {});
    });
  });

  it('failed job -> retry makes a new job; content_changed fails the job', async () => {
    await asOwner(db, async () => {
      await base();
      const rec = await h.receipt(DEAL, '2500000');
      const r = await release(await draft('advance_invoice', { receiptId: rec.id }));
      const job = await one<{ jobId: string }>(WORKER, SQL.claim, ['local-1', 60]);
      expect(await one(WORKER, SQL.complete, [job.jobId, 'local-1', false, 'placeholders_present', null])).toMatchObject({ status: 'failed' });
      expect((await one<DealDocs>(ACC, SQL.dealDocs, [DEAL])).documents[0]!.can.retryPdf).toBe(true);
      const retried = await one<{ renderJobId: string }>(ACC, SQL.retry, [r.documentId, rid()]);
      await owner('update public.customer_document_render_jobs set content_sha256 = $2 where id = $1', [retried.renderJobId, 'd'.repeat(64)]);
      const j2 = await one<{ jobId: string }>(WORKER, SQL.claim, ['local-1', 60]);
      expect(await one(WORKER, SQL.input, [j2.jobId, 'local-1'])).toMatchObject({ status: 'failed', errorCode: 'content_changed' });
      expect(await h.audits('accounts.customer_document.render_retried')).toHaveLength(1);
    });
  });
});

describe('Section 4 deal_service_class', () => {
  it('hotel-only version is hotel; ACC2 is an Accounts person', async () => {
    await asOwner(db, async () => {
      const b = await base();
      expect((await owner<{ c: string }>('select authz.deal_service_class($1) as c', [b.versionId]))[0]!.c).toBe('hotel');
      expect((await owner<{ c: string | null }>('select authz.deal_service_class(gen_random_uuid()) as c'))[0]!.c).toBeNull();
      expect(ACC2.userId).toBeTruthy();
    });
  });
});
