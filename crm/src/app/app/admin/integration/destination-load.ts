import 'server-only';
import type { StaffContext } from '@/modules/identity/server/session';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { listDestinationOptions } from '@/modules/integration/server/destinations-db';
import type { DestinationClassRow } from '@/views/booking-form/vn-types';

/**
 * The Bitrix destination options and their trip type, for the Super Admin
 * card on Settings · Bitrix connection. null = could not be read (never an
 * empty list); [] = the trip details read is off or Bitrix has no options.
 */
export async function loadDestinationClasses(staff: Pick<StaffContext, 'supabase'>): Promise<{ rows: DestinationClassRow[] | null; canEdit: boolean }> {
  try {
    const list = await listDestinationOptions(asRpcClient(staff.supabase));
    return {
      // The database says who may set a trip type (Super Admin of the company).
      canEdit: list.canSet,
      rows: list.options.map((o) => ({
        optionId: o.optionId,
        label: o.label,
        source: o.listId === 'DEAL_DESTINATION_MULTI' ? 'multi' : 'single',
        scope: o.scope,
        reason: null,
        byName: o.setByName ?? null,
        at: o.setAt ?? null,
        rowVersion: o.rowVersion,
      })),
    };
  } catch {
    return { canEdit: false, rows: null };
  }
}
