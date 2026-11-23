'use client';

import { Download, FileCode2, ListX, Search } from 'lucide-react';
import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { ErrorSummary } from '@/components/ui/error-summary';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { refusalMessage, refusedField, todayIst, useDeskCommand, useRefusedControl, type DeskResult } from '@/views/accounts-desk/desk-kit';
import { dayText, inr } from '@/views/accounts-desk/labels';
import { Hidden, type DecisionAction } from '@/views/accounts/supplier-forms';
import { ANY_KIND_LABEL, FILE_KIND_LABEL, LEFT_OUT_WORDS, leftOutHref, reasonCounts, tallyXmlHref } from './labels';
import { TALLY_FILE_KINDS, TF_FIELD, type TallyFileCreated, type TallyFilePreview } from './types';

/*
 * Accounts › Tally › "Make Tally file" (contract 7.3 C3, R-C2; 15 screen 7).
 * Choose the period, types and branches; "Show what goes in" lists the
 * vouchers the file would hold and every record left out with the reason
 * and how to fix it. "Make Tally file" freezes the lines and gives the XML
 * download. Records already in a file stay out unless "Include again" is
 * ticked with a reason. Typed choices stay after a refusal. The CRM never
 * contacts Tally: Accounts import the file by hand.
 */

export const TALLY_MAPPING_HREF = '/app/admin/accounts/tally-mapping';
const PREVIEW_ROWS = 50;

export function MakeTallyFilePanel({
  enabled,
  companyName,
  entities,
  branches,
  previewAction,
  createAction,
  initialPreview = null,
  initialState = null,
  initialIncludeAgain = false,
}: {
  /** accounts_settings.tally_xml_enabled. */
  enabled: boolean;
  companyName: string | null;
  entities: Array<{ id: string; name: string }>;
  branches: Array<{ id: string; name: string }>;
  previewAction: DecisionAction;
  createAction: DecisionAction;
  /** Preview gallery: start with a preview or a result on screen. */
  initialPreview?: DeskResult | null;
  initialState?: DeskResult | null;
  initialIncludeAgain?: boolean;
}) {
  const uid = useId();
  const look = useDeskCommand(previewAction, initialPreview);
  const make = useDeskCommand(createAction, initialState);
  const [formEl, setFormEl] = useState<HTMLFormElement | null>(null);
  const [again, setAgain] = useState(initialIncludeAgain);
  const summaryId = useId();
  const refused = (make.state && !make.state.ok ? make.state : null) ?? (look.state && !look.state.ok ? look.state : null);
  const target = useRefusedControl(formEl, refused, summaryId);
  const resultRef = useRef<HTMLDivElement>(null);
  const preview = look.state?.ok ? ((look.state as { data?: TallyFilePreview }).data ?? null) : null;
  const created = make.state?.ok ? ((make.state as { data?: TallyFileCreated }).data ?? null) : null;
  const today = todayIst();
  const monthStart = `${today.slice(0, 8)}01`;
  const pending = look.pending || make.pending;

  if (!enabled)
    return (
      <Notice tone="locked" title="The Tally file is not switched on yet.">
        <p>A Super Admin switches it on in Settings · Accounts and types the Tally company name. Until then use the CSV export below.</p>
      </Notice>
    );

  return (
    <form
      ref={setFormEl}
      noValidate
      aria-labelledby={`${uid}-h`}
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        if (pending) {
          e.preventDefault();
          return;
        }
        const after = () => requestAnimationFrame(() => resultRef.current?.focus());
        if (submitter?.value === 'preview') {
          make.setState(null);
          look.submit(e, after);
        } else {
          // UI review finding 9: an earlier preview refusal must not stay on screen once Create is pressed.
          if (look.state && !look.state.ok) look.setState(null);
          make.submit(e, after);
        }
      }}
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${uid}-h`} className="m-0 text-lg font-semibold text-ink">
          Make Tally file
        </h2>
        <p className="m-0 max-w-prose text-copy">
          A TallyPrime file of money vouchers{companyName ? (
            <>
              {' '}for the Tally company <strong className="text-ink">{companyName}</strong>
            </>
          ) : null}
          . Import it in Tally yourself (Import · Vouchers). Tally numbers the vouchers; no ledger is ever created by the file.
        </p>
      </div>
      <Hidden fields={{ requestId: make.requestId }} />
      {refused ? (
        <div id={summaryId}>
          <ErrorSummary title={make.state && !make.state.ok ? 'No file was made' : 'The check did not run'} description={refusalMessage(refused)} focusOnMount={!refusedField(refused)} items={target ? [{ fieldId: target.id, text: `Check: ${target.label}` }] : []}>
            <p className="m-0 mt-[0.25rem] text-sm">Your choices are still here.</p>
          </ErrorSummary>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {entities.length > 1 ? (
          <Field htmlFor={`${uid}-entity`} label="Company">
            <Select id={`${uid}-entity`} name={TF_FIELD.entityId} defaultValue={entities[0]?.id}>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <input type="hidden" name={TF_FIELD.entityId} value={entities[0]?.id ?? ''} />
        )}
        <Field htmlFor={`${uid}-from`} label="From (accounting date)">
          <Input id={`${uid}-from`} name={TF_FIELD.from} type="date" required defaultValue={monthStart} max={today} />
        </Field>
        <Field htmlFor={`${uid}-to`} label="To" hint="Up to today.">
          <Input id={`${uid}-to`} name={TF_FIELD.to} type="date" required defaultValue={today} max={today} aria-describedby={`${uid}-to-hint`} />
        </Field>
      </div>
      <fieldset className="m-0 border-0 p-0">
        <legend className="mb-1.5 text-sm font-semibold text-ink">Voucher types</legend>
        <ul className="m-0 flex list-none flex-col gap-1 p-0 sm:flex-row sm:flex-wrap sm:gap-x-5">
          {TALLY_FILE_KINDS.map((k) => (
            <li key={k} className="m-0">
              <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-sm text-copy">
                <input type="checkbox" name={TF_FIELD.kinds} value={k} defaultChecked className="size-4 accent-brand-strong" />
                {FILE_KIND_LABEL[k]}
              </label>
            </li>
          ))}
        </ul>
        <p className="m-0 mt-1.5 text-sm text-quiet">Never in the file: customer bills, supplier bills, GST invoice references, receipt reversals and company-paid expenses. Enter those in Tally by hand.</p>
      </fieldset>
      {branches.length > 1 ? (
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-1.5 text-sm font-semibold text-ink">Branches</legend>
          <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1 p-0">
            {branches.map((b) => (
              <li key={b.id} className="m-0">
                <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-sm text-copy">
                  <input type="checkbox" name={TF_FIELD.branchIds} value={b.id} defaultChecked className="size-4 accent-brand-strong" />
                  {b.name}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
      <div className="flex flex-col gap-2">
        <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-sm text-copy">
          <input type="checkbox" name={TF_FIELD.includeAgain} value="true" checked={again} onChange={(e) => setAgain(e.target.checked)} className="size-4 accent-brand-strong" aria-controls={`${uid}-again`} />
          Include again entries already in an earlier Tally file
        </label>
        {again ? (
          <div id={`${uid}-again`}>
            <Field htmlFor={`${uid}-reason`} label="Why include them again" hint="10 to 500 characters, for example: the earlier import into Tally failed. Saved with the file.">
              <Textarea id={`${uid}-reason`} name={TF_FIELD.includeReason} minLength={10} maxLength={500} rows={2} aria-describedby={`${uid}-reason-hint`} />
            </Field>
          </div>
        ) : (
          <div id={`${uid}-again`} hidden />
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="intent" value="preview" variant="secondary" aria-disabled={pending || undefined}>
          <Search aria-hidden="true" />
          {look.pending ? 'Checking…' : 'Show what goes in'}
        </Button>
        <Button type="submit" name="intent" value="create" aria-disabled={pending || undefined}>
          <FileCode2 aria-hidden="true" />
          {make.pending ? 'Making the file…' : 'Make Tally file'}
        </Button>
      </div>
      <div ref={resultRef} tabIndex={-1} className="flex flex-col gap-4 outline-none" role="status" aria-live="polite">
        {created ? (
          <Notice tone="success" title={`Tally file ${created.exportNo}: ${created.lines} ${created.lines === 1 ? 'voucher' : 'vouchers'}${created.leftOut ? `, ${created.leftOut} left out` : ''}`}>
            <p>Import it in Tally, then upload Tally&apos;s Day Book below so the CRM can match the voucher numbers.</p>
            <p className="flex flex-wrap gap-2">
              <a href={tallyXmlHref(created.exportId)} className={buttonVariants({ variant: 'secondary' })} download>
                <Download aria-hidden="true" />
                Download Tally file (XML)
              </a>
              {created.leftOut ? (
                <Link href={leftOutHref(created.exportId)} className={buttonVariants({ variant: 'ghost' })}>
                  <ListX aria-hidden="true" />
                  See what was left out
                </Link>
              ) : null}
            </p>
          </Notice>
        ) : preview ? (
          <FilePreview preview={preview} />
        ) : null}
      </div>
    </form>
  );
}

function FilePreview({ preview }: { preview: TallyFilePreview }) {
  const counts = reasonCounts(preview.counts.byReason);
  const needsMapping = counts.some((c) => c.reason === 'ledger_not_mapped' || c.reason === 'voucher_type_missing');
  return (
    <section aria-label="What the file would hold" className="flex flex-col gap-3">
      {preview.companyName ? (
        <p className="m-0 text-sm text-copy">
          For the Tally company <strong className="text-ink">{preview.companyName}</strong>. Import it into that company only.
        </p>
      ) : null}
      <Notice tone={preview.counts.lines > 0 ? 'info' : 'warning'} title={`${preview.counts.lines} ${preview.counts.lines === 1 ? 'voucher goes' : 'vouchers go'} in · ${preview.counts.leftOut} left out`}>
        {counts.length ? (
          <ul className="m-0 list-disc pl-4">
            {counts.map((c) => (
              <li key={c.reason}>
                {c.count} — {LEFT_OUT_WORDS[c.reason].word}. {LEFT_OUT_WORDS[c.reason].fix}
              </li>
            ))}
          </ul>
        ) : (
          <p>Nothing is left out.</p>
        )}
        {needsMapping ? (
          <p>
            <Link href={TALLY_MAPPING_HREF} className="font-semibold text-brand-strong underline underline-offset-4">
              Open Tally ledger mapping
            </Link>
          </p>
        ) : null}
        <p className="text-sm">Nothing is saved until you press “Make Tally file”.</p>
      </Notice>
      {preview.lines.length ? (
        <Table label="Vouchers that go into the file" stackOnMobile wrapperClassName="rounded-card border border-line bg-card">
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Voucher</TableHead>
              <TableHead>Date</TableHead>
              <TableHead numeric>Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {preview.lines.slice(0, PREVIEW_ROWS).map((l) => (
              <TableRow key={`${l.recordKind}:${l.recordId}`}>
                <TableCell label="Reference">
                  <span className="flex flex-col">
                    <span className="font-semibold wrap-anywhere text-ink">{l.reference ?? "No reference"}</span>
                    <span className="text-sm text-quiet">{l.dealReference ?? ANY_KIND_LABEL[l.recordKind]}</span>
                  </span>
                </TableCell>
                <TableCell label="Voucher">{l.voucherType}</TableCell>
                <TableCell label="Date">
                  <span className="whitespace-nowrap">{dayText(l.date)}</span>
                </TableCell>
                <TableCell label="Amount" numeric>
                  <span className="whitespace-nowrap tabular-nums">{inr(l.amountPaise)}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      {preview.leftOut.length ? <LeftOutTable rows={preview.leftOut.slice(0, PREVIEW_ROWS)} label="Records left out of the file" /> : null}
      {preview.truncated || preview.lines.length > PREVIEW_ROWS || preview.leftOut.length > PREVIEW_ROWS ? <p className="m-0 text-sm text-quiet">Showing the first {PREVIEW_ROWS} of each list. The full left-out list is kept with the file.</p> : null}
    </section>
  );
}

export function LeftOutTable({ rows, label }: { rows: TallyFilePreview['leftOut']; label: string }) {
  return (
    <Table label={label} stackOnMobile wrapperClassName="rounded-card border border-line bg-card">
      <TableHeader>
        <TableRow>
          <TableHead>Record</TableHead>
          <TableHead>Why it is left out</TableHead>
          <TableHead>What to do</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={`${r.recordKind}:${r.recordId}`}>
            <TableCell label="Record">
              <span className="flex flex-col">
                <span className="font-semibold wrap-anywhere text-ink">{r.reference ?? "No reference"}</span>
                <span className="text-sm text-quiet">{ANY_KIND_LABEL[r.recordKind]}</span>
              </span>
            </TableCell>
            <TableCell label="Why it is left out">
              <span className="flex flex-col items-start gap-1">
                <StatusBadge tone="warning" wrap>
                  {LEFT_OUT_WORDS[r.reason].word}
                </StatusBadge>
                {r.detail ? <span className="text-sm text-quiet wrap-anywhere">{r.detail}</span> : null}
              </span>
            </TableCell>
            <TableCell label="What to do">
              <span className="text-sm">{LEFT_OUT_WORDS[r.reason].fix}</span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
