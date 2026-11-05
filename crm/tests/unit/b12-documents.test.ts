import { describe, expect, it } from 'vitest';
import type {
  ItineraryDocumentView,
  PackageDocumentInput,
  QuotationDocumentView,
  QuoteDocumentInput,
} from '@/modules/documents/contracts';
import { forbiddenKeyPaths } from '@/modules/documents/guard';
import { exactPerPersonRupees, paiseToRupees, rupeesInWords } from '@/modules/documents/money';
import { htmlToText, scanStrings, scanText } from '@/modules/documents/safety';
import { PlaceholderCollector, isPlaceholder, neutraliseLeadingBracket, placeholder, shortDate } from '@/modules/documents/text';
import { itineraryView, quotationView } from './b12-documents-fixtures';

/**
 * B1.2 Phase F groundwork: documents module pure rules (money, placeholders,
 * content safety, leak guard). Synthetic values only.
 */

// --- type-level leak check: no view or input key names a forbidden concept ---
type DeepKeys<T> = T extends readonly (infer U)[]
  ? DeepKeys<U>
  : T extends object
    ? { [K in keyof T & string]: K | DeepKeys<T[K]> }[keyof T & string]
    : never;
type Word = 'cost' | 'margin' | 'budget' | 'supplier' | 'vendor' | 'bitrix' | 'internal' | 'remark' | 'claim' | 'receipt' | 'purchase' | 'markup' | 'commission' | 'profit' | 'difference';
type Forbidden = `${string}${Word | Capitalize<Word>}${string}`;
type NoForbidden<T> = [Extract<DeepKeys<T>, Forbidden>] extends [never] ? true : false;
const typeChecks: [NoForbidden<QuotationDocumentView>, NoForbidden<ItineraryDocumentView>, NoForbidden<QuoteDocumentInput>, NoForbidden<PackageDocumentInput>] = [
  true, true, true, true,
];

describe('leak guard', () => {
  it('the view and input types contain no cost, margin, budget, supplier, Bitrix, internal, claim or receipt key', () => {
    expect(typeChecks).toEqual([true, true, true, true]);
    expect(forbiddenKeyPaths(quotationView())).toEqual([]);
    expect(forbiddenKeyPaths(itineraryView())).toEqual([]);
  });

  it('finds a forbidden key at any depth', () => {
    const leaky = {
      ...quotationView(),
      tiers: [{ ...quotationView().tiers[0]!, costTotalPaise: '1', breakdown: [{ categoryKey: 'hotels', descriptions: [], amountPaise: null, supplierName: 'x' }] }],
      bitrixDealId: '5',
      internalNote: 'x',
    };
    expect(forbiddenKeyPaths(leaky).sort()).toEqual(['bitrixDealId', 'internalNote', 'tiers[0].breakdown[0].supplierName', 'tiers[0].costTotalPaise']);
    for (const k of ['marginPaise', 'purchaseBudgetPaise', 'remark', 'claims', 'receiptId', 'unitCostPaise', 'differencePaise']) {
      expect(forbiddenKeyPaths({ [k]: 1 })).toEqual([k]);
    }
  });
});

describe('money', () => {
  it('converts whole rupees exactly and refuses paise or bad values', () => {
    expect(paiseToRupees('24000000')).toEqual({ ok: true, rupees: 240000 });
    expect(paiseToRupees(100)).toEqual({ ok: true, rupees: 1 });
    expect(paiseToRupees(0n)).toEqual({ ok: true, rupees: 0 });
    expect(paiseToRupees('24000050')).toEqual({ ok: false, code: 'amount_has_paise' });
    expect(paiseToRupees(150)).toEqual({ ok: false, code: 'amount_has_paise' });
    for (const bad of ['-100', '1.5', '', 'abc', '0100', 1.5, Number.MAX_VALUE]) {
      expect(paiseToRupees(bad as string | number)).toEqual({ ok: false, code: 'amount_invalid' });
    }
    expect(paiseToRupees((BigInt(Number.MAX_SAFE_INTEGER) + 1n) * 100n)).toEqual({ ok: false, code: 'amount_invalid' });
  });

  it('prints a per-person price only when it divides exactly', () => {
    expect(exactPerPersonRupees(240000, 4)).toBe(60000);
    expect(exactPerPersonRupees(100000, 3)).toBeNull();
    expect(exactPerPersonRupees(100000, 0)).toBeNull();
  });

  it('spells totals in Indian format', () => {
    expect(rupeesInWords(270000)).toBe('Two Lakh Seventy Thousand Rupees');
    expect(rupeesInWords(12345678)).toBe('One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Rupees');
    expect(rupeesInWords(105)).toBe('One Hundred Five Rupees');
    expect(rupeesInWords(0)).toBe('Zero Rupees');
    expect(() => rupeesInWords(-1)).toThrow();
  });
});

describe('placeholders and customer text', () => {
  it('a placeholder is a whole bracketed label; customer text starting with "[" is neutralised', () => {
    expect(placeholder('Hotel name')).toBe('[Hotel name]');
    expect(isPlaceholder('[Hotel name]')).toBe(true);
    expect(isPlaceholder('[a] and [b]')).toBe(false);
    expect(neutraliseLeadingBracket('[Optional] cruise dinner')).toBe('(Optional) cruise dinner');
    expect(neutraliseLeadingBracket('[Sea view]')).toBe('(Sea view)');
    expect(isPlaceholder(neutraliseLeadingBracket('[Sea view]'))).toBe(false);
    expect(neutraliseLeadingBracket('  Sea [view] ')).toBe('Sea [view]');
  });

  it('the collector records every placeholder it writes', () => {
    const ph = new PlaceholderCollector();
    expect(ph.text(null, 'Customer name')).toBe('[Customer name]');
    expect(ph.text('  ', 'Customer phone')).toBe('[Customer phone]');
    expect(ph.text('[x] y', 'Ignored')).toBe('(x) y');
    expect(neutraliseLeadingBracket('[open')).toBe('(open');
    expect(ph.number(null, 'Rooms')).toBe('[Rooms]');
    expect(ph.labels).toEqual(['Customer name', 'Customer phone', 'Rooms']);
    expect(shortDate('2026-11-20')).toBe('20 Nov');
    expect(shortDate('20-11-2026')).toBeNull();
  });
});

describe('content safety', () => {
  it('finds internal-rate, sales-pressure, old-template and CRM words as whole phrases', () => {
    const hits = (t: string) => scanText(t).map((h) => `${h.kind}:${h.phrase}`);
    expect(hits('Our net rate for this hotel')).toEqual(['internal_rate:net rate']);
    expect(hits('Margin is fine')).toEqual(['internal_rate:margin']);
    expect(hits('Hurry, book immediately!')).toEqual(['sales_pressure:hurry', 'sales_pressure:book immediately']);
    expect(hits('Best price guaranteed lowest')).toEqual(['sales_pressure:best price', 'sales_pressure:guaranteed lowest']);
    expect(hits('Prepared by Trip Weavers')).toEqual(['old_template:trip weavers']);
    expect(hits('Synced from Bitrix')).toEqual(['crm_internal:bitrix']);
    expect(hits('Purchase budget ₹40,000')).toEqual(['crm_internal:purchase budget']);
    expect(hits('Amount 1234500 paise')).toEqual(['crm_internal:paise']);
    expect(hits('See deal BX-1234 for details')).toEqual(['crm_internal:bitrix_reference']);
    expect(hits('Internal only: check with supplier cost')).toEqual(['internal_rate:supplier cost', 'crm_internal:internal only']);
  });

  it('does not flag ordinary travel wording', () => {
    for (const ok of [
      'International flights and internal transfers',
      'A marginally longer drive along the coast',
      'Sea view room, breakfast included',
      'Our Bitrixian friends',
      'Netherlands',
    ]) {
      expect(scanText(ok), ok).toEqual([]);
    }
    // Whole words only: "profitable" is not "profit".
    expect(scanText('a profitable season for the farms')).toEqual([]);
  });

  it('finds raw GDS strings', () => {
    expect(scanText('BOMDXB HS1 0930').map((h) => h.phrase)).toEqual(['gds_status_code', 'gds_sector_pair']);
    expect(scanText('Status HK2').map((h) => h.phrase)).toEqual(['gds_status_code']);
  });

  it('reports paths for structured text and scans rendered page text', () => {
    expect(scanStrings({ days: [{ t: 'Arrive', d: 'Our markup is low' }], ok: 'fine' })).toEqual([
      { kind: 'internal_rate', phrase: 'markup', path: 'days[0].d' },
    ]);
    expect(htmlToText('<p>Net&nbsp;rate</p><style>.x{}</style>')).toBe('Net rate');
    expect(scanText(htmlToText('<p>Net&nbsp;rate</p>')).map((h) => h.phrase)).toEqual(['net rate']);
  });
});
