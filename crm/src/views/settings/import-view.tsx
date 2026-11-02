'use client';

import { CircleCheck, FileSpreadsheet, History, Upload } from 'lucide-react';
import { useState, useTransition, type FormEvent } from 'react';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs } from '@/components/ui/tabs';
import { dateText } from '../b11/book-fields';
import { AreaField, SelectField } from '../b11/controls';
import { newRequestId, ResultBox, useB11Action, type UiResult } from '../b11/form-kit';
import type { ImportActions, ImportBatchRow, ImportBranchChoice, ImportKind, ImportStatus, ImportSummaryView } from '../booking-form/vn-types';
import { SettingsSectionHeading } from './settings-frame';

/*
 * Admin · Import hotels or customers from a CSV file (voice-note batch, owner
 * item 5). Step 1 checks the file and shows a read-only summary: which
 * columns are used, how many rows are ready, invalid rows with reasons,
 * possible duplicates (never merged by name), and what would be created or
 * updated. Checked records are never overwritten; imported records start
 * Not checked. Step 2, "Apply import", is a separate confirmed action for
 * the role that owns that list, with a reason. History lists earlier files.
 */

const KIND_WORD: Record<ImportKind, { one: string; many: string; owner: string }> = {
  hotel: { one: 'hotel', many: 'hotels', owner: 'a Super Admin' },
  customer: { one: 'customer', many: 'customers', owner: 'Accounts' },
};
const STATUS_LOOK: Record<ImportStatus, { word: string; tone: StatusTone }> = {
  validated: { word: 'Checked, not applied', tone: 'warning' },
  applied: { word: 'Applied', tone: 'success' },
  expired: { word: 'Out of date: check the file again', tone: 'neutral' },
};
const FILE_MAX = '2 MB';

export function ImportView({
  kind,
  kindLinks,
  canApply,
  summary: initialSummary,
  history,
  actions,
  branchChoice = null,
}: {
  kind: ImportKind;
  kindLinks: Array<{ kind: ImportKind; label: string; href: string; current: boolean }>;
  canApply: boolean;
  summary: ImportSummaryView | null;
  /** null = the history could not be read. */
  history: ImportBatchRow[] | null;
  actions: ImportActions;
  /** Customer imports: the branch choice (Echo-A M1). Absent for hotel imports. */
  branchChoice?: ImportBranchChoice | null;
}) {
  const w = KIND_WORD[kind];
  const [validateState, validateAction] = useB11Action(actions.validate);
  const [checking, startCheck] = useTransition();
  const [local, setLocal] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyText, setApplyText] = useState<string | null>(null);
  const fromAction = validateState?.ok ? ((validateState as { data?: { summary?: ImportSummaryView } }).data?.summary ?? null) : null;
  const [appliedBatch, setAppliedBatch] = useState<string | null>(null);
  const latest = fromAction ?? initialSummary;
  // A refreshed page may still carry the checked summary; once applied here it reads Applied.
  const summary = latest && latest.batchId === appliedBatch ? { ...latest, status: 'applied' as const } : latest;
  const onCheck = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const file = (e.currentTarget.elements.namedItem('file') as HTMLInputElement | null)?.files?.[0];
    if (!file) {
      setLocal('Choose the CSV file first.');
      requestAnimationFrame(() => document.getElementById('import-file')?.focus());
      return;
    }
    if (!/\.csv$/i.test(file.name)) {
      setLocal('Use a CSV file (in Excel: File, Save As, CSV UTF-8).');
      requestAnimationFrame(() => document.getElementById('import-file')?.focus());
      return;
    }
    if (kind === 'customer' && branchChoice && !branch) {
      setLocal('Choose the branch the customers belong to, or Whole company.');
      requestAnimationFrame(() => document.getElementById('import-branch')?.focus());
      return;
    }
    setLocal(null);
    setApplyText(null);
    const fd = new FormData(e.currentTarget);
    fd.set('requestId', newRequestId());
    startCheck(() => validateAction(fd));
  };
  const [branch, setBranch] = useState<string>(() => branchChoice?.defaultBranchId ?? '');
  const canApplyNow = canApply && summary?.status === 'validated' && !summary.applyBlockedReason && summary.counts.creates + summary.counts.updates > 0;
  return (
    <div className="flex flex-col gap-5 font-sans text-base text-copy">
      <SettingsSectionHeading description={`Add or update the stored ${w.many} from a CSV file. Nothing is saved until you apply.`}>Import {w.many}</SettingsSectionHeading>
      {kindLinks.length > 1 ? <Tabs label="What to import" items={kindLinks.map((k) => ({ href: k.href, label: k.label, current: k.current }))} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>1. Check the file</CardTitle>
          <CardDescription>CSV saved from Excel (CSV UTF-8), up to 5,000 rows and {FILE_MAX}. The first row holds the column names.</CardDescription>
        </CardHeader>
        <CardBody>
          <form onSubmit={onCheck} noValidate aria-label={`Check a ${w.one} file`} className="flex flex-col gap-3">
            <ResultBox
              result={local ? ({ ok: false, code: 'invalid_input', message: local, fields: [local.startsWith('Choose the branch') ? 'branchId' : 'file'] } as UiResult) : validateState && !validateState.ok ? validateState : null}
              fields={[
                { field: 'file', id: 'import-file', label: 'CSV file' },
                { field: 'branchId', id: 'import-branch', label: 'Branch' },
              ]}
            />
            <input type="hidden" name="kind" value={kind} />
            {kind === 'customer' && branchChoice ? (
              <>
                <SelectField
                  id="import-branch"
                  name="branchChoice"
                  label="Customers belong to"
                  hint="Sales and Managers of this branch can find them. Whole company: every branch can."
                  value={branch}
                  onChange={setBranch}
                  options={[{ value: '', label: 'Choose' }, ...branchChoice.options.map((b) => ({ value: b.branchId, label: b.name })), { value: 'company', label: 'Whole company (every branch)' }]}
                  className="max-w-md"
                />
                {/* Posted as a branch id, or an explicit whole-company choice (never a silent default). */}
                <input type="hidden" name="branchScope" value={branch === 'company' ? 'company' : branch ? 'branch' : ''} />
                <input type="hidden" name="branchId" value={branch === 'company' ? '' : branch} />
              </>
            ) : null}
            <div className="flex flex-wrap items-end gap-3">
              <Field htmlFor="import-file" label="CSV file" className="min-w-0 flex-1">
                <input
                  id="import-file"
                  name="file"
                  type="file"
                  accept=".csv,text/csv"
                  className="block w-full rounded-control border border-control bg-card px-3 py-2 font-sans text-base text-ink file:mr-3 file:rounded-control file:border-0 file:bg-wash file:px-3 file:py-1.5 file:font-semibold file:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-strong"
                />
              </Field>
              <Button type="submit" variant={summary ? 'secondary' : 'primary'} className="min-h-11" loading={checking}>
                <Upload aria-hidden="true" />
                {checking ? 'Checking…' : 'Check file'}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      {summary ? <SummaryCard summary={summary} canApply={canApply} canApplyNow={canApplyNow} onApply={() => setApplying(true)} applyText={applyText} /> : null}
      {summary && applying ? (
        <ApplyDialog
          summary={summary}
          action={actions.apply}
          onClose={(text) => {
            setApplying(false);
            if (text) {
              setApplyText(text);
              setAppliedBatch(summary.batchId);
            }
          }}
        />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>
            <span className="inline-flex items-center gap-2">
              <History aria-hidden="true" className="size-4.5 text-quiet" />
              Earlier files
            </span>
          </CardTitle>
        </CardHeader>
        <CardBody>
          {history === null ? (
            <Notice tone="warning">The list of earlier files could not be read. Nothing was changed.</Notice>
          ) : history.length === 0 ? (
            <p className="m-0 text-quiet">No {w.one} files yet.</p>
          ) : (
            <Table label={`Earlier ${w.one} files`} stackOnMobile>
              <TableCaption>Latest first</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead numeric>Rows</TableHead>
                  <TableHead numeric>New</TableHead>
                  <TableHead numeric>Updated</TableHead>
                  <TableHead numeric>Invalid</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((h) => (
                  <TableRow key={h.batchId}>
                    <TableCell label="File">
                      <span className="font-medium wrap-anywhere text-ink">{h.fileName}</span>
                      <span className="block text-sm text-quiet">
                        {dateText(h.at)}
                        {h.byName ? ` · ${h.byName}` : ''}
                      </span>
                    </TableCell>
                    <TableCell label="Status">
                      <StatusBadge tone={STATUS_LOOK[h.status].tone}>{STATUS_LOOK[h.status].word}</StatusBadge>
                    </TableCell>
                    <TableCell label="Rows" numeric>
                      {h.rows}
                    </TableCell>
                    <TableCell label="New" numeric>
                      {h.creates}
                    </TableCell>
                    <TableCell label="Updated" numeric>
                      {h.updates}
                    </TableCell>
                    <TableCell label="Invalid" numeric>
                      {h.invalid}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardBody>
      </Card>
      {!canApply ? <p className="m-0 text-sm text-quiet">Only {w.owner} can apply a {w.one} file. You can check files and read the result.</p> : null}
    </div>
  );
}

function Count({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="flex min-w-28 flex-col gap-0.5 rounded-control bg-wash px-3 py-2.5">
      <span className="text-sm text-quiet">{label}</span>
      <strong className="text-xl font-semibold text-ink tabular-nums">{value.toLocaleString('en-IN')}</strong>
      {note ? <span className="text-xs text-quiet">{note}</span> : null}
    </div>
  );
}

function SummaryCard({ summary: s, canApply, canApplyNow, onApply, applyText }: { summary: ImportSummaryView; canApply: boolean; canApplyNow: boolean; onApply: () => void; applyText: string | null }) {
  const w = KIND_WORD[s.kind];
  const c = s.counts;
  const look = STATUS_LOOK[s.status];
  const ignored = s.mapping.filter((m) => m.field === null);
  return (
    <Card>
      <section aria-labelledby="import-summary-heading">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle id="import-summary-heading">2. Check result</CardTitle>
            <StatusBadge tone={look.tone}>{look.word}</StatusBadge>
          </div>
          <CardDescription>
            <span className="inline-flex items-center gap-1.5 wrap-anywhere">
              <FileSpreadsheet aria-hidden="true" className="size-4 shrink-0" />
              {s.fileName}
            </span>
          </CardDescription>
          {s.kind === 'customer' && s.branchName !== undefined ? (
            <p className="m-0 text-sm text-copy">{s.branchName ? `For branch: ${s.branchName}` : 'For the whole company (every branch)'}</p>
          ) : null}
        </CardHeader>
        <CardBody className="flex flex-col gap-5">
          {applyText ? (
            <Notice tone="success" role="status" icon={CircleCheck}>
              {applyText}
            </Notice>
          ) : null}
          <div className="flex flex-wrap gap-2.5" role="group" aria-label="Counts">
            <Count label="Rows" value={c.rows} />
            <Count label="Ready" value={c.valid} />
            <Count label="Invalid" value={c.invalid} note="left out" />
            <Count label="Possible duplicates" value={c.duplicates} note="never merged" />
            <Count label={`New ${w.many}`} value={c.creates} />
            <Count label="Updates" value={c.updates} note="by ID column only" />
            <Count label="Unchanged" value={c.unchanged} />
            <Count label="Skipped" value={c.skippedVerified} note="checked, never overwritten" />
          </div>

          <details className="group/map">
            <summary className="w-fit cursor-pointer rounded-chip text-sm font-medium text-brand-strong">
              Columns used ({s.mapping.length - ignored.length} of {s.mapping.length}){ignored.length ? ` · ${ignored.length} not imported` : ''}
            </summary>
            <ul className="m-0 mt-2.5 flex list-none flex-col gap-1 p-0 text-sm">
              {s.mapping.map((m) => (
                <li key={m.column}>
                  <span className="font-medium text-ink">{m.column}</span> {m.field ? `→ ${m.field}` : <span className="text-quiet">→ not imported</span>}
                </li>
              ))}
            </ul>
          </details>

          {s.invalidRows.length > 0 ? (
            <RowList title={`Invalid rows (${c.invalid})`} more={c.invalid - s.invalidRows.length} items={s.invalidRows.map((r) => ({ rowNo: r.rowNo, text: r.reasons.join('; ') }))} />
          ) : null}
          {s.duplicateRows.length > 0 ? <RowList title={`Possible duplicates (${c.duplicates})`} more={c.duplicates - s.duplicateRows.length} items={s.duplicateRows} /> : null}
          {(s.assumedRows ?? 0) + (s.clearingRows ?? 0) > 0 ? (
            <details className="group/assumed">
              <summary className="w-fit cursor-pointer rounded-chip text-sm font-medium text-brand-strong">
                {[
                  (s.assumedRows ?? 0) > 0 ? `${s.assumedRows} ${s.assumedRows === 1 ? 'row' : 'rows'} with assumed values` : null,
                  (s.clearingRows ?? 0) > 0 ? `${s.clearingRows} ${s.clearingRows === 1 ? 'row' : 'rows'} will clear stored values` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </summary>
              <div className="mt-2.5">
                <RowList title="Row notes (check them before you import)" more={Math.max(0, (s.assumedRows ?? 0) + (s.clearingRows ?? 0) - new Set((s.rowNotes ?? []).map((r) => r.rowNo)).size)} items={s.rowNotes ?? []} />
              </div>
            </details>
          ) : null}
          {s.proposed.length > 0 ? (
            <RowList
              title={`What would change (${c.creates + c.updates})`}
              more={c.creates + c.updates - s.proposed.length}
              items={s.proposed.map((p) => ({ rowNo: p.rowNo, text: `${p.action === 'create' ? 'New' : 'Update'}: ${p.name}${p.changes.length ? ` (${p.changes.join(', ')})` : ''}` }))}
            />
          ) : null}

          {s.status === 'validated' ? (
            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <p className="m-0 text-sm text-quiet">Applied {w.many} start Not checked. Invalid rows are left out.</p>
              {s.applyBlockedReason ? <Notice tone="warning">{s.applyBlockedReason}</Notice> : null}
              {canApply ? (
                <div>
                  <Button variant="primary" size="lg" disabled={!canApplyNow} onClick={onApply}>
                    3. Apply import
                  </Button>
                  {!canApplyNow && !s.applyBlockedReason ? <p className="m-0 mt-1.5 text-sm text-quiet">Nothing to apply: no new {w.many} and no updates.</p> : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </CardBody>
      </section>
    </Card>
  );
}

function RowList({ title, items, more }: { title: string; items: Array<{ rowNo: number; text: string }>; more: number }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 text-base font-semibold text-ink">{title}</h3>
      <ul className="m-0 flex max-h-72 list-none flex-col overflow-auto rounded-control border border-line p-0 text-sm">
        {items.map((r) => (
          <li key={`${r.rowNo}-${r.text}`} className="flex gap-3 border-b border-line px-3 py-2 last:border-b-0">
            <span className="w-16 shrink-0 text-quiet tabular-nums">Row {r.rowNo}</span>
            <span className="min-w-0 wrap-anywhere">{r.text}</span>
          </li>
        ))}
      </ul>
      {more > 0 ? <p className="m-0 text-sm text-quiet">{more.toLocaleString('en-IN')} more not shown.</p> : null}
    </section>
  );
}

function ApplyDialog({ summary: s, action, onClose }: { summary: ImportSummaryView; action: ImportActions['apply']; onClose: (text: string | null) => void }) {
  const w = KIND_WORD[s.kind];
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  const [state, formAction] = useB11Action(action);
  const [pending, start] = useTransition();
  const [requestId] = useState(() => newRequestId());
  const [seen, setSeen] = useState<UiResult | null>(null);
  if (state !== seen) {
    setSeen(state);
    if (state?.ok) {
      const done = (state as { data?: { applied?: { creates?: number; updates?: number } } }).data?.applied;
      onClose(done ? `Applied: ${done.creates ?? 0} new ${w.many}, ${done.updates ?? 0} updated. They start Not checked.` : 'Import applied.');
    }
  }
  const refused = Boolean(state && !state.ok && ((state as { fields?: string[] }).fields ?? []).includes('reason'));
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose(null);
      }}
    >
      <DialogContent closeLabel="Close without applying">
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const len = reason.trim().length;
            if (len < 10 || len > 500) {
              setLocal('Type a reason of 10 to 500 characters.');
              requestAnimationFrame(() => document.getElementById('import-reason')?.focus());
              return;
            }
            setLocal(null);
            const fd = new FormData();
            fd.set('batchId', s.batchId);
            // Echo-A L3: apply exactly what this summary shows; a newer check is refused.
            if (s.rowVersion !== undefined) fd.set('batchRowVersion', String(s.rowVersion));
            if (s.proposalHash) fd.set('proposalHash', s.proposalHash);
            fd.set('reason', reason.trim());
            fd.set('requestId', requestId);
            start(() => formAction(fd));
          }}
        >
          <DialogHeader>
            <DialogTitle>Apply this import?</DialogTitle>
            <DialogDescription>
              {s.counts.creates} new {s.counts.creates === 1 ? w.one : w.many} and {s.counts.updates} {s.counts.updates === 1 ? 'update' : 'updates'} from {s.fileName}. Invalid rows and checked records are left as they are.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            <ResultBox result={state && !state.ok && !refused ? state : null} />
            <AreaField id="import-reason" name="reason" label="Reason" hint="10 to 500 characters, for the history." rows={3} maxLength={500} value={reason} onChange={setReason} error={local ?? (refused ? 'Type a reason of 10 to 500 characters.' : null)} />
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => onClose(null)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={pending}>
              {pending ? 'Applying…' : 'Apply import'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
