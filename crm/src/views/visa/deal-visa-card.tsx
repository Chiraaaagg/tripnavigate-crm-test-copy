'use client';

import { BellRing, Stamp } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { VISA_NOTICE_TEXT, VISA_TEXT } from '@/modules/visa/contracts';
import { formatIst } from '../deal-labels';
import { DEAL_VISA_ANCHOR } from '../service-labels';
import { formOf, VF, type DealVisaActions } from './actions';
import { VisaStatusBadge } from './bits';
import { ResultNotice, useCommand, type VisaResult } from './kit';
import { plural } from './labels';
import type { DealVisaNotice, DealVisaSummary } from './types';

/*
 * Deal page · Services tab visa card (contract 11.2, from deal_visa_summary):
 * per visa or passport task its status words and "x of y approved · z
 * waiting"; and, for the Deal's Sales owner (branch Manager when none), the
 * "Visa results" notices with "OK, seen" (C14, once per application outcome,
 * V10). No fees, references, e-mails or passport numbers (money and contact
 * fence). 21st.dev "Information Card" idea only: a plain card with a
 * labelled list, the CRM Notice for each result.
 */

function NoticeRow({ n, dealId, action, initialState }: { n: DealVisaNotice; dealId: string; action?: DealVisaActions['ackNotice']; initialState?: VisaResult | null }) {
  const cmd = useCommand(action ?? (async () => ({ ok: false, code: 'not_authorized', message: '' })), initialState ?? null);
  const who = n.travellerName ?? VISA_NOTICE_TEXT.unnamed;
  const text = (n.outcome === 'approved' ? VISA_NOTICE_TEXT.approved : VISA_NOTICE_TEXT.rejected).replace('{name}', who);
  const seen = n.seen || cmd.state?.ok === true;
  return (
    <li className="m-0 flex flex-col gap-2 px-4.5 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="m-0 font-semibold wrap-anywhere text-ink">{text}</p>
          <p className="m-0 text-sm text-quiet">
            {n.title} · {formatIst(n.at)}
          </p>
          {n.outcome === 'rejected' ? <p className="m-0 mt-[0.25rem] text-sm">Reason: {n.reason ?? VISA_TEXT.reasonNotRecorded}</p> : null}
        </div>
        <StatusBadge tone={n.outcome === 'approved' ? 'success' : 'danger'} wrap>
          <span className="sr-only">Result: </span>
          {n.outcome === 'approved' ? 'Approved' : 'Rejected'}
        </StatusBadge>
      </div>
      {seen ? (
        <p className="m-0 text-sm text-quiet">Seen</p>
      ) : n.canAck && action ? (
        <div>
          <Button size="sm" loading={cmd.pending} onClick={() => cmd.send((rid) => formOf({ [VF.noticeId]: n.noticeId, [VF.dealId]: dealId }, rid))}>
            {VISA_NOTICE_TEXT.ack}
            <span className="sr-only">: {text}</span>
          </Button>
        </div>
      ) : null}
      {cmd.state && !cmd.state.ok ? <ResultNotice state={cmd.state} /> : null}
    </li>
  );
}

export function DealVisaCard({
  summary,
  dealId,
  actions,
  canOpenTasks = false,
  ackInitialState,
}: {
  summary: DealVisaSummary;
  dealId: string;
  actions?: DealVisaActions;
  /** The viewer can open the task pages (branch Manager); Sales cannot. */
  canOpenTasks?: boolean;
  /** Preview gallery only. */
  ackInitialState?: VisaResult | null;
}) {
  if (summary.tasks.length === 0 && summary.notices.length === 0) return null;
  const open = summary.notices.filter((n) => !n.seen);
  return (
    <div id={DEAL_VISA_ANCHOR} className="flex scroll-mt-4 flex-col gap-5">
      {summary.notices.length > 0 ? (
        <Card className={cn(open.length > 0 && 'border-status-info-line')} id="visa-results">
          <section aria-labelledby="visa-results-heading">
            <CardHeader>
              <div className="min-w-0">
                <CardTitle id="visa-results-heading">Visa results{open.length ? ` · ${open.length} new` : ''}</CardTitle>
                <CardDescription>The Visa desk recorded these results. Tell the customer if they do not know yet.</CardDescription>
              </div>
              <BellRing aria-hidden="true" className="size-4 text-faint" />
            </CardHeader>
            <ol className="m-0 flex list-none flex-col divide-y divide-line p-0" aria-label="Visa results">
              {summary.notices.map((n) => (
                <NoticeRow key={n.noticeId} n={n} dealId={dealId} action={actions?.ackNotice} initialState={ackInitialState} />
              ))}
            </ol>
          </section>
        </Card>
      ) : null}
      {summary.tasks.length > 0 ? (
        <Card>
          <section aria-labelledby="deal-visa-heading">
            <CardHeader>
              <div className="min-w-0">
                <CardTitle id="deal-visa-heading">Visa and passport</CardTitle>
                <CardDescription>Progress from the Visa desk. Fees and references stay with the desk and Accounts.</CardDescription>
              </div>
              <Stamp aria-hidden="true" className="size-4 text-faint" />
            </CardHeader>
            <ol className="m-0 flex list-none flex-col divide-y divide-line p-0" aria-label="Visa and passport tasks">
              {summary.tasks.map((t) => {
                const parts = [`${t.approved} of ${t.applicantCount} approved`];
                if (t.waiting) parts.push(`${t.waiting} waiting`);
                if (t.rejected) parts.push(`${t.rejected} rejected`);
                if (t.withdrawn) parts.push(`${t.withdrawn} withdrawn`);
                return (
                  <li key={t.taskId} className="m-0 flex flex-col gap-1.5 px-4.5 py-3.5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="m-0 font-semibold wrap-anywhere text-ink">
                        {canOpenTasks ? (
                          <Link href={`/app/visa/${t.taskId}`} className={cn('rounded-chip text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing)}>
                            {t.serviceType === 'passport' ? 'Passport' : 'Visa'} · {t.title}
                          </Link>
                        ) : (
                          <>
                            {t.serviceType === 'passport' ? 'Passport' : 'Visa'} · {t.title}
                          </>
                        )}
                      </p>
                      <VisaStatusBadge status={t.status} />
                    </div>
                    <p className="m-0 text-sm text-copy">{t.applicantCount ? parts.join(' · ') : plural(0, 'passenger')}</p>
                    {t.addedAfterCompletion > 0 ? (
                      <Notice tone="warning">{t.addedAfterCompletion === 1 ? '1 traveller added after completion has no visa application.' : `${t.addedAfterCompletion} travellers added after completion have no visa application.`}</Notice>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </section>
        </Card>
      ) : null}
    </div>
  );
}

export function DealVisaUnavailable() {
  return (
    <Card>
      <CardBody>
        <p className="m-0 text-copy" role="status">
          The visa and passport progress could not be loaded. Nothing was changed. Reload the page to try again.
        </p>
      </CardBody>
    </Card>
  );
}
