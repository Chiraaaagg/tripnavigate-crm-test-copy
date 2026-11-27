import { describe, expect, it } from 'vitest';
import { AccountsDealDetailSchema } from '@/modules/finance/dto';
import { FINANCE_FIELD as F, parseBillingForm } from '@/modules/finance/forms';

/*
 * Echo M2: Accounts sees and edits the booking form Bill To fields and can
 * switch a business between GST registered and not registered. The keys are
 * sent only when the form posts them (older database: the screen has no such
 * inputs, nothing new is sent). Synthetic values only.
 */

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const base = { [F.billingName]: 'Test Travels', [F.addressLine1]: 'Test street 1', [F.city]: 'Jodhpur', [F.stateCode]: '08', [F.postalCode]: '342001', [F.gstin]: '' };

describe('Accounts billing form', () => {
  it('without Bill To inputs: the seven old keys only (older database)', () => {
    const p = parseBillingForm(form({ ...base, [F.gstin]: '08ABCDE1234F1Z5' }));
    expect(p.ok && Object.keys(p.value).sort()).toEqual(['addressLine1', 'addressLine2', 'billingName', 'city', 'gstin', 'postalCode', 'stateCode']);
  });
  it('unregistered → registered with a GSTIN of the state', () => {
    const p = parseBillToBusiness({ [F.gstStatus]: 'registered', [F.gstin]: '08ABCDE1234F1Z5' });
    expect(p.ok && p.value).toMatchObject({ billToType: 'business', gstStatus: 'registered', gstin: '08ABCDE1234F1Z5', gstReason: null, contactPerson: 'Riya Mehta', phone: '9876543210', email: 'accounts@example.com' });
  });
  it('registered → unregistered: a reason, no GSTIN; a typed GSTIN is a clear choice, not a dead end', () => {
    const ok = parseBillToBusiness({ [F.gstStatus]: 'unregistered', [F.gstReason]: 'Turnover below the limit', [F.gstin]: '' });
    expect(ok.ok && ok.value).toMatchObject({ gstStatus: 'unregistered', gstin: null, gstReason: 'Turnover below the limit' });
    const withGstin = parseBillToBusiness({ [F.gstStatus]: 'unregistered', [F.gstReason]: 'Turnover below the limit', [F.gstin]: '08ABCDE1234F1Z5' });
    expect(withGstin.ok ? {} : withGstin.fieldErrors[F.gstin]).toMatch(/Clear the GSTIN, or choose GST registered/);
    const noReason = parseBillToBusiness({ [F.gstStatus]: 'unregistered', [F.gstin]: '' });
    expect(noReason.ok ? {} : noReason.fieldErrors).toHaveProperty(F.gstReason);
    const noGstin = parseBillToBusiness({ [F.gstStatus]: 'registered', [F.gstin]: '' });
    expect(noGstin.ok ? {} : noGstin.fieldErrors).toHaveProperty(F.gstin);
  });
  it('personal: no contact person or GST answers', () => {
    const p = parseBillingForm(form({ ...base, [F.billToType]: 'personal', [F.contactPerson]: 'ignored', [F.gstStatus]: 'registered', [F.billingPhone]: '' }));
    expect(p.ok && p.value).toMatchObject({ billToType: 'personal', contactPerson: null, gstStatus: null, gstReason: null, phone: null });
  });
  it('bad phone, email and type are named', () => {
    const p = parseBillingForm(form({ ...base, [F.billToType]: 'other' }));
    expect(p.ok ? {} : p.fieldErrors).toHaveProperty(F.billToType);
    const q = parseBillToBusiness({ [F.billingPhone]: '12345', [F.billingEmail]: 'nope' });
    expect(q.ok ? {} : q.fieldErrors).toEqual(expect.objectContaining({ [F.billingPhone]: expect.any(String), [F.billingEmail]: expect.any(String) }));
  });
});

function parseBillToBusiness(over: Record<string, string>) {
  return parseBillingForm(form({ ...base, [F.billToType]: 'business', [F.contactPerson]: 'Riya Mehta', [F.billingPhone]: '+91 98765 43210', [F.billingEmail]: 'Accounts@Example.com', [F.gstStatus]: 'registered', [F.gstin]: '08ABCDE1234F1Z5', ...over }));
}

describe('Accounts deal detail read', () => {
  it('keeps the Bill To keys when sent and loads without them', () => {
    const billing = {
      billingName: 'Test Travels', addressLine1: 'Test street 1', addressLine2: null, city: 'Jodhpur', stateCode: '08', postalCode: '342001', gstin: null,
      status: 'draft', rowVersion: 1, updatedByName: null, updatedAt: '2026-10-22T08:00:00Z', verifiedByName: null, verifiedAt: null,
    };
    const BillingOnly = AccountsDealDetailSchema.shape.billing;
    expect(BillingOnly.parse({ ...billing, billToType: 'business', contactPerson: 'Riya Mehta', phone: null, email: null, gstStatus: 'unregistered', gstReason: 'Turnover below the limit' })).toMatchObject({ gstStatus: 'unregistered', gstReason: 'Turnover below the limit' });
    expect(BillingOnly.parse(billing)).not.toHaveProperty('gstStatus');
  });
});

describe('Accounts booking prices (Echo review A M1)', () => {
  it('selling side only: a purchase or markup key is never kept; absent is fine', () => {
    const Booking = AccountsDealDetailSchema.shape.booking.unwrap();
    const base = {
      bookingVersionId: '11111111-1111-4111-8111-111111111111', versionNo: 1, hotelName: null, city: null, checkIn: null, checkOut: null, rooms: null, adults: null, children: null,
      sellingTotalPaise: '3300000', confirmedAt: '2026-10-22T08:00:00Z', confirmedByName: null, reviewStatus: 'pending', reviewRowVersion: 1, returnReason: null,
      reviewedByName: null, reviewedAt: null, canApprove: false, approveBlock: null,
    };
    const parsed = Booking.parse({ ...base, prices: { lines: [{ category: 'adult', quantity: 2, salePaise: '1200000', purchasePaise: '1000000', markupPaise: '200000' }], source: 'per_person', sellingTotalPaise: '2400000' } });
    expect(parsed.prices?.lines[0]).toEqual({ category: 'adult', quantity: 2, salePaise: '1200000' });
    expect(JSON.stringify(parsed)).not.toMatch(/purchasePaise|markupPaise/);
    expect(Booking.parse(base)).not.toHaveProperty('prices');
  });
});
