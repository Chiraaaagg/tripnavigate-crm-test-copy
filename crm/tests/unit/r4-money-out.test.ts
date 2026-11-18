import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AccountsGoAheadRow } from '@/modules/procurement/contracts';
import type { AccountsSupplierDocumentsView, AccountsSupplierPaymentRow, CompanyFundingRow } from '@/modules/supplier-money/contracts';
import type { AccountsSectionViewer } from '@/views/accounts-desk/sections';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { AccountsCompanyFundingPage, FUNDING_LIMIT_TEXT, FUNDING_TABS, parseFundingTab } from '@/views/accounts/supplier-funding';
import { AccountsGoAheadPage, GO_AHEAD_TABS, parseGoAheadTab } from '@/views/accounts/supplier-go-ahead';
import { AccountsSupplierInvoicesPage, DOCUMENT_TABS, parseDocumentTab } from '@/views/accounts/supplier-invoices';
import { ACCOUNTS_PAYMENT_TABS, AccountsSupplierPaymentsPage, PAYMENT_LIMIT_TEXT, parsePaymentTab } from '@/views/accounts/supplier-payments';

/*
 * Redesign R4, helper A2 (design plan A7, build plan 4.7): Accounts · Money
 * out lists. Approval rows carry Approve and "Return with reason" on the
 * row; a request routed to the branch Manager (above ₹50,000) shows "Needs
 * the branch Manager" and no Approve to Accounts; the ₹50,000 rule is said
 * once per page; the Money out tab strip sits under the header; every old
 * `?tab=` address keeps its meaning. Who may decide stays with the database:
 * the screen only follows canDecide / canReview and the route per row.
 * Synthetic values only.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const noop = (async () => ({ ok: true, message: 'ok' })) as unknown as DecisionAction;
const ACCOUNTS: AccountsSectionViewer = { canUseAccounts: true, canCheckCustomers: true, canSeeAccountsDesk: true, canSeeBranchMoney: false, canSeeOwnDues: false };

/** The HTML of the one card (article) that mentions `text`. */
function card(html: string, text: string): string {
  const cards = html.split('<article').slice(1).filter((c) => c.includes(text));
  expect(cards, `exactly one card mentions ${text}`).toHaveLength(1);
  return cards[0]!;
}
const count = (html: string, text: string) => html.split(text).length - 1;
/**
 * A blocked decision button (R3 review P3-6): focusable but inert, so aria-disabled="true" on a plain
 * type="button" (never a submit) that sits in no form. Returns the button's markup.
 */
function inertButton(html: string, label: string): string {
  const match = html.match(new RegExp(`<button(?=[^>]*aria-disabled="true")[^>]*>(?:(?!</button>).)*?${label}(?:(?!</button>).)*</button>`));
  expect(match, `${label} is an aria-disabled button`).not.toBeNull();
  const button = match![0];
  expect(button).toMatch(/^<button type="button"/);
  const before = html.slice(0, match!.index);
  expect(count(before, '<form') - count(before, '</form>'), `${label} sits in no form`).toBe(0);
  return button;
}

const payment = (over: Partial<AccountsSupplierPaymentRow> = {}): AccountsSupplierPaymentRow => ({
  department: 'purchase',
  flightBatchNo: null,
  id: uuid(31),
  refNo: 'SP-2026-000941',
  dealId: uuid(11),
  dealReference: 'SYN-R4-001',
  branchName: 'Jodhpur',
  taskId: uuid(21),
  serviceTitle: 'Synthetic Lakeside Hotel, Udaipur',
  serviceType: 'hotel',
  supplierId: uuid(41),
  supplierName: 'Synthetic Stays (example)',
  part: 'deposit',
  amountPaise: '2100000',
  customerMoneyPaise: '2100000',
  dueDate: '2026-11-25',
  note: null,
  route: 'accounts',
  status: 'pending',
  costVersionNo: 2,
  agreedCostPaise: '4200000',
  proformaEvidenceId: uuid(51),
  returnReason: null,
  requestedAt: '2026-11-17T07:00:00Z',
  requestedByName: 'Synthetic Purchase',
  decidedAt: null,
  decidedByName: null,
  paidOn: null,
  paymentMode: null,
  bankReference: null,
  paymentProofEvidenceId: null,
  bankRevisionNo: null,
  recordedAt: null,
  recordedByName: null,
  verifiedAt: null,
  verifiedByName: null,
  bankDetails: null,
  funding: null,
  onHold: false,
  holdReason: null,
  rowVersion: 1,
  canDecide: true,
  canRecord: false,
  canVerify: false,
  ...over,
});

const funding = (over: Partial<CompanyFundingRow> = {}): CompanyFundingRow => ({
  id: uuid(61),
  paymentRequestId: uuid(32),
  paymentRefNo: 'SP-2026-000942',
  paymentStatus: 'pending',
  dealId: uuid(12),
  dealReference: 'SYN-R4-002',
  branchName: 'Jodhpur',
  supplierName: 'Synthetic Dune Partners',
  serviceTitle: 'Synthetic Desert Camp, Jaisalmer',
  amountPaise: '2000000',
  reason: 'The camp releases the tents tomorrow unless paid.',
  route: 'accounts',
  status: 'pending',
  returnReason: null,
  requestedAt: '2026-11-17T07:10:00Z',
  requestedByName: 'Synthetic Purchase',
  decidedAt: null,
  decidedByName: null,
  recoveredAt: null,
  recoveredByName: null,
  recoveryNote: null,
  rowVersion: 1,
  canDecide: true,
  canMarkRecovered: false,
  ...over,
});

const goAhead = (over: Partial<AccountsGoAheadRow> = {}): AccountsGoAheadRow => ({
  requestId: uuid(1),
  status: 'pending',
  current: true,
  dealId: uuid(11),
  dealReference: 'SYN-R4-003',
  branchName: 'Jodhpur',
  taskId: uuid(21),
  itemTitle: 'Synthetic Fort Hotel, Jodhpur',
  checkIn: '2026-12-01',
  checkOut: '2026-12-03',
  supplierName: 'Synthetic Fort Partners',
  amountPaise: '3840000',
  costVersionNo: 2,
  requestedAt: '2026-11-17T06:10:00Z',
  requestedByName: 'Synthetic Purchase',
  decidedAt: null,
  decidedByName: null,
  returnReason: null,
  rowVersion: 1,
  bookingReviewStatus: 'approved',
  canDecide: true,
  contractState: 'none',
  contractTotalPaise: null,
  contractDeviationReason: null,
  ...over,
});

const paymentsPage = (rows: AccountsSupplierPaymentRow[], viewer: AccountsSectionViewer | null = ACCOUNTS) =>
  renderToStaticMarkup(
    createElement(AccountsSupplierPaymentsPage, { rows, tab: 'to_approve', today: '2026-11-18', actions: { decide: noop, record: noop, upload: noop, verify: noop }, sectionViewer: viewer ?? undefined }),
  );

describe('old addresses keep their tab (?tab= values)', () => {
  it('every tab value that works today opens the same tab; anything else opens the default', () => {
    for (const t of ACCOUNTS_PAYMENT_TABS) expect(parsePaymentTab(t)).toBe(t);
    for (const t of FUNDING_TABS) expect(parseFundingTab(t)).toBe(t);
    for (const t of DOCUMENT_TABS) expect(parseDocumentTab(t)).toBe(t);
    for (const t of GO_AHEAD_TABS) expect(parseGoAheadTab(t)).toBe(t);
    expect([parsePaymentTab(undefined), parsePaymentTab('nope'), parsePaymentTab('To_Record')]).toEqual(['to_approve', 'to_approve', 'to_approve']);
    expect([parseFundingTab(undefined), parseFundingTab('approved')]).toEqual(['to_approve', 'to_approve']);
    expect([parseDocumentTab(undefined), parseDocumentTab('to_check')]).toEqual(['to_review', 'to_review']);
    expect([parseGoAheadTab(undefined), parseGoAheadTab('pending')]).toEqual(['to_check', 'to_check']);
  });

  it('a value given twice uses the first, as the browser does', () => {
    expect(parsePaymentTab(['to_verify', 'all'])).toBe('to_verify');
    expect(parseFundingTab(['to_recover'])).toBe('to_recover');
  });

  it('filter tab links are the same addresses as before', () => {
    const html = paymentsPage([]);
    expect(html).toContain('href="/app/accounts/supplier-payments"');
    expect(html).toContain('href="/app/accounts/supplier-payments?tab=to_record"');
    expect(html).toContain('href="/app/accounts/supplier-payments?tab=to_verify"');
    expect(html).toContain('href="/app/accounts/supplier-payments?tab=all"');
  });
});

describe('Supplier payments: approval rows', () => {
  it('Approve and "Return with reason" on the row, each named with the request; the reason box opens only in the dialog', () => {
    const html = paymentsPage([payment()]);
    const row = card(html, 'SP-2026-000941');
    expect(row).toMatch(/Approve payment<span class="sr-only"> SP-2026-000941<\/span>/);
    expect(row).toMatch(/Return with reason<span class="sr-only"> SP-2026-000941<\/span>/);
    // The old form kept a reason box open on every row; now nothing asks for a reason until Return is pressed.
    expect(row).not.toContain('name="reason"');
    expect(row).not.toContain('Reason for returning');
    // The same fields the action reads today.
    expect(row).toContain(`name="paymentId" value="${uuid(31)}"`);
    expect(row).toContain('name="expectedRowVersion" value="1"');
    expect(row).toContain('name="decision" value="approve"');
    expect(row).toMatch(/name="requestId" value="[0-9a-f-]{36}"/);
  });

  it('above ₹50,000 (routed to the branch Manager): "Needs the branch Manager" and no Approve or Return for Accounts', () => {
    const html = paymentsPage([payment(), payment({ id: uuid(39), refNo: 'SP-2026-000950', amountPaise: '7500000', route: 'manager', canDecide: false })]);
    const row = card(html, 'SP-2026-000950');
    expect(row).toContain('Needs the branch Manager.');
    expect(row).not.toContain('Approve payment');
    expect(row).not.toContain('Return with reason');
    expect(row).not.toContain('name="decision"');
    // The request Accounts may decide keeps its Approve.
    expect(card(html, 'SP-2026-000941')).toContain('Approve payment');
  });

  it('a Manager-routed request the viewer may decide (the read says so) shows Approve: the data decides, not the amount', () => {
    const row = card(paymentsPage([payment({ route: 'manager', amountPaise: '7500000', canDecide: true })]), 'SP-2026-000941');
    expect(row).toContain('Approve payment');
    expect(row).not.toContain('Needs the branch Manager');
  });

  it('own request: both buttons shown disabled with the reason; nothing posts', () => {
    const row = card(paymentsPage([payment({ canDecide: false })]), 'SP-2026-000941');
    inertButton(row, 'Approve payment');
    expect(row).toContain('Nobody approves their own request.');
    expect(row).not.toContain('<form');
  });

  it('says the ₹50,000 rule once on the page, not on every row', () => {
    const rows = [payment(), payment({ id: uuid(33), refNo: 'SP-2026-000943' }), payment({ id: uuid(39), refNo: 'SP-2026-000950', route: 'manager', canDecide: false })];
    const html = paymentsPage(rows);
    expect(count(html, '₹50,000')).toBe(1);
    expect(html).toContain(PAYMENT_LIMIT_TEXT);
    // Also on an empty list (the rule explains the page, not a row).
    expect(count(paymentsPage([]), '₹50,000')).toBe(1);
  });

  it('a returned or verified request has no decision row', () => {
    const html = paymentsPage([payment({ status: 'returned', canDecide: false, returnReason: 'Wrong stay dates on the proforma (synthetic).' })]);
    expect(html).not.toContain('Approve payment');
    expect(html).not.toContain('Needs the branch Manager');
  });

  it('recorder of a payment sees Verify unavailable with the reason; a colleague gets the button', () => {
    const paid = { status: 'paid' as const, canDecide: false, paidOn: '2026-11-17', paymentMode: 'bank_transfer' as const, bankReference: 'SYNUTR1', recordedAt: '2026-11-17T08:00:00Z', recordedByName: 'Synthetic Accounts A' };
    const own = card(paymentsPage([payment({ ...paid, canVerify: false })]), 'SP-2026-000941');
    expect(own).toMatch(/aria-disabled="true"[^>]*>Mark payment verified/);
    expect(own).toContain('You recorded this payment, so another Accounts person verifies it.');
    expect(card(paymentsPage([payment({ ...paid, canVerify: true })]), 'SP-2026-000941')).toContain('Mark payment verified');
  });
});

describe('Money out tab strip under the header', () => {
  it('shows the five Money out pages for an Accounts person, the current one marked; none without the menu flags', () => {
    const html = paymentsPage([]);
    expect(html).toContain('aria-label="Money out sections"');
    for (const href of ['/app/accounts/go-ahead', '/app/accounts/supplier-invoices', '/app/accounts/funding', '/app/accounts/expenses']) expect(html).toContain(`href="${href}"`);
    expect(html).toMatch(/href="\/app\/accounts\/supplier-payments"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/app\/accounts\/supplier-payments"/);
    // After the page heading.
    expect(html.indexOf('<h1')).toBeLessThan(html.indexOf('Money out sections'));
    expect(paymentsPage([], null)).not.toContain('Money out sections');
    expect(paymentsPage([], { ...ACCOUNTS, canUseAccounts: false })).not.toContain('Money out sections');
  });

  it('go-ahead: the waiting count the page already loads; no other tab gets a count', () => {
    const html = renderToStaticMarkup(
      createElement(AccountsGoAheadPage, { rows: [goAhead(), goAhead({ requestId: uuid(2), status: 'approved', canDecide: false })], tab: 'to_check', decideAction: noop, sectionViewer: ACCOUNTS }),
    );
    const strip = html.slice(html.indexOf('Money out sections'), html.indexOf('</nav>', html.indexOf('Money out sections')));
    expect(strip).toContain('Hotel go-ahead');
    expect(strip).toMatch(/Hotel go-ahead.*?1/s);
    expect(strip).not.toContain('count not known');
  });
});

describe('Company funding: approval rows', () => {
  const page = (rows: CompanyFundingRow[]) =>
    renderToStaticMarkup(createElement(AccountsCompanyFundingPage, { rows, tab: 'to_approve', actions: { decide: noop, recover: noop }, sectionViewer: ACCOUNTS }));

  it('Approve company funding on the row; above ₹50,000 "Needs the branch Manager" with no Approve; the rule once', () => {
    const html = page([funding(), funding({ id: uuid(62), paymentRefNo: 'SP-2026-000948', amountPaise: '7500000', route: 'manager', canDecide: false })]);
    expect(card(html, 'SP-2026-000942')).toMatch(/Approve company funding<span class="sr-only"> company funding for payment SP-2026-000942<\/span>/);
    const manager = card(html, 'SP-2026-000948');
    expect(manager).toContain('Needs the branch Manager.');
    expect(manager).not.toContain('Approve company funding');
    expect(count(html, '₹50,000')).toBe(1);
    expect(html).toContain(FUNDING_LIMIT_TEXT);
    expect(html).toContain(`name="fundingId" value="${uuid(61)}"`);
  });
});

describe('Hotel go-ahead: approval rows', () => {
  const page = (rows: AccountsGoAheadRow[]) => renderToStaticMarkup(createElement(AccountsGoAheadPage, { rows, tab: 'to_check', decideAction: noop }));

  it('Give go-ahead on the row with the same fields; booking review not approved: Give go-ahead disabled with the reason, Return still possible', () => {
    const ok = card(page([goAhead()]), 'SYN-R4-003');
    expect(ok).toMatch(/Give go-ahead<span class="sr-only"> SYN-R4-003, Synthetic Fort Hotel, Jodhpur<\/span>/);
    expect(ok).toContain(`name="goAheadRequestId" value="${uuid(1)}"`);
    expect(ok).toContain('name="rowVersion" value="1"');
    const blocked = card(page([goAhead({ bookingReviewStatus: 'pending' })]), 'SYN-R4-003');
    inertButton(blocked, 'Give go-ahead');
    expect(blocked).toContain('Return with reason');
  });

  it('own request: disabled with the reason', () => {
    const own = card(page([goAhead({ canDecide: false })]), 'SYN-R4-003');
    expect(own).toContain('Nobody approves their own request.');
    expect(own).not.toContain('<form');
  });
});

describe('Supplier invoices: approval rows', () => {
  const view = (canReview: boolean): AccountsSupplierDocumentsView => ({
    documents: [
      {
        id: uuid(71),
        kind: 'invoice',
        taskId: uuid(21),
        dealReference: 'SYN-R4-004',
        serviceTitle: 'Synthetic Lakeside Hotel, Udaipur',
        supplierId: uuid(41),
        supplierName: 'Synthetic Stays (example)',
        number: 'SYN-INV-9001',
        docDate: '2026-11-15',
        totalPaise: '4200000',
        gstIncluded: true,
        evidenceId: uuid(54),
        status: 'uploaded',
        returnReason: null,
        uploadedAt: '2026-11-16T06:00:00Z',
        uploadedByName: 'Synthetic Purchase',
        reviewedAt: null,
        reviewedByName: null,
        rowVersion: 1,
        branchName: 'Jodhpur',
        canReview,
        department: 'purchase',
      },
    ],
    missingInvoices: [],
  });
  const page = (canReview: boolean) =>
    renderToStaticMarkup(createElement(AccountsSupplierInvoicesPage, { view: view(canReview), tab: 'to_review', reviewAction: noop, sectionViewer: ACCOUNTS }));

  it('Accept document posts "accept" with the same fields; own upload is disabled with the reason', () => {
    const row = card(page(true), 'SYN-INV-9001');
    expect(row).toMatch(/Accept document<span class="sr-only"> supplier invoice SYN-INV-9001<\/span>/);
    expect(row).toContain('name="decision" value="accept"');
    expect(row).toContain(`name="documentId" value="${uuid(71)}"`);
    const own = card(page(false), 'SYN-INV-9001');
    expect(own).toContain('Nobody checks their own upload.');
    expect(own).not.toContain('<form');
  });
});
