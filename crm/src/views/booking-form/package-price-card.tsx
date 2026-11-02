'use client';

import { CircleAlert, Lock, ReceiptText } from 'lucide-react';
import { Fragment, useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { Notice } from '@/components/ui/notice';
import { SaveStatus } from '@/components/ui/save-status';
import { PRICE_CATEGORY_LABEL, PRICE_CATEGORIES, type PackagePriceView, type PriceCategory } from '@/modules/fulfilment/booking-form-contract';
import { bookingPriceLines, editPrice, formatInr, isBelowPurchase, priceFieldId, priceLinesFromSaved, priceTotals, rupeesToPaise, visiblePriceCategories, type PartyCounts, type PriceLineInput } from '@/modules/fulfilment/booking-form-model';
import { useSectionForm } from '../b11/draft-sync';
import type { FieldRef, UiResult } from '../b11/form-kit';
import type { B11Action, BookNowView } from '../b11/shapes';
import { useAutosave } from './autosave-queue';
import { HiddenDraftInputs, editableOf, useShownRefusal } from './form-helpers';
import { SectionBody, SectionCard } from './parts';

/*
 * Step 3 · Package price (Book now v2, owner-approved prototype priceCard;
 * change 8). Four per-person categories; child rows only with children, the
 * infant row only with infants; adult and infant counts follow step 1.
 * Purchase + markup = final sale with the approved edit directions. The
 * card saves itself; when it cannot be saved the top says "Prices are not
 * saved", the exact reason and "Fix in step 1"; a total still being worked
 * out reads "Working out, not saved yet". Commercial readers only.
 */

type Amount = 'purchase' | 'markup' | 'sale';
const AMOUNTS: ReadonlyArray<{ key: Amount; label: string; head: string; post: string }> = [
  { key: 'purchase', label: 'Purchase', head: 'Purchase / person', post: 'pricePurchaseRupees' },
  { key: 'markup', label: 'Markup', head: 'Markup / person', post: 'priceMarkupRupees' },
  { key: 'sale', label: 'Final sale', head: 'Final sale / person', post: 'priceSaleRupees' },
];
const GRID = 'grid grid-cols-[minmax(6.875rem,1.2fr)_4.5rem_repeat(3,minmax(5.5rem,1fr))] items-center gap-x-2 max-sm:grid-cols-3 max-sm:gap-2';

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

/** Why prices cannot be saved yet (prototype priceState), or null. */
export function priceBlock(party: PartyCounts, countsSaved: boolean, lines: readonly PriceLineInput[]): string | null {
  if (!countsSaved) return 'Save step 1 first. Prices follow the saved traveller counts.';
  const c = party.children ?? 0;
  if (c > 0) {
    const bed = Number(lines.find((l) => l.category === 'child_bed')?.quantity || 0);
    const nobed = Number(lines.find((l) => l.category === 'child_no_bed')?.quantity || 0);
    if (bed + nobed !== c) return `Split all ${c === 1 ? '1 child' : `${c} children`} into with bed or without bed.`;
  }
  return null;
}

export function PackagePriceCard({
  prices,
  view,
  party,
  countsSaved,
  action,
  onTotal,
  onGoStep1,
}: {
  prices: PackagePriceView;
  view: BookNowView;
  /** The saved counts of step 1 (prices follow them). */
  party: PartyCounts;
  /** Step 1's counts are saved (the server prices the saved counts). */
  countsSaved: boolean;
  action: B11Action;
  /** The live total, whether it is saved, and the real gap in words ("Before you submit" shows it). */
  onTotal?: (paise: string | null, settled: boolean, gap: string | null) => void;
  onGoStep1: () => void;
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
    saveable: false,
    tracksDirty: true,
  });
  const lines = bookingPriceLines(party, f.values.lines);
  const visible = new Set<PriceCategory>(visiblePriceCategories(party));
  const totals = priceTotals(lines);
  // A draft from an accepted quotation (or typed before per-person prices) already has its total;
  // per-person lines are optional there, so it is worked out until someone starts typing lines.
  const typedAny = lines.some((l) => (Number(l.quantity) || 0) > 0 && (l.purchase.trim() !== '' || l.markup.trim() !== '' || l.sale.trim() !== ''));
  const storedTotal = prices.source !== 'per_person' && !typedAny ? prices.sellingTotalPaise : null;
  const shownTotal = totals.salePaise ?? storedTotal;
  const block = priceBlock(party, countsSaved, lines);
  const set = (cat: PriceCategory, fn: (l: PriceLineInput) => PriceLineInput) => f.setValues((s) => ({ ...s, lines: bookingPriceLines(party, s.lines).map((l) => (l.category === cat ? fn(l) : l)) }));
  const refusal = useShownRefusal(f, (name) => {
    const m = /^(priceQuantity|pricePurchaseRupees|priceMarkupRupees|priceSaleRupees)\[(\w+)\]$/.exec(name);
    if (!m) return undefined;
    const key = ({ priceQuantity: 'quantity', pricePurchaseRupees: 'purchase', priceMarkupRupees: 'markup', priceSaleRupees: 'sale' } as const)[m[1] as 'priceQuantity'];
    return (v: { lines: PriceLineInput[] }) => v.lines.find((l) => l.category === m[2])?.[key];
  });
  const fields = refusal.fields;
  const refs: FieldRef[] = PRICE_CATEGORIES.flatMap((c) => [
    { field: `priceQuantity[${c}]`, id: priceFieldId(c, 'quantity'), label: `${PRICE_CATEGORY_LABEL[c]}: check the number of people.` },
    ...AMOUNTS.map((a) => ({ field: `${a.post}[${c}]`, id: priceFieldId(c, a.key), label: `${PRICE_CATEGORY_LABEL[c]} ${a.label.toLowerCase()}: rupees, 0 or more, with up to 2 decimals.` })),
  ]);
  const refused = (field: string) => fields?.includes(field) ?? false;
  const formRef = useRef<HTMLFormElement | null>(null);
  const bindForm = f.bindForm;
  const setForm = useCallback(
    (el: HTMLFormElement | null) => {
      formRef.current = el;
      bindForm(el);
    },
    [bindForm],
  );
  const save = useAutosave({
    key: 'price',
    values: f.values,
    dirty: f.dirty,
    enabled: editable,
    hasStored: prices.lines.some((l) => l.salePaise !== null) || (prices.source !== 'per_person' && Boolean(prices.sellingTotalPaise)),
    check: () => {
      const cur = bookingPriceLines(party, f.values.lines);
      const b = priceBlock(party, countsSaved, cur);
      if (b) return [b];
      const bad = cur.find((l) => (Number(l.quantity) || 0) > 0 && AMOUNTS.some((a) => l[a.key].trim() !== '' && rupeesToPaise(l[a.key], { signed: a.key === 'markup' }) === undefined));
      return bad ? [`${PRICE_CATEGORY_LABEL[bad.category]}: rupees, 0 or more, with up to 2 decimals.`] : [];
    },
    send: () => (formRef.current ? f.post(new FormData(formRef.current)) : Promise.resolve({ ok: false, code: 'unexpected', message: '' } as UiResult)),
    refs,
  });
  const settled = save.state === 'saved' || save.state === 'idle';
  const missing = totals.incomplete.map((c) => PRICE_CATEGORY_LABEL[c]).join(', ');
  const gap = storedTotal ? null : (block ?? (save.state === 'fix' && save.reason ? save.reason : missing ? `Fill purchase, markup and final sale for ${missing}` : !totals.salePaise ? 'Fill the final sale per person' : null));
  useEffect(() => {
    onTotal?.(shownTotal, settled && (!block || Boolean(storedTotal)), gap);
  }, [shownTotal, storedTotal, settled, block, gap, onTotal]);
  const sourceNote =
    prices.source === 'quotation_total'
      ? `Total from the accepted quotation: ${formatInr(prices.sellingTotalPaise, 'not set')}. Per-person prices are optional here. If they add up to a different total, the customer must accept again.`
      : prices.source === 'legacy_total'
        ? `Total typed before per-person prices existed: ${formatInr(prices.sellingTotalPaise, 'not set')}. It stays as it is.`
        : null;
  const counted = lines.reduce((n, l) => n + (Number(l.quantity) || 0), 0);
  const lockedInputs = !editable || (block !== null && !countsSaved);
  const reason = save.state === 'fix' && save.reason && save.reason !== block ? save.reason : null;
  return (
    <SectionCard id="price" title="Package price" icon={ReceiptText} action={editable ? <SaveStatus id="pill-price" state={save.state} reason={save.reason} label="Package price" /> : null}>
      <form ref={setForm} onSubmit={(e) => e.preventDefault()} noValidate aria-labelledby="price-heading">
        <SectionBody>
          <HiddenDraftInputs view={view} base={f.base} result={f.state} />
          {block && editable && !storedTotal ? (
            <div role="status" className="mb-3.5 flex gap-2.5 rounded-control border border-status-danger-line bg-status-danger-tint px-3.5 py-3 text-sm text-status-danger-strong">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <p className="m-0">
                <b>Prices are not saved.</b> {block}{' '}
                <Button variant="link" size="sm" className="text-sm" onClick={onGoStep1}>
                  Fix in step 1
                </Button>
              </p>
            </div>
          ) : null}
          {sourceNote ? (
            <Notice tone="info" className="mb-4">
              {sourceNote}
            </Notice>
          ) : null}
          {!editable && editableOf(view) ? (
            <p className="m-0 mb-4 flex gap-2 text-sm text-quiet">
              <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              You can’t change the prices on this deal. Ask the deal owner.
            </p>
          ) : null}
          <div aria-hidden="true" className={`${GRID} pb-2 text-xs font-medium text-quiet max-sm:hidden`}>
            <span>Passenger</span>
            <span>People</span>
            {AMOUNTS.map((a) => (
              <span key={a.key}>{a.head}</span>
            ))}
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
                {!show || zero ? AMOUNTS.map((a) => <input key={a.key} type="hidden" name={a.post} value="" />) : null}
              </>
            );
            if (!show) return <Fragment key={line.category}>{hidden}</Fragment>;
            const qtyId = priceFieldId(line.category, 'quantity');
            return (
              <div key={line.category} role="group" aria-labelledby={`${qtyId}-name`} className={`${GRID} border-t border-line py-2.5`}>
                {hidden}
                <label id={`${qtyId}-name`} htmlFor={qtyId} className="text-sm font-medium text-copy max-sm:col-span-2">
                  {label}
                </label>
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-quiet sm:hidden">People</span>
                  <Input
                    id={qtyId}
                    name={readOnlyQty ? undefined : 'priceQuantity'}
                    aria-label={`${label}: people`}
                    inputMode="numeric"
                    readOnly={readOnlyQty}
                    disabled={lockedInputs && !readOnlyQty}
                    value={line.quantity}
                    invalid={refused(`priceQuantity[${line.category}]`)}
                    onChange={(e) => set(line.category, (l) => ({ ...l, quantity: e.target.value }))}
                    className="w-16 read-only:bg-wash read-only:text-quiet"
                  />
                </div>
                {AMOUNTS.map((a) => {
                  const id = priceFieldId(line.category, a.key);
                  const isBelow = a.key === 'sale' && below;
                  const wrong = refused(`${a.post}[${line.category}]`);
                  return (
                    <div key={a.key} className="flex min-w-0 flex-col gap-1">
                      <span className="text-xs text-quiet sm:hidden" aria-hidden="true">
                        {a.label}
                      </span>
                      <MoneyInput
                        id={id}
                        name={zero ? undefined : a.post}
                        aria-label={`${label} ${a.label.toLowerCase()} per person, rupees`}
                        aria-describedby={[isBelow ? `${id}-below` : null, wrong ? `${id}-error` : null].filter(Boolean).join(' ') || undefined}
                        value={line[a.key]}
                        disabled={lockedInputs || zero}
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
          <div className="mt-[0.25rem] flex items-end justify-between gap-4 border-t border-line pt-3.5">
            <span className="text-sm text-quiet">{party.total !== null ? `${counted} / ${party.total} passengers` : ''}</span>
            <div className="text-right">
              <span className="text-sm text-quiet">Package selling total</span>
              <strong className="block text-2xl font-semibold text-ink tabular-nums max-sm:text-xl">{shownTotal && (party.total || storedTotal) ? formatInr(shownTotal) : 'Not worked out yet'}</strong>
              <span className="block text-xs text-status-warning">{totals.salePaise && !block && !settled ? 'Working out, not saved yet' : ''}</span>
            </div>
          </div>
          <p className="m-0 mt-3 text-sm text-quiet">Purchase, Flight and the Visa desk never see these prices. No tax is calculated here.</p>
          {reason ? (
            <p id="why-price" className="m-0 mt-3 flex items-start gap-1.5 text-sm font-medium text-status-danger">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>{reason}</span>
            </p>
          ) : null}
        </SectionBody>
      </form>
    </SectionCard>
  );
}
