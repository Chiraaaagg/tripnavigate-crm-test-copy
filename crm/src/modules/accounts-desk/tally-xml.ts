/**
 * TallyPrime 7.1 import file (Accounts phase 3, contract 7.3, LD17, LD18). Pure: no I/O, no network.
 *
 * ENVELOPE > HEADER > TALLYREQUEST = Import Data;
 * BODY > IMPORTDATA > REQUESTDESC > REPORTNAME = Vouchers, STATICVARIABLES > SVCURRENTCOMPANY = <company>;
 * REQUESTDATA > TALLYMESSAGE (xmlns:UDF="TallyUDF") > VOUCHER (VCHTYPE, ACTION="Create") with DATE (YYYYMMDD),
 * VOUCHERTYPENAME, NARRATION, REFERENCE, PARTYLEDGERNAME (when there is a party) and one ALLLEDGERENTRIES.LIST per
 * entry: LEDGERNAME, ISDEEMEDPOSITIVE (Yes = debit, No = credit), AMOUNT (debit negative, credit positive, rupees
 * with two decimals).
 *
 * Never: a voucher number (Tally numbers it), bill-wise allocation, cost centre, GST fields or a ledger master — the
 * file can never invent a ledger. Text is XML-escaped; control characters are dropped (the database refuses them in
 * names already). UTF-8 with a declaration. The same frozen input always gives the same bytes.
 */

export interface TallyXmlEntry {
  ledger: string;
  /** Whole paise as a decimal string; exactly one of debitPaise / creditPaise. */
  debitPaise?: string;
  creditPaise?: string;
}

export interface TallyXmlVoucher {
  /** ISO date YYYY-MM-DD. */
  date: string;
  voucherType: string;
  narration: string;
  reference: string | null;
  partyLedger: string | null;
  entries: TallyXmlEntry[];
}

export interface TallyXmlFile {
  companyName: string;
  vouchers: TallyXmlVoucher[];
}

const EOL = '\r\n';

/** XML text escaping (& < > " '); control characters other than tab / newline are dropped. */
export function xmlEscape(value: string): string {
   
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** "123456" paise -> "1234.56"; negative when `negative`. Exact for any whole-paise string (no floats). */
export function paiseToTallyAmount(paise: string, negative: boolean): string {
  if (!/^(0|[1-9][0-9]{0,17})$/.test(paise)) throw new Error('tally-xml: amount is not whole paise');
  const padded = paise.padStart(3, '0');
  const rupees = `${padded.slice(0, -2)}.${padded.slice(-2)}`;
  return negative && paise !== '0' ? `-${rupees}` : rupees;
}

/** "2026-11-10" -> "20261110". */
export function tallyDate(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new Error('tally-xml: date is not YYYY-MM-DD');
  return isoDate.replace(/-/g, '');
}

function el(name: string, value: string, indent: string): string {
  return `${indent}<${name}>${xmlEscape(value)}</${name}>${EOL}`;
}

/** The file head up to and including <REQUESTDATA>. */
export function tallyXmlHead(companyName: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>${EOL}` +
    `<ENVELOPE>${EOL}` +
    ` <HEADER>${EOL}` +
    `  <TALLYREQUEST>Import Data</TALLYREQUEST>${EOL}` +
    ` </HEADER>${EOL}` +
    ` <BODY>${EOL}` +
    `  <IMPORTDATA>${EOL}` +
    `   <REQUESTDESC>${EOL}` +
    `    <REPORTNAME>Vouchers</REPORTNAME>${EOL}` +
    `    <STATICVARIABLES>${EOL}` +
    el('SVCURRENTCOMPANY', companyName, '     ') +
    `    </STATICVARIABLES>${EOL}` +
    `   </REQUESTDESC>${EOL}` +
    `   <REQUESTDATA>${EOL}`
  );
}

/** One voucher in its own TALLYMESSAGE. */
export function tallyVoucherXml(v: TallyXmlVoucher): string {
  const i = '      ';
  let out = `    <TALLYMESSAGE xmlns:UDF="TallyUDF">${EOL}`;
  out += `     <VOUCHER VCHTYPE="${xmlEscape(v.voucherType)}" ACTION="Create">${EOL}`;
  out += el('DATE', tallyDate(v.date), i);
  out += el('VOUCHERTYPENAME', v.voucherType, i);
  out += el('NARRATION', v.narration, i);
  if (v.reference) out += el('REFERENCE', v.reference, i);
  if (v.partyLedger) out += el('PARTYLEDGERNAME', v.partyLedger, i);
  for (const e of v.entries) {
    const debit = e.debitPaise != null;
    if (debit === (e.creditPaise != null)) throw new Error('tally-xml: an entry needs exactly one of debit or credit');
    out += `${i}<ALLLEDGERENTRIES.LIST>${EOL}`;
    out += el('LEDGERNAME', e.ledger, `${i} `);
    out += el('ISDEEMEDPOSITIVE', debit ? 'Yes' : 'No', `${i} `);
    out += el('AMOUNT', paiseToTallyAmount((debit ? e.debitPaise : e.creditPaise)!, debit), `${i} `);
    out += `${i}</ALLLEDGERENTRIES.LIST>${EOL}`;
  }
  out += `     </VOUCHER>${EOL}`;
  out += `    </TALLYMESSAGE>${EOL}`;
  return out;
}

/** The file tail after the last voucher. */
export function tallyXmlTail(): string {
  return `   </REQUESTDATA>${EOL}  </IMPORTDATA>${EOL} </BODY>${EOL}</ENVELOPE>${EOL}`;
}

/** The whole file as text (the route streams the same three parts). */
export function buildTallyXml(file: TallyXmlFile): string {
  return tallyXmlHead(file.companyName) + file.vouchers.map(tallyVoucherXml).join('') + tallyXmlTail();
}

/** Download file name of an XML file: "<file number>.xml". */
export function tallyXmlFileName(exportNo: string): string {
  return `${exportNo.replace(/[^A-Za-z0-9-]/g, '')}.xml`;
}
