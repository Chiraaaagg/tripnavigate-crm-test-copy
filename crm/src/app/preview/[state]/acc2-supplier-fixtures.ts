import type { ImportBatchRow, ImportSummaryView } from '@/views/booking-form/vn-types';
import type { QuoteCatalogueHotel, SupplierMaster, SupplierRegisterRow } from '@/views/suppliers/types';

/*
 * Synthetic fixtures for the Accounts phase 2 supplier states (acc2-supplier-*).
 * Fake names, @example.test addresses and made-up GSTIN/PAN values only.
 */

const id = (n: number) => `a2000${String(n).padStart(3, '0')}-0000-4000-8000-000000000${String(n).padStart(3, '0')}`;

export const SUP_ROWS: SupplierRegisterRow[] = [
  {
    supplierId: id(101),
    name: 'Sample Lake Hotels Pvt Ltd',
    kind: 'direct',
    serviceTypes: ['hotel'],
    city: 'Udaipur',
    stateCode: '08',
    gstin: '08ABCDE1234F1Z5',
    panMasked: 'XXXXX1234X',
    verification: 'verified',
    bankState: 'approved',
    primaryContact: { name: 'Sample Reservations Desk', phone: '+91 90000 00101', email: 'reservations@lakehotels.example.test' },
    hotelCount: 3,
    rowVersion: 4,
    status: 'active',
  },
  {
    supplierId: id(102),
    name: 'Sample Desert Travel Channel',
    kind: 'channel',
    serviceTypes: ['hotel', 'transfer', 'activity'],
    city: 'Jaisalmer',
    stateCode: '08',
    gstin: null,
    panMasked: 'XXXXX9876X',
    verification: 'unverified',
    bankState: 'on_hold',
    primaryContact: { name: 'Sample Channel Manager', phone: null, email: 'bookings@desertchannel.example.test' },
    hotelCount: 12,
    rowVersion: 2,
    status: 'active',
  },
  {
    supplierId: id(103),
    name: 'Sample City Cabs and Transfers With A Very Long Registered Trading Name',
    kind: 'direct',
    serviceTypes: ['transfer'],
    city: 'Jodhpur',
    stateCode: null,
    gstin: null,
    panMasked: null,
    verification: 'unverified',
    bankState: 'none',
    primaryContact: null,
    hotelCount: 0,
    rowVersion: 1,
    status: 'active',
  },
  {
    supplierId: id(104),
    name: 'Sample Fort Experiences',
    kind: 'direct',
    serviceTypes: ['activity'],
    city: 'Jodhpur',
    stateCode: '08',
    gstin: '08PQRST6789K1Z2',
    panMasked: 'XXXXX6789X',
    verification: 'verified',
    bankState: 'on_hold',
    primaryContact: { name: 'Sample Fort Desk', phone: '+91 90000 00104', email: null },
    hotelCount: 0,
    rowVersion: 7,
    status: 'active',
  },
];

export const FLIGHT_SUP_ROWS: SupplierRegisterRow[] = [
  {
    supplierId: id(201),
    name: 'Sample Air Consolidators',
    kind: 'channel',
    serviceTypes: ['flight'],
    city: 'Delhi',
    stateCode: '07',
    gstin: '07LMNOP4321Q1Z9',
    panMasked: 'XXXXX4321X',
    verification: 'verified',
    bankState: 'approved',
    primaryContact: { name: 'Sample Ticketing Desk', phone: '+91 90000 00201', email: 'ticketing@airconsol.example.test' },
    hotelCount: 0,
    rowVersion: 3,
    status: 'active',
  },
];

export const SUP_MASTER: SupplierMaster = {
  ...SUP_ROWS[1]!,
  legalEntityId: 'a0000001-0000-4000-8000-000000000001',
  pan: 'XXXXX9876X',
  tallyLedgerName: null,
  verifiedAt: null,
  verifiedByName: null,
  updatedAt: '2026-11-10T10:30:00Z',
  bank: { revisionNo: 2, status: 'unverified', accountLast4: '4821' },
  address: 'Sample Building 4, Sample Market Road, Jaisalmer 345001',
  sourceRef: 'TALLY-SYN-0042',
  paymentTerms: '50% at booking, balance 7 days before arrival.',
  status: 'active',
  contacts: [
    { contactId: id(301), name: 'Sample Channel Manager', roleLabel: 'Reservations', phone: null, email: 'bookings@desertchannel.example.test', isPrimary: true, status: 'active', rowVersion: 2, updatedAt: '2026-11-05T11:40:00Z' },
    { contactId: id(302), name: 'Sample Accounts Contact', roleLabel: 'Accounts', phone: '+91 90000 00302', email: 'accounts@desertchannel.example.test', isPrimary: false, status: 'active', rowVersion: 1, updatedAt: '2026-11-05T11:40:00Z' },
  ],
  hotels: [
    { linkId: id(401), hotelId: id(501), name: 'Sample Dune Camp Resort', city: 'Jaisalmer', source: 'quote', createdAt: '2026-11-02T09:15:00Z' },
    { linkId: id(402), hotelId: id(502), name: 'Sample Golden Fort Haveli', city: 'Jaisalmer', source: 'manual', createdAt: '2026-11-05T11:40:00Z' },
    { linkId: id(403), hotelId: id(503), name: 'Sample Lakeside Palace', city: 'Udaipur', source: 'import', createdAt: '2026-11-08T06:05:00Z' },
  ],
  duplicates: [{ supplierId: id(105), name: 'Sample Desert Travels Channel Jaisalmer', reasons: ['similar_name_city', 'same_pan'] }],
  history: [
    { changedAt: '2026-11-10T10:30:00Z', changedByName: 'Synthetic Purchase Jodhpur', source: 'edit', field: 'gstin', oldValue: null, newValue: '08ABCDE1234F1Z5' },
    { changedAt: '2026-11-10T10:30:00Z', changedByName: 'Synthetic Purchase Jodhpur', source: 'edit', field: 'verification_status', oldValue: 'verified', newValue: 'unverified' },
    { changedAt: '2026-11-09T08:00:00Z', changedByName: 'Synthetic Purchase Jodhpur', source: 'bank', field: 'bank_revision', oldValue: null, newValue: 'revision 2 (…4821)' },
    { changedAt: '2026-11-08T06:05:00Z', changedByName: 'Synthetic Accounts 1', source: 'import', field: 'hotel:Sample Lakeside Palace', oldValue: null, newValue: 'linked' },
    { changedAt: '2026-11-05T11:40:00Z', changedByName: 'Synthetic Purchase Jodhpur', source: 'contact', field: 'contact:302', oldValue: null, newValue: 'Sample Accounts Contact' },
  ],
  can: { edit: true, verify: false, linkHotel: true, approveBank: false },
};

export const SUP_MASTER_MANAGER: SupplierMaster = {
  ...SUP_MASTER,
  pan: 'ABCDE9876F',
  tallyLedgerName: 'Sample Desert Travel Channel (Sundry Creditors)',
  can: { edit: false, verify: true, linkHotel: false, approveBank: true },
};

export const SUP_MASTER_FLIGHT: SupplierMaster = {
  ...FLIGHT_SUP_ROWS[0]!,
  legalEntityId: 'a0000001-0000-4000-8000-000000000001',
  pan: 'XXXXX4321X',
  tallyLedgerName: null,
  verifiedAt: '2026-11-03T09:00:00Z',
  verifiedByName: 'Synthetic Manager Jodhpur',
  updatedAt: '2026-11-03T09:00:00Z',
  bank: { revisionNo: 1, status: 'approved', accountLast4: '1199' },
  address: null,
  sourceRef: null,
  paymentTerms: null,
  status: 'active',
  contacts: [{ contactId: id(311), name: 'Sample Ticketing Desk', roleLabel: null, phone: '+91 90000 00201', email: 'ticketing@airconsol.example.test', isPrimary: true, status: 'active', rowVersion: 1, updatedAt: '2026-11-03T09:00:00Z' }],
  hotels: [],
  duplicates: [],
  history: [],
  can: { edit: true, verify: false, linkHotel: false, approveBank: false },
};

export const SUP_CATALOGUE: QuoteCatalogueHotel = {
  catalogueHotelId: id(501),
  catalogueHotelName: 'Sample Dune Camp Resort',
  hotelSuppliers: [
    { supplierId: SUP_ROWS[1]!.supplierId, name: SUP_ROWS[1]!.name, kind: 'channel', verification: 'unverified', bankState: 'on_hold' },
    { supplierId: id(106), name: 'Sample Dune Camp Direct', kind: 'direct', verification: 'verified', bankState: 'approved' },
  ],
};

export const SUP_QUOTE_SUPPLIERS = [
  { supplierId: SUP_ROWS[0]!.supplierId, name: SUP_ROWS[0]!.name },
  { supplierId: id(106), name: 'Sample Dune Camp Direct' },
  { supplierId: SUP_ROWS[1]!.supplierId, name: SUP_ROWS[1]!.name },
];

export const SUP_IMPORT_SUMMARY: ImportSummaryView = {
  batchId: id(601),
  kind: 'supplier',
  fileName: 'synthetic-sundry-creditors.csv',
  status: 'validated',
  counts: { rows: 6, valid: 4, invalid: 1, duplicates: 1, creates: 2, updates: 1, unchanged: 0, skippedVerified: 1 },
  mapping: [
    { column: 'Ledger GUID', field: 'sourceRef' },
    { column: 'Name', field: 'name' },
    { column: 'Type', field: 'supplierKind' },
    { column: 'Services', field: 'serviceTypes' },
    { column: 'City', field: 'city' },
    { column: 'State', field: 'stateCode' },
    { column: 'GSTIN', field: 'gstin' },
    { column: 'PAN', field: 'pan' },
    { column: 'Ledger name', field: 'tallyLedgerName' },
    { column: 'Hotels', field: 'hotelSourceRefs' },
    { column: 'A/c holder', field: 'bankAccountHolder' },
    { column: 'Bank', field: 'bankName' },
    { column: 'IFSC', field: 'ifsc' },
    { column: 'A/c no', field: 'accountNumber' },
    { column: 'Notes', field: null },
  ],
  invalidRows: [{ rowNo: 5, reasons: ['The PAN does not match the GSTIN'] }],
  duplicateRows: [{ rowNo: 6, text: 'ID TALLY-SYN-0050 appears twice in the file (rows 3 and 6).' }],
  proposed: [
    { rowNo: 2, action: 'create', name: 'Sample Oasis Hotels', changes: [] },
    { rowNo: 3, action: 'create', name: 'Sample Camel Safari Co', changes: [] },
    { rowNo: 4, action: 'update', name: 'Sample Desert Travel Channel', changes: ['GSTIN', 'bank details'] },
  ],
  applyBlockedReason: null,
  rowVersion: 1,
  proposalHash: 'syn-hash-0001',
  supplier: {
    warnings: { similarNameCity: 1, sameGstin: 0, samePan: 1, sameBank: 1, hotelNotFound: 1 },
    withBankDetails: 2,
    rows: [
      {
        rowNo: 2,
        outcome: 'create',
        reasons: [],
        warnings: ['similar_name_city', 'hotel_not_found'],
        warningDetails: [
          { code: 'similar_name_city', supplierId: SUP_ROWS[0]!.supplierId, supplierName: SUP_ROWS[0]!.name, hotelSourceRef: null },
          { code: 'hotel_not_found', supplierId: null, supplierName: null, hotelSourceRef: 'HOTEL-SYN-0999' },
        ],
        values: { name: 'Sample Oasis Hotels', supplierKind: 'direct', serviceTypes: 'hotel', city: 'Udaipur', stateCode: '08', gstin: null, panMasked: null, tallyLedgerName: 'Sample Oasis Hotels', sourceRef: 'TALLY-SYN-0048', contactName: 'Sample Oasis Desk', contactPhone: '+91 90000 00448', contactEmail: null, hotelSourceRefs: 'HOTEL-SYN-0011; HOTEL-SYN-0999', bank: null },
        targetId: null,
      },
      {
        rowNo: 3,
        outcome: 'create',
        reasons: [],
        warnings: ['same_bank'],
        warningDetails: [{ code: 'same_bank', supplierId: SUP_ROWS[3]!.supplierId, supplierName: SUP_ROWS[3]!.name, hotelSourceRef: null }],
        values: { name: 'Sample Camel Safari Co', supplierKind: 'direct', serviceTypes: 'activity', city: 'Jaisalmer', stateCode: '08', gstin: null, panMasked: 'XXXXX5555X', tallyLedgerName: null, sourceRef: 'TALLY-SYN-0050', contactName: null, contactPhone: null, contactEmail: 'safari@camel.example.test', hotelSourceRefs: null, bank: { holder: 'Sample Camel Safari Co', bankName: 'Sample Bank', ifsc: 'SMPL0001234', accountLast4: '7788' } },
        targetId: null,
      },
      {
        rowNo: 4,
        outcome: 'update',
        reasons: [],
        warnings: ['same_pan'],
        warningDetails: [{ code: 'same_pan', supplierId: id(105), supplierName: 'Sample Desert Travels Channel Jaisalmer', hotelSourceRef: null }],
        values: { name: 'Sample Desert Travel Channel', supplierKind: 'channel', serviceTypes: 'hotel; transfer; activity', city: 'Jaisalmer', stateCode: '08', gstin: '08ABCDE9876F1Z1', panMasked: 'XXXXX9876X', tallyLedgerName: 'Sample Desert Travel Channel', sourceRef: 'TALLY-SYN-0042', contactName: null, contactPhone: null, contactEmail: null, hotelSourceRefs: null, bank: { holder: 'Sample Desert Travel Channel', bankName: 'Sample Bank', ifsc: 'SMPL0004321', accountLast4: '4821' } },
        targetId: SUP_ROWS[1]!.supplierId,
      },
      {
        rowNo: 5,
        outcome: 'invalid',
        reasons: ['The PAN does not match the GSTIN'],
        warnings: [],
        warningDetails: [],
        values: { name: 'Sample Broken Row Tours', supplierKind: 'direct', serviceTypes: 'transfer', city: 'Delhi', stateCode: '07', gstin: '07ABCDE1111F1Z3', panMasked: 'XXXXX2222X', tallyLedgerName: null, sourceRef: 'TALLY-SYN-0051', contactName: null, contactPhone: null, contactEmail: null, hotelSourceRefs: null, bank: null },
        targetId: null,
      },
      {
        rowNo: 7,
        outcome: 'skipped_checked',
        reasons: [],
        warnings: [],
        warningDetails: [],
        values: { name: 'Sample Lake Hotels Pvt Ltd', supplierKind: 'direct', serviceTypes: 'hotel', city: 'Udaipur', stateCode: '08', gstin: '08ABCDE1234F1Z5', panMasked: 'XXXXX1234X', tallyLedgerName: null, sourceRef: 'TALLY-SYN-0001', contactName: null, contactPhone: null, contactEmail: null, hotelSourceRefs: null, bank: null },
        targetId: SUP_ROWS[0]!.supplierId,
      },
    ],
    moreRows: 0,
  },
};

export const SUP_IMPORT_HISTORY: ImportBatchRow[] = [
  { batchId: id(602), kind: 'supplier', fileName: 'synthetic-owner-file.csv', status: 'applied', rows: 40, creates: 31, updates: 6, invalid: 3, byName: 'Synthetic Accounts 1', at: '2026-11-09T07:30:00Z' },
];

export const SUP_STATES_LIST: ReadonlyArray<{ code: string; name: string }> = [
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '24', name: 'Gujarat' },
];
