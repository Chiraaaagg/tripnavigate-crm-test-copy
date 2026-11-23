'use client';

import { ChevronDown, Link2, RotateCcw, ShieldAlert, Stamp } from 'lucide-react';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Hidden, type DecisionAction } from '@/views/accounts/supplier-forms';
import { DeskDialog, todayIst, type DeskResult } from './desk-kit';
import { DESK_FIELD, KIND_LABEL, TALLY_LABEL } from './labels';
import type { RecordRow } from './types';

/*
 * Row actions on the Documents and money workspace (contract 11.1, A only):
 * "Mark matched", "Raise exception", "Reopen" and "Link to another task"
 * (supplier bills). One menu button per row named after the record; each item
 * opens one dialog with one primary button. The database decides every step
 * (T1–T3, S1); the menu only offers what the row's `can` says.
 */

export interface DeskRowActions {
  /** T1 accounts_tally_match (kind, recordId, expectedRowVersion, voucherRef, voucherDate, requestId). */
  match: DecisionAction;
  /** T2 accounts_tally_exception (kind, recordId, expectedRowVersion, reason, tallyAmountRupees?, requestId). */
  exception: DecisionAction;
  /** T3 accounts_tally_reopen (kind, recordId, expectedRowVersion, reason, requestId). */
  reopen: DecisionAction;
  /** S1 supplier_document_link_task (documentId, taskId, requestId). */
  linkTask: DecisionAction;
}

/** A task a supplier bill may be linked to (same supplier, Purchase or Flight). */
export interface LinkTaskOption {
  taskId: string;
  label: string;
}

/** Reads the eligible tasks when the dialog opens (addendum B2 loadLinkTargets); null = could not be read. */
export type LoadLinkTargets = (documentId: string) => Promise<LinkTaskOption[] | null>;

type Open = null | 'match' | 'exception' | 'reopen' | 'link';

export function RowActions({
  row,
  actions,
  linkOptions,
  loadLinkTargets,
  onResult,
  initialOpen = null,
  initialState = null,
}: {
  row: RecordRow;
  actions: DeskRowActions;
  /** Eligible tasks for "Link to another task"; empty = the dialog says none were found. */
  linkOptions?: LinkTaskOption[];
  loadLinkTargets?: LoadLinkTargets;
  onResult: (r: DeskResult & { ok: true }) => void;
  /** Preview gallery only. */
  initialOpen?: Open;
  initialState?: DeskResult | null;
}) {
  const [open, setOpen] = useState<Open>(initialOpen);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const uid = useId();
  const { can } = row;
  if (!can.match && !can.exception && !can.reopen && !can.linkTask) return null;
  const tallyKind = row.tally.recordKind ?? '';
  // The Tally commands take the Tally source record (a receipt's journal entry), which the row names in tally.recordId.
  const base = { [DESK_FIELD.kind]: tallyKind, [DESK_FIELD.recordId]: row.tally.recordId ?? row.recordId, [DESK_FIELD.expectedRowVersion]: row.tally.rowVersion };
  const ref = row.reference ?? KIND_LABEL[row.kind];
  const what = `${KIND_LABEL[row.kind]} ${row.reference ?? ''}`.trim();
  const done = (r: DeskResult & { ok: true }) => {
    setOpen(null);
    onResult(r);
  };
  const close = (o: boolean) => {
    if (!o) setOpen(null);
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={trigger} variant="secondary" size="sm">
            Actions<span className="sr-only"> for {what}</span>
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {can.match ? (
            <DropdownMenuItem onSelect={() => setOpen('match')}>
              <Stamp aria-hidden="true" />
              Mark matched
            </DropdownMenuItem>
          ) : null}
          {can.exception ? (
            <DropdownMenuItem onSelect={() => setOpen('exception')}>
              <ShieldAlert aria-hidden="true" />
              Raise exception
            </DropdownMenuItem>
          ) : null}
          {can.reopen ? (
            <DropdownMenuItem onSelect={() => setOpen('reopen')}>
              <RotateCcw aria-hidden="true" />
              Reopen
            </DropdownMenuItem>
          ) : null}
          {can.linkTask ? (
            <DropdownMenuItem onSelect={() => setOpen('link')}>
              <Link2 aria-hidden="true" />
              Link to another task
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {open === 'match' ? (
        <DeskDialog
          open
          returnFocus={trigger}
          onOpenChange={close}
          title={`Mark ${ref} matched`}
          description={`Record the Tally voucher for this ${KIND_LABEL[row.kind].toLowerCase()}. Exporting a file never marks a record matched; only this step does.`}
          primaryLabel="Mark matched"
          pendingLabel="Saving…"
          action={actions.match}
          initialState={initialState}
          onDone={done}
        >
          {({ requestId }) => (
            <>
              <Hidden fields={{ ...base, [DESK_FIELD.requestId]: requestId }} />
              <Field htmlFor={`${uid}-voucher`} label="Tally voucher reference" hint="As shown in Tally, up to 60 characters.">
                <Input id={`${uid}-voucher`} name={DESK_FIELD.voucherRef} required maxLength={60} autoComplete="off" aria-describedby={fieldDescribedBy(`${uid}-voucher`, { hint: true })} />
              </Field>
              <Field htmlFor={`${uid}-vdate`} label="Voucher date">
                <Input id={`${uid}-vdate`} name={DESK_FIELD.voucherDate} type="date" required min="2000-01-01" max={todayIst()} />
              </Field>
            </>
          )}
        </DeskDialog>
      ) : null}

      {open === 'exception' ? (
        <DeskDialog
          open
          returnFocus={trigger}
          onOpenChange={close}
          title={`Raise an exception on ${ref}`}
          description="Say what does not agree with Tally. The exception owner is told and the record stays out of exports until the exception is cleared."
          primaryLabel="Raise exception"
          pendingLabel="Saving…"
          action={actions.exception}
          initialState={initialState}
          onDone={done}
        >
          {({ requestId }) => (
            <>
              <Hidden fields={{ ...base, [DESK_FIELD.requestId]: requestId }} />
              <Field htmlFor={`${uid}-reason`} label="What is wrong" hint="10 to 500 characters. Do not type card numbers, PAN or phone numbers.">
                <Textarea id={`${uid}-reason`} name={DESK_FIELD.reason} required minLength={10} maxLength={500} rows={3} aria-describedby={fieldDescribedBy(`${uid}-reason`, { hint: true })} />
              </Field>
              <Field htmlFor={`${uid}-amount`} label="Amount in Tally (₹)" optional hint="Only when the amounts differ.">
                <MoneyInput id={`${uid}-amount`} name={DESK_FIELD.tallyAmountRupees} aria-describedby={fieldDescribedBy(`${uid}-amount`, { hint: true })} />
              </Field>
            </>
          )}
        </DeskDialog>
      ) : null}

      {open === 'reopen' ? (
        <DeskDialog
          open
          returnFocus={trigger}
          onOpenChange={close}
          title={`Reopen ${ref}`}
          description={
            row.tally.status === 'exception'
              ? 'Clears the exception. The record goes back to how it was before the exception.'
              : `Takes the record back from ${TALLY_LABEL[row.tally.status].toLowerCase()} to exported, so it can be matched again.`
          }
          primaryLabel="Reopen"
          pendingLabel="Saving…"
          action={actions.reopen}
          initialState={initialState}
          onDone={done}
        >
          {({ requestId }) => (
            <>
              <Hidden fields={{ ...base, [DESK_FIELD.requestId]: requestId }} />
              <Field htmlFor={`${uid}-rreason`} label="Why" hint="10 to 500 characters.">
                <Textarea id={`${uid}-rreason`} name={DESK_FIELD.reason} required minLength={10} maxLength={500} rows={3} aria-describedby={fieldDescribedBy(`${uid}-rreason`, { hint: true })} />
              </Field>
            </>
          )}
        </DeskDialog>
      ) : null}

      {open === 'link' ? (
        <LinkTaskDialog row={row} action={actions.linkTask} options={linkOptions} load={loadLinkTargets} initialState={initialState} onClose={close} onDone={done} returnFocus={trigger} />
      ) : null}
    </>
  );
}

/** S1: one bill on several tasks (no amount split). */
export function LinkTaskDialog({
  row,
  action,
  options: given,
  load,
  initialState,
  onClose,
  onDone,
  returnFocus,
}: {
  returnFocus?: RefObject<HTMLElement | null>;
  row: Pick<RecordRow, 'recordId' | 'reference' | 'supplierName'>;
  action: DecisionAction;
  /** Known choices (preview); otherwise `load` reads them when the dialog opens. */
  options?: LinkTaskOption[];
  load?: LoadLinkTargets;
  initialState?: DeskResult | null;
  onClose: (open: boolean) => void;
  onDone: (r: DeskResult & { ok: true }) => void;
}) {
  const uid = useId();
  const [loaded, setLoaded] = useState<LinkTaskOption[] | null | 'loading'>(given ?? (load ? 'loading' : []));
  useEffect(() => {
    if (given || !load) return;
    let live = true;
    void load(row.recordId).then(
      (o) => live && setLoaded(o),
      () => live && setLoaded(null),
    );
    return () => {
      live = false;
    };
  }, [given, load, row.recordId]);
  const options = Array.isArray(loaded) ? loaded : [];
  return (
    <DeskDialog
      open
      returnFocus={returnFocus}
      onOpenChange={onClose}
      title={`Link bill ${row.reference ?? ''} to another task`.replace('  ', ' ')}
      description={`The same bill then counts for that task too. The amount is not split. Only tasks with work from ${row.supplierName ?? 'this supplier'} are listed.`}
      primaryLabel="Link the bill"
      pendingLabel="Linking…"
      action={action}
      initialState={initialState}
      onDone={onDone}
      hidePrimary={options.length === 0}
    >
      {({ requestId }) => (
        <>
          <Hidden fields={{ [DESK_FIELD.documentId]: row.recordId, [DESK_FIELD.requestId]: requestId }} />
          {loaded === 'loading' ? (
            <p className="m-0 text-quiet" role="status">
              Finding tasks with this supplier…
            </p>
          ) : loaded === null ? (
            <p className="m-0 text-copy" role="alert">
              The tasks could not be loaded. Close and try again.
            </p>
          ) : options.length === 0 ? (
            <p className="m-0 text-copy">No other task with this supplier was found. A task appears here once its work uses this supplier.</p>
          ) : (
            <Field htmlFor={`${uid}-task`} label="Task">
              <Select id={`${uid}-task`} name={DESK_FIELD.taskId} required defaultValue="">
                <option value="" disabled>
                  Choose a task
                </option>
                {options.map((o) => (
                  <option key={o.taskId} value={o.taskId}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </>
      )}
    </DeskDialog>
  );
}
