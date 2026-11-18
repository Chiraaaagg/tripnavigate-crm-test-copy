import type { Metadata } from 'next';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { setMessageSwitchAction, setPilotDealAction, setPilotDealByReferenceAction, setPilotOnlyAction, setTemplateStatusAction, setTimerEnabledAction } from '@/modules/customer-messages/server/actions';
import { loadAdminCustomerMessages } from '@/modules/customer-messages/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { adminMessagesView } from '@/views/customer-messages/adapt';
import { CustomerMessageSettingsCompanies } from '@/views/customer-messages/settings';

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
 * R-A2, screen 15.4). Super Admin only: admin_customer_messages returns null
 * for everyone else. One section per company the person administers.
 */
export default async function CustomerMessagesSettingsRoute() {
  const staff = await requireStaff();
  const superAdmin = staff.memberships.filter((m) => m.roleCode === 'super_admin');
  const entityIds = [...new Set(superAdmin.map((m) => m.legalEntityId))];
  const names = new Map(staff.memberships.map((m) => [m.legalEntityId, m.legalEntityName]));
  const reads = await Promise.all(entityIds.map(async (id) => ({ id, data: await loadAdminCustomerMessages(staff, id).catch(() => 'error' as const) })));
  const visible = reads.filter((r) => r.data !== null);
  if (visible.length === 0) {
    return (
      <>
        <PageHeader title="Customer messages" />
        <Notice tone="restricted" title="For Super Admins only">
          <p>The customer message switches, the pilot list and the WhatsApp text approvals are set by a Super Admin.</p>
        </Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader title="Customer messages" description="The nine booking messages to customers by e-mail and WhatsApp. Every switch is Off until you turn it on with a reason; nothing goes to customers on test Deals." />
      <CustomerMessageSettingsCompanies
        companies={visible.map((r) => ({ id: r.id, name: names.get(r.id) ?? 'Company', data: r.data === 'error' ? 'error' : adminMessagesView(r.data!) }))}
        actions={ACTIONS}
      />
    </>
  );
}
