/**
 * Day Book parser for the Tally matching upload (Accounts phase 3, contract 7.4, LD17). Pure: no I/O, no network.
 *
 * Input: the Day Book exported from TallyPrime as XML (ENVELOPE > ... > TALLYMESSAGE > VOUCHER; UTF-8 or Tally's
 * UTF-16 "Unicode" export, with or without a byte-order mark). One forward pass over the text (a streaming tokenizer,
 * no DOM): for each VOUCHER it keeps the voucher number, the date, the voucher type, the narration and the absolute
 * amount of the first ledger entry (the party or bank line), and extracts the CRM tag "TN:<file number>/<line>" from
 * the narration. Nothing else is kept; the narration never leaves the server action.
 *
 * Refused (TallyDayBookError): more than 4 MiB (Addendum L6), more than 5,000 vouchers, any DTD or markup declaration
 * (<!DOCTYPE, <!ENTITY, ...), any entity reference other than the five XML ones and numeric character references,
 * malformed markup, a voucher without a number or with an unreadable date or amount.
 */

/** Addendum L6: 4 MiB (server actions and Vercel bodies are capped near 4.5 MB). */
export const DAYBOOK_MAX_BYTES = 4 * 1024 * 1024;
export const DAYBOOK_MAX_VOUCHERS = 5000;

export type DayBookErrorCode =
  | 'too_large'
  | 'too_many_vouchers'
  | 'no_vouchers'
  | 'dtd_refused'
  | 'entity_refused'
  | 'malformed'
  | 'voucher_number_missing'
  | 'bad_date'
  | 'bad_amount';

export class TallyDayBookError extends Error {
  override name = 'TallyDayBookError';
  constructor(
    readonly code: DayBookErrorCode,
    /** 1-based voucher position, when the problem is in one voucher. */
    readonly voucherIndex: number | null = null,
  ) {
    super(`Day Book refused: ${code}${voucherIndex ? ` (voucher ${voucherIndex})` : ''}`);
  }
}

export interface DayBookVoucher {
  voucherNumber: string;
  /** ISO YYYY-MM-DD. */
  date: string;
  voucherType: string | null;
  narration: string;
  /** Absolute amount of the first ledger entry, whole paise as a decimal string. */
  amountPaise: string;
  /** "TN:TE-2026-000012/3", or null when the narration carries no CRM tag. */
  tnTag: string | null;
}

export interface DayBook {
  vouchers: DayBookVoucher[];
}

const TN_TAG = /TN:(TE-\d{4}-\d{6})\/(\d{1,5})(?!\d)/;

/** The CRM tag in a narration, normalised ("TN:TE-2026-000012/3"), or null. */
export function tnTagOf(narration: string): string | null {
  const m = TN_TAG.exec(narration);
  return m ? `TN:${m[1]}/${Number(m[2])}` : null;
}

function byteLength(text: string): number {
  // UTF-8 length without allocating: 1-4 bytes per code point.
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i += 1;
    } else n += 3;
    if (n > DAYBOOK_MAX_BYTES) return n;
  }
  return n;
}

/** Bytes -> text: UTF-16 by byte-order mark (or a NUL in the second byte), else UTF-8. */
export function decodeDayBook(bytes: Uint8Array): string {
  if (bytes.byteLength > DAYBOOK_MAX_BYTES) throw new TallyDayBookError('too_large');
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes.byteLength > 1 && bytes[0] === 0x3c && bytes[1] === 0x00) return new TextDecoder('utf-16le').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodes the five XML entities and numeric references; anything else is refused (no entity expansion). */
function decodeText(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&([^;&\s]{0,12});?/g, (whole, name: string) => {
    if (!whole.endsWith(';')) throw new TallyDayBookError('entity_refused');
    if (Object.hasOwn(NAMED, name)) return NAMED[name]!;
    let code: number | null = null;
    if (/^#[0-9]{1,7}$/.test(name)) code = Number(name.slice(1));
    else if (/^#x[0-9a-fA-F]{1,6}$/.test(name)) code = parseInt(name.slice(2), 16);
    if (code === null) throw new TallyDayBookError('entity_refused');
    if (code > 0x10ffff) throw new TallyDayBookError('malformed');
    // Tally writes control characters as references (&#4; and the like): dropped; line breaks become spaces.
    if (code === 9 || code === 10 || code === 13) return ' ';
    if (code < 32 || code === 127) return '';
    return String.fromCodePoint(code);
  });
}

/** "-20000.00" -> "2000000" (absolute, whole paise); null when unreadable. */
export function tallyAmountToPaise(raw: string): string | null {
  const t = raw.trim().replace(/,/g, '');
  const m = /^-?(\d{1,15})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const paise = `${m[1]}${(m[2] ?? '').padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
  return paise;
}

function isoDate(raw: string): string | null {
  const t = raw.trim();
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(t) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

interface Draft {
  vchType: string | null;
  number: string | null;
  date: string | null;
  type: string | null;
  narration: string | null;
  amount: string | null;
  sawEntry: boolean;
}

const ENTRY_LISTS = new Set(['ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST']);

/** Parses a Day Book (text or bytes). Throws TallyDayBookError when refused. */
export function parseDayBook(input: string | Uint8Array): DayBook {
  const text = typeof input === 'string' ? input : decodeDayBook(input);
  if (typeof input === 'string' && byteLength(input) > DAYBOOK_MAX_BYTES) throw new TallyDayBookError('too_large');

  const vouchers: DayBookVoucher[] = [];
  const stack: string[] = [];
  let draft: Draft | null = null;
  let voucherDepth = -1;
  let entryDepth = -1;
  let buf = '';
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;

  const finish = (d: Draft): void => {
    const index = vouchers.length + 1;
    if (index > DAYBOOK_MAX_VOUCHERS) throw new TallyDayBookError('too_many_vouchers');
    const number = (d.number ?? '').trim();
    if (!number) throw new TallyDayBookError('voucher_number_missing', index);
    const date = d.date === null ? null : isoDate(d.date);
    if (!date) throw new TallyDayBookError('bad_date', index);
    let amount = '0';
    if (d.amount !== null) {
      const p = tallyAmountToPaise(d.amount);
      if (p === null) throw new TallyDayBookError('bad_amount', index);
      amount = p;
    }
    const narration = (d.narration ?? '').trim();
    const type = (d.type ?? d.vchType ?? '').trim();
    vouchers.push({ voucherNumber: number, date, voucherType: type || null, narration, amountPaise: amount, tnTag: tnTagOf(narration) });
  };

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      buf += text.slice(i);
      break;
    }
    if (lt > i) buf += text.slice(i, lt);
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) throw new TallyDayBookError('malformed');
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) throw new TallyDayBookError('malformed');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end === -1) throw new TallyDayBookError('malformed');
      buf += text.slice(lt + 9, end).replace(/&/g, '&amp;');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) throw new TallyDayBookError('dtd_refused');
    const gt = text.indexOf('>', lt + 1);
    if (gt === -1) throw new TallyDayBookError('malformed');
    const tag = text.slice(lt + 1, gt);
    i = gt + 1;

    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      const open = stack.pop();
      if (open !== name) throw new TallyDayBookError('malformed');
      const value = decodeText(buf);
      buf = '';
      const depth = stack.length;
      if (draft && depth === voucherDepth + 1) {
        if (name === 'VOUCHERNUMBER') draft.number = value;
        else if (name === 'DATE') draft.date = value;
        else if (name === 'VOUCHERTYPENAME') draft.type = value;
        else if (name === 'NARRATION') draft.narration = value;
      }
      if (draft && entryDepth >= 0 && depth === entryDepth + 1 && name === 'AMOUNT' && draft.amount === null) draft.amount = value;
      if (draft && depth === entryDepth && ENTRY_LISTS.has(name)) entryDepth = -1;
      if (draft && depth === voucherDepth && name === 'VOUCHER') {
        finish(draft);
        draft = null;
        voucherDepth = -1;
      }
      continue;
    }

    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const m = /^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*)$/.exec(body);
    if (!m) throw new TallyDayBookError('malformed');
    const name = m[1]!;
    const attrs = m[2]!;
    if (attrs.includes('&')) decodeText(attrs);
    buf = '';
    if (selfClosing) continue;
    const depth = stack.length;
    stack.push(name);
    if (name === 'VOUCHER' && !draft) {
      const vch = /\bVCHTYPE\s*=\s*"([^"]*)"/.exec(attrs);
      draft = { vchType: vch ? decodeText(vch[1]!) : null, number: null, date: null, type: null, narration: null, amount: null, sawEntry: false };
      voucherDepth = depth;
      if (vouchers.length >= DAYBOOK_MAX_VOUCHERS) throw new TallyDayBookError('too_many_vouchers');
    } else if (draft && depth === voucherDepth + 1 && ENTRY_LISTS.has(name) && !draft.sawEntry) {
      draft.sawEntry = true;
      entryDepth = depth;
    }
  }
  if (stack.length > 0 || draft) throw new TallyDayBookError('malformed');
  if (/&/.test(buf)) decodeText(buf);
  return { vouchers };
}
