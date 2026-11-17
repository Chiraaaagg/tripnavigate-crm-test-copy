import type { Metadata } from 'next';
import { accountsEntityIds, financePolicyEntityIds } from '@/modules/access/policy';
import { loadAdminAccountsSettings } from '@/modules/accounts-desk/server/queries';
import { setExceptionOwnerAction, setTallyExportEnabledAction } from '@/modules/accounts-desk/server/actions';
import { setAutoBillsAction, setCustomerDocumentsEnabledAction } from '@/modules/customer-documents/server/actions';
import { setTallyXmlAction } from '@/modules/accounts-desk/server/tally-file-actions';
import { setWriteOffAction } from '@/modules/write-offs/server/actions';
import { loadDocumentSettings } from '@/modules/customer-documents/server/queries';
import { setRefundsEnabledAction } from '@/modules/refunds/server/actions';
import { financeEnabledEntityIds } from '@/modules/finance/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { Notice } from '@/components/ui/notice';
import { SETTINGS_PATH } from '@/modules/settings/contracts';
import type { ExistingSettingsAction } from '@/views/settings/setting-switch-form';
import { AccountsSettingsView } from '@/views/accounts-desk/settings';
import { accountsSettingsTabs } from '@/views/tally-mapping/labels';

export const metadata: Metadata = { title: 'Accounts settings' };

const act = (a: unknown) => a as ExistingSettingsAction;

/**
 * Settings · Accounts (contract 6.2.6, 6.3.3, 7.1 T6/T7, 11.8, 11.12; Accounts
 * phase 3 B1, B2, C2), UX redesign R1: per company eight rows on one screen
 * (Tally export, exception owner, customer documents, refunds, automatic
 * drafts, automatic release, write-offs, Tally import file), each with one
 * confirm dialog and an optional reason (D9). Finance policy managers (Super
 * Admin without Accounts) change them; the database decides and audits.
 * A Super Admin who also holds Accounts in a finance company sees that
 * company read only with the reason (S12; the read refuses them, so no
 * values are shown). The staff notices switch moved to Features (D12).
 * Tally mapping is a sub-tab (its own address, for Accounts of the company).
 */
export default async function AccountsSettingsRoute() {
  const staff = await requireStaff();
  const financeEntities = await financeEnabledEntityIds(staff);
  const entityIds = financePolicyEntityIds(staff.access, financeEntities);
  const superAdmin = staff.memberships.some((m) => m.roleCode === 'super_admin');
  const names = new Map(staff.memberships.map((m) => [m.legalEntityId, m.legalEntityName]));
  // S12: Super Admin and Accounts in the same finance company (financePolicyEntityIds leaves these out).
  const accountsIds = accountsEntityIds(staff.access, financeEntities);
  const readOnlyIds = superAdmin
    ? [...new Set(staff.memberships.filter((m) => m.roleCode === 'super_admin' && accountsIds.includes(m.legalEntityId)).map((m) => m.legalEntityId))]
    : [];
  if (!superAdmin && entityIds.length === 0) {
    return (
      <Notice tone="restricted" title="For Super Admins only">
        <p>Tally export, the exception owner and the other Accounts switches are set by a Super Admin who does not work in Accounts.</p>
      </Notice>
    );
  }
  const [entities, switches] = await Promise.all([
    Promise.all(entityIds.map((id) => loadAdminAccountsSettings(staff, id).catch(() => null))),
    Promise.all(entityIds.map((id) => loadDocumentSettings(staff, id).catch(() => null))),
  ]);
  const phase2 = new Map(switches.filter((x): x is NonNullable<typeof x> => x !== null).map((x) => [x.entityId, x]));
  return (
    // The Settings frame gives the one h1 (the area name "Accounts" and its line); no page heading here.
    <AccountsSettingsView
      tabs={accountsSettingsTabs({ switches: true, mapping: accountsIds.length > 0, current: 'switches' })}
      model={{
        featuresHref: superAdmin ? SETTINGS_PATH.features : null,
        readOnlyEntities: readOnlyIds.map((id) => ({ entityId: id, entityName: names.get(id) ?? 'Company' })),
        entities: entities
          .filter((e): e is NonNullable<typeof e> => e !== null)
          .map((e) => ({
            entityId: e.entityId,
            entityName: names.get(e.entityId) ?? 'Company',
            tallyExportEnabled: e.tallyExportEnabled,
            customerDocumentsEnabled: phase2.get(e.entityId)?.customerDocumentsEnabled ?? e.customerDocumentsEnabled ?? null,
            refundsEnabled: phase2.get(e.entityId)?.refundsEnabled ?? null,
            exceptionOwnerUserId: e.exceptionOwnerActive ? e.exceptionOwnerUserId : null,
            accountsPeople: e.candidates,
            // admin_accounts_settings carries the Phase 3 values (migration 0340); missing = not known.
            autoBillsEnabled: e.autoBillsEnabled ?? null,
            autoBillReleaseEnabled: e.autoBillReleaseEnabled ?? null,
            writeOffEnabled: e.writeOffEnabled ?? null,
            writeOffLimitPaise: e.writeOffLimitPaise ?? null,
            tallyXmlEnabled: e.tallyXmlEnabled ?? null,
            tallyCompanyName: e.tallyCompanyName ?? null,
          })),
      }}
      actions={{
        setTallyExport: act(setTallyExportEnabledAction),
        setExceptionOwner: act(setExceptionOwnerAction),
        setCustomerDocuments: act(setCustomerDocumentsEnabledAction),
        setRefunds: act(setRefundsEnabledAction),
        setAutoBills: act(setAutoBillsAction),
        setWriteOff: act(setWriteOffAction),
        setTallyXml: act(setTallyXmlAction),
      }}
    />
  );
}
