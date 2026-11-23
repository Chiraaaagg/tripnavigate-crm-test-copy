import type { ReactNode } from 'react';
import { Tabs } from '@/components/ui/tabs';
import type { FormState } from '@/lib/forms';
import { parseTab } from '@/lib/parse-tab';
import { STALE_SYNC_HOURS_PROPOSED, type InboxStatus, type IntegrationStatusView } from '@/modules/integration/contracts';
import type { BitrixPipeline, BitrixUser } from '@/modules/integration/bitrix/directory';
import { SETTINGS_PATH } from '@/modules/settings/contracts';
import type { SettingsSectionModel } from '@/modules/settings/rows';
import type { SyncStateModel } from '@/modules/settings/server/queries';
import { AttentionReason, ORIGIN_LABEL, RETRYABLE, STATUS_LABEL, STATUS_ORDER, STATUS_TONE, WaitingForOwner } from './integration-history';
import { ReconcileNowForm, RetryInboxItemForm } from './integration-forms';
import { IntakeScopePanel, IntakeScopeUnavailable, type IntakeScopeView } from './integration-scope';
import {
  asRecords,
  ENVIRONMENT_LABEL,
  errorCopyFor,
  FullCheck,
  HealthChecklist,
  integrationHealth,
  latestProviderFailure,
  objectLabel,
  olderThan,
  OUTCOME_LABEL,
  StatusPill,
  SyncAtAGlance,
  SyncProblemList,
  syncProblems,
} from './integration-status';
import { SettingsSectionHeading } from './settings/settings-frame';
import { SettingsSectionView, type SettingSwitchActions } from './settings/setting-rows';
import { SyncScopeSection, type SyncScopeActions } from './settings/sync-scope-form';
import { formatIst } from './staff-views';

/*
 * Settings · Bitrix connection (contract §7; UX redesign R1, prototype S5).
 * Four sub-tabs on the same address: Status (what needs fixing, the
 * connection and "Check Bitrix now"; the technical checklist behind
 * "Details"), Which deals come in (the import scope form, the Lead import
 * list and "Bring in deals only when won", shown once), Switches (the Bitrix
 * switches and their own cards) and Clean-up (open sync work, rows that need
 * a person, ID-proof copy stops, deals waiting for an owner). Every form
 * posts the same fields as before; only the layout changed.
 *
 * The parts live in integration-status.tsx, integration-scope.tsx and
 * integration-history.tsx (split mechanically out of this file); they are
 * re-exported here so existing imports keep working.
 */

export * from './integration-status';
export * from './integration-scope';
export { primaryCopy } from './integration-history';

/** The four sub-tabs, in order. `status` is the address without ?tab=. */
export const BITRIX_TABS = ['status', 'deals', 'switches', 'cleanup'] as const;
export type BitrixTab = (typeof BITRIX_TABS)[number];

export const BITRIX_TAB_LABEL: Record<BitrixTab, string> = {
  status: 'Status',
  deals: 'Which deals come in',
  switches: 'Switches',
  cleanup: 'Clean-up',
};

/** The address of one sub-tab. Status keeps the old address (no ?tab=). */
export function bitrixTabHref(tab: BitrixTab): string {
  return tab === 'status' ? SETTINGS_PATH.bitrix : `${SETTINGS_PATH.bitrix}?tab=${tab}`;
}

/** ?tab= of the Bitrix connection page. The old address (no tab) and any unknown value open Status. */
export function parseBitrixTab(raw: unknown): BitrixTab {
  return parseTab(raw, BITRIX_TABS, 'status');
}

export function IntegrationNoPermissionView() {
  return (
    <>
      <SettingsSectionHeading>Bitrix connection</SettingsSectionHeading>
      <p role="status">Only staff who manage the Bitrix connection, and who hold no Purchase role, can open this page.</p>
    </>
  );
}

/** Short words for the one-line summary (the long labels stay on the list and the rows). */
const COUNT_WORD: Partial<Record<InboxStatus, string>> = {
  pending: 'waiting',
  processing: 'processing',
  needs_review: 'to review',
  failed: 'failed',
  dead_letter: 'stopped',
};

/** "Nothing open: 0 waiting, 0 processing, …" on one line; the five counts as a list once any is above zero. */
function OpenSyncWork({ status }: { status: IntegrationStatusView }) {
  const counts = STATUS_ORDER.map((s) => ({ status: s, n: status.counts[s] ?? 0 }));
  return (
    <section className="panel" aria-labelledby="counts-heading">
      <h2 id="counts-heading">Open sync work</h2>
      {counts.every((c) => c.n === 0) ? (
        <p className="mb-0" data-slot="open-sync-work-line">
          Nothing open: {counts.map((c) => `${c.n} ${COUNT_WORD[c.status] ?? STATUS_LABEL[c.status].toLowerCase()}`).join(', ')}.
        </p>
      ) : (
        <dl className="stat-grid">
          {counts.map((c) => (
            <div key={c.status} className="stat">
              <dt>{STATUS_LABEL[c.status]}</dt>
              <dd>{c.n}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function AttentionTable({ status, retryInitialState }: { status: IntegrationStatusView; retryInitialState?: FormState }) {
  return (
    <>
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

function ConnectionPanel({
  status,
  now,
  emailAlertsConfigured,
  reconcileInitialState,
  tabbed,
}: {
  status: IntegrationStatusView;
  now: number;
  emailAlertsConfigured?: boolean;
  reconcileInitialState?: FormState;
  /** With sub-tabs, the rows that need a person are on Clean-up, not below. */
  tabbed: boolean;
}) {
  const providerFailure = latestProviderFailure(status.attention);
  const health = integrationHealth(status, now, providerFailure);
  const quiet = health.tone === 'ok' && olderThan(status.lastProcessedAt, now, STALE_SYNC_HOURS_PROPOSED * 3_600_000);
  return (
    <section className="panel" aria-labelledby="sync-status-heading">
      <div className="panel-header">
        <h2 id="sync-status-heading" className="mb-0">
          Connection
        </h2>
        <StatusPill health={health} />
      </div>

      {providerFailure ? (
        <div className="message error" role="alert">
          <strong>Error: </strong>
          {errorCopyFor(providerFailure.lastErrorCode!).sentence} Last failure at {formatIst(providerFailure.lastErrorAt!)}.
          {providerFailure.lastErrorCode === 'provider_auth_failed'
            ? 'Retries keep failing until an admin replaces the credential; see What needs fixing above.'
            : `Affected deals are retried automatically; those that run out of retries are listed ${tabbed ? 'on the Clean-up tab' : 'below'}.`}
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
        <p>Deals are not confirmed to be arriving. Each check under Details says what is wrong.</p>
      ) : null}
      <SyncAtAGlance status={status} now={now} emailAlertsConfigured={emailAlertsConfigured} />
      <FullCheck check={status.fullCheck} crmDeals={status.crmDeals} />

      {/* The technical checklist and facts sit behind "Details"; open on first load while something is wrong. */}
      <details open={health.tone !== 'ok'} data-slot="bitrix-details">
        <summary>Details</summary>
        {/* S-25: the technical cause (it can name a raw error code) stays under its own closed fold for the CRM team. */}
        {health.detail ? (
          <details>
            <summary>Details for the CRM team</summary>
            <p className="mb-0">{health.detail}</p>
          </details>
        ) : null}
        <HealthChecklist status={status} now={now} />
        <dl className="facts mt-1">
          <dt>Environment</dt>
          <dd>{ENVIRONMENT_LABEL[status.environment]}</dd>
          <dt>Bitrix portal</dt>
          <dd>{status.portalDomain ?? 'Not configured'}</dd>
          <dt>Pilot branch</dt>
          <dd>{status.pilotBranchName ?? 'Not configured'}</dd>
          <dt>Bring in deals created on or after</dt>
          <dd>{status.cutoffAt ? `${formatIst(status.cutoffAt)} (from 00:00 India time)` : 'Not configured'}</dd>
          <dt>Last deal processed</dt>
          <dd>{status.lastProcessedAt ? formatIst(status.lastProcessedAt) : 'Nothing processed yet'}</dd>
          <dt>Last background update</dt>
          <dd>
            {status.lastWorkerRunAt
              ? `${formatIst(status.lastWorkerRunAt)}: ${status.lastWorkerOutcome ? OUTCOME_LABEL[status.lastWorkerOutcome] : 'outcome not recorded'}`
              : 'Never'}
          </dd>
        </dl>
      </details>

      <div className="action-block">
        <h3>Check Bitrix now</h3>
        {status.configured ? (
          <ReconcileNowForm initialState={reconcileInitialState} />
        ) : (
          <p className="mb-0">Checking Bitrix is available once the connection is set up.</p>
        )}
      </div>
    </section>
  );
}

/** Status tab: one line pointing to Clean-up while rows need a person (the rows themselves are there). */
function CleanupPointer({ status }: { status: IntegrationStatusView }) {
  const rows = status.attention.length;
  const waiting = status.waitingForOwner ?? 0;
  if (rows === 0 && waiting === 0) return null;
  const parts = [
    rows > 0 ? `${rows} ${rows === 1 ? 'item needs' : 'items need'} attention` : null,
    waiting > 0 ? `${waiting} ${waiting === 1 ? 'deal is' : 'deals are'} waiting for an owner` : null,
  ].filter(Boolean);
  return (
    <p className="mb-0" data-slot="bitrix-cleanup-pointer">
      {parts.join(' and ')}. <a href={bitrixTabHref('cleanup')}>Open Clean-up</a>
    </p>
  );
}

export function IntegrationAdminView({
  status,
  now,
  scope,
  tab,
  reconcileInitialState,
  retryInitialState,
  pipelines = null,
  bitrixUsers = null,
  directoryError = null,
  emailAlertsConfigured,
  switches,
  switchActions,
  sync,
  slots,
  children,
}: {
  /**
   * UX redesign R1: the sub-tab to show, with the sub-tab links. Omitted
   * (older preview states only): every section on one page, as before.
   */
  tab?: BitrixTab;
  /** Batch 4: the Bitrix switches (Terra bitrixPageModel(...).switches); Bitrix names keeps its own card (slots.switches). */
  switches?: SettingsSectionModel;
  switchActions?: SettingSwitchActions;
  /**
   * Batch 4 (M1, DA-259): which deals come in from Bitrix, preview then apply.
   * Without it the section says the not-installed line; the old one-step form is never offered.
   */
  sync?: { model: SyncStateModel | null; text: string | null } & SyncScopeActions;
  /**
   * With sub-tabs: the page's own cards per sub-tab. Switches: Bitrix names,
   * trip details, destinations. Which deals come in: "Bring in deals only when
   * won". Clean-up: ID-proof copy stops.
   */
  slots?: { switches?: ReactNode; deals?: ReactNode; cleanup?: ReactNode };
  /** Without sub-tabs (older preview states): cards after the switches. */
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
  const tabbed = tab !== undefined;
  const show = (t: BitrixTab) => !tabbed || tab === t;
  // With Phase 6 scope wired (even when unreadable) the inbox can hold Leads and Deals: say "records".
  const problems = scope !== undefined ? syncProblems(status, now).map(asRecords) : syncProblems(status, now);
  const needPerson = status.attention.length + (status.waitingForOwner ?? 0);

  return (
    <>
      <SettingsSectionHeading description="New eligible deals created in Bitrix come into this CRM. Bitrix stays the owner of title, stage and salesperson. Nothing is written back to Bitrix and no amounts are brought in.">
        Bitrix connection
      </SettingsSectionHeading>

      {tabbed ? (
        <Tabs
          label="Bitrix connection sections"
          variant="pill"
          items={BITRIX_TABS.map((t) => ({
            href: bitrixTabHref(t),
            label: BITRIX_TAB_LABEL[t],
            current: t === tab,
            ...(t === 'cleanup' && needPerson > 0 ? { count: needPerson } : {}),
          }))}
        />
      ) : null}

      {show('status') ? (
        <>
          <SyncProblemList problems={problems} />
          <ConnectionPanel status={status} now={now} emailAlertsConfigured={emailAlertsConfigured} reconcileInitialState={reconcileInitialState} tabbed={tabbed} />
          {tabbed ? <CleanupPointer status={status} /> : null}
        </>
      ) : null}

      {show('deals') ? (
        <>
          {scope ? <p>Leads from Bitrix come in only when they are on the approved import list below; they are never stored as deals.</p> : null}
          {scope ? <IntakeScopePanel scope={scope} configured={status.configured} now={now} /> : null}
          {scope === null ? <IntakeScopeUnavailable /> : null}
          <SyncScopeSection
            configured={status.configured}
            pipelines={pipelines}
            directoryError={directoryError}
            model={sync ? sync.model : null}
            text={sync ? sync.text : null}
            installed={!!sync}
            actions={sync ? { preview: sync.preview, apply: sync.apply } : null}
          />
          {tabbed ? slots?.deals : null}
        </>
      ) : null}

      {show('switches') ? (
        <>
          {switches ? (
            <SettingsSectionView
              id="bitrix-switches"
              title="Bitrix switches"
              description="What the CRM reads from Bitrix, and the one setting that writes to it."
              section={switches}
              actions={switchActions}
              // With sub-tabs, "Bring in deals only when won" is shown once: its own card on Which deals come in.
              hideKeys={tabbed ? ['bitrix_name_read', 'won_only_intake'] : ['bitrix_name_read']}
            />
          ) : null}
          {tabbed ? slots?.switches : children}
        </>
      ) : null}

      {show('cleanup') ? (
        <>
          {tabbed ? slots?.cleanup : null}
          <OpenSyncWork status={status} />
          <AttentionTable status={status} retryInitialState={retryInitialState} />
          <WaitingForOwner status={status} users={bitrixUsers} />
          {tabbed ? (
            <p className="hint mb-0">
              Removing deals that are not won is part of “Bring in deals only when won”, on the{' '}
              <a href={bitrixTabHref('deals')}>Which deals come in</a> tab.
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}
