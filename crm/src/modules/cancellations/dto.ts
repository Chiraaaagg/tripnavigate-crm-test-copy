import { z } from 'zod';

/**
 * zod schemas for the additive cancellation keys (7.4) and the C9-C11
 * results, every key listed. Readers of the existing summary, Flight money
 * and Visa workspace DTOs can extend their schemas with these.
 */

const paise = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);

export const FlightCancellationChargeSchema = z.object({
  batchId: z.uuid(),
  batchNo: z.number().int().positive(),
  supplierName: z.string(),
  supplierCostPaise: paise,
  airlineChargePaise: paise.nullable(),
  refundExpectedPaise: paise.nullable(),
  refundReportedPaise: paise.nullable(),
  revisionNo: z.number().int().nonnegative(),
  enteredByName: z.string().nullable(),
  note: z.string().nullable().optional().transform((v) => v ?? null),
});

/** deal_cancellation_summary().cancellation / manager_cancellation_list() rows, Manager only (absent otherwise). */
export const CancellationManagerAdditionsSchema = z.object({
  flightCharges: z.array(FlightCancellationChargeSchema).optional(),
  chargesKeptPaise: paise.optional(),
});

export const FlightBatchCancellationSchema = z.object({
  /** Track H: the remove_service request (null for a trip cancellation; absent from older servers). */
  changeRequestId: z.uuid().nullable().optional(),
  state: z.enum(['open', 'approved']),
  revisionNo: z.number().int().nonnegative(),
  airlineChargePaise: paise.nullable(),
  refundExpectedPaise: paise.nullable(),
  refundReportedPaise: paise.nullable(),
  supplierRefundReceivedPaise: paise,
  canEnter: z.boolean(),
  note: z.string().nullable().optional().transform((v) => v ?? null),
});

/** Additive per-batch keys of flight_money(). */
export const FlightBatchCancellationKeysSchema = z.object({
  ticketsCancelled: z.boolean().optional(),
  cancellation: FlightBatchCancellationSchema.optional(),
});

export const VisaCancellationSchema = z.object({
  /** Null for a service removal (track H). */
  cancellationId: z.uuid().nullable(),
  /** Track H: the remove_service request (null for a trip cancellation). */
  changeRequestId: z.uuid().nullable().optional(),
  status: z.enum(['open', 'charges_entered', 'sent_to_manager', 'approved']),
  approved: z.boolean(),
  fees: z.array(z.object({
    entryId: z.uuid(),
    applicationId: z.uuid().nullable(),
    costKind: z.string(),
    amountPaise: paise,
    refundExpectedPaise: paise.nullable(),
    revisionNo: z.number().int().nonnegative(),
    canSet: z.boolean(),
  })),
});

export const VisaApplicantCancellationSchema = z.object({
  cancellationChoice: z.enum(['withdraw', 'finish']).nullable().optional(),
  canChooseCancellation: z.boolean().optional(),
  cancellationChoiceReason: z.string().nullable().optional(),
});

export const FlightChargeResultSchema = z.object({
  outcome: z.enum(['created', 'existing']),
  /** Null for a service removal (track H). */
  cancellationId: z.uuid().nullable(),
  changeRequestId: z.uuid().nullable().optional(),
  batchId: z.uuid(),
  revisionNo: z.number().int().positive(),
  status: z.string(),
});

export const VisaChoiceResultSchema = z.object({
  outcome: z.enum(['updated', 'existing']),
  applicationId: z.uuid(),
  rowVersion: z.number().int().positive(),
  state: z.string(),
  closed: z.boolean(),
  taskCompleted: z.boolean(),
  cancellationChoice: z.enum(['withdraw', 'finish']),
});

export const VisaFeeRefundResultSchema = z.object({
  outcome: z.enum(['created', 'existing']),
  entryId: z.uuid(),
  revisionNo: z.number().int().positive(),
  /** Track H: the remove_service request (null for a trip cancellation). */
  changeRequestId: z.uuid().nullable().optional(),
});
