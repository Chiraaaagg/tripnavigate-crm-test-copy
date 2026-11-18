import type { StatusTone } from '@/components/ui/badge';
import { LEFT_OUT_REASONS, MATCH_OUTCOMES, type LeftOutReason, type MatchOutcome, type TallyAnyKind, type TallyFileKind } from './types';

/*
 * Words and addresses for the Tally file screens (Accounts phase 3, contract
 * 7, 15 screen 7). Pure, unit-tested (tests/unit/acc3u-tally-labels.test.ts).
 * Refusal messages are track C's frozen texts (contract 13); copies here are
 * for the preview gallery.
 */

export const TALLY_PATH = '/app/accounts/tally';

export const FILE_KIND_LABEL: Record<TallyFileKind, string> = {
  journal_entry: 'Customer receipts, cash deposits and customer refunds',
  supplier_payment: 'Supplier payments',
  supplier_refund: 'Supplier refunds',
  write_off: 'Write-offs',
};

export const ANY_KIND_LABEL: Record<TallyAnyKind, string> = {
  ...FILE_KIND_LABEL,
  journal_entry: 'Customer money entry',
  supplier_document: 'Supplier invoice or credit note',
  expense: 'Company-paid expense',
  tally_gst_invoice: 'GST invoice reference',
  customer_document: 'Customer document',
};

export const LEFT_OUT_WORDS: Record<LeftOutReason, { word: string; fix: string }> = {
  ledger_not_mapped: { word: 'A ledger name is missing', fix: 'Fill the ledger in Tally ledger mapping.' },
  party_not_mapped: { word: 'The customer has no Tally party name', fix: 'Add the Tally party name on the customer page.' },
  voucher_type_missing: { word: 'The voucher type is missing', fix: 'Fill the voucher type in Tally ledger mapping.' },
  already_in_file: { word: 'Already in an earlier Tally file', fix: 'Tick "Include again" with a reason only if Tally lost it.' },
  kind_not_in_file: { word: 'Not part of the Tally file', fix: 'Enter it in Tally by hand; the CSV still lists it.' },
  changed_since_file: { word: 'Changed after it went into a file', fix: 'Check the entry in Tally, then include it again with a reason.' },
};

export const MATCH_WORDS: Record<MatchOutcome, { word: string; tone: StatusTone; effect: string }> = {
  matched: { word: 'Matched', tone: 'success', effect: 'Gets the Tally voucher number and is marked matched.' },
  amount_differs: { word: 'Amount differs', tone: 'danger', effect: 'Becomes a Tally exception for the exception owner.' },
  not_found: { word: 'Not found in the CRM', tone: 'warning', effect: 'Nothing changes.' },
  already_matched: { word: 'Already matched', tone: 'neutral', effect: 'Nothing changes.' },
  duplicate_in_file: { word: 'Twice in this file', tone: 'warning', effect: 'Nothing changes.' },
  no_tag: { word: 'No TN: tag', tone: 'neutral', effect: 'Entered in Tally by hand or before the CRM; nothing changes.' },
};

export const BATCH_STATUS_WORDS = {
  staged: { word: 'Checked — not applied yet', tone: 'info' as StatusTone },
  applied: { word: 'Applied', tone: 'success' as StatusTone },
  cancelled: { word: 'Cancelled', tone: 'neutral' as StatusTone },
};

export const TALLY_FILE_REFUSAL = {
  tally_xml_off: 'The Tally file is not switched on yet.',
  nothing_to_export: 'Nothing can go into the file. See the left-out list for the reasons.',
  version_changed: 'Someone changed this meanwhile. Reload and try again.',
} as const;

export { tallyXmlHref } from '@/modules/accounts-desk/contracts';

export function leftOutHref(exportId: string, after?: string | null): string {
  const base = `${TALLY_PATH}/exports/${encodeURIComponent(exportId)}/left-out`;
  return after ? `${base}?after=${encodeURIComponent(after)}` : base;
}

export function matchBatchHref(batchId: string, outcome?: MatchOutcome | null, after?: string | null): string {
  const q = new URLSearchParams();
  if (outcome) q.set('outcome', outcome);
  if (after) q.set('after', after);
  const s = q.toString();
  return `${TALLY_PATH}/matches/${encodeURIComponent(batchId)}${s ? `?${s}` : ''}`;
}

/** Counts per left-out reason in the fixed order (zero counts dropped). */
export function reasonCounts(byReason: Partial<Record<LeftOutReason, number>>): Array<{ reason: LeftOutReason; count: number }> {
  return LEFT_OUT_REASONS.map((reason) => ({ reason, count: byReason[reason] ?? 0 })).filter((r) => r.count > 0);
}

/** What applying a staged batch will do, in plain counts. */
export function applySummary(summary: Record<MatchOutcome, number>): { willMatch: number; willBecomeExceptions: number; unchanged: number; total: number } {
  const total = MATCH_OUTCOMES.reduce((n, o) => n + (summary[o] ?? 0), 0);
  const willMatch = summary.matched ?? 0;
  const willBecomeExceptions = summary.amount_differs ?? 0;
  return { willMatch, willBecomeExceptions, unchanged: total - willMatch - willBecomeExceptions, total };
}

/** Parses the outcome filter of the match page (unknown values = all). */
export function parseOutcome(v: string | string[] | undefined): MatchOutcome | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s && (MATCH_OUTCOMES as readonly string[]).includes(s) ? (s as MatchOutcome) : null;
}

/** Tally party name rule mirror (1..100 characters, no control characters); null = fine. */
export function partyNameProblem(name: string): string | null {
  const t = name.trim();
  if (t.length === 0) return 'Type the party name exactly as it is in Tally.';
  if (t.length > 100) return 'At most 100 characters.';
  if (/[\u0000-\u001f\u007f]/.test(t)) return 'Remove tabs and line breaks.';
  return null;
}
