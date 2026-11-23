import type { TallyFileHeader, TallyFilePreview, TallyLeftOutPage, TallyMatchBatch, TallyMatchPage } from '@/views/tally-file/types';

/*
 * Synthetic fixtures for the Tally file preview states (acc3-tally-).
 * References, Deals and amounts are invented; nothing here is real.
 */

export const ENTITIES = [{ id: 'a0000001-0000-4000-8000-000000000001', name: 'Holiday Chacha Pvt LTD' }];
export const BRANCHES = [
  { id: 'a0000011-0000-4000-8000-000000000011', name: 'Jodhpur' },
  { id: 'a0000012-0000-4000-8000-000000000012', name: 'Delhi' },
  { id: 'a0000013-0000-4000-8000-000000000013', name: 'Ahmedabad' },
];
const rid = (n: number) => `a0003${String(500 + n)}-0000-4000-8000-000000003${String(500 + n)}`;

export const TALLY_PREVIEW: TallyFilePreview = {
  lines: [
    { recordKind: 'journal_entry', recordId: rid(1), reference: 'R-2026-000412', dealReference: 'SYN-JOD-301', voucherType: 'Receipt', date: '2026-11-03', amountPaise: '5000000' },
    { recordKind: 'supplier_payment', recordId: rid(2), reference: 'SP-2026-000088', dealReference: 'SYN-JOD-301', voucherType: 'Payment', date: '2026-11-05', amountPaise: '3200000' },
    { recordKind: 'write_off', recordId: rid(3), reference: 'WO-2026-000009', dealReference: 'SYN-DEL-305', voucherType: 'Journal', date: '2026-11-10', amountPaise: '30000' },
  ],
  leftOut: [
    { recordKind: 'journal_entry', recordId: rid(4), reference: 'R-2026-000415', reason: 'party_not_mapped', detail: 'Billing party: Synthetic Traveller Co' },
    { recordKind: 'supplier_refund', recordId: rid(5), reference: 'SRF-2026-000003', reason: 'ledger_not_mapped', detail: 'Supplier refund · bank ledger' },
    { recordKind: 'journal_entry', recordId: rid(6), reference: 'R-2026-000398', reason: 'already_in_file', detail: 'TE-2026-000027' },
  ],
  counts: { lines: 3, leftOut: 3, byReason: { party_not_mapped: 1, ledger_not_mapped: 1, already_in_file: 1 } },
  truncated: false,
  companyName: 'Holiday Chacha Pvt Ltd (Copy)',
};

export const TALLY_PREVIEW_EMPTY: TallyFilePreview = {
  lines: [],
  leftOut: [{ recordKind: 'write_off', recordId: rid(7), reference: 'WO-2026-000011', reason: 'voucher_type_missing', detail: 'Write-off (customer owed)' }],
  counts: { lines: 0, leftOut: 1, byReason: { voucher_type_missing: 1 } },
  truncated: false,
};

export const FILES: TallyFileHeader[] = [
  {
    exportId: 'a0003401-0000-4000-8000-000000003401',
    exportNo: 'TE-2026-000031',
    format: 'xml',
    periodFrom: '2026-11-01',
    periodTo: '2026-11-12',
    kinds: ['journal_entry', 'supplier_payment', 'supplier_refund', 'write_off'],
    rowCount: 3,
    leftOutCount: 3,
    includeReason: null,
    companyName: 'Holiday Chacha Pvt Ltd (Copy)',
    createdAt: '2026-11-12T10:30:00Z',
    createdByName: 'Synthetic Accounts 1',
  },
  {
    exportId: 'a0003402-0000-4000-8000-000000003402',
    exportNo: 'TE-2026-000029',
    format: 'xml',
    periodFrom: '2026-10-01',
    periodTo: '2026-10-31',
    kinds: ['journal_entry', 'supplier_payment'],
    rowCount: 142,
    leftOutCount: 0,
    includeReason: 'The first import into the copy company stopped halfway; importing the October entries again.',
    createdAt: '2026-11-02T06:00:00Z',
    createdByName: 'Synthetic Accounts 2',
  },
  {
    exportId: 'a0003403-0000-4000-8000-000000003403',
    exportNo: 'TE-2026-000028',
    format: 'csv',
    periodFrom: '2026-10-01',
    periodTo: '2026-10-31',
    kinds: ['journal_entry', 'supplier_document', 'expense'],
    rowCount: 210,
    leftOutCount: 0,
    includeReason: null,
    createdAt: '2026-11-01T12:00:00Z',
    createdByName: 'Synthetic Accounts 1',
  },
];

export const LEFT_OUT_PAGE: TallyLeftOutPage = {
  exportId: FILES[0]!.exportId,
  exportNo: FILES[0]!.exportNo,
  items: [
    ...TALLY_PREVIEW.leftOut,
    { recordKind: 'journal_entry', recordId: rid(8), reference: 'R-2026-000401', reason: 'kind_not_in_file', detail: 'Receipt reversal' },
    { recordKind: 'write_off', recordId: rid(9), reference: 'WO-2026-000004', reason: 'changed_since_file', detail: 'TE-2026-000025' },
  ],
  nextAfter: 'journal_entry|a0003509-0000-4000-8000-000000003509',
  hasMore: true,
};

export const MATCH_BATCH: TallyMatchBatch = {
  batchId: 'a0003601-0000-4000-8000-000000003601',
  fileName: 'DayBook-Nov-1-12.xml',
  status: 'staged',
  rowCount: 7,
  summary: { matched: 3, amount_differs: 1, not_found: 1, already_matched: 1, duplicate_in_file: 0, no_tag: 1 },
  proposalHash: 'f'.repeat(64),
  stagedAt: '2026-11-13T05:40:00Z',
  stagedByName: 'Synthetic Accounts 1',
  appliedAt: null,
};

export const MATCH_PAGE: TallyMatchPage = {
  batch: MATCH_BATCH,
  outcome: null,
  rows: [
    { rowNo: 1, tnTag: 'TN:TE-2026-000031/1', voucherRef: '1287', voucherDate: '2026-11-03', voucherType: 'Receipt', amountPaise: '5000000', outcome: 'matched', crmAmountPaise: '5000000', crmReference: 'R-2026-000412' },
    { rowNo: 2, tnTag: 'TN:TE-2026-000031/2', voucherRef: '644', voucherDate: '2026-11-05', voucherType: 'Payment', amountPaise: '3150000', outcome: 'amount_differs', crmAmountPaise: '3200000', crmReference: 'SP-2026-000088' },
    { rowNo: 3, tnTag: 'TN:TE-2026-000031/3', voucherRef: '91', voucherDate: '2026-11-10', voucherType: 'Journal', amountPaise: '30000', outcome: 'matched', crmAmountPaise: '30000', crmReference: 'WO-2026-000009' },
    { rowNo: 4, tnTag: 'TN:TE-2026-000029/17', voucherRef: '1201', voucherDate: '2026-10-14', voucherType: 'Receipt', amountPaise: '2500000', outcome: 'already_matched', crmAmountPaise: '2500000', crmReference: 'R-2026-000377' },
    { rowNo: 5, tnTag: 'TN:TE-2026-000099/4', voucherRef: '1290', voucherDate: '2026-11-11', voucherType: 'Receipt', amountPaise: '100000', outcome: 'not_found', crmAmountPaise: null, crmReference: null },
    { rowNo: 6, tnTag: null, voucherRef: '1291', voucherDate: '2026-11-11', voucherType: 'Payment', amountPaise: '45000', outcome: 'no_tag', crmAmountPaise: null, crmReference: null },
    { rowNo: 7, tnTag: 'TN:TE-2026-000029/40', voucherRef: '1240', voucherDate: '2026-10-29', voucherType: 'Contra', amountPaise: '1000000', outcome: 'matched', crmAmountPaise: '1000000', crmReference: 'R-2026-000390' },
  ],
  nextAfter: null,
  hasMore: false,
};
