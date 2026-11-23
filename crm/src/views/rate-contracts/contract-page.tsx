import { CalendarOff, FileText, History, Hotel, ListChecks, Paperclip } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { JumpLinks, type JumpLink } from '@/components/ui/jump-links';
import { PageHeader } from '@/components/ui/page-header';
import { RecordHeader } from '@/components/ui/record-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { BlockedButton, CommandButton, DialogAction, ReasonField } from '@/views/accounts-desk/acc2-kit';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { Facts } from '@/views/accounts/supplier-kit';
import { TaskBackLink } from '@/views/department/task-frame';
import { ContractDetailsForm, ContractFileForm, FormSection, RateLinesForm, RoomTypeAddForm } from './forms';
import { dateText, inr, rangeText } from './format';
import { MEAL_PLAN_LABEL, nextStepText, STATUS_LOOK } from './labels';
import { ContractStatusBadge } from './list';
import type { RateContractDetail, RateContractViewer, RateLineView, RoomTypeView } from './types';

/*
 * Suppliers › Rate contracts › one contract (Accounts phase 3 contract §9.3
 * E2–E8, §9.5 R-E2, §15 item 9). Status, owner and next step at the top;
 * one primary action for the viewer (Purchase: "Send for approval"; Manager:
 * "Approve contract"). A draft or returned contract is edited here (details,
 * rate lines, blackouts, room types, file); an active contract is never
 * edited — a new sheet makes a new version, listed under "Earlier versions".
 * Buttons that cannot be used now stay visible with one short reason.
 */

export interface RateContractActions {
  /** E3 rate_contract_save. */
  save?: DecisionAction | null;
  /** E4 rate_contract_lines_set. */
  linesSet?: DecisionAction | null;
  /** E6 rate_contract_submit. */
  submit?: DecisionAction | null;
  /** E7 rate_contract_decide (decision approve | return). */
  decide?: DecisionAction | null;
  /** E8 rate_contract_end. */
  end?: DecisionAction | null;
  /** E2 hotel_room_type_save (new type: empty roomTypeId). */
  roomTypeSave?: DecisionAction | null;
  /** E2 hotel_room_type_remove. */
  roomTypeRemove?: DecisionAction | null;
  /** E5 rate_contract_file_begin + upload + _finish, done by the route action. */
  fileUpload?: DecisionAction | null;
}

/** Preview gallery: start with a dialog open or a refusal on screen. */
export interface RateContractPreview {
  open?: 'approve' | 'return' | 'end' | 'removeRoomType';
  state?: DeskResult | null;
  submitState?: DeskResult | null;
  linesState?: DeskResult | null;
  detailsState?: DeskResult | null;
}

const linkClass = cn('rounded-chip font-semibold text-brand-strong underline-offset-4 hover:text-brand-deep hover:underline', focusRing);

export function RateContractPageView({
  viewer,
  enabled,
  contract,
  roomTypes,
  actions = {},
  basePath = '/app/purchase/rate-contracts',
  fileHref,
  preview,
}: {
  viewer: RateContractViewer;
  enabled: boolean;
  contract: RateContractDetail | 'error';
  /** The hotel's active room types (Purchase editing); null = not loaded for this viewer. */
  roomTypes: RoomTypeView[] | null;
  actions?: RateContractActions;
  basePath?: string;
  /** Download link for a stored file (E5 _authorize_download behind it). */
  fileHref: (fileId: string) => string;
  preview?: RateContractPreview;
}) {
  if (contract === 'error') {
    return (
      <div className="flex flex-col gap-4 font-sans text-base text-copy">
        <TaskBackLink href={basePath}>Back to rate contracts</TaskBackLink>
        <PageHeader title="Rate contract" />
        <Notice tone="warning" role="status" title="This contract could not be loaded">
          <p>Nothing was changed. Reload the page. If it keeps happening, tell your admin.</p>
        </Notice>
      </div>
    );
  }
  const c = contract;
  const off = enabled ? null : 'Rate contracts are not switched on yet.';
  const editing = viewer === 'purchase' && c.can.edit && enabled;
  const fields = { contractId: c.contractId, expectedRowVersion: c.rowVersion };

  const primary: ReactNode =
    viewer === 'purchase' && (c.status === 'draft' || c.status === 'returned') ? (
      <CommandButton
        action={actions.submit}
        fields={fields}
        label="Send for approval"
        pendingLabel="Sending…"
        variant="primary"
        okTitle="Sent"
        initialState={preview?.submitState}
        blockedReason={off ?? (c.lines.length === 0 ? 'Add at least one rate line first.' : c.can.submit ? null : 'Not available to you.')}
      />
    ) : viewer === 'manager' && c.status === 'pending_approval' ? (
      <DialogAction
        buttonLabel="Approve contract"
        buttonVariant="primary"
        blockedReason={off ?? (c.can.approve ? null : c.isMine ? 'You entered this contract. Another Manager approves it.' : 'Only a Manager who did not enter it approves it.')}
        title={`Approve ${c.contractNo}?`}
        description={`From ${dateText(c.validFrom)}, offers for ${c.hotelName} from ${c.supplierName} show these rates. An active contract for the same dates ends where they overlap.`}
        primaryLabel="Approve contract"
        pendingLabel="Approving…"
        action={actions.decide}
        fields={{ ...fields, decision: 'approve', reason: '' }}
        okTitle="Approved"
        initialOpen={preview?.open === 'approve'}
        initialState={preview?.open === 'approve' ? preview.state : undefined}
      />
    ) : null;

  const step = nextStepText(c.status, viewer);
  const nextLine = step.startsWith('Next: ') ? { mine: true, text: step.slice('Next: '.length) } : { mine: false, text: step };
  const jumps: JumpLink[] = [
    { targetId: 'contract-details', label: 'Contract' },
    { targetId: 'rate-lines', label: 'Rate lines' },
    ...(viewer === 'purchase' && roomTypes ? [{ targetId: 'room-types', label: 'Room types' }] : []),
    { targetId: 'contract-files', label: 'File' },
    { targetId: 'contract-history', label: 'Earlier versions' },
  ];

  return (
    <div className="flex flex-col gap-5 font-sans text-base text-copy">
      <RecordHeader
        className="mb-[0]"
        back={{ href: basePath, label: 'Back to rate contracts' }}
        recordId={`${c.contractNo} · version ${c.versionNo}${c.source === 'import' ? ' · from a rate sheet' : ''}`}
        title={<span className="block wrap-anywhere">{c.hotelName}</span>}
        status={
          <>
            <ContractStatusBadge status={c.status} daysLeft={c.daysLeft} />
            <span className="text-copy">
              {c.supplierName}
              {c.city ? ` · ${c.city}` : ''} · <span className="whitespace-nowrap">{rangeText(c.validFrom, c.validTo)}</span>
            </span>
          </>
        }
        owner={c.isMine ? 'You' : (c.enteredByName ?? undefined)}
        ownerLabel="Entered by"
        // The one primary action sits beside the title (a confirm dialog or a command, not a jump or a link).
        next={nextLine.mine ? { text: nextLine.text } : null}
        nextWho={nextLine.mine ? undefined : nextLine.text}
        actions={primary ?? undefined}
      />
      <JumpLinks links={jumps} className="mb-[0]" />

      {!enabled ? (
        <Notice tone="locked" role="status" title="Rate contracts are not switched on yet">
          <p>You can read this contract. Nothing can be changed, approved or ended until a Super Admin switches rate contracts on.</p>
        </Notice>
      ) : null}
      {c.status === 'returned' && c.returnReason ? (
        <Notice tone="danger" title={`Returned${c.decidedByName ? ` by ${c.decidedByName}` : ''}`}>
          <p className="wrap-anywhere">{c.returnReason}</p>
        </Notice>
      ) : null}
      {c.status === 'ended' ? (
        <Notice tone="info" title="Ended">
          <p className="wrap-anywhere">{c.endReason ?? 'This contract is no longer used for offers.'}</p>
        </Notice>
      ) : null}

      <Card id="contract-details">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Contract</CardTitle>
            <CardDescription>Supplier, hotel, dates and terms.</CardDescription>
          </div>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <Facts
            rows={[
              ['Supplier', c.supplierName],
              ['Hotel', `${c.hotelName}${c.city ? `, ${c.city}` : ''}`],
              ['Rates apply', rangeText(c.validFrom, c.validTo)],
              ['Status', STATUS_LOOK[c.status].word],
              c.decidedByName && c.decidedAt ? [c.status === 'returned' ? 'Returned' : 'Decided', `${dateText(c.decidedAt)} by ${c.decidedByName}`] : null,
              !editing ? ['Cancellation terms', c.cancellationTerms ? <span className="whitespace-pre-line">{c.cancellationTerms}</span> : <span className="text-quiet">Not entered</span>] : null,
              !editing && c.note ? ['Note', c.note] : null,
            ]}
          />
          {editing && actions.save ? (
            <FormSection title="Change the details">
              <ContractDetailsForm action={actions.save} contract={c} initialState={preview?.detailsState} />
            </FormSection>
          ) : null}
        </CardBody>
      </Card>

      <Card id="rate-lines">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Rate lines</CardTitle>
            <CardDescription>
              {c.lines.length} {c.lines.length === 1 ? 'line' : 'lines'} · per room per night{c.blackouts.length > 0 ? ` · ${c.blackouts.length} blackout ${c.blackouts.length === 1 ? 'period' : 'periods'}` : ''}
            </CardDescription>
          </div>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          {editing && actions.linesSet ? (
            <RateLinesForm action={actions.linesSet} contract={c} roomTypes={roomTypes ?? []} initialState={preview?.linesState} />
          ) : (
            <>
              {c.lines.length === 0 ? (
                <EmptyState icon={ListChecks} headingLevel={3} title="No rate lines yet" description={viewer === 'purchase' ? 'Rate lines can be added while the contract is a draft or returned.' : 'Purchase adds the rate lines before sending it for approval.'} />
              ) : (
                <LinesTable lines={c.lines} />
              )}
              <BlackoutList contract={c} />
            </>
          )}
        </CardBody>
      </Card>

      {viewer === 'purchase' && roomTypes ? (
        <Card id="room-types">
          <CardHeader>
            <div className="min-w-0">
              <CardTitle>Room types of {c.hotelName}</CardTitle>
              <CardDescription>Shared by every contract and offer for this hotel.</CardDescription>
            </div>
          </CardHeader>
          <CardBody className="flex flex-col gap-4">
            {roomTypes.length === 0 ? (
              <p className="m-0 text-copy">No room types yet.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-control border border-line p-0" aria-label="Room types">
                {roomTypes.map((r) => (
                  <li key={r.roomTypeId} className="m-0 flex flex-wrap items-start justify-between gap-2 px-3 py-2.5">
                    <span className="flex items-center gap-2 font-medium wrap-anywhere text-ink">
                      <Hotel aria-hidden="true" className="size-4 shrink-0 text-quiet" />
                      {r.name}
                    </span>
                    {r.inUse ? (
                      <BlockedButton label={`Remove ${r.name}`} reason="Used by an active contract." />
                    ) : (
                      <DialogAction
                        buttonLabel="Remove"
                        ariaLabel={`Remove room type ${r.name}`}
                        blockedReason={off}
                        title={`Remove ${r.name}?`}
                        description="It can no longer be chosen for new rate lines or offers. Offers already made keep their words."
                        primaryLabel="Remove room type"
                        pendingLabel="Removing…"
                        action={actions.roomTypeRemove}
                        fields={{ roomTypeId: r.roomTypeId }}
                        danger
                        okTitle="Removed"
                        initialOpen={preview?.open === 'removeRoomType' && r === roomTypes.find((x) => !x.inUse)}
                        initialState={preview?.open === 'removeRoomType' && r === roomTypes.find((x) => !x.inUse) ? preview.state : undefined}
                      >
                        <ReasonField id={`rt-reason-${r.roomTypeId}`} />
                      </DialogAction>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {enabled && actions.roomTypeSave ? <RoomTypeAddForm action={actions.roomTypeSave} hotelId={c.hotelId} /> : null}
          </CardBody>
        </Card>
      ) : null}

      <Card id="contract-files">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Contract file</CardTitle>
            <CardDescription>The supplier’s signed contract or rate sheet. Every download is recorded.</CardDescription>
          </div>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          {c.files.length === 0 ? (
            <p className="m-0 flex items-center gap-2 text-copy">
              <Paperclip aria-hidden="true" className="size-4 text-quiet" />
              No file yet.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Contract files">
              {c.files.map((f) => (
                <li key={f.fileId} className="m-0 flex flex-col gap-0.5">
                  {f.status === 'stored' ? (
                    <a href={fileHref(f.fileId)} rel="noopener" className={cn('inline-flex items-center gap-1.5 font-medium wrap-anywhere text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing)}>
                      <FileText aria-hidden="true" className="size-4 shrink-0" />
                      {f.fileName}
                    </a>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 wrap-anywhere">
                      <FileText aria-hidden="true" className="size-4 shrink-0 text-quiet" />
                      {f.fileName} — {f.status === 'pending_upload' ? 'still uploading, or the upload stopped' : f.status === 'removed' ? 'removed' : 'not accepted (wrong type or size)'}
                    </span>
                  )}
                  <span className="text-sm text-quiet">
                    Uploaded {dateText(f.uploadedAt)}
                    {f.uploadedByName ? ` by ${f.uploadedByName}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {viewer === 'purchase' && enabled && actions.fileUpload ? <ContractFileForm action={actions.fileUpload} contractId={c.contractId} /> : null}
        </CardBody>
      </Card>

      {viewer === 'manager' && (c.status === 'pending_approval' || c.status === 'active') ? (
        <Card>
          <CardHeader>
            <div className="min-w-0">
              <CardTitle>{c.status === 'pending_approval' ? 'Not right?' : 'End this contract'}</CardTitle>
              <CardDescription>{c.status === 'pending_approval' ? 'Send it back to Purchase with what to fix.' : 'Offers stop using it at once. Offers already made keep their prices.'}</CardDescription>
            </div>
          </CardHeader>
          <CardBody>
            {c.status === 'pending_approval' ? (
              <DialogAction
                buttonLabel="Return to Purchase"
                blockedReason={off ?? (c.can.return && c.can.approve ? null : c.isMine ? 'You entered this contract. Another Manager approves it.' : 'Only a Manager who did not enter it decides it.')}
                title={`Return ${c.contractNo}?`}
                description="Purchase sees your reason at the top of the contract and can fix it and send it again."
                primaryLabel="Return contract"
                pendingLabel="Returning…"
                action={actions.decide}
                fields={{ ...fields, decision: 'return' }}
                okTitle="Returned"
                initialOpen={preview?.open === 'return'}
                initialState={preview?.open === 'return' ? preview.state : undefined}
              >
                <ReasonField id="rc-return-reason" label="What should Purchase fix?" />
              </DialogAction>
            ) : (
              <DialogAction
                buttonLabel="End contract"
                blockedReason={off ?? (c.can.end ? null : 'Not available to you.')}
                title={`End ${c.contractNo} now?`}
                description="This cannot be undone. Purchase can enter a new version from a new rate sheet."
                primaryLabel="End contract"
                pendingLabel="Ending…"
                action={actions.end}
                fields={fields}
                danger
                okTitle="Ended"
                initialOpen={preview?.open === 'end'}
                initialState={preview?.open === 'end' ? preview.state : undefined}
              >
                <ReasonField id="rc-end-reason" />
              </DialogAction>
            )}
          </CardBody>
        </Card>
      ) : null}

      <Card id="contract-history">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Earlier versions</CardTitle>
            <CardDescription>Contracts for the same supplier and hotel, newest first.</CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          {c.history.length === 0 ? (
            <p className="m-0 flex items-center gap-2 text-copy">
              <History aria-hidden="true" className="size-4 text-quiet" />
              This is the first version.
            </p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Earlier versions">
              {c.history.map((h) => (
                <li key={h.contractId} className="m-0 flex flex-col gap-1 border-l-2 border-line pl-3">
                  <span className="flex flex-wrap items-center gap-2">
                    <Link href={`${basePath}/${h.contractId}`} className={linkClass}>
                      {h.contractNo} · version {h.versionNo}
                    </Link>
                    <ContractStatusBadge status={h.status} />
                  </span>
                  <span className="text-sm text-copy">{rangeText(h.validFrom, h.validTo)}</span>
                  {h.decidedByName && h.decidedAt ? <span className="text-sm text-quiet">Decided {dateText(h.decidedAt)} by {h.decidedByName}</span> : null}
                  {h.endReason ? <span className="text-sm wrap-anywhere text-quiet">{h.endReason}</span> : null}
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function money(paise: string | null, empty = 'Not offered') {
  return paise ? <span className="tabular-nums">{inr(paise)}</span> : <span className="text-quiet">{empty}</span>;
}

/** Read-only rate lines: a table from 640 px, labelled cards below. */
export function LinesTable({ lines }: { lines: RateLineView[] }) {
  return (
    <Table stackOnMobile label="Rate lines table" wrapperClassName="rounded-control border border-line" className="sm:min-w-[56rem]">
      <TableCaption className="sr-only">Rate lines, per room per night</TableCaption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Season</TableHead>
          <TableHead>Room and meals</TableHead>
          <TableHead numeric>Rate</TableHead>
          <TableHead numeric>Weekend</TableHead>
          <TableHead numeric>Extra adult</TableHead>
          <TableHead numeric>Child with bed</TableHead>
          <TableHead numeric>Child no bed</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((l, i) => (
          <TableRow key={l.lineId} className="align-top">
            <TableCell label="Season" className="align-top">
              <span className="block text-xs font-medium text-quiet">Line {i + 1}</span>
              {rangeText(l.seasonFrom, l.seasonTo)}
              {l.note ? <span className="block text-sm wrap-anywhere text-quiet">{l.note}</span> : null}
            </TableCell>
            <TableCell label="Room and meals" className="align-top">
              <span className="block font-medium wrap-anywhere text-ink">{l.roomTypeName}</span>
              <span className="block text-sm text-quiet">
                {MEAL_PLAN_LABEL[l.mealPlan]} ({l.mealPlan})
              </span>
            </TableCell>
            <TableCell label="Rate" numeric className="align-top">
              {money(l.ratePaise)}
            </TableCell>
            <TableCell label="Weekend" numeric className="align-top">
              {money(l.weekendRatePaise, 'Same')}
            </TableCell>
            <TableCell label="Extra adult" numeric className="align-top">
              {money(l.extraAdultPaise)}
            </TableCell>
            <TableCell label="Child with bed" numeric className="align-top">
              {money(l.childWithBedPaise)}
            </TableCell>
            <TableCell label="Child no bed" numeric className="align-top">
              {money(l.childWithoutBedPaise)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function BlackoutList({ contract }: { contract: RateContractDetail }) {
  if (contract.blackouts.length === 0) return <p className="m-0 text-sm text-quiet">No blackout dates.</p>;
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="m-0 flex items-center gap-2 text-base font-semibold text-ink">
        <CalendarOff aria-hidden="true" className="size-4 text-quiet" />
        Blackout dates
      </h3>
      <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5" aria-label="Blackout dates">
        {contract.blackouts.map((b) => (
          <li key={`${b.fromDate}-${b.toDate}`}>{rangeText(b.fromDate, b.toDate)}</li>
        ))}
      </ul>
    </div>
  );
}

export function RateContractLoading() {
  return (
    <div className="flex flex-col gap-4 font-sans">
      <h1 className="sr-only">Rate contract</h1>
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading the contract…
      </p>
      <div aria-busy="true" className="flex flex-col gap-4">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-40 w-full rounded-card" />
        ))}
      </div>
    </div>
  );
}

/** R-E2 returned null: not a reader, or no such contract (same words). */
export function RateContractNotFound({ basePath = '/app/purchase/rate-contracts' }: { basePath?: string }) {
  return (
    <div className="flex flex-col gap-4 font-sans text-base text-copy">
      <TaskBackLink href={basePath}>Back to rate contracts</TaskBackLink>
      <PageHeader title="Rate contract" />
      <Notice tone="locked" role="status" title="This contract is not available to you">
        <p>It does not exist, or rate contracts are not part of your work. Rate contracts are for Purchase, branch Managers and Accounts.</p>
      </Notice>
    </div>
  );
}
