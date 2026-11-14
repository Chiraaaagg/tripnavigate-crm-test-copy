import type { ReactNode } from 'react';
import { getAppConfig } from '@/lib/config';
import { financeEnabledEntityIds } from '@/modules/finance/server/queries';
import { markAllNoticesReadAction, markNoticeAction, setNoticePopupsAction, setNoticeSoundAction } from '@/modules/notices/server/actions';
import { listPushDevicesAction, registerPushDeviceAction, removeCurrentPushDeviceAction, removePushDeviceAction, sendPushTestAction } from '@/modules/notices/server/push-actions';
import { requireStaff } from '@/modules/identity/server/session';
import { StaffShell } from '@/views/StaffShell';
import { accountsDeskLinks, shellPermissions } from './shell-permissions';

// Every staff page depends on the signed-in session; never prerender or cache.
export const dynamic = 'force-dynamic';

export default async function StaffLayout({ children }: { children: ReactNode }) {
  const staff = await requireStaff();
  const primary = staff.memberships.find((m) => m.isHeadOffice) ?? staff.memberships[0];
  // Navigation convenience only; every finance RPC re-checks access (phase-5a-contract.md §4).
  const financeEntities = await financeEnabledEntityIds(staff);
  const config = getAppConfig();
  return (
    <StaffShell
      // Accounts phase (contract 9.4, 11.5): the bell on every page. Reads go through GET /api/notices
      // (notice_inbox re-checks access on every read; never a Server Action, so they never queue with
      // the page's own actions); the Realtime token comes from GET /api/realtime-token; marks stay
      // actions; Realtime only signals a re-read.
      notices={{
        api: {
          mark: markNoticeAction,
          markAllRead: markAllNoticesReadAction,
          setSound: setNoticeSoundAction,
          setPopups: setNoticePopupsAction,
          // Accounts phase 3 (contract 8.4, screen 15.8): "Alerts on this device". The browser adapter is built
          // in the bell from these actions; nothing registers until the person presses "Turn on".
          push: {
            actions: { list: listPushDevicesAction, register: registerPushDeviceAction, remove: removePushDeviceAction, removeCurrent: removeCurrentPushDeviceAction, test: sendPushTestAction },
            vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '',
          },
        },
        realtime: { supabaseUrl: config.supabaseUrl, supabasePublishableKey: config.supabasePublishableKey, userId: staff.userId },
      }}
      viewer={{
        displayName: staff.displayName,
        primaryRole: primary?.roleName ?? '',
        primaryBranch: primary?.branchName ?? '',
        // Account panel (FP-004): the person's own memberships, already loaded by requireStaff.
        memberships: staff.memberships.map((m) => ({ roleName: m.roleName, branchName: m.branchName, isHeadOffice: m.isHeadOffice })),
        ...shellPermissions(staff, financeEntities),
        ...accountsDeskLinks(staff, financeEntities),
      }}
    >
      {children}
    </StaffShell>
  );
}
