'use client';

import { CircleHelp, Globe2, MapPinned, Search } from 'lucide-react';
import { useState, useTransition } from 'react';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChoiceGroup, Radio } from '@/components/ui/choice';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { controlClass } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/components/ui/cn';
import { TRIP_SCOPE_LABEL, type TripScope } from '@/modules/fulfilment/contracts';
import { dateText } from '../b11/book-fields';
import { AreaField } from '../b11/controls';
import { newRequestId, ResultBox, useB11Action, type UiResult } from '../b11/form-kit';
import type { B11Action } from '../b11/shapes';
import type { DestinationClassRow } from '../booking-form/vn-types';

/*
 * Settings · Bitrix connection · Destinations (voice-note batch, owner answer
 * 3): a Super Admin marks each Bitrix destination option once as Domestic or
 * International, with a reason (audited). Bookings then take Domestic or
 * International from the Deal's destination; an option that is not set is
 * asked once on the booking. Nothing is guessed from the name. Same change
 * flow as the other switches: choose, reason, review, confirm.
 */

type Choice = TripScope | '';
const LOOK: Record<'domestic' | 'international' | 'unset', { word: string; tone: StatusTone; icon: typeof Globe2 }> = {
  domestic: { word: 'Domestic', tone: 'info', icon: MapPinned },
  international: { word: 'International', tone: 'brand', icon: Globe2 },
  unset: { word: 'Not set', tone: 'warning', icon: CircleHelp },
};

function ScopeBadge({ scope }: { scope: TripScope | null }) {
  const look = LOOK[scope ?? 'unset'];
  return (
    <StatusBadge tone={look.tone} icon={look.icon}>
      {look.word}
    </StatusBadge>
  );
}

const choiceWord = (c: Choice) => (c === '' ? 'Not set' : TRIP_SCOPE_LABEL[c]);

export function DestinationClassesCard({ rows, canEdit, action }: { rows: DestinationClassRow[] | null; canEdit: boolean; action: B11Action }) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<DestinationClassRow | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const list = (rows ?? []).filter((r) => !q || r.label.toLowerCase().includes(q)).sort((a, b) => Number(a.scope !== null) - Number(b.scope !== null) || a.label.localeCompare(b.label));
  const unset = (rows ?? []).filter((r) => r.scope === null).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Destinations: domestic or international</CardTitle>
        <CardDescription>Bookings take this from the Deal&rsquo;s destination. A destination not set here is asked once on the booking.</CardDescription>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        {rows === null ? (
          <Notice tone="warning" title="The destination list could not be read">
            <p>Nothing was changed. It is read from Bitrix while the Bitrix trip details switch is on.</p>
          </Notice>
        ) : rows.length === 0 ? (
          <p className="m-0 text-quiet">No Bitrix destinations read yet. They appear after the next Bitrix name update while the trip details switch is on.</p>
        ) : (
          <>
            <p role="status" className="m-0 text-sm text-copy">
              {saved ?? (unset > 0 ? `${unset} of ${rows.length} destinations not set yet.` : `All ${rows.length} destinations are set.`)}
            </p>
            {rows.length > 8 ? (
              <div className="relative max-w-sm">
                <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.75 size-4 -translate-y-1/2 text-quiet" />
                <input type="search" aria-label="Find a destination" placeholder="Find a destination" value={query} onChange={(e) => setQuery(e.target.value)} className={cn(controlClass, 'pl-8.5')} />
              </div>
            ) : null}
            <Table label="Bitrix destinations" stackOnMobile>
              <TableCaption>{list.length === rows.length ? `${rows.length} destinations, not set first` : `${list.length} of ${rows.length} destinations`}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Destination</TableHead>
                  <TableHead>Set as</TableHead>
                  <TableHead>Last change</TableHead>
                  {canEdit ? <TableHead>Change</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((r) => (
                  <TableRow key={`${r.source}-${r.optionId}`}>
                    <TableCell label="Destination">
                      <span className="font-medium text-ink">{r.label}</span>
                      <span className="block text-sm text-quiet">{r.source === 'single' ? 'Destination field' : 'Destinations (multiple) field'}</span>
                    </TableCell>
                    <TableCell label="Set as">
                      <ScopeBadge scope={r.scope} />
                    </TableCell>
                    <TableCell label="Last change">
                      {r.at ? (
                        <span className="text-sm">
                          {dateText(r.at)}
                          {r.byName ? ` · ${r.byName}` : ''}
                          {r.reason ? <span className="block text-quiet">{r.reason}</span> : null}
                        </span>
                      ) : (
                        <span className="text-sm text-quiet">Never set</span>
                      )}
                    </TableCell>
                    {canEdit ? (
                      <TableCell label="Change">
                        <Button
                          id={`dest-${r.source}-${r.optionId}`}
                          size="sm"
                          className="min-h-10"
                          onClick={() => {
                            setSaved(null);
                            setEditing(r);
                          }}
                        >
                          Change<span className="sr-only"> {r.label}</span>
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
        {!canEdit && rows && rows.length > 0 ? <p className="m-0 text-sm text-quiet">Only a Super Admin can change these.</p> : null}
      </CardBody>
      {editing ? (
        <ChangeDialog
          key={`${editing.source}-${editing.optionId}`}
          row={editing}
          action={action}
          onClose={(text) => {
            const back = `dest-${editing.source}-${editing.optionId}`;
            setEditing(null);
            if (text) setSaved(text);
            requestAnimationFrame(() => document.getElementById(back)?.focus());
          }}
        />
      ) : null}
    </Card>
  );
}

function ChangeDialog({ row, action, onClose }: { row: DestinationClassRow; action: B11Action; onClose: (savedText: string | null) => void }) {
  const [step, setStep] = useState<'choose' | 'review'>('choose');
  const [choice, setChoice] = useState<Choice>(row.scope ?? '');
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  const [state, formAction] = useB11Action(action);
  const [pending, start] = useTransition();
  const [requestId] = useState(() => newRequestId());
  const [seen, setSeen] = useState<UiResult | null>(null);
  if (state !== seen) {
    setSeen(state);
    if (state?.ok) onClose(`${row.label} is now ${choiceWord(choice)}.`);
    else if (state && ((state as { fields?: string[] }).fields ?? []).includes('reason')) setStep('choose');
  }
  const same = choice === (row.scope ?? '');
  const len = reason.trim().length;
  const reasonRefused = Boolean(state && !state.ok && ((state as { fields?: string[] }).fields ?? []).includes('reason'));
  const reasonError = local ?? (reasonRefused ? 'Type a reason of 10 to 500 characters.' : null);
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose(null);
      }}
    >
      <DialogContent closeLabel="Close without changing">
        <DialogHeader>
          <DialogTitle>{step === 'choose' ? `Change ${row.label}` : 'Review change'}</DialogTitle>
          <DialogDescription>{step === 'choose' ? `Now: ${choiceWord(row.scope ?? '')}.` : 'Nothing changes until you confirm.'}</DialogDescription>
        </DialogHeader>
        {step === 'choose' ? (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (same) {
                setLocal(null);
                return;
              }
              if (len < 10 || len > 500) {
                setLocal('Type a reason of 10 to 500 characters.');
                requestAnimationFrame(() => document.getElementById('dest-reason')?.focus());
                return;
              }
              setLocal(null);
              setStep('review');
            }}
          >
            <DialogBody className="flex flex-col gap-4">
              <ChoiceGroup id="dest-scope" legend="Set as" hint={same ? 'Choose a different value to change it.' : undefined}>
                {(['domestic', 'international', ''] as const).map((c) => (
                  <Radio key={c || 'unset'} id={`dest-scope-${c || 'unset'}`} name="scope" value={c} label={choiceWord(c)} description={c === '' ? 'Staff choose on each booking.' : undefined} checked={choice === c} onChange={() => setChoice(c)} />
                ))}
              </ChoiceGroup>
              <AreaField id="dest-reason" name="reason" label="Reason" hint="10 to 500 characters. Changing this in the live CRM needs the owner’s approval first; write it here." rows={3} maxLength={500} value={reason} onChange={setReason} error={reasonError} />
              <ResultBox result={state && !state.ok && !reasonRefused ? state : null} />
            </DialogBody>
            <DialogFooter>
              <Button onClick={() => onClose(null)}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={same}>
                Review change
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData();
              fd.set('optionId', row.optionId);
              fd.set('listId', row.source === 'single' ? 'DEAL_DESTINATION' : 'DEAL_DESTINATION_MULTI');
              fd.set('scope', choice);
              fd.set('reason', reason.trim());
              fd.set('rowVersion', String(row.rowVersion));
              fd.set('requestId', requestId);
              start(() => formAction(fd));
            }}
          >
            <DialogBody className="flex flex-col gap-3">
              <SummaryList>
                <SummaryRow label="Destination">{row.label}</SummaryRow>
                <SummaryRow label="Change">
                  {choiceWord(row.scope ?? '')} to {choiceWord(choice)}
                </SummaryRow>
                <SummaryRow label="Reason">{reason.trim()}</SummaryRow>
              </SummaryList>
              <p className="m-0 text-sm text-quiet">{choice === '' ? 'Bookings to this destination ask staff to choose.' : `Bookings to this destination become ${choiceWord(choice)}; staff are not asked.`}</p>
              <ResultBox result={state && !state.ok ? state : null} />
            </DialogBody>
            <DialogFooter>
              <Button onClick={() => setStep('choose')}>Back</Button>
              <Button type="submit" variant="primary" loading={pending}>
                {pending ? 'Saving…' : 'Confirm change'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
