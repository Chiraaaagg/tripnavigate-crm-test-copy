import type { CustomerDocumentContent, DealDocs, DocDetail, DocListRow, DocRow, TallyInvoiceOption } from '@/views/customer-documents/types';

/*
 * Synthetic fixtures for the customer documents preview states (acc2-docs-):
 * one Bitrix-linked Deal (number prefix 10101), a verified payment ready for
 * an Advance Invoice, an Invoice draft from approved booking version 2, a
 * released ADV, a replaced and a released Invoice, a cancelled Credit Note.
 * Names, references and amounts are invented; nothing here is real.
 */

export const DEAL_ID = 'a0002101-0000-4000-8000-000000002101';
const sha = (c: string) => c.repeat(64).slice(0, 64);
const can = (over: Partial<DocRow['can']> = {}): DocRow['can'] => ({ refresh: false, release: false, discard: false, cancel: false, replace: false, linkTally: false, retryPdf: false, download: false, printView: false, ...over });

function doc(id: number, over: Partial<DocRow>): DocRow {
  return {
    documentId: `a0002${String(200 + id)}-0000-4000-8000-000000002${String(200 + id)}`,
    kind: 'invoice',
    title: 'Invoice',
    number: null,
    status: 'draft',
    totalPaise: '18500000',
    issueDate: null,
    createdAt: '2026-11-12T05:30:00Z',
    releasedAt: null,
    releasedByName: null,
    rowVersion: 1,
    contentSha256: sha(String(id % 10)),
    stale: false,
    bookingChangedSinceRelease: false,
    paymentReversed: false,
    pdf: { state: 'none', fileId: null },
    tallyLinked: false,
    gstInvoiceNumber: null,
    replacesNumber: null,
    replacedByNumber: null,
    endReason: null,
    warnings: [],
    can: can(),
    screenPdf: 'none',
    ...over,
  };
}

const RELEASED_CAN = can({ download: true, printView: true, cancel: true, replace: true, linkTally: true, retryPdf: true });

export const ADV_RELEASED = doc(1, {
  kind: 'advance_invoice',
  title: 'Advance Invoice',
  number: '10101-ADV-1',
  status: 'released',
  totalPaise: '5000000',
  issueDate: '2026-11-05',
  releasedAt: '2026-11-05T09:10:00Z',
  releasedByName: 'Synthetic Accounts 1',
  pdf: { state: 'ready', fileId: 'a0002301-0000-4000-8000-000000002301' },
  screenPdf: 'ready',
  can: RELEASED_CAN,
});
export const INV_REPLACED = doc(2, {
  number: '10101-INV-1',
  status: 'replaced',
  issueDate: '2026-11-06',
  releasedAt: '2026-11-06T10:00:00Z',
  releasedByName: 'Synthetic Accounts 2',
  replacedByNumber: '10101-INV-2',
  endReason: 'Booking revised: one more room added by the customer.',
  pdf: { state: 'ready', fileId: 'a0002302-0000-4000-8000-000000002302' },
  screenPdf: 'ready',
  can: can({ download: true, printView: true }),
});
export const INV_RELEASED = doc(3, {
  number: '10101-INV-2',
  status: 'released',
  totalPaise: '21500000',
  issueDate: '2026-11-10',
  releasedAt: '2026-11-10T11:20:00Z',
  releasedByName: 'Synthetic Accounts 1',
  replacesNumber: '10101-INV-1',
  gstInvoiceNumber: 'HC/26-27/0412',
  tallyLinked: true,
  pdf: { state: 'queued', fileId: null },
  screenPdf: 'off',
  can: RELEASED_CAN,
});
export const CN_CANCELLED = doc(4, {
  kind: 'credit_note',
  title: 'Credit Note',
  number: '10101-CN-1',
  status: 'cancelled',
  totalPaise: '1500000',
  issueDate: '2026-11-11',
  releasedAt: '2026-11-11T08:00:00Z',
  releasedByName: 'Synthetic Accounts 2',
  endReason: 'Raised against the wrong invoice by mistake.',
  pdf: { state: 'failed', fileId: null },
  screenPdf: 'failed',
  can: can({ printView: true, retryPdf: true }),
});
export const INV_DRAFT = doc(5, { kind: 'invoice', status: 'draft', totalPaise: '21500000', can: can({ release: true, discard: true, refresh: true, linkTally: true }), replacesNumber: null });
export const ADV_DRAFT = doc(6, { kind: 'advance_invoice', title: 'Advance Invoice', status: 'draft', totalPaise: '2500000', can: can({ release: true, discard: true, refresh: true }) });

export const TALLY_INVOICES: TallyInvoiceOption[] = [
  { id: 'a0002401-0000-4000-8000-000000002401', invoiceRef: 'HC/26-27/0412', invoiceDate: '2026-11-10' },
  { id: 'a0002402-0000-4000-8000-000000002402', invoiceRef: 'HC/26-27/0398', invoiceDate: '2026-11-04' },
];

export const DEAL_DOCS: DealDocs = {
  dealId: DEAL_ID,
  viewer: 'accounts',
  enabled: true,
  billing: { verified: true, missing: false },
  candidates: {
    advances: [{ receiptId: 'a0002501-0000-4000-8000-000000002501', receiptNo: 'R-2026-27-000123', amountPaise: '2500000', receivedOn: '2026-11-12' }],
    invoice: null,
    creditNotes: [],
  },
  documents: [INV_DRAFT, INV_RELEASED, INV_REPLACED, ADV_RELEASED, CN_CANCELLED],
};

/** Accounts, before anything was issued: an ADV and the Invoice are ready to make. */
export const DEAL_DOCS_FRESH: DealDocs = {
  ...DEAL_DOCS,
  candidates: {
    advances: [
      { receiptId: 'a0002501-0000-4000-8000-000000002501', receiptNo: 'R-2026-27-000123', amountPaise: '2500000', receivedOn: '2026-11-12' },
      { receiptId: 'a0002502-0000-4000-8000-000000002502', receiptNo: 'R-2026-27-000098', amountPaise: '5000000', receivedOn: '2026-11-05' },
    ],
    invoice: {
      basisVersionNo: 2,
      totalPaise: '21500000',
      lines: [
        { label: 'Air tickets — batch 1 (JDH–DEL–JDH)', amountPaise: '6200000' },
        { label: 'Air tickets — batch 2 (DEL–GOI)', amountPaise: '3100000' },
      ],
      warnings: ['flight_total_differs'],
    },
    creditNotes: [{ refundRequestId: 'a0002601-0000-4000-8000-000000002601', refNo: 'RF-2026-000014', amountPaise: '1500000' }],
  },
  documents: [],
};

export const SALES_DOCS: DealDocs = { ...DEAL_DOCS, viewer: 'sales', candidates: null, documents: [INV_RELEASED, INV_REPLACED, ADV_RELEASED, CN_CANCELLED].map((d) => ({ ...d, releasedByName: null, endReason: null, can: can({ download: d.can.download, printView: d.can.printView }) })) };
export const MANAGER_DOCS: DealDocs = { ...DEAL_DOCS, viewer: 'manager', candidates: null, documents: [INV_RELEASED, INV_REPLACED, ADV_RELEASED, CN_CANCELLED].map((d) => ({ ...d, can: can({ download: d.can.download, printView: d.can.printView }) })) };

export const CONTENT_INVOICE: CustomerDocumentContent = {
  schema: 'cdoc-1',
  kind: 'invoice',
  title: 'Invoice',
  number: null,
  issueDate: null,
  company: { legalName: 'Holiday Chacha Pvt LTD', registeredAddress: 'Synthetic Address 1, Sample Road, Jodhpur 342001', pan: 'AAACH0000A', gstin: '08AAACH0000A1Z5', gstinState: 'Rajasthan' },
  branch: { code: 'JOD', name: 'Jodhpur' },
  customer: { billingName: 'Sample Traveller Family', addressLine1: '12 Example Lane', addressLine2: null, city: 'Jodhpur', stateCode: '08', postalCode: '342001', gstin: null },
  deal: { reference: 'SYN-JOD-101', dealNumber: '10101' },
  trip: { destination: 'Udaipur', startDate: '2026-12-20', endDate: '2026-12-24', travellerCount: 4 },
  lines: [{ label: 'Holiday package — Udaipur', amountPaise: '21500000' }],
  totalPaise: '21500000',
  paidPaise: '7500000',
  balancePaise: '14000000',
  plan: [
    { label: 'Advance', dueDate: '2026-11-05', amountPaise: '5000000' },
    { label: 'Second instalment', dueDate: '2026-11-30', amountPaise: '8000000' },
    { label: 'Balance', dueDate: '2026-12-10', amountPaise: '8500000' },
  ],
  payment: null,
  credits: null,
  gstInvoiceNumber: null,
  replaces: { number: '10101-INV-1' },
};

export const CONTENT_ADV: CustomerDocumentContent = {
  ...CONTENT_INVOICE,
  kind: 'advance_invoice',
  title: 'Advance Invoice',
  lines: [{ label: 'Advance received', amountPaise: '2500000' }],
  totalPaise: '2500000',
  paidPaise: '2500000',
  balancePaise: undefined,
  plan: undefined,
  payment: { reference: 'R-2026-27-000123', receivedOn: '2026-11-12', mode: 'upi' },
  replaces: null,
};

export const DETAIL_RELEASED: DocDetail = { ...INV_RELEASED, dealId: DEAL_ID, viewer: 'accounts', content: { ...CONTENT_INVOICE, number: '10101-INV-2', issueDate: '2026-11-10', gstInvoiceNumber: null } };
export const DETAIL_CANCELLED: DocDetail = {
  ...CN_CANCELLED,
  dealId: DEAL_ID,
  viewer: 'manager',
  content: { ...CONTENT_INVOICE, kind: 'credit_note', title: 'Credit Note', number: '10101-CN-1', issueDate: '2026-11-11', lines: [{ label: 'Credit for cancelled hotel nights', amountPaise: '1500000' }], totalPaise: '1500000', paidPaise: '0', balancePaise: undefined, plan: undefined, credits: { number: '10101-INV-2', title: 'Invoice' }, replaces: null },
};

function listRow(d: DocRow, ref: string, branch = 'Jodhpur'): DocListRow {
  return { ...d, dealId: DEAL_ID, dealReference: ref, branchName: branch };
}
export const LIST_ROWS: DocListRow[] = [
  listRow(INV_DRAFT, 'SYN-JOD-101'),
  listRow({ ...ADV_DRAFT, stale: true }, 'SYN-JOD-117'),
  listRow(INV_RELEASED, 'SYN-JOD-101'),
  listRow({ ...ADV_RELEASED, documentId: 'a0002291-0000-4000-8000-000000002291', number: '10144-ADV-2', paymentReversed: true }, 'SYN-DEL-044', 'Delhi'),
  listRow({ ...INV_RELEASED, documentId: 'a0002292-0000-4000-8000-000000002292', number: 'BX-AHD-0031-INV-1', bookingChangedSinceRelease: true, gstInvoiceNumber: null, replacesNumber: null, screenPdf: 'ready' }, 'BX-AHD-0031', 'Ahmedabad'),
  listRow(INV_REPLACED, 'SYN-JOD-101'),
  listRow(CN_CANCELLED, 'SYN-JOD-101'),
];
