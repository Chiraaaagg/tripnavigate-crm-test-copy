import type { TestDb } from '../helpers/db';

/**
 * Number counters that committed setup steps of the real-Postgres race suites
 * move outside their own Deals (lead fix-forward, 12 Nov 2026: after a full
 * serial real-db run supplier_payment_counters stayed at 7 with no payment
 * request left, which breaks the Phase 1 numbering suites run later).
 * Rows are saved as the server's JSON text (to_jsonb keeps microseconds) and
 * put back server-side, so the restore is exact.
 */
export const COUNTER_TABLES = ['finance_receipt_counters', 'supplier_payment_counters', 'tally_export_counters', 'customer_refund_counters'];

export type SavedCounters = Record<string, string[]>;

export async function saveCounters(db: TestDb): Promise<SavedCounters> {
  const out: SavedCounters = {};
  for (const t of COUNTER_TABLES) out[t] = (await db.query<{ j: string }>(`select to_jsonb(x)::text as j from public.${t} x order by 1`)).map((r) => r.j);
  return out;
}

/** Inside the caller's cleanup transaction: every counter table back to the saved rows. */
export async function restoreCounters(db: TestDb, saved: SavedCounters): Promise<void> {
  for (const t of COUNTER_TABLES) {
    await db.query(`delete from public.${t}`);
    for (const row of saved[t] ?? []) await db.query(`insert into public.${t} select (jsonb_populate_record(null::public.${t}, $1::jsonb)).*`, [row]);
  }
}

/** Throws when a counter table differs from the saved rows (call after the cleanup committed). */
export async function assertCountersRestored(db: TestDb, saved: SavedCounters, suite: string): Promise<void> {
  const now = await saveCounters(db);
  const changed = COUNTER_TABLES.filter((t) => JSON.stringify(now[t]) !== JSON.stringify(saved[t]));
  if (changed.length > 0) throw new Error(`${suite} left number counters changed: ${changed.join(', ')}`);
}
