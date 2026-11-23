import 'server-only';
import { createHash } from 'node:crypto';
import { countPdfPages, type PdfResult } from './pdf';
import { RenderStepError } from './worker-core';

/**
 * DEC-49: PDF from the in-app print page (online PDF maker). Headless
 * Chromium opens the page through a short-lived signed link, so the branded
 * template is rendered by Next.js itself and react-dom/server is never needed.
 *
 *   1. Check context (JavaScript on, A4 viewport): open the page, wait for the
 *      fonts, read the template's own markup, the visible text of the WHOLE
 *      body (review E10-2: the safety scan covers everything that prints),
 *      the visible placeholders anywhere on the page, whether any visible
 *      text sits outside the template (app chrome: page_chrome), and the
 *      layout codes of the template element.
 *   2. Print context (JavaScript off, review E6-4): open the page again and
 *      print it.
 *
 * Network: only the app's own origin (the page, its stylesheets and fonts).
 * Every other request is aborted and counted (a final document with any
 * blocked request fails asset_missing). Review E10-6: the print token travels
 * in a request header (x-tn-print-token), not in the URL, so request logs do
 * not record it; Chromium sends it only to the app's own origin (every other
 * request is aborted before it leaves).
 */

export { PRINT_DOCUMENT_ELEMENT_ID } from './print-token';
import { PRINT_DOCUMENT_ELEMENT_ID } from './print-token';

/** The small part of Playwright's Browser this module uses. */
export interface UrlPdfBrowser {
  newContext(options: { javaScriptEnabled: boolean; viewport: { width: number; height: number } }): Promise<UrlPdfContext>;
}
export interface UrlPdfContext {
  route(url: string, handler: (route: UrlPdfRoute) => Promise<void>): Promise<unknown>;
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  newPage(): Promise<UrlPdfPage>;
  close(): Promise<void>;
}
export interface UrlPdfRoute {
  request(): { url(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
}
export interface UrlPdfPage {
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<{ status(): number } | null>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  pdf(options: { format: 'A4'; printBackground: boolean; preferCSSPageSize: boolean; margin: Record<string, string>; timeout?: number }): Promise<Uint8Array>;
}

export interface PrintPageCheck {
  /** outerHTML of the template element. */
  markup: string;
  /** Visible text of the whole body (what prints). */
  bodyText: string;
  /** Text of every visible placeholder (.fill) anywhere on the page. */
  placeholders: string[];
  /** Visible text outside the template element (banner, skip link, app chrome). */
  strayText: boolean;
  layoutIssues: string[];
  blockedRequests: number;
  ms: number;
}

const A4 = { width: 794, height: 1123 };

type PageFacts = { markup: string | null; bodyText: string; placeholders: string[]; strayText: boolean; issues: string[] };

/**
 * Layout: same rules as the local check (pdf.ts), on the template element.
 * Text: the visible text of the whole body, the visible placeholders, and
 * whether anything visible sits outside the template.
 */
function pageCheck(id: string): Promise<PageFacts> | PageFacts {
  const run = (): PageFacts => {
    const root = document.getElementById(id);
    const bodyText = document.body ? document.body.innerText : '';
    if (!root) return { markup: null, bodyText, placeholders: [], strayText: false, issues: [] };
    const issues = new Set<string>();
    const width = document.documentElement.clientWidth;
    for (const el of [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]) {
      const style = getComputedStyle(el);
      if ((style.overflow === 'hidden' || style.overflowY === 'hidden') && el.scrollHeight > el.clientHeight + 2) issues.add('text_clipped');
      if (el.getBoundingClientRect().right > width + 1) issues.add('layout_overflow');
    }
    const visible = (el: HTMLElement) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const placeholders = Array.from(document.body.querySelectorAll<HTMLElement>('.fill')).filter(visible).map((el) => el.innerText.trim());
    const strayText = bodyText.replace(root.innerText, '').trim().length > 0;
    return { markup: root.outerHTML, bodyText, placeholders, strayText, issues: [...issues].sort() };
  };
  return document.fonts ? document.fonts.ready.then(run) : run();
}

export function createUrlPdfRenderer(options: { browser: UrlPdfBrowser; origin: string; timeoutMs?: number; now?: () => number }) {
  const origin = new URL(options.origin).origin;
  const timeout = options.timeoutMs ?? 30_000;
  const now = options.now ?? Date.now;

  const open = async (javaScriptEnabled: boolean, counter: { blocked: number }, headers: Record<string, string>) => {
    const context = await options.browser.newContext({ javaScriptEnabled, viewport: A4 });
    await context.setExtraHTTPHeaders(headers);
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      let allowed = url.startsWith('data:');
      if (!allowed) {
        try {
          allowed = new URL(url).origin === origin;
        } catch {
          allowed = false;
        }
      }
      if (allowed) return route.continue();
      counter.blocked += 1;
      return route.abort();
    });
    return context;
  };

  const load = async (context: UrlPdfContext, url: string) => {
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'load', timeout });
    // The print page answers 404 for any refusal (switch off, bad or expired
    // link, job no longer leased): an infrastructure problem, retried.
    if (!response || response.status() !== 200) throw new RenderStepError('internal');
    return page;
  };

  return {
    /** Step 1: the template markup and its layout codes. */
    async check(url: string, headers: Record<string, string> = {}): Promise<PrintPageCheck> {
      if (new URL(url).origin !== origin) throw new RenderStepError('internal');
      const started = now();
      const counter = { blocked: 0 };
      const context = await open(true, counter, headers);
      try {
        const page = await load(context, url);
        const result = await page.evaluate(pageCheck, PRINT_DOCUMENT_ELEMENT_ID);
        if (!result.markup) throw new RenderStepError('internal');
        return {
          markup: result.markup,
          bodyText: result.bodyText,
          placeholders: result.placeholders,
          strayText: result.strayText,
          layoutIssues: result.issues,
          blockedRequests: counter.blocked,
          ms: now() - started,
        };
      } finally {
        await context.close().catch(() => undefined);
      }
    },

    /** Step 2: the PDF, printed with JavaScript off. */
    async print(url: string, checked: PrintPageCheck, headers: Record<string, string> = {}): Promise<PdfResult> {
      if (new URL(url).origin !== origin) throw new RenderStepError('internal');
      const started = now();
      const counter = { blocked: 0 };
      const context = await open(false, counter, headers);
      try {
        const page = await load(context, url);
        const pdf = await page.pdf({
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
          layoutIssues: checked.layoutIssues,
          blockedRequests: checked.blockedRequests + counter.blocked,
          ms: checked.ms + (now() - started),
        };
      } finally {
        await context.close().catch(() => undefined);
      }
    },
  };
}
