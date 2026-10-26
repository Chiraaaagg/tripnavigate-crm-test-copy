'use client';

import { CircleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { TravellerChips, type ChipPerson } from '@/components/ui/traveller-chips';
import type { BookingFormServiceItemView } from '@/modules/fulfilment/booking-form-contract';
import { isIsoDate } from '@/modules/fulfilment/booking-form-model';
import type { BookTravellerView, ServiceType } from '@/modules/fulfilment/contracts';
import { AreaField, SelectField, TextField } from '../b11/controls';
import { useSectionForm } from '../b11/draft-sync';
import { newRequestId, type UiResult } from '../b11/form-kit';
import type { B11Action, BookNowView } from '../b11/shapes';
import { refusalReason, useSaveQueue } from './autosave-queue';
import { useFormToast } from './form-toast';
import { CarEditor } from './car-editor';
import { FlightEditor, type FlightEditorStart } from './flight-editor';
import { HotelEditor } from './hotel-editor';
import { str } from './service-model';
import { SERVICE_KIND_LABEL } from './service-labels';
import type { HotelOption, SearchAction } from './vn-types';

/*
 * Service drawers of step 2 (Book now v2, owner-approved prototype drawer()
 * and openEditor). One drawer per save: "Save …" becomes "Saving…" and is
 * disabled until the answer arrives, Enter inside a field never saves
 * (change 4), and an error re-checks itself on every change and goes away
 * once the value is valid (change 5). Every new service starts with all
 * named travellers chosen (change 6); passport starts with nobody. Saves run
 * through the page's save queue. Activity, visa and passport keep the live
 * fields the prototype shows; the visa "apply by" and passport "required
 * date" are no longer asked (kept on older items by the server).
 */

/** Escape inside an open list (airport, requests) closes the list, not the drawer (prototype). */
export function escapeClosesListFirst(e: KeyboardEvent) {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el.getAttribute('role') === 'combobox' && el.getAttribute('aria-expanded') === 'true') e.preventDefault();
}

/** What every editor gets from step 2. */
export interface EditorEnv {
  view: BookNowView;
  item: BookingFormServiceItemView | null;
  copyOf: BookingFormServiceItemView | null;
  editable: boolean;
  estimatesVisible: boolean;
  /** Named passengers (lead ruling D4). */
  people: ChipPerson[];
  /** "N travellers not named yet. Name them in step 1." or null. */
  unnamed: string | null;
  /** Typed party of step 1. */
  party: { total: number | null; children: number; infants: number };
  trip: { start: string; end: string };
  items: BookingFormServiceItemView[];
  travellers: BookTravellerView[];
  searchHotels: SearchAction<HotelOption> | null;
  /** A new item was saved and the drawer stays open on it (its files then show as stored). */
  bind: (itemId: string) => void;
  /** Saves one service (booking_service_save) through the page queue. */
  save: (build: (fd: FormData) => void, values: unknown) => Promise<UiResult>;
  /** Item files (flight screenshots). */
  fileActions: { upload: B11Action; remove: B11Action };
  filesEditable: boolean;
  onClose: () => void;
}

/** The drawer frame every service editor uses. */
export function EditorShell({
  title,
  description,
  saveLabel,
  editable,
  busy,
  problem,
  footerNote,
  onSave,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  saveLabel: string;
  editable: boolean;
  busy: boolean;
  /** The one error line at the bottom of the body (local check or the server's reason). */
  problem: string | null;
  footerNote?: ReactNode;
  /** The save; a second press while it runs is ignored (synchronous guard, change 4). */
  onSave: () => Promise<void> | void;
  onClose: () => void;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // The first field gets focus (prototype), not the close button.
    const t = requestAnimationFrame(() => {
      const el = [...(bodyRef.current?.querySelectorAll<HTMLElement>('input:not([type=hidden]):not([readonly]):not([type=file]):not([type=checkbox]), select, textarea') ?? [])].find((x) => x.offsetParent !== null);
      el?.focus();
    });
    return () => cancelAnimationFrame(t);
  }, []);
  useEffect(() => {
    if (problem) bodyRef.current?.querySelector('#svc-problem')?.scrollIntoView({ block: 'nearest' });
  }, [problem]);
  // Change 4: a synchronous in-flight flag, so a double press never sends twice (state updates arrive a render later).
  const inflight = useRef(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy || !editable || inflight.current) return;
    inflight.current = true;
    void Promise.resolve(onSave()).finally(() => {
      inflight.current = false;
    });
  };
  return (
    <Drawer
      open
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
    >
      <DrawerContent className="w-[min(42.5rem,100vw)] max-sm:rounded-none" closeLabel="Close without saving" onOpenAutoFocus={(e) => e.preventDefault()} onEscapeKeyDown={escapeClosesListFirst}>
        <form
          onSubmit={submit}
          onKeyDown={(e) => {
            // Change 4: Enter inside a field never saves the drawer.
            if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type !== 'submit') e.preventDefault();
          }}
          noValidate
          aria-label={title}
          className="flex min-h-full flex-col"
        >
          <DrawerHeader>
            <DrawerTitle className="m-0 text-lg font-semibold text-ink">{title}</DrawerTitle>
            <DrawerDescription className={description ? 'm-0 text-sm text-quiet' : 'sr-only'}>{description ?? `${title}. Nothing is booked here.`}</DrawerDescription>
          </DrawerHeader>
          <DrawerBody className="flex flex-col gap-4">
            <div ref={bodyRef} className="flex flex-col gap-4">
              {children}
              {problem ? (
                <div id="svc-problem" role="alert" className="flex scroll-mb-24 gap-2.5 rounded-control border border-status-danger-line bg-status-danger-tint px-3.5 py-3 text-sm text-status-danger-strong">
                  <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>{problem}</span>
                </div>
              ) : null}
            </div>
          </DrawerBody>
          <DrawerFooter className="sticky bottom-0 bg-card" data-drawer-footer="">
            <div className="flex items-center justify-end gap-2.5">
              <span className="flex-1 text-sm text-quiet">{footerNote}</span>
              <Button onClick={onClose} disabled={busy}>
                {editable ? 'Cancel' : 'Close'}
              </Button>
              {editable ? (
                <Button type="submit" variant="primary" disabled={busy} aria-busy={busy || undefined}>
                  {busy ? 'Saving…' : saveLabel}
                </Button>
              ) : null}
            </div>
          </DrawerFooter>
        </form>
      </DrawerContent>
    </Drawer>
  );
}

/** Live local check: shown after a save was pressed, then re-checked on every change (change 5). */
export function useLiveProblem(check: () => string) {
  const [shown, setShown] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const local = check();
  return {
    problem: (shown && local) || server,
    /** Run before saving: true when fine to send. */
    gate: () => {
      setServer(null);
      if (local) {
        setShown(true);
        return false;
      }
      setShown(false);
      return true;
    },
    setServer,
    clearServer: () => setServer(null),
  };
}

/** The chips line used by every editor. */
export function WhoChips({ env, label, value, onChange, single = false, error }: { env: EditorEnv; label: string; value: string[]; onChange: (v: string[]) => void; single?: boolean; error?: string | null }) {
  return <TravellerChips id="svc-who" label={label} people={env.people} selected={value} onChange={onChange} single={single} disabled={!env.editable} note={env.unnamed} error={error} />;
}

/** Hidden participant inputs. */
export function appendParticipants(fd: FormData, seqs: readonly string[]) {
  for (const s of [...seqs].map(Number).sort((a, b) => a - b)) fd.append('participantSeq', String(s));
}

export function appendRequests(fd: FormData, items: ReadonlyArray<{ text: string; forSeq: string }>) {
  for (const r of items) {
    fd.append('requestItemText', r.text);
    fd.append('requestItemFor', r.forSeq);
  }
}

const everyone = (env: EditorEnv) => env.people.map((p) => p.value);

/** Who is on the item: saved participants, or everyone named for a new one (passport: nobody). */
export function initialWho(env: EditorEnv, type: ServiceType): string[] {
  const src = env.item ?? env.copyOf;
  if (src) return (src.participants ?? []).map(String).filter((s) => env.people.some((p) => p.value === s));
  return type === 'passport' ? [] : everyone(env);
}

const PURPOSES = ['Tourism', 'Business', 'Visiting family', 'Transit'];
const FEE_OPTIONS = [
  { value: 'not_decided', label: 'Not decided yet' },
  { value: 'customer', label: 'Customer pays directly' },
  { value: 'company', label: 'Company pays (recorded for Accounts review)' },
];
const APPLICATION_TYPES = [
  { value: 'fresh', label: 'Fresh' },
  { value: 'renewal', label: 'Renewal' },
  { value: 'tatkaal', label: 'Tatkaal' },
  { value: 'minor', label: 'Minor' },
];

/** Activity, visa and passport (prototype: same fields as live, traveller chips added). */
function OtherEditor({ env, type }: { env: EditorEnv; type: 'activity' | 'visa' | 'passport' }) {
  const toast = useFormToast();
  const f = (env.item ?? env.copyOf)?.facts ?? null;
  const [v, setV] = useState(() => ({
    name: str(f?.name),
    city: str(type === 'passport' ? f?.officeCity : f?.city),
    date: str(type === 'visa' ? f?.travelDate : f?.date) || (type === 'visa' ? env.trip.start : ''),
    country: str(f?.country),
    purpose: str(f?.purpose) || 'Tourism',
    feePaidBy: str(f?.feePaidBy) || 'not_decided',
    applicationType: str(f?.applicationType) || 'fresh',
    notes: str(f?.notes),
    who: initialWho(env, type),
  }));
  const set = <K extends keyof typeof v>(k: K, x: (typeof v)[K]) => setV((s) => ({ ...s, [k]: x }));
  const [busy, setBusy] = useState(false);
  const live = useLiveProblem(() =>
    type === 'activity' && (!v.name.trim() || !v.city.trim() || !isIsoDate(v.date))
      ? 'Add the activity, city and date.'
      : type === 'visa' && (!v.country.trim() || !isIsoDate(v.date))
        ? 'Add the country and the planned travel date.'
        : type === 'passport' && !v.city.trim()
          ? 'Add the passport office city.'
          : '',
  );
  const save = async () => {
    if (!live.gate()) return;
    setBusy(true);
    const r = await env.save((fd) => {
      if (type === 'activity') {
        fd.set('name', v.name.trim());
        fd.set('city', v.city.trim());
        fd.set('date', v.date);
        // Activity people come from the chosen travellers (fallback: the party).
        fd.set('participants', String(v.who.length || env.party.total || 1));
      } else if (type === 'visa') {
        fd.set('country', v.country.trim());
        fd.set('purpose', v.purpose);
        fd.set('travelDate', v.date);
        fd.set('feePaidBy', v.feePaidBy);
      } else {
        fd.set('applicationType', v.applicationType);
        fd.set('officeCity', v.city.trim());
      }
      fd.set('notes', v.notes);
      appendParticipants(fd, v.who);
    }, v);
    setBusy(false);
    if (r.ok) {
      toast(type === 'activity' ? 'Activity saved.' : 'Requirements saved.');
      env.onClose();
    } else live.setServer(refusalReason(r));
  };
  const isNew = !env.item;
  const title = type === 'activity' ? (isNew ? 'Add activity' : 'Edit activity') : type === 'visa' ? 'Visa requirements' : 'Passport requirements';
  return (
    <EditorShell title={title} saveLabel={type === 'activity' ? 'Save activity' : 'Save requirements'} editable={env.editable} busy={busy} problem={live.problem} onSave={save} onClose={env.onClose}>
      <div className="grid grid-cols-1 gap-4 min-[381px]:grid-cols-2">
        {type === 'activity' ? (
          <>
            <TextField id="svc-name" name="name" label="Activity" value={v.name} onChange={(x) => set('name', x)} maxLength={200} disabled={!env.editable} />
            <TextField id="svc-city" name="city" label="City / location" value={v.city} onChange={(x) => set('city', x)} maxLength={120} disabled={!env.editable} />
            <TextField id="svc-date" name="date" label="Required date" type="date" value={v.date} onChange={(x) => set('date', x)} disabled={!env.editable} />
          </>
        ) : type === 'visa' ? (
          <>
            <SelectField id="svc-purpose" name="purpose" label="Visa type" value={v.purpose} onChange={(x) => set('purpose', x)} options={[...PURPOSES, ...(PURPOSES.includes(v.purpose) ? [] : [v.purpose])].map((p) => ({ value: p, label: p }))} disabled={!env.editable} />
            <TextField id="svc-country" name="country" label="Country" value={v.country} onChange={(x) => set('country', x)} maxLength={120} disabled={!env.editable} />
            <TextField id="svc-travelDate" name="travelDate" label="Planned travel date" type="date" value={v.date} onChange={(x) => set('date', x)} disabled={!env.editable} />
            <SelectField id="svc-feePaidBy" name="feePaidBy" label="Government fee paid by" value={v.feePaidBy} onChange={(x) => set('feePaidBy', x)} options={FEE_OPTIONS} disabled={!env.editable} />
          </>
        ) : (
          <>
            <SelectField id="svc-applicationType" name="applicationType" label="Application type" value={v.applicationType} onChange={(x) => set('applicationType', x)} options={APPLICATION_TYPES} disabled={!env.editable} />
            <TextField id="svc-officeCity" name="officeCity" label="City / location" hint="The passport office city." value={v.city} onChange={(x) => set('city', x)} maxLength={120} disabled={!env.editable} />
          </>
        )}
      </div>
      <WhoChips env={env} label={type === 'passport' ? 'Applicant' : type === 'activity' ? 'Who takes part' : 'Who needs a visa'} value={v.who} onChange={(x) => set('who', x)} single={type === 'passport'} />
      <AreaField id="svc-notes" name="notes" label="Requirements" optional rows={3} maxLength={2000} value={v.notes} onChange={(x) => set('notes', x)} disabled={!env.editable} />
    </EditorShell>
  );
}

export interface ServiceEditorProps {
  view: BookNowView;
  type: ServiceType;
  item: BookingFormServiceItemView | null;
  copyOf: BookingFormServiceItemView | null;
  /** Flight only: "Add next flight" / "Add return flights" start values and banner. */
  flightStart?: FlightEditorStart | null;
  estimatesVisible: boolean;
  people: ChipPerson[];
  unnamed: string | null;
  party: EditorEnv['party'];
  trip: EditorEnv['trip'];
  items: BookingFormServiceItemView[];
  searchHotels: SearchAction<HotelOption> | null;
  action: B11Action;
  fileActions: { upload: B11Action; remove: B11Action };
  filesEditable: boolean;
  onClose: () => void;
  onBound: (itemId: string) => void;
}

/** One drawer for one service; the section form keeps the drawer's own row version and request id. */
export function ServiceEditorDrawer(p: ServiceEditorProps) {
  const queue = useSaveQueue();
  const editable = p.view.canEdit && p.view.version?.status === 'draft' && !p.view.dealNotActive && !(p.item?.locked ?? false);
  // An exact retry after an unknown outcome reuses its request id, so the database replays it
  // (draft-sync keys the id on the form values, which this drawer passes too late; the key here is the posted form).
  const lastSend = useRef<{ key: string; id: string; unknown: boolean } | null>(null);
  const action = useCallback(
    async (prev: never, fd: FormData) => {
      const key = [...fd.entries()]
        .filter(([k]) => k !== 'requestId')
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : `${v.name}:${v.size}`}`)
        .join('&');
      const last = lastSend.current;
      const id = last && last.unknown && last.key === key ? last.id : newRequestId();
      fd.set('requestId', id);
      lastSend.current = { key, id, unknown: true };
      const r = await (p.action as (prev: never, fd: FormData) => Promise<{ ok: boolean; code?: string }>)(prev, fd);
      lastSend.current = { key, id, unknown: !r.ok && r.code === 'unexpected' };
      return r;
    },
    [p.action],
  );
  // Stable for the drawer's life (a new item bound after its first save keeps the same form).
  const [formId] = useState(() => (p.item ? `svc-${p.item.itemId}` : `svc-new-${p.type}`));
  const [formLabel] = useState(() => (p.item ? `${SERVICE_KIND_LABEL[p.type]} ${p.item.itemNo}` : `New ${SERVICE_KIND_LABEL[p.type].toLowerCase()}`));
  const f = useSectionForm<unknown>({
    id: formId,
    section: 'services',
    label: formLabel,
    order: 40,
    action: action as B11Action,
    initial: null,
    versionBound: true,
    rowVersion: p.view.version?.rowVersion ?? 0,
    saveable: false,
    tracksDirty: false,
  });
  const { setValues, post } = f;
  const env: EditorEnv = {
    view: p.view,
    item: p.item,
    copyOf: p.copyOf,
    editable,
    estimatesVisible: p.estimatesVisible,
    people: p.people,
    unnamed: p.unnamed,
    party: p.party,
    trip: p.trip,
    items: p.items,
    travellers: p.view.travellers,
    searchHotels: p.searchHotels,
    fileActions: p.fileActions,
    filesEditable: p.filesEditable,
    onClose: p.onClose,
    bind: p.onBound,
    save: (build, values) =>
      queue.run(() => {
        const fd = new FormData();
        fd.set('dealId', p.view.dealId);
        fd.set('versionId', p.view.version?.versionId ?? '');
        fd.set('rowVersion', String(f.base));
        // A fresh id is set when sent; an exact retry after an unknown outcome keeps it (draft-sync).
        fd.set('requestId', newRequestId());
        fd.set('serviceType', p.type);
        if (p.item) fd.set('itemId', p.item.itemId);
        build(fd);
        setValues(values);
        return post(fd);
      }),
  };
  if (p.type === 'hotel') return <HotelEditor env={env} />;
  if (p.type === 'transfer') return <CarEditor env={env} />;
  if (p.type === 'flight') return <FlightEditor env={env} start={p.flightStart ?? null} />;
  return <OtherEditor env={env} type={p.type} />;
}
