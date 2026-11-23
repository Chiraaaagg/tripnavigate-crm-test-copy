import type { Metadata } from 'next';
import { loadTallyExports, loadTallyMapping, loadTallyMappingHistory } from '@/modules/accounts-desk/server/queries';
import { setTallyMappingAction } from '@/modules/accounts-desk/server/actions';
import { requireStaff } from '@/modules/identity/server/session';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { accountsSettingsTabs } from '@/views/tally-mapping/labels';
import { TallyMappingNoAccess, TallyMappingView } from '@/views/tally-mapping/mapping';
import type { TallyMappingPageView } from '@/views/tally-mapping/types';

export const metadata: Metadata = { title: 'Tally mapping' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH = '/app/admin/accounts/tally-mapping';
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Settings › Accounts › Tally mapping (contract 8.1 D1/D2, 11.11), Accounts of
 * the company only (tally_mapping_list returns null otherwise). The companies
 * are the ones the viewer exports Tally for; `?entity=` picks one and
 * `?history=<mappingId>` opens that row's history (read here, on the server).
 * Every save is the database's tally_mapping_set with the person's reason.
 * UX redesign R1: shown as the Tally mapping sub-tab of Settings › Accounts.
 */
export default async function TallyMappingRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff();
  const q = await searchParams;
  const exportsView = await loadTallyExports(staff, 1).catch(() => null);
  const entities = exportsView?.entities ?? [];
  if (entities.length === 0) return <TallyMappingNoAccess />;
  const wanted = one(q.entity);
  const current = entities.find((e) => e.entityId === wanted) ?? entities[0]!;
  const baseHref = entities.length > 1 ? `${PATH}?entity=${current.entityId}` : PATH;
  const historyId = one(q.history);
  const [list, history] = await Promise.all([
    loadTallyMapping(staff, current.entityId).catch(() => 'error' as const),
    historyId && UUID.test(historyId) ? loadTallyMappingHistory(staff, historyId).catch(() => 'error' as const) : Promise.resolve(undefined),
  ]);
  if (list === null) return <TallyMappingNoAccess />;
  // R1: Settings › Accounts sub-tabs. "Switches" for a Super Admin (that page shows read only to one who also holds Accounts).
  const superAdmin = staff.memberships.some((m) => m.roleCode === 'super_admin');
  const view: TallyMappingPageView = {
    tabs: accountsSettingsTabs({ switches: superAdmin, mapping: true, current: 'mapping', mappingHref: baseHref }),
    entityName: current.name,
    entities: entities.length > 1 ? entities.map((e) => ({ id: e.entityId, name: e.name, href: `${PATH}?entity=${e.entityId}`, current: e.entityId === current.entityId })) : undefined,
    list,
    baseHref,
    history: historyId && history !== undefined ? { mappingId: historyId, items: history === 'error' ? 'error' : history ? history.items : null } : undefined,
  };
  return <TallyMappingView view={view} action={setTallyMappingAction as unknown as DecisionAction} />;
}
