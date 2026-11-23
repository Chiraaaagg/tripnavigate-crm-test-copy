import type { InboxItemView, InboxOrigin, InboxStatus, IntegrationStatusView } from '@/modules/integration/contracts';
import type { BitrixUser } from '@/modules/integration/bitrix/directory';
import { copyForObject, errorCopyFor, ProblemNextLine, reasonCopyFor, type ProblemCopy } from './integration-status';
import { formatIst } from './staff-views';

/*
 * Settings · Bitrix connection, Clean-up tab: open sync work by status, the
 * rows that need a person (with Retry) and the deals waiting for an owner.
 * Split mechanically out of integration-views.tsx (UX redesign R1).
 */

export const STATUS_LABEL: Record<InboxStatus, string> = {
  pending: 'Waiting to process',
  processing: 'Processing now',
  processed: 'Processed',
  ignored: 'Ignored (not eligible)',
  needs_review: 'Needs review',
  failed: 'Failed, will retry automatically',
  dead_letter: 'Stopped: retries used up',
};
/** Work still open or needing a person; cumulative processed/ignored totals are not shown. */
export const STATUS_ORDER: InboxStatus[] = ['pending', 'processing', 'needs_review', 'failed', 'dead_letter'];
export const STATUS_TONE: Partial<Record<InboxStatus, string>> = { needs_review: 'warn', failed: 'warn', dead_letter: 'danger' };

/** Statuses integration_retry_inbox accepts. */
export const RETRYABLE: ReadonlySet<InboxStatus> = new Set(['needs_review', 'failed', 'dead_letter']);

/** 'staff_refresh': "Refresh from Bitrix now" on the booking form (Book now v2). */
export const ORIGIN_LABEL: Record<InboxOrigin | 'staff_refresh', string> = {
  event: 'Bitrix event',
  reconcile: 'Missed-deal check',
  manual_retry: 'Manual retry',
  staff_refresh: 'Staff refresh',
};



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

export function AttentionReason({ item }: { item: InboxItemView }) {
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

export function WaitingForOwner({ status, users }: { status: IntegrationStatusView; users: BitrixUser[] | null }) {
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
