import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { itineraryToEngine } from '@/modules/documents/itinerary-adapter';
import { quotationToEngineQuote } from '@/modules/documents/quotation-adapter';
import { placeholderTexts, renderDocumentHtml } from '@/modules/documents/render/html';
import { PlainItineraryTemplate, PlainQuotationTemplate } from '@/modules/documents/render/plain-templates';
import { itineraryView, quotationView } from './b12-documents-fixtures';

/** B1.2 Phase F groundwork: HTML renderer seam (no Chromium, no PDF). Synthetic values only. */

describe('renderDocumentHtml', () => {
  it('renders the plain quotation, counts the same placeholders as the adapter and finds no unsafe word', () => {
    const r = quotationToEngineQuote(quotationView());
    if (!r.ok) throw new Error('refused');
    const doc = renderDocumentHtml(PlainQuotationTemplate, { input: r.input }, { title: 'Quotation TQ-12 <synthetic>' });
    expect(doc.html.startsWith('<!doctype html>')).toBe(true);
    expect(doc.html).toContain('<title>Quotation TQ-12 &lt;synthetic&gt;</title>');
    expect(doc.html).toContain('GST as applicable');
    expect(doc.html).toContain('Quotation — not a tax invoice');
    expect(doc.html).toContain('₹2,40,000');
    expect(doc.safetyHits).toEqual([]);
    expect(doc.placeholders.sort()).toEqual([...r.placeholders].sort());
  });

  it('a template that prints an internal word is caught on the rendered page', () => {
    const Leaky = ({ note }: { note: string }) => createElement('p', null, 'Supplier rate: ', note);
    const doc = renderDocumentHtml(Leaky, { note: 'synthetic' }, { title: 't' });
    expect(doc.safetyHits.map((h) => h.phrase)).toEqual(['supplier rate']);
  });

  it('customer text is escaped, never injected as markup', () => {
    const r = quotationToEngineQuote(quotationView({ includes: ['<img src=x onerror=alert(1)> dinner'] }));
    if (!r.ok) throw new Error('refused');
    const doc = renderDocumentHtml(PlainQuotationTemplate, { input: r.input }, { title: 't' });
    expect(doc.html).not.toContain('<img');
    expect(doc.html).toContain('&lt;img');
  });

  it('renders the plain itinerary without prices', () => {
    const r = itineraryToEngine(itineraryView());
    if (!r.ok) throw new Error('refused');
    const doc = renderDocumentHtml(PlainItineraryTemplate, { input: r.input }, { title: 'Itinerary IT-7', css: 'body{font-family:serif}' });
    expect(doc.html).toContain('<style>body{font-family:serif}</style>');
    expect(doc.html).not.toContain('Your price');
    expect(doc.safetyHits).toEqual([]);
    expect(doc.placeholders.length).toBe(r.placeholders.length);
  });

  it('placeholderTexts reads every element with the fill class', () => {
    expect(placeholderTexts('<p><span class="fill">Hotel name</span> and <b class="x fill y">Room</b></p>')).toEqual(['Hotel name', 'Room']);
  });
});
