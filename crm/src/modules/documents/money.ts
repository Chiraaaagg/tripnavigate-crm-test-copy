/**
 * Paise -> rupees for customer documents (freeze part 2 sections 3 and 5).
 * Exact or refused: an amount with paise is never rounded; an amount beyond
 * the safe integer range is refused. Pure.
 */

export type RupeesResult = { ok: true; rupees: number } | { ok: false; code: 'amount_has_paise' | 'amount_invalid' };

const WHOLE = /^(0|[1-9][0-9]{0,17})$/;

export function paiseToRupees(paise: string | number | bigint): RupeesResult {
  let value: bigint;
  if (typeof paise === 'bigint') value = paise;
  else if (typeof paise === 'number') {
    if (!Number.isSafeInteger(paise)) return { ok: false, code: 'amount_invalid' };
    value = BigInt(paise);
  } else {
    if (!WHOLE.test(paise)) return { ok: false, code: 'amount_invalid' };
    value = BigInt(paise);
  }
  if (value < 0n) return { ok: false, code: 'amount_invalid' };
  if (value % 100n !== 0n) return { ok: false, code: 'amount_has_paise' };
  const rupees = value / 100n;
  if (rupees > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, code: 'amount_invalid' };
  return { ok: true, rupees: Number(rupees) };
}

/**
 * Per-person price in whole rupees, only when the total divides exactly by the
 * paying travellers; null otherwise (the document then says "total for N
 * travellers").
 */
export function exactPerPersonRupees(totalRupees: number, travellers: number): number | null {
  if (!Number.isSafeInteger(totalRupees) || !Number.isInteger(travellers) || travellers < 1) return null;
  return totalRupees % travellers === 0 ? totalRupees / travellers : null;
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n]!;
  const t = TENS[Math.floor(n / 10)]!;
  return n % 10 ? `${t} ${ONES[n % 10]!}` : t;
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]!} Hundred` : '', r ? belowHundred(r) : ''].filter(Boolean).join(' ');
}

/** Indian-format words for whole rupees: 270000 -> "Two Lakh Seventy Thousand Rupees". */
export function rupeesInWords(rupees: number): string {
  if (!Number.isSafeInteger(rupees) || rupees < 0) throw new RangeError('rupees');
  if (rupees === 0) return 'Zero Rupees';
  const parts: string[] = [];
  let n = rupees;
  const crore = Math.floor(n / 10_000_000);
  n %= 10_000_000;
  const lakh = Math.floor(n / 100_000);
  n %= 100_000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  // Crores above 999 are spelled recursively ("One Thousand Crore").
  if (crore) parts.push(`${rupeesInWords(crore).replace(/ Rupees$/, '')} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (n) parts.push(belowThousand(n));
  return `${parts.join(' ')} Rupees`;
}
