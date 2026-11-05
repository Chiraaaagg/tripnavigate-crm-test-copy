import type { Actor } from '../helpers/db';

/**
 * Shared helper for suites that need a quotation version to pass the money
 * checks of 20261120000300 (Mercury) before quotation_mark_ready: one line
 * per service item with the unit the item's type requires, and a typed total
 * per tier equal to the component sum. Synthetic amounts only.
 */

type One = <T>(actor: Actor, sql: string, params?: unknown[]) => Promise<T>;
type Owner = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

const UNIT: Record<string, { unitKind: string; categoryKey: string; units: number; periods: number }> = {
  hotel: { unitKind: 'room_night', categoryKey: 'hotels', units: 1, periods: 1 },
  transfer: { unitKind: 'trip', categoryKey: 'transfers', units: 1, periods: 1 },
  activity: { unitKind: 'line_total', categoryKey: 'tours', units: 1, periods: 1 },
  flight: { unitKind: 'line_total', categoryKey: 'flights', units: 1, periods: 1 },
  visa: { unitKind: 'line_total', categoryKey: 'visas', units: 1, periods: 1 },
  passport: { unitKind: 'line_total', categoryKey: 'visas', units: 1, periods: 1 },
};

/** ₹1,000 per line (cost ₹800); returns the new row version. */
export async function priceQuotationVersion(one: One, owner: Owner, actor: Actor, versionId: string, rowVersion: number): Promise<number> {
  const items = await owner<{ id: string; service_type: string; tier_key: string | null }>(
    'select id, service_type, tier_key from public.quotation_version_items where quotation_version_id = $1 order by item_no',
    [versionId],
  );
  const lines = items.map((item, i) => ({
    lineNo: i + 1,
    optionKey: item.tier_key ?? 'common',
    itemId: item.id,
    description: `Synthetic ${item.service_type} line`,
    unitSellPaise: '100000',
    unitCostPaise: '80000',
    ...UNIT[item.service_type]!,
  }));
  let rv = (await one<{ rowVersion: number }>(actor, 'select public.quotation_lines_save($1, $2, $3::jsonb) as r',
    [versionId, rowVersion, JSON.stringify(lines)])).rowVersion;
  const tiers = new Set(['quoted', ...items.map((i) => i.tier_key).filter((t): t is string => t !== null)]);
  const hasUpgradeTier = (await owner('select 1 from public.quotation_version_tiers where quotation_version_id = $1 and tier_key = $2',
    [versionId, 'upgrade'])).length > 0;
  if (hasUpgradeTier) tiers.add('upgrade');
  for (const tier of tiers) {
    const total = lines.filter((l) => l.optionKey === 'common' || l.optionKey === tier).length * 100000;
    rv = (await one<{ rowVersion: number }>(actor, 'select public.quotation_total_save($1, $2, $3, $4::bigint, $5) as r',
      [versionId, rv, tier, String(Math.max(total, 100000)), true])).rowVersion;
  }
  return rv;
}
