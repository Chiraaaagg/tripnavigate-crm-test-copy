import 'server-only';
import { z } from 'zod';
import type { AdapterRefusal, ItineraryDocumentView, QuotationDocumentView } from '../contracts';
import { itineraryToEngine } from '../itinerary-adapter';
import { quotationToEngineQuote } from '../quotation-adapter';
import type { SafetyHit } from '../safety';
import { renderDocumentHtml } from './html';
import { readFileSync } from 'node:fs';
import { BrandedItineraryTemplate, BrandedQuotationTemplate } from './branded-templates';

/** The branded templates' stylesheet (the same file the in-app preview imports), inlined into the page. */
function documentCss(): string {
  return readFileSync(new URL('./document.css', import.meta.url), 'utf8');
}

/**
 * One customer view -> one HTML document, for the Node render script
 * (crm/scripts/render-document.mjs) and, later, the approved render worker.
 * Not for the Next.js server layer (react-dom/server; see ./html.tsx). No
 * network: no photos are fetched and nothing is sent anywhere.
 *
 * Outcomes:
 *   rendered       HTML produced; `placeholders` > 0 means preview only
 *   refused        the adapter refused (codes and paths only)
 *   unsafe_page    the rendered page text hit the content-safety list
 *   invalid_input  the payload is not a document view
 */

export type RenderViewResult =
  | { outcome: 'rendered'; html: string; placeholders: string[]; internalNotes: string[] }
  | { outcome: 'refused'; refusals: AdapterRefusal[] }
  | { outcome: 'unsafe_page'; safetyHits: SafetyHit[] }
  | { outcome: 'invalid_input'; issue: string };

const Payload = z.object({
  title: z.string().min(1).max(200).optional(),
  view: z.object({ kind: z.enum(['quotation', 'itinerary']) }).passthrough(),
});

export function renderView(payload: unknown): RenderViewResult {
  const parsed = Payload.safeParse(payload);
  if (!parsed.success) return { outcome: 'invalid_input', issue: parsed.error.issues[0]?.path.join('.') || 'payload' };
  const { view } = parsed.data;
  try {
    if (view.kind === 'quotation') {
      const v = view as unknown as QuotationDocumentView;
      const r = quotationToEngineQuote(v);
      if (!r.ok) return { outcome: 'refused', refusals: r.refusals };
      const doc = renderDocumentHtml(BrandedQuotationTemplate, { input: r.input }, { title: parsed.data.title ?? `Quotation ${r.input.quoteNo}`, css: documentCss() });
      if (doc.safetyHits.length) return { outcome: 'unsafe_page', safetyHits: doc.safetyHits };
      return { outcome: 'rendered', html: doc.html, placeholders: doc.placeholders, internalNotes: r.internalNotes };
    }
    const v = view as unknown as ItineraryDocumentView;
    const r = itineraryToEngine(v);
    if (!r.ok) return { outcome: 'refused', refusals: r.refusals };
    const doc = renderDocumentHtml(BrandedItineraryTemplate, { input: r.input }, { title: parsed.data.title ?? `Itinerary ${r.input.code}`, css: documentCss() });
    if (doc.safetyHits.length) return { outcome: 'unsafe_page', safetyHits: doc.safetyHits };
    return { outcome: 'rendered', html: doc.html, placeholders: doc.placeholders, internalNotes: r.internalNotes };
  } catch {
    // A malformed view that passed the outer shape check (missing nested fields).
    return { outcome: 'invalid_input', issue: 'view' };
  }
}
