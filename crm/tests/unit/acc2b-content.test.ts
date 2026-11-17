import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  CustomerDocumentContentSchema,
  checkContent,
  contentTitle,
  dealLine,
  documentTitle,
  formatNumber,
  formatRupees,
  numberKind,
  type CustomerDocumentContent,
} from '@/modules/customer-documents/content';
import { DOCUMENT_ERROR_STATES, DOCUMENT_ERROR_TEXT, DOCUMENT_TITLES } from '@/modules/customer-documents/contracts';
import { BRANCHES, COMPANY_IDENTITY, companyGstinGapFor, companyIdentityFor } from '@/modules/documents/company-identity';
import { CustomerDocumentTemplate } from '@/modules/documents/render/customer-templates';
import { checkDocumentMarkup } from '@/modules/documents/render/checks';
import { forbiddenKeyPaths } from '@/modules/documents/guard';

/**
 * Accounts phase 2, Track B unit tests (contract 6.3-6.5, 9, 12.2): cdoc-1
 * content zod, number format and titles, rupee words, forbidden keys and the
 * safety scan, the customer template (no "not a tax invoice", Tally number
 * printed, Deal ID), the one company GSTIN for every branch (LD1) and its
 * SQL mirror.
 */

const line = companyIdentityFor('DEL');
const SAMPLE: CustomerDocumentContent = {
  schema: 'cdoc-1',
  kind: 'invoice',
  title: 'Invoice',
  number: '10101-INV-1',
  issueDate: '2026-11-12',
  company: { legalName: line.legalName, registeredAddress: line.registeredAddress, pan: line.pan, gstin: line.gstin, gstinState: line.gstinState },
  branch: { code: 'DEL', name: 'Delhi' },
  customer: { billingName: 'Synthetic Billing Name', addressLine1: '1 Synthetic Road', addressLine2: null, city: 'Delhi', stateCode: '07',
    postalCode: '110001', gstin: null },
  deal: { reference: 'BX-10101', dealNumber: '10101' },
  trip: { destination: 'Synthetic Goa', startDate: '2026-12-01', endDate: '2026-12-05', travellerCount: 2 },
  lines: [{ label: 'Holiday package — Synthetic Goa', amountPaise: '9123457' }],
  totalPaise: '9123457',
  paidPaise: '2500000',
  balancePaise: '6623457',
  plan: [{ label: 'Full payment', dueDate: '2026-11-30', amountPaise: '9123457' }],
  payment: null,
  credits: null,
  gstInvoiceNumber: 'HC/26-27/0101',
  replaces: null,
};

describe('cdoc-1 content', () => {
  it('parses the sample; every key listed (an extra key fails)', () => {
    expect(CustomerDocumentContentSchema.safeParse(SAMPLE).success).toBe(true);
    expect(CustomerDocumentContentSchema.safeParse({ ...SAMPLE, margin: '1' }).success).toBe(false);
    expect(CustomerDocumentContentSchema.safeParse({ ...SAMPLE, totalPaise: '1.5' }).success).toBe(false);
  });

  it('checkContent: forbidden key names, safety words, Bitrix references hidden when the Deal ID prints', () => {
    expect(checkContent(SAMPLE)).toMatchObject({ ok: true });
    expect(forbiddenKeyPaths(SAMPLE)).toEqual([]);
    expect(checkContent({ ...SAMPLE, supplierCost: '1' })).toMatchObject({ ok: false, code: 'forbidden_field' });
    expect(checkContent({ ...SAMPLE, lines: [{ label: 'Net rate for the stay', amountPaise: '1' }] })).toMatchObject({ ok: false, code: 'content_safety' });
    // A CRM-only Deal prints its reference; a BX- reference without a Deal ID would be refused by the scan.
    expect(checkContent({ ...SAMPLE, deal: { reference: 'BX-10101', dealNumber: null } })).toMatchObject({ ok: false, code: 'content_safety' });
    expect(checkContent({ ...SAMPLE, deal: { reference: 'SYN-DEL-001', dealNumber: null } })).toMatchObject({ ok: true });
  });

  it('numbers, titles and rupees', () => {
    expect(formatNumber('10101', 'advance_invoice', 1)).toBe('10101-ADV-1');
    expect(formatNumber('SYN-DEL-001', 'invoice', 2)).toBe('SYN-DEL-001-INV-2');
    expect(formatNumber('10101', 'credit_note', 12)).toBe('10101-CN-12');
    expect(() => formatNumber('10101', 'invoice', 0)).toThrow();
    expect(() => formatNumber('x'.repeat(41), 'invoice', 1)).toThrow();
    expect(numberKind('10101-CN-3')).toBe('credit_note');
    expect(numberKind('10101-XX-3')).toBeNull();
    expect(documentTitle('advance_invoice')).toBe('Advance Invoice');
    expect(Object.values(DOCUMENT_TITLES)).toEqual(['Advance Invoice', 'Invoice', 'Credit Note']);
    expect(contentTitle(SAMPLE)).toBe('Invoice 10101-INV-1');
    expect(formatRupees('2500000')).toBe('₹25,000.00');
    expect(formatRupees('9123457')).toBe('₹91,234.57');
    expect(formatRupees('1234567800')).toBe('₹1,23,45,678.00');
    expect(formatRupees('5')).toBe('₹0.05');
    expect(() => formatRupees('-1')).toThrow();
    expect(dealLine(SAMPLE)).toEqual({ label: 'Deal ID', value: '10101' });
  });

  it('refusal tokens: frozen codes and messages (section 9)', () => {
    expect(DOCUMENT_ERROR_STATES).toMatchObject({ documents_off: '55000', billing_not_verified: '55000', document_stale: '40001',
      receipt_not_verified: '55000', has_credit_notes: '55000' });
    expect(DOCUMENT_ERROR_TEXT.documents_off).toBe('Customer documents are not switched on yet.');
    expect(DOCUMENT_ERROR_TEXT.document_stale).toBe('The booking or money changed since this draft was made. Refresh the draft first.');
  });
});

describe('customer template', () => {
  const html = (c: CustomerDocumentContent) => renderToStaticMarkup(createElement(CustomerDocumentTemplate, { content: c, id: 'itinerary-document' }));

  it('prints title, number, Deal ID, the Tally GST number, lines and the company GSTIN; never "not a tax invoice"', () => {
    const out = html(SAMPLE);
    expect(out).toContain('Invoice');
    expect(out).toContain('10101-INV-1');
    expect(out).toContain('Deal ID 10101');
    expect(out).toContain('GST invoice no. HC/26-27/0101');
    expect(out).toContain('₹91,234.57');
    expect(out).toContain('08AAFCH9191M1ZV');
    expect(out.toLowerCase()).not.toContain('not a tax invoice');
    expect(out).not.toContain('BX-10101');
    const checked = checkDocumentMarkup(out);
    expect(checked.safetyHits).toEqual([]);
    expect(checked.placeholders).toEqual([]);
  });

  it('missing billing details and an unknown branch print placeholders (block the PDF)', () => {
    const unknown = companyIdentityFor('SB1');
    const out = html({ ...SAMPLE, customer: null, company: { ...SAMPLE.company, gstin: unknown.gstin, gstinState: unknown.gstinState } });
    expect(checkDocumentMarkup(out).placeholders).toEqual(['Billing details', 'GSTIN for branch']);
  });

  it('Advance Invoice prints the payment block, a credit note what it credits', () => {
    const adv = html({ ...SAMPLE, kind: 'advance_invoice', title: 'Advance Invoice', number: '10101-ADV-1', lines: [{ label: 'Advance received', amountPaise: '2500000' }],
      totalPaise: '2500000', balancePaise: undefined, plan: undefined, gstInvoiceNumber: null,
      payment: { reference: 'R-2026-27-000123', receivedOn: '2026-11-10', mode: 'upi' } });
    expect(adv).toContain('R-2026-27-000123');
    expect(adv).toContain('by UPI');
    const cn = html({ ...SAMPLE, kind: 'credit_note', title: 'Credit Note', number: '10101-CN-1', credits: { number: '10101-INV-1', title: 'Invoice' },
      balancePaise: undefined, plan: undefined });
    expect(cn).toContain('Credit against Invoice 10101-INV-1');
  });
});

describe('company identity (Q2, LD1)', () => {
  it('every known branch prints the one company GSTIN (Rajasthan); unknown branch a placeholder', () => {
    for (const code of Object.keys(BRANCHES)) {
      expect(companyIdentityFor(code)).toMatchObject({ gstin: '08AAFCH9191M1ZV', gstinState: 'Rajasthan', placeholders: [] });
      expect(companyGstinGapFor(code)).toBeNull();
    }
    expect(companyIdentityFor(null)).toMatchObject({ gstin: '[GSTIN for branch]', gstinState: null });
    expect(COMPANY_IDENTITY.HOLIDAY_CHACHA).toMatchObject({ companyGstin: '08AAFCH9191M1ZV', companyGstinState: 'Rajasthan' });
  });

  it('the SQL mirror authz.cdoc_company carries the same values', () => {
    const sql = readFileSync(new URL('../../supabase/migrations/20261204000200_customer_documents_schema.sql', import.meta.url), 'utf8');
    const r = COMPANY_IDENTITY.HOLIDAY_CHACHA;
    for (const v of [r.legalName, r.registeredAddress, r.pan, r.companyGstin, r.companyGstinState, '[GSTIN for branch]']) {
      expect(sql).toContain(`'${v}'`);
    }
    expect(sql).toContain(`in (${Object.keys(BRANCHES).map((c) => `'${c}'`).join(', ')})`);
  });
});
