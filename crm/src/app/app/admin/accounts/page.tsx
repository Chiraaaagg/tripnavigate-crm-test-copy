import type { Metadata } from 'next';
import { financePolicyEntityIds } from '@/modules/access/policy';
import { loadAdminAccountsSettings } from '@/modules/accounts-desk/server/queries';
import { setExceptionOwnerAction, setTallyExportEnabledAction } from '@/modules/accounts-desk/server/actions';
import { setAutoBillsAction, setCustomerDocumentsEnabledAction } from '@/modules/customer-documents/server/actions';
import { setTallyXmlAction } from '@/modules/accounts-desk/server/tally-file-actions';
import { setWriteOffAction } from '@/modules/write-offs/server/actions';
import { loadDocumentSettings } from '@/modules/customer-documents/server/queries';
import { setRefundsEnabledAction } from '@/modules/refunds/server/actions';
import { financeEnabledEntityIds } from '@/modules/finance/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { setNoticesEnabledAction } from '@/modules/notices/server/actions';
import { loadNoticesEnabled } from '@/modules/notices/server/queries';
import { PageHeader } from '@/components/ui/page-header';
import { Notice } from '@/components/ui/notice';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { Acc3AccountsSettings } from '@/views/accounts-desk/acc3-settings';
import { AccountsSettingsView } from '@/views/accounts-desk/settings';

export const metadata: Metadata = { title: 'Accounts settings' };

const act = (a: unknown) => a as DecisionAction;

/**
 * Settings · Accounts (contract 6.2.6, 6.3.3, 7.1 T6/T7, 11.8): the staff
 * notices switch (Super Admin), and per company the Tally export switch and
 * the Tally exception owner (finance policy managers: Super Admin without
 * Accounts). Every change needs a reason; the database decides and audits.
 * Accounts phase 2 (contract 6.2 B9, 7.3 C12, 11.12): per company the
 * customer documents and refunds switches (admin_customer_documents_settings
 * reads both; a failed read shows "Not known" and no switch).
 */
export default async function AccountsSettingsRoute() {
  const staff = await requireStaff();
  const financeEntities = await financeEnabledEntityIds(staff);
  const entityIds = financePolicyEntityIds(staff.access, financeEntities);
  const superAdmin = staff.memberships.some((m) => m.roleCode === 'super_admin');
  if (!superAdmin && entityIds.length === 0) {
    return (
      <>
        <PageHeader title="Accounts settings" />
        <Notice tone="restricted" title="For Super Admins only">
          <p>Staff notices, Tally export and the exception owner are set by a Super Admin who does not work in Accounts.</p>
        </Notice>
      </>
    );
  }
  const [noticesEnabled, entities, switches] = await Promise.all([
    superAdmin ? loadNoticesEnabled(staff) : Promise.resolve(null),
    Promise.all(entityIds.map((id) => loadAdminAccountsSettings(staff, id).catch(() => null))),
    Promise.all(entityIds.map((id) => loadDocumentSettings(staff, id).catch(() => null))),
  ]);
  const phase2 = new Map(switches.filter((x): x is NonNullable<typeof x> => x !== null).map((x) => [x.entityId, x]));
  const names = new Map(staff.memberships.map((m) => [m.legalEntityId, m.legalEntityName]));
  return (
    <>
      <PageHeader title="Accounts settings" description="Staff notices, Tally export, the Tally exception owner, customer documents, refunds, automatic bills, write-offs and the Tally file. Each change needs a reason and is recorded." />
      <AccountsSettingsView
        model={{
          noticesEnabled,
          canSetNotices: superAdmin,
          entities: entities
            .filter((e): e is NonNullable<typeof e> => e !== null)
            .map((e) => ({
              entityId: e.entityId,
              entityName: names.get(e.entityId) ?? 'Company',
              tallyExportEnabled: e.tallyExportEnabled,
              customerDocumentsEnabled: phase2.get(e.entityId)?.customerDocumentsEnabled ?? null,
              refundsEnabled: phase2.get(e.entityId)?.refundsEnabled ?? null,
              exceptionOwnerUserId: e.exceptionOwnerActive ? e.exceptionOwnerUserId : null,
              accountsPeople: e.candidates,
            })),
        }}
        actions={{ setNotices: act(setNoticesEnabledAction), setTallyExport: act(setTallyExportEnabledAction), setExceptionOwner: act(setExceptionOwnerAction), setCustomerDocuments: act(setCustomerDocumentsEnabledAction), setRefunds: act(setRefundsEnabledAction) }}
      />
      {/* Accounts phase 3 (contract 6.1 B1, B2, 7.2 C2, screen 15.5): automatic bills, write-offs, the Tally file. */}
      <Acc3AccountsSettings
        entities={entities
          .filter((e): e is NonNullable<typeof e> => e !== null)
          // admin_accounts_settings carries the Phase 3 values (C's AdminAccountsSettingsView, migration 0340).
          .map((e) => ({
            entityId: e.entityId,
            entityName: names.get(e.entityId) ?? 'Company',
            customerDocumentsEnabled: e.customerDocumentsEnabled ?? phase2.get(e.entityId)?.customerDocumentsEnabled ?? null,
            autoBillsEnabled: e.autoBillsEnabled ?? null,
            autoBillReleaseEnabled: e.autoBillReleaseEnabled ?? null,
            writeOffEnabled: e.writeOffEnabled ?? null,
            writeOffLimitPaise: e.writeOffLimitPaise ?? null,
            tallyXmlEnabled: e.tallyXmlEnabled ?? null,
            tallyCompanyName: e.tallyCompanyName ?? null,
          }))}
        actions={{ setAutoBills: act(setAutoBillsAction), setWriteOff: act(setWriteOffAction), setTallyXml: act(setTallyXmlAction) }}
      />
    </>
  );
}
