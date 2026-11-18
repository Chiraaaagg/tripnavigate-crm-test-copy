'use client';

import { ImageIcon, Plus, RefreshCw } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { Submit } from '@/views/accounts/supplier-forms';
import { formatIst } from '../deal-labels';
import { FF, type FlightWorkActions } from './actions';
import { ChangeStatusBadge } from './bits';
import { bySchedule, legLine, plural, sectorLine, shortDate, sizeText } from './format';
import { ActionForm } from './kit';
import { CHANGE_KIND_LABEL } from './labels';
import { checkSector, EMPTY_SECTOR, SectorFields, type SectorDraft, type SectorKey } from './sector-fields';
import type { BookingDiff, DealKind, DiffLeg, FlightChange, WorkspaceFlight } from './types';

/* ---------------- Booking changed (decision 6, contract 8) ---------------- */

function diffLeg(l: DiffLeg): string {
  return legLine({ date: l.date, airline: l.airline, flightNo: l.flightNo, from: l.from, to: l.to, departTime: l.departTime, arriveTime: l.arriveTime });
}

export function BookingChangedCard({ f, diff, canWork, action }: { f: WorkspaceFlight; diff: BookingDiff; canWork: boolean; action: FlightWorkActions['applyBookingChange'] }) {
  const id = `booking-changed-${f.taskId}`;
  const L = diff.legs;
  const P = diff.passengers;
  const I = diff.impact;
  const legItems = [
    ...L.unchanged.map((u, i) => ({ key: `u${i}`, word: 'Unchanged', text: u.leg ? diffLeg(u.leg) : `Leg ${u.oldLegNo} stays (now leg ${u.newLegNo})` })),
    ...L.changed.map((c, i) => ({ key: `c${i}`, word: 'Changed', text: `${diffLeg(c.old)} → ${diffLeg(c.new)}` })),
    ...L.removed.map((r, i) => ({ key: `r${i}`, word: 'Removed', text: diffLeg(r.old) })),
    ...L.added.map((a, i) => ({ key: `a${i}`, word: 'Added', text: diffLeg(a.new) })),
  ];
  const paxItems = [
    ...P.added.map((p) => `Added: ${p.name}`),
    ...P.removed.map((p) => `Removed: ${p.name}`),
    ...P.renamed.map((p) => `Renamed: ${p.oldName} → ${p.newName}${p.oldType !== p.newType ? ` (${p.oldType} → ${p.newType})` : ''}`),
  ];
  const impact = [
    I.ticketsOnRemoved ? `${plural(I.ticketsOnRemoved, 'ticket')} on removed or changed flights stay in the history; those travellers need new tickets.` : null,
    I.ticketsOfRemovedTravellers ? `${plural(I.ticketsOfRemovedTravellers, 'ticket')} of removed travellers stay in the history.` : null,
    I.ticketsRenamed ? `${plural(I.ticketsRenamed, 'ticket')} carry an old name; correct them after applying.` : null,
    I.pendingChangesSuperseded ? `${plural(I.pendingChangesSuperseded, 'change')} waiting for a decision will be replaced.` : null,
    I.approvedChangesOnChangedLegs.length ? `Check approved change ${I.approvedChangesOnChangedLegs.map((c) => c.changeNo).join(', ')}: its flight changed in the booking.` : null,
  ].filter(Boolean) as string[];
  return (
    <Card id={id} tabIndex={-1} className="border-status-warning-line">
      <section aria-labelledby={`${id}-title`}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={`${id}-title`} className="flex items-center gap-2">
              <RefreshCw aria-hidden="true" className="size-4 text-status-warning" />
              Booking changed · {f.title}
            </CardTitle>
            <CardDescription>
              Sales sent booking version {diff.toVersionNo ?? f.currentVersionNo}
              {diff.fromVersionNo ?? f.basisVersionNo ? ` (you are working on version ${diff.fromVersionNo ?? f.basisVersionNo})` : ''}. Unchanged flights keep their tickets.
            </CardDescription>
          </div>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          {legItems.length ? (
            <section aria-label="Flights in the new booking">
              <h3 className="m-0 mb-1.5 text-sm font-semibold text-ink">Flights</h3>
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                {legItems.map((l) => (
                  <li key={l.key} className="m-0 flex flex-wrap gap-x-2">
                    <span className={cn('font-semibold', l.word === 'Unchanged' ? 'text-quiet' : 'text-ink')}>{l.word}:</span>
                    <span className="wrap-anywhere">{l.text}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {paxItems.length ? (
            <section aria-label="Traveller changes">
              <h3 className="m-0 mb-1.5 text-sm font-semibold text-ink">Travellers</h3>
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                {paxItems.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {diff.otherFields.length ? <p className="m-0 text-sm">Other details changed: {diff.otherFields.join(', ')}.</p> : null}
          {impact.length ? (
            <Notice tone="warning" title="What applying does">
              {impact.map((t) => (
                <p key={t}>{t}</p>
              ))}
            </Notice>
          ) : null}
          {canWork ? (
            <ActionForm
              action={action}
              fields={{ [FF.taskId]: f.taskId, [FF.expectedBasisVersionId]: diff.fromVersionId, [FF.targetVersionId]: diff.toVersionId }}
              label={`Apply the new booking to ${f.title}`}
              className="flex flex-col items-start gap-2"
            >
              {(state) => (state?.ok ? null : <Submit label="Apply the new booking" pendingLabel="Applying…" />)}
            </ActionForm>
          ) : (
            <p className="m-0 text-sm text-quiet">The Flight colleague on these flights applies it.</p>
          )}
        </CardBody>
      </section>
    </Card>
  );
}

/* ---------------- Screenshot sectors (decision 11) ---------------- */

export function ScreenshotSectorsCard({ f, canWork, blockedReason, action }: { f: WorkspaceFlight; canWork: boolean; blockedReason: string | null; action: FlightWorkActions['saveScreenshotSectors'] }) {
  const base = useId();
  const existing = f.sectors.filter((s) => s.origin === 'screenshot' && s.status === 'active').sort(bySchedule);
  const editable = canWork && !blockedReason && existing.every((s) => s.canEditScreenshot);
  const [rows, setRows] = useState<Array<SectorDraft & { sectorId: string | null }>>(() =>
    existing.length
      ? existing.map((s) => ({ sectorId: s.sectorId, departDate: shortDate(s.departDate), flightNo: s.flightNo ?? '', from: s.from, to: s.to, departTime: s.departTime ?? '', arriveTime: s.arriveTime ?? '', arriveDate: s.arriveDate && s.arriveDate !== s.departDate ? shortDate(s.arriveDate) : '', airline: s.airline ?? '', cabin: s.cabin ?? 'Economy' }))
      : [{ ...EMPTY_SECTOR, sectorId: null }],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const checked = rows.map((r) => checkSector(r));
  const payload = JSON.stringify(checked.every((c) => c.value) ? checked.map((c, i) => ({ sectorId: rows[i]!.sectorId, ...c.value })) : []);
  const id = `screenshot-${f.taskId}`;
  return (
    <Card id={id}>
      <section aria-labelledby={`${id}-title`}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={`${id}-title`} className="flex items-center gap-2">
              <ImageIcon aria-hidden="true" className="size-4 text-faint" />
              Sectors from the screenshot · {f.title}
            </CardTitle>
            <CardDescription>Type each flight from what Sales attached. Entering what Sales attached needs no approval.</CardDescription>
          </div>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-2">
              <h3 className="m-0 text-sm font-semibold text-ink">Screenshots</h3>
              {f.screenshots.length ? (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm">
                  {f.screenshots.map((s) => (
                    <li key={s.fileId} className="m-0 wrap-anywhere">
                      {s.href ? (
                        <a href={s.href} target="_blank" rel="noopener" className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4', focusRing)}>
                          {s.fileName}
                          <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                      ) : (
                        s.fileName
                      )}{' '}
                      <span className="text-quiet">{sizeText(s.sizeBytes)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 text-sm text-quiet">No screenshot is attached to this flight.</p>
              )}
              {f.screenshotNote ? <p className="m-0 text-sm">Note from Sales: {f.screenshotNote}</p> : null}
            </div>
            {editable ? (
              <ActionForm
                action={action}
                fields={{ [FF.taskId]: f.taskId, [FF.expectedRowVersion]: f.stateRowVersion ?? 0, [FF.payload]: payload }}
                label={`Save sectors of ${f.title}`}
                onSubmit={(e) => {
                  const errs: Record<string, string> = {};
                  checked.forEach((c, i) => {
                    const k = Object.keys(c.errors)[0] as SectorKey | undefined;
                    if (k) errs[`${i}-${k}`] = c.errors[k]!;
                  });
                  setErrors(errs);
                  const first = Object.keys(errs)[0];
                  if (first) {
                    e.preventDefault();
                    document.getElementById(`${base}-${first}`)?.focus();
                  }
                }}
              >
                {rows.map((r, i) => (
                  <div key={i} className="flex flex-col gap-2 rounded-control border border-line p-3">
                    <div className="flex items-center justify-between">
                      <h3 className="m-0 text-sm font-semibold text-ink">Sector {i + 1}</h3>
                      {rows.length > 1 ? (
                        <Button size="sm" variant="ghost" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>
                          Remove<span className="sr-only"> sector {i + 1}</span>
                        </Button>
                      ) : null}
                    </div>
                    <SectorFields
                      value={r}
                      onChange={(next) => setRows((x) => x.map((y, j) => (j === i ? { ...next, sectorId: y.sectorId } : y)))}
                      errors={Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith(`${i}-`)).map(([k, v]) => [k.slice(String(i).length + 1), v]))}
                      idBase={`${base}-${i}`}
                      legend={`Sector ${i + 1}`}
                    />
                  </div>
                ))}
                <div className="flex flex-wrap gap-2">
                  {rows.length < 8 ? (
                    <Button size="sm" variant="secondary" onClick={() => setRows((x) => [...x, { ...EMPTY_SECTOR, sectorId: null }])}>
                      <Plus aria-hidden="true" />
                      Add a sector
                    </Button>
                  ) : null}
                  <Submit label="Save sectors" pendingLabel="Saving…" variant="secondary" />
                </div>
              </ActionForm>
            ) : existing.length ? (
              <div className="flex flex-col gap-1 text-sm">
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {existing.map((s) => (
                    <li key={s.sectorId}>{sectorLine(s)}</li>
                  ))}
                </ul>
                {canWork ? <p className="m-0 text-quiet">{blockedReason ?? 'Read-only: a ticket is confirmed on these sectors.'}</p> : null}
              </div>
            ) : (
              <p className="m-0 text-sm text-quiet">The Flight colleague on these flights types the sectors.</p>
            )}
          </div>
        </CardBody>
      </section>
    </Card>
  );
}

/* ---------------- Changes waiting / decided ---------------- */

function deciderWordOf(c: FlightChange): string {
  if (c.deciderKind === 'flight_owner') return 'you';
  return c.deciderName ? `${c.deciderName} (${c.deciderKind === 'sales_owner' ? 'Sales' : 'Manager'})` : c.deciderKind === 'sales_owner' ? 'Sales' : 'the Manager';
}

export function ChangesCard({ f, dealKind, canWork, actions }: { f: WorkspaceFlight; dealKind: DealKind; canWork: boolean; actions: FlightWorkActions }) {
  const shown = f.changes.filter((c) => c.status === 'pending' || c.status === 'rejected' || c.needsAck || c.status === 'approved').sort((a, b) => b.changeNo - a.changeNo);
  if (shown.length === 0) return null;
  const sectorById = new Map(f.sectors.map((s) => [s.sectorId, s]));
  const line = (ids: string[]) => ids.map((i) => sectorById.get(i)).filter(Boolean).map((s) => sectorLine(s!));
  const id = `changes-${f.taskId}`;
  return (
    <Card id={id}>
      <section aria-labelledby={`${id}-title`}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={`${id}-title`}>Flight changes · {f.title}</CardTitle>
            <CardDescription>{dealKind === 'package' ? 'The Sales owner decides each change on the Deal page.' : 'Flight-only Deal: changes apply when you save them.'}</CardDescription>
          </div>
        </CardHeader>
        <ol className="m-0 flex list-none flex-col divide-y divide-line p-0" aria-label={`Flight changes of ${f.title}`}>
          {shown.map((c) => (
            <li key={c.changeId} className="m-0 flex flex-col gap-2 px-4.5 py-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">
                  Change {c.changeNo} · {CHANGE_KIND_LABEL[c.kind]}
                </span>
                <ChangeStatusBadge status={c.status} waitingFor={c.status === 'pending' ? deciderWordOf(c) : undefined} />
              </div>
              <p className="m-0 text-sm">Travellers: {c.travellers.map((t) => t.name ?? `Traveller ${t.seq}`).join(', ')}</p>
              {c.fromSectorIds.length ? <p className="m-0 text-sm">From: {line(c.fromSectorIds).join('; ') || '—'}</p> : null}
              <p className="m-0 text-sm">To: {line(c.newSectorIds).join('; ') || '—'}</p>
              <p className="m-0 text-sm text-quiet">
                Remark: {c.remark} · sent {formatIst(c.requestedAt)}
                {c.requestedByName ? ` by ${c.requestedByName}` : ''}
                {c.decidedAt ? ` · decided ${formatIst(c.decidedAt)}${c.decidedByName ? ` by ${c.decidedByName}` : ''}` : ''}
              </p>
              {c.rejectReason ? <p className="m-0 text-sm">Reason for rejecting: {c.rejectReason}. The travellers are back on their previous flight.</p> : null}
              {canWork && c.canWithdraw && c.status === 'pending' ? (
                <ActionForm action={actions.withdrawChange} fields={{ [FF.changeId]: c.changeId, [FF.expectedRowVersion]: c.rowVersion }} label={`Withdraw change ${c.changeNo}`} className="flex flex-col items-start gap-2">
                  {(state) => (state?.ok ? null : <Submit label="Withdraw" pendingLabel="Withdrawing…" variant="secondary" />)}
                </ActionForm>
              ) : null}
              {canWork && c.needsAck ? (
                <ActionForm action={actions.acknowledgeChange} fields={{ [FF.changeId]: c.changeId }} label={`Mark the decision on change ${c.changeNo} as seen`} className="flex flex-col items-start gap-2">
                  {(state) => (state?.ok ? null : <Submit label="OK, seen" pendingLabel="Saving…" variant="secondary" />)}
                </ActionForm>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </Card>
  );
}
