import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { loadStaffAdmin } from '@/modules/access/server/admin-queries';
import { loadAdminCustomerMessages } from '@/modules/customer-messages/server/queries';
import { financeEnabledEntityIds } from '@/modules/finance/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import {
  type OverviewFact,
  type OverviewFacts,
  settingsAreaTarget,
  settingsOverviewRows,
  type SettingsCategory,
} from '@/modules/settings/contracts';
import { liveRows } from '@/modules/settings/rows';
import { bitrixPageModel, featuresPageModel, loadCompanyPage, loadSettingsStates, sectionOf } from '@/modules/settings/server/queries';
import { SettingsOverviewNoPermissionView, SettingsOverviewView } from '@/views/settings/settings-overview';
import { settingsAreasFor, shellPermissions } from '../shell-permissions';

export const metadata: Metadata = { title: 'Settings' };

/**
 * Settings · Overview (R1, audit N7; build plan 2.4 "a+"): the landing page of
 * the Settings menu item, at the one new address /app/admin. One row per area
 * this person may open, each from a read that already exists (the same reads
 * the area pages make, under the person's own session), each failing on its
 * own to "Not known". Nothing here writes.
 *
 * Someone whose only area is Imports (Accounts) goes straight there, as the
 * menu item does. The phone area picker posts ?area= here without script; it
 * is followed only to one of the person's own areas.
 */
export default async function SettingsOverviewRoute({ searchParams }: { searchParams: Promise<{ area?: string | string[] }> }) {
  const staff = await requireStaff();
  // Request-cached: the staff layout already ran this read.
  const financeEntities = await financeEnabledEntityIds(staff);
  // The same areas as the frame (admin/layout.tsx, one rule: settingsAreasFor).
  const tabs = settingsAreasFor(staff, financeEntities);

  const target = settingsAreaTarget(tabs, (await searchParams).area);
  if (target) redirect(target);
  if (tabs.length === 0) return <SettingsOverviewNoPermissionView />;
  if (tabs[0]!.category !== 'overview') redirect(tabs[0]!.href);

  const has = (c: SettingsCategory) => tabs.some((t) => t.category === c);
  const states = await loadSettingsStates(staff).catch(() => 'error' as const);
  const superAdminEntities = [...new Set(staff.memberships.filter((m) => m.roleCode === 'super_admin').map((m) => m.legalEntityId))];

  const [people, company, messages] = await Promise.all([
    has('people') && shellPermissions(staff, financeEntities).canAdministerStaff
      ? loadStaffAdmin(staff)
          .then((d) => ({ active: d.staff.filter((s) => s.status === 'active').length, invited: d.staff.filter((s) => s.status === 'invited').length }))
          .catch(() => 'unknown' as const)
      : undefined,
    has('company')
      ? loadCompanyPage(staff, states)
          .then((m) => ({ missingGstin: m.branches.filter((b) => !b.gstin).map((b) => b.name), notApproved: m.notApproved.length }))
          .catch(() => 'unknown' as const)
      : undefined,
    has('messages') && superAdminEntities.length > 0 ? messagesFact(staff, superAdminEntities[0]!) : undefined,
  ]);

  const facts: OverviewFacts = {
    people,
    company,
    messages,
    money: has('money') ? moneyFact(states) : undefined,
    features: has('features') ? featuresFact(states) : undefined,
    bitrix: has('bitrix') ? bitrixFact(states) : undefined,
    health: has('health') ? healthFact(states) : undefined,
  };
  return <SettingsOverviewView rows={settingsOverviewRows(tabs, facts)} tabs={tabs} />;
}

type States = Parameters<typeof sectionOf>[0];

function moneyFact(states: States): OverviewFact<{ on: number; total: number }> {
  const live = sectionOf(states, 'live');
  if (live === null) return undefined;
  if (typeof live !== 'object') return 'unknown';
  const modes = live.financeModes.flatMap((c) => c.modes);
  if (modes.length === 0 || modes.some((m) => m.state === 'unknown')) return 'unknown';
  return { on: modes.filter((m) => m.state === 'on').length, total: modes.length };
}

function featuresFact(states: States): OverviewFact<{ on: number; total: number; unknown: number }> {
  const { features } = featuresPageModel(states);
  if (features.rows.length === 0) return undefined;
  if (features.sectionText !== null) return 'unknown';
  return {
    on: features.rows.filter((r) => r.state === 'on').length,
    total: features.rows.length,
    unknown: features.rows.filter((r) => r.state === 'unknown').length,
  };
}

function bitrixFact(states: States): OverviewFact<{ autoSync: 'on' | 'off' | 'unknown' }> {
  const page = bitrixPageModel(states);
  if (page.sync) return { autoSync: page.sync.autoSync };
  return sectionOf(states, 'bitrix') === null ? undefined : 'unknown';
}

function healthFact(states: States): OverviewFact<{ realBooking: 'on' | 'off' | 'unknown' }> {
  const live = liveRows(sectionOf(states, 'live'));
  if (live.rows.length === 0) return undefined;
  if (live.sectionText !== null) return 'unknown';
  return { realBooking: live.rows.find((r) => r.key === 'real_booking')?.state ?? 'unknown' };
}

async function messagesFact(staff: Awaited<ReturnType<typeof requireStaff>>, entityId: string): Promise<OverviewFacts['messages']> {
  try {
    const data = await loadAdminCustomerMessages(staff, entityId);
    if (!data) return undefined;
    return {
      on: data.switches.filter((s) => s.enabled).length,
      total: data.switches.length,
      pilotOnly: data.pilotOnly,
      pilotDeals: data.pilot.length,
      keysMissing: data.providers.filter((p) => !p.configured).length,
    };
  } catch {
    return 'unknown';
  }
}
