import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_DEALS as D, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACC, DEAL, HOTEL_ITEM, REASON, SALES_B, SUPER, accHelpers, rid, today } from './acc-support';

/**
 * Accounts phase 2, Track B: contract Addendum L7 fixes (migration
 * 20261204000240) — review 3 list filters (dynamic, same answers), review 5
 * company_identity_missing, review 6 credits_document_id never rewritten,
 * review 7 prefix fixed on the counter row and number_conflict.
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
const DEAL2 = D.del002;

const SQL = {
  draft: 'select public.customer_document_draft_create($1, $2, $3::jsonb, $4) as r',
  refresh: 'select public.customer_document_refresh($1, $2, $3) as r',
  release: 'select public.customer_document_release($1, $2, $3, $4) as r',
  replace: 'select public.customer_document_replace($1, $2, $3, $4) as r',
  link: 'select public.customer_document_link_tally($1, $2, $3, $4) as r',
  setOn: 'select public.admin_set_customer_documents_enabled($1, $2, $3) as r',
  list: 'select public.customer_documents_list($1::jsonb, $2, $3) as r',
} as const;
type Done = { documentId: string; status: string; number: string | null; rowVersion: number; contentSha256: string };
type Page = { items: Array<{ documentId: string; stale: boolean; bookingChangedSinceRelease: boolean }>; hasMore: boolean };

const draft = (kind: string, source: Record<string, unknown> = {}, deal: string = DEAL) => one<Done>(ACC, SQL.draft, [deal, kind, JSON.stringify(source), rid()]);
const release = (d: Done) => one<Done>(ACC, SQL.release, [d.documentId, d.rowVersion, d.contentSha256, rid()]);

async function base(deal: string = DEAL, actor = undefined as undefined | typeof SALES_B) {
  await h.addAcc2();
  const b = await h.book([HOTEL_ITEM], { deal, ...(actor ? { actor } : {}) });
  await h.approveReal(b.versionId, deal);
  await one(SUPER, SQL.setOn, [await h.entityId(), true, REASON]);
  return b;
}

describe('L7 review 5: company identity', () => {
  it('a Deal whose branch prints the GSTIN placeholder cannot be released (company_identity_missing)', async () => {
    await asOwner(db, async () => {
      await base();
      // SYNTHETIC FIXTURE STEP: the Delhi branch gets a code the company record does not know.
      await owner(`update public.branches set code = 'XDL' where id = (select branch_id from public.deals where id = $1)`, [DEAL]);
      const d = await draft('invoice');
      await refused(ACC, SQL.release, [d.documentId, d.rowVersion, d.contentSha256, rid()], 'company_identity_missing', '55000');
    });
  });
});

describe('L7 review 7: number prefix', () => {
  it('fixed at the first release; a later Bitrix id does not change it; another Deal with the same prefix refuses number_conflict', async () => {
    await asOwner(db, async () => {
      await base();
      // SYNTHETIC FIXTURE STEP: synthetic Deals carry no Bitrix id; the provenance check is lifted in this rolled-back transaction.
      await owner('alter table public.deals drop constraint deals_provenance');
      await owner('update public.deals set source_deal_id = 10101 where id = $1', [DEAL]);
      const rec = await h.receipt(DEAL, '100000');
      expect((await release(await draft('advance_invoice', { receiptId: rec.id }))).number).toBe('10101-ADV-1');
      await owner('update public.deals set source_deal_id = 30303 where id = $1', [DEAL]);
      expect((await release(await draft('invoice'))).number).toBe('10101-INV-1');
      expect(await owner('select kind, prefix from public.customer_document_counters where deal_id = $1 order by kind', [DEAL]))
        .toEqual([{ kind: 'advance_invoice', prefix: '10101' }, { kind: 'invoice', prefix: '10101' }]);
      await expectGuard(() => owner(`update public.customer_document_counters set prefix = 'X' where deal_id = $1`, [DEAL]));
      // Another Deal of the entity whose prefix would be 10101 too.
      await base(DEAL2, SALES_B);
      await owner('update public.deals set source_deal_id = 10101 where id = $1', [DEAL2]);
      const rec2 = await h.receipt(DEAL2, '100000');
      const d2 = await draft('advance_invoice', { receiptId: rec2.id }, DEAL2);
      const hint = await refusedHint(ACC, SQL.release, [d2.documentId, d2.rowVersion, d2.contentSha256, rid()], 'number_conflict',
        /^otherDealReference=/, '23505');
      const ref = (await owner<{ reference: string }>('select reference from public.deals where id = $1', [DEAL]))[0]!.reference;
      expect(hint).toBe(`otherDealReference=${ref}`);
    });
  });
});

async function expectGuard(fn: () => Promise<unknown>): Promise<void> {
  await db.exec('savepoint guard');
  let failed = false;
  try {
    await fn();
  } catch {
    failed = true;
  }
  await db.exec('rollback to savepoint guard');
  expect(failed).toBe(true);
}

describe('L7 review 6: credits_document_id is set once', () => {
  it('refresh and Tally link of a credit note draft whose source moved refuse not_ready (creditsDocumentId), never a raw 42501', async () => {
    await asOwner(db, async () => {
      await base();
      const inv1 = await release(await draft('invoice'));
      // SYNTHETIC FIXTURE STEP: a credit-note source under test control (Track C's function and table set aside in this rolled-back transaction).
      await owner('alter table public.customer_documents drop constraint if exists customer_documents_refund_request_fk');
      await owner(`do $$ begin if to_regclass('public.customer_refund_requests') is not null then
                   alter table public.customer_refund_requests rename to customer_refund_requests_hidden; end if; end $$`);
      await owner('create table public.acc2b_cn_source (credits uuid)');
      await owner('insert into public.acc2b_cn_source values ($1)', [inv1.documentId]);
      await owner(`create or replace function authz.cdoc_credit_note_source(p_refund_request uuid) returns jsonb
                   language sql stable security definer set search_path = '' as $f$
                     select jsonb_build_object('amountPaise', '100000', 'creditsDocumentId', s.credits, 'reasonWords', 'the cancellation',
                       'creditedAdvanceNumbers', '[]'::jsonb) from public.acc2b_cn_source s limit 1 $f$`);
      const cn = await draft('credit_note', { refundRequestId: rid() });
      expect((await owner<{ c: string }>('select credits_document_id::text as c from public.customer_documents where id = $1', [cn.documentId]))[0]!.c)
        .toBe(inv1.documentId);
      // The Invoice is replaced; the source now names the replacement.
      const rep = await one<Done>(ACC, SQL.replace, [inv1.documentId, inv1.rowVersion, REASON, rid()]);
      const inv2 = await release(rep);
      await owner('update public.acc2b_cn_source set credits = $1', [inv2.documentId]);
      await refusedHint(ACC, SQL.refresh, [cn.documentId, cn.rowVersion, rid()], 'not_ready', /^creditsDocumentId$/, '55000');
      const gst = await one<{ id: string }>(ACC, 'select public.accounts_tally_invoice_add($1, $2::jsonb, $3) as r',
        [DEAL, JSON.stringify({ invoiceRef: 'HC/26-27/0202', invoiceDate: today(), note: null }), rid()]);
      await refusedHint(ACC, SQL.link, [cn.documentId, gst.id, cn.rowVersion, rid()], 'not_ready', /^creditsDocumentId$/, '55000');
    });
  });
});

describe('L7 review 3: list filters (dynamic query, same answers)', () => {
  it('stale, bookingChanged, pdfState and plain pages', async () => {
    await asOwner(db, async () => {
      await base();
      const inv = await release(await draft('invoice'));
      const rec = await h.receipt(DEAL, '100000');
      const adv = await draft('advance_invoice', { receiptId: rec.id });
      expect((await one<Page>(ACC, SQL.list, ['{}', null, 50])).items.map((i) => i.documentId).sort()).toEqual([inv.documentId, adv.documentId].sort());
      expect((await one<Page>(ACC, SQL.list, [JSON.stringify({ stale: true }), null, 50])).items).toEqual([]);
      expect((await one<Page>(ACC, SQL.list, [JSON.stringify({ stale: false }), null, 50])).items).toHaveLength(2);
      expect((await one<Page>(ACC, SQL.list, [JSON.stringify({ bookingChanged: false }), null, 50])).items).toHaveLength(2);
      expect((await one<Page>(ACC, SQL.list, [JSON.stringify({ bookingChanged: true }), null, 50])).items).toEqual([]);
      expect((await one<Page>(ACC, SQL.list, [JSON.stringify({ pdfState: 'queued' }), null, 50])).items.map((i) => i.documentId)).toEqual([inv.documentId]);
      expect((await one<Page>(ACC, SQL.list, [JSON.stringify({ pdfState: 'none', status: ['draft'] }), null, 50])).items.map((i) => i.documentId))
        .toEqual([adv.documentId]);
      // SYNTHETIC FIXTURE STEP: the approved total moves (commercial row edited with its guard off, rolled back).
      await owner('alter table public.booking_version_commercials disable trigger user');
      await owner(`update public.booking_version_commercials set selling_total_paise = selling_total_paise + 100
                   where version_id = (select basis_version_id from public.customer_documents where id = $1)`, [inv.documentId]);
      const changed = await one<Page>(ACC, SQL.list, [JSON.stringify({ bookingChanged: true }), null, 50]);
      expect(changed.items.map((i) => i.documentId)).toEqual([inv.documentId]);
      expect(changed.items[0]!.bookingChangedSinceRelease).toBe(true);
    });
  });
});
