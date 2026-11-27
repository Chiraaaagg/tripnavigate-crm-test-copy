import { z } from 'zod';
import {
  SUPPLIER_BANK_STATES,
  SUPPLIER_CHANGE_SOURCES,
  SUPPLIER_DUPLICATE_REASONS,
  SUPPLIER_HOTEL_SOURCES,
  SUPPLIER_KINDS,
  SUPPLIER_SERVICE_TYPES,
  SUPPLIER_STATUSES,
  SUPPLIER_VERIFICATIONS,
  type HotelSuppliers,
  type SupplierContactRemoveResult,
  type SupplierContactSaveResult,
  type SupplierHotelLinkResult,
  type SupplierMaster,
  type SupplierRegisterPage,
  type SupplierWriteResult,
} from './contracts';

/**
 * zod DTOs for the supplier master reads and commands (contract 5.5, 5.7,
 * 13.4). Every key is listed; unknown keys are stripped. No bank account
 * number, IFSC or holder exists in any of these shapes.
 */

const text = z.string().nullable();
const timestamp = z.string().min(1).refine((v) => !Number.isNaN(Date.parse(v)));
const count = z.number().int().nonnegative();
const rowVersion = z.number().int().positive();

export const SupplierDuplicateSchema = z.object({
  supplierId: z.uuid(),
  name: z.string(),
  reasons: z.array(z.enum(SUPPLIER_DUPLICATE_REASONS)).min(1),
});

const PrimaryContactSchema = z.object({ name: z.string(), phone: text, email: text });

export const SupplierRegisterRowSchema = z.object({
  supplierId: z.uuid(),
  name: z.string().min(1),
  kind: z.enum(SUPPLIER_KINDS),
  serviceTypes: z.array(z.enum(SUPPLIER_SERVICE_TYPES)).min(1),
  city: text,
  stateCode: text,
  gstin: text,
  panMasked: z.string().regex(/^XXXXX[0-9]{4}X$/).nullable(),
  verification: z.enum(SUPPLIER_VERIFICATIONS),
  bankState: z.enum(SUPPLIER_BANK_STATES),
  primaryContact: PrimaryContactSchema.nullable(),
  hotelCount: count,
  rowVersion,
  status: z.enum(SUPPLIER_STATUSES),
});

export const SupplierRegisterReplySchema = z
  .object({ items: z.array(SupplierRegisterRowSchema), nextAfter: z.string().nullable() })
  .nullable()
  .transform((v): SupplierRegisterPage | null => (v ? { items: v.items, nextAfter: v.nextAfter, hasMore: v.nextAfter !== null } : null));

const ContactSchema = z.object({
  contactId: z.uuid(),
  name: z.string(),
  roleLabel: text,
  phone: text,
  email: text,
  isPrimary: z.boolean(),
  rowVersion,
  updatedAt: timestamp,
}).transform((c) => ({ ...c, status: 'active' as const }));

const HotelLinkSchema = z.object({
  linkId: z.uuid(),
  hotelId: z.uuid(),
  name: z.string(),
  city: text,
  source: z.enum(SUPPLIER_HOTEL_SOURCES),
  createdAt: timestamp,
});

const HistorySchema = z.object({
  changedAt: timestamp,
  changedByName: text,
  source: z.enum(SUPPLIER_CHANGE_SOURCES),
  field: z.string().min(1).max(60),
  oldValue: text,
  newValue: text,
});

export const SupplierMasterSchema = SupplierRegisterRowSchema.extend({
  legalEntityId: z.uuid(),
  pan: text,
  address: text,
  tallyLedgerName: text,
  sourceRef: text,
  paymentTerms: text,
  verifiedAt: timestamp.nullable(),
  verifiedByName: text,
  updatedAt: timestamp,
  bank: z.object({ revisionNo: rowVersion, status: z.enum(['unverified', 'approved']), accountLast4: z.string().regex(/^[0-9]{4}$/) }).nullable(),
  contacts: z.array(ContactSchema),
  hotels: z.array(HotelLinkSchema),
  duplicates: z.array(SupplierDuplicateSchema),
  history: z.array(HistorySchema),
  can: z.object({ edit: z.boolean(), verify: z.boolean(), linkHotel: z.boolean(), approveBank: z.boolean() }),
});
export const SupplierMasterReplySchema = SupplierMasterSchema.nullable() satisfies z.ZodType<SupplierMaster | null, unknown>;

export const HotelSupplierOptionSchema = z.object({
  supplierId: z.uuid(),
  name: z.string(),
  kind: z.enum(SUPPLIER_KINDS),
  verification: z.enum(SUPPLIER_VERIFICATIONS),
  bankState: z.enum(SUPPLIER_BANK_STATES),
});
export const HotelSuppliersReplySchema = z
  .object({ hotelId: z.uuid(), suppliers: z.array(HotelSupplierOptionSchema) })
  .nullable() satisfies z.ZodType<HotelSuppliers | null, unknown>;

export const SupplierWriteSchema = z.object({
  supplierId: z.uuid(),
  rowVersion,
  warnings: z.array(SupplierDuplicateSchema).optional().transform((v) => v ?? []),
}) satisfies z.ZodType<SupplierWriteResult, unknown>;

export const ContactSaveSchema = z.object({
  outcome: z.enum(['created', 'updated', 'existing']),
  contactId: z.uuid(),
  rowVersion,
  supplierRowVersion: rowVersion,
}) satisfies z.ZodType<SupplierContactSaveResult, unknown>;

export const ContactRemoveSchema = z.object({
  outcome: z.enum(['updated', 'existing']),
  contactId: z.uuid(),
  supplierRowVersion: rowVersion,
}) satisfies z.ZodType<SupplierContactRemoveResult, unknown>;

export const HotelLinkResultSchema = z.object({
  outcome: z.enum(['created', 'updated', 'existing']),
  linkId: z.uuid(),
}) satisfies z.ZodType<SupplierHotelLinkResult, unknown>;
