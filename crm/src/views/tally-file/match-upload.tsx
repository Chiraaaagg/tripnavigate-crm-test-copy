'use client';

import { ArrowRight, Upload } from 'lucide-react';
import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { ErrorSummary } from '@/components/ui/error-summary';
import { Field } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { refusalMessage, useDeskCommand, type DeskResult } from '@/views/accounts-desk/desk-kit';
import { Hidden, type DecisionAction } from '@/views/accounts/supplier-forms';
import { applySummary, matchBatchHref, MATCH_WORDS } from './labels';
import { MATCH_OUTCOMES, TF_FIELD, type TallyMatchBatch } from './types';

/*
 * Accounts › Tally › "Upload Tally vouchers" (contract 7.4 C4; 15 screen 7).
 * Accounts export the Day Book from TallyPrime as XML and upload it here. The
 * server reads it (track C's parser: no DTD or entities, ≤ 4 MiB, ≤ 5,000
 * vouchers), finds each voucher's TN: tag and stages a match. Nothing changes
 * until "Apply" on the next screen. The file itself is not kept.
 */

const MAX_BYTES = 4 * 1024 * 1024; // track C: DAYBOOK_MAX_BYTES (server actions take at most 4 MB)

export function TallyMatchUpload({ entityId, action, initialState = null }: { entityId: string; action: DecisionAction; initialState?: DeskResult | null }) {
  const uid = useId();
  const cmd = useDeskCommand(action, initialState);
  const [local, setLocal] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const batch = cmd.state?.ok ? ((cmd.state as { data?: TallyMatchBatch }).data ?? null) : null;
  const refused = local ?? (cmd.state && !cmd.state.ok ? refusalMessage(cmd.state) : null);
  const fileId = `${uid}-file`;
  return (
    <form
      noValidate
      aria-labelledby={`${uid}-h`}
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        const file = (e.currentTarget.elements.namedItem(TF_FIELD.file) as HTMLInputElement | null)?.files?.[0];
        const problem = !file ? 'Choose the Day Book file first.' : !/\.xml$/i.test(file.name) ? 'Use the XML file Tally exports (Day Book, format XML).' : file.size > MAX_BYTES ? 'The file is larger than 4 MB. Export a shorter period.' : null;
        if (problem) {
          e.preventDefault();
          setLocal(problem);
          requestAnimationFrame(() => document.getElementById(fileId)?.focus());
          return;
        }
        setLocal(null);
        cmd.submit(e, () => requestAnimationFrame(() => resultRef.current?.focus()));
      }}
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${uid}-h`} className="m-0 text-lg font-semibold text-ink">
          Upload Tally vouchers
        </h2>
        <p className="m-0 max-w-prose text-copy">After importing a Tally file, export the Day Book from TallyPrime as XML and upload it. The CRM finds each voucher by its TN: tag and shows what would match before anything changes.</p>
      </div>
      <Hidden fields={{ [TF_FIELD.entityId]: entityId, requestId: cmd.requestId }} />
      {refused ? (
        <ErrorSummary title="The file was not checked" description={refused} focusOnMount={false} items={[{ fieldId: fileId, text: 'Check: Day Book file' }]} />
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <Field htmlFor={fileId} label="Day Book file (XML)" hint="Up to 4 MB and 5,000 vouchers." className="min-w-0 flex-1">
          <input
            id={fileId}
            name={TF_FIELD.file}
            type="file"
            accept=".xml,application/xml,text/xml"
            aria-invalid={refused ? true : undefined}
            aria-describedby={`${fileId}-hint`}
            className="block w-full max-w-full rounded-control border border-control bg-card px-3 py-2 font-sans text-base text-ink file:mr-3 file:rounded-control file:border-0 file:bg-wash file:px-3 file:py-1.5 file:font-semibold file:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-strong"
          />
        </Field>
        <Button type="submit" variant="secondary" aria-disabled={cmd.pending || undefined} onClick={(e) => (cmd.pending ? e.preventDefault() : undefined)}>
          <Upload aria-hidden="true" />
          {cmd.pending ? 'Checking the file…' : 'Check the file'}
        </Button>
      </div>
      <div ref={resultRef} tabIndex={-1} className="outline-none" role="status" aria-live="polite">
        {batch ? <StagedSummary batch={batch} /> : null}
      </div>
    </form>
  );
}

function StagedSummary({ batch }: { batch: TallyMatchBatch }) {
  const s = applySummary(batch.summary);
  return (
    <Notice tone="info" title={`${batch.fileName}: ${s.total} ${s.total === 1 ? 'voucher' : 'vouchers'} checked`}>
      <ul className="m-0 list-disc pl-4">
        {MATCH_OUTCOMES.filter((o) => batch.summary[o]).map((o) => (
          <li key={o}>
            {batch.summary[o]} {MATCH_WORDS[o].word.toLowerCase()} — {MATCH_WORDS[o].effect}
          </li>
        ))}
      </ul>
      <p>Nothing has changed yet.</p>
      <p>
        <Link href={matchBatchHref(batch.batchId)} className={buttonVariants({ variant: 'primary' })}>
          Review and apply
          <ArrowRight aria-hidden="true" />
        </Link>
      </p>
    </Notice>
  );
}
