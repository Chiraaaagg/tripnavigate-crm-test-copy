'use client';

import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DialogAction, ReasonField } from '@/views/accounts-desk/acc2-kit';
import { DeskResultLine, useDeskCommand } from '@/views/accounts-desk/desk-kit';
import { RateSheetColumns, RateSheetImportDetails } from './import-details';
import type { RateSheetImportSummary, RateSheetReason, RateSheetRowView, RateSheetWarning } from './types';

/*
 * Settings › Imports › Rate sheet (contract 9.4, screen 15.9; track E's
 * checkRateSheetAction / applyRateSheetAction). Step 1 checks a CSV (nothing
 * is imported); step 2 "Import" with a reason makes DRAFT contracts only, each
 * approved later by a Manager. The column names follow RATE_SHEET_COLUMNS
 * (no guessing: unknown columns are listed and ignored).
 */

/** The check result track E returns (RateSheetCheckView), kept structural so the view never imports server code. */
export interface RateSheetCheckData {
  batchId: string;
  rowVersion: number;
  proposalHash: string | null;
  fileName: string;
  rowCount: number;
  contracts: number;
  lines: number;
  newRoomTypes: number;
  invalidRows: number;
  warnings: { newRoomType: number; overlapsActiveContract: number };
  rows: Array<{ rowNo: number; outcome: 'create' | 'invalid' | null; reasons: string[]; warnings: string[]; values: Record<string, string | null> }>;
  moreRows: number;
  unknownHeaders: string[];
}

const cell = (v: Record<string, string | null>, k: string) => v[k] ?? null;

/** Track E's check data → the summary the details table shows. Pure. */
export function rateSheetSummary(d: RateSheetCheckData): RateSheetImportSummary {
  const rows: RateSheetRowView[] = d.rows.map((r) => ({
    rowNo: r.rowNo,
    outcome: r.outcome === 'create' ? 'create' : 'invalid',
    reasons: r.reasons as RateSheetReason[],
    warnings: r.warnings as RateSheetWarning[],
    values: {
      supplierRef: cell(r.values, 'supplierRef'),
      hotelRef: cell(r.values, 'hotelRef'),
      validFrom: cell(r.values, 'validFrom'),
      validTo: cell(r.values, 'validTo'),
      seasonFrom: cell(r.values, 'seasonFrom'),
      seasonTo: cell(r.values, 'seasonTo'),
      roomType: cell(r.values, 'roomType'),
      mealPlan: cell(r.values, 'mealPlan'),
      rate: cell(r.values, 'rate'),
      weekendRate: cell(r.values, 'weekendRate'),
      blackoutDates: cell(r.values, 'blackoutDates'),
    },
  }));
  return { contracts: d.contracts, lines: d.lines, newRoomTypes: d.newRoomTypes, invalidRows: d.invalidRows, warnings: d.warnings, rows, moreRows: d.moreRows };
}

export function RateSheetImportView({ check, apply, canImport, noAccessText }: { check: DecisionAction | null; apply: DecisionAction | null; canImport: boolean; noAccessText: string }) {
  const id = useId();
  const cmd = useDeskCommand(check ?? (async () => ({ ok: false, code: 'not_authorized', message: noAccessText })));
  const data = cmd.state?.ok ? ((cmd.state as { data?: RateSheetCheckData }).data ?? null) : null;
  return (
    <div className="flex flex-col gap-5 font-sans text-base text-copy">
      <Card>
        <CardHeader>
          <CardTitle>1. Check the rate sheet</CardTitle>
          <CardDescription>CSV saved from Excel (CSV UTF-8), up to 5,000 rows. The first row holds the column names below. Nothing is imported in this step.</CardDescription>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <RateSheetColumns />
          {canImport && check ? (
            <form noValidate onSubmit={(e) => cmd.submit(e)} className="flex flex-col gap-3" aria-label="Check a rate sheet file">
              <input type="hidden" name="requestId" value={cmd.requestId} />
              <Field htmlFor={`${id}-file`} label="Rate sheet (CSV)">
                <Input id={`${id}-file`} name="file" type="file" accept=".csv,text/csv" required />
              </Field>
              <div>
                <Button type="submit" variant={data ? 'secondary' : 'primary'} aria-disabled={cmd.pending || undefined}>
                  {cmd.pending ? 'Checking…' : 'Check file'}
                </Button>
              </div>
              <DeskResultLine state={cmd.state} okTitle="Checked" failTitle="Not checked" />
            </form>
          ) : (
            <p className="m-0 text-sm text-quiet">{noAccessText}</p>
          )}
        </CardBody>
      </Card>
      {data ? (
        <Card>
          <CardHeader>
            <CardTitle>2. Import {data.fileName}</CardTitle>
            <CardDescription>
              {data.rowCount} rows read.{data.unknownHeaders.length ? ` Columns not imported: ${data.unknownHeaders.join(', ')}.` : ''} Import makes draft contracts only; a Manager approves each one.
            </CardDescription>
          </CardHeader>
          <CardBody className="flex flex-col gap-4">
            <RateSheetImportDetails sheet={rateSheetSummary(data)} />
            <DialogAction
              buttonLabel="Import as draft contracts"
              buttonVariant="primary"
              blockedReason={data.contracts === 0 ? 'No contract can be made from this file.' : !data.proposalHash ? 'Check the file again first.' : null}
              title={`Import ${data.contracts} draft contract${data.contracts === 1 ? '' : 's'}?`}
              description="The CRM checks the file again and creates draft contracts only. Active contracts are never changed."
              primaryLabel="Import"
              pendingLabel="Importing…"
              action={apply}
              fields={{ batchId: data.batchId, batchRowVersion: data.rowVersion, proposalHash: data.proposalHash }}
              okTitle="Imported"
            >
              <ReasonField id={`${id}-reason`} />
            </DialogAction>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
