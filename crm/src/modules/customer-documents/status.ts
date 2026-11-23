import type { DocumentStatus, PdfState } from './contracts';
import type { DocumentRow } from './dto';

/**
 * Status words of a customer document for screens (contract section 11.1).
 * Status never by colour alone: every state has words. Pure.
 */

export const DOCUMENT_STATUS_WORDS: Readonly<Record<DocumentStatus, string>> = Object.freeze({
  draft: 'Draft — number on release',
  released: 'Released',
  replaced: 'Replaced',
  cancelled: 'Cancelled',
  discarded: 'Discarded',
});

export const PDF_STATE_WORDS: Readonly<Record<PdfState, string>> = Object.freeze({
  none: 'No PDF',
  off: 'PDF not made yet — Print view',
  queued: 'PDF being made',
  ready: 'Download PDF',
  failed: 'PDF failed — retry',
});

/** The main status line plus flag lines, in reading order. */
export function documentStatusLines(row: Pick<DocumentRow, 'status' | 'replacedByNumber' | 'endReason' | 'stale' |
  'bookingChangedSinceRelease' | 'paymentReversed'>): string[] {
  const lines: string[] = [];
  if (row.status === 'replaced') lines.push(row.replacedByNumber ? `Replaced by ${row.replacedByNumber}` : DOCUMENT_STATUS_WORDS.replaced);
  else if (row.status === 'cancelled') lines.push(row.endReason ? `Cancelled — ${row.endReason}` : DOCUMENT_STATUS_WORDS.cancelled);
  else lines.push(DOCUMENT_STATUS_WORDS[row.status]);
  if (row.stale) lines.push('Booking or money changed — refresh the draft');
  if (row.bookingChangedSinceRelease) lines.push('Booking changed since release');
  if (row.paymentReversed) lines.push('Payment reversed');
  return lines;
}
