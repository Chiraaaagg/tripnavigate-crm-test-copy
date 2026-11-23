import type { ReactNode } from 'react';
import {
  type InboxItemView,
  type IntakeErrorCode,
  type IntakeReasonCode,
  type FullCheckView,
  type IntegrationStatusView,
  type SourceObject,
  WORKER_HEALTH_MINUTES_PROPOSED,
} from '@/modules/integration/contracts';
import { autoSyncState, runProblems24h } from '@/modules/integration/auto-sync-state';
import type { HandoffRole } from './handoff';
import { formatIst } from './staff-views';

/*
 * Settings · Bitrix connection, Status tab: problem words, connection health,
 * the at-a-glance lines, the full check and the technical checklist. Split
 * mechanically out of integration-views.tsx (UX redesign R1); behaviour and
 * words unchanged.
 */

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

export const NOBODY = 'Nobody. Nothing to do.';
export const AUTOMATIC = 'Nobody yet. The CRM retries on its own.';

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


export const ENVIRONMENT_LABEL: Record<IntegrationStatusView['environment'], string> = {
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

export type Tone = 'ok' | 'warn' | 'danger';
export interface Health {
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
export function latestProviderFailure(items: InboxItemView[]): InboxItemView | null {
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

export function olderThan(iso: string | null, now: number, ms: number): boolean {
  if (!iso) return false;
  const time = Date.parse(iso);
  return !Number.isNaN(time) && now - time > ms;
}

export const OUTCOME_LABEL: Record<NonNullable<IntegrationStatusView['lastWorkerOutcome']>, string> = {
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

export function StatusPill({ health }: { health: Health }) {
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

export function HealthChecklist({ status, now }: { status: IntegrationStatusView; now: number }) {
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
export function SyncAtAGlance({
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
export function FullCheck({ check, crmDeals }: { check: FullCheckView | null | undefined; crmDeals: number | undefined }) {
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
          {last.missing > 0 ? ` ${last.missing} Bitrix deal(s) are not in the CRM yet; see "Needs attention".` : ''}
          {last.extra > 0
            ? ` ${last.extra} CRM deal(s) were not listed by Bitrix (deleted there, or moved); they were read again and any that cannot be saved are listed under "Needs attention".`
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

export interface SyncProblem {
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
        repair: 'If deals stop after all retries, check that Bitrix is up, then retry them under Needs attention.',
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
        repair: 'Fix the cause shown on each row under Needs attention, then press Retry.',
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
        repair: 'Read each row under Needs attention, fix the cause, then press Retry.',
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
export function asRecords(problem: SyncProblem): SyncProblem {
  const swap = (text: string) => text.replace(/\bdeals\b/g, 'records').replace(/\bdeal\b/g, 'record');
  const { copy } = problem;
  return { ...problem, copy: { ...copy, sentence: swap(copy.sentence), repair: swap(copy.repair) } };
}

export function SyncProblemList({ problems }: { problems: SyncProblem[] }) {
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
