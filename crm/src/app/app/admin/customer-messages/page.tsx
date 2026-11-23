import type { Metadata } from 'next';
import { setMessageSwitchAction, setPilotDealAction, setPilotDealByReferenceAction, setPilotOnlyAction, setTemplateStatusAction, setTimerEnabledAction } from '@/modules/customer-messages/server/actions';
import { loadAdminCustomerMessages } from '@/modules/customer-messages/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { adminMessagesView } from '@/views/customer-messages/adapt';
import { CustomerMessageSettingsCompanies, CustomerMessageSettingsNoAccess } from '@/views/customer-messages/settings';
import { parseMessageSettingsTab } from '@/views/customer-messages/settings-tabs';

export const metadata: Metadata = { title: 'Customer messages' };

const act = (a: unknown) => a as DecisionAction;
const ACTIONS = {
  setSwitch: act(setMessageSwitchAction),
  setPilotMode: act(setPilotOnlyAction),
  setPilotDeal: act(setPilotDealAction),
  addPilotDeal: act(setPilotDealByReferenceAction),
  setTemplateStatus: act(setTemplateStatusAction),
  setTimer: act(setTimerEnabledAction),
};

/**
 * Settings · Customer messages (Accounts phase 3 contract 5.9 A7–A10, 5.10
 * R-A2, screen 15.4), its own Settings area since the UX redesign (R1, D12).
 * Sub-tabs on the same address: ?tab=texts|pilot|setup; the old address (no
 * tab) and any unknown value open Switches. Super Admin only:
 * admin_customer_messages returns null for everyone else. One section per
 * company the person administers.
 */
export default async function CustomerMessagesSettingsRoute({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const tab = parseMessageSettingsTab((await searchParams).tab);
  const staff = await requireStaff();
  const superAdmin = staff.memberships.filter((m) => m.roleCode === 'super_admin');
  const entityIds = [...new Set(superAdmin.map((m) => m.legalEntityId))];
  const names = new Map(staff.memberships.map((m) => [m.legalEntityId, m.legalEntityName]));
  const reads = await Promise.all(entityIds.map(async (id) => ({ id, data: await loadAdminCustomerMessages(staff, id).catch(() => 'error' as const) })));
  const visible = reads.filter((r) => r.data !== null);
  if (visible.length === 0) return <CustomerMessageSettingsNoAccess />;
  return (
    <CustomerMessageSettingsCompanies
      companies={visible.map((r) => ({ id: r.id, name: names.get(r.id) ?? 'Company', data: r.data === 'error' ? 'error' : adminMessagesView(r.data!) }))}
      actions={ACTIONS}
      tab={tab}
    />
  );
}
