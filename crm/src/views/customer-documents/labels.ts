import type { StatusTone } from '@/components/ui/badge';
import { AUTO_RULE_TEXT, DOCUMENT_CODES, DOCUMENT_TITLES, DOCUMENT_WARNING_TEXT, HOLD_REASON_TEXT } from '@/modules/customer-documents/contracts';
import { documentStatusLines, PDF_STATE_WORDS } from '@/modules/customer-documents/status';
import type { AutoBillFields, DocRow, DocumentKind, DocumentStatus } from './types';

/*
 * Words for the customer documents screens (contract 11.1, 11.2). Every
 * status is an icon plus words, never colour alone. The status lines and
 * PDF words are track B's (`status.ts`); the titles are the owner's (Q1:
 * "Advance Invoice", "Invoice", "Credit Note", no "not a tax invoice" line).
 * Plain constants only (no zod): safe in client components.
 */

export { documentStatusLines, PDF_STATE_WORDS };

export const KIND_TITLE: Readonly<Record<DocumentKind, string>> = DOCUMENT_TITLES;

export const KIND_PLURAL: Readonly<Record<DocumentKind, string>> = {
  advance_invoice: 'Advance Invoices',
  invoice: 'Invoices',
  credit_note: 'Credit Notes',
};

export const STATUS_TONE: Readonly<Record<DocumentStatus, StatusTone>> = {
  draft: 'info',
  released: 'success',
  replaced: 'neutral',
  cancelled: 'neutral',
  discarded: 'neutral',
};

export const STATUS_FILTER_LABEL: Readonly<Record<DocumentStatus, string>> = {
  draft: 'Drafts',
  released: 'Released',
  replaced: 'Replaced',
  cancelled: 'Cancelled',
  discarded: 'Discarded',
};

export function warningText(code: string): string {
  return (DOCUMENT_WARNING_TEXT as Record<string, string>)[code] ?? 'Check this draft before releasing it.';
}

/** "10101-INV-3" -> { prefix: "10101", seq: 3 }. */
function splitNumber(n: string): { prefix: string; code: string; seq: number } | null {
  const m = /^(.{1,40})-(ADV|INV|CN)-([0-9]{1,4})$/.exec(n);
  return m ? { prefix: m[1]!, code: m[2]!, seq: Number(m[3]) } : null;
}

/**
 * The number this draft is expected to get at release: the Deal's prefix
 * (Bitrix Deal ID, else the CRM Deal reference, contract 6.3) and the next
 * running number of its kind. The database decides at release; the success
 * line states the real number.
 */
export function expectedNumber(draft: Pick<DocRow, 'kind'>, documents: readonly Pick<DocRow, 'kind' | 'number'>[], fallbackPrefix: string | null): string | null {
  const code = DOCUMENT_CODES[draft.kind];
  let prefix: string | null = null;
  let max = 0;
  for (const d of documents) {
    const s = d.number ? splitNumber(d.number) : null;
    if (!s) continue;
    prefix ??= s.prefix;
    if (s.code === code) max = Math.max(max, s.seq);
  }
  prefix ??= fallbackPrefix;
  return prefix ? `${prefix}-${code}-${max + 1}` : null;
}

/** Badge tone for a released document carrying a flag (booking changed, payment reversed). */
export function rowTone(row: Pick<DocRow, 'status' | 'stale' | 'bookingChangedSinceRelease' | 'paymentReversed'>): StatusTone {
  if (row.status === 'released' && (row.bookingChangedSinceRelease || row.paymentReversed)) return 'warning';
  if (row.status === 'draft' && row.stale) return 'warning';
  return STATUS_TONE[row.status];
}

/* ---------- Accounts phase 3: automatic bills (contract 6.2–6.5, screen 5) ---------- */

/** Track B's frozen words: hold reasons and "by the CRM, rule: …" history lines. */
export { AUTO_RULE_TEXT, HOLD_REASON_TEXT };

/** "by the CRM, rule: Advance Invoice when a payment is verified" (null when a person made it). Unknown rules are named plainly. */
export function crmHistoryLine(rule: string | null | undefined): string | null {
  if (!rule) return null;
  return (AUTO_RULE_TEXT as Record<string, string>)[rule] ?? `by the CRM, rule: ${rule}`;
}

/** "Made by the CRM, rule: …" for a draft or document the CRM made (null when a person made it). */
export function madeByLine(d: Pick<AutoBillFields, 'autoRule'>): string | null {
  const line = crmHistoryLine(d.autoRule);
  return line ? `Made ${line}` : null;
}

/** "by the CRM, rule: released automatically after every check passed". */
export const RELEASED_BY_CRM_LINE = AUTO_RULE_TEXT.auto_release;

export function holdReasonWords(code: string): string {
  return (HOLD_REASON_TEXT as Record<string, string>)[code] ?? 'A check did not pass. Open the Deal to see why.';
}

export interface HoldFixLinks {
  /** Where Accounts verify the billing details of this Deal. */
  billingHref?: string | null;
  /** Accounts review of this Deal (newer version waiting). */
  reviewHref?: string | null;
}

/** The repair link for a hold code, when Accounts can fix it themselves (otherwise the words say what to do). */
export function holdFix(code: string, links: HoldFixLinks = {}): { href: string; label: string } | null {
  switch (code) {
    case 'billing_not_verified':
      return links.billingHref ? { href: links.billingHref, label: 'Verify the billing details' } : null;
    case 'newer_version_waiting':
      return links.reviewHref ? { href: links.reviewHref, label: 'Open the Accounts review' } : null;
    default:
      return null;
  }
}

/** Status words of an automatic draft (never colour alone: the badge carries an icon too). */
export function autoStateWords(d: Pick<AutoBillFields, 'autoState' | 'holdReasons'>): string | null {
  if (d.autoState === 'held') {
    const n = d.holdReasons?.length ?? 0;
    return n > 1 ? `Held — ${n} checks to fix` : 'Held — check to fix';
  }
  if (d.autoState === 'ready') return 'Checks passed';
  return null;
}
