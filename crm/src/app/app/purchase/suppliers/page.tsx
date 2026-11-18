import type { Metadata } from 'next';
import { requireStaff, type StaffContext } from '@/modules/identity/server/session';
import { purchaseEntities } from '@/modules/procurement/server/queries';
import {
  SUPPLIER_BANK_STATES,
  SUPPLIER_KINDS,
  SUPPLIER_SERVICE_TYPES,
  SUPPLIER_STATUSES,
  SUPPLIER_VERIFICATIONS,
  type SupplierRegisterFilter,
  type SupplierServiceType,
  type SupplierViewer,
} from '@/modules/suppliers/contracts';
import { createSupplierAction } from '@/modules/suppliers/server/actions';
import { loadSupplierRegister } from '@/modules/suppliers/server/queries';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { GST_STATES } from '@/views/b11/book-fields';
import { SupplierRegisterNoAccess, SupplierRegisterView } from '@/views/suppliers/register';

export const metadata: Metadata = { title: 'Suppliers' };

type Search = Record<string, string | string[] | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? '';
}
function pick<T extends string>(v: string, allowed: readonly T[]): T | undefined {
  return (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

/** Allowlist parse of the address (R-A1 filter keys only); anything else is ignored. */
function parseFilter(q: Search): SupplierRegisterFilter {
  const f: SupplierRegisterFilter = {};
  const text = one(q.q).slice(0, 80);
  if (text) f.q = text;
  const city = one(q.city).slice(0, 120);
  if (city) f.city = city;
  const kind = pick(one(q.kind), SUPPLIER_KINDS);
  if (kind) f.kind = kind;
  const serviceType = pick(one(q.serviceType), SUPPLIER_SERVICE_TYPES);
  if (serviceType) f.serviceType = serviceType;
  const verification = pick(one(q.verification), SUPPLIER_VERIFICATIONS);
  if (verification) f.verification = verification;
  const bankState = pick(one(q.bankState), SUPPLIER_BANK_STATES);
  if (bankState) f.bankState = bankState;
  const status = pick(one(q.status), SUPPLIER_STATUSES);
  if (status) f.status = status;
  const hotelId = one(q.hotelId);
  if (UUID.test(hotelId)) f.hotelId = hotelId;
  return f;
}

/** Wording and the create form only; supplier_register decides every row (section 10). */
function viewerOf(staff: StaffContext): SupplierViewer {
  const holds = (code: string) => staff.memberships.some((m) => m.roleCode === code);
  if (holds('purchase')) return 'purchase';
  if (holds('flight')) return 'flight';
  if (holds('manager')) return 'manager';
  return 'accounts';
}

const SERVICES: Record<SupplierViewer, SupplierServiceType[]> = {
  purchase: ['hotel', 'transfer', 'activity'],
  flight: ['flight'],
  manager: ['hotel', 'transfer', 'activity', 'flight'],
  accounts: ['hotel', 'transfer', 'activity', 'flight'],
};

/**
 * Suppliers register (Accounts phase 2, R-A1, contract 11.9). Filters and the
 * "Show more" cursor come from the address (allowlisted); the read runs under
 * the viewer's own session and returns null for anyone who may not read
 * suppliers (the same "not available" words whatever the reason). A failed
 * read says so (never an empty list).
 */
export default async function SuppliersRoute({ searchParams }: { searchParams: Promise<Search> }) {
  const staff = await requireStaff();
  const query = await searchParams;
  const filter = parseFilter(query);
  const after = one(query.after).slice(0, 200) || null;
  const page = await loadSupplierRegister(staff, { filter, after }).catch(() => 'error' as const);
  if (page === null) return <SupplierRegisterNoAccess />;
  const viewer = viewerOf(staff);
  // Purchase adds hotel/transfer/activity suppliers per company; Flight adds flight suppliers (company from its membership).
  const entities =
    viewer === 'purchase'
      ? purchaseEntities(staff)
      : viewer === 'flight'
        ? [...new Map(staff.memberships.filter((m) => m.roleCode === 'flight').map((m) => [m.legalEntityId, m.legalEntityName] as const)).entries()].map(([id, name]) => ({ id, name }))
        : [];
  return (
    <SupplierRegisterView
      viewer={viewer}
      filter={filter}
      page={page}
      states={GST_STATES}
      serviceTypes={SERVICES[viewer]}
      entities={entities}
      createAction={entities.length > 0 ? (createSupplierAction as unknown as DecisionAction) : null}
    />
  );
}
