import { describe, expect, it } from 'vitest';
import { importEntity, importEntityIds } from '@/modules/parties/import-access';
import { parsePartyFields, readReturnReason, searchQuery, toPartyOption } from '@/modules/parties/party-forms';

/* Voice-note batch: stored customer form rules, import roles and search words (pure). Made-up data only. */

const E1 = 'e0000000-0000-4000-8000-000000000001';
const E2 = 'e0000000-0000-4000-8000-000000000002';
const viewer = (roles: Array<[string, string]>) => ({ userId: 'u', memberships: roles.map(([legalEntityId, roleCode]) => ({ legalEntityId, branchId: 'b', roleCode })), rolePermissions: [], grants: [] });

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe('parsePartyFields', () => {
  it('personal: name needed; phone, email, PIN tidied; never GST answers', () => {
    const p = parsePartyFields(form({ partyType: 'personal', name: '  Test   Person ', phone: '+91 98765-00001', email: 'Person@Example.TEST', postalCode: '110 001', stateCode: '07', gstStatus: 'registered', gstin: '07AAAAA0000A1Z5', contactPerson: 'x' }));
    expect(p).toEqual({
      ok: true,
      fields: { partyType: 'personal', name: 'Test Person', contactPerson: null, phone: '9876500001', email: 'person@example.test', addressLine1: null, addressLine2: null, city: null, stateCode: '07', postalCode: '110001', gstStatus: null, gstin: null, gstReason: null },
    });
  });
  it('business: GST answer required; GSTIN must match the state; unregistered needs a 10-500 reason', () => {
    expect(parsePartyFields(form({ partyType: 'business', name: 'Test Co' }))).toEqual({ ok: false, fields: ['gstStatus'] });
    expect(parsePartyFields(form({ partyType: 'business', name: 'Test Co', gstStatus: 'registered', gstin: '07AAAAA0000A1Z5', stateCode: '08' }))).toEqual({ ok: false, fields: ['gstin'] });
    expect(parsePartyFields(form({ partyType: 'business', name: 'Test Co', gstStatus: 'registered', gstin: '08AAAAA0000A1Z5' }))).toEqual({ ok: false, fields: ['stateCode'] });
    expect(parsePartyFields(form({ partyType: 'business', name: 'Test Co', gstStatus: 'unregistered', gstReason: 'short' }))).toEqual({ ok: false, fields: ['gstReason'] });
    const ok = parsePartyFields(form({ partyType: 'business', name: 'Test Co', gstStatus: 'registered', gstin: '08aaaaa0000a1z5', stateCode: '08', contactPerson: 'Test Contact' }));
    expect(ok.ok && ok.fields).toMatchObject({ gstin: '08AAAAA0000A1Z5', contactPerson: 'Test Contact' });
  });
  it('refuses unknown type, bad phone, bad email, bad PIN and bad state together', () => {
    expect(parsePartyFields(form({ partyType: 'firm', name: '', phone: '123', email: 'x', postalCode: '012345', stateCode: '99' }))).toEqual({ ok: false, fields: ['partyType', 'name', 'phone', 'email', 'stateCode', 'postalCode'] });
  });
  it('return reason 10..500', () => {
    expect(readReturnReason(form({ reason: 'too short' }))).toBeNull();
    expect(readReturnReason(form({ reason: '  PIN does not match   the city ' }))).toBe('PIN does not match the city');
  });
});

describe('toPartyOption and search words', () => {
  it('missing keys read as empty; personal never shows GST; imported label', () => {
    expect(toPartyOption({ id: 'p1', partyType: 'personal', name: 'Test', gstin: '08AAAAA0000A1Z5', checkStatus: 'not_checked', importBatchId: 'b' })).toMatchObject({ partyId: 'p1', gstin: null, gstStatus: null, addressLine1: '', sourceLabel: 'Imported' });
    expect(toPartyOption({ id: 'p2', partyType: 'business', name: 'Co', gstin: '08AAAAA0000A1Z5', checkStatus: 'checked' })).toMatchObject({ gstStatus: 'registered', sourceLabel: null });
  });
  it('search words: 2..100 characters, spaces tidied, never anything else', () => {
    expect(searchQuery('a')).toBeNull();
    expect(searchQuery('  test   co ')).toBe('test co');
    expect(searchQuery('x'.repeat(101))).toBeNull();
    expect(searchQuery(42)).toBeNull();
  });
});

describe('import roles', () => {
  it('hotels: Super Admin; customers: Accounts; never with Purchase in that company; one company only', () => {
    expect(importEntityIds(viewer([[E1, 'super_admin']]), 'hotel')).toEqual([E1]);
    expect(importEntityIds(viewer([[E1, 'super_admin']]), 'customer')).toEqual([]);
    expect(importEntityIds(viewer([[E1, 'accounts'], [E1, 'purchase']]), 'customer')).toEqual([]);
    expect(importEntity(viewer([[E1, 'accounts']]), 'customer')).toEqual({ ok: true, entityId: E1 });
    expect(importEntity(viewer([[E1, 'accounts'], [E2, 'accounts']]), 'customer')).toEqual({ ok: false, reason: 'several' });
    expect(importEntity(viewer([[E1, 'sales']]), 'hotel')).toEqual({ ok: false, reason: 'no_access' });
  });
});
