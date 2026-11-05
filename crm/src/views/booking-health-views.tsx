import { Activity, CircleCheck, CircleHelp, CircleOff, CircleX, FileText, Link2, Lock, Mail, RefreshCw, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { StatItem, StatList } from '@/components/ui/stat-card';
import type { BookingHealthView } from '@/modules/fulfilment/contracts';
import type { SettingsSectionModel } from '@/modules/settings/rows';
import { READ_ONLY_WORDS, SETTINGS_TEXT } from '@/modules/settings/text';
import { SettingsSectionHeading } from './settings/settings-frame';
import { SettingsSectionView } from './settings/setting-rows';

/*
 * Settings · System health (Direction A R6; copy DA-262, S-36 to S-38).
 * Read only: every row is a fact with its state in words and an icon, never a
 * control (booking confirmation, the online PDF maker and email alerts are
 * changed by the CRM team with the owner's approval, DA-253). It never shows
 * a healthy state it cannot prove: Unknown is its own state.
 */

export const GATE_OFF_TEXT = 'Real bookings: off';

const ENVIRONMENT_LABEL: Record<BookingHealthView['environment'], string> = {
  unset: 'Not set',
  test: 'Test',
  staging: 'Staging',
  operational: 'Operational',
};

function headline(health: BookingHealthView | null): { tone: StatusTone; icon: LucideIcon; word: string } {
  if (!health) return { tone: 'warning', icon: CircleHelp, word: 'Unknown' };
  if (health.environment === 'unset') return { tone: 'danger', icon: CircleX, word: 'Not set up: bookings cannot be confirmed' };
  if (!health.realBookingEnabled) return { tone: 'neutral', icon: CircleOff, word: GATE_OFF_TEXT };
  return { tone: 'success', icon: CircleCheck, word: 'Real bookings: on' };
}

function gateExplanation(health: BookingHealthView): string {
  if (health.environment === 'unset') return 'This CRM is not set up, so no booking can be confirmed. Drafts can still be saved.';
  if (!health.realBookingEnabled) {
    return health.environment === 'test'
      ? 'Only synthetic test deals can be confirmed in this test environment. Real deals stay as drafts.'
      : 'Real deals stay as drafts. Synthetic test deals can only be confirmed in the test environment.';
  }
  return 'Sales can submit real bookings. Submitting creates the department tasks.';
}

/** One read-only fact row (System health): name, state word with an icon, one line, and the "not here" line. */
function FactRow({ icon: Icon, title, state, children }: { icon: LucideIcon; title: string; state: ReactNode; children?: ReactNode }) {
  return (
    <li className="m-0 flex flex-col gap-2 rounded-control border border-line bg-card px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <h4 className="m-0 flex min-w-0 flex-1 basis-56 items-center gap-2 text-base font-semibold text-ink">
          <Icon aria-hidden="true" className="size-4 shrink-0 text-faint" />
          {title}
        </h4>
        {state}
      </div>
      {children}
    </li>
  );
}

function NotHere({ children = SETTINGS_TEXT.readOnlyLine }: { children?: ReactNode }) {
  return (
    <p className="m-0 flex items-start gap-1.5 text-sm text-quiet">
      <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
      <span>{children}</span>
    </p>
  );
}

function OnOffUnknown({ on, label }: { on: boolean | null | undefined; label: string }) {
  const look = on === true ? { tone: 'success' as const, icon: CircleCheck, word: 'On' } : on === false ? { tone: 'neutral' as const, icon: CircleOff, word: 'Off' } : { tone: 'warning' as const, icon: CircleHelp, word: 'Unknown' };
  return (
    <StatusBadge tone={look.tone} icon={look.icon} wrap>
      <span className="sr-only">{label}: </span>
      {look.word}
    </StatusBadge>
  );
}

const linkClass = cn('rounded-chip font-semibold text-brand-strong underline decoration-1 underline-offset-4 hover:text-brand-deep hover:decoration-2', focusRing);

export function BookingHealthPage({
  health,
  live,
  pdfMaker,
  emailAlertsConfigured,
  bitrix,
  bitrixHref,
}: {
  health: BookingHealthView | null;
  /** Real bookings and supplier confirmation as read-only rows with their last change (Terra liveRows). */
  live?: SettingsSectionModel;
  /** The online PDF maker server setting (B1.2 read-only row); on null = Unknown. Absent: no row. */
  pdfMaker?: { on: boolean | null };
  /** Whether problem e-mails can be sent. Absent: no row. */
  emailAlertsConfigured?: boolean;
  /** Bitrix updates headline (S-25 words, integrationHealthSummary). null = could not be read. Absent: no row. */
  bitrix?: { label: string; tone: 'ok' | 'warn' | 'danger' } | null;
  /** Settings · Bitrix connection, when this person may open it. */
  bitrixHref?: string | null;
}) {
  const head = headline(health);
  return (
    <>
      <SettingsSectionHeading id="health-heading" description={SETTINGS_TEXT.frameReadOnly}>
        Booking health
      </SettingsSectionHeading>
      <Card>
        <section aria-labelledby="gate-heading">
          <CardHeader>
            <div className="min-w-0">
              <CardTitle id="gate-heading">Booking confirmation</CardTitle>
              <CardDescription>{health ? gateExplanation(health) : 'The booking counts could not be read. Nothing is assumed healthy, and nothing was changed.'}</CardDescription>
            </div>
            <StatusBadge tone={head.tone} icon={head.icon} wrap>
              <span className="sr-only">Booking health: </span>
              {head.word}
            </StatusBadge>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            <p className="m-0 text-copy" data-slot="health-next">
              <span className="font-semibold text-ink">Next:</span>{' '}
              {health
                ? health.realBookingEnabled
                  ? 'watch the counts below; Purchase tasks waiting to be taken need a Purchase colleague.'
                  : 'nothing here. Real bookings are switched on by the CRM team with the owner’s approval.'
                : 'reload the page. If it keeps failing, tell the CRM team.'}
            </p>
            {health ? (
              <p className="m-0 text-sm text-quiet">
                Environment: <span className="font-semibold text-copy">{ENVIRONMENT_LABEL[health.environment]}</span>
              </p>
            ) : (
              <Notice tone="warning" role="alert">
                <p>The booking counts could not be read. Nothing is assumed healthy, and nothing was changed.</p>
              </Notice>
            )}
            <NotHere />
          </CardBody>
        </section>
      </Card>
      {health ? (
        <section aria-labelledby="counts-heading" className="flex flex-col gap-3">
          <h3 id="counts-heading" className="m-0 text-lg font-semibold text-ink">
            Bookings and Purchase tasks
          </h3>
          <StatList>
            <StatItem label="Drafts" value={health.drafts} />
            <StatItem label="Drafts needing details" value={health.draftsNeedingRepair} />
            <StatItem label="Confirmed bookings" value={health.confirmed} />
            <StatItem label="Purchase tasks waiting to be taken" value={health.tasksNotStarted} />
            <StatItem label="Purchase tasks in progress" value={health.tasksInProgress} />
            <StatItem label="Internal notices waiting" value={health.pendingOutboxEvents} />
          </StatList>
          <p className="m-0 text-sm text-quiet">Internal notices waiting: {health.pendingOutboxEvents}. Nothing is sent to Bitrix, hotels or customers.</p>
        </section>
      ) : null}
      {pdfMaker || emailAlertsConfigured !== undefined || bitrix !== undefined ? (
        <section aria-labelledby="system-facts-heading" className="flex flex-col gap-3">
          <h3 id="system-facts-heading" className="m-0 text-lg font-semibold text-ink">
            PDFs, email alerts and Bitrix updates
          </h3>
          <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-labelledby="system-facts-heading">
            {pdfMaker ? (
              <FactRow icon={FileText} title={READ_ONLY_WORDS.pdf_render_online.title} state={<OnOffUnknown on={pdfMaker.on} label="Online PDF maker" />}>
                {pdfMaker.on === null ? <p className="m-0 text-sm text-copy">{SETTINGS_TEXT.unknownOne}</p> : null}
                <NotHere>{READ_ONLY_WORDS.pdf_render_online.line}</NotHere>
              </FactRow>
            ) : null}
            {emailAlertsConfigured !== undefined ? (
              <FactRow icon={Mail} title="Email alerts" state={<OnOffUnknown on={emailAlertsConfigured} label="Email alerts" />}>
                <p className="m-0 text-sm text-copy">{emailAlertsConfigured ? 'Super Admins get an email when Bitrix updates stop.' : 'Email alerts are off: problems show only on this page.'}</p>
                <NotHere />
              </FactRow>
            ) : null}
            {bitrix !== undefined ? (
              <FactRow
                icon={RefreshCw}
                title="Bitrix updates"
                state={
                  bitrix === null ? (
                    <OnOffUnknown on={null} label="Bitrix updates" />
                  ) : (
                    <StatusBadge tone={bitrix.tone === 'ok' ? 'success' : bitrix.tone === 'warn' ? 'warning' : 'danger'} icon={bitrix.tone === 'ok' ? CircleCheck : bitrix.tone === 'warn' ? Activity : CircleX} wrap>
                      <span className="sr-only">Bitrix updates: </span>
                      {bitrix.label}
                    </StatusBadge>
                  )
                }
              >
                {bitrix === null ? <p className="m-0 text-sm text-copy">The Bitrix update state could not be read. It is not assumed to be working.</p> : null}
                {bitrixHref ? (
                  <p className="m-0 flex items-center gap-1.5 text-sm">
                    <Link2 aria-hidden="true" className="size-3.5 shrink-0 text-faint" />
                    <Link href={bitrixHref} className={linkClass}>
                      Open Bitrix connection
                    </Link>
                  </p>
                ) : null}
              </FactRow>
            ) : null}
          </ul>
        </section>
      ) : null}
      {live ? <SettingsSectionView id="health-read-only" title="Set by the CRM team" section={live} /> : null}
    </>
  );
}

export function BookingHealthNoPermissionView() {
  return (
    <>
      <SettingsSectionHeading>Booking health</SettingsSectionHeading>
      <Notice tone="restricted" role="status">
        <p>You do not have permission to see booking health.</p>
      </Notice>
    </>
  );
}
