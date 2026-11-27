'use client';

import { Download } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { ErrorSummary } from '@/components/ui/error-summary';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Select } from '@/components/ui/select';
import { tallyExportCsvHref } from '@/modules/accounts-desk/contracts';
import { Hidden, type DecisionAction } from '@/views/accounts/supplier-forms';
import { refusedField, todayIst, useDeskCommand, useRefusedControl, type DeskResult } from './desk-kit';
import { DESK_FIELD, TALLY_KIND_LABEL } from './labels';
import { TALLY_RECORD_KINDS, type TallyExportResult } from './types';

/*
 * Tally export form (contract 7.2 T8, 11.3): entity, dates, record types,
 * "include already exported", branches. The export marks rows "exported",
 * never "matched". The result names the export and offers "Download CSV"
 * (the audited route handler streams the snapshot). Typed values stay after a
 * refusal ("More than 10,000 rows. Narrow the dates.").
 */


export function TallyExportForm({
  entities,
  branches,
  action,
  initialState = null,
}: {
  entities: Array<{ id: string; name: string }>;
  branches: Array<{ id: string; name: string }>;
  action: DecisionAction;
  initialState?: DeskResult | null;
}) {
  const cmd = useDeskCommand(action, initialState);
  const [formEl, setFormEl] = useState<HTMLFormElement | null>(null);
  const refused = cmd.state && !cmd.state.ok ? cmd.state : null;
  const summaryId = useId();
  const target = useRefusedControl(formEl, refused, summaryId);
  const uid = useId();
  const resultRef = useRef<HTMLDivElement>(null);
  const result = cmd.state?.ok ? ((cmd.state as { data?: TallyExportResult }).data ?? null) : null;
  const today = todayIst();
  const monthStart = `${today.slice(0, 8)}01`;
  return (
    <form
      ref={setFormEl}
      noValidate
      aria-labelledby={`${uid}-h`}
      className="flex flex-col gap-4"
      onSubmit={(e) =>
        cmd.submit(e, () => {
          requestAnimationFrame(() => resultRef.current?.focus());
        })
      }
    >
      <h2 id={`${uid}-h`} className="m-0 text-lg font-semibold text-ink">
        New export
      </h2>
      <Hidden fields={{ [DESK_FIELD.requestId]: cmd.requestId }} />
      {cmd.state && !cmd.state.ok ? (
        <div id={summaryId}>
        <ErrorSummary title="No export was made" description={cmd.state.message} focusOnMount={!refusedField(cmd.state)} items={target ? [{ fieldId: target.id, text: `Check: ${target.label}` }] : []}>
          <p className="m-0 mt-[0.25rem] text-sm">Your choices are still here.</p>
        </ErrorSummary>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {entities.length > 1 ? (
          <Field htmlFor={`${uid}-entity`} label="Company">
            <Select id={`${uid}-entity`} name={DESK_FIELD.entityId} defaultValue={entities[0]?.id}>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <input type="hidden" name={DESK_FIELD.entityId} value={entities[0]?.id ?? ''} />
        )}
        <Field htmlFor={`${uid}-from`} label="From (accounting date)">
          <Input id={`${uid}-from`} name={DESK_FIELD.from} type="date" required defaultValue={monthStart} max={today} />
        </Field>
        <Field htmlFor={`${uid}-to`} label="To" hint="At most 366 days, up to today.">
          <Input id={`${uid}-to`} name={DESK_FIELD.to} type="date" required defaultValue={today} max={today} aria-describedby={`${uid}-to-hint`} />
        </Field>
      </div>
      <fieldset className="m-0 border-0 p-0">
        <legend className="mb-1.5 text-sm font-semibold text-ink">Record types</legend>
        <ul className="m-0 flex list-none flex-col gap-1 p-0 sm:flex-row sm:flex-wrap sm:gap-x-5">
          {TALLY_RECORD_KINDS.map((k) => (
            <li key={k} className="m-0">
              <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-sm text-copy">
                <input type="checkbox" name={DESK_FIELD.kinds} value={k} defaultChecked className="size-4 accent-brand-strong" />
                {TALLY_KIND_LABEL[k]}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      {branches.length > 1 ? (
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-1.5 text-sm font-semibold text-ink">Branches</legend>
          <p className="m-0 mb-1 text-sm text-quiet">Leave all ticked for the whole company.</p>
          <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1 p-0">
            {branches.map((b) => (
              <li key={b.id} className="m-0">
                <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-sm text-copy">
                  <input type="checkbox" name={DESK_FIELD.branchIds} value={b.id} defaultChecked className="size-4 accent-brand-strong" />
                  {b.name}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
      <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-sm text-copy">
        <input type="checkbox" name={DESK_FIELD.includeExported} value="true" className="size-4 accent-brand-strong" />
        Include records already exported but not yet matched
      </label>
      <p className="m-0 text-sm text-quiet">Matched records and records with an open exception are never exported. Exporting does not mark anything matched. PAN and mobile numbers are masked in the file.</p>
      <div>
        <Button
          type="submit"
          aria-disabled={cmd.pending || undefined}
          onClick={(e) => {
            if (cmd.pending) e.preventDefault();
          }}
        >
          {cmd.pending ? 'Preparing the export…' : 'Create export'}
        </Button>
      </div>
      <div ref={resultRef} tabIndex={-1} className="outline-none" role="status" aria-live="polite">
        {result ? (
          <Notice tone="success" title={`Export ${result.exportNo}: ${result.rowCount} ${result.rowCount === 1 ? 'row' : 'rows'}${result.alreadyExportedCount ? ` (${result.alreadyExportedCount} exported before)` : ''}`}>
            {result.skippedCount ? <p>{result.skippedCount} records were matched meanwhile and left out.</p> : null}
            <p>
              <a href={tallyExportCsvHref(result.exportId)} className={buttonVariants({ variant: 'secondary' })} download>
                <Download aria-hidden="true" />
                Download CSV
              </a>
            </p>
          </Notice>
        ) : null}
      </div>
    </form>
  );
}
