import { describe, expect, it } from 'vitest';
import {
  accountsQueue,
  FinanceCommandError,
  mapFinanceError,
  receiptRecord,
  type ReceiptFields,
} from '@/modules/finance/commands';
import { FINANCE_ERROR_STATES, type FinanceErrorCode, UNRESOLVED_CASH_KINDS } from '@/modules/finance/contracts';
import {
  AccountsQueueItemSchema,
  AccountsQueuePageSchema,
  CashOverviewSchema,
  FinanceCommandResultSchema,
  isAccountsQueueCursor,
  parseOrNull,
} from '@/modules/finance/dto';

/** Phase 5A RPC wrappers: exact token + SQLSTATE mapping (fail closed) and response validation. */

function client(response: { data?: unknown; error?: { code?: string; message?: string; details?: string } | null }, calls: unknown[] = []) {
  return {
    rpc(fn: string, args?: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve({ data: response.data ?? null, error: response.error ?? null });
    },
  };
}

const FIELDS: ReceiptFields = {
  mode: 'upi', amountPaise: '100', receivedOn: '2026-10-06', branchId: '11111111-2222-4333-8444-555555555555',
  collectorUserId: null, payerName: 'Synthetic', payerPan: null, payerMobile: '9876543210', reference: 'UPI123456',
  micrCode: null, chequeNumber: null, chequeDate: null, accountPayee: null, bookingVersionId: null, correctsReceiptId: null, note: null,
  destinationVersionId: 'dddddddd-2222-4333-8444-555555555555',
};

describe('mapFinanceError', () => {
  it('maps every contract token only with its own SQLSTATE', () => {
    for (const [token, state] of Object.entries(FINANCE_ERROR_STATES) as Array<[FinanceErrorCode, string]>) {
      expect(mapFinanceError({ code: state, message: token })).toBe(token);
      expect(mapFinanceError({ code: state === '55000' ? '22023' : '55000', message: token })).toBeNull();
    }
  });
  it('fails closed on anything else and recognises an ended session', () => {
    expect(mapFinanceError({ code: '42501', message: 'permission denied for function receipt_record' })).toBeNull();
    expect(mapFinanceError({ code: 'XX000', message: 'boom' })).toBeNull();
    expect(mapFinanceError({ code: 'PGRST301', message: 'JWT expired' })).toBe('session');
  });
});

describe('wrappers', () => {
  it('passes named arguments and validates the result', async () => {
    const calls: unknown[] = [];
    const result = await receiptRecord(
      client({ data: { outcome: 'created', id: '66666666-7777-4888-9999-aaaaaaaaaaaa', receiptNo: 'R-2026-27-000001', status: 'recorded' } }, calls),
      { dealId: 'd', fields: FIELDS, requestId: 'r' },
    );
    expect(result.receiptNo).toBe('R-2026-27-000001');
    expect(calls).toEqual([{ fn: 'receipt_record', args: { p_deal_id: 'd', p_fields: FIELDS, p_request_id: 'r' } }]);
  });

  it('carries the cash cap kind from DETAIL', async () => {
    const error = await receiptRecord(client({ error: { code: '55000', message: 'cash_cap_exceeded', details: 'trip' } }), {
      dealId: 'd', fields: FIELDS, requestId: 'r',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FinanceCommandError);
    expect(error).toMatchObject({ code: 'cash_cap_exceeded', capKind: 'trip', sqlState: '55000' });
    expect(String((error as Error).message)).not.toContain('trip');
  });

  it('fails closed on an unexpected response shape', async () => {
    const error = await accountsQueue(client({ data: [{ dealId: 'x' }] }), 'all').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: null });
    const thrown = await accountsQueue({ rpc: () => Promise.reject(new Error('network')) }, 'all').catch((e: unknown) => e);
    expect(thrown).toMatchObject({ code: null });
  });
});

describe('dto', () => {
  it('rejects a JS number amount and accepts digit strings', () => {
    const item = {
      dealId: '66666666-7777-4888-9999-aaaaaaaaaaaa', dealReference: 'SYN-DEL-001', dealTitle: 't', branchName: 'Delhi',
      hasConfirmedBooking: true, billingStatus: null, reviewStatus: 'pending',
      money: { availablePaise: '0', awaitingVerificationPaise: '100', chequesAwaitingClearancePaise: '0' },
      updatedAt: '2026-10-06T10:00:00+00:00',
    };
    expect(parseOrNull(AccountsQueueItemSchema, item)).not.toBeNull();
    expect(parseOrNull(AccountsQueueItemSchema, { ...item, money: { ...item.money, availablePaise: 0 } })).toBeNull();
    expect(parseOrNull(FinanceCommandResultSchema, { outcome: 'replayed', id: item.dealId })).toBeNull();
  });
});

const ITEM = {
  dealId: '66666666-7777-4888-9999-aaaaaaaaaaaa', dealReference: 'SYN-DEL-001', dealTitle: 't', branchName: 'Delhi',
  hasConfirmedBooking: true, billingStatus: null, reviewStatus: 'pending',
  money: { availablePaise: '0', awaitingVerificationPaise: '100', chequesAwaitingClearancePaise: '0' },
  updatedAt: '2026-10-06T10:00:00+00:00',
};
const CURSOR = `${ITEM.dealId}:${ITEM.dealReference}`;

describe('accounts queue pages (milestone A section 3)', () => {
  it('passes the filter, cursor and optional limit and validates the page', async () => {
    const calls: unknown[] = [];
    const page = { items: [ITEM], hasMore: true, nextAfter: CURSOR, totalCount: 7 };
    expect(await accountsQueue(client({ data: page }, calls), 'all')).toEqual(page);
    await accountsQueue(client({ data: page }, calls), 'returned', CURSOR, 10);
    expect(calls).toEqual([
      { fn: 'accounts_queue', args: { p_filter: 'all', p_after: null } },
      { fn: 'accounts_queue', args: { p_filter: 'returned', p_after: CURSOR, p_limit: 10 } },
    ]);
  });

  it('refuses a page that could pass for the whole queue when it is not', () => {
    const ok = { items: [ITEM], hasMore: false, nextAfter: null, totalCount: 1 };
    expect(parseOrNull(AccountsQueuePageSchema, ok)).not.toBeNull();
    expect(parseOrNull(AccountsQueuePageSchema, { items: [], hasMore: false, nextAfter: null, totalCount: 3 })).not.toBeNull();
    expect(parseOrNull(AccountsQueuePageSchema, { ...ok, hasMore: true })).toBeNull(); // more pages but no cursor
    expect(parseOrNull(AccountsQueuePageSchema, { ...ok, nextAfter: CURSOR })).toBeNull(); // cursor but no more pages
    expect(parseOrNull(AccountsQueuePageSchema, { ...ok, totalCount: 0 })).toBeNull(); // total smaller than the page
    expect(parseOrNull(AccountsQueuePageSchema, { ...ok, totalCount: undefined })).toBeNull();
    expect(parseOrNull(AccountsQueuePageSchema, [ITEM])).toBeNull(); // the old bare-array shape
  });

  it('recognises only well-formed cursors', () => {
    expect(isAccountsQueueCursor(CURSOR)).toBe(true);
    expect(isAccountsQueueCursor(`${ITEM.dealId}:A:B with spaces`)).toBe(true);
    for (const bad of [null, undefined, 1, '', ITEM.dealId, `${ITEM.dealId}:`, `${ITEM.dealId.toUpperCase()}:X`, `${ITEM.dealId}:a\nb`, `x:${ITEM.dealReference}`]) {
      expect(isAccountsQueueCursor(bad), String(bad)).toBe(false);
    }
  });
});

describe('cash overview unresolved totals (milestone A section 2)', () => {
  const zero = Object.fromEntries(UNRESOLVED_CASH_KINDS.map((k) => [k, 0]));
  const policy = {
    versionNo: 1, effectiveAt: '2026-10-01T00:00:00+00:00', receiptMaxPaise: '1000000000', cashPayerDayCapPaise: '4999900',
    cashTripCapPaise: '4999900', cashDepositDays: 1, reconciliationRequired: true, reason: 'Initial', createdByName: null,
    createdAt: '2026-10-01T00:00:00+00:00',
  };
  const missing = (date: string) => ({ kind: 'reconciliation_missing', receiptId: null, receiptNo: null, businessDate: date, amountPaise: null });
  const overview = (branch: Record<string, unknown>) => ({
    legalEntityId: ITEM.dealId,
    policy,
    branches: [{
      branchId: ITEM.dealId, branchName: 'Jodhpur', cashInHandPaise: '0', recordedUnverifiedCashPaise: '0', undepositedVerified: [],
      unresolved: [], unresolvedTotals: zero, oldestUnresolvedDate: {}, unresolvedTruncated: false, deposits: [], reconciliations: [],
      ...branch,
    }],
  });
  const days = (n: number) => Array.from({ length: n }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`);

  it('accepts a clear branch, an awaiting-verification item and a truncated list with full totals', () => {
    expect(parseOrNull(CashOverviewSchema, overview({}))).not.toBeNull();
    expect(parseOrNull(CashOverviewSchema, overview({
      unresolved: [{ ...missing('2026-10-05'), kind: 'reconciliation_awaiting_verification' }],
      unresolvedTotals: { ...zero, reconciliation_awaiting_verification: 1 },
      oldestUnresolvedDate: { reconciliation_awaiting_verification: '2026-10-05' },
    }))).not.toBeNull();
    // 50 listed of 72: truncated, the oldest date still reported.
    const listed = [...days(31), ...days(19).map((d) => d.replace('-08-', '-09-'))].map(missing);
    expect(listed).toHaveLength(50);
    expect(parseOrNull(CashOverviewSchema, overview({
      unresolved: listed, unresolvedTotals: { ...zero, reconciliation_missing: 72 },
      oldestUnresolvedDate: { reconciliation_missing: '2026-08-01' }, unresolvedTruncated: true,
    }))).not.toBeNull();
  });

  it('fails closed when totals, oldest dates or the truncated flag disagree with the list', () => {
    const one = { unresolved: [missing('2026-10-05')], unresolvedTotals: { ...zero, reconciliation_missing: 1 }, oldestUnresolvedDate: { reconciliation_missing: '2026-10-05' } };
    expect(parseOrNull(CashOverviewSchema, overview(one))).not.toBeNull();
    // A listed item with a zero total would let the branch look clear.
    expect(parseOrNull(CashOverviewSchema, overview({ ...one, unresolvedTotals: zero }))).toBeNull();
    // A total with no listed item hides work.
    expect(parseOrNull(CashOverviewSchema, overview({ ...one, unresolved: [] }))).toBeNull();
    expect(parseOrNull(CashOverviewSchema, overview({ ...one, oldestUnresolvedDate: {} }))).toBeNull();
    expect(parseOrNull(CashOverviewSchema, overview({ ...one, unresolvedTruncated: true }))).toBeNull();
    expect(parseOrNull(CashOverviewSchema, overview({ ...one, unresolvedTotals: { ...zero, reconciliation_missing: 51 } }))).toBeNull();
    const missingKind = Object.fromEntries(Object.entries(zero).filter(([k]) => k !== 'reconciliation_stale'));
    expect(parseOrNull(CashOverviewSchema, overview({ unresolvedTotals: missingKind }))).toBeNull();
    expect(parseOrNull(CashOverviewSchema, overview({ oldestUnresolvedDate: { someday: '2026-10-05' } }))).toBeNull();
    expect(parseOrNull(CashOverviewSchema, overview({ unresolved: [{ ...missing('2026-10-05'), kind: 'reconciliation_unknown' }] }))).toBeNull();
  });
});
