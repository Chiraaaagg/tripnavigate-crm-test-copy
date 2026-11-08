'use client';

import { ProgressChecklist } from '@/components/ui/progress-checklist';
import type { BookingFormChecklistItem } from '@/modules/fulfilment/booking-form-vm';

/*
 * "Before you submit" / "Ready to submit" at the top of step 3 (Book now v2,
 * change 9; 21st.dev "Multi-Step Progress" via ProgressChecklist). Seven
 * items with reasons; tapping one goes to it. Each item is done only when the
 * server's readiness has nothing blocking in it AND the screen agrees (typed
 * values not saved yet count as not done); the submit button is still checked
 * by the server. A blocking reason that fits no bucket shows under the
 * nearest one, so nothing that blocks is ever hidden.
 */

export type ReadyKey = 's1' | 'id' | 's2' | 'price' | 'bill' | 'plan' | 'ok';

export interface ReadyItem {
  key: ReadyKey;
  label: string;
  done: boolean;
  why: string;
}

export const READY_LABEL: Record<ReadyKey, string> = {
  s1: 'Customer & passengers',
  id: 'ID proof for adults',
  s2: 'Trip & services',
  price: 'Package price',
  bill: 'Bill To',
  plan: 'Payment plan',
  ok: 'Customer’s written OK',
};

const DEFAULT_WHY: Record<ReadyKey, string> = {
  s1: 'Finish step 1',
  id: 'Attach ID proof on step 1',
  s2: 'Finish step 2',
  price: 'Fill the final sale per person',
  bill: 'Choose or add the customer to bill',
  plan: 'Instalments must add up to the total',
  ok: 'Upload the customer’s yes',
};

/** The bucket of one server readiness row. */
export function readyBucket(r: Pick<BookingFormChecklistItem, 'code' | 'section'>): ReadyKey {
  if (r.code === 'id_proof_missing') return 'id';
  if (r.section === 'customer' || r.section === 'passengers') return 's1';
  if (r.section === 'services') return 's2';
  if (r.section === 'price') return 'price';
  if (r.section === 'billTo') return 'bill';
  if (r.code.startsWith('plan_')) return 'plan';
  return 'ok';
}

/**
 * The seven items: the screen's own state (`client`: done and reason as the
 * prototype works them out) merged with the server's blocking rows.
 */
export function readyItems(checklist: readonly BookingFormChecklistItem[], client: Record<ReadyKey, { done: boolean; why: string | null }>): ReadyItem[] {
  const blocking = checklist.filter((r) => r.blocking);
  return (Object.keys(READY_LABEL) as ReadyKey[]).map((key) => {
    const server = blocking.filter((r) => readyBucket(r) === key);
    const c = client[key];
    const done = c.done && server.length === 0;
    return { key, label: READY_LABEL[key], done, why: (!c.done ? c.why : null) ?? server[0]?.text ?? DEFAULT_WHY[key] };
  });
}

export function ReadyList({ items, onGo }: { items: readonly ReadyItem[]; onGo: (key: ReadyKey) => void }) {
  const all = items.every((i) => i.done);
  return (
    <section className="rounded-card border border-line bg-card px-5 py-4.5 shadow-card max-sm:px-4" id="ready">
      <ProgressChecklist id="bf-ready" title={all ? 'Ready to submit' : 'Before you submit'} items={items.map((i) => ({ key: i.key, label: i.label, done: i.done, why: i.why, onSelect: () => onGo(i.key) }))} />
    </section>
  );
}
