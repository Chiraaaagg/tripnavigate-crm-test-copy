'use client';

import { CircleCheck, ShieldAlert } from 'lucide-react';
import { useId, useState, type MouseEvent, type ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmChange, type ConfirmResult } from '@/components/ui/confirm-change';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Status } from '@/components/ui/status';
import { switchRowDescribedBy } from '@/components/ui/switch-row';
import {
  FILE_MOVE_FIELD,
  type FileMoveActionResult,
  type FileMoveAlertsModel,
  type FileMoveItemModel,
  type FileMoveSectionModel,
  type FileMoveStopModel,
  type FileMoveSwitchRowModel,
  type FileMoveValueRowModel,
  type FileMovePilotRowModel,
} from '@/modules/settings/file-move-rows';
import { FILE_MOVE_TEXT } from '@/modules/settings/text';
import { SettingRowsCard } from '../settings/setting-rows';
import { ActionSwitchRow, changeLabel, confirmActionOf, type ActionRowPreview } from '../settings/setting-switch-form';

/*
 * S11 "files to Bitrix" (file 14 sections 2.5 to 2.7): Settings › Bitrix
 * connection. Two parts, shown to the Super Admin only (the database answers
 * nothing for anyone else, and then nothing is drawn):
 *
 *  - FileMoveSettingsSection (Switches tab): the three switches as Settings
 *    rows (C6), then the hold, the Accounts box and the pilot deal as value
 *    rows in the same card. Every change opens the one confirm dialog (C7):
 *    what happens, who is affected, the owner's-APPROVE line, a required
 *    reason (10 to 500 characters), Cancel (focused first) and one button
 *    named for the action. A refusal keeps the dialog open with the typed
 *    reason and value; a save closes it and the result is announced beside
 *    the button. Clearing the pilot has its own dialog that says plainly it
 *    is the company-wide start. Turning a switch off also offers a ready-made
 *    reason, "Emergency stop by Super Admin", with one click (review 14a open
 *    question 6): it fills the same reason box, which is still sent and still
 *    checked (10 to 500 characters); turning a switch on keeps a free reason.
 *  - FileMoveAlertsCard (Clean-up tab): automatic stops with "Acknowledge",
 *    and files that need a person with "Try again" and, for a file lost in
 *    Bitrix, "Look in another deal" and "Accept this file is lost".
 *
 * Status is always words with an icon (never colour alone). Buttons say
 * "Change" on screen and "Change {name}" to screen readers; item buttons name
 * their deal. Layout stacks on narrow screens (flex-wrap, no fixed widths),
 * long item keys wrap, and there is no motion beyond the dialog's own
 * (which honours reduced motion). Codes and deal numbers only: no file names.
 */

export type FileMoveAction = (prev: FileMoveActionResult | null, formData: FormData) => Promise<FileMoveActionResult>;

export interface FileMoveSettingsActions {
  setSwitch: FileMoveAction;
  setHold: FileMoveAction;
  setAccountsBox: FileMoveAction;
  setPilot: FileMoveAction;
}

export interface FileMoveAlertActions {
  acknowledge: FileMoveAction;
  retry: FileMoveAction;
  relocate: FileMoveAction;
  acceptLost: FileMoveAction;
}

/** Preview gallery only: one control's dialog open with a reason or a reply. */
export type FileMovePreview = { control: string } & ActionRowPreview;

function previewFor(preview: FileMovePreview | undefined, control: string): ActionRowPreview | undefined {
  return preview && preview.control === control ? preview : undefined;
}

function refusedField(result: ConfirmResult | null | undefined): string | null {
  return result && !result.ok ? (result.fields?.[0] ?? null) : null;
}

/**
 * The dialog's action plus the field the last refusal named, so the input it
 * names is marked. confirmActionOf (the shared Settings adapter) also turns a
 * thrown error into "could not confirm", never "not saved".
 */
function useChangeAction(action: FileMoveAction, initial?: ConfirmResult | null) {
  const [refused, setRefused] = useState<string | null>(refusedField(initial));
  const [formAction] = useState(() => confirmActionOf(action, { onRefusedField: setRefused }));
  return { formAction, refused };
}

// ---------------------------------------------------------------------------
// Settings (Switches tab)
// ---------------------------------------------------------------------------

/**
 * Turning a switch off: one click puts the ready-made reason in the dialog's
 * reason box, so an emergency stop is never slowed down by typing. It only
 * fills the box (the person can still change the words); the reason is posted
 * and checked like any typed one. After the click, focus moves to the reason
 * box, so a screen reader reads its label and the new text, and the next Tab
 * reaches the confirm button. A plain button inside the dialog's form
 * (type="button": it never submits by itself).
 */
function ReadyReasonButton({ reason }: { reason: string }) {
  const hintId = useId();
  const fill = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.form?.elements.namedItem(FILE_MOVE_FIELD.reason);
    if (!(box instanceof HTMLTextAreaElement)) return;
    // The reason box is a React-controlled field (ConfirmChange keeps its text
    // in state). Set it the way typing does, so the dialog's own state and its
    // 10-to-500-character check see the new text.
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setValue) return;
    setValue.call(box, reason);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.focus();
    box.setSelectionRange(reason.length, reason.length);
  };
  return (
    <div className="flex flex-col items-start gap-1.5" data-slot="file-move-ready-reason">
      <p id={hintId} className="m-0 text-sm text-quiet">
        {FILE_MOVE_TEXT.emergencyHint}
      </p>
      <Button type="button" variant="secondary" size="sm" className="h-auto min-h-8 whitespace-normal py-1 text-left" onClick={fill} aria-describedby={hintId}>
        {FILE_MOVE_TEXT.emergencyUse}
      </Button>
    </div>
  );
}

function SwitchRowOf({ row, action, preview }: { row: FileMoveSwitchRowModel; action: FileMoveAction; preview?: ActionRowPreview }) {
  return (
    <ActionSwitchRow
      id={`file-move-${row.key}`}
      rowKey={`file_move_${row.key}`}
      name={row.title}
      effect={row.detail}
      more={<p className="m-0">Affects: every branch.</p>}
      state={row.state}
      readOnlyReason={row.blockedText ?? undefined}
      change={{
        confirmLabel: row.confirmLabel,
        effect: row.effect,
        affected: FILE_MOVE_TEXT.affected,
        tone: row.tone,
        action,
        hiddenFields: { [FILE_MOVE_FIELD.switch]: row.key, [FILE_MOVE_FIELD.state]: row.target, [FILE_MOVE_FIELD.confirm]: 'yes' },
        // STANDING-RULES: writing to Bitrix and deleting the CRM's copy keep a required reason.
        reasonRule: 'required',
        fields: () => (
          <>
            <p className="m-0 text-sm text-quiet">{row.approvalText}</p>
            {row.readyReason ? <ReadyReasonButton reason={row.readyReason} /> : null}
          </>
        ),
      }}
      preview={preview}
    />
  );
}

/** One value row (hold, Accounts box, pilot): name, one line, the value in words, and its Change. */
function ValueRow({ id, row, children }: { id: string; row: FileMoveValueRowModel; children: ReactNode }) {
  return (
    <li className="m-0 border-b border-line last:border-b-0" data-slot="setting-row" data-key={`file_move_${row.key}`}>
      <div id={`${id}-row`} className="flex flex-col gap-2.5 px-4.5 py-3.5 font-sans sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          <p id={`${id}-name`} className="m-0 font-semibold text-ink">
            {row.title}
          </p>
          <p className="m-0 text-sm text-copy">{row.detail}</p>
        </div>
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-3 sm:justify-end">
          <span id={`${id}-state`} className="min-w-0 max-w-full">
            {/* A value is shown as words; only "not set" gets a badge (Off look, own words), so nothing relies on colour. */}
            {row.empty ? (
              <Status kind="off" label={row.valueText} srPrefix={`${row.title}: `} wrap />
            ) : (
              <span className="font-semibold text-ink break-all">
                <span className="sr-only">{`${row.title}: `}</span>
                {row.valueText}
              </span>
            )}
          </span>
          {children}
        </div>
      </div>
    </li>
  );
}

/** A text or number field inside a change dialog. Uncontrolled: the dialog's form never resets, so a refusal keeps it. */
function DialogInput({
  name,
  label,
  hint,
  error,
  defaultValue,
  inputMode,
  autoComplete = 'off',
}: {
  name: string;
  label: string;
  hint: string;
  error: string | null;
  defaultValue: string;
  inputMode?: 'numeric' | 'text';
  autoComplete?: string;
}) {
  const uid = useId();
  const id = `${uid}-${name}`;
  return (
    <Field htmlFor={id} label={label} hint={hint} error={error}>
      <Input
        id={id}
        name={name}
        defaultValue={defaultValue}
        inputMode={inputMode}
        autoComplete={autoComplete}
        spellCheck={false}
        required
        invalid={Boolean(error)}
        aria-describedby={fieldDescribedBy(id, { hint: true, error })}
      />
    </Field>
  );
}

function HoldRow({ row, action, preview }: { row: FileMoveValueRowModel; action: FileMoveAction; preview?: ActionRowPreview }) {
  const id = 'file-move-hold';
  const change = useChangeAction(action, preview?.result);
  return (
    <ValueRow id={id} row={row}>
      <ConfirmChange
        title={`${row.confirmLabel}?`}
        effect={row.effect}
        affected={FILE_MOVE_TEXT.affected}
        confirmLabel={row.confirmLabel}
        reason="required"
        reasonLabel="Why are you changing it?"
        reasonHint={FILE_MOVE_TEXT.reasonHint}
        formAction={change.formAction}
        hiddenFields={{ [FILE_MOVE_FIELD.confirm]: 'yes' }}
        trigger={{ label: changeLabel(row.title), describedBy: switchRowDescribedBy(id) }}
        initialOpen={preview?.open}
        initialReason={preview?.reason}
        initialResult={preview?.result}
      >
        <DialogInput
          name={FILE_MOVE_FIELD.minutes}
          label={FILE_MOVE_TEXT.holdLabel}
          hint={FILE_MOVE_TEXT.holdHint}
          inputMode="numeric"
          defaultValue={row.inputValue}
          error={change.refused === FILE_MOVE_FIELD.minutes ? FILE_MOVE_TEXT.holdError : null}
        />
        <p className="m-0 text-sm text-quiet">{FILE_MOVE_TEXT.approval}</p>
      </ConfirmChange>
    </ValueRow>
  );
}

function BoxRow({ row, action, preview }: { row: FileMoveValueRowModel; action: FileMoveAction; preview?: ActionRowPreview }) {
  const id = 'file-move-accounts-box';
  const change = useChangeAction(action, preview?.result);
  return (
    <ValueRow id={id} row={row}>
      <ConfirmChange
        title={`${row.confirmLabel}?`}
        effect={row.effect}
        affected={FILE_MOVE_TEXT.affected}
        confirmLabel={row.confirmLabel}
        reason="required"
        reasonLabel="Why are you changing it?"
        reasonHint={FILE_MOVE_TEXT.reasonHint}
        formAction={change.formAction}
        hiddenFields={{ [FILE_MOVE_FIELD.confirm]: 'yes' }}
        trigger={{ label: changeLabel(row.title), describedBy: switchRowDescribedBy(id) }}
        initialOpen={preview?.open}
        initialReason={preview?.reason}
        initialResult={preview?.result}
      >
        <DialogInput
          name={FILE_MOVE_FIELD.itemKey}
          label={FILE_MOVE_TEXT.boxLabel}
          hint={FILE_MOVE_TEXT.boxHint}
          defaultValue={row.inputValue}
          error={change.refused === FILE_MOVE_FIELD.itemKey ? FILE_MOVE_TEXT.boxError : null}
        />
        <p className="m-0 text-sm text-quiet">{FILE_MOVE_TEXT.approval}</p>
      </ConfirmChange>
    </ValueRow>
  );
}

function PilotRow({ row, action, preview }: { row: FileMovePilotRowModel; action: FileMoveAction; preview?: FileMovePreview }) {
  const id = 'file-move-pilot';
  const set = previewFor(preview, 'pilot');
  const clear = previewFor(preview, 'pilot_clear');
  const setChange = useChangeAction(action, set?.result);
  const clearChange = useChangeAction(action, clear?.result);
  return (
    <ValueRow id={id} row={row}>
      <ConfirmChange
        title={`${row.confirmLabel}?`}
        effect={row.effect}
        affected={FILE_MOVE_TEXT.affected}
        confirmLabel={row.confirmLabel}
        reason="required"
        reasonLabel="Why are you changing it?"
        reasonHint={FILE_MOVE_TEXT.reasonHint}
        formAction={setChange.formAction}
        hiddenFields={{ [FILE_MOVE_FIELD.confirm]: 'yes' }}
        trigger={{ label: changeLabel(row.title), describedBy: switchRowDescribedBy(id) }}
        initialOpen={set?.open}
        initialReason={set?.reason}
        initialResult={set?.result}
      >
        <DialogInput
          name={FILE_MOVE_FIELD.dealId}
          label={FILE_MOVE_TEXT.pilotLabel}
          hint={FILE_MOVE_TEXT.pilotHint}
          inputMode="numeric"
          defaultValue={row.inputValue}
          error={setChange.refused === FILE_MOVE_FIELD.dealId ? FILE_MOVE_TEXT.pilotError : null}
        />
        <p className="m-0 text-sm text-quiet">{FILE_MOVE_TEXT.approval}</p>
      </ConfirmChange>
      {row.clear ? (
        <ConfirmChange
          title={`${FILE_MOVE_TEXT.clearTitle}?`}
          effect={row.clear.effect}
          affected={FILE_MOVE_TEXT.affected}
          confirmLabel={row.clear.confirmLabel}
          tone="danger"
          reason="required"
          reasonLabel="Why are you clearing it?"
          reasonHint={FILE_MOVE_TEXT.reasonHint}
          formAction={clearChange.formAction}
          hiddenFields={{ [FILE_MOVE_FIELD.clear]: 'yes', [FILE_MOVE_FIELD.confirm]: 'yes' }}
          trigger={{
            label: (
              <>
                <span aria-hidden="true">Clear</span>
                <span className="sr-only">{FILE_MOVE_TEXT.clearTitle}</span>
              </>
            ),
            describedBy: switchRowDescribedBy(id),
          }}
          initialOpen={clear?.open}
          initialReason={clear?.reason}
          initialResult={clear?.result}
        >
          <p className="m-0 text-sm text-quiet">{FILE_MOVE_TEXT.approval}</p>
        </ConfirmChange>
      ) : null}
    </ValueRow>
  );
}

/**
 * Switches tab: "Files kept in Bitrix". null model = not the Super Admin: nothing at all.
 * Not installed or unreadable: the heading and one honest line, no change controls.
 */
export function FileMoveSettingsSection({
  model,
  actions,
  preview,
}: {
  model: FileMoveSectionModel | null;
  actions: FileMoveSettingsActions;
  /** Preview gallery only. control: a switch key, 'hold', 'accounts_box', 'pilot' or 'pilot_clear'. */
  preview?: FileMovePreview;
}) {
  if (!model) return null;
  const headingId = 'file-move-heading';
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3" data-slot="settings-section" id="file-move">
      <div className="flex flex-col gap-1">
        <h3 id={headingId} className="m-0 text-lg font-semibold text-ink">
          {FILE_MOVE_TEXT.sectionTitle}
        </h3>
        <p className="m-0 text-copy">{FILE_MOVE_TEXT.sectionLine}</p>
      </div>
      {model.kind !== 'ready' ? (
        <Notice tone={model.kind === 'error' ? 'warning' : 'info'} role="status">
          <p>{model.text}</p>
        </Notice>
      ) : (
        <>
          {model.notices.map((line) => (
            <Notice key={line} tone="warning" role="status">
              <p>{line}</p>
            </Notice>
          ))}
          <SettingRowsCard label={FILE_MOVE_TEXT.sectionTitle}>
            {model.switches.map((row) => (
              <SwitchRowOf key={row.key} row={row} action={actions.setSwitch} preview={previewFor(preview, row.key)} />
            ))}
            <HoldRow row={model.hold} action={actions.setHold} preview={previewFor(preview, 'hold')} />
            <BoxRow row={model.box} action={actions.setAccountsBox} preview={previewFor(preview, 'accounts_box')} />
            <PilotRow row={model.pilot} action={actions.setPilot} preview={preview} />
          </SettingRowsCard>
          <p className="m-0 text-sm text-quiet" data-slot="file-move-updated">
            {model.updatedLine}
          </p>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Alerts (Clean-up tab)
// ---------------------------------------------------------------------------

/** "Try again" etc. say the action on screen and add the deal for screen readers. */
function named(label: string, tail: string): ReactNode {
  return (
    <>
      <span aria-hidden="true">{label}</span>
      <span className="sr-only">
        {label} {tail}
      </span>
    </>
  );
}

function StopRow({ stop, action, preview }: { stop: FileMoveStopModel; action: FileMoveAction; preview?: ActionRowPreview }) {
  const change = useChangeAction(action, preview?.result);
  return (
    <li
      className={
        stop.open
          ? 'm-0 flex flex-wrap items-center gap-3 rounded-control border border-status-danger-line bg-status-danger-tint px-3.5 py-2.5'
          : 'm-0 flex flex-wrap items-center gap-3 rounded-control border border-line bg-canvas px-3.5 py-2.5'
      }
      data-slot="file-move-stop"
      data-open={stop.open ? 'yes' : 'no'}
    >
      <span className="min-w-0 flex-1 basis-60">
        <span className="flex flex-wrap items-center gap-2">
          <Status kind={stop.open ? 'needs_attention' : 'closed'} label={stop.open ? FILE_MOVE_TEXT.stopOpen : FILE_MOVE_TEXT.stopAcknowledged} srPrefix="Stop: " />
          <span className="font-semibold text-ink">{stop.dealText}</span>
        </span>
        <span className="mt-1 block text-sm text-copy">{stop.reasonText}</span>
        <span className="block text-sm text-quiet">{stop.timeText}</span>
      </span>
      {stop.open ? (
        <ConfirmChange
          title={FILE_MOVE_TEXT.ackTitle}
          effect={FILE_MOVE_TEXT.ackEffect}
          confirmLabel={FILE_MOVE_TEXT.ackConfirm}
          reason="required"
          reasonLabel="What was checked?"
          reasonHint={FILE_MOVE_TEXT.reasonHint}
          formAction={change.formAction}
          hiddenFields={{ [FILE_MOVE_FIELD.stopId]: stop.stopId, [FILE_MOVE_FIELD.confirm]: 'yes' }}
          trigger={{ label: named(FILE_MOVE_TEXT.ackLabel, `the stop on ${stop.dealText}`) }}
          initialOpen={preview?.open}
          initialReason={preview?.reason}
          initialResult={preview?.result}
        />
      ) : null}
    </li>
  );
}

function ItemRow({ item, actions, preview }: { item: FileMoveItemModel; actions: FileMoveAlertActions; preview?: FileMovePreview }) {
  const retry = previewFor(preview, `retry:${item.moveId}`);
  const relocate = previewFor(preview, `relocate:${item.moveId}`);
  const lost = previewFor(preview, `lost:${item.moveId}`);
  const retryChange = useChangeAction(actions.retry, retry?.result);
  const relocateChange = useChangeAction(actions.relocate, relocate?.result);
  const lostChange = useChangeAction(actions.acceptLost, lost?.result);
  return (
    <li className="m-0 flex flex-wrap items-center gap-3 rounded-control border border-status-warning-line bg-status-warning-tint px-3.5 py-2.5" data-slot="file-move-item" data-kind={item.kind}>
      <span className="min-w-0 flex-1 basis-60">
        <span className="flex flex-wrap items-center gap-2">
          <Status kind={item.kind === 'lost_in_bitrix' ? 'lost_in_bitrix' : 'needs_attention'} label={item.label} srPrefix="Problem: " wrap />
          <span className="font-semibold text-ink">{item.dealText}</span>
        </span>
        <span className="mt-1 block text-sm text-copy">{item.text}</span>
        <span className="block text-sm text-quiet">
          {item.whatText} · {item.timeText}
        </span>
        {item.errorText ? <span className="block text-sm text-quiet">{item.errorText}</span> : null}
      </span>
      <span className="flex flex-wrap items-start gap-2">
        {item.canRetry ? (
          <ConfirmChange
            title={FILE_MOVE_TEXT.retryTitle}
            effect={FILE_MOVE_TEXT.retryEffect}
            confirmLabel={FILE_MOVE_TEXT.retryConfirm}
            reason="none"
            formAction={retryChange.formAction}
            hiddenFields={{ [FILE_MOVE_FIELD.moveId]: item.moveId, [FILE_MOVE_FIELD.confirm]: 'yes' }}
            trigger={{ label: named(FILE_MOVE_TEXT.retryLabel, item.nameTail) }}
            initialOpen={retry?.open}
            initialResult={retry?.result}
          />
        ) : null}
        {item.canRelocate ? (
          <ConfirmChange
            title={FILE_MOVE_TEXT.relocateTitle}
            effect={FILE_MOVE_TEXT.relocateEffect}
            confirmLabel={FILE_MOVE_TEXT.relocateConfirm}
            reason="none"
            formAction={relocateChange.formAction}
            hiddenFields={{ [FILE_MOVE_FIELD.moveId]: item.moveId, [FILE_MOVE_FIELD.confirm]: 'yes' }}
            trigger={{ label: named(FILE_MOVE_TEXT.relocateLabel, item.nameTail) }}
            initialOpen={relocate?.open}
            initialResult={relocate?.result}
          >
            <DialogInput
              name={FILE_MOVE_FIELD.dealId}
              label={FILE_MOVE_TEXT.relocateLabelField}
              hint={FILE_MOVE_TEXT.relocateHint}
              inputMode="numeric"
              defaultValue=""
              error={relocateChange.refused === FILE_MOVE_FIELD.dealId ? FILE_MOVE_TEXT.pilotError : null}
            />
          </ConfirmChange>
        ) : null}
        {item.canAcceptLost ? (
          <ConfirmChange
            title={FILE_MOVE_TEXT.lostTitle}
            effect={FILE_MOVE_TEXT.lostEffect}
            confirmLabel={FILE_MOVE_TEXT.lostConfirm}
            tone="danger"
            reason="required"
            reasonLabel="Why is it lost?"
            reasonHint={FILE_MOVE_TEXT.reasonHint}
            formAction={lostChange.formAction}
            hiddenFields={{ [FILE_MOVE_FIELD.moveId]: item.moveId, [FILE_MOVE_FIELD.confirm]: 'yes' }}
            trigger={{ label: named(FILE_MOVE_TEXT.lostLabel, item.nameTail) }}
            initialOpen={lost?.open}
            initialReason={lost?.reason}
            initialResult={lost?.result}
          >
            <p className="m-0 text-sm text-quiet">{FILE_MOVE_TEXT.approval}</p>
          </ConfirmChange>
        ) : null}
      </span>
    </li>
  );
}

/**
 * Clean-up tab: the alert list. null model = nothing is shown (not the Super
 * Admin, or not installed). A failed read says so; it is never "nothing open".
 */
export function FileMoveAlertsCard({
  model,
  actions,
  preview,
}: {
  model: FileMoveAlertsModel | null;
  actions: FileMoveAlertActions;
  /** Preview gallery only. control: 'ack:<stopId>', 'retry:<moveId>', 'relocate:<moveId>' or 'lost:<moveId>'. */
  preview?: FileMovePreview;
}) {
  if (!model) return null;
  return (
    <Card>
      <section aria-labelledby="file-move-alerts-heading" data-slot="file-move-alerts">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="file-move-alerts-heading">{FILE_MOVE_TEXT.alertsTitle}</CardTitle>
            <CardDescription>{FILE_MOVE_TEXT.alertsLine}</CardDescription>
          </div>
          {model.kind === 'error' ? null : model.summary.open + model.summary.items > 0 ? (
            <StatusBadge tone="danger" icon={ShieldAlert} wrap>
              {model.summary.text}
            </StatusBadge>
          ) : (
            <StatusBadge tone="success" icon={CircleCheck}>
              {model.summary.text}
            </StatusBadge>
          )}
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          {model.kind === 'error' ? (
            <p className="m-0 text-copy" role="status">
              {model.text}
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <h3 className="m-0 text-base font-semibold text-ink">{FILE_MOVE_TEXT.stopsTitle}</h3>
                {model.stops.length === 0 ? (
                  <p className="m-0 text-copy">{FILE_MOVE_TEXT.stopsNone}</p>
                ) : (
                  <>
                    {model.summary.open > 0 ? <p className="m-0 text-copy">{FILE_MOVE_TEXT.stopsHelp}</p> : null}
                    <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label={FILE_MOVE_TEXT.stopsTitle}>
                      {model.stops.map((stop) => (
                        <StopRow key={stop.stopId} stop={stop} action={actions.acknowledge} preview={previewFor(preview, `ack:${stop.stopId}`)} />
                      ))}
                    </ul>
                  </>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <h3 className="m-0 text-base font-semibold text-ink">{FILE_MOVE_TEXT.itemsTitle}</h3>
                {model.items.length === 0 ? (
                  <p className="m-0 text-copy">{FILE_MOVE_TEXT.itemsNone}</p>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label={FILE_MOVE_TEXT.itemsTitle}>
                    {model.items.map((item) => (
                      <ItemRow key={item.moveId} item={item} actions={actions} preview={preview} />
                    ))}
                  </ul>
                )}
              </div>
              {model.countLines.length > 0 ? (
                <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm text-copy" aria-label="Counts">
                  {model.countLines.map((line) => (
                    <li key={line} className="m-0">
                      {line}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </CardBody>
      </section>
    </Card>
  );
}
