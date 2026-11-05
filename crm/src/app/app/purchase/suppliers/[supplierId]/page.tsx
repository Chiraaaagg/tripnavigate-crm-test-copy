import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import { loadSupplier } from '@/modules/procurement/server/queries';
import { SupplierDetailPage, SupplierNotFoundView } from '@/views/procurement-views';

export const metadata: Metadata = { title: 'Supplier' };

export default async function SupplierRoute({
  params,
  searchParams,
}: {
  params: Promise<{ supplierId: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const [{ supplierId }, { created }] = await Promise.all([params, searchParams]);
  const staff = await requireStaff();
  const supplier = await loadSupplier(staff, supplierId);
  return supplier ? <SupplierDetailPage supplier={supplier} justCreated={created === '1'} /> : <SupplierNotFoundView />;
}
