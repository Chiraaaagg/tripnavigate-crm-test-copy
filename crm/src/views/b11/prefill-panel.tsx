'use client';

import { CircleCheck, Download, Info, PenLine } from 'lucide-react';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Notice } from '@/components/ui/notice';
import { PREFILL_TEXT, type PrefillFieldCode, type PrefillFieldView, type PrefillTargetKind, type PrefillView } from '@/modules/fulfilment/contracts';
import { PREFILL_FIELD } from '@/modules/fulfilment/b11-forms';
import { dateText } from './book-fields';
import { BaseRowVersion, useSectionForm } from './draft-sync';
import { PendingButton, ResultBox } from './form-kit';
import type { B11Action } from './shapes';

/*
 * "From Bitrix" (B1.2 prefill, DEC-36) on Book now steps 1 and 2 and on the
 * quotation editor: what Bitrix holds for this Lead or Deal, one click to use
 * a value (the database copies its own snapshot; nothing comes from the
 * browser), and "Mark checked" for values filled from Bitrix. Booking Notes
 * are reference only, or said to be hidden (never "empty"); Customer Type is
 * a label that never sets who the booking is for. Warnings never block.
 */

/**
 * DEC-45: Bitrix Customer Type (B2D, Corporate, Travel agent) means a business
 * booking. The database offers it as the field "contacts.bookingFor" (value
 * "business"; null when Bitrix has no known Customer Type).
 * Still one click by staff, marked "From Bitrix — check it" until checked.
 */
export const BOOKING_FOR_PREFILL: PrefillFieldCode = 'contacts.bookingFor';

/** The hint mark on a form field filled from Bitrix and not checked yet (words, not colour alone). */
export function prefillHint(prefill: PrefillView | null | undefined, code: PrefillFieldCode, hint?: ReactNode): ReactNode {
  const row = prefill?.fields.find((f) => f.field === code);
  if (!row || row.state !== 'from_bitrix') return hint;
  return (
    <>
      {/* Copy BP-02 / DA-160: the "From Bitrix" tag, then the check line. */}
      <span className="font-semibold text-status-info">From Bitrix.</span> Check with the customer.
      {hint ? <> {hint}</> : null}
    </>
  );
}

interface PanelProps {
  prefill: PrefillView | null | undefined;
  target: PrefillTargetKind;
  versionId: string;
  /** Booking target only. */
  dealId?: string;
  rowVersion: number;
  editable: boolean;
  useAction?: B11Action;
  checkAction?: B11Action;
  /** The field codes this panel offers (a step shows its own). */
  codes: readonly PrefillFieldCode[];
  /** Booking Notes, Customer Type and traveller total (first panel only). */
  showReference?: boolean;
  idPrefix: string;
  reloadHref?: string;
}

function PrefillForm({ p, kind, codes, label, srLabel, variant, order }: { p: PanelProps; kind: 'use' | 'check'; codes: PrefillFieldCode[]; label: string; /** Field name for screen readers when the visible label is short. */ srLabel?: string; variant: 'primary' | 'secondary' | 'ghost'; order: number }) {
  const action = (kind === 'use' ? p.useAction : p.checkAction)!;
  const f = useSectionForm({
    id: `${p.idPrefix}-prefill-${kind}-${codes.join('-')}`,
    section: p.target === 'booking_version' ? (codes.some((c) => c.startsWith('trip.')) ? 'trip' : 'customer') : 'contact',
    label,
    order,
    action,
    initial: {},
    versionBound: true,
    rowVersion: p.rowVersion,
    saveable: false,
    tracksDirty: false,
  });
  const { bindForm, bindResult } = f;
  return (
    <form ref={bindForm} action={f.formAction} noValidate className="flex flex-col gap-2">
      <div ref={bindResult}>
        <ResultBox result={f.state} reloadHref={p.reloadHref} />
      </div>
      <input type="hidden" name={PREFILL_FIELD.target} value={p.target} />
      <input type="hidden" name="versionId" value={p.versionId} />
      {p.dealId ? <input type="hidden" name="dealId" value={p.dealId} /> : null}
      <BaseRowVersion base={f.base} />
      {codes.map((c) => (
        <input key={c} type="hidden" name={PREFILL_FIELD.field} value={c} />
      ))}
      <div>
        <PendingButton pendingLabel={kind === 'use' ? 'Filling…' : 'Marking…'} variant={variant} className="min-h-11">
          {label}
          {srLabel ? <span className="sr-only"> for {srLabel}</span> : null}
        </PendingButton>
      </div>
    </form>
  );
}

function valueText(row: PrefillFieldView, customerTypeLabel: string | null): string {
  if (row.bitrixValue === null) return 'Bitrix has nothing here';
  if (row.field === BOOKING_FOR_PREFILL) return row.bitrixValue === 'business' ? `A business (GST)${customerTypeLabel ? `, from Customer Type ${customerTypeLabel}` : ''}` : row.bitrixValue;
  return row.field.startsWith('trip.') ? (dateText(row.bitrixValue) ?? row.bitrixValue) : row.bitrixValue;
}

function StateBadge({ row }: { row: PrefillFieldView }) {
  if (!row.state) return null;
  if (row.state === 'from_bitrix')
    return (
      <StatusBadge tone="info" icon={Download} wrap>
        From Bitrix — check
      </StatusBadge>
    );
  if (row.state === 'checked')
    return (
      <StatusBadge tone="success" icon={CircleCheck} wrap>
        {row.stateText ?? 'Checked'}
      </StatusBadge>
    );
  return (
    <StatusBadge tone="neutral" icon={PenLine} wrap>
      {row.stateText ?? 'Changed by staff'}
    </StatusBadge>
  );
}

export function PrefillPanel(p: PanelProps) {
  const pre = p.prefill;
  if (!pre) return null;
  const headingId = `${p.idPrefix}-prefill-heading`;
  const rows = pre.fields.filter((f) => p.codes.includes(f.field));
  const usable = rows.filter((r) => r.canUse).map((r) => r.field);
  const checkable = rows.filter((r) => r.canMarkChecked).map((r) => r.field);
  const canAct = p.editable && Boolean(p.useAction && p.checkAction);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-card border border-status-info-line bg-status-info-tint px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={headingId} className="m-0 text-base font-semibold text-ink">
          {PREFILL_TEXT.title}
        </h3>
        {pre.available && pre.lastVerifiedAt ? (
          <p className="m-0 text-sm text-quiet">
            Read from Bitrix {dateText(pre.lastVerifiedAt)}
            {pre.sourceModifiedAt ? ` · last changed in Bitrix ${dateText(pre.sourceModifiedAt)}` : ''}
          </p>
        ) : null}
      </div>
      {!pre.available ? (
        <p className="m-0 flex gap-2 text-copy">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-info" />
          {PREFILL_TEXT.unavailable}
        </p>
      ) : (
        <>
          {pre.issues.length > 0 ? <Notice tone="warning">Some Bitrix values could not be read cleanly. Check every value before you use it.</Notice> : null}
          {p.showReference ? (
            <dl className="m-0 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
              <dt className="font-semibold text-quiet">Booking Notes</dt>
              <dd className="m-0 whitespace-pre-line text-copy">{pre.notesHidden ? PREFILL_TEXT.notesHidden : pre.bookingNotes ? pre.bookingNotes : 'No Booking Notes in Bitrix.'}</dd>
              {pre.customerTypeLabel ? (
                <>
                  <dt className="font-semibold text-quiet">Customer Type</dt>
                  <dd className="m-0 text-copy">
                    {pre.customerTypeLabel}{' '}
                    <span className="text-quiet">
                      ·{' '}
                      {pre.fields.some((f) => f.field === BOOKING_FOR_PREFILL && f.bitrixValue === 'business') ? PREFILL_TEXT.customerTypeNote : 'For reference.'}
                    </span>
                  </dd>
                </>
              ) : null}
              {pre.travellerTotal !== null ? (
                <>
                  <dt className="font-semibold text-quiet">Travellers in Bitrix</dt>
                  <dd className="m-0 text-copy">{pre.travellerTotal}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
          {p.showReference && !pre.notesHidden && pre.bookingNotes && p.target === 'booking_version' ? <p className="m-0 text-sm text-quiet">{PREFILL_TEXT.notesReference}</p> : null}
          {rows.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Bitrix values">
              {rows.map((r, i) => (
                <li key={r.field} className="m-0 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control border border-line bg-card px-3.5 py-2.5">
                  <span className="min-w-48 flex-1">
                    <span className="block text-sm font-semibold text-quiet">{r.label}</span>
                    <span className="block wrap-anywhere text-ink">{valueText(r, pre.customerTypeLabel)}</span>
                  </span>
                  <StateBadge row={r} />
                  {canAct && r.canUse ? <PrefillForm p={p} kind="use" codes={[r.field]} label={PREFILL_TEXT.use} srLabel={r.label} variant="secondary" order={i * 2} /> : null}
                  {canAct && r.canMarkChecked ? <PrefillForm p={p} kind="check" codes={[r.field]} label={PREFILL_TEXT.markChecked} srLabel={r.label} variant="ghost" order={i * 2 + 1} /> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {canAct && (usable.length > 1 || checkable.length > 1) ? (
            <div className="flex flex-wrap gap-2">
              {usable.length > 1 ? <PrefillForm p={p} kind="use" codes={usable} label={PREFILL_TEXT.useAll} variant="secondary" order={98} /> : null}
              {checkable.length > 1 ? <PrefillForm p={p} kind="check" codes={checkable} label="Mark all checked" variant="secondary" order={99} /> : null}
            </div>
          ) : null}
          {rows.some((r) => r.field.startsWith('contacts.')) ? <p className="m-0 text-sm text-quiet">{PREFILL_TEXT.contactUnconfirmed}</p> : null}
        </>
      )}
    </section>
  );
}
