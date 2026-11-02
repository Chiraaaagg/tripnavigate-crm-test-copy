import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import { loadSuppliers, purchaseEntities } from '@/modules/procurement/server/queries';
import { SupplierListPage } from '@/views/procurement-views';

export const metadata: Metadata = { title: 'Suppliers' };

export default async function SuppliersRoute() {
  const staff = await requireStaff();
  // The database returns suppliers only for entities where the viewer holds the Purchase role.
  const suppliers = await loadSuppliers(staff);
  return <SupplierListPage suppliers={suppliers} entities={purchaseEntities(staff)} />;
}
