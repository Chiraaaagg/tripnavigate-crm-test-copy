import { describe, expect, it } from 'vitest';
import {
  CrmSearchError,
  decodeSearchAfter,
  encodeSearchAfter,
  mapCrmSearchError,
  parseCrmSearchReply,
  runCrmSearch,
} from '@/modules/search/server/crm-search';

/**
 * Batch 5 (contracts E): the crm_search wrapper. Parser fails closed, cursors
 * are opaque and checked, refusals map to the frozen SearchErrorCode states,
 * and the search words go only into the rpc arguments (never a log or error).
 */

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

function reply(over: Record<string, unknown> = {}) {
  return {
    kind: 'deal',
    titlesSearched: true,
    hits: [
      { kind: 'deal', id: ID1, reference: 'BX-610005' },
      { kind: 'deal', id: ID2, reference: 'SYN-DEL-001' },
    ],
    hasMore: true,
    next: { n: null, id: ID2 },
    ...over,
  };
}

type Call = { fn: string; args: Record<string, unknown> };
function fakeStaff(result: { data?: unknown; error?: { code?: string; message?: string; hint?: string | null } | null } | 'throw') {
  const calls: Call[] = [];
  const supabase = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      if (result === 'throw') return Promise.reject(new Error('network'));
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
    },
  };
  return { staff: { supabase } as never, calls };
}

describe('parseCrmSearchReply', () => {
  it('copies hits key by key and turns next into an opaque nextAfter', () => {
    const { page, titlesSearched } = parseCrmSearchReply('deal', { ...reply(), extra: 'ignored' });
    expect(titlesSearched).toBe(true);
    expect(page.hits).toEqual([
      { kind: 'deal', id: ID1, reference: 'BX-610005' },
      { kind: 'deal', id: ID2, reference: 'SYN-DEL-001' },
    ]);
    expect(typeof page.nextAfter).toBe('string');
    expect(page.nextAfter).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeSearchAfter('deal', page.nextAfter)).toEqual({ n: null, id: ID2 });
  });

  it('no more pages: nextAfter null even when the database sends a next', () => {
    expect(parseCrmSearchReply('deal', reply({ hasMore: false, next: null })).page.nextAfter).toBeNull();
    expect(parseCrmSearchReply('deal', reply({ hasMore: false })).page.nextAfter).toBeNull();
    expect(parseCrmSearchReply('lead', { kind: 'lead', titlesSearched: false, hits: [], hasMore: false, next: null }).page).toEqual({
      hits: [],
      nextAfter: null,
    });
  });

  it.each([
    ['another kind', reply({ kind: 'lead' })],
    ['a hit of another kind', reply({ hits: [{ kind: 'lead', id: ID1, reference: 'BXL-1' }] })],
    ['a bad id', reply({ hits: [{ kind: 'deal', id: 'x', reference: 'BX-1' }] })],
    ['an empty reference', reply({ hits: [{ kind: 'deal', id: ID1, reference: '' }] })],
    ['a duplicate id', reply({ hits: [{ kind: 'deal', id: ID1, reference: 'BX-1' }, { kind: 'deal', id: ID1, reference: 'BX-2' }] })],
    ['more than 50 hits', reply({ hits: Array.from({ length: 51 }, () => ({ kind: 'deal', id: ID1, reference: 'BX-1' })) })],
    ['hasMore without next', reply({ next: null })],
    ['a bad cursor number', reply({ next: { n: '0123', id: ID2 } })],
    ['a cursor with extra keys', reply({ next: { n: '1', id: ID2, x: 1 } })],
    ['no titlesSearched', reply({ titlesSearched: undefined })],
    ['null', null],
    ['a string', 'BX-1'],
  ])('fails closed on %s', (_label, data) => {
    expect(() => parseCrmSearchReply('deal', data)).toThrow(CrmSearchError);
  });

  it('a Lead page with more but no Bitrix number in the cursor is refused', () => {
    expect(() =>
      parseCrmSearchReply('lead', { kind: 'lead', titlesSearched: true, hits: [{ kind: 'lead', id: ID1, reference: 'BXL-5' }], hasMore: true, next: { n: null, id: ID1 } }),
    ).toThrow(CrmSearchError);
  });
});

describe('search cursors', () => {
  it('round-trips and rejects anything not issued here', () => {
    const lead = encodeSearchAfter({ n: '610001', id: ID1 });
    expect(decodeSearchAfter('lead', lead)).toEqual({ n: '610001', id: ID1 });
    expect(decodeSearchAfter('deal', lead)).toEqual({ n: '610001', id: ID1 });
    for (const empty of [undefined, null, '']) expect(decodeSearchAfter('deal', empty)).toBeNull();
    const bad: unknown[] = [
      42, {}, 'not base64!', 'x'.repeat(201),
      Buffer.from('not json').toString('base64url'),
      Buffer.from(JSON.stringify({ n: '1' })).toString('base64url'),
      Buffer.from(JSON.stringify({ n: 1, id: ID1 })).toString('base64url'),
      Buffer.from(JSON.stringify({ n: '1', id: ID1, q: 'Sharma' })).toString('base64url'),
      Buffer.from(JSON.stringify({ n: '1', id: 'nope' })).toString('base64url'),
    ];
    for (const raw of bad) expect(decodeSearchAfter('deal', raw)).toBe('invalid');
    // A Lead cursor always has a number.
    expect(decodeSearchAfter('lead', encodeSearchAfter({ n: null, id: ID1 }))).toBe('invalid');
  });
});

describe('mapCrmSearchError', () => {
  it.each([
    [{ code: 'PGRST202', message: 'Could not find the function' }, 'not_installed'],
    [{ code: '42883', message: 'function does not exist' }, 'not_installed'],
    [{ code: '42501', message: 'permission denied for function crm_search' }, 'not_authorized'],
    [{ code: '22023', message: 'invalid_input', hint: 'query' }, 'too_short'],
    [{ code: '22023', message: 'invalid_input', hint: 'after' }, 'unexpected'],
    [{ code: '22023', message: 'invalid_input', hint: 'kind' }, 'unexpected'],
    [{ code: 'PGRST301', message: 'JWT expired' }, 'unexpected'],
    [{ code: '57014', message: 'canceling statement due to statement timeout' }, 'unexpected'],
    [{}, 'unexpected'],
  ] as const)('%j -> %s', (error, code) => {
    expect(mapCrmSearchError(error)).toBe(code);
  });
});

describe('runCrmSearch', () => {
  it('normalises the words, calls crm_search once with the caller client and returns the page', async () => {
    const { staff, calls } = fakeStaff({ data: reply() });
    const out = await runCrmSearch(staff, 'deal', '  Sharma   family  ', undefined);
    expect(calls).toEqual([{ fn: 'crm_search', args: { p_query: 'Sharma family', p_kind: 'deal', p_after: null, p_limit: 20 } }]);
    expect(out).toMatchObject({ ok: true, query: 'Sharma family', titlesSearched: true });
    if (!out.ok) throw new Error('expected ok');
    expect(out.page.hits.map((h) => h.id)).toEqual([ID1, ID2]);
    // The next page sends the decoded cursor back.
    const second = fakeStaff({ data: reply({ hasMore: false, next: null }) });
    await runCrmSearch(second.staff, 'deal', 'Sharma family', out.page.nextAfter);
    expect(second.calls[0]!.args.p_after).toEqual({ n: null, id: ID2 });
  });

  it('too short and bad cursors never reach the database; the typed words are kept', async () => {
    for (const raw of ['', ' a ', null, 5, { q: 'x' }]) {
      const { staff, calls } = fakeStaff({ data: reply() });
      const out = await runCrmSearch(staff, 'lead', raw, null);
      expect(out).toMatchObject({ ok: false, code: 'too_short' });
      expect(calls).toHaveLength(0);
    }
    const { staff, calls } = fakeStaff({ data: reply() });
    expect(await runCrmSearch(staff, 'lead', 'Sharma', 'tampered!')).toEqual({ ok: false, query: 'Sharma', code: 'unexpected' });
    expect(calls).toHaveLength(0);
    // Cut to 60 characters before the call.
    const long = fakeStaff({ data: { kind: 'lead', titlesSearched: true, hits: [], hasMore: false, next: null } });
    const out = await runCrmSearch(long.staff, 'lead', 'x'.repeat(80), null);
    expect(out).toMatchObject({ ok: true, query: 'x'.repeat(60) });
    expect(long.calls[0]!.args.p_query).toBe('x'.repeat(60));
    // Characters, not UTF-16 units: an emoji at the cut is kept whole, never split.
    const emoji = fakeStaff({ data: { kind: 'lead', titlesSearched: true, hits: [], hasMore: false, next: null } });
    const raw = `${'y'.repeat(59)}\u{1F334}${'z'.repeat(10)}`;
    const cut = await runCrmSearch(emoji.staff, 'lead', raw, null);
    const sent = emoji.calls[0]!.args.p_query as string;
    expect(sent).toBe(`${'y'.repeat(59)}\u{1F334}`);
    expect(Array.from(sent)).toHaveLength(60);
    expect(sent.isWellFormed()).toBe(true);
    expect(cut).toMatchObject({ ok: true, query: sent });
    // One emoji plus one letter is 2 characters: long enough (though 3 UTF-16 units, it is not 3 characters).
    const two = fakeStaff({ data: { kind: 'lead', titlesSearched: false, hits: [], hasMore: false, next: null } });
    expect(await runCrmSearch(two.staff, 'lead', '\u{1F334}a', null)).toMatchObject({ ok: true });
    expect(two.calls).toHaveLength(1);
    // A single emoji is 1 character: too short, no call.
    const one = fakeStaff({ data: reply() });
    expect(await runCrmSearch(one.staff, 'lead', '\u{1F334}', null)).toMatchObject({ ok: false, code: 'too_short' });
    expect(one.calls).toHaveLength(0);
  });

  it('maps refusals and failures without throwing and without the words in any error', async () => {
    const cases: Array<[Parameters<typeof fakeStaff>[0], string]> = [
      [{ error: { code: 'PGRST202', message: 'missing' } }, 'not_installed'],
      [{ error: { code: '42501', message: 'permission denied' } }, 'not_authorized'],
      [{ error: { code: '22023', message: 'invalid_input', hint: 'query' } }, 'too_short'],
      [{ error: { code: 'XX000', message: 'boom' } }, 'unexpected'],
      [{ data: { wrong: true } }, 'unexpected'],
      ['throw', 'unexpected'],
    ];
    for (const [result, code] of cases) {
      const { staff } = fakeStaff(result);
      expect(await runCrmSearch(staff, 'deal', 'Sharma secret words', null)).toEqual({ ok: false, query: 'Sharma secret words', code });
    }
    expect(new CrmSearchError('unexpected', '22023').message).not.toMatch(/Sharma/);
  });
});

describe('titles are never searched by a phone number or e-mail (contracts E.4; Echo-A L1 and recheck)', () => {
  it('phone-like queries, plain or formatted, and anything with "@" never search titles', async () => {
    const { isPhoneLike, searchesTitles } = await import('@/modules/search/contracts');
    for (const q of ['9876543210', '987', '+91 98765-43210', '98765-43210', '98765 43210', '+91', '(0291) 2611', '0291.2611']) {
      expect(isPhoneLike(q), q).toBe(true);
      expect(searchesTitles(q), q).toBe(false);
    }
    for (const q of ['a@b', 'sharma@example.test', '@@@']) expect(searchesTitles(q), q).toBe(false);
    for (const q of ['Goa', 'Goa 2026', 'Trip 3', 'A-1 Travels']) expect(searchesTitles(q), q).toBe(true);
    for (const q of ['---', '( )', '+.+']) expect(isPhoneLike(q), q).toBe(false);
  });
});
