'use client';

import { CircleAlert, CircleCheck, History, Pencil, TableProperties } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Hidden, type DecisionAction } from '@/views/accounts/supplier-forms';
import { DeskDialog, DeskResultLine, type DeskResult } from '@/views/accounts-desk/desk-kit';
import { dayText, whenText } from '@/views/accounts-desk/labels';
import { FIELD_LABEL, mappingLine, ROW_KIND_GROUPS, ROW_KIND_LABEL, rowMissing, SERVICE_LABEL } from './labels';
import type { TallyMappingChange, TallyMappingPageView, TallyMappingRow } from './types';

/*
 * Settings › Accounts › Tally mapping (contract 8.1 D1/D2, 11.11). One list
 * per group of row kinds; each row is a row kind × service with its debit
 * ledger, credit ledger and voucher type, "Not set" in words when blank, and
 * one "Edit" per row (Accounts only). An edit needs a reason (10 to 500
 * characters) and is recorded; a refusal keeps the dialog open with every
 * typed value. The missing count sits at the top with a "Missing only"
 * toggle. A mapping change never marks anything "changed since export" (LD19):
 * the next export simply uses the new names.
 */

export const MAPPING_FIELD = {
  mappingId: 'mappingId',
  expectedRowVersion: 'expectedRowVersion',
  requestId: 'requestId',
  debitLedger: 'debitLedger',
  creditLedger: 'creditLedger',
  voucherType: 'voucherType',
  reason: 'reason',
} as const;


export interface TallyMappingPreview {
  missingOnly?: boolean;
  editMappingId?: string;
  editState?: DeskResult;
}

export function TallyMappingView({ view, action, preview }: { view: TallyMappingPageView; /** null = read only (no edit). */ action: DecisionAction | null; preview?: TallyMappingPreview }) {
  const [missingOnly, setMissingOnly] = useState(!!preview?.missingOnly);
  const [result, setResult] = useState<DeskResult | null>(null);
  const resultId = useId();

  if (view.list === 'error') {
    return (
      <section aria-labelledby="tm-h" className="flex flex-col gap-4">
        <MappingHeading entityName={view.entityName} entities={view.entities} />
        <Notice tone="warning" role="status" title="The Tally mapping did not load">
          <p>Nothing was changed. Reload the page. If it keeps happening, tell your admin.</p>
        </Notice>
      </section>
    );
  }
  const list = view.list;
  if (list.rows.length === 0) {
    return (
      <section aria-labelledby="tm-h" className="flex flex-col gap-4">
        <MappingHeading entityName={view.entityName} entities={view.entities} />
        <Card>
          <EmptyState
            icon={TableProperties}
            title="No mapping rows for this company yet"
            description="The mapping is filled when the Accounts update is installed. Until then the CSV export says “Mapping missing” on every line."
          />
        </Card>
      </section>
    );
  }
  const rows = missingOnly ? list.rows.filter(rowMissing) : list.rows;
  return (
    <section aria-labelledby="tm-h" className="flex flex-col gap-4">
      <MappingHeading entityName={view.entityName} entities={view.entities} />
      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {list.missingCount > 0 ? (
              <StatusBadge tone="warning" icon={CircleAlert} wrap>
                {list.missingCount === 1 ? '1 row has mapping missing' : `${list.missingCount} rows have mapping missing`}
              </StatusBadge>
            ) : (
              <StatusBadge tone="success" icon={CircleCheck} wrap>
                No mapping missing
              </StatusBadge>
            )}
            <div role="group" aria-label="Which rows to show" className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant={missingOnly ? 'ghost' : 'secondary'} aria-pressed={!missingOnly} onClick={() => setMissingOnly(false)}>
                All rows ({list.rows.length})
              </Button>
              <Button type="button" size="sm" variant={missingOnly ? 'secondary' : 'ghost'} aria-pressed={missingOnly} onClick={() => setMissingOnly(true)}>
                Missing only ({list.rows.filter(rowMissing).length})
              </Button>
            </div>
          </div>
          <p className="m-0 text-sm text-quiet">
            A row without a voucher type or without any ledger name makes its CSV lines say “Mapping missing” (the other side is the party ledger). Bank, cash, customer advance, purchase and expense ledgers are left for Accounts to fill. Changing a name never marks exported records as changed: the next export uses the new name. Nothing is posted to Tally.
          </p>
          <div id={resultId} tabIndex={-1} className="outline-none">
            <DeskResultLine state={result} okTitle="Saved" />
          </div>
        </CardBody>
      </Card>
      {missingOnly && rows.length === 0 ? (
        <Card>
          <EmptyState icon={CircleCheck} title="Nothing missing" description="Every row has a voucher type and a ledger name." />
        </Card>
      ) : null}
      {ROW_KIND_GROUPS.map((g) => {
        const groupRows = rows.filter((r) => g.kinds.includes(r.rowKind));
        if (groupRows.length === 0) return null;
        return (
          <MappingGroup
            key={g.title}
            title={g.title}
            rows={groupRows}
            action={action}
            history={view.history}
            baseHref={view.baseHref}
            preview={preview}
            onDone={(r) => {
              setResult(r);
              requestAnimationFrame(() => document.getElementById(resultId)?.focus());
            }}
          />
        );
      })}
    </section>
  );
}

function MappingHeading({ entityName, entities }: { entityName: string; entities?: TallyMappingPageView['entities'] }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 id="tm-h" className="m-0 text-xl leading-tight font-display tracking-heading text-ink">
        Tally mapping · {entityName}
      </h2>
      <p className="m-0 text-copy">The Tally ledger and voucher type each CSV line carries. Accounts edit them; each change needs a reason and is recorded.</p>
      {entities && entities.length > 1 ? (
        <nav aria-label="Company">
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {entities.map((e) => (
              <li key={e.id} className="m-0">
                <Link href={e.href} aria-current={e.current ? 'page' : undefined} className={buttonVariants({ variant: e.current ? 'secondary' : 'ghost', size: 'sm' })}>
                  {e.name}
                  {e.current ? <span className="sr-only"> (shown)</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}

function MappingGroup({
  title,
  rows,
  action,
  history,
  baseHref,
  preview,
  onDone,
}: {
  title: string;
  rows: TallyMappingRow[];
  action: DecisionAction | null;
  history?: TallyMappingPageView['history'];
  baseHref?: string;
  preview?: TallyMappingPreview;
  onDone: (r: DeskResult) => void;
}) {
  const hid = useId();
  return (
    <Card>
      <section aria-labelledby={hid}>
        <CardHeader>
          <div>
            <CardTitle id={hid} level={3}>
              {title}
            </CardTitle>
            <CardDescription>{rows.length === 1 ? '1 row' : `${rows.length} rows`}</CardDescription>
          </div>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <Table label={`Tally mapping: ${title}`} stackOnMobile wrapperClassName="rounded-control border border-line">
            <TableHeader>
              <TableRow>
                <TableHead>Record and service</TableHead>
                <TableHead>Debit ledger</TableHead>
                <TableHead>Credit ledger</TableHead>
                <TableHead>Voucher type</TableHead>
                <TableHead>Last change</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.mappingId}>
                  <TableCell label="Record and service">
                    <span className="flex flex-col">
                      <span className="font-semibold text-ink">{ROW_KIND_LABEL[r.rowKind]}</span>
                      <span className="text-sm text-quiet">{SERVICE_LABEL[r.serviceClass]}</span>
                      {rowMissing(r) ? (
                        <span className="mt-[0.25rem]">
                          <StatusBadge tone="warning" icon={CircleAlert} wrap>
                            Mapping missing
                          </StatusBadge>
                        </span>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell label="Debit ledger">
                    <LedgerValue value={r.debitLedger} />
                  </TableCell>
                  <TableCell label="Credit ledger">
                    <LedgerValue value={r.creditLedger} />
                  </TableCell>
                  <TableCell label="Voucher type">
                    <LedgerValue value={r.voucherType} />
                  </TableCell>
                  <TableCell label="Last change">
                    <span className="text-sm text-copy">
                      {dayText(r.updatedAt)}
                      {r.updatedByName ? ` · ${r.updatedByName}` : ''}
                    </span>
                  </TableCell>
                  <TableCell label="Actions">
                    <span className="flex flex-wrap gap-2">
                      {action ? <EditMapping row={r} action={action} onDone={onDone} initialOpen={preview?.editMappingId === r.mappingId} initialState={preview?.editMappingId === r.mappingId ? preview.editState : undefined} /> : null}
                      {baseHref ? <MappingHistory row={r} baseHref={baseHref} items={history?.mappingId === r.mappingId ? history.items : undefined} /> : null}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardBody>
      </section>
    </Card>
  );
}

function LedgerValue({ value }: { value: string | null }) {
  return value ? <span className="wrap-anywhere text-ink">{value}</span> : <span className="text-quiet italic">Not set</span>;
}

function EditMapping({ row, action, onDone, initialOpen, initialState }: { row: TallyMappingRow; action: DecisionAction; onDone: (r: DeskResult) => void; initialOpen?: boolean; initialState?: DeskResult }) {
  const [open, setOpen] = useState(!!initialOpen);
  const opener = useRef<HTMLButtonElement>(null);
  const uid = useId();
  const line = mappingLine(row);
  return (
    <>
      <Button ref={opener} type="button" size="sm" variant="secondary" onClick={() => setOpen(true)} aria-label={`Edit ${line}`}>
        <Pencil aria-hidden="true" />
        Edit
      </Button>
      {open ? (
        <DeskDialog
          open={open}
          onOpenChange={setOpen}
          title={`Edit ${line}`}
          description="Type the names exactly as they are in Tally. Leave a box empty to clear it. The reason is recorded with the change."
          primaryLabel="Save mapping"
          pendingLabel="Saving…"
          action={action}
          initialState={initialState ?? null}
          returnFocus={opener}
          onDone={(r) => {
            setOpen(false);
            onDone(r);
          }}
        >
          {({ requestId }) => (
            <>
              <Hidden fields={{ [MAPPING_FIELD.mappingId]: row.mappingId, [MAPPING_FIELD.expectedRowVersion]: row.rowVersion, [MAPPING_FIELD.requestId]: requestId }} />
              {(['debitLedger', 'creditLedger', 'voucherType'] as const).map((f) => (
                <Field key={f} htmlFor={`${uid}-${f}`} label={FIELD_LABEL[f]!} optional hint={f === 'voucherType' ? 'Up to 60 characters, for example “Receipt”.' : 'Up to 100 characters. Cannot start with = + - or @.'}>
                  <Input
                    id={`${uid}-${f}`}
                    name={MAPPING_FIELD[f]}
                    defaultValue={row[f] ?? ''}
                    maxLength={f === 'voucherType' ? 60 : 100}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby={fieldDescribedBy(`${uid}-${f}`, { hint: true })}
                  />
                </Field>
              ))}
              <Field htmlFor={`${uid}-reason`} label="Reason" hint="10 to 500 characters, for example “Ledger renamed in Tally on 12 Nov”.">
                <Textarea id={`${uid}-reason`} name={MAPPING_FIELD.reason} required minLength={10} maxLength={500} rows={2} aria-describedby={fieldDescribedBy(`${uid}-reason`, { hint: true })} />
              </Field>
            </>
          )}
        </DeskDialog>
      ) : null}
    </>
  );
}

/**
 * History of one row: a link (works without script) to this page with
 * `history=<id>`; the server reads that one row's history and the dialog
 * opens on load. Closing returns to the page address without it.
 */
function MappingHistory({ row, baseHref, items }: { row: TallyMappingRow; baseHref: string; /** undefined = not asked for this row. */ items?: TallyMappingChange[] | 'error' | null }) {
  const router = useRouter();
  const line = mappingLine(row);
  const href = `${baseHref}${baseHref.includes('?') ? '&' : '?'}history=${encodeURIComponent(row.mappingId)}`;
  const open = items !== undefined;
  return (
    <>
      <Link href={href} scroll={false} aria-label={`History of ${line}`} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
        <History aria-hidden="true" />
        History
      </Link>
      {open ? (
        <Dialog
          open
          onOpenChange={(o) => {
            if (!o) router.replace(baseHref, { scroll: false });
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>History of {line}</DialogTitle>
              <DialogDescription>Every change, newest first, with who made it and why.</DialogDescription>
            </DialogHeader>
            <DialogBody>
              {items === 'error' ? (
                <Notice tone="warning" role="status">
                  <p>The history did not load. Nothing was changed. Close this and try again.</p>
                </Notice>
              ) : items === null ? (
                <p className="m-0 text-copy">This history is not available to you.</p>
              ) : items.length === 0 ? (
                <p className="m-0 text-copy">No changes since the mapping was filled.</p>
              ) : (
                <ol className="m-0 flex list-none flex-col gap-3 p-0">
                  {items.map((c, i) => (
                    <li key={i} className="m-0 rounded-control border border-line bg-canvas px-3 py-2">
                      <p className="m-0 text-sm text-quiet">
                        {whenText(c.changedAt)}
                        {c.changedByName ? ` · ${c.changedByName}` : ''}
                      </p>
                      <p className="m-0 wrap-anywhere text-copy">
                        <strong className="text-ink">{FIELD_LABEL[c.field] ?? c.field}:</strong> {c.oldValue ?? 'Not set'} → {c.newValue ?? 'Not set'}
                      </p>
                      <p className="m-0 text-sm wrap-anywhere text-copy">Reason: {c.reason}</p>
                    </li>
                  ))}
                </ol>
              )}
            </DialogBody>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="secondary">
                  Close
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

export function TallyMappingLoading() {
  return (
    <LoadingRegion label="Loading Tally mapping">
      <h2 className="sr-only">Tally mapping</h2>
      <Skeleton className="mb-2 h-7 w-64" />
      <Skeleton className="mb-5 h-4 w-96 max-w-full" />
      <Skeleton className="mb-5 h-24 w-full" />
      <Skeleton className="h-64 w-full" />
    </LoadingRegion>
  );
}

export function TallyMappingNoAccess() {
  return (
    <section aria-labelledby="tm-no" className="flex flex-col gap-3">
      <h2 id="tm-no" className="m-0 text-xl leading-tight font-display tracking-heading text-ink">
        Tally mapping
      </h2>
      <Notice tone="restricted" title="For Accounts only">
        <p>The Tally ledger names are kept by Accounts of the company. Ask Accounts if a name looks wrong in an export.</p>
      </Notice>
    </section>
  );
}
