import { FileCheck, Plane, Ticket } from 'lucide-react';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { BlockedButton, CommandButton, DialogAction } from '@/views/accounts-desk/acc2-kit';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { whenText } from '@/views/accounts-desk/labels';
import { CHANNEL_LABEL, SEND_STATE_WORD, boardingPassDue } from './labels';
import { BOARDING_PASS_NOT_LINKED_TEXT } from '@/modules/customer-messages/contracts';
import type { TaskCustomerFiles } from '@/modules/customer-messages/dto';
import type { BoardingPassSlot, ChannelSendState, TaskCustomerMessageStatus, VoucherFile } from './types';

/*
 * Department task panels for the files the CRM sends to the customer
 * (contract §5.6, R-A3, §15 screen 3). Purchase: "Customer voucher" on a
 * supplier-confirmed hotel task. Flight: "Boarding pass" per passenger and
 * flight, with the urgent "due" banner 24 hours before departure. The send
 * state is all the department sees (LD9): never the message, address or
 * any amount.
 */

const FILE_ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp';
const FILE_HINT = 'PDF, JPEG, PNG or WebP, up to 4 MB.';

function SendState({ status, evidenceId }: { status: TaskCustomerMessageStatus | null; evidenceId: string }) {
  const item = status?.items.find((i) => i.evidenceId === evidenceId);
  const rows: [string, ChannelSendState][] = [
    [CHANNEL_LABEL.email, item?.email.state ?? 'not_sent'],
    [CHANNEL_LABEL.whatsapp, item?.whatsapp.state ?? 'not_sent'],
  ];
  return (
    <dl className="m-0 flex flex-wrap gap-x-4 gap-y-2" aria-label="Sent to the customer">
      {rows.map(([label, state]) => (
        <div key={label} className="flex items-center gap-2">
          <dt className="text-sm text-quiet">{label}</dt>
          <dd className="m-0">
            <StatusBadge tone={SEND_STATE_WORD[state].tone}>{SEND_STATE_WORD[state].label}</StatusBadge>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function FileInput({ id }: { id: string }) {
  return (
    <Field htmlFor={id} label="File" hint={FILE_HINT}>
      <Input id={id} name="file" type="file" accept={FILE_ACCEPT} required aria-describedby={`${id}-hint`} />
    </Field>
  );
}

export interface VoucherActions {
  /** A: purchase_evidence_begin/_finish with kind customer_voucher (one action, file in the form). */
  upload: DecisionAction;
  /** A5 purchase_voucher_mark_ready. */
  markReady: DecisionAction;
}

export function CustomerVoucherPanel({
  taskId,
  supplierConfirmed,
  canWork,
  files,
  status,
  actions,
  preview,
}: {
  taskId: string;
  supplierConfirmed: boolean;
  /** The task's Purchase assignee. Others read only. */
  canWork: boolean;
  files: VoucherFile[];
  status: TaskCustomerMessageStatus | null | 'error';
  actions: Partial<VoucherActions> | null;
  preview?: { uploadOpen?: boolean; uploadState?: DeskResult | null; ready?: { evidenceId: string; state: DeskResult } };
}) {
  const block = !supplierConfirmed ? 'Available once the supplier has confirmed this booking.' : !canWork ? 'Only the Purchase person on this task can add the voucher.' : null;
  const readyCount = files.filter((f) => f.readyAt).length;
  return (
    <Panel
      id="customer-voucher"
      title="Customer voucher"
      icon={<Ticket aria-hidden="true" className="size-4 text-faint" />}
      description={files.length === 0 ? 'No voucher for the customer yet' : `${files.length} ${files.length === 1 ? 'file' : 'files'}, ${readyCount} ready for the customer`}
    >
      <p className="m-0 text-copy">The hotel voucher the customer receives by e-mail and WhatsApp. Upload it, check it, then press “Ready for customer”. The CRM sends it; you see only whether it went.</p>
      {status === 'error' ? (
        <Notice tone="warning" role="status">
          <p>The send state could not be loaded just now. Reload the page.</p>
        </Notice>
      ) : null}
      {files.length > 0 ? (
        <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
          {files.map((f) => (
            <li key={f.evidenceId} className="m-0 flex flex-col gap-2 py-3 first:pt-0">
              <p className="m-0 flex flex-wrap items-center gap-x-2 text-sm">
                <FileCheck aria-hidden="true" className="size-4 shrink-0 text-faint" />
                <span className="font-medium wrap-anywhere text-ink">{f.fileName}</span>
                <span className="text-quiet">Uploaded {whenText(f.storedAt)}</span>
              </p>
              {f.readyAt ? (
                <>
                  <p className="m-0 text-sm text-quiet">
                    Ready for customer — marked by {f.readyByName ?? 'a Purchase person'} on {whenText(f.readyAt)}
                  </p>
                  <SendState status={status === 'error' ? null : status} evidenceId={f.evidenceId} />
                </>
              ) : (
                <CommandButton
                  action={actions?.markReady}
                  fields={{ taskId, evidenceId: f.evidenceId }}
                  label="Ready for customer"
                  pendingLabel="Marking…"
                  variant="primary"
                  okTitle="Queued for the customer"
                  blockedReason={block}
                  initialState={preview?.ready?.evidenceId === f.evidenceId ? preview.ready.state : null}
                  ariaLabel={`Ready for customer: ${f.fileName}`}
                />
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <DialogAction
        buttonLabel="Upload customer voucher"
        buttonVariant={files.length === 0 ? 'primary' : 'secondary'}
        blockedReason={block}
        title="Upload the customer voucher"
        description="The file is private. It goes to the customer only after you press “Ready for customer”."
        primaryLabel="Upload"
        pendingLabel="Uploading…"
        action={actions?.upload}
        fields={{ taskId, kind: 'customer_voucher' }}
        okTitle="Uploaded"
        initialOpen={preview?.uploadOpen}
        initialState={preview?.uploadState}
      >
        <FileInput id="cvoucher-file" />
      </DialogAction>
    </Panel>
  );
}

export interface BoardingPassActions {
  /** A: department_evidence_begin/_finish with kind boarding_pass (file in the form). */
  upload: DecisionAction;
}

export function BoardingPassPanel({
  taskId,
  hasTicketBatch,
  canWork,
  slots,
  status,
  actions,
  now,
  preview,
}: {
  taskId: string;
  hasTicketBatch: boolean;
  /** The Flight task assignee. */
  canWork: boolean;
  slots: BoardingPassSlot[];
  status: TaskCustomerMessageStatus | null | 'error';
  actions: Partial<BoardingPassActions> | null;
  /** Server time (ISO), so the "due" banner is the same on server and browser. */
  now: string;
  preview?: { upload?: { key: string; state?: DeskResult | null } };
}) {
  const nowDate = new Date(now);
  const due = slots.filter((s) => boardingPassDue(s.departureAt, s.file !== null, nowDate));
  const block = !hasTicketBatch ? 'Upload boarding passes after the tickets are confirmed.' : !canWork ? 'Only the Flight person on this task can upload.' : null;
  const stored = slots.filter((s) => s.file).length;
  return (
    <Panel
      id="boarding-passes"
      title="Boarding passes"
      icon={<Plane aria-hidden="true" className="size-4 text-faint" />}
      description={slots.length === 0 ? 'No flights on this task' : `${stored} of ${slots.length} uploaded`}
    >
      {due.length > 0 ? (
        <Notice tone="danger" title="Boarding pass due — flight within 24 hours" role="status">
          <p>{due.map((s) => `${s.passengerLabel}, ${s.sectorLabel}`).join('; ')}.</p>
        </Notice>
      ) : null}
      <p className="m-0 text-copy">Upload each passenger’s boarding pass after web check-in. The CRM sends it to the customer by e-mail and WhatsApp; you see only whether it went.</p>
      {status === 'error' ? (
        <Notice tone="warning" role="status">
          <p>The send state could not be loaded just now. Reload the page.</p>
        </Notice>
      ) : null}
      {slots.length === 0 ? (
        <p className="m-0 text-quiet">No flight sectors on this task.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
          {slots.map((s) => {
            const isDue = due.includes(s);
            return (
              <li key={s.key} className="m-0 flex flex-col gap-2 py-3 first:pt-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p className="m-0 font-semibold text-ink">{s.passengerLabel}</p>
                  <p className="m-0 text-sm text-quiet">
                    {s.sectorLabel} · departs {whenText(s.departureAt)}
                  </p>
                  {isDue ? <StatusBadge tone="danger">Due now</StatusBadge> : null}
                </div>
                {s.file ? (
                  <>
                    <p className="m-0 flex flex-wrap items-center gap-x-2 text-sm">
                      <FileCheck aria-hidden="true" className="size-4 shrink-0 text-faint" />
                      <span className="font-medium wrap-anywhere text-ink">{s.file.fileName}</span>
                      <span className="text-quiet">Uploaded {whenText(s.file.storedAt)}</span>
                    </p>
                    <SendState status={status === 'error' ? null : status} evidenceId={s.file.evidenceId} />
                  </>
                ) : block ? (
                  <BlockedButton label="Upload boarding pass" reason={block} />
                ) : (
                  <DialogAction
                    buttonLabel="Upload boarding pass"
                    buttonVariant={isDue ? 'primary' : 'secondary'}
                    ariaLabel={`Upload boarding pass: ${s.passengerLabel}, ${s.sectorLabel}`}
                    title={`Boarding pass — ${s.passengerLabel}`}
                    description={`${s.sectorLabel}. It goes to the customer as soon as it is stored.`}
                    primaryLabel="Upload and send"
                    pendingLabel="Uploading…"
                    action={actions?.upload}
                    fields={{ taskId, sectorId: s.sectorId, slot: s.key, kind: 'boarding_pass' }}
                    okTitle="Uploaded"
                    initialOpen={preview?.upload?.key === s.key}
                    initialState={preview?.upload?.key === s.key ? preview.upload.state : null}
                  >
                    <FileInput id={`bp-file-${s.key}`} />
                  </DialogAction>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function Panel({ id, title, description, icon, children }: { id: string; title: string; description: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Card id={id}>
      <section aria-labelledby={`${id}-heading`}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={`${id}-heading`}>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {icon}
        </CardHeader>
        <CardBody className="flex flex-col gap-4">{children}</CardBody>
      </section>
    </Card>
  );
}

/** A's task_customer_files slot read (contract §5.6): the files of one task and their send state. */
export type TaskCustomerFilesView = TaskCustomerFiles;

type TaskFile = TaskCustomerFilesView['files'][number];
type TaskSlot = TaskCustomerFilesView['slots'][number];
const slotKey = (s: Pick<TaskSlot, 'sectorId' | 'passengerSeq'>) => `${s.sectorId}:${String(s.passengerSeq)}`;

function TaskFileLine({ f }: { f: TaskFile }) {
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-2 text-sm">
      <FileCheck aria-hidden="true" className="size-4 shrink-0 text-faint" />
      <span className="font-medium wrap-anywhere text-ink">{f.fileName}</span>
      <span className="text-quiet">{f.status === 'stored' && f.storedAt ? `Uploaded ${whenText(f.storedAt)}` : f.status === 'failed' ? 'Upload failed — upload it again' : 'Still uploading'}</span>
    </p>
  );
}

function ChannelStates({ taskId, evidenceId, email, whatsapp }: { taskId: string; evidenceId: string; email: TaskFile['email']; whatsapp: TaskFile['whatsapp'] }) {
  return <SendState status={{ taskId, items: [{ evidenceId, messageType: 'boarding_pass', email, whatsapp }] }} evidenceId={evidenceId} />;
}

/**
 * Flight task › Boarding passes, wired to track A's slot read
 * (task_customer_files, kind boarding_pass, contract §5.6): one slot per
 * active flight and traveller with its own upload and e-mail / WhatsApp send
 * state, plus "Upload one file for the whole flight" when the airline gives a
 * single file for everyone (no slot link). The urgent "due" banner is the
 * database's (a flight departs within 24 hours with no pass after the latest
 * ticket batch). The department sees only whether it went (LD9).
 */
export function TaskBoardingPassPanel({ data, upload, preview }: { data: TaskCustomerFilesView | 'error'; upload: DecisionAction | null; preview?: { state?: DeskResult | null; open?: boolean; slot?: string } }) {
  if (data === 'error')
    return (
      <Panel id="boarding-passes-error" title="Boarding passes" icon={<Plane aria-hidden="true" className="size-4 text-faint" />} description="Could not load">
        <Notice tone="warning" role="status">
          <p>The boarding passes could not be loaded just now. Nothing was changed. Reload the page.</p>
        </Notice>
      </Panel>
    );
  const byId = new Map(data.files.map((f) => [f.evidenceId, f]));
  const whole = data.files.filter((f) => f.sectorId === null);
  const filled = data.slots.filter((s) => s.evidenceId !== null).length;
  const block = !data.taskConfirmed ? 'Upload boarding passes after the tickets are confirmed.' : !data.can.upload ? 'Only the Flight person on this task can upload.' : !upload ? 'Not available to you.' : null;
  const description =
    data.slots.length > 0 ? `${String(filled)} of ${String(data.slots.length)} uploaded` : whole.filter((f) => f.status === 'stored').length === 0 ? 'None uploaded yet' : `${String(whole.filter((f) => f.status === 'stored').length)} uploaded`;
  const wholeOpen = preview?.open && !preview.slot;
  return (
    <Panel id={`boarding-passes-${data.taskId}`} title="Boarding passes" icon={<Plane aria-hidden="true" className="size-4 text-faint" />} description={description}>
      {data.due ? (
        <Notice tone="danger" title="Boarding pass due — flight within 24 hours" role="status">
          <p>Upload the boarding passes after web check-in. The customer is waiting for them.</p>
        </Notice>
      ) : null}
      <p className="m-0 text-copy">Upload each passenger’s boarding pass after web check-in. The CRM sends it to the customer by e-mail and WhatsApp; you see only whether it went.</p>
      {data.slots.length > 0 ? (
        <ul className="m-0 flex list-none flex-col divide-y divide-line p-0" aria-label="Boarding passes per passenger and flight">
          {data.slots.map((s) => {
            const key = slotKey(s);
            const file = s.evidenceId ? byId.get(s.evidenceId) ?? null : null;
            return (
              <li key={key} className="m-0 flex flex-col gap-2 py-3 first:pt-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p className="m-0 font-semibold wrap-anywhere text-ink">{s.passengerName}</p>
                  <p className="m-0 text-sm text-quiet">{s.sectorLabel}</p>
                  {s.evidenceId === null ? <StatusBadge tone="neutral">Not uploaded</StatusBadge> : null}
                </div>
                {s.evidenceId ? (
                  <>
                    {file ? <TaskFileLine f={file} /> : null}
                    <ChannelStates taskId={data.taskId} evidenceId={s.evidenceId} email={s.email} whatsapp={s.whatsapp} />
                  </>
                ) : block ? (
                  <BlockedButton label="Upload boarding pass" reason={block} ariaLabel={`Upload boarding pass: ${s.passengerName}, ${s.sectorLabel}`} />
                ) : (
                  <DialogAction
                    buttonLabel="Upload boarding pass"
                    buttonVariant={data.due ? 'primary' : 'secondary'}
                    ariaLabel={`Upload boarding pass: ${s.passengerName}, ${s.sectorLabel}`}
                    title={`Boarding pass — ${s.passengerName}`}
                    description={`${s.sectorLabel}. It goes to the customer as soon as it is stored.`}
                    primaryLabel="Upload and send"
                    pendingLabel="Uploading…"
                    action={upload}
                    fields={{ taskId: data.taskId, sectorId: s.sectorId, passengerSeq: s.passengerSeq }}
                    okTitle="Uploaded"
                    warnOkMessage={BOARDING_PASS_NOT_LINKED_TEXT}
                    initialOpen={preview?.open && preview.slot === key}
                    initialState={preview?.slot === key ? preview.state : null}
                  >
                    <FileInput id={`bp-file-${data.taskId}-${key}`} />
                  </DialogAction>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {whole.length > 0 ? (
        <section aria-labelledby={`bp-whole-${data.taskId}`} className="flex flex-col gap-2">
          <h3 id={`bp-whole-${data.taskId}`} className="m-0 text-sm font-semibold text-ink">
            {data.slots.length > 0 ? 'Files for the whole flight' : 'Boarding passes uploaded'}
          </h3>
          <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
            {whole.map((f) => (
              <li key={f.evidenceId} className="m-0 flex flex-col gap-2 py-3 first:pt-0">
                <TaskFileLine f={f} />
                {f.status === 'stored' ? <ChannelStates taskId={data.taskId} evidenceId={f.evidenceId} email={f.email} whatsapp={f.whatsapp} /> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {block ? (
        data.slots.length > 0 ? null : <BlockedButton label="Upload a boarding pass" reason={block} />
      ) : (
        <DialogAction
          buttonLabel={data.slots.length > 0 ? 'Upload one file for the whole flight' : 'Upload a boarding pass'}
          buttonVariant={data.slots.length > 0 ? 'ghost' : data.due ? 'primary' : 'secondary'}
          title={data.slots.length > 0 ? 'One file for the whole flight' : 'Upload a boarding pass'}
          description={data.slots.length > 0 ? 'Use this only when the airline gives one file for every passenger. It goes to the customer as soon as it is stored.' : 'One passenger’s boarding pass. It goes to the customer as soon as it is stored.'}
          primaryLabel="Upload and send"
          pendingLabel="Uploading…"
          action={upload}
          fields={{ taskId: data.taskId }}
          okTitle="Uploaded"
          initialOpen={wholeOpen}
          initialState={wholeOpen ? preview?.state : null}
        >
          <FileInput id={`bp-file-${data.taskId}`} />
        </DialogAction>
      )}
    </Panel>
  );
}
