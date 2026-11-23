'use client';

import { CircleCheck, CircleHelp, CircleOff } from 'lucide-react';
import { useActionState, useState } from 'react';
import { HandForm } from '@/components/hand-form';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChipCheck } from '@/components/ui/chip-check';
import { Notice } from '@/components/ui/notice';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { CRM_WORK_LABELS, PRUNE_CONFIRM_PHRASE, PRUNE_DRY_RUN_NOTE, PRUNE_UNDO_NOTE, WON_ONLY_REASON_MAX, WON_ONLY_REASON_MIN, type CrmWorkKind, type IntakeEntryRuleView, type PruneResult } from '@/modules/integration/won-only';
import type { PruneFormState, WonOnlyFormState } from '@/modules/integration/server/won-only-actions';
import { AreaField, TextField } from './controls';
import { PendingButton } from './form-kit';

/*
 * Won-only Deal intake card (B1.1d, contract §3, freeze note §3.3) on the
 * Workflow switches page. Switching on and the real prune need the owner's
 * APPROVE first; the card says so, shows the dry run first, and the real run
 * needs the switch on, a dry run in this visit and the typed word REMOVE.
 */

export type WonOnlyAction = (prev: WonOnlyFormState, formData: FormData) => Promise<WonOnlyFormState>;
export type PruneAction = (prev: PruneFormState, formData: FormData) => Promise<PruneFormState>;

export interface StageOption {
  id: string;
  label: string;
  pipelineName: string | null;
}

/** The trigger stage "Won - Payment Received" in the default pipeline (DEC-27). */
export const WON_STAGE_ID = 'UC_AD0SLH';

function StateBox({ state }: { state: { status: 'idle' | 'error' | 'success'; message?: string } }) {
  if (state.status === 'idle' || !state.message) return <div role="status" aria-live="polite" />;
  return (
    <Notice tone={state.status === 'error' ? 'danger' : 'success'} role={state.status === 'error' ? 'alert' : 'status'}>
      {state.message}
    </Notice>
  );
}

function DealList({ title, deals, showWork }: { title: string; deals: PruneResult['pruned']['deals']; showWork?: boolean }) {
  if (deals.length === 0) return null;
  return (
    <details className="rounded-control border border-line bg-canvas">
      <summary className="flex min-h-11 cursor-pointer items-center px-3 font-medium text-brand-strong">{title}</summary>
      <ul className="m-0 flex list-none flex-col gap-1 border-t border-line bg-card px-3 py-2 text-sm">
        {deals.map((d) => (
          <li key={d.id}>
            {d.reference} · stage {d.stageId ?? 'unknown'}
            {showWork && d.work && d.work.length > 0 ? ` · ${d.work.map((w) => CRM_WORK_LABELS[w as CrmWorkKind] ?? w).join(', ')}` : ''}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function PruneResultView({ result }: { result: PruneResult }) {
  return (
    <div className="flex flex-col gap-3">
      <SummaryList>
        <SummaryRow label="Deals in the CRM now" numeric>
          {result.storedActive}
        </SummaryRow>
        <SummaryRow label="Already at an entry stage" numeric>
          {result.atEntryStage}
        </SummaryRow>
        <SummaryRow label={result.dryRun ? 'Would be hidden (no CRM work)' : 'Hidden from the CRM (can be brought back)'} numeric total>
          {result.pruned.count}
        </SummaryRow>
        <SummaryRow label="Kept: they have CRM work" numeric>
          {result.keptWithWork.count}
        </SummaryRow>
        <SummaryRow label="Kept: a Bitrix update is still waiting" numeric>
          {result.keptSyncPending.count}
        </SummaryRow>
      </SummaryList>
      <DealList title={`${result.dryRun ? 'Deals that would be hidden' : 'Deals hidden'} (${result.pruned.deals.length})`} deals={result.pruned.deals} />
      <DealList title={`Deals kept because of CRM work (${result.keptWithWork.deals.length}) — the owner decides each`} deals={result.keptWithWork.deals} showWork />
      <DealList title={`Deals kept while a Bitrix update waits (${result.keptSyncPending.deals.length})`} deals={result.keptSyncPending.deals} />
      {result.truncated ? <p className="m-0 text-sm text-quiet">The lists are shortened; the counts are complete.</p> : null}
    </div>
  );
}

export function WonOnlyCard({
  rule,
  stageOptions,
  setAction,
  dryRunAction,
  runAction,
  initial = {},
}: {
  rule: IntakeEntryRuleView | null;
  stageOptions: StageOption[];
  setAction: WonOnlyAction;
  dryRunAction: PruneAction;
  runAction: PruneAction;
  /** Preview gallery: first answers. */
  initial?: { set?: WonOnlyFormState; dryRun?: PruneFormState; run?: PruneFormState };
}) {
  const [setState, set] = useActionState(setAction, initial.set ?? ({ status: 'idle' } as WonOnlyFormState));
  const [dryState, dry] = useActionState(dryRunAction, initial.dryRun ?? ({ status: 'idle' } as PruneFormState));
  const [runState, run] = useActionState(runAction, initial.run ?? ({ status: 'idle' } as PruneFormState));
  const on = rule?.wonOnly ?? false;
  const [mode, setMode] = useState<'on' | 'off'>(on ? 'off' : 'on');
  const [stages, setStages] = useState<string[]>(setState.values?.stageIds ?? (on ? (rule?.entryStageIds ?? []) : stageOptions.some((s) => s.id === WON_STAGE_ID) ? [WON_STAGE_ID] : []));
  const [reason, setReason] = useState(setState.values?.reason ?? '');
  const [dryReason, setDryReason] = useState(dryState.values?.reason ?? '');
  const [runReason, setRunReason] = useState(runState.values?.reason ?? '');
  const [confirm, setConfirm] = useState(runState.values?.confirm ?? '');
  const dryResult = dryState.status === 'success' ? dryState.result : undefined;
  return (
    <Card>
      <section aria-labelledby="won-only-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="won-only-heading">Bring in deals only when won</CardTitle>
            <CardDescription>New Bitrix deals come into the CRM only when they reach “Won - Payment Received”. Deals already in the CRM stay and keep updating.</CardDescription>
          </div>
          {rule === null ? (
            <StatusBadge tone="warning" icon={CircleHelp}>
              <span className="sr-only">Current state: </span>Unknown
            </StatusBadge>
          ) : on ? (
            <StatusBadge tone="success" icon={CircleCheck}>
              <span className="sr-only">Current state: </span>On
            </StatusBadge>
          ) : (
            <StatusBadge tone="neutral" icon={CircleOff}>
              <span className="sr-only">Current state: </span>Off
            </StatusBadge>
          )}
        </CardHeader>
        <CardBody className="flex flex-col gap-5">
          {rule === null ? (
            <Notice tone="warning">The CRM could not read this setting, so it shows as Unknown. Unknown is not Off. Reload the page; if it stays Unknown, tell the CRM team.</Notice>
          ) : (
            <SummaryList>
              <SummaryRow label="New deals come in at">{on ? rule.entryStages.map((s) => `${s.label}${s.pipelineName ? ` (${s.pipelineName})` : ''}`).join(', ') : 'Any ticked stage'}</SummaryRow>
              <SummaryRow label="Deals already in the CRM">Stay and keep receiving Bitrix updates, also when they leave Won.</SummaryRow>
            </SummaryList>
          )}
          <Notice tone="warning" title="Owner’s APPROVE first">
            <p>This changes which deals are in the CRM for everyone. Switch this on, and hide deals, only after the owner replies APPROVE. Write it in the reason.</p>
          </Notice>

          <HandForm action={set} noValidate aria-labelledby="won-only-set-heading" className="flex flex-col gap-3">
            <h3 id="won-only-set-heading" className="m-0 text-base font-semibold text-ink">
              {on ? 'Change or switch off' : 'Switch on'}
            </h3>
            <StateBox state={setState} />
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-1 p-0 text-base font-semibold text-ink">Setting</legend>
              {(['on', 'off'] as const).map((m) => (
                <label key={m} htmlFor={`won-only-mode-${m}`} className="flex cursor-pointer items-start gap-2.5">
                  <input id={`won-only-mode-${m}`} type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} className="m-0 mt-0.5 size-4 accent-brand-strong outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-strong" />
                  <span>{m === 'on' ? 'On: new deals come in only at the chosen stages' : 'Off: new deals come in from the ticked stages again'}</span>
                </label>
              ))}
            </fieldset>
            {mode === 'on' ? (
              <fieldset className="m-0 border-0 p-0">
                <legend className="mb-2 p-0 text-base font-semibold text-ink">Entry stages</legend>
                {stageOptions.length === 0 ? (
                  <p className="m-0 text-quiet">The Bitrix stages could not be read. Reload the page.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {stageOptions.map((s) => (
                      <ChipCheck
                        key={s.id}
                        id={`won-only-stage-${s.id}`}
                        name="stageId"
                        value={s.id}
                        label={`${s.label}${s.pipelineName ? ` · ${s.pipelineName}` : ''}`}
                        checked={stages.includes(s.id)}
                        onChange={() => setStages((x) => (x.includes(s.id) ? x.filter((y) => y !== s.id) : [...x, s.id]))}
                      />
                    ))}
                  </div>
                )}
              </fieldset>
            ) : null}
            <AreaField id="won-only-reason" name="reason" label="Why are you changing it?" hint={`${WON_ONLY_REASON_MIN} to ${WON_ONLY_REASON_MAX} characters, saved with your name. Write the owner’s APPROVE here.`} value={reason} onChange={setReason} rows={2} maxLength={WON_ONLY_REASON_MAX} />
            <div>
              <PendingButton pendingLabel="Saving…" variant="primary">
                Save this rule
              </PendingButton>
            </div>
          </HandForm>

          <section aria-labelledby="won-only-prune-heading" className="flex flex-col gap-3 border-t border-line pt-4">
            <h3 id="won-only-prune-heading" className="m-0 text-base font-semibold text-ink">
              Remove deals that are not won
            </h3>
            <p className="m-0 text-copy">Deals with any CRM work (a booking, task, receipt, reported payment, billing details or document) are never removed.</p>
            {!on ? <p className="m-0 text-sm text-quiet">Switch “Bring in deals only when won” on first; then the check shows what would be removed.</p> : null}
            <form action={dry} noValidate className="flex flex-col gap-3" aria-label="Check what would be removed">
              <StateBox state={dryState} />
              <AreaField id="won-only-dry-reason" name="reason" label="Why are you checking?" hint={`${WON_ONLY_REASON_MIN} to ${WON_ONLY_REASON_MAX} characters.`} value={dryReason} onChange={setDryReason} rows={2} maxLength={WON_ONLY_REASON_MAX} />
              <div className="flex flex-col gap-1.5">
                <div>
                  <PendingButton pendingLabel="Checking…" describedBy="won-only-dry-note">
                    Check what would be removed (no deal changes)
                  </PendingButton>
                </div>
                <p id="won-only-dry-note" className="m-0 text-sm text-quiet">
                  {PRUNE_DRY_RUN_NOTE}
                </p>
              </div>
            </form>
            {dryResult ? <PruneResultView result={dryResult} /> : null}
            {on && dryResult ? (
              <form action={run} noValidate className="flex flex-col gap-3 rounded-control border-2 border-status-danger-line bg-status-danger-tint px-3.5 py-3" aria-label="Remove the deals">
                <StateBox state={runState} />
                <p className="m-0 font-semibold text-ink">Only after the owner approved these numbers.</p>
                <p className="m-0 text-sm text-copy">{PRUNE_UNDO_NOTE}</p>
                <AreaField id="won-only-run-reason" name="reason" label="Why, with the owner’s APPROVE of these numbers" value={runReason} onChange={setRunReason} rows={2} maxLength={WON_ONLY_REASON_MAX} />
                <TextField id="won-only-confirm" name="confirm" label={`Type ${PRUNE_CONFIRM_PHRASE} to confirm`} value={confirm} onChange={setConfirm} maxLength={20} />
                <div>
                  <PendingButton pendingLabel="Removing…" variant="danger" disabled={confirm.trim() !== PRUNE_CONFIRM_PHRASE}>
                    Remove {dryResult.pruned.count} {dryResult.pruned.count === 1 ? 'deal' : 'deals'}
                  </PendingButton>
                </div>
              </form>
            ) : !on ? (
              <p className="m-0 text-sm text-quiet">The remove button appears after “Bring in deals only when won” is on and the check was done in this visit.</p>
            ) : null}
            {runState.status === 'success' && runState.result ? <PruneResultView result={runState.result} /> : null}
          </section>
        </CardBody>
      </section>
    </Card>
  );
}
