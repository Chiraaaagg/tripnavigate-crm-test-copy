import { describe, expect, it } from 'vitest';
import { parseRateContractQuery } from '@/views/rate-contracts/format';
import { filterHref, rateContractChips, rateContractHref, rateContractSearchKeep, supplierSearchKeep, supplierStateChips } from '@/views/suppliers/queue';

/**
 * UX redesign R3 (DM-20, DM-22, DM-23): the suppliers register and the rate
 * contracts list in the queue pattern. Chips and the search build only the
 * address values the pages already read, so every old address still gives
 * the same rows and every chip is an address that worked before.
 */

const S = '/app/purchase/suppliers';
const R = '/app/purchase/rate-contracts';

describe('suppliers register chips', () => {
  it('each chip is one of the existing filter addresses', () => {
    const chips = supplierStateChips(S, {});
    expect(chips.map((c) => [c.label, c.href])).toEqual([
      ['All suppliers', S],
      ['Not verified', `${S}?verification=unverified`],
      ['Payments on hold', `${S}?bankState=on_hold`],
      ['No bank details', `${S}?bankState=none`],
      ['Archived', `${S}?status=archived`],
    ]);
    expect(chips.filter((c) => c.current).map((c) => c.label)).toEqual(['All suppliers']);
  });
  it('the Manager approvals link (?bankState=on_hold) marks "Payments on hold"', () => {
    expect(supplierStateChips(S, { bankState: 'on_hold' }).filter((c) => c.current).map((c) => c.label)).toEqual(['Payments on hold']);
  });
  it('a combination from "More filters" marks no chip; chips keep the search, kind, city and hotel', () => {
    const chips = supplierStateChips(S, { verification: 'unverified', status: 'active', q: 'Sam', kind: 'channel', city: 'Jaisalmer' });
    expect(chips.some((c) => c.current)).toBe(false);
    expect(chips[2]!.href).toBe(`${S}?q=Sam&kind=channel&city=Jaisalmer&bankState=on_hold`);
  });
  it('a search keeps every filter but its own words, and never the page cursor', () => {
    expect(supplierSearchKeep({ q: 'Sam', bankState: 'on_hold', hotelId: 'h1' })).toEqual({ bankState: 'on_hold', hotelId: 'h1' });
    expect(filterHref(S, { q: 'Sam' }, undefined, 'cursor')).toBe(`${S}?q=Sam&after=cursor`);
  });
});

describe('rate contracts chips', () => {
  it('presets and statuses are the same addresses the old tabs and status select made', () => {
    const chips = rateContractChips(R, {}, { manager: true, counts: { toApprove: 1, endingSoon: 2 } });
    expect(chips.map((c) => [c.label, c.href, c.count])).toEqual([
      ['All contracts', R, undefined],
      ['To approve', `${R}?preset=to_approve`, 1],
      ['Ending soon', `${R}?preset=ending_soon`, 2],
      ['Draft', `${R}?status=draft`, undefined],
      ['Waiting for Manager approval', `${R}?status=pending_approval`, undefined],
      ['Returned for changes', `${R}?status=returned`, undefined],
      ['Active', `${R}?status=active`, undefined],
      ['Ended', `${R}?status=ended`, undefined],
    ]);
  });
  it('"To approve" is for Managers only', () => {
    expect(rateContractChips(R, {}, { manager: false }).map((c) => c.label)).not.toContain('To approve');
  });
  it('every chip address reads back to the filter it stands for', () => {
    for (const c of rateContractChips(R, { q: 'lake' }, { manager: true })) {
      const params = Object.fromEntries(new URL(c.href, 'http://x').searchParams);
      const { filter } = parseRateContractQuery(params);
      expect(filter.q).toBe('lake');
    }
    expect(parseRateContractQuery({ status: 'draft' }).filter.status).toEqual(['draft']);
  });
  it('current chip follows the address; a multi-status address marks none', () => {
    expect(rateContractChips(R, { preset: 'ending_soon' }, { manager: false }).filter((c) => c.current).map((c) => c.label)).toEqual(['Ending soon']);
    expect(rateContractChips(R, { status: ['active'] }, { manager: false }).filter((c) => c.current).map((c) => c.label)).toEqual(['Active']);
    expect(rateContractChips(R, { status: ['draft', 'returned'] }, { manager: false }).some((c) => c.current)).toBe(false);
  });
  it('a search keeps the preset, statuses, supplier and hotel; the old address format is kept', () => {
    expect(rateContractSearchKeep({ q: 'x', preset: 'to_approve', status: ['draft', 'returned'], supplierId: 's1' })).toEqual({ preset: 'to_approve', status: 'draft,returned', supplierId: 's1' });
    expect(rateContractHref(R, { status: ['draft', 'returned'] }, undefined, 'c1')).toBe(`${R}?status=draft%2Creturned&after=c1`);
  });
});
