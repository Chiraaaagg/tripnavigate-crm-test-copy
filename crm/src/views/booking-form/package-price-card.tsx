'use client';

import { CircleAlert, Lock, ReceiptText } from 'lucide-react';
import { Fragment, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { Notice } from '@/components/ui/notice';
import { PRICE_CATEGORY_LABEL, PRICE_CATEGORIES, type PackagePriceView, type PriceCategory } from '@/modules/fulfilment/booking-form-contract';
import { bookingPriceLines, editPrice, formatInr, isBelowPurchase, priceFieldId, priceLinesFromSaved, priceTotals, visiblePriceCategories, type PartyCounts, type PriceLineInput } from '@/modules/fulfilment/booking-form-model';
import { useSectionForm } from '../b11/draft-sync';
import { ResultBox, type FieldRef } from '../b11/form-kit';
import type { B11Action, BookNowView } from '../b11/shapes';
import { HiddenDraftInputs, SectionSaveRow, editableOf, useShownRefusal, useSectionSubmit } from './form-helpers';
import { InlineNote, SectionBody, SectionCard } from './parts';

/*
 * Step 3 · Package price (approved preview PackagePrices; contract §2.7).
 * Four per-person categories; child rows only with children, the infant row
 * only with infants; adult and infant counts follow step 1 (read-only).
 * Purchase + markup = final sale with the three approved edit directions
 * (booking-form-model editPrice). Markup starts empty. A sale below purchase
 * is shown with its negative markup and flagged, never corrected. Shown only
 * to commercial readers; everybody else sees one locked line.
 */

type Amount = 'purchase' | 'markup' | 'sale';
const AMOUNTS: ReadonlyArray<{ key: Amount; label: string; post: string }> = [
  { key: 'purchase', label: 'Purchase', post: 'pricePurchaseRupees' },
  { key: 'markup', label: 'Markup', post: 'priceMarkupRupees' },
  { key: 'sale', label: 'Final sale', post: 'priceSaleRupees' },
];

export function PriceLockedCard() {
  return (
    <SectionCard id="price" title="Package price" icon={ReceiptText}>
      <SectionBody>
        <Notice tone="locked" title="The selling price is not shown to you">
          <p>Sales on this deal fills the prices.</p>
        </Notice>
      </SectionBody>
    </SectionCard>
  );
}

export function PackagePriceCard({
  prices,
  view,
  party,
  action,
  reloadHref,
  onTotal,
  countsUnsaved = false,
}: {
  prices: PackagePriceView;
  view: BookNowView;
  party: PartyCounts;
  action: B11Action;
  reloadHref: string;
  /** The live selling total (the booking summary shows it). */
  onTotal?: (paise: string | null) => void;
  /** Step 1 has unsaved passenger counts (the server prices the saved counts, Echo B-L7). */
  countsUnsaved?: boolean;
}) {
  const editable = editableOf(view) && view.canEditCommercials;
  const f = useSectionForm({
    id: 'price',
    section: 'price',
    label: 'Package price',
    order: 70,
    action,
    initial: { lines: priceLinesFromSaved(prices.lines) },
    versionBound: true,
    rowVersion: view.version?.rowVersion ?? 0,
  });
  const { bindForm, bindResult } = f;
  const submitter = useSectionSubmit(f.post);
  const lines = bookingPriceLines(party, f.values.lines);
  const visible = new Set<PriceCategory>(visiblePriceCategories(party));
  const totals = priceTotals(lines);
  useEffect(() => {
    onTotal?.(totals.salePaise);
  }, [totals.salePaise, onTotal]);
  const set = (cat: PriceCategory, fn: (l: PriceLineInput) => PriceLineInput) =>
    f.setValues((s) => ({ ...s, lines: bookingPriceLines(party, s.lines).map((l) => (l.category === cat ? fn(l) : l)) }));
  const refusal = useShownRefusal(f, (name) => {
    const m = /^(priceQuantity|pricePurchaseRupees|priceMarkupRupees|priceSaleRupees)\[(\w+)\]$/.exec(name);
    if (!m) return undefined;
    const key = ({ priceQuantity: 'quantity', pricePurchaseRupees: 'purchase', priceMarkupRupees: 'markup', priceSaleRupees: 'sale' } as const)[m[1] as 'priceQuantity'];
    return (v: { lines: PriceLineInput[] }) => v.lines.find((l) => l.category === m[2])?.[key];
  });
  const fields = refusal.fields;
  // Refusals name a category's field as priceSaleRupees[adult] (Terra's action).
  const refs: FieldRef[] = PRICE_CATEGORIES.flatMap((c) => [
    { field: `priceQuantity[${c}]`, id: priceFieldId(c, 'quantity'), label: `${PRICE_CATEGORY_LABEL[c]}: check the number of people.` },
    ...AMOUNTS.map((a) => ({ field: `${a.post}[${c}]`, id: priceFieldId(c, a.key), label: `${PRICE_CATEGORY_LABEL[c]} ${a.label.toLowerCase()}: enter purchase, markup and final sale, in rupees, 0 or more, with up to 2 decimals.` })),
  ]);
  const refused = (field: string) => fields?.includes(field) ?? false;
  const success = totals.salePaise ? `Prices saved. Package selling total ${formatInr(totals.salePaise)}.` : `Prices saved. Total not worked out yet: ${totals.incomplete.length || 'some'} amounts still missing.`;
  const sourceNote =
    prices.source === 'quotation_total'
      ? `Total from the accepted quotation: ${formatInr(prices.sellingTotalPaise, 'not set')}. Per-person prices are optional here. If they add up to a different total, the customer must accept again.`
      : prices.source === 'legacy_total'
        ? `Total typed before per-person prices existed: ${formatInr(prices.sellingTotalPaise, 'not set')}. It stays as it is.`
        : null;
  const counted = lines.reduce((n, l) => n + (Number(l.quantity) || 0), 0);
  return (
    <SectionCard id="price" title="Package price" icon={ReceiptText}>
      <form ref={bindForm} onSubmit={submitter.onSubmit} noValidate aria-labelledby="price-heading">
        <SectionBody>
          <div ref={bindResult} className="mb-4 [&:has(>[role=status]:empty)]:hidden">
            <ResultBox result={refusal.shown} fields={refs} reloadHref={reloadHref} successText={success} />
          </div>
          <HiddenDraftInputs view={view} base={f.base} result={f.state} />
          {sourceNote ? <Notice tone="info" className="mb-4">{sourceNote}</Notice> : null}
          {!editable && editableOf(view) ? (
            <p className="m-0 mb-4 flex gap-2 text-sm text-quiet">
              <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              You can’t change the prices on this deal. Ask the deal owner.
            </p>
          ) : null}
          <div aria-hidden="true" className="grid grid-cols-[minmax(6.875rem,1.2fr)_3.25rem_repeat(3,minmax(5rem,1fr))] items-center gap-2.5 pb-2.5 text-sm text-quiet max-sm:hidden">
            <span>Passenger</span>
            <span>People</span>
            <span>Purchase / person</span>
            <span>Markup / person</span>
            <span>Final sale / person</span>
          </div>
          {lines.map((line) => {
            const label = PRICE_CATEGORY_LABEL[line.category];
            const show = visible.has(line.category);
            const readOnlyQty = line.category === 'adult' || line.category === 'infant';
            const zero = (Number(line.quantity) || 0) === 0;
            const below = !zero && isBelowPurchase(line);
            const hidden = (
              <>
                <input type="hidden" name="priceCategory" value={line.category} />
                {readOnlyQty || !show ? <input type="hidden" name="priceQuantity" value={line.quantity} /> : null}
                {!show || zero
                  ? AMOUNTS.map((a) => <input key={a.key} type="hidden" name={a.post} value="" />)
                  : null}
              </>
            );
            if (!show) return <Fragment key={line.category}>{hidden}</Fragment>;
            const qtyId = priceFieldId(line.category, 'quantity');
            return (
              <div
                key={line.category}
                role="group"
                aria-labelledby={`${qtyId}-name`}
                className="grid grid-cols-[minmax(6.875rem,1.2fr)_3.25rem_repeat(3,minmax(5rem,1fr))] items-start gap-2.5 border-t border-line py-3 max-sm:grid-cols-3"
              >
                {hidden}
                <label id={`${qtyId}-name`} htmlFor={qtyId} className="self-center text-sm font-medium text-copy max-sm:col-span-2">
                  {label}
                </label>
                <Input
                  id={qtyId}
                  name={readOnlyQty ? undefined : 'priceQuantity'}
                  aria-label={`${label}: people`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={100}
                  readOnly={readOnlyQty}
                  disabled={!editable && !readOnlyQty}
                  value={line.quantity}
                  invalid={refused(`priceQuantity[${line.category}]`)}
                  onChange={(e) => set(line.category, (l) => ({ ...l, quantity: e.target.value }))}
                  className="read-only:bg-wash read-only:text-quiet"
                />
                {AMOUNTS.map((a) => {
                  const id = priceFieldId(line.category, a.key);
                  const isBelow = a.key === 'sale' && below;
                  const wrong = refused(`${a.post}[${line.category}]`);
                  return (
                    <div key={a.key} className="flex min-w-0 flex-col gap-1">
                      <label htmlFor={id} className="text-sm font-semibold text-ink sm:sr-only">
                        {a.label}
                      </label>
                      <MoneyInput
                        id={id}
                        name={zero ? undefined : a.post}
                        aria-label={`${label} ${a.label.toLowerCase()} per person, rupees`}
                        aria-describedby={[isBelow ? `${id}-below` : null, wrong ? `${id}-error` : null].filter(Boolean).join(' ') || undefined}
                        value={line[a.key]}
                        disabled={!editable || zero}
                        invalid={wrong || isBelow}
                        onChange={(e) => set(line.category, (l) => editPrice(l, a.key, e.target.value))}
                      />
                      {wrong ? (
                        <p id={`${id}-error`} className="m-0 text-sm font-medium text-status-danger">
                          Use rupees, 0 or more, with up to 2 decimals.
                        </p>
                      ) : null}
                      {isBelow ? (
                        <p id={`${id}-below`} className="m-0 flex items-start gap-1 text-sm font-medium text-status-danger">
                          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                          Final sale is below purchase.
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
          <div className="mt-[0.25rem] flex items-center justify-between gap-5 border-t border-line pt-4 text-sm max-sm:items-start max-sm:gap-3">
            {/* Visible totals; not a live region, so a screen reader is not interrupted on every keystroke (Echo B-L5). */}
            <span className="text-quiet">
              {counted} / {party.total ?? '—'} passengers
            </span>
            <div className="text-right">
              <span>Package selling total</span>
              <strong className="block text-2xl font-semibold text-ink tabular-nums max-sm:text-xl">{party.total ? formatInr(totals.salePaise, 'Not worked out yet') : 'Not worked out yet'}</strong>
            </div>
          </div>
          <InlineNote className="mt-3">Purchase, Flight and the Visa desk never see these prices. No tax is calculated here.</InlineNote>
          {countsUnsaved && f.dirty && editable ? (
            <p className="m-0 mt-4 text-sm text-copy">Save the passenger counts in step 1 first. The prices follow the saved counts.</p>
          ) : (
            <div className="mt-4 empty:hidden">
              <SectionSaveRow label="Save prices" dirty={f.dirty} editable={editable} pending={submitter.pending} />
            </div>
          )}
        </SectionBody>
      </form>
    </SectionCard>
  );
}
