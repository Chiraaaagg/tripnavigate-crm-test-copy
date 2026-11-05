import 'server-only';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PackageDocumentInput } from '../contracts';
import { BrandedItineraryTemplate } from './branded-templates';
import { checkDocumentMarkup, type RenderedDocument } from './checks';
import { RenderStepError } from './worker-core';

export { placeholderTexts, type RenderedDocument } from './checks';

/**
 * HTML renderer seam for customer documents (freeze part 2 section 5).
 *
 * Renders a document template component (Luna supplies the branded ones; a
 * minimal plain template ships in ./plain-templates) to one HTML string, then
 * runs the blocking page checks on the rendered text: the content-safety scan
 * and the placeholder count (elements with class "fill"). No Chromium and no
 * PDF here; the rendering location is PENDING (Vercel function, local machine
 * or approved worker).
 *
 * IMPORTANT: `react-dom/server` cannot load in the React Server Components
 * layer (Server Components, Server Actions, App Router route handlers): React
 * 19 maps it to a module that throws there. Import this file only from a Node
 * runtime outside that layer (the render worker, a script, unit tests). The
 * module index does not re-export it.
 */

export interface RenderOptions {
  /** Document <title>; plain text, escaped here. */
  title: string;
  /** Inline CSS for the template (bundled, never fetched). */
  css?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderDocumentHtml<P extends object>(Template: ComponentType<P>, props: P, options: RenderOptions): RenderedDocument {
  const body = renderToStaticMarkup(<Template {...props} />);
  const css = options.css ? `<style>${options.css.replace(/<\/style/gi, '')}</style>` : '';
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(options.title)}</title>${css}</head>` +
    `<body>${body}</body></html>`;
  return checkDocumentMarkup(body, html);
}

/**
 * The HTML step of the LOCAL render worker (worker-core `renderHtml`): the
 * branded itinerary template with the stylesheet inlined. A missing
 * stylesheet is asset_missing. Node only (react-dom/server).
 */
export function localItineraryHtmlStep(css: string) {
  return async (_job: unknown, input: PackageDocumentInput, title: string): Promise<RenderedDocument> => {
    if (!css.trim()) throw new RenderStepError('asset_missing');
    return renderDocumentHtml(BrandedItineraryTemplate, { input }, { title, css });
  };
}
