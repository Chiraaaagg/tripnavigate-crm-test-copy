import 'server-only';
import type { StaffContext } from '@/modules/identity/server/session';
import { VnDbError } from '@/modules/parties/server/parties-db';
import { asRpcClient } from '../commands';
import { toNameReadStateView, type NameReadStateView } from '../name-map';
import { tripDetailsReadState } from './destinations-db';

/**
 * Voice-note batch: state of the "Read trip details from Bitrix" switch for
 * the Bitrix connection page, in the same view shape as the Bitrix names
 * switch. Unknown is never shown as off.
 */
export async function loadBitrixTripDetailsReadState(staff: Pick<StaffContext, 'supabase'>): Promise<NameReadStateView> {
  try {
    return toNameReadStateView(await tripDetailsReadState(asRpcClient(staff.supabase)));
  } catch (error) {
    if (error instanceof VnDbError) {
      if (error.code === 'not_authorized' || error.code === 'not_configured') return { state: 'unknown', reason: error.code };
      if (error.sqlState === 'PGRST202' || error.sqlState === '42883') return { state: 'unknown', reason: 'not_installed' };
    }
    return { state: 'unknown', reason: 'failed' };
  }
}
