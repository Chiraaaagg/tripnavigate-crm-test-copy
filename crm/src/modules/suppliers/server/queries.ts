import 'server-only';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import { hotelSuppliers, supplierMasterGet, supplierRegister } from '../commands';
import type { HotelSuppliers, SupplierMaster, SupplierRegisterFilter, SupplierRegisterPage } from '../contracts';

/**
 * Supplier master reads for the pages (Accounts phase 2, R-A1..R-A3). Under
 * the staff member's own session: the database fences every row (section
 * 10) and answers null when the viewer may not read; null is passed through
 * so the page can say "not available" (never a partial object).
 */

export function loadSupplierRegister(
  staff: StaffContext,
  args: { filter?: SupplierRegisterFilter; after?: string | null; limit?: number } = {},
): Promise<SupplierRegisterPage | null> {
  return supplierRegister(asRpcClient(staff.supabase), args);
}

export function loadSupplierMaster(staff: StaffContext, supplierId: string): Promise<SupplierMaster | null> {
  return supplierMasterGet(asRpcClient(staff.supabase), supplierId);
}

export function loadHotelSuppliers(staff: StaffContext, hotelId: string): Promise<HotelSuppliers | null> {
  return hotelSuppliers(asRpcClient(staff.supabase), hotelId);
}
