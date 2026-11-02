import 'server-only';
import { createHash } from 'node:crypto';

/**
 * HTML -> A4 PDF with headless Chromium (Playwright, pinned with the test
 * tooling), for the local render worker only. The browser is passed in by
 * the Node script, so nothing here pulls Playwright into the app bundle.
 *
 * No network: every request except data: URLs is aborted (the page is set
 * from a string; styles are inlined; fonts are system fonts). The page is
 * checked before printing (layout issues as codes), then printed.
 */

/** The small part of Playwright's Browser this module uses. */
export interface PdfBrowser {
  newContext(options: { offline: boolean; javaScriptEnabled: boolean; viewport: { width: number; height: number } }): Promise<PdfContext>;
}
export interface PdfContext {
  route(url: string, handler: (route: PdfRoute) => Promise<void>): Promise<void>;
  newPage(): Promise<PdfPage>;
  close(): Promise<void>;
}
export interface PdfRoute {
  request(): { url(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
}
export interface PdfPage {
  setContent(html: string, options: { waitUntil: 'load'; timeout: number }): Promise<void>;
  evaluate<R>(fn: () => R): Promise<R>;
  pdf(options: { format: 'A4'; printBackground: boolean; preferCSSPageSize: boolean; margin: Record<string, string>; timeout?: number }): Promise<Uint8Array>;
}

export interface PdfResult {
  pdf: Uint8Array;
  sha256: string;
  sizeBytes: number;
  pageCount: number;
  /** Codes only: layout_overflow (content wider than the page), text_clipped (text cut by its box). */
  layoutIssues: string[];
  /** Network requests the page tried (all aborted); a count only. */
  blockedRequests: number;
  ms: number;
}

/** A4 at 96 dpi: 794 x 1123 CSS pixels. */
const A4 = { width: 794, height: 1123 };

/** Pages in a PDF: page objects (`/Type /Page`, not `/Pages`). */
export function countPdfPages(pdf: Uint8Array): number {
  const text = Buffer.from(pdf).toString('latin1');
  return (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

export async function renderPdf(browser: PdfBrowser, html: string, options: { timeoutMs?: number; now?: () => number } = {}): Promise<PdfResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const timeout = options.timeoutMs ?? 30_000;
  let blockedRequests = 0;
  const open = async (javaScriptEnabled: boolean) => {
    const context = await browser.newContext({ offline: true, javaScriptEnabled, viewport: A4 });
    await context.route('**/*', async (route) => {
      if (route.request().url().startsWith('data:')) return route.continue();
      blockedRequests += 1;
      return route.abort();
    });
    return context;
  };
  // Review E6-4: the layout check needs JavaScript; the PDF is printed from a
  // second context with JavaScript off (the templates are static markup).
  const checkContext = await open(true);
  let printContext: PdfContext | null = null;
  try {
    const page = await checkContext.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout });
    const layoutIssues = await page.evaluate(() => {
      const issues = new Set<string>();
      const doc = document.documentElement;
      if (doc.scrollWidth > doc.clientWidth + 1) issues.add('layout_overflow');
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        const style = getComputedStyle(el);
        if ((style.overflow === 'hidden' || style.overflowY === 'hidden') && el.scrollHeight > el.clientHeight + 2) issues.add('text_clipped');
        if (el.getBoundingClientRect().right > doc.clientWidth + 1) issues.add('layout_overflow');
      }
      return [...issues].sort();
    });
    await checkContext.close().catch(() => undefined);
    printContext = await open(false);
    const printPage = await printContext.newPage();
    await printPage.setContent(html, { waitUntil: 'load', timeout });
    const pdf = await printPage.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '12mm', bottom: '14mm', left: '0mm', right: '0mm' },
      timeout,
    });
    return {
      pdf,
      sha256: createHash('sha256').update(pdf).digest('hex'),
      sizeBytes: pdf.byteLength,
      pageCount: countPdfPages(pdf),
      layoutIssues,
      blockedRequests,
      ms: now() - started,
    };
  } finally {
    await checkContext.close().catch(() => undefined);
    await printContext?.close().catch(() => undefined);
  }
}
