import { describe, expect, it, vi } from 'vitest';
import { CONFLICT_SQLSTATE_NEW, CONFLICT_SQLSTATE_OLD, CONFLICT_STATES } from '@/lib/sqlstate';
import type { RpcError } from '@/modules/fulfilment/commands';
import { ACCOUNTS_DESK_ERROR_STATES } from '@/modules/accounts-desk/contracts';
import { mapAccountsDeskError } from '@/modules/accounts-desk/commands';
import { CHANGE_ERROR_STATES } from '@/modules/booking-changes/contracts';
import { mapChangeError } from '@/modules/booking-changes/commands';
import { CANCELLATION_ERROR_STATES } from '@/modules/cancellations/contracts';
import { mapCancellationError } from '@/modules/cancellations/commands';
import { DOCUMENT_ERROR_STATES } from '@/modules/customer-documents/contracts';
import { mapDocumentError } from '@/modules/customer-documents/commands';
import { MESSAGE_ERROR_STATES } from '@/modules/customer-messages/contracts';
import { mapMessageError } from '@/modules/customer-messages/commands';
import { customerRenderClaim, customerRenderComplete, customerRenderInput } from '@/modules/documents/render/customer-job-input';
import { FINANCE_ERROR_STATES } from '@/modules/finance/contracts';
import { mapFinanceError } from '@/modules/finance/commands';
import { FLIGHT_ERROR_STATES } from '@/modules/flight/contracts';
import { mapFlightError } from '@/modules/flight/commands';
import { FLIGHT_MONEY_ERROR_STATES } from '@/modules/flight/money-contracts';
import { mapFlightMoneyError } from '@/modules/flight/money-commands';
import { SYNC_SETTINGS_ERROR_STATES, mapSyncSettingsError } from '@/modules/integration/sync-settings-preview';
import { ITINERARY_ERROR_STATES } from '@/modules/itineraries/contracts';
import { mapItineraryError } from '@/modules/itineraries/commands';
import { RenderWorkerError, itineraryRenderClaimForWorker, itineraryRenderInputForWorker } from '@/modules/itineraries/server/render-worker';
import { VN_ERROR_STATES, mapVnError } from '@/modules/parties/server/parties-db';
import { mapBookingChangeError } from '@/modules/procurement/booking-change';
import { PROCUREMENT_ERROR_STATES, mapProcurementError } from '@/modules/procurement/commands';
import { QUOTATION_ERROR_STATES } from '@/modules/quotations/contracts';
import { mapQuotationError } from '@/modules/quotations/commands';
import { REFERRAL_ERROR_STATES, mapReferralError } from '@/modules/quotations/referral';
import { RATE_ERROR_STATES } from '@/modules/rate-contracts/contracts';
import { mapRateError } from '@/modules/rate-contracts/commands';
import { REFUND_ERROR_STATES } from '@/modules/refunds/contracts';
import { mapRefundError } from '@/modules/refunds/commands';
import { SUPPLIER_MONEY_ERROR_STATES } from '@/modules/supplier-money/contracts';
import { mapSupplierMoneyError } from '@/modules/supplier-money/commands';
import { SUPPLIER_ERROR_STATES } from '@/modules/suppliers/contracts';
import { mapSupplierError } from '@/modules/suppliers/commands';
import { VISA_ERROR_STATES } from '@/modules/visa/contracts';
import { mapVisaError } from '@/modules/visa/commands';
import { WRITE_OFF_ERROR_STATES } from '@/modules/write-offs/contracts';
import { mapWriteOffError } from '@/modules/write-offs/commands';

/**
 * Booking reliability B1-1: every module mapper accepts a conflict refusal
 * with 40001 (the database before the migrations, or after a rollback) or
 * PT409 (after them), only with its exact token. A conflict code without its
 * token maps to nothing, as before.
 */

const BOTH = [CONFLICT_SQLSTATE_OLD, CONFLICT_SQLSTATE_NEW] as const;
type Table = Readonly<Record<string, string | readonly string[]>>;
type Mapper = (error: RpcError) => string | null;

const MAPPERS: Array<[string, Table, Mapper]> = [
  ['accounts-desk', ACCOUNTS_DESK_ERROR_STATES, mapAccountsDeskError],
  ['booking-changes', CHANGE_ERROR_STATES, mapChangeError],
  ['cancellations', CANCELLATION_ERROR_STATES, mapCancellationError],
  ['customer-documents', DOCUMENT_ERROR_STATES, mapDocumentError],
  ['customer-messages', MESSAGE_ERROR_STATES, mapMessageError],
  ['finance', FINANCE_ERROR_STATES, mapFinanceError],
  ['flight', FLIGHT_ERROR_STATES, mapFlightError],
  ['flight money', FLIGHT_MONEY_ERROR_STATES, mapFlightMoneyError],
  ['integration sync settings', SYNC_SETTINGS_ERROR_STATES, (e) => mapSyncSettingsError('fn', e).code],
  ['itineraries', ITINERARY_ERROR_STATES, mapItineraryError],
  ['parties (voice notes)', VN_ERROR_STATES, (e) => mapVnError(e).code],
  ['procurement', PROCUREMENT_ERROR_STATES, mapProcurementError],
  ['quotations', QUOTATION_ERROR_STATES, mapQuotationError],
  ['quotation referral', REFERRAL_ERROR_STATES, mapReferralError],
  ['rate contracts', RATE_ERROR_STATES, mapRateError],
  ['refunds', REFUND_ERROR_STATES, mapRefundError],
  ['supplier money', SUPPLIER_MONEY_ERROR_STATES, mapSupplierMoneyError],
  ['suppliers', SUPPLIER_ERROR_STATES, mapSupplierError],
  ['visa', VISA_ERROR_STATES, mapVisaError],
  ['write-offs', WRITE_OFF_ERROR_STATES, mapWriteOffError],
];

const conflictTokens = (table: Table) => Object.entries(table).filter(([, s]) => typeof s !== 'string').map(([t]) => t);

describe('conflict token tables (B1-1)', () => {
  it.each(MAPPERS)('%s: every conflict entry allows exactly 40001 and PT409, and no entry is a bare 40001', (_name, table) => {
    const tokens = conflictTokens(table);
    expect(tokens.length).toBeGreaterThan(0);
    for (const [token, allowed] of Object.entries(table)) {
      if (typeof allowed === 'string') {
        expect(allowed, token).not.toBe(CONFLICT_SQLSTATE_OLD);
        expect(allowed, token).not.toBe(CONFLICT_SQLSTATE_NEW);
      } else {
        expect(allowed, token).toEqual(CONFLICT_STATES);
      }
    }
  });

  it.each(MAPPERS)('%s: each conflict token maps with either code', (_name, table, map) => {
    for (const token of conflictTokens(table)) {
      for (const code of BOTH) expect(map({ code, message: token }), `${token} / ${code}`).toBe(token);
      // Surrounding whitespace in the message is tolerated, as before.
      expect(map({ code: CONFLICT_SQLSTATE_NEW, message: ` ${token} ` })).toBe(token);
    }
  });

  it.each(MAPPERS)('%s: a conflict code without its exact token is not guessed (fail closed)', (name, table, map) => {
    const expected = name === 'customer-messages' ? 'version_changed' : null; // code-alone site, see below
    for (const code of BOTH) {
      expect(map({ code, message: 'could not serialize access due to concurrent update' })).toBe(expected);
      expect(map({ code, message: '' })).toBe(expected);
      // A non-conflict token with a conflict code does not map to that token.
      const other = Object.entries(table).find(([, s]) => s === '55000' || s === '22023')?.[0];
      if (other) expect(map({ code, message: other })).not.toBe(other);
    }
  });

  it.each(MAPPERS)('%s: other codes are unchanged (PT409 is never confused with 23505 or 55000)', (_name, table, map) => {
    for (const token of conflictTokens(table)) {
      expect(map({ code: '23505', message: token })).not.toBe(token);
      expect(map({ code: '55000', message: token })).not.toBe(token);
    }
  });
});

describe('alias and code-alone sites (B1-1)', () => {
  it.each(BOTH)('a replayed request conflict becomes duplicate_request in the desks (%s)', (code) => {
    expect(mapSupplierMoneyError({ code, message: 'request_conflict' })).toBe('duplicate_request');
    expect(mapFlightError({ code, message: 'request_conflict' })).toBe('duplicate_request');
    expect(mapFlightMoneyError({ code, message: 'request_conflict' })).toBe('duplicate_request');
    expect(mapVisaError({ code, message: 'request_conflict' })).toBe('duplicate_request');
    expect(mapCancellationError({ code, message: 'duplicate_request' })).toBe('duplicate_request');
    expect(mapRefundError({ code, message: 'duplicate_request' })).toBe('request_conflict');
  });

  it.each(BOTH)('the Purchase booking-change mapper accepts %s for its two tokens', (code) => {
    expect(mapBookingChangeError({ code, message: 'version_changed' })).toBe('version_changed');
    expect(mapBookingChangeError({ code, message: 'request_conflict' })).toBe('duplicate_request');
    expect(mapBookingChangeError({ code, message: 'other' })).toBeNull();
  });

  it.each(BOTH)('customer messages: a conflict code alone still reads as version_changed (%s)', (code) => {
    expect(mapMessageError({ code, message: 'version_changed' })).toBe('version_changed');
    expect(mapMessageError({ code })).toBe('version_changed');
  });

  it.each(BOTH)('sync settings: preview_stale keeps its reason with %s', (code) => {
    const e = mapSyncSettingsError('integration_sync_settings_apply', { code, message: 'preview_stale', hint: 'counts_changed' });
    expect(e.code).toBe('preview_stale');
    expect(e.detail).toBe('counts_changed');
    expect(e.sqlState).toBe(code);
    expect(mapSyncSettingsError('fn', { code, message: 'other' }).code).toBeNull();
  });
});

describe('render workers treat PT409 + task_conflict as "someone else has the job" (B1-1)', () => {
  const JOB = '00000000-0000-4000-8000-0000000000a1';
  const rpcClient = (error: RpcError | null, data: unknown = null) => ({ rpc: vi.fn().mockResolvedValue({ data, error }) });

  it.each(BOTH)('itinerary worker: input read answers conflict for %s', async (code) => {
    await expect(itineraryRenderInputForWorker({ jobId: JOB, worker: 'w1' }, rpcClient({ code, message: 'task_conflict' }))).resolves.toEqual({ status: 'conflict' });
  });

  it.each(BOTH)('itinerary worker: a claim conflict throws a conflict error for %s', async (code) => {
    const err = await itineraryRenderClaimForWorker({ worker: 'w1', leaseSeconds: 120 }, rpcClient({ code, message: 'task_conflict' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RenderWorkerError);
    expect((err as RenderWorkerError).sqlState).toBe(CONFLICT_SQLSTATE_NEW);
  });

  it('itinerary worker: a conflict code with another token is not a conflict', async () => {
    const err = await itineraryRenderInputForWorker({ jobId: JOB, worker: 'w1' }, rpcClient({ code: CONFLICT_SQLSTATE_NEW, message: 'version_changed' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RenderWorkerError);
  });

  it.each(BOTH)('customer document worker: input read answers conflict for %s; claim and complete throw', async (code) => {
    const c = rpcClient({ code, message: 'task_conflict' });
    await expect(customerRenderInput(c as never, JOB, 'worker-1')).resolves.toEqual({ status: 'conflict' });
    await expect(customerRenderClaim(c as never, 'worker-1', 120)).rejects.toMatchObject({ sqlState: CONFLICT_SQLSTATE_NEW });
    await expect(customerRenderComplete(c as never, JOB, 'worker-1', { ok: false, errorCode: 'render_failed' })).rejects.toMatchObject({ sqlState: CONFLICT_SQLSTATE_NEW });
  });

  it('customer document worker: a conflict code with another token throws with that code', async () => {
    await expect(customerRenderInput(rpcClient({ code: CONFLICT_SQLSTATE_NEW, message: 'document_stale' }) as never, JOB, 'worker-1')).rejects.toMatchObject({
      sqlState: CONFLICT_SQLSTATE_NEW,
    });
  });
});
