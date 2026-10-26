'use client';

import { ChevronLeft, CircleCheck, FileText, Pencil, UsersRound, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, useTransition, type FormEvent } from 'react';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { NotEntered, SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs } from '@/components/ui/tabs';
import { GST_STATES, dateText } from '../b11/book-fields';
import { AreaField } from '../b11/controls';
import { newRequestId, ResultBox, useB11Action, type FieldRef, type UiResult } from '../b11/form-kit';
import { PARTY_ERROR_TEXT, PartyFields, partyProblems, PartyTypeSwitch, partyValuesOf, type PartyValues } from '../booking-form/party-fields';
import { PARTY_STATUS_LABEL, type PartyCheckActions, type PartyCheckDetail, type PartyCheckFilter, type PartyCheckRow, type PartyCheckStatus } from '../booking-form/vn-types';

/*
 * Accounts · Customers to check (voice-note batch, owner item 10). Stored
 * customers (Bill To parties) start "Not checked"; Accounts checks them here
 * inside the CRM, edits them where needed (an edit sets the customer back to
 * Not checked) or returns them to Sales with a reason. Nothing is checked
 * automatically and the existing billing check on each booking stays as it
 * is. Status is always in words with an icon, never colour alone.
 */

const STATUS_TONE: Record<PartyCheckStatus, StatusTone> = { not_checked: 'warning', checked: 'success', returned: 'danger' };

export function PartyStatusBadge({ status }: { status: PartyCheckStatus }) {
  return <StatusBadge tone={STATUS_TONE[status]}>{PARTY_STATUS_LABEL[status]}</StatusBadge>;
}

const EMPTY_TEXT: Record<PartyCheckFilter, { title: string; text: string }> = {
  not_checked: { title: 'No customers to check', text: 'New and imported customers appear here until Accounts checks them.' },
  returned: { title: 'No returned customers', text: 'Customers you return to Sales with a reason appear here until they are fixed.' },
  checked: { title: 'No checked customers yet', text: 'Customers you check appear here.' },
};

export function CustomersToCheckView({
  items,
  filters,
  nextHref,
}: {
  /** null = the list could not be read (never shown as empty). */
  items: PartyCheckRow[] | null;
  filters: Array<{ key: PartyCheckFilter; label: string; href: string; count: number | null; current: boolean }>;
  nextHref: string | null;
}) {
  const current = filters.find((f) => f.current)?.key ?? 'not_checked';
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader eyebrow="Accounts" title="Customers to check" description="Check new and imported customers before they are used for billing." className="mb-3" />
      <Tabs label="Customer check status" className="mb-4" items={filters.map((f) => ({ href: f.href, label: f.label, current: f.current, count: f.count ?? undefined }))} />
      {items === null ? (
        <Notice tone="warning" title="The customer list could not be read">
          <p>Nothing was changed. Reload the page; if it keeps happening, tell a Super Admin.</p>
        </Notice>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState icon={UsersRound} headingLevel={2} title={EMPTY_TEXT[current].title} description={EMPTY_TEXT[current].text} />
        </Card>
      ) : (
        <Card>
          <Table label="Customers" stackOnMobile>
            <TableCaption>
              {items.length} {items.length === 1 ? 'customer' : 'customers'}
              {nextHref ? ' on this page' : ''}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>GST</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((p) => (
                <TableRow key={p.partyId}>
                  <TableCell label="Customer">
                    <Link href={p.href} className={cn('font-semibold text-brand-strong underline-offset-4 hover:underline', focusRing)}>
                      {p.name}
                      <span className="sr-only"> (open the customer check)</span>
                    </Link>
                    <span className="block text-sm text-quiet">{[p.type === 'business' ? 'Business' : 'Personal', p.place].filter(Boolean).join(' · ')}</span>
                  </TableCell>
                  <TableCell label="Contact">{p.contactLine ?? <NotEntered />}</TableCell>
                  <TableCell label="GST">{p.gstLine ?? (p.type === 'business' ? <NotEntered /> : '—')}</TableCell>
                  <TableCell label="Source">
                    <span className="block">{p.sourceLabel ?? 'Added in the CRM'}</span>
                    <span className="block text-sm text-quiet">
                      {dateText(p.addedAt)}
                      {p.addedByName ? ` · ${p.addedByName}` : ''}
                    </span>
                  </TableCell>
                  <TableCell label="Status">
                    <PartyStatusBadge status={p.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {nextHref ? (
        <p className="m-0 mt-4">
          <Link href={nextHref} className={cn('font-medium text-brand-strong underline underline-offset-4', focusRing)}>
            Show more customers
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/** Posts a FormData by hand (React's form reset would blank controlled selects after a refusal). */
function useManual(action: Parameters<typeof useB11Action>[0]) {
  const [state, formAction] = useB11Action(action);
  const [pending, start] = useTransition();
  const send = (fd: FormData) => start(() => formAction(fd));
  return { state, send, pending };
}

export function CustomerCheckView({
  party,
  backHref,
  canEdit,
  canCheck,
  checkBlockedReason,
  actions,
}: {
  party: PartyCheckDetail;
  backHref: string;
  canEdit: boolean;
  canCheck: boolean;
  /** Why this person may not check (words), when canCheck is false. */
  checkBlockedReason: string | null;
  actions: PartyCheckActions;
}) {
  const [editing, setEditing] = useState(false);
  const [returning, setReturning] = useState(false);
  const check = useManual(actions.check);
  const requestId = useRef(newRequestId());
  const business = party.type === 'business';
  const stateName = GST_STATES.find((s) => s.code === party.stateCode)?.name ?? party.stateCode;
  const checked = party.checkStatus === 'checked';
  const base = (fd: FormData) => {
    fd.set('partyId', party.partyId);
    fd.set('partyRowVersion', String(party.rowVersion));
    fd.set('requestId', requestId.current);
    requestId.current = newRequestId();
    return fd;
  };
  return (
    <div className="font-sans text-base text-copy">
      <p className="m-0 mb-3">
        <Link href={backHref} className={cn('inline-flex items-center gap-1 rounded-chip text-sm font-medium text-brand-strong no-underline hover:underline', focusRing)}>
          <ChevronLeft aria-hidden="true" className="size-4" />
          Customers to check
        </Link>
      </p>
      <PageHeader
        eyebrow="Accounts · Customer check"
        title={party.name}
        status={
          <>
            <PartyStatusBadge status={party.checkStatus} />
            <span>{business ? 'Business' : 'Personal'}</span>
            {party.sourceLabel ? <span>· {party.sourceLabel}</span> : null}
            {checked && party.checkedByName ? (
              <span>
                · Checked by {party.checkedByName}
                {party.checkedAt ? ` on ${dateText(party.checkedAt)}` : ''}
              </span>
            ) : null}
          </>
        }
        actions={
          canCheck && !checked && !editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                check.send(base(new FormData()));
              }}
            >
              <Button type="submit" variant="primary" size="lg" loading={check.pending}>
                <CircleCheck aria-hidden="true" />
                {check.pending ? 'Saving…' : 'Mark as checked'}
              </Button>
            </form>
          ) : null
        }
      />
      <div className="flex flex-col gap-4.5">
        <ResultBox result={check.state} successText="Customer checked." className="[&:empty]:hidden" />
        {party.checkStatus === 'returned' && party.returnedReason ? (
          <Notice tone="warning" title="Returned to Sales">
            <p>{party.returnedReason}</p>
          </Notice>
        ) : null}
        {!canCheck && checkBlockedReason && !checked ? <Notice tone="locked">{checkBlockedReason}</Notice> : null}

        <Card>
          <section aria-labelledby="pc-details-heading" className="p-5 max-sm:p-4">
            <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
              <h2 id="pc-details-heading" className="m-0 text-lg font-semibold text-ink">
                Details
              </h2>
              {canEdit && !editing ? (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" className="min-h-10" onClick={() => setEditing(true)}>
                    <Pencil aria-hidden="true" />
                    Edit details
                  </Button>
                  {canCheck && party.checkStatus !== 'returned' ? (
                    <Button size="sm" className="min-h-10" onClick={() => setReturning(true)}>
                      <Undo2 aria-hidden="true" />
                      Return with reason
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
            {editing ? (
              <EditPartyForm party={party} action={actions.save} base={base} onDone={() => setEditing(false)} />
            ) : (
              <SummaryList>
                {business ? <SummaryRow label="Contact name">{party.contactPerson ?? <NotEntered />}</SummaryRow> : null}
                <SummaryRow label="Phone · Email">{[party.phone, party.email].filter(Boolean).join(' · ') || <NotEntered />}</SummaryRow>
                <SummaryRow label="Address">{[party.addressLine1, party.addressLine2, party.city, stateName, party.postalCode, 'India'].filter(Boolean).join(', ') || <NotEntered />}</SummaryRow>
                {business ? (
                  <SummaryRow label="GST registration">
                    {party.gstStatus === 'registered' ? `GST registered · ${party.gstin ?? ''}` : party.gstStatus === 'unregistered' ? `Not GST registered · ${party.gstReason ?? ''}` : <NotEntered />}
                  </SummaryRow>
                ) : null}
                <SummaryRow label="Files">
                  {party.files.length === 0 ? (
                    <NotEntered>No files</NotEntered>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {party.files.map((f) => (
                        <li key={f.fileId}>
                          <a href={f.downloadHref} rel="noopener" className={cn('inline-flex items-center gap-1.5 font-medium text-brand-strong underline underline-offset-4', focusRing)}>
                            <FileText aria-hidden="true" className="size-3.5" />
                            {f.fileName}
                          </a>
                          <span className="text-sm text-quiet">
                            {' '}
                            · {f.kind === 'id_proof' ? 'ID proof' : f.kind === 'gst_certificate' ? 'GST certificate' : 'Other'} · {f.sizeLabel}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </SummaryRow>
                {party.usedOn.length > 0 ? (
                  <SummaryRow label="Used on">
                    {party.usedOn.map((u, i) => (
                      <span key={u.reference}>
                        {i > 0 ? ', ' : ''}
                        {u.href ? (
                          <Link href={u.href} className={cn('text-brand-strong underline underline-offset-4', focusRing)}>
                            {u.reference}
                          </Link>
                        ) : (
                          u.reference
                        )}
                      </span>
                    ))}
                  </SummaryRow>
                ) : null}
              </SummaryList>
            )}
            {editing ? null : <p className="m-0 mt-3.5 text-sm text-quiet">GSTIN: format and state checked only. Bookings keep their own copy of the billing details.</p>}
          </section>
        </Card>

        {party.history.length > 0 ? (
          <Card>
            <section aria-labelledby="pc-history-heading" className="p-5 max-sm:p-4">
              <h2 id="pc-history-heading" className="m-0 mb-3 text-lg font-semibold text-ink">
                History
              </h2>
              <ol className="m-0 flex list-none flex-col gap-2 p-0">
                {party.history.map((h, i) => (
                  <li key={`${h.at}-${i}`} className="text-sm">
                    <span className="text-quiet">
                      {dateText(h.at)}
                      {h.byName ? ` · ${h.byName}` : ''}:
                    </span>{' '}
                    {h.text}
                  </li>
                ))}
              </ol>
            </section>
          </Card>
        ) : null}
      </div>
      <ReturnDialog open={returning} onOpenChange={setReturning} action={actions.returnParty} base={base} name={party.name} />
    </div>
  );
}

function EditPartyForm({ party, action, base, onDone }: { party: PartyCheckDetail; action: PartyCheckActions['save']; base: (fd: FormData) => FormData; onDone: () => void }) {
  const [v, setV] = useState<PartyValues>(() => partyValuesOf(party));
  const [problems, setProblems] = useState<Array<{ field: string; text: string }>>([]);
  const save = useManual(action);
  const [seen, setSeen] = useState<UiResult | null>(null);
  if (save.state !== seen) {
    setSeen(save.state);
    if (save.state?.ok) onDone();
  }
  const set = <K extends keyof PartyValues>(k: K, x: PartyValues[K]) => setV((s) => ({ ...s, [k]: x }));
  const refused = save.state && !save.state.ok ? ((save.state as { fields?: string[] }).fields ?? []) : [];
  const err = (field: string) => problems.find((p) => p.field === field)?.text ?? (refused.includes(field) ? (PARTY_ERROR_TEXT[field] ?? 'Check this field.') : null);
  const refs: FieldRef[] = Object.keys(PARTY_ERROR_TEXT).map((k) => ({ field: k, id: `ac-${k}`, label: PARTY_ERROR_TEXT[k]! }));
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const found = partyProblems(v);
    setProblems(found);
    if (found.length > 0) {
      requestAnimationFrame(() => document.getElementById(`ac-${found[0]!.field}`)?.focus());
      return;
    }
    save.send(base(new FormData(e.currentTarget)));
  };
  return (
    <form onSubmit={submit} noValidate aria-label="Edit customer details" className="flex flex-col gap-4">
      <ResultBox result={save.state && !save.state.ok ? save.state : null} fields={refs} />
      <PartyTypeSwitch id="ac-type" value={v.type} onChange={(t) => set('type', t)} />
      <PartyFields v={v} set={set} err={err} idPrefix="ac" />
      <Notice tone="info">Saving changes sets this customer back to Not checked. Check it again after.</Notice>
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" loading={save.pending}>
          {save.pending ? 'Saving…' : 'Save details'}
        </Button>
      </div>
    </form>
  );
}

function ReturnDialog({ open, onOpenChange, action, base, name }: { open: boolean; onOpenChange: (o: boolean) => void; action: PartyCheckActions['returnParty']; base: (fd: FormData) => FormData; name: string }) {
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  const ret = useManual(action);
  const [seen, setSeen] = useState<UiResult | null>(null);
  if (ret.state !== seen) {
    setSeen(ret.state);
    if (ret.state?.ok) onOpenChange(false);
  }
  const len = reason.trim().length;
  const refused = ret.state && !ret.state.ok && ((ret.state as { fields?: string[] }).fields ?? []).includes('reason');
  const error = local ?? (refused ? 'Write the reason in 10 to 500 characters.' : null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel="Close without returning">
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (len < 10 || len > 500) {
              setLocal('Write the reason in 10 to 500 characters, so Sales knows what to fix.');
              requestAnimationFrame(() => document.getElementById('pc-return-reason')?.focus());
              return;
            }
            setLocal(null);
            const fd = base(new FormData());
            fd.set('reason', reason.trim());
            ret.send(fd);
          }}
        >
          <DialogHeader>
            <DialogTitle>Return {name} to Sales?</DialogTitle>
            <DialogDescription>Sales sees the reason and fixes the details. The customer cannot be used for billing until then.</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            <ResultBox result={ret.state && !ret.state.ok && !refused ? ret.state : null} />
            <AreaField id="pc-return-reason" name="reason" label="Reason" hint="10 to 500 characters." rows={3} maxLength={500} value={reason} onChange={setReason} error={error} />
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Keep it</Button>
            <Button type="submit" variant="primary" loading={ret.pending}>
              {ret.pending ? 'Returning…' : 'Return to Sales'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
