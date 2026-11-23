import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  ROUTES, USERS, type UserKey, allowedOutbound, approveBooking, asUser, bookingWithTrip, configured, dayFromToday, entityId, freshDeal, noServiceWorker,
  prepareUsers, q, restoreSwitches3, saveSwitches3, session, stamp, switchesOn3, verifiedCash,
} from './acc3-real-support';

/**
 * Accounts Phase 3 test plan 16.4, journeys 3 (write-off, 6.6) and 4 (Tally
 * import file and matching upload, 7.1-7.4), Track T, written from the
 * contract. Production build on the disposable stack. The CRM never contacts
 * Tally: the Day Book file is built here from the frozen lines (synthetic).
 */

test.describe.configure({ mode: 'serial' });
test.skip(!configured, 'needs the real local stack (TEST_DATABASE_URL, Supabase URL and keys)');
test.setTimeout(15 * 60_000);
test.use({ actionTimeout: 30_000 });

let secrets: Record<UserKey, string>;
test.beforeAll(async () => {
  await saveSwitches3();
  secrets = await prepareUsers();
  await switchesOn3({ writeOff: true, tallyXml: true });
});
test.afterAll(async () => {
  await restoreSwitches3();
});

const SELLING_WO = '4567800';
type Dues = { balancePaise: string; creditPaise: string; writeOff: null | { refNo: string; status: string; amountPaise: string; direction: string } };
const dues = (dealId: string) => asUser<Dues>(USERS.accA.id, 'select public.deal_dues($1) as r', [dealId]);

/**
 * SYNTHETIC FIXTURE STEP: the Deal's billing profile gets a customer party (owner SQL), then Accounts names its Tally
 * ledger through C1. ASSUMPTION: party_id / party_copied_at may be set on an existing billing profile by the owner.
 */
async function partyWithTallyName(dealId: string, name: string): Promise<string> {
  const e = await entityId();
  const party = (await q<{ id: string }>(`insert into public.customer_parties (legal_entity_id, party_type, name, created_by, updated_by)
    values ($1, 'personal', $2, $3, $3) returning id`, [e, `Synthetic Party ${stamp}-${name}`, USERS.sales.id]))[0]!.id;
  await q('update public.customer_billing_profiles set party_id = $2, party_copied_at = now() where deal_id = $1', [dealId, party]);
  const rv = (await q<{ v: number }>('select row_version as v from public.customer_parties where id = $1', [party]))[0]!.v;
  await asUser(USERS.accA.id, 'select public.customer_party_tally_name_set($1, $2, $3, $4) as r', [party, rv, name, randomUUID()]);
  return party;
}

/** Fills every mapping row whose ledgers or voucher type are blank with synthetic names (Accounts, audited). */
async function fillMapping(): Promise<void> {
  const list = await asUser<{ rows: Array<{ mappingId: string; rowVersion: number; rowKind: string; debitLedger: string | null; creditLedger: string | null;
    voucherType: string | null }> }>(USERS.accA.id, 'select public.tally_mapping_list($1) as r', [await entityId()]);
  for (const m of list.rows) {
    if (m.debitLedger && m.creditLedger && m.voucherType) continue;
    await asUser(USERS.accA.id, 'select public.tally_mapping_set($1, $2, $3::jsonb, $4, $5) as r', [m.mappingId, m.rowVersion, JSON.stringify({
      debitLedger: m.debitLedger ?? 'Synthetic Bank A/c', creditLedger: m.creditLedger ?? 'Synthetic Customer Advances',
      voucherType: m.voucherType ?? (m.rowKind.startsWith('write_off') ? 'Journal' : 'Receipt') }), 'Synthetic: ledger names for the copy company test', randomUUID()]);
  }
}

let writeOffDeal = '';
let writeOffRef = '';

test('3. write-off: small balance after the trip → proposed → approved by the Manager → dues zero → Journal in the Tally file → undone', async ({ browser }) => {
  writeOffRef = `ACC3WO-${stamp}`;
  writeOffDeal = await freshDeal(writeOffRef);
  const v = await bookingWithTrip(writeOffDeal, -10, -5, 31, { selling: SELLING_WO });
  await approveBooking(writeOffDeal, v.versionId);
  // Customer paid all but ₹300 (30000 paise ≤ the ₹5,000 limit).
  await verifiedCash(writeOffDeal, String(BigInt(SELLING_WO) - 30000n), 31);
  expect((await dues(writeOffDeal)).balancePaise).toBe('30000');

  // Accounts › Small balances lists the Deal; Accounts proposes (whole balance, B3).
  const acc = await session(browser, 'accA', secrets);
  await acc.page.goto(ROUTES.smallBalances);
  await expect(acc.page.getByText(writeOffRef).first()).toBeVisible();
  const proposed = await asUser<{ writeOffId?: string; id?: string }>(USERS.accA.id, 'select public.write_off_propose($1, $2::jsonb, $3) as r', [writeOffDeal,
    JSON.stringify({ direction: 'due', amountPaise: '30000', reason: 'Synthetic: ₹300 left after the trip, not worth chasing' }), randomUUID()]);
  const woId = proposed.writeOffId ?? proposed.id!;
  // Notice 41 to the approvers (branch Manager, not the proposer).
  await expect.poll(async () => (await q<{ r: string }>(`select recipient_user_id as r from public.staff_notices where kind = 'write_off_to_approve'
    and subject_id = $1`, [woId])).map((x) => x.r)).toContain(USERS.manager.id);

  // Manager approves in Approvals › Write-offs (binding the amount the screen showed).
  const mgr = await session(browser, 'manager', secrets);
  await mgr.page.goto(ROUTES.approvals);
  await expect(mgr.page.getByText(/Write-offs/).first()).toBeVisible();
  const row = (await q<{ row_version: number; ref_no: string }>('select row_version, ref_no from public.deal_write_offs where id = $1', [woId]))[0]!;
  expect(row.ref_no).toMatch(/^WO-[0-9]{4}-[0-9]{6}$/);
  await expect(mgr.page.getByText(row.ref_no).first()).toBeVisible();
  await asUser(USERS.manager.id, 'select public.write_off_decide($1, $2, $3::bigint, $4, $5, $6) as r', [woId, 'approve', '30000', null, row.row_version, randomUUID()]);

  // Dues zero; the dues line says who wrote it off; no journal entry, money held unchanged.
  const after = await dues(writeOffDeal);
  expect(after.balancePaise).toBe('0');
  expect(after.writeOff).toMatchObject({ refNo: row.ref_no, status: 'approved', amountPaise: '30000', direction: 'due' });
  expect((await q<{ n: number }>(`select count(*)::int as n from public.finance_journal_entries where deal_id = $1 and kind not like 'receipt_%'`,
    [writeOffDeal]))[0]!.n).toBe(0);
  const so = await session(browser, 'sales', secrets);
  // UX redesign R2: the dues card (with the write-off line) is on the Deal's Money tab.
  await so.page.goto(ROUTES.deal(writeOffDeal, 'money'));
  await expect(so.page.getByText(/Written off ₹300(\.00)? by /).first()).toBeVisible();

  // Tally file carries the Journal (write_off_due mapping row; customer ledger from the party).
  await fillMapping();
  await partyWithTallyName(writeOffDeal, `Synthetic WO Customer ${stamp}`);
  const file = await asUser<{ exportId: string; exportNo?: string; lines: number }>(USERS.accA.id,
    'select public.accounts_tally_file_create($1, $2::date, $3::date, $4::text[], $5::uuid[], $6, $7, $8) as r',
    [await entityId(), dayFromToday(-1), dayFromToday(0), ['write_off'], null, false, null, randomUUID()]);
  const lines = await q<{ values: Record<string, unknown> }>('select "values" from public.tally_export_lines where export_id = $1', [file.exportId]);
  const journal = lines.find((l) => String(l.values.reference ?? '').startsWith('WO-'));
  expect(journal, 'the write-off Journal line').toBeDefined();
  expect(journal!.values).toMatchObject({ voucherType: 'Journal', reference: row.ref_no });
  expect(String(journal!.values.narration)).toMatch(/\| TN:TE-[0-9]{4}-[0-9]{6}\/[0-9]+$/);

  // Undone by the branch Manager with a reason: the balance is back; the exported Journal stays exported (changed since file).
  const rv = (await q<{ v: number }>('select row_version as v from public.deal_write_offs where id = $1', [woId]))[0]!.v;
  await asUser(USERS.manager.id, 'select public.write_off_undo($1, $2, $3, $4) as r', [woId, rv, 'Synthetic: customer offered to pay the ₹300 after all',
    randomUUID()]);
  expect((await dues(writeOffDeal)).balancePaise).toBe('30000');
  expect((await q<{ s: string }>(`select status as s from public.tally_records where record_kind = 'write_off' and record_id = $1`, [woId]))[0]!.s).toBe('exported');
  // Notice 42 (undone) to the proposer; no amount in any notice.
  const n42 = await q<{ params: Record<string, unknown> }>(`select params from public.staff_notices where kind = 'write_off_decided' and subject_id = $1`, [woId]);
  expect(n42.length).toBeGreaterThan(0);
  expect(JSON.stringify(n42)).not.toMatch(/30000|300\.00/);
  await noServiceWorker(acc.page);
  await Promise.all([acc.ctx.close(), mgr.ctx.close(), so.ctx.close()]);
});

test('4. Tally: mapping → preview → file → left-out list → second file leaves entries out → Day Book uploaded → matched and one amount exception', async ({ browser }) => {
  await fillMapping();
  // Two Deals with verified bank receipts today: one with a Tally party name, one without (left out: party_not_mapped).
  const mapped = await freshDeal(`ACC3TL-${stamp}-1`);
  const v1 = await bookingWithTrip(mapped, 15, 18, 41);
  await approveBooking(mapped, v1.versionId);
  await partyWithTallyName(mapped, `Synthetic Tally Customer ${stamp}`);
  await verifiedCash(mapped, '250000', 41);
  await verifiedCash(mapped, '150000', 42);
  const unmapped = await freshDeal(`ACC3TL-${stamp}-2`);
  const v2 = await bookingWithTrip(unmapped, 15, 18, 43);
  await approveBooking(unmapped, v2.versionId);
  await verifiedCash(unmapped, '120000', 43);

  // Accounts › Tally: "Make Tally file" with the preview of what goes in and what is left out and why.
  const acc = await session(browser, 'accA', secrets);
  const downloads: string[] = [];
  acc.page.on('download', (d) => downloads.push(d.suggestedFilename()));
  const t0 = (await q<{ t: string }>('select now()::text as t'))[0]!.t;
  const today = dayFromToday(0);
  await acc.page.goto(ROUTES.tally);
  const make = acc.page.getByRole('form', { name: 'Make Tally file' });
  await make.getByLabel('From (accounting date)').fill(today);
  await make.getByLabel('To', { exact: true }).fill(today);
  for (const kind of ['Supplier payments', 'Supplier refunds', 'Write-offs']) await make.getByLabel(kind, { exact: true }).uncheck();
  await make.getByRole('button', { name: 'Show what goes in' }).click();
  const look = make.getByRole('region', { name: 'What the file would hold' });
  await expect(look.getByText(/ left out$/).first()).toBeVisible();
  await expect(look.getByText('The customer has no Tally party name').first()).toBeVisible();
  const preview = await asUser<{ lines?: unknown[]; included?: unknown[]; leftOut: Array<{ reason: string }> }>(USERS.accA.id,
    'select public.accounts_tally_file_preview($1, $2::date, $3::date, $4::text[], $5::uuid[]) as r',
    [await entityId(), today, today, ['journal_entry'], null]);
  expect(preview.leftOut.map((l) => l.reason)).toContain('party_not_mapped');
  await make.getByRole('button', { name: 'Make Tally file' }).click();
  await expect(make.getByText(/^Tally file TE-[0-9]{4}-[0-9]{6}: /)).toBeVisible();
  await expect.poll(async () => (await q<{ n: number }>(`select count(*)::int as n from public.tally_exports where format = 'xml' and created_at > $1::timestamptz`, [t0]))[0]!.n)
    .toBe(1);
  const [first] = await q<{ id: string; export_no: string }>(`select id, export_no from public.tally_exports where format = 'xml' and created_at > $1::timestamptz
    order by created_at desc limit 1`, [t0]);
  // Left-out list on the file; XML download (attachment <file number>.xml, audited).
  const left = await asUser<{ items: Array<{ reason: string }> }>(USERS.accA.id, 'select public.accounts_tally_export_left_out($1, $2, $3) as r', [first!.id, null, 100]);
  expect(left.items.map((i) => i.reason)).toContain('party_not_mapped');
  const xml = await acc.page.request.get(`/app/accounts/tally/exports/${first!.id}/xml`);
  expect(xml.status()).toBe(200);
  expect(xml.headers()['content-disposition']).toContain(`${first!.export_no}.xml`);
  expect(xml.headers()['cache-control']).toContain('no-store');
  const text = await xml.text();
  expect(text.startsWith('<?xml')).toBe(true);
  expect(text).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>');
  expect(text).toContain('<SVCURRENTCOMPANY>Synthetic Copy Company</SVCURRENTCOMPANY>');
  expect(text).not.toMatch(/<VOUCHERNUMBER>|GSTIN|Synthetic Payer/);
  expect((await q<{ n: number }>(`select count(*)::int as n from public.audit_events where action = 'accounts.tally_file.downloaded' and target_id = $1`,
    [first!.id]))[0]!.n).toBe(1);
  void downloads;

  // A second file leaves the exported entries out (already_in_file) unless included again with a reason.
  const second = await asUser<{ exportId: string } | null>(USERS.accA.id,
    'select public.accounts_tally_file_create($1, $2::date, $3::date, $4::text[], $5::uuid[], $6, $7, $8) as r',
    [await entityId(), dayFromToday(0), dayFromToday(0), ['journal_entry'], null, false, null, randomUUID()]).catch((e: { message: string }) => {
    expect(e.message).toBe('nothing_to_export');
    return null;
  });
  if (second) {
    const left2 = await asUser<{ items: Array<{ reason: string }> }>(USERS.accA.id, 'select public.accounts_tally_export_left_out($1, $2, $3) as r', [second.exportId, null, 100]);
    expect(left2.items.map((i) => i.reason)).toContain('already_in_file');
  }

  // Day Book exported from the copy company (synthetic): one voucher per line, one with a different amount, one unknown tag.
  const frozen = await q<{ line_no: number; values: { narration: string; date: string; voucherType: string; entries: Array<{ debitPaise?: string; creditPaise?: string }> } }>(
    'select line_no, "values" from public.tally_export_lines where export_id = $1 order by line_no', [first!.id]);
  expect(frozen.length).toBeGreaterThanOrEqual(2);
  const rupees = (p: bigint) => `${p / 100n}.${String(p % 100n).padStart(2, '0')}`;
  const vouchers = frozen.map((l, i) => {
    const amount = BigInt(l.values.entries.find((e) => e.debitPaise)?.debitPaise ?? '0');
    const shown = i === 1 ? amount + 100n : amount;
    return `<VOUCHER VCHTYPE="${l.values.voucherType}" ACTION="Create"><DATE>${l.values.date}</DATE><VOUCHERTYPENAME>${l.values.voucherType}</VOUCHERTYPENAME>`
      + `<VOUCHERNUMBER>${100 + i}</VOUCHERNUMBER><NARRATION>${l.values.narration.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</NARRATION>`
      + `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Synthetic Bank A/c</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${rupees(shown)}</AMOUNT></ALLLEDGERENTRIES.LIST>`
      + `</VOUCHER>`;
  });
  vouchers.push(`<VOUCHER VCHTYPE="Receipt" ACTION="Create"><DATE>${frozen[0]!.values.date}</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>999</VOUCHERNUMBER>`
    + `<NARRATION>Entered by hand, no tag</NARRATION><ALLLEDGERENTRIES.LIST><LEDGERNAME>Synthetic Bank A/c</LEDGERNAME><AMOUNT>-10.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>`);
  // ASSUMPTION: the parser (tally-daybook.ts) reads TallyPrime's Day Book XML export: ENVELOPE > BODY > DATA > TALLYMESSAGE > VOUCHER.
  const dayBook = `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><DATA>`
    + vouchers.map((v) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">${v}</TALLYMESSAGE>`).join('') + `</DATA></BODY></ENVELOPE>`;

  // "Upload Tally vouchers": check the file (nothing changes), review, Apply (bound to the proposal hash).
  await acc.page.goto(ROUTES.tally);
  const up = acc.page.getByRole('form', { name: 'Upload Tally vouchers' });
  await up.locator('input[type=file]').setInputFiles({ name: `daybook-${stamp}.xml`, mimeType: 'application/xml', buffer: Buffer.from(dayBook) });
  await up.getByRole('button', { name: 'Check the file' }).click();
  await expect(up.getByText(/amount differs —/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(up.getByText(/no tn: tag —/i).first()).toBeVisible();
  await up.getByRole('link', { name: /Review and apply/ }).click();
  await acc.page.getByRole('button', { name: 'Apply', exact: true }).first().click();
  await acc.page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(async () => (await q<{ s: string }>(`select status as s from public.tally_match_batches order by staged_at desc limit 1`))[0]?.s, { timeout: 30_000 })
    .toBe('applied');
  const recs = await q<{ status: string; voucher_ref: string | null; exception_tally_amount_paise: string | null }>(
    `select t.status, t.voucher_ref, t.exception_tally_amount_paise::text from public.tally_export_lines l join public.tally_records t on t.id = l.tally_record_id
     where l.export_id = $1 order by l.line_no`, [first!.id]);
  expect(recs.filter((r) => r.status === 'matched').length).toBe(recs.length - 1);
  expect(recs[1]).toMatchObject({ status: 'exception' });
  expect(recs[1]!.exception_tally_amount_paise).not.toBeNull();
  // The existing tally_exception notice fires for the exception owner.
  expect((await q<{ n: number }>(`select count(*)::int as n from public.staff_notices where kind = 'tally_exception' and created_at > now() - interval '10 minutes'`))[0]!.n)
    .toBeGreaterThan(0);
  await acc.ctx.close();
  void unmapped;
});

test('9. no outbound request except the app and the local Supabase (the CRM never contacts Tally)', () => {
  expect(allowedOutbound()).toEqual([]);
});
