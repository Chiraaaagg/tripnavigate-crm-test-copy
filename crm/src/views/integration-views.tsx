import type { ReactNode } from 'react';
import type { FormState } from '@/lib/forms';
import {
  type InboxItemView,
  type InboxOrigin,
  type InboxStatus,
  type IntakeErrorCode,
  type IntakeReasonCode,
  type FullCheckView,
  type IntegrationStatusView,
  type SourceObject,
  STALE_SYNC_HOURS_PROPOSED,
  WORKER_HEALTH_MINUTES_PROPOSED,
} from '@/modules/integration/contracts';
import type { BitrixPipeline, BitrixUser } from '@/modules/integration/bitrix/directory';
import type { HandoffRole } from './handoff';
import { ReconcileNowForm, RetryInboxItemForm } from './integration-forms';
import { autoSyncState, runProblems24h } from '@/modules/integration/auto-sync-state';
import { formatIst } from './staff-views';
import type { SettingsSectionModel } from '@/modules/settings/rows';
import type { SyncStateModel } from '@/modules/settings/server/queries';
import { SettingsSectionHeading } from './settings/settings-frame';
import { SettingsSectionView, type SettingSwitchActions } from './settings/setting-rows';
import { SyncScopeSection, type SyncScopeActions } from './settings/sync-scope-form';

/**
 * Bitrix sync administration (contract §7). Layout adapted from the 21st.dev
 * "Data Refresh State" panel (29369: state pill with a distinct glyph plus text,
 * fact grid, footer actions) and "Destructive Alert with Action List" (29338:
 * one problem sentence, then the repair steps), into the existing CSS and
 * semantic HTML. Every state is text; colour is decoration.
 * See docs/implementation/phase-5/design/21st-dev-log.md.
 */

/**
 * One sync problem in plain words: what happened, who acts next and the repair.
 * `roles` empty means nobody needs to act (the CRM retries, or nothing to do).
 */
export interface ProblemCopy {
  sentence: string;
  roles: HandoffRole[];
  actor: string;
  repair: string;
  /** S-26: runbook steps for the CRM team, shown under "Details for the CRM team" (never the main line). */
  teamDetail?: string;
}

const lowerFirst = (t: string) => (t ? t[0]!.toLowerCase() + t.slice(1) : t);

/**
 * One Next line (copy G-18): "Next: {repair} · {who}" (who includes "nobody
 * yet; the CRM retries on its own"), and the CRM team's runbook steps behind a disclosure.
 */
export function ProblemNextLine({ copy }: { copy: ProblemCopy }) {
  return (
    <>
      <p className="next-line" data-slot="next-line">
        <strong>Next:</strong> {lowerFirst(copy.repair)}
        <span className="hint"> · {lowerFirst(copy.actor)}</span>
      </p>
      {copy.teamDetail ? (
        <details>
          <summary>Details for the CRM team</summary>
          <p className="mb-0">{copy.teamDetail}</p>
        </details>
      ) : null}
    </>
  );
}

const NOBODY = 'Nobody. Nothing to do.';
const AUTOMATIC = 'Nobody yet. The CRM retries on its own.';

export const REASON_COPY: Record<IntakeReasonCode, ProblemCopy> = {
  not_configured: {
    sentence: 'Intake was not configured or was switched off when this deal arrived, so it was not copied.',
    roles: ['Admin'],
    actor: 'An admin',
    repair: 'Finish the intake setup on the server, then press Retry.',
  },
  environment_unset: {
    sentence: 'The server environment was not set when this deal arrived, so it was not copied.',
    roles: ['Admin'],
    actor: 'An admin',
    repair: 'Set the environment on the server, then press Retry.',
  },
  not_eligible_category: {
    sentence: 'This deal is in a Bitrix pipeline this CRM does not take.',
    roles: [],
    actor: NOBODY,
    repair: 'It stays in Bitrix only. If it belongs here, move it to the pilot pipeline in Bitrix.',
  },
  not_eligible_stage: {
    sentence: 'This deal is at a Bitrix stage this CRM does not take yet.',
    roles: [],
    actor: NOBODY,
    repair: 'If it moves to an accepted stage in Bitrix, the next check copies it.',
  },
  before_cutoff: {
    sentence: 'This deal was created in Bitrix before the start date (from 00:00 India time), so it stays in Bitrix only.',
    roles: [],
    actor: NOBODY,
    repair: 'No repair needed. The sync date is the intake start date; deals created before the intake start date stay in Bitrix.',
  },
  unmapped_owner: {
    sentence: 'The responsible person in Bitrix is not linked to a CRM staff member.',
    roles: ['Admin'],
    actor: 'An admin',
    repair: 'Link their Bitrix user to their CRM staff record, then press Retry.',
  },
  owner_not_in_pilot_branch: {
    sentence: 'The responsible person is not an active member of the pilot branch.',
    roles: ['Admin'],
    actor: 'An admin',
    repair: 'Add them to the pilot branch, or reassign the deal in Bitrix to someone in it, then press Retry.',
  },
  invalid_source_data: {
    sentence: 'Bitrix sent this deal with a missing or too-long title or a deal number that is not a number.',
    roles: ['Sales', 'Admin'],
    actor: 'The deal owner corrects it in Bitrix; an admin retries',
    repair: 'Correct the title in Bitrix, then press Retry.',
  },
  source_deal_not_found: {
    sentence: 'Bitrix says this deal does not exist or cannot be read with the CRM’s access.',
    roles: ['Admin'],
    actor: 'An admin',
    repair: 'Check the deal in Bitrix. If it was deleted, nothing to do; otherwise check the CRM’s Bitrix access, then press Retry.',
  },
  stale_ignored: {
    sentence: 'This was an older version of a deal the CRM already holds newer data for.',
    roles: [],
    actor: NOBODY,
    repair: 'No repair needed.',
  },
  reference_conflict: {
    sentence: 'The CRM reference this Bitrix deal needs is already used by another deal.',
    roles: ['Admin'],
    actor: 'An admin, with the CRM team',
    repair: 'Find which CRM deal holds the reference and resolve the duplicate, then press Retry.',
  },
  not_in_manifest: {
    sentence: 'This Bitrix record is not on the owner-approved import list, so it was not copied.',
    roles: [],
    actor: 'Nobody. It stays in Bitrix only.',
    repair:
      'No repair needed. If the owner wants it imported, the CRM team prepares a new approved import list that includes it. Retry cannot add it.',
    teamDetail: 'Create the new approved import list with the manifest command (intake runbook).',
  },
  outside_manifest_scope: {
    sentence:
      'This record is on the approved import list, but Bitrix now shows a different source or a creation time outside the approved date, so it was held for review and not copied.',
    roles: ['Admin'],
    actor: 'An admin, with the owner',
    repair:
      'Check the record in Bitrix. If its source was changed by mistake, correct it in Bitrix, then press Retry. If it really is outside the approved scope, leave it in Bitrix only.',
  },
  scope_changed: {
    sentence:
      'The CRM already holds this record under a different company or branch than the current Bitrix intake setup, so the update was held for review. The CRM record was left as it was.',
    roles: ['Admin'],
    actor: 'An admin, with the owner',
    repair:
      'Confirm with the owner which branch and intake setup this record belongs to. Correct the intake setup if it is wrong, then press Retry. The CRM never moves a record to another company or branch automatically.',
  },
  owner_not_eligible: {
    sentence:
      'The responsible person in Bitrix is not an active Sales member of the pilot branch, so this record stays in Bitrix only.',
    roles: [],
    actor: NOBODY,
    repair:
      'No repair needed. If that person should be in the pilot, link their Bitrix user to their CRM staff record and add them to the pilot branch; the record comes in when it next changes in Bitrix.',
  },
};

/**
 * Phase 6: the copy above names a "deal". For a Bitrix Lead row the same
 * sentence names a "lead", so staff never read a Lead as a Deal.
 */
export function copyForObject(copy: ProblemCopy, sourceObject: SourceObject | undefined): ProblemCopy {
  if (sourceObject !== 'lead') return copy;
  const swap = (text: string) =>
    text.replace(/\bdeals\b/g, 'leads').replace(/\bdeal\b/g, 'lead').replace(/\bDeals\b/g, 'Leads').replace(/\bDeal\b/g, 'Lead');
  return { ...copy, sentence: swap(copy.sentence), actor: swap(copy.actor), repair: swap(copy.repair) };
}

/** "Lead" or "Deal": absent means Deal (rows recorded before Phase 6). */
export function objectLabel(sourceObject: SourceObject | undefined): 'Lead' | 'Deal' {
  return sourceObject === 'lead' ? 'Lead' : 'Deal';
}

export const ERROR_COPY: Record<IntakeErrorCode, ProblemCopy> = {
  provider_timeout: {
    sentence: 'Bitrix did not answer within 10 seconds.',
    roles: [],
    actor: AUTOMATIC,
    repair: 'If it stops after all retries, check that Bitrix is up, then press Retry.',
  },
  provider_unavailable: {
    sentence: 'Bitrix was unavailable (server error or no connection).',
    roles: [],
    actor: AUTOMATIC,
    repair: 'If it stops after all retries, check that Bitrix is up, then press Retry.',
  },
  provider_rate_limited: {
    sentence: 'Bitrix asked the CRM to slow down (rate limit).',
    roles: [],
    actor: AUTOMATIC,
    repair: 'No repair needed unless it stops after all retries; then press Retry.',
  },
  provider_auth_failed: {
    sentence: 'Bitrix rejected the CRM’s access credential, so no deal can be read.',
    roles: ['Admin'],
    actor: 'An admin with Bitrix access',
    repair: 'The CRM team needs to fix the Bitrix login.',
    teamDetail: 'Create a new inbound webhook in Bitrix, put it in the server secret store, then retry the stopped deals.',
  },
  provider_bad_response: {
    sentence: 'Bitrix sent a reply the CRM could not read.',
    roles: ['Admin'],
    actor: 'An admin',
    repair: 'Press Retry once. If it happens again, send the Bitrix deal number to the CRM team.',
  },
  internal_error: {
    sentence: 'The CRM hit an internal error while copying this deal. Details are in the server log.',
    roles: ['Admin'],
    actor: 'An admin, with the CRM team',
    repair: 'Send the Bitrix deal number to the CRM team and retry after they fix it.',
  },
};

/**
 * A code this page does not know (the database may be newer than the app):
 * neutral text instead of a crash, and an admin asks before retrying.
 */
export const UNKNOWN_REASON_COPY: ProblemCopy = {
  sentence: 'The CRM recorded a reason this version of the page does not describe yet.',
  roles: ['Admin'],
  actor: 'An admin, with the CRM team',
  repair: 'Ask the CRM team what this reason means before pressing Retry.',
};
export const UNKNOWN_ERROR_COPY: ProblemCopy = {
  sentence: 'The CRM recorded an error this version of the page does not describe yet.',
  roles: ['Admin'],
  actor: 'An admin, with the CRM team',
  repair: 'Ask the CRM team what this error means before pressing Retry.',
};

/** Copy for a stored reason code; unknown codes get UNKNOWN_REASON_COPY. */
export function reasonCopyFor(code: string): ProblemCopy {
  return Object.prototype.hasOwnProperty.call(REASON_COPY, code) ? REASON_COPY[code as IntakeReasonCode] : UNKNOWN_REASON_COPY;
}
/** Copy for a stored error code; unknown codes get UNKNOWN_ERROR_COPY. */
export function errorCopyFor(code: string): ProblemCopy {
  return Object.prototype.hasOwnProperty.call(ERROR_COPY, code) ? ERROR_COPY[code as IntakeErrorCode] : UNKNOWN_ERROR_COPY;
}

/** One-sentence texts (kept for callers that need only the sentence). */
export const REASON_TEXT = Object.fromEntries(
  Object.entries(REASON_COPY).map(([code, copy]) => [code, copy.sentence]),
) as Record<IntakeReasonCode, string>;
export const ERROR_TEXT = Object.fromEntries(
  Object.entries(ERROR_COPY).map(([code, copy]) => [code, copy.sentence]),
) as Record<IntakeErrorCode, string>;

const STATUS_LABEL: Record<InboxStatus, string> = {
  pending: 'Waiting to process',
  processing: 'Processing now',
  processed: 'Processed',
  ignored: 'Ignored (not eligible)',
  needs_review: 'Needs review',
  failed: 'Failed, will retry automatically',
  dead_letter: 'Stopped: retries used up',
};
/** Work still open or needing a person; cumulative processed/ignored totals are not shown. */
const STATUS_ORDER: InboxStatus[] = ['pending', 'processing', 'needs_review', 'failed', 'dead_letter'];
const STATUS_TONE: Partial<Record<InboxStatus, string>> = { needs_review: 'warn', failed: 'warn', dead_letter: 'danger' };

/** Statuses integration_retry_inbox accepts. */
const RETRYABLE: ReadonlySet<InboxStatus> = new Set(['needs_review', 'failed', 'dead_letter']);

const ORIGIN_LABEL: Record<InboxOrigin, string> = {
  event: 'Bitrix event',
  reconcile: 'Missed-deal check',
  manual_retry: 'Manual retry',
};

const ENVIRONMENT_LABEL: Record<IntegrationStatusView['environment'], string> = {
  unset: 'Not set',
  test: 'Test',
  staging: 'Staging',
  operational: 'Operational',
};

const PROVIDER_ERRORS: ReadonlySet<IntakeErrorCode> = new Set([
  'provider_timeout',
  'provider_unavailable',
  'provider_rate_limited',
  'provider_auth_failed',
]);

type Tone = 'ok' | 'warn' | 'danger';
interface Health {
  /** S-25: the technical cause, shown under "Details for the CRM team". */
  detail?: string;
  tone: Tone;
  glyph: string;
  label: string;
}

/**
 * Most recent provider failure among rows that still need attention, if any.
 * A rejected credential wins over newer transient failures: it never fixes itself.
 */
function latestProviderFailure(items: InboxItemView[]): InboxItemView | null {
  let latest: InboxItemView | null = null;
  for (const item of items) {
    if (!item.lastErrorCode || !PROVIDER_ERRORS.has(item.lastErrorCode) || !item.lastErrorAt) continue;
    if (item.status !== 'failed' && item.status !== 'dead_letter') continue;
    const isAuth = item.lastErrorCode === 'provider_auth_failed';
    const latestAuth = latest?.lastErrorCode === 'provider_auth_failed';
    if (!latest || (isAuth && !latestAuth) || (isAuth === latestAuth && Date.parse(item.lastErrorAt) > Date.parse(latest.lastErrorAt ?? '')))
      latest = item;
  }
  return latest;
}

const WINDOW_MS = WORKER_HEALTH_MINUTES_PROPOSED * 60_000;

function olderThan(iso: string | null, now: number, ms: number): boolean {
  if (!iso) return false;
  const time = Date.parse(iso);
  return !Number.isNaN(time) && now - time > ms;
}

const OUTCOME_LABEL: Record<NonNullable<IntegrationStatusView['lastWorkerOutcome']>, string> = {
  ok: 'Completed',
  partial: 'Completed with some items left for later',
  provider_error: 'Failed: Bitrix could not be reached',
  internal_error: 'Failed: internal error (see server log)',
};

/**
 * Headline state. "Receiving deals" needs positive evidence (contract §12 M2):
 * a recent ok/partial worker run, no backlog older than the window, the worker
 * secret present and exactly one enabled configuration. Anything else is named.
 */
/** Settings · System health: the Bitrix updates headline in the S-25 words (no cause, no counts). */
export function integrationHealthSummary(status: IntegrationStatusView, now: number): { label: string; tone: Tone } {
  const h = integrationHealth(status, now, latestProviderFailure(status.attention));
  return { label: h.label, tone: h.tone };
}

export function integrationHealth(status: IntegrationStatusView, now: number, providerFailure: InboxItemView | null): Health {
  if (status.enabledConfigCount > 1)
    return { tone: 'danger', glyph: '✕', label: 'Not set up correctly', detail: 'More than one enabled configuration: intake is refused.' };
  if (!status.configured) return { tone: 'danger', glyph: '✕', label: 'Not set up', detail: 'Intake is not configured, so it is disabled.' };
  if (!status.workerSecretPresent) return { tone: 'danger', glyph: '✕', label: 'Background updates cannot run', detail: 'The worker secret is missing on the server.' };
  if (!status.lastWorkerRunAt) return { tone: 'danger', glyph: '✕', label: 'Background updates have never run', detail: 'No worker run is recorded.' };
  if (olderThan(status.lastWorkerRunAt, now, WINDOW_MS))
    return { tone: 'danger', glyph: '◷', label: 'Background updates stopped', detail: `No worker run since ${formatIst(status.lastWorkerRunAt)}.` };
  if (providerFailure?.lastErrorCode === 'provider_auth_failed')
    return { tone: 'danger', glyph: '!', label: 'Bitrix refused the CRM’s login', detail: 'Bitrix rejected the inbound webhook credential (provider_auth_failed).' };
  if (status.lastWorkerOutcome === 'provider_error' || providerFailure)
    return { tone: 'danger', glyph: '!', label: 'Bitrix not responding', detail: 'The last worker run or a deal read could not reach Bitrix.' };
  if (status.lastWorkerOutcome !== 'ok' && status.lastWorkerOutcome !== 'partial')
    return { tone: 'danger', glyph: '!', label: 'Last update failed', detail: 'The last worker run did not complete.' };
  if (status.oldestPendingAt && olderThan(status.oldestPendingAt, now, WINDOW_MS))
    return { tone: 'warn', glyph: '◷', label: `Updates delayed since ${formatIst(status.oldestPendingAt)}`, detail: 'Bitrix events are waiting longer than the worker window.' };
  // Never "Receiving deals" while runs of the last 24 hours failed.
  const problems = runProblems24h(status.autoSync);
  if (problems && problems.failedRuns > 0)
    return { tone: 'warn', glyph: '!', label: `${problems.failedRuns} ${problems.failedRuns === 1 ? 'update' : 'updates'} failed today`, detail: `${problems.failedRuns} failed sync run(s) in the last 24 hours.` };
  return { tone: 'ok', glyph: '✓', label: 'Receiving deals' };
}

function StatusPill({ health }: { health: Health }) {
  return (
    <span className={`status-pill ${health.tone}`}>
      <span aria-hidden="true" className="status-glyph">
        {health.glyph}
      </span>
      {health.label}
    </span>
  );
}

function Check({ ok, children, detail }: { ok: boolean; children: ReactNode; detail: string }) {
  return (
    <li className={ok ? 'check-ok' : 'check-missing'}>
      <span aria-hidden="true" className="status-glyph">
        {ok ? '✓' : '✕'}
      </span>
      <span>
        <strong>{children}: </strong>
        {detail}
      </span>
    </li>
  );
}

function HealthChecklist({ status, now }: { status: IntegrationStatusView; now: number }) {
  const hasConfigRow = status.portalDomain !== null || status.enabledConfigCount > 0;
  const envSet = status.environment !== 'unset';
  const switchedOn = status.configured
    ? 'Yes'
    : status.enabledConfigCount > 1
      ? `No. ${status.enabledConfigCount} configurations are enabled; exactly one is allowed`
      : !hasConfigRow
        ? 'No. There is no intake configuration yet'
        : !envSet
          ? 'No. The environment is not set'
          : 'No. The intake configuration is switched off';
  const workerRecent = status.lastWorkerRunAt !== null && !olderThan(status.lastWorkerRunAt, now, WINDOW_MS);
  const workerOk = workerRecent && (status.lastWorkerOutcome === 'ok' || status.lastWorkerOutcome === 'partial');
  const workerDetail = !status.lastWorkerRunAt
    ? 'Never. Background updates are not running yet'
    : `${formatIst(status.lastWorkerRunAt)}, ${status.lastWorkerOutcome ? OUTCOME_LABEL[status.lastWorkerOutcome] : 'outcome not recorded'}${
        workerRecent ? '' : ` (more than ${WORKER_HEALTH_MINUTES_PROPOSED} minutes ago)`
      }`;
  const backlogOld = olderThan(status.oldestPendingAt, now, WINDOW_MS);
  const backlogDetail = !status.oldestPendingAt
    ? 'Nothing waiting'
    : `Oldest waiting item received ${formatIst(status.oldestPendingAt)}${
        backlogOld ? ` (more than ${WORKER_HEALTH_MINUTES_PROPOSED} minutes)` : ''
      }`;
  return (
    <ul className="checklist" aria-label="Intake health checks">
      <Check ok={status.credentialPresent} detail={status.credentialPresent ? 'Present on the server' : 'Missing on the server'}>
        Bitrix credential
      </Check>
      <Check ok={hasConfigRow} detail={hasConfigRow ? 'Present' : 'Missing (portal, pipeline, stages, cutoff, pilot branch)'}>
        Intake configuration
      </Check>
      <Check ok={envSet} detail={envSet ? ENVIRONMENT_LABEL[status.environment] : 'Not set'}>
        Deployment environment
      </Check>
      <Check ok={status.configured && status.enabledConfigCount === 1} detail={switchedOn}>
        Intake switched on
      </Check>
      <Check ok={status.workerSecretPresent} detail={status.workerSecretPresent ? 'Present on the server' : 'Missing on the server'}>
        Background update setting
      </Check>
      <Check ok={workerOk} detail={workerDetail}>
        Last background update
      </Check>
      <Check ok={!backlogOld} detail={backlogDetail}>
        Backlog
      </Check>
    </ul>
  );
}

const SYNC_OUTCOME_TEXT: Record<NonNullable<IntegrationStatusView['lastSyncOutcome']>, string> = {
  ok: 'Bitrix was read successfully.',
  partial: 'Bitrix was read, but more changes were waiting; the next run continues.',
  provider_error: 'Bitrix could not be reached. Queued deals are kept and the next run tries again.',
  internal_error: 'The CRM hit an internal error while syncing (see server log). The next run tries again.',
};

/** "Auto sync running · last run 12 s ago" or "⚠ Auto sync stopped since 13:21 — reason". */
function AutoSyncLine({ status, now }: { status: IntegrationStatusView; now: number }) {
  const state = autoSyncState(status.autoSync, now);
  if (state.kind === 'unknown') return null;
  if (state.kind === 'paused') {
    return (
      <p className="message info" role="status">
        Auto sync is paused. Turn it on under Sync settings.
      </p>
    );
  }
  if (state.kind === 'running') {
    return (
      <p className="message success" role="status">
        <span aria-hidden="true">✓ </span>Auto sync running · last run {state.lastRunSecondsAgo} s ago
      </p>
    );
  }
  return (
    <p className="message error" role="alert">
      <strong>
        <span aria-hidden="true">⚠ </span>Auto sync stopped{state.since ? ` since ${formatIst(state.since)}` : ''}
      </strong>{' '}
      — {state.reason} &quot;Check Bitrix now&quot; still works.
    </p>
  );
}

/** Failed and partial runs of the last 24 hours, in plain words; nothing when every run was clean. */
export function RunProblemsLine({ status }: { status: IntegrationStatusView }) {
  const problems = runProblems24h(status.autoSync);
  if (!problems) return null;
  const items =
    problems.itemsFailed + problems.itemsDeadLettered > 0
      ? ` Those runs could not confirm ${problems.itemsFailed + problems.itemsDeadLettered} item(s) as saved; any that were not saved are tried again automatically${
          problems.itemsDeadLettered > 0 ? `, except ${problems.itemsDeadLettered} stopped for good (see "Needs attention")` : ''
        }.`
      : '';
  if (problems.failedRuns > 0) {
    return (
      <p className="message error" role="alert">
        <strong>
          <span aria-hidden="true">⚠ </span>
          {problems.failedRuns} sync run(s) failed in the last 24 hours
        </strong>
        {problems.lastFailedAt ? ` (last at ${formatIst(problems.lastFailedAt)})` : ''}.
        {problems.partialRuns > 0 ? ` ${problems.partialRuns} more finished only part of their work.` : ''}
        {items}
      </p>
    );
  }
  if (problems.partialRuns > 0) {
    return (
      <p className="hint" role="status">
        {problems.partialRuns} sync run(s) in the last 24 hours finished only part of their work; the next run continues.
        {items}
      </p>
    );
  }
  return null;
}

/** Bitrix count for the current settings vs the available deals. */
function bitrixComparison(status: IntegrationStatusView): { text: string; ok: boolean } | null {
  const available = status.crmDeals;
  const last = status.fullCheck?.last;
  const fromCheck = last && last.matchesSettings ? last.bitrix : null;
  const bitrix = status.bitrixNow ?? fromCheck;
  if (available === undefined || bitrix === null || bitrix === undefined) return null;
  const kept = status.keptOutsideStages ?? 0;
  const diff = available - kept - bitrix;
  return diff === 0 ? { text: `${bitrix} ✓`, ok: true } : { text: `${bitrix} (difference ${diff > 0 ? '+' : ''}${diff})`, ok: false };
}

/** Automatic sync summary: status, available deals vs Bitrix, waiting items, problems in plain words. */
function SyncAtAGlance({
  status,
  now,
  emailAlertsConfigured,
}: {
  status: IntegrationStatusView;
  now: number;
  emailAlertsConfigured?: boolean;
}) {
  const waiting = (status.counts.pending ?? 0) + (status.counts.processing ?? 0) + (status.counts.failed ?? 0);
  const problems = (status.counts.needs_review ?? 0) + (status.counts.dead_letter ?? 0);
  const compare = bitrixComparison(status);
  const kept = status.keptOutsideStages ?? 0;
  return (
    <section className="mt-1" aria-label="Deals in the CRM and in Bitrix">
      <AutoSyncLine status={status} now={now} />
      <RunProblemsLine status={status} />
      {emailAlertsConfigured === false ? (
        <p className="hint" role="note">
          Email alerts are off: problems show only on this page.
        </p>
      ) : null}
      <dl className="stat-grid" aria-label="Automatic sync">
        <div className="stat">
          <dt>Available deals</dt>
          <dd>{status.crmDeals ?? '—'}</dd>
        </div>
        <div className="stat">
          <dt>Bitrix (current settings)</dt>
          <dd>{compare ? compare.text : 'not readable'}</dd>
        </div>
        <div className="stat">
          <dt>Waiting to sync</dt>
          <dd>{waiting}</dd>
        </div>
        <div className="stat">
          <dt>Need attention</dt>
          <dd>{problems}</dd>
        </div>
      </dl>
      <p className="hint mb-0" role="status">
        Deals in the CRM: {status.crmDeals ?? '—'} (same as the Deals page).
      </p>
      <details>
        <summary>Why?</summary>
        <p className="hint mb-0">
        Deals in the CRM are the deals here now, after the start date, pipelines and stages.
        {kept > 0 ? ` It includes ${kept} deal(s) that moved in Bitrix to an unticked stage after import (kept by design).` : ''}{' '}
        {status.lastRun
          ? `Last run: ${status.lastRun.fetched} fetched, ${status.lastRun.created} new, ${status.lastRun.updated} updated (${formatIst(status.lastRun.at)}).`
          : ''}{' '}
        {status.lastSyncOutcome ? SYNC_OUTCOME_TEXT[status.lastSyncOutcome] : 'No sync has run yet.'}{' '}
        {problems > 0 ? `${problems} deal(s) could not be saved; each one is explained under "Needs attention".` : ''}
        </p>
      </details>
    </section>
  );
}

const CHECK_REASON: Record<NonNullable<FullCheckView['running']>['reason'], string> = {
  settings_changed: 'after the sync settings were saved',
  manual: 'requested with Check Bitrix now',
  daily: 'daily check',
};

/** Bitrix vs CRM: progress of the full resync and the result of the last complete one. */
function FullCheck({ check, crmDeals }: { check: FullCheckView | null | undefined; crmDeals: number | undefined }) {
  const running = check?.running ?? null;
  const last = check?.last ?? null;
  return (
    <div className="action-block" aria-labelledby="full-check-heading">
      <h3 id="full-check-heading">Bitrix and CRM counts</h3>
      {running ? (
        <p className="message info" role="status">
          {running.listingDone
            ? `Full sync in progress (${CHECK_REASON[running.reason]}): all ${running.scanned} Bitrix deals listed, saving the last ones.`
            : `Full sync in progress (${CHECK_REASON[running.reason]}): ${running.scanned}${
                running.bitrixTotal !== null ? ` of ${running.bitrixTotal}` : ''
              } Bitrix deals checked. It continues automatically every 30 seconds.`}
        </p>
      ) : null}
      {last ? (
        <p className={last.inSync ? 'mb-0' : 'message error'} role="status">
          <strong>
            Bitrix: {last.bitrix} · CRM: {last.crm - last.keptAfterStageMove}
            {last.inSync ? ' · ✓ in sync' : ' · not in sync'}
          </strong>{' '}
          (full check {formatIst(last.finishedAt)}).
          {last.keptAfterStageMove > 0
            ? ` The CRM also keeps ${last.keptAfterStageMove} deal(s) that moved in Bitrix to a stage that is not ticked (kept by design).`
            : ''}
          {last.missing > 0 ? ` ${last.missing} Bitrix deal(s) are not in the CRM yet; see "Needs attention" below.` : ''}
          {last.extra > 0
            ? ` ${last.extra} CRM deal(s) were not listed by Bitrix (deleted there, or moved); they were read again and any that cannot be saved are listed below.`
            : ''}
        </p>
      ) : running ? null : (
        <p className="mb-0">No full check has run yet. It runs automatically once a day and after the settings change.</p>
      )}
      {crmDeals !== undefined ? (
        <p className="hint mb-0">
          Available deals now: <strong>{crmDeals}</strong> (the same number as the Deals page).
        </p>
      ) : null}
    </div>
  );
}

/** The copy that leads a row: the provider error for failed rows, otherwise the reason. */
export function primaryCopy(item: InboxItemView): ProblemCopy | null {
  const fromError = item.lastErrorCode ? errorCopyFor(item.lastErrorCode) : null;
  const fromReason = item.reasonCode ? reasonCopyFor(item.reasonCode) : null;
  const base = (item.status === 'failed' || item.status === 'dead_letter' ? fromError ?? fromReason : fromReason ?? fromError) ?? null;
  if (!base) return null;
  // Retries used up: nothing happens on its own any more, so an admin always acts.
  if (item.status === 'dead_letter' && base.roles.length === 0) {
    return { ...base, roles: ['Admin'], actor: 'An admin', repair: `Check that Bitrix is up, then press Retry.` };
  }
  return copyForObject(base, item.sourceObject);
}

function AttentionReason({ item }: { item: InboxItemView }) {
  const copy = primaryCopy(item);
  const reason = item.reasonCode ? copyForObject(reasonCopyFor(item.reasonCode), item.sourceObject) : null;
  const error = item.lastErrorCode ? copyForObject(errorCopyFor(item.lastErrorCode), item.sourceObject) : null;
  const secondary = reason && error ? (copy?.sentence === reason.sentence ? error.sentence : reason.sentence) : null;
  if (!copy) return <p className="mb-0">No reason was recorded. An admin checks the server log, then presses Retry.</p>;
  return (
    <>
      <p className="mb-0 problem-sentence">{copy.sentence}</p>
      {secondary ? <p className="mb-0">{secondary}</p> : null}
      {item.status === 'dead_letter' ? (
        <p className="mb-0">Retries are used up; it will not be tried again on its own.</p>
      ) : null}
      <ProblemNextLine copy={copy} />
      {item.lastErrorAt ? <p className="hint mb-0">Last error: {formatIst(item.lastErrorAt)}</p> : null}
      {item.status === 'failed' && item.nextAttemptAt ? (
        <p className="hint mb-0">Next automatic try: {formatIst(item.nextAttemptAt)}</p>
      ) : null}
    </>
  );
}

interface SyncProblem {
  key: string;
  tone: 'danger' | 'warn';
  copy: ProblemCopy;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Page-level problems, most urgent first. Empty means nothing needs a person. */
export function syncProblems(status: IntegrationStatusView, now: number): SyncProblem[] {
  const out: SyncProblem[] = [];
  const admin: HandoffRole[] = ['Admin'];
  if (status.enabledConfigCount > 1) {
    out.push({
      key: 'multiple-configs',
      tone: 'danger',
      copy: {
        sentence: `${status.enabledConfigCount} intake configurations are switched on, so every Bitrix deal is refused.`,
        roles: admin,
        actor: 'An admin',
        repair: 'Switch off all but one intake configuration on the server.',
      },
    });
  } else if (!status.configured) {
    out.push({
      key: 'not-configured',
      tone: 'danger',
      copy: {
        sentence: 'Intake is not set up or is switched off, so no Bitrix deal is copied.',
        roles: admin,
        actor: 'An admin',
        repair: 'The CRM team finishes the setup on the server. It cannot be changed from this page.',
        teamDetail: 'Finish the intake setup on the server, following the pilot runbook.',
      },
    });
  }
  if (!status.workerSecretPresent) {
    out.push({
      key: 'worker-secret',
      tone: 'danger',
      copy: {
        sentence: 'Background updates cannot run: a server setting is missing.',
        roles: admin,
        actor: 'An admin',
        repair: 'The CRM team adds the missing setting on the server.',
        teamDetail: 'Add the worker secret to the server secret store.',
      },
    });
  }
  if (status.configured && status.workerSecretPresent) {
    if (!status.lastWorkerRunAt || olderThan(status.lastWorkerRunAt, now, WINDOW_MS)) {
      out.push({
        key: 'worker-down',
        tone: 'danger',
        copy: {
          sentence: status.lastWorkerRunAt
            ? `Background updates have not run since ${formatIst(status.lastWorkerRunAt)}, so new Bitrix deals wait and are not copied.`
            : 'Background updates have never run, so new Bitrix deals wait and are not copied.',
          roles: admin,
          actor: 'An admin',
          repair: `The CRM team restarts background updates; this page then shows an update in the last ${WORKER_HEALTH_MINUTES_PROPOSED} minutes.`,
          teamDetail: 'Start the scheduled intake worker (scheduler), then check the last worker run.',
        },
      });
    }
  }
  const stuck = status.attention.filter((i) => i.status === 'failed' || i.status === 'dead_letter');
  if (stuck.some((i) => i.lastErrorCode === 'provider_auth_failed')) {
    out.push({ key: 'auth', tone: 'danger', copy: ERROR_COPY.provider_auth_failed });
  } else if (status.lastWorkerOutcome === 'provider_error' || latestProviderFailure(status.attention)) {
    out.push({
      key: 'provider',
      tone: 'warn',
      copy: {
        sentence: 'Bitrix is not responding. Affected deals are retried automatically.',
        roles: [],
        actor: AUTOMATIC,
        repair: 'If deals stop after all retries, check that Bitrix is up, then retry them below.',
      },
    });
  }
  const dead = status.counts.dead_letter ?? 0;
  if (dead > 0) {
    out.push({
      key: 'dead-letter',
      tone: 'danger',
      copy: {
        sentence: `${plural(dead, 'deal', 'deals')} stopped after using all retries and will not be tried again on ${dead === 1 ? 'its' : 'their'} own.`,
        roles: admin,
        actor: 'An admin',
        repair: 'Fix the cause shown on each row below, then press Retry.',
      },
    });
  }
  const review = status.counts.needs_review ?? 0;
  if (review > 0) {
    out.push({
      key: 'needs-review',
      tone: 'warn',
      copy: {
        sentence: `${plural(review, 'deal needs', 'deals need')} a person to fix something before ${review === 1 ? 'it' : 'they'} can be copied.`,
        roles: admin,
        actor: 'An admin',
        repair: 'Read each row below, fix the cause, then press Retry.',
      },
    });
  }
  const failed = status.counts.failed ?? 0;
  if (failed > 0) {
    out.push({
      key: 'failed',
      tone: 'warn',
      copy: {
        sentence: `${plural(failed, 'deal', 'deals')} failed and will be retried automatically.`,
        roles: [],
        actor: AUTOMATIC,
        repair: 'Nothing to do yet. Rows that run out of retries need an admin.',
      },
    });
  }
  return out;
}

/** Phase 6: with an import list the inbox holds Leads and Deals, so page-level problems say "record". */
function asRecords(problem: SyncProblem): SyncProblem {
  const swap = (text: string) => text.replace(/\bdeals\b/g, 'records').replace(/\bdeal\b/g, 'record');
  const { copy } = problem;
  return { ...problem, copy: { ...copy, sentence: swap(copy.sentence), repair: swap(copy.repair) } };
}

function SyncProblemList({ problems }: { problems: SyncProblem[] }) {
  return (
    <section className="panel" aria-labelledby="problems-heading">
      <h2 id="problems-heading">What needs fixing</h2>
      {problems.length === 0 ? (
        <p className="mb-0" role="status">
          <span aria-hidden="true" className="status-glyph problem-ok-glyph">
            ✓
          </span>{' '}
          No sync problems right now. Nobody needs to act.
        </p>
      ) : (
        <ul className="problem-list">
          {problems.map((p) => (
            <li key={p.key} className={`problem problem-${p.tone}`}>
              <span aria-hidden="true" className="problem-glyph">
                {p.tone === 'danger' ? '!' : '◷'}
              </span>
              <div className="problem-body">
                <p className="problem-title">
                  <span className="visually-hidden">{p.tone === 'danger' ? 'Problem: ' : 'Warning: '}</span>
                  {p.copy.sentence}
                </p>
                <ProblemNextLine copy={p.copy} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function IntegrationNoPermissionView() {
  return (
    <>
      <SettingsSectionHeading>Bitrix connection</SettingsSectionHeading>
      <p role="status">Only staff who manage the Bitrix connection, and who hold no Purchase role, can open this page.</p>
    </>
  );
}

function WaitingForOwner({ status, users }: { status: IntegrationStatusView; users: BitrixUser[] | null }) {
  const total = status.waitingForOwner ?? 0;
  const names = new Map((users ?? []).map((u) => [u.id, u]));
  return (
    <section className="panel" aria-labelledby="waiting-heading">
      <h2 id="waiting-heading">Deals waiting for an owner</h2>
      {total === 0 ? (
        <p role="status" className="mb-0">
          None. Every stored Bitrix deal has a CRM owner.
        </p>
      ) : (
        <>
          <p>
            {total} {total === 1 ? 'deal has' : 'deals have'} no CRM owner. Link their Bitrix user on the <a href="/app/admin/staff">Staff page</a>.
          </p>
          <p className="hint">Only administrators see these deals. Once the person is linked, their deals move to them at once.</p>
          <div className="table-scroll">
            <table>
              <caption>Waiting deals by Bitrix responsible</caption>
              <thead>
                <tr>
                  <th scope="col">Bitrix user</th>
                  <th scope="col">Deals waiting</th>
                </tr>
              </thead>
              <tbody>
                {(status.waitingByBitrixUser ?? []).map((w) => {
                  const u = names.get(w.bitrixUserId);
                  return (
                    <tr key={w.bitrixUserId}>
                      <td>
                        {u ? u.name : `Bitrix user #${w.bitrixUserId}`}
                        {u?.email ? <span className="hint"> {u.email}</span> : null}
                        {u && !u.active ? <span className="hint"> (inactive in Bitrix)</span> : null}
                      </td>
                      <td>{w.deals}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/*
 * Phase 6: owner-approved intake scope (contract §2.3). Layout adapted from the
 * 21st.dev "API Usage Meter Card" (19006: labelled meter against a shared limit)
 * for expected vs imported, and "Data Refresh State" (29369: state pill with a
 * distinct glyph plus words, last-updated fact). Rebuilt with a native <progress>
 * (no inline styles under the production CSP) and a counts list in words.
 * See docs/implementation/phase-6/design/21st-dev-log.md.
 */

/** Counts for the records on one import list. Excluded records are not on the list and never count towards it. */
export interface IntakeScopeCounts {
  /** List records with a CRM row (created or updated). */
  imported: number;
  /** List records whose inbox row is needs_review (e.g. unmapped owner, outside_manifest_scope). */
  heldForReview: number;
  /** List records whose inbox row is failed or dead_letter. */
  failed: number;
  /** Inbox rows ignored with not_in_manifest while this list was active (records outside the list). */
  excluded: number;
}

/** One owner-approved import list (manifest). Never carries the record ids themselves. */
export interface IntakeManifestSummary {
  status: 'active' | 'closed';
  sourceObject: SourceObject;
  /** Verified Bitrix SOURCE_ID, e.g. WEBFORM. */
  sourceCode: string;
  /** Verified portal label for sourceCode (e.g. "CRM form"); null shows the raw code. */
  sourceCodeLabel: string | null;
  /** Frozen business date, YYYY-MM-DD in Asia/Kolkata. */
  businessDate: string;
  /** Half-open creation interval on the Bitrix record, ISO timestamps. */
  intervalFrom: string;
  intervalTo: string;
  expectedCount: number;
  /** Operator label recorded by integration_manifest_create (no secret, no email). */
  createdByOperator: string;
  createdAt: string;
  closedAt: string | null;
  counts: IntakeScopeCounts;
}

/** Scope panel input. `manifest` null means no list exists for the enabled configuration: nothing is imported. */
export interface IntakeScopeView {
  manifest: IntakeManifestSummary | null;
  /** Last processed inbox row for this list's source object (null = never). */
  lastSuccessfulSyncAt: string | null;
}

const OBJECT_PLURAL: Record<SourceObject, string> = { lead: 'Leads', deal: 'Deals' };

/** "CRM form (WEBFORM)" when the label is verified, otherwise "Bitrix source WEBFORM". */
export function sourceCodeText(code: string, label: string | null | undefined): string {
  const verified = label?.trim();
  return verified ? `${verified} (${code})` : `Bitrix source ${code}`;
}

const DATE_ONLY = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' });
function formatBusinessDate(date: string): string {
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(time) ? date : DATE_ONLY.format(time);
}

interface ScopeState extends Health {
  copy: ProblemCopy;
}

/** Headline state of the import list, most serious first. Never reads as healthy while records failed or wait. */
export function intakeScopeState(scope: IntakeScopeView, configured: boolean, now: number): ScopeState {
  const admin: HandoffRole[] = ['Admin'];
  const m = scope.manifest;
  if (!m) {
    return {
      tone: 'warn',
      glyph: '■',
      label: 'No approved import list: nothing is imported',
      copy: {
        sentence: 'There is no approved import list, so no Bitrix record is copied, even if intake is switched on.',
        roles: admin,
        actor: 'An admin, after the owner approves the records',
        repair: 'The CRM team prepares the list of records to bring in, and the owner approves it.',
        teamDetail: 'Run the selection script, get the owner’s approval, then create the list with the manifest command (intake runbook).',
      },
    };
  }
  const plural = OBJECT_PLURAL[m.sourceObject].toLowerCase();
  if (m.status === 'closed') {
    return {
      tone: 'warn',
      glyph: '■',
      label: 'Import list closed: nothing more is imported',
      copy: {
        sentence: `The import list was closed${m.closedAt ? ` on ${formatIst(m.closedAt)}` : ''}. No further Bitrix ${plural} are copied. ${OBJECT_PLURAL[m.sourceObject]} already imported stay.`,
        roles: [],
        actor: NOBODY,
        repair: 'To import more, the owner approves a new list and the CRM team creates it.',
        teamDetail: 'Create the list with the manifest command (intake runbook).',
      },
    };
  }
  const { imported, heldForReview, failed } = m.counts;
  if (!configured) {
    return {
      tone: 'danger',
      glyph: '✕',
      label: 'List active, but intake is switched off',
      copy: {
        sentence: `The import list is active, but intake is switched off or not allowed in this environment, so no ${plural} are copied.`,
        roles: admin,
        actor: 'An admin',
        repair: 'If intake was stopped on purpose, close the list too. Otherwise fix what “What needs fixing” lists.',
      },
    };
  }
  if (failed > 0) {
    return {
      tone: 'danger',
      glyph: '!',
      label: `${failed} of ${m.expectedCount} failed`,
      copy: {
        sentence: `${failed} of ${m.expectedCount} approved ${plural} failed to copy.`,
        roles: admin,
        actor: 'An admin',
        repair: 'Read each failed row under “Needs attention”, fix the cause, then press Retry.',
      },
    };
  }
  if (heldForReview > 0) {
    return {
      tone: 'warn',
      glyph: '◷',
      label: `${heldForReview} held for review`,
      copy: {
        sentence: `${heldForReview} of ${m.expectedCount} approved ${plural} are held for review and not copied yet.`,
        roles: admin,
        actor: 'An admin',
        repair: 'Read each held row under “Needs attention”, fix the cause, then press Retry.',
      },
    };
  }
  if (imported >= m.expectedCount) {
    return {
      tone: 'ok',
      glyph: '✓',
      label: `All ${m.expectedCount} imported`,
      copy: {
        sentence: `All ${m.expectedCount} approved ${plural} are in the CRM.`,
        roles: admin,
        actor: 'An admin',
        repair: 'The CRM team checks the match, then closes the list when the owner says so.',
        teamDetail: 'Run the comparator with the manifest file to confirm the match, then close the list when the owner says so.',
      },
    };
  }
  const stale = !scope.lastSuccessfulSyncAt || olderThan(scope.lastSuccessfulSyncAt, now, STALE_SYNC_HOURS_PROPOSED * 3_600_000);
  if (stale) {
    return {
      tone: 'warn',
      glyph: '◷',
      label: scope.lastSuccessfulSyncAt ? `No successful sync for over ${STALE_SYNC_HOURS_PROPOSED} hours` : 'No successful sync yet',
      copy: {
        sentence: `${m.expectedCount - imported} approved ${plural} are not in the CRM yet and nothing was copied ${
          scope.lastSuccessfulSyncAt ? `since ${formatIst(scope.lastSuccessfulSyncAt)}` : 'so far'
        }.`,
        roles: admin,
        actor: 'An admin',
        repair: 'Check that background updates run, then press “Check Bitrix now” to fetch the listed records.',
      },
    };
  }
  return {
    tone: 'ok',
    glyph: '…',
    label: `Importing: ${imported} of ${m.expectedCount}`,
    copy: {
      sentence: `${imported} of ${m.expectedCount} approved ${plural} are in the CRM; the rest are on their way.`,
      roles: [],
      actor: AUTOMATIC,
      repair: 'Nothing to do unless this stays the same for a day.',
    },
  };
}

function IntakeScopePanel({ scope, configured, now }: { scope: IntakeScopeView; configured: boolean; now: number }) {
  const state = intakeScopeState(scope, configured, now);
  const m = scope.manifest;
  const notYet = m ? Math.max(0, m.expectedCount - m.counts.imported - m.counts.heldForReview - m.counts.failed) : 0;
  const plural = m ? OBJECT_PLURAL[m.sourceObject] : 'Records';
  return (
    <section className="panel scope-panel" aria-labelledby="scope-heading">
      <div className="panel-header">
        <h2 id="scope-heading" className="mb-0">
          Approved import list
        </h2>
        <StatusPill health={state} />
      </div>
      <p>
        Only Bitrix records on the owner-approved list are copied. Records outside it stay in Bitrix only. This page
        cannot create, widen or close the list.
      </p>

      {m ? (
        <>
          <dl className="facts">
            <dt>List</dt>
            <dd>{m.status === 'active' ? 'Active' : `Closed${m.closedAt ? ` on ${formatIst(m.closedAt)}` : ''}`}</dd>
            <dt>Bitrix records</dt>
            <dd>{plural} only</dd>
            <dt>Source</dt>
            <dd>{sourceCodeText(m.sourceCode, m.sourceCodeLabel)}</dd>
            <dt>Business date</dt>
            <dd>{formatBusinessDate(m.businessDate)} (India time)</dd>
            <dt>Created in Bitrix</dt>
            <dd>
              From {formatIst(m.intervalFrom)} up to, not including, {formatIst(m.intervalTo)}
            </dd>
            <dt>Last successful sync</dt>
            <dd>{scope.lastSuccessfulSyncAt ? formatIst(scope.lastSuccessfulSyncAt) : 'Nothing copied yet'}</dd>
            <dt>List created</dt>
            <dd>
              {formatIst(m.createdAt)} by {m.createdByOperator}
            </dd>
          </dl>

          <div className="scope-meter">
            <label htmlFor="scope-progress" className="scope-meter-label">
              <span>Imported</span>
              <span>
                {m.counts.imported} of {m.expectedCount} approved
              </span>
            </label>
            <progress id="scope-progress" max={Math.max(m.expectedCount, 1)} value={Math.min(m.counts.imported, m.expectedCount)}>
              {m.counts.imported} of {m.expectedCount}
            </progress>
          </div>
          <dl className="stat-grid scope-counts" aria-label="Approved list counts">
            <div className="stat">
              <dt>Expected (on the list)</dt>
              <dd>{m.expectedCount}</dd>
            </div>
            <div className="stat stat-ok">
              <dt>Imported</dt>
              <dd>{m.counts.imported}</dd>
            </div>
            <div className={`stat${m.counts.heldForReview > 0 ? ' stat-warn' : ''}`}>
              <dt>Held for review</dt>
              <dd>{m.counts.heldForReview}</dd>
            </div>
            <div className={`stat${m.counts.failed > 0 ? ' stat-danger' : ''}`}>
              <dt>Failed</dt>
              <dd>{m.counts.failed}</dd>
            </div>
            <div className="stat">
              <dt>Not arrived yet</dt>
              <dd>{notYet}</dd>
            </div>
            <div className="stat">
              <dt>Excluded (not on the list)</dt>
              <dd>{m.counts.excluded}</dd>
            </div>
          </dl>
          <p className="hint">Excluded records are not part of the expected total. They were acknowledged and not copied.</p>
        </>
      ) : null}

      <div className={`note ${state.tone === 'danger' ? 'danger' : state.tone === 'ok' ? 'info' : 'warn'}`} role="note">
        <p className="mb-0">
          <strong>{state.copy.sentence}</strong>
        </p>
        <ProblemNextLine copy={state.copy} />
      </div>

      {m?.status === 'active' ? (
        <div className="action-block">
          <h3>How to stop intake</h3>
          <p>Either step stops every further CRM write. The CRM team does it on the server; this page cannot.</p>
          <ol className="stop-steps">
            <li>
              <strong>Close the import list.</strong> The CRM team closes it on the server. New Bitrix events are then
              acknowledged and not copied.
              <details>
                <summary>Details for the CRM team</summary>
                <p className="mb-0">Run the manifest close command (intake runbook, “Stop intake”).</p>
              </details>
            </li>
            <li>
              <strong>Or switch off the intake configuration</strong> on the server. Every intake path then refuses.
            </li>
          </ol>
          <p className="hint mb-0">
            {plural} already imported stay in the CRM. Nothing is deleted and nothing is written back to Bitrix.
          </p>
        </div>
      ) : null}
    </section>
  );
}

/** The import-list read was refused or failed. Says so plainly; never implies no list or a healthy list. */
function IntakeScopeUnavailable() {
  return (
    <section className="panel scope-panel" aria-labelledby="scope-heading">
      <div className="panel-header">
        <h2 id="scope-heading" className="mb-0">
          Approved import list
        </h2>
        <span className="status-pill warn">
          <span aria-hidden="true" className="status-glyph">
            !
          </span>
          Could not be read
        </span>
      </div>
      <div className="note warn" role="note">
        <p className="mb-0">
          The CRM could not read the approved import list just now, so this page cannot say which leads are expected or
          copied. Lead intake itself is not changed by this.
        </p>
        <ProblemNextLine
          copy={{ sentence: '', roles: ['Admin'], actor: 'An admin', repair: 'Reload this page. If the list still cannot be read, check that your admin access is active in the company that owns the Bitrix connection.' }}
        />
      </div>
    </section>
  );
}

export function IntegrationAdminView({
  status,
  now,
  scope,
  reconcileInitialState,
  retryInitialState,
  pipelines = null,
  bitrixUsers = null,
  directoryError = null,
  emailAlertsConfigured,
  switches,
  switchActions,
  sync,
  children,
}: {
  /** Batch 4: the Bitrix switches (Terra bitrixPageModel(...).switches); Bitrix names keeps its own card (children). */
  switches?: SettingsSectionModel;
  switchActions?: SettingSwitchActions;
  /**
   * Batch 4 (M1, DA-259): which deals come in from Bitrix, preview then apply.
   * Without it the section says the not-installed line; the old one-step form is never offered.
   */
  sync?: { model: SyncStateModel | null; text: string | null } & SyncScopeActions;
  /** Cards after the switches: Bitrix names, ID-proof copies, Bring in deals only when won (lead ruling D3). */
  children?: ReactNode;
  /**
   * Sync completion §4: whether sync-stopped emails can be sent (sender settings present).
   * false shows "Email alerts are not set up"; omitted (previews) shows nothing.
   */
  emailAlertsConfigured?: boolean;
  /** Bitrix pipelines/stages for the settings form (null = unavailable). */
  pipelines?: BitrixPipeline[] | null;
  bitrixUsers?: BitrixUser[] | null;
  directoryError?: string | null;
  status: IntegrationStatusView;
  /**
   * Phase 6: approved import list and its progress. null: the import-list read was refused or
   * failed, shown as "could not be read" (never as a healthy or empty list). Omitted: no panel.
   */
  scope?: IntakeScopeView | null;
  /** Server render time (ms), used only for the health/stale checks. */
  now: number;
  /** Preview gallery only. */
  reconcileInitialState?: FormState;
  /** Preview gallery only: applied to the first attention row. */
  retryInitialState?: FormState;
}) {
  const providerFailure = latestProviderFailure(status.attention);
  const health = integrationHealth(status, now, providerFailure);
  const quiet = health.tone === 'ok' && olderThan(status.lastProcessedAt, now, STALE_SYNC_HOURS_PROPOSED * 3_600_000);

  return (
    <>
      <SettingsSectionHeading
        description="New eligible deals created in Bitrix come into this CRM. Bitrix stays the owner of title, stage and salesperson. Nothing is written back to Bitrix and no amounts are brought in."
      >
        Bitrix connection
      </SettingsSectionHeading>

      {scope ? <p>Leads from Bitrix come in only when they are on the approved import list below; they are never stored as deals.</p> : null}

      {/* With Phase 6 scope wired (even when unreadable) the inbox can hold Leads and Deals: say "records". */}
      <SyncProblemList problems={scope !== undefined ? syncProblems(status, now).map(asRecords) : syncProblems(status, now)} />

      {scope ? <IntakeScopePanel scope={scope} configured={status.configured} now={now} /> : null}
      {scope === null ? <IntakeScopeUnavailable /> : null}

      <section className="panel" aria-labelledby="sync-status-heading">
        <div className="panel-header">
          <h2 id="sync-status-heading" className="mb-0">
            Connection
          </h2>
          <StatusPill health={health} />
        </div>
        {health.detail ? (
          <details>
            <summary>Details for the CRM team</summary>
            <p className="mb-0">{health.detail}</p>
          </details>
        ) : null}

        {providerFailure ? (
          <div className="message error" role="alert">
            <strong>Error: </strong>
            {errorCopyFor(providerFailure.lastErrorCode!).sentence} Last failure at {formatIst(providerFailure.lastErrorAt!)}.
            {providerFailure.lastErrorCode === 'provider_auth_failed'
              ? 'Retries keep failing until an admin replaces the credential; see What needs fixing above.'
              : 'Affected deals are retried automatically; those that run out of retries are listed below.'}
          </div>
        ) : null}
        {quiet ? (
          <p className="message info" role="status">
            The worker is running, but no Bitrix deal has been processed for over {STALE_SYNC_HOURS_PROPOSED} hours. If
            deals were created in Bitrix since then, check for missed deals.
          </p>
        ) : null}

        {!status.configured ? (
          <p>
            Bitrix events are refused and no deals are created until intake is configured. Setup is done on the server by
            an administrator; it cannot be changed from this page.
          </p>
        ) : health.tone !== 'ok' ? (
          <p>Deals are not confirmed to be arriving. Each check below says what is wrong.</p>
        ) : null}
        <SyncAtAGlance status={status} now={now} emailAlertsConfigured={emailAlertsConfigured} />
        <FullCheck check={status.fullCheck} crmDeals={status.crmDeals} />
        <HealthChecklist status={status} now={now} />

        <dl className="facts mt-1">
          <dt>Environment</dt>
          <dd>{ENVIRONMENT_LABEL[status.environment]}</dd>
          <dt>Bitrix portal</dt>
          <dd>{status.portalDomain ?? 'Not configured'}</dd>
          <dt>Pilot branch</dt>
          <dd>{status.pilotBranchName ?? 'Not configured'}</dd>
          <dt>Bring in deals created on or after</dt>
          <dd>
            {status.cutoffAt
              ? `${formatIst(status.cutoffAt)} (from 00:00 India time)`
              : 'Not configured'}
          </dd>
          <dt>Last deal processed</dt>
          <dd>{status.lastProcessedAt ? formatIst(status.lastProcessedAt) : 'Nothing processed yet'}</dd>
          <dt>Last background update</dt>
          <dd>
            {status.lastWorkerRunAt
              ? `${formatIst(status.lastWorkerRunAt)}: ${status.lastWorkerOutcome ? OUTCOME_LABEL[status.lastWorkerOutcome] : 'outcome not recorded'}`
              : 'Never'}
          </dd>
        </dl>

        <div className="action-block">
          <h3>Check Bitrix now</h3>
          {status.configured ? (
            <ReconcileNowForm initialState={reconcileInitialState} />
          ) : (
            <p className="mb-0">Checking Bitrix is available once the connection is set up.</p>
          )}
        </div>
      </section>

      <SyncScopeSection
        configured={status.configured}
        pipelines={pipelines}
        directoryError={directoryError}
        model={sync ? sync.model : null}
        text={sync ? sync.text : null}
        installed={!!sync}
        actions={sync ? { preview: sync.preview, apply: sync.apply } : null}
      />

      {switches ? (
        <SettingsSectionView
          id="bitrix-switches"
          title="Bitrix switches"
          description="What the CRM reads from Bitrix, and the one setting that writes to it."
          section={switches}
          actions={switchActions}
          hideKeys={['bitrix_name_read']}
        />
      ) : null}
      {children}

      <WaitingForOwner status={status} users={bitrixUsers} />

      <section className="panel" aria-labelledby="counts-heading">
        <h2 id="counts-heading">Open sync work</h2>
        <dl className="stat-grid">
          {STATUS_ORDER.map((s) => (
            <div key={s} className="stat">
              <dt>{STATUS_LABEL[s]}</dt>
              <dd>{status.counts[s] ?? 0}</dd>
            </div>
          ))}
        </dl>
      </section>

      <h2 id="attention-heading">Needs attention</h2>
      {status.attention.length === 0 ? (
        <p className="panel" role="status">
          Nothing needs attention. Deals waiting for review, failed deals and deals that ran out of retries appear here.
        </p>
      ) : (
        <table className="stack-table attention-table">
          <caption>
            {status.attention.length} {status.attention.length === 1 ? 'item needs' : 'items need'} attention
          </caption>
          <thead>
            <tr>
              <th scope="col">Bitrix record</th>
              <th scope="col">Status</th>
              <th scope="col">What happened and who fixes it</th>
              <th scope="col">Attempts</th>
              <th scope="col">Received</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {status.attention.map((item, index) => (
              <tr key={item.inboxId}>
                <td data-label="Bitrix record">
                  <strong>
                    {objectLabel(item.sourceObject)} #{item.sourceDealId}
                  </strong>
                  <br />
                  <span className="hint">{ORIGIN_LABEL[item.origin]}</span>
                </td>
                <td data-label="Status">
                  <span className={`badge ${STATUS_TONE[item.status] ?? 'neutral'}`}>{STATUS_LABEL[item.status]}</span>
                </td>
                <td data-label="What happened and who fixes it" className="reason-cell">
                  <AttentionReason item={item} />
                </td>
                <td data-label="Attempts">
                  {item.attempts} of {item.maxAttempts}
                </td>
                <td data-label="Received">{formatIst(item.receivedAt)}</td>
                <td data-label="Action">
                  {RETRYABLE.has(item.status) ? (
                    <RetryInboxItemForm
                      inboxId={item.inboxId}
                      sourceDealId={item.sourceDealId}
                      sourceObject={item.sourceObject}
                      initialState={index === 0 ? retryInitialState : undefined}
                    />
                  ) : (
                    <span className="hint">No action needed</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
