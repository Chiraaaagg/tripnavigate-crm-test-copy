import { FileText, History, Send, Undo2, Banknote, Plane } from 'lucide-react';
import Link from 'next/link';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { Timeline, type TimelineItem } from '@/components/ui/timeline';
import { DEAL_HISTORY_FLIGHT_UNAVAILABLE_TEXT, dealHistoryGroups } from '@/modules/deals/workspace';
import type { DealHistoryEventVM, DealHistoryVM } from '@/modules/deals/workspace-contract';
import { ACCOUNTS_REVIEW_STATUS_LABEL, CHANGE_CLASS_LABEL } from '@/modules/fulfilment/contracts';
import { CLAIM_STATUS_SALES_LABEL } from '../b11/book-fields';
import { formatIst } from '../deal-labels';
import { TabUnavailable } from './tab-error';
import { FLIGHT_HISTORY_TITLE } from '../flight/labels';

/*
 * History tab (DE-02, FP-027, screen plan §3 "History rule"). Every event
 * comes from a read the database already filters by role; no event carries
 * an amount. An honest empty line for roles that see no events; a failed
 * read is an error, never "no history". Timeline idea: cubby-ui 28295 /
 * olewandowski1 28340 (CRM Timeline component).
 */

export const HISTORY_EMPTY_TEXT = 'No history you can see on this deal yet.';

function when(at: string | null): string {
  return at ? formatIst(at) : 'Time not recorded';
}

function item(e: DealHistoryEventVM): TimelineItem {
  switch (e.kind) {
    case 'booking_version':
      return {
        id: e.id,
        icon: FileText,
        title: `Booking version ${e.versionNo}: ${e.statusText}`,
        meta: when(e.at),
        detail: e.changeClass ? CHANGE_CLASS_LABEL[e.changeClass].title : undefined,
      };
    case 'accounts_review':
      return {
        id: e.id,
        icon: Undo2,
        title: `Version ${e.versionNo}: ${ACCOUNTS_REVIEW_STATUS_LABEL[e.reviewStatus]}`,
        meta: 'Time not shown here',
        detail: e.reason ? `Reason: ${e.reason}` : e.reasonHidden ? 'The reason was not shared with Sales.' : undefined,
      };
    case 'quotation_version':
      return {
        id: e.id,
        icon: Send,
        title: (
          <Link href={e.href} className={cn('rounded-chip font-semibold text-brand-strong underline decoration-1 underline-offset-4 hover:text-brand-deep', focusRing)}>
            {`Quotation ${e.quotationReference} version ${e.versionNo}: ${e.statusText}`}
          </Link>
        ),
        meta: when(e.at),
      };
    case 'payment_reported':
      return {
        id: e.id,
        icon: Banknote,
        title: `Payment reported: ${CLAIM_STATUS_SALES_LABEL[e.status]}`,
        meta: when(e.at),
      };
    case 'flight_event':
      return flightItem(e);
  }
}

/**
 * Flight build (contract 9.4 deal_flight_history, decision 9): flight events
 * of the Deal's flight group, grouped under "Flight" by the workspace module:
 * what happened, on which flight, who (named only when the read names them)
 * and a reason note; never an amount, PNR or ticket number.
 */
function flightItem(e: Extract<DealHistoryEventVM, { kind: 'flight_event' }>): TimelineItem {
  const base = FLIGHT_HISTORY_TITLE[e.flightKind] ?? 'Flight work recorded';
  const who = e.byYou ? 'You' : e.byName;
  return {
    id: e.id,
    icon: Plane,
    title: `${base}${e.changeNo ? ` (change ${e.changeNo})` : ''}${e.flightTitle ? ` · ${e.flightTitle}` : ''}`,
    meta: `${when(e.at)}${who ? ` · by ${who === 'You' ? 'you' : who}` : ''}`,
    detail: e.note ? `Reason: ${e.note}` : undefined,
  };
}

export function DealHistoryTab({ history }: { history: DealHistoryVM }) {
  if (history.state === 'error') return <TabUnavailable thing="History" />;
  return (
    <Card>
      <section aria-labelledby="deal-history-heading">
        <CardHeader>
          <CardTitle id="deal-history-heading">History</CardTitle>
          <History aria-hidden="true" className="size-4 text-faint" />
        </CardHeader>
        <CardBody className="flex flex-col gap-5">
          {history.events.length === 0 && !history.flightUnavailable ? (
            <p className="m-0 text-copy">{HISTORY_EMPTY_TEXT}</p>
          ) : (
            <>
              <p className="m-0 text-sm text-quiet">Each group lists its newest event first.</p>
              {dealHistoryGroups(history.events, { flightUnavailable: history.flightUnavailable }).map((group) => (
                <section key={group.key} aria-labelledby={`history-${group.key}`} className="flex flex-col gap-3">
                  <h3 id={`history-${group.key}`} className="m-0 text-base font-semibold text-ink">
                    {group.heading}
                  </h3>
                  {group.unavailable ? (
                    // Flight build: only the flight read failed; the other groups still show. Never "no flight events".
                    <Notice tone="warning" role="status">
                      <p>{DEAL_HISTORY_FLIGHT_UNAVAILABLE_TEXT}</p>
                    </Notice>
                  ) : (
                    <Timeline label={`${group.heading}, newest first`} items={group.events.map(item)} />
                  )}
                </section>
              ))}
            </>
          )}
        </CardBody>
      </section>
    </Card>
  );
}
