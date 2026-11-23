import { GitCompareArrows } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Fold } from '@/components/ui/fold';
import { Notice } from '@/components/ui/notice';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { DialogAction } from '@/views/accounts-desk/acc2-kit';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { BlockedGroup } from './blocked-group';
import { ChangeRequestFields } from './fields';
import { DEPARTMENT_WORD, KIND_WORD, STATUS_WORD, blockedWord } from './labels';
import { ChangeRequestBlock, type ChangeRequestActions, type RequestPreviewOpen } from './request-block';
import { BookingChangeSwitches } from './switch';
import { liveRequest, requestBlockedReason } from './rules';
import type { ChangeKind, ChangeViewer, DealChangeRequestsView } from './types';

/*
 * Deal page "Changes after confirmation" card (contract 10.3, 10.5 R-G1,
 * 11, screen 15.10). The Sales owner (or the branch Manager) asks for a
 * change, to add a service or to remove one, fills the change version and
 * sends it; the branch Manager approves exactly that version on Approvals
 * (the only approval, owner Q7 / LD24, Addendum O2).
 * Shows the live request with its next step and the reconfirmation
 * progress, then earlier requests. Accounts read it only. Purchase, Flight
 * and Visa get null from the database and the route renders nothing.
 * Never shows a cost or a rate (section 14).
 */

// Addendum O2: the Sales owner fills the change version first (new total and payment plan included) and sends
// it; the branch Manager approves exactly that version; then Purchase reconfirms with the suppliers.
const ASK_DESCRIPTION: Record<ChangeKind, string> = {
  change: 'Say what changes and why. You then make the change in the booking (with the new total and payment plan) and press "Send change". The branch Manager approves exactly that version; then Purchase reconfirms with each supplier. The earlier booking stays valid until the change is applied.',
  add_service: 'Say what to add and why. You then add the service in the booking, set the new total and payment plan, and press "Send change". The branch Manager approves exactly that version; a new task goes to the right department.',
  remove_service: 'Say which service and why. You then take it out of the booking, set the new total and payment plan, and press "Send change". A service already booked needs the supplier charges entered by its department before the Manager can approve.',
};

const KINDS = ['change', 'add_service', 'remove_service'] as const;
const ASK_LABEL: Record<ChangeKind, string> = { change: 'Request a change', add_service: 'Add a service', remove_service: 'Remove a service' };
const ASK_TITLE: Record<ChangeKind, string> = { change: 'Request a change', add_service: 'Ask to add a service', remove_service: 'Ask to remove a service' };

type AskPreview = { kind: ChangeKind; state?: DeskResult | null };

function askAction(actions: Partial<ChangeRequestActions> | null, kind: ChangeKind): DecisionAction | undefined {
  return kind === 'change' ? actions?.create : kind === 'add_service' ? actions?.createAdd : actions?.createRemove;
}

/** One ask button with its dialog (same fields and action as before; only its place on the page moved in R2). */
function AskDialog({ c, kind, actions, preview, variant }: { c: DealChangeRequestsView; kind: ChangeKind; actions: Partial<ChangeRequestActions> | null; preview?: AskPreview; variant: 'primary' | 'secondary' }) {
  return (
    <DialogAction
      buttonLabel={ASK_LABEL[kind]}
      buttonVariant={variant}
      blockedReason={requestBlockedReason(c, kind)}
      title={ASK_TITLE[kind]}
      description={ASK_DESCRIPTION[kind]}
      primaryLabel="Start the change"
      pendingLabel="Starting…"
      action={askAction(actions, kind)}
      fields={{ dealId: c.dealId }}
      okTitle="Started"
      initialOpen={preview?.kind === kind}
      initialState={preview?.kind === kind ? preview.state : undefined}
    >
      <ChangeRequestFields kind={kind} confirmed={c.confirmed} removable={c.removable} addableTypes={c.addableTypes} />
    </DialogAction>
  );
}

/**
 * R2 (design plan 2.4 "Deal › Services and tasks", SL-8): "Request a change"
 * in the Services sold header. Rendered only for people who may ask (the
 * database's canRequest); while it cannot be used the button stays visible,
 * disabled, with the reason beside it. Pair with
 * `<DealChangesCard askInServicesHeader />` so the button is not shown twice.
 */
export function RequestChangeHeaderAction({ changes, actions, preview }: { changes: DealChangeRequestsView; actions: Partial<ChangeRequestActions> | null; preview?: AskPreview }) {
  if (!changes.canRequest) return null;
  return <AskDialog c={changes} kind="change" actions={actions} preview={preview} variant="primary" />;
}

export function DealChangesCard({
  changes,
  viewer,
  actions,
  editHref,
  historyHref,
  switches,
  askInServicesHeader = false,
  preview,
}: {
  /** R2: "Request a change" sits in the Services sold header (RequestChangeHeaderAction); this card keeps Add and Remove. */
  askInServicesHeader?: boolean;
  /** Super Admin only (the route decides): the two feature switches with their actions. */
  switches?: { setChanges: DecisionAction; setServiceChanges: DecisionAction } | null;
  changes: DealChangeRequestsView | 'error';
  viewer: ChangeViewer;
  actions: Partial<ChangeRequestActions> | null;
  /** Route-built link to the booking form in change mode for a request. */
  editHref?: (changeRequestId: string) => string;
  /** Link to the History of changes section. */
  historyHref?: string;
  preview?: { ask?: { kind: ChangeKind; state?: DeskResult | null }; open?: RequestPreviewOpen };
}) {
  if (changes === 'error') {
    return (
      <Shell status="Could not load">
        <Notice tone="warning" role="status">
          <p>The changes could not be loaded just now. Nothing was changed. Reload the page.</p>
        </Notice>
      </Shell>
    );
  }
  const c = changes;
  const live = liveRequest(c);
  const past = c.requests.filter((r) => r !== live);
  const status = live ? `${KIND_WORD[live.kind]} ${live.refNo}: ${STATUS_WORD[live.status].toLowerCase()}` : c.requests.length ? 'No change in progress' : 'No change asked for';
  const offWord = !c.enabled && !(c.serviceChangesEnabled ?? c.enabled) ? blockedWord('changes_off') : null;
  const showAsk = c.canRequest;
  const kinds = askInServicesHeader ? KINDS.filter((k) => k !== 'change') : KINDS;
  const reasons = kinds.map((k) => requestBlockedReason(c, k));
  const sharedBlock = reasons[0] && reasons.every((r) => r === reasons[0]) ? reasons[0] : null;
  const dbBlocks = c.blockedBy.filter((code) => code !== 'changes_off' && code !== 'service_changes_off' && code !== 'change_open');
  return (
    <Shell status={status}>
      {offWord ? (
        <Notice tone="info" title="Changes after confirmation are not switched on yet">
          <p>Requests start once a Super Admin switches them on in Settings. Until then, ask Purchase to talk to the supplier and record nothing here.</p>
        </Notice>
      ) : null}
      {switches ? <BookingChangeSwitches changesEnabled={c.enabled} serviceChangesEnabled={c.serviceChangesEnabled ?? false} actions={switches} /> : null}
      {viewer === 'accounts' ? (
        <Notice tone="locked" title="Read only for Accounts">
          <p>The Sales owner asks and the branch Manager approves. Once a change is applied, dues and bills follow the new booking; you get the urgent &quot;booking changed&quot; notice.</p>
        </Notice>
      ) : null}
      {!offWord && dbBlocks.length > 0 && !live ? (
        <Notice tone="warning" title="A change cannot be asked for now">
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
            {dbBlocks.map((code) => (
              <li key={code}>{blockedWord(code)}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {showAsk && sharedBlock ? <BlockedGroup labels={kinds.map((k) => ASK_LABEL[k])} reason={sharedBlock} /> : null}
      {showAsk && !sharedBlock ? (
        <div className="flex flex-wrap items-start gap-3">
          {kinds.map((kind) => (
            <AskDialog key={kind} c={c} kind={kind} actions={actions} preview={preview?.ask} variant={kind === 'change' ? 'primary' : 'secondary'} />
          ))}
        </div>
      ) : null}

      {live ? (
        <section aria-labelledby="changes-live" className="flex flex-col gap-3">
          <h3 id="changes-live" className="m-0 text-base font-semibold text-ink">
            In progress
          </h3>
          <ChangeRequestBlock r={live} deal={c} viewer={viewer} actions={actions} editHref={live.changeVersionId && editHref ? editHref(live.id) : null} open={preview?.open} />
        </section>
      ) : null}

      {c.confirmed.length > 0 ? (
        <details className="group rounded-control border border-line px-3 py-2">
          <summary className="cursor-pointer text-sm font-semibold text-ink">Services confirmed by a supplier ({c.confirmed.length})</summary>
          <ul className="m-0 mt-2.5 flex list-none flex-col gap-1 p-0 text-sm">
            {c.confirmed.map((s) => (
              <li key={s.itemId} className="wrap-anywhere text-copy">
                <span className="text-ink">
                  {s.itemNo}. {s.serviceTitle}
                </span>
                {' · '}
                {DEPARTMENT_WORD[s.department]}
                {s.supplierName ? ` · ${s.supplierName}` : ''}
                {s.reference ? ` · ref ${s.reference}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <section aria-labelledby="changes-past" className="flex flex-col gap-3">
        <h3 id="changes-past" className="m-0 text-base font-semibold text-ink">
          Earlier requests
        </h3>
        {past.length === 0 ? (
          <p className="m-0 text-copy">None yet.</p>
        ) : (
          // R2 (SL-8): each earlier request folds to one line; its details open on demand.
          <div className="flex flex-col gap-2">
            {past.map((r) => (
              <Fold key={r.id} summary={`${KIND_WORD[r.kind]} ${r.refNo}`} meta={STATUS_WORD[r.status]} className="shadow-none">
                <ChangeRequestBlock r={r} deal={c} viewer={viewer} actions={actions} editHref={null} open={preview?.open} />
              </Fold>
            ))}
          </div>
        )}
        {historyHref && c.requests.some((r) => r.status === 'applied') ? (
          <a href={historyHref} className="text-sm font-semibold text-brand-strong underline-offset-4 hover:underline">
            See the history of changes
          </a>
        ) : null}
      </section>
    </Shell>
  );
}

function Shell({ status, children }: { status: string; children: ReactNode }) {
  return (
    <Card id="changes">
      <section aria-labelledby="changes-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="changes-heading">Changes after confirmation</CardTitle>
            <CardDescription>{status}</CardDescription>
          </div>
          <GitCompareArrows aria-hidden="true" className="size-4 text-faint" />
        </CardHeader>
        <CardBody className="flex flex-col gap-5">{children}</CardBody>
      </section>
    </Card>
  );
}

export function DealChangesCardLoading() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Changes after confirmation</CardTitle>
      </CardHeader>
      <CardBody>
        <LoadingRegion label="Loading changes…">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </LoadingRegion>
      </CardBody>
    </Card>
  );
}
