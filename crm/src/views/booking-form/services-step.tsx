'use client';

import { BedDouble, CarFront, Check, Compass, Copy, FileText, Pencil, Plane, Plus, ShieldCheck, Trash2, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import type { BookingFormServiceItemView } from '@/modules/fulfilment/booking-form-contract';
import type { BookingFormVM } from '@/modules/fulfilment/booking-form-vm';
import { BOOKING_FORM_FIELD_ID, formatInr, isIsoDate, stayNights } from '@/modules/fulfilment/booking-form-model';
import type { ServiceType } from '@/modules/fulfilment/contracts';
import { dateText } from '../b11/book-fields';
import { useSectionForm } from '../b11/draft-sync';
import { ResultBox } from '../b11/form-kit';
import type { BookNowView } from '../b11/shapes';
import { ConfirmDialog } from './confirm-dialog';
import { editableOf } from './form-helpers';
import { EmptyInline, InlineNote, RowAmount, RowCard, RowMeta, RowTitle, SectionCard } from './parts';
import { ServiceEditorDrawer, type EditorDefaults } from './service-editor';
import { SERVICE_CHIPS, SERVICE_KIND_LABEL } from './service-labels';
import type { BookingFormActions } from './types';
import type { HotelOption, SearchAction } from './vn-types';

/*
 * Step 2 · Trip & services (approved preview): service chips, the hotel night
 * coverage line, one card per chosen service with compact rows, and the
 * editor drawer. Each drawer save is a real save of that service; removing a
 * service asks first. Chips are a view choice only (not stored): a chosen
 * service with no rows is flagged before submit, and a service with saved
 * rows cannot be hidden.
 */

export const SERVICE_ICON: Record<ServiceType, LucideIcon> = {
  hotel: BedDouble,
  transfer: CarFront,
  flight: Plane,
  activity: Compass,
  visa: FileText,
  passport: ShieldCheck,
};

type EditorState = {
  type: ServiceType;
  item: BookingFormServiceItemView | null;
  copyOf?: BookingFormServiceItemView | null;
  /** "Save and attach screenshot": the saved flight's id; the drawer reopens on it once the refreshed list has it. */
  savedId?: string;
} | null;

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const range = (a: string, b: string) => [dateText(a), b && b !== a ? dateText(b) : null].filter(Boolean).join(' – ') || 'Date not set';

export function RowFor({ item, estimatesVisible }: { item: BookingFormServiceItemView; estimatesVisible: boolean }) {
  const f = item.facts;
  const cost = estimatesVisible && item.estimate ? <RowAmount label="Our cost">{formatInr(item.estimate.totalPaise)}</RowAmount> : null;
  switch (item.serviceType) {
    case 'hotel': {
      const n = stayNights(str(f.checkIn), str(f.checkOut));
      const named = str(f.hotelName) || (str(f.preferences) ? `Preference: ${str(f.preferences)}` : 'Hotel not named');
      return (
        <>
          <RowTitle>
            {item.itemNo}. {named}
            {str(f.city) ? <span className="font-normal text-quiet"> · {str(f.city)}</span> : null}
          </RowTitle>
          <RowMeta>
            <span>{range(str(f.checkIn), str(f.checkOut))}</span>
            {n !== null ? <span>{n} {n === 1 ? 'night' : 'nights'}</span> : null}
          </RowMeta>
          <RowMeta>
            <span>{[str(f.roomType), str(f.mealPlan)].filter(Boolean).join(' · ') || 'Room details not set'}</span>
            <span>
              {str(f.rooms) || 0} rooms · {str(f.extraBeds) || 0} extra beds · {str(f.childrenWithoutBed) || 0} no bed
            </span>
          </RowMeta>
          {cost}
          {str(f.specialRequests) ? <p className="m-0 mt-[0.5rem] text-sm text-quiet">{str(f.specialRequests)}</p> : null}
        </>
      );
    }
    case 'transfer':
      return (
        <>
          <RowTitle>
            {str(f.quantity) || 1} × {str(f.vehicleType) || 'Vehicle not set'}
          </RowTitle>
          <RowMeta>
            <span>{range(str(f.date), str(f.endDate))}</span>
            {str(f.includedKms) ? <span>{str(f.includedKms)} km included</span> : null}
            {str(f.vendor) ? <span>{str(f.vendor)}</span> : null}
          </RowMeta>
          {str(f.route) || (str(f.pickup) && str(f.drop)) ? <div className="mt-[0.25rem] text-sm text-quiet">{str(f.route) || `${str(f.pickup)} to ${str(f.drop)}`}</div> : null}
          {cost}
          {str(f.notes) ? <p className="m-0 mt-[0.5rem] text-sm text-quiet">{str(f.notes)}</p> : null}
        </>
      );
    case 'flight': {
      const segs = Array.isArray(f.segments) ? (f.segments as Array<Record<string, unknown>>) : [];
      const first = segs[0] ?? {};
      return (
        <>
          <RowTitle>{segs.length > 0 ? segs.map((g) => `${str(g.from)} – ${str(g.to)}`).join(', ') : 'Flight not set'}</RowTitle>
          <RowMeta>
            <span>{dateText(str(first.date)) ?? 'Date not set'}</span>
            <span>{[str(first.airline), str(first.flightNo), str(f.cabin)].filter(Boolean).join(' · ')}</span>
          </RowMeta>
          {str(first.departTime) || str(first.arriveTime) ? (
            <RowMeta>
              <span>
                {str(first.departTime) || 'Time not set'} – {str(first.arriveTime) || 'Time not set'} (local)
              </span>
            </RowMeta>
          ) : null}
          {(item.files ?? []).length > 0 ? (
            <InlineNote icon={FileText} className="mt-[0.5rem]">
              {(item.files ?? []).map((x) => x.fileName).join(', ')}
            </InlineNote>
          ) : null}
          {cost}
        </>
      );
    }
    default: {
      const title = item.serviceType === 'activity' ? str(f.name) : item.serviceType === 'visa' ? [str(f.country), str(f.purpose)].filter(Boolean).join(' · ') : [str(f.applicationType), str(f.officeCity)].filter(Boolean).join(' · ');
      const date = item.serviceType === 'activity' ? str(f.date) : item.serviceType === 'visa' ? str(f.applyBy) || str(f.travelDate) : str(f.neededBy);
      const people = item.participants?.length ?? 0;
      return (
        <>
          <RowTitle>{title || item.summary || SERVICE_KIND_LABEL[item.serviceType]}</RowTitle>
          <RowMeta>
            {item.serviceType === 'activity' && str(f.city) ? <span>{str(f.city)}</span> : null}
            {isIsoDate(date) ? <span>{dateText(date)}</span> : null}
            {people > 0 ? <span>{people} {people === 1 ? 'passenger' : 'passengers'}</span> : null}
          </RowMeta>
          {str(f.notes) ? <p className="m-0 mt-[0.5rem] text-sm text-quiet">{str(f.notes)}</p> : null}
        </>
      );
    }
  }
}

export function ServicesStep({
  vm,
  view,
  actions,
  reloadHref,
  party,
  tripStart,
  tripEnd,
  searchHotels = null,
}: {
  vm: BookingFormVM;
  view: BookNowView;
  actions: Pick<BookingFormActions, 'saveService' | 'removeServiceItem' | 'uploadServiceFile' | 'removeServiceFile'>;
  reloadHref: string;
  /** Typed party (unsaved counts count). */
  party: { adults: number | null; total: number | null };
  tripStart: string;
  tripEnd: string;
  searchHotels?: SearchAction<HotelOption> | null;
}) {
  const editable = editableOf(view);
  const revision = Boolean(view.version?.revisesVersionId);
  const items = [...vm.items].sort((a, b) => a.itemNo - b.itemNo);
  const countFor = (t: ServiceType) => items.filter((i) => i.serviceType === t).length;
  const [selected, setSelected] = useState<ServiceType[]>(() => SERVICE_CHIPS.map((c) => c.type).filter((t) => items.some((i) => i.serviceType === t)));
  const [note, setNote] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [removeTarget, setRemoveTarget] = useState<BookingFormServiceItemView | null>(null);
  const estimatesVisible = view.commercials !== undefined || items.some((i) => i.estimate !== undefined);
  const budgetVisible = view.commercials !== undefined || items.some((i) => i.purchaseBudgetPaise !== undefined);
  const shown = SERVICE_CHIPS.filter((c) => selected.includes(c.type) || countFor(c.type) > 0);
  const hotels = items.filter((i) => i.serviceType === 'hotel');
  const lastCheckOut = hotels.map((h) => str(h.facts.checkOut)).filter(isIsoDate).sort().at(-1) ?? null;
  const defaults: EditorDefaults = { tripStart, tripEnd, adults: party.adults, total: party.total, lastCheckOut };
  const cov = vm.coverage;

  const remover = useSectionForm({
    id: 'services-remove',
    section: 'services',
    label: 'Remove service',
    order: 49,
    action: actions.removeServiceItem,
    initial: {},
    versionBound: true,
    rowVersion: view.version?.rowVersion ?? 0,
    saveable: false,
    tracksDirty: false,
  });
  const [removing, setRemoving] = useState(false);
  const confirmRemove = async () => {
    if (!removeTarget) return;
    setRemoving(true);
    const fd = new FormData();
    fd.set('dealId', view.dealId);
    fd.set('versionId', view.version?.versionId ?? '');
    fd.set('itemId', removeTarget.itemId);
    const r = await remover.post(fd);
    setRemoving(false);
    if (r.ok) setRemoveTarget(null);
  };

  const toggle = (t: ServiceType) => {
    if (selected.includes(t) && countFor(t) > 0) {
      setNote('Remove saved rows before hiding this service.');
      return;
    }
    setNote(null);
    setSelected((x) => (x.includes(t) ? x.filter((k) => k !== t) : [...x, t]));
  };
  const canChange = editable && !revision;

  return (
    <div className="flex flex-col gap-4.5 outline-none" id={BOOKING_FORM_FIELD_ID.services} tabIndex={-1}>
      {/* Old links to #hotels land here. */}
      <span id="hotels" />
      <div>
        <div role="group" aria-label="Choose services" className="mb-4.5 flex flex-wrap gap-2">
          {SERVICE_CHIPS.map(({ type, label }) => {
            const Icon = SERVICE_ICON[type];
            const on = selected.includes(type) || countFor(type) > 0;
            return (
              <button
                key={type}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(type)}
                disabled={!canChange && !on}
                className={cn(
                  'inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-control border border-line-strong bg-card px-3 py-2 font-medium text-copy',
                  'hover:border-quiet disabled:cursor-not-allowed disabled:opacity-60',
                  on && 'border-brand-line bg-brand-tint text-brand-deep',
                  focusRing,
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
                {label}
                {on ? <Check aria-hidden="true" className="size-3.5" /> : null}
              </button>
            );
          })}
        </div>
        <p role="status" className={note ? 'm-0 mb-3 text-sm text-copy' : 'sr-only'}>
          {note ?? ''}
        </p>
        {cov && cov.nights !== null && hotels.length > 0 ? (
          <InlineNote icon={BedDouble} role="status" className="pb-4">
            {cov.covered} / {cov.nights} tour nights covered
            {cov.missing.length > 0 ? ` · ${cov.missing.length} missing` : ''}
            {cov.outside.length > 0 ? ' · Check hotel dates' : ''}
          </InlineNote>
        ) : null}
        <div className="[&:has(>[role=status]:empty)]:hidden">
          <ResultBox result={remover.state} reloadHref={reloadHref} successText="Service removed." />
        </div>
        {shown.length === 0 ? (
          <Card>
            <div className="flex min-h-45 flex-col items-center justify-center gap-3 text-quiet">
              <Compass aria-hidden="true" className="size-6.5 text-faint" />
              <span>Choose the services this booking needs.</span>
            </div>
          </Card>
        ) : null}
      </div>
      {revision ? <InlineNote>While fixing a returned booking you can change services but not add or remove them.</InlineNote> : null}
      {shown.map(({ type, label, add, addEmpty }) => {
        const rows = items.filter((i) => i.serviceType === type);
        const Icon = SERVICE_ICON[type];
        return (
          <SectionCard
            key={type}
            id={`services-${type}`}
            title={label}
            icon={Icon}
            count={rows.length}
            action={
              canChange ? (
                <Button size="sm" onClick={() => setEditor({ type, item: null })}>
                  <Plus aria-hidden="true" />
                  {add}
                </Button>
              ) : null
            }
          >
            {rows.length === 0 ? (
              <EmptyInline
                text={`No ${label.toLowerCase()} added.`}
                action={
                  canChange ? (
                    <Button variant="ghost" size="sm" onClick={() => setEditor({ type, item: null })}>
                      {addEmpty}
                    </Button>
                  ) : null
                }
              />
            ) : (
              rows.map((item) => {
                const name = `${SERVICE_KIND_LABEL[type].toLowerCase()} ${item.itemNo}`;
                return (
                  <RowCard
                    key={item.itemId}
                    id={`bf-item-${item.itemId}`}
                    actions={
                      <>
                        <Button id={`svc-row-${item.itemId}-edit`} variant="ghost" size="sm" aria-label={`${editable ? 'Edit' : 'Details of'} ${name}`} onClick={() => setEditor({ type, item })}>
                          <Pencil aria-hidden="true" />
                        </Button>
                        {type === 'hotel' && canChange ? (
                          <Button variant="ghost" size="sm" aria-label={`Duplicate ${name}`} onClick={() => setEditor({ type, item: null, copyOf: item })}>
                            <Copy aria-hidden="true" />
                          </Button>
                        ) : null}
                        {canChange && !item.locked ? (
                          <Button variant="ghost" size="sm" aria-label={`Remove ${name}`} onClick={() => setRemoveTarget(item)}>
                            <Trash2 aria-hidden="true" />
                          </Button>
                        ) : null}
                      </>
                    }
                  >
                    <RowFor item={item} estimatesVisible={estimatesVisible} />
                  </RowCard>
                );
              })
            )}
          </SectionCard>
        );
      })}
      {editor && (!editor.savedId || items.some((i) => i.itemId === editor.savedId)) ? (
        <ServiceEditorDrawer
          key={`${editor.type}-${editor.savedId ?? editor.item?.itemId ?? 'new'}-${editor.copyOf?.itemId ?? ''}`}
          view={view}
          type={editor.type}
          // The saved item as the server sends it now (attached screenshots appear while the drawer is open).
          item={editor.savedId ? (items.find((i) => i.itemId === editor.savedId) ?? null) : editor.item ? (items.find((i) => i.itemId === editor.item!.itemId) ?? editor.item) : null}
          searchHotels={searchHotels}
          focusAttach={Boolean(editor.savedId)}
          onSavedAttach={(itemId) => setEditor({ type: editor.type, item: null, savedId: itemId })}
          copyOf={editor.copyOf ?? null}
          defaults={defaults}
          budgetVisible={budgetVisible}
          estimatesVisible={estimatesVisible}
          travellers={view.travellers}
          action={actions.saveService}
          fileActions={{ upload: actions.uploadServiceFile, remove: actions.removeServiceFile }}
          filesEditable={vm.itemFilesCanEdit}
          reloadHref={reloadHref}
          onClose={() => {
            const id = editor.savedId ?? editor.item?.itemId;
            const back = id ? `svc-row-${id}-edit` : `services-${editor.type}-heading`;
            setEditor(null);
            requestAnimationFrame(() => document.getElementById(back)?.focus());
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(o) => {
          if (!o) setRemoveTarget(null);
        }}
        title={`Remove this ${removeTarget ? (removeTarget.serviceType === 'hotel' ? 'hotel stay' : SERVICE_KIND_LABEL[removeTarget.serviceType].toLowerCase()) : 'service'}?`}
        description="It is removed from this booking draft now. Nothing is booked or cancelled with a supplier."
        confirmLabel="Remove"
        cancelLabel="Keep it"
        busy={removing}
        onConfirm={confirmRemove}
      >
        {remover.state && !remover.state.ok ? (
          <div className="px-5">
            <ResultBox result={remover.state} reloadHref={reloadHref} />
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
