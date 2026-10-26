import type { Metadata } from 'next';
import { holdsPurchaseAnywhere } from '@/modules/access/policy';
import { loadB12Switches } from '@/modules/fulfilment/server/b12-switches';
import { loadBookingHealth } from '@/modules/fulfilment/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { isAlertEmailConfigured } from '@/modules/integration/sync-alerts';
import { SETTINGS_PATH } from '@/modules/settings/contracts';
import { liveRows } from '@/modules/settings/rows';
import { loadSettingsStates, sectionOf } from '@/modules/settings/server/queries';
import { BookingHealthNoPermissionView, BookingHealthPage } from '@/views/booking-health-views';

export const metadata: Metadata = { title: 'System health' };

/**
 * Settings · System health (AD-04, DA-262): read only. Booking health, real
 * bookings and supplier confirmation, the online PDF maker, email alerts and
 * a link to Bitrix connection. Unknown is shown as unknown, never as healthy.
 */
export default async function BookingHealthRoute() {
  const staff = await requireStaff();
  let health;
  try {
    health = await loadBookingHealth(staff);
  } catch {
    health = undefined;
  }
  if (health === null) return <BookingHealthNoPermissionView />;
  const [states, b12] = await Promise.all([loadSettingsStates(staff), loadB12Switches(staff).catch(() => null)]);
  const pdf = b12?.readOnly.find((r) => r.key === 'pdf_render_online');
  return (
    <BookingHealthPage
      health={health ?? null}
      live={liveRows(sectionOf(states, 'live'))}
      pdfMaker={{ on: pdf ? pdf.on : null }}
      emailAlertsConfigured={isAlertEmailConfigured()}
      bitrixHref={holdsPurchaseAnywhere(staff.access) ? null : SETTINGS_PATH.bitrix}
    />
  );
}
