import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatIst } from '../deal-labels';
import { bySchedule, flightLabel, routeText, shortDate, timeRange } from './format';
import { SECTOR_STATE_LABEL } from './labels';
import type { FlightWorkspace } from './types';

/*
 * "Flight sector history" (prototype sectorHistoryCard): every sector the
 * flights ever had, including replaced, rejected, withdrawn and removed ones,
 * with who travels on it and the change remark. No amounts for anyone
 * (fixes FV:800 vs FV:2208).
 */

export function SectorHistoryCard({ ws }: { ws: FlightWorkspace }) {
  const rows = ws.flights.flatMap((f) => f.sectors.map((s) => ({ f, s, ch: s.changeId ? f.changes.find((c) => c.changeId === s.changeId) : undefined })));
  rows.sort((a, b) => bySchedule(a.s, b.s));
  const name = (seq: number) => ws.flights.flatMap((f) => f.travellers).find((t) => t.seq === seq)?.fullName ?? `Traveller ${seq}`;
  return (
    <Card>
      <section aria-labelledby="sector-history-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="sector-history-heading">Flight sector history</CardTitle>
            <CardDescription>Every flight these travellers had, with its outcome. No amounts are shown here.</CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          {rows.length === 0 ? (
            <p className="m-0 text-copy">No sectors yet.</p>
          ) : (
            <Table label="Every flight and its outcome" stackOnMobile className="text-sm">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Flight</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Date and time</TableHead>
                  <TableHead>Travellers</TableHead>
                  <TableHead>Remark</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Changed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ f, s, ch }) => (
                  <TableRow key={s.sectorId} className="align-top">
                    <TableCell label="Flight">
                      {flightLabel(s.airline, s.flightNo)}
                      <span className="block text-quiet">{f.title}</span>
                    </TableCell>
                    <TableCell label="Route">{routeText(s.from, s.to)}</TableCell>
                    <TableCell label="Date and time" className="whitespace-nowrap">
                      {shortDate(s.departDate)} · {timeRange(s.departTime, s.arriveTime)}
                    </TableCell>
                    <TableCell label="Travellers">
                      {[...s.travellers.map((t) => name(t.seq)), ...s.endedTravellers.map((t) => `${name(t.seq)} (left)`)].join(', ') || '—'}
                    </TableCell>
                    <TableCell label="Remark">{ch?.remark ?? (s.origin === 'booking' ? 'From the booking' : s.origin === 'screenshot' ? 'Typed from the screenshot' : '—')}</TableCell>
                    <TableCell label="Outcome">
                      {SECTOR_STATE_LABEL[s.displayState]}
                      {ch?.rejectReason ? <span className="block text-quiet">Reason: {ch.rejectReason}</span> : null}
                    </TableCell>
                    <TableCell label="Changed">{ch?.decidedAt ? formatIst(ch.decidedAt) : ch ? formatIst(ch.requestedAt) : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardBody>
      </section>
    </Card>
  );
}
