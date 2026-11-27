/*
 * S11 "files to Bitrix" (file 14 section 2.5): the small pages a person sees
 * when a file kept in Bitrix cannot be shown. The delivery code (slice 3,
 * documents/server/file-delivery.ts) sends "Bitrix is not answering" and
 * "needs attention" with status 503, and "wait a minute" (the CRM's own limit
 * of files opened per person per minute, review 14a P3-4) with status 429.
 *
 * A complete HTML document: no script, no outside file, inline CSS only, so it
 * works whatever the page's security headers allow (without the style it is
 * still a plain, readable page). The sentences are the approved wording,
 * word for word. Nothing else is printed: no file name, deal, Bitrix id, link
 * or error code, so the page never says more than the person may know.
 *
 * Look: the app's own colours (globals.css), one calm card, a heading that
 * says what happened in words (the meaning never rests on colour), the
 * approved sentence and one plain link back to the CRM. Sizes are in rem, the
 * card is fluid with a 16px side gutter, so it reads at 200% zoom and on a
 * narrow phone. There is no motion, so reduced motion needs nothing.
 */

export type FileUnavailableKind = 'bitrix_unavailable' | 'needs_attention' | 'view_limit';

/** The approved sentences (file 14 section 2.5; view_limit: review 14a open question 2), word for word. */
export const FILE_UNAVAILABLE_TEXT: Record<FileUnavailableKind, { heading: string; text: string }> = {
  bitrix_unavailable: {
    heading: 'Bitrix is not answering right now',
    text: 'This file is kept in Bitrix and Bitrix is not answering right now. Nothing is lost. Please try again in a few minutes.',
  },
  needs_attention: {
    heading: 'This file needs attention',
    text: 'This file needs attention. Please tell your administrator.',
  },
  view_limit: {
    heading: 'Please wait a minute',
    text: 'You opened many files in the last minute. Please wait a minute and try again.',
  },
};

/** The link back. A plain link (no script is allowed, so no "go back" button). */
export const FILE_UNAVAILABLE_BACK = { href: '/app', label: 'Back to the CRM' } as const;

/**
 * The inline style, exported so the delivery code can allow it in a
 * Content-Security-Policy (for example by hashing this exact text) if it sets
 * one on this page.
 */
export const FILE_UNAVAILABLE_CSS = [
  ':root{color-scheme:light}',
  '*{box-sizing:border-box}',
  "html{font-family:system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans','Noto Sans Devanagari',sans-serif;font-size:100%;line-height:1.5}",
  'body{margin:0;background:#fafafa;color:#0a0a0a}',
  'main{max-width:36rem;margin:0 auto;padding:3rem 1rem}',
  '.card{background:#fff;border:1px solid #d4d4d4;border-radius:8px;padding:1.5rem}',
  '.tag{display:inline-block;margin:0 0 0.75rem;padding:0.125rem 0.625rem;border-radius:999px;background:#fff4d6;color:#5c4400;font-size:0.875rem;font-weight:600}',
  'h1{font-size:1.5rem;line-height:1.25;margin:0 0 0.75rem}',
  'p{margin:0 0 1rem;overflow-wrap:anywhere}',
  'a{color:#004aad;font-weight:600}',
  'a:hover{color:#003a87}',
  'a:focus-visible{outline:3px solid #ffbf47;outline-offset:2px;box-shadow:0 0 0 5px #0a0a0a;border-radius:2px}',
  '.back{margin:0}',
].join('');

/** One of the pages as a complete HTML document (UTF-8). */
export function fileUnavailableHtml(kind: FileUnavailableKind): string {
  // Fail closed: anything unexpected gets the "needs attention" page, never a blank one.
  const known = Object.hasOwn(FILE_UNAVAILABLE_TEXT, kind) ? kind : 'needs_attention';
  const words = FILE_UNAVAILABLE_TEXT[known];
  // The tag says in words whether waiting helps (the meaning never rests on its colour).
  const tag = known === 'needs_attention' ? 'Needs attention' : 'Try again later';
  return (
    '<!doctype html>' +
    '<html lang="en">' +
    '<head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="referrer" content="no-referrer">' +
    '<meta name="robots" content="noindex">' +
    `<title>${words.heading} · TripNavigate CRM</title>` +
    `<style>${FILE_UNAVAILABLE_CSS}</style>` +
    '</head>' +
    '<body>' +
    '<main>' +
    '<div class="card">' +
    `<p class="tag">${tag}</p>` +
    `<h1>${words.heading}</h1>` +
    `<p>${words.text}</p>` +
    `<p class="back"><a href="${FILE_UNAVAILABLE_BACK.href}">${FILE_UNAVAILABLE_BACK.label}</a></p>` +
    '</div>' +
    '</main>' +
    '</body>' +
    '</html>'
  );
}
