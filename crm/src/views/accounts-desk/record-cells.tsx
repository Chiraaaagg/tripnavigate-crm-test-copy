import { Clock, FileText, FileWarning } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ui/badge';
import { cn, focusRing } from '@/components/ui/cn';
import { dayText, DEPARTMENT_LABEL, KIND_LABEL, DIRECTION_LABEL, inr, ORIGINAL_LABEL, REVIEW_LABEL, STAGE_LABEL, STAGE_TONE, TALLY_LABEL, TALLY_TONE } from './labels';
import type { RecordRow } from './types';

/*
 * Server-safe cells of one workspace row (contract 11.1 table): every status
 * is an icon plus words. Links go to the existing record screens; file links
 * go to the existing audited download routes (only those the read listed).
 */

/**
 * Where a row opens (track B decides the kind per viewer, review item 2):
 * Accounts open the record (the Accounts deal screen, or the list with the
 * record in view); a branch Manager opens the Deal's dues card; 'none' (or a
 * kind this viewer cannot open) has no link and the reference shows as text.
 * A cash record opens Branch cash on its own branch (`?branch=`) when the page
 * could tell the branch id from the row's branch name; else the bare address.
 */
export function recordHref(link: RecordRow['link'], branchId?: string | null): string | null {
  const id = link.id ? encodeURIComponent(link.id) : null;
  switch (link.kind) {
    case 'accounts_deal':
      return id ? `/app/accounts/deals/${id}` : null;
    case 'deal_dues':
      return id ? `/app/deals/${id}?tab=money#dues` : null;
    case 'claim':
      return id ? `/app/accounts/claims?filter=all#claim-${id}` : '/app/accounts/claims?filter=all';
    case 'supplier_payment':
      return id ? `/app/accounts/supplier-payments?tab=all#sp-${id}` : '/app/accounts/supplier-payments?tab=all';
    case 'supplier_document':
      return id ? `/app/accounts/supplier-invoices?tab=all#doc-${id}` : '/app/accounts/supplier-invoices?tab=all';
    case 'expense':
      return '/app/accounts/expenses';
    case 'cash':
      return branchId ? `/app/accounts/cash?branch=${encodeURIComponent(branchId)}` : '/app/accounts/cash';
    case 'flight_deal':
    case 'visa_task':
    case 'purchase_task':
    case 'none':
      return null;
  }
}

export function fileHref(kind: 'finance' | 'supplier_money' | 'department', evidenceId: string): string {
  if (kind === 'finance') return `/app/accounts/files/${evidenceId}`;
  if (kind === 'supplier_money') return `/app/accounts/supplier-payments/files/${evidenceId}`;
  return `/app/department/evidence/${evidenceId}`;
}

/** Words for the record's own status (statusCode). Unknown codes read as plain words. */
const STATUS_WORDS: Record<string, string> = {
  recorded: 'Recorded, not verified',
  verified: 'Verified',
  pending_clearance: 'Cheque waiting to clear',
  cleared: 'Cheque cleared',
  bounced: 'Cheque bounced',
  stopped: 'Cheque stopped',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
  reversed: 'Reversed',
  reported: 'Reported — not money',
  linked: 'Linked to a receipt',
  not_received: 'Not received',
  withdrawn: 'Withdrawn',
  pending: 'Waiting for approval',
  approved: 'Approved',
  paid: 'Paid, not verified',
  returned: 'Returned',
  uploaded: 'Uploaded, not checked',
  accepted: 'Accepted',
  draft: 'Draft',
  submitted: 'Sent to Accounts',
  confirmed: 'Confirmed',
  applied: 'Applied',
  active: 'Recorded',
  stale: 'Count out of date',
  counted: 'Counted',
  posted: 'Posted',
  expected: 'Expected',
  missing: 'Missing',
};
export function statusWords(code: string | null): string {
  if (!code) return '—';
  const w = STATUS_WORDS[code];
  if (w) return w;
  const plain = code.replace(/_/g, ' ');
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

export function DateCell({ row }: { row: RecordRow }) {
  return <span className="whitespace-nowrap tabular-nums">{dayText(row.recordDate)}</span>;
}

/**
 * The id of the row's branch from the page's branch choices, by name (the records read carries the branch
 * name only). null when the name is missing or not exactly one choice has it.
 */
export function rowBranchId(row: Pick<RecordRow, 'branchName' | 'collectingBranchName'>, branches: ReadonlyArray<{ id: string; name: string }>): string | null {
  const name = row.branchName ?? row.collectingBranchName;
  if (!name) return null;
  const found = branches.filter((b) => b.name === name);
  return found.length === 1 ? found[0]!.id : null;
}

export function ReferenceCell({ row, branches = [] }: { row: RecordRow; branches?: ReadonlyArray<{ id: string; name: string }> }) {
  const href = recordHref(row.link, row.link.kind === 'cash' ? rowBranchId(row, branches) : null);
  return (
    <span className="flex min-w-0 flex-col">
      <span className="text-xs font-semibold tracking-label text-quiet uppercase">{KIND_LABEL[row.kind]}</span>
      {href ? (
        <Link href={href} className={cn('w-fit rounded-chip font-semibold wrap-anywhere text-brand-strong underline-offset-4 hover:underline', focusRing)}>
          {row.reference ?? KIND_LABEL[row.kind]}
        </Link>
      ) : (
        <span className="font-semibold wrap-anywhere text-ink">{row.reference ?? KIND_LABEL[row.kind]}</span>
      )}
      {row.otherReferences.length > 0 ? <span className="text-sm wrap-anywhere text-quiet">{row.otherReferences.join(' · ')}</span> : null}
      {row.dealReference ? (
        <span className="text-sm text-copy">
          Deal {row.dealReference}
          {row.bitrixDealId ? <span className="text-quiet"> · Bitrix {row.bitrixDealId}</span> : null}
        </span>
      ) : null}
      <span className="text-xs text-quiet">
        {row.branchName ?? ''}
        {row.collectingBranchName && row.collectingBranchName !== row.branchName ? ` · collected by ${row.collectingBranchName}` : ''}
      </span>
    </span>
  );
}

export function WhoCell({ row }: { row: RecordRow }) {
  const dept = row.department ? DEPARTMENT_LABEL[row.department] : null;
  // "Flight 1" already names the department: never "Flight · Flight 1".
  const parts = (row.serviceLabel && dept && row.serviceLabel.toLowerCase().startsWith(dept.split(' ')[0]!.toLowerCase()) ? [row.serviceLabel] : [dept, row.serviceLabel]).filter(Boolean).join(' · ');
  return (
    <span className="flex min-w-0 flex-col">
      {parts ? <span>{parts}</span> : <span className="text-quiet">—</span>}
      {row.supplierName ? <span className="text-sm wrap-anywhere text-quiet">{row.supplierName}</span> : null}
    </span>
  );
}

export function AmountCell({ row }: { row: RecordRow }) {
  return (
    <span className="flex flex-col items-end max-sm:items-start">
      <span className="font-semibold whitespace-nowrap text-ink tabular-nums">{row.amountPaise === null ? '—' : inr(row.amountPaise)}</span>
      <span className="text-xs text-quiet">{DIRECTION_LABEL[row.direction]}</span>
    </span>
  );
}

/**
 * UX redesign R4 (audit A5): the row's status on one line. Two badges, the
 * record's stage and its Tally status (each an icon plus words, with
 * screen-reader prefixes), plus "Changed since export" only when it applies;
 * the other facts (the record's own status words, review, voucher, last
 * export) follow as one quiet line, and a Tally exception reason stays on
 * its own line because it is the next thing to fix.
 */
export function statusFacts(row: RecordRow, showVoucher: boolean): string[] {
  const t = row.tally;
  return [
    row.statusCode ? statusWords(row.statusCode) : null,
    row.reviewStatus !== 'not_needed' ? `Review: ${REVIEW_LABEL[row.reviewStatus]}` : null,
    showVoucher && t.voucherRef ? `Voucher ${t.voucherRef}` : null,
    t.lastExportedAt ? `Exported ${dayText(t.lastExportedAt)}${t.exportCount > 1 ? ` (${t.exportCount} times)` : ''}` : null,
  ].filter((f): f is string => !!f);
}

export function StatusLine({ row, showVoucher }: { row: RecordRow; showVoucher: boolean }) {
  const t = row.tally;
  const facts = statusFacts(row, showVoucher);
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="flex flex-wrap gap-1.5">
        <StatusBadge tone={STAGE_TONE[row.stage]}>
          <span className="sr-only">Stage: </span>
          {STAGE_LABEL[row.stage]}
        </StatusBadge>
        <StatusBadge tone={TALLY_TONE[t.status]}>
          <span className="sr-only">Tally: </span>
          {TALLY_LABEL[t.status]}
        </StatusBadge>
        {t.changedSinceExport ? <StatusBadge tone="warning">Changed since export</StatusBadge> : null}
      </span>
      {facts.length > 0 ? <span className="text-sm wrap-anywhere text-quiet">{facts.join(' · ')}</span> : null}
      {showVoucher && t.exceptionReason ? <span className="text-sm wrap-anywhere text-status-danger">{t.exceptionReason}</span> : null}
    </span>
  );
}

function ownerText(role: string, name: string | null): string {
  const r = (DEPARTMENT_LABEL as Record<string, string>)[role] ?? role;
  return name ? `${name} (${r})` : r;
}

export function FilesCell({ row }: { row: RecordRow }) {
  const { files, original } = row;
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      {files.links.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {files.links.map((f) => (
            <li key={f.evidenceId} className="m-0">
              <a href={fileHref(f.kind, f.evidenceId)} rel="noopener" className={cn('inline-flex items-start gap-1 rounded-chip text-sm font-medium wrap-anywhere text-brand-strong underline underline-offset-4', focusRing)}>
                <FileText aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                {f.fileName}
              </a>
            </li>
          ))}
        </ul>
      ) : files.count > 0 ? (
        <span className="text-sm text-copy">
          {files.count} {files.count === 1 ? 'file' : 'files'}
        </span>
      ) : (
        <span className="text-sm text-quiet">No files</span>
      )}
      {original ? (
        <span className={cn('flex items-start gap-1 text-sm', original.state === 'missing' ? 'font-medium text-status-danger' : 'text-status-warning')}>
          {original.state === 'missing' ? <FileWarning aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /> : <Clock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />}
          <span>
            {ORIGINAL_LABEL[original.what]} {original.state === 'missing' ? 'missing' : 'expected'} since {dayText(original.since)}.{' '}
            <span className="text-copy">
              {ownerText(original.ownerRole, original.ownerName)} {original.what === 'gst_invoice_ref' ? 'must type it in' : 'must upload it'}.
            </span>
          </span>
        </span>
      ) : null}
    </span>
  );
}
