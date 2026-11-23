import type { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import {
  SUPPLIER_ERROR_STATES,
  SUPPLIER_TOKEN_ALIASES,
  type HotelSuppliers,
  type SupplierContactRemoveResult,
  type SupplierContactSaveResult,
  type SupplierErrorCode,
  type SupplierHotelLinkResult,
  type SupplierKind,
  type SupplierMaster,
  type SupplierRegisterFilter,
  type SupplierRegisterPage,
  type SupplierServiceType,
  type SupplierStatus,
  type SupplierWriteResult,
} from './contracts';
import {
  ContactRemoveSchema,
  ContactSaveSchema,
  HotelLinkResultSchema,
  HotelSuppliersReplySchema,
  SupplierMasterReplySchema,
  SupplierRegisterReplySchema,
  SupplierWriteSchema,
} from './dto';
import { stateMatches } from '@/lib/sqlstate';

/**
 * Typed wrappers for the supplier master (migrations 20261204000110/0130).
 * Every call runs under the staff member's OWN session; the database
 * authorizes and audits. Replies are zod-validated (fail closed: code null).
 * Database messages never reach the browser: errors map by SQLSTATE + token.
 */

const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const INPUT_STATES = new Set(['22023', '22P02', '22001', '22003', '23514', '23502']);

export class SupplierCommandError extends Error {
  override name = 'SupplierCommandError';
  constructor(
    readonly command: string,
    readonly code: SupplierErrorCode | 'session' | null,
    readonly sqlState: string | null,
    /** The refused field for invalid_input (database hint). */
    readonly hint: string | null = null,
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapSupplierError(error: RpcError): SupplierErrorCode | 'session' | null {
  const state = error.code ?? '';
  const raw = (error.message ?? '').trim();
  const token = SUPPLIER_TOKEN_ALIASES[raw] ?? raw;
  if (Object.hasOwn(SUPPLIER_ERROR_STATES, token) && stateMatches(SUPPLIER_ERROR_STATES[token as SupplierErrorCode], state)) {
    return token as SupplierErrorCode;
  }
  if (SESSION_STATES.has(state)) return 'session';
  if (state === '42501') return 'not_authorized';
  if (state === 'P0002') return 'not_found';
  if (INPUT_STATES.has(state)) return 'invalid_input';
  return null;
}

async function invoke(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, args);
  } catch {
    throw new SupplierCommandError(fn, null, null);
  }
  if (result.error) throw new SupplierCommandError(fn, mapSupplierError(result.error), result.error.code ?? null, result.error.hint ?? null);
  return result.data;
}

function parse<T>(fn: string, schema: z.ZodType<T, unknown>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new SupplierCommandError(fn, null, null);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function supplierRegister(client: RpcClient, args: { filter?: SupplierRegisterFilter; after?: string | null; limit?: number }): Promise<SupplierRegisterPage | null> {
  const fn = 'supplier_register';
  return parse(fn, SupplierRegisterReplySchema, await invoke(client, fn, { p_filter: args.filter ?? {}, p_after: args.after ?? null, p_limit: args.limit ?? 50 }));
}

export async function supplierMasterGet(client: RpcClient, supplierId: string): Promise<SupplierMaster | null> {
  const fn = 'supplier_master_get';
  return parse(fn, SupplierMasterReplySchema, await invoke(client, fn, { p_supplier_id: supplierId }));
}

export async function hotelSuppliers(client: RpcClient, hotelId: string): Promise<HotelSuppliers | null> {
  const fn = 'hotel_suppliers';
  return parse(fn, HotelSuppliersReplySchema, await invoke(client, fn, { p_hotel_id: hotelId }));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** p_fields of supplier_create / supplier_update (A1/A2). An absent new key keeps the stored value on an update. */
export interface SupplierMasterFields {
  name: string;
  serviceTypes: SupplierServiceType[];
  city: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  paymentTerms: string | null;
  status?: SupplierStatus;
  supplierKind?: SupplierKind;
  gstin?: string | null;
  pan?: string | null;
  stateCode?: string | null;
  address?: string | null;
}

/** p_fields of flight_supplier_create / flight_supplier_update (A3): no service types or payment terms. */
export type FlightSupplierFields = Omit<SupplierMasterFields, 'serviceTypes' | 'paymentTerms'>;

export async function supplierCreate(client: RpcClient, entityId: string, fields: SupplierMasterFields): Promise<SupplierWriteResult> {
  const fn = 'supplier_create';
  return parse(fn, SupplierWriteSchema, await invoke(client, fn, { p_entity_id: entityId, p_fields: fields }));
}

export async function supplierUpdate(client: RpcClient, supplierId: string, expectedRowVersion: number, fields: SupplierMasterFields): Promise<SupplierWriteResult> {
  const fn = 'supplier_update';
  return parse(fn, SupplierWriteSchema, await invoke(client, fn, { p_supplier_id: supplierId, p_expected_row_version: expectedRowVersion, p_fields: fields }));
}

export async function flightSupplierCreate(client: RpcClient, fields: FlightSupplierFields, requestId: string): Promise<SupplierWriteResult> {
  const fn = 'flight_supplier_create';
  return parse(fn, SupplierWriteSchema, await invoke(client, fn, { p_fields: fields, p_request_id: requestId }));
}

export async function flightSupplierUpdate(client: RpcClient, supplierId: string, expectedRowVersion: number, fields: FlightSupplierFields): Promise<SupplierWriteResult> {
  const fn = 'flight_supplier_update';
  return parse(fn, SupplierWriteSchema, await invoke(client, fn, { p_supplier_id: supplierId, p_expected_row_version: expectedRowVersion, p_fields: fields }));
}

export interface SupplierContactFields {
  name: string;
  roleLabel: string | null;
  phone: string | null;
  email: string | null;
  isPrimary?: boolean;
}

export async function supplierContactSave(
  client: RpcClient,
  args: { supplierId: string; contactId: string | null; expectedRowVersion: number; fields: SupplierContactFields; requestId: string },
): Promise<SupplierContactSaveResult> {
  const fn = 'supplier_contact_save';
  return parse(fn, ContactSaveSchema, await invoke(client, fn, {
    p_supplier_id: args.supplierId, p_contact_id: args.contactId, p_expected_row_version: args.expectedRowVersion, p_fields: args.fields,
    p_request_id: args.requestId,
  }));
}

export async function supplierContactRemove(
  client: RpcClient,
  args: { contactId: string; expectedRowVersion: number; reason: string; requestId: string },
): Promise<SupplierContactRemoveResult> {
  const fn = 'supplier_contact_remove';
  return parse(fn, ContactRemoveSchema, await invoke(client, fn, {
    p_contact_id: args.contactId, p_expected_row_version: args.expectedRowVersion, p_reason: args.reason, p_request_id: args.requestId,
  }));
}

export async function supplierHotelLink(client: RpcClient, args: { supplierId: string; hotelId: string; requestId: string }): Promise<SupplierHotelLinkResult> {
  const fn = 'supplier_hotel_link';
  return parse(fn, HotelLinkResultSchema, await invoke(client, fn, { p_supplier_id: args.supplierId, p_hotel_id: args.hotelId, p_request_id: args.requestId }));
}

export async function supplierHotelUnlink(client: RpcClient, args: { linkId: string; reason: string; requestId: string }): Promise<SupplierHotelLinkResult> {
  const fn = 'supplier_hotel_unlink';
  return parse(fn, HotelLinkResultSchema, await invoke(client, fn, { p_link_id: args.linkId, p_reason: args.reason, p_request_id: args.requestId }));
}
