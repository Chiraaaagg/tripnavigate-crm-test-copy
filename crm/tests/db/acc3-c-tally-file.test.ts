import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, resetActor } from '../helpers/db';
import { CONTACT, PAST_HOTEL_ITEM, PAST_TRIP, SELLING, SENTINEL, dayFrom } from './acc-support';
import { ACC, DEAL, LEFT_OUT_REASONS, MANAGER, MATCH_OUTCOMES, OWNER, PURCHASE, REASON, SQL3, SUPER, U, acc3Helpers, rid, text, today } from './acc3-support';
import { CONFLICT_STATE } from '../helpers/sqlstates';

/**
 * Accounts phase 3, Track T — Track C Tally import file and matching upload
 * (contract 7.1-7.4, 13, 14, 16.1 C). Written from the contract, not from
 * Track C's code. The XML bytes themselves are unit-tested in
 * tests/unit/acc3-tally-xml.test.ts; here: selection, left-out reasons,
 * frozen lines, narration, matching and fences.
 */

/** Period start inside the 366-day Tally file cap (Addendum L5): 300 days before today (India time). */
const FROM = dayFrom(-300);
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = acc3Helpers(() => db);
const { one, owner, refused, refusedHint } = h;
/**
 * Tally record kinds that may become file lines (7.1): customer-money journal entries (receipts, deposits, customer refunds),
 * verified supplier payments, verified supplier refunds and approved write-offs. The voucher type lives in the line values.
 */
const FILE_KINDS = ['journal_entry', 'supplier_payment', 'supplier_refund', 'write_off'];
const PARTY_LEDGER = 'Synthetic Party Ledger';
type Line = { line_no: number; record_kind: string; record_id: string; values: Record<string, unknown> & { narration?: string; reference?: string;
  entries?: Array<Record<string, unknown>> } };

/** Owner SQL: every blank mapping cell filled (the screen would do it through tally_mapping_set). */
async function fillMappings(except: string[] = []): Promise<void> {
  await resetActor(db);
  await owner(`update public.tally_ledger_mappings set debit_ledger = coalesce(debit_ledger, 'Synthetic Debit ' || row_kind),
      credit_ledger = coalesce(credit_ledger, 'Synthetic Credit ' || row_kind), voucher_type = coalesce(voucher_type, 'Receipt'),
      row_version = row_version + 1
    where legal_entity_id = $1 and row_kind <> all ($2::text[])`, [await h.entityId(), except]);
}
/** SYNTHETIC FIXTURE STEP: a bill-to party linked to the Deal's billing profile, then C1 names it in Tally. */
async function mapParty(name = PARTY_LEDGER): Promise<string> {
  await resetActor(db);
  const [p] = await owner<{ id: string }>(`insert into public.customer_parties (legal_entity_id, party_type, name, created_by, updated_by)
    values ($1, 'personal', 'Synthetic Party', $2, $2) returning id`, [await h.entityId(), U.accountsJodhpur]);
  await owner('update public.customer_billing_profiles set party_id = $2, party_copied_at = now() where deal_id = $1', [DEAL, p!.id]);
  const [rv] = await owner<{ row_version: number }>('select row_version from public.customer_parties where id = $1', [p!.id]);
  await one(ACC, SQL3.partyTallyName, [p!.id, rv!.row_version, name, rid()]);
  return p!.id;
}
/** Approved past-trip booking with one verified bank receipt; Tally file On. */
async function base(amount = '2500000') {
  await h.people();
  const b = await h.book([PAST_HOTEL_ITEM], { trip: { start: PAST_TRIP.start, end: PAST_TRIP.end } });
  await h.approveReal(b.versionId);
  const receipt = await h.receipt(DEAL, amount);
  await h.tallyXmlOn(true);
  return { b, receipt };
}
const create = (opts: { kinds?: string[] | null; again?: boolean; reason?: string | null; from?: string; to?: string } = {}) =>
  one<Record<string, unknown>>(ACC, SQL3.fileCreate, [await_entity, opts.from ?? FROM, opts.to ?? today(), opts.kinds ?? null, null,
    opts.again ?? false, opts.reason ?? null, rid()]);
let await_entity = '';
const latestXml = async () => (await owner<{ id: string; export_no: string; format: string; include_reason: string | null }>(
  `select id, export_no, format, include_reason from public.tally_exports where format = 'xml' order by created_at desc, export_no desc limit 1`))[0]!;
const lines = (exportId: string) => owner<Line>(
  'select line_no, record_kind, record_id, values from public.tally_export_lines where export_id = $1 order by line_no', [exportId]);
const leftOut = (exportId: string) => owner<{ record_kind: string; record_id: string; reason: string; detail: string | null }>(
  'select record_kind, record_id, reason, detail from public.tally_export_left_out where export_id = $1', [exportId]);

describe('7.2 C2 switch and C1 party name', () => {
  it('tally_xml_off while Off; policy manager turns it on with a company name; C1 Accounts only, audited', async () => {
    await asOwner(db, async () => {
      await h.people();
      await_entity = await h.entityId();
      await refused(ACC, SQL3.fileCreate, [await_entity, FROM, today(), null, null, false, null, rid()], 'tally_xml_off', '55000');
      await refused(ACC, SQL3.setTallyXml, [await_entity, true, 'Copy Co', REASON], 'not_authorized', '42501');
      await refusedHint(SUPER, SQL3.setTallyXml, [await_entity, true, null, REASON], 'invalid_input', /company/i);
      await refusedHint(SUPER, SQL3.setTallyXml, [await_entity, true, 'Bad\u0001Name', REASON], 'invalid_input', /company/i);
      await h.tallyXmlOn(true, 'Holiday Chacha Copy Co');
      const s = await one<Record<string, unknown>>(SUPER, SQL3.accountsSettings, [await_entity]);
      expect(s).toMatchObject({ tallyXmlEnabled: true, tallyCompanyName: 'Holiday Chacha Copy Co' });
      await h.book([PAST_HOTEL_ITEM], { trip: { start: PAST_TRIP.start, end: PAST_TRIP.end } });
      const party = await mapParty();
      const [a] = await h.audits('accounts.tally_party_named');
      expect(a!.target_id).toBe(party);
      expect(text(a!.details)).not.toContain(PARTY_LEDGER);
      await refused(OWNER, SQL3.partyTallyName, [party, 99, 'x', rid()], 'not_authorized', '42501');
    });
  });
});

describe('7.1 / 7.3 making the file', () => {
  it('preview then file: a mapped receipt becomes a frozen Receipt line with the TN tag; unmapped party is left out', async () => {
    await asOwner(db, async () => {
      const { receipt } = await base();
      await_entity = await h.entityId();
      await fillMappings();
      // Party not mapped yet -> left out.
      const preview = await one<Record<string, unknown>>(ACC, SQL3.filePreview, [await_entity, FROM, today(), null, null]);
      expect(text(preview)).toContain('party_not_mapped');
      await refused(ACC, SQL3.fileCreate, [await_entity, FROM, today(), null, null, false, null, rid()], 'nothing_to_export', '55000');
      await mapParty();
      const before = await h.lastAuditId();
      await create();
      const file = await latestXml();
      expect(file.export_no).toMatch(/^TE-/);
      const ls = await lines(file.id);
      expect(ls).toHaveLength(1);
      const l = ls[0]!;
      expect(l.record_kind).toBe('journal_entry');
      // ASSUMPTION: the frozen voucher names its type under `voucherType` (7.3 lists "voucher type" in the values).
      expect(String(l.values.voucherType ?? l.values.voucher_type)).toBe('Receipt');
      const v = l.values;
      const narration = String(v.narration);
      expect(narration).toMatch(new RegExp(`^Deal [^|]+ \\| SYN-DEL-001 \\| .+ \\| TN:${file.export_no}/${l.line_no}$`));
      expect(String(v.reference)).toMatch(/^R-/);
      // Never a name, PAN or mobile beyond the party ledger.
      for (const s of [CONTACT.mobile, CONTACT.contactName, SENTINEL.pan, 'Synthetic Party\"']) expect(text(v)).not.toContain(s);
      expect(text(v)).toContain(PARTY_LEDGER);
      // Debit and credit balance; whole paise.
      const entries = v.entries ?? [];
      const sum = (k: string) => entries.reduce((s, e) => s + BigInt(String(e[k] ?? '0')), 0n);
      expect(sum('debitPaise')).toBe(sum('creditPaise'));
      expect(sum('debitPaise')).toBe(2500000n);
      // Record marked exported (never matched), tracked apart from CSV.
      const [tr] = await owner<{ status: string; xml_export_id: string | null; xml_line_no: number | null }>(
        'select status, xml_export_id, xml_line_no from public.tally_records where record_id = $1 or record_id = (select id from public.finance_journal_entries where receipt_id = $1 limit 1)',
        [receipt.id]);
      expect(tr).toMatchObject({ status: 'exported', xml_export_id: file.id, xml_line_no: l.line_no });
      const audit = (await h.auditsSince(before)).find((a) => a.action === 'accounts.tally_file.created')!;
      expect(audit.details).toMatchObject({ exportId: file.id, lines: 1 });
      // R-C1 lists the file with its format; R-C3 lists the left-out rows.
      const list = await one<unknown>(ACC, SQL3.exports, [50]);
      expect(text(list)).toContain('"format":"xml"');
      expect(await one(ACC, SQL3.leftOut, [file.id, null, 50])).not.toBeNull();
    });
  });

  it('left-out reasons: ledger_not_mapped, kind_not_in_file (reversal), already_in_file; include again needs a reason', async () => {
    await asOwner(db, async () => {
      await base();
      await_entity = await h.entityId();
      await fillMappings(['receipt_bank']);
      await mapParty();
      // receipt_bank mapping has blank cells only if the defaults left them blank: force one blank to be sure.
      await owner(`update public.tally_ledger_mappings set debit_ledger = null, row_version = row_version + 1
        where legal_entity_id = $1 and row_kind = 'receipt_bank'`, [await_entity]);
      const reversed = await h.receipt(DEAL, '300000');
      await h.fin.reverse(ACC, reversed.id, 'data_error');
      await refused(ACC, SQL3.fileCreate, [await_entity, FROM, today(), null, null, false, null, rid()], 'nothing_to_export', '55000');
      const preview = text(await one(ACC, SQL3.filePreview, [await_entity, FROM, today(), null, null]));
      expect(preview).toContain('ledger_not_mapped');
      expect(preview).toContain('kind_not_in_file');
      await fillMappings();
      await create();
      const first = await latestXml();
      expect((await lines(first.id)).length).toBeGreaterThanOrEqual(1);
      for (const l of await lines(first.id)) expect(FILE_KINDS).toContain(l.record_kind);
      const out1 = await leftOut(first.id);
      for (const o of out1) expect(LEFT_OUT_REASONS as readonly string[]).toContain(o.reason);
      expect(out1.some((o) => o.reason === 'kind_not_in_file')).toBe(true);
      // Second file: exported entries are left out as already_in_file -> nothing to export.
      await refused(ACC, SQL3.fileCreate, [await_entity, FROM, today(), null, null, false, null, rid()], 'nothing_to_export', '55000');
      await refusedHint(ACC, SQL3.fileCreate, [await_entity, FROM, today(), null, null, true, null, rid()], 'invalid_input', /reason/i);
      await one(ACC, SQL3.fileCreate, [await_entity, FROM, today(), null, null, true, REASON, rid()]);
      const second = await latestXml();
      expect(second.id).not.toBe(first.id);
      expect(second.include_reason).toBe(REASON);
      // Frozen lines: the first file's values never change.
      const again = await lines(first.id);
      expect(text(again)).toBe(text(await lines(first.id)));
    });
  });

  it('a write-off is a Journal; its mapping rows start with blank ledgers, so it is left out until Accounts fills them (no ledger is invented)', async () => {
    await asOwner(db, async () => {
      await h.people();
      const b = await h.book([PAST_HOTEL_ITEM], { trip: { start: PAST_TRIP.start, end: PAST_TRIP.end } });
      await h.approveReal(b.versionId);
      await h.receipt(DEAL, String(Number(SELLING) - 30000));
      await h.tallyXmlOn(true);
      await h.writeOffOn(true);
      await_entity = await h.entityId();
      const rows = await owner<{ row_kind: string; voucher_type: string | null; debit_ledger: string | null; credit_ledger: string | null }>(
        `select row_kind, voucher_type, debit_ledger, credit_ledger from public.tally_ledger_mappings where legal_entity_id = $1 and row_kind like 'write_off%'`,
        [await_entity]);
      expect(rows.map((r) => r.row_kind).sort()).toEqual(['write_off_due', 'write_off_excess']);
      for (const r of rows) expect(r).toMatchObject({ voucher_type: 'Journal', debit_ledger: null, credit_ledger: null });
      const p = await one<{ writeOffId: string }>(ACC, SQL3.woPropose, [DEAL, JSON.stringify({ direction: 'due', amountPaise: '30000', reason: REASON }), rid()]);
      const [w] = await owner<{ row_version: number }>('select row_version from public.deal_write_offs where id = $1', [p.writeOffId]);
      await one(MANAGER, SQL3.woDecide, [p.writeOffId, 'approve', '30000', null, w!.row_version, rid()]);
      await mapParty();
      const preview = text(await one(ACC, SQL3.filePreview, [await_entity, FROM, today(), ['write_off'], null]));
      expect(preview).toContain('ledger_not_mapped');
      await fillMappings();
      await one(ACC, SQL3.fileCreate, [await_entity, FROM, today(), ['write_off'], null, false, null, rid()]);
      const file = await latestXml();
      const [l] = await lines(file.id);
      expect(l).toMatchObject({ record_kind: 'write_off', record_id: p.writeOffId });
      expect(String(l!.values.reference)).toMatch(/^WO-/);
      // Undo after the file: the exported state is kept and the record shows as changed since the file.
      const [w2] = await owner<{ row_version: number }>('select row_version from public.deal_write_offs where id = $1', [p.writeOffId]);
      await one(MANAGER, SQL3.woUndo, [p.writeOffId, w2!.row_version, REASON, rid()]);
      const [tr] = await owner<{ status: string }>(`select status from public.tally_records where record_kind = 'write_off' and record_id = $1`, [p.writeOffId]);
      expect(tr!.status).toBe('exported');
    });
  });
});

describe('7.4 matching upload', () => {
  it('stage: matched, amount_differs, not_found, duplicate_in_file, no_tag; apply sets voucher refs and raises the exception; already_matched after', async () => {
    await asOwner(db, async () => {
      await base('2500000');
      await_entity = await h.entityId();
      await h.receipt(DEAL, '1000000');
      await fillMappings();
      await mapParty();
      await create();
      const file = await latestXml();
      const ls = await lines(file.id);
      expect(ls).toHaveLength(2);
      const tag = (l: Line) => `TN:${file.export_no}/${l.line_no}`;
      const amt = (l: Line) => String((l.values.entries ?? []).reduce((s, e) => s + BigInt(String(e.debitPaise ?? '0')), 0n));
      // ASSUMPTION: staged row keys are the parser's camelCase fields {tnTag, voucherRef, voucherDate, voucherType, amountPaise}.
      const rows = [
        { tnTag: tag(ls[0]!), voucherRef: 'RCPT-1', voucherDate: today(), voucherType: 'Receipt', amountPaise: amt(ls[0]!) },
        { tnTag: tag(ls[1]!), voucherRef: 'RCPT-2', voucherDate: today(), voucherType: 'Receipt', amountPaise: String(BigInt(amt(ls[1]!)) + 100n) },
        { tnTag: `TN:${file.export_no}/99`, voucherRef: 'RCPT-3', voucherDate: today(), voucherType: 'Receipt', amountPaise: '100' },
        { tnTag: tag(ls[0]!), voucherRef: 'RCPT-4', voucherDate: today(), voucherType: 'Receipt', amountPaise: amt(ls[0]!) },
        { tnTag: null, voucherRef: 'RCPT-5', voucherDate: today(), voucherType: 'Receipt', amountPaise: '100' },
      ];
      for (const actor of [OWNER, MANAGER, PURCHASE]) {
        await refused(actor, SQL3.matchStage, [await_entity, 'daybook.xml', 'a'.repeat(64), JSON.stringify(rows), rid()], 'not_authorized', '42501');
      }
      const staged = await one<Record<string, unknown> & { batchId?: string; id?: string; proposalHash: string }>(ACC, SQL3.matchStage,
        [await_entity, 'daybook.xml', 'a'.repeat(64), JSON.stringify(rows), rid()]);
      const batchId = (staged.batchId ?? staged.id) as string;
      const outcomes = (await owner<{ row_no: number; outcome: string }>('select row_no, outcome from public.tally_match_rows where batch_id = $1 order by row_no',
        [batchId])).map((r) => r.outcome);
      for (const o of outcomes) expect(MATCH_OUTCOMES as readonly string[]).toContain(o);
      expect(outcomes).toEqual(expect.arrayContaining(['matched', 'amount_differs', 'not_found', 'duplicate_in_file', 'no_tag']));
      // Same file twice (same sha) while staged is refused.
      const dup = await h.attempt(ACC, SQL3.matchStage, [await_entity, 'daybook.xml', 'a'.repeat(64), JSON.stringify(rows), rid()]);
      expect(dup.ok).toBe(false);
      await refused(ACC, SQL3.matchApply, [batchId, 'f'.repeat(64), rid()], 'version_changed', CONFLICT_STATE);
      await one(ACC, SQL3.matchApply, [batchId, staged.proposalHash, rid()]);
      const recs = await owner<{ status: string; voucher_ref: string | null; xml_line_no: number }>(
        'select status, voucher_ref, xml_line_no from public.tally_records where xml_export_id = $1 order by xml_line_no', [file.id]);
      expect(recs.find((r) => r.xml_line_no === ls[0]!.line_no)).toMatchObject({ status: 'matched', voucher_ref: 'RCPT-1' });
      expect(recs.find((r) => r.xml_line_no === ls[1]!.line_no)!.status).toBe('exception');
      expect((await h.audits('accounts.tally_match.applied')).length).toBe(1);
      // Uploading again: already_matched.
      const again = await one<{ batchId?: string; id?: string }>(ACC, SQL3.matchStage,
        [await_entity, 'daybook2.xml', 'b'.repeat(64), JSON.stringify([rows[0]]), rid()]);
      const [o] = await owner<{ outcome: string }>('select outcome from public.tally_match_rows where batch_id = $1', [again.batchId ?? again.id]);
      expect(o!.outcome).toBe('already_matched');
      await one(ACC, SQL3.matchCancel, [again.batchId ?? again.id, rid()]);
      // Reads are Accounts only.
      expect(await one(ACC, SQL3.matchGet, [batchId, null, null, 50])).not.toBeNull();
      for (const actor of [OWNER, MANAGER, PURCHASE]) {
        expect(await one(actor, SQL3.matchGet, [batchId, null, null, 50])).toBeNull();
        expect(await one(actor, SQL3.leftOut, [file.id, null, 50])).toBeNull();
        expect(await one(actor, SQL3.filePreview, [await_entity, FROM, today(), null, null])).toBeNull();
      }
    });
  });

  it('apply is refused after a change since staging (version_changed)', async () => {
    await asOwner(db, async () => {
      await base('2500000');
      await_entity = await h.entityId();
      await fillMappings();
      await mapParty();
      await create();
      const file = await latestXml();
      const [l] = await lines(file.id);
      const amount = String((l!.values.entries ?? []).reduce((s, e) => s + BigInt(String(e.debitPaise ?? '0')), 0n));
      const row = { tnTag: `TN:${file.export_no}/${l!.line_no}`, voucherRef: 'R-9', voucherDate: today(), voucherType: 'Receipt', amountPaise: amount };
      const s1 = await one<{ batchId?: string; id?: string; proposalHash: string }>(ACC, SQL3.matchStage,
        [await_entity, 'a.xml', 'c'.repeat(64), JSON.stringify([row]), rid()]);
      const s2 = await one<{ batchId?: string; id?: string; proposalHash: string }>(ACC, SQL3.matchStage,
        [await_entity, 'b.xml', 'd'.repeat(64), JSON.stringify([{ ...row, voucherRef: 'R-10' }]), rid()]);
      await one(ACC, SQL3.matchApply, [s2.batchId ?? s2.id, s2.proposalHash, rid()]);
      await refused(ACC, SQL3.matchApply, [s1.batchId ?? s1.id, s1.proposalHash, rid()], 'version_changed', CONFLICT_STATE);
    });
  });
});
