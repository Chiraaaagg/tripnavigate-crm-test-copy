import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { QUOTE_SCREENS, quoteDocumentView, V2_ID } from '@/app/preview/[state]/b12-quote-fixtures';
import { itineraryDocumentView } from '@/app/preview/[state]/b12-itin-fixtures';
import {
  COMPANY_GSTIN_TEXT,
  companyGstinBranch,
  companyGstinGapFor,
  companyGstinMissingText,
  isCompanyGstinPlaceholder,
  quotationGstinWarning,
  splitCompanyGstinPlaceholders,
} from '@/modules/documents/company-identity';
import { htmlToText } from '@/modules/documents/safety';
import { RENDER_ERROR_TEXT } from '@/modules/itineraries/contracts';
import { renderErrorText, renderedQaNote } from '@/modules/itineraries/dto';
import { ItineraryPreviewPage } from '@/views/b12/itin-views';
import type { QuoteActions } from '@/views/b12/quote-kit';
import { QuotationPage, QuotationPreviewPage } from '@/views/b12/quote-page';

// The quotation page's client forms read the router; outside Next.js a stand-in is enough to render markup.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => '/app/quotations',
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * DEC-50 review (Echo): a missing company GSTIN is Accounts' data, never a
 * fact staff can fill in. Screens say so plainly; a quotation warns before
 * sending and never blocks marking it sent (lead decision). Synthetic values
 * and the approved company values only.
 */

const DELHI = 'The company GSTIN for Delhi is not approved yet. Ask Accounts; there is nothing for you to fill in.';
const DELHI_QUOTE = "This quotation prints a '[GSTIN for Delhi]' mark instead of the company GSTIN, because Accounts has not approved it yet. Ask Accounts before sending it to the customer.";
const UNKNOWN = 'The branch of this document is not known, so the company GSTIN cannot be printed. Tell the CRM team.';

describe('company GSTIN placeholder helpers', () => {
  it('recognise exactly the labels the identity record makes', () => {
    expect(companyGstinBranch('GSTIN for Delhi')).toBe('Delhi');
    expect(companyGstinBranch('GSTIN for Ahmedabad')).toBe('Ahmedabad');
    expect(companyGstinBranch('GSTIN for branch')).toBe('this branch');
    for (const other of ['Hotel name', 'GSTIN for Mumbai', 'gstin for delhi', 'Customer GSTIN', '']) {
      expect(companyGstinBranch(other)).toBeNull();
      expect(isCompanyGstinPlaceholder(other)).toBe(false);
    }
    expect(isCompanyGstinPlaceholder('GSTIN for Delhi')).toBe(true);
  });

  it('split the GSTIN gaps (once each) from the other missing facts (kept in order)', () => {
    expect(splitCompanyGstinPlaceholders(['Hotel name', 'GSTIN for Delhi', 'Room type', 'GSTIN for Delhi'])).toEqual({ gstinBranches: ['Delhi'], others: ['Hotel name', 'Room type'] });
    expect(splitCompanyGstinPlaceholders([])).toEqual({ gstinBranches: [], others: [] });
  });

  it('gap per branch code (LD1: one company GSTIN): none for any known branch; an unknown branch has one', () => {
    expect(companyGstinGapFor('JDH')).toBeNull();
    expect(companyGstinGapFor('DEL')).toBeNull();
    expect(companyGstinGapFor('AMD')).toBeNull();
    expect(companyGstinGapFor(null)).toBe('this branch');
  });

  it('the wording', () => {
    expect(companyGstinMissingText('Delhi')).toBe(DELHI);
    expect(quotationGstinWarning('Delhi')).toBe(DELHI_QUOTE);
    // An unknown branch is a data problem for the CRM team, not an Accounts matter.
    expect(companyGstinMissingText('this branch')).toBe(UNKNOWN);
    expect(quotationGstinWarning('this branch')).toBe(UNKNOWN);
    expect(COMPANY_GSTIN_TEXT.quotationTitle).toBe('Company GSTIN missing on this quotation');
    expect(COMPANY_GSTIN_TEXT.notApproved).toContain('{branch}');
  });
});

describe('itinerary render job error text', () => {
  it('placeholders_present names the GSTIN only for an unknown branch (LD1); every known branch keeps the existing text', () => {
    expect(renderErrorText('placeholders_present', 'DEL')).toBe(RENDER_ERROR_TEXT.placeholders_present);
    expect(renderErrorText('placeholders_present', 'AMD')).toBe(RENDER_ERROR_TEXT.placeholders_present);
    expect(renderErrorText('placeholders_present', 'JDH')).toBe(RENDER_ERROR_TEXT.placeholders_present);
    expect(renderErrorText('layout_overflow', 'DEL')).toBe(RENDER_ERROR_TEXT.layout_overflow);
    expect(renderErrorText('not_a_code', 'JDH')).toBe(RENDER_ERROR_TEXT.internal);
    expect(renderErrorText('placeholders_present', null)).toBe(`${UNKNOWN} Any other missing facts show in brackets on the preview.`);
  });
});

describe('made-documents list: the placeholder count in words', () => {
  it('the GSTIN mark is named, not counted as a fact (unknown branch only, LD1); singular and plural are right', () => {
    expect(renderedQaNote(0, 'DEL')).toBeNull();
    expect(renderedQaNote(1, 'DEL')).toBe('1 missing fact in brackets');
    expect(renderedQaNote(2, 'DEL')).toBe('2 missing facts in brackets');
    expect(renderedQaNote(3, 'AMD')).toBe('3 missing facts in brackets');
    expect(renderedQaNote(2, null)).toBe('1 missing fact in brackets · company GSTIN not printed (branch not known)');
    expect(renderedQaNote(1, 'JDH')).toBe('1 missing fact in brackets');
    expect(renderedQaNote(2, 'JDH')).toBe('2 missing facts in brackets');
    expect(renderedQaNote(1, null)).toBe('company GSTIN not printed (branch not known)');
    expect(renderedQaNote(0, 'JDH')).toBeNull();
  });
});

describe('preview pages', () => {
  const text = (el: Parameters<typeof renderToStaticMarkup>[0]) => htmlToText(renderToStaticMarkup(el));

  it('quotation preview, Delhi (LD1): the company GSTIN prints, no send warning; the room type is still a fact to fill in', () => {
    const t = text(createElement(QuotationPreviewPage, { versionId: V2_ID, view: quoteDocumentView({ branchCode: 'DEL' }), moneyVisible: true }));
    expect(t).not.toContain(DELHI_QUOTE);
    expect(t).toContain('GSTIN 08AAFCH9191M1ZV (Rajasthan)');
    expect(t).toContain('1 detail missing (shown in [brackets]): Room type.');
    expect(t).not.toContain('GSTIN for Delhi');
  });

  it('quotation preview, unknown branch: the CRM team wording, not Accounts', () => {
    const t = text(createElement(QuotationPreviewPage, { versionId: V2_ID, view: quoteDocumentView({ branchCode: null }), moneyVisible: true }));
    expect(t).toContain(UNKNOWN);
    expect(t).not.toContain('Ask Accounts');
  });

  it('quotation preview, Jodhpur: no GSTIN wording', () => {
    const t = text(createElement(QuotationPreviewPage, { versionId: V2_ID, view: quoteDocumentView(), moneyVisible: true }));
    expect(t).not.toContain('not approved yet');
    expect(t).toContain('PAN AAFCH9191M · GSTIN 08AAFCH9191M1ZV (Rajasthan)');
  });

  it('itinerary preview, Delhi (LD1): no GSTIN wording; unknown branch: the CRM team wording, never "fill them in" for the GSTIN', () => {
    const del = text(createElement(ItineraryPreviewPage, { documentId: 'it000000-0000-4000-8000-000000000003', view: itineraryDocumentView({ branchCode: 'DEL' }) }));
    expect(del).not.toContain(DELHI);
    expect(del).not.toContain('not approved yet');
    const t = text(createElement(ItineraryPreviewPage, { documentId: 'it000000-0000-4000-8000-000000000003', view: itineraryDocumentView({ branchCode: null }) }));
    expect(t).toContain(UNKNOWN);
    expect(t).not.toMatch(/missing \(shown in \[brackets\]\): [^.]*GSTIN/);
  });
});

describe('quotation page (lead decision: warn, never block)', () => {
  const actions = new Proxy({}, { get: () => async () => ({ ok: true }) }) as unknown as QuoteActions;
  const page = (branchCode: string | null) => {
    const data = QUOTE_SCREENS.ready();
    data.version.subject = { ...data.version.subject, branchCode };
    return htmlToText(renderToStaticMarkup(createElement(QuotationPage, { data, actions, today: '2026-10-12' })));
  };

  it('Delhi (LD1): no GSTIN warning; unknown branch: the warning is shown and Mark as shared stays available', () => {
    const del = page('DEL');
    expect(del).not.toContain('Company GSTIN missing on this quotation');
    expect(del).toContain('Mark as shared');
    const t = page(null);
    expect(t).toContain('Company GSTIN missing on this quotation');
    expect(t).toContain(UNKNOWN);
    expect(t).toContain('Mark as shared');
  });

  it('Jodhpur: no warning; unknown branch: the CRM team wording', () => {
    expect(page('JDH')).not.toContain('Company GSTIN missing');
    expect(page(null)).toContain(UNKNOWN);
  });
});
