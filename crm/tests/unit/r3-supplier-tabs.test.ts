import { describe, expect, it } from 'vitest';
import { SUPPLIER_BANK_RECORD_ID, SUPPLIER_TABS, supplierNext, supplierTabFrom, supplierTabHref } from '@/views/suppliers/tabs';

/**
 * UX redesign R3 (DM-21): the supplier page gains a "Bank details" tab. Every
 * address that worked before must open the same tab, and the header's
 * "Next:" line must point at the right place for each reader.
 */

describe('supplier page tabs: old addresses keep their tab', () => {
  it('no ?tab= and ?tab=details open Details', () => {
    expect(supplierTabFrom(undefined)).toBe('details');
    expect(supplierTabFrom('details')).toBe('details');
  });
  it('the four tabs that existed before open the same tab', () => {
    for (const t of ['details', 'contacts', 'hotels', 'history'] as const) expect(supplierTabFrom(t)).toBe(t);
  });
  it('?tab=bank opens the new Bank details tab', () => {
    expect(supplierTabFrom('bank')).toBe('bank');
    expect(SUPPLIER_TABS).toContain('bank');
  });
  it('an unknown, misspelt or repeated value falls back the same way as before', () => {
    expect(supplierTabFrom('Bank')).toBe('details');
    expect(supplierTabFrom('payments')).toBe('details');
    expect(supplierTabFrom('')).toBe('details');
    expect(supplierTabFrom(['contacts', 'history'])).toBe('contacts');
  });
  it('tab addresses: Details has no ?tab=, the others carry their value', () => {
    expect(supplierTabHref('/app/purchase/suppliers', 's1', 'details')).toBe('/app/purchase/suppliers/s1');
    expect(supplierTabHref('/app/purchase/suppliers', 's1', 'bank')).toBe('/app/purchase/suppliers/s1?tab=bank');
    expect(supplierTabHref('/app/purchase/suppliers', 's1', 'history')).toBe('/app/purchase/suppliers/s1?tab=history');
  });
});

const can = (over: Partial<{ edit: boolean; verify: boolean; linkHotel: boolean; approveBank: boolean }> = {}) => ({ edit: false, verify: false, linkHotel: false, approveBank: false, ...over });
const base = { serviceTypes: ['hotel' as const], verification: 'verified' as const, bankState: 'approved' as const, can: can() };
const o = (tab: Parameters<typeof supplierNext>[1]['tab'], canEdit = false) => ({ canEdit, tab, bankHref: '/app/purchase/suppliers/s1?tab=bank' });

describe('supplier page header: next step', () => {
  it('not verified: the Manager who may verify is told to check; everyone else is told who does', () => {
    expect(supplierNext({ ...base, verification: 'unverified', can: can({ verify: true }) }, o('details'))).toEqual({ text: 'Check these details, then verify them.', mine: true });
    expect(supplierNext({ ...base, verification: 'unverified' }, o('details', true))).toEqual({ text: 'A Manager checks and verifies these details.', mine: false });
  });
  it('payments on hold: a bank approver gets a link to the Bank details tab (none on that tab); Purchase is told who acts', () => {
    const hold = { ...base, bankState: 'on_hold' as const };
    expect(supplierNext({ ...hold, can: can({ approveBank: true }) }, o('details')).button).toEqual({ label: 'Open bank details', href: '/app/purchase/suppliers/s1?tab=bank' });
    expect(supplierNext({ ...hold, can: can({ approveBank: true }) }, o('bank')).button).toBeUndefined();
    const purchase = supplierNext({ ...hold, can: can({ edit: true }) }, o('details', true));
    expect(purchase.mine).toBe(false);
    expect(purchase.button).toBeUndefined();
    expect(purchase.text).toMatch(/Manager who did not record them approves/);
  });
  it('no bank details: the editor records them (link to the tab, or a jump on the tab); others are told who', () => {
    const none = { ...base, bankState: 'none' as const };
    expect(supplierNext(none, o('details', true)).button).toEqual({ label: 'Record bank details', href: '/app/purchase/suppliers/s1?tab=bank' });
    expect(supplierNext(none, o('bank', true)).button).toEqual({ label: 'Record bank details', jumpTo: SUPPLIER_BANK_RECORD_ID });
    expect(supplierNext(none, o('details'))).toEqual({ text: 'Purchase records bank details before any payment to this supplier.', mine: false });
    expect(supplierNext({ ...none, serviceTypes: ['flight'] }, o('details')).text).toMatch(/^Flight records bank details/);
  });
  it('verified with approved bank details: ready, no button', () => {
    expect(supplierNext(base, o('details', true))).toEqual({ text: 'Ready to use for rates and payments.', mine: true });
  });
});
