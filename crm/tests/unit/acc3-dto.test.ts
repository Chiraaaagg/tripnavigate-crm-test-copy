import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
// ASSUMPTION: export names — zod DTOs of the new reads (contract 5.10, 5.6, 6.6, 8.3, 9.5, 10.5).
import { DealCustomerMessagesSchema, TaskCustomerMessageStatusSchema } from '@/modules/customer-messages/dto';
import { SmallBalancesPageSchema, WriteOffMonthlySchema } from '@/modules/write-offs/dto';
import { PushDevicesSchema } from '@/modules/notices/dto';
import { RateContractLookupSchema } from '@/modules/rate-contracts/dto';
import { DealChangeRequestsSchema, TaskReconfirmationSchema } from '@/modules/booking-changes/dto';

/**
 * Accounts phase 3, Track T (contract 16.2): zod DTOs of every new read keep
 * their fence. A sample built from the contract's key list parses; the same
 * sample with forbidden keys added either is refused or comes back without
 * them (every key is listed, Phase 2 rule). Synthetic values only.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-11-13T06:00:00.000Z';

function deepKeys(value: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => deepKeys(v, acc));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { acc.add(k); deepKeys(v, acc); }
  return acc;
}
/** Adds `extra` keys to the root object and to every nested object. */
function poison(value: unknown, extra: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((v) => poison(v, extra));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = { ...extra };
    for (const [k, v] of Object.entries(value)) out[k] = poison(v, extra);
    return out;
  }
  return value;
}
function expectFenced(schema: ZodType, sample: unknown, forbidden: Record<string, unknown>, label: string) {
  const good = schema.safeParse(sample);
  expect(good.success, `${label} contract sample: ${good.success ? '' : JSON.stringify(good.error.issues.slice(0, 3))}`).toBe(true);
  const bad = schema.safeParse(poison(sample, forbidden));
  if (bad.success) {
    const keys = deepKeys(bad.data);
    for (const k of Object.keys(forbidden)) expect(keys.has(k), `${label} keeps ${k}`).toBe(false);
  }
}

const MONEY_AND_CONTACT = {
  params: { amountPaise: '9123457' }, amountPaise: '9123457', balancePaise: '9123457', to: 'pooja@example.test', mobile: '6000043210',
  email: 'pooja@example.test', whatsappMobile: '6000043210', messageText: 'Sentinel text',
};
const SELLING = { sellingPaise: '9123457', sellingTotalPaise: '9123457', marginPaise: '100', totalPaise: '9123457', duesPaise: '1', receiptsPaise: '1' };
const DEVICE_SECRETS = { endpoint: 'https://push.example.test/abc', p256dh: 'BKsynthetic', authKey: 'synthetic-auth', auth_key: 'x' };

describe('R-A1 / R-A3 customer messages', () => {
  it('messages card: masked contact, no params, amounts or addresses', () => {
    const sample = {
      dealId: ID,
      prefs: { language: 'hi', whatsappMasked: '98xxxxxx12', emailMasked: 'p***@example.test', whatsappOff: false, emailOff: false, optedOut: false, rowVersion: 1 },
      contactConfirmed: true,
      messages: [{ id: ID, type: 'payment_received', channel: 'whatsapp', language: 'hi', status: 'failed', skipReason: null, createdAt: AT, sentAt: null,
        deliveredAt: null, readAt: null, failedAt: AT, errorCode: 'provider_error', toMasked: '98xxxxxx12', attachmentKind: null, resendOf: null,
        can: { resend: true } }],
      can: { editPrefs: true, restartWhatsapp: false },
    };
    expectFenced(DealCustomerMessagesSchema as ZodType, sample, MONEY_AND_CONTACT, 'deal_customer_messages');
  });
  it('task send state: states only (not_sent | waiting | sent | failed | off)', () => {
    const sample = { taskId: ID, items: [{ evidenceId: ID, messageType: 'hotel_voucher', email: { state: 'sent' }, whatsapp: { state: 'off' } }] };
    // `email` / `whatsapp` are the contract's per-channel send states ({state}), so those two key names are allowed here;
    // every other contact or money key is still poisoned, and no string address may survive under any key.
    const { email: _email, ...contactWithoutEmailKey } = MONEY_AND_CONTACT;
    void _email;
    expectFenced(TaskCustomerMessageStatusSchema as ZodType, sample, { ...contactWithoutEmailKey, ...SELLING, status: 'delivered', toMasked: '98xxxxxx12',
      address: 'pooja@example.test', phone: '6000043210' }, 'task_customer_message_status');
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(strings)
      : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : typeof v === 'string' ? [v] : []);
    const poisoned = TaskCustomerMessageStatusSchema.safeParse(poison(sample, { address: 'pooja@example.test', phone: '6000043210', to: '6000043210' }));
    if (poisoned.success) for (const t of strings(poisoned.data)) expect(t, 'no address survives').not.toMatch(/@|^[6-9][0-9]{9}$/);
    // A channel value that is an address instead of a state is refused.
    expect(TaskCustomerMessageStatusSchema.safeParse({ ...sample, items: [{ ...sample.items[0], email: 'pooja@example.test' }] }).success).toBe(false);
    expect(TaskCustomerMessageStatusSchema.safeParse({ ...sample, items: [{ ...sample.items[0], whatsapp: { state: 'sent', to: '6000043210' } }] }).success
      && JSON.stringify(TaskCustomerMessageStatusSchema.parse({ ...sample, items: [{ ...sample.items[0], whatsapp: { state: 'sent', to: '6000043210' } }] }))
        .includes('6000043210')).toBe(false);
    const wrong = TaskCustomerMessageStatusSchema.safeParse({ ...sample, items: [{ ...sample.items[0], email: { state: 'delivered' } }] });
    expect(wrong.success, 'only the five LD9 states').toBe(false);
  });
});

describe('R-B1 / R-B2 small balances and monthly totals', () => {
  it('small balances row has no customer contact or receipts', () => {
    const sample = {
      items: [{ dealId: ID, dealReference: 'SYN-DEL-001', branchName: 'Delhi', tripEnd: '2026-11-01', direction: 'due', balancePaise: '300', limitPaise: '500000',
        writeOff: { id: ID, refNo: 'WO-2026-000001', status: 'proposed', amountPaise: '300', reason: 'Synthetic small balance reason', proposedByName: 'Accounts',
          rowVersion: 1 }, blockedBy: [], can: { propose: false, approve: true, return: true, withdraw: false, undo: false } }],
      nextAfter: null,
    };
    expectFenced(SmallBalancesPageSchema as ZodType, sample, { mobile: '6000043210', email: 'pooja@example.test', pan: 'ABCDE1234F', receipts: [] },
      'small_balances_list');
  });
  it('monthly totals are per branch counts and sums only', () => {
    const sample = { month: '2026-11-01', branches: [{ branchName: 'Delhi', count: 2, duePaise: '300', excessPaise: '120' }] };
    expectFenced(WriteOffMonthlySchema as ZodType, sample, { dealReference: 'SYN-DEL-001', deals: [], reason: 'x' }, 'write_off_monthly');
  });
});

describe('D3 push devices', () => {
  it('never the endpoint or keys', () => {
    const sample = { enabled: true, devices: [{ deviceId: ID, label: 'Chrome on Windows', createdAt: AT, lastUsedAt: null, thisDevice: true }] };
    expectFenced(PushDevicesSchema as ZodType, sample, DEVICE_SECRETS, 'push_devices_list');
  });
});

describe('R-E3 / R-G1 / R-G3 Purchase-facing reads carry no selling data', () => {
  it('rate contract lookup: supplier cost only', () => {
    const sample = { state: 'ok', contractIds: [ID], nights: [{ date: '2026-11-13', ratePaise: '650000', lineId: ID, weekend: true }],
      perRoomTotalPaise: '650000', totalPaise: '1300000', endedOn: null, roomTypes: [{ id: ID, name: 'Deluxe' }] };
    expectFenced(RateContractLookupSchema as ZodType, sample, { sellingPaise: '9123457', marginPaise: '1', duesPaise: '1', customerName: 'x' },
      'rate_contract_lookup');
  });
  it('reconfirmation: old and new side by side, never a selling price', () => {
    const sample = {
      taskId: ID, changeRequest: { refNo: 'CR-2026-000001', status: 'submitted' },
      old: { details: { checkIn: '2026-12-01', checkOut: '2026-12-04', rooms: 1 }, ratePaise: '1000000', reference: 'SYN-CONF-0001', confirmedAt: AT },
      new: { details: { checkIn: '2026-12-02', checkOut: '2026-12-05', rooms: 1 }, changedFields: ['checkIn', 'checkOut'] },
      reconfirmation: { id: ID, status: 'pending', newRatePaise: null, supplierFeePaise: null, newReference: null, evidenceId: null, overBudget: false,
        budgetPaise: '2000000', rowVersion: 1 },
      can: { record: true, refuse: true, approveOverBudget: false },
    };
    expectFenced(TaskReconfirmationSchema as ZodType, sample, SELLING, 'task_reconfirmation_get');
  });
  it('deal change requests: costs and rates never in it', () => {
    const sample = {
      dealId: ID, enabled: true, canRequest: false, blockedBy: ['change_open'],
      confirmed: [{ itemId: ID, itemNo: 1, serviceTitle: 'Hotel', department: 'purchase', taskStatus: 'supplier_confirmed', supplierName: null, reference: null }],
      requests: [{ id: ID, refNo: 'CR-2026-000001', kind: 'change', status: 'submitted', itemNos: [1], changeSummary: 'Synthetic summary of the change',
        reason: 'Synthetic reason for the change', requestedByName: 'Sales', requestedAt: AT, decidedByName: 'Manager', decidedAt: AT, returnReason: null,
        changeVersionId: ID, reconfirmations: [{ taskId: ID, serviceTitle: 'Hotel', status: 'pending', overBudget: false, refusedReason: null }],
        closeReason: null, rowVersion: 3, can: { resubmit: false, withdraw: true, openVersion: false, submit: false } }],
    };
    expectFenced(DealChangeRequestsSchema as ZodType, sample, { newRatePaise: '1', supplierFeePaise: '1', ratePaise: '1', amountPaise: '1', costPaise: '1' },
      'deal_change_requests');
  });
});
