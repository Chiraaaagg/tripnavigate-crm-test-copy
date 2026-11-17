import { CircleCheck, CircleDashed, Lock, UserRound } from 'lucide-react';
import Link from 'next/link';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { NotEntered, SummaryList, SummaryRow } from '@/components/ui/summary-list';
import type { DealOverviewVM } from '@/modules/deals/workspace-contract';
import { bitrixCodeDetail, dayText, formatIst, LATE_TEXT } from '../deal-labels';
import { DEAL_SEEN_BECAUSE } from '../deals-list-view';
import { BitrixName } from '../list-parts';

/*
 * Overview tab (DE-02, FP-020, D-14, D-15, D-19; R2 one-screen summary,
 * design plan 2.4 "Deal › Overview"): trip, travellers, the services with
 * their status, money lines for price readers only, and the team; each block
 * links to its tab. Branch, created date, why the viewer can see the deal and
 * the Bitrix facts are folded under Details. Money appears only when the
 * route built `overview.money` (never for Purchase, Flight or Visa). There is
 * no trip-closure checklist on the Deal Overview (build plan section 5).
 */

function TabLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} className={cn('w-fit rounded-chip text-sm font-semibold text-brand-strong underline decoration-1 underline-offset-4 hover:text-brand-deep', focusRing)}>
      {children}
    </Link>
  );
}

/** An amount is one unit: it never breaks across lines. */
function Amount({ value }: { value: string }) {
  return <span className="font-semibold whitespace-nowrap tabular-nums">{value}</span>;
}

export function DealOverviewTab({ overview }: { overview: DealOverviewVM }) {
  const bitrix = overview.bitrix;
  const services = overview.services ?? [];
  const links = overview.links;
  const money = overview.money;
  return (
    <Card>
      <section aria-labelledby="deal-overview-heading">
        <CardHeader className="sr-only">
          <CardTitle id="deal-overview-heading">Overview</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <SummaryList>
            <SummaryRow label="Trip">{overview.tripText ?? <NotEntered>Not known yet</NotEntered>}</SummaryRow>
            {overview.travellersText !== null ? <SummaryRow label="Travellers">{overview.travellersText}</SummaryRow> : null}
            <SummaryRow label="Services">
              <div className="flex flex-col gap-1.5" data-slot="overview-services">
                {services.length === 0 ? (
                  <span className="text-quiet">No services yet</span>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {services.map((s) => (
                      <li key={s.itemNo} className="m-0 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        {s.done ? (
                          <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-status-success" />
                        ) : (
                          <CircleDashed aria-hidden="true" className="size-4 shrink-0 text-faint" />
                        )}
                        <span className="min-w-0 wrap-break-word text-ink">{s.title}</span>
                        <span className="text-sm text-quiet">
                          · {s.departmentLabel} · {s.statusWord}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {overview.servicesProgressText ? <span className="text-sm text-copy">{overview.servicesProgressText}</span> : null}
                {links ? <TabLink href={links.services}>Open Services and tasks</TabLink> : null}
              </div>
            </SummaryRow>
            {money ? (
              <SummaryRow label="Money">
                <div className="flex flex-col gap-1" data-slot="overview-money">
                  <span>
                    Final selling total: {money.sellingTotal ? <Amount value={money.sellingTotal} /> : <NotEntered />}
                  </span>
                  <span>
                    Still to pay (based on checked money):{' '}
                    {money.stillToPay ? <Amount value={money.stillToPay} /> : <NotEntered>Not known yet</NotEntered>}
                  </span>
                  {links?.money ? <TabLink href={links.money}>Open Money</TabLink> : null}
                </div>
              </SummaryRow>
            ) : null}
            <SummaryRow label="Team">
              {overview.team.length === 0 ? (
                <span className="text-quiet">No one assigned yet</span>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {overview.team.map((member, i) => (
                    // Several people can share one kind; the order is kept, so the position tells them apart.
                    <li key={`${member.kindLabel}-${i}`} className="m-0 inline-flex items-center gap-1.5">
                      <UserRound aria-hidden="true" className="size-4 shrink-0 text-faint" />
                      {member.kindLabel}: {member.isYou ? 'You' : 'a colleague'}
                    </li>
                  ))}
                </ul>
              )}
            </SummaryRow>
          </SummaryList>
          <details className="rounded-control border border-line bg-canvas px-3.5 py-2.5" data-slot="deal-details">
            <summary className={cn('cursor-pointer rounded-chip font-semibold text-brand-strong underline decoration-1 underline-offset-4', focusRing)}>
              {bitrix ? 'Details and Bitrix facts' : 'Details'}
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              <SummaryList>
                <SummaryRow label="Branch">{overview.branchName}</SummaryRow>
                <SummaryRow label="Created">{dayText(overview.createdOn)}</SummaryRow>
                <SummaryRow label="Why you can see this deal">{DEAL_SEEN_BECAUSE[overview.relation]}</SummaryRow>
                {bitrix ? (
                  <>
                    <SummaryRow label="Bitrix deal">#{bitrix.sourceDealId}</SummaryRow>
                    <SummaryRow label="Stage">
                      <BitrixName name={bitrix.stage} kind="stage" />
                      <span className="block text-sm text-quiet">{bitrixCodeDetail(bitrix.stage)}</span>
                    </SummaryRow>
                    <SummaryRow label="Last checked with Bitrix">{formatIst(bitrix.lastCheckedAt)}</SummaryRow>
                    <SummaryRow label="Last change received">{formatIst(bitrix.lastChangeAt)}</SummaryRow>
                    {bitrix.late ? <SummaryRow label="Bitrix update">{LATE_TEXT}</SummaryRow> : null}
                  </>
                ) : (
                  <SummaryRow label="Source">Test record (not from Bitrix)</SummaryRow>
                )}
              </SummaryList>
              {bitrix ? (
                <p className="m-0 flex gap-2 text-sm text-quiet">
                  <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
                  <span>Title, stage and salesperson come from Bitrix. Change them there.</span>
                </p>
              ) : null}
            </div>
          </details>
        </CardBody>
      </section>
    </Card>
  );
}
