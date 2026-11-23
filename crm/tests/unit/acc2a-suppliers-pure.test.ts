import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeCsvBytes, parseCsv } from '@/modules/parties/csv';
import { GST_STATE_LIST } from '@/modules/parties/gst-states';
import { importEntityIds } from '@/modules/parties/import-access';
import { IMPORT_KINDS, IMPORT_REASON_TEXT, importSummaryView, prepareRows, resolveMapping, supplierKindWord } from '@/modules/parties/import-mapping';
import { SUPPLIER_DUPLICATE_TEXT, SUPPLIER_ERROR_STATES, SUPPLIER_ERROR_TEXT, SUPPLIER_KIND_LABEL } from '@/modules/suppliers/contracts';
import { mapSupplierError } from '@/modules/suppliers/commands';
import { SupplierMasterReplySchema, SupplierRegisterReplySchema, SupplierWriteSchema } from '@/modules/suppliers/dto';
import { duplicateWarningText, gstPanStateProblem, isGstin, isPan, maskPan, similarNameKeys, similarSupplier, supplierNameKey } from '@/modules/suppliers/validate';

/**
 * Accounts phase 2, Track A (builder's own unit tests): pure supplier rules,
 * the supplier import mapping and the supplier DTOs (contract 5.1, 5.6, 5.7,
 * 13.3; Addendum L2). Track F writes the independent acc2-* suites.
 */

const fixtures = join(import.meta.dirname, '..', '..', 'supabase', 'fixtures', 'imports');
const E1 = 'e0000000-0000-4000-8000-000000000001';
const viewer = (roles: Array<[string, string]>) => ({ userId: 'u', memberships: roles.map(([legalEntityId, roleCode]) => ({ legalEntityId, branchId: 'b', roleCode })), rolePermissions: [], grants: [] });

describe('validators (mirror of 5.1 checks)', () => {
  it('GSTIN, PAN and state consistency', () => {
    expect(isGstin('08aaaaa0001a1z1')).toBe(true);
    expect(isGstin('08AAAAA0001A1Z')).toBe(false);
    expect(isPan('AAAAA0001A')).toBe(true);
    expect(gstPanStateProblem({ gstin: '08AAAAA0001A1Z1', pan: 'AAAAA0001A', stateCode: '08' })).toBeNull();
    expect(gstPanStateProblem({ gstin: '08AAAAA0001A1Z1', pan: 'BBBBB0001B' })).toBe('pan');
    expect(gstPanStateProblem({ gstin: '08AAAAA0001A1Z1', stateCode: '07' })).toBe('stateCode');
    expect(gstPanStateProblem({ stateCode: '39' })).toBe('stateCode');
    expect(gstPanStateProblem({ gstin: 'bad' })).toBe('gstin');
    expect(maskPan('AAAAA0001A')).toBe('XXXXX0001X');
    expect(maskPan('short')).toBeNull();
  });

  it('name key mirrors authz.supplier_name_key (same cases as the db test)', () => {
    expect(['The Lake-View Hotels Pvt. Ltd', 'Hotel Sunrise & Tours', 'A&B Travels LLP', '', 'Résort Ölé'].map(supplierNameKey))
      .toEqual(['lakeview', 'sunrise', 'ab', '', 'rsortl']);
  });

  it('similar name (LD24): equal key or a prefix of at least 5 characters, same city', () => {
    expect(similarNameKeys('testlakeview', 'testlakeview')).toBe(true);
    expect(similarNameKeys('testl', 'testlakeview')).toBe(true);
    expect(similarNameKeys('test', 'testlakeview')).toBe(false);
    expect(similarNameKeys('', '')).toBe(false);
    expect(similarSupplier({ name: 'Test Lakeview', city: 'Udaipur' }, { name: 'Test Lakeview Hotels', city: ' udaipur ' })).toBe(true);
    expect(similarSupplier({ name: 'Test Lakeview', city: 'Udaipur' }, { name: 'Test Lakeview Hotels', city: 'Jaipur' })).toBe(false);
    expect(similarSupplier({ name: 'The Lakeview Resort', city: 'Udaipur' }, { name: 'Test Lakeview Hotels', city: 'Udaipur' })).toBe(false);
    expect(duplicateWarningText({ name: 'Hotel X', reasons: ['same_gstin'] }, SUPPLIER_DUPLICATE_TEXT)).toBe('Looks like Hotel X (same GSTIN) — check before saving.');
  });
});

describe('words and refusals (Addendum L2, section 9)', () => {
  it('kind values are direct and channel; agent_channel is not used', () => {
    expect(Object.keys(SUPPLIER_KIND_LABEL)).toEqual(['direct', 'channel']);
    expect(SUPPLIER_KIND_LABEL.channel).toBe('Agent or booking channel');
    expect(supplierKindWord('Agent or booking channel')).toBe('channel');
    expect(supplierKindWord('Direct')).toBe('direct');
    expect(supplierKindWord('wholesaler')).toBe('wholesaler');
  });

  it('maps tokens by SQLSTATE; duplicate_supplier reads as supplier_exists; every code has words', () => {
    expect(mapSupplierError({ code: '55000', message: 'link_not_allowed' })).toBe('link_not_allowed');
    expect(mapSupplierError({ code: '23505', message: 'duplicate_supplier' })).toBe('supplier_exists');
    expect(mapSupplierError({ code: '22023', message: 'invalid_input' })).toBe('invalid_input');
    expect(mapSupplierError({ code: '55000', message: 'something else' })).toBeNull();
    for (const code of Object.keys(SUPPLIER_ERROR_STATES)) expect(SUPPLIER_ERROR_TEXT[code as keyof typeof SUPPLIER_ERROR_TEXT]).toBeTruthy();
  });
});

describe('supplier import mapping (5.6, 13.3)', () => {
  it('owner file and Tally ledger list map without guessing; Tally "Under" is left out', () => {
    expect(IMPORT_KINDS).toContain('supplier');
    for (const [file, expectUnknown] of [['acc2-supplier-owner-file.csv', []], ['acc2-tally-sundry-creditors.csv', ['Under']]] as const) {
      const decoded = decodeCsvBytes(new Uint8Array(readFileSync(join(fixtures, file))));
      expect(decoded.ok).toBe(true);
      const parsed = parseCsv(decoded.ok ? decoded.text : '');
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const m = resolveMapping('supplier', parsed.table.headers);
      expect(m.complete, m.unknownHeaders.join(',')).toBe(true);
      expect(m.unknownHeaders).toEqual(expectUnknown);
    }
  });

  it('prepareRows tidies supplier cells (state name to code, codes upper case, kind words, services) and refuses formulas', () => {
    const decoded = decodeCsvBytes(new Uint8Array(readFileSync(join(fixtures, 'acc2-supplier-owner-file.csv'))));
    const parsed = parseCsv(decoded.ok ? decoded.text : '');
    if (!parsed.ok) throw new Error('csv');
    const prepared = prepareRows('supplier', parsed.table, resolveMapping('supplier', parsed.table.headers), GST_STATE_LIST);
    expect(prepared.formulaRows).toEqual([]);
    expect(prepared.rows[0]).toMatchObject({ sourceRef: 'TST-S-001', stateCode: '08', gstin: '08AAAAA0001A1Z1', serviceTypes: 'hotel',
      supplierKind: 'direct', accountNumber: '100000000001', hotelSourceRefs: 'TST-H-001;TST-H-002', contactPhone: '+91 60000 10001' });
    expect(prepared.rows[1]).toMatchObject({ supplierKind: 'channel', serviceTypes: 'hotel;transfer', stateCode: '08' });
    const formula = prepareRows('supplier', { headers: ['Supplier ID', 'Supplier Name'], rows: [['TST-1', '=SUM(A1)']], lines: [2], ragged: [] },
      resolveMapping('supplier', ['Supplier ID', 'Supplier Name']), GST_STATE_LIST);
    expect(formula.formulaRows).toEqual([1]);
  });

  it('every frozen reason code of 13.3 has words', () => {
    for (const code of ['name_required', 'name_exists', 'kind_invalid', 'service_types_invalid', 'gstin_invalid', 'pan_invalid', 'state_invalid',
      'gstin_pan_mismatch', 'gstin_state_mismatch', 'contact_invalid', 'bank_incomplete', 'ifsc_invalid', 'account_invalid', 'source_ref_invalid', 'formula_cell']) {
      expect(IMPORT_REASON_TEXT[code], code).toBeTruthy();
    }
  });

  it('access: Accounts without Purchase, or Super Admin', () => {
    expect(importEntityIds(viewer([[E1, 'accounts']]), 'supplier')).toEqual([E1]);
    expect(importEntityIds(viewer([[E1, 'super_admin']]), 'supplier')).toEqual([E1]);
    expect(importEntityIds(viewer([[E1, 'accounts'], [E1, 'purchase']]), 'supplier')).toEqual([]);
    expect(importEntityIds(viewer([[E1, 'purchase']]), 'supplier')).toEqual([]);
  });

  it('summary carries the supplier extras with masked values only', () => {
    const headers = ['Supplier ID', 'Supplier Name'];
    const view = importSummaryView({
      kind: 'supplier', fileName: 'suppliers.csv', headers, mapping: resolveMapping('supplier', headers),
      validation: { batchId: 'b0000000-0000-4000-8000-000000000001', kind: 'supplier', status: 'validated', rows: 1, valid: 1, invalid: 0,
        duplicatesInFile: 0, possibleDuplicates: 0, proposed: { create: 1, update: 0, unchanged: 0, skippedChecked: 0 }, invalidRows: [],
        duplicateRows: [], rowVersion: 2, withBankDetails: 1, warnings: { similarNameCity: 0, sameGstin: 0, samePan: 0, sameBank: 0, hotelNotFound: 1 } },
      supplierRows: [{ rowNo: 1, outcome: 'create', reasons: [], targetId: null,
        warnings: [{ code: 'hotel_not_found', supplierId: null, supplierName: null, hotelSourceRef: 'TST-H-404' }],
        values: { name: 'Test', supplierKind: 'direct', serviceTypes: ['hotel', 'transfer'], city: null, stateCode: '08', gstin: null, panMasked: 'XXXXX0001X',
          tallyLedgerName: null, sourceRef: 'TST-1', contactName: null, contactPhone: null, contactEmail: null, hotelSourceRefs: ['TST-H-404'],
          bank: { holder: 'Test', bankName: 'Bank', ifsc: 'TEST0000001', accountLast4: '0001' } } }],
    });
    expect(view.supplier?.warnings.hotelNotFound).toBe(1);
    expect(view.supplier?.rows[0]).toMatchObject({ warnings: ['hotel_not_found'], values: { serviceTypes: 'hotel; transfer', hotelSourceRefs: 'TST-H-404' } });
  });
});

describe('DTOs (every key listed; no bank numbers)', () => {
  const row = { supplierId: 'a0000000-0000-4000-8000-000000000101', name: 'Test', kind: 'channel', serviceTypes: ['hotel'], city: null, stateCode: '08',
    gstin: null, panMasked: 'XXXXX0001X', verification: 'unverified', bankState: 'on_hold', primaryContact: null, hotelCount: 0, rowVersion: 1, status: 'active' };

  it('register page: unknown keys stripped; hasMore from nextAfter; null passes through', () => {
    const page = SupplierRegisterReplySchema.parse({ items: [{ ...row, accountNumber: '100000000001', pan: 'AAAAA0001A' }], nextAfter: 'test|x' });
    expect(page?.hasMore).toBe(true);
    expect(JSON.stringify(page)).not.toMatch(/100000000001|AAAAA0001A/);
    expect(SupplierRegisterReplySchema.parse(null)).toBeNull();
    expect(SupplierRegisterReplySchema.safeParse({ items: [{ ...row, kind: 'agent_channel' }], nextAfter: null }).success).toBe(false);
  });

  it('master: bank is number, status and last 4 only', () => {
    const m = SupplierMasterReplySchema.parse({ ...row, legalEntityId: 'e0000000-0000-4000-8000-000000000001', pan: 'XXXXX0001X', address: null,
      tallyLedgerName: null, sourceRef: null, paymentTerms: null, verifiedAt: null, verifiedByName: null, updatedAt: '2026-11-11T10:00:00Z',
      bank: { revisionNo: 1, status: 'unverified', accountLast4: '0001', accountNumber: '100000000001', ifsc: 'TEST0000001' },
      contacts: [], hotels: [], duplicates: [], history: [], can: { edit: true, verify: false, linkHotel: true, approveBank: false } });
    expect(m?.bank).toEqual({ revisionNo: 1, status: 'unverified', accountLast4: '0001' });
  });

  it('write result: warnings default to []', () => {
    expect(SupplierWriteSchema.parse({ supplierId: row.supplierId, rowVersion: 1 }).warnings).toEqual([]);
  });
});
