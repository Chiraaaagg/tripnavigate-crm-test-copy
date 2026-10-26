import { htmlToText, scanText, type SafetyHit } from '../safety';

/**
 * The page checks every rendered customer document goes through, wherever it
 * was rendered (Node render seam ./html.tsx, or the online PDF maker reading
 * the in-app print page from headless Chromium): the content-safety scan and
 * the placeholder count. No React here, so this module is safe in the Next.js
 * server layer.
 */

export interface RenderedDocument {
  html: string;
  /** Blocking: any hit stops sending / issuing. */
  safetyHits: SafetyHit[];
  /** Visible placeholders on the page (text of each `.fill` element). */
  placeholders: string[];
  /**
   * Codes for anything else on the printed page that must not reach a
   * customer (online maker: page_chrome = visible text outside the template).
   * Counted with the safety codes: a final document with any fails
   * content_safety.
   */
  pageIssues?: string[];
}

/** Text of every element whose class list contains "fill" (placeholder tokens). */
export function placeholderTexts(html: string): string[] {
  const out: string[] = [];
  const re = /<([a-z]+)\b[^>]*\bclass="(?:[^"]*\s)?fill(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/\1>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) out.push(htmlToText(m[2] ?? ''));
  return out;
}

/** The checks on a document's markup (the template's own element, not the page around it). */
export function checkDocumentMarkup(markup: string, html: string = markup): RenderedDocument {
  return { html, safetyHits: scanText(htmlToText(markup)), placeholders: placeholderTexts(markup) };
}
