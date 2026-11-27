import { Image as ImageIcon, Plane, UserX } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { budgetText } from '../department/task-frame';
import { flightLabel, inr, plural, shortDate, sizeText } from './format';
import { PAX_LABEL } from './labels';
import type { FlightMoney, FlightWorkspace, WorkspaceFlight } from './types';

/*
 * Details tab (contract 11.1, prototype flightDetails FV:1088): per flight
 * the booked legs, cabin and Sales' notes; the screenshot block (assignee and
 * Manager); the real travellers by name for the Flight team (F-04 retired),
 * identity for the assignee on international trips; "N travellers not named
 * yet"; the approved budget and where it came from. Counts are per flight
 * (that flight's participants), never the Deal's party counts (fixes FV:1096).
 */

const dl = 'm-0 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(7rem,11rem)_1fr]';

const BUDGET_SOURCE: Record<'typed' | 'estimate' | 'none', string> = {
  typed: 'Budget typed by Sales',
  estimate: 'From the Sales fare estimate × travellers on this flight',
  none: 'No budget set: every fare set needs the Manager’s approval',
};

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-sm font-medium text-quiet">{term}</dt>
      <dd className="m-0 text-ink wrap-break-word">{children}</dd>
    </>
  );
}

function FlightBlock({ f, money }: { f: WorkspaceFlight; money: FlightMoney | null }) {
  const b = f.booked;
  const budget = money?.budget.tasks.find((t) => t.taskId === f.taskId);
  const counts = (['adult', 'child', 'infant'] as const).map((t) => [t, f.travellers.filter((p) => p.type === t).length] as const).filter(([, n]) => n > 0);
  const headingId = `flight-details-${f.taskId}`;
  return (
    <Card>
      <section aria-labelledby={headingId}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={headingId}>{f.title}</CardTitle>
            <CardDescription>
              Flight {f.itemNo} · {f.entryMode === 'screenshot' ? 'From screenshot' : plural(b.legs.length, 'leg')} · booking version {f.currentVersionNo}
            </CardDescription>
          </div>
          <Plane aria-hidden="true" className="size-4 text-faint" />
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          {b.legs.length > 0 ? (
            <Table label={`Booked legs of ${f.title}`} stackOnMobile className="text-sm">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Date</TableHead>
                  <TableHead>Flight</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Dep</TableHead>
                  <TableHead>Arr</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {b.legs.map((l) => (
                  <TableRow key={l.legNo}>
                    <TableCell label="Date" className="whitespace-nowrap">
                      {shortDate(l.date)}
                    </TableCell>
                    <TableCell label="Flight">{flightLabel(l.airline, l.flightNo)}</TableCell>
                    <TableCell label="From">{l.from}</TableCell>
                    <TableCell label="To">{l.to}</TableCell>
                    <TableCell label="Dep">{l.departTime ?? '—'}</TableCell>
                    <TableCell label="Arr">
                      {l.arriveTime ?? '—'}
                      {l.arrivalDate && l.arrivalDate !== l.date ? <span className="block text-quiet">{shortDate(l.arrivalDate)}</span> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          {f.entryMode === 'screenshot' ? (
            <div className="rounded-control border border-line bg-wash px-3.5 py-3 text-sm text-copy">
              <p className="m-0 flex items-center gap-2 font-semibold text-ink">
                <ImageIcon aria-hidden="true" className="size-4" />
                From screenshot
              </p>
              <p className="m-0">Sales attached the chosen flight or fare quote instead of typing it. Type the sectors from it on the Work tab before ticketing.</p>
              {f.screenshotNote ? <p className="m-0 mt-[0.25rem]">Note for the Flight team: {f.screenshotNote}</p> : null}
              {f.screenshots.length > 0 ? (
                <ul className="m-0 mt-[0.5rem] flex list-none flex-col gap-1 p-0" aria-label="Flight screenshots">
                  {f.screenshots.map((s) => (
                    <li key={s.fileId} className="m-0 flex flex-wrap gap-x-2 wrap-anywhere">
                      {s.href ? (
                        <a href={s.href} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4', focusRing)}>
                          {s.fileName}
                        </a>
                      ) : (
                        <span className="font-medium">{s.fileName}</span>
                      )}
                      <span className="text-quiet">{sizeText(s.sizeBytes)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 mt-[0.25rem] text-quiet">The screenshots are shown to the Flight colleague who takes these flights and to the branch Manager.</p>
              )}
            </div>
          ) : null}
          <dl className={dl}>
            <Row term="Cabin">{b.cabin ?? 'Not given'}</Row>
            {b.preferredTime ? <Row term="Preferred time">{b.preferredTime}</Row> : null}
            {b.preferences ? <Row term="Preferences">{b.preferences}</Row> : null}
            {b.assistance ? <Row term="Assistance">{b.assistance}</Row> : null}
            {b.notes ? <Row term="Notes from Sales">{b.notes}</Row> : null}
            <Row term="Travellers on this flight">{counts.length ? counts.map(([t, n]) => `${n} ${PAX_LABEL[t].toLowerCase()}${n === 1 ? '' : 's'}`).join(', ') : 'None named yet'}</Row>
            {f.salesFare ? <Row term="Sales fare given"><SalesFare fare={f.salesFare} /></Row> : null}
            {money ? (
              <Row term="Approved budget">
                {budgetText(budget?.budgetPaise ?? null)}
                <span className="block text-sm text-quiet">{BUDGET_SOURCE[budget?.source ?? 'none']}</span>
              </Row>
            ) : null}
          </dl>
          <div className="flex flex-col gap-2">
            <h3 className="m-0 text-base font-semibold text-ink">Travellers on {f.title}</h3>
            {f.unnamedCount > 0 ? (
              <Notice tone="warning" icon={UserX} role="status">
                <p>
                  {plural(f.unnamedCount, 'traveller')} not named yet. Sales has been told; they cannot get a ticket until Sales names them in the booking.
                </p>
              </Notice>
            ) : null}
            {f.travellers.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label={`Travellers on ${f.title}`}>
                {f.travellers.map((t) => (
                  <li key={t.seq} className="m-0 text-copy">
                    {t.fullName} <span className="text-sm text-quiet">({PAX_LABEL[t.type]}{t.ageYears !== null ? `, ${t.ageYears}` : ''})</span>
                    {t.specialNeeds ? <span className="block text-sm text-quiet">Needs: {t.specialNeeds}</span> : null}
                    {t.identity ? (
                      <span className="block text-sm text-copy">
                        Born {t.identity.dateOfBirth ?? 'not given'} · {t.identity.nationality ?? 'nationality not given'} · passport {t.identity.passportNumber ?? 'not given yet'}
                        {t.identity.passportExpiry ? `, expires ${t.identity.passportExpiry}` : ''}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-sm text-quiet">No traveller is named on this flight yet.</p>
            )}
          </div>
        </CardBody>
      </section>
    </Card>
  );
}

/** Sales' fare estimate × this flight's travellers per type (fixes FV:1096: never the Deal's party counts). */
function SalesFare({ fare }: { fare: NonNullable<WorkspaceFlight['salesFare']> }) {
  const rows = (
    [
      ['Adult', fare.adultPaise, fare.adults],
      ['Child', fare.childPaise, fare.children],
      ['Infant', fare.infantPaise, fare.infants],
    ] as const
  ).filter(([, p, n]) => p !== null && n > 0);
  if (rows.length === 0) return <span className="text-quiet">Not priced</span>;
  const total = rows.reduce((sum, [, p, n]) => sum + BigInt(p!) * BigInt(n), 0n);
  return (
    <span className="flex flex-col tabular-nums">
      {rows.map(([label, p, n]) => (
        <span key={label}>
          {label} {inr(p)} × {n} = {inr((BigInt(p!) * BigInt(n)).toString())}
        </span>
      ))}
      <span className="font-semibold">Total {inr(total.toString())}</span>
      <span className="text-sm text-quiet">
        {fare.source === 'item' ? 'This flight’s estimate' : 'The booking’s fare for all flights'}. An estimate of our cost only; not a price.
      </span>
    </span>
  );
}

export function FlightDetailsTab({ ws, idProofs, money }: { ws: FlightWorkspace; idProofs?: ReactNode; money: FlightMoney | null }) {
  return (
    <div className="flex flex-col gap-5">
      {ws.flights.map((f) => (
        <FlightBlock key={f.taskId} f={f} money={money} />
      ))}
      <Card>
        <section aria-labelledby="flight-origin-heading">
          <CardHeader>
            <CardTitle id="flight-origin-heading">Where this came from</CardTitle>
          </CardHeader>
          <CardBody>
            <dl className={dl}>
              <Row term="Deal">{ws.dealReference}</Row>
              <Row term="Branch">{ws.branchName}</Row>
              <Row term="Kind of Deal">{ws.dealKind === 'package' ? 'Package (changes need the Sales owner’s approval)' : 'Flight only (the Flight owner decides changes)'}</Row>
              {money ? <Row term="Approved budget (all flights)">{budgetText(money.budget.dealPaise)}</Row> : null}
            </dl>
          </CardBody>
        </section>
      </Card>
      {idProofs}
    </div>
  );
}
