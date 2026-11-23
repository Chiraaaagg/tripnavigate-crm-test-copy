import { describe, expect, it } from 'vitest';
import { CompanyDestinationsPageSchema, DestinationOptionsSchema } from '@/modules/finance/dto';
import { FINANCE_FIELD as F, parseDestinationForm } from '@/modules/finance/forms';

const ENTITY = 'e0000000-0000-4000-8000-000000000001';
const DEST = 'd0000000-0000-4000-8000-000000000001';
const REQ = '11111111-2222-4333-8444-555555555555';

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}
const BANK = {
  [F.entityId]: ENTITY, [F.requestId]: REQ, [F.destinationKind]: 'bank', [F.label]: 'Synthetic current account',
  [F.holderName]: 'Synthetic Holder', [F.bankName]: 'Synthetic Bank', [F.accountNumber]: '0001 2345 6789', [F.ifsc]: 'synb0001234',
};

describe('parseDestinationForm', () => {
  it('parses a new bank account, keeping leading zeros and normalising the IFSC', () => {
    expect(parseDestinationForm(form(BANK))).toEqual({
      ok: true,
      value: {
        entityId: ENTITY, destinationId: null, expectedRowVersion: null, requestId: REQ,
        fields: { kind: 'bank', label: 'Synthetic current account', holderName: 'Synthetic Holder', bankName: 'Synthetic Bank', accountNumber: '000123456789', ifsc: 'SYNB0001234' },
      },
    });
  });

  it('parses a UPI replacement with the expected row version and no kind or label', () => {
    const parsed = parseDestinationForm(form({
      [F.entityId]: ENTITY, [F.requestId]: REQ, [F.destinationId]: DEST, [F.destinationKind]: 'upi', [F.expectedRowVersion]: '3',
      [F.payeeName]: 'Synthetic Payee', [F.upiId]: 'Synthetic.Payee@SynBank',
    }));
    expect(parsed).toEqual({
      ok: true,
      value: { entityId: ENTITY, destinationId: DEST, expectedRowVersion: 3, requestId: REQ, fields: { payeeName: 'Synthetic Payee', upiId: 'synthetic.payee@synbank' } },
    });
  });

  it('refuses labels that carry numbers or UPI IDs, and malformed values, without echoing them', () => {
    for (const label of ['Acct 1234 5678 9012', 'pay.me@synbank', '']) {
      const parsed = parseDestinationForm(form({ ...BANK, [F.label]: label }));
      expect(!parsed.ok && parsed.fieldErrors[F.label]).toBeTruthy();
      expect(JSON.stringify(parsed)).not.toContain('5678');
    }
    const bad = parseDestinationForm(form({ ...BANK, [F.accountNumber]: '12AB', [F.ifsc]: 'BAD' }));
    expect(!bad.ok && Object.keys(bad.fieldErrors).sort()).toEqual([F.accountNumber, F.ifsc].sort());
  });

  it('requires the expected row version for a replacement and request identity always', () => {
    const noVersion = parseDestinationForm(form({ [F.entityId]: ENTITY, [F.requestId]: REQ, [F.destinationId]: DEST, [F.destinationKind]: 'upi', [F.payeeName]: 'X', [F.upiId]: 'x.y@bank' }));
    expect(!noVersion.ok && noVersion.fieldErrors._form).toBeTruthy();
    const noRequest = parseDestinationForm(form({ ...BANK, [F.requestId]: '' }));
    expect(!noRequest.ok && noRequest.fieldErrors._form).toBeTruthy();
  });
});

describe('destination DTOs fail closed', () => {
  const version = {
    versionId: DEST, versionNo: 1, status: 'approved', predecessorVersionNo: null, holderName: 'Synthetic', bankName: 'Synthetic Bank',
    accountMasked: 'XXXX6789', ifsc: 'SYNB0001234', payeeName: null, upiMasked: null, makerId: DEST, makerName: 'A',
    createdAt: '2026-10-08T10:00:00Z', decidedByName: 'B', decidedAt: '2026-10-08T10:05:00Z', decisionReason: null,
  };
  const page = {
    entityId: ENTITY,
    destinations: [{
      destinationId: DEST, kind: 'bank', label: 'Synthetic', rowVersion: 2, state: 'approved', createdByName: 'A', createdAt: '2026-10-08T10:00:00Z',
      retiredAt: null, retiredByName: null, retireReason: null, current: version, pending: null, latestVersionNo: 1, versions: [version],
      actions: { submit: null, decide: 'wrong_state', retire: null },
    }],
  };

  it('accepts the masked shape the database returns', () => {
    expect(CompanyDestinationsPageSchema.safeParse(page).success).toBe(true);
  });

  it('refuses an unmasked account number or UPI ID in a list or an option', () => {
    const leaked = { ...page, destinations: [{ ...page.destinations[0]!, current: { ...version, accountMasked: '000123456789' } }] };
    expect(CompanyDestinationsPageSchema.safeParse(leaked).success).toBe(false);
    const option = { versionId: DEST, destinationId: DEST, kind: 'upi', label: 'S', versionNo: 1, bankName: null, accountMasked: null, payeeName: 'P', upiMasked: 's***@synbank' };
    expect(DestinationOptionsSchema.safeParse([option]).success).toBe(true);
    expect(CompanyDestinationsPageSchema.safeParse({ ...page, destinations: [{ ...page.destinations[0]!, current: { ...version, upiMasked: 'synthetic.payee@synbank' } }] }).success).toBe(false);
  });
});
