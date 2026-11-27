import { STALE_SYNC_HOURS_PROPOSED, type SourceObject } from '@/modules/integration/contracts';
import type { HandoffRole } from './handoff';
import { AUTOMATIC, NOBODY, olderThan, ProblemNextLine, StatusPill, type Health, type ProblemCopy } from './integration-status';
import { formatIst } from './staff-views';

/*
 * Settings · Bitrix connection, Which deals come in tab: the owner-approved
 * Lead import list and its progress (Phase 6). Split mechanically out of
 * integration-views.tsx (UX redesign R1).
 */

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

export function IntakeScopePanel({ scope, configured, now }: { scope: IntakeScopeView; configured: boolean; now: number }) {
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
export function IntakeScopeUnavailable() {
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
