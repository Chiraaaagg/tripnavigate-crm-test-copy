/*
 * Synthetic fixtures for the Accounts phase preview states (acc-). Invented
 * values only (SYN- deals, Sample suppliers, example.test people); no real
 * customer, money or document data.
 */
import type { DailyCheck, DealDues, DuesRow, RecordRow, RecordsPage, RecordsTotals, TallyPageView } from '@/views/accounts-desk/types';
import type { NoticeHistory, NoticeInbox, NoticeItem } from '@/views/notices/types';
import type { PurchaseBookingChangeView } from '@/views/purchase/booking-change-banner';

const id = (n: number) => `a${String(n).padStart(7, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const SUP_HOTEL = id(901);
export const SUP_AIR = id(902);
export const BR_JOD = id(911);
export const BR_DEL = id(912);

function row(n: number, over: Partial<RecordRow>): RecordRow {
  return {
    rowId: `${over.kind ?? 'receipt'}:${id(n)}`,
    kind: 'receipt',
    recordId: id(n),
    recordDate: '2026-11-09',
    createdAt: '2026-11-09T06:30:00Z',
    reference: `R-2026-27-${String(n).padStart(6, '0')}`,
    otherReferences: [],
    dealId: id(500 + n),
    dealReference: 'SYN-JOD-101',
    bitrixDealId: '41021',
    branchName: 'Jodhpur',
    collectingBranchName: null,
    department: 'sales',
    taskId: null,
    serviceLabel: null,
    supplierId: null,
    supplierName: null,
    amountPaise: '2500000',
    direction: 'in',
    statusCode: 'verified',
    stage: 'done',
    reviewStatus: 'done',
    tally: { status: 'ready', rowVersion: 0, recordKind: 'journal_entry', changedSinceExport: false, lastExportedAt: null, exportCount: 0, voucherRef: null, voucherDate: null, exceptionReason: null, recordId: null },
    files: { count: 1, links: [{ kind: 'finance', evidenceId: id(700 + n), fileName: 'synthetic-bank-proof.pdf' }] },
    original: null,
    link: { kind: 'accounts_deal', id: id(500 + n) },
    can: { match: true, exception: true, reopen: false, linkTask: false },
    ...over,
  };
}

export const ROWS: RecordRow[] = [
  row(1, {}),
  row(2, {
    kind: 'receipt',
    reference: 'R-2026-27-000002',
    statusCode: 'recorded',
    stage: 'open',
    reviewStatus: 'waiting',
    collectingBranchName: 'Delhi',
    tally: { status: 'not_ready', rowVersion: 0, recordKind: 'journal_entry', changedSinceExport: false, lastExportedAt: null, exportCount: 0, voucherRef: null, voucherDate: null, exceptionReason: null, recordId: null },
    files: { count: 0, links: [] },
    original: { what: 'bank_proof', state: 'missing', since: '2026-11-09', ownerRole: 'accounts', ownerName: 'Synthetic Accounts 1' },
    can: { match: false, exception: false, reopen: false, linkTask: false },
  }),
  row(3, {
    kind: 'supplier_payment',
    reference: 'SP-2026-000041',
    department: 'purchase',
    serviceLabel: 'Hotel 1',
    supplierId: SUP_HOTEL,
    supplierName: 'Sample Lake Palace Hotel',
    amountPaise: '4800000',
    direction: 'out',
    statusCode: 'verified',
    tally: { status: 'exported', rowVersion: 2, recordKind: 'supplier_payment', changedSinceExport: true, lastExportedAt: '2026-11-05T10:00:00Z', exportCount: 1, voucherRef: null, voucherDate: null, exceptionReason: null, recordId: null },
    files: { count: 2, links: [{ kind: 'supplier_money', evidenceId: id(731), fileName: 'synthetic-transfer-slip.pdf' }] },
    link: { kind: 'supplier_payment', id: id(3), ref: 'SP-2026-000041' },
    can: { match: true, exception: true, reopen: false, linkTask: false },
  }),
  row(4, {
    kind: 'supplier_invoice',
    reference: 'SYN/INV/2026/118',
    recordDate: '2026-11-07',
    department: 'purchase',
    serviceLabel: 'Hotel 1',
    supplierId: SUP_HOTEL,
    supplierName: 'Sample Lake Palace Hotel',
    otherReferences: ['Linked to 2 tasks'],
    amountPaise: '9600000',
    direction: 'bill',
    statusCode: 'accepted',
    reviewStatus: 'done',
    tally: { status: 'matched', rowVersion: 3, recordKind: 'supplier_document', changedSinceExport: false, lastExportedAt: '2026-11-08T09:00:00Z', exportCount: 1, voucherRef: 'PUR/2611/0042', voucherDate: '2026-11-08', exceptionReason: null, recordId: null },
    files: { count: 1, links: [{ kind: 'supplier_money', evidenceId: id(741), fileName: 'synthetic-hotel-invoice.pdf' }] },
    link: { kind: 'supplier_document', id: id(4) },
    can: { match: false, exception: true, reopen: true, linkTask: true },
  }),
  row(5, {
    kind: 'expense',
    reference: 'Visa fee · SYN-JOD-104',
    dealReference: 'SYN-JOD-104',
    department: 'visa',
    serviceLabel: 'Visa 1',
    amountPaise: '650000',
    direction: 'out',
    statusCode: 'accepted',
    tally: { status: 'exception', rowVersion: 4, recordKind: 'expense', changedSinceExport: false, lastExportedAt: '2026-11-06T09:00:00Z', exportCount: 1, voucherRef: null, voucherDate: null, recordId: null, exceptionReason: 'Tally shows ₹6,800 for this fee; the receipt says ₹6,500 (synthetic).' },
    files: { count: 0, links: [] },
    original: { what: 'fee_receipt', state: 'missing', since: '2026-11-04', ownerRole: 'visa', ownerName: 'Synthetic Visa Jodhpur' },
    link: { kind: 'accounts_deal', id: id(505) },
    can: { match: false, exception: false, reopen: true, linkTask: false },
  }),
  row(6, {
    kind: 'flight_ticket_batch',
    reference: 'Tickets batch 1 · SYN-JOD-102',
    dealReference: 'SYN-JOD-102',
    otherReferences: ['PNR SYNAB1', '176-2410394501 – 176-2410394504'],
    department: 'flight',
    serviceLabel: 'Flight 1',
    supplierId: SUP_AIR,
    supplierName: 'Sample Air Portal',
    amountPaise: '3360000',
    direction: 'info',
    statusCode: 'confirmed',
    reviewStatus: 'not_needed',
    tally: { status: 'not_applicable', rowVersion: 0, recordKind: null, changedSinceExport: false, lastExportedAt: null, exportCount: 0, voucherRef: null, voucherDate: null, exceptionReason: null, recordId: null },
    files: { count: 0, links: [] },
    original: { what: 'airline_bill', state: 'expected', since: '2026-11-04', ownerRole: 'flight', ownerName: 'Synthetic Flight Jodhpur' },
    link: { kind: 'accounts_deal', id: id(502) },
    can: { match: false, exception: false, reopen: false, linkTask: false },
  }),
  row(7, {
    kind: 'claim',
    reference: 'Reported payment · SYN-JOD-103',
    dealReference: 'SYN-JOD-103',
    amountPaise: '1000000',
    direction: 'info',
    statusCode: 'reported',
    stage: 'open',
    reviewStatus: 'waiting',
    tally: { status: 'not_applicable', rowVersion: 0, recordKind: null, changedSinceExport: false, lastExportedAt: null, exportCount: 0, voucherRef: null, voucherDate: null, exceptionReason: null, recordId: null },
    files: { count: 1, links: [] },
    link: { kind: 'claim', id: id(7) },
    can: { match: false, exception: false, reopen: false, linkTask: false },
  }),
  row(8, {
    kind: 'cash_deposit',
    reference: 'Cash deposit · Jodhpur',
    dealId: null,
    dealReference: null,
    bitrixDealId: null,
    department: 'accounts',
    amountPaise: '1500000',
    direction: 'contra',
    statusCode: 'verified',
    tally: { status: 'ready', rowVersion: 0, recordKind: 'journal_entry', changedSinceExport: false, lastExportedAt: null, exportCount: 0, voucherRef: null, voucherDate: null, exceptionReason: null, recordId: null },
    files: { count: 1, links: [{ kind: 'finance', evidenceId: id(781), fileName: 'synthetic-deposit-slip.jpg' }] },
    link: { kind: 'cash', id: id(8) },
  }),
  row(9, {
    kind: 'tally_gst_invoice',
    reference: 'HC/2026-27/0117',
    amountPaise: null,
    direction: 'info',
    statusCode: 'active',
    reviewStatus: 'not_needed',
    tally: { status: 'matched', rowVersion: 1, recordKind: 'tally_gst_invoice', changedSinceExport: false, lastExportedAt: null, exportCount: 0, voucherRef: 'HC/2026-27/0117', voucherDate: '2026-11-02', exceptionReason: null, recordId: null },
    files: { count: 0, links: [] },
    can: { match: false, exception: true, reopen: false, linkTask: false },
  }),
];

export const PAGE: RecordsPage = { scope: { mode: 'accounts', readOnly: false }, items: ROWS, nextAfter: '2026-11-07|2026-11-07T06:30:00Z|receipt|x', hasMore: true };
export const MANAGER_PAGE: RecordsPage = {
  scope: { mode: 'manager', readOnly: true },
  items: ROWS.map((r) => ({ ...r, link: r.dealId ? { kind: 'deal_dues' as const, id: r.dealId } : { kind: 'none' as const, id: null }, tally: { ...r.tally, voucherRef: null, exceptionReason: null }, can: { match: false, exception: false, reopen: false, linkTask: false }, files: { count: r.files.count, links: [] } })),
  nextAfter: null,
  hasMore: false,
};
export const MORE_PAGE: RecordsPage = {
  scope: { mode: 'accounts', readOnly: false },
  items: [row(21, { reference: 'R-2026-27-000021', recordDate: '2026-11-03', dealReference: 'SYN-JOD-090' }), row(22, { reference: 'R-2026-27-000022', recordDate: '2026-11-02', dealReference: 'SYN-JOD-089' })],
  nextAfter: null,
  hasMore: false,
};
export const SEARCH_PAGE: RecordsPage = { scope: { mode: 'accounts', readOnly: false }, items: [ROWS[5]!, { ...ROWS[5]!, rowId: 'flight_ticket_batch:x2', recordId: id(66), reference: 'Tickets batch 1 · SYN-DEL-020', dealReference: 'SYN-DEL-020', branchName: 'Delhi' }], nextAfter: null, hasMore: false };

export const TOTALS: RecordsTotals = {
  count: 214,
  byKind: [
    { kind: 'receipt', count: 96, inPaise: '184500000', outPaise: '0' },
    { kind: 'receipt_reversal', count: 2, inPaise: '0', outPaise: '3500000' },
    { kind: 'supplier_payment', count: 61, inPaise: '0', outPaise: '128900000' },
    { kind: 'supplier_invoice', count: 40, inPaise: '0', outPaise: '0' },
    { kind: 'expense', count: 15, inPaise: '0', outPaise: '9750000' },
  ],
};

export const DAILY: DailyCheck = {
  exceptionOwner: { userId: id(990), name: 'Synthetic Accounts 2', isYou: false, set: true },
  exceptionsOpen: { count: 1, oldestAt: '2026-11-06T09:00:00Z' },
  changedAfterExport: 1,
  originalsMissing: 3,
  receiptsAwaitingVerificationOverOneWorkingDay: 2,
  paymentsApprovedNotRecordedOverOneWorkingDay: 0,
  urgentNoticesUnopenedOverOneWorkingDay: [{ branchName: 'Jodhpur', count: 1 }],
  filters: {
    exceptionsOpen: { tallyStatus: 'exception' },
    changedAfterExport: { changedSinceExport: true },
    originalsMissing: { kinds: ['original'], originals: 'missing' },
    receiptsAwaitingVerificationOverOneWorkingDay: { overdueCheck: 'receipts_unverified' },
    paymentsApprovedNotRecordedOverOneWorkingDay: { overdueCheck: 'payments_unrecorded' },
  },
};
export const DAILY_NO_OWNER: DailyCheck = { ...DAILY, exceptionOwner: { userId: null, name: null, isYou: false, set: false } };

export const SUPPLIERS = [
  { id: SUP_HOTEL, name: 'Sample Lake Palace Hotel' },
  { id: SUP_AIR, name: 'Sample Air Portal' },
];
export const BRANCHES = [
  { id: BR_JOD, name: 'Jodhpur' },
  { id: BR_DEL, name: 'Delhi' },
];

/* ---------- dues ---------- */

function dues(n: number, over: Partial<DuesRow>): DuesRow {
  return {
    dealId: id(600 + n),
    dealReference: `SYN-JOD-${100 + n}`,
    branchName: 'Jodhpur',
    ownerName: 'Synthetic Sales Jodhpur',
    basis: { versionNo: 2, kind: 'approved', newerVersionPending: false, provisional: false, lastApprovedAt: '2026-10-20T10:00:00Z' },
    reported: false,
    totalPaise: '18000000',
    verifiedPaise: '6000000',
    balancePaise: '12000000',
    overduePaise: '0',
    dueNowPaise: '0',
    nextDue: { date: '2026-11-20', openPaise: '6000000' },
    reportedPaise: '0',
    awaitingVerificationPaise: '0',
    creditPaise: '0',
    status: 'upcoming',
    cancellation: null,
    ...over,
  };
}
export const DUES_ROWS: DuesRow[] = [
  dues(1, { status: 'overdue', overduePaise: '6000000', nextDue: { date: '2026-11-05', openPaise: '6000000' }, reportedPaise: '2000000', reported: true }),
  dues(2, { status: 'due_now', dueNowPaise: '4000000', nextDue: { date: '2026-11-10', openPaise: '4000000' }, basis: { versionNo: 3, kind: 'approved', newerVersionPending: true, provisional: false, lastApprovedAt: '2026-10-28T10:00:00Z' } }),
  dues(3, { status: 'upcoming', basis: { versionNo: 1, kind: 'awaiting_review', newerVersionPending: false, provisional: true, lastApprovedAt: null }, awaitingVerificationPaise: '1500000' }),
  dues(4, { status: 'unallocated', nextDue: null, verifiedPaise: '5000000', balancePaise: '13000000' }),
  dues(5, { status: 'credit', verifiedPaise: '18500000', balancePaise: '0', creditPaise: '500000', nextDue: null, cancellation: 'open' }),
  dues(6, { status: 'paid', verifiedPaise: '18000000', balancePaise: '0', nextDue: null, branchName: 'Delhi' }),
];

export const DEAL_DUES: DealDues = {
  ...DUES_ROWS[0]!,
  writeOff: null,
  writeOffNeedsReview: false,
  instalments: [
    { seq: 1, label: 'Advance', dueDate: '2026-10-25', amountPaise: '6000000', coveredPaise: '6000000', openPaise: '0', status: 'paid', partlyPaid: false },
    { seq: 2, label: 'Second payment', dueDate: '2026-11-05', amountPaise: '6000000', coveredPaise: '0', openPaise: '6000000', status: 'overdue', partlyPaid: false },
    { seq: 3, label: 'Balance before travel', dueDate: '2026-11-25', amountPaise: '6000000', coveredPaise: '0', openPaise: '6000000', status: 'upcoming', partlyPaid: false },
  ],
  tallyInvoices: [{ id: id(801), invoiceRef: 'HC/2026-27/0117', invoiceDate: '2026-11-02', status: 'active', tallyStatus: 'matched', rowVersion: 1 }],
  canAddTallyInvoice: true,
  viewer: 'accounts',
  supplierPayables: [
    { supplierId: SUP_HOTEL, supplierName: 'Sample Lake Palace Hotel', requestedLivePaise: '2000000', paidPaise: '4800000', verifiedPaise: '4800000', invoicedAcceptedPaise: '9600000', creditNotesAcceptedPaise: '0', invoicesUploadedPaise: '9600000' },
    { supplierId: SUP_AIR, supplierName: 'Sample Air Portal', requestedLivePaise: '0', paidPaise: '3360000', verifiedPaise: '0', invoicedAcceptedPaise: '0', creditNotesAcceptedPaise: '0', invoicesUploadedPaise: '0' },
  ],
};
export const DEAL_DUES_PROVISIONAL: DealDues = {
  ...DEAL_DUES,
  ...DUES_ROWS[2]!,
  instalments: [
    { seq: 1, label: 'Advance', dueDate: '2026-11-08', amountPaise: '9000000', coveredPaise: '6000000', openPaise: '3000000', status: 'overdue', partlyPaid: true },
    { seq: 2, label: 'Balance', dueDate: '2026-11-20', amountPaise: '9000000', coveredPaise: '0', openPaise: '9000000', status: 'upcoming', partlyPaid: false },
  ],
  tallyInvoices: [],
};
export const DEAL_DUES_NO_PLAN: DealDues = { ...DEAL_DUES, ...DUES_ROWS[3]!, instalments: [], tallyInvoices: [], supplierPayables: [] };

/* ---------- Tally ---------- */

export const TALLY_VIEW: TallyPageView = {
  exportEnabled: true,
  entities: [{ id: id(1), name: 'Holiday Chacha Pvt LTD' }],
  branches: BRANCHES,
  exports: [
    { exportId: id(851), exportNo: 'TE-2026-000011', createdAt: '2026-11-05T10:00:00Z', entityId: id(1), includeExported: false, branchNames: null, alreadyExportedCount: 4, fileName: 'tripnavigate-TE-2026-000011.csv', createdByName: 'Synthetic Accounts 1', periodFrom: '2026-10-01', periodTo: '2026-10-31', rowCount: 328, kinds: ['journal_entry', 'supplier_payment', 'supplier_document', 'expense'] },
    { exportId: id(852), exportNo: 'TE-2026-000010', createdAt: '2026-10-04T10:00:00Z', entityId: id(1), includeExported: false, branchNames: ['Jodhpur'], alreadyExportedCount: 0, fileName: 'tripnavigate-TE-2026-000010.csv', createdByName: 'Synthetic Accounts 2', periodFrom: '2026-09-01', periodTo: '2026-09-30', rowCount: 290, kinds: ['journal_entry'] },
  ],
  exceptions: [ROWS[4]!],
  daily: DAILY,
};

/* ---------- notices ---------- */

const minutesAgo = (m: number) => new Date(Date.parse('2026-11-10T08:00:00Z') - m * 60_000).toISOString();
function notice(seq: number, over: Partial<NoticeItem>): NoticeItem {
  return {
    noticeId: id(1000 + seq),
    seq,
    kind: 'task_new',
    priority: 'normal',
    escalated: false,
    createdAt: minutesAgo(100 - seq),
    readAt: null,
    doneAt: null,
    resolvedAt: null,
    resolvedReason: null,
    dealId: id(500),
    dealReference: 'SYN-JOD-101',
    taskId: id(400 + seq),
    department: 'purchase',
    params: { dealReference: 'SYN-JOD-101', department: 'purchase' },
    link: { kind: 'task', id: id(400 + seq) },
    ...over,
  };
}
export const NOTICES: NoticeItem[] = [
  notice(41, { kind: 'booking_changed', priority: 'urgent', createdAt: minutesAgo(3), params: { dealReference: 'SYN-JOD-101', versionNo: 3 } }),
  notice(40, { kind: 'trip_cancelled', priority: 'urgent', createdAt: minutesAgo(12), dealReference: 'SYN-JOD-099', params: { dealReference: 'SYN-JOD-099' } }),
  notice(39, { kind: 'payment_decided', dealReference: 'SYN-JOD-103', params: { dealReference: 'SYN-JOD-103', refNo: 'SP-2026-000041', status: 'approved' }, link: { kind: 'task', id: id(441) }, createdAt: minutesAgo(20) }),
  notice(38, { kind: 'go_ahead_decided', dealReference: 'SYN-JOD-103', params: { dealReference: 'SYN-JOD-103', status: 'approved' }, createdAt: minutesAgo(24) }),
  notice(37, { kind: 'supplier_bill_returned', dealReference: 'SYN-JOD-103', params: { dealReference: 'SYN-JOD-103' }, createdAt: minutesAgo(27) }),
  notice(36, { kind: 'task_assigned', dealReference: 'SYN-JOD-102', params: { dealReference: 'SYN-JOD-102', department: 'purchase' }, createdAt: minutesAgo(60) }),
  notice(35, { kind: 'task_new', dealReference: 'SYN-DEL-020', params: { dealReference: 'SYN-DEL-020', department: 'purchase' }, createdAt: minutesAgo(90), readAt: minutesAgo(80), doneAt: minutesAgo(80) }),
];
export const INBOX: NoticeInbox = { enabled: true, unreadCount: 6, urgentCount: 2, latestSeq: 41, soundOn: false, items: NOTICES };
export const INBOX_EMPTY: NoticeInbox = { enabled: true, unreadCount: 0, urgentCount: 0, latestSeq: 12, soundOn: false, items: [] };
export const INBOX_ACCOUNTS: NoticeInbox = {
  enabled: true,
  unreadCount: 3,
  urgentCount: 1,
  latestSeq: 77,
  soundOn: true,
  items: [
    notice(77, { kind: 'receipt_to_verify', escalated: true, department: null, params: { dealReference: 'SYN-JOD-105', refNo: 'R-2026-27-000077' }, dealReference: 'SYN-JOD-105', link: { kind: 'accounts_deal', id: id(605) }, createdAt: minutesAgo(1600) }),
    notice(76, { kind: 'payment_to_record', department: null, params: { refNo: 'SP-2026-000043' }, dealReference: 'SYN-JOD-105', link: { kind: 'supplier_payment', id: id(43) }, createdAt: minutesAgo(15) }),
    notice(75, { kind: 'tally_exception', department: null, params: { dealReference: 'SYN-JOD-104', status: 'expense' }, dealReference: 'SYN-JOD-104', link: { kind: 'workspace_row', id: id(5) }, createdAt: minutesAgo(30) }),
  ],
};
export const HISTORY: NoticeHistory = {
  enabled: true,
  items: [
    notice(30, { kind: 'task_new', readAt: minutesAgo(600), doneAt: minutesAgo(600), resolvedAt: minutesAgo(590), resolvedReason: 'taken', createdAt: minutesAgo(700), dealReference: 'SYN-JOD-095', params: { dealReference: 'SYN-JOD-095', department: 'purchase' } }),
    notice(29, { kind: 'booking_changed', priority: 'urgent', readAt: minutesAgo(1500), doneAt: minutesAgo(1500), createdAt: minutesAgo(1600), dealReference: 'SYN-JOD-090', params: { dealReference: 'SYN-JOD-090' } }),
  ],
  nextBefore: null,
};

/* ---------- Purchase booking change ---------- */

export const BOOKING_CHANGE: PurchaseBookingChangeView = {
  taskId: id(450),
  basisVersionId: id(460),
  basisVersionNo: 2,
  currentVersionId: id(461),
  currentVersionNo: 3,
  changedAt: '2026-11-10T06:00:00Z',
  canAck: true,
  fields: [
    { key: 'checkIn', label: 'Check-in', before: '25 Nov 2026', after: '26 Nov 2026' },
    { key: 'rooms', label: 'Rooms', before: '1', after: '2' },
    { key: 'mealPlan', label: 'Meal plan', before: 'Breakfast', after: 'Breakfast and dinner' },
  ],
  travellers: { added: [{ seq: 4, name: 'Sample Traveller D', type: 'child' }], removed: [], renamed: [{ seq: 2, before: 'Sample Travler B', after: 'Sample Traveller B' }], typeChanged: [] },
  tripChanged: { end: { before: '30 Nov 2026', after: '1 Dec 2026' } },
  budgetChanged: true,
};
