import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, resetActor } from '../helpers/db';
import { PAST_HOTEL_ITEM, PAST_TRIP, dayFrom } from './acc-support';
import { ACC, DEAL, MANAGER, OWNER, PURCHASE, SQL3, SUPER as SUPER_ACTOR, U, acc3Helpers, rid, today } from './acc3-support';
import { buildTallyXml, type TallyXmlVoucher } from '@/modules/accounts-desk/tally-xml';
import { parseDayBook } from '@/modules/accounts-desk/tally-daybook';

/**
 * Accounts phase 3, Track C own tests (contract 7.2-7.4): frozen lines give the same XML bytes; a Day Book made
 * from the file parses back and matches through stage / apply; the download is audited; reads are Accounts only;
 * tally_export_lines keep the Tally record kind (journal_entry) of tally_records.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = acc3Helpers(() => db);
const { one, owner } = h;
type Line = { line_no: number; record_kind: string; values: { voucher: TallyXmlVoucher; amountPaise: string; reference: string } };

async function setup(): Promise<string> {
  await h.people();
  const b = await h.book([PAST_HOTEL_ITEM], { trip: { start: PAST_TRIP.start, end: PAST_TRIP.end } });
  await h.approveReal(b.versionId);
  await h.receipt(DEAL, '2500000');
  await h.receipt(DEAL, '1000000');
  await h.tallyXmlOn(true, 'SYN Copy & Co');
  const entity = await h.entityId();
  await resetActor(db);
  await owner(`update public.tally_ledger_mappings set debit_ledger = coalesce(debit_ledger, 'SYN Debit ' || row_kind),
      credit_ledger = coalesce(credit_ledger, 'SYN Credit ' || row_kind), row_version = row_version + 1 where legal_entity_id = $1`, [entity]);
  const [p] = await owner<{ id: string }>(`insert into public.customer_parties (legal_entity_id, party_type, name, created_by, updated_by)
    values ($1, 'personal', 'SYN Party', $2, $2) returning id`, [entity, U.accountsJodhpur]);
  await owner('update public.customer_billing_profiles set party_id = $2, party_copied_at = now() where deal_id = $1', [DEAL, p!.id]);
  await one(ACC, SQL3.partyTallyName, [p!.id, 1, 'SYN Party Ledger', rid()]);
  return entity;
}

describe('Tally file round trip', () => {
  it('frozen lines -> same XML bytes; Day Book back -> matched; download audited; Accounts only', async () => {
    await asOwner(db, async () => {
      const entity = await setup();
      const made = await one<{ exportId: string; exportNo: string; lines: number }>(ACC, SQL3.fileCreate,
        [entity, dayFrom(-300), today(), ['journal_entry'], null, false, null, rid()]);
      expect(made.lines).toBe(2);
      const lines = await owner<Line>('select line_no, record_kind, values from public.tally_export_lines where export_id = $1 order by line_no',
        [made.exportId]);
      expect(lines.map((l) => l.record_kind)).toEqual(['journal_entry', 'journal_entry']);
      for (const l of lines) {
        expect(l.values.voucher).toMatchObject({ voucherType: 'Receipt', partyLedger: 'SYN Party Ledger' });
        expect(l.values.voucher.narration.endsWith(`TN:${made.exportNo}/${l.line_no}`)).toBe(true);
      }
      // Download: one audit row, frozen company name; the XML from the frozen lines is byte-identical each time.
      const head = await one<{ companyName: string; fileName: string }>(ACC, 'select public.accounts_tally_file_download_log($1) as r', [made.exportId]);
      expect(head).toMatchObject({ companyName: 'SYN Copy & Co', fileName: `${made.exportNo}.xml` });
      expect((await h.audits('accounts.tally_file.downloaded')).length).toBe(1);
      await h.refused(MANAGER, 'select public.accounts_tally_file_download_log($1) as r', [made.exportId], 'not_authorized', '42501');
      const xml = buildTallyXml({ companyName: head.companyName, vouchers: lines.map((l) => l.values.voucher) });
      expect(buildTallyXml({ companyName: head.companyName, vouchers: lines.map((l) => structuredClone(l.values.voucher)) })).toBe(xml);
      expect(xml).toContain('SYN Copy &amp; Co');
      // Tally numbers the vouchers on import; its Day Book comes back.
      let n = 100;
      const dayBook = xml.replace(/<VOUCHERTYPENAME>/g, () => `<VOUCHERNUMBER>${(n += 1)}</VOUCHERNUMBER><VOUCHERTYPENAME>`);
      const book = parseDayBook(dayBook);
      const rows = book.vouchers.map((v) => ({ tnTag: v.tnTag, voucherRef: v.voucherNumber, voucherDate: v.date, voucherType: v.voucherType,
        amountPaise: v.amountPaise }));
      for (const actor of [OWNER, PURCHASE]) {
        await h.refused(actor, SQL3.matchStage, [entity, 'daybook.xml', 'e'.repeat(64), JSON.stringify(rows), rid()], 'not_authorized', '42501');
      }
      const staged = await one<{ batchId: string; proposalHash: string; summary: Record<string, number> }>(ACC, SQL3.matchStage,
        [entity, 'daybook.xml', 'e'.repeat(64), JSON.stringify(rows), rid()]);
      expect(staged.summary).toMatchObject({ matched: 2, amount_differs: 0, not_found: 0, no_tag: 0 });
      const page = await one<{ rows: Array<{ crmReference: string | null; outcome: string }> }>(ACC, SQL3.matchGet, [staged.batchId, 'matched', null, 50]);
      expect(page.rows.map((r) => r.crmReference)).toEqual(lines.map((l) => l.values.reference));
      expect(await one(MANAGER, SQL3.matchGet, [staged.batchId, null, null, 50])).toBeNull();
      const applied = await one<{ matched: number; exceptions: number }>(ACC, SQL3.matchApply, [staged.batchId, staged.proposalHash, rid()]);
      expect(applied).toMatchObject({ matched: 2, exceptions: 0 });
      const recs = await owner<{ status: string; voucher_ref: string }>(
        'select status, voucher_ref from public.tally_records where xml_export_id = $1 order by xml_line_no', [made.exportId]);
      expect(recs).toEqual([{ status: 'matched', voucher_ref: '101' }, { status: 'matched', voucher_ref: '102' }]);
      await h.refused(ACC, SQL3.matchCancel, [staged.batchId, rid()], 'wrong_state', '55000');
      // A matched record never goes into a file again, even when included again.
      await h.refused(ACC, SQL3.fileCreate, [entity, dayFrom(-300), today(), ['journal_entry'], null, true, 'Synthetic include again reason', rid()],
        'nothing_to_export', '55000');
    });
  });

  it('Day Book shape refused at the database: bad tags and keys are invalid_input', async () => {
    await asOwner(db, async () => {
      const entity = await setup();
      const bad = [{ tnTag: 'TN:TE-1/1', voucherRef: '1', voucherDate: today(), voucherType: 'Receipt', amountPaise: '1' }];
      await h.refusedHint(ACC, SQL3.matchStage, [entity, 'x.xml', 'f'.repeat(64), JSON.stringify(bad), rid()], 'invalid_input', /rows/);
      const extra = [{ voucherRef: '1', voucherDate: today(), amountPaise: '1', narration: 'names never reach the database' }];
      await h.refusedHint(ACC, SQL3.matchStage, [entity, 'x.xml', 'f'.repeat(64), JSON.stringify(extra), rid()], 'invalid_input', /rows/);
    });
  });
});

describe('company name in the reads (additive)', () => {
  it('preview, file list entity and XML item carry the Tally company name', async () => {
    await asOwner(db, async () => {
      const entity = await setup();
      const preview = await one<{ companyName: string | null }>(ACC, SQL3.filePreview, [entity, dayFrom(-300), today(), null, null]);
      expect(preview.companyName).toBe('SYN Copy & Co');
      await one(ACC, SQL3.fileCreate, [entity, dayFrom(-300), today(), ['journal_entry'], null, false, null, rid()]);
      const list = await one<{ entities: Array<{ companyName: string | null }>; items: Array<{ format: string; companyName: string | null }> }>(
        ACC, SQL3.exports, [50]);
      expect(list.entities[0]!.companyName).toBe('SYN Copy & Co');
      expect(list.items.find((i) => i.format === 'xml')!.companyName).toBe('SYN Copy & Co');
      const settings = await one<Record<string, unknown>>(SUPER_ACTOR, SQL3.accountsSettings, [entity]);
      expect(settings).toMatchObject({ tallyXmlEnabled: true, tallyCompanyName: 'SYN Copy & Co', writeOffLimitPaise: '500000' });
    });
  });
});
