import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// ASSUMPTION: export name — pure XML builder (contract 7.3).
import { buildTallyXml } from '@/modules/accounts-desk/tally-xml';
// ASSUMPTION: export name — pure Day Book parser (contract 7.4).
import { parseDayBook } from '@/modules/accounts-desk/tally-daybook';

/**
 * Accounts phase 3, Track T (contract 16.2): the TallyPrime 7.1 import file
 * builder and the Day Book parser, written from contract 7.3 / 7.4 and LD17 /
 * LD18. Structure tests only; a real import into a copy company is a gate.
 *
 * ASSUMPTION (input shape, not frozen by the contract): buildTallyXml({
 *   companyName, vouchers: [{ date 'YYYY-MM-DD', voucherType, narration,
 *   reference, partyLedger | null, entries: [{ ledger, debitPaise | creditPaise }] }] })
 * returns the XML text. parseDayBook(xml text) returns { vouchers: [{
 *   voucherNumber, date 'YYYY-MM-DD', voucherType, narration, amountPaise, tnTag }] }
 *   and refuses (throws, or returns { ok: false }) a DTD, an entity, more than
 *   4 MiB (Addendum L5) or more than 5,000 vouchers.
 */

const RECEIPT = {
  date: '2026-11-10', voucherType: 'Receipt', narration: 'Deal 990001 | SYN-DEL-001 | Receipt R-2026-27-000001 | TN:TE-2026-000012/1',
  reference: 'R-2026-27-000001', partyLedger: 'Synthetic Customer Ledger',
  entries: [{ ledger: 'Synthetic Bank', debitPaise: '123456' }, { ledger: 'Synthetic Customer Ledger', creditPaise: '123456' }],
};
const CONTRA = {
  date: '2026-11-11', voucherType: 'Contra', narration: 'Deal - | - | Deposit DEP-1 | TN:TE-2026-000012/2', reference: 'DEP-1', partyLedger: null,
  entries: [{ ledger: 'Synthetic Bank', debitPaise: '5' }, { ledger: 'Cash', creditPaise: '5' }],
};
const FILE = { companyName: 'Holiday Chacha Copy & Co <Test>', vouchers: [RECEIPT, CONTRA] };

const tags = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name.replace('.', '\\.')}(?:\\s[^>]*)?>([\\s\\S]*?)</${name.replace('.', '\\.')}>`, 'g'))].map((m) => m[1]!);
const one = (xml: string, name: string) => {
  const all = tags(xml, name);
  expect(all.length, name).toBeGreaterThan(0);
  return all[0]!.trim();
};

describe('7.3 Tally import envelope', () => {
  const xml = buildTallyXml(FILE as never);

  it('UTF-8 declaration and the envelope path of 7.3', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(one(xml, 'TALLYREQUEST')).toBe('Import Data');
    expect(xml).toMatch(/<ENVELOPE>[\s\S]*<HEADER>[\s\S]*<TALLYREQUEST>Import Data<\/TALLYREQUEST>[\s\S]*<\/HEADER>[\s\S]*<BODY>[\s\S]*<IMPORTDATA>[\s\S]*<REQUESTDESC>[\s\S]*<REPORTNAME>Vouchers<\/REPORTNAME>[\s\S]*<STATICVARIABLES>[\s\S]*<SVCURRENTCOMPANY>[\s\S]*<\/SVCURRENTCOMPANY>[\s\S]*<\/STATICVARIABLES>[\s\S]*<\/REQUESTDESC>[\s\S]*<REQUESTDATA>[\s\S]*<TALLYMESSAGE xmlns:UDF="TallyUDF">[\s\S]*<VOUCHER [\s\S]*<\/REQUESTDATA>[\s\S]*<\/IMPORTDATA>[\s\S]*<\/BODY>[\s\S]*<\/ENVELOPE>\s*$/);
    expect(one(xml, 'SVCURRENTCOMPANY')).toBe('Holiday Chacha Copy &amp; Co &lt;Test&gt;');
  });

  it('one VOUCHER per entry with VCHTYPE and ACTION="Create", date YYYYMMDD, type, narration, reference, party when present', () => {
    const vouchers = [...xml.matchAll(/<VOUCHER\s([^>]*)>([\s\S]*?)<\/VOUCHER>/g)];
    expect(vouchers).toHaveLength(2);
    expect(vouchers[0]![1]).toMatch(/VCHTYPE="Receipt"/);
    expect(vouchers[0]![1]).toMatch(/ACTION="Create"/);
    const v1 = vouchers[0]![2]!;
    expect(one(v1, 'DATE')).toBe('20261110');
    expect(one(v1, 'VOUCHERTYPENAME')).toBe('Receipt');
    expect(one(v1, 'NARRATION')).toBe(RECEIPT.narration);
    expect(one(v1, 'REFERENCE')).toBe('R-2026-27-000001');
    expect(one(v1, 'PARTYLEDGERNAME')).toBe('Synthetic Customer Ledger');
    const v2 = vouchers[1]![2]!;
    expect(vouchers[1]![1]).toMatch(/VCHTYPE="Contra"/);
    expect(one(v2, 'DATE')).toBe('20261111');
    expect(tags(v2, 'PARTYLEDGERNAME')).toHaveLength(0);
  });

  it('entries: debit = ISDEEMEDPOSITIVE Yes and a negative amount; credit = No and positive; rupees with two decimals', () => {
    const v = [...xml.matchAll(/<VOUCHER\s[^>]*>([\s\S]*?)<\/VOUCHER>/g)].map((m) => m[1]!);
    const entries = (body: string) => tags(body, 'ALLLEDGERENTRIES.LIST').map((e) => ({
      ledger: one(e, 'LEDGERNAME'), positive: one(e, 'ISDEEMEDPOSITIVE'), amount: one(e, 'AMOUNT') }));
    expect(entries(v[0]!)).toEqual([
      { ledger: 'Synthetic Bank', positive: 'Yes', amount: '-1234.56' },
      { ledger: 'Synthetic Customer Ledger', positive: 'No', amount: '1234.56' },
    ]);
    expect(entries(v[1]!)).toEqual([
      { ledger: 'Synthetic Bank', positive: 'Yes', amount: '-0.05' },
      { ledger: 'Cash', positive: 'No', amount: '0.05' },
    ]);
  });

  it('large whole-paise amounts keep every digit (no floats)', () => {
    const big = buildTallyXml({ companyName: 'C', vouchers: [{ ...RECEIPT, entries: [
      { ledger: 'B', debitPaise: '900719925474099312' }, { ledger: 'P', creditPaise: '900719925474099312' }] }] } as never);
    expect(tags(big, 'AMOUNT').map((a) => a.trim())).toEqual(['-9007199254740993.12', '9007199254740993.12']);
    const round = buildTallyXml({ companyName: 'C', vouchers: [{ ...RECEIPT, entries: [
      { ledger: 'B', debitPaise: '100' }, { ledger: 'P', creditPaise: '100' }] }] } as never);
    expect(tags(round, 'AMOUNT').map((a) => a.trim())).toEqual(['-1.00', '1.00']);
  });

  it('text is XML-escaped (& < > " \')', () => {
    const x = buildTallyXml({ companyName: 'C', vouchers: [{ ...RECEIPT, narration: 'A & B <x> "q" \'s | TN:TE-1/1', partyLedger: 'M&M "Travels"',
      entries: [{ ledger: 'M&M "Travels"', debitPaise: '1' }, { ledger: '<Bank>', creditPaise: '1' }] }] } as never);
    expect(x).not.toMatch(/A & B/);
    expect(x).toContain('A &amp; B &lt;x&gt;');
    expect(x).not.toContain('<Bank>');
    expect(x).toContain('&lt;Bank&gt;');
    expect(x).toMatch(/M&amp;M (&quot;|")Travels(&quot;|")/);
  });

  it('LD18: no voucher number, no bill-wise allocation, no cost centre, no GST fields, no ledger creation', () => {
    for (const forbidden of ['VOUCHERNUMBER', 'BILLALLOCATIONS', 'COSTCENTRE', 'CATEGORYALLOCATIONS', 'GST', 'LEDGER NAME=', '<LEDGER ', 'ACTION="Alter"', 'ACTION="Delete"']) {
      expect(xml.toUpperCase(), forbidden).not.toContain(forbidden.toUpperCase());
    }
  });

  it('same frozen input → the same bytes', () => {
    expect(buildTallyXml(structuredClone(FILE) as never)).toBe(xml);
    expect(Buffer.from(buildTallyXml(structuredClone(FILE) as never), 'utf8').equals(Buffer.from(xml, 'utf8'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7.4 Day Book parser
// ---------------------------------------------------------------------------
/**
 * The Day Book as TallyPrime exports it to XML: Tally's own data-exchange wrapper
 * ENVELOPE > HEADER (TALLYREQUEST Import Data) > BODY > IMPORTDATA > REQUESTDESC / REQUESTDATA >
 * TALLYMESSAGE > VOUCHER — the same shape as the lead's fixture
 * supabase/fixtures/phase3/acc3-syn-tally-daybook.xml (contract 7.4 does not freeze the wrapper).
 */
function dayBook(vouchers: Array<{ no: string; date: string; type: string; narration: string; amount: string }>, prolog = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${prolog}<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>SYN Copy Company (synthetic)</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${
    vouchers.map((v) => `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${v.type}" ACTION="Create" OBJVIEW="Accounting Voucher View"><DATE>${v.date}</DATE><NARRATION>${v.narration}</NARRATION><VOUCHERTYPENAME>${v.type}</VOUCHERTYPENAME><VOUCHERNUMBER>${v.no}</VOUCHERNUMBER><ALLLEDGERENTRIES.LIST><LEDGERNAME>Synthetic Bank</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>${v.amount}</AMOUNT></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Synthetic Customer</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${v.amount.replace('-', '')}</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE>`).join('')
  }</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}
type Parsed = { vouchers: Array<{ voucherNumber: string; date: string; voucherType: string; narration: string; amountPaise: string | number | bigint;
  tnTag: string | null | { exportNo: string; lineNo: number } }> };
function refused(run: () => unknown): boolean {
  try {
    const r = run() as { ok?: boolean } | null;
    return r == null || r.ok === false;
  } catch {
    return true;
  }
}

describe('7.4 Day Book parser', () => {
  it('reads the lead fixture Day Book (Tally export wrapper, CRLF): six vouchers, tags and amounts', () => {
    const xml = readFileSync(join(import.meta.dirname, '..', '..', 'supabase', 'fixtures', 'phase3', 'acc3-syn-tally-daybook.xml'), 'utf8');
    const r = parseDayBook(xml) as Parsed;
    expect(r.vouchers).toHaveLength(6);
    const tags = r.vouchers.map((v) => (v.tnTag == null ? null : JSON.stringify(v.tnTag)));
    expect(tags.filter((t) => t !== null)).toHaveLength(5);
    expect(tags[0]).toMatch(/TE-2026-000001/);
    expect(tags[5]).toBeNull();
    expect(r.vouchers.slice(0, 3).map((v) => String(v.amountPaise))).toEqual(['2000000', '1000000', '910000']);
    expect(r.vouchers[0]).toMatchObject({ voucherNumber: '1', date: '2026-11-13', voucherType: 'Receipt' });
  });

  it('voucher number, date, type, narration, absolute amount and the TN: tag', () => {
    const r = parseDayBook(dayBook([
      { no: '101', date: '20261110', type: 'Receipt', narration: 'Deal 990001 | SYN-DEL-001 | Receipt R-1 | TN:TE-2026-000012/1', amount: '-1234.56' },
      { no: '102', date: '20261111', type: 'Payment', narration: 'Typed by hand in Tally', amount: '-10.00' },
    ])) as Parsed;
    expect(r.vouchers).toHaveLength(2);
    const [a, b] = r.vouchers;
    expect(a).toMatchObject({ voucherNumber: '101', date: '2026-11-10', voucherType: 'Receipt' });
    expect(String(a!.amountPaise)).toBe('123456');
    expect(JSON.stringify(a!.tnTag)).toMatch(/TE-2026-000012/);
    expect(JSON.stringify(a!.tnTag)).toMatch(/\b1\b/);
    expect(b!.tnTag ?? null).toBeNull();
    expect(String(b!.amountPaise)).toBe('1000');
  });

  it('refuses a DTD and entities (no expansion)', () => {
    const v = [{ no: '1', date: '20261110', type: 'Receipt', narration: 'TN:TE-1/1', amount: '-1.00' }];
    expect(refused(() => parseDayBook(dayBook(v, '<!DOCTYPE ENVELOPE [<!ENTITY x "boom">]>')))).toBe(true);
    expect(refused(() => parseDayBook(dayBook(v, '<!DOCTYPE ENVELOPE SYSTEM "file:///etc/passwd">')))).toBe(true);
    expect(refused(() => parseDayBook(dayBook([{ ...v[0]!, narration: '&x;' }], '<!ENTITY x "boom">')))).toBe(true);
  });

  it('refuses more than 4 MiB (Addendum L5) and more than 5,000 vouchers; 5,000 is accepted', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ no: String(i + 1), date: '20261110', type: 'Receipt', narration: `TN:TE-1/${i + 1}`, amount: '-1.00' }));
    expect(refused(() => parseDayBook(dayBook(many(5001))))).toBe(true);
    const ok = parseDayBook(dayBook(many(5000))) as Parsed;
    expect(ok.vouchers).toHaveLength(5000);
    const pad = `<!-- ${'x'.repeat(4 * 1024 * 1024)} -->`;
    expect(refused(() => parseDayBook(dayBook(many(1)).replace('<ENVELOPE>', `<ENVELOPE>${pad}`)))).toBe(true);
  });
});
